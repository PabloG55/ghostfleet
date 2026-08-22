#!/usr/bin/env bash
# ghostfleet installer.
# - STAGES the runtime out of the repo into a non-TCC dir (see below), then:
# - symlinks bin/ghostfleet + bin/claude-here (and helpers) onto your PATH
# - wires hooks/fleet-event.sh into ~/.claude/settings.json (backing it up first)
# - registers the fleet MCP server into <config>/.claude.json (via `claude mcp add`;
#   Claude does NOT read MCP from settings.json)
# - links the example zellij layout if you use zellij
#
# WHY STAGE: on macOS, ~/Documents (and ~/Desktop, ~/Downloads) are TCC-protected.
# An app that lacks "Documents folder"/Full Disk Access — e.g. ClaudeCode.app —
# gets EPERM ("Operation not permitted") trying to EXECUTE anything stored there.
# If you cloned this repo under ~/Documents, running the fleet CLI/hook/MCP straight
# from it breaks the moment such an app hosts your session. So we COPY the runtime
# into $CLAUDE_FLEET_HOME (default ~/.local/libexec/ghostfleet — NOT TCC-guarded)
# and point PATH symlinks / the hook / MCP / skill / layout THERE. The repo stays
# for development; after editing it, run `cf-sync` to push changes into the runtime.
#
# Re-run any time; it's idempotent. `--yes` (or CLAUDE_FLEET_YES=1) lets it install
# missing dependencies with no prompt, for installs with no terminal to ask at.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${CLAUDE_FLEET_BIN:-$HOME/.local/bin}"
FLEET_HOME="${CLAUDE_FLEET_HOME:-$HOME/.local/libexec/ghostfleet}"

usage() {
  cat <<'EOF'
ghostfleet installer

    ./install.sh [-y|--yes]          from a clone
    npx ghostfleet-cli [-y|--yes]    without cloning (args pass straight through)

  -y, --yes    Install missing dependencies (tmux, jq) WITHOUT prompting, using the
               OS package manager — with sudo on Linux where that needs it. For
               unattended installs (CI, a Dockerfile, `curl | bash`) where there is
               no terminal to ask at. Same as CLAUDE_FLEET_YES=1.
  -h, --help   This.

Without it nothing is installed and no privileged command is run unless you answer the
prompt at the terminal — including when there IS no terminal, where the installer
prints the command and installs nothing.
EOF
}

# --- consent to install missing dependencies --------------------------------
# The default is unchanged and deliberate: ensure_pkg below never installs, and never
# sudo's, without a yes typed at /dev/tty. What this adds is the other end of that rule
# — with no controlling terminal there is nobody to ask, so `npx ghostfleet-cli` inside
# CI or a Dockerfile printed one line about tmux and exited 0. That install reads as
# clean and cannot work: a fleet session IS a tmux server, so the grid has nothing to
# start. --yes is how you consent IN ADVANCE, for the case where you cannot be asked.
ASSUME_YES=0; YES_VIA=""
# An explicit CLAUDE_FLEET_YES=0 means OFF. "Non-empty is consent" would read a
# Dockerfile's `ENV CLAUDE_FLEET_YES=0` as permission to sudo, which is the one mistake
# this flag must not make.
case "${CLAUDE_FLEET_YES:-}" in
  ""|0|n|N|no|No|NO|false|False|FALSE|off|Off|OFF) ;;
  *) ASSUME_YES=1; YES_VIA="CLAUDE_FLEET_YES" ;;
esac
for a in "$@"; do
  case "$a" in
    -y|--yes)  ASSUME_YES=1; YES_VIA="--yes" ;;
    -h|--help) usage; exit 0 ;;
    # A MISTYPED flag must not be ignored: `--yse` in a Dockerfile would otherwise
    # produce exactly the silent tmux-less install that --yes exists to prevent, and
    # the build would pass. A stray POSITIONAL stays a warning, because args were
    # ignored entirely before this and nothing that worked should start failing.
    -*) echo "install.sh: unknown option: $a" >&2; usage >&2; exit 2 ;;
    *)  echo "! ignoring unrecognized argument: $a" >&2 ;;
  esac
done

echo "ghostfleet installer"
echo "  repo:     $REPO   (development)"
echo "  runtime:  $FLEET_HOME   (executed from here)"
echo "  bin dir:  $BIN_DIR"
[ "$ASSUME_YES" = 1 ] && echo "  deps:     $YES_VIA given — missing dependencies will be installed WITHOUT asking"
echo

command -v node >/dev/null 2>&1 || { echo "error: node is required (the v2 grid is a Node TUI)"; exit 1; }

# Both consent paths — a yes typed at the tty, and --yes given in advance — install
# through this one place, so they cannot drift into installing differently.
pkg_run() {
  local pkg="$1"; shift
  echo "  Running: $*"
  if "$@"; then echo "✓ $pkg installed"; return 0; fi
  echo "! $pkg install failed — install it yourself: $*"
  return 1
}

# Offer to install a missing dependency rather than just refusing. Both of ours are
# one obvious package on every supported OS, and the package name happens to equal
# the command name for both. Never runs a privileged command without asking first,
# and reads the prompt from /dev/tty directly — piping this script through
# `curl | bash` leaves stdin attached to the script itself, not the terminal, so a
# plain `read` would silently read garbage (or block on it) instead of showing the
# user anything.
#   This used to be tmux-only, on the reasoning that tmux was "the most likely to be
# missing (jq/node are common already)". The conclusion was right and the handling was
# not: jq was the one dependency that stopped a first install with a bare
# `error: jq is required (brew install jq)` instead of an offer. Measured while changing
# this: macOS 26 SHIPS jq at /usr/bin/jq, Apple-signed as com.apple.jq — so the
# `brew install jq` the README used to open with was telling most readers to install
# something they already had, while the people who genuinely lacked it (older macOS,
# a minimal Linux image, a container) got an error and no help.
ensure_pkg() {
  local pkg="$1" why="$2"
  command -v "$pkg" >/dev/null 2>&1 && return 0
  local sudo_prefix=() cmd=()
  [ "$(id -u)" = 0 ] || sudo_prefix=(sudo)
  case "$(uname -s)" in
    Darwin) command -v brew >/dev/null 2>&1 && cmd=(brew install "$pkg") ;;
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" apt-get install -y "$pkg")
      elif command -v dnf     >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" dnf install -y "$pkg")
      elif command -v yum     >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" yum install -y "$pkg")
      elif command -v pacman  >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" pacman -S --noconfirm "$pkg")
      elif command -v zypper  >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" zypper install -y "$pkg")
      elif command -v apk     >/dev/null 2>&1; then cmd=("${sudo_prefix[@]}" apk add "$pkg")
      fi
      ;;
  esac

  if [ "${#cmd[@]}" -eq 0 ]; then
    echo "! $pkg not found — $why, and I don't recognize a package manager to install it with."
    echo "  Install it yourself, e.g.: brew install $pkg (macOS) / apt-get, dnf, yum, pacman, zypper, or apk install $pkg (Linux)"
    return 0
  fi

  echo "! $pkg not found — $why."

  # Consent given up front: install, no prompt. This is the only path that runs a
  # package manager with nobody watching, which is exactly why it is opt-in.
  if [ "$ASSUME_YES" = 1 ]; then
    echo "  $YES_VIA given — installing without asking."
    pkg_run "$pkg" "${cmd[@]}" || true    # the end-of-install check decides if it is fatal
    return 0
  fi

  # Probe /dev/tty in a subshell first rather than pre-checking with `[ -r ]`:
  # that only tests permission bits and passes even with no controlling terminal
  # at all (this happens in sandboxed/headless environments) — the actual open()
  # is what fails there. A failed `exec` on THIS shell prints its own diagnostic
  # that a plain `2>/dev/null` doesn't catch; wrapping the probe in `( … )` keeps
  # that noise inside the subshell instead of leaking to the real stderr.
  local ans=""
  if ( exec 3<>/dev/tty ) 2>/dev/null; then
    exec 9<>/dev/tty
    printf "  Install it now with: %s ? [Y/n] " "${cmd[*]}" >&9
    read -r ans <&9 || ans=""
    exec 9>&- 9<&-
  else
    # Don't stop at "not auto-installing". That line is true, actionable only by a
    # human, and printed precisely where no human is — so name the flag that makes an
    # unattended install actually work, which is what the reader of this line wants.
    echo "  Non-interactive (no controlling terminal) — not auto-installing. Run: ${cmd[*]}"
    echo "  Or consent up front and let the installer run that for you:"
    echo "      npx ghostfleet-cli --yes   |   ./install.sh --yes   |   CLAUDE_FLEET_YES=1"
    # WHERE the flag goes decides whether we ever see it. `--yes`/`-y` is also npx's own
    # flag, so BEFORE the package name npm consumes it and this script is invoked with no
    # arguments at all — landing here, printing "pass --yes", at somebody who is certain
    # they did. Measured on npm 11.18: after the package name it reaches us (and we never
    # reach this branch); before it, argv is empty and npm leaves its own parse behind in
    # npm_config_yes ("true"), which is the only way to tell the two apart. A plain
    # `npx ghostfleet-cli` leaves that variable set but EMPTY, so it must not count.
    case "${npm_config_yes:-}" in
      ""|false|0) ;;
      *) echo "  (npm swallowed a --yes of its own: it only reaches this installer AFTER the"
         echo "   package name — 'npx ghostfleet-cli --yes', not 'npx --yes ghostfleet-cli'.)" ;;
    esac
    return 0
  fi
  case "$ans" in
    ""|y|Y|yes|YES|Yes) pkg_run "$pkg" "${cmd[@]}" || true ;;
    *) echo "  Skipped. Install it yourself: ${cmd[*]}" ;;
  esac
}
ensure_pkg jq   "this installer edits settings.json and .claude.json with it, and the status hook parses its payload with it"
ensure_pkg tmux "the grid needs it"

# jq is the one that cannot be deferred: the wiring below is written WITH jq, so a
# declined or failed install has to stop here rather than half-configure a config dir.
# tmux can wait — nothing in this script needs it, only the fleet does, later.
command -v jq >/dev/null 2>&1 || { echo "error: jq is required to wire the hooks and MCP server — install it and re-run"; exit 1; }

chmod +x "$REPO"/hooks/*.sh "$REPO"/bin/*

# --- stage the runtime out of the repo (into a non-TCC location) ------------
# cf-sync copies bin/tmux/hooks/mcp/skill/layouts from the repo into FLEET_HOME
# and records the repo in FLEET_HOME/.source (so `cf-sync` alone re-syncs later).
CLAUDE_FLEET_HOME="$FLEET_HOME" "$REPO/bin/cf-sync" "$REPO"
chmod +x "$FLEET_HOME"/hooks/*.sh "$FLEET_HOME"/bin/* 2>/dev/null || true

# Everything below points at the STAGED runtime, never the repo.
HOOK="$FLEET_HOME/hooks/fleet-event.sh"
GUARD="$FLEET_HOME/hooks/fleet-guard.sh"

mkdir -p "$BIN_DIR"
CF_BINS=(ghostfleet claude-here cf-sync fleet-schedule fleet-send fleet-list fleet-read
         fleet-spawn fleet-jump fleet-pause fleet-resume fleet-governor fleet-statusbar
         fleet-worktrees fleet-answer fleet-inbox fleet-stop fleet-scratch fleet-companion fleet-tab fleet-copy fleet-merged
         fleet-clean fleet-open fleet-project fleet-adopt fleet-awake fleet-cycle
         fleet-rename fleet-agent fleet-stack fleet-slot fleet-serve
         agent-here opencode-here codex-here)
linked=()
for b in "${CF_BINS[@]}"; do
  if [ -e "$FLEET_HOME/bin/$b" ]; then ln -sf "$FLEET_HOME/bin/$b" "$BIN_DIR/$b"; linked+=("$b")
  else echo "! $b is in the install list but not in the runtime — skipped" >&2; fi
done
ln -sf "$FLEET_HOME/bin/ghostfleet" "$BIN_DIR/claude-fleet"   # back-compat: the old entry point
# Report what was ACTUALLY linked. This line used to be a hand-maintained list, and it
# had already drifted twice — it was still missing fleet-stack, and then fleet-slot, so
# an installer that had just linked a new command told you it hadn't. A summary
# maintained separately from the work it summarises is a summary that will lie.
echo "✓ linked ${#linked[@]} commands (${linked[*]}) -> $BIN_DIR"

# --- OpenCode event bridge (optional, only if opencode is installed) --------
# The counterpart of wire_hooks below: Claude Code learns about the fleet through
# settings.json hooks, OpenCode through a plugin. Installed GLOBALLY (OpenCode
# auto-discovers ~/.config/opencode/plugin/*.js) rather than into each checkout, so
# no file is ever written into the user's repo. The plugin is inert without
# CLAUDE_FLEET_SOCK in the environment, so it does nothing to ordinary opencode use.
if command -v opencode >/dev/null 2>&1; then
  OC_PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin"
  if mkdir -p "$OC_PLUGIN_DIR" 2>/dev/null; then
    ln -sf "$FLEET_HOME/hooks/opencode-fleet-event.js" "$OC_PLUGIN_DIR/ghostfleet-event.js"
    echo "✓ installed the OpenCode event bridge -> $OC_PLUGIN_DIR/ghostfleet-event.js"
  else
    echo "! could not create $OC_PLUGIN_DIR — OpenCode workers will fall back to pane-only detection"
  fi
else
  echo "· opencode not installed — skipping its event bridge (fleet-spawn --agent opencode will refuse until it is)"
fi

# --- wire hooks into every Claude config dir (profile) ----------------------
# Each profile (work=~/.claude, personal=~/.claude-personal, …) has its OWN
# settings.json, so the status/notification hooks must be wired into each.
# Register the fleet MCP server where Claude ACTUALLY reads it. Claude Code does
# NOT read mcpServers from settings.json — only from .claude.json (user/local
# scope) or .mcp.json (project). With CLAUDE_CONFIG_DIR set, the user-scoped file
# is $CLAUDE_CONFIG_DIR/.claude.json. `claude mcp add` (run with the same
# CLAUDE_CONFIG_DIR) writes to the exact file the fleet's sessions read, so the
# fleet_* tools surface in every session (incl. --resume + --dangerously-skip).
register_mcp() {
  local dir="$1" mcp="$FLEET_HOME/mcp/fleet-mcp.mjs"
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_CONFIG_DIR="$dir" claude mcp remove -s user ghostfleet   >/dev/null 2>&1 || true
    CLAUDE_CONFIG_DIR="$dir" claude mcp remove -s user claude-fleet >/dev/null 2>&1 || true   # pre-rename name
    if CLAUDE_CONFIG_DIR="$dir" claude mcp add -s user --transport stdio ghostfleet -- node "$mcp" >/dev/null 2>&1; then
      echo "✓ registered ghostfleet MCP (user scope) -> $dir/.claude.json"
    else
      echo "! could not 'claude mcp add' in $dir — run: CLAUDE_CONFIG_DIR=$dir claude mcp add -s user --transport stdio ghostfleet -- node $mcp"
    fi
  else
    # no claude CLI on PATH — write the top-level mcpServers into .claude.json directly
    local cj="$dir/.claude.json" t; [ -f "$cj" ] || echo '{}' > "$cj"; t="$(mktemp)"
    if jq --arg m "$mcp" '.mcpServers = ((.mcpServers // {}) + { "ghostfleet": { type:"stdio", command:"node", args:[$m], env:{} } })' "$cj" > "$t" 2>/dev/null; then
      mv "$t" "$cj"; echo "✓ wrote ghostfleet MCP -> $cj"
    else rm -f "$t"; echo "! failed to write MCP into $cj"; fi
  fi
}

wire_hooks() {
  local dir="$1" settings="$1/settings.json" tmp
  mkdir -p "$dir/fleet" "$dir/skills"
  # orchestration skill so a lead session knows it can drive siblings (-n so an
  # existing dir-symlink is replaced, not followed into — a macOS ln -sf footgun)
  rm -f "$dir/skills/claude-fleet-orchestrate" 2>/dev/null                      # pre-rename skill
  ln -sfn "$FLEET_HOME/skill/ghostfleet-orchestrate" "$dir/skills/ghostfleet-orchestrate"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp "$settings" "$settings.bak.$(date +%Y%m%d%H%M%S)"
  tmp="$(mktemp)"
  # Hooks belong in settings.json; MCP does NOT (see register_mcp). Wire the hooks
  # and strip any stale ghostfleet MCP entry an older installer wrote here.
  jq --arg hook "$HOOK" --arg guard "$GUARD" '
    def entry: [ { matcher: "", hooks: [ { type: "command", command: $hook } ] } ];
    .hooks = ((.hooks // {}) + {
      Notification: entry, Stop: entry, UserPromptSubmit: entry,
      SessionStart: entry, SessionEnd: entry })
    # PreToolUse is SHARED GROUND — unlike the five above, other tools legitimately
    # live here, so ours is APPENDED, never assigned over the top. Stanzas pointing at
    # our guard are dropped first so re-installing (or changing the matcher) replaces
    # rather than stacks up copies.
    | .hooks.PreToolUse = (
        [ (.hooks.PreToolUse // [])[]
          | select([.hooks[]?.command] | index($guard) | not) ]
        + [ { matcher: "EnterWorktree",
              hooks: [ { type: "command", command: $guard } ] } ] )
    | (if .mcpServers then .mcpServers |= del(.["ghostfleet"]) else . end)
    | (if (.mcpServers // {}) == {} then del(.mcpServers) else . end)
  ' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "✓ wired hooks into $settings (backup saved)"
  register_mcp "$dir"
}
is_config_dir() { [ -f "$1/settings.json" ] || [ -d "$1/projects" ] || [ -f "$1/.claude.json" ]; }

wire_hooks "$HOME/.claude"                       # work (default)
for d in "$HOME"/.claude-*; do                   # personal + any other profiles
  [ -d "$d" ] && is_config_dir "$d" && wire_hooks "$d"
done

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "! $BIN_DIR is not on your PATH. Add it:"
     echo "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

# --- optional: example zellij layout ----------------------------------------
if [ -d "$HOME/.config/zellij" ]; then
  ZL="$HOME/.config/zellij/layouts"
  mkdir -p "$ZL"
  ln -sf "$FLEET_HOME/layouts/fleet.kdl" "$ZL/fleet.kdl"
  echo "✓ linked layout -> $ZL/fleet.kdl  (launch: zellij --layout fleet attach -c fleet)"
fi

# --- did tmux actually land? -------------------------------------------------
# Last, because first is where it gets scrolled past: the tmux offer happens a few
# hundred lines of output earlier, and every shape of "no" ends up here — declined at
# the prompt, install failed, no package manager recognised, or no terminal to ask at.
# `npx ghostfleet-cli` in CI hit that last one and exited 0 having installed a fleet
# that cannot open a single session, because a session IS a tmux server. Say so where
# it will still be on screen.
if ! command -v tmux >/dev/null 2>&1; then
  echo
  echo "! tmux is STILL missing. Everything above is installed and wired, but the grid cannot"
  echo "  start a session without it — a fleet session IS a tmux server. Install tmux and you"
  echo "  are done; nothing here needs re-running."
  if [ "$ASSUME_YES" = 1 ]; then
    # $YES_VIA delegated the install to us and we did not manage it. Exit non-zero so an
    # unattended install FAILS here, instead of a CI job going green around a fleet that
    # cannot spawn anything.
    echo "  $YES_VIA was given, so this is an error, not a warning."
    exit 1
  fi
fi

echo
echo "Done. In a zellij pane:"
echo "    ghostfleet            # work profile   (~/.claude)"
echo "    ghostfleet personal   # personal       (~/.claude-personal)"
echo "Then press 'n' to add a session. (Layout: zellij --layout fleet attach -c <project>.)"
