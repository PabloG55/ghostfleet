#!/usr/bin/env bash
# ghostfleet event bridge for codex.
#
# codex has lifecycle hooks (measured on 0.166.0; `codex features list`: `hooks  stable  true`):
# $CODEX_HOME/hooks.json, JSON on stdin, one command per event. install.sh registers this
# file there for seven of them (lib/codex-hooks.mjs). Like the agy and cursor bridges, it does
# NOT re-implement what hooks/fleet-event.sh does with a turn — status record, inbox row,
# sub-lead routing, lead wake, reply-to relay, Telegram mark, briefing. It hands
# fleet-event.sh the Claude-shaped payload it already reads, so there is one implementation
# of the push logic and a fix to it reaches every agent at once.
#
# Usage (from hooks.json):  codex-fleet-event.sh <Event>
# The payload carries the event too (hook_event_name); it is an ARGUMENT as well so that
# PreToolUse, which fires on every tool call, can be routed without reading stdin at all.
#
# THE MAPPING (measured on codex-cli 0.166.0, 2026-11-10; docs/multi-agent-sessions.md)
#   SessionStart      -> SessionStart      fires LAZILY, at the first prompt, not at launch
#   UserPromptSubmit  -> UserPromptSubmit  working; arms a reply-to; marks a Telegram turn;
#                                          the ledger records the prompt and notes what is
#                                          still open; codex accepts additionalContext here
#   Stop              -> Stop              ready + done; fires ONCE per finished turn, never
#                                          mid-turn, carrying last_assistant_message
#   PermissionRequest -> Notification      need-you (codex has NO Notification event: an
#                                          unknown key in hooks.json is ignored in silence)
#   Interrupt         -> Notification      ready: an Esc ends the turn and fires no Stop
#   PreToolUse        -> fleet-telegram-guard.sh, unchanged: codex blocks a tool call on
#                                          exit 2 with the reason on stderr, the contract the
#                                          guard already speaks for Claude Code
#   PostToolUse       -> mods/ghostfleet/hooks/login-capture.mjs, unchanged: an MCP
#                                          authenticate result becomes a pending login the
#                                          phone can finish (docs/MCP-LOGIN.md). Registered
#                                          with Claude's matcher, mcp__.*__authenticate, so
#                                          no other tool call starts a process for it
# Nothing else is passed on: fleet-event.sh reads any event it does not name as `working`.
#
# THE STDOUT CONTRACT IS CODEX'S. SessionStart and UserPromptSubmit may print one
# {"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}} object, which becomes
# context for the model. A Stop must print nothing: plain text there is invalid, and
# {"decision":"block"} would make codex continue the turn. PermissionRequest prints nothing
# so codex shows its own dialog. So fleet-event.sh's stdout is kept for the two context
# events only, and discarded everywhere else. Exit is 0 except a guard's refusal.
#
# INERT, AT THE COST OF THIS ONE EXEC. codex runs a hook as `$SHELL -lc '<command>'` in every
# session on the machine, a fleet or not, so the first lines decide without forking:
#   - no fleet socket in the environment or in $TMUX: not a fleet pane
#   - a WORK profile's fleet (CLAUDE_CONFIG_DIR unset, or ~/.claude): this bridge does
#     nothing there, by the owner's decision — no events, no briefing, no ledger, no guard.
#     bin/fleet-telegram refuses a codex session in such a fleet for exactly that reason.
# Both exit before reading stdin; codex ignores the broken pipe (its runner treats
# ErrorKind::BrokenPipe on a hook's stdin as success, codex-rs/hooks command_runner.rs).
ev="${1:-}"

case "${CLAUDE_CONFIG_DIR:-}" in ''|"$HOME/.claude"|"$HOME/.claude/") exit 0 ;; esac
sock="${CLAUDE_FLEET_SOCK:-}"
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) sock="${_t%%,*}"; sock="${sock##*/}" ;; esac
[ -n "$sock" ] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

case "$ev" in
  PreToolUse)
    CLAUDE_FLEET_SOCK="$sock" exec bash "$here/fleet-telegram-guard.sh" ;;
  PostToolUse)
    # THE SAME CAPTURE CLAUDE'S MOD RUNS, handed the payload as codex sent it: codex names an
    # MCP tool mcp__<server>__<tool> and gives tool_response as a string, the two fields
    # login-shape.js reads. It finds the session by session_id in the fleet dir, which is the
    # record this bridge writes (keyed by the thread id), and it prints nothing, so codex has
    # nothing to read as a decision. Its failures are silent by design (tool output is never
    # logged), and a capture that is missing or crashes must not fail codex's tool call
    # either: not exec'd, so its status is never the hook's.
    command -v node >/dev/null 2>&1 || exit 0
    CLAUDE_FLEET_DIR="${CLAUDE_FLEET_DIR:-$CLAUDE_CONFIG_DIR/fleet}" \
      node "$here/../mods/ghostfleet/hooks/login-capture.mjs" >/dev/null 2>&1
    exit 0 ;;
  SessionStart|UserPromptSubmit|Stop|PermissionRequest|Interrupt) ;;
  *) exit 0 ;;
esac
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
US=$'\x1f'
IFS="$US" read -r conv rollout turn tool < <(
  printf '%s' "$input" | jq -r '
    [ (.session_id // ""), (.transcript_path // ""), (.turn_id // ""), (.tool_name // "") ]
    | map(tostring | gsub("[\u001f\n\r]"; " ")) | join("\u001f")' 2>/dev/null
)
[ -n "$conv" ] || exit 0
case "$conv" in *[!A-Za-z0-9._-]*) exit 0 ;; esac   # it names files below

FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
mkdir -p "$FLEET_DIR" 2>/dev/null

# THE TRANSCRIPT fleet-event.sh READS, AND THE ONE THE RECORD NAMES, ARE TWO FILES.
# fleet-event.sh reads a transcript as Claude's JSONL — the reply-to relay counts its lines at
# UserPromptSubmit and takes the assistant text after that offset at Stop — and codex's own
# (transcript_path, the rollout) is a different shape. So, the way the agy bridge does it, a
# fleet-side file in Claude's shape gets each turn's last_assistant_message, and that is the
# transcript fleet-event.sh is handed. One per pane, named the way agy's is: codex-here exports
# CLAUDE_FLEET_SLOT, and the thread id stands in where it did not.
#   The RECORD still names the rollout (CLAUDE_FLEET_EVENT_RECORD below): lib/codex-rollout.mjs
# has always written it there with `agent: codex`, and every reader that reopens, claims or
# switches a codex session dispatches on those two fields.
ftr="$FLEET_DIR/$sock.${CLAUDE_FLEET_SLOT:-$conv}.codex.jsonl"
case "$ev" in
  UserPromptSubmit) [ -f "$ftr" ] || : > "$ftr" 2>/dev/null ;;
  Stop)
    printf '%s' "$input" | jq -c --arg id "${turn:-codex-$(date +%s)}" '
      (.last_assistant_message // "") as $m
      | select(($m | type) == "string" and ($m | test("\\S")))
      | {type: "assistant", message: {id: $id, role: "assistant", content: [{type: "text", text: $m}]}}' \
      >> "$ftr" 2>/dev/null ;;
esac
[ -f "$ftr" ] || ftr=""

case "$ev" in
  PermissionRequest)
    # Claude's own words for the same moment, so the classifier in fleet-event.sh reads it as
    # need-you. Not the command itself: a command that says "is waiting" would read as idle.
    cev=Notification; msg="codex needs your permission to use ${tool:-a tool}" ;;
  Interrupt)
    cev=Notification; msg="codex is waiting for your input (the turn was interrupted)" ;;
  *) cev="$ev"; msg="" ;;
esac

rec="$(jq -nc --arg t "$rollout" '{agent: "codex", events: "hooks"} + (if $t != "" then {transcript: $t} else {} end)')"
fwd="$(printf '%s' "$input" | jq -c --arg e "$cev" --arg t "$ftr" --arg m "$msg" \
  '. + {hook_event_name: $e, transcript_path: $t, message: $m}' 2>/dev/null)"
[ -n "$fwd" ] || exit 0
out="$(printf '%s' "$fwd" | CLAUDE_FLEET_SOCK="$sock" CLAUDE_FLEET_EVENT_AGENT=codex \
  CLAUDE_FLEET_EVENT_RECORD="$rec" bash "$here/fleet-event.sh" 2>/dev/null)"

# THE LEDGER (lib/codex-ledger.mjs): the prompt's asks recorded and its open items noted at
# UserPromptSubmit, the turn settled at Stop and at Interrupt — what the Claude mod does at
# prompt.submit and turn.complete, through the same pure functions and into the same file.
note=""
if command -v node >/dev/null 2>&1 && [ -f "$here/../lib/codex-ledger.mjs" ]; then
  case "$ev" in
    UserPromptSubmit)
      note="$(printf '%s' "$input" | jq -j '.prompt // ""' 2>/dev/null \
        | node "$here/../lib/codex-ledger.mjs" prompt "$FLEET_DIR" "$conv" "$turn" 2>/dev/null)" ;;
    Stop)
      printf '%s' "$input" | jq -j '.last_assistant_message // ""' 2>/dev/null \
        | node "$here/../lib/codex-ledger.mjs" settle "$FLEET_DIR" "$conv" "$turn" >/dev/null 2>&1 ;;
    Interrupt)
      node "$here/../lib/codex-ledger.mjs" interrupt "$FLEET_DIR" "$conv" "$turn" </dev/null >/dev/null 2>&1 ;;
  esac
fi

# The context: the briefing at SessionStart, the Telegram rules at UserPromptSubmit (both
# fleet-event.sh's), and the ledger's note, as ONE object — codex reads one JSON value.
case "$ev" in
  SessionStart|UserPromptSubmit)
    ctx="$(printf '%s' "$out" | jq -rs '[.[] | objects | .hookSpecificOutput.additionalContext? // empty | strings] | join("\n\n")' 2>/dev/null)"
    [ -n "$note" ] && ctx="${ctx:+$ctx

}$note"
    [ -n "$ctx" ] && jq -n --arg e "$ev" --arg c "$ctx" '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}' ;;
esac
exit 0
