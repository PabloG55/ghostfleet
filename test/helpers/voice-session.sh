#!/usr/bin/env bash
# A Claude-shaped session: real prompt/guard/Stop hooks, no model or network.
set -u
L="$1"; TR="$L/transcript.jsonl"; : >> "$TR"
frame() {
  printf '\033[2J\033[H'
  [ "$1" != busy ] || printf '✻ Working… (3s · esc to interrupt)\n'
  printf '\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  status\n'
}
n=0
while :; do
  frame idle
  IFS= read -r p || exit 0
  while IFS= read -r -t 1 more; do p="$p"$'\n'"$more"; done
  n=$((n + 1)); frame busy
  printf '%s' "$p" > "$L/prompt.$n"
  jq -nc --arg p "$p" --arg tr "$TR" --arg d "$PWD" \
    '{hook_event_name:"UserPromptSubmit",session_id:"voice-session",cwd:$d,transcript_path:$tr,prompt:$p}' \
    | env -u CLAUDE_FLEET_DIR CLAUDE_FLEET_DIR="$TEST_FLEET_DIR" "$HOOK" > "$L/context.$n" 2>/dev/null
  # Model the mod recording the received prompt in its ledger. The CLI writes
  # the real ledger format, so the leak assertion has an actual file to inspect.
  [ -f "$TEST_FLEET_DIR/voice-session.ledger" ] || printf '{"v":1,"seq":0,"items":[]}\n' > "$TEST_FLEET_DIR/voice-session.ledger"
  env -u CLAUDE_FLEET_DIR CLAUDE_FLEET_DIR="$TEST_FLEET_DIR" fleet-ledger --session voice-session add "$p" >/dev/null 2>&1
  for tool in Bash Read; do
    jq -nc --arg tool "$tool" '{hook_event_name:"PreToolUse",session_id:"voice-session",tool_name:$tool,tool_input:{command:"ls",file_path:"/etc/hosts"}}' \
      | env -u CLAUDE_FLEET_DIR CLAUDE_FLEET_DIR="$TEST_FLEET_DIR" "$GUARD" >/dev/null 2>"$L/refusal.$n.$tool"
    printf '%s %s\n' "$tool" "$?" >> "$L/tools.$n"
  done
  case "$p" in *slow*) sleep 4 ;; esac
  case "$p" in *hola*) answer='La sesión está lista.' ;; *) answer="Answer for turn $n." ;; esac
  case "$p" in *'[voice]'*)
    case "$p" in *hola*) lang=es ;; *) lang=en ;; esac
    answer="$(jq -nc --arg text "$answer" --arg lang "$lang" '{text:$text,lang:$lang}')" ;;
  esac
  jq -nc --arg a "$answer" --arg id "msg_$n" '{type:"assistant",message:{id:$id,role:"assistant",content:[{type:"text",text:$a}]}}' >> "$TR"
  frame idle
  jq -nc --arg tr "$TR" --arg d "$PWD" '{hook_event_name:"Stop",session_id:"voice-session",cwd:$d,transcript_path:$tr}' \
    | env -u CLAUDE_FLEET_DIR CLAUDE_FLEET_DIR="$TEST_FLEET_DIR" "$HOOK" >/dev/null 2>&1
  : > "$L/stop.$n"
done
