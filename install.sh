#!/usr/bin/env bash
# ghostfleet installer.
# - STAGES the runtime out of the repo into a non-TCC dir (see below), then:
# - symlinks bin/ghostfleet + bin/claude-here (and helpers) onto your PATH
# - wires hooks/fleet-event.sh into ~/.claude/settings.json (backing it up first), plus
#   hooks/fleet-guard.sh on PreToolUse and hooks/fleet-observe.sh alongside it on Stop
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
# ~ FOR $HOME, AND THE TILDE COMES FROM A VARIABLE — the same shape bin/fleet-demo uses and
# for the same reason: on bash 3.2 (the bash macOS ships) `${x/#$HOME/\~}` keeps the
# backslash, so a line written to be copy-pasted comes out with a `\~` in it. A parameter
# expansion is never re-parsed, so the variable is right on every version.
TILDE='~'
short() { printf '%s' "${1/#$HOME/$TILDE}"; }

usage() {
  cat <<'EOF'
ghostfleet installer

    ./install.sh [-y|--yes]          from a clone
    npx ghostfleet-cli [-y|--yes]    without cloning (args pass straight through)

  -v, --verbose  Narrate every step — what was staged, each command linked, each
                 config dir wired, each MCP registration. Same as CLAUDE_FLEET_VERBOSE=1.
                 The default prints a summary and what to run next; warnings and errors
                 print either way.
  -y, --yes    Install missing dependencies (tmux, jq — and the optional Claude Code,
               Neovim and LazyVim) WITHOUT prompting, using the
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

# --- how much of this to say ------------------------------------------------
# WHAT WAS WRONG WITH SAYING ALL OF IT. This installer wires a lot — a staged runtime,
# forty-odd symlinks, hooks and an MCP server into every Claude profile on the machine,
# two more agents, a zellij layout, a pre-push guard — and it narrated every step. That is
# the right output for the person debugging an install and exactly the wrong output for
# the person doing their first one, who cannot tell which of those lines they are supposed
# to act on, and whose actual next step ("now run something") was the last line under all
# of it.
#   So the default is a summary and a next step, and the narration moves behind --verbose.
# WARNINGS DO NOT MOVE. Every `!` line is unconditional, here and below: the whole value
# of quieting the successes is that a failure is now the only thing on the screen.
VERBOSE=0
case "${CLAUDE_FLEET_VERBOSE:-}" in
  ""|0|n|N|no|No|NO|false|False|FALSE|off|Off|OFF) ;;
  *) VERBOSE=1 ;;
esac
# ${VERBOSE:-0}, not $VERBOSE: test/run.sh lifts the two MCP registrars out of this file
# with sed and sources them on their own, so this function has to work with none of the
# rest of the script around it. Under `set -u` a bare $VERBOSE would abort the extracted
# copy instead of printing.
#   `return 0` because the last command is a test that is FALSE in the quiet case, and a
# helper whose status flips with a verbosity setting is a helper that will eventually be
# the reason a caller's `&&` chain stops running.
vsay() { [ "${VERBOSE:-0}" = 1 ] && printf '%s\n' "$*"; return 0; }
for a in "$@"; do
  case "$a" in
    -y|--yes)  ASSUME_YES=1; YES_VIA="--yes" ;;
    -v|--verbose) VERBOSE=1 ;;
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
vsay "  repo:     $REPO   (development)"
vsay "  runtime:  $FLEET_HOME   (executed from here)"
vsay "  bin dir:  $BIN_DIR"
[ "$ASSUME_YES" = 1 ] && echo "  deps:     $YES_VIA given — missing dependencies will be installed WITHOUT asking"

# IS THIS A RE-INSTALL? Measured BEFORE cf-sync stages anything, because afterwards the
# runtime always exists and the question can no longer be asked. It decides one thing: a
# first-timer does not need the live-sessions caveat at the end (they have no sessions),
# and somebody re-running the installer very often needs nothing else.
REINSTALL=0; [ -d "$FLEET_HOME/bin" ] && REINSTALL=1
echo


# Both consent paths — a yes typed at the tty, and --yes given in advance — install
# through this one place, so they cannot drift into installing differently.
# APT'S PACKAGE LISTS CAN BE EMPTY, AND THE ERROR NAMES THE PACKAGE, NOT THE CAUSE.
# `apt-get install -y nodejs` on a machine that has never run `apt-get update` answers
# "E: Unable to locate package nodejs" — which reads as "that package does not exist" and
# is nothing of the kind. Measured on a stock ubuntu:24.04, where all three prerequisites
# failed that way in a row; a just-installed WSL Ubuntu starts out the same. Refresh once,
# on the FIRST failure rather than up front, so only the machines that need it pay a network
# round trip — and say it out loud, because it is a second privileged command and the
# consent that was given was for the first.
APT_REFRESHED=0
pkg_run() {
  local pkg="$1"; shift
  echo "  Running: $*"
  if "$@"; then echo "✓ $pkg installed"; return 0; fi
  case " $* " in
    *" apt-get "*)
      if [ "$APT_REFRESHED" = 0 ]; then
        APT_REFRESHED=1
        local upd=(apt-get update); [ "$(id -u)" = 0 ] || upd=(sudo apt-get update)
        echo "  apt has no package lists yet, which is what that error means. Running: ${upd[*]}"
        if "${upd[@]}" >/dev/null 2>&1 && "$@"; then echo "✓ $pkg installed"; return 0; fi
      fi ;;
  esac
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
# THE BINARY AND THE PACKAGE ARE NOT ALWAYS THE SAME WORD. `node` is `nodejs` on apt, and
# asking apt for `node` installs an unrelated package (a tiny HTTP server, historically) —
# so the thing being LOOKED FOR and the thing being INSTALLED are separate arguments now.
# ensure_pkg keeps its one-argument form for the cases where they agree.
# WHEN THERE IS NOBODY TO SAY YES, SAY IT ONCE. Each offer used to print the same
# three-line "or consent up front" footer, so a machine missing all three prerequisites
# spent 9 of the installer's 16 lines repeating itself — and still left three separate
# install commands to run one at a time. Collect the packages instead and let
# report_missing_hard say it once, as a single install.
PKG_PENDING=()
PKG_PREFIX=""
ensure_pkg() { ensure_pkg_named "$1" "$1" "$2"; }
ensure_pkg_named() {
  local bin="$1" pkg="$2" why="$3"
  command -v "$bin" >/dev/null 2>&1 && return 0
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
    PKG_PENDING+=("$pkg")
    echo "! $bin not found — $why, and I don't recognize a package manager to install it with."
    echo "  Install it yourself, e.g.: brew install $pkg (macOS) / apt-get, dnf, yum, pacman, zypper, or apk install $pkg (Linux)"
    return 0
  fi

  # The BINARY is what the reader just failed to run, so it is what the line must name.
  # With the two words split apart this printed "! nodejs not found" at somebody who had
  # typed `node` — naming a package they had never heard of as the thing that was missing.
  echo "! $bin not found — $why."

  # All but the last element: the package name is always last, so what is left is the
  # manager's invocation, which is the same for every package and is what lets the final
  # report offer one command instead of one per prerequisite. AFTER the no-manager return
  # above — an empty cmd makes this a negative-length slice, which is a bash syntax error
  # at runtime, in a branch that only fires on a distro nobody here tests on.
  PKG_PREFIX="${cmd[*]:0:$(( ${#cmd[@]} - 1 ))}"

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
    # Don't stop at "not auto-installing" — that line is true, actionable only by a human,
    # and printed precisely where no human is. But don't print the way out once per package
    # either: record it, and let the single report at the end name the flag AND every
    # package in one command.
    PKG_PENDING+=("$pkg")
    echo "  Non-interactive (no controlling terminal) — not auto-installing."
    return 0
  fi
  case "$ans" in
    ""|y|Y|yes|YES|Yes) pkg_run "$pkg" "${cmd[@]}" || true ;;
    *) PKG_PENDING+=("$pkg"); echo "  Skipped. Install it yourself: ${cmd[*]}" ;;
  esac
}
# NODE IS OFFERED, NOT DEMANDED. It was the one prerequisite of three with no way out: jq
# and tmux are offered right here, and node — which strictly more of this depends on —
# printed one line and exited 1. Measured on a fresh ubuntu:24.04, which ships none of
# node, npm, git, tmux, jq or curl: the clone path died on the word "error", having
# installed nothing and suggested nothing.
#   The package is `node` on brew and `nodejs` on every Linux manager here (apt, dnf, yum,
# pacman, apk), which is why the binary and the package are separate arguments — asking apt
# for `node` installs an unrelated package. Same consent rule as the other two: nothing is
# installed, and nothing is sudo'd, without a yes at the terminal or an explicit --yes.
NODE_PKG=node; [ "$(uname -s)" = Linux ] && NODE_PKG=nodejs
ensure_pkg_named node "$NODE_PKG" \
  "every screen here is a Node program — the grid, the phone server and the MCP server"
ensure_pkg jq   "this installer edits settings.json and .claude.json with it, and the status hook parses its payload with it"
ensure_pkg tmux "the grid needs it"

# THE nodejs APT INSTALLS IS TOO OLD TO RUN A CLONE'S BUILD. Ubuntu 24.04 ships 18.19;
# vite 8 needs 20.19. Measured end to end on a fresh one: the install accepted every offer,
# ran ~3,900 lines of apt and npm, and died in the build on `SyntaxError: The requested
# module 'node:util' does not provide an export named 'styleText'` — a stack trace about a
# Node internal, half a minute after the last thing the reader typed, naming neither node
# nor a version nor anything to do about it. Ask the version question up here, where the
# answer is one line.
#   ONLY FOR A TREE THAT BUILDS. The fleet itself runs on the older node perfectly well, and
# an unpacked npx cache ships web/ already built — stopping those installs over a build they
# will never run would be inventing a prerequisite.
NODE_BUILD_MIN=20.19
node_ge() {   # $1 have, $2 want — major.minor, numeric, no sort -V (BSD sort lacks it)
  local hM hm wM wm
  IFS=. read -r hM hm _ <<< "$1"
  IFS=. read -r wM wm _ <<< "$2"
  [ "${hM:-0}" -gt "${wM:-0}" ] && return 0
  [ "${hM:-0}" -lt "${wM:-0}" ] && return 1
  [ "${hm:-0}" -ge "${wm:-0}" ]
}
if [ -f "$REPO/vite.config.mjs" ] && [ -d "$REPO/web/src" ] && command -v node >/dev/null 2>&1; then
  NODE_HAVE="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  if ! node_ge "$NODE_HAVE" "$NODE_BUILD_MIN"; then
    echo
    echo "! node $NODE_HAVE cannot build the phone client — vite needs $NODE_BUILD_MIN or newer."
    echo "  This is a CLONE, and a clone builds web/src before anything is staged, so the"
    echo "  install stops here rather than 3,000 lines further on inside the build."
    echo "  Debian/Ubuntu ship 18.x, which is why you are reading this. Either:"
    echo "      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "      nvm install 22    # https://github.com/nvm-sh/nvm"
    echo "  Then re-run this installer. Or skip the build entirely and install the published"
    echo "  package instead, which ships web/ already built:  npx ghostfleet-cli"
    exit 1
  fi
fi

# …AND APT'S `nodejs` DOES NOT CARRY npm EITHER, WHICH A CLONE'S BUILD NEEDS. brew's node
# does carry it, so this only ever fires on Linux — and it fired on a fresh ubuntu:24.04,
# where the install ran all the way to "Done. Next:" having staged nothing at all: cf-sync
# builds web/ from web/src before it copies a single file, found neither pnpm nor npm, and
# stopped. Asked only of a source tree that can actually build, which is cf-sync's own gate
# — an unpacked npx cache ships web/ already built and has no business being asked for a
# toolchain it will never run. AFTER the version gate above, because installing a build
# tool for a node that cannot run the build is 300 lines of apt spent on the way to an error.
if [ -f "$REPO/vite.config.mjs" ] && [ -d "$REPO/web/src" ] && ! command -v pnpm >/dev/null 2>&1; then
  ensure_pkg npm "the phone client is built from web/src before anything is staged"
fi

# EVERY PREREQUISITE THAT IS STILL MISSING, IN ONE PLACE, WITH ONE COMMAND TO FIX THEM ALL.
# Reporting one and stopping sends somebody to install it and re-run straight into the next
# one — and a stock Ubuntu container has none of node, jq or tmux, so that is three round
# trips through a script whose whole job is to be run once. Measured there: the old output
# named three separate install commands and then exited on a bare `error: jq is required`,
# which is the fourth thing to read and the first one that stops you.
#   It reports rather than decides. The jq gate below stops because jq is what the wiring is
# WRITTEN with; node and tmux are only needed later, by the fleet, so they warn and the
# install still finishes. Both callers print the same block, so the reader sees one shape.
report_missing_hard() {
  local miss=() pkgs=() m
  command -v node >/dev/null 2>&1 || miss+=(node)
  command -v jq   >/dev/null 2>&1 || miss+=(jq)
  command -v tmux >/dev/null 2>&1 || miss+=(tmux)
  [ "${#miss[@]}" -eq 0 ] && return 0

  echo
  echo "! still missing, and the fleet needs all of these:"
  for m in "${miss[@]}"; do
    case "$m" in
      node) echo "    node — every screen is a Node program: the grid, the phone server, the MCP server" ;;
      jq)   echo "    jq   — the hooks and the MCP registration are written with it" ;;
      tmux) echo "    tmux — a fleet session IS a tmux server, so the grid cannot open one" ;;
    esac
    # node is `nodejs` to every Linux manager here and `node` only to brew, which is why
    # the loop translates rather than printing the binary name into an install command.
    if [ "$m" = node ]; then pkgs+=("$NODE_PKG"); else pkgs+=("$m"); fi
  done

  if [ -n "$PKG_PREFIX" ]; then
    echo "  One command installs the lot:"
    echo "      $PKG_PREFIX ${pkgs[*]}"
  else
    # No package manager was recognised, so there is no ONE command — say which line is
    # for which machine rather than printing two under a heading that promises one.
    echo "  Whichever of these your machine is:"
    echo "      brew install ${miss[*]}"
    echo "      sudo apt-get install -y ${miss[*]/node/nodejs}"
  fi
  if [ "$ASSUME_YES" != 1 ]; then
    # WHERE THE FLAG GOES decides whether we ever see it. `--yes`/`-y` is also npx's own
    # flag, so BEFORE the package name npm consumes it and this script is invoked with no
    # arguments at all — landing here, printing "pass --yes", at somebody who is certain
    # they did. Measured on npm 11.18: after the package name it reaches us (and we never
    # get here); before it, argv is empty and npm leaves its own parse behind in
    # npm_config_yes ("true"), which is the only way to tell the two apart. A plain
    # `npx ghostfleet-cli` leaves that variable set but EMPTY, so it must not count.
    echo "  Or let the installer do it: ./install.sh --yes  (or npx ghostfleet-cli --yes, or CLAUDE_FLEET_YES=1)"
    case "${npm_config_yes:-}" in
      ""|false|0) ;;
      *) echo "  (npm swallowed a --yes of its own: it only reaches this installer AFTER the"
         echo "   package name — 'npx ghostfleet-cli --yes', not 'npx --yes ghostfleet-cli'.)" ;;
    esac
  fi
  return 1
}

# --- optional: the agent, and the editor behind ^N ---------------------------
# WHY THE INSTALLER AND NOT THE README. `npx ghostfleet-cli` is the one command people
# run, and everything it did not install was found later, one failure at a time: no
# `claude` meant a fleet that opened sessions with nothing in them, and no editor meant
# ^N — a key the fleet takes over inside every session — answered from inside tmux with
# `'fleet-tab edit …' returned 1` and nothing else. Measured on a fresh WSL Ubuntu: both
# missing, both discovered only by pressing things.
#   OPTIONAL, unlike jq and tmux: a fleet runs without an editor, and without claude when
# every project uses another agent. So a "no" is final and never an error, and neither
# offer can fail the install.
#   ASKED ONLY WHEN SOMEBODY IS WATCHING — stdout a terminal, not just /dev/tty openable.
# A required dependency has to ask wherever it can (see ensure_pkg), but an optional one
# asked of a /dev/tty whose output is going to a pipe is a prompt nobody reads: the suite
# captures this installer with $(…) from a real terminal, and a question there would hang
# the run. With nobody watching, everything skipped goes on ONE line — the first-install
# output is held to a screen, and a line per optional item is how that budget goes.
# 0 = yes, 1 = no, 2 = nobody to ask.
ask_optional() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 1 ] && ( exec 3<>/dev/tty ) 2>/dev/null || return 2
  local ans=""
  exec 9<>/dev/tty
  printf '%s [Y/n] ' "$1" >&9
  read -r ans <&9 || ans=""
  exec 9>&- 9<&-
  case "$ans" in ""|y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}
UNASKED=()   # optional items skipped because nobody could be asked

# Claude Code: the native installer, not `npm install -g`. On a stock Linux node the
# global prefix is /usr/lib or /usr/local and not writable, so the npm route needs sudo
# for a tool that has no business being root-owned; the native one lands in ~/.local/bin
# with no privilege at all.
if ! command -v claude >/dev/null 2>&1; then
  CLAUDE_INSTALL='curl -fsSL https://claude.ai/install.sh | bash'
  rc=0; ask_optional "! claude (Claude Code, the default agent) not found. Install it with: $CLAUDE_INSTALL ?" || rc=$?
  case $rc in
    0) # A PIPELINE'S STATUS IS ITS RIGHT-HAND SIDE'S. `curl … | bash` on a machine with no
       # curl exits 0 — bash ran fine, on empty input — so this printed "✓ claude installed"
       # one line under `curl: command not found`. Measured on a stock ubuntu:24.04, which
       # ships no curl: the installer claimed the agent was there and the first session
       # opened empty. pipefail makes curl's failure the pipeline's, and the `command -v`
       # after it checks the artifact rather than a proxy for it, so a download that exits 0
       # without writing the binary is caught too.
       if bash -o pipefail -c "$CLAUDE_INSTALL" \
          && { export PATH="$HOME/.local/bin:$PATH"; hash -r; command -v claude >/dev/null 2>&1; }; then
         echo "✓ claude installed — run \`claude\` once to sign in before starting a session"
       else
         echo "! claude install failed — install it yourself: $CLAUDE_INSTALL"
         command -v curl >/dev/null 2>&1 || echo "  (there is no curl on this machine either, and that command needs one.)"
       fi ;;
    1) echo "  Skipped. Install it yourself: $CLAUDE_INSTALL" ;;
    2) UNASKED+=("Claude Code") ;;
  esac
fi

# THE EDITOR ^N OPENS: $CLAUDE_FLEET_EDITOR, then $EDITOR, then nvim — the order
# bin/fleet-tab resolves it in. Only nvim is ours to install; somebody who named another
# editor is told it is missing and left to it.
#   LAZYVIM WANTS NEOVIM >= 0.11.2, and the distro package is not that everywhere:
# Ubuntu 24.04's apt neovim is 0.9.5 (26.04's is 0.11.6). So on Linux this is the
# official release tarball, unpacked under ~/.local — current on every distro, no sudo,
# and nothing for the package manager to fight over. macOS takes brew's, which is current.
#   The LazyVim starter goes in only where there is NO nvim config at all: an existing
# ~/.config/nvim is somebody's editor, and replacing it is not an install step.
NVIM_MIN=0.11.2
nvim_ok() {
  local v; v="$(nvim --version 2>/dev/null | head -1 | sed -n 's/^NVIM v\([0-9.]*\).*/\1/p')"
  [ -n "$v" ] && [ "$(printf '%s\n%s\n' "$NVIM_MIN" "$v" | sort -V | head -1)" = "$NVIM_MIN" ]
}
install_nvim() {
  case "$(uname -s)" in
    Darwin) command -v brew >/dev/null 2>&1 && brew install neovim && return 0 ;;
    Linux)
      local arch; case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=arm64 ;; *) arch="" ;; esac
      if [ -n "$arch" ] && command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
        local dir="$HOME/.local/nvim-linux-$arch"
        mkdir -p "$HOME/.local" "$BIN_DIR" \
          && curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$arch.tar.gz" \
               | tar xz -C "$HOME/.local" \
          && ln -sf "$dir/bin/nvim" "$BIN_DIR/nvim" && export PATH="$BIN_DIR:$PATH" && hash -r && return 0
      fi ;;
  esac
  return 1
}
NVIM_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
ED="${CLAUDE_FLEET_EDITOR:-${EDITOR:-nvim}}"; ED="${ED%% *}"
if [ "$ED" != nvim ] && [ "${ED##*/}" != nvim ]; then
  command -v "$ED" >/dev/null 2>&1 \
    || echo "! $ED (your editor, which ^N opens) is not installed — ^N will say so until it is"
elif ! nvim_ok || [ ! -e "$NVIM_CFG" ]; then
  want=()
  nvim_ok || want+=("Neovim")
  [ -e "$NVIM_CFG" ] || want+=("LazyVim")
  what="$(printf '%s + ' "${want[@]}")"; what="${what% + }"
  rc=0; ask_optional "! ^N opens an editor on a session's folder, and $what is not set up. Install $what now?" || rc=$?
  case $rc in
    0)
      if nvim_ok || install_nvim; then
        nvim_ok && vsay "✓ neovim $(nvim --version | head -1)"
        if [ ! -e "$NVIM_CFG" ]; then
          if git clone -q --depth 1 https://github.com/LazyVim/starter "$NVIM_CFG" 2>/dev/null; then
            rm -rf "$NVIM_CFG/.git"
            echo "✓ $what ready for ^N — the first launch downloads LazyVim's plugins, give it a minute"
          else echo "! could not fetch the LazyVim starter — git clone https://github.com/LazyVim/starter $NVIM_CFG"; fi
        else echo "✓ neovim ready for ^N (your $NVIM_CFG is untouched)"; fi
      else
        echo "! could not install Neovim here — install $NVIM_MIN or newer yourself, or set CLAUDE_FLEET_EDITOR"
      fi ;;
    1) if nvim_ok; then echo "  Skipped. ^N will open plain Neovim."
       else echo "  Skipped. ^N needs an editor: install Neovim $NVIM_MIN+, or set CLAUDE_FLEET_EDITOR."; fi ;;
    2) UNASKED+=("$what (the editor ^N opens)") ;;
  esac
fi
if [ "${#UNASKED[@]}" -gt 0 ]; then
  _u="$(printf '%s, ' "${UNASKED[@]}")"
  # "NOBODY TO ASK" IS THIS SCRIPT'S OWN VOCABULARY. It means "stdout is not a terminal, so
  # a [Y/n] would have gone to a pipe" — obvious from in here, and from out there it is a
  # riddle attached to the two optional things a first install skips. Say the condition, not
  # the internal name for it, and put the two ways out on their own line where they read as
  # instructions rather than as a trailing clause.
  echo "· skipped, because this install had no terminal to ask at: ${_u%, }"
  echo "  Run the installer again in a terminal to be asked, or pass --yes to accept up front."
fi

# jq is the one that cannot be deferred: the wiring below is written WITH jq, so a
# declined or failed install has to stop here rather than half-configure a config dir.
# tmux can wait — nothing in this script needs it, only the fleet does, later.
if ! command -v jq >/dev/null 2>&1; then
  report_missing_hard || true
  echo
  echo "error: jq is required to wire the hooks and MCP server, so this stops here rather than"
  echo "       half-configure a config dir. Install the above and re-run — nothing it already"
  echo "       did needs undoing."
  exit 1
fi

chmod +x "$REPO"/hooks/*.sh "$REPO"/bin/*

# --- stage the runtime out of the repo (into a non-TCC location) ------------
# cf-sync copies bin/tmux/hooks/mcp/skill/layouts/web from the repo into FLEET_HOME
# and records the repo in FLEET_HOME/.source (so `cf-sync` alone re-syncs later).
#
# THAT POINTER IS A FOOTGUN, and this is where it goes off. `.source` is the only thing
# telling a later `cf-sync` where to sync FROM, and cf-sync records whatever it was
# handed — correctly, it cannot know better. So running the npm/npx installer on a
# machine that ALREADY has a clone repointed .source at the npx cache, and from then on
# `cf-sync` in the clone copied the CACHE into the live runtime: your edits stop
# arriving, nothing errors, and the sync still prints "synced runtime". That is the
# repo-vs-runtime trap at the top of CLAUDE.md, reached from a direction no message
# mentions and with the success line asserting it did not happen.
#   So: when the copy we are RUNNING FROM is not a git repo (npx cache, unpacked
# tarball) and the recorded source is one, stage from here — that is what the person
# asked for by running npx — and then put the pointer back. An install run from a clone
# always repoints, unchanged: that includes a re-install from the same clone, a moved
# clone, and a second clone, because the guard only ever fires when THIS copy could not
# serve as a sync source in the first place.
is_repo() { [ -e "$1/.git" ]; }   # a directory in a clone, a FILE in a git worktree
KEEP_SOURCE=""
if ! is_repo "$REPO"; then
  prev="$(cat "$FLEET_HOME/.source" 2>/dev/null || true)"
  if [ -n "$prev" ] && [ "$prev" != "$REPO" ] && is_repo "$prev"; then KEEP_SOURCE="$prev"; fi
fi
# cf-sync narrates its own success in two lines. Keep them for --verbose, and on a
# FAILURE keep them unconditionally: it prints "the runtime is now a MIX of old and new
# code, do not trust it" to stderr, and that must never be something a quiet mode ate.
#   SO CAPTURE BOTH STREAMS, not just stdout. cf-sync's advice on stderr is written for
# somebody typing `cf-sync` by hand — "this source is not a git repo; if the code you edit
# lives in a clone, point this at it once" is true and useful there, and on a first install
# it is the first thing the reader sees, phrased as a caveat, about a clone they do not
# have. Quiet means quiet on success; the failure path below prints every line of it.
_sync_rc=0
if [ "$VERBOSE" = 1 ]; then
  # `|| _sync_rc=$?` and not a bare call: under `set -e` a failing cf-sync would take the
  # whole script out here with its own status and none of the explanation below.
  CLAUDE_FLEET_HOME="$FLEET_HOME" "$REPO/bin/cf-sync" --deps "$REPO" || _sync_rc=$?
else
  _sync_out="$(CLAUDE_FLEET_HOME="$FLEET_HOME" "$REPO/bin/cf-sync" --deps "$REPO" 2>&1)" \
    || { _sync_rc=$?; printf '%s\n' "$_sync_out"; }
fi
# A FAILED STAGE IS THE END OF THE INSTALL, NOT A LINE IN IT. cf-sync copies nothing when it
# fails, so every step below links symlinks at files that are not there and then prints a
# "Done. Next:" block naming commands that do not exist. Measured on a fresh ubuntu:24.04:
# the build found no npm, cf-sync said NOT SYNCED, and the installer went on to report
# `✓ linked 0 commands` and exit 0 — a green install of nothing, which is the one outcome
# worse than a red one, because nobody re-runs it.
if [ "${_sync_rc:-0}" != 0 ]; then
  echo
  echo "error: the runtime was not staged, so nothing was installed. The lines above from"
  echo "       cf-sync say why. Nothing on this machine changed$([ -d "$FLEET_HOME/bin" ] && echo " — a runtime from an earlier install is still there, untouched")."
  echo "       Fix what it names and re-run this installer."
  exit 1
fi
if [ -n "$KEEP_SOURCE" ]; then
  printf '%s\n' "$KEEP_SOURCE" > "$FLEET_HOME/.source"
  echo "· this install ran from $REPO, which is not a git repo,"
  echo "  so cf-sync's source pointer stays on your clone: $KEEP_SOURCE"
  echo "  (to repoint it deliberately: cf-sync /path/to/ghostfleet)"
fi
chmod +x "$FLEET_HOME"/hooks/*.sh "$FLEET_HOME"/bin/* 2>/dev/null || true

# Everything below points at the STAGED runtime, never the repo.
HOOK="$FLEET_HOME/hooks/fleet-event.sh"
GUARD="$FLEET_HOME/hooks/fleet-guard.sh"
OBSERVE="$FLEET_HOME/hooks/fleet-observe.sh"

mkdir -p "$BIN_DIR"
CF_BINS=(ghostfleet claude-here cf-sync fleet-schedule fleet-send fleet-list fleet-read
         fleet-spawn fleet-jump fleet-pause fleet-resume fleet-governor fleet-statusbar
         fleet-worktrees fleet-ack fleet-answer fleet-inbox fleet-stop fleet-scratch fleet-companion fleet-tab fleet-copy fleet-merged fleet-shipped fleet-look.mjs fleet-shots.mjs
         fleet-clean fleet-open fleet-restart fleet-project fleet-demo fleet-phone fleet-adopt fleet-awake fleet-cycle
         fleet-rename fleet-agent fleet-stack fleet-slot fleet-serve fleet-hibernate fleet-meter.mjs fleet-review
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
# The COUNT by default, the roster under --verbose. The roster is forty-odd names on one
# wrapped line and is the single biggest block of output here; it is also the thing you
# want when a command is missing, which is a --verbose question.
# ZERO IS NEVER A SUCCESS, and it printed as one: `✓ linked 0 commands` under forty lines
# of "not in the runtime — skipped". The stage gate above should make this unreachable; it
# stays because it checks the artifact — what is actually on PATH — rather than the exit
# code of the step that was supposed to put it there.
if [ "${#linked[@]}" -eq 0 ]; then
  echo "! linked 0 commands — the runtime at $FLEET_HOME has no bin/ to link from."
  echo "  Nothing is on your PATH, so nothing below will run. Re-run this installer."
  exit 1
elif [ "$VERBOSE" = 1 ]; then echo "✓ linked ${#linked[@]} commands (${linked[*]}) -> $BIN_DIR"
else                          echo "✓ linked ${#linked[@]} commands -> $BIN_DIR"; fi

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
    vsay "✓ installed the OpenCode event bridge -> $OC_PLUGIN_DIR/ghostfleet-event.js"
  else
    echo "! could not create $OC_PLUGIN_DIR — OpenCode workers will fall back to pane-only detection"
  fi
else
  vsay "· opencode not installed — skipping its event bridge (fleet-spawn --agent opencode will refuse until it is)"
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
      vsay "✓ registered ghostfleet MCP (user scope) -> $dir/.claude.json"
    else
      echo "! could not 'claude mcp add' in $dir — run: CLAUDE_CONFIG_DIR=$dir claude mcp add -s user --transport stdio ghostfleet -- node $mcp"
    fi
  else
    # no claude CLI on PATH — write the top-level mcpServers into .claude.json directly
    local cj="$dir/.claude.json" t; [ -f "$cj" ] || echo '{}' > "$cj"; t="$(mktemp)"
    if jq --arg m "$mcp" '.mcpServers = ((.mcpServers // {}) + { "ghostfleet": { type:"stdio", command:"node", args:[$m], env:{} } })' "$cj" > "$t" 2>/dev/null; then
      mv "$t" "$cj"; vsay "✓ wrote ghostfleet MCP -> $cj"
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
  jq --arg hook "$HOOK" --arg guard "$GUARD" --arg observe "$OBSERVE" '
    def entry: [ { matcher: "", hooks: [ { type: "command", command: $hook } ] } ];
    # STOP CARRIES TWO OF OURS: the status/notify hook, and the observation enforcer that
    # refuses a lead done-claim on a turn that changed a surface and never looked at it.
    #   ORDER, and it is deliberate. fleet-event.sh runs FIRST because it always exits 0 and
    # its whole job is to record state; fleet-observe.sh runs second because it may exit 2.
    # A refused Stop therefore leaves the status file briefly saying `ready` while the session
    # works on — harmless, and checked: the worker->inbox block in fleet-event.sh is gated on
    # the slot NOT being master, and the enforcer only ever fires for master, so a refused
    # stop cannot emit a false `done` to anybody.
    def stopentry: [ { matcher: "", hooks: [ { type: "command", command: $hook },
                                             { type: "command", command: $observe } ] } ];
    .hooks = ((.hooks // {}) + {
      Notification: entry, Stop: stopentry, UserPromptSubmit: entry,
      SessionStart: entry, SessionEnd: entry })
    # PreToolUse is SHARED GROUND — unlike the five above, other tools legitimately
    # live here, so ours is APPENDED, never assigned over the top. Stanzas pointing at
    # our guard are dropped first so re-installing (or changing the matcher) replaces
    # rather than stacks up copies — which is what makes ADDING a tool to the matcher a
    # safe re-install rather than a second stanza racing the first.
    # The matcher is a regex over the tool name: EnterWorktree would move this session,
    # and Agent (Task in older builds) would do the work somewhere the fleet cannot see.
    | .hooks.PreToolUse = (
        [ (.hooks.PreToolUse // [])[]
          | select([.hooks[]?.command] | index($guard) | not) ]
        + [ { matcher: "EnterWorktree|Agent|Task",
              hooks: [ { type: "command", command: $guard } ] } ] )
    | (if .mcpServers then .mcpServers |= del(.["ghostfleet"]) else . end)
    | (if (.mcpServers // {}) == {} then del(.mcpServers) else . end)
  ' "$settings" > "$tmp" && mv "$tmp" "$settings"
  vsay "✓ wired hooks into $settings (backup saved)"
  # COUNTED HERE, where the work happens, rather than by re-deriving the profile list for
  # the summary. A summary maintained separately from the work it summarises is a summary
  # that will lie — the linked-commands line above carries that exact scar.
  N_WIRED=$((N_WIRED + 1))
  register_mcp "$dir"
}
is_config_dir() { [ -f "$1/settings.json" ] || [ -d "$1/projects" ] || [ -f "$1/.claude.json" ]; }
N_WIRED=0

wire_hooks "$HOME/.claude"                       # work (default)
for d in "$HOME"/.claude-*; do                   # personal + any other profiles
  [ -d "$d" ] && is_config_dir "$d" && wire_hooks "$d"
done
# ONE LINE FOR THE WHOLE LOOP, and it has to exist: quieting the per-profile narration
# without replacing it would leave the default output claiming only that some symlinks
# were made, with nothing saying the hooks and the MCP server — the parts that make a
# session report its status and a lead able to drive one — reached anything at all. A
# summary that omits the main work is not quieter, it is wrong.
#   The COUNT is what matters here rather than the names: "2 profiles" answers "did it
# find my personal profile too", which is the question this loop exists for, and
# --verbose still names each file it wrote.
echo "✓ wired hooks + MCP into $N_WIRED Claude profile$([ "$N_WIRED" = 1 ] || echo s)"

# --- the other two agents' MCP: one registration each, and that is correct ----
# WHY THIS LOOKS WRONG NEXT TO THE CLAUDE PATH ABOVE, AND IS NOT. register_mcp() runs once
# PER CLAUDE CONFIG DIR because for Claude a profile IS a config dir — ~/.claude and
# ~/.claude-personal are different accounts with different settings.json files, so the
# server has to be named in each. codex keeps ONE global config (~/.codex/config.toml) and
# opencode likewise (~/.config/opencode/opencode.jsonc); neither has a per-profile
# equivalent to register into.
#   That is not a compromise, because the server does not carry a fleet: mcp/fleet-mcp.mjs
# resolves which fleet and which profile it is serving from the SESSION's environment at
# runtime — CLAUDE_FLEET_SOCK and CLAUDE_CONFIG_DIR, read per call in
# mcp/fleet-dispatch.mjs — and agent-here exports both when it starts a session in a pane.
# So one registration is right for every fleet and every profile at once, and a second one
# would be the same line written twice.
#   ...WITH ONE MEASURED EXCEPTION, and it is codex's, not ours. That runtime resolution
# needs the session's CLAUDE_FLEET_SOCK to reach the server, and opencode passes its
# environment to an MCP child while codex SCRUBS it (2026-08-27: a codex session with the
# variable exported called fleet_list and the server's child answered "fleet-list: no
# socket"; `-c shell_environment_policy.inherit=all` changes nothing, since that policy is
# about its shell tool). A codex session therefore has to name the project —
# fleet_list(project: "ghostfleet") works, fleet_list() cannot — which is recorded as the
# `mcp_self` field in bin/fleet-agent and printed in its caveat. It does not change WHERE
# to register: there is still exactly one place per CLI to put it.
#
# WHAT THIS DOES NOT GIVE THEM, said here because the two are easy to conflate: MCP is
# TOOLS, hooks are PUSH EVENTS. A codex session can now CALL the fleet; it still tells the
# fleet nothing. It writes no inbox row, wakes no master, and its status is still read from
# its pane by fleet-agent's busy_re. "You can see it, you will not be told" is exactly as
# true after this as before. opencode has both halves (hooks/opencode-fleet-event.js), so
# opencode reaches near parity; codex does not.
#   Neither gets the orchestrate skill, which is a Claude Code feature — see
# skill/ghostfleet-orchestrate and the note in bin/fleet-agent's `skill` field. They have
# the tools without the instructions for using them.
register_codex_mcp() {
  local mcp="$FLEET_HOME/mcp/fleet-mcp.mjs"
  if ! command -v codex >/dev/null 2>&1; then
    vsay "· codex not installed — skipping its MCP registration (fleet-spawn --agent codex will refuse until it is)"
    return 0
  fi
  # IDEMPOTENT BY MEASUREMENT, not by hope: a second `codex mcp add` of the same name
  # rewrites that one [mcp_servers.ghostfleet] table and leaves every other key in
  # config.toml alone (checked with `model`/`approval_policy` present, codex-cli 0.149.1).
  # So no remove-first dance, and re-running the installer cannot stack up entries.
  if codex mcp add ghostfleet -- node "$mcp" >/dev/null 2>&1; then
    vsay "✓ registered ghostfleet MCP -> ${CODEX_HOME:-$HOME/.codex}/config.toml (codex, global)"
  else
    echo "! could not 'codex mcp add' — run: codex mcp add ghostfleet -- node $mcp"
  fi
}

# opencode's OWN CLI IS NOT USED, and this is the same call install.sh already makes for
# .claude.json when the claude binary is absent: write the config file directly.
# `opencode mcp add <name> -- <cmd>` exists and is non-interactive (the command after `--`
# is undocumented in its --help), but measured on opencode 1.18.21 it cannot be pointed at
# a file:
#   - with XDG_CONFIG_HOME set it created a directory literally named `undefined` in the
#     CWD and wrote undefined/<tail>/opencode/opencode.jsonc — inside the repo, in the case
#     that found this
#   - with HOME set and XDG unset it ignored HOME and wrote the invoking user's real
#     ~/.config/opencode/opencode.jsonc
#   - both exited 0 and printed "added to <path>", one of them naming a path it had not
#     written
# A tool that reports success while writing somewhere else cannot be tested without
# editing the developer's own config, and an installer that shells out to it cannot say
# whether it worked. jq can, and the entry it writes is byte-shaped like the CLI's own
# output ({type:"local", command:[…]}), which is where that shape came from.
register_opencode_mcp() {
  local mcp="$FLEET_HOME/mcp/fleet-mcp.mjs"
  if ! command -v opencode >/dev/null 2>&1; then
    vsay "· opencode not installed — skipping its MCP registration"
    return 0
  fi
  local dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode" cfg t
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "! could not create $dir — opencode gets no fleet_* tools"
    return 0
  fi
  # .jsonc is what opencode writes and what exists on a machine that has run it, but a
  # plain .json is equally valid to it — so an existing one is edited rather than shadowed
  # by a second file whose precedence nobody here can state.
  cfg="$dir/opencode.jsonc"
  [ -f "$cfg" ] || { [ -f "$dir/opencode.json" ] && cfg="$dir/opencode.json"; }
  [ -f "$cfg" ] || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$cfg"
  t="$(mktemp)"
  # `.mcp = (.mcp // {}) + {…}` REPLACES our key and keeps every other server, which is
  # what makes a re-install idempotent — the same assignment shape register_mcp() uses on
  # .claude.json.
  if jq --arg m "$mcp" '.mcp = ((.mcp // {}) + { ghostfleet: { type: "local", command: ["node", $m] } })' "$cfg" > "$t" 2>/dev/null; then
    mv "$t" "$cfg"
    vsay "✓ wrote ghostfleet MCP -> $cfg (opencode, global)"
  else
    rm -f "$t"
    # A .jsonc may legally hold comments, which jq cannot read. Refusing to touch it is the
    # only safe answer — rewriting it would silently delete somebody's comments — so say
    # exactly what to paste instead of failing quietly.
    echo "! $cfg is not readable as JSON (a .jsonc may contain comments), so it was left alone."
    echo "  Add this to it by hand:  \"mcp\": { \"ghostfleet\": { \"type\": \"local\", \"command\": [\"node\", \"$mcp\"] } }"
  fi
}
register_codex_mcp
register_opencode_mcp

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) # NAME THE READER'S OWN RC FILE. This said ~/.zshrc unconditionally, so on Linux —
     # where the login shell is bash far more often than not — the one copy-pasteable line
     # in the whole install appended to a file that shell never reads, and the next command
     # was still not found. $SHELL is the login shell, which is the one whose rc file a new
     # terminal will source; $0 is whatever is running this script and can be the `bash` of
     # a `curl | bash`, so it is not the question being asked.
     case "${SHELL##*/}" in
       zsh)  _rc="$HOME/.zshrc" ;;
       bash) _rc="$HOME/.bashrc" ;;
       fish) _rc="" ;;
       *)    _rc="$HOME/.profile" ;;
     esac
     echo "! $BIN_DIR is not on your PATH. Add it:"
     if [ -n "$_rc" ]; then
       echo "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $(short "$_rc") && . $(short "$_rc")"
     else
       echo "    fish_add_path $BIN_DIR"
     fi ;;
esac

# --- optional: example zellij layout ----------------------------------------
if [ -d "$HOME/.config/zellij" ]; then
  ZL="$HOME/.config/zellij/layouts"
  mkdir -p "$ZL"
  ln -sf "$FLEET_HOME/layouts/fleet.kdl" "$ZL/fleet.kdl"
  vsay "✓ linked layout -> $ZL/fleet.kdl  (launch: zellij --layout fleet attach -c fleet)"
fi

# --- did they actually land? -------------------------------------------------
# Last, because first is where it gets scrolled past: the offers happen a few hundred lines
# of output earlier, and every shape of "no" ends up here — declined at the prompt, install
# failed, no package manager recognised, or no terminal to ask at. `npx ghostfleet-cli` in
# CI hit that last one and exited 0 having installed a fleet that cannot open a single
# session, because a session IS a tmux server. Say so where it will still be on screen.
if ! report_missing_hard; then
  if [ "$ASSUME_YES" = 1 ]; then
    # $YES_VIA delegated the install to us and we did not manage it. Exit non-zero so an
    # unattended install FAILS here, instead of a CI job going green around a fleet that
    # cannot spawn anything.
    echo
    echo "  $YES_VIA was given, so the above is an error, not a warning."
    exit 1
  fi
fi

# --- and the trap that makes a correct install look broken -------------------
# AN MCP SERVER IS SPAWNED ONCE PER SESSION AND LIVES AS LONG AS IT. Everything above is
# written to config files, and a session that is already running read those files when it
# started — so no session open right now gains the fleet_* tools, however many times this
# is re-run. CLAUDE.md records the live case: a worker called fleet_stop(reclaim: true) on
# a five-day-old server, which accepted the argument and silently ignored it, because the
# file on disk was current and the PROCESS was not.
#   This is in the installer's own output and not only in the docs, because the person who
# needs it is the person who has just re-run the installer to fix exactly this and is about
# to conclude it did not work.
#
#   AND THAT SENTENCE IS ALSO WHO IT IS FOR. It is the most confusing failure this project
# has, and it can only happen to somebody who ALREADY HAD SESSIONS OPEN when they ran this
# — which is precisely a re-install. On a first install there is no running session for a
# stale server to be attached to, so the warning describes something that cannot have
# happened yet, to a reader with no way to tell it apart from the other things they are
# being told to worry about. It costs them the attention that should go to the next step.
#   So: unconditional on a RE-install (the case it is about), always under --verbose, and
# out of a first-timer's way. $REINSTALL is measured at the top, before cf-sync stages the
# runtime and makes the question unanswerable.
if [ "$REINSTALL" = 1 ] || [ "$VERBOSE" = 1 ]; then
  echo
  echo "The fleet_* tools reach NEW sessions only. An MCP server is spawned once per session and"
  echo "lives as long as it, so anything open right now — claude, codex or opencode — keeps the"
  echo "server it started with. Quit and reopen a session to pick these up."
fi

# ── arm the pre-push guard, because a clone that forgets has no guard ────────
# THE GUARD IS COMMITTED BUT core.hooksPath IS NOT. It is repo-local git config, so it does
# not survive a clone — and .githooks/pre-push is inert until somebody runs one command they
# have no reason to remember. That is not a hypothetical gap: this repo is public, it is
# written against private work, and the last leak was 37 branches that reached the remote
# because the only check read the tree you happened to be standing in.
#   So the installer arms it. The installer is the one step nobody skips, and a guard that
# arms itself is the difference between a rule and a hope.
#   NEVER SILENTLY OVERWRITE somebody else's choice: an existing hooksPath pointing somewhere
# else is a deliberate setup (a shared hook manager, a personal override) and clobbering it
# would disable whatever it was doing. Say so and move on.
if [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ]; then
  _hp="$(git -C "$REPO" config --get core.hooksPath 2>/dev/null || true)"
  if [ -z "$_hp" ]; then
    if git -C "$REPO" config core.hooksPath .githooks 2>/dev/null; then
      vsay ""
      vsay "✓ armed the pre-push guard (core.hooksPath -> .githooks)"
      vsay "  It refuses a push whose tree, FILE NAMES, commit messages or branch name carry a"
      vsay "  withheld project name. Override a false positive once with: git push --no-verify"
    fi
  elif [ "$_hp" = .githooks ]; then
    vsay ""
    vsay "✓ pre-push guard already armed"
  else
    echo
    echo "! core.hooksPath is set to '$_hp', so .githooks/pre-push is NOT active."
    echo "  Left alone on purpose — that is your setting, not mine. To use the guard instead:"
    echo "      git -C \"$REPO\" config core.hooksPath .githooks"
  fi
fi

# --- what to do next --------------------------------------------------------
# THE OLD ENDING HANDED OVER TO AN EMPTY SCREEN. It said `ghostfleet`, which on a machine
# that has just been installed opens the Projects picker with no projects in it — and the
# next instruction, "press n to add a session", is not even true there: `n` is a key on a
# project's session GRID, and you cannot reach one without registering a project first. So
# the last line of the install told a first-timer to press a key that does nothing on the
# screen they were about to land on.
#   `ghostfleet demo` is the answer to that: it builds three throwaway projects and opens
# a real fleet on them, touching nothing of yours (bin/fleet-demo). The empty picker now
# guides too, so the second line is no longer a dead end either — but the demo is the one
# that shows the product rather than asking the reader to supply it.
echo
echo "Done. Next:"
echo "    ghostfleet demo       # three throwaway projects — see it working, touches nothing of yours"
echo "    ghostfleet            # your own projects (the empty screen walks you through adding one)"
# THE PHONE CLIENT HAD NO ROUTE INTO IT. It is the largest thing here by setup — a daemon,
# a transport, a passkey, an install — and nothing in the first-run path said it existed:
# you found it by reading docs/mobile.md, which is a 900-line design document. One line
# here, because this list is where a new install looks for what to do next, and
# `fleet-phone` is the step rather than a pointer at a document.
echo "    fleet-phone           # put the fleet on your phone — it reports what is left to do"
# THE RE-RUN COMMAND HAS TO BE ONE THE READER CAN ACTUALLY TYPE. This printed
# `./install.sh --verbose` at everyone, including the npx reader, whose working directory
# has no install.sh in it and never did — the installer ran out of a cache directory they
# were never shown. Name whichever of the two actually reaches this script.
if [ "$VERBOSE" != 1 ]; then
  if [ -f "$REPO/install.sh" ] && [ "$REPO" = "$PWD" ]; then _again="./install.sh --verbose"
  elif is_repo "$REPO";                                 then _again="$(short "$REPO")/install.sh --verbose"
  else                                                       _again="npx ghostfleet-cli --verbose"; fi
  echo "    $_again   # everything this just did, step by step"
fi
