#!/usr/bin/env bash
# ghostfleet event hook.
#
# Wired into Claude Code's hook system (see install.sh). Fires on every hooked
# event, writes a tiny per-session status file to ~/.claude/fleet/<id>.json, and
# on Stop / Notification posts an identity-rich macOS notification that names the
# checkout + branch (+ zellij slot) so you can tell which session it came from.
#
# Must stay fast and never fail the session: it always exits 0.

# Status lives under the ACTIVE config dir, so work and personal profiles
# (CLAUDE_CONFIG_DIR=~/.claude vs ~/.claude-personal) stay separate.
FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"

# Route by the LIVE tmux server ($TMUX), not a possibly-stale CLAUDE_FLEET_SOCK: a
# long-running --resume/--fork Claude can hold an env var from an earlier context,
# which would send this worker's inbox events / wake-nudge to the WRONG fleet's
# master. $TMUX reflects the server this session actually runs in and can't drift.
# Only when it names a cf-* (fleet) server; otherwise keep whatever env provided.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

# ── AN EXIT THAT WRITES NOTHING MUST STILL LEAVE A LINE ──────────────────────
# Every early exit below is an exit 0, because a hook must never fail the session — and
# from outside, a hook that exits early is indistinguishable from one that never ran: no
# record, no inbox row, hookErrors []. A conversation the fleet had lost was diagnosed as
# "the hook exits early" for exactly that reason, when the hook had run to the end and its
# record had gone missing later. One line per silent exit, per refused identity and per
# record removed, so the next diagnosis starts from what happened. Bounded: rotated at
# 256KB, one generation kept.
_dbg() {
  local f="$FLEET_DIR/hook-debug.log" sz
  [ -d "$FLEET_DIR" ] || return 0
  # -f first: a `<` on a missing file is reported by the shell before 2>/dev/null applies
  sz=""; [ -f "$f" ] && sz="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  case "$sz" in ''|*[!0-9]*) ;; *) [ "$sz" -gt 262144 ] && mv -f "$f" "$f.1" 2>/dev/null ;; esac
  printf '%s pid=%s ppid=%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$$" "$PPID" "$*" >> "$f" 2>/dev/null
  return 0
}

# jq is required to parse the payload; if it's missing, say so and do nothing else.
command -v jq >/dev/null 2>&1 || { _dbg "exit: jq not on PATH ($PATH)"; exit 0; }
mkdir -p "$FLEET_DIR" 2>/dev/null || exit 0

# --- read the hook payload (single jq pass) ----------------------------------
input="$(cat)"
# Join with the unit separator (non-whitespace), not @tsv: a whitespace IFS makes
# `read` collapse empty fields (e.g. a missing transcript_path) and shift the rest.
IFS=$'\x1f' read -r EVENT SESSION CWD TRANSCRIPT CURSOR_V NOTE < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.session_id // ""),
      (.cwd // .workspace.current_dir // ""),
      (.transcript_path // ""),
      (.cursor_version // ""),
      (.message // "" | gsub("[\n\r\t]"; " ")) ] | join("\u001f")' 2>/dev/null
)

[ -n "$SESSION" ] || { _dbg "exit: no session_id (event='${EVENT}', ${#input} bytes of payload)"; exit 0; }

# ── CURSOR RUNS THIS FILE TOO, AND MUST NOT ──────────────────────────────────
# cursor-agent loads Claude's hooks as well as its own — ~/.claude/settings.json, read by its
# hook loader beside ~/.cursor/hooks.json ("third-party extensibility", on by default) — and
# hands them ITS payload: cursor's event names ("beforeSubmitPrompt", "stop", "sessionStart"),
# no cwd, its own transcript. Measured: a cursor session in a fleet pane wrote a record here
# with an empty cwd and status "working", under the slot of the pane that had launched it.
# hooks/cursor-fleet-event.sh is the translation, and what it pipes in is Claude-shaped with
# no cursor_version in it — so a payload that still carries one came the compat way, and is
# dropped whole.
if [ -n "$CURSOR_V" ]; then
  _dbg "exit: a cursor payload through Claude's hooks (event='${EVENT}') — the cursor bridge reports this turn"
  exit 0
fi

# SessionEnd: deregister and stop here — and say who did it, since a removed record is the
# one outcome nothing else on disk records.
if [ "$EVENT" = "SessionEnd" ]; then
  [ -f "$FLEET_DIR/$SESSION.json" ] && _dbg "SessionEnd $SESSION reason=$(printf '%s' "$input" | jq -r '.reason // "?"' 2>/dev/null) job=${CLAUDE_JOB_DIR##*/} tmux=${TMUX_PANE:-} — record removed"
  rm -f "$FLEET_DIR/$SESSION.json" "$FLEET_DIR/$SESSION.task" 2>/dev/null
  exit 0
fi

# --- derive identity ---------------------------------------------------------
folder="${CWD##*/}"
branch="$(git -C "${CWD:-.}" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)"
ZELL="${ZELLIJ_SESSION_NAME:-}"
SLOT="${CLAUDE_FLEET_SLOT:-}"
SOCK="${CLAUDE_FLEET_SOCK:-}"
# ── EVERY SESSION ON EVERY FLEET, not only the ones launched through the fleet ──
# sock and slot came from the launcher's environment alone, so a session started any other
# way — an agent run by hand in a pane, a fleet whose panes predate the launcher — wrote a
# record with both fields empty. It still had a session_id, so it looked recorded; it simply
# could not be found BY FLEET. Measured on a real fleet: 28 of 64 running sessions had no
# addressable record, 8.57 GB of them, and they were the oldest — exactly the ones anything
# idle-driven wants to find.
#   Derived from $TMUX when the environment is silent, the same way fleet-pause derives it
# and for the same reason: $TMUX names the server this pane is actually on, so it cannot go
# stale the way an exported variable can behind a long-running --resume.
if [ -z "$SOCK" ] && [ -n "${TMUX:-}" ]; then
  _s="${TMUX%%,*}"; _s="${_s##*/}"
  case "$_s" in cf-*) SOCK="$_s" ;; esac
fi
# ── THE SLOT IS THE PANE'S NAME NOW, NOT THE NAME IT WAS BORN WITH ───────────
# CLAUDE_FLEET_SLOT is exported once, at launch, and a rename cannot reach into a running
# process to change it. So after `x` was renamed `y`, every event went on writing
# slot:"x" — overwriting whatever fleet-rename had patched — and every reader that looks a
# session up by name (fleet-read, the phone's chat, the grid card, hibernate's plan) found
# nothing under `y`. Measured on a live fleet: the tmux session answered to its new name,
# its record said the old one on every turn, and the phone said "No messages yet".
#   $TMUX_PANE is the pane's id (`%12`), which a rename does not change, so asking tmux
# what session that pane is in answers with the CURRENT name. Targeted with the pane id and
# nothing else: without -t, display-message answers for whichever session the server
# considers current, which is somebody else's as often as not.
#   A tab or a `+` name is never claimed (CLAUDE.md): an agent run by hand inside a tab
# keeps whatever the environment says, which is what it did before.
PANE=""
if [ -n "$SOCK" ] && [ -n "${TMUX_PANE:-}" ]; then
  case "${TMUX:-}" in *"/$SOCK,"*)
    # Qualified by the SERVER's pid ($TMUX is "<socket>,<server-pid>,<session>"): pane ids
    # restart at %0 with every server, so a bare `%3` in a record left from a server that
    # has since died would claim whichever new session got that id.
    _r="${TMUX#*,}"; PANE="$TMUX_PANE@${_r%%,*}"
    _live="$(tmux -L "$SOCK" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)"
    case "$_live" in ''|_*|+*) ;; *) SLOT="$_live" ;; esac
  ;; esac
fi
if [ -z "$SLOT" ] && [ -n "$SOCK" ] && [ -z "$PANE" ]; then
  SLOT="$(tmux -L "$SOCK" display-message -p '#{session_name}' 2>/dev/null)"
  # A leading `_` is a tab, not an agent (CLAUDE.md), and a `+` name is a tmux expression
  # rather than a name — neither is a slot this should claim.
  case "$SLOT" in _*|+*) SLOT="" ;; esac
fi
# ── A BACKGROUNDED CONVERSATION RUNS UNDER SOMEBODY ELSE'S ENVIRONMENT ───────
# Claude Code can send a conversation to the background (`/background`, or ← into the agent
# view). It does not move the process: it writes `continued-in` into the old transcript and
# hands the conversation, under a NEW session id, to a spare process its daemon spawned
# ahead of time. The pane's process stays behind as a viewer of it and fires no more hooks.
# So every event of the live conversation comes from a process with no $TMUX and no
# $TMUX_PANE, and with the CLAUDE_FLEET_* of whichever session first started the daemon —
# one daemon per config dir, shared by every fleet on that profile. Measured: a scratch
# session on its own socket, backgrounded, fired its next hooks with another fleet's
# socket, slot and fleet dir, wrote a record claiming that fleet's slot, and posted a
# `done` row into that fleet's inbox. The env is not evidence of who this is.
#   The old transcript is. Its `continued-in` names this id, and the record that points at
# that transcript is the conversation's identity before the hand-off: same socket, same
# slot, same pane (the pane now shows this conversation). The line is written before the
# old id's SessionEnd and the new id's SessionStart (measured: 0.15s and 0.46s earlier), so
# the first event can already find it. Once found it is kept in this record as
# continued_from, and later events reuse it rather than searching again.
#   No predecessor — a spare's placeholder warming up, or `claude --bg` run from a shell —
# means no fleet identity at all: an unaddressable record, like any agent run by hand,
# rather than a borrowed one. A bg process is recognised by $CLAUDE_JOB_DIR, which only
# those carry, with no $TMUX; the session-kind variable is visible in the process's
# environment but is not passed to its hooks.
FROM=""
if [ -n "${CLAUDE_JOB_DIR:-}" ] && [ -z "${TMUX:-}" ]; then
  _env="${SOCK:-}/${SLOT:-}"
  SOCK=""; SLOT=""; PANE=""
  if [ -f "$FLEET_DIR/$SESSION.json" ]; then
    IFS=$'\x1f' read -r FROM SOCK SLOT PANE < <(jq -r \
      '[(.continued_from // ""), (.sock // ""), (.slot // ""), (.pane // "")] | join("\u001f")' \
      "$FLEET_DIR/$SESSION.json" 2>/dev/null)
    [ -n "$FROM" ] || { SOCK=""; SLOT=""; PANE=""; }
  fi
  if [ -z "$FROM" ] && [ -n "$CWD" ]; then
    # Candidates are the records for this checkout only; each one's transcript is asked
    # whether it was continued in THIS id. The tail, not the file: transcripts here run to
    # 100MB+, and the line is written at the hand-off with only bookkeeping lines after it.
    while IFS=$'\x1f' read -r _pid _psock _pslot _ppane _ptr; do
      [ -n "$_pid" ] && [ "$_pid" != "$SESSION" ] && [ -f "$_ptr" ] || continue
      if tail -c 65536 "$_ptr" 2>/dev/null | grep -F "\"continuedInSessionId\":\"$SESSION\"" >/dev/null 2>&1; then
        FROM="$_pid"; SOCK="$_psock"; SLOT="$_pslot"; PANE="$_ppane"; break
      fi
    done < <(jq -r --arg c "$CWD" \
      'select(.cwd == $c) | [(.session_id // ""), (.sock // ""), (.slot // ""), (.pane // ""), (.transcript // "")] | join("\u001f")' \
      "$FLEET_DIR"/*.json 2>/dev/null)
    if [ -n "$FROM" ]; then _dbg "bg $EVENT $SESSION: continued from $FROM, takes ${SOCK:-?}/${SLOT:-?} (env said $_env)"
    else _dbg "bg $EVENT $SESSION: no predecessor names this id; claims no slot (env said $_env)"; fi
  fi
  # Everything below — inbox rows, the lead's wake, reply-to, the queue — routes on the
  # variable itself, so the borrowed value has to go there too, or the record would be
  # right and every row and nudge would still land on the daemon's fleet.
  CLAUDE_FLEET_SOCK="$SOCK"; CLAUDE_FLEET_SLOT="$SLOT"
fi
now="$(date +%s)"

# --- a prompt typed into a RUNNING turn is the next task, not a replacement ----
# Claude Code folds a message submitted mid-turn into the turn in progress, and the agent
# reads it as a change of direction: task A is dropped for task B and nothing says so.
# fleet-send now queues its own traffic (bin/fleet-send, "the queue"), but a prompt a
# HUMAN types into a busy session goes straight in, and the launch contract alone is one
# paragraph among many. So the prompt is labelled where the agent reads it.
#   Measured on 2.1.280 before relying on it: a mid-turn submit DOES fire UserPromptSubmit
# (two prompts, two events, one Stop), and so does a background task's completion — as a
# "prompt" of `<task-notification>…`, which is the machine talking and is skipped here.
#   "MID-TURN" IS THE STATUS THIS HOOK LAST WROTE, read before it is overwritten below:
# `working` means a turn started and has not Stopped. An Esc interrupt fires NO Stop
# (measured), so `working` alone would label the first prompt after an interrupt as queued
# behind the task the human just abandoned — so the turn's transcript is checked for the
# interrupt record too. What was asked is kept in <session_id>.task: its first line, and
# the transcript line the turn began at.
if [ "$EVENT" = "UserPromptSubmit" ]; then
  _prompt="$(printf '%s' "$input" | jq -r '.prompt // ""' 2>/dev/null)"
  _taskf="$FLEET_DIR/$SESSION.task"
  case "$_prompt" in
    "<task-notification>"*|"<local-command"*|"") ;;
    *)
      _prev="$(jq -r '.status // ""' "$FLEET_DIR/$SESSION.json" 2>/dev/null)"
      _t_at=""; _t_line=""
      [ -f "$_taskf" ] && IFS=$'\x1f' read -r _t_at _t_line < "$_taskf"
      case "$_t_at" in ''|*[!0-9]*) _t_at="" ;; esac
      _mid=0
      # ── AND THE AGENT HAS TO SAY SO ITSELF, because the status above is only what this hook
      # last WROTE. A prompt that started no turn (a hook refused it, the API failed before the
      # first token) leaves `working` and its own .task behind with no Stop to clear them, and
      # the NEXT prompt into that idle session was labelled as arriving mid-task — quoting the
      # same prompt as the task in hand when it was the one re-sent. Seen twice in one day on
      # the owner's own prompts into an idle lead.
      #   The measurement is the agent's note about itself, <config>/sessions/<pid>.json, found
      # by walking up from this hook to the process whose note names this session. Measured on
      # 2.1.284 at the moment this hook runs: an idle submit already reads `busy`, with
      # statusUpdatedAt 60–230ms old — the prompt itself flipped it; a mid-turn submit reads
      # `busy` since the turn began, 5.4s earlier in the measured case. So "a turn is running"
      # is busy AND busy since before this prompt. 2s of margin: a prompt sent in a turn's
      # first two seconds goes unlabelled, which is the harmless direction. No note, no
      # measurement, no label.
      _busy_ms=""
      _p="$PPID"; _cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
      for _ in 1 2 3 4 5 6; do
        case "$_p" in ''|0|1|*[!0-9]*) break ;; esac
        if [ -f "$_cfg/sessions/$_p.json" ]; then
          _busy_ms="$(jq -r --arg s "$SESSION" --arg p "$_p" \
            'select(.sessionId == $s and (.pid|tostring) == $p and .status == "busy")
             | (now * 1000 - (.statusUpdatedAt // 0)) | floor' "$_cfg/sessions/$_p.json" 2>/dev/null)"
          break
        fi
        _p="$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')"
      done
      case "$_busy_ms" in ''|*[!0-9]*) _busy_ms=0 ;; esac
      # ...and never the prompt being annotated: if the task in hand IS this prompt, it was
      # re-sent, not queued behind anything.
      _this="$(printf '%s\n' "$_prompt" | awk 'NF { print; exit }' | tr '\t\037' '  ')"
      if [ "$_prev" = working ] && [ -n "$_t_line" ] && [ "$_busy_ms" -ge 2000 ] \
         && [ "$_t_line" != "${_this:0:160}" ]; then
        _mid=1
        if [ -n "$_t_at" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] \
           && tail -n "+$(( _t_at + 1 ))" "$TRANSCRIPT" 2>/dev/null \
              | grep -F '[Request interrupted by user' >/dev/null 2>&1; then
          _mid=0
        fi
      fi
      # fleet-send --now: pasted into the turn ON PURPOSE. Say nothing, once.
      _nowf="$FLEET_DIR/${SOCK:-_}.${SLOT:-_}.now"
      if [ -n "$SOCK" ] && [ -n "$SLOT" ] && [ -f "$_nowf" ]; then rm -f "$_nowf"; _mid=0; fi
      if [ "$_mid" = 1 ]; then
        jq -n --arg t "$_t_line" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit",
          additionalContext: ("[fleet] This message arrived while you were still working on: \"" + $t + "\". It is QUEUED WORK, not a replacement: add it to your task list, finish the task in hand, then do this one — unless this message itself says to stop or switch (stop, instead, drop that, first do). Your closing report lists every task you received this turn with its state.")}}' 2>/dev/null
      else
        # A new turn: this prompt IS the task in hand. A fleet reply preamble is not what
        # was asked, so the first line after it is.
        _first="$_prompt"
        case "$_first" in "[fleet] This request comes from"*)
          _first="$(printf '%s\n' "$_first" | awk 'f && NF { print; exit } !NF { f = 1 }')" ;;
        esac
        _first="$(printf '%s\n' "$_first" | awk 'NF { print; exit }' | tr '\t\037' '  ')"
        _tl=0
        [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] \
          && _tl="$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d '[:space:]')"
        case "$_tl" in ''|*[!0-9]*) _tl=0 ;; esac
        printf '%s\x1f%s\n' "$_tl" "${_first:0:160}" > "$_taskf" 2>/dev/null
      fi ;;
  esac
  # ── JARVIS'S LEDGER: what the OWNER said, which is how a yes is proven ────────
  # Jarvis's confirm-list (lib/jarvis.mjs) lets a listed action through only after a yes that
  # the model did not write. This is where that yes is recorded: a prompt SUBMITTED into
  # Jarvis's own master, which is him at the desk, the phone's composer, or a transcript of
  # his voice. The machine's own traffic — every nudge, relay and reply-to preamble starts
  # with [fleet], Claude Code's injected turns with < — is dropped by the recorder, so a
  # worker answering "yes" can never be read as him saying it. Jarvis's master only: the
  # marker names its socket, and the name is read from tmux, not from the environment.
  if [ -n "$SOCK" ] && [ "$SLOT" = master ] && [ -f "$HOME/.config/ghostfleet/jarvis" ] \
     && [ "$SOCK" = "$(grep -m1 '^sock=' "$HOME/.config/ghostfleet/jarvis" 2>/dev/null | cut -d= -f2-)" ]; then
    printf '%s' "$_prompt" | "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../bin/fleet-jarvis" said --from owner >/dev/null 2>&1
  fi
fi
[ "$EVENT" = "Stop" ] && rm -f "$FLEET_DIR/$SESSION.task" 2>/dev/null

case "$EVENT" in
  UserPromptSubmit) status="working"                       # any new prompt un-parks the session
    if [ -n "$SLOT" ]; then
      [ -n "${CLAUDE_FLEET_SOCK:-}" ] && rm -f "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.$SLOT.parked" 2>/dev/null
      rm -f "$FLEET_DIR/$SLOT.parked" 2>/dev/null                                    # legacy bare marker
    fi ;;
  Notification)
    # Claude fires Notification for real attention (permission / a question) AND for
    # benign idle ("Claude is waiting for your input"), which a long-running lead or
    # watcher trips constantly. Only real attention is a need-you; idle-waiting means
    # the turn is over and it's sitting at the prompt → 'ready'.
    low="$(printf '%s' "$NOTE" | tr '[:upper:]' '[:lower:]')"
    case "$low" in
      # benign idle — the turn is over, it's sitting at the prompt
      *"waiting for your input"*|*"waiting for your response"*|*"is waiting"*) status="ready" ;;
      # a HARD block genuinely needs you (fleet-answer unblocks these)
      *"limit reached"*|*"rate limit"*|*"approaching your"*) status="need-you" ;;
      # usage ADVISORIES ("You've used 77% of your weekly limit · resets 7pm") are
      # informational: nothing is waiting on you, so they must not paint "need you"
      # on the card. Checked after the hard-block patterns above.
      *"you've used"*|*"youve used"*|*"% of your"*) status="ready" ;;
      *) status="need-you" ;;
    esac
    ;;
  Stop)             status="ready"    ;;
  SubagentStop)     status="working"  ;;
  SessionStart)     status="idle"     ;;
  *)                status="working"  ;;
esac

# --- write status file (atomic) ----------------------------------------------
# THE MOD'S FIELDS RIDE ALONG. mods/ghostfleet writes a Claude session's exact state into
# this same record from inside Claude Code (source, state, turnId, mod, usage), and this
# hook rebuilds the record from nothing on every event, so without this every Stop and
# every Notification would wipe them and the readers would fall back to the pane until
# the mod's next write. Read from the file at the moment of writing, not at the top: the
# mod writes while this hook runs, and the later the read the smaller the window in which
# its write is lost. The list is mods/ghostfleet/hooks/shape.js's MOD_FIELDS, and the
# suite holds the two to each other.
_mod="$(jq -c '{source, state, turnId, mod, usage} | with_entries(select(.value != null))' \
  "$FLEET_DIR/$SESSION.json" 2>/dev/null)"
case "$_mod" in '{'*) ;; *) _mod='{}' ;; esac
tmp="$FLEET_DIR/.$SESSION.$$.tmp"
if jq -n \
  --arg id "$SESSION" --arg z "$ZELL" --arg slot "$SLOT" \
  --arg sock "$SOCK" --arg pane "$PANE" \
  --arg cwd "$CWD" --arg folder "$folder" --arg branch "$branch" \
  --arg status "$status" --arg tr "$TRANSCRIPT" --argjson ts "$now" --arg from "$FROM" \
  --argjson mod "$_mod" \
  '{session_id:$id, zellij:$z, sock:$sock, slot:$slot, pane:$pane, cwd:$cwd, folder:$folder,
    branch:$branch, status:$status, transcript:$tr, ts:$ts}
   + (if $from != "" then {continued_from:$from} else {} end) + $mod' \
  >"$tmp" 2>/dev/null
then
  mv -f "$tmp" "$FLEET_DIR/$SESSION.json" 2>/dev/null || _dbg "write: could not move $tmp into place"
else
  _dbg "write: jq could not build the record for $SESSION ($EVENT)"
  rm -f "$tmp" 2>/dev/null
fi

# A wake PASTES into a session's input box and presses Enter, so it must only fire when
# that box is EMPTY — otherwise it submits whatever a human was half-way through typing
# with the nudge glued onto the end.
#
# FIND THE BOX; DO NOT GUESS AT IT. This used to grep the whole visible pane for ❯ and
# take the last match, on the assumption that the last ❯ on screen is the input box. It
# is not, and the assumption fails in both directions:
#
#   * Claude Code echoes every SUBMITTED message back into the transcript as `❯ <text>`,
#     and those stay on screen. Measured on a live master: `❯ did it finsih and it didnt
#     send a message?` — submitted minutes earlier, sitting in no box at all.
#   * Any RENDERED CONTENT can carry one: a tool result showing another pane, a file
#     being displayed — and, fittingly, this hook's own source, because the old line
#     `grep '❯'` contains one.
#
# Each of those reads as "half-typed", so the wake is skipped and the master is never
# told a worker finished. Two events did exactly that on 2026-08-25 (22:16 and 22:24);
# the stamp, written only on a successful send, still read 22:02.
#
# WHAT ACTUALLY LOCATES THE COMPOSER is the frame around it, and bin/fleet-send's
# in_input() had the insight first: the composer is the region between the LAST TWO
# boundary lines, because below it there is only the status bar, which carries text.
#   NOT a copy of its regex, though, and the difference is measured rather than stylistic.
# in_input tests for a line of NOTHING but rule glyphs and spaces. On a live worker pane
# that matches a BLANK line (an empty string satisfies it) and misses the labelled edge
# the fleet draws, so its pair straddles the wrong lines — it happens to still contain the
# composer, which is why in_input works in practice, but it is right by luck. The version
# below anchors on a run of rule glyphs instead, which is why it needs no luck.
#
# THREE ANSWERS, NOT TWO, and the caller needs the difference:
#   0  composer found and EMPTY          -> safe to paste
#   1  composer found and OCCUPIED       -> never paste; a human is mid-sentence
#   2  no composer found                 -> never paste either. A permission dialog, a
#                                           full-screen overlay or a scrolled-back pane
#                                           has no box, and pasting into one is exactly
#                                           as wrong as clobbering a message.
# Refusing on "unknown" is only affordable because a refusal is no longer a drop — see
# _defer_nudge below. The two changes are one change: the guard can be strict precisely
# because a skip now comes back.
#   LC_ALL=C AND NO BRACKET EXPRESSIONS, both of which were learned the hard way against
# live panes. A capture can contain a byte that is not valid UTF-8 — a spinner glyph split
# across a redraw — and BSD awk in a UTF-8 locale does not shrug that off, it aborts the
# record with `towc: multibyte conversion failure` and stops classifying. Under LC_ALL=C
# there is no conversion to fail. But a bracket expression like [─╭╰╮╯] is then a set of
# BYTES, not of characters, so it half-matches every other multibyte glyph on the line;
# every pattern below is therefore a literal alternation, which is the same bytes in both
# locales. `length("❯")` is 3 under C and 1 under UTF-8, and substr counts in the same
# units either way, so the skip past the glyph is right in both.
_input_state() {                      # $1=socket $2=session -> 0 empty / 1 typed / 2 none
  tmux -L "$1" capture-pane -p -t "$2" 2>/dev/null | LC_ALL=C awk '
    # A RULE MAY CARRY A LABEL. Requiring a line of NOTHING but rule glyphs looked right
    # and rejected the top edge of the composer on every worker pane, because the fleet
    # draws a labelled separator — `────── ghostfleet/docs-sync ─`. Measured on a live
    # worker: only ONE of the two edges matched, so the region was never found and every
    # wake read "no box". So: starts with a rule glyph and carries a long run of them. The
    # composer line starts with the prompt glyph and never qualifies; prose does not either.
    function isrule(s) { return s ~ /^[ \t]*(─|│|╭|╮|╰|╯)/ && s ~ /────────/ }
    { l[NR]=$0; if (isrule($0)) b[++n]=NR }
    END { if (n < 2) exit 2
          found = 0; rest = ""
          for (i = b[n-1] + 1; i < b[n]; i++) {
            line = l[i]
            # only the FIRST ❯ is the prompt glyph; anything after it on that line, and
            # every continuation line below it, is what the human has typed
            if (!found) { p = index(line, "❯")
                          if (p) { found = 1; line = substr(line, p + length("❯")) } }
            rest = rest line
          }
          if (!found) exit 2
          # NOT JUST ASCII SPACE. A live empty composer pads with U+00A0 (c2 a0), not
          # U+0020 — measured on this fleet, where the box reads `❯` followed by a
          # NON-BREAKING space. Strip that and its neighbours too, or an empty box counts
          # as typed and the wake is skipped forever. The padding has already changed once;
          # anything space-like belongs on this list.
          gsub(/─|│|╭|╮|╰|╯|\||[ \t]|\302\240|\342\200[\200-\213\257]|\343\200\200/, "", rest)
          exit (rest == "" ? 0 : 1) }' 2>/dev/null
}
_input_empty() { _input_state "$1" "$2"; [ "$?" = 0 ]; }

# A SKIPPED WAKE MUST NOT VANISH.
#
# The skip used to leave nothing behind, on the reasoning that "the next event re-checks
# right away instead of waiting out the cooldown". That only holds if another event comes.
# When the LAST worker to finish is the one that gets skipped, nothing re-checks — ever.
# The master sits idle with a DONE in its inbox and no reason to look, which is
# indistinguishable from no worker having finished: no error, no row, nothing to grep.
#
# So a skip arms a detached re-check instead. Delayed, never dropped.
#
# ONE PER FLEET, and that is not a shortcut: a single wake covers every row in the inbox,
# which is the same reason the debounce below coalesces a burst of finishes into one
# nudge. Five workers finishing while a human types must not queue five pastes for the
# moment the box clears. The lock holds the re-check's pid, so a dead one never blocks a
# live event from arming a fresh one.
#
# It re-enters the SAME debounce-and-stamp path rather than sending directly, so a
# re-check that wakes up after a fresh event already nudged simply exits — the stamp it
# reads is the other path's.
#
# BOUNDED, because a human who walks away mid-sentence would otherwise leave a process
# polling forever. On giving up it writes a marker naming what went undelivered, so the
# end state is still greppable rather than silent — the whole complaint about the old
# behaviour was the absence of a trace, and a retry that expires quietly would recreate it
# at a longer timescale.
#   IT TAKES A DIRECTORY, A KIND AND A MESSAGE, so the same machinery wakes Jarvis: another
# profile's fleet is another directory, and Jarvis's stamp must not be the master nudge's —
# either would swallow the other's wake. Called with the socket alone it is what it always
# was: this fleet's dir, the notify stamp, the worker nudge — whose words live HERE, inside
# the function, so it still works when lifted out and run on its own (the suite does).
_defer_nudge() {                      # $1=socket [$2=fleet dir $3=kind $4=message $5=target]
  # declared separately, not `local a=$1 b=…$a…`: bash expands every assignment word in a
  # single `local` before binding any of them, so the second would read an unset $sock and
  # abort the hook under `set -u`
  local sock dir kind msg lock p to
  sock="$1"; dir="${2:-$FLEET_DIR}"; kind="${3:-notify}"; msg="${4:-[fleet] A worker finished or needs you — run fleet-inbox to see what changed, then continue (dispatch the next step, merge, or unblock). Automated nudge; no need to reply to it.}"; to="${5:-master}"
  lock="$dir/$sock.$kind.retry"
  p="$(cat "$lock" 2>/dev/null)"
  case "$p" in ''|*[!0-9]*) ;; *) kill -0 "$p" 2>/dev/null && return 0 ;; esac
  export -f _input_state _input_empty
  FLEET_DIR="$dir" nohup bash -c '
    sock="$1"; lock="$2"; every="${3:-20}"; tries="${4:-30}"; kind="${5:-notify}"; msg="$6"; to="${7:-master}"
    echo $$ > "$lock" 2>/dev/null
    trap "rm -f \"$lock\"" EXIT
    i=0
    while [ "$i" -lt "$tries" ]; do
      sleep "$every"; i=$((i + 1))
      tmux -L "$sock" has-session -t "$to" 2>/dev/null || continue
      stamp="$FLEET_DIR/$sock.$kind.stamp"
      last="$(cat "$stamp" 2>/dev/null || echo 0)"
      case "$last" in ""|*[!0-9]*) last=0 ;; esac
      case "$kind" in jarvis) win="${CLAUDE_FLEET_JARVIS_DEBOUNCE:-30}" ;; *) win="${CLAUDE_FLEET_NOTIFY_DEBOUNCE:-30}" ;; esac
      case "$win" in ""|*[!0-9]*) win=30 ;; esac
      now="$(date +%s)"
      # a fresh event already woke it: nothing left to deliver
      [ "$(( now - last ))" -ge "$win" ] || exit 0
      if _input_empty "$sock" "$to"; then
        printf "%s\n" "$now" > "$stamp" 2>/dev/null
        # CLAUDE_FLEET_DIR is where fleet-send QUEUES a prompt for a busy target, so it is
        # the target fleet dir: the one its own Stop drains. (No apostrophes in here: this
        # whole body is one single-quoted argument.)
        CLAUDE_FLEET_DIR="$FLEET_DIR" fleet-send -s "$sock" "$to" "$msg" >/dev/null 2>&1
        exit 0
      fi
    done
    printf "%s deferred wake expired after %ss with the input box never clear\n" \
      "$(date +%Y-%m-%dT%H:%M:%S)" "$(( every * tries ))" \
      >> "$FLEET_DIR/$sock.$kind.undelivered" 2>/dev/null
  ' _ "$sock" "$lock" "${CLAUDE_FLEET_NOTIFY_RETRY_EVERY:-20}" \
       "${CLAUDE_FLEET_NOTIFY_RETRY_TRIES:-30}" "$kind" "$msg" "$to" >/dev/null 2>&1 &
}

# Did this turn already hand the answer to the asker DIRECTLY? fleet-send --reply-to now
# asks the target to call SendMessage (Claude Code's cross-session messaging), which lands
# in the asker's session even while it is mid-turn — the exact case where the relay below
# skips its wake and the row sits unread. Both paths are live at once, so a target that
# does as it is told would answer TWICE: once into the asker's session, and again as an
# inbox row plus a paste into the asker's input box, which can Stop a turn it never asked
# about.
#
# PROOF, NOT INTENTION. What counts is a SendMessage whose recipient is THIS asker and
# whose tool_result came back {"success":true} — the recipient's own confirmation that it
# was delivered. A tool call alone doesn't count: an unreachable name (a session started
# before it had a peer name, or renamed since) answers {"success":false}, and suppressing
# on that would recreate the silence this whole path exists to end.
#
# SCOPED TO THIS TURN, from the line the transcript had reached when the address was armed.
# The address survives across turns until it's answered, so an unscoped search would find
# the SendMessage that answered the PREVIOUS question to the same asker and swallow this
# one.
#
# Fails toward DELIVERING: no transcript, no offset, unparsable JSON, no jq — every one of
# them returns non-zero and the relay runs. A duplicate answer is annoying; a dropped one
# is the bug.
_peer_answered() {              # $1=transcript $2=line this turn starts at $3=asker peer name
  local tr="$1" from="$2" to="$3" n=""
  [ -n "$tr" ] && [ -f "$tr" ] && [ -n "$to" ] || return 1
  case "$from" in ''|*[!0-9]*) return 1 ;; esac
  # `.content` of a tool_result is an ARRAY of blocks, and `tostring` on it JSON-escapes
  # the payload's own quotes ("success" becomes \"success\") — which is exactly how the
  # first version of this matched nothing at all. Join the text blocks instead.
  n="$(tail -n "+$(( from + 1 ))" "$tr" 2>/dev/null | jq -s --arg to "$to" '
        ([ .[] | select(.type=="assistant") | (.message.content // [])
           | if type=="array" then .[] else empty end
           | select(.type=="tool_use" and .name=="SendMessage" and ((.input.to // "") == $to))
           | .id ]) as $ids
        | [ .[] | select(.type=="user") | (.message.content // [])
            | if type=="array" then .[] else empty end
            | select(.type=="tool_result" and (.is_error != true))
            | .tool_use_id as $tid | select(($ids | index($tid)) != null)
            | (.content | if type=="array" then map(select(.type=="text") | .text) | join(" ")
                          else tostring end)
            | select(test("\"success\" *: *true")) ] | length' 2>/dev/null)"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -gt 0 ]
}

# --- push worker events into the lead's inbox (see fleet-inbox) ---------------
# Event-driven, zero polling: the lead can't be interrupted, so it drains this
# feed with `fleet-inbox` instead of polling every sibling. Emit the two events a
# lead acts on: a worker NEEDING a human (permission / limit / a real question),
# and a worker DONE (its turn ended → idle, the completion signal — a worker's
# autonomous turn Stops once when its whole tool-loop finishes). Workers only,
# never the lead's own turns; best-effort, never fail the hook.
# ── A SUB-WORKER REPORTS TO ITS SUB-LEAD, NOT TO MASTER ──────────────────────
# A child spawned from a worker's worktree (bin/fleet-spawn) carries its parent's name in
# <sock>.<child>.parent. Its events go to THAT session's inbox, <sock>.<parent>.inbox, and
# wake THAT session: the sub-lead asked for this worker and is waiting on it, and the top
# master asked for the sub-lead, not for its team — it sees the rollup on the sub-lead's
# card. Same socket, same fleet dir; only the inbox and the wake target move.
#   A PARENT THAT IS GONE HANDS ITS CHILDREN BACK TO MASTER, rather than filing their
# events into an inbox nobody will ever drain. Silence is this fleet's worst symptom, and
# a tag pointing at a stopped session is exactly how it would arrive.
_parent=""; _to=master; _inbox="$FLEET_DIR/${CLAUDE_FLEET_SOCK:-}.inbox"
_submsg="[fleet] One of YOUR workers finished or needs you — run fleet-inbox to see what changed, then continue (merge its PR into your branch, dispatch the next step, or unblock). Automated nudge; no need to reply to it."
if [ -n "$SLOT" ] && [ "$SLOT" != master ] && [ -n "${CLAUDE_FLEET_SOCK:-}" ] \
   && [ -f "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}.parent" ]; then
  _parent="$(head -1 "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}.parent" 2>/dev/null)"
  case "$_parent" in ''|master|*[!A-Za-z0-9._~-]*) _parent="" ;; esac
  if [ -n "$_parent" ] && tmux -L "$CLAUDE_FLEET_SOCK" has-session -t "$_parent" 2>/dev/null; then
    _to="$_parent"; _inbox="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${_parent}.inbox"
  else
    _parent=""
  fi
fi
if [ -n "$SLOT" ] && [ "$SLOT" != master ] && [ -n "${CLAUDE_FLEET_SOCK:-}" ]; then
  ev=""; detail=""
  if   [ "$status" = "need-you" ]; then ev="need-you"; detail="${NOTE:0:120}"
  elif [ "$EVENT" = "Stop" ];      then ev="done";      detail="${folder}${branch:+ · $branch}"
  fi
  if [ -n "$ev" ]; then
    printf '%s\t%s\t%s\t%s\n' "$now" "$SLOT" "$ev" "$detail" \
      >> "$_inbox" 2>/dev/null || true

    # Opt-in PUSH: instead of the lead polling, WAKE it so it drains the inbox and
    # acts. Enable per fleet by `touch $FLEET_DIR/<sock>.notify-lead` (live, no
    # restart) or export CLAUDE_FLEET_NOTIFY_LEAD=1 before launching the fleet.
    # Debounced (leading-edge cooldown): the first event wakes the master, then
    # events within CLAUDE_FLEET_NOTIFY_DEBOUNCE seconds (default 30) are suppressed,
    # so a burst of finishes wakes it ONCE. OFF by default — each wake spends a
    # master turn on the shared account. Never fires for the lead's own turns (this
    # block is workers-only); fleet-send queues it if the master is mid-turn.
    #
    # PRECEDENCE — MOST SPECIFIC WINS, at every level. This is the one statement of it;
    # the grid's settings pages, fleet-serve and the docs point here.
    #   A worker of MASTER:
    #     1. its own <sock>.<worker>.notify-lead-off -> silent; .notify-lead -> push
    #     2. the project's <sock>.notify-lead-off    -> silent (overrides env and global)
    #     3. env CLAUDE_FLEET_NOTIFY_LEAD=1, the project's <sock>.notify-lead, or the
    #        global ~/.config/ghostfleet/notify-lead  -> push;  none of them -> silent
    #   A CHILD OF A SUB-LEAD (a live parent named in <sock>.<child>.parent):
    #     1. the child's own .notify-lead-off -> silent; its .notify-lead -> push
    #     2. the SUB-LEAD's own .notify-lead-off -> silent; its .notify-lead -> push
    #     3. the project's <sock>.notify-lead-off -> silent
    #     4. otherwise -> push
    # Per-session markers are set from the grid's settings page (,); the project's from the
    # projects screen (,). So one noisy worker can be silenced without touching the
    # project, and one can push while the rest of the project stays quiet.
    # A sub-lead's own marker is the same file that decides whether ITS turns nudge master,
    # so switching a sub-lead off quiets it in both directions.
    #   A SUB-LEAD IS WOKEN BY DEFAULT (step 4). The opt-in exists to keep background
    # chatter off a master that did not ask to be interrupted; a sub-lead spawned these
    # workers in order to wait for them, and a done it has to poll for is the gap this
    # whole feature closes. The project's off-switch used to sit ABOVE the per-session
    # markers on this path only, so a project switched off with every session switched on
    # filed its children's dones in the sub-lead's inbox and never woke it — while the
    # settings page said the session's setting won. Now the sub-lead path reads like
    # master's, with the sub-lead as one more level between the child and the project.
    _sm="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}"
    _pm="$FLEET_DIR/${CLAUDE_FLEET_SOCK}"
    _lm="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${_parent}"
    _push=0
    if   [ -n "$_parent" ] && [ -f "$_sm.notify-lead-off" ]; then _push=0
    elif [ -n "$_parent" ] && [ -f "$_sm.notify-lead" ];     then _push=1
    elif [ -n "$_parent" ] && [ -f "$_lm.notify-lead-off" ]; then _push=0
    elif [ -n "$_parent" ] && [ -f "$_lm.notify-lead" ];     then _push=1
    elif [ -n "$_parent" ] && [ -f "$_pm.notify-lead-off" ]; then _push=0
    elif [ -n "$_parent" ];                                  then _push=1
    elif [ -n "$SLOT" ] && [ -f "$_sm.notify-lead-off" ]; then _push=0
    elif [ -n "$SLOT" ] && [ -f "$_sm.notify-lead" ];     then _push=1
    elif [ -f "$_pm.notify-lead-off" ];                   then _push=0
    elif [ "${CLAUDE_FLEET_NOTIFY_LEAD:-0}" = 1 ] \
      || [ -f "$_pm.notify-lead" ] \
      || [ -f "$HOME/.config/ghostfleet/notify-lead" ]; then _push=1
    fi
    if [ "$_push" = 1 ] \
       && tmux -L "$CLAUDE_FLEET_SOCK" has-session -t "$_to" 2>/dev/null; then
      # One stamp per WAKE TARGET: a sub-lead's burst must not swallow master's next wake.
      stamp="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.notify.stamp"
      [ -n "$_parent" ] && stamp="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${_parent}.notify.stamp"
      last="$(cat "$stamp" 2>/dev/null || echo 0)"; case "$last" in ''|*[!0-9]*) last=0 ;; esac
      win="${CLAUDE_FLEET_NOTIFY_DEBOUNCE:-30}"; case "$win" in ''|*[!0-9]*) win=30 ;; esac
      if [ "$(( now - last ))" -ge "$win" ]; then
        # Don't clobber a half-typed message, and don't paste into a pane with no box at
        # all (see _input_state). Don't stamp on skip, so the next event re-checks right
        # away instead of waiting out the cooldown — and arm a re-check, because when the
        # LAST worker to finish is the skipped one there is no next event (_defer_nudge).
        if _input_empty "$CLAUDE_FLEET_SOCK" "$_to"; then
          printf '%s\n' "$now" > "$stamp" 2>/dev/null
          _sock="$CLAUDE_FLEET_SOCK"
          if [ -n "$_parent" ]; then
            ( fleet-send -s "$_sock" "$_to" "$_submsg" >/dev/null 2>&1 & )
          else
            ( fleet-send -s "$_sock" master "[fleet] A worker finished or needs you — run fleet-inbox to see what changed, then continue (dispatch the next step, merge, or unblock). Automated nudge; no need to reply to it." >/dev/null 2>&1 & )
          fi
        elif [ -n "$_parent" ]; then
          # its own kind, so the retry's lock and stamp are the sub-lead's and not master's
          _defer_nudge "$CLAUDE_FLEET_SOCK" "$FLEET_DIR" "$_parent.notify" "$_submsg" "$_parent"
        else
          _defer_nudge "$CLAUDE_FLEET_SOCK"
        fi
      fi
    fi
  fi
fi

# --- wake JARVIS, the master of masters, for a need-you ANYWHERE ---------------
# Every fleet's own master is woken by the block above, on ITS socket and in ITS fleet dir.
# Jarvis is above all of them, on whichever profile it was put on, so this is the one path
# that crosses profiles on purpose — which is why it reads the marker for Jarvis's socket AND
# its config dir, and writes into THAT fleet dir rather than this one. A row written to the
# wrong profile's dir is invisible with nothing to grep (CLAUDE.md, "every push channel is
# scoped to ONE fleet socket").
#
# ONLY A NEED-YOU WAKES IT, AND ONLY FOR SOMEBODY ELSE. A finished turn does not: Jarvis
# reads finished work from the digest when the owner asks, so a day of workers finishing
# costs it nothing — an idle Jarvis spends zero turns. The one opt-in exception is `batch=`
# in the marker, a minutes-scale window after which ONE nudge covers everything that
# finished (off by default, because every Jarvis turn that ends is a push to his phone).
# Jarvis's own need-you reaches the phone through fleet-serve's watcher like any lead's; it
# never wakes itself.
#
# Masters included: a lead blocked on a permission prompt is exactly what he wants to hear
# about, and the workers-only gate above exists for a different inbox.
JMARK="$HOME/.config/ghostfleet/jarvis"
if [ -f "$JMARK" ] && [ -n "$SOCK" ] && [ -n "$SLOT" ] \
   && { [ "$status" = need-you ] || [ "$EVENT" = Stop ]; }; then
  j_sock="$(grep -m1 '^sock=' "$JMARK" 2>/dev/null | cut -d= -f2-)"
  j_cfg="$(grep -m1 '^cfg=' "$JMARK" 2>/dev/null | cut -d= -f2-)"
  j_batch="$(grep -m1 '^batch=' "$JMARK" 2>/dev/null | cut -d= -f2-)"
  case "$j_batch" in ''|*[!0-9]*) j_batch=0 ;; esac
  case "$j_cfg" in /*) ;; *) j_sock="" ;; esac           # a relative dir is not a place to write
  # JARVIS'S OWN WORKERS already reach it: the worker block above wrote their row into this
  # same inbox and, when notify-lead is on, nudged this same master. Doing it again here
  # would be a second row for one event and a second wake a stamp apart.
  # A SUB-WORKER on Jarvis's own fleet belongs to its sub-lead, which the block above
  # already filed and woke: Jarvis sees that one on the sub-lead's card, like any master.
  j_own=0; [ "$SOCK" = "$j_sock" ] && j_own=1
  if [ -n "$j_sock" ] && ! { [ "$SOCK" = "$j_sock" ] && [ "$SLOT" = master ]; } \
     && ! { [ "$j_own" = 1 ] && { [ "${_push:-0}" = 1 ] || [ -n "$_parent" ]; }; }; then
    j_dir="$j_cfg/fleet"; mkdir -p "$j_dir" 2>/dev/null
    j_who="${SOCK#cf-}/$SLOT"
    j_stamp="$j_dir/$j_sock.jarvis.stamp"
    j_last="$(cat "$j_stamp" 2>/dev/null || echo 0)"; case "$j_last" in ''|*[!0-9]*) j_last=0 ;; esac
    j_win="${CLAUDE_FLEET_JARVIS_DEBOUNCE:-30}"; case "$j_win" in ''|*[!0-9]*) j_win=30 ;; esac
    if [ "$status" = need-you ]; then
      [ "$j_own" = 1 ] || printf '%s\t%s\t%s\t%s\n' "$now" "$j_who" "need-you" "${NOTE:0:160}" >> "$j_dir/$j_sock.inbox" 2>/dev/null
      j_msg="[fleet] need-you: $j_who — ${NOTE:0:120}. Run fleet_digest, then tell the owner in one line what is blocked and what you propose. Answering it for him is on the confirm-list. Automated wake."
      # Leading-edge, like every other wake here: a burst of blocks is one look, and the digest
      # the look starts with names all of them. Not running: the row waits in its inbox.
      if tmux -L "$j_sock" has-session -t master 2>/dev/null && [ "$(( now - j_last ))" -ge "$j_win" ]; then
        if _input_empty "$j_sock" master; then
          printf '%s\n' "$now" > "$j_stamp" 2>/dev/null
          # Jarvis's dirs, not this session's: another profile's hook is running this, and
          # a busy Jarvis QUEUES the prompt under CLAUDE_FLEET_DIR — which must be the dir
          # Jarvis's own Stop drains, or the wake waits in a file nothing reads.
          ( CLAUDE_FLEET_DIR="$j_dir" CLAUDE_CONFIG_DIR="$j_cfg" fleet-send -s "$j_sock" master "$j_msg" >/dev/null 2>&1 & )
        else
          _defer_nudge "$j_sock" "$j_dir" jarvis "$j_msg"
        fi
      fi
    elif [ "$j_batch" -gt 0 ]; then
      # ONE SLEEPER PER JARVIS, armed by the first finish after a quiet spell. When it wakes it
      # nudges only if nothing else woke Jarvis in the meantime — a need-you already made it
      # look, and that look read the whole digest.
      j_lock="$j_dir/$j_sock.jarvis.batch"
      j_p="$(cat "$j_lock" 2>/dev/null)"
      case "$j_p" in ''|*[!0-9]*) j_p="" ;; esac
      if [ -z "$j_p" ] || ! kill -0 "$j_p" 2>/dev/null; then
        export -f _input_state _input_empty
        nohup bash -c '
          sock="$1"; lock="$2"; stamp="$3"; after="$4"; armed="$5"; dir="$6"
          echo $$ > "$lock" 2>/dev/null; trap "rm -f \"$lock\"" EXIT
          sleep "$after"
          last="$(cat "$stamp" 2>/dev/null || echo 0)"; case "$last" in ""|*[!0-9]*) last=0 ;; esac
          [ "$last" -ge "$armed" ] && exit 0
          tmux -L "$sock" has-session -t master 2>/dev/null || exit 0
          _input_empty "$sock" master || exit 0
          date +%s > "$stamp" 2>/dev/null
          CLAUDE_FLEET_DIR="$dir" fleet-send -s "$sock" master "[fleet] batch: work finished across the fleets in the last $(( after / 60 )) minutes. Run fleet_digest and tell the owner only what he would want to know unprompted, in one line. Automated wake." >/dev/null 2>&1
        ' _ "$j_sock" "$j_lock" "$j_stamp" "$j_batch" "$now" "$j_dir" >/dev/null 2>&1 &
      fi
    fi
  fi
fi

# --- relay the answer back to whoever ASKED (fleet-send --reply-to) -----------
# The block above is one-way: a worker's Stop reaches ITS OWN fleet's master and nobody
# else. So a question sent from another project — or sent to a project's MASTER, which
# that block skips entirely — got worked on and answered into thin air; from the asking
# side that is indistinguishable from being ignored. fleet-send --reply-to leaves an
# address next to the target session; this is the delivery.
#
# Deliberately NOT gated on the notify-lead markers: those exist to keep background
# worker chatter off a master. An explicit --reply-to is someone waiting for an answer,
# and dropping it silently is the exact failure this path exists to fix. Equally
# deliberately outside the workers-only block above, because the target of a
# cross-project question is usually that project's master.
#
# WHY ARMING, AND NOT JUST "RELAY ON THE NEXT STOP": fleet-send pastes into a target
# that may be MID-TURN, in which case the prompt queues and the turn already running
# Stops first. Relaying that Stop would answer with the wrong turn's work and consume
# the address, so the real answer — the one we asked for — would never be sent. So the
# address is ARMED by the UserPromptSubmit that actually starts a turn, and only an
# armed address relays. Note what this does NOT protect: if a human types into that
# session later, that turn is armed too. fleet-send removes its own marker when it
# can't confirm the submit, which closes the common way that happens.
if [ -n "${CLAUDE_FLEET_SOCK:-}" ] && [ -n "$SLOT" ]; then
  rt="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}.reply-to"
  # An arming the mod wrote names its turn on a second line (`turn <id>`): it was armed by
  # the turn.start of the very prompt that asked, and a prompt typed into that turn must
  # not move its offset past the start of the answer. Only a paste's arming is redone.
  if [ -f "$rt" ] && [ "$EVENT" = "UserPromptSubmit" ] \
     && ! grep -q '^turn ' "$rt.armed" 2>/dev/null; then
    # The arming marker also carries WHERE THIS TURN STARTS in the transcript — the line
    # count now — so the Stop below can ask "did this turn SendMessage the answer" without
    # finding the one that answered the previous question to the same asker. An empty or
    # unparsable marker (one written by older code) means "don't know", and _peer_answered
    # then declines to suppress: a duplicate, never a silence.
    _tl=0
    [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] \
      && _tl="$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d '[:space:]')"
    case "$_tl" in ''|*[!0-9]*) _tl=0 ;; esac
    printf '%s\n' "$_tl" > "$rt.armed" 2>/dev/null
  elif [ -f "$rt" ] && [ -f "$rt.armed" ] \
       && { [ "$EVENT" = "Stop" ] || [ "$status" = "need-you" ]; }; then
    # \x1f, and a sink for the leftover: with fewer variables than fields `read` glues
    # the rest onto the LAST one — which here is the DIRECTORY this writes into, so a
    # stray field would aim the whole delivery somewhere else. Validate every column.
    IFS=$'\x1f' read -r r_sock r_sess r_dir r_extra < "$rt" 2>/dev/null
    r_ok=1
    [ -n "${r_sock:-}" ] && [ -n "${r_sess:-}" ] && [ -z "${r_extra:-}" ] || r_ok=0
    case "${r_sock:-}${r_sess:-}" in *[!A-Za-z0-9._~-]*) r_ok=0 ;; esac
    case "${r_dir:-}" in /*) [ -d "$r_dir" ] || r_ok=0 ;; *) r_ok=0 ;; esac
    # An address pointing back at this very session would relay its own Stop into its
    # own input — and that reply is a prompt, which Stops, and relays again.
    [ "${r_sock:-}" = "$CLAUDE_FLEET_SOCK" ] && [ "${r_sess:-}" = "$SLOT" ] && r_ok=0

    if [ "$r_ok" = 1 ]; then
      # Who we would be answering, and where this turn began (see _peer_answered).
      r_peer="${r_sock#cf-}/$r_sess"
      r_start="$(head -n 1 "$rt.armed" 2>/dev/null | tr -d '[:space:]')"
      case "$r_start" in ''|*[!0-9]*) r_start="" ;; esac
      # An offset the transcript cannot contain has outlived the file it was counted against
      # (the session was killed and came back on another one). Scoping to it would read past
      # the end and report "no text" for a turn that answered perfectly, so treat it as
      # UNKNOWN — which falls back to the unscoped window, exactly as before this existed.
      if [ -n "$r_start" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
        _tn="$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d '[:space:]')"
        case "$_tn" in ''|*[!0-9]*) _tn=0 ;; esac
        [ "$r_start" -gt "$_tn" ] && r_start=""
      fi

      # THE RELAY IS NOW THE SECOND HALF OF A PAIR. fleet-send --reply-to asks the target to
      # answer the asker BY NAME with SendMessage, which lands in its session even mid-turn —
      # the case this relay is worst at, since its wake is skipped outright while the asker is
      # busy. Both paths live at once, so a target that does as it is told would answer TWICE,
      # the second time as a row that reads like a separate answer plus a paste into the
      # asker's input box. So the relay stands down for a delivery it can PROVE happened, and
      # runs in every other case: an unreachable asker, a target that ignored the instruction,
      # a non-Claude agent, a turn killed before it got there.
      r_direct=0
      [ "$EVENT" = "Stop" ] && _peer_answered "$TRANSCRIPT" "$r_start" "$r_peer" && r_direct=1

      if [ "$r_direct" = 0 ]; then
        if [ "$EVENT" = "Stop" ]; then
          r_ev="answered"
          # The answer itself: last non-empty assistant message, flattened to one line.
          # Same extraction as fleet-read, so the excerpt and the "full reply" command
          # can't disagree. Tabs MUST go — the inbox is a TSV and a tab in the detail
          # would shift the columns of a row nothing else validates.
          #
          # SCOPED TO THIS TURN, and RETRIED, because "the last assistant text in the file"
          # is not the same thing as "the answer". Caught on a live fleet: the final message
          # lands in the transcript in the same SECOND the Stop hook runs, and lost the race —
          # so the relay answered a question about 7+5 with `4`, the previous turn's answer,
          # confidently and with nothing in the row to reveal it. Scoping makes that
          # impossible (nothing from an earlier turn is in range); the retry is what turns the
          # racy case from "(no text)" back into the real answer. Bounded, and never reached
          # unless somebody is owed an answer this relay still has to carry.
          for _try in 1 2 3 4 5; do
            if [ -n "$r_start" ]; then _from="+$(( r_start + 1 ))"; else _from="-400"; fi
            r_txt="$(tail -n "$_from" "$TRANSCRIPT" 2>/dev/null \
              | jq -r 'select(.type=="assistant") | (.message.content // [])
                       | map(select(.type=="text")|.text) | join(" ")' 2>/dev/null \
              | grep -v '^[[:space:]]*$' | tail -1 | tr '\n\r\t' '   ')"
            [ -n "$r_txt" ] && break
            sleep 0.2
          done
        else
          r_ev="asks"; r_txt="$NOTE"
        fi
        # Bash substring, not `cut -c`: this text is UTF-8 (em dashes, box glyphs) and
        # cut counts bytes in the C locale, which would slice a character in half.
        r_txt="${r_txt:0:220}"
        [ -n "$r_txt" ] || r_txt="(no text — read it with fleet-read)"

        printf '%s\t%s\t%s\t%s\n' "$now" "${CLAUDE_FLEET_SOCK#cf-}/$SLOT" "$r_ev" "$r_txt" \
          >> "$r_dir/$r_sock.inbox" 2>/dev/null || true

        # Debounced per ASKER, not per fleet like the master nudge above: a shared stamp
        # would let either wake swallow the other's, and this one must not be droppable.
        r_stamp="$r_dir/$r_sock.$r_sess.relay.stamp"
        r_last="$(cat "$r_stamp" 2>/dev/null || echo 0)"; case "$r_last" in ''|*[!0-9]*) r_last=0 ;; esac
        r_win="${CLAUDE_FLEET_NOTIFY_DEBOUNCE:-30}"; case "$r_win" in ''|*[!0-9]*) r_win=30 ;; esac
        if tmux -L "$r_sock" has-session -t "=$r_sess" 2>/dev/null \
           && [ "$(( now - r_last ))" -ge "$r_win" ] && _input_empty "$r_sock" "$r_sess"; then
          printf '%s\n' "$now" > "$r_stamp" 2>/dev/null
          # No --reply-to on this one: an answer that asked for an answer is a loop.
          ( fleet-send -s "$r_sock" "$r_sess" "[fleet] ${CLAUDE_FLEET_SOCK#cf-}/$SLOT $r_ev your request: $r_txt
Full reply: fleet-read -s $CLAUDE_FLEET_SOCK $SLOT 3 — to ask it something else, fleet-send -s $CLAUDE_FLEET_SOCK --reply-to me $SLOT \"…\". Relayed automatically; no need to reply to this line." >/dev/null 2>&1 & )
        fi
      fi
      # One request, one answer: consume the address on Stop so a later, unrelated turn
      # can't answer again. need-you keeps it — that turn hasn't produced the answer yet.
      [ "$EVENT" = "Stop" ] && rm -f "$rt" "$rt.armed" 2>/dev/null
    else
      # A malformed address can never become valid, and leaving it would re-run this
      # every turn. Name it in the inbox of the fleet that CAN see it: our own.
      printf '%s\t%s\t%s\t%s\n' "$now" "$SLOT" "need-you" "unroutable reply-to marker dropped (see ${rt##*/})" \
        >> "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.inbox" 2>/dev/null || true
      rm -f "$rt" "$rt.armed" 2>/dev/null
    fi
  fi
fi

# --- deliver the next QUEUED prompt as a turn of its own (bin/fleet-send) -------
# fleet-send writes a prompt for a working session to <sock>.<slot>.queue instead of
# pasting it into the turn; this Stop is the moment that turn is over. AFTER the relay
# above on purpose: that block consumes this turn's reply address, and the queued prompt
# may carry its own, which `fleet-send --dequeue` writes as it delivers.
#   DETACHED AND RETRIED, because the hook runs while the turn is still finishing — the
# pane usually still shows the spinner at this instant, and --dequeue answers "busy" (3)
# rather than fold the prompt into the very turn it was queued behind. It also waits for an
# EMPTY composer (_input_state), for the same reason the master nudge does: a human half-way
# through a sentence must not get a queued prompt glued onto it.
#   ONE DRAINER PER SESSION, pid in <queue>.drain, so a burst of Stops does not race two
# deliveries. Bounded: a drainer that gives up leaves the queue intact — the card still
# says `queued: N`, the next Stop starts another, and the next plain fleet-send to an
# idle session delivers the head itself.
if [ "$EVENT" = "Stop" ] && [ -n "${CLAUDE_FLEET_SOCK:-}" ] && [ -n "$SLOT" ] \
   && [ -s "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}.queue" ]; then
  _qd="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}.queue.drain"
  _qp="$(cat "$_qd" 2>/dev/null)"
  case "$_qp" in ''|*[!0-9]*) _qp="" ;; esac
  if [ -z "$_qp" ] || ! kill -0 "$_qp" 2>/dev/null; then
    export -f _input_state
    # A session whose mod delivers takes the prompt without touching the composer
    # (register.js, DELIVERY), so a half-typed message there is no reason to wait. Asked
    # only when the composer is NOT empty, and asked again each time: a mod that has died
    # since means the paste, and the paste still waits.
    _qmt="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib/mod-target.mjs"
    FLEET_DIR="$FLEET_DIR" nohup bash -c '
      sock="$1"; slot="$2"; lock="$3"; every="$4"; tries="$5"; mt="$6"
      echo $$ > "$lock" 2>/dev/null
      trap "rm -f \"$lock\"" EXIT
      i=0
      while [ "$i" -lt "$tries" ]; do
        sleep "$every"; i=$((i + 1))
        tmux -L "$sock" has-session -t "=$slot" 2>/dev/null || exit 0
        [ -s "$FLEET_DIR/$sock.$slot.queue" ] || exit 0
        _input_state "$sock" "$slot"
        if [ "$?" != 0 ]; then
          [ "${CLAUDE_FLEET_MOD_DELIVER:-on}" != off ] && [ -f "$mt" ] \
            && node "$mt" "$FLEET_DIR" "$sock" "$slot" >/dev/null 2>&1 || continue
        fi
        fleet-send -s "$sock" --dequeue "$slot" >/dev/null 2>&1
        [ "$?" = 3 ] || exit 0
      done
    ' _ "$CLAUDE_FLEET_SOCK" "$SLOT" "$_qd" "${CLAUDE_FLEET_QUEUE_EVERY:-1}" \
         "${CLAUDE_FLEET_QUEUE_TRIES:-300}" "$_qmt" >/dev/null 2>&1 &
  fi
fi

# --- notify, detached so the hook returns fast -------------------------------
# Only a real attention-need (need-you) or a completed turn — never the benign idle
# "waiting for your input" Notification, which is the false "needs you" a watcher trips.
# CLAUDE_FLEET_NOTIFIER=off silences the popup and nothing else — the status file and the
# inboxes still record everything, which is what the rest of the fleet reads. For a
# headless/CI run (and test/run.sh, which fires this hook for real) a desktop
# notification per event is noise from a machine nobody is watching.
case "${CLAUDE_FLEET_NOTIFIER:-}" in off|none|false) EVENT_QUIET=1 ;; *) EVENT_QUIET=0 ;; esac
if [ "$EVENT_QUIET" = 0 ] \
   && { [ "$EVENT" = "Stop" ] || { [ "$EVENT" = "Notification" ] && [ "$status" = "need-you" ]; }; }; then
  # A bridge for another agent (hooks/agy-fleet-event.sh, hooks/cursor-fleet-event.sh) names it, so its popup does not
  # say "Claude" over a session that is not one.
  who="${CLAUDE_FLEET_EVENT_AGENT:-Claude}"
  if [ "$EVENT" = "Stop" ]; then title="✅ $who — done"; sound="Glass"; else title="🔔 $who — needs you"; sound="Ping"; fi
  sub="${folder:-claude}"; [ -n "$branch" ] && sub="$sub · $branch"
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

  # The Ctrl-f chord that lands on THIS session, so the popup says where to go instead
  # of only who spoke: "Ctrl-f 2 1". Two digits, and neither is guessable from here —
  # the project's is its position in ITS PROFILE's list, the session's is its position
  # in the grid's card order, which ⇧hjkl can rewrite.
  #
  # The session digit comes from `fleet-grid.mjs --order`, the same call bin/ghostfleet
  # counts the chord through. Deriving it here instead would be a second opinion about
  # an order the user can change, and the first time they disagreed the popup would
  # send you to the wrong session — worse than saying nothing.
  jump_chord() {
    local sock="$1" sess="$2" pn="" sn=""
    # Match on the SOCKET each row computes, not on the socket's name: a work project
    # called "personal-foo" and a personal project called "foo" both spell cf-personal-foo,
    # so splitting the string cannot tell them apart. Rebuilding it can.
    # Collect the lists that EXIST rather than globbing straight into awk: with no
    # profile files the pattern doesn't expand, and awk is handed a literal
    # ".../projects.*" it can't open — which killed the whole lookup. It only worked
    # here because this machine happens to have a projects.personal.
    local files=() f=""
    [ -f "$HOME/.config/ghostfleet/projects" ] && files+=("$HOME/.config/ghostfleet/projects")
    for f in "$HOME"/.config/ghostfleet/projects.*; do [ -f "$f" ] && files+=("$f"); done
    [ "${#files[@]}" -gt 0 ] || return 1
    pn="$(awk -F'\t' -v want="$sock" '
        FNR==1 { i=0; skip=0; prof="work"; f=FILENAME
                 if (sub(/.*\/projects\./, "", f)) { prof=f
                   if (prof !~ /^[A-Za-z0-9_-]+$/) skip=1 } }   # projects.bak.1785 is a backup
        skip || /^[[:space:]]*#/ || NF<2 { next }
        { i++
          p = ($3 != "" ? $3 : prof)
          s = (p == "work" || p == "default") ? "cf-" $1 : "cf-" p "-" $1
          if (s == want) { print i; exit } }
      ' "${files[@]}" 2>/dev/null)"
    case "$pn" in ''|*[!0-9]*) return 1 ;; esac
    [ "$pn" -ge 1 ] && [ "$pn" -le 9 ] || return 1      # the chord only takes one digit
    if [ "$sess" = master ]; then
      printf 'Ctrl-f %s ⏎' "$pn"; return 0             # master is Enter, not a digit
    fi
    sn="$(node "$HOOK_DIR/../bin/fleet-grid.mjs" "$sock" --order 2>/dev/null \
          | grep -nxF -- "$sess" 2>/dev/null | head -1 | cut -d: -f1)"
    case "$sn" in ''|*[!0-9]*) return 1 ;; esac
    [ "$sn" -ge 1 ] && [ "$sn" -le 9 ] || return 1
    printf 'Ctrl-f %s %s' "$pn" "$sn"
  }
  chord="$(jump_chord "${CLAUDE_FLEET_SOCK:-}" "$SLOT" 2>/dev/null)" || chord=""
  tn="$(command -v terminal-notifier 2>/dev/null || true)"
  JUMP="$HOOK_DIR/../bin/fleet-jump"
  # Default to osascript — it posts via a system app that's already authorized, so
  # it reliably shows on modern macOS. terminal-notifier is opt-in
  # (CLAUDE_FLEET_NOTIFIER=terminal-notifier) because it can be *clicked* to jump to
  # master — but macOS must authorize it first (System Settings → Notifications),
  # which old versions often never register for.
  if [ "${CLAUDE_FLEET_NOTIFIER:-osascript}" = "terminal-notifier" ] && [ -n "$tn" ] && [ -x "$JUMP" ]; then
    zs="${ZELL//\'/}"
    "$tn" -title "$title" -subtitle "${chord:+$chord · }$sub" -message "${SLOT:+$SLOT · }click → master" \
      -sound "$sound" -group "cf-$SESSION" \
      -execute "$JUMP '$zs' 'master' '${CLAUDE_FLEET_SOCK:-}'" >/dev/null 2>&1 &
  else
    # Chord FIRST: a notification is truncated from the right, and the one part you act
    # on must survive that. Absent when it can't be worked out (unknown project, or a
    # position past 9, which the chord can't express) — a wrong chord is worse than none.
    msg="${chord:+$chord · }${SLOT:+$SLOT — }$sub"; msg="${msg//\"/}"; msg="${msg//\\/}"; ttl="${title//\"/}"
    # macOS: osascript. Linux: notify-send. Neither: stay silent — the status file and
    # the lead's inbox already carry the event, so nothing depends on the popup.
    if command -v osascript >/dev/null 2>&1; then
      ( osascript -e "display notification \"$msg\" with title \"$ttl\" sound name \"$sound\"" >/dev/null 2>&1 & )
    elif command -v notify-send >/dev/null 2>&1; then
      ( notify-send "$ttl" "$msg" >/dev/null 2>&1 & )
    elif grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
      # WSL: notify-send usually has no DBus/X, so raise a Windows toast instead
      ( powershell.exe -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); \$n = New-Object System.Windows.Forms.NotifyIcon; \$n.Icon = [System.Drawing.SystemIcons]::Information; \$n.Visible = \$true; \$n.ShowBalloonTip(5000, '$ttl', '$msg', 'Info')" >/dev/null 2>&1 & )
    fi
  fi
fi

exit 0
