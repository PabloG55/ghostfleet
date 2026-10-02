#!/usr/bin/env bash
# ghostfleet event bridge for agy (Google's Antigravity CLI).
#
# agy has lifecycle hooks of its own — ~/.gemini/config/hooks.json, the global
# customization root, with PreToolUse / PostToolUse / PreInvocation / PostInvocation /
# Stop — and this is the one command install.sh registers there. It does NOT
# re-implement what hooks/fleet-event.sh does with a turn (status file, inbox row,
# sub-lead routing, lead wake, reply-to relay, Jarvis). It translates agy's payload into
# the Claude-shaped one fleet-event.sh already reads and pipes it through, so there is
# one implementation of the push logic and a fix to it reaches every agent at once.
#
# Usage (from hooks.json):  agy-fleet-event.sh <PreInvocation|Stop>
# The event name is an ARGUMENT because agy's payload does not carry one: the handler
# is registered per event, and each registration passes its own name.
#
# THE MAPPING
#   PreInvocation, invocationNum 0 -> UserPromptSubmit   un-parks, arms a reply-to relay
#   PreInvocation, later           -> (working)          a turn is under way
#   Stop, terminationReason ~error -> Notification       need-you, with the error as text
#   Stop, otherwise                -> Stop               ready + done in the lead's inbox
# Measured on agy 1.2.14 with a probe hook: one turn that called three tools fired
# PreInvocation with invocationNum 0,1,2,3 and then ONE Stop, terminationReason
# "NO_TOOL_CALL" — upper case, where the embedded docs say "model_stop", so the error
# test below is case-blind rather than trusting either spelling.
# agy has no permission-asked event, so a tool prompt is NOT pushed: the fleet runs agy
# with --dangerously-skip-permissions, and with CLAUDE_FLEET_YOLO=0 a prompt is visible
# only on the pane (lib/permission-dialog.mjs), the same as codex.
#
# The stdout contract is agy's, not Claude's: every handler must print a JSON object, and
# a Stop handler that printed {"decision":"continue"} would keep the agent running. So
# fleet-event.sh's own stdout is discarded and this prints `{}` — "default behaviour" for
# every event — whatever happens. It always exits 0.
#
# INERT OUTSIDE A FLEET: with no fleet socket in the environment or in $TMUX it prints
# `{}` and stops, so agy in an ordinary terminal is unaffected.
ev="${1:-}"
out() { printf '{}\n'; exit 0; }

sock="${CLAUDE_FLEET_SOCK:-}"
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) sock="${_t%%,*}"; sock="${sock##*/}" ;; esac
[ -n "$sock" ] || { cat >/dev/null; out; }
command -v jq >/dev/null 2>&1 || { cat >/dev/null; out; }

input="$(cat)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# One jq pass, \x1f-joined (CLAUDE.md: a tab collapses empty fields under read).
US=$'\x1f'
IFS="$US" read -r conv cwd tr inv reason err < <(
  printf '%s' "$input" | jq -r '
    [ (.conversationId // ""),
      (.workspacePaths[0]? // ""),
      (.transcriptPath // ""),
      (.invocationNum // "" | tostring),
      (.terminationReason // ""),
      (.error // "" | tostring | gsub("[\n\r\t]"; " ")) ] | join("\u001f")' 2>/dev/null
)
[ -n "$conv" ] || out
[ -n "$cwd" ] || cwd="$PWD"

case "$ev" in
  PreInvocation)
    # The first model call of a turn is the turn starting, which is what Claude's
    # UserPromptSubmit means to fleet-event.sh. Every later call in the same turn is
    # only "still working" — re-arming a relay on each one would re-arm it mid-turn.
    case "$inv" in 0) cev=UserPromptSubmit ;; *) cev=PreInvocation ;; esac
    msg="" ;;
  Stop)
    case "$(printf '%s' "$reason" | tr '[:upper:]' '[:lower:]')" in
      *error*) cev=Notification; msg="agy stopped on an error${err:+: $err}" ;;
      *)       cev=Stop; msg="" ;;
    esac ;;
  *) out ;;
esac

# THE CARD'S LAST MESSAGE. The grid and fleet-event.sh read a transcript as Claude's JSONL,
# and agy's own (transcriptPath) is a different shape: one step per line, the model's text
# in `content` of a PLANNER_RESPONSE step. Pointing them at it would show nothing, or a
# tool result. So, the way the opencode bridge does it, a fleet-side transcript in the
# shape they already parse gets the turn's last non-empty PLANNER_RESPONSE at each Stop.
#   Per SESSION, not per conversation: the card belongs to the pane. Slot from the
# environment, which agy passes to its hooks (measured: CLAUDE_FLEET_SLOT, $TMUX and
# $TMUX_PANE all arrive) — and fleet-event.sh re-derives the live name from the pane.
FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
ftr="$FLEET_DIR/$sock.${CLAUDE_FLEET_SLOT:-$conv}.agy.jsonl"
if [ "$ev" = Stop ] && [ -f "$tr" ]; then
  mkdir -p "$FLEET_DIR" 2>/dev/null
  jq -c 'select(.type == "PLANNER_RESPONSE" and ((.content // "") | length) > 0)
         | {type: "assistant", message: {content: [{type: "text", text: .content}]}}' "$tr" 2>/dev/null \
    | tail -n 1 >> "$ftr"
fi
[ -f "$ftr" ] || ftr=""

jq -n --arg e "$cev" --arg s "$conv" --arg c "$cwd" --arg m "$msg" --arg t "$ftr" \
  '{hook_event_name:$e, session_id:$s, cwd:$c, transcript_path:$t, message:$m, prompt:""}' 2>/dev/null \
  | CLAUDE_FLEET_SOCK="$sock" CLAUDE_FLEET_EVENT_AGENT=agy bash "$here/fleet-event.sh" >/dev/null 2>&1
out
