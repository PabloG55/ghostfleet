#!/usr/bin/env bash
# test/run.sh — the regression suite. No dependencies, no network, no live fleet.
#
#     ./test/run.sh            everything
#     ./test/run.sh agent      only groups whose name matches "agent"
#
# Safe to run while a sibling worktree is running it: every tmux server a run
# starts lives under that run's own $TMUX_TMPDIR (§0), so two runs cannot meet
# and neither can reach the live fleet.
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

# ── 0. one tmux socket namespace per RUN ─────────────────────────────────────
# Every server this file starts used to have a FIXED name — cftabh, cfstka,
# cfrecl, forty-odd of them. That is fine for one run and corrupting for two, and
# two is the ordinary case in a repo whose whole subject is running sessions in
# parallel: a sibling worktree running the suite drove the SAME servers, and
# since nearly every group opens with `kill-server`, each run tore the other's
# fixture down mid-assertion, counted sessions the other had created, and read
# panes the other had written. Measured twice in one afternoon: 46 phantom
# failures in a run that overlapped a sibling's, and a red run that went green on
# a quiet retry with no code change in between. That is worse than having no
# suite, because the rule here is to trust a test only after watching it go red —
# and a phantom red is indistinguishable from a real one.
#
# THE FIX IS THE DIRECTORY, NOT THE NAMES. `tmux -L <name>` is a name *inside*
# $TMUX_TMPDIR, so one exported variable namespaces every socket a run opens —
# including the ones this file never spells, which is the half renaming cannot
# reach: fleet-stack falls back to `cf-stack` when CLAUDE_FLEET_STACK_SOCK is
# unset, and cf-stack is the lead's live stack screen. ab8fff5 caught exactly
# that by hand, after the suite had spent who knows how long tearing down real
# stacks; under a private TMUX_TMPDIR the same slip cannot reach out of the run
# at all. Nothing started here can touch cf-superkey or cf-ghostfleet now even if
# it asks for them by name.
#
# It also leaves the names alone, and the names are load-bearing. `${SOCK#cf-}`
# is how a fleet turns a socket into a project, so `cfstka` (no hyphen) and
# `cf-demo` (hyphen) exercise two different paths on purpose — the stack's pane
# label is asserted as `cfstka · master`, which only reads that way because the
# strip finds nothing to strip. A renaming scheme that blurred the two would have
# changed what several assertions measure while every one of them stayed green.
#
# /tmp rather than $TMPDIR: macOS hands out a /var/folders/… TMPDIR long enough
# to push a socket path past sun_path's 104 bytes. `pwd -P` because /tmp here is
# a symlink to /private/tmp and tmux reports the resolved path back — two
# spellings of one directory is the trap that already cost this repo a config key
# nothing could find.
TEST_RUNS=/tmp/ghostfleet-test                    # one <prefix>.<pid>.XXXXXX per run
TMUX_TMPDIR="$(cd "$(mktemp -d "$TEST_RUNS.$$.XXXXXX")" && pwd -P)"; export TMUX_TMPDIR

# A fixed name is self-limiting: the next run kills the server. A unique one is
# not, so a run that dies half way leaks its servers for good. Two guards — our
# own teardown, on the failing path as much as the passing one (this suite exits
# non-zero by design, and gets ⌃C'd), and a sweep for the runs that never reached
# theirs. The sweep is keyed on the pid in the directory name and only ever looks
# at directories this file created and this user owns, so it can reach neither a
# live sibling's servers nor anybody's real fleet. Two depths of glob because the
# namespace check below builds fake run directories one level down, and a socket
# the teardown cannot see is a server nothing ever kills.
kill_servers_in() {                # $1 = a run directory
  local s
  for s in "$1"/tmux-*/* "$1"/*/tmux-*/*; do
    [ -S "$s" ] && tmux -S "$s" kill-server 2>/dev/null
  done
  return 0
}
sweep_dead_runs() {                # $1 = the <prefix> of <prefix>.<pid>.XXXXXX
  local d pid
  for d in "$1".*; do
    [ -d "$d" ] && [ -O "$d" ] || continue
    pid="${d#"$1".}"; pid="${pid%%.*}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac   # not a run directory of ours
    [ "$pid" = "$$" ] && continue                  # us
    kill -0 "$pid" 2>/dev/null && continue         # a run still going: hands off
    kill_servers_in "$d"; rm -rf "$d"
  done
  return 0
}
trap 'rc=$?; kill_servers_in "$TMUX_TMPDIR"; rm -rf "$TMUX_TMPDIR"; exit $rc' EXIT
trap 'exit 130' INT
sweep_dead_runs "$TEST_RUNS"

# Proven, not asserted: every other group now rests on this, so it goes first and
# goes red on its own rather than being taken on trust. Both directions on the
# sweep especially — it deletes directories and kills servers, and the direction
# that matters is the one where it must NOT.
group "socket namespace (this run's own)"
if command -v tmux >/dev/null 2>&1; then
  tmux -L nsprobe kill-server 2>/dev/null
  tmux -L nsprobe new-session -d -s p 'sleep 20' 2>/dev/null
  nsp="$(tmux -L nsprobe display-message -p '#{socket_path}' 2>/dev/null)"
  is "a server lands in THIS run's dir" "$TMUX_TMPDIR" "$(dirname "$(dirname "$nsp")")"
  tmux -L nsprobe kill-server 2>/dev/null
  # On a scratch prefix of its own: pointed at $TEST_RUNS the sweep would be
  # making its point by reaching into a sibling's live run. Named under $TEST_RUNS
  # all the same, so a run killed mid-group leaves something a later sweep owns.
  SW="$(cd "$(mktemp -d "$TEST_RUNS.$$.swpXXXXXX")" && pwd -P)"; SWP="$SW/run"
  sleep 30 & LIVE=$!
  sleep 0  & DEAD=$!; wait "$DEAD" 2>/dev/null
  LD="$SWP.$LIVE.aaaaaa"; DD="$SWP.$DEAD.bbbbbb"; mkdir -p "$LD" "$DD"
  TMUX_TMPDIR="$DD" tmux -L leaked new-session -d -s s 'sleep 60' 2>/dev/null
  spid="$(TMUX_TMPDIR="$DD" tmux -L leaked display-message -p '#{pid}' 2>/dev/null)"
  alive() { kill -0 "${1:-0}" 2>/dev/null && echo 1 || echo 0; }
  is "a leaked server is running to begin with" "1" "$(alive "$spid")"
  sweep_dead_runs "$SWP"; sleep 0.5
  is "the sweep kills a dead run's server"      "0" "$(alive "$spid")"
  is "...and takes its directory with it"       "0" "$([ -d "$DD" ] && echo 1 || echo 0)"
  is "...but leaves a LIVE run's alone"         "1" "$([ -d "$LD" ] && echo 1 || echo 0)"
  kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
  kill_servers_in "$SW"; rm -rf "$SW"
else
  skip "socket namespace" "tmux not available"
fi

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

# ── the governor reads a LIVE figure, not a fossil ───────────────────────────
# Two ways the status bar's number lies, both of which parked a real fleet:
#
#  1. Parking freezes the pane the figure is read from. An idle Claude does not repaint
#     its status bar, so a worker parked at 98% still SAYS 98% long after the window
#     recovered — and since budget() takes the MAX across panes, that fossil becomes the
#     fleet's answer. The trap then closes on itself: everything parked, so nothing
#     refreshes, so the reading never falls, so nothing is ever resumed. A real log sat
#     at "98% — all workers parked, holding for recovery" until ignore-limit was flipped
#     by hand.
#  2. The figure is stale for a while after an account/team switch — every pane keeps
#     reporting the OLD window until Claude next repaints it. Acting on the first
#     reading parks the fleet over a number that has already stopped being true.
group "governor: a frozen pane must not pin the fleet"
if command -v tmux >/dev/null 2>&1; then
  GV="$(mktemp -d)"
  printf 'x | Acct | master | main | Opus 5 (1M context) | ctx:5%% | 17%%(4h 34m) | 7d:20%%(3h)\n' > "$GV/lo"
  printf 'x | Acct | w1 | main | Opus 5 (1M context) | ctx:5%% | 98%%(2h 40m) | 7d:86%%(4h)\n'     > "$GV/hi"
  govtick() {                    # $@ = extra governor args -> its decision line
    tmux -L cfgovfrz kill-server 2>/dev/null
    tmux -L cfgovfrz new-session -d -s master -x 200 -y 30 "cat '$GV/lo'; sleep 60" 2>/dev/null
    tmux -L cfgovfrz new-session -d -s w1     -x 200 -y 30 "cat '$GV/hi'; sleep 60" 2>/dev/null
    sleep 1
    CLAUDE_FLEET_DIR="$GV" "$ROOT/bin/fleet-governor" -s cfgovfrz --once --dry-run "$@" 2>&1
    tmux -L cfgovfrz kill-server 2>/dev/null
  }
  rm -f "$GV/cfgovfrz.w1.parked"
  # w1 LIVE: its 98% is a real reading and must still drive the ceiling
  is "a live 98% pane still parks"      "1" "$(govtick --confirm 0 | grep -c 'parking ALL 1' || true)"
  # w1 PARKED: the same 98% is now a stopped clock, and master's live 17% must win
  printf 'governor 1\n' > "$GV/cfgovfrz.w1.parked"
  is "a PARKED 98% pane is ignored"     "1" "$(govtick --confirm 0 | grep -c 'budget 17%' || true)"
  is "...so the fleet can recover"      "1" "$(govtick --confirm 0 | grep -c 'resume w1' || true)"
  rm -rf "$GV"
else
  skip "governor frozen pane" "tmux missing"
fi

group "governor: look twice before parking"
if command -v tmux >/dev/null 2>&1; then
  GC="$(mktemp -d)"
  printf 'x | Acct | master | main | Opus 5 (1M context) | ctx:5%% | 98%%(2h 40m) | 7d:86%%(4h)\n' > "$GC/hi"
  printf 'x | Acct | master | main | Opus 5 (1M context) | ctx:5%% | 17%%(4h 34m) | 7d:20%%(3h)\n' > "$GC/lo"
  # $1 = the pane script (what the figure does over time) -> the decision line
  confirmtick() {
    tmux -L cfgovcfm kill-server 2>/dev/null
    tmux -L cfgovcfm new-session -d -s master -x 200 -y 30 "$1" 2>/dev/null
    tmux -L cfgovcfm new-session -d -s w1     -x 200 -y 30 "sleep 60" 2>/dev/null
    sleep 1
    CLAUDE_FLEET_DIR="$GC" "$ROOT/bin/fleet-governor" -s cfgovcfm --once --dry-run --confirm 4 2>&1
    tmux -L cfgovcfm kill-server 2>/dev/null
  }
  # the figure catches up during the wait: the 98% was the OLD account's, don't park
  is "a figure that catches up -> no park" "1" \
     "$(confirmtick "cat '$GC/hi'; sleep 2; clear; cat '$GC/lo'; sleep 60" | grep -c 'not parking' || true)"
  # it holds: a real ceiling, so the wait must not have turned parking off
  is "a figure that HOLDS -> parks"        "1" \
     "$(confirmtick "cat '$GC/hi'; sleep 60" | grep -c 'parking ALL' || true)"
  rm -rf "$GC"
else
  skip "governor confirm" "tmux missing"
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
# NOT a case: a phrase with no leading glyph. That was invented rather than captured,
# and every real spinner and subagent line taken off a pane carries one (✻ ✽ ✳ ✢ · +).
# Keeping it forced the phrase branch to accept lines starting with a bare word, which
# is exactly what prose does — see the two prose cases below, which it cannot separate
# without the glyph.
line "digits and a slash in it"     "· Updating apps/api v2 routes… (11m 40s · ↓ 42.2k tokens)"           1
# These two are why the class is an EXCLUDE list. An allow-list of letters/digits was
# widened twice in one day — first for the hyphen, then for the apostrophe — because
# these strings are model-written prose and will contain any punctuation at all. Both
# were live misses: a card sat on "✓ ready" over a session seven minutes into a turn.
line "an apostrophe in the phrase"     "✳ Extracting DV's review surface into shared components… (7m 32s · ↓ 21.1k)" 1
line "a comma and a full stop"         "✻ Reading src/a.ts, then src/b.ts… (2m 4s)"                          1
# The phrase branch buys its spaces by REQUIRING the clock. Without that, ordinary
# prose with an ellipsis is indistinguishable from a spinner — the exact false
# positive that anchoring was introduced to close, which cost 17 minutes of a worker
# showing "working" after it had finished.
line "a phrase with no clock"       "- Adding the operator-key auth provider… (the one that hung)"        0
line "prose with a line number"     "56  ✳ Adding the thing… (10m 15s)"                                   0
line "the idle agent-count hint"    "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent"           0
# ...and why it still excludes ( ` and ". Those three are structural: "(" would let the
# phrase swallow the very clock this branch demands, and a backtick or quote is how
# PROSE quotes a spinner — the false positive anchoring was added to close. Allowing
# them (a bare [^(]* was the obvious simplification) makes this fire.
line "prose quoting a spinner"        "> quoting \`✻ Baking… (2m 1s)\` here"                                  0
# THE ONE THAT ACTUALLY BIT. A terminal RENDERS markdown delimiters as styling, so the
# backticks never reach capture-pane: this is a real captured line from a session whose
# own message was about this detector, and it read "working" for the rest of its life.
# Nothing may depend on a quote surviving; what separates it is that a live spinner's
# parenthetical CLOSES its line, and prose keeps talking after the ")".
line "prose, backticks stripped by the terminal" \
     "  One thing I found: a bullet quoting a spinner at the margin — - The spinner reads Flowing… (18s) — does fire, and did before." 0
# A markdown bullet starts with "-", which IS a glyph — so the glyph rule cannot save
# this one and the end-of-line rule has to. A live spinner's parenthetical is the last
# thing on its line; prose keeps talking after the ")".
line "a bulleted quote that keeps talking" \
     "  - The spinner reads Flowing… (18s) — does fire, and did before this change."      0
line "prose whose clock DOES end the line" \
     "  Some prose that happens to mention Flowing… (18s)"                                 0
# and the one-word branch must keep its LOOSE paren: a narrow pane drops the clock
# first, and that pane still has to read as busy.
line "one word, clock dropped"      "✽ Flowing… (almost done thinking with xhigh effort)"                 1
rm -rf "$ST"

# THE GRID IS THE THING THAT DRAWS THE CARD, so assert on ITS answer, through a real
# pane. The group above asserts on what `fleet-agent field` returns — and that is
# exactly how a fix shipped that changed nothing a user could see: fleet-grid.mjs kept
# its own inline copy of claude's pattern AND pre-seeded the cache with it, so it never
# asked the adapter at all. The adapter learned to see a running subagent, the suite
# went green, and the grid went on printing "✓ ready" over a busy session.
group "the GRID's own verdict on a real pane"
if command -v tmux >/dev/null 2>&1; then
  GB="$(mktemp -d)"
  gridsees() {                   # $1 = what the pane shows -> the STATUS the grid prints
    printf '%s\n' "$1" > "$GB/pane.txt"
    tmux -L cfgridbusy kill-server 2>/dev/null
    # -c "$GB": an empty temp dir ON PURPOSE. Inherit the suite's cwd and
    # newestTranscript() finds a REAL conversation for it, so the idle case comes back
    # "ready" and the assertion below passes or fails on where the suite was run from.
    tmux -L cfgridbusy new-session -d -s w1 -c "$GB" -x 200 -y 30 "cat '$GB/pane.txt'; sleep 30" 2>/dev/null
    sleep 1
    CLAUDE_FLEET_DIR="$GB" CLAUDE_FLEET_ROOT= node "$ROOT/bin/fleet-grid.mjs" cfgridbusy --plain 2>/dev/null \
      | tail -n +3 | grep '^w1' | cut -c62-72 | sed 's/ *$//'
    tmux -L cfgridbusy kill-server 2>/dev/null
  }
  is "a subagent line reads as working"  "working" "$(gridsees "+ Adding the operator-key auth provider… (10m 15s · ↓ 32.8k tokens)")"
  # "Razzle-dazzling" is one WORD but carries a hyphen, so [A-Za-z]+ stopped at "Razzle"
  # — a live, reported miss that had nothing to do with subagents.
  is "a hyphenated spinner too"          "working" "$(gridsees "✳ Razzle-dazzling… (3m 5s · ↓ 11.5k tokens)")"
  is "the plain one-word spinner"        "working" "$(gridsees "✻ Flowing… (18s)")"
  # and the other direction, or all of the above would pass on a detector matching
  # everything
  is "an idle prompt is not working"     "idle"    "$(gridsees "❯ ")"
  rm -rf "$GB"
else
  skip "grid verdict" "tmux missing"
fi

# Two spellings of one pattern in two languages is already a drift risk the suite
# checks for; a THIRD copy inlined in the grid is how the drift actually happened. The
# grid keeps it only as a fallback for when fleet-agent can't be reached, so it has to
# stay byte-identical to what the adapter serves.
group "the grid's inline fallback matches the adapter"
is "BUSY_RE == claude's busy_re_js" "true" "$(node -e '
  const fs=require("fs"),{execFileSync}=require("child_process");
  const adapter=execFileSync(process.argv[1]+"/bin/fleet-agent",["field","claude","busy_re_js"],{encoding:"utf8"});
  const m=fs.readFileSync(process.argv[1]+"/bin/fleet-grid.mjs","utf8").match(/^const BUSY_RE = \/(.*)\/i;$/m);
  if(!m){console.log("NO-BUSY_RE-FOUND");process.exit(0)}
  console.log(String(new RegExp(adapter,"i").source===new RegExp(m[1],"i").source));
' "$ROOT")"

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

# ── 4a6. a need-you that was answered must stop being red ────────────────────
# need-you is LATCHED — the hook writes it and only a later hook event overwrites it —
# so the only other way out is noticing the session moved on. That test was purely a
# clock: "the transcript advanced more than 5s after the flag". The 5s is slop for
# Claude writing its turn either side of firing the hook, and it swallowed real
# answers: a /login answered 3 seconds after the prompt landed INSIDE the grace, and a
# slash command is not a model turn, so no Stop hook ever came either. The card stayed
# red for the life of the session while the pane sat at an idle prompt.
#
# The fix asks who spoke last instead, so the cases below run in BOTH directions: an
# answered flag must clear, and a genuinely pending one must NOT — a rule that just
# cleared everything would fix the complaint and silently blind the fleet to every
# real question, which is the one thing this status exists to surface.
group "an answered need-you stops being red"
if command -v tmux >/dev/null 2>&1; then
  NY="$(mktemp -d)"
  tmux -L cfneedtest kill-server 2>/dev/null
  for s in n1 n2 n3; do tmux -L cfneedtest new-session -d -s "$s" "sleep 120" 2>/dev/null; done
  node -e '
    const fs=require("fs"),path=require("path");
    const dir=process.argv[1], now=Math.floor(Date.now()/1000);
    const A=JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"working on it"}]}});
    const U=JSON.stringify({type:"user",message:{role:"user",content:"ok"}});
    // slot -> [transcript tail, seconds the transcript lands AFTER the hook]
    const cases={ n1:[[A,U],3], n2:[[U,A],3], n3:[[U,A],600] };
    for(const [slot,[lines,delta]] of Object.entries(cases)){
      const t=path.join(dir,slot+".jsonl");
      fs.writeFileSync(t,lines.join("\n")+"\n");
      const hookTs=now-3600;                       // raised an hour ago either way
      fs.utimesSync(t,hookTs+delta,hookTs+delta);
      fs.writeFileSync(path.join(dir,slot+".json"),JSON.stringify(
        {sock:"cfneedtest",slot,cwd:"/tmp/"+slot,folder:slot,branch:"main",
         status:"need-you",transcript:t,ts:hookTs}));
    }' "$NY"
  nystat() { CLAUDE_FLEET_DIR="$NY" node "$ROOT/bin/fleet-grid.mjs" cfneedtest --plain 2>/dev/null \
             | tail -n +3 | while IFS= read -r l; do
                 [ "$(printf '%s' "$l" | cut -c1-12 | sed 's/ *$//')" = "$1" ] \
                   && printf '%s' "$l" | cut -c62-72 | sed 's/ *$//'; done; }
  # answered 3s later — inside the old grace, so it used to stay red forever
  is "answered (user spoke last)      -> cleared" "ready"    "$(nystat n1)"
  # Claude spoke last and nothing came back: a real question, must survive
  is "pending (Claude spoke last)     -> still red" "need-you" "$(nystat n2)"
  # and the original clock rule still has to work on its own
  is "moved on long after             -> cleared" "ready"    "$(nystat n3)"
  tmux -L cfneedtest kill-server 2>/dev/null
  rm -rf "$NY"
else
  skip "answered need-you" "tmux missing"
fi

# ── 4a6b. a codex worker has history, and the grid has to find it ────────────
# codex has no hooks, so no status file is ever pushed for it, and its history is in
# its own layout ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl) that the
# claude-shaped lookup cannot reach. Both sources came back empty and deriveStatus fell
# to its last line: every codex worker read "· idle" — which on this grid means BRAND
# NEW — with no age and no last line, however long the conversation had been.
#
# Both directions, and the wrong answers here are the plausible ones: a resolver that
# returned the newest rollout REGARDLESS of cwd, or borrowed the claude transcript
# sitting in a recycled worktree, would light the card up with a real message and a real
# timestamp belonging to somebody else — which reads as working perfectly.
#
# $CX is `pwd -P`: mktemp hands back /var/... which is a symlink to /private/var, tmux
# reports the physical path, and a rollout keyed to the logical one would match nothing.
# That exact mismatch is why the codex trust stanza was written to a path codex never read.
group "codex history (rollout -> ready)"
if command -v tmux >/dev/null 2>&1; then
  CX="$(cd "$(mktemp -d)" && pwd -P)"
  tmux -L cfcodextest kill-server 2>/dev/null
  node -e '
    const fs=require("fs"),path=require("path");
    const CX=process.argv[1];
    const wt=s=>path.join(CX,"wt",s);
    const enc=c=>c.replace(/[/.]/g,"-");
    const day=path.join(CX,"codex","sessions","2026","08","08");
    fs.mkdirSync(day,{recursive:true});
    fs.mkdirSync(path.join(CX,"fleet"),{recursive:true});
    // A rollout: the header (which is the ONLY place the cwd appears) plus, optionally,
    // a completed turn. The header padding stands in for the base instructions the real
    // file carries — kilobytes of prose AFTER the cwd, which is what forces the reader
    // to look at a bounded window rather than parse the line.
    const roll=(stamp,cwd,msg)=>{
      const lines=[JSON.stringify({timestamp:"2026-08-08T04:25:21.829Z",ordinal:0,type:"session_meta",
        payload:{session_id:stamp,cwd,originator:"codex-tui",cli_version:"0.147.0",
                 base_instructions:{text:"You are Codex. ".repeat(500)}}})];
      if(msg) lines.push(JSON.stringify({timestamp:"2026-08-08T04:25:23.711Z",ordinal:13,type:"event_msg",
        payload:{type:"task_complete",turn_id:"t1",last_agent_message:msg,completed_at:1786163123}}));
      fs.writeFileSync(path.join(day,`rollout-2026-08-08T${stamp}-0000.jsonl`),lines.join("\n")+"\n");
    };
    for(const s of ["c1","c2","c3","c4","c5","c6"]) fs.mkdirSync(wt(s),{recursive:true});
    // c1 talked to codex; c2 has only started it; c3 has no rollout of its own at all
    roll("00-10-00",wt("c1"),"binder slots line up now");
    roll("00-11-00",wt("c2"),"");
    // c6 is a RECYCLED worktree: an older finished conversation and a newer one, same cwd
    roll("00-12-00",wt("c6"),"the previous tenant");
    roll("00-13-00",wt("c6"),"who lives here now");
    // an unrelated rollout, newest of all — nothing may fall back to it
    roll("00-14-00",path.join(CX,"wt","somewhere-else"),"a stranger");
    // c4 is a worktree that USED to run claude: the old transcript must not be borrowed
    const pd=path.join(CX,"cfg","projects",enc(wt("c4")));
    fs.mkdirSync(pd,{recursive:true});
    fs.writeFileSync(path.join(pd,"old.jsonl"),JSON.stringify(
      {type:"assistant",message:{role:"assistant",content:[{type:"text",text:"claude was here"}]}})+"\n");
    // c5 is the control: still claude, and must go on reading exactly that transcript
    const pd5=path.join(CX,"cfg","projects",enc(wt("c5")));
    fs.mkdirSync(pd5,{recursive:true});
    fs.writeFileSync(path.join(pd5,"live.jsonl"),JSON.stringify(
      {type:"assistant",message:{role:"assistant",content:[{type:"text",text:"claude still works"}]}})+"\n");
    for(const s of ["c1","c2","c3","c4","c6"])
      fs.writeFileSync(path.join(CX,"fleet",`cfcodextest.${s}.agent`),"codex\n");
  ' "$CX"
  for s in c1 c2 c3 c4 c5 c6; do
    tmux -L cfcodextest new-session -d -s "$s" -c "$CX/wt/$s" "sleep 120" 2>/dev/null
  done
  # column widths come from the --plain header: name 12, checkout 14, branch 26,
  # agent 9, status 11, msg 46
  cxcol() { CLAUDE_CONFIG_DIR="$CX/cfg" CLAUDE_FLEET_DIR="$CX/fleet" CODEX_HOME="$CX/codex" \
            node "$ROOT/bin/fleet-grid.mjs" cfcodextest --plain 2>/dev/null \
            | tail -n +3 | while IFS= read -r l; do
                [ "$(printf '%s' "$l" | cut -c1-12 | sed 's/ *$//')" = "$1" ] \
                  && printf '%s' "$l" | cut -c"$2" | sed 's/ *$//'; done; }
  cxstat() { cxcol "$1" 62-72; }
  cxmsg()  { cxcol "$1" 73-118; }
  is "finished a turn          -> ready"      "ready" "$(cxstat c1)"
  is "and its last line is shown"            "binder slots line up now" "$(cxmsg c1)"
  # codex writes the header at STARTUP, so a file exists before you have said anything —
  # handing that back would call a brand-new pane "ready", which means "has history".
  is "started, never spoken to -> idle"      "idle"  "$(cxstat c2)"
  is "and shows no last line"                ""      "$(cxmsg c2)"
  # the stranger's rollout is the newest on disk: matching by cwd is the only thing
  # standing between c3 and somebody else's conversation
  is "no rollout of its own     -> idle"     "idle"  "$(cxstat c3)"
  is "and never borrows another's line"      ""      "$(cxmsg c3)"
  is "recycled worktree: newest rollout wins" "who lives here now" "$(cxmsg c6)"
  # dispatch is on the AGENT, not "try codex, fall back to claude"
  is "codex never reads a claude transcript" ""      "$(cxmsg c4)"
  is "and stays idle for it"                 "idle"  "$(cxstat c4)"
  is "claude sessions are untouched"         "claude still works" "$(cxmsg c5)"
  is "and still read ready"                  "ready" "$(cxstat c5)"
  tmux -L cfcodextest kill-server 2>/dev/null
  rm -rf "$CX"
else
  skip "codex history" "tmux missing"
fi

# ── 4a7. the MCP can reach ANOTHER project's repo ────────────────────────────
# fleet_spawn and fleet_worktrees find the repo from $PWD rather than from -s — the
# only two here that do — which is why they were also the only two with no `project`
# parameter. An agent asked to start a worker in another project had to drop to the CLI
# and know that fleet-spawn re-routes by repo owner. They now RUN IN the target's
# checkout instead.
#
# Both directions, because a tool that ignored the parameter entirely would sail through
# a one-sided test by inventorying whatever directory it already sat in: with `project`
# it must see the TARGET's worktree and NOT the caller's, and without it, the reverse.
group "MCP: fleet_worktrees reaches another project"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  MP="$(mktemp -d)"
  mkdir -p "$MP/home/.config/ghostfleet" "$MP/root"
  for r in "$MP/root/theproj" "$MP/caller"; do
    mkdir -p "$r"; git init -q -b main "$r" 2>/dev/null
    git -C "$r" config user.email t@t; git -C "$r" config user.name t
    : > "$r/f"; git -C "$r" add -A; git -C "$r" commit -qm init 2>/dev/null
  done
  git -C "$MP/root/theproj" worktree add -q "$MP/root/only-over-there" -b only-over-there 2>/dev/null
  printf 'theproj\t%s\twork\n' "$MP/root" > "$MP/home/.config/ghostfleet/projects"
  mcpwt() {            # $1 = the tool's JSON arguments -> its text output
    { printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
      printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fleet_worktrees","arguments":%s}}\n' "$1"
      sleep 3
    } | ( cd "$MP/caller" && HOME="$MP/home" CLAUDE_FLEET_SOCK=cfmcptest TMUX= \
          node "$ROOT/mcp/fleet-mcp.mjs" 2>/dev/null ) \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.split("\n").filter(Boolean).forEach(l=>{try{const o=JSON.parse(l);if(o.id===2)process.stdout.write(o.result?.content?.[0]?.text||"")}catch{}})})'
  }
  # anchored to the WORKTREE column: the name also appears in the "Free to reuse:"
  # footer, so an unanchored count is 2 and the assertion would be pinned to a
  # formatting detail rather than to the row being there.
  is "with project: the TARGET's worktree"   "1" "$(mcpwt '{"project":"theproj"}' | grep -c '^only-over-there ' || true)"
  is "with project: NOT the caller's repo"   "0" "$(mcpwt '{"project":"theproj"}' | grep -c '^caller ' || true)"
  is "without project: the caller's repo"    "1" "$(mcpwt '{}'                    | grep -c '^caller ' || true)"
  is "without project: not the target's"     "0" "$(mcpwt '{}'                    | grep -c '^only-over-there ' || true)"
  is "an unknown project is refused"         "1" "$(mcpwt '{"project":"nope"}'    | grep -c 'unknown project' || true)"
  rm -rf "$MP"
else
  skip "MCP cross-project" "git/tmux missing"
fi

# ── 4a7b. a missing required argument must not become the word "undefined" ────
# Shipped, and silent on both sides: a lead sent four prompts with fleet_send and every
# one of them arrived in the worker's pane as `❯ undefined`, while the tool answered
# `fleet-send: → <session>` — the ordinary success line. Two workers then sat idle
# waiting on instructions their lead was certain it had sent, one of them a scope answer
# sent three times. `required: ['session','prompt']` had been in the inputSchema all
# along; that array is a promise the CLIENT keeps, and this client (Claude Code 2.1.226)
# dropped the key. `String(undefined)` is the seven-character word "undefined", and the
# wrapper pasted it in and pressed Enter.
#
# So: every required argument of every tool, refused BY NAME before anything runs. Run
# against stub bin/ commands that log their argv, because the two halves are only
# separable if execution is observable — "refused" and "ran with garbage" both return
# text otherwise. Both directions, so a guard that refused everything (which would also
# make the no-`undefined` assertion green) cannot pass: the valid calls must still reach
# their command with their arguments intact.
group "MCP refuses a missing required argument"
AG="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$AG/mcp" "$AG/bin" "$AG/home"
cp "$ROOT/mcp/fleet-mcp.mjs" "$AG/mcp/"     # BIN is <this file>/../bin, so the copy's
: > "$AG/ran"                               # stubs are what a passing call reaches
for c in fleet-project fleet-list fleet-send fleet-read fleet-spawn fleet-worktrees \
         fleet-inbox fleet-answer fleet-pause fleet-resume fleet-stop fleet-rename; do
  cat > "$AG/bin/$c" <<STUB
#!/bin/sh
printf '%s' "\$(basename "\$0")" >> "$AG/ran"
for a in "\$@"; do printf ' [%s]' "\$a" >> "$AG/ran"; done
printf '\n' >> "$AG/ran"
echo "STUB ran"
STUB
  chmod +x "$AG/bin/$c"
done
# HOME/TMUX cleared: nothing here may read the real projects file or reach a live fleet.
HOME="$AG/home" TMUX= CLAUDE_FLEET_SOCK=cfargtest \
  node "$ROOT/test/helpers/mcp-argcheck.mjs" "$AG/mcp/fleet-mcp.mjs" > "$AG/out" 2>/dev/null
US=$'\x1f'
agf() { grep -m1 "^$1$US" "$AG/out" | cut -d "$US" -f2; }   # 1 = returned as an error
agt() { grep -m1 "^$1$US" "$AG/out" | cut -d "$US" -f3; }   # the text the caller sees

# the reported call, and the message the next lead gets instead of silence
is "missing prompt: flagged isError"       "1" "$(agf send.no-prompt)"
is "missing prompt: names tool and arg"    "1" "$(agt send.no-prompt | grep -cF "fleet_send: missing required argument 'prompt'" || true)"
is "missing session is named too"          "1" "$(agt send.no-session | grep -cF "fleet_send: missing required argument 'session'" || true)"
# null and a non-string are the same defect in another coat: String() turns them into
# "null" and "[object Object]" just as quietly
is "an explicit null is refused"           "1" "$(agt pause.null | grep -cF "fleet_pause: missing required argument 'session'" || true)"
is "a non-string is refused, with its type" "1" "$(agt send.obj-prompt | grep -cF "must be a string, got object" || true)"
# an empty prompt pastes nothing and submits it — the same lost instruction
is "an empty prompt is refused"            "1" "$(agt send.empty | grep -cF "fleet_send: required argument 'prompt' is empty" || true)"
is "a missing answer text is refused"      "1" "$(agt answer.no-text | grep -cF "fleet_answer: missing required argument 'text'" || true)"
# ...but empty is NOT blanket-refused: fleet_answer's text is raw keystrokes, and "" with
# the trailing Enter its description promises is a legible call. It goes through.
is "an empty answer text still runs"       "0" "$(agf answer.empty)"

# THE OTHER DIRECTION. Refusing must not cost the valid calls anything: each of these
# reached its command, and with its arguments unchanged.
is "a full send reaches fleet-send"        "1" "$(grep -cF 'fleet-send [w1] [the real work]' "$AG/ran" || true)"
is "optional n still defaults"             "1" "$(grep -cF 'fleet-read [w1] [1]' "$AG/ran" || true)"
is "optional reclaim stays optional"       "1" "$(grep -cF 'fleet-stop [w1]' "$AG/ran" || true)"
is "optional all stays optional"           "1" "$(grep -cF 'fleet-inbox [--all]' "$AG/ran" || true)"
is "optional prompt stays optional"        "1" "$(grep -cF 'fleet-resume [w1] [go]' "$AG/ran" || true)"
is "a tool with no required args runs"     "1" "$(grep -cF 'fleet-list' "$AG/ran" || true)"
is "empty text reaches fleet-answer"       "1" "$(grep -cF 'fleet-answer [w1] []' "$AG/ran" || true)"
# and NOTHING else did — a refusal that still shelled out would show up here
is "exactly the 7 valid calls ran"         "7" "$(grep -c . "$AG/ran" || true)"
is "no command was handed 'undefined'"     "0" "$(grep -c undefined "$AG/ran" || true)"

# DRIFT: the same check for every required argument the server declares, omitted in turn,
# generated from its own tools/list — so a tool added later is covered without editing
# this file. The count guards the loop itself: a driver that generated no cases would
# leave the refusal tally at zero and read as a pass.
nreq=0; badreq=0
while IFS="$US" read -r c e txt; do
  case "$c" in req:*) ;; *) continue ;; esac
  nreq=$((nreq+1)); k="${c##*.}"; tool="${c#req:}"; tool="${tool%%.*}"
  if [ "$e" = 1 ] && printf '%s' "$txt" | grep -qF "$tool: missing required argument '$k'"; then :
  else badreq=$((badreq+1)); fi
done < "$AG/out"
is "every declared required arg is refused by name" "0" "$badreq"
is "...and the loop covered the 12 known today"     "yes" "$([ "${nreq:-0}" -ge 12 ] && echo yes || echo no)"
is "...and nothing new ran while doing it"          "7" "$(grep -c . "$AG/ran" || true)"
rm -rf "$AG"

# The empty-text exception above rests on fleet-answer refusing "" itself, by name. If
# that ever became a silent no-op the exception would be hiding a lost keystroke, so it
# is asserted here rather than assumed.
group "fleet-answer refuses an empty text itself"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cfansempty kill-server 2>/dev/null
  tmux -L cfansempty new-session -d -s w1 "sleep 30" 2>/dev/null
  out="$(TMUX= "$ROOT/bin/fleet-answer" -s cfansempty w1 "" 2>&1; echo "rc=$?")"
  is "it refuses"        "1" "$(printf '%s' "$out" | grep -c 'nothing to send' || true)"
  is "and exits nonzero" "1" "$(printf '%s' "$out" | grep -c 'rc=1' || true)"
  # the other direction: a real key does get through, so the refusal is about emptiness
  is "a real text is sent" "1" "$(TMUX= "$ROOT/bin/fleet-answer" -s cfansempty w1 "2" 2>&1 | grep -c "sent '2'" || true)"
  tmux -L cfansempty kill-server 2>/dev/null
else
  skip "fleet-answer empty text" "tmux missing"
fi

# ── 4a8. dev-stack slots ─────────────────────────────────────────────────────
# One integer per checkout that nothing else in the fleet holds, so a repo can derive
# its local stack (ports, database, bucket) instead of a human picking free numbers per
# worktree with nothing checking they agree.
#
# The race is the whole feature. Leads spawn concurrently — that is what a fleet IS —
# and a read-modify-write over a shared free list has nothing serialising it, so two
# spawns both read "lowest free is N" and both take it: the original collision back
# again, rarer and harder to see. There is no lock to reach for either (flock(1) is not
# on macOS), so the claim itself is the atom. Measured against the obvious
# read-then-write version, which hands the SAME slot to all 20 racers and leaves 19
# checkouts with none at all.
group "dev-stack slots"
if command -v git >/dev/null 2>&1; then
  SL="$(mktemp -d)"
  mkdir -p "$SL/home/.config/ghostfleet" "$SL/root/proj" "$SL/root/proj-1" "$SL/root/wt-a"
  git init -q "$SL/root/proj" 2>/dev/null
  printf 'proj\t%s\twork\n' "$SL/root" > "$SL/home/.config/ghostfleet/projects"
  SLOT() { HOME="$SL/home" CLAUDE_FLEET_SLOTS="$SL/slots" "$ROOT/bin/fleet-slot" "$@"; }
  # 0 is the project's REGISTERED primary — the checkout master runs in — and is never
  # allocated, so the checkout you already work in keeps the ports it always had.
  is "the registered primary is 0"      "0" "$(SLOT claim "$SL/root/proj")"
  # ...and "primary" must NOT mean "first entry of git worktree list": a sibling CLONE
  # is its own repo's first entry, so that test would hand 0 to every checkout in the
  # project and collide them all onto the primary's ports — the exact failure this
  # feature removes.
  is "a sibling clone is NOT 0"         "1" "$(SLOT claim "$SL/root/proj-1")"
  is "another checkout gets the next"   "2" "$(SLOT claim "$SL/root/wt-a")"
  # idempotent, so `reuse` keeps its slot (and its warm database) with no special case,
  # and a boot script can call it every time instead of caching the answer
  is "claiming twice is stable"         "1" "$(SLOT claim "$SL/root/proj-1")"
  is "of: reads without allocating"     "2" "$(SLOT of "$SL/root/wt-a")"
  SLOT release "$SL/root/proj-1" >/dev/null
  is "a released slot is handed out again" "1" "$(mkdir -p "$SL/root/wt-b"; SLOT claim "$SL/root/wt-b")"
  # a slot whose checkout is gone must not stay held, or the pool fills with nothing
  rm -rf "$SL/root/wt-a"
  SLOT reclaim >/dev/null
  is "reclaim frees a vanished checkout" "" "$(SLOT of "$SL/root/wt-a" 2>/dev/null)"
  # THE RACE
  rm -rf "$SL/slots"; for i in $(seq 1 20); do mkdir -p "$SL/race/w$i"; done
  for i in $(seq 1 20); do SLOT claim "$SL/race/w$i" & done > "$SL/race.out" 2>&1
  wait
  is "20 concurrent claims -> 20 slots"  "20" "$(sort -n "$SL/race.out" | uniq | grep -c . || true)"
  is "...none of them duplicated"        "0"  "$(sort -n "$SL/race.out" | uniq -d | grep -c . || true)"
  is "...and 20 checkouts are recorded"  "20" "$(SLOT list | cut -f2 | sort -u | grep -c . || true)"
  rm -rf "$SL"
else
  skip "dev-stack slots" "git missing"
fi

# ── 4a9. pinning the primary, and the repo's own setup hook ──────────────────
# Deriving the primary checkout is a guess about someone's disk layout, and it is wrong
# exactly where it costs most: a project registered at a plain CONTAINER directory
# holding several clones AND unrelated products. superkey's root is one of those — four
# superkey clones plus `platform` and `gmc-crosswalk` — so the child-scan would hand
# slot 0 to a different product entirely. An explicit pin skips the guess.
group "dev-stack slots: pinned primary"
if command -v git >/dev/null 2>&1; then
  PN="$(mktemp -d)"
  mkdir -p "$PN/home/.config/ghostfleet" "$PN/root/aardvark" "$PN/root/theproj"
  git init -q "$PN/root/aardvark" 2>/dev/null; git init -q "$PN/root/theproj" 2>/dev/null
  # the registered NAME matches no child dir, so <root>/<name> misses and the scan runs
  printf 'mismatch\t%s\twork\n' "$PN/root" > "$PN/home/.config/ghostfleet/projects"
  PIN() { HOME="$PN/home" CLAUDE_FLEET_SLOTS="$PN/slots" "$ROOT/bin/fleet-slot" "$@"; }
  rm -rf "$PN/slots"
  # unpinned: alphabetical order hands 0 to the FOREIGN repo — the hazard, demonstrated
  is "unpinned: the scan takes the first repo" "0" "$(PIN claim "$PN/root/aardvark")"
  rm -rf "$PN/slots"
  printf 'mismatch\t%s\n' "$PN/root/theproj" > "$PN/home/.config/ghostfleet/primaries"
  is "pinned: the named checkout is 0"         "0" "$(PIN claim "$PN/root/theproj")"
  is "pinned: the foreign repo is allocated"   "1" "$(PIN claim "$PN/root/aardvark")"
  rm -rf "$PN"
else
  skip "pinned primary" "git missing"
fi

# A repo that ships .ghostfleet/post-create sets its own worktree up, so the
# node_modules symlink must not ALSO happen. Not merely redundant: in a pnpm workspace
# the root node_modules links workspace packages by RELATIVE path, so a symlinked tree
# resolves every workspace import from the symlink's real location — the MAIN checkout's
# source. Silent cross-tree contamination, and `pnpm install` afterwards would install
# straight through the symlink into that checkout.
group "dev-stack slots: post-create hook"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  HK="$(mktemp -d)"; mkdir -p "$HK/home/.config/ghostfleet" "$HK/stub" "$HK/fleet"
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$HK/stub/agent-here"; chmod +x "$HK/stub/agent-here"
  # $1 = "hook" | "nohook" -> spawns a worktree and reports what it got
  spawnwt() {
    rm -rf "$HK/root" "$HK/slots"; mkdir -p "$HK/root/proj/.ghostfleet"
    git init -q -b main "$HK/root/proj" 2>/dev/null
    git -C "$HK/root/proj" config user.email t@t; git -C "$HK/root/proj" config user.name t
    mkdir -p "$HK/root/proj/node_modules/pretend"     # so the symlink WOULD fire
    printf 'node_modules/\n.ran\n' > "$HK/root/proj/.gitignore"
    if [ "$1" = hook ]; then
      printf '#!/usr/bin/env bash\nprintf "slot=%%s" "${CLAUDE_FLEET_SLOT:-none}" > .ran\n' \
        > "$HK/root/proj/.ghostfleet/post-create"
      chmod +x "$HK/root/proj/.ghostfleet/post-create"
    fi
    git -C "$HK/root/proj" add -A; git -C "$HK/root/proj" commit -qm init 2>/dev/null
    printf 'proj\t%s\twork\n' "$HK/root" > "$HK/home/.config/ghostfleet/projects"
    tmux -L cfhooktest kill-server 2>/dev/null
    ( cd "$HK/root/proj" && HOME="$HK/home" CLAUDE_FLEET_SLOTS="$HK/slots" \
      CLAUDE_FLEET_DIR="$HK/fleet" CLAUDE_FLEET_SOCK=cfhooktest \
      PATH="$HK/stub:$ROOT/bin:$PATH" "$ROOT/bin/fleet-spawn" w1 --new ) >/dev/null 2>&1
    tmux -L cfhooktest kill-server 2>/dev/null
  }
  spawnwt hook
  is "hook: it ran, and saw its slot"     "slot=1" "$(cat "$HK/root/w1/.ran" 2>/dev/null)"
  is "hook: no node_modules symlink"      "0"      "$([ -L "$HK/root/w1/node_modules" ] && echo 1 || echo 0)"
  # the other direction, or "no symlink" would pass for a spawn that simply stopped
  # linking at all
  spawnwt nohook
  is "no hook: the symlink still happens" "1"      "$([ -L "$HK/root/w1/node_modules" ] && echo 1 || echo 0)"
  rm -rf "$HK"
else
  skip "post-create hook" "git/tmux missing"
fi

# ── 4a10. a worker must not spawn workers ────────────────────────────────────
# A session finishes a PR, is told "branch off fresh main", and reaches for the
# orchestrate skill — which spawns. But it is ALREADY in a worktree, so it gets a second
# one beside the first instead of re-branching where it stands. The fleet's shape is
# master in the main checkout and workers as leaves; nesting is never what was meant.
#
# Both directions, because a guard that refused everywhere would "fix" this by breaking
# the only path that is supposed to work.
group "spawning from inside a worktree is refused"
if command -v git >/dev/null 2>&1; then
  WK="$(mktemp -d)"; mkdir -p "$WK/repo"
  git init -q -b main "$WK/repo" 2>/dev/null
  git -C "$WK/repo" config user.email t@t; git -C "$WK/repo" config user.name t
  : > "$WK/repo/f"; git -C "$WK/repo" add -A; git -C "$WK/repo" commit -qm init 2>/dev/null
  git -C "$WK/repo" worktree add -q "$WK/wt-a" -b wt-a 2>/dev/null
  spawn_in() { ( cd "$1" && CLAUDE_FLEET_SOCK=cfnest "$ROOT/bin/fleet-spawn" newone 2>&1 ); }
  out="$(spawn_in "$WK/wt-a")"
  is "refused from a linked worktree"    "1" "$(printf '%s' "$out" | grep -c 'ALREADY in a worktree' || true)"
  is "...and says how to re-branch here" "1" "$(printf '%s' "$out" | grep -c 'checkout -B' || true)"
  is "...and creates nothing"            "0" "$([ -e "$WK/newone" ] && echo 1 || echo 0)"
  # The main checkout is the path that MUST still work — it is where master lives and
  # where every legitimate spawn comes from. It gets as far as the free-worktree refusal
  # (wt-a is clean and sessionless), which is proof it passed the nesting guard.
  out2="$(spawn_in "$WK/repo")"
  is "allowed from the main checkout"    "0" "$(printf '%s' "$out2" | grep -c 'ALREADY in a worktree' || true)"
  is "...reaching spawn's own free-list" "1" "$(printf '%s' "$out2" | grep -c 'free worktree' || true)"
  # and the override is a real escape hatch, not decoration
  out3="$( cd "$WK/wt-a" && CLAUDE_FLEET_ALLOW_NESTED=1 CLAUDE_FLEET_SOCK=cfnest "$ROOT/bin/fleet-spawn" newone 2>&1 )"
  is "override gets past the guard"      "0" "$(printf '%s' "$out3" | grep -c 'ALREADY in a worktree' || true)"
  rm -rf "$WK"
else
  skip "worker nesting guard" "git missing"
fi

# ── 4a10b. the built-in EnterWorktree must not move a fleet session ──────────
# Claude Code's own worktree tool CREATES the tree and RELOCATES THE CALLING SESSION
# into it. Told "start a worktree and open a PR", a master reached for it: the worktree
# appeared, master walked off its own checkout, and the thread the user was talking to
# was suddenly somewhere else. It looks half-right, so it went unnoticed twice.
# fleet-spawn's nesting guard can't catch it — fleet-spawn was never called.
#
# Both directions, and then some: a guard that blocked everything would "fix" this by
# breaking plain Claude Code outside a fleet, by trapping an already-moved session with
# no way back (ExitWorktree), and by refusing every other tool in the session.
group "EnterWorktree is refused in a fleet"
if command -v git >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  GW="$(mktemp -d)"
  git init -q -b main "$GW/repo" 2>/dev/null
  git -C "$GW/repo" config user.email t@t; git -C "$GW/repo" config user.name t
  : > "$GW/repo/f"; git -C "$GW/repo" add -A; git -C "$GW/repo" commit -qm init 2>/dev/null
  git -C "$GW/repo" worktree add -q "$GW/wt-a" -b wt-a 2>/dev/null
  # Start from a CLEAN env every time, then set only what the case is about. The suite
  # itself usually runs inside a fleet, so an inherited $TMUX / $CLAUDE_FLEET_SOCK would
  # make "allowed outside a fleet" pass or fail on where it ran, not on the code.
  guard() { local json="$1"; shift
    GOUT="$(printf '%s' "$json" | env -u TMUX -u CLAUDE_FLEET_SOCK \
      -u CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE "$@" bash "$ROOT/hooks/fleet-guard.sh" 2>&1)"; GRC=$?; }
  j() { printf '{"hook_event_name":"%s","tool_name":"%s","cwd":"%s"}' "$1" "$2" "$3"; }
  has() { printf '%s' "$GOUT" | grep -c -- "$1" || true; }

  guard "$(j PreToolUse EnterWorktree "$GW/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "blocked in a fleet (exit 2 = block)"  "2" "$GRC"
  is "...and hands over fleet-spawn"        "1" "$(has 'fleet-spawn <name>')"
  is "...and says it would MOVE this one"   "1" "$(has 'MOVE THIS SESSION')"

  # A worker is a leaf: the answer there is re-branch in place, not spawn a worker.
  guard "$(j PreToolUse EnterWorktree "$GW/wt-a")" CLAUDE_FLEET_SOCK=cf-x
  is "blocked inside a linked worktree too" "2" "$GRC"
  is "...and says re-branch where you are"  "1" "$(has 'checkout -B')"
  is "...and does NOT offer fleet-spawn"    "0" "$(has 'fleet-spawn <name>')"

  # ── the directions that prove the guard isn't just "deny everything" ──
  guard "$(j PreToolUse EnterWorktree "$GW/repo")"
  is "allowed outside a fleet"              "0" "$GRC"
  is "...and stays silent there"            ""  "$GOUT"

  guard "$(j PreToolUse ExitWorktree "$GW/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "ExitWorktree is never blocked"        "0" "$GRC"

  guard "$(j PreToolUse Bash "$GW/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "other tools pass through"             "0" "$GRC"

  guard "$(j Stop EnterWorktree "$GW/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "only PreToolUse is inspected"         "0" "$GRC"

  guard "$(j PreToolUse EnterWorktree "$GW/repo")" CLAUDE_FLEET_SOCK=cf-x CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1
  is "the override is a real escape hatch"  "0" "$GRC"

  # The installer shares PreToolUse with whatever the user already had there.
  WIRED="$(printf '%s' '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/mine"}]}]}}' \
    | jq -c --arg guard /G '.hooks.PreToolUse = ([ (.hooks.PreToolUse // [])[]
          | select([.hooks[]?.command] | index($guard) | not) ]
        + [ { matcher: "EnterWorktree", hooks: [ { type: "command", command: $guard } ] } ])')"
  is "wiring keeps a foreign PreToolUse hook" "1" "$(printf '%s' "$WIRED" | grep -c '/mine' || true)"
  RE="$(printf '%s' "$WIRED" | jq -c --arg guard /G '.hooks.PreToolUse = ([ (.hooks.PreToolUse // [])[]
          | select([.hooks[]?.command] | index($guard) | not) ]
        + [ { matcher: "EnterWorktree", hooks: [ { type: "command", command: $guard } ] } ])')"
  is "...and re-installing does not stack up" "1" "$(printf '%s' "$RE" | grep -o '/G' | grep -c . || true)"
  rm -rf "$GW"
else
  skip "EnterWorktree guard" "git or jq missing"
fi

# ── 4a10c. Claude's own worktrees are not ghostfleet's to hand out ────────────
# They are git worktrees like any other, so a stale one lands in the free-list looking
# clean and sessionless. fleet-spawn then shadows itself: it offers a tree you cannot
# sensibly reuse AND refuses to make a new one until you pass --new. Both directions —
# skipping every worktree would be the same bug wearing the opposite sign.
group "free worktrees exclude Claude's own"
if command -v git >/dev/null 2>&1; then
  FW="$(mktemp -d)"
  git init -q -b main "$FW/repo" 2>/dev/null
  git -C "$FW/repo" config user.email t@t; git -C "$FW/repo" config user.name t
  : > "$FW/repo/f"; git -C "$FW/repo" add -A; git -C "$FW/repo" commit -qm init 2>/dev/null
  git -C "$FW/repo" worktree add -q "$FW/repo/.claude/worktrees/aw" -b aw 2>/dev/null
  # the LOCAL fallback: fleet-spawn's own single-repo logic, used when fleet-worktrees
  # isn't reachable. The cross-clone path is covered in its own group below.
  eval "$(sed -n '/^free_worktrees_local() {/,/^}/p' "$ROOT/bin/fleet-spawn")"
  free_worktrees() { free_worktrees_local; }
  GITROOT="$FW/repo"; sess_for() { :; }          # nothing occupied anywhere
  is "a .claude/worktrees tree is not free" "0" "$(free_worktrees | grep -c aw || true)"
  git -C "$FW/repo" worktree add -q "$FW/sib" -b sib 2>/dev/null
  is "a real sibling worktree still is"     "1" "$(free_worktrees | grep -c '^sib ' || true)"
  rm -rf "$FW"
else
  skip "free-worktree exclusion" "git missing"
fi

# ── 4a10d. fleet-clean can actually reclaim what it offers to ────────────────
# Claude LOCKS its worktrees, and the lock outlives the session that set it: plain
# `worktree remove` AND `remove --force` both refuse a locked tree, and `worktree prune`
# skips it. So --agents promised a sweep it could not perform, and the leftover sat
# there forever. Both directions: the default must still keep its hands off.
group "fleet-clean and Claude's locked worktrees"
if command -v git >/dev/null 2>&1; then
  FC="$(mktemp -d)"
  git init -q -b main "$FC/repo" 2>/dev/null
  git -C "$FC/repo" config user.email t@t; git -C "$FC/repo" config user.name t
  : > "$FC/repo/f"; git -C "$FC/repo" add -A; git -C "$FC/repo" commit -qm init 2>/dev/null
  git -C "$FC/repo" worktree add -q "$FC/repo/.claude/worktrees/aw" -b aw 2>/dev/null
  git -C "$FC/repo" worktree lock "$FC/repo/.claude/worktrees/aw" --reason "claude session (pid 99999)" 2>/dev/null
  clean_out() { ( cd "$FC/repo" && env -u TMUX CLAUDE_FLEET_SOCK=cf-t "$ROOT/bin/fleet-clean" "$@" 2>&1 ); }
  d="$(clean_out)"; a="$(clean_out --agents)"
  is "default keeps Claude's worktree"   "1" "$(printf '%s' "$d" | grep -c "keep aw" || true)"
  is "...and plans no removal"           "0" "$(printf '%s' "$d" | grep -c "worktree remove" || true)"
  is "--agents plans to remove it"       "1" "$(printf '%s' "$a" | grep -c "remove aw" || true)"
  is "...with the -f -f a lock requires" "1" "$(printf '%s' "$a" | grep -c "remove --force --force" || true)"
  is "...and is still a DRY RUN"         "1" "$([ -d "$FC/repo/.claude/worktrees/aw" ] && echo 1 || echo 0)"
  rm -rf "$FC"
else
  skip "fleet-clean locked worktrees" "git missing"
fi

# ── 4a11. a session's display label ──────────────────────────────────────────
# The card can be titled something a human chose ("PR 964 doc verify") while the tmux
# session keeps its name. That separation is the whole point: fleet-rename exists to keep
# "worktree basename == session name" true, and fleet-send, the Ctrl-f chord, the
# dev-stack slot and the manifest all key off it. So the label is cosmetic BY
# CONSTRUCTION — a marker file only the card reads — and the card still shows the session
# name, because a card titled "PR 964 doc verify" otherwise tells you nothing to type.
group "session display label"
if command -v tmux >/dev/null 2>&1; then
  LB="$(mktemp -d)"; mkdir -p "$LB/fleet"
  tmux -L cflbltest kill-server 2>/dev/null; tmux -L cflbldrv kill-server 2>/dev/null
  tmux -L cflbltest new-session -d -s master "sleep 120" 2>/dev/null
  # a real worktree whose FOLDER and BRANCH deliberately differ — the case the card used
  # to hide, because it read `branch || folder` and the branch always won
  git init -q -b main "$LB/repo" 2>/dev/null
  git -C "$LB/repo" config user.email t@t; git -C "$LB/repo" config user.name t
  : > "$LB/repo/f"; git -C "$LB/repo" add -A; git -C "$LB/repo" commit -qm init 2>/dev/null
  git -C "$LB/repo" worktree add -q "$LB/wt-folder" -b feature-x 2>/dev/null
  git -C "$LB/repo" worktree add -q "$LB/samename" -b samename 2>/dev/null
  tmux -L cflbltest new-session -d -s w1 -c "$LB/wt-folder" "sleep 120" 2>/dev/null
  tmux -L cflbltest new-session -d -s w2 -c "$LB/samename" "sleep 120" 2>/dev/null
  cardtitle() {                 # the top line of card 1, as drawn
    tmux -L cflbldrv kill-session -t d 2>/dev/null
    tmux -L cflbldrv -f /dev/null new-session -d -s d -x 120 -y 32 \
      "CLAUDE_FLEET_DIR='$LB/fleet' CLAUDE_FLEET_ROOT= CLAUDE_FLEET_SCOPE=lbl node '$ROOT/bin/fleet-grid.mjs' cflbltest >/dev/null" 2>/dev/null
    sleep 2
    # cut at the box rule: a second card sits on the same row, so trimming only a
    # trailing ╮ leaves the whole neighbour attached
    tmux -L cflbldrv capture-pane -p -t d 2>/dev/null | grep -E '^ ╭─ 1 ' | head -1 | sed 's/^ ╭─ 1 //; s/ *─.*$//'
    tmux -L cflbldrv kill-session -t d 2>/dev/null
  }
  cardline2() {
    tmux -L cflbldrv kill-session -t d 2>/dev/null
    tmux -L cflbldrv -f /dev/null new-session -d -s d -x 120 -y 32 \
      "CLAUDE_FLEET_DIR='$LB/fleet' CLAUDE_FLEET_ROOT= CLAUDE_FLEET_SCOPE=lbl node '$ROOT/bin/fleet-grid.mjs' cflbltest >/dev/null" 2>/dev/null
    sleep 2
    tmux -L cflbldrv capture-pane -p -t d 2>/dev/null | grep -E '^ │' | sed -n '2p' | sed 's/^ │ //; s/ *│.*$//'
    tmux -L cflbldrv kill-session -t d 2>/dev/null
  }
  # cardline2 reads card 1; w1 sorts first
  rm -f "$LB/fleet/cflbltest.w1.label"
  is "no label: the card is the session name" "w1" "$(cardtitle)"
  # THE WORKTREE LEADS. It was invisible before: a session in "wt-folder" on branch
  # "feature-x" showed only the branch, so the card never said which checkout it was.
  is "worktree first, branch appended"        "wt-folder · feature-x" "$(cardline2)"
  printf 'PR 964 doc verify\n' > "$LB/fleet/cflbltest.w1.label"
  is "labelled: the card is the label"        "PR 964 doc verify" "$(cardtitle)"
  # the session name must stay ON the card — it is what fleet-send takes
  is "...and the session name is still shown" "1" "$(cardline2 | grep -c '^w1 · ' || true)"
  # and the branch is NOT repeated when it says the same thing as the folder
  rm -f "$LB/fleet/cflbltest.w1.label"
  tmux -L cflbltest kill-session -t w1 2>/dev/null
  is "same name: the branch is not repeated"  "samename" "$(cardline2)"
  # a marker keyed by name has to move with a rename, like every other one here
  printf 'keepme\n' > "$LB/fleet/cflbltest.w1.label"
  mv "$LB/fleet/cflbltest.w1.label" "$LB/fleet/cflbltest.w2.label"   # what fleet-rename does
  is "rename carries the label"               "keepme" "$(cat "$LB/fleet/cflbltest.w2.label" 2>/dev/null)"
  is "fleet-rename actually migrates it"      "1" "$(grep -c 'OLD.label' "$ROOT/bin/fleet-rename" || true)"
  is "fleet-stop actually clears it"          "1" "$(grep -c 'SESSION.label' "$ROOT/bin/fleet-stop" || true)"
  tmux -L cflbldrv kill-server 2>/dev/null; tmux -L cflbltest kill-server 2>/dev/null; rm -rf "$LB"
else
  skip "session label" "tmux missing"
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
# exactly five — ` to leave, ⇧←/→ to move focus between panes, ⌃⇧←/→ to move the PANE —
# and ⇧←→ is affordable ONLY because the fleet binds the same session cycle to C-a ←/→ in
# its prefix table, which still passes through. Proven by asking a REAL server what it
# owns. The count is asserted on purpose: it is what makes the next author justify a new
# no-prefix key instead of quietly taking one out of Claude's keyboard.
group "stack config steals only what it must"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cfstktest kill-server 2>/dev/null
  tmux -L cfstktest -f "$ROOT/tmux/cf-stack.tmux.conf" new-session -d -s t "sleep 30" 2>/dev/null
  # tmux's own root table always carries ~24 Mouse*/Wheel*/*Click* bindings. Those are
  # built-ins nothing here manages (and with `mouse on` they are what makes a click
  # focus a pane — asserted separately below); the KEYBOARD entries are what decide
  # whether a keystroke stops at the stack or reaches the fleet inside it.
  root="$(tmux -L cfstktest list-keys -T root 2>/dev/null | grep -vE 'Mouse|Wheel|Click')"
  is "root table binds exactly 5 keys" "5" "$(printf '%s\n' "$root" | grep -c . || true)"
  is "backtick leaves the stack"       "1" "$(printf '%s\n' "$root" | grep -c -- '-T root ` *detach-client' || true)"
  # These three still have to reach the fleet: they write a .goto marker and detach.
  for k in C-s C-p C-f; do
    is "no-prefix $k passes through"   "0" "$(printf '%s\n' "$root" | grep -cE "root +$k " || true)"
  done
  # ⇧←→ must select a PANE (:.+/:.- wrap; -L/-R dead-end on the edge pane) and must not
  # be anything that detaches — a stack you leave by moving right is not navigation.
  is "S-Right selects the next pane"   "1" "$(printf '%s\n' "$root" | grep -cE "root +S-Right +select-pane -t '?:\.\+" || true)"
  is "S-Left selects the previous one" "1" "$(printf '%s\n' "$root" | grep -cE "root +S-Left +select-pane -t '?:\.-" || true)"
  # ⌃⇧←→ MOVES the pane. Two keys apart from the pair above and no printable character —
  # ⇧HJKL, which is what the grid uses for the same job, cannot be bound here at all:
  # Shift+H is not a keycode, it is capital H, and this server would then eat every
  # capital H, J, K and L typed into any Claude pane in the stack.
  is "C-S-Right moves the pane right"  "1" "$(printf '%s\n' "$root" | grep -cE "root +C-S-Right +run-shell .*fleet-stack move right" || true)"
  is "C-S-Left moves it left"          "1" "$(printf '%s\n' "$root" | grep -cE "root +C-S-Left +run-shell .*fleet-stack move left" || true)"
  is "no capital letter is bound"      "0" "$(printf '%s\n' "$root" | grep -cE "root +[A-Z] " || true)"
  # It has to name the pane by TTY. A member name would move the wrong pane as soon as two
  # sessions of one project are stacked side by side, or the lead cycles a pane (C-a ←/→)
  # to a session other than the one it was opened on.
  is "...naming the pane by its tty"   "2" "$(printf '%s\n' "$root" | grep -c 'pane_tty' || true)"
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

# ── 4b2. reordering the stack ────────────────────────────────────────────────
# The panes are built in stack.tsv's row order (read_live hands open_stack its members in
# file order), so a reorder that only moved panes would EVAPORATE on the next open: the
# window reflows and the file puts everything straight back where it was. Both writes
# therefore apply ONE decision — swap_plan turns "move the pane at position P one slot"
# into adjacent swaps, reorder_rows applies that same list to the file's rows — and this
# group drives that pair directly, the way the wire-format group drives split_choice. No
# tmux, because the arithmetic is where a wrap goes wrong.
group "stack reorder (the file's rows)"
T="$(mktemp -d)"; TSV="$T/stack.tsv"
eval "$(sed -n '/^valid_line() {/,/^}/p;/^read_all() {/,/^}/p;/^swap_plan() {/,/^}/p;/^reorder_rows() {/,/^}/p' "$ROOT/bin/fleet-stack")"
PANES() { printf 'cf-a\tone\ncf-b\ttwo\ncf-c\tthree\n'; }     # what is on screen, left to right
RO() { PANES | reorder_rows "$1" "$2" | tr '\t' ':' | tr '\n' ' '; }
PLAN() { swap_plan "$1" "$2" "$3" | tr '\n' '/' | sed 's|/$||'; }
PANES > "$TSV"
is "an inside move is one swap"        "1 2"     "$(PLAN right 1 3)"
is "off the end is a walk across"      "2 1/1 0" "$(PLAN right 2 3)"
is "a stack of one has no plan"        "1"       "$(swap_plan right 0 1 >/dev/null 2>&1; echo $?)"
is "moving the middle pane right"      "cf-a:one cf-c:three cf-b:two "  "$(RO right 1)"
is "moving the middle pane left"       "cf-b:two cf-a:one cf-c:three "  "$(RO left 1)"
# Wrapping matches the ⇧←→ focus ring: the moved pane comes out the other side and the
# REST SLIDE ONE PLACE. Asserted as the whole row, because swapping the two END panes
# would also "wrap" — and would fling a pane the lead never touched across the screen.
is "off the left end the rest slide"   "cf-b:two cf-c:three cf-a:one "  "$(RO left 0)"
is "off the right end, likewise"       "cf-c:three cf-a:one cf-b:two "  "$(RO right 2)"
# Why the move is computed over PANES and not over file order. A row whose session has
# died keeps its place in the file — nothing prunes it, read_live just skips it — so file
# order and pane order are different lists. Walking file order would spend the keypress
# swapping a pane with a row that is not on screen: the file would change, the window
# would not, and one keystroke would mean two different things.
printf 'cf-x\tdead\ncf-a\tone\ncf-b\ttwo\ncf-c\tthree\n' > "$TSV"
is "a paneless row keeps its slot"     "cf-x:dead cf-b:two cf-a:one cf-c:three "  "$(RO right 0)"
printf 'cf-a\tone\ncf-x\tdead\ncf-b\ttwo\ncf-c\tthree\n' > "$TSV"
is "...even sitting between two panes" "cf-b:two cf-x:dead cf-a:one cf-c:three "  "$(RO right 0)"
# A pane whose row has gone (`fleet-stack remove` from a shell, with the stack open) must
# refuse: rewriting the file from the panes alone would drop that member from the stack.
printf 'cf-a\tone\ncf-c\tthree\n' > "$TSV"
is "a pane with no row refuses"        "1"  "$(PANES | reorder_rows right 0 >/dev/null 2>&1; echo $?)"
is "...and writes nothing"             ""   "$(PANES | reorder_rows right 0 2>/dev/null)"
rm -rf "$T"; unset TSV

# A right file with a wrong window is the same bug as the reverse, so this drives the real
# `fleet-stack move` against real panes and asserts BOTH after every press — plus the two
# things a bare swap-pane gets wrong: which pane keeps the focus, and whether the border
# labels travel with the pane or stay with the slot they were set on.
group "stack reorder (real panes and the file together)"
if command -v tmux >/dev/null 2>&1; then
  T="$(mktemp -d)"; MS=cfmvpane      # never cf-stack: that socket is the lead's live screen
  tmux -L $MS kill-server 2>/dev/null
  tmux -L $MS -f "$ROOT/tmux/cf-stack.tmux.conf" new-session -d -s stack -x 200 -y 50 "sleep 120" 2>/dev/null
  tmux -L $MS split-window -h -t stack "sleep 120" 2>/dev/null
  tmux -L $MS split-window -h -t stack "sleep 120" 2>/dev/null
  tmux -L $MS select-layout -t stack even-horizontal 2>/dev/null
  # exactly what open_stack stamps: which member each pane is, and which profile's
  # stack.tsv the stack was opened from
  mi=0
  for m in one two three; do
    tmux -L $MS set-option -p -t "stack.$mi" @cf_sock "cf-$m" 2>/dev/null
    tmux -L $MS set-option -p -t "stack.$mi" @cf_sess master 2>/dev/null
    tmux -L $MS select-pane -t "stack.$mi" -T "$m · master" 2>/dev/null
    mi=$((mi + 1))
  done
  tmux -L $MS set-option -g @cf_fleet_dir "$T" 2>/dev/null
  tmux -L $MS select-pane -t stack.0 2>/dev/null
  printf 'cf-one\tmaster\ncf-two\tmaster\ncf-three\tmaster\n' > "$T/stack.tsv"
  MSOCK="$(tmux -L $MS display-message -p '#{socket_path}' 2>/dev/null)"
  pn() { tmux -L $MS list-panes -t "=stack" -F '#{@cf_sock}' 2>/dev/null | tr '\n' ' '; }
  fl() { tr '\n' ' ' < "$T/stack.tsv" | sed 's/	master//g'; }
  ac() { tmux -L $MS list-panes -t "=stack" -F '#{?pane_active,#{@cf_sock},}' 2>/dev/null | tr -d ' \n'; }
  ti() { tmux -L $MS list-panes -t "=stack" -F '#{pane_title}' 2>/dev/null | tr '\n' ' '; }
  # the tty of the pane with the focus is what a binding hands over, from either side of
  # the nest (`#{pane_tty}` from the stack, `#{client_tty}` from the session inside it)
  MV() { "$ROOT/bin/fleet-stack" move "$1" \
           "$(tmux -L $MS list-panes -t '=stack' -F '#{?pane_active,#{pane_tty},}' 2>/dev/null | tr -d ' \n')" \
           "$MSOCK" 2>&1; }
  is "the panes start in file order"    "cf-one cf-two cf-three " "$(pn)"
  MV right >/dev/null 2>&1
  is "moving right moves the pane"      "cf-two cf-one cf-three " "$(pn)"
  is "...and the file says the same"    "cf-two cf-one cf-three " "$(fl)"
  is "...and the focus goes WITH it"    "cf-one"                  "$(ac)"
  is "...and the labels travel too"     "two · master one · master three · master " "$(ti)"
  MV right >/dev/null 2>&1
  is "again, to the last slot"          "cf-two cf-three cf-one " "$(pn)"
  MV right >/dev/null 2>&1
  is "off the end it wraps on screen"   "cf-one cf-two cf-three " "$(pn)"
  is "...and in the file"               "cf-one cf-two cf-three " "$(fl)"
  is "...still holding the focus"       "cf-one"                  "$(ac)"
  MV left >/dev/null 2>&1
  is "and the other way round"          "cf-two cf-three cf-one " "$(pn)"
  is "...file agreeing"                 "cf-two cf-three cf-one " "$(fl)"
  # A tty that is no pane of this stack is the chord pressed OUTSIDE the stack. It must say
  # so: reordering a stack the lead isn't looking at is worse than doing nothing, and doing
  # nothing silently is indistinguishable from a broken binding.
  is "an unknown tty refuses"           "1" "$("$ROOT/bin/fleet-stack" move right /dev/null "$MSOCK" >/dev/null 2>&1; echo $?)"
  is "...saying which pane it wanted"   "1" "$("$ROOT/bin/fleet-stack" move right /dev/null "$MSOCK" 2>&1 | grep -c 'not a pane' || true)"
  is "...and leaves the file alone"     "cf-two cf-three cf-one " "$(fl)"
  # A stack opened by an older ghostfleet has no stamps at all. Reordering it would have to
  # guess which row a pane is, so it refuses instead — and says how to fix it.
  tmux -L $MS set-option -pu -t stack.0 @cf_sock 2>/dev/null
  is "an unstamped pane refuses"        "1" "$(MV right >/dev/null 2>&1; echo $?)"
  is "...and the file is untouched"     "cf-two cf-three cf-one " "$(fl)"
  tmux -L $MS kill-server 2>/dev/null; rm -rf "$T"
else
  skip "stack reorder (real panes)" "tmux not available"
fi

# The prefixed form, which is the one that works in every terminal: Apple Terminal sends
# nothing for ⌃⇧← (it emits a bare ESC [ D, the same bytes as an unmodified ←), so the
# stack's own binding is dead weight there. C-a reaches the fleet from inside a stack
# because the stack runs `prefix None`. Two directions matter here: the chord must be in
# the PREFIX table, and `<`/`>`/`{`/`}` must NOT be in the root table — they are printable
# characters, and a fleet that answered them would swallow every one typed into Claude.
group "stack reorder chord (fleet prefix table)"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cfmvchord kill-server 2>/dev/null
  tmux -L cfmvchord -f "$ROOT/tmux/cf.tmux.conf" new-session -d -s master 'sleep 60' 2>/dev/null
  pk() { tmux -L cfmvchord list-keys -T prefix 2>/dev/null | grep -E "^bind-key +-T prefix +\\\\?$1 " || true; }
  is "C-a > moves the pane right"   "1" "$(pk '>' | grep -c 'fleet-stack move right' || true)"
  is "C-a < moves it left"          "1" "$(pk '<' | grep -c 'fleet-stack move left'  || true)"
  is "C-a } does too (tmux's own)"  "1" "$(pk '}' | grep -c 'fleet-stack move right' || true)"
  is "C-a { likewise"               "1" "$(pk '{' | grep -c 'fleet-stack move left'  || true)"
  is "...named by the client's tty" "4" "$(tmux -L cfmvchord list-keys -T prefix 2>/dev/null | grep -c 'fleet-stack move .*client_tty' || true)"
  root="$(tmux -L cfmvchord list-keys -T root 2>/dev/null)"
  for c in '<' '>' '{' '}'; do
    is "a bare $c still reaches the agent" "0" "$(printf '%s\n' "$root" | grep -cF -- "-T root $c " || true)"
  done
  tmux -L cfmvchord kill-server 2>/dev/null
else
  skip "stack reorder chord" "tmux not available"
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
  # The answer is written AFTER arming, because that is the only order a real turn can
  # have: the prompt starts the turn, the turn produces the message. It matters now that
  # arming records where the transcript had got to and the relay reads only what came
  # after — a fixture whose answer predates the arming is a turn that answered before it
  # was asked, and gets the "(no text)" it deserves.
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"the write-back is suppressed by the sync"}]}}' >> "$TRF"
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

# ── 4c2. two paths, one answer ────────────────────────────────────────────────
# The relay above is a nine-link chain and every link drops the answer in SILENCE: the
# turn must end (a usage limit, an interrupt or a killed session means it never does), the
# row must be drained, and the wake that says "drain it" is skipped outright while the
# asker is BUSY — the moment a lead is most likely to be waiting on one. So fleet-send now
# asks the target to answer the asker BY NAME with SendMessage, which lands in its session
# regardless. Both paths live at once, which is a new way to be wrong: a target that obeys
# would answer twice, the second time by pasting into the asker's input box.
#
# Suppression must therefore be exact, and it is asserted in BOTH directions — a rule that
# fires too eagerly recreates the silence it was written to fix. The transcript fixtures
# are verbatim lines from real sessions: one delivery that succeeded, and one addressed to
# a name that does not exist (which is what a session with no peer name looks like).
group "reply relay (a direct answer replaces the row)"
if command -v jq >/dev/null 2>&1; then
  # the shipped detector, lifted out of the hook — change it there and these go red
  eval "$(sed -n '/^_peer_answered() {/,/^}/p' "$ROOT/hooks/fleet-event.sh")"
  OK="$FIX/reply-sendmessage-ok.jsonl"              # → cftest/receiver, {"success":true}
  NO="$FIX/reply-sendmessage-failed.jsonl"          # → a name nothing answers, success:false
  NO_TU="$(sed -n 1p "$NO")"; NO_TR="$(sed -n 2p "$NO")"
  pa() { _peer_answered "$1" "$2" "$3" && echo 1 || echo 0; }
  is "a delivered answer counts"        "1" "$(pa "$OK" 0 'cftest/receiver')"
  # the whole point of matching the recipient: a target that messaged somebody else has
  # not answered US, and treating that as an answer is a dropped one
  is "...only for OUR address"          "0" "$(pa "$OK" 0 'ask/master')"
  # A CALL IS NOT A DELIVERY. This is the case the fallback exists for — the asker isn't
  # an addressable peer (started before it had a name, or renamed since), the tool says
  # so, and suppressing here would strand the answer.
  is "an unreachable name doesn't"      "0" "$(pa "$NO" 0 'zzz-no-such-peer-9f3a/nobody')"
  # Scoped to THIS turn. The address survives across turns until it's answered, so an
  # unscoped search finds the SendMessage that answered the PREVIOUS question and eats
  # this one. Arming records where the transcript had got to; a turn starting after those
  # lines must not see them.
  is "...and only within this turn"     "0" "$(pa "$OK" "$(grep -c . "$OK")" 'cftest/receiver')"
  # Everything unknown falls toward DELIVERING: a duplicate is annoying, a drop is the bug.
  is "no transcript -> relay"           "0" "$(pa "$FIX/nope.jsonl" 0 'cftest/receiver')"
  is "no arming offset -> relay"        "0" "$(pa "$OK" "" 'cftest/receiver')"
  is "no address -> relay"              "0" "$(pa "$OK" 0 '')"

  # ...and the same thing end to end, through the real hook: the row that does NOT get
  # written, and the one that still does.
  T="$(mktemp -d)"; RF="$T/resp/fleet"; AF="$T/ask/fleet"; mkdir -p "$RF" "$AF"
  US=$'\x1f'; TRF="$T/t.jsonl"; asked="$AF/cf-cftest.inbox"
  fire()  {
    printf '{"hook_event_name":"%s","session_id":"sid1","cwd":"%s","transcript_path":"%s","message":""}' \
      "$1" "$T" "$TRF" \
    | env -u TMUX CLAUDE_FLEET_DIR="$RF" CLAUDE_FLEET_SOCK=cf-resp CLAUDE_FLEET_SLOT=w1 \
          CLAUDE_FLEET_NOTIFIER=off "$ROOT/hooks/fleet-event.sh" >/dev/null 2>&1
  }
  rows()  { grep -c . "$1" 2>/dev/null || true; }
  # The asker is cf-cftest/receiver, so its peer name is exactly the one the fixture was
  # captured answering. The transcript is that delivery plus a closing message, which is
  # what the fallback would have relayed.
  turn()  { cat "$1" > "$TRF"
            printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"yes — deduped by externalId"}]}}' >> "$TRF"
            printf '%s\n' "cf-cftest${US}receiver${US}$AF" > "$RF/cf-resp.w1.reply-to"
            printf '%s\n' "${2:-0}" > "$RF/cf-resp.w1.reply-to.armed"; : > "$asked"; }
  turn "$OK"; fire Stop
  is "a delivered answer: no row"       "0" "$(rows "$asked")"
  is "...and the address is consumed"   "0" "$(ls "$RF" 2>/dev/null | grep -c 'reply-to' || true)"
  # SAME transcript, turn armed AFTER the delivery: that SendMessage belongs to an earlier
  # question, so this turn is unanswered and the row must land.
  turn "$OK" "$(grep -c . "$OK")"; fire Stop
  is "a previous turn's delivery: row"  "1" "$(rows "$asked")"
  # SAME shape, delivery REFUSED: the fallback is the only path left.
  turn "$NO"; fire Stop
  is "an undelivered answer: row"       "1" "$(rows "$asked")"
  is "...carrying the answer's text"    "1" "$(matches 'deduped by externalId' "$asked")"
  # AND IT MUST BE THIS TURN'S ANSWER. "The last assistant text in the file" is not the same
  # thing, and the difference is not theoretical: seen on a live fleet, the final message
  # landed in the transcript in the same second the Stop hook ran and lost the race, so a
  # question about 7+5 was answered `4` — the PREVIOUS turn's answer, relayed with complete
  # confidence and nothing in the row to reveal it.
  prev='{"type":"assistant","message":{"content":[{"type":"text","text":"4"}]}}'
  here='{"type":"assistant","message":{"content":[{"type":"text","text":"12"}]}}'
  mkturn() {                    # $@ = the lines this turn added, after a one-line history
    printf '%s\n' "$prev" > "$TRF"
    for l in "$@"; do printf '%s\n' "$l" >> "$TRF"; done
    printf '%s\n' "cf-cftest${US}receiver${US}$AF" > "$RF/cf-resp.w1.reply-to"
    printf '1\n' > "$RF/cf-resp.w1.reply-to.armed"; : > "$asked"
  }
  mkturn "$NO_TU" "$NO_TR" "$here"; fire Stop
  # trailing space: the extraction flattens the message's own newline into one (existing
  # behaviour of every relayed row), so compare the trimmed detail
  is "the row carries THIS turn's text" "12" \
     "$(awk -F'\t' 'NR==1{print $4}' "$asked" 2>/dev/null | sed 's/[[:space:]]*$//')"
  # A turn that ended on a tool call has no answer to relay. Saying so points the asker at
  # fleet-read; reaching back for an older message answers it with something that was never
  # the answer to this question.
  mkturn "$NO_TU" "$NO_TR"; fire Stop
  is "no text this turn -> says so"     "1" "$(matches 'no text' "$asked")"
  is "...never an older answer"         "0" "$(awk -F'\t' 'NR==1{print $4}' "$asked" 2>/dev/null | grep -c '^4$' || true)"
  # An offset the transcript cannot contain has outlived the file it was counted against —
  # a session killed mid-question and brought back on another one. Unknown, not "said
  # nothing": scoping to it would relay "(no text)" for a turn that answered perfectly.
  mkturn "$NO_TU" "$NO_TR" "$here"; printf '9999\n' > "$RF/cf-resp.w1.reply-to.armed"
  fire Stop
  is "a stale offset falls back"        "12" \
     "$(awk -F'\t' 'NR==1{print $4}' "$asked" 2>/dev/null | sed 's/[[:space:]]*$//')"
  # Arming is what records the offset, and it must be the transcript's CURRENT length —
  # an empty marker (what older code wrote) means "unknown", which relays.
  printf 'a\nb\nc\n' > "$TRF"
  printf '%s\n' "cf-cftest${US}receiver${US}$AF" > "$RF/cf-resp.w1.reply-to"
  rm -f "$RF/cf-resp.w1.reply-to.armed"; fire UserPromptSubmit
  is "arming records the turn's start"  "3" "$(cat "$RF/cf-resp.w1.reply-to.armed" 2>/dev/null)"
  rm -rf "$T"
else
  skip "direct answer suppression" "jq not available"
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
  # Named by its PEER name (cf- stripped), not by its socket: that is the string Claude
  # Code's SendMessage can address, the same one claude-here passes as --name and the hook
  # prints in an inbox row. Telling the target "cf-ask/master" would name nothing.
  is "the target is told who asked"    "1" "$(printf '%s\n' "$buf" | grep -c 'from another agent (ask/master)' || true)"
  # ...and told to USE it. The turn-ending relay drops the answer in silence whenever the
  # turn doesn't end, isn't drained, or the asker is busy when the wake would fire; a
  # direct message has none of those links. Both halves are asked for on purpose — the
  # relay is the fallback for an asker that isn't an addressable peer.
  is "...and to SendMessage the answer" "1" "$(printf '%s\n' "$buf" | grep -c 'SendMessage with to: "ask/master"' || true)"
  is "...and to end with it too"        "1" "$(printf '%s\n' "$buf" | grep -c 'end your turn with that same answer' || true)"
  is "...and the caller's words last"  "what is the schema" "$(printf '%s\n' "$buf" | tail -1)"
  # A NON-CLAUDE target has no SendMessage, so the instruction it can act on is the old
  # one. Asserted because the wrong half of this branch is invisible: codex would simply
  # ignore a tool it doesn't have, and look like it ignored the question.
  #   Its OWN session, and its own pane: capture-pane reads whatever is still on screen, so
  # asserting "SendMessage is absent" in the pane that was just sent the claude wording
  # passes for the wrong reason — it found the previous send. (It did, first time round.)
  # The busy line is codex's, not claude's, or fleet-send waits out its submit-confirm loop
  # against a pane no agent is reading.
  tmux -L cffsend new-session -d -x 200 -y 40 -s cdx \
    "printf 'Working (12s · esc to interrupt\n'; sleep 30" 2>/dev/null
  sleep 0.4
  printf 'codex\n' > "$RF/cffsend.cdx.agent"
  PATH="$ROOT/bin:$PATH" FSEND --reply-to "cf-ask/master" --reply-dir "$AF" cdx "codex question" >/dev/null 2>&1
  cbuf="$(tmux -L cffsend capture-pane -p -t cdx 2>/dev/null | grep -v '^[[:space:]]*$')"
  is "a codex target isn't told to"     "0" "$(printf '%s\n' "$cbuf" | grep -c 'call SendMessage' || true)"
  is "...it gets the relay wording"     "1" "$(printf '%s\n' "$cbuf" | grep -c 'relayed back automatically' || true)"
  # and the claude wording really was on the other pane — the assertion above has teeth
  is "...while a claude target is"      "1" "$(printf '%s\n' "$buf" | grep -c 'call SendMessage' || true)"
  rm -f "$RF/cffsend.cdx.agent" "$RF/cffsend.cdx.reply-to"
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

# ── 4c3. a fleet session is addressable by name ───────────────────────────────
# Claude Code names every session for its cross-session messaging, and left alone it
# DERIVES that name from the directory: broker-agencies-61, getmycoi-06, platform-4b.
# Nothing in the fleet knows those, so "reply to master" named nothing and the direct
# reply path could not be used at all. claude-here now passes the address the fleet
# already uses, <project>/<session> — the same string fleet-send computes for --reply-to
# and the hook prints in an inbox row.
#
# Both directions, because a HALF name is worse than none: "/master" or "superkey/" is
# unaddressable and would still displace the derived one, so a session missing either half
# must go unnamed rather than named wrongly.
group "peer name (claude-here --name)"
CH="$(mktemp -d)"; mkdir -p "$CH/bin" "$CH/cfg" "$CH/work" "$CH/fleet"
# stand in for claude and report the argv it was handed
printf '#!/bin/sh\nfor a in "$@"; do printf "%%s\\n" "$a"; done\n' > "$CH/bin/claude"
chmod +x "$CH/bin/claude"
ARGV() {                        # $1 = CLAUDE_FLEET_SOCK ("" = unset), rest = claude-here argv
  local sock="$1"; shift
  ( cd "$CH/work" && env -u ZELLIJ_SESSION_NAME -u CLAUDE_FLEET_SLOT -u CLAUDE_FLEET_MODEL \
      -u CLAUDE_FLEET_RESUME -u CLAUDE_FLEET_FRESH \
      PATH="$CH/bin:$PATH" CLAUDE_CONFIG_DIR="$CH/cfg" CLAUDE_FLEET_DIR="$CH/fleet" \
      CLAUDE_FLEET_SOCK="$sock" \
      /bin/bash "$ROOT/bin/claude-here" "$@" 2>/dev/null ) | tr '\n' ' '
}
NAMED() { ARGV "$@" | sed -n 's/.*--name \([^ ]*\).*/\1/p'; }
is "named <project>/<session>"        "superkey/master" "$(NAMED cf-superkey master)"
# The SAME expansion fleet-send uses (${sock#cf-}), so a socket without the prefix spells
# one name on both sides instead of two that never meet.
is "...however the socket is spelled" "weird/master"    "$(NAMED weird master)"
is "no socket -> no name"             ""                "$(NAMED '' master)"
is "no session -> no name"           ""                 "$(NAMED cf-superkey)"
# A name has to be spellable back at us: fleet-send refuses these characters in a reply
# address, and Claude Code renames a session whose name it won't take.
is "an unspellable name is dropped"   ""                "$(NAMED cf-superkey 'mas ter')"
# The caller's own --name wins, and a second one would be an argument error.
is "an explicit --name is left alone" "boss"            "$(NAMED cf-superkey master -- --name boss)"
is "...and never doubled"             "1" \
   "$(ARGV cf-superkey master -- --name boss | tr ' ' '\n' | grep -c -- '--name' || true)"
is "...nor in the --name=x spelling"  "1" \
   "$(ARGV cf-superkey master -- --name=boss | tr ' ' '\n' | grep -c -- '--name' || true)"
# THE PATH A FLEET SESSION ACTUALLY TAKES is the resume one — a session is created once
# and re-opened for the rest of its life, so a name that only lands on a fresh start would
# be missing from every session anyone talks to.
enc="$(printf '%s' "$CH/work" | sed 's#[/.]#-#g')"; mkdir -p "$CH/cfg/projects/$enc"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}' \
  > "$CH/cfg/projects/$enc/abc123.jsonl"
res="$(ARGV cf-superkey master)"
is "a resumed session is named too"   "1" "$(printf '%s' "$res" | grep -c -- '--resume abc123' || true)"
is "...with the same name"            "superkey/master" "$(NAMED cf-superkey master)"
rm -rf "$CH"


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
  for s in cfstka cfstkb cfstkdrv cfstkwin; do tmux -L "$s" kill-server 2>/dev/null; done
  # two members on two DIFFERENT servers — the case join-pane cannot do at all
  tmux -L cfstka new-session -d -s master "sleep 120" 2>/dev/null
  tmux -L cfstkb new-session -d -s master "sleep 120" 2>/dev/null
  CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-stack" add cfstka master
  CLAUDE_FLEET_DIR="$T" "$ROOT/bin/fleet-stack" add cfstkb master
  # a driver pane, because `fleet-stack open` attaches and needs a real tty. The stack
  # socket is overridden for the same reason the fleet dir is: the default is `cf-stack`,
  # which is the socket the LEAD's own stack screen runs on — a suite that built its
  # fixture there would tear down a stack somebody is working in, and the failure would
  # land on them and not on the test.
  tmux -L cfstkdrv -f /dev/null new-session -d -s drv -x 160 -y 40 \
    -e CLAUDE_FLEET_DIR="$T" -e CLAUDE_FLEET_STACK_SOCK=cfstkwin "bash --norc" 2>/dev/null
  sleep 1
  tmux -L cfstkdrv send-keys -t drv "'$ROOT/bin/fleet-stack' open" Enter
  sleep 4
  is "one pane per member"        "2" "$(tmux -L cfstkwin list-panes -t stack 2>/dev/null | grep -c . || true)"
  # Every project has a `master`; the pane border is the only thing that can say whose.
  is "panes are labelled by socket" "2" "$(tmux -L cfstkwin list-panes -t stack -F '#{pane_title}' 2>/dev/null | grep -cE '^cfstk[ab] · master$' || true)"
  is "both members have a client" "1 1" "$( { tmux -L cfstka list-sessions -F '#{session_attached}' 2>/dev/null; tmux -L cfstkb list-sessions -F '#{session_attached}' 2>/dev/null; } | tr '\n' ' ' | sed 's/ $//')"
  # Without this, opening a stack silently crops whatever you view full-screen next.
  is "window-size largest on member A" "largest" "$(tmux -L cfstka show-options -gv window-size 2>/dev/null)"
  is "window-size largest on member B" "largest" "$(tmux -L cfstkb show-options -gv window-size 2>/dev/null)"
  # ` leaves the whole stack (the one key the stack's config binds)
  tmux -L cfstkdrv send-keys -t drv '`'
  sleep 3
  is "leaving tears the stack down"    "0" "$(tmux -L cfstkwin list-sessions 2>/dev/null | grep -c . || true)"
  is "member A SURVIVES, detached"     "master 0" "$(tmux -L cfstka list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null)"
  is "member B SURVIVES, detached"     "master 0" "$(tmux -L cfstkb list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null)"

  # `fleet-stack open </dev/tty` — the way every other screen in this repo is invoked,
  # and the way the control plane called it at first. tmux REFUSES a client whose stdin
  # is the /dev/tty alias (`tty </dev/tty` reports the literal "/dev/tty"), so the whole
  # window gets built and then the attach fails. The visible symptom was a one-frame
  # flicker with no error, because the panes really were there. Assert the ATTACH, not
  # just the panes — panes alone were true while it was broken.
  tmux -L cfstkwin kill-server 2>/dev/null
  tmux -L cfstkdrv kill-server 2>/dev/null
  tmux -L cfstkdrv -f /dev/null new-session -d -s drv -x 160 -y 40 \
    -e CLAUDE_FLEET_DIR="$T" -e CLAUDE_FLEET_STACK_SOCK=cfstkwin "bash --norc" 2>/dev/null
  sleep 1
  tmux -L cfstkdrv send-keys -t drv "'$ROOT/bin/fleet-stack' open </dev/tty" Enter
  sleep 4
  is "opens with stdin on /dev/tty too" "stack" "$(tmux -L cfstkwin list-clients -F '#{client_session}' 2>/dev/null)"
  tmux -L cfstkdrv send-keys -t drv '`'; sleep 2

  for s in cfstka cfstkb cfstkdrv cfstkwin; do tmux -L "$s" kill-server 2>/dev/null; done
  rm -rf "$T"
else
  skip "stack window" "tmux not available"
fi

# And through the whole nest, with real keys — the only thing that can prove the chord
# ARRIVES. Terminal → stack tmux → fleet tmux → the pane: C-a has to pass through the
# stack (`prefix None`) to reach the fleet, whose prefix table runs fleet-stack against
# the stack it is nested in. A binding that never fires is indistinguishable from one
# that works, and this one crosses two servers to do its job.
group "stack reorder through the nest (real keys)"
if command -v tmux >/dev/null 2>&1; then
  T="$(mktemp -d)"; NF=cfmvfleet; NK=cfmvnest; ND=cfmvdrv
  for s in $NF $NK $ND; do tmux -L "$s" kill-server 2>/dev/null; done
  # A fleet server with the REAL config, so C-a is its prefix. @cf_bin points the binding
  # at THIS checkout instead of the installed runtime. CLAUDE_FLEET_STACK_SOCK is exported
  # into the server's own environment on purpose: a binding's run-shell inherits the
  # server's env and not the env of whoever attached, which is exactly why production
  # never reads it from there — it takes the default socket, and takes the fleet DIR from
  # an option on the stack server instead.
  for s in master worker-1 worker-2; do
    CLAUDE_FLEET_STACK_SOCK=$NK tmux -L $NF -f "$ROOT/tmux/cf.tmux.conf" \
      new-session -d -s "$s" -x 200 -y 50 "sleep 200" 2>/dev/null
  done
  tmux -L $NF set-option -g @cf_bin "$ROOT/bin" 2>/dev/null
  printf '%s\tmaster\n%s\tworker-1\n%s\tworker-2\n' $NF $NF $NF > "$T/stack.tsv"
  tmux -L $ND -f /dev/null new-session -d -s drv -x 200 -y 50 \
    -e CLAUDE_FLEET_DIR="$T" -e CLAUDE_FLEET_STACK_SOCK=$NK "bash --norc" 2>/dev/null
  sleep 1
  tmux -L $ND send-keys -t drv "'$ROOT/bin/fleet-stack' open" Enter
  sleep 4
  np() { tmux -L $NK list-panes -t "=stack" -F '#{@cf_sess}' 2>/dev/null | tr '\n' ' '; }
  nf() { tr '\n' ' ' < "$T/stack.tsv" | sed "s/$NF	//g"; }
  na() { tmux -L $NK list-panes -t "=stack" -F '#{?pane_active,#{@cf_sess},}' 2>/dev/null | tr -d ' \n'; }
  nk() { for a in "$@"; do tmux -L $ND send-keys "$a" 2>/dev/null; sleep 1; done; }
  is "the nested stack opens in file order" "master worker-1 worker-2 " "$(np)"
  nk C-a '>'
  is "C-a > reaches the fleet and moves it" "worker-1 master worker-2 " "$(np)"
  is "...and rewrites the file"             "worker-1 master worker-2 " "$(nf)"
  is "...leaving the lead in the same pane" "master"                    "$(na)"
  nk C-a '>'
  is "...again, to the far end"             "worker-1 worker-2 master " "$(np)"
  # A bare > is a printable character and MUST reach the agent: if either server answered
  # it, nobody in the stack could type one.
  nk '>'
  is "a bare > moves nothing"               "worker-1 worker-2 master " "$(np)"
  # ⌃⇧← as the bytes a terminal that has it would send. Apple Terminal does NOT (it emits
  # a bare ESC [ D — see tmux/cf-stack.tmux.conf), which is why the chord above exists.
  tmux -L $ND send-keys -l "$(printf '\033[1;6D')" 2>/dev/null; sleep 1
  is "the raw C-S-Left sequence fires too"  "worker-1 master worker-2 " "$(np)"
  is "...and the file follows"              "worker-1 master worker-2 " "$(nf)"
  # The whole point of writing the file: leaving must not lose the arrangement.
  tmux -L $ND send-keys '`'; sleep 3
  is "leaving still tears the stack down"   "0" "$(tmux -L $NK list-sessions 2>/dev/null | grep -c . || true)"
  tmux -L $ND send-keys -t drv "'$ROOT/bin/fleet-stack' open" Enter
  sleep 4
  is "and it reopens in the ORDER SET"      "worker-1 master worker-2 " "$(np)"
  tmux -L $ND send-keys '`'; sleep 2
  for s in $NF $NK $ND; do tmux -L "$s" kill-server 2>/dev/null; done
  rm -rf "$T"
else
  skip "stack reorder through the nest" "tmux not available"
fi

# ── 4d. tabs: a terminal / editor on the session's own folder ────────────────
# C-t and C-n open a tab; C-x is where the stack screen moved to make room.
#
# A tab is a SESSION, never a window, and that is not a style choice: every status
# reader here captures with `capture-pane -t "$SESSION"`, which resolves to the
# session's CURRENT window. A shell window would make the grid read the shell instead
# of the agent — and `fleet-send` would paste your prompt into it.
group "tabs (fleet-tab)"
if command -v tmux >/dev/null 2>&1; then
  TB="$(mktemp -d)"; mkdir -p "$TB/api-2" "$TB/api-3"
  tmux -L cftabt kill-server 2>/dev/null
  tmux -L cftabt new-session -d -s api-2 -c "$TB/api-2" 'sleep 60' 2>/dev/null
  TSOCK="$(tmux -L cftabt display-message -p '#{socket_path}' 2>/dev/null)"
  ft() { "$ROOT/bin/fleet-tab" "$@" >/dev/null 2>&1; }
  nsess() { tmux -L cftabt list-sessions -F '#{session_name}' 2>/dev/null | grep -c "$1" || true; }

  ft term "$TSOCK" "$TB/api-2" api-2
  is "a term tab appears"             "1" "$(nsess '^_term-api-2$')"
  # pwd -P on BOTH sides: mktemp hands back /var/folders/…, tmux reports the resolved
  # /private/var/folders/… — the same /tmp-is-a-symlink trap that already cost this repo
  # a config key nothing could find.
  is "...on the folder it was asked for" "$(cd "$TB/api-2" && pwd -P)" \
     "$(tmux -L cftabt display-message -p -t _term-api-2 '#{pane_current_path}' 2>/dev/null)"
  # THE NAME MUST BE TARGET-RESOLVABLE. It was `+term-…` first, and a leading + means
  # "next session" to tmux: has-session and switch-client both still worked, so it
  # demoed fine, while display-message/capture-pane silently answered for ANOTHER
  # session. Assert the name resolves to ITSELF — has-session cannot catch this.
  is "...and the name resolves to itself" "_term-api-2" \
     "$(tmux -L cftabt display-message -p -t _term-api-2 '#{session_name}' 2>/dev/null)"
  # AND THE ASSERTION ABOVE HAS TEETH, because a + name does NOT resolve to itself.
  #
  # DO NOT RESTORE the assertion that used to stand here — "a + name resolves
  # ELSEWHERE", expecting 0. It went red on untouched main, and not because anything
  # regressed: what a + target answers is version-dependent. `+` is not part of a name,
  # it is a target expression, and it is answered relative to whatever session tmux
  # considers CURRENT. tmux 3.7b answers the current session itself, and the session
  # created last is current — so `-t '+term-api-2'`, measured right after creating
  # `+term-api-2`, answered `+term-api-2` and the old expectation inverted. Older tmux
  # answers the session AFTER the current one, which lands back on `+term-api-2` just as
  # easily given the wrong ordering. Neither spelling is something to assert. The `_`
  # prefix in bin/fleet-tab stays regardless: the hazard is live on the tmux other people
  # are running, and this repo has it written down as one.
  #
  # What IS the same on every tmux, and IS the hazard, is that the answer MOVES when some
  # other session becomes current — while the session of that name is not touched at all.
  # A name does not do that. So make another session current and measure both names
  # across it: the + one drifts, the _ one does not. The second assertion is the control;
  # without it a tmux that answered the current session for EVERY target would satisfy
  # the first one and the `_` fix would be worth nothing.
  tmux -L cftabt new-session -d -s '+term-api-2' -c "$TB/api-3" 'sleep 60' 2>/dev/null
  resolves() { tmux -L cftabt display-message -p -t "$1" '#{session_name}' 2>/dev/null; }
  was_plus="$(resolves '+term-api-2')"; was_under="$(resolves _term-api-2)"
  tmux -L cftabt new-session -d -s zz-elsewhere -c "$TB/api-3" 'sleep 60' 2>/dev/null
  is "...unlike a + name, which answers whoever is current" "moved" \
     "$([ "$was_plus" = "$(resolves '+term-api-2')" ] && echo same || echo moved)"
  is "...while the _ name keeps answering itself"           "same" \
     "$([ "$was_under" = "$(resolves _term-api-2)" ] && echo same || echo moved)"
  tmux -L cftabt kill-session -t '=zz-elsewhere' 2>/dev/null

  ft term "$TSOCK" "$TB/api-2" api-2
  is "pressing it twice REUSES the tab" "1" "$(nsess '^_term-api-2$')"
  ft term "$TSOCK" "$TB/api-3" api-3
  is "another session gets its own"     "1" "$(nsess '^_term-api-3$')"
  ft term "$TSOCK" "$TB/api-2" "api.2"
  is "a dot in the name can't break it" "1" "$(nsess '^_term-api_2$')"

  # is_tab decides what the agent machinery leaves alone. Both directions, and the
  # negative case is a REAL worktree name that contains "term" — a substring match
  # would sweep it in and the governor would stop metering a live worker.
  eval "$(sed -n '/^is_tab() {/p' "$ROOT/bin/fleet-governor")"
  tab_says() { is_tab "$1" && echo tab || echo worker; }
  is "_term-x is a tab"          "tab"    "$(tab_says _term-x)"
  is "_edit-x is a tab"          "tab"    "$(tab_says _edit-x)"
  is "a worker is not"           "worker" "$(tab_says api-2)"
  is "nor is 'terminal-fix'"     "worker" "$(tab_says terminal-fix)"

  # fleet-send into a shell would type the prompt at a prompt and press Enter.
  st() { env -u TMUX "$ROOT/bin/fleet-send" -s cftabt "$1" hi 2>&1 | head -1; }
  is "send to a tab is refused"  "1" "$(st _term-api-2 | grep -c 'is a tab' || true)"
  is "...but a worker still takes one" "0" "$(st api-2 | grep -c 'is a tab' || true)"
  tmux -L cftabt kill-server 2>/dev/null; rm -rf "$TB"
else
  skip "tabs" "tmux not available"
fi

# The bindings themselves: C-t/C-n must reach fleet-tab, and the stack must have MOVED
# off C-t rather than merely gained C-x — a config that binds both is the bug.
group "tab bindings (real tmux server)"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cftabk kill-server 2>/dev/null
  tmux -L cftabk -f "$ROOT/tmux/cf.tmux.conf" new-session -d -s api-2 'sleep 60' 2>/dev/null
  rk() { tmux -L cftabk list-keys -T root 2>/dev/null | grep -E "^bind-key +-T root +$1 " || true; }
  is "C-t opens a term tab"      "1" "$(rk C-t | grep -c 'fleet-tab term' || true)"
  is "...and no longer the stack" "0" "$(rk C-t | grep -c 'goto' || true)"
  is "C-n opens an edit tab"     "1" "$(rk C-n | grep -c 'fleet-tab edit' || true)"
  is "C-x opens the stack"       "1" "$(rk C-x | grep -c 'printf stack' || true)"
  tmux -L cftabk kill-server 2>/dev/null
else
  skip "tab bindings" "tmux not available"
fi

# A TAB IS NOT A CARD. It is a real session (that is what keeps the fleet from reading
# it as an agent pane), so every list built from `list-sessions` picked it up: it took
# card 1 and renumbered every session behind it, and because it shares its origin's cwd
# the transcript lookup handed it the ORIGIN'S last message — a terminal card reading
# "✓ ready" over work it had no part in. The grid, the ring and the shell fallback all
# have to agree, or a digit means one session on the grid and another to ⇧→.
group "tabs are not sessions"
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  TH="$(mktemp -d)"; mkdir -p "$TH/main" "$TH/api-2"
  tmux -L cftabh kill-server 2>/dev/null
  tmux -L cftabh new-session -d -s master -c "$TH/main" 'sleep 60' 2>/dev/null
  tmux -L cftabh new-session -d -s api-2  -c "$TH/api-2" 'sleep 60' 2>/dev/null
  "$ROOT/bin/fleet-tab" term cftabh "$TH/api-2" api-2 >/dev/null 2>&1
  HSOCK="$(tmux -L cftabh display-message -p '#{socket_path}' 2>/dev/null)"
  is "tmux really has the tab"     "1" \
     "$(tmux -L cftabh list-sessions -F '#{session_name}' 2>/dev/null | grep -c '^_term-api-2$' || true)"
  # ...and every list the fleet builds leaves it out
  ord="$(node "$ROOT/bin/fleet-grid.mjs" cftabh --order </dev/null 2>/dev/null | tr '\n' ' ')"
  is "the grid's order omits it"   "api-2 " "$ord"
  is "...and no card renders it"   "0" \
     "$(node "$ROOT/bin/fleet-grid.mjs" cftabh --plain </dev/null 2>/dev/null | grep -c '_term-' || true)"
  ring="$(sed -n '/^ring="\$(/,/^)"/p' "$ROOT/bin/fleet-cycle" | grep -c '_term-' || true)"
  is "the cycle ring excludes it"  "1" "$ring"
  # the exact-match anchor, because '^master' would also swallow a worker called
  # master-notes — the prefix-vs-exact trap this repo has already been bitten by
  is "...and still matches master EXACTLY" "1" \
     "$(grep -c "grep -vE '\^master\\\$|\^_term-|\^_edit-'" "$ROOT/bin/fleet-cycle" || true)"
  is "the shell fallback agrees"   "1" \
     "$(grep -c "grep -vE '\^master\\\$|\^_term-|\^_edit-'" "$ROOT/bin/ghostfleet" || true)"

  # back: a tab returns to the session it came from, not up to the grid
  is "the tab records its origin"  "api-2" \
     "$(tmux -L cftabh show-options -qv -t _term-api-2 @cf_tab_from 2>/dev/null)"
  # A TAB OUTLIVES THE CODE THAT MADE IT. tmux sessions keep the options they were born
  # with, so tabs already open when the back key landed had no @cf_tab_from — ` fell
  # through to detach and threw you up to Projects, from inside the very feature meant
  # to step back one level. It read as "the binding never shipped", and re-installing
  # could not fix it. So the stamp is re-applied on every call, repairing in place.
  tmux -L cftabh set-option -u -t _term-api-2 @cf_tab_from 2>/dev/null
  is "...a stale tab starts unstamped" "" \
     "$(tmux -L cftabh show-options -qv -t _term-api-2 @cf_tab_from 2>/dev/null)"
  "$ROOT/bin/fleet-tab" term cftabh "$TH/api-2" api-2 >/dev/null 2>&1
  is "...and one C-t repairs it"   "api-2" \
     "$(tmux -L cftabh show-options -qv -t _term-api-2 @cf_tab_from 2>/dev/null)"
  is "...without dealing a second" "1" \
     "$(tmux -L cftabh list-sessions -F '#{session_name}' 2>/dev/null | grep -c '^_term-api-2$' || true)"
  is "...and its bar names it"     "1" \
     "$(tmux -L cftabh display-message -p -t _term-api-2 '#{status-left}' 2>/dev/null | grep -c 'api-2' || true)"
  # the OTHER direction: with the origin gone, back must fall through to a detach
  # rather than switch-client at a dead name and look like a broken key
  tmux -L cftabh kill-session -t api-2 2>/dev/null
  "$ROOT/bin/fleet-tab" back "$HSOCK" _term-api-2 "" >/dev/null 2>&1
  is "a dead origin doesn't strand it" "1" \
     "$(tmux -L cftabh has-session -t '=_term-api-2' 2>/dev/null && echo 1 || echo 0)"
  tmux -L cftabh kill-server 2>/dev/null; rm -rf "$TH"
else
  skip "tabs are not sessions" "tmux or node missing"
fi

# The grid's own keys. ^T/^N/^X must mean the same thing here as they do inside a
# session — a chord that changes meaning per screen is worse than no chord. Driven
# through a REAL tty, because the grid reads stdin directly.
group "grid tab keys (real TUI)"
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  GK="$(mktemp -d)"; mkdir -p "$GK/main" "$GK/api-2"
  tmux -L cfgkin kill-server 2>/dev/null; tmux -L cfgkout kill-server 2>/dev/null
  tmux -L cfgkin new-session -d -s master -c "$GK/main" 'sleep 90' 2>/dev/null
  tmux -L cfgkin new-session -d -s api-2  -c "$GK/api-2" 'sleep 90' 2>/dev/null
  gkey() {                      # $1 = key -> the choice the grid printed
    rm -f "$GK/choice"; tmux -L cfgkout kill-server 2>/dev/null
    tmux -L cfgkout new-session -d -x 200 -y 50 \
      "node '$ROOT/bin/fleet-grid.mjs' cfgkin > '$GK/choice' 2>/dev/null" 2>/dev/null
    sleep 2
    tmux -L cfgkout send-keys "$1" 2>/dev/null; sleep 2
    tmux -L cfgkout kill-server 2>/dev/null
    tr '\037' '|' < "$GK/choice" 2>/dev/null
  }
  is "^T asks to attach a term tab" "attach|_term-api-2" "$(gkey C-t)"
  # the name is PREDICTED to build that choice — if it ever drifts from what fleet-tab
  # really creates, the grid attaches to a session that does not exist
  is "...and that session exists"   "1" \
     "$(tmux -L cfgkin has-session -t '=_term-api-2' 2>/dev/null && echo 1 || echo 0)"
  is "^N asks to attach an editor"  "attach|_edit-api-2" "$(gkey C-n)"
  is "^X is the stack"              "stack" "$(gkey C-x)"
  is "...and plain t still is too"  "stack" "$(gkey t)"
  tmux -L cfgkout kill-server 2>/dev/null; tmux -L cfgkin kill-server 2>/dev/null; rm -rf "$GK"
else
  skip "grid tab keys" "tmux or node missing"
fi

# THE PROJECTS SCREEN KEEPS ITS OWN COPY OF THESE KEYS. That is exactly how ^T went on
# opening the stack there long after the session grid AND tmux had both moved to ^X —
# one chord meaning two different things one screen apart, and nothing to notice it.
# CLAUDE_FLEET_PROJECTS keeps this off the real registry: without it the screen reads
# the developer's own projects and the test passes or fails on whose machine it is.
group "Projects screen tab keys (real TUI)"
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  PK="$(mktemp -d)"; mkdir -p "$PK/repo"
  printf 'demo\t%s\twork\n' "$PK/repo" > "$PK/projects"
  pkey() {
    rm -f "$PK/choice"; tmux -L cfpkout kill-server 2>/dev/null
    tmux -L cfpkout new-session -d -x 200 -y 50 \
      "CLAUDE_FLEET_PROJECTS='$PK/projects' node '$ROOT/bin/fleet-grid.mjs' - --screen projects > '$PK/choice' 2>/dev/null" 2>/dev/null
    sleep 2
    tmux -L cfpkout send-keys "$1" 2>/dev/null; sleep 2
    tmux -L cfpkout kill-server 2>/dev/null
    tr '\037' '|' < "$PK/choice" 2>/dev/null
  }
  is "^T asks for a term tab"  "tabfor|demo|term" "$(pkey C-t)"
  is "^N asks for an editor"   "tabfor|demo|edit" "$(pkey C-n)"
  is "^X is the stack here too" "stackfor|demo"   "$(pkey C-x)"
  tmux -L cfpkout kill-server 2>/dev/null; rm -rf "$PK"
else
  skip "Projects screen tab keys" "tmux or node missing"
fi

# The name the control plane attaches to must be the name fleet-tab really creates. The
# loop has to know it BEFORE the session exists, so it asks fleet-tab rather than
# rebuilding the rule — a second copy drifts, and the failure is an attach to nothing.
group "tab name is single-sourced"
if command -v tmux >/dev/null 2>&1; then
  NM="$(mktemp -d)"; tmux -L cfnm kill-server 2>/dev/null
  is "name term master" "_term-master"  "$("$ROOT/bin/fleet-tab" name term master)"
  is "name edit api.2"  "_edit-api_2"   "$("$ROOT/bin/fleet-tab" name edit 'api.2')"
  # and it agrees with what actually gets created
  "$ROOT/bin/fleet-tab" term cfnm "$NM" 'api.2' >/dev/null 2>&1
  is "...and that is the session made" "1" \
     "$(tmux -L cfnm has-session -t "=$("$ROOT/bin/fleet-tab" name term 'api.2')" 2>/dev/null && echo 1 || echo 0)"
  is "ghostfleet asks for the name"    "1" \
     "$(grep -c 'fleet-tab\" name' "$ROOT/bin/ghostfleet" || true)"
  tmux -L cfnm kill-server 2>/dev/null; rm -rf "$NM"
else
  skip "tab name single-sourced" "tmux not available"
fi

# ── 4d2. "at limit" must not read as "ready" ─────────────────────────────────
# Claude prints "You've hit your session limit · resets 10:20pm" and then takes no
# prompt until the window rolls over — but it leaves the input box up, so every ready
# signal still matches. Five limited workers rendered as "5 ready", which is the summary
# line lying at exactly the moment you would act on it.
#
# THE TEXT ALONE CANNOT BE THE SIGNAL, and these two fixtures are why. Both are real
# captures taken the same minute; both carry the notice; both carry it behind the same
# "⎿ " tool-result marker — because reading a limited pane with capture-pane renders its
# output as a tool result in the reader's own pane. Anchoring on the glyph, or on the
# sentence, calls the READER limited too. The only thing that separates them is the
# session's own 5h figure: 102% vs 15%.
group "session limit is not ready"
LIM_RE="$("$ROOT/bin/fleet-agent" field claude limit_re 2>/dev/null)"
is "claude has a limit pattern"      "1"   "$([ -n "$LIM_RE" ] && echo 1 || echo 0)"
is "...and other agents do not"      ""    "$("$ROOT/bin/fleet-agent" field opencode limit_re 2>/dev/null)"
# the notice fires on BOTH — that is the point, it is not the discriminator
is "notice matches the real one"     "1"   "$(matches "$LIM_RE" "$FIX/claude-limit-hit.txt")"
is "notice matches the quote too"    "1"   "$(matches "$LIM_RE" "$FIX/claude-idle-quoting-limit.txt")"
# ...and the usage figure is what tells them apart
pct_in() { grep -oE '[^:0-9][0-9]+%\(' "$1" 2>/dev/null | grep -oE '[0-9]+' | tail -1; }
is "the limited pane reads 102%"     "102" "$(pct_in "$FIX/claude-limit-hit.txt")"
is "the quoting pane reads 15%"      "15"  "$(pct_in "$FIX/claude-idle-quoting-limit.txt")"
# the conjunction the grid applies, spelled out in both directions
lim() { [ "$(matches "$LIM_RE" "$1")" != 0 ] && [ "$(pct_in "$1")" -ge 100 ] 2>/dev/null && echo limit || echo ready; }
is "really limited -> limit"         "limit" "$(lim "$FIX/claude-limit-hit.txt")"
is "merely quoting  -> ready"        "ready" "$(lim "$FIX/claude-idle-quoting-limit.txt")"
# and an ordinary idle pane, which mentions no limit at all, is untouched
is "a plain idle pane -> ready"      "ready" "$(lim "$FIX/claude-idle.txt")"
# the status must exist, be counted apart from ready, and never be folded into it
is "the grid has a 'limit' status"   "1" "$(grep -ac '^  limit: ' "$ROOT/bin/fleet-grid.mjs" || true)"
is "...counted apart from ready"     "1" "$(grep -ac "c.status === 'limit'" "$ROOT/bin/fleet-grid.mjs" || true)"
# The stack picker reaches other projects' fleets through sessionStatuses, NOT tmuxList,
# so hiding tabs from the grid did nothing for it — every terminal in every project
# showed up there as an "idle" session you could stack.
is "the stack picker drops tabs"     "1" "$(sed -n '/^function sessionStatuses/,/^}/p' "$ROOT/bin/fleet-grid.mjs" | grep -c 'isTab' || true)"

# ── 4d3. a status glyph wider than one column shifts every card ──────────────
# vis() counts CODE POINTS, not display columns, so the whole card grid is built on
# "one character = one cell". A 2-column glyph renders wider than the arithmetic
# believes and shoves every card to its right out of alignment — silent, cosmetic, and
# instantly visible to the person using it. Shipped once: the limit status was ⏳
# (U+23F3), which measures 2.
#
# MEASURED, not tabulated: each glyph is printed into a real tmux pane and the cursor
# column is read back, so a new status with an emoji in it fails here rather than in
# your terminal. (⏳ is measured too, as the control — a test that only ever sees
# 1-column glyphs would pass just as happily with a broken ruler.)
group "status glyphs are one column"
if command -v tmux >/dev/null 2>&1; then
  tmux -L cfglyph kill-server 2>/dev/null
  tmux -L cfglyph new-session -d -x 80 -y 10 'sleep 600' 2>/dev/null
  sleep 0.5
  gwidth() {                     # $1 = glyph -> the column the cursor lands on
    tmux -L cfglyph respawn-pane -k -t 0 "printf '%s' '$1'; sleep 600" 2>/dev/null
    sleep 0.35
    tmux -L cfglyph display-message -p -t 0 '#{cursor_x}' 2>/dev/null
  }
  is "the ruler works: ⏳ is 2 wide" "2" "$(gwidth '⏳')"
  # every leading glyph the STATUS table actually uses
  # ONLY the STATUS table — `label:` is an ordinary key elsewhere in this file, and
  # scooping those up tested the width of the word "branch".
  #   LC_ALL=C on the sort, or it dedupes almost everything: under this machine's
  # collation ● ◆ ✓ ⏸ · … ⧗ ⚠ all compare EQUAL, so `sort -u` returned two of the nine
  # and the loop quietly tested a third of what it claimed to.
  GLYPHS="$(sed -n '/^const STATUS = {/,/^};/p' "$ROOT/bin/fleet-grid.mjs" \
            | grep -aoE "label: '[^ ']+" | sed "s/label: '//" | LC_ALL=C sort -u)"
  is "...and the table is non-empty"  "1" "$([ -n "$GLYPHS" ] && echo 1 || echo 0)"
  for g in $GLYPHS; do
    is "status glyph $g is 1 column" "1" "$(gwidth "$g")"
  done
  tmux -L cfglyph kill-server 2>/dev/null
else
  skip "status glyph widths" "tmux not available"
fi

# ── 4d4. an interrupted turn must not read as ready ──────────────────────────
# A cut-short turn leaves "Interrupted · What should Claude do instead?" above an
# ordinary empty input box, so every ready signal matches and the card says "✓ ready"
# over a session doing nothing. A park interrupts a turn, so a governor episode makes
# these in bulk.
#
# ANCHORED TO THE INDENT, which is the entire discriminator: Claude renders its own
# result marker at exactly two columns, while the same sentence quoted inside a
# command's output lands deeper. Caught against the session that wrote the detector,
# which greps for the string and would otherwise have marked itself interrupted.
group "interrupted is not ready"
INT_RE="$("$ROOT/bin/fleet-agent" field claude interrupt_re 2>/dev/null)"
is "claude has an interrupt pattern" "1" "$([ -n "$INT_RE" ] && echo 1 || echo 0)"
is "...and other agents do not"      ""  "$("$ROOT/bin/fleet-agent" field opencode interrupt_re 2>/dev/null)"
is "it fires on a real one"          "1" "$(matches "$INT_RE" "$FIX/claude-interrupted.txt")"
is "...and not on a plain idle pane" "0" "$(matches "$INT_RE" "$FIX/claude-idle.txt")"
# the anchor earns its keep: the SAME sentence one indent deeper must not fire
QT="$(mktemp)"; sed 's/^  ⎿/     ⎿/' "$FIX/claude-interrupted.txt" > "$QT"
is "...nor on the sentence quoted deeper" "0" "$(matches "$INT_RE" "$QT")"
rm -f "$QT"
is "the grid has an 'interrupted' status" "1" \
   "$(grep -ac '^  interrupted:' "$ROOT/bin/fleet-grid.mjs" || true)"

# ── 4d5. fleet-send must be able to SEE the input box ────────────────────────
# in_input answers "is my pasted prompt still sitting in the composer?" and it located
# the box by its rounded corners (╭ … ╰). Claude now draws the composer as two plain
# horizontal rules, so on every current pane the detector returned 2 = "no box found".
#
# The visible half was cosmetic: every send ended in "could not confirm submit". The
# damaging half was silent — the re-nudge that recovers a SWALLOWED ENTER only fires
# when in_input says 0 ("probe still in the box"), which a blind detector can never say.
# So the paste/Enter race stopped being recoverable and the prompt sat unsent forever,
# which from the outside is a worker ignoring you. Found live: a lead's "continue where
# you left off" still in the box while the same session answered a fresh probe fine.
#
# Both directions AND both box styles, because a detector that says 2 everywhere and one
# that says 0 everywhere are equally useless, and fixing the new style by breaking the
# old one just moves the blindness.
group "fleet-send can see the composer"
if command -v awk >/dev/null 2>&1; then
  # the real function, lifted out of the script so the test exercises the shipped code
  eval "$(sed -n '/^in_input() {/,/^}/p' "$ROOT/bin/fleet-send" | sed 's/tmux -L "\$SOCK" capture-pane -p -t "\$SESSION" 2>\/dev\/null/cat "$PANE"/')"
  probe="browser walkthrough on 8120"
  ii() { PANE="$1" in_input; echo $?; }
  PANE="$FIX/claude-input-pending.txt";   in_input; is "plain rules: probe still in the box" "0" "$?"
  PANE="$FIX/claude-input-submitted.txt"; in_input; is "plain rules: probe gone = submitted" "1" "$?"
  # the older rounded composer must keep working — same pane, corners drawn on
  RB="$(mktemp)"; sed 's/^─\(─*\)$/╭\1╮/' "$FIX/claude-input-pending.txt" > "$RB"
  PANE="$RB"; in_input; is "rounded box is still seen"          "0" "$?"
  # a pane with no composer at all is UNKNOWN (2), never a confident answer
  printf 'just some text\nand more\n' > "$RB"
  PANE="$RB"; in_input; is "no box at all -> unknown, not a guess" "2" "$?"
  rm -f "$RB"
else
  skip "fleet-send composer detector" "awk missing"
fi

# ── 4d6. selecting with the mouse must reach the system clipboard ────────────
# `mouse on` is what creates this problem: tmux captures the drag, so the terminal's own
# selection never happens and what you highlight lands in tmux's private buffer —
# visibly selected, and not on the clipboard. Getting a URL out of a pane meant holding
# a per-terminal modifier to bypass tmux, which nobody discovers.
#
# Driven as a REAL DRAG through an attached client, because that is the only thing that
# resolves a mouse binding: send-keys to the pane would bypass the binding entirely and
# prove nothing. fleet-copy is stubbed so the test can read what the drag produced
# without touching the machine's actual clipboard.
group "drag to copy"
if command -v tmux >/dev/null 2>&1; then
  DC="$(mktemp -d)"; mkdir -p "$DC/bin"
  printf '#!/bin/sh\ncat > "%s/got.txt"\n' "$DC" > "$DC/bin/fleet-copy"; chmod +x "$DC/bin/fleet-copy"
  tmux -L cfdrin kill-server 2>/dev/null; tmux -L cfdrout kill-server 2>/dev/null
  tmux -L cfdrin -f "$ROOT/tmux/cf.tmux.conf" new-session -d -x 80 -y 12 \
    "printf 'COPY-ME-9182\n'; sleep 90" 2>/dev/null
  tmux -L cfdrin set -g @cf_bin "$DC/bin" 2>/dev/null
  tmux -L cfdrout new-session -d -x 80 -y 12 \
    "tmux -L cfdrin -f '$ROOT/tmux/cf.tmux.conf' attach -t 0" 2>/dev/null
  sleep 1.5
  m() { tmux -L cfdrout send-keys -l "$(printf "$1")" 2>/dev/null; sleep 0.3; }
  m '\033[<0;1;1M'; m '\033[<32;13;1M'; m '\033[<0;13;1m'   # press, move, release
  sleep 0.6
  is "a drag reaches the clipboard" "COPY-ME-9182" \
     "$(tr -d '\n' < "$DC/got.txt" 2>/dev/null)"
  # ...and the binding exists in BOTH copy-mode tables. mode-keys follows $EDITOR, so
  # binding only copy-mode-vi works on a vi user's machine and nowhere else.
  is "bound for copy-mode-vi" "1" "$(grep -c '^bind -T copy-mode-vi MouseDragEnd1Pane' "$ROOT/tmux/cf.tmux.conf" || true)"
  is "bound for copy-mode"    "1" "$(grep -c '^bind -T copy-mode    MouseDragEnd1Pane' "$ROOT/tmux/cf.tmux.conf" || true)"
  is "the stack copies too"   "2" "$(grep -c 'MouseDragEnd1Pane' "$ROOT/tmux/cf-stack.tmux.conf" || true)"
  # the stack must NOT take clicks into copy-mode: in there a click FOCUSES a pane, and
  # that behaviour is pinned by its own group above
  is "...without stealing its clicks" "0" "$(grep -c 'Click1Pane' "$ROOT/tmux/cf-stack.tmux.conf" || true)"
  tmux -L cfdrout kill-server 2>/dev/null; tmux -L cfdrin kill-server 2>/dev/null; rm -rf "$DC"
else
  skip "drag to copy" "tmux not available"
fi

# fleet-copy picks a clipboard tool at run time — pbcopy is macOS-only and this repo
# supports Linux and WSL. Both directions: it must find one when present, and say what
# is missing rather than exiting mutely when none is (it runs from a keybinding, where
# silence is indistinguishable from a broken binding).
group "fleet-copy finds a clipboard"
CP="$(mktemp -d)"; mkdir -p "$CP/bin"
printf '#!/bin/sh\ncat > "%s/out.txt"\n' "$CP" > "$CP/bin/pbcopy"; chmod +x "$CP/bin/pbcopy"
printf 'hello-clip' | PATH="$CP/bin:$PATH" "$ROOT/bin/fleet-copy" >/dev/null 2>&1
is "it uses the tool it finds"  "hello-clip" "$(cat "$CP/out.txt" 2>/dev/null)"
# A PATH holding `cat` and NOTHING else. Emptying it entirely proves nothing: the
# shebang's `env bash` fails to exec, and even run as `/bin/bash script` the `cat` that
# reads stdin is gone too, so it exits at the empty-input guard having never reached the
# clipboard search — a green light for a code path that was never entered.
mkdir -p "$CP/nobin"; ln -sf "$(command -v cat)" "$CP/nobin/cat"
out="$(printf 'x' | PATH="$CP/nobin" /bin/bash "$ROOT/bin/fleet-copy" 2>&1; echo "rc=$?")"
is "no tool -> says so"         "1" "$(printf '%s' "$out" | grep -c 'no clipboard tool' || true)"
is "...and exits non-zero"      "1" "$(printf '%s' "$out" | grep -c 'rc=1' || true)"
is "empty selection is a no-op" "rc=0" "$(printf '' | PATH="$CP/nobin" /bin/bash "$ROOT/bin/fleet-copy" 2>&1; echo "rc=$?")"
rm -rf "$CP"

# ── 4d7. a fleet must not have its binary swapped mid-flight ─────────────────
# Claude Code's background-service supervisor watches its own executable's mtime and
# self-restarts when it moves — while the updater is still writing that ~300MB file, so
# the exec hits a path that exists, has a fresh mtime, and is not executable yet:
# EACCES. The session then drops into the agents view carrying the error. A fleet turns
# that from a rare race into a routine one, because one update swaps the binary under
# every live session at once.
#
# Both directions: the opt-out has to actually work, or the only way back to
# auto-updates would be editing the launcher.
group "fleet sessions don't auto-update"
AH="$(mktemp -d)"; mkdir -p "$AH/bin"
# stand in for the real launcher and report what it was handed
printf '#!/bin/sh\necho "DISABLE_AUTOUPDATER=[${DISABLE_AUTOUPDATER:-unset}]"\n' > "$AH/bin/claude-here"
chmod +x "$AH/bin/claude-here"
ah() { env -u DISABLE_AUTOUPDATER "$@" PATH="$AH/bin:$PATH" /bin/bash "$ROOT/bin/agent-here" 2>/dev/null; }
is "off by default"            "DISABLE_AUTOUPDATER=[1]"     "$(ah)"
is "opt back in with the flag" "DISABLE_AUTOUPDATER=[unset]" "$(ah CLAUDE_FLEET_AUTOUPDATE=1)"
# it is set in the ONE place every launch path goes through, not per call site
is "set in agent-here"         "1" "$(grep -c 'export DISABLE_AUTOUPDATER=1' "$ROOT/bin/agent-here" || true)"
rm -rf "$AH"

# ── 4d8. a worktree goes where the REPO says worktrees go ────────────────────
# A sibling was the only layout and is still the default. But superkey's PreToolUse guard
# denies any edit whose PATH lacks `.worktrees/` — it never asks git whether the path IS a
# worktree — so our sibling (a real, isolated worktree on its own branch) was refused as
# "the shared main checkout", the agent obeyed the refusal, and created a SECOND worktree
# nested inside the first, plus a full dependency install. Nineteen worktrees across four
# clones, fifteen idle, came out of that.
#
# The default case is the one to protect: a repo with no convention must place worktrees
# exactly where it always did, or this "fix" silently relocates every other project.
group "worktree location follows the repo"
if command -v git >/dev/null 2>&1; then
  eval "$(sed -n '/^worktree_parent() {/,/^}/p' "$ROOT/bin/fleet-spawn")"
  WD="$(mktemp -d)"
  mkrepo() { git init -q -b main "$WD/$1" 2>/dev/null; git -C "$WD/$1" config user.email t@t
             git -C "$WD/$1" config user.name t; : > "$WD/$1/f"
             git -C "$WD/$1" add -A; git -C "$WD/$1" commit -qm i 2>/dev/null; }
  mkrepo plain
  mkrepo declares; printf '.worktrees/\n' > "$WD/declares/.gitignore"
  git -C "$WD/declares" add -A; git -C "$WD/declares" commit -qm ignore 2>/dev/null
  mkrepo hasdir; mkdir -p "$WD/hasdir/.worktrees"
  wp() { GITROOT="$WD/$1" PARENT="$WD" CLAUDE_FLEET_WORKTREE_DIR="${2-}" worktree_parent; }
  is "no convention -> sibling (unchanged)" "$WD"                       "$(wp plain)"
  is "the dir exists -> use it"             "$WD/hasdir/.worktrees"     "$(wp hasdir)"
  # the case that matters most: the FIRST worktree in a fresh clone, where the directory
  # does not exist yet and only the repo's declaration says where they belong
  is "declared in .gitignore -> use it"     "$WD/declares/.worktrees"   "$(wp declares)"
  is "explicit 'sibling' overrides back"    "$WD"                       "$(wp declares sibling)"
  is "explicit relative dir"                "$WD/declares/.wt"          "$(wp declares .wt)"
  is "explicit absolute dir"                "/tmp/elsewhere"            "$(wp declares /tmp/elsewhere)"
  # `.worktrees/` is a DIRECTORY-ONLY pattern: check-ignore will not match it against a
  # bare name with nothing on disk, which is exactly the fresh-clone case. Probing a child
  # is what makes the declaration detectable before the first worktree exists.
  is "the probe asks about a child path"    "1" \
     "$(grep -c 'check-ignore -q .worktrees/.probe' "$ROOT/bin/fleet-spawn" || true)"
  rm -rf "$WD"
else
  skip "worktree location" "git missing"
fi

# ── 4d9. one project can be several clones ───────────────────────────────────
# superkey registers ~/superkey, which is NOT a repo — it holds four independent clones,
# each with its own .git and therefore its own private worktrees. fleet-worktrees walked
# only the clone it stood in: 2 visible, 17 invisible. So reuse-before-proliferate could
# never fire and every task made another worktree.
#
# Both directions: it must find the siblings, and it must NOT walk a linked worktree a
# second time as though it were a clone of its own (which would list its owner's trees
# again, and offer the main checkout for reuse).
group "worktrees span sibling clones"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  # pwd -P: git and fleet-worktrees report the RESOLVED path, and mktemp hands back the
  # /var/folders symlink — the same /tmp-is-a-symlink trap that has bitten this repo twice.
  CW="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$CW/proj"
  mk2() { git init -q -b main "$CW/proj/$1" 2>/dev/null; git -C "$CW/proj/$1" config user.email t@t
          git -C "$CW/proj/$1" config user.name t; : > "$CW/proj/$1/f"
          git -C "$CW/proj/$1" add -A; git -C "$CW/proj/$1" commit -qm i 2>/dev/null; }
  mk2 a; mk2 b                                     # two independent clones
  git -C "$CW/proj/a" worktree add -q "$CW/proj/a/.worktrees/aw" -b aw 2>/dev/null
  git -C "$CW/proj/b" worktree add -q "$CW/proj/b/.worktrees/bw" -b bw 2>/dev/null
  tmux -L cfclone kill-server 2>/dev/null; tmux -L cfclone new-session -d -s master 'sleep 60' 2>/dev/null
  fwt() { ( cd "$CW/proj/a" && env -u TMUX CLAUDE_FLEET_SOCK=cfclone "$ROOT/bin/fleet-worktrees" "$@" 2>/dev/null ); }
  free="$(fwt --free | awk -F'\t' '{print $1}' | sed "s|$CW/proj/||" | sort | tr '\n' ' ')"
  is "sees BOTH clones' worktrees" "a/.worktrees/aw b/.worktrees/bw " "$free"
  # --here is the old behaviour, and has to stay available
  hfree="$(fwt --here --free | awk -F'\t' '{print $1}' | sed "s|$CW/proj/||" | sort | tr '\n' ' ')"
  is "--here restricts to this repo"  "a/.worktrees/aw " "$hfree"
  # a clone's own checkout is a main checkout, never offered for reuse — and with several
  # clones there is more than one, so it can't be "the first line" any more
  is "no clone root is offered"       "0" "$(fwt --free | grep -cE "proj/(a|b)\$" || true)"
  # Claude Code's own worktrees must stay out of the free list here too. fleet-spawn
  # skipped them; the moment this file became the enumerator, that skip had to move with
  # it or the exclusion silently stopped applying — which is exactly what the suite caught.
  git -C "$CW/proj/a" worktree add -q "$CW/proj/a/.claude/worktrees/agent-x" -b agentx 2>/dev/null
  is "Claude's own trees stay excluded" "0" "$(fwt --free | grep -c '.claude/worktrees' || true)"
  is "...and the real ones still show"  "2" "$(fwt --free | grep -c '.worktrees/' || true)"
  tmux -L cfclone kill-server 2>/dev/null; rm -rf "$CW"
else
  skip "cross-clone worktrees" "git or tmux missing"
fi

# ── 4d10. finished work has to announce itself ───────────────────────────────
# A worker that merges its PR and goes idle leaves a worktree behind, and nothing ever
# said so — one fleet reached 19, fifteen of them idle, before anyone counted.
#
# "Finished" cannot be asked of git. A SQUASH-MERGE lands one NEW commit, so the
# branch's own commits are never in main and every reachability test (rev-list --not
# --remotes, git cherry, branch --merged) calls shipped work unlanded. Measured: 16 of
# 17 worktrees were refused as holding "unpushed local commits" while every one of their
# PRs was merged. fleet-merged asks GitHub instead, and the cache it keeps is what makes
# it cheap enough for fleet-inbox to call on every look.
group "finished worktrees surface to the lead"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  FD="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$FD/fleet"
  mkr() { git init -q -b main "$FD/repo" 2>/dev/null; git -C "$FD/repo" config user.email t@t
          git -C "$FD/repo" config user.name t; : > "$FD/repo/f"
          git -C "$FD/repo" add -A; git -C "$FD/repo" commit -qm i 2>/dev/null
          git -C "$FD/repo" remote add origin git@github.com:acme/widget.git 2>/dev/null; }
  mkr
  git -C "$FD/repo" worktree add -q "$FD/repo/.worktrees/shipped"  -b feat/shipped  2>/dev/null
  git -C "$FD/repo" worktree add -q "$FD/repo/.worktrees/ongoing"  -b feat/ongoing  2>/dev/null
  git -C "$FD/repo" worktree add -q "$FD/repo/.worktrees/messy"    -b feat/messy    2>/dev/null
  echo scratch > "$FD/repo/.worktrees/messy/dirty.txt"
  # Seed fleet-merged's cache instead of reaching the network: same code path, same
  # file, no gh call. Only feat/shipped has a merged PR.
  printf 'feat/shipped\n' > "$FD/fleet/merged.acme_widget"
  tmux -L cffin kill-server 2>/dev/null; tmux -L cffin new-session -d -s master 'sleep 60' 2>/dev/null
  wt() { ( cd "$FD/repo" && env -u TMUX CLAUDE_FLEET_DIR="$FD/fleet" CLAUDE_FLEET_SOCK=cffin \
           "$ROOT/bin/fleet-worktrees" "$@" 2>/dev/null ); }
  is "the merged one is DONE"        "1" "$(wt --done | grep -c 'worktrees/shipped' || true)"
  is "an unmerged one is not"        "0" "$(wt --done | grep -c 'worktrees/ongoing' || true)"
  is "a dirty one is not"            "0" "$(wt --done | grep -c 'worktrees/messy'   || true)"
  # DONE is still reusable — clean and sessionless is the whole definition of free
  is "...but DONE is still offered as free" "1" "$(wt --free | grep -c 'worktrees/shipped' || true)"
  # a live session outranks everything: it is neither free nor finished
  tmux -L cffin new-session -d -s w1 -c "$FD/repo/.worktrees/shipped" 'sleep 60' 2>/dev/null
  sleep 0.5
  is "a live session makes it neither"  "0" "$(wt --done | grep -c 'worktrees/shipped' || true)"
  tmux -L cffin kill-session -t '=w1' 2>/dev/null; sleep 0.5

  # fleet-clean must now agree, or --go still refuses the only finished work there is
  cl="$( cd "$FD/repo" && env -u TMUX CLAUDE_FLEET_DIR="$FD/fleet" CLAUDE_FLEET_SOCK=cffin \
         "$ROOT/bin/fleet-clean" 2>/dev/null )"
  is "fleet-clean calls it merged"   "1" "$(printf '%s' "$cl" | grep -c 'remove shipped .*PR merged' || true)"
  is "...and still keeps the dirty"  "1" "$(printf '%s' "$cl" | grep -c 'keep messy' || true)"

  # the footer is the whole point: it must appear on the QUIET path, which is the one a
  # lead sees most and the one it would otherwise never be read under
  ib() { ( cd "$FD/repo" && env -u TMUX CLAUDE_FLEET_DIR="$FD/fleet" CLAUDE_FLEET_SOCK=cffin \
           "$ROOT/bin/fleet-inbox" 2>/dev/null ); }
  is "inbox is quiet here"           "1" "$(ib | grep -c 'inbox: (empty)' || true)"
  is "...and still surfaces it"      "1" "$(ib | grep -c 'finished & reclaimable (1)' || true)"
  is "...naming the worktree"        "1" "$(ib | grep -c 'shipped  (feat/shipped)' || true)"
  # and says nothing when there is nothing — a footer that always fires is noise
  rm -f "$FD/fleet/merged.acme_widget"
  is "silent when nothing is finished" "0" "$(ib | grep -c 'finished & reclaimable' || true)"
  tmux -L cffin kill-server 2>/dev/null; rm -rf "$FD"
else
  skip "finished worktrees" "git or tmux missing"
fi

# ── 4d11. "this worker is done" in one command ───────────────────────────────
# Stopping a worker left its worktree behind, and fleet-stop's own header apologised for
# it — "run `git worktree prune` in the repo". So finishing a worker was a stop here and
# a raw git command somewhere else, and nothing an agent could reach at all: there is no
# clean tool in MCP. A worker cannot do it for itself either; its cwd IS the worktree.
#
# The safety decision is NOT duplicated here — it is delegated to fleet-clean --only, so
# there is exactly one set of gates. Both directions, because a --reclaim that removes
# whatever it is pointed at is a data-loss bug wearing a convenience feature's clothes.
group "fleet-stop --reclaim"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  RC="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$RC/fleet"
  git init -q -b main "$RC/repo" 2>/dev/null
  git -C "$RC/repo" config user.email t@t; git -C "$RC/repo" config user.name t
  : > "$RC/repo/f"; git -C "$RC/repo" add -A; git -C "$RC/repo" commit -qm i 2>/dev/null
  git -C "$RC/repo" remote add origin git@github.com:acme/widget.git 2>/dev/null
  git -C "$RC/repo" worktree add -q "$RC/repo/.worktrees/shipped" -b feat/shipped 2>/dev/null
  git -C "$RC/repo" worktree add -q "$RC/repo/.worktrees/wip"     -b feat/wip 2>/dev/null
  echo scratch > "$RC/repo/.worktrees/wip/dirty.txt"
  printf 'feat/shipped\n' > "$RC/fleet/merged.acme_widget"     # seed, so no gh call
  tmux -L cfrecl kill-server 2>/dev/null
  tmux -L cfrecl new-session -d -s master  -c "$RC/repo" 'sleep 90' 2>/dev/null
  tmux -L cfrecl new-session -d -s shipped -c "$RC/repo/.worktrees/shipped" 'sleep 90' 2>/dev/null
  tmux -L cfrecl new-session -d -s wip     -c "$RC/repo/.worktrees/wip" 'sleep 90' 2>/dev/null
  sleep 0.6
  stop() { env -u TMUX CLAUDE_FLEET_DIR="$RC/fleet" "$ROOT/bin/fleet-stop" -s cfrecl "$@" 2>&1; }

  out="$(stop --reclaim shipped)"
  is "a finished worker: session gone"  "0" "$(tmux -L cfrecl has-session -t '=shipped' 2>/dev/null && echo 1 || echo 0)"
  is "...and its worktree removed"      "0" "$([ -d "$RC/repo/.worktrees/shipped" ] && echo 1 || echo 0)"
  is "...for the stated reason"         "1" "$(printf '%s' "$out" | grep -c 'PR merged' || true)"

  out="$(stop --reclaim wip)"
  is "an unfinished worker: still stops" "0" "$(tmux -L cfrecl has-session -t '=wip' 2>/dev/null && echo 1 || echo 0)"
  is "...but the worktree is KEPT"       "1" "$([ -d "$RC/repo/.worktrees/wip" ] && echo 1 || echo 0)"
  is "...saying why"                     "1" "$(printf '%s' "$out" | grep -c 'uncommitted changes' || true)"

  # without the flag it must behave exactly as it always did — stop only, git untouched
  tmux -L cfrecl new-session -d -s wip2 -c "$RC/repo/.worktrees/wip" 'sleep 90' 2>/dev/null; sleep 0.4
  stop wip2 >/dev/null
  is "no --reclaim -> worktree untouched" "1" "$([ -d "$RC/repo/.worktrees/wip" ] && echo 1 || echo 0)"

  # a main checkout is never removed, whatever the session sitting in it is called
  tmux -L cfrecl new-session -d -s home -c "$RC/repo" 'sleep 90' 2>/dev/null; sleep 0.4
  out="$(stop --reclaim home)"
  is "a MAIN checkout is refused"        "1" "$(printf '%s' "$out" | grep -c 'is a main checkout' || true)"
  is "...and still exists"               "1" "$([ -d "$RC/repo/.git" ] && echo 1 || echo 0)"
  tmux -L cfrecl kill-server 2>/dev/null; rm -rf "$RC"
else
  skip "fleet-stop --reclaim" "git or tmux missing"
fi
# FLAGS ON EITHER SIDE OF THE SESSION. The first cut broke out of the arg loop at the
# first non-flag, so `fleet-stop <session> --reclaim` parsed the session and then
# SILENTLY DROPPED the flag: session stopped, worktree left, nothing said why. An agent
# hit it within a day — having copied that order from this repo's own skill table. An
# ignored option is worse than a rejected one, so an unknown flag is now an error too.
group "fleet-stop flag order"
fs() { env -u TMUX CLAUDE_FLEET_SOCK=cf-nosuch "$ROOT/bin/fleet-stop" "$@" 2>&1 | head -1; }
is "flag BEFORE the session"  "1" "$(fs --reclaim ghost | grep -c "no live session 'ghost'" || true)"
is "flag AFTER the session"   "1" "$(fs ghost --reclaim | grep -c "no live session 'ghost'" || true)"
is "an unknown flag errors"   "1" "$(fs --bogus ghost | grep -c 'unknown option' || true)"
is "a second session errors"  "1" "$(fs a b | grep -c 'unexpected arg' || true)"
# and the skill must teach the form that works, since that is where the agent copied from
is "the skill shows a working form" "0" \
   "$(grep -c 'fleet-stop <session> --reclaim' "$ROOT/skill/ghostfleet-orchestrate/SKILL.md" || true)"

# A WORKSPACE MUST NOT GET THE node_modules SYMLINK. Convenient for a plain repo,
# destructive here: the root node_modules links workspace packages by RELATIVE path, so
# through a symlink they resolve from the MAIN checkout — and an install in the worktree
# writes THROUGH the symlink into it. Reported live as "Root node_modules/vitest is a
# dangling symlink — the new worktree's install disturbed the main checkout's links."
group "no node_modules symlink into a workspace"
if command -v git >/dev/null 2>&1; then
  WS="$(cd "$(mktemp -d)" && pwd -P)"
  eval "$(sed -n '/^link_node_modules() {/,/^}/p' "$ROOT/bin/fleet-spawn")"
  mk() { mkdir -p "$WS/$1/node_modules"; printf '{}' > "$WS/$1/package.json"; mkdir -p "$WS/$1-wt"; }
  mk plain
  mk pnpmws; printf 'packages:\n  - packages/*\n' > "$WS/pnpmws/pnpm-workspace.yaml"
  mk npmws;  printf '{"workspaces":["packages/*"]}' > "$WS/npmws/package.json"
  linked() { GITROOT="$WS/$1" NAME="$1" link_node_modules "$WS/$1-wt" 2>/dev/null
             [ -L "$WS/$1-wt/node_modules" ] && echo yes || echo no; }
  is "a plain repo still gets the link" "yes" "$(linked plain)"
  is "a pnpm workspace does NOT"        "no"  "$(linked pnpmws)"
  is "an npm/yarn workspace does NOT"   "no"  "$(linked npmws)"
  is "...and it says why"               "1" \
     "$(GITROOT="$WS/pnpmws" NAME=pnpmws link_node_modules "$WS/pnpmws-wt" 2>&1 | grep -c 'rewrite the main checkout' || true)"
  rm -rf "$WS"
else
  skip "workspace symlink guard" "git missing"
fi

# ...and an agent can actually reach it, which was half the gap: there is no clean tool
# in MCP at all, so a lead had to shell out to a command that was all-or-nothing.
group "reclaim is reachable from MCP"
is "fleet_stop takes reclaim" "1" "$(grep -c "a.reclaim ? \['--reclaim'" "$ROOT/mcp/fleet-mcp.mjs" || true)"
is "...and it is in the schema" "1" "$(grep -c "reclaim: { type: 'boolean'" "$ROOT/mcp/fleet-mcp.mjs" || true)"

# ── 4e. the governor parks on a fossil its own park created ──────────────────
# A Claude pane only repaints when it does something, so a worker RESUMED a moment ago
# still shows the figure it was painting when it was parked. Skipping PARKED panes was
# not enough: everything parked -> the only live pane is master at 46% -> resume all ->
# the just-resumed panes still say 104% -> park all -> round again. Measured in a real
# log: 1,024 park/resume events, one cycle every ~90s, each park cutting a turn off
# mid-flight, so three-wide ran slower than one-wide.
#
# Four directions, because a detector that called EVERYTHING a fossil would "fix" the
# loop by disabling the ceiling entirely — the failure this whole layer exists to avoid.
group "governor: a resumed pane is a stopped clock too"
if command -v tmux >/dev/null 2>&1; then
  GV="$(mktemp -d)"; tmux -L cfgovt kill-server 2>/dev/null
  tmux -L cfgovt new-session -d -s w1 \
    "printf 'acct | Opus 5 | ctx:5%% | 104%%(4h 1m)\n'; sleep 90" 2>/dev/null
  sleep 1
  # one-liner, so grep it; the rest are real blocks
  eval "$(grep -a '^stale_f() {' "$ROOT/bin/fleet-governor")"
  eval "$(sed -n '/^pct_of() {/,/^}/p' "$ROOT/bin/fleet-governor")"
  eval "$(sed -n '/^pct_fingerprint() {/,/^}/p' "$ROOT/bin/fleet-governor")"
  eval "$(sed -n '/^is_fossil() {/,/^}/p' "$ROOT/bin/fleet-governor")"
  SOCK=cfgovt; FLEET_DIR="$GV"
  is "the pane's figure is read"     "104" "$(pct_of w1)"
  is "unparked: not a fossil"        "no"  "$(is_fossil w1 && echo yes || echo no)"
  printf '%s' "$(pct_fingerprint w1)" > "$(stale_f w1)"
  is "parked on it: fossil"          "yes" "$(is_fossil w1 && echo yes || echo no)"
  is "...and still, a tick later"    "yes" "$(is_fossil w1 && echo yes || echo no)"
  # the pane MOVES — the whole point is that this releases it, with no timer to tune
  tmux -L cfgovt respawn-pane -k -t w1 \
    "printf 'acct | Opus 5 | ctx:5%% | 41%%(4h 9m)\n'; sleep 90" 2>/dev/null
  sleep 1
  is "repainted: not a fossil"       "no"  "$(is_fossil w1 && echo yes || echo no)"
  is "...marker self-cleared"        "yes" "$([ -f "$(stale_f w1)" ] && echo no || echo yes)"
  is "...and the NEW figure is used" "41"  "$(pct_of w1)"
  tmux -L cfgovt kill-server 2>/dev/null; rm -rf "$GV"
else
  skip "governor fossil detector" "tmux not available"
fi

# Recovery releases ONE worker per tick. Letting all of them back on the same reading
# re-creates the condition that tripped the ceiling — five resumed together were over it
# again inside a minute — which is the other half of what sustained the loop.
group "governor: recovery ramps, it does not slam"
is "resume breaks after the first" "1" \
   "$(sed -n '/RECOVERED -> resume what WE parked/,/healthy/p' "$ROOT/bin/fleet-governor" | grep -c '^ *break$' || true)"
# ...but an explicit "ignore the budget" still releases everything: that is a human
# saying "I have extra usage, un-park my workers", not a reading to be ramped into.
is "ignore-limit passes no cap"    "1" \
   "$(grep -c 'release_gov_parked "budget ceiling ignored for this project"$' "$ROOT/bin/fleet-governor" || true)"

# fleet-resume used to print "un-parked" whatever happened — it never checked a marker
# existed. Pointing it at the wrong fleet dir (CLAUDE_FLEET_DIR outranks
# CLAUDE_CONFIG_DIR; an unexpanded ~ is a directory that cannot exist) reported success
# and did nothing, which is indistinguishable from a resume that is simply broken.
group "fleet-resume says what it actually cleared"
FR="$(mktemp -d)"; mkdir -p "$FR/fleet"
rout() { env -u TMUX CLAUDE_FLEET_DIR="$1" "$ROOT/bin/fleet-resume" -s cf-x plan 2>&1 | head -1; }
is "nothing parked -> says so"  "1" "$(rout "$FR/fleet" | grep -c 'was not parked' || true)"
is "...and names the dir it looked in" "1" "$(rout "$FR/fleet" | grep -cF "$FR/fleet" || true)"
printf '%s\n' 123 > "$FR/fleet/cf-x.plan.parked"
is "really parked -> un-parks"  "1" "$(rout "$FR/fleet" | grep -c 'un-parked' || true)"
is "...and the marker is gone"  "0" "$([ -f "$FR/fleet/cf-x.plan.parked" ] && echo 1 || echo 0)"
is "wrong dir -> refuses to claim success" "1" "$(rout "$FR/nope" | grep -c 'was not parked' || true)"
rm -rf "$FR"

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

# ── 6a2. the notification names the chord that reaches the session ───────────
# A popup that says only WHO spoke leaves you to find them. It now leads with the
# Ctrl-f chord that lands on that exact session — and neither digit is guessable from
# inside the hook: the project's is its position in ITS PROFILE's list, and the
# session's is its position in the grid's CARD order, which ⇧hjkl can rewrite. So the
# reorder case is the one that matters; a chord derived from tmux's own ordering would
# look right until the day someone moved a card, then send you to the wrong session.
group "notification carries the jump chord"
if command -v tmux >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  NT="$(mktemp -d)"; mkdir -p "$NT/home/.config/ghostfleet" "$NT/fleet" "$NT/stub"
  printf 'alpha\t/tmp/alpha\twork\nbravo\t/tmp/bravo\twork\n' > "$NT/home/.config/ghostfleet/projects"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "$OSA_OUT"\n' > "$NT/stub/osascript"
  chmod +x "$NT/stub/osascript"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n' > "$NT/t.jsonl"
  tmux -L cf-bravo kill-server 2>/dev/null
  for s in master wa wb wc; do tmux -L cf-bravo new-session -d -s "$s" "sleep 120" 2>/dev/null; done
  chordfor() {           # $1 = session, $2 = socket -> just the chord the popup shows
    rm -f "$NT/osa.txt"
    printf '{"hook_event_name":"Stop","session_id":"s1","cwd":"%s","transcript_path":"%s","message":""}' \
      "$NT" "$NT/t.jsonl" \
    | env -u TMUX HOME="$NT/home" PATH="$NT/stub:$PATH" OSA_OUT="$NT/osa.txt" \
          CLAUDE_FLEET_DIR="$NT/fleet" CLAUDE_FLEET_SOCK="${2:-cf-bravo}" CLAUDE_FLEET_SLOT="$1" \
          "$ROOT/hooks/fleet-event.sh" >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$NT/osa.txt" ] && break; sleep 0.2; done
    sed -n 's/.*display notification "\([^"]*\)".*/\1/p' "$NT/osa.txt" 2>/dev/null | sed 's/ · .*//'
  }
  rm -f "$NT/fleet/cf-bravo.order"
  is "worker: project digit + card digit" "Ctrl-f 2 1" "$(chordfor wa)"
  is "master is Enter, not a digit"       "Ctrl-f 2 ⏎" "$(chordfor master)"
  # THE ONE THAT MATTERS: move the cards and the chord has to move with them
  printf 'wc\nwb\nwa\n' > "$NT/fleet/cf-bravo.order"
  is "reordered: wc is now card 1"        "Ctrl-f 2 1" "$(chordfor wc)"
  is "reordered: wa is now card 3"        "Ctrl-f 2 3" "$(chordfor wa)"
  # A chord it cannot work out must be ABSENT, not wrong — a popup that sends you to
  # someone else's session is worse than one that just names the worker. The unlisted
  # fleet is given LIVE SESSIONS on purpose: point it at an empty socket and the chord
  # goes missing because the SESSION digit can't be found, so the assertion would pass
  # without the project lookup ever being exercised. (First cut did exactly that, and
  # forcing the project digit to 1 sailed straight through it.)
  tmux -L cf-unlisted kill-server 2>/dev/null
  for s in master wa wb; do tmux -L cf-unlisted new-session -d -s "$s" "sleep 120" 2>/dev/null; done
  is "unlisted project: no chord at all"  "wa — $(basename "$NT")" "$(chordfor wa cf-unlisted)"
  tmux -L cf-unlisted kill-server 2>/dev/null
  tmux -L cf-bravo kill-server 2>/dev/null; rm -rf "$NT"
else
  skip "notification chord" "tmux/jq missing"
fi

# ── 6a. the phone client (web/) ───────────────────────────────────────────────
# The PWA renders the SAME cards as the TUI, from the §4 JSON. Two helpers do the work
# and both emit one `name <US> want <US> got` row per check, so the comparing and the
# reporting stay here, in this file's own `is`.
#
# THE ROW COUNT IS ASSERTED FIRST, and that is not a formality. Both helpers `await
# import(...)` and throw on a missing file or a renamed function; a helper that dies
# emits nothing, the `while` loop runs zero times, and the group prints nothing at all
# — which in a 600-assertion run looks exactly like a group that passed. A floor under
# the count is what turns that silence back into a failure.
#
# \x1f, not a tab: tab is IFS-whitespace, so an empty field would collapse and shift
# `got` into `want` — the trap at the top of CLAUDE.md, and one that would report a
# mismatch as a pass here.
group "phone client: the card the phone draws is the card the TUI draws"
if [ -d "$ROOT/web" ]; then
  PW="$(mktemp -d "$TEST_RUNS.$$.pwa.XXXXXX")"
  node "$ROOT/test/helpers/grid-parity.mjs" > "$PW/parity" 2> "$PW/parity.err"
  is "grid-parity ran"                "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/parity.err" | tr '\n' ' ' | sed 's/ *$//')"
  # 4 cards on the smallest fixture set is ~40 rows; 90 leaves room to add fixtures and
  # still fails loudly if the helper dies half way.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/parity")" -ge 90 ] && echo yes || echo "no: $(wc -l < "$PW/parity") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/parity"

  node "$ROOT/test/helpers/pwa-check.mjs" > "$PW/struct" 2> "$PW/struct.err"
  is "pwa-check ran"                  "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/struct.err" | tr '\n' ' ' | sed 's/ *$//')"
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/struct")" -ge 80 ] && echo yes || echo "no: $(wc -l < "$PW/struct") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/struct"
  rm -rf "$PW"

  # cf-sync mirrors only a whitelist of directories into the runtime, and the client is
  # a RUNTIME asset — fleet-serve serves it from ~/.local/libexec/ghostfleet, not from
  # the repo. Left out of that list, the PWA 404s in the browser while every file in the
  # repo is perfectly correct: the same "the file on disk was current, the process was
  # not" trap CLAUDE.md records for a stale MCP server, and just as invisible from here.
  is "cf-sync syncs web/ into the runtime" "yes" \
     "$(grep -qE '^for d in .*\bweb\b' "$ROOT/bin/cf-sync" && echo yes || echo no)"
  is "...and npm ships it"                 "yes" \
     "$(grep -q '"web/"' "$ROOT/package.json" && echo yes || echo no)"

  # The client is served as static files, so it has to parse as what the browser will
  # load it as: ES modules. `node --check` reads web/package.json's "type": "module" to
  # decide, which is exactly why that file is there — without it these parse as CommonJS
  # and every `import` is a syntax error.
  for f in "$ROOT"/web/*.js; do
    node --check "$f" >/dev/null 2>&1 && ok "web/$(basename "$f") parses as a module" \
      || bad "web/$(basename "$f") parses as a module" "ok" "syntax error"
  done
  for f in "$ROOT"/web/fixtures/*.json "$ROOT"/web/manifest.webmanifest "$ROOT"/web/package.json; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null \
      && ok "$(basename "$f") is valid JSON" || bad "$(basename "$f") is valid JSON" "ok" "parse error"
  done
else
  skip "phone client" "web/ not present"
fi

# ── 6b. every command is actually installed ──────────────────────────────────
# A new command that never reaches the install list is invisible until someone hits
# "command not found" — and worse, the SUMMARY line was hand-maintained separately from
# the loop that does the linking, so it had already drifted twice (it was still missing
# fleet-stack, then fleet-slot) and told you it had not linked a command it just had.
# The summary is derived now; this keeps the LIST honest.
group "install list covers every command"
# deliberately not linked: invoked by their parent, not by a user on PATH
NOT_LINKED="fleet-grid.mjs npx-install.mjs"
for f in "$ROOT"/bin/*; do
  b="$(basename "$f")"
  case " $NOT_LINKED " in *" $b "*) continue ;; esac
  # "does it appear at all", not "exactly once": ghostfleet and fleet-spawn are named
  # in prose elsewhere in the installer, and pinning a COUNT would fail on that.
  is "$b is in install.sh's list" "yes" \
     "$(grep -qE "(^|[( ])$b([ )]|\$)" "$ROOT/install.sh" 2>/dev/null && echo yes || echo no)"
done

# ── 7. every command parses ──────────────────────────────────────────────────
group "syntax"
for f in "$ROOT"/bin/*; do
  case "$f" in *.mjs) node --check "$f" >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error" ;;
                   *) bash -n "$f"      >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error" ;;
  esac
done
for f in "$ROOT"/hooks/*.sh; do
  bash -n "$f" >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error"
done
node --check "$ROOT/mcp/fleet-mcp.mjs" >/dev/null 2>&1 && ok "fleet-mcp.mjs parses" || bad "fleet-mcp.mjs parses" "ok" "syntax error"
node --check "$ROOT/test/helpers/mcp-argcheck.mjs" >/dev/null 2>&1 && ok "mcp-argcheck helper parses" || bad "mcp-argcheck helper parses" "ok" "syntax error"
node --check "$ROOT/hooks/opencode-fleet-event.js" >/dev/null 2>&1 && ok "opencode plugin parses" || bad "opencode plugin parses" "ok" "syntax error"

printf '\n%s passed  %s%s failed%s  %s skipped\n' "$PASS" "$([ "$FAIL" -gt 0 ] && printf '%s' "$R")" "$FAIL" "$N" "$SKIP"
[ "$FAIL" -eq 0 ]
