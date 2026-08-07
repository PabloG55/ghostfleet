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

# jq is required to parse the payload; if it's missing, do nothing quietly.
command -v jq >/dev/null 2>&1 || exit 0
mkdir -p "$FLEET_DIR" 2>/dev/null || exit 0

# --- read the hook payload (single jq pass) ----------------------------------
input="$(cat)"
# Join with the unit separator (non-whitespace), not @tsv: a whitespace IFS makes
# `read` collapse empty fields (e.g. a missing transcript_path) and shift the rest.
IFS=$'\x1f' read -r EVENT SESSION CWD TRANSCRIPT NOTE < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.session_id // ""),
      (.cwd // .workspace.current_dir // ""),
      (.transcript_path // ""),
      (.message // "" | gsub("[\n\r\t]"; " ")) ] | join("\u001f")' 2>/dev/null
)

[ -n "$SESSION" ] || exit 0

# SessionEnd: deregister and stop here.
if [ "$EVENT" = "SessionEnd" ]; then
  rm -f "$FLEET_DIR/$SESSION.json" 2>/dev/null
  exit 0
fi

# --- derive identity ---------------------------------------------------------
folder="${CWD##*/}"
branch="$(git -C "${CWD:-.}" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)"
ZELL="${ZELLIJ_SESSION_NAME:-}"
SLOT="${CLAUDE_FLEET_SLOT:-}"
now="$(date +%s)"

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
tmp="$FLEET_DIR/.$SESSION.$$.tmp"
if jq -n \
  --arg id "$SESSION" --arg z "$ZELL" --arg slot "$SLOT" \
  --arg sock "${CLAUDE_FLEET_SOCK:-}" \
  --arg cwd "$CWD" --arg folder "$folder" --arg branch "$branch" \
  --arg status "$status" --arg tr "$TRANSCRIPT" --argjson ts "$now" \
  '{session_id:$id, zellij:$z, sock:$sock, slot:$slot, cwd:$cwd, folder:$folder,
    branch:$branch, status:$status, transcript:$tr, ts:$ts}' \
  >"$tmp" 2>/dev/null
then
  mv -f "$tmp" "$FLEET_DIR/$SESSION.json" 2>/dev/null
else
  rm -f "$tmp" 2>/dev/null
fi

# A wake PASTES into a session's input box and presses Enter, so it must only fire when
# that box is EMPTY — otherwise it submits whatever a human was half-way through typing
# with the nudge glued onto the end. Anything left after the ❯ prompt (once the box
# drawing is stripped) counts as half-typed. Skipping is safe: the event stays in the
# inbox and the next wake, with a clear box, delivers it. Shared by both wakes below.
_input_empty() {                      # $1=socket $2=session -> 0 when safe to paste
  local inl
  inl="$(tmux -L "$1" capture-pane -p -t "$2" 2>/dev/null | grep '❯' | tail -1)"
  inl="$(printf '%s' "${inl#*❯}" | tr -d '[:space:]│╭╮╰╯─|')"
  [ -z "$inl" ]
}

# --- push worker events into the lead's inbox (see fleet-inbox) ---------------
# Event-driven, zero polling: the lead can't be interrupted, so it drains this
# feed with `fleet-inbox` instead of polling every sibling. Emit the two events a
# lead acts on: a worker NEEDING a human (permission / limit / a real question),
# and a worker DONE (its turn ended → idle, the completion signal — a worker's
# autonomous turn Stops once when its whole tool-loop finishes). Workers only,
# never the lead's own turns; best-effort, never fail the hook.
if [ -n "$SLOT" ] && [ "$SLOT" != master ] && [ -n "${CLAUDE_FLEET_SOCK:-}" ]; then
  ev=""; detail=""
  if   [ "$status" = "need-you" ]; then ev="need-you"; detail="${NOTE:0:120}"
  elif [ "$EVENT" = "Stop" ];      then ev="done";      detail="${folder}${branch:+ · $branch}"
  fi
  if [ -n "$ev" ]; then
    printf '%s\t%s\t%s\t%s\n' "$now" "$SLOT" "$ev" "$detail" \
      >> "$FLEET_DIR/${CLAUDE_FLEET_SOCK}.inbox" 2>/dev/null || true

    # Opt-in PUSH: instead of the lead polling, WAKE it so it drains the inbox and
    # acts. Enable per fleet by `touch $FLEET_DIR/<sock>.notify-lead` (live, no
    # restart) or export CLAUDE_FLEET_NOTIFY_LEAD=1 before launching the fleet.
    # Debounced (leading-edge cooldown): the first event wakes the master, then
    # events within CLAUDE_FLEET_NOTIFY_DEBOUNCE seconds (default 30) are suppressed,
    # so a burst of finishes wakes it ONCE. OFF by default — each wake spends a
    # master turn on the shared account. Never fires for the lead's own turns (this
    # block is workers-only); fleet-send just queues if the master is mid-turn.
    #
    # Precedence (matches the TUI settings page, projects screen → ,):
    #   <sock>.notify-lead-off  is an authoritative KILL SWITCH — if present this
    #   fleet NEVER pushes, overriding the env var, the per-fleet on-marker, AND the
    #   global default. That's how "disable worker→master nudges for THIS project"
    #   works even when the global default is on. Otherwise push is on when any of
    #   env=1 / per-fleet on-marker / global marker is set.
    # MOST SPECIFIC WINS: a per-SESSION marker (<sock>.<session>.notify-lead[-off],
    # set from the grid's settings page) overrides the project's, which overrides the
    # env var / global default. So one noisy worker can be silenced without touching
    # the project, and one worker can push while the rest of the project stays quiet.
    _sm="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.${SLOT}"
    _pm="$FLEET_DIR/${CLAUDE_FLEET_SOCK}"
    _push=0
    if   [ -n "$SLOT" ] && [ -f "$_sm.notify-lead-off" ]; then _push=0
    elif [ -n "$SLOT" ] && [ -f "$_sm.notify-lead" ];     then _push=1
    elif [ -f "$_pm.notify-lead-off" ];                   then _push=0
    elif [ "${CLAUDE_FLEET_NOTIFY_LEAD:-0}" = 1 ] \
      || [ -f "$_pm.notify-lead" ] \
      || [ -f "$HOME/.config/ghostfleet/notify-lead" ]; then _push=1
    fi
    if [ "$_push" = 1 ] \
       && tmux -L "$CLAUDE_FLEET_SOCK" has-session -t master 2>/dev/null; then
      stamp="$FLEET_DIR/${CLAUDE_FLEET_SOCK}.notify.stamp"
      last="$(cat "$stamp" 2>/dev/null || echo 0)"; case "$last" in ''|*[!0-9]*) last=0 ;; esac
      win="${CLAUDE_FLEET_NOTIFY_DEBOUNCE:-30}"; case "$win" in ''|*[!0-9]*) win=30 ;; esac
      if [ "$(( now - last ))" -ge "$win" ]; then
        # Don't clobber a half-typed message (see _input_empty). Don't stamp on skip,
        # so the next event re-checks right away instead of waiting out the cooldown.
        if _input_empty "$CLAUDE_FLEET_SOCK" master; then
          printf '%s\n' "$now" > "$stamp" 2>/dev/null
          _sock="$CLAUDE_FLEET_SOCK"
          ( fleet-send -s "$_sock" master "[fleet] A worker finished or needs you — run fleet-inbox to see what changed, then continue (dispatch the next step, merge, or unblock). Automated nudge; no need to reply to it." >/dev/null 2>&1 & )
        fi
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
  if [ -f "$rt" ] && [ "$EVENT" = "UserPromptSubmit" ]; then
    : > "$rt.armed" 2>/dev/null
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
      if [ "$EVENT" = "Stop" ]; then
        r_ev="answered"
        # The answer itself: last non-empty assistant message, flattened to one line.
        # Same extraction as fleet-read, so the excerpt and the "full reply" command
        # can't disagree. Tabs MUST go — the inbox is a TSV and a tab in the detail
        # would shift the columns of a row nothing else validates.
        r_txt="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
          | jq -r 'select(.type=="assistant") | (.message.content // [])
                   | map(select(.type=="text")|.text) | join(" ")' 2>/dev/null \
          | grep -v '^[[:space:]]*$' | tail -1 | tr '\n\r\t' '   ')"
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
  if [ "$EVENT" = "Stop" ]; then title="✅ Claude — done"; sound="Glass"; else title="🔔 Claude — needs you"; sound="Ping"; fi
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
