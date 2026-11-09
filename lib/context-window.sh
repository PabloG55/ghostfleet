# lib/context-window.sh — the CONTEXT CEILING a fleet session is launched with. Sourced.
#
# WHY A CEILING. Every call re-reads the whole context from the prompt cache, so a call's
# cost grows with its context and a session that is allowed to grow to the model's window
# pays for that growth on every call afterwards. Measured on one busy fleet over 13 days
# (146 sessions, 68k model calls): 83% of the token cost was cache READS, the average call
# carried 420k tokens, 54% of the spend came from calls at 500k+ and 30% from calls at
# 700k+ — and sessions only compacted near ~965k, because on a 1M-token model that is
# where Claude Code's default threshold sits (980k effective window minus a 13k buffer).
#
# THE KNOB, MEASURED RATHER THAN TRUSTED BY NAME. Three env vars in the installed Claude
# Code look like they do this; each was run on a scratch session outside the fleet:
#   CLAUDE_CODE_AUTO_COMPACT_WINDOW     the auto-compact window. Debug log's effectiveWindow
#                                       went 980000 -> 280000 at `300k` (window minus a 20k
#                                       output reserve). A 334k-token session resumed under
#                                       it compacted before its next call (one summary pass:
#                                       334k read, 769 out), and that call then read 14k
#                                       instead of 334k. A 172k session under `300k` did NOT
#                                       compact, and under `200k` it reached the compact
#                                       level — so the 300k threshold sits between the two
#                                       (238k, read off the code). This is the one used.
#   CLAUDE_AUTOCOMPACT_PCT_OVERRIDE     moves the threshold to a percentage of the window but
#                                       leaves the window at 980k, so every "% left" the UI
#                                       shows is still out of 1M; the code calls it a test
#                                       override and a forked agent ignores it. Not used.
#   CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS only the size floor for compacting WHILE IDLE (just
#                                       before the 1h prompt cache would expire). Whether
#                                       idle compaction runs at all is decided per account
#                                       by a server-side flag; the env var cannot turn it on.
#                                       Measured on an account whose flag reads on: two idle
#                                       172k forks, one with the floor lowered to 100k, sat
#                                       58 minutes past their last request (past the 54-minute
#                                       point it is meant to fire at) and neither compacted.
#                                       So masters get no idle-only treatment: an unreliable
#                                       mechanism is no substitute for the ceiling.
#
# TWO SHARP EDGES in how the CLI reads the value, both measured:
#   - a bare `300` is 300 TOKENS, raised to the 100k minimum with a warning — so this file
#     always hands the CLI a full integer, never what was typed.
#   - below 200k the CLI does not compact ahead of time at all (it waits for the API to
#     refuse the request), so a smaller ceiling is raised to 200k rather than passed on.
#
# WHERE IT COMES FROM, most specific first:
#   <fleet-dir>/<sock>.context-window               this project   (fleet-project set … context-window)
#   ${CLAUDE_FLEET_EXPERIMENTAL_DIR:-~/.config/ghostfleet}/context-window   every project
#   CONTEXT_WINDOW_DEFAULT                          built in
# Each holds one value: a size (`300k`, `0.5m`, `400000`) or `off`, which launches the
# session exactly as before — no variable set, the model's own window.

CONTEXT_WINDOW_DEFAULT=300000
CONTEXT_WINDOW_MIN=200000
CONTEXT_WINDOW_MAX=1000000

# context_window_parse <value> -> prints tokens, or `off`; exit 1 when it is not a size.
# Sizes outside [MIN, MAX] are clamped, not refused: the person asked for a ceiling, and the
# nearest one the CLI will actually enforce is closer to that than none at all.
context_window_parse() {
  local v; v="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$v" in
    off|none|0) printf 'off'; return 0 ;;
    '') return 1 ;;
  esac
  local n
  n="$(awk -v v="$v" 'BEGIN{
        m = 1; s = v
        if (s ~ /k$/) { m = 1000; s = substr(s, 1, length(s) - 1) }
        else if (s ~ /m$/) { m = 1000000; s = substr(s, 1, length(s) - 1) }
        if (s !~ /^[0-9]+(\.[0-9]+)?$/ && s !~ /^\.[0-9]+$/) exit 1
        t = s * m
        if (m == 1 && t < 1000) exit 1          # a bare 300 is a typo for 300k, not 300 tokens
        printf "%d", t + 0.5 }')" || return 1
  [ -n "$n" ] || return 1
  [ "$n" -lt "$CONTEXT_WINDOW_MIN" ] && n="$CONTEXT_WINDOW_MIN"
  [ "$n" -gt "$CONTEXT_WINDOW_MAX" ] && n="$CONTEXT_WINDOW_MAX"
  printf '%s' "$n"
}

# context_window_resolve <fleet-dir> <sock> -> prints "<tokens|off>\t<source>"
# <source> is project | all-projects | default. A file that does not parse is skipped with a
# warning on stderr and the next one down is used: a typo must not silently mean `off`.
context_window_resolve() {
  local dir="${1:-}" sock="${2:-}" f src v raw
  for src in project all-projects; do
    case "$src" in
      project)      [ -n "$dir" ] && [ -n "$sock" ] || continue; f="$dir/$sock.context-window" ;;
      all-projects) f="${CLAUDE_FLEET_EXPERIMENTAL_DIR:-$HOME/.config/ghostfleet}/context-window" ;;
    esac
    [ -f "$f" ] || continue
    raw="$(head -n 1 "$f" 2>/dev/null)"
    if v="$(context_window_parse "$raw")"; then printf '%s\t%s\n' "$v" "$src"; return 0; fi
    printf 'ghostfleet: ignoring %s — "%s" is not a size (use 300k, 400000 or off)\n' "$f" "$raw" >&2
  done
  printf '%s\t%s\n' "$CONTEXT_WINDOW_DEFAULT" default
}

# A person reads `300k`, not 300000.
context_window_label() {
  case "$1" in
    off) printf 'off' ;;
    *)   awk -v n="$1" 'BEGIN{ if (n % 1000000 == 0) printf "%dm", n/1000000; else if (n % 1000 == 0) printf "%dk", n/1000; else printf "%d", n }' ;;
  esac
}
