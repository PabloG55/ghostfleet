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
# Re-run any time; it's idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${CLAUDE_FLEET_BIN:-$HOME/.local/bin}"
FLEET_HOME="${CLAUDE_FLEET_HOME:-$HOME/.local/libexec/ghostfleet}"

echo "ghostfleet installer"
echo "  repo:     $REPO   (development)"
echo "  runtime:  $FLEET_HOME   (executed from here)"
echo "  bin dir:  $BIN_DIR"
echo

command -v node >/dev/null 2>&1 || { echo "error: node is required (the v2 grid is a Node TUI)"; exit 1; }

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
    echo "  Non-interactive (no controlling terminal) — not auto-installing. Run: ${cmd[*]}"
    return 0
  fi
  case "$ans" in
    ""|y|Y|yes|YES|Yes)
      echo "  Running: ${cmd[*]}"
      if "${cmd[@]}"; then
        echo "✓ $pkg installed"
      else
        echo "! $pkg install failed — install it yourself: ${cmd[*]}"
      fi
      ;;
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

echo
echo "Done. In a zellij pane:"
echo "    ghostfleet            # work profile   (~/.claude)"
echo "    ghostfleet personal   # personal       (~/.claude-personal)"
echo "Then press 'n' to add a session. (Layout: zellij --layout fleet attach -c <project>.)"
