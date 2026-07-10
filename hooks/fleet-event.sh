#!/usr/bin/env bash
# claude-fleet event hook.
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
  UserPromptSubmit) status="working"; [ -n "$SLOT" ] && rm -f "$FLEET_DIR/$SLOT.parked" 2>/dev/null ;;  # any new prompt un-parks
  Notification)
    # Claude fires Notification for real attention (permission / a question) AND for
    # benign idle ("Claude is waiting for your input"), which a long-running lead or
    # watcher trips constantly. Only real attention is a need-you; idle-waiting means
    # the turn is over and it's sitting at the prompt → 'ready'.
    low="$(printf '%s' "$NOTE" | tr '[:upper:]' '[:lower:]')"
    case "$low" in
      *"waiting for your input"*|*"waiting for your response"*|*"is waiting"*) status="ready" ;;
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
  --arg cwd "$CWD" --arg folder "$folder" --arg branch "$branch" \
  --arg status "$status" --arg tr "$TRANSCRIPT" --argjson ts "$now" \
  '{session_id:$id, zellij:$z, slot:$slot, cwd:$cwd, folder:$folder,
    branch:$branch, status:$status, transcript:$tr, ts:$ts}' \
  >"$tmp" 2>/dev/null
then
  mv -f "$tmp" "$FLEET_DIR/$SESSION.json" 2>/dev/null
else
  rm -f "$tmp" 2>/dev/null
fi

# --- notify, detached so the hook returns fast -------------------------------
# Only a real attention-need (need-you) or a completed turn — never the benign idle
# "waiting for your input" Notification, which is the false "needs you" a watcher trips.
if [ "$EVENT" = "Stop" ] || { [ "$EVENT" = "Notification" ] && [ "$status" = "need-you" ]; }; then
  if [ "$EVENT" = "Stop" ]; then title="✅ Claude — done"; sound="Glass"; else title="🔔 Claude — needs you"; sound="Ping"; fi
  sub="${folder:-claude}"; [ -n "$branch" ] && sub="$sub · $branch"
  tn="$(command -v terminal-notifier 2>/dev/null || true)"
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  JUMP="$HOOK_DIR/../bin/fleet-jump"
  # Default to osascript — it posts via a system app that's already authorized, so
  # it reliably shows on modern macOS. terminal-notifier is opt-in
  # (CLAUDE_FLEET_NOTIFIER=terminal-notifier) because it can be *clicked* to jump to
  # master — but macOS must authorize it first (System Settings → Notifications),
  # which old versions often never register for.
  if [ "${CLAUDE_FLEET_NOTIFIER:-osascript}" = "terminal-notifier" ] && [ -n "$tn" ] && [ -x "$JUMP" ]; then
    zs="${ZELL//\'/}"
    "$tn" -title "$title" -subtitle "$sub" -message "${SLOT:+$SLOT · }click → master" \
      -sound "$sound" -group "cf-$SESSION" \
      -execute "$JUMP '$zs' 'master' '${CLAUDE_FLEET_SOCK:-}'" >/dev/null 2>&1 &
  else
    msg="${SLOT:+$SLOT — }$sub"; msg="${msg//\"/}"; msg="${msg//\\/}"; ttl="${title//\"/}"
    ( osascript -e "display notification \"$msg\" with title \"$ttl\" sound name \"$sound\"" >/dev/null 2>&1 & )
  fi
fi

exit 0
