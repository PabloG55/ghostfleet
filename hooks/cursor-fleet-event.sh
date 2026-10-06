#!/usr/bin/env bash
# ghostfleet event bridge for cursor (Cursor's CLI, `cursor-agent`).
#
# cursor has lifecycle hooks of its own — ~/.cursor/hooks.json, `{"version":1,"hooks":{…}}`,
# JSON on stdin and JSON on stdout — and this is the one command install.sh registers there.
# Like hooks/agy-fleet-event.sh it does NOT re-implement what hooks/fleet-event.sh does with a
# turn (status file, inbox row, sub-lead routing, lead wake, reply-to relay, Jarvis). It
# translates cursor's payload into the Claude-shaped one fleet-event.sh already reads and
# pipes it through, so there is one implementation of the push logic.
#
# Usage (from hooks.json):  cursor-fleet-event.sh      (the event is in the payload)
#
# THE MAPPING
#   beforeSubmitPrompt         -> UserPromptSubmit   working, un-parks, arms a reply-to relay
#   stop, status "error"       -> Notification       need-you, with the error as text
#   stop, otherwise            -> Stop               ready + done in the lead's inbox
# Measured on 2026.10.01-e373342 with a probe hook on every event: a turn fires
# beforeSubmitPrompt once, then the tool events, then afterAgentResponse and stop in the same
# second and in EITHER order. stop carries `status` — "completed", or "error" when the turn
# failed (seen for real: an account that may not use the model asked for). The chat id is
# both conversation_id and session_id, and it is the id `--resume` takes.
# cursor has no permission-asked event. beforeShellExecution fires before cursor's own
# approval check, identically for an allowed command and for one it is about to ask about, so
# it cannot say "waiting on a human". The fleet runs cursor with --force; with
# CLAUDE_FLEET_YOLO=0 a prompt is visible only on the pane (lib/permission-dialog.mjs).
#
# THE PAYLOAD CARRIES THE ACCOUNT'S EMAIL (user_email, on every event). Nothing below reads
# it, and only the named fields are passed on — never the payload itself.
#
# THE STDOUT CONTRACT is cursor's: `{}` is "no opinion" for every event, whereas a stop
# handler that answered {"followup_message": …} would start another turn. So fleet-event.sh's
# own stdout is discarded and this prints `{}`, whatever happens, and exits 0.
#
# INERT OUTSIDE A FLEET: with no fleet socket in the environment or in $TMUX it prints `{}`
# and stops, so cursor in an ordinary terminal is unaffected.
out() { printf '{}\n'; exit 0; }

sock="${CLAUDE_FLEET_SOCK:-}"
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) sock="${_t%%,*}"; sock="${sock##*/}" ;; esac
[ -n "$sock" ] || { cat >/dev/null; out; }
command -v jq >/dev/null 2>&1 || { cat >/dev/null; out; }

input="$(cat)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# One jq pass, \x1f-joined (CLAUDE.md: a tab collapses empty fields under read).
US=$'\x1f'
IFS="$US" read -r ev conv cwd tr status < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.conversation_id // .session_id // ""),
      (.workspace_roots[0]? // ""),
      (.transcript_path // ""),
      (.status // "") ] | join("\u001f")' 2>/dev/null
)
[ -n "$conv" ] || out
[ -n "$cwd" ] || cwd="$PWD"

case "$ev" in
  beforeSubmitPrompt) cev=UserPromptSubmit; msg="" ;;
  stop)
    case "$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')" in
      *error*)
        # The reason is the transcript's own last word on the turn: {"type":"turn_ended",
        # "status":"error","error":"…"}. Newlines flattened, since it becomes one inbox field.
        err=""
        [ -f "$tr" ] && err="$(jq -r 'select(.type == "turn_ended") | .error // empty' "$tr" 2>/dev/null \
                                | tail -n 1 | tr '\n\r\t' '   ' | cut -c1-200)"
        cev=Notification; msg="cursor stopped on an error${err:+: $err}" ;;
      *) cev=Stop; msg="" ;;
    esac ;;
  *) out ;;
esac

# THE CARD'S LAST MESSAGE. cursor's transcript (transcript_path) is one record per line and
# close to Claude's — {"role":"assistant","message":{"content":[{"type":"text",…}]}} — but it
# keys the speaker on `role` where the grid and fleet-event.sh read `type`, so pointing them at
# it would show nothing. At each stop the turn's last assistant text is appended to a
# fleet-side transcript in the shape they parse, the way the agy and opencode bridges do it.
# Read from cursor's transcript rather than from afterAgentResponse because that event can
# land AFTER stop, and stop is when fleet-event.sh reads the card.
#   Per SESSION, not per chat: the card belongs to the pane. Slot from the environment, which
# cursor passes to its hooks (measured: CLAUDE_FLEET_SLOT, $TMUX and $TMUX_PANE all arrive).
FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
ftr="$FLEET_DIR/$sock.${CLAUDE_FLEET_SLOT:-$conv}.cursor.jsonl"
if [ "$ev" = stop ] && [ -f "$tr" ]; then
  mkdir -p "$FLEET_DIR" 2>/dev/null
  jq -c 'select(.role == "assistant")
         | [.message.content[]? | select(.type == "text") | .text] | join("\n")
         | select(length > 0)
         | {type: "assistant", message: {content: [{type: "text", text: .}]}}' "$tr" 2>/dev/null \
    | tail -n 1 >> "$ftr"
fi
[ -f "$ftr" ] || ftr=""

jq -n --arg e "$cev" --arg s "$conv" --arg c "$cwd" --arg m "$msg" --arg t "$ftr" \
  '{hook_event_name:$e, session_id:$s, cwd:$c, transcript_path:$t, message:$m, prompt:""}' 2>/dev/null \
  | CLAUDE_FLEET_SOCK="$sock" CLAUDE_FLEET_EVENT_AGENT=cursor bash "$here/fleet-event.sh" >/dev/null 2>&1
out
