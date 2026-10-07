#!/usr/bin/env bash
# agent-switch.sh — move a RUNNING session (a project's master, or one sub-master) onto
# another agent, and back again without losing either conversation.
#
#   agent-switch.sh request <fleet-dir> <sock> <slot> <agent> [<project>]
#                                    what `fleet-project agent` runs: record the wish, start
#                                    the watcher, return at once
#   agent-switch.sh watch   <fleet-dir> <sock> <slot> [<project>]
#                                    the watcher: waits for the turn to end, then switches
#   agent-switch.sh state   <fleet-dir> <sock> <slot>
#                                    one line for a UI: `switching <agent>`, `failed <msg>`,
#                                    or nothing
#
# ── WHY A SETTING HAD TO REACH A RUNNING PROCESS ─────────────────────────────
# CLAUDE_FLEET_AGENT is read once, by agent-here, when the tmux session is created. So the
# AGENT setting only ever applied to the NEXT master, and a project set to codex went on
# answering as claude with the setting reading as broken. Changing the agent now replaces
# the agent process under the same session name — card, socket, worktree and markers are
# all derived from the name, so nothing else moves (same reasoning as fleet-restart).
#
# ── WHY IT WAITS, AND WHY IN THE BACKGROUND ──────────────────────────────────
# Killing a pane mid-turn throws the turn away, and for codex the whole conversation with
# it. So a switch asked for while the session works is PENDING until its pane has read
# idle for IDLE_N consecutive samples, and only then fires. It always fires from this
# detached watcher, even when the session is already idle: the settings screen runs
# `fleet-project` synchronously, and a switch that waits on an agent booting would freeze
# the TUI for as long as the boot takes.
#   The pending marker holds only the LATEST wish. Changing it again before it fires
# rewrites the marker; changing it back to what is running deletes it, and the watcher,
# which re-reads the marker every sample, exits without touching anything.
#
# ── FILES, all in the profile's fleet dir, all keyed <sock>.<slot> ───────────
#   .switch          the pending target agent, one word. Present = "switching to <agent>…"
#   .switch.pid      the watcher's pid, so a second request does not start a second one
#   .switch-failed   one line: why the last switch did not happen (cleared by the next
#                    request and by a switch that succeeds)
#   .switch.log      the watcher's own trail, appended
#   .convs.json      THE CONVERSATIONS THIS SLOT HAS HAD, ONE PER AGENT:
#                      { "claude":   {"id": "<session id>", "model": "haiku", "ts": 1790000000},
#                        "codex":    {"id": "",             "model": "",      "ts": 1790000600} }
#                    Written for the OUTGOING agent before its pane is killed, merged, never
#                    pruned. Keyed by agent rather than "the newest record for this slot"
#                    because every agent's hooks write records under the same (sock, slot):
#                    after a stint on another agent, the newest record is not claude's, and
#                    `--resume` of it would open the wrong conversation or none. `model` is
#                    kept because CLAUDE_FLEET_MODEL is vendor-specific — `haiku` passed to
#                    codex is an error — so it is dropped on the way out and restored on the
#                    way back. An empty `id` still records that the agent was here, which is
#                    what lets the settings screen warn that codex will start fresh.
#
# ── NEVER --continue ─────────────────────────────────────────────────────────
# The incoming agent resumes ONLY by its own recorded id (CLAUDE_FLEET_RESUME, the path
# fleet-restart uses — read its header for why --continue reaches the wrong conversation in
# a checkout with several). With no id, or an agent whose `resume` field is not yes (codex:
# its TUI does not flush a killed pane's rollout), it starts with CLAUDE_FLEET_FRESH=1 —
# not the launcher's "newest in this cwd" discovery, which is --continue by another name.
#
# ── NEVER NO MASTER ──────────────────────────────────────────────────────────
# A missing binary is caught BEFORE the kill and the running agent is left alone. A new
# agent that dies or never reaches its prompt is killed and the OLD one relaunched on its
# own recorded id; the setting is put back to match what is running, and the reason is left
# in .switch-failed for the settings screen to show.
set -uo pipefail

src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do t="$(readlink "$src")"; case "$t" in /*) src="$t" ;; *) src="$(dirname "$src")/$t" ;; esac; done
LIB_DIR="$(cd "$(dirname "$src")" && pwd)"
BIN_DIR="$(cd "$LIB_DIR/../bin" && pwd)"
SELF="$LIB_DIR/agent-switch.sh"

IDLE_N="${CLAUDE_FLEET_SWITCH_IDLE_N:-3}"          # consecutive idle samples before firing
POLL="${CLAUDE_FLEET_SWITCH_POLL:-1}"               # seconds between samples
READY_SECS="${CLAUDE_FLEET_SWITCH_READY_SECS:-90}"  # how long a new agent gets to draw a prompt
# THE WISH HAS TO HOLD STILL BEFORE IT FIRES. The settings column is a RING: from claude,
# codex is two presses away and the first one lands on opencode. Without this an idle master
# was switched to opencode by the press that was only passing through it.
SETTLE="${CLAUDE_FLEET_SWITCH_SETTLE:-4}"

cmd="${1:-}"; DIR="${2:-}"; SOCK="${3:-}"; SLOT="${4:-}"
case "$cmd" in request|watch|state) ;; *)
  echo "agent-switch: usage: agent-switch.sh request|watch|state <fleet-dir> <sock> <slot> ..." >&2; exit 2 ;; esac
# Every rm below is under $DIR; an empty one would resolve to a path at the root.
[ -n "$DIR" ] && [ "$DIR" != / ] && [ -n "$SOCK" ] && [ -n "$SLOT" ] \
  || { echo "agent-switch: need a fleet dir, a socket and a session" >&2; exit 2; }
# The session name becomes part of every marker path below.
case "$SLOT" in */*|.*|-*) echo "agent-switch: bad session name '$SLOT'" >&2; exit 2 ;; esac
# The tools below find the fleet through this, so a scratch fleet stays a scratch fleet.
export CLAUDE_FLEET_DIR="$DIR"

K="${DIR:?}/$SOCK.$SLOT"
PENDING="$K.switch"; PIDF="$K.switch.pid"; FAILED="$K.switch-failed"; LOG="$K.switch.log"; CONVS="$K.convs.json"

FA() { "$BIN_DIR/fleet-agent" "$@"; }
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null; }
alive() { tmux -L "$SOCK" has-session -t "=$SLOT" 2>/dev/null; }
# The agent the session is RUNNING, from its marker (the setting is a different thing).
live_agent() { FA of "$SLOT" -s "$SOCK" 2>/dev/null || printf claude; }

# ── the per-agent conversation map ───────────────────────────────────────────
conv_get() {   # agent field -> value or empty
  [ -f "$CONVS" ] || return 0
  jq -r --arg a "$1" --arg f "$2" '.[$a][$f] // "" | tostring' "$CONVS" 2>/dev/null
}
conv_has() { [ -f "$CONVS" ] && jq -e --arg a "$1" 'has($a)' "$CONVS" >/dev/null 2>&1; }
conv_put() {   # agent id model — merged into the map, atomically
  local tmp="$CONVS.$$.tmp" base=''
  [ -f "$CONVS" ] && base="$(cat "$CONVS" 2>/dev/null)"
  [ -n "$base" ] || base='{}'
  # An unreadable map fails --argjson, so the write fails and the caller kills nothing.
  jq -n --argjson m "$base" --arg a "$1" --arg i "$2" --arg mo "$3" --argjson ts "$(date +%s)" \
     '$m + {($a): {id: $i, model: $mo, ts: $ts}}' > "$tmp" 2>/dev/null && mv -f "$tmp" "$CONVS"
  local rc=$?; rm -f "$tmp" 2>/dev/null; return $rc
}

# ── which conversation the OUTGOING agent is in ──────────────────────────────
# claude: ask fleet-hibernate, which reads it off the PROCESS (the recorded id can be stale —
# fleet-restart's header has the measured case), and accept it only with a transcript
# behind it. Anything else, or claude when that cannot be established: the newest hook record
# for this (sock, slot) that is not already some OTHER agent's conversation in the map —
# after a stint on another agent the records interleave, and this is what keeps them apart.
outgoing_id() {
  local agent="$1" out lid ltr others
  if [ "$agent" = claude ]; then
    if out="$("$BIN_DIR/fleet-hibernate" --resolve "$SOCK" "$SLOT" 2>/dev/null)" && [ -n "$out" ]; then
      IFS=$'\x1f' read -r lid ltr _ <<< "$out"
      [ -n "$ltr" ] && [ -f "$ltr" ] && { printf '%s' "$lid"; return 0; }
      # Resolved, and it never took a turn: there is nothing to come back to. Falling
      # through to the records would pick this slot's PREVIOUS conversation instead — one
      # the master had already left — and "switching back" would reopen that.
      return 0
    fi
  fi
  others=""
  [ -f "$CONVS" ] && others="$(jq -r --arg a "$agent" 'to_entries[] | select(.key != $a) | .value.id // empty' "$CONVS" 2>/dev/null)"
  jq -r --arg s "$SOCK" --arg l "$SLOT" \
     'select(.sock == $s and .slot == $l and (.session_id // "") != "") | [(.ts // 0), .session_id] | @tsv' \
     "$DIR"/*.json 2>/dev/null | sort -rn | cut -f2 | while IFS= read -r id; do
       grep -qxF -- "$id" <<< "$others" && continue
       printf '%s' "$id"; break
     done
}

# ── launch <agent> in the slot, resumed on <id> or fresh ─────────────────────
# The session's own environment is carried over (CLAUDE_CONFIG_DIR, CLAUDE_FLEET_DIR and the
# rest of what the master was created with), with the four switch variables overridden. A
# per-session -e outranks the server's global value — the reason CLAUDE_FLEET_FRESH is always
# written, never left to whatever the server inherited (fleet-restart's relaunch has the case).
ENV_ARGS=()
capture_env() {
  local line
  ENV_ARGS=()
  while IFS= read -r line; do
    case "$line" in -*|'') continue ;; esac
    case "${line%%=*}" in
      CLAUDE_FLEET_AGENT|CLAUDE_FLEET_RESUME|CLAUDE_FLEET_FRESH|CLAUDE_FLEET_MODEL|CLAUDE_FLEET_SOCK) continue ;;
    esac
    ENV_ARGS+=(-e "$line")
  done < <(tmux -L "$SOCK" show-environment -t "$SLOT" 2>/dev/null)
}
launch() {   # agent id model cwd
  local agent="$1" id="$2" model="$3" cwd="$4" fresh=0
  [ -n "$id" ] || fresh=1
  tmux -L "$SOCK" new-session -d -s "$SLOT" -c "$cwd" \
    ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
    -e "CLAUDE_FLEET_SOCK=$SOCK" -e "CLAUDE_FLEET_AGENT=$agent" \
    -e "CLAUDE_FLEET_RESUME=$id" -e "CLAUDE_FLEET_FRESH=$fresh" -e "CLAUDE_FLEET_MODEL=$model" \
    "exec agent-here \"$SLOT\"" 2>/dev/null
}
# Up to READY_SECS for the agent's own ready pattern. A session that disappears is a launcher
# that came straight back (agent-here takes the pane down when the agent never got going).
WHY_NOT=""
wait_ready() {
  local agent="$1" re i=0 max
  re="$(FA field "$agent" ready_re 2>/dev/null)"
  max=$((READY_SECS * 2)); WHY_NOT="did not reach a prompt in ${READY_SECS}s"
  while [ "$i" -lt "$max" ]; do
    alive || { WHY_NOT="exited before it reached a prompt"; return 1; }
    if [ -n "$re" ] && grep -qE -- "$re" <<< "$(tmux -L "$SOCK" capture-pane -p -t "$SLOT" 2>/dev/null)"; then
      # Held a moment: a launcher that draws a prompt and dies straight after is a failed
      # start too, and the old agent is already gone.
      sleep "${CLAUDE_FLEET_SWITCH_READY_HOLD:-1}"; alive && return 0
      WHY_NOT="exited right after its prompt appeared"; return 1
    fi
    sleep 0.5; i=$((i+1))
  done
  return 1
}
kill_slot() {
  local i=0
  tmux -L "$SOCK" kill-session -t "=$SLOT" 2>/dev/null
  while alive && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done
}

# What a session is told when it comes up. FRESH: who it is now and where the state lives,
# and nothing of the old conversation — the fleet's own commands are the state, a summary
# would be a second copy of it that is already stale. RESUMED: one line, because the
# conversation is its own and the only thing it does not know is that it was away.
handoff() {   # to from resumed
  # A --session switch moves a sub-master, not the project's master; telling it otherwise
  # would have it start acting as the lead of the whole fleet.
  local who="this project's master"
  [ "$SLOT" = master ] || who="the session $SLOT in this fleet"
  if [ "$3" = 1 ]; then
    printf 'You are %s again, taking over from %s. Check fleet-inbox for anything that arrived while you were away.' "$who" "$2"
  else
    printf 'You are now %s, taking over from %s. Run fleet-worktrees and fleet-inbox to see the state of the fleet.' "$who" "$2"
  fi
}
send_prompt() {
  # a prompt typed before the input box is listening lands nowhere (fleet-restart)
  sleep "${CLAUDE_FLEET_SWITCH_PROMPT_DELAY:-2}"
  "$BIN_DIR/fleet-send" -s "$SOCK" "$SLOT" "$1" >/dev/null 2>&1 \
    || log "the handoff prompt to $SLOT did not send"
}

fail() {
  printf '%s\n' "$1" > "$FAILED" 2>/dev/null
  log "FAILED: $1"
}
# The setting follows what is running after a failure, or the next master would try the
# agent that just failed. Project-wide only: a --session switch's setting IS the marker.
revert_setting() {   # agent
  local proj="${PROJECT:-}"
  [ -n "$proj" ] && [ "$SLOT" = master ] || return 0
  local want="$1"; [ "$want" = claude ] && want=--none
  CLAUDE_FLEET_SWITCH_SETTING_ONLY=1 "$BIN_DIR/fleet-project" agent "$proj" "$want" >/dev/null 2>&1
}

do_switch() {
  local to="$1" from bin cwd oid omodel rid rmodel resumed=0 fid fmodel
  from="$(live_agent)"
  [ "$to" != "$from" ] || return 0
  bin="$(FA field "$to" bin 2>/dev/null)"
  if [ -z "$bin" ] || ! command -v "$bin" >/dev/null 2>&1; then
    fail "$to is not installed ('${bin:-?}' is not on PATH) — $SLOT stays on $from"
    # The wish is consumed with the refusal. Left in place, the watcher re-read it on its
    # next sample and refused again every two seconds, for as long as nobody changed it.
    rm -f "${PENDING:?}" 2>/dev/null
    revert_setting "$from"
    return 1
  fi
  cwd="$(tmux -L "$SOCK" display-message -p -t "$SLOT" '#{pane_current_path}' 2>/dev/null)"
  [ -n "$cwd" ] && [ -d "$cwd" ] || cwd="$HOME"
  capture_env
  omodel="$(tmux -L "$SOCK" show-environment -t "$SLOT" CLAUDE_FLEET_MODEL 2>/dev/null)"
  case "$omodel" in CLAUDE_FLEET_MODEL=*) omodel="${omodel#CLAUDE_FLEET_MODEL=}" ;; *) omodel="" ;; esac

  # THE RECORD GOES DOWN BEFORE THE KILL. If writing it fails, nothing is killed.
  oid="$(outgoing_id "$from")"
  conv_put "$from" "$oid" "$omodel" || { fail "could not record $from's conversation — $SLOT left on $from"; rm -f "${PENDING:?}"; return 1; }
  log "recorded $from conversation '${oid:-none}' (model '${omodel}') for $SLOT"

  rid=""; rmodel="$(conv_get "$to" model)"
  if [ "$(FA field "$to" resume 2>/dev/null)" = yes ]; then rid="$(conv_get "$to" id)"; fi
  [ -n "$rid" ] && resumed=1
  log "switching $SLOT $from -> $to ($([ -n "$rid" ] && printf 'resume %s' "$rid" || printf fresh)) in $cwd"

  kill_slot
  if launch "$to" "$rid" "$rmodel" "$cwd" && wait_ready "$to"; then
    FA set "$SLOT" "$to" -s "$SOCK" >/dev/null 2>&1
    rm -f "${FAILED:?}" 2>/dev/null
    [ "$(cat "$PENDING" 2>/dev/null)" = "$to" ] && rm -f "${PENDING:?}"
    log "switched $SLOT to $to"
    send_prompt "$(handoff "$to" "$from" "$resumed")"
    return 0
  fi

  # ── the new agent did not come up: put the old one back, on its own conversation ──
  local why="$WHY_NOT"     # saved: the old agent's wait below overwrites it
  log "$to $why — restoring $from"
  kill_slot
  fid=""; fmodel="$(conv_get "$from" model)"
  [ "$(FA field "$from" resume 2>/dev/null)" = yes ] && fid="$(conv_get "$from" id)"
  if launch "$from" "$fid" "$fmodel" "$cwd" && wait_ready "$from"; then
    FA set "$SLOT" "$from" -s "$SOCK" >/dev/null 2>&1
    fail "$to failed to start ($why) — $SLOT is back on $from${fid:+ (resumed)}"
    [ -n "$fid" ] || send_prompt "$(handoff "$from" "$to" 0)"
  else
    fail "$to failed to start AND $from did not come back — reopen it: fleet-restart --reopen $SLOT -s $SOCK"
  fi
  rm -f "${PENDING:?}" 2>/dev/null
  revert_setting "$from"
  return 1
}

watch_loop() {
  local want live idle=0 rc seen="" since=$SECONDS
  printf '%s\n' "$$" > "$PIDF"
  log "watcher $$ up for $SLOT"
  while :; do
    [ -f "$PENDING" ] || break
    want="$(tr -d '[:space:]' < "$PENDING" 2>/dev/null)"
    if ! alive; then
      # Nothing running to switch: the setting already applies to the next start.
      rm -f "${PENDING:?}"; log "$SLOT is not running — nothing to switch"; break
    fi
    live="$(live_agent)"
    if [ -z "$want" ] || [ "$want" = "$live" ]; then rm -f "${PENDING:?}"; log "cancelled: $SLOT already runs ${live}"; break; fi
    [ "$want" = "$seen" ] || { seen="$want"; since=$SECONDS; }
    # 0 = working. A pane blocked on a dialog is mid-turn too. 1 or 2 (cannot tell) is idle:
    # an agent with no detector would otherwise never switch.
    FA busy "$SLOT" -s "$SOCK" >/dev/null 2>&1; rc=$?
    if [ "$rc" = 0 ] || FA blocked "$SLOT" -s "$SOCK" >/dev/null 2>&1; then idle=0
    else idle=$((idle+1)); fi
    if [ "$idle" -ge "$IDLE_N" ] && [ $((SECONDS - since)) -ge "$SETTLE" ]; then
      do_switch "$want"
      idle=0
      continue      # a newer wish may have landed while it ran; the loop reads it
    fi
    sleep "$POLL"
  done
  [ "$(cat "$PIDF" 2>/dev/null)" = "$$" ] && rm -f "${PIDF:?}"
  log "watcher $$ done"
}

PROJECT=""
case "$cmd" in
  state)
    if [ -f "$PENDING" ]; then printf 'switching %s\n' "$(tr -d '[:space:]' < "$PENDING")"
    elif [ -f "$FAILED" ]; then printf 'failed %s\n' "$(head -1 "$FAILED")"; fi ;;
  watch)
    PROJECT="${5:-}"
    watch_loop ;;
  request)
    WANT="${5:-}"; PROJECT="${6:-}"
    [ -n "$WANT" ] || WANT=claude
    mkdir -p "$DIR" 2>/dev/null
    rm -f "${FAILED:?}" 2>/dev/null
    if ! alive; then
      rm -f "${PENDING:?}" 2>/dev/null
      echo "not-running"; exit 0
    fi
    LIVE="$(live_agent)"
    if [ "$WANT" = "$LIVE" ]; then
      if [ -f "$PENDING" ]; then rm -f "${PENDING:?}"; echo "cancelled $LIVE"; else echo "already $LIVE"; fi
      exit 0
    fi
    # Refused HERE as well as at the switch, so the caller hears it now rather than from a
    # row that changes a few seconds later. The switch keeps its own check: a binary can go
    # between the two.
    WBIN="$(FA field "$WANT" bin 2>/dev/null)"
    if [ -z "$WBIN" ] || ! command -v "$WBIN" >/dev/null 2>&1; then
      rm -f "${PENDING:?}" 2>/dev/null
      fail "$WANT is not installed ('${WBIN:-?}' is not on PATH) — $SLOT stays on $LIVE"
      revert_setting "$LIVE"
      echo "missing $WANT ${WBIN:-?} $LIVE"; exit 0
    fi
    printf '%s\n' "$WANT" > "$PENDING"
    pid="$(cat "$PIDF" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "request: $SLOT -> $WANT (watcher $pid already up)"
    else
      # DETACHED, WITH EVERY STREAM REDIRECTED. The settings screen runs this through
      # execFileSync, which waits for its stdout to CLOSE — a child still holding the pipe
      # would freeze the TUI for as long as the master's turn runs. nohup keeps it through
      # the SIGHUP a killed pane sends, which matters when the session asking is the one
      # being switched.
      nohup bash "$SELF" watch "$DIR" "$SOCK" "$SLOT" "$PROJECT" </dev/null >>"$LOG" 2>&1 &
      log "request: $SLOT -> $WANT (watcher $! started)"
    fi
    if FA busy "$SLOT" -s "$SOCK" >/dev/null 2>&1; then echo "pending-busy $LIVE"; else echo "pending $LIVE"; fi ;;
esac
