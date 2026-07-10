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
IFS=$'\t' read -r EVENT SESSION CWD TRANSCRIPT < <(
  printf '%s' "$input" | jq -r '
    [ .hook_event_name // "",
      .session_id // "",
      (.cwd // .workspace.current_dir // ""),
      (.transcript_path // "") ] | @tsv' 2>/dev/null
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
  UserPromptSubmit) status="working"  ;;
  Notification)     status="need-you" ;;
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

# --- notify (Stop / Notification only), detached so the hook returns fast -----
if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "Notification" ]; then
  if [ "$EVENT" = "Stop" ]; then title="✅ Claude — done"; sound="Glass"; else title="🔔 Claude — needs you"; sound="Ping"; fi
  sub="${folder:-claude}"; [ -n "$branch" ] && sub="$sub · $branch"
  tn="$(command -v terminal-notifier 2>/dev/null || true)"
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  JUMP="$HOOK_DIR/../bin/fleet-jump"
  if [ -n "$tn" ] && [ -x "$JUMP" ]; then
    # clickable: clicking focuses the window + lands you on MASTER (you coordinate
    # everything through the lead — you only ever talk to master)
    zs="${ZELL//\'/}"
    "$tn" -title "$title" -subtitle "$sub" -message "${SLOT:+$SLOT · }click → master" \
      -sound "$sound" -group "cf-$SESSION" \
      -execute "$JUMP '$zs' 'master' '${CLAUDE_FLEET_SOCK:-}'" >/dev/null 2>&1 &
  else
    msg="${SLOT:+$SLOT — }$sub"; msg="${msg//\"/}"; ttl="${title//\"/}"
    ( osascript -e "display notification \"$msg\" with title \"$ttl\" sound name \"$sound\"" >/dev/null 2>&1 & )
  fi
fi

exit 0
