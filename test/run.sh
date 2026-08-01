#!/usr/bin/env bash
# test/run.sh — the regression suite. No dependencies, no network, no live fleet.
#
#     ./test/run.sh            everything
#     ./test/run.sh agent      only groups whose name matches "agent"
#
# WHAT BELONGS HERE. Every case below is a bug that actually shipped, and every one
# of them was SILENT — the code kept running and produced a plausible wrong answer:
#
#   - a trust stanza written under the logical path, which codex (reading the
#     physical one) never matched: looked exactly like success
#   - a ready pattern that matched only outside $HOME, so it matched nowhere real
#   - two separate "the last variable absorbs the rest" field bugs
#   - a busy regex that can't fire, which is indistinguishable from an idle worker
#
# That last one is why the pane assertions run in BOTH directions. A detector is only
# proven by matching a real busy capture AND not matching a real idle one; testing
# only the happy direction would pass for a regex that matches everything, and pass
# for one that matches nothing. Fixtures are verbatim captures from real panes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="$ROOT/test/fixtures"
FILTER="${1:-}"
PASS=0; FAIL=0; SKIP=0; GROUP=""
R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'

group() { GROUP="$1"; case "$GROUP" in *"$FILTER"*) printf '\n%s%s%s\n' "$D" "$GROUP" "$N" ;; esac; }
skip()  { case "$GROUP" in *"$FILTER"*) SKIP=$((SKIP+1)); printf '  %s○%s %s %s(%s)%s\n' "$Y" "$N" "$1" "$D" "$2" "$N" ;; esac; }
ok()    { PASS=$((PASS+1)); printf '  %s✔%s %s\n' "$G" "$N" "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  %s✘%s %s\n     %sexpected:%s %s\n     %sgot:     %s %s\n' \
            "$R" "$N" "$1" "$D" "$N" "$2" "$D" "$N" "$3"; }
is()    { case "$GROUP" in *"$FILTER"*) ;; *) return 0 ;; esac
          if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
# grep -c, but never let a non-match kill the run under pipefail
matches() { grep -cE -- "$1" "$2" 2>/dev/null || true; }

# ── 1. the grid → control-plane wire format ──────────────────────────────────
# Fields after the cwd are optional: a grid still holding older code sends fewer.
# The trap is that `${x#*$US}` on a string WITHOUT the separator returns it
# UNCHANGED, so a two-field choice set name to the whole cwd — non-empty, so it
# sailed past every `[ -n "$name" ]` fallback and produced a session called
# "/Users/...". Test for the separator, not for emptiness.
group "wire format (split_choice)"
US=$'\x1f'
eval "$(sed -n '/^split_choice() {/,/^}/p' "$ROOT/bin/ghostfleet")"
sc() { PROJECT_AGENT="${4:-}"; cwd=""; name=""; agent=""; split_choice "$1"; printf '%s|%s|%s' "$cwd" "$name" "$agent"; }
is "3 fields: cwd, name, agent"        "/c/foo|w|opencode" "$(sc "/c/foo${US}w${US}opencode")"
is "2 fields: agent empty"             "/c/foo|w|"         "$(sc "/c/foo${US}w")"
is "1 field: name falls back to base"  "/c/foo|foo|"       "$(sc "/c/foo")"
is "junk agent is dropped"             "/c/foo|w|"         "$(sc "/c/foo${US}w${US}rm -rf /")"
is "path-ish agent is dropped"         "/c/foo|w|"         "$(sc "/c/foo${US}w${US}../../etc")"
is "no agent inherits the project's"   "/c/foo|w|codex"    "$(sc "/c/foo${US}w" "" "" codex)"
is "explicit claude beats project's"   "/c/foo|w|claude"   "$(sc "/c/foo${US}w${US}claude" "" "" codex)"

# ── 2. pane detectors, both directions ───────────────────────────────────────
# A regex that never fires looks exactly like a worker that is never busy.
group "pane detectors (busy_re)"
for a in claude opencode codex; do
  re="$("$ROOT/bin/fleet-agent" field "$a" busy_re 2>/dev/null)"
  if [ -z "$re" ]; then skip "$a busy_re" "no detector declared"; continue; fi
  is "$a: matches a real BUSY pane"  "1" "$(matches "$re" "$FIX/$a-busy.txt")"
  idle="$FIX/$a-idle.txt"; [ -f "$idle" ] || idle="$FIX/$a-idle-home.txt"
  is "$a: silent on a real IDLE pane" "0" "$(matches "$re" "$idle")"
done

group "ready detectors (ready_re)"
cre="$("$ROOT/bin/fleet-agent" field codex ready_re)"
# "· /" passed its original test only because that worktree sat in /private/tmp.
# Codex abbreviates $HOME, so every REAL worktree prints "· ~/..." and never matched.
is "codex: ready under \$HOME"        "1" "$(matches "$cre" "$FIX/codex-idle-home.txt")"
is "codex: ready outside \$HOME"      "1" "$(matches "$cre" "$FIX/codex-idle-abs.txt")"
# A false ready here fires the initial prompt into the dialog, where it is swallowed.
is "codex: NOT ready on trust dialog" "0" "$(matches "$cre" "$FIX/codex-trust.txt")"
bre="$("$ROOT/bin/fleet-agent" field codex blocked_re)"
is "codex: blocked on trust dialog"   "1" "$(matches "$bre" "$FIX/codex-trust.txt")"
is "codex: not blocked when idle"     "0" "$(matches "$bre" "$FIX/codex-idle-home.txt")"

# ── 3. the projects file ─────────────────────────────────────────────────────
group "projects file columns"
T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet"
printf 'four\t~/a\twork\topencode\nthree\t~/b\tpersonal\ntwo\t~/c\n' > "$T/.config/ghostfleet/projects"
out="$(HOME="$T" "$ROOT/bin/fleet-project" list 2>/dev/null)"
# read with fewer variables than fields glues the remainder onto the last one, so
# the agent ended up inside the profile — and the socket, derived from the profile,
# was wrong with it.
is "4-col: profile not polluted by agent" "work"     "$(awk '$1=="four"{print $2}'  <<<"$out")"
is "4-col: agent column read"             "opencode" "$(awk '$1=="four"{print $3}'  <<<"$out")"
is "4-col: socket unaffected"             "cf-four"  "$(awk '$1=="four"{print $4}'  <<<"$out")"
is "3-col: still works"                   "personal" "$(awk '$1=="three"{print $2}' <<<"$out")"
is "3-col: agent defaults to claude"      "claude"   "$(awk '$1=="three"{print $3}' <<<"$out")"
is "2-col: profile defaults to work"      "work"     "$(awk '$1=="two"{print $2}'   <<<"$out")"
# The backup guard used to skip the PRIMARY list: `${f##*/projects.}` strips nothing
# from "projects", leaving a full path whose own / and . fail the charset test.
: > "$T/.config/ghostfleet/projects.bak.1785"
out2="$(HOME="$T" "$ROOT/bin/fleet-project" list 2>/dev/null)"
is "primary list is not skipped"          "1" "$(grep -c '^four ' <<<"$out2" || true)"
is "a .bak file is not read as a profile" "0" "$(grep -c '1785'   <<<"$out2" || true)"
rm -rf "$T"

# ── 4. session naming ────────────────────────────────────────────────────────
group "session naming"
namer() {                      # $1=typed $2=live list $3=separator
  local name="$1" live=" $2 " base="$1" i=2
  while [[ "$live" == *" $name "* ]]; do name="$base$3$i"; i=$((i+1)); done
  printf '%s' "$name"
}
is "new: free name kept"          "foo"    "$(namer foo ""            -)"
is "new: collision -> -2"         "foo-2"  "$(namer foo "foo"         -)"
is "new: -2 taken -> -3"          "foo-3"  "$(namer foo "foo foo-2"   -)"
# Incrementing before use skipped ~2 entirely: the ordinary case produced ~3 first.
is "parallel: first is ~2, not ~3" "foo~2" "$(namer foo "foo"         '~')"
is "parallel: then ~3"             "foo~3" "$(namer foo "foo foo~2"   '~')"

# ── 5. sleep inhibitor guards ────────────────────────────────────────────────
group "fleet-awake guards"
"$ROOT/bin/fleet-awake" 999999 >/dev/null 2>&1; is "dead pid: exits 0, no inhibitor" "0" "$?"
"$ROOT/bin/fleet-awake" abc    >/dev/null 2>&1; is "junk arg: exits 0"               "0" "$?"

# ── 6. the adapter table ─────────────────────────────────────────────────────
group "agent adapter"
is "claude is the default agent" "claude" "$("$ROOT/bin/fleet-agent" of __no_such_session__ 2>/dev/null)"
is "unknown agent has no launcher" "" "$("$ROOT/bin/fleet-agent" field nope launcher 2>/dev/null)"
for a in $("$ROOT/bin/fleet-agent" list); do
  l="$("$ROOT/bin/fleet-agent" field "$a" launcher)"
  is "$a: launcher $l exists" "1" "$([ -f "$ROOT/bin/$l" ] && echo 1 || echo 0)"
  # grep ERE and JS regex are different dialects, so the two spellings are written
  # separately — and can drift into disagreeing about when a worker is busy.
  e="$("$ROOT/bin/fleet-agent" field "$a" busy_re)"; j="$("$ROOT/bin/fleet-agent" field "$a" busy_re_js)"
  is "$a: both busy spellings present or both empty" \
     "$([ -n "$e" ] && echo y || echo n)" "$([ -n "$j" ] && echo y || echo n)"
done

# ── 7. every command parses ──────────────────────────────────────────────────
group "syntax"
for f in "$ROOT"/bin/*; do
  case "$f" in *.mjs) node --check "$f" >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error" ;;
                   *) bash -n "$f"      >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error" ;;
  esac
done
node --check "$ROOT/mcp/fleet-mcp.mjs" >/dev/null 2>&1 && ok "fleet-mcp.mjs parses" || bad "fleet-mcp.mjs parses" "ok" "syntax error"
node --check "$ROOT/hooks/opencode-fleet-event.js" >/dev/null 2>&1 && ok "opencode plugin parses" || bad "opencode plugin parses" "ok" "syntax error"

printf '\n%s passed  %s%s failed%s  %s skipped\n' "$PASS" "$([ "$FAIL" -gt 0 ] && printf '%s' "$R")" "$FAIL" "$N" "$SKIP"
[ "$FAIL" -eq 0 ]
