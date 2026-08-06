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

# The SAME detector, against a pane that is only 56 columns wide — the width the stack
# screen makes ordinary, because a nested client resizes its target. Claude COMPOSES
# its spinner to fit and drops the elapsed-time counter first, so at 56 columns the
# live line is "✻ Flowing… (almost done thinking with xhigh effort)": no "(NNs", no
# "↓ N tokens", no "esc to interrupt". Every alternative the old regex had was
# width-dependent, and `fleet-agent busy` read IDLE for 120 consecutive samples over a
# full minute of real thinking. Both fixtures are verbatim 56-column captures (only the
# account/email sanitised); the idle one is here because the narrow pane is FULL of
# truncation ellipses ("| w1 |   HEA…"), which is exactly what a looser fix would trip
# over.
group "pane detectors at stack width"
cre="$("$ROOT/bin/fleet-agent" field claude busy_re)"
is "claude: matches a 56-col BUSY pane with no timer" "1" "$(matches "$cre" "$FIX/claude-busy-narrow.txt")"
is "claude: silent on a 56-col IDLE pane"             "0" "$(matches "$cre" "$FIX/claude-idle-narrow.txt")"
is "claude: silent on a 130-col IDLE pane"            "0" "$(matches "$cre" "$FIX/claude-idle-wide.txt")"
# grep ERE and JS are different dialects and the two spellings are maintained
# separately, so run the JS one over the same fixtures rather than trusting they agree.
jsre="$("$ROOT/bin/fleet-agent" field claude busy_re_js)"
# String(), not a bare number. console.log() runs a NON-string argument through
# util.inspect, which colourises when colour is on — and every fleet session has
# FORCE_COLOR=3 in its environment, so this returned "\033[33m1\033[39m" and the
# comparison failed. It passed wherever colour happened to be off: the same
# "a test can pass because of where it ran" trap CLAUDE.md already warns about.
jsm() { node -e '
  const fs=require("fs"), re=new RegExp(process.argv[1],"i");
  console.log(String(fs.readFileSync(process.argv[2],"utf8").split("\n").filter(l=>re.test(l)).length ? 1 : 0));
' "$1" "$2"; }
is "claude(js): matches the 56-col BUSY pane" "1" "$(jsm "$jsre" "$FIX/claude-busy-narrow.txt")"
is "claude(js): silent on the 56-col IDLE pane" "0" "$(jsm "$jsre" "$FIX/claude-idle-narrow.txt")"

# The governor scrapes the 5h usage % out of the same pane, and Claude TRUNCATES its
# status line rather than wrapping it — so below ~100 columns the figure is simply not
# there. This is a LIMITATION, asserted so it stays a known one: if a stacked session
# is the only client, the governor gets no reading from it, and `budget()` falls back
# to whatever a wider pane reports. Asserted in both directions so a "fix" that
# loosened the pattern into matching ctx:NN% or the 7d figure would go red.
group "governor usage scrape vs pane width"
# The governor's OWN pct_of, lifted out of bin/fleet-governor (the same trick this file
# uses for split_choice) with `tmux` stubbed out to cat a fixture instead of capturing a
# pane. So this exercises the shipped pattern: change it and these go red.
eval "$(sed -n '/^pct_of() {/,/^}/p' "$ROOT/bin/fleet-governor")"
PANE=""
SOCK=stub                 # pct_of interpolates it; under `set -u` an unset one aborts
                          # the function, and an aborted pct_of returns "" — which is
                          # what two of these tests EXPECT. Don't let them pass on that.
tmux() { cat "$PANE"; }
PANE="$FIX/claude-idle-wide.txt"
is "reads the 5h figure at 130 columns"     "18" "$(pct_of x)"
# The figure is TRUNCATED away, not wrapped, so there is nothing on the pane to find.
PANE="$FIX/claude-busy-narrow.txt"
is "no figure to read at 56 columns"        ""   "$(pct_of x)"
PANE="$FIX/claude-idle-narrow.txt"
is "no figure to read at 56 columns (idle)" ""   "$(pct_of x)"
# The wide fixture also carries ctx:5% and 7d:33%(115h 24m). Reading either as the 5h
# figure would drive the whole fleet's park decision off the wrong number, so the answer
# above being exactly 18 is half the test — this is the other half.
is "not ctx:NN%, not the 7d figure"         "18" "$(PANE="$FIX/claude-idle-wide.txt"; pct_of x)"
unset -f tmux; PANE=""
# ...and the whole tick, through a real pane, because budget() now sets globals instead
# of echoing: called in a command substitution it would be a SUBSHELL and every
# assignment would vanish, leaving the governor permanently at 0%. That is the trap
# release_gov_parked already carries a comment about, one function further down.
if command -v tmux >/dev/null 2>&1; then
  gov() {                        # $1 = fixture to show, $2 = pane width -> the log line
    local T; T="$(mktemp -d)"
    tmux -L cfgovtest kill-server 2>/dev/null
    tmux -L cfgovtest new-session -d -s master -x "$2" -y 30 "cat '$1'; sleep 30" 2>/dev/null
    sleep 1
    CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-governor" -s cfgovtest --once --dry-run 2>&1 | tail -1
    tmux -L cfgovtest kill-server 2>/dev/null; rm -rf "$T"
  }
  is "a tick reads 18% off a 130-col pane" "1" \
     "$(gov "$FIX/claude-idle-wide.txt" 130 | grep -c 'budget 18%' || true)"
  # A blind tick must SAY it is blind — otherwise it is indistinguishable from an
  # account sitting at 0%, and the ceiling silently stops being enforced.
  is "a blind tick names the narrow pane" "1" \
     "$(gov "$FIX/claude-busy-narrow.txt" 56 | grep -c 'too narrow.*master(56c)' || true)"
else
  skip "governor tick" "tmux not available"
fi

# An agent that WRITES ABOUT a spinner puts byte-identical text on screen while idle
# — a report, a doc, a pasted capture. Nothing in the text separates them, so the
# pattern is anchored to the line start: a live spinner OWNS its line, prose about
# one always has something in front. A worker sat on the grid as "working" for 17
# minutes after finishing, purely from its own report text, before this.
group "busy: prose about a spinner is not a spinner"
q="$FIX/claude-idle-quoting-spinner.txt"
re="$("$ROOT/bin/fleet-agent" field claude busy_re)"
jre="$("$ROOT/bin/fleet-agent" field claude busy_re_js)"
is "idle pane quoting spinners: silent"      "0" "$(matches "$re" "$q")"
is "...and silent for the JS spelling too"   "0" "$(jsm "$jre" "$q")"
# The same file must still contain text an UNANCHORED pattern would have matched,
# or this test would pass against a regex that simply stopped working.
is "the fixture really is a trap"            "1" "$([ "$(grep -cE '[A-Za-z](…|\.\.\.) ?\(' "$q" || true)" -gt 0 ] && echo 1 || echo 0)"
# Dropping the ↓-tokens / esc-to-interrupt alternatives must not un-detect anything.
is "wide busy still fires without them"      "1" "$(matches "$re" "$FIX/claude-busy.txt")"
is "narrow busy still fires without them"    "1" "$(matches "$re" "$FIX/claude-busy-narrow.txt")"

# While a SUBAGENT runs, Claude replaces its one-word spinner with the agent's own
# description — "+ Adding the operator-key auth provider… (10m 15s · ↓ 32.8k tokens)".
# That's a PHRASE, which the one-word pattern could not see, so a session with a
# ten-minute agent under it sat on the grid as "✓ ready" — not merely wrong, but the
# one status that means "finished, come look".
#
# PROVENANCE, because it matters here: these lines are TRANSCRIBED from a reported
# pane (a screenshot of a live session), not taken with capture-pane. The line is
# drawn in place and never reaches the scrollback, and a 5-minute poll of every live
# pane across six fleets didn't catch one. So rather than pin one exact transcription
# — which could be wrong in a way that passes here and still misses in the wild —
# these vary everything a transcription could get wrong (the leading glyph, the
# spacing, hyphens and digits in the description) and assert only the structure the
# fix actually rests on: line start · phrase · ellipsis · elapsed clock.
group "a running subagent reads as working, not ready"
sre="$("$ROOT/bin/fleet-agent" field claude busy_re)"
sjs="$("$ROOT/bin/fleet-agent" field claude busy_re_js)"
ST="$(mktemp -d)"
line() {   # $1=label $2=the pane line $3=1 fires / 0 silent
  printf '%s\n' "$2" > "$ST/l"
  is "$1 (ere)" "$3" "$(matches "$sre" "$ST/l")"
  is "$1 (js)"  "$3" "$(jsm  "$sjs" "$ST/l")"
}
line "the reported subagent line"   "+ Adding the operator-key auth provider… (10m 15s · ↓ 32.8k tokens)" 1
line "another glyph, short clock"   "✢ Running the full regression suite… (2m 4s · ↓ 1.2k tokens)"        1
line "no glyph, indented"           "  Checking the migration plan… (42s)"                                1
line "digits and a slash in it"     "· Updating apps/api v2 routes… (11m 40s · ↓ 42.2k tokens)"           1
# The phrase branch buys its spaces by REQUIRING the clock. Without that, ordinary
# prose with an ellipsis is indistinguishable from a spinner — the exact false
# positive that anchoring was introduced to close, which cost 17 minutes of a worker
# showing "working" after it had finished.
line "a phrase with no clock"       "- Adding the operator-key auth provider… (the one that hung)"        0
line "prose with a line number"     "56  ✳ Adding the thing… (10m 15s)"                                   0
line "the idle agent-count hint"    "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent"           0
# and the one-word branch must keep its LOOSE paren: a narrow pane drops the clock
# first, and that pane still has to read as busy.
line "one word, clock dropped"      "✽ Flowing… (almost done thinking with xhigh effort)"                 1
rm -rf "$ST"

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

group "fleet-project add --agent"
T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet" "$T/p1" "$T/p2" "$T/p3"
PATH="$ROOT/bin:$PATH" HOME="$T" "$ROOT/bin/fleet-project" add "$T/p1" --name a4 --agent opencode >/dev/null 2>&1
PATH="$ROOT/bin:$PATH" HOME="$T" "$ROOT/bin/fleet-project" add "$T/p2" --name a3 >/dev/null 2>&1
PATH="$ROOT/bin:$PATH" HOME="$T" "$ROOT/bin/fleet-project" add "$T/p3" --name bad --agent notreal >/dev/null 2>&1
cf="$T/.config/ghostfleet/projects"
is "--agent writes 4 columns"      "4" "$(awk -F'\t' '$1=="a4"{print NF}' "$cf")"
is "no --agent stays 3 columns"    "3" "$(awk -F'\t' '$1=="a3"{print NF}' "$cf")"
# A default that never applies is worse than an error: nothing would ever report it.
is "unknown agent is not written"  "0" "$(grep -c 'notreal' "$cf" || true)"
is "unknown agent aborts the add"  "0" "$(awk -F'\t' '$1=="bad"' "$cf" | wc -l | tr -d ' ')"
rm -rf "$T"

group "projects screen reads the agent column"
T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet" "$T/a" "$T/b"
printf 'oc\t%s/a\twork\topencode\npl\t%s/b\twork\n' "$T" "$T" > "$T/.config/ghostfleet/projects"
scr="$(HOME="$T" CLAUDE_FLEET_PROJECTS="$T/.config/ghostfleet/projects" node "$ROOT/bin/fleet-grid.mjs" - --screen projects --plain 2>/dev/null; true)"
# --plain doesn't draw cards, so assert on the parser the screen uses instead
got="$(HOME="$T" node -e '
  const fs=require("fs");
  const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(x=>x.trim()&&!x.startsWith("#"));
  console.log(l.map(x=>{const c=x.split("\t");return (c[0]+":"+(c[3]||"claude"))}).join(" "));
' "$T/.config/ghostfleet/projects")"
is "4th column parsed per project" "oc:opencode pl:claude" "$got"
rm -rf "$T"

group "projects banner"
# The sprite costs six rows. On a short or narrow window the cards matter more than
# the logo, so it must collapse to the one-line header instead of pushing projects
# off the bottom. Driven through a real pane, because this is a rendering decision.
T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet" "$T/a"
printf 'demo\t%s/a\twork\n' "$T" > "$T/.config/ghostfleet/projects"
bnr() {   # cols rows -> 1 if the ship rendered
  tmux -L cfbtest kill-server 2>/dev/null
  tmux -L cfbtest new-session -d -x "$1" -y "$2" -e HOME="$T" \
    -e CLAUDE_FLEET_PROJECTS="$T/.config/ghostfleet/projects" \
    "node '$ROOT/bin/fleet-grid.mjs' - --screen projects; sleep 8" 2>/dev/null
  sleep 2
  local n; n="$(tmux -L cfbtest capture-pane -p 2>/dev/null | grep -c '█' || true)"
  tmux -L cfbtest kill-server 2>/dev/null
  [ "${n:-0}" -gt 0 ] && echo 1 || echo 0
}
if command -v tmux >/dev/null 2>&1; then
  is "roomy window draws the ship"      "1" "$(bnr 100 30)"
  is "short window falls back to 1 line" "0" "$(bnr 100 20)"
  is "narrow window falls back to 1 line" "0" "$(bnr 50 30)"
else
  skip "banner rendering" "tmux not available"
fi
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

# ── 4a2. the card order ──────────────────────────────────────────────────────
# ⇧hjkl reorders the cards, and that order IS the fleet's numbering — the digit on a
# card, `1`-`9`, `Ctrl-f <p> <s>` and ⇧←→ all count the same list. THREE separate
# implementations read it: fleet-grid.mjs (the screen, and `--order`, which is what
# bin/ghostfleet counts through), and the awk ring in fleet-cycle (which can't reach
# the order FILE from inside run-shell, so it reads the @cf_order option instead).
# Two orderings that disagree don't fail — they quietly open a different session than
# the card you were reading, which is indistinguishable from a mis-press.
#
# Both directions matter here too: an implementation that ignored the saved order
# entirely would still pass every "unset -> tmux order" case on its own.
group "card order (grid vs fleet-cycle)"
ORD_T="$(mktemp -d)"
# Both implementations are lifted out of the shipped files rather than restated here —
# a copy in the test proves the copy, not the code. That makes the EXTRACTION load-
# bearing, so assert it found something: a renamed function otherwise turns every case
# below into a silent empty answer, which is the failure this whole file exists to
# refuse. (It has already happened once: `orderFile()` grew parameters.)
ORD_JS="$(awk '/^function orderFile\(/,/^function writeOrder\(/' "$ROOT/bin/fleet-grid.mjs" | sed '$d')"
ORD_AWK="$(sed -n "/BEGIN { m = split(ord, want/,/^ *}'\$/p" "$ROOT/bin/fleet-cycle" | sed "s/'\$//")"
is "grid's applyOrder was found"  "1" "$(printf '%s' "$ORD_JS"  | grep -c 'function applyOrder')"
is "fleet-cycle's ring was found" "1" "$(printf '%s' "$ORD_AWK" | grep -c 'split(ord, want')"
js_order() {                   # $1=order-file contents  $2=live names (newline sep)
  printf '%s' "$1" > "$ORD_T/cf-t.order"
  printf '%s' "$2" | node --input-type=module -e "
    import fs from 'node:fs'; import path from 'node:path';
    const FLEET_DIR = '$ORD_T', SOCK = 'cf-t';
    $ORD_JS
    const live = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map(name => ({ name }));
    console.log(applyOrder(live).map(r => r.name).join(' '));
  "
}
awk_order() {                  # $1=@cf_order value (colon sep)  $2=live names
  printf '%s\n' "$2" | awk -v ord="$1" "$ORD_AWK" | paste -sd' ' -
}
both() {                       # assert the two agree AND match the expectation
  local label="$1" want="$2" file="$3" live="$4"
  is "$label (grid)"        "$want" "$(js_order  "$file" "$live")"
  is "$label (fleet-cycle)" "$want" "$(awk_order "$(printf '%s' "$file" | paste -sd: -)" "$live")"
}
LIVE="$(printf 'a\nb\nc')"
both "no saved order -> tmux's own"     "a b c"   ""                        "$LIVE"
both "saved order wins"                 "c a b"   "$(printf 'c\na\nb\n')"   "$LIVE"
both "partial order, rest keeps tmux's" "c a b"   "$(printf 'c\n')"         "$LIVE"
# A killed session still named in the file must be SKIPPED, not counted — otherwise
# every card after it shifts up one and the digits point one session too far.
both "dead name in the file is skipped" "c a"     "$(printf 'c\nb\na\n')"   "$(printf 'a\nc')"
# and a session created since the last reorder must still appear, at the end
both "unknown session lands last"       "c a b d" "$(printf 'c\na\n')"      "$(printf 'a\nb\nc\nd')"
both "a duplicate in the file is not"   "c a b"   "$(printf 'c\nc\na\n')"   "$LIVE"
rm -rf "$ORD_T"

# ── 4a3. a rename must not lose the session's slot ───────────────────────────
# Every other per-session marker is migrated by RENAMING its file. The card order is
# the one that can't be: it stores names INSIDE the file, one per line. Renaming with
# only the file moves left the session unlisted, so it sorted to the END of the grid —
# and every card after its old slot shifted up one, which quietly re-points the digits
# and `Ctrl-f <p> <s>` at the next session along. Shipped broken; found by driving it.
group "rename keeps its slot in the card order"
if command -v tmux >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  RN="$(mktemp -d)"; RNF="$RN/fleet"; mkdir -p "$RNF" "$RN/repo"
  tmux -L cfrntest kill-server 2>/dev/null
  git init -q -b main "$RN/repo" 2>/dev/null
  git -C "$RN/repo" config user.email t@t; git -C "$RN/repo" config user.name t
  : > "$RN/repo/f"; git -C "$RN/repo" add -A; git -C "$RN/repo" commit -qm init 2>/dev/null
  for w in wa wb wc; do
    git -C "$RN/repo" worktree add -q "$RN/$w" -b "$w" 2>/dev/null
    tmux -L cfrntest new-session -d -s "$w" -c "$RN/$w" "sleep 120" 2>/dev/null
  done
  ordr() { CLAUDE_FLEET_DIR="$RNF" node "$ROOT/bin/fleet-grid.mjs" cfrntest --order 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
  printf 'wc\nwa\nwb\n' > "$RNF/cfrntest.order"
  is "fixture: wa sits in slot 2"        "wc wa wb" "$(ordr)"
  CLAUDE_FLEET_DIR="$RNF" "$ROOT/bin/fleet-rename" -s cfrntest wa wz >/dev/null 2>&1
  is "renamed session KEEPS slot 2"      "wc wz wb" "$(ordr)"
  is "the file itself was rewritten"     "wc wz wb" "$(tr '\n' ' ' < "$RNF/cfrntest.order" | sed 's/ $//')"
  # ⇧←→ reads the server's mirror, not the file, so that has to move too or the
  # renamed session drops to the end of the RING while the grid shows it in place.
  is "@cf_order mirror moved with it"    "wc:wz:wb" "$(tmux -L cfrntest show-options -gqv @cf_order 2>/dev/null)"
  # An order file that never mentioned this session must come out untouched, not
  # rewritten into something that happens to look plausible.
  printf 'wb\nwc\n' > "$RNF/cfrntest.order"
  CLAUDE_FLEET_DIR="$RNF" "$ROOT/bin/fleet-rename" -s cfrntest wz wq >/dev/null 2>&1
  is "an unlisted session leaves it be"  "wb wc" "$(tr '\n' ' ' < "$RNF/cfrntest.order" | sed 's/ $//')"
  tmux -L cfrntest kill-server 2>/dev/null
  rm -rf "$RN"
else
  skip "rename keeps its slot" "tmux/git missing"
fi

# ── 4a4. never hand --order to a grid that predates it ───────────────────────
# It doesn't error: an unknown flag is no flag, so the old grid falls through to
# DRAWING THE TUI inside the control plane's command substitution — nothing reads it,
# nothing exits, and the fleet freezes behind a screen you can't act on, with no
# message anywhere. Measured; stdin on /dev/null doesn't help, its own refresh timer
# keeps it alive. So grid_sessions asks the file whether it knows the flag first.
#
# The stub is a grid that PRINTS instead of hanging, so a removed guard fails this
# suite loudly rather than wedging it.
group "--order is only offered to a grid that has it"
if command -v tmux >/dev/null 2>&1; then
  GT="$(mktemp -d)"
  echo 'console.log("STUB RAN")' > "$GT/old-grid.mjs"
  tmux -L cfordguard kill-server 2>/dev/null
  for s in ga gb; do tmux -L cfordguard new-session -d -s "$s" "sleep 120" 2>/dev/null; done
  tmux -L cfordguard new-session -d -s master "sleep 120" 2>/dev/null
  eval "$(sed -n '/^grid_sessions() {/,/^}/p' "$ROOT/bin/ghostfleet")"
  SOCK=cfordguard; CONF=""
  GRID="$GT/old-grid.mjs"
  is "old grid: not run, tmux order used" "ga gb" "$(grid_sessions | tr '\n' ' ' | sed 's/ $//')"
  GRID="$ROOT/bin/fleet-grid.mjs"
  printf 'gb\nga\n' > "$GT/cfordguard.order"
  is "current grid: it IS asked"          "gb ga" "$(CLAUDE_FLEET_DIR="$GT" grid_sessions | tr '\n' ' ' | sed 's/ $//')"
  tmux -L cfordguard kill-server 2>/dev/null
  rm -rf "$GT"
else
  skip "--order guard" "tmux missing"
fi

# ── 4a5. a click has to land on the card you clicked ─────────────────────────
# The hit-test hardcoded "cards start at row 3", which stopped being true the day the
# ship banner went up — it was added AFTER clickable cards and nothing told cardAt. On
# any window big enough to fly the ship (8 rows instead of 1) every click resolved a
# whole card-row too low: onto nothing at all on a small grid, so the click looked
# simply dead, and onto the WRONG session on a fuller one.
#
# So this is measured at BOTH layouts. A test at one size proves nothing here — that is
# exactly how it broke, and a hit-test pinned only to the short layout would look
# perfectly correct while every real (big) window stayed broken.
group "grid clicks land on the card you clicked"
if command -v tmux >/dev/null 2>&1; then
  CK="$(mktemp -d)"
  tmux -L cfclktest kill-server 2>/dev/null; tmux -L cfclkdrv kill-server 2>/dev/null
  for s in master ca cb; do tmux -L cfclktest new-session -d -s "$s" "sleep 120" 2>/dev/null; done
  # $1=width $2=height $3=col $4=row -> the choice the grid printed, if any.
  # stderr is deliberately NOT redirected: the grid reads the terminal size off it, so
  # sending it to a file makes every window look like 80x24 and the ship never flies —
  # which silently turns the wide case into a second copy of the short one.
  clickcard() {
    tmux -L cfclkdrv kill-session -t d 2>/dev/null; : > "$CK/choice"
    tmux -L cfclkdrv -f /dev/null new-session -d -s d -x "$1" -y "$2" \
      "CLAUDE_FLEET_DIR='$CK' CLAUDE_FLEET_SCOPE=clktest CLAUDE_FLEET_ROOT= node '$ROOT/bin/fleet-grid.mjs' cfclktest > '$CK/choice'" 2>/dev/null
    sleep 2
    tmux -L cfclkdrv send-keys -t d -l "$(printf '\033[<0;%s;%sM' "$3" "$4")" 2>/dev/null; sleep 0.3
    tmux -L cfclkdrv send-keys -t d -l "$(printf '\033[<0;%s;%sm' "$3" "$4")" 2>/dev/null; sleep 0.7
    cat "$CK/choice"
  }
  US=$'\x1f'
  # 140x40: the ship fits, so cards start at row 10
  is "wide: card 1 opens card 1"   "attach${US}ca" "$(clickcard 140 40 10 11)"
  is "wide: card 2 opens card 2"   "attach${US}cb" "$(clickcard 140 40 43 11)"
  is "wide: the banner is not a card" ""           "$(clickcard 140 40 10 4)"
  is "wide: the gap is not a card"    ""           "$(clickcard 140 40 10 15)"
  # 140x24: too short for the ship, so cards start at row 3 — the original layout
  is "short: card 1 opens card 1"  "attach${US}ca" "$(clickcard 140 24 10 4)"
  is "short: header is not a card"    ""           "$(clickcard 140 24 10 1)"
  tmux -L cfclkdrv kill-server 2>/dev/null; tmux -L cfclktest kill-server 2>/dev/null
  rm -rf "$CK"
else
  skip "grid clicks" "tmux missing"
fi

# ── 4b. the stack ────────────────────────────────────────────────────────────
# stack.tsv is "sock<TAB>session". Socket-scoped for the reason every marker in this
# repo is: EVERY project has a session called `master`, so a bare name stacks whichever
# one tmux answers for first.
group "stack membership (stack.tsv)"
T="$(mktemp -d)"; export CLAUDE_FLEET_DIR="$T"
FS() { CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-stack" "$@"; }
FS add cf-a master; FS add cf-b master; FS add cf-a worker
is "3 members recorded"                 "3"          "$(FS all | wc -l | tr -d ' ')"
# The whole reason for the socket column: these are two DIFFERENT sessions.
is "same name on two sockets is 2 rows" "2"          "$(FS all | grep -c 'master$' || true)"
is "removing one leaves the other"      "cf-b	master" "$(FS remove cf-a master; FS all | grep 'master$')"
is "adding twice is a no-op"            "2"          "$(FS add cf-b master; FS all | wc -l | tr -d ' ')"
is "toggle removes a member"            "removed"    "$(FS toggle cf-b master)"
is "toggle adds it back"                "added"      "$(FS toggle cf-b master)"
is "clear empties the file"             "0"          "$(FS clear; FS all | grep -c . || true)"
# A field that could close a quote would reach the shell command a pane runs.
FS add 'cf-x;touch /tmp/pwned' s >/dev/null 2>&1
is "a shell-metachar member is refused" "0" "$(FS all | grep -c . || true)"
# The two traps CLAUDE.md keeps a list of, applied to this format:
#   - a stray 3rd column: with fewer read variables than fields the leftover lands
#     INSIDE the last one, so "master" silently becomes "master<TAB>JUNK" — verified by
#     removing the guards, which reproduces exactly that row
#   - `IFS=$'\t'` collapses empty fields, so "<TAB>master" would set sock=master and
#     leave the session empty — non-obvious, because sock is then non-empty
# TWO guards in read_all catch the first one (the sink `extra` variable names the column,
# and the charset test rejects the embedded tab if anyone ever drops the sink), so this
# asserts the CONTRACT rather than either guard: removing just one still passes.
printf 'cf-a\tmaster\tJUNK\n\tmaster\ncf-b\tworker\n' > "$T/stack.tsv"
is "3-column row is dropped, not glued" "cf-b	worker" "$(FS all)"
is "...and exactly one row survives"    "1"           "$(FS all | wc -l | tr -d ' ')"
# An empty stack must refuse rather than build a window with nothing in it.
FS clear; FS open --dry-run >/dev/null 2>&1
is "open on an empty stack exits 2"     "2"           "$?"
rm -rf "$T"; unset CLAUDE_FLEET_DIR

# The stack is a THIRD multiplexer level (zellij -> stack tmux -> fleet tmux -> agent)
# and the OUTER tmux answers a key first. cf.tmux.conf binds `, ^S, ^P, ⇧←/→ and ^F
# with -n; every one the stack also binds is one the fleet never sees again. It takes
# exactly three — ` to leave, ⇧←/→ to move focus between panes — and ⇧←→ is affordable
# ONLY because the fleet binds the same session cycle to C-a ←/→ in its prefix table,
# which still passes through. Proven by asking a REAL server what it owns.
group "stack config steals only what it must"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cfstktest kill-server 2>/dev/null
  tmux -L cfstktest -f "$ROOT/tmux/cf-stack.tmux.conf" new-session -d -s t "sleep 30" 2>/dev/null
  # tmux's own root table always carries ~24 Mouse*/Wheel*/*Click* bindings. Those are
  # built-ins nothing here manages (and with `mouse on` they are what makes a click
  # focus a pane — asserted separately below); the KEYBOARD entries are what decide
  # whether a keystroke stops at the stack or reaches the fleet inside it.
  root="$(tmux -L cfstktest list-keys -T root 2>/dev/null | grep -vE 'Mouse|Wheel|Click')"
  is "root table binds exactly 3 keys" "3" "$(printf '%s\n' "$root" | grep -c . || true)"
  is "backtick leaves the stack"       "1" "$(printf '%s\n' "$root" | grep -c -- '-T root ` *detach-client' || true)"
  # These three still have to reach the fleet: they write a .goto marker and detach.
  for k in C-s C-p C-f; do
    is "no-prefix $k passes through"   "0" "$(printf '%s\n' "$root" | grep -cE "root +$k " || true)"
  done
  # ⇧←→ must select a PANE (:.+/:.- wrap; -L/-R dead-end on the edge pane) and must not
  # be anything that detaches — a stack you leave by moving right is not navigation.
  is "S-Right selects the next pane"   "1" "$(printf '%s\n' "$root" | grep -cE "root +S-Right +select-pane -t '?:\.\+" || true)"
  is "S-Left selects the previous one" "1" "$(printf '%s\n' "$root" | grep -cE "root +S-Left +select-pane -t '?:\.-" || true)"
  # C-a must stay the FLEET's prefix, or C-a g/d/s/p and the C-a C-a escape all die.
  is "prefix is None (C-a reaches the fleet)" "None" "$(tmux -L cfstktest show-options -gv prefix 2>/dev/null)"
  # `on` so a CLICK focuses the pane you clicked. It was `off` on the theory that an
  # outer tmux claiming the mouse would swallow events before the fleet; measured, it
  # forwards them (default MouseDown1Pane is `select-pane -t = ; send-keys -M`), and
  # `off` never stopped delivery in the first place — it only suppressed the focusing.
  is "mouse is on (click focuses)"     "on"   "$(tmux -L cfstktest show-options -gv mouse 2>/dev/null)"
  tmux -L cfstktest kill-server 2>/dev/null
else
  skip "stack config" "tmux not available"
fi

# A binding in the file is not focus that MOVES. With `prefix None` (tmux ships pane
# navigation only in the prefix table) and `mouse off` (which made the click bindings
# inert) there was NO way to reach pane 2..N — the stack was watch-only for every pane but
# the first — and "the config says select-pane" would pass just as happily for a key the
# client never resolves. So attach a REAL client and drive it: keys in both directions, the
# wrap at both ends, the negative (a key the fleet owns must leave focus alone), and a click.
group "stack pane focus (real client, keys sent)"
if command -v tmux >/dev/null 2>&1; then
  SCONF="$ROOT/tmux/cf-stack.tmux.conf"
  tmux -L cfstkpane kill-server 2>/dev/null; tmux -L cfstkout kill-server 2>/dev/null
  tmux -L cfstkpane -f "$SCONF" new-session -d -s stack -x 200 -y 50 "sleep 60" 2>/dev/null
  tmux -L cfstkpane split-window -h -t stack "sleep 60" 2>/dev/null
  tmux -L cfstkpane split-window -h -t stack "sleep 60" 2>/dev/null
  tmux -L cfstkpane select-layout -t stack even-horizontal 2>/dev/null
  tmux -L cfstkpane select-pane -t stack.0 2>/dev/null
  # An ATTACHED client is the only thing that resolves a key table — send-keys straight
  # to the pane would bypass the bindings entirely and prove nothing about them.
  tmux -L cfstkout new-session -d -x 200 -y 50 \
    "tmux -L cfstkpane -f '$SCONF' attach -t stack" 2>/dev/null
  sleep 1.5
  act() { tmux -L cfstkpane list-panes -t stack -F '#{?pane_active,#{pane_index},}' 2>/dev/null | tr -d ' \n'; }
  key() { tmux -L cfstkout send-keys "$1" 2>/dev/null; sleep 0.5; }
  is "focus starts on the first pane"  "0" "$(act)"
  key S-Right; is "⇧→ moves one right"  "1" "$(act)"
  key S-Right; is "...and again"        "2" "$(act)"
  key S-Right; is "...and WRAPS to 0"   "0" "$(act)"
  key S-Left;  is "⇧← wraps back to 2"  "2" "$(act)"
  key S-Left;  is "...and moves left"   "1" "$(act)"
  # C-s belongs to the fleet inside (it writes a .goto marker and detaches). If the stack
  # ever answered it, this would move focus instead of passing through.
  key C-s;     is "C-s leaves focus put" "1" "$(act)"

  # And by CLICK. A mouse event can't be sent with send-keys, so feed the client the raw
  # SGR sequence it would get from the terminal (press then release, 1-based coords).
  # With `mouse off` this moved nothing — the bindings were suppressed — while the click
  # still reached the agent in the pane clicked, which is the state this replaces.
  geom="$(tmux -L cfstkpane list-panes -t stack -F '#{pane_index}:#{pane_left}-#{pane_right}' 2>/dev/null | tr '\n' ' ')"
  is "3 panes across 200 columns"      "0:0-65 1:67-132 2:134-199 " "$geom"
  click() {   # $1=column $2=row
    tmux -L cfstkout send-keys -l "$(printf '\033[<0;%s;%sM' "$1" "$2")" 2>/dev/null; sleep 0.3
    tmux -L cfstkout send-keys -l "$(printf '\033[<0;%s;%sm' "$1" "$2")" 2>/dev/null; sleep 0.4
  }
  click 150 10; is "a click focuses pane 2"  "2" "$(act)"
  click  20 10; is "...and back to pane 0"   "0" "$(act)"
  click 100 10; is "...and the middle one"   "1" "$(act)"
  tmux -L cfstkout kill-server 2>/dev/null; tmux -L cfstkpane kill-server 2>/dev/null
else
  skip "stack pane focus" "tmux not available"
fi

# ── 4c. the reply relay (fleet-send --reply-to → the hook) ────────────────────
# A question sent to another fleet used to be answered into thin air: the inbox block in
# hooks/fleet-event.sh routes a Stop to ITS OWN fleet's master and nobody else, and it
# skips masters entirely — so the usual cross-project target reported to no one. From the
# asking side that is indistinguishable from being ignored, which is what makes it worth
# testing in every direction: a relay that never fires looks exactly like today's bug.
group "reply relay (hook routing)"
if command -v jq >/dev/null 2>&1; then
  T="$(mktemp -d)"; RF="$T/resp/fleet"; AF="$T/ask/fleet"; mkdir -p "$RF" "$AF"
  US=$'\x1f'; TRF="$T/t.jsonl"; asked="$AF/cf-ask.inbox"
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"the write-back is suppressed by the sync"}]}}' > "$TRF"
  mark()  { printf '%s\n' "$1" > "$RF/cf-resp.w1.reply-to"; }
  arm()   { : > "$RF/cf-resp.w1.reply-to.armed"; }
  held()  { [ -f "$RF/cf-resp.w1.reply-to" ] && echo 1 || echo 0; }
  armed() { [ -f "$RF/cf-resp.w1.reply-to.armed" ] && echo 1 || echo 0; }
  rows()  { grep -c . "$1" 2>/dev/null || true; }
  fire()  {                     # $1 = event, $2 = notification message
    printf '{"hook_event_name":"%s","session_id":"sid1","cwd":"%s","transcript_path":"%s","message":"%s"}' \
      "$1" "$T" "$TRF" "${2:-}" \
    | env -u TMUX CLAUDE_FLEET_DIR="$RF" CLAUDE_FLEET_SOCK=cf-resp CLAUDE_FLEET_SLOT=w1 \
          CLAUDE_FLEET_NOTIFIER=off "$ROOT/hooks/fleet-event.sh" >/dev/null 2>&1
  }
  # The delivery itself. The row lands in the ASKER's dir, which is the whole point: under
  # another profile that is a different directory, so the address has to carry it.
  mark "cf-ask${US}master${US}$AF"; arm; fire Stop
  is "the answer reaches the asker"     "resp/w1|answered" "$(awk -F'\t' 'NR==1{print $2"|"$3}' "$asked" 2>/dev/null)"
  is "...carrying the answer's text"    "1" "$(matches 'write-back is suppressed' "$asked")"
  is "...and the address is consumed"   "0" "$(ls "$RF" 2>/dev/null | grep -c 'reply-to' || true)"
  # Both paths must stay independent: no address means no relay, and the responder's own
  # fleet still logs its 'done' exactly as before.
  : > "$asked"; : > "$RF/cf-resp.inbox"; fire Stop
  is "no address, no relay"             "0" "$(rows "$asked")"
  is "...its own fleet still logs done" "1" "$(matches 'done' "$RF/cf-resp.inbox")"
  # ARMING — the ordering guard. fleet-send can paste into a session that is MID-TURN,
  # and that turn Stops first. Relaying it would answer with the wrong turn's work AND
  # consume the address, so the answer actually asked for would never be sent.
  : > "$asked"; mark "cf-ask${US}master${US}$AF"; fire Stop
  is "an unarmed address doesn't relay" "0" "$(rows "$asked")"
  is "...and is kept, not burned"       "1" "$(held)"
  fire UserPromptSubmit
  is "UserPromptSubmit arms it"         "1" "$(armed)"
  fire Stop
  is "...and THAT turn's Stop relays"   "1" "$(matches 'write-back is suppressed' "$asked")"
  # A block mid-request goes back to the asker too (it's the one that can unblock it),
  # but must NOT consume the address — that turn hasn't produced the answer yet.
  : > "$asked"; mark "cf-ask${US}master${US}$AF"; arm; fire Notification "needs permission to run rm"
  is "a mid-request block relays"       "asks" "$(awk -F'\t' 'NR==1{print $3}' "$asked" 2>/dev/null)"
  is "...and keeps the address"         "1" "$(held)"
  # Malformed addresses. The 4-field case is the trap CLAUDE.md keeps a list of: with
  # fewer read variables than fields the leftover glues onto the LAST one — here the
  # DIRECTORY every row gets written into. Two guards catch it (the sink, and the -d
  # test), so this asserts the contract rather than either guard.
  bads=("cf-ask${US}master${US}$AF${US}JUNK"      \
        "cf-ask${US}mas ter${US}$AF"              \
        "cf-ask${US}master${US}not/absolute"      \
        "cf-ask${US}master"                       \
        "cf-resp${US}w1${US}$AF")
  : > "$RF/cf-resp.inbox"
  for bad in "${bads[@]}"; do
    : > "$asked"; mark "$bad"; arm; fire Stop
    is "unroutable address is refused"  "0" "$(rows "$asked")"
    is "...dropped, not retried a turn" "0" "$(ls "$RF" 2>/dev/null | grep -c 'reply-to' || true)"
  done
  # Silence is the failure mode here: dropping the address without a word would leave the
  # asker waiting and the responder with nothing to explain it. One row per dropped one.
  is "...and it says so where you look" "${#bads[@]}" "$(matches 'unroutable reply-to marker' "$RF/cf-resp.inbox")"
  rm -rf "$T"
else
  skip "reply relay" "jq not available"
fi

# The sending half: the address fleet-send writes, and every address it must refuse.
group "reply relay (fleet-send --reply-to)"
if command -v tmux >/dev/null 2>&1; then
  T="$(mktemp -d)"; RF="$T/fleet"; AF="$T/ask/fleet"; mkdir -p "$RF" "$AF"
  US=$'\x1f'
  tmux -L cffsend kill-server 2>/dev/null
  # The pane prints the busy marker on purpose: fleet-send then takes its "already
  # mid-turn, the prompt queues" path, which skips the 8s submit-confirm loop. The
  # queued path must KEEP the address (arming decides which turn answers, not this).
  tmux -L cffsend new-session -d -x 200 -y 40 -s tgt "printf 'esc to interrupt\n'; sleep 30" 2>/dev/null
  sleep 0.4
  FSEND() { env -u TMUX CLAUDE_FLEET_DIR="$RF" "$ROOT/bin/fleet-send" -s cffsend "$@" 2>&1; }
  FSEND --reply-to "cf-ask/master" --reply-dir "$AF" tgt "what is the schema" >/dev/null 2>&1
  is "the address is a 3-field record" "cf-ask|master|$AF" \
     "$(tr '\037' '|' < "$RF/cffsend.tgt.reply-to" 2>/dev/null | tr -d '\n')"
  is "a queued send keeps it"          "1" "$([ -f "$RF/cffsend.tgt.reply-to" ] && echo 1 || echo 0)"
  is "...and nothing is pre-armed"     "0" "$([ -f "$RF/cffsend.tgt.reply-to.armed" ] && echo 1 || echo 0)"
  # The target has to be TOLD, or it answers as if a human were watching. Read it off the
  # PANE (the tty echoes the paste): fleet-send pastes with -d, which deletes the buffer,
  # so the buffer is gone by now — and the pane is what the agent actually received.
  # The notice is PREPENDED: the paste-landed probe is the last 24 chars of the message,
  # and a fixed boilerplate tail would be identical on every relayed send, so the probe
  # would match a PREVIOUS send still on screen instead of this one.
  buf="$(tmux -L cffsend capture-pane -p -t tgt 2>/dev/null | grep -v '^[[:space:]]*$')"
  is "the target is told who asked"    "1" "$(printf '%s\n' "$buf" | grep -c 'from another agent (cf-ask/master)' || true)"
  is "...and the caller's words last"  "what is the schema" "$(printf '%s\n' "$buf" | tail -1)"
  # Every field lands in a file that a hook reads back and interpolates into a tmux
  # command line, so refuse it here — the same rule as fleet-stack's valid_line.
  is "a path-ish address is refused"   "1" "$(FSEND --reply-to 'cf-a/../../etc' tgt hi | grep -c 'bad --reply-to' || true)"
  is "a quote-closing one is refused"  "1" "$(FSEND --reply-to "cf-a/x';id'" tgt hi | grep -c 'bad --reply-to' || true)"
  is "the target as its own asker too" "1" "$(FSEND --reply-to cffsend/tgt tgt hi | grep -c 'would loop back' || true)"
  # `me` must NOT be answered from CLAUDE_FLEET_SOCK: under the MCP server that env names
  # the TARGET's fleet, so it would address our session NAME on their SOCKET — an address
  # that validates and relays to whatever answers that name over there.
  is "--reply-to me with no \$TMUX refuses" "1" \
     "$(env -u TMUX CLAUDE_FLEET_DIR="$RF" CLAUDE_FLEET_SOCK=cf-somewhere-else \
          "$ROOT/bin/fleet-send" -s cffsend --reply-to me tgt hi 2>&1 \
        | grep -c 'needs a live fleet session' || true)"
  rm -f "$RF/cffsend.tgt.reply-to"
  FSEND tgt "plain dispatch" >/dev/null 2>&1
  is "a plain send writes no address"  "0" "$(ls "$RF" 2>/dev/null | grep -c 'reply-to' || true)"
  # ...and must not CANCEL one. "Newest send wins" reads tidy and is a trap: the address is
  # keyed by the TARGET, so the master nudge in fleet-event.sh — a plain fleet-send at
  # `master` — would drop a pending question to that master every time a worker finished.
  FSEND --reply-to "cf-ask/master" --reply-dir "$AF" tgt "q2" >/dev/null 2>&1
  FSEND tgt "unrelated dispatch" >/dev/null 2>&1
  is "...and doesn't cancel a pending" "1" "$([ -f "$RF/cffsend.tgt.reply-to" ] && echo 1 || echo 0)"
  tmux -L cffsend kill-server 2>/dev/null; rm -rf "$T"
else
  skip "reply relay (fleet-send)" "tmux not available"
fi

# `node --check` proves the screen PARSES, not that it runs — a missing `let` is a
# ReferenceError that only fires on the keystroke that reaches it, and it kills the
# whole grid pane. So drive the real TUI in a scratch tmux pane and send it keys. The
# screen prints its choice on stdout, which is what the control plane switches on: a
# screen that renders beautifully and prints the wrong word does nothing at all.
group "stack screen (real TUI, keys sent)"
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet" "$T/fleet" "$T/repo"
  tmux -L cfstkui kill-server 2>/dev/null
  tmux -L cfstkses kill-server 2>/dev/null
  # one real project with two live sessions, so the screen has rows to toggle
  printf 'demo\t%s/repo\twork\n' "$T" > "$T/.config/ghostfleet/projects"
  tmux -L cf-demo kill-server 2>/dev/null
  tmux -L cf-demo new-session -d -s master "sleep 90" 2>/dev/null
  tmux -L cf-demo new-session -d -s worker "sleep 90" 2>/dev/null
  ui() {          # keys… -> whatever the screen printed on stdout
    tmux -L cfstkui kill-server 2>/dev/null
    tmux -L cfstkui new-session -d -x 100 -y 30 \
      -e HOME="$T" -e CLAUDE_FLEET_DIR="$T/fleet" \
      -e CLAUDE_FLEET_PROJECTS="$T/.config/ghostfleet/projects" \
      "node '$ROOT/bin/fleet-grid.mjs' - --screen stack > '$T/out' 2>'$T/err'" 2>/dev/null
    sleep 2.5
    local k
    for k in "$@"; do tmux -L cfstkui send-keys "$k"; sleep 0.6; done
    sleep 1
    cat "$T/out" 2>/dev/null
    tmux -L cfstkui kill-server 2>/dev/null
  }
  # It has to LIST the fleet's sessions, or there is nothing to pick.
  tmux -L cfstkui kill-server 2>/dev/null
  tmux -L cfstkui new-session -d -x 100 -y 30 -e HOME="$T" -e CLAUDE_FLEET_DIR="$T/fleet" \
    -e CLAUDE_FLEET_PROJECTS="$T/.config/ghostfleet/projects" \
    "node '$ROOT/bin/fleet-grid.mjs' - --screen stack; sleep 8" 2>/dev/null
  sleep 2.5
  screen="$(tmux -L cfstkui capture-pane -p 2>/dev/null)"
  is "lists the project's sessions"  "1" "$(printf '%s\n' "$screen" | grep -c 'worker' || true)"
  is "no crash on the way in"        "0" "$(printf '%s\n' "$screen" | grep -cE 'ReferenceError|TypeError|is not defined' || true)"
  tmux -L cfstkui kill-server 2>/dev/null
  # ⏎ on an EMPTY stack must not hand the control plane an open it can't satisfy —
  # it stays on the screen, so the following Escape is what ends the run ("back").
  rm -f "$T/fleet/stack.tsv"
  is "⏎ with nothing stacked doesn't open" "back" "$(ui Enter Escape)"
  # space adds the selected session, socket-scoped, and ⏎ then asks for the window
  rm -f "$T/fleet/stack.tsv"
  is "space + ⏎ asks to open"       "stackopen" "$(ui Space Enter)"
  is "...and space wrote one member" "1"        "$(grep -c . "$T/fleet/stack.tsv" 2>/dev/null || true)"
  is "...scoped to its socket"       "1"        "$(grep -c '^cf-demo	' "$T/fleet/stack.tsv" 2>/dev/null || true)"
  # Same key, both directions — and from a KNOWN-empty file, or "twice" would just be
  # toggling the member the previous case left behind and end up back at one.
  rm -f "$T/fleet/stack.tsv"
  is "space twice leaves it empty"   "0"        "$(ui Space Space Escape >/dev/null; grep -c . "$T/fleet/stack.tsv" 2>/dev/null || true)"
  is "esc/q backs out"               "back"     "$(ui q)"
  # And the way in: `t` on the grid must emit exactly the word grid_loop switches on.
  tmux -L cfstkses kill-server 2>/dev/null
  tmux -L cfstkses new-session -d -x 100 -y 30 -e HOME="$T" -e CLAUDE_FLEET_DIR="$T/fleet" \
    "node '$ROOT/bin/fleet-grid.mjs' cf-demo - > '$T/gout' 2>/dev/null" 2>/dev/null
  sleep 2.5; tmux -L cfstkses send-keys t; sleep 1.5
  is "t on the grid asks for the stack" "stack" "$(cat "$T/gout" 2>/dev/null)"
  tmux -L cfstkses kill-server 2>/dev/null
  tmux -L cf-demo kill-server 2>/dev/null
  rm -rf "$T"
else
  skip "stack screen" "tmux or node not available"
fi

# Panes cannot cross tmux servers, so the stack is nested attaches. The contract that
# matters most: LEAVING must detach those clients and never kill a session. Driven
# through real servers because "attach in a pane that dies leaves the session running"
# is exactly the kind of thing that is true until it isn't.
group "stack window (live tmux)"
if command -v tmux >/dev/null 2>&1; then
  T="$(mktemp -d)"
  for s in cfstka cfstkb cfstkdrv cf-stack; do tmux -L "$s" kill-server 2>/dev/null; done
  # two members on two DIFFERENT servers — the case join-pane cannot do at all
  tmux -L cfstka new-session -d -s master "sleep 120" 2>/dev/null
  tmux -L cfstkb new-session -d -s master "sleep 120" 2>/dev/null
  CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-stack" add cfstka master
  CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-stack" add cfstkb master
  # a driver pane, because `fleet-stack open` attaches and needs a real tty
  tmux -L cfstkdrv -f /dev/null new-session -d -s drv -x 160 -y 40 \
    -e CLAUDE_FLEET_DIR="$T" "bash --norc" 2>/dev/null
  sleep 1
  tmux -L cfstkdrv send-keys -t drv "'$ROOT/bin/fleet-stack' open" Enter
  sleep 4
  is "one pane per member"        "2" "$(tmux -L cf-stack list-panes -t stack 2>/dev/null | grep -c . || true)"
  # Every project has a `master`; the pane border is the only thing that can say whose.
  is "panes are labelled by socket" "2" "$(tmux -L cf-stack list-panes -t stack -F '#{pane_title}' 2>/dev/null | grep -cE '^cfstk[ab] · master$' || true)"
  is "both members have a client" "1 1" "$( { tmux -L cfstka list-sessions -F '#{session_attached}' 2>/dev/null; tmux -L cfstkb list-sessions -F '#{session_attached}' 2>/dev/null; } | tr '\n' ' ' | sed 's/ $//')"
  # Without this, opening a stack silently crops whatever you view full-screen next.
  is "window-size largest on member A" "largest" "$(tmux -L cfstka show-options -gv window-size 2>/dev/null)"
  is "window-size largest on member B" "largest" "$(tmux -L cfstkb show-options -gv window-size 2>/dev/null)"
  # ` leaves the whole stack (the one key the stack's config binds)
  tmux -L cfstkdrv send-keys -t drv '`'
  sleep 3
  is "leaving tears the stack down"    "0" "$(tmux -L cf-stack list-sessions 2>/dev/null | grep -c . || true)"
  is "member A SURVIVES, detached"     "master 0" "$(tmux -L cfstka list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null)"
  is "member B SURVIVES, detached"     "master 0" "$(tmux -L cfstkb list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null)"

  # `fleet-stack open </dev/tty` — the way every other screen in this repo is invoked,
  # and the way the control plane called it at first. tmux REFUSES a client whose stdin
  # is the /dev/tty alias (`tty </dev/tty` reports the literal "/dev/tty"), so the whole
  # window gets built and then the attach fails. The visible symptom was a one-frame
  # flicker with no error, because the panes really were there. Assert the ATTACH, not
  # just the panes — panes alone were true while it was broken.
  tmux -L cf-stack kill-server 2>/dev/null
  tmux -L cfstkdrv kill-server 2>/dev/null
  tmux -L cfstkdrv -f /dev/null new-session -d -s drv -x 160 -y 40 \
    -e CLAUDE_FLEET_DIR="$T" "bash --norc" 2>/dev/null
  sleep 1
  tmux -L cfstkdrv send-keys -t drv "'$ROOT/bin/fleet-stack' open </dev/tty" Enter
  sleep 4
  is "opens with stdin on /dev/tty too" "stack" "$(tmux -L cf-stack list-clients -F '#{client_session}' 2>/dev/null)"
  tmux -L cfstkdrv send-keys -t drv '`'; sleep 2

  for s in cfstka cfstkb cfstkdrv cf-stack; do tmux -L "$s" kill-server 2>/dev/null; done
  rm -rf "$T"
else
  skip "stack window" "tmux not available"
fi

# ── 5. sleep inhibitor guards ────────────────────────────────────────────────
# The mode has to survive a relaunch. An env var only applies to the process you
# launched with it, so a persisted marker is the difference between "set it once" and
# "the screen locks again the next time you forget" — reported three times before this.
group "awake mode is persisted, not just an env var"
awmode() {   # $1 = env value ("" = unset), $2 = marker contents ("" = no marker)
  local T; T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet"
  [ -n "$2" ] && printf '%s\n' "$2" > "$T/.config/ghostfleet/awake"
  HOME="$T" CLAUDE_FLEET_AWAKE="$1" bash -c "$(sed -n '/^_awake_file=/,/^case "\$_awake_mode" in on|off/p' "$ROOT/bin/ghostfleet"); printf %s \"\$_awake_mode\""
  rm -rf "$T"
}
is "marker alone selects display"      "display" "$(awmode "" display)"
is "marker alone selects off"          "off"     "$(awmode "" off)"
is "no marker, no env -> on"           "on"      "$(awmode "" "")"
# A one-off override must still work without editing the marker.
is "env beats the marker"              "off"     "$(awmode off display)"
is "env beats the marker, other way"   "display" "$(awmode display off)"
# A typo in the file must not silently disable the inhibitor.
is "garbage marker falls back to on"   "on"      "$(awmode "" 'garbage!')"

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
