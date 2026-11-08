#!/usr/bin/env bash
# hooks/fleet-telegram-guard.sh — PreToolUse: a turn the owner started from Telegram runs
# only the tools the channel allows.
#
# THE CHANNEL IS A DOOR INTO A SESSION FROM A PHONE, and the owner decided what may come
# through it: an allowlist, not full power. A Telegram message is words from a device that
# can be lost, borrowed or read over a shoulder, and the session it lands in is usually a
# lead with a shell and a checkout. So the turn it starts may read, search, look things up
# and drive the fleet — answer, delegate, spawn, wake — but not run a shell or write outside
# its own scratch directory. Delegated work runs in the session it was handed to, with that
# session's own permissions: this is a limit on the turn, not a sandbox, and docs/TELEGRAM.md
# says so.
#
# WHICH TURN: hooks/fleet-event.sh writes <fleet dir>/<sock>.<slot>.telegram at the
# UserPromptSubmit of a prompt that bin/fleet-telegram delivered, and removes it at that
# turn's Stop. An ARMED reply address to `telegram/…` counts too — that is the same turn
# reached the other way round, and either signal alone holds it.
#
# EVERY TOOL CALL IN EVERY SESSION COMES THROUGH HERE (matcher ""), and almost none is in a
# Telegram turn. So the first question costs no process at all: is there a mark anywhere on
# this socket. Only then is the slot resolved and the payload parsed.
#
# Blocking contract: exit 2, message on stderr — Claude Code hands stderr to the model as
# the reason, so the refusal says what it MAY do instead.
#
#   fleet-telegram-guard.sh          the hook (payload on stdin)
#   fleet-telegram-guard.sh --list   the effective allowlist, one line, for the context
#                                    fleet-event.sh gives the turn and for fleet-telegram
#   fleet-telegram-guard.sh --default  the built-in list

FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
TG_DEFAULT_DIR="$HOME/.config/ghostfleet/telegram"

# THE DEFAULT ALLOWLIST. Globs over the tool name; `:scratch` means "only for a path inside
# this session's scratch directory". mcp__ghostfleet__fleet_* is every fleet tool, the ones
# a lead delegates with (fleet_send, fleet_spawn, fleet_wake, fleet_telegram_send) and any
# added later. No Bash, no Agent/Task, no write anywhere else.
DEFAULT_ALLOW=(Read Glob Grep LS NotebookRead WebFetch WebSearch ToolSearch TodoWrite
               'mcp__ghostfleet__fleet_*'
               Write:scratch Edit:scratch MultiEdit:scratch NotebookEdit:scratch)

# Socket and slot the way fleet-event.sh derives them: the live server from $TMUX (an
# exported CLAUDE_FLEET_SOCK can be stale behind a --resume), the slot from the pane's own
# id (a rename cannot reach an exported CLAUDE_FLEET_SLOT).
SOCK="${CLAUDE_FLEET_SOCK:-}"
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) _s="${_t%%,*}"; SOCK="${_s##*/}" ;; esac

slot() {
  local live=""
  if [ -n "${TMUX_PANE:-}" ]; then
    case "${TMUX:-}" in *"/$SOCK,"*)
      live="$(tmux -L "$SOCK" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" ;;
    esac
  fi
  case "$live" in ''|_*|+*) live="${CLAUDE_FLEET_SLOT:-}" ;; esac
  printf '%s' "$live"
}

# The channel's state dir for this turn: what the mark recorded, else the reply address's
# directory, else the default. Its config.json holds the owner's allowlist.
tg_dir() {
  local d="" f1 f3
  [ -f "$FLEET_DIR/$SOCK.$SLOT.telegram" ] && d="$(head -n 1 "$FLEET_DIR/$SOCK.$SLOT.telegram" 2>/dev/null)"
  if [ -z "$d" ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to" ]; then
    IFS=$'\x1f' read -r f1 _ f3 _ < "$FLEET_DIR/$SOCK.$SLOT.reply-to" 2>/dev/null
    [ "${f1:-}" = telegram ] && d="${f3:-}"
  fi
  case "$d" in /*) printf '%s' "$d" ;; *) printf '%s' "$TG_DEFAULT_DIR" ;; esac
}

# The allowlist in force: config.json's "allow" when it is a non-empty array of strings,
# else the default. An unreadable file is the default, never "nothing" and never "all".
ALLOW=()
load_allow() {
  local cfg; cfg="$(tg_dir)/config.json"; ALLOW=()
  if [ -f "$cfg" ] && command -v jq >/dev/null 2>&1; then
    while IFS= read -r line; do [ -n "$line" ] && ALLOW+=("$line"); done < <(
      jq -r 'if (.allow | type) == "array" then .allow[] | strings else empty end' "$cfg" 2>/dev/null)
  fi
  [ "${#ALLOW[@]}" -gt 0 ] || ALLOW=("${DEFAULT_ALLOW[@]}")
}

case "${1:-}" in
  --default) printf '%s\n' "${DEFAULT_ALLOW[*]}"; exit 0 ;;
  --list)    SLOT="$(slot)"; load_allow; printf '%s\n' "${ALLOW[*]}"; exit 0 ;;
esac

input="$(cat)"
[ -n "$SOCK" ] || exit 0
# The free question first: a mark or an armed address anywhere on this socket.
_any=0
for f in "$FLEET_DIR/$SOCK".*.telegram "$FLEET_DIR/$SOCK".*.reply-to.armed; do
  [ -e "$f" ] && { _any=1; break; }
done
[ "$_any" = 1 ] || exit 0

SLOT="$(slot)"
[ -n "$SLOT" ] || exit 0
ACTIVE=0
[ -f "$FLEET_DIR/$SOCK.$SLOT.telegram" ] && ACTIVE=1
if [ "$ACTIVE" = 0 ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to.armed" ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to" ]; then
  IFS=$'\x1f' read -r _f1 _ < "$FLEET_DIR/$SOCK.$SLOT.reply-to" 2>/dev/null
  [ "${_f1:-}" = telegram ] && ACTIVE=1
fi
[ "$ACTIVE" = 1 ] || exit 0

SCRATCH="$FLEET_DIR/telegram/$SOCK.$SLOT"
refuse() {
  printf '%s\n' "[fleet] This turn came from the owner on Telegram, and $1 Tools this turn may use: ${ALLOW[*]} (a :scratch entry only for files under $SCRATCH/). To get it done anyway, delegate it: fleet_send the task to a session that can do it (fleet_spawn a worker for new work), then tell the owner who has it. Only the owner can widen the list, at the desk: fleet-telegram config allow <tool-pattern>." >&2
  exit 2
}

# No jq is no way to read the call, and this turn is restricted: refuse rather than guess.
if ! command -v jq >/dev/null 2>&1; then
  ALLOW=("${DEFAULT_ALLOW[@]}"); refuse "this machine has no jq, so the call cannot be checked."
fi
load_allow
IFS=$'\x1f' read -r TOOL FPATH TSESS TPROJ < <(
  printf '%s' "$input" | jq -r '[ (.tool_name // ""),
      ((.tool_input // {}) | (.file_path // .notebook_path // "")),
      ((.tool_input // {}) | (.session // "")),
      ((.tool_input // {}) | (.project // "")) ]
    | map(tostring | gsub("[\u001f\n\r]"; " ")) | join("\u001f")' 2>/dev/null)
[ -n "${TOOL:-}" ] || refuse "the call could not be read."

# Is a path inside the scratch dir, after every symlink in it is resolved? The file may not
# exist yet, so its nearest existing ancestor is resolved and the rest appended. `..` and a
# symlink AT the path are refused outright: either can point a write anywhere.
in_scratch() {
  local p="$1" d rest="" real sr
  case "$p" in /*) ;; *) return 1 ;; esac
  case "/$p/" in */../*|*/./*) return 1 ;; esac
  [ -L "$p" ] && return 1
  mkdir -p "$SCRATCH" 2>/dev/null
  sr="$(cd "$SCRATCH" 2>/dev/null && pwd -P)" || return 1
  d="${p%/*}"; [ -n "$d" ] || d="/"
  while [ ! -d "$d" ]; do rest="/${d##*/}$rest"; d="${d%/*}"; [ -n "$d" ] || d="/"; done
  real="$(cd "$d" 2>/dev/null && pwd -P)" || return 1
  real="${real%/}$rest/${p##*/}"
  case "$real" in "$sr"/?*) return 0 ;; esac
  return 1
}

# A FLEET TOOL AIMED AT THIS VERY SESSION is the one way round the list from inside it: a
# prompt it sends itself queues behind this turn and runs, after the Stop, as an ordinary
# turn with every tool. Delegating to ANOTHER session is the point of the channel.
is_self() {
  [ "${TSESS:-}" = "$SLOT" ] || return 1
  case "${TPROJ:-}" in
    ''|"$SOCK"|"cf-$TPROJ") return 0 ;;
  esac
  [ "$SOCK" = "cf-$TPROJ" ] && return 0
  case "$SOCK" in cf-*-"$TPROJ") return 0 ;; esac
  return 1
}
case "$TOOL" in
  mcp__ghostfleet__fleet_send|mcp__ghostfleet__fleet_answer|mcp__ghostfleet__fleet_resume)
    is_self && refuse "$TOOL to this same session ($SLOT) would run that prompt later as a turn the list does not cover." ;;
esac

for e in "${ALLOW[@]}"; do
  pat="${e%:scratch}"
  # shellcheck disable=SC2254  # the entry IS a glob
  case "$TOOL" in
    $pat)
      [ "$pat" = "$e" ] && exit 0
      in_scratch "$FPATH" && exit 0
      refuse "$TOOL may write only under $SCRATCH/, and ${FPATH:-this call} is not there." ;;
  esac
done
refuse "$TOOL is not on the channel's allowlist."
