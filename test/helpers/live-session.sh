#!/usr/bin/env bash
# live-session.sh <sock> <slot> <conversation-id> <cwd> [transcript]
#
# Writes, for a FIXTURE pane, the note an agent writes about itself —
# $CLAUDE_CONFIG_DIR/sessions/<pid>.json — which is what bin/fleet-hibernate's live_sid()
# believes about which conversation a process is in. Keyed by the pane's pid and carrying
# that process's real start time, because live_sid refuses a note whose pid or procStart
# does not match the running process (a pid is reused; a crashed agent leaves its file).
#
# With a transcript, a copy lands where the agent would keep that conversation's — the
# project directory for <cwd> — with its mtime preserved, so the idle clock reads it.
#
# Only ever against a pane on a socket under the suite's own TMUX_TMPDIR, and only into a
# CLAUDE_CONFIG_DIR the caller made: it refuses to write under the real one.
set -uo pipefail
sock="$1" slot="$2" id="$3" cwd="$4" tr="${5:-}"
cfg="${CLAUDE_CONFIG_DIR:?live-session: set CLAUDE_CONFIG_DIR to a test directory}"
[ "$cfg" != "$HOME/.claude" ] || { echo "live-session: refusing the real config dir" >&2; exit 2; }
pid="$(tmux -L "$sock" list-panes -t "$slot" -F '#{pane_pid}' 2>/dev/null | head -1)"
[ -n "$pid" ] || { echo "live-session: no pane $sock/$slot" >&2; exit 1; }
start="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" | sed 's/ *$//')"
mkdir -p "$cfg/sessions"
jq -n --argjson pid "$pid" --arg id "$id" --arg cwd "$cwd" --arg st "$start" \
  '{pid:$pid, sessionId:$id, cwd:$cwd, procStart:$st, kind:"interactive"}' > "$cfg/sessions/$pid.json"
if [ -n "$tr" ]; then
  d="$cfg/projects/$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"
  mkdir -p "$d" && cp -p "$tr" "$d/$id.jsonl"
fi
printf '%s\n' "$pid"
