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

# ── the run's environment: NOTHING may force colour ──────────────────────────
# Every value this suite compares is captured through a pipe, and node decides whether to
# colourise by asking whether stdout is a tty — except when FORCE_COLOR overrides that.
# `console.log(1)` on a bare NUMBER goes through util.inspect, which paints a number
# yellow, so a helper that answered `1` actually answered $'\033[33m1\033[39m' and its red
# line printed as
#
#     expected: 1
#     got:      1
#
# two values that look identical and are not. This repo has now been bitten twice. §2's
# busy_re probe was the first (fixed in place with String()); the second was free_port(),
# where the cost was not one assertion but the whole serve half of the suite: a coloured
# port makes $BASE a URL curl can never reach, `fleet-serve init --port` parses it as NaN
# and writes null, so every daemon fell back to its built-in 8787, was abandoned there
# still holding the port, and the next one died EADDRINUSE. 1350 green assertions became
# 1051 passed / 4 failed / 8 skipped — six groups skipping with "server did not come up"
# and three assertions in OTHER groups going red over logs those daemons never wrote. Not
# one line of that output mentioned colour, and the suite is green again the moment the
# variable is absent, which is why it looked like a phantom.
#
# UNSET HERE rather than hunting every console.log, for the same reason §0 below
# namespaces the socket DIRECTORY instead of renaming forty sockets: this reaches the
# helpers that have not been written yet. The String() guards stay as well — a suite that
# is only correct because somebody scrubbed its environment is one `export` away from
# lying again — and the group at the end of §0 proves both halves in both directions.
# NO_COLOR is deliberately NOT set: that would change what the code UNDER TEST emits,
# and this is about what the harness CAPTURES.
unset FORCE_COLOR CLICOLOR_FORCE

group() { GROUP="$1"; case "$GROUP" in *"$FILTER"*) printf '\n%s%s%s\n' "$D" "$GROUP" "$N" ;; esac; }
skip()  { case "$GROUP" in *"$FILTER"*) SKIP=$((SKIP+1)); printf '  %s○%s %s %s(%s)%s\n' "$Y" "$N" "$1" "$D" "$2" "$N" ;; esac; }
ok()    { PASS=$((PASS+1)); printf '  %s✔%s %s\n' "$G" "$N" "$1"; }
# A red line has to be legible, and two values that differ only in bytes a terminal does
# not draw print as the same value — which is how "expected: 1 / got: 1" happened above.
# ESC, tab, CR and newline come back as \e \t \r \n, so a failure that reads as equal can
# only mean `is` itself is broken, rather than being a puzzle about the value.
vis()   { local v="$1"; v="${v//$'\e'/\\e}"; v="${v//$'\t'/\\t}"
          v="${v//$'\r'/\\r}"; v="${v//$'\n'/\\n}"; printf '%s' "$v"; }
bad()   { FAIL=$((FAIL+1)); printf '  %s✘%s %s\n     %sexpected:%s %s\n     %sgot:     %s %s\n' \
            "$R" "$N" "$1" "$D" "$N" "$(vis "$2")" "$D" "$N" "$(vis "$3")"; }
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
# at all. Nothing started here can touch cf-acme-api or cf-ghostfleet now even if
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
# A LEAKED fleet-serve is the same hazard wearing a TCP port. The suite's own teardown
# kills the ones it started, and ⌃C reaches it through the INT trap — but a run that is
# SIGKILLed runs no trap at all, and a daemon left holding a port is exactly the
# cross-run interference this section exists to stop. Measured once: a run killed mid-way
# left one alive for half an hour. It is found by its own argv, which names the dead run's
# directory, so this can only ever reach a daemon THIS file started under a directory that
# is provably nobody's any more.
kill_serves_in() {                 # $1 = a run directory
  local p
  for p in $(pgrep -f "$1/.*fleet-serve.mjs" 2>/dev/null); do
    [ "$p" = "$$" ] || kill "$p" 2>/dev/null
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
    kill_serves_in "$d"; kill_servers_in "$d"; rm -rf "$d"
  done
  return 0
}
# fleet-serve is a background node child, not a tmux server, so the sweep above cannot
# reach it — and a leaked daemon holding a TCP port is the same cross-run interference
# this section exists to stop. $SERVE_PIDS is set by the fleet-serve group.
trap 'rc=$?; kill ${SERVE_PIDS:-} 2>/dev/null; kill_serves_in "$TMUX_TMPDIR"; kill_servers_in "$TMUX_TMPDIR"; rm -rf "$TMUX_TMPDIR"; exit $rc' EXIT
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

# The other precondition every group rests on, proven the same way and for the same
# reason: a guard that is never exercised looks exactly like one that works. So put the
# variable BACK and check the probe changes — without that direction this group would pass
# just as happily on a node that colourises nothing, and the unset would be cargo.
group "the harness captures plain bytes"
if command -v node >/dev/null 2>&1; then
  ESC="$(printf '\033')"
  is "a bare number is captured bare"       "1" "$(node -e 'console.log(1)' 2>/dev/null)"
  is "...with no escape in it"              "0" "$(node -e 'console.log(1)' 2>/dev/null | grep -c "$ESC" || true)"
  # the direction that makes the one above mean something
  is "FORCE_COLOR would have painted it"    "1" \
     "$(FORCE_COLOR=3 node -e 'console.log(1)' 2>/dev/null | grep -c "$ESC" || true)"
  is "...and then it is not the string 1"   "0" \
     "$([ "$(FORCE_COLOR=3 node -e 'console.log(1)' 2>/dev/null)" = 1 ] && echo 1 || echo 0)"
  # String() is the per-site half, and it has to hold with the variable back ON — that is
  # what stops the next exported FORCE_COLOR from costing the serve section again.
  is "String() survives forced colour"      "1" \
     "$(FORCE_COLOR=3 node -e 'console.log(String(1))' 2>/dev/null)"
else
  skip "plain bytes" "node missing"
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

# ── setting the agent AFTER the project exists ──────────────────────────────
# "the master cant be selected as open code or codex". Everything downstream of the 4th
# column could already READ it and nothing could write one after `add` — so every project
# that already existed, which is all of them, had no way to change it but a text editor.
group "fleet-project agent (the edit path)"
T="$(mktemp -d)"; mkdir -p "$T/.config/ghostfleet"
cf="$T/.config/ghostfleet/projects"
fp() { PATH="$ROOT/bin:$PATH" HOME="$T" "$ROOT/bin/fleet-project" "$@"; }
{ printf '# a comment the format documents itself with\n'
  printf 'three\t~/a\twork\n'
  printf 'noprof\t~/b\t\n'
  printf 'twocol\t~/c\n'
  printf 'already\t~/d\twork\tcodex\n'; } > "$cf"
fp agent three opencode >/dev/null 2>&1
is "sets the 4th column"            "opencode" "$(awk -F'\t' '$1=="three"{print $4}' "$cf")"
is "...and leaves the profile"      "work"     "$(awk -F'\t' '$1=="three"{print $3}' "$cf")"
is "...on exactly 4 fields"         "4"        "$(awk -F'\t' '$1=="three"{print NF}' "$cf")"
is "...touching nobody else"        "codex"    "$(awk -F'\t' '$1=="already"{print $4}' "$cf")"
# The header is the only documentation of this format; an edit that ate it would be silent.
is "the comment survives an edit"   "1"        "$(grep -c '^# a comment' "$cf" || true)"
# CLEARING IS AN EMPTY COLUMN, NOT THE WORD claude. grid.js prints "profile · agent" on
# any truthy agent, so writing 'claude' would make every default project start saying
# "· claude" — hiding the one project that actually differs.
fp agent three --none >/dev/null 2>&1
is "--none clears it"               ""         "$(awk -F'\t' '$1=="three"{print $4}' "$cf")"
is "...back to 3 fields"            "3"        "$(awk -F'\t' '$1=="three"{print NF}' "$cf")"
is "...and never the word claude"   "0"        "$(grep -c 'claude' "$cf" || true)"
# THE TRAP THIS FEATURE WALKS INTO. A project with an EMPTY profile plus an agent is
# `name<TAB>path<TAB><TAB>agent`, and tab is IFS-whitespace: `IFS=$'\t' read` collapses
# the run, the agent lands in `prof`, and the fleet socket — derived from the profile —
# comes out as cf-<agent>-<name>. Measured on main before the fix: profile=opencode,
# agent=claude, FLEET=cf-opencode-noprof. That is CLAUDE.md's first entry arriving
# through a feature that made it reachable from a button.
fp agent noprof opencode >/dev/null 2>&1
is "empty profile: agent lands in 4" "opencode" "$(awk -F'\t' '$1=="noprof"{print $4}' "$cf")"
is "...and column 3 stays empty"     ""         "$(awk -F'\t' '$1=="noprof"{print $3}' "$cf")"
lst="$(fp list 2>/dev/null)"
is "...the reader does not shift it"  "work"     "$(awk '$1=="noprof"{print $2}' <<<"$lst")"
is "...the agent is read as an agent" "opencode" "$(awk '$1=="noprof"{print $3}' <<<"$lst")"
# The one that actually costs something: the socket is name+profile, and a shifted
# profile moves the whole fleet somewhere nothing else is looking.
is "...and the SOCKET is unchanged"   "cf-noprof" "$(awk '$1=="noprof"{print $4}' <<<"$lst")"
# ...and the list is not empty for some unrelated reason, which is how the first cut of
# that fix passed: `awk -v OFS='\x1f'` is a gawk-ism, BSD awk left the literal text, and
# every row was dropped. A green "no shift" over an empty list proves nothing.
is "...and every project is listed"   "4"         "$(grep -cE '^(three|noprof|twocol|already) ' <<<"$lst" || true)"
# A 2-column line has no profile field at all; column 3 has to be MADE, not skipped.
fp agent twocol codex >/dev/null 2>&1
is "2-col: grows to 4 fields"        "4"        "$(awk -F'\t' '$1=="twocol"{print NF}' "$cf")"
is "2-col: agent is in column 4"     "codex"    "$(awk -F'\t' '$1=="twocol"{print $4}' "$cf")"
is "2-col: socket still bare"        "cf-twocol" "$(fp list 2>/dev/null | awk '$1=="twocol"{print $4}')"
# Refusals, both of them, or the picker could write a default that never applies.
fp agent three notreal >/dev/null 2>&1; is "unknown agent is refused"  "1" "$?"
is "...and nothing was written"      "0"        "$(grep -c 'notreal' "$cf" || true)"
fp agent nosuchproject codex >/dev/null 2>&1; is "unknown project is refused" "1" "$?"
# THE RUNNING MASTER DOES NOT CHANGE, and the command has to say so — CLAUDE_FLEET_AGENT
# is read once, when the tmux session is created. Without this line the setting reads as
# broken: you pick codex and the master goes on answering as claude.
is "it says the running master is unaffected" "1" \
   "$(fp agent already opencode 2>&1 | grep -c 'RUNNING master keeps the agent' || true)"
is "...and warns what the choice costs"       "1" \
   "$(fp agent already codex 2>&1 | grep -c 'heads up' || true)"
is "...and does not warn for the default"     "0" \
   "$(fp agent already --none 2>&1 | grep -c 'heads up' || true)"
rm -rf "$T"

# ── what a non-claude master actually loses ─────────────────────────────────
# MEASURED, not assumed, and the UI reads these rather than spelling them. The wiring gap
# #88 recorded is CLOSED as of 2026-08-27: install.sh now registers the ghostfleet MCP for
# codex (~/.codex/config.toml) and opencode (~/.config/opencode/opencode.jsonc) as well as
# into every claude profile, so `no fleet_* tools` is no longer true of any of them and
# these assertions had to move with it — a stale warning is worse than none.
#
# WHAT STAYS TRUE, and the three fields keep them apart:
#   hooks     codex still pushes NO events. MCP is tools; hooks are push events. It can now
#             drive the fleet and still cannot tell it anything, so its status is read from
#             its pane and a question it asks may never reach the inbox.
#   mcp_self  codex starts an MCP server with a scrubbed environment (measured by calling
#             the tool: fleet_list with no arguments answered "fleet-list: no socket"), so
#             its sessions must NAME the project. opencode passes its env and does not.
#   skill     ghostfleet-orchestrate is a Claude Code skill and stays Claude-only, so the
#             other two have the tools without the instructions for using them.
group "agent capabilities are declared, not hardcoded"
fa() { "$ROOT/bin/fleet-agent" "$@"; }
# A NAMED HELPER, not a `case` inside $( ). macOS ships bash 3.2 and this suite runs on
# it: `$(case "$x" in a|b) echo 1 ;; esac)` mis-parses there — the `)` closing the pattern
# is taken for the one closing the substitution — so every one of these came back empty
# and read as a missing declaration rather than as a quoting bug.
yn() { case "$1" in yes|no) echo 1 ;; *) echo 0 ;; esac; }
for a in $(fa list); do
  is "$a declares hooks"    "1" "$(yn "$(fa field "$a" hooks)")"
  is "$a declares mcp"      "1" "$(yn "$(fa field "$a" mcp)")"
  is "$a declares mcp_self" "1" "$(yn "$(fa field "$a" mcp_self)")"
  is "$a declares skill"    "1" "$(yn "$(fa field "$a" skill)")"
done
# Every agent has the TOOLS now, which is the change; the fields below are where they differ.
is "all three have the fleet_* tools" "yes" \
   "$([ "$(fa field claude mcp)" = yes ] && [ "$(fa field opencode mcp)" = yes ] && [ "$(fa field codex mcp)" = yes ] && echo yes || echo no)"
is "...and only claude has the skill" "claude" \
   "$(for a in $(fa list); do [ "$(fa field "$a" skill)" = yes ] && printf '%s' "$a"; done)"
is "...and only codex needs a project" "codex" \
   "$(for a in $(fa list); do [ "$(fa field "$a" mcp_self)" = no ] && printf '%s' "$a"; done)"
# The caveat is COMPOSED from those fields, so a fourth agent gets a warning by declaring
# them. Both directions, because a composer that always returned text would be as useless
# as one that never did: the fully-capable agent must come back EMPTY.
is "claude gives up nothing"          ""  "$(fa caveat claude)"
# THE CLAUSE THAT HAD TO GO. Both of these said "no fleet_* tools" until the MCP server was
# registered for them; asserting its ABSENCE is what stops it coming back by accident.
is "opencode: tools, not a warning"   "0" "$(fa caveat opencode | grep -c 'no fleet_\* tools' || true)"
is "codex: tools either"              "0" "$(fa caveat codex | grep -c 'no fleet_\* tools' || true)"
is "...and it is NOT blind to events" "0" "$(fa caveat opencode | grep -c 'no fleet events' || true)"
is "codex: no events, still"          "1" "$(fa caveat codex | grep -c 'no fleet events' || true)"
# What replaced it, per agent — and the other direction on each, since a composer that
# printed every clause for everybody would pass all the positives above.
is "codex must name the project"      "1" "$(fa caveat codex | grep -c 'must name the project' || true)"
is "...and opencode must not"         "0" "$(fa caveat opencode | grep -c 'must name the project' || true)"
is "opencode: no orchestrate skill"   "1" "$(fa caveat opencode | grep -c 'no orchestrate skill' || true)"
is "codex: no skill either"           "1" "$(fa caveat codex | grep -c 'no orchestrate skill' || true)"
is "...and claude keeps its skill"    "0" "$(fa caveat claude | grep -c 'no orchestrate skill' || true)"
is "an unknown agent is refused"      "1" "$(fa caveat nosuch >/dev/null 2>&1; echo $?)"
# `installed` is what the pickers offer from, and it is a SUBSET of `list` — an option
# that cannot run is worse than a missing one, because picking it leaves the next master
# dead at `exec agent-here` with nothing on screen to say why.
is "installed is a subset of list" "0" \
   "$(comm -13 <(fa list | sort) <(fa installed | sort) | wc -l | tr -d ' ')"

# ── the MCP server reaches codex and opencode, once, globally ────────────────
# EXTRACTED AND DRIVEN WITH STUBS, for two reasons that both matter. Neither CLI exists on
# a CI runner, so a test that shelled out to the real ones would silently become a skip on
# the only machines that run this suite unattended. And `opencode mcp add` cannot be
# sandboxed AT ALL — measured 2026-08-27, it ignores both HOME and XDG_CONFIG_HOME and
# writes the invoking user's real ~/.config/opencode/opencode.jsonc, so a suite that called
# it would edit the developer's own config on every run (it did, once, while this was being
# written). install.sh writes that file with jq for exactly that reason, and jq is testable.
group "install.sh registers the MCP for codex and opencode"
if ! command -v jq >/dev/null 2>&1; then
  skip "codex/opencode MCP registration" "jq is not installed"
else
  MR="$(cd "$(mktemp -d)" && pwd -P)"
  # The two functions, lifted out of the installer. bash, not zsh: they use arrays and
  # `local`, and this file is bash already.
  sed -n '/^register_codex_mcp() {/,/^}/p'    "$ROOT/install.sh" >  "$MR/lib.sh"
  sed -n '/^register_opencode_mcp() {/,/^}/p' "$ROOT/install.sh" >> "$MR/lib.sh"
  is "the codex registrar was extracted"    "1" "$(grep -c '^register_codex_mcp() {' "$MR/lib.sh")"
  is "the opencode registrar too"           "1" "$(grep -c '^register_opencode_mcp() {' "$MR/lib.sh")"
  is "...and both parse"                    "ok" "$(bash -n "$MR/lib.sh" 2>&1 && echo ok)"
  mkdir -p "$MR/bin" "$MR/rt/mcp"
  printf '#!/bin/sh\nexit 0\n' > "$MR/rt/mcp/fleet-mcp.mjs"
  # A codex that RECORDS its argv: the thing worth asserting is the exact command line,
  # because `codex mcp add NAME -- COMMAND` is the syntax and a missing `--` would register
  # a server with no command and fail only when a session tried to use it.
  cat > "$MR/bin/codex" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$MR_RAN"
exit "${MR_CODEX_RC:-0}"
STUB
  printf '#!/bin/sh\nexit 0\n' > "$MR/bin/opencode"      # only needs to EXIST
  chmod +x "$MR/bin/codex" "$MR/bin/opencode"
  mr() {   # $1=xdg-config-home ... runs one registrar with the stubs in front
    ( FLEET_HOME="$MR/rt" XDG_CONFIG_HOME="$1" MR_RAN="$MR/ran" PATH="$MR/bin:$PATH" \
      bash -c 'set -uo pipefail; source "$0"; shift; "$@"' "$MR/lib.sh" x "$2" 2>&1 )
  }

  # ── codex: the argv, and the failure path ─────────────────────────────────
  : > "$MR/ran"
  out="$(mr "$MR/x1" register_codex_mcp)"
  is "codex is registered by the CLI"       "1" "$(printf '%s' "$out" | grep -c 'registered ghostfleet MCP' || true)"
  is "...with the exact argv"               "mcp add ghostfleet -- node $MR/rt/mcp/fleet-mcp.mjs" "$(cat "$MR/ran")"
  is "...and the config file is named"      "1" "$(printf '%s' "$out" | grep -c 'config.toml (codex, global)' || true)"
  # A CLI that fails must not be reported as success — and must say what to run by hand.
  out="$(MR_CODEX_RC=1 mr "$MR/x1" register_codex_mcp)"
  is "a failing codex add is not a success" "0" "$(printf '%s' "$out" | grep -c '✓' || true)"
  is "...and it prints the command"         "1" "$(printf '%s' "$out" | grep -c "codex mcp add ghostfleet -- node $MR/rt/mcp/fleet-mcp.mjs" || true)"
  # Not installed at all: skip, say so, touch nothing.
  : > "$MR/ran"
  # ABSOLUTE BASH. `PATH=/nowhere bash -c …` cannot start: bash applies the assignment
  # before it looks the command up, so the interpreter is what goes missing and the probe
  # prints NOTHING — which reads exactly like a function that stayed silent. Same trick the
  # funnel group uses for node.
  BASH_ABS="$(command -v bash)"
  out="$(FLEET_HOME="$MR/rt" MR_RAN="$MR/ran" PATH="$MR/empty" "$BASH_ABS" -c 'set -uo pipefail; source "$0"; register_codex_mcp' "$MR/lib.sh" 2>&1)"
  is "no codex: it says so"                 "1" "$(printf '%s' "$out" | grep -c 'codex not installed' || true)"
  is "...and runs nothing"                  ""  "$(cat "$MR/ran")"

  # ── opencode: the file we write, and what we refuse to touch ─────────────
  X="$MR/x2"; mkdir -p "$X/opencode"
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "keep-me",\n  "mcp": { "other": { "type": "local", "command": ["true"] } }\n}\n' > "$X/opencode/opencode.jsonc"
  out="$(mr "$X" register_opencode_mcp)"
  cfg="$X/opencode/opencode.jsonc"
  is "opencode's config is written"         "1" "$(printf '%s' "$out" | grep -c 'wrote ghostfleet MCP' || true)"
  # The SHAPE opencode's own CLI produces — type + a command ARRAY — because that is where
  # this shape came from, and a string command there is silently ignored by opencode.
  is "...with the shape opencode uses"     '{"type":"local","command":["node","'"$MR"'/rt/mcp/fleet-mcp.mjs"]}' \
     "$(jq -c '.mcp.ghostfleet' "$cfg")"
  is "...leaving other servers alone"      '{"type":"local","command":["true"]}' "$(jq -c '.mcp.other' "$cfg")"
  is "...and unrelated keys"               '"keep-me"' "$(jq -c '.theme' "$cfg")"
  # IDEMPOTENT: install.sh is re-run routinely, and a second entry under one name is not
  # even expressible in JSON — but a second RUN could still duplicate the servers around it,
  # or drop one.
  #   COUNTED AS WHAT IT MEANS, not as a total. The first cut asserted `.mcp | keys | length`
  # == 1 and went red with 2, which was the ASSERTION being wrong: the fixture plants an
  # unrelated server beside ours on purpose, so two keys is the correct answer and a total
  # cannot say which of them changed. So: exactly one ghostfleet, and the set of OTHER keys
  # identical to what it was before the run.
  others_before="$(jq -c '[.mcp | keys[] | select(. != "ghostfleet")] | sort' "$cfg")"
  out="$(mr "$X" register_opencode_mcp)"
  is "a second run keeps one ghostfleet"   "1" "$(jq '[.mcp | keys[] | select(. == "ghostfleet")] | length' "$cfg")"
  is "...and touches no other server"      "$others_before" "$(jq -c '[.mcp | keys[] | select(. != "ghostfleet")] | sort' "$cfg")"
  is "...leaving that server intact"       '{"type":"local","command":["true"]}' "$(jq -c '.mcp.other' "$cfg")"
  # ...and the entry it rewrote still points at the runtime, so "idempotent" is not "inert".
  is "...and ours still points at the server" "$MR/rt/mcp/fleet-mcp.mjs" "$(jq -r '.mcp.ghostfleet.command[1]' "$cfg")"
  # A FRESH machine has no config at all: one is created rather than the write being skipped.
  Y="$MR/x3"
  out="$(mr "$Y" register_opencode_mcp)"
  is "a missing config is created"          "yes" "$([ -f "$Y/opencode/opencode.jsonc" ] && echo yes || echo no)"
  is "...with the server in it"             "node" "$(jq -r '.mcp.ghostfleet.command[0]' "$Y/opencode/opencode.jsonc" 2>/dev/null)"
  is "...and a \$schema, like opencode's"   "1" "$(jq 'has("$schema")' "$Y/opencode/opencode.jsonc" | grep -c true || true)"
  # A .jsonc MAY hold comments, which jq cannot read. Rewriting it would delete somebody's
  # comments, so the file is LEFT ALONE and the entry is printed instead. This is the
  # direction that matters: a silent clobber of a config file is unrecoverable.
  Z="$MR/x4"; mkdir -p "$Z/opencode"
  printf '{\n  // my notes\n  "theme": "mine"\n}\n' > "$Z/opencode/opencode.jsonc"
  before="$(cat "$Z/opencode/opencode.jsonc")"
  out="$(mr "$Z" register_opencode_mcp)"
  is "a commented .jsonc is not clobbered"  "$before" "$(cat "$Z/opencode/opencode.jsonc")"
  is "...and it says what to paste"         "1" "$(printf '%s' "$out" | grep -c '"mcp": { "ghostfleet"' || true)"
  is "...without claiming success"          "0" "$(printf '%s' "$out" | grep -c '✓' || true)"
  out="$(FLEET_HOME="$MR/rt" PATH="$MR/empty" "$BASH_ABS" -c 'set -uo pipefail; source "$0"; register_opencode_mcp' "$MR/lib.sh" 2>&1)"
  is "no opencode: it says so"              "1" "$(printf '%s' "$out" | grep -c 'opencode not installed' || true)"

  # ── the installer says the part that makes a correct install look broken ──
  # An MCP server is spawned once per session and lives as long as it, so nothing already
  # running gains the tools. That belongs in the OUTPUT, not only in the docs, because the
  # person who needs it has just re-run the installer to fix exactly this.
  is "the installer warns about live sessions" "1" \
     "$(grep -c 'reach NEW sessions only' "$ROOT/install.sh" || true)"
  is "...and says why (one server per session)" "1" \
     "$(grep -c 'spawned once per session' "$ROOT/install.sh" || true)"
  # UNINSTALL COVERS THE NEW HOMES, or removing ghostfleet leaves a server registered
  # against a runtime that no longer exists.
  # THE FINDING BELONGS WHERE SOMEONE WILL HIT IT. A codex session that calls fleet_list and
  # reads "no socket" should find the sentence, not rediscover it — docs/multi-agent-sessions.md
  # is where the capability matrix lives (#88), so Q4 has to say so rather than still asking.
  is "the doc answers Q4 rather than asking" "0" \
     "$(grep -c '^### Q4 (still open)' "$ROOT/docs/multi-agent-sessions.md" || true)"
  # PRESENCE, NOT A COUNT — the same rule the install-list group states: "does it appear at
  # all", not "exactly once". Both of these went red at 1-expected-2, because the finding is
  # deliberately in two places (the degradation summary AND Q4's detail), and pinning a count
  # would make writing the doc better fail a test about whether the doc says it.
  is "...and names the codex asymmetry"      "yes" \
     "$(grep -q 'scrubbed environment' "$ROOT/docs/multi-agent-sessions.md" && echo yes || echo no)"
  is "...with the fix a reader needs"        "yes" \
     "$(grep -q 'fleet_list(project' "$ROOT/docs/multi-agent-sessions.md" && echo yes || echo no)"
  is "...and keeps tools and hooks apart"    "yes" \
     "$(grep -q 'MCP is tools; hooks are push events' "$ROOT/docs/multi-agent-sessions.md" && echo yes || echo no)"
  is "uninstall covers codex"               "1" "$(grep -c 'codex mcp remove ghostfleet' "$ROOT/README.md" || true)"
  is "...and opencode's MCP entry"          "1" "$(grep -c 'del(.mcp.ghostfleet)' "$ROOT/README.md" || true)"
  is "...and opencode's event bridge"       "1" "$(grep -c 'plugin/ghostfleet-event.js' "$ROOT/README.md" || true)"
  rm -rf "$MR"
fi

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
cp "$ROOT"/mcp/*.mjs "$AG/mcp/"             # BIN is <this file>/../bin, so the copy's
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
  if [ "$e" = 1 ] && grep -qF "$tool: missing required argument '$k'" <<< "$txt"; then :
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
# holding several clones AND unrelated products. One project's root here is one of those —
# four acme-api clones plus `billing-svc` and `toolbox` — so the child-scan would hand
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
# ── 4a9c. a spawn that says "started" must have started something ────────────
# fleet-spawn printed its success line one statement below a `new-session` whose exit
# status nobody read, so EVERY failure mode printed "started '<name>' in <worktree>" and
# exited 0. tmux's own error was on stderr all along — and immediately contradicted by
# the success line under it, which is the one a reader believes. Reported from
# one project after the same spawn was re-run three times, because nothing in the output
# told the attempts apart.
#
# Worse than a wrong message: bin/fleet-grid.mjs's createWorktree reads that very line
# (/started '([^']+)'/) to decide which session to attach to. So a failed spawn became a
# confident attach to nothing and the card drew "· FREE — no session yet" — byte-for-byte
# the symptom of the socket-routing bug fixed in #64, which is what made the two
# expensive to tell apart.
#
# NO SHIM NEEDED; both halves are deterministic with the real tmux:
#   * new-session FAILS when its socket directory cannot be made. TMUX_TMPDIR pointing at
#     a FILE gives "couldn't create directory … (Not a directory)" and exit 1.
#   * new-session SUCCEEDS and the session dies anyway when the pane's command comes
#     straight back — rc=0, a real session id, and gone before the settle is over. That
#     is the live cause: agent-here missing because ./install.sh was never run, or a
#     half-synced runtime. Modelled with an agent-here that exits 0, which is the same
#     observable and needs no PATH surgery.
# Both directions, because a check that refused every spawn would "fix" this by breaking
# the only path that is supposed to work.
group "a spawn only says 'started' when it did"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  SW="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$SW/home/.config/ghostfleet" "$SW/ok" "$SW/dies" "$SW/broken"
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$SW/ok/agent-here";   chmod +x "$SW/ok/agent-here"
  printf '#!/usr/bin/env bash\nexit 0\n'   > "$SW/dies/agent-here"; chmod +x "$SW/dies/agent-here"
  # THE CAUSE THIS ACTUALLY WAS, and it needs no stub of ours at all: a `claude` that is a
  # binary for the wrong platform. A claude-code package update left bin/ holding only a
  # Windows claude.exe for ~20 minutes on the machine that reported this, so every spawn
  # in that window died on "cannot execute binary file". Two bytes of MZ header reproduce
  # it, and this variant runs the REAL launcher chain (agent-here -> claude-here -> claude)
  # instead of replacing it, which is what makes it the faithful case.
  mkdir -p "$SW/winbin"
  printf 'MZ\220\000\003\000\000\000' > "$SW/winbin/claude"; chmod +x "$SW/winbin/claude"
  : > "$SW/broken/notadir"                 # TMUX_TMPDIR here cannot hold a socket dir
  SWOUT=""; SWRC=0
  spawnsw() {                    # $1 = which agent-here, $2 = TMUX_TMPDIR, rest = extra args
    rm -rf "$SW/repo" "$SW/w1" "$SW/fleet" "$SW/slots"; mkdir -p "$SW/fleet"
    git init -q -b main "$SW/repo" 2>/dev/null
    git -C "$SW/repo" config user.email t@t; git -C "$SW/repo" config user.name t
    : > "$SW/repo/f"; git -C "$SW/repo" add -A; git -C "$SW/repo" commit -qm init 2>/dev/null
    SWOUT="$( cd "$SW/repo" && HOME="$SW/home" env -u TMUX \
      TMUX_TMPDIR="$2" CLAUDE_FLEET_SOCK=cfsayswhat CLAUDE_FLEET_DIR="$SW/fleet" \
      CLAUDE_FLEET_SLOTS="$SW/slots" PATH="$SW/$1:$ROOT/bin:$PATH" \
      "$ROOT/bin/fleet-spawn" w1 --new "${@:3}" 2>&1 )"; SWRC=$?
    tmux -L cfsayswhat kill-server 2>/dev/null      # the RUN's namespace, not the spawn's
  }
  # ALWAYS A NUMBER. `grep -c` on a file that does not EXIST prints nothing at all — the
  # complaint goes to stderr and no count is written — so no `|| true` can rescue it and
  # the assertion compares "0" against "". A missing manifest IS the answer zero here,
  # and it is the answer the interesting cases produce.
  mfrow() {
    local f="$SW/fleet/cfsayswhat.manifest.tsv"
    [ -f "$f" ] || { echo 0; return 0; }
    grep -c "$SW/w1" "$f" 2>/dev/null || true
  }

  # ── the happy path, which must not regress ──
  spawnsw ok "$TMUX_TMPDIR"
  is "a real spawn still says started"  "1" "$(printf '%s' "$SWOUT" | grep -c "started 'w1'" || true)"
  is "...and exits 0"                   "0" "$SWRC"
  is "...and records the manifest row"  "1" "$(mfrow)"

  # ── new-session FAILS: the socket directory cannot be created ──
  spawnsw ok "$SW/broken/notadir"
  is "a failed new-session exits nonzero" "1" "$([ "$SWRC" = 0 ] && echo 0 || echo 1)"
  is "...and does NOT say started"        "0" "$(printf '%s' "$SWOUT" | grep -c "started 'w1'" || true)"
  is "...and passes tmux's error through" "1" \
     "$(printf '%s' "$SWOUT" | grep -c "couldn't create directory" || true)"
  # a phrase both failure paths share, so the assertion does not track one headline
  is "...and says nothing was removed"    "1" \
     "$(printf '%s' "$SWOUT" | grep -c 'Nothing was removed' || true)"
  is "...and offers the re-run command"   "1" \
     "$(printf '%s' "$SWOUT" | grep -c 'fleet-spawn w1 --reuse w1' || true)"
  # THE ORPHAN IS THE EXPENSIVE HALF: the worktree is fully provisioned by the time
  # new-session runs, so the refusal has to name it or a lead never learns it is there.
  is "...and names the worktree it left"  "1" \
     "$([ "$(printf '%s' "$SWOUT" | grep -c "$SW/w1" || true)" -ge 1 ] && echo 1 || echo 0)"
  is "...leaving NO manifest row"         "0" "$(mfrow)"
  # ...and the tree really is still there, i.e. "nothing has been removed" is true
  is "...which really does still exist"   "1" "$([ -d "$SW/w1" ] && echo 1 || echo 0)"

  # ── new-session RETURNS 0 and the session dies anyway ──
  spawnsw dies "$TMUX_TMPDIR"
  is "a vanished session is a failure"    "1" "$([ "$SWRC" = 0 ] && echo 0 || echo 1)"
  is "...and does NOT say started"        "0" "$(printf '%s' "$SWOUT" | grep -c "started 'w1'" || true)"
  is "...blaming the pane's own command"  "1" \
     "$(printf '%s' "$SWOUT" | grep -c 'exited the instant it started' || true)"
  # named at least once: the cause line says it, and the trailing "other things" list
  # names it again for the PATH case
  is "...and naming agent-here"           "1" \
     "$([ "$(printf '%s' "$SWOUT" | grep -c 'agent-here' || true)" -ge 1 ] && echo 1 || echo 0)"
  is "...and leaves NO manifest row"      "0" "$(mfrow)"

  # ── the same, WITH --prompt ──
  # The promise is the part that wasted the most time downstream: the old code printed
  # "will dispatch the initial prompt once 'w1' is ready for input" and armed a detached
  # poller that spends 90 x 2s watching capture-pane on a session that will never appear,
  # then fires fleet-send into nothing. Without --prompt that line never prints either
  # way, so asking for one is what makes this assertion mean anything.
  spawnsw dies "$TMUX_TMPDIR" --prompt 'do the thing'
  is "no prompt is promised on failure"   "0" \
     "$(printf '%s' "$SWOUT" | grep -c 'will dispatch the initial prompt' || true)"
  is "...and it still fails loudly"       "1" "$([ "$SWRC" = 0 ] && echo 0 || echo 1)"

  # ── the real one: a wrong-platform agent binary, through the real launcher chain ──
  spawnsw winbin "$TMUX_TMPDIR"
  is "a wrong-platform claude fails"      "1" "$([ "$SWRC" = 0 ] && echo 0 || echo 1)"
  is "...and does NOT say started"        "0" "$(printf '%s' "$SWOUT" | grep -c "started 'w1'" || true)"
  is "...pointing at the agent binary"    "1" \
     "$(printf '%s' "$SWOUT" | grep -c 'agent binary could not exec' || true)"
  is "...and how to check it"             "1" \
     "$(printf '%s' "$SWOUT" | grep -c -- "claude --version" || true)"
  is "...and leaves NO manifest row"      "0" "$(mfrow)"

  # THE CHECK IS BY SESSION ID AND WITHOUT -t, because a session NAME can be tmux TARGET
  # SYNTAX (a leading `+` is an expression, and which session it resolves to is
  # version-dependent — CLAUDE.md). Pinned in the source, since "simplify it to
  # has-session" is the obvious wrong edit and it would still pass every case above.
  # comments stripped first: the comment in there EXPLAINS why -t is wrong, so grepping
  # the whole function matches the explanation and passes for a function that uses it
  is "the liveness check avoids -t"       "0" \
     "$(sed -n '/^session_live() {/,/^}/p' "$ROOT/bin/fleet-spawn" \
        | grep -v '^[[:space:]]*#' | grep -c 'has-session\| -t ' || true)"
  is "...and compares session ids"        "1" \
     "$(sed -n '/^session_live() {/,/^}/p' "$ROOT/bin/fleet-spawn" | grep -c "session_id" || true)"
  rm -rf "$SW"
else
  skip "spawn verifies its session" "git or tmux missing"
fi


# ── 4a10. a worker must not spawn workers ────────────────────────────────────
# A session finishes a PR, is told "branch off fresh staging", and reaches for the
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

# ── 4a10a1. an explicit socket has to be able to win ─────────────────────────
# fleet-spawn prefers $TMUX over $CLAUDE_FLEET_SOCK on purpose (a long-running --resume
# Claude holds a stale env var; the live server it sits in cannot go stale). But that
# left NO way for a caller to say "this socket, I mean it", and $TMUX is inherited by
# anything launched from inside a fleet session. Measured: vhs, started from a fleet
# session to record `ghostfleet demo`, handed the recorded shell the RECORDER's socket,
# so the grid on screen asked for a worker and fleet-spawn put it on the launching
# session's fleet. Nothing errored — the grid drew the new worktree as "· FREE — no
# session yet", because the session was real and simply on a socket that grid never reads.
#
# The manifest FILENAME is the witness: fleet-spawn writes "<sock>.manifest.tsv", so it
# names the socket the run actually chose without racing a session boot.
#
# BOTH DIRECTIONS, and the first one matters most: $TMUX must STILL beat the plain env
# var, or this is the silent precedence flip it was meant not to be.
group "an explicit socket beats \$TMUX"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  XS="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$XS/home/.config/ghostfleet" "$XS/stub"
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$XS/stub/agent-here"; chmod +x "$XS/stub/agent-here"
  # a $TMUX that names a cf-* server, formatted the way tmux does: <socket>,<pid>,<n>
  FAKE_TMUX="$TMUX_TMPDIR/cf-xsamb,1,0"
  sockchosen() {                 # $1 = env assignment (or ""), rest = extra spawn args
    local envs="$1"; shift
    rm -rf "$XS/repo" "$XS/fleet" "$XS/wt"; mkdir -p "$XS/fleet"
    git init -q -b main "$XS/repo" 2>/dev/null
    git -C "$XS/repo" config user.email t@t; git -C "$XS/repo" config user.name t
    : > "$XS/repo/f"; git -C "$XS/repo" add -A; git -C "$XS/repo" commit -qm init 2>/dev/null
    ( cd "$XS/repo" && HOME="$XS/home" TMUX="$FAKE_TMUX" CLAUDE_FLEET_SOCK=cf-xsenv \
      CLAUDE_FLEET_DIR="$XS/fleet" PATH="$XS/stub:$ROOT/bin:$PATH" \
      env ${envs:+$envs} "$ROOT/bin/fleet-spawn" wt --new "$@" ) >/dev/null 2>&1
    for s in cf-xsamb cf-xsenv cf-xsflag cf-xsforce cf-other; do
      tmux -L "$s" kill-server 2>/dev/null
    done
    ( cd "$XS/fleet" && ls *.manifest.tsv 2>/dev/null | sed 's/\.manifest\.tsv$//' )
  }
  is "no override: \$TMUX still wins"   "cf-xsamb"   "$(sockchosen '')"
  is "-s wins over \$TMUX"              "cf-xsflag"  "$(sockchosen '' -s cf-xsflag)"
  is "--socket is the same flag"        "cf-xsflag"  "$(sockchosen '' --socket cf-xsflag)"
  is "the env override wins too"        "cf-xsforce" "$(sockchosen CLAUDE_FLEET_SOCK_FORCE=cf-xsforce)"
  is "-s beats the env override"        "cf-xsflag"  \
     "$(sockchosen CLAUDE_FLEET_SOCK_FORCE=cf-xsforce -s cf-xsflag)"
  # An explicit socket must survive route_to_owner too, or "I mean it" is a suggestion.
  # Registering this repo's PARENT as another project is what would otherwise move it.
  printf 'other\t%s\twork\n' "$XS" > "$XS/home/.config/ghostfleet/projects"
  is "route_to_owner does not move it"  "cf-xsflag"  "$(sockchosen '' -s cf-xsflag)"
  # ...and the other direction: with no explicit socket, owner routing still happens
  is "...but it still routes otherwise" "cf-other"   "$(sockchosen '')"
  rm -f "$XS/home/.config/ghostfleet/projects"
  rm -rf "$XS"
else
  skip "explicit spawn socket" "git or tmux missing"
fi

# The grid is the caller that was actually bitten, and reproducing it needs no props: a
# tmux server whose socket happens to start with "cf-" is all $TMUX has to say for
# fleet-spawn to prefer it, and the grid runs in a pane. So run the real TUI on a pane of
# cf-gpsn, point it at a fleet on cf-gpin, press `w` and create — the manifest filename
# says which fleet the worker actually landed on.
group "the grid's create lands on the grid's own fleet"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  GP="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$GP/fleet" "$GP/stub"
  # A STUB `claude`, NOT A STUB `agent-here`. createWorktree prepends the repo's OWN bin/
  # to PATH (it has to, so fleet-agent is findable), which shadows any agent-here a test
  # puts there — so the session runs the real one, which execs claude-here, which execs
  # `claude`. On a dev box that exists and the session lives; on a CI runner it does not,
  # the pane comes straight back, and the session is gone before the assertion looks.
  #   That went unnoticed until fleet-spawn started verifying its session: the old code
  # printed "started" and wrote the manifest regardless, so this asserted the manifest of
  # a session that had already died. Stubbing the thing at the END of the chain is what
  # makes the test mean the same on both.
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$GP/stub/claude"; chmod +x "$GP/stub/claude"
  git init -q -b main "$GP/repo" 2>/dev/null
  git -C "$GP/repo" config user.email t@t; git -C "$GP/repo" config user.name t
  : > "$GP/repo/f"; git -C "$GP/repo" add -A; git -C "$GP/repo" commit -qm init 2>/dev/null
  tmux -L cf-gpin kill-server 2>/dev/null; tmux -L cf-gpsn kill-server 2>/dev/null
  tmux -L cf-gpin new-session -d -s master -c "$GP/repo" 'sleep 90' 2>/dev/null
  # a launcher script, not an inline command: PATH has to be EXPANDED at run time and a
  # $PATH inside tmux's own quoting is the sort of thing that silently ends up literal,
  # which reads back as "the grid never started" rather than as a quoting mistake
  { echo '#!/usr/bin/env bash'
    echo "export CLAUDE_FLEET_ROOT='$GP/repo' CLAUDE_FLEET_DIR='$GP/fleet'"
    echo "export PATH=\"$GP/stub:$ROOT/bin:\$PATH\""
    echo "exec node '$ROOT/bin/fleet-grid.mjs' cf-gpin >/dev/null 2>&1"; } > "$GP/launch"
  chmod +x "$GP/launch"
  tmux -L cf-gpsn new-session -d -x 120 -y 40 "$GP/launch" 2>/dev/null
  sleep 2
  tmux -L cf-gpsn send-keys w 2>/dev/null;      sleep 1
  tmux -L cf-gpsn send-keys wkr 2>/dev/null;    sleep 1
  tmux -L cf-gpsn send-keys Enter 2>/dev/null;  sleep 6
  tmux -L cf-gpsn kill-server 2>/dev/null; tmux -L cf-gpin kill-server 2>/dev/null
  is "the worktree really got made" "1" "$([ -d "$GP/wkr" ] && echo 1 || echo 0)"
  is "the worker is on cf-gpin"     "cf-gpin" \
     "$( cd "$GP/fleet" && ls *.manifest.tsv 2>/dev/null | sed 's/\.manifest\.tsv$//' )"
  rm -rf "$GP"
else
  skip "grid create socket" "git, tmux or node missing"
fi

# ── 4a10a2. a branch name git already resolves as a root ref ─────────────────
# git looks a bare name up as $GIT_DIR/<name> BEFORE refs/heads/<name>, and tools drop
# files in the git dir: opencode writes $GIT_DIR/opencode. So once a worker called
# `opencode` has run, that name resolves as BOTH the stray file and refs/heads/opencode,
# and `git worktree add <path> -b opencode` dies with `fatal: invalid reference: opencode`
# — AFTER creating the branch. Half-succeeded: a branch nobody asked for, no worktree,
# and a repo needing hand cleanup. A slashed name (.git/feat/x) does it too.
#
# Only content git can PARSE as a ref does this, which is what keeps the guard off git's
# own files: a branch called `config` is fine, because `[core]` is not a ref.
group "a stray ref in the git dir is refused up front"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  RG="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$RG/home/.config/ghostfleet" "$RG/stub" "$RG/fleet"
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$RG/stub/agent-here"; chmod +x "$RG/stub/agent-here"
  BOGUS=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
  mkrg() {                       # a fresh repo; the case then drops what it likes in .git
    rm -rf "$RG/repo" "$RG"/wt* "$RG/opencode" "$RG/config"
    git init -q -b main "$RG/repo" 2>/dev/null
    git -C "$RG/repo" config user.email t@t; git -C "$RG/repo" config user.name t
    : > "$RG/repo/f"; git -C "$RG/repo" add -A; git -C "$RG/repo" commit -qm init 2>/dev/null
  }
  spawnrg() {                    # $@ = fleet-spawn args -> what it said
    ( cd "$RG/repo" && HOME="$RG/home" env -u TMUX CLAUDE_FLEET_SOCK=cfstrayref \
      CLAUDE_FLEET_DIR="$RG/fleet" PATH="$RG/stub:$ROOT/bin:$PATH" \
      "$ROOT/bin/fleet-spawn" "$@" --new 2>&1 )
    tmux -L cfstrayref kill-server 2>/dev/null
  }
  # THE REASON THE GUARD EXISTS, proven rather than asserted: git really does create the
  # branch and then refuse. If a future git stops doing this, that is worth a red line.
  mkrg; printf '%s\n' "$BOGUS" > "$RG/repo/.git/opencode"
  graw="$(git -C "$RG/repo" worktree add "$RG/wtraw" -b opencode 2>&1)"; grc=$?
  is "git itself fails on it"           "1" "$([ "$grc" = 0 ] && echo 0 || echo 1)"
  is "...saying invalid reference"      "1" "$(printf '%s' "$graw" | grep -c 'invalid reference' || true)"
  is "...with the branch already made"  "1" "$(git -C "$RG/repo" branch --list opencode | grep -c opencode || true)"
  is "...and no worktree"               "0" "$([ -e "$RG/wtraw" ] && echo 1 || echo 0)"

  mkrg; printf '%s\n' "$BOGUS" > "$RG/repo/.git/opencode"
  out="$(spawnrg opencode)"
  is "spawn refuses the collision"      "1" "$(printf '%s' "$out" | grep -c 'already resolves as a ref' || true)"
  # named at least once — the message points at it twice, once to say what is in the way
  # and once in the `mv` that clears it
  is "...naming the file"               "1" \
     "$([ "$(printf '%s' "$out" | grep -c '\.git/opencode' || true)" -ge 1 ] && echo 1 || echo 0)"
  is "...and naming a way out"          "1" "$(printf '%s' "$out" | grep -c -- '--branch' || true)"
  is "...creating NO branch"            "0" "$(git -C "$RG/repo" branch --list opencode | grep -c opencode || true)"
  is "...and NO worktree"               "0" "$([ -e "$RG/opencode" ] && echo 1 || echo 0)"
  # a slashed branch name collides the same way, so the guard cannot only look at a leaf
  mkrg; mkdir -p "$RG/repo/.git/feat"; printf '%s\n' "$BOGUS" > "$RG/repo/.git/feat/x"
  out2="$(spawnrg wtb --branch feat/x)"
  is "a slashed branch too"             "1" "$(printf '%s' "$out2" | grep -c 'already resolves as a ref' || true)"
  # ── the directions that prove it is not "refuse anything in the git dir" ──
  mkrg; printf 'not a ref at all\n' > "$RG/repo/.git/opencode"
  out3="$(spawnrg opencode)"
  is "unparseable content is no ref"    "0" "$(printf '%s' "$out3" | grep -c 'already resolves as a ref' || true)"
  is "...so that worktree IS created"   "1" "$([ -d "$RG/opencode" ] && echo 1 || echo 0)"
  # git's OWN files share the git dir, and a branch named after one of them is fine
  mkrg; out4="$(spawnrg config)"
  is "a branch called 'config' is fine" "0" "$(printf '%s' "$out4" | grep -c 'already resolves as a ref' || true)"
  is "...and really gets a worktree"    "1" "$([ -d "$RG/config" ] && echo 1 || echo 0)"
  rm -rf "$RG"
else
  skip "git-dir ref collision" "git or tmux missing"
fi

# ── 4a10a3. the form must show the ADVICE, not the escape hatch ──────────────
# createWorktree kept `.split('\n').filter(Boolean).pop()` of fleet-spawn's stderr — the
# LAST line. The nested-worktree refusal is nine lines and ends with "Override
# deliberately with CLAUDE_FLEET_ALLOW_NESTED=1", so the form showed the one thing you
# must not do and threw away "Really want another worker? Run it from the main checkout"
# along with both commands that fix it.
group "the new-worktree form keeps the advice"
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  AD="$(cd "$(mktemp -d)" && pwd -P)"
  git init -q -b main "$AD/repo" 2>/dev/null
  git -C "$AD/repo" config user.email t@t; git -C "$AD/repo" config user.name t
  : > "$AD/repo/f"; git -C "$AD/repo" add -A; git -C "$AD/repo" commit -qm init 2>/dev/null
  git -C "$AD/repo" worktree add -q "$AD/wt-a" -b wt-a 2>/dev/null
  # Lift the real function out of the grid and feed it the real refusal from the real
  # command — a fixture of either one is a copy that drifts from what ships.
  shape() { node -e '
    const fs=require("fs");
    const m=fs.readFileSync(process.argv[1],"utf8").match(/^function spawnFailLines\([\s\S]*?^}$/m);
    if(!m){console.log("NO-spawnFailLines-FOUND");process.exit(0)}
    const spawnFailLines=eval("("+m[0]+")");
    let raw=""; process.stdin.on("data",d=>raw+=d)
      .on("end",()=>console.log(spawnFailLines(raw).join("\n")));
  ' "$ROOT/bin/fleet-grid.mjs"; }
  raw="$( cd "$AD/wt-a" && env -u TMUX CLAUDE_FLEET_SOCK=cfadvice "$ROOT/bin/fleet-spawn" nope 2>&1 )"
  sh="$(printf '%s' "$raw" | shape)"
  is "keeps 'from the main checkout'"      "1" "$(printf '%s' "$sh" | grep -c 'from the main checkout' || true)"
  is "keeps the re-branch command"        "1" "$(printf '%s' "$sh" | grep -c 'checkout -B' || true)"
  is "keeps the spawn-from-there command" "1" "$(printf '%s' "$sh" | grep -c 'fleet-spawn nope' || true)"
  is "DROPS the override line"            "0" "$(printf '%s' "$sh" | grep -c 'ALLOW_NESTED' || true)"
  is "leads with what went wrong"         "1" "$(printf '%s' "$sh" | head -1 | grep -c 'ALREADY in a worktree' || true)"
  is "...without the command's prefix"    "0" "$(printf '%s' "$sh" | head -1 | grep -c 'fleet-spawn:' || true)"
  is "bounded, so the form cannot grow"   "1" \
     "$([ "$(printf '%s\n' "$sh" | grep -c .)" -le 6 ] && echo 1 || echo 0)"
  # the other direction: a ONE-line refusal must still arrive whole, not empty
  one="$(printf "fleet-spawn: unknown agent 'zz' (known: claude )\n" | shape)"
  is "a one-line refusal survives"        "1" "$(printf '%s' "$one" | grep -c "unknown agent 'zz'" || true)"
  rm -rf "$AD"
else
  skip "worktree form advice" "git or node missing"
fi

# The layout half, in the real TUI: the footer must not move when the message does. The
# pure function above cannot see this, and neither can `node --check`.
group "the worktree form's footer stays put"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  FT="$(cd "$(mktemp -d)" && pwd -P)"
  git init -q -b main "$FT/repo" 2>/dev/null
  git -C "$FT/repo" config user.email t@t; git -C "$FT/repo" config user.name t
  : > "$FT/repo/f"; git -C "$FT/repo" add -A; git -C "$FT/repo" commit -qm init 2>/dev/null
  # CLAUDE_FLEET_ROOT at a LINKED WORKTREE is not contrived: that is exactly what
  # mainRepo()'s child scan handed back on a container root, and it is how the nine-line
  # refusal reached this form in the first place.
  git -C "$FT/repo" worktree add -q "$FT/wt-a" -b wt-a 2>/dev/null
  tmux -L cfftin kill-server 2>/dev/null
  tmux -L cfftin new-session -d -s master -c "$FT/repo" 'sleep 90' 2>/dev/null
  formpane() {                   # $1 = a name to type (or "") -> the pane as drawn
    tmux -L cfftout kill-server 2>/dev/null
    tmux -L cfftout new-session -d -x 120 -y 40 \
      "CLAUDE_FLEET_ROOT='$FT/wt-a' CLAUDE_FLEET_DIR='$FT' \
       node '$ROOT/bin/fleet-grid.mjs' cfftin >/dev/null 2>&1" 2>/dev/null
    sleep 2
    tmux -L cfftout send-keys w 2>/dev/null; sleep 1
    if [ -n "$1" ]; then
      tmux -L cfftout send-keys "$1" 2>/dev/null; sleep 1
      tmux -L cfftout send-keys Enter 2>/dev/null; sleep 4
    fi
    tmux -L cfftout capture-pane -p 2>/dev/null
    tmux -L cfftout kill-server 2>/dev/null
  }
  footrow() { printf '%s\n' "$1" | grep -n 'create + open' | head -1 | cut -d: -f1; }
  clean="$(formpane '')"
  erred="$(formpane nope)"
  is "the empty form draws a footer"    "1" "$([ -n "$(footrow "$clean")" ] && echo 1 || echo 0)"
  is "the refusal reached the form"     "1" "$(printf '%s' "$erred" | grep -c 'ALREADY in a worktree' || true)"
  is "...showing the actionable advice" "1" "$(printf '%s' "$erred" | grep -c 'from the main checkout' || true)"
  is "...and not the override"          "0" "$(printf '%s' "$erred" | grep -c 'ALLOW_NESTED' || true)"
  is "the footer did not move"          "$(footrow "$clean")" "$(footrow "$erred")"
  tmux -L cfftin kill-server 2>/dev/null; rm -rf "$FT"
else
  skip "worktree form layout" "git, tmux or node missing"
fi

# ── 4a10a4. a container root holds worktrees too, and one is not a checkout ──
# mainRepo() falls back to "the first child directory that is a repo" when the registered
# path is not itself a repo. `readdir` order is not a preference, and a LINKED WORKTREE
# has a .git of its own — so on a container root it handed back a worktree, fleet-spawn's
# nesting guard refused the create, and the form showed only "override this".
#
# Both directions: prefer the main checkout, AND still answer when a worktree is
# genuinely all there is.
group "a container root resolves to its main checkout"
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  MR="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$MR/root" "$MR/only"
  mkmr() { git init -q -b main "$1" 2>/dev/null; git -C "$1" config user.email t@t
           git -C "$1" config user.name t; : > "$1/f"; git -C "$1" add -A
           git -C "$1" commit -qm init 2>/dev/null; }
  mkmr "$MR/src"
  # THE ORDER IS THE FIXTURE. `awt` is a linked worktree and sorts FIRST; `zmain` is a
  # real checkout and sorts last. All three implementations now walk a SORTED list
  # (node's readdir alphasorts; the shell copy globs), so the worktree is what each of
  # them reaches first and the preference below is the only thing standing between it
  # and the wrong answer. Rename either directory and this fixture proves nothing.
  git -C "$MR/src" worktree add -q "$MR/root/awt" -b awt 2>/dev/null
  mkmr "$MR/root/zmain"
  git -C "$MR/src" worktree add -q "$MR/only/wt" -b onlywt 2>/dev/null
  mainrepo() { CLAUDE_FLEET_ROOT="$1" CLAUDE_FLEET_DIR="$MR" \
    node "$ROOT/bin/fleet-grid.mjs" cf-mrx --checkouts 2>/dev/null \
    | sed -n 's/^main repo: //p'; }
  is "picks the checkout, not a worktree" "$MR/root/zmain" "$(mainrepo "$MR/root")"
  is "a registered repo is itself"        "$MR/root/zmain" "$(mainrepo "$MR/root/zmain")"
  # nothing but a worktree under it: still answer, rather than going silent
  is "a lone worktree is still an answer" "$MR/only/wt"    "$(mainrepo "$MR/only")"
  # THREE COPIES OF THESE STEPS, and "which checkout is this project" cannot have three
  # answers: the grid draws it, a lead's fleet_spawn RUNS there, and master OPENS there.
  # A disagreement is a worker sitting on a checkout nobody is looking at. So every case
  # above is asked of all three, on the same fixture.
  mcpof() { node -e '
    import(process.argv[1]+"/mcp/fleet-dispatch.mjs").then(m =>
      console.log(m.checkoutOf({ path: process.argv[2], name: process.argv[3] })));
  ' "$ROOT" "$1" "${2:-nosuch}"; }
  eval "$(sed -n '/^master_checkout() {/,/^}/p' "$ROOT/bin/ghostfleet")"
  is "the MCP's copy agrees"              "$MR/root/zmain" "$(mcpof "$MR/root")"
  is "and master opens the same one"      "$MR/root/zmain" "$(master_checkout "$MR/root" nosuch)"
  is "...honouring <root>/<name> first"   "$MR/root/zmain" "$(master_checkout "$MR/root" zmain)"
  is "...and still answering for one wt"  "$MR/only/wt"    "$(master_checkout "$MR/only" nosuch)"
  # A REGISTERED PATH IS TAKEN AT ITS WORD, even when it names a worktree — the grid
  # already does that (isRepo, not "is a checkout"), and master has to open where the
  # grid thinks the project is or `w` and the cards describe different repos. The shell
  # copy used to differ here: its scan emitted the start point first with `test -e`, so
  # a container root that WAS a worktree resolved to a clone inside it instead.
  is "a worktree root is honoured: grid"  "$MR/only/wt" "$(mainrepo "$MR/only/wt")"
  is "...and master"                      "$MR/only/wt" "$(master_checkout "$MR/only/wt" nosuch)"
  is "...and the MCP"                     "$MR/only/wt" "$(mcpof "$MR/only/wt")"
  rm -rf "$MR"
else
  skip "container root resolution" "git or node missing"
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
        + [ { matcher: "EnterWorktree|Agent|Task", hooks: [ { type: "command", command: $guard } ] } ])')"
  is "wiring keeps a foreign PreToolUse hook" "1" "$(printf '%s' "$WIRED" | grep -c '/mine' || true)"
  RE="$(printf '%s' "$WIRED" | jq -c --arg guard /G '.hooks.PreToolUse = ([ (.hooks.PreToolUse // [])[]
          | select([.hooks[]?.command] | index($guard) | not) ]
        + [ { matcher: "EnterWorktree|Agent|Task", hooks: [ { type: "command", command: $guard } ] } ])')"
  is "...and re-installing does not stack up" "1" "$(printf '%s' "$RE" | grep -o '/G' | grep -c . || true)"
  rm -rf "$GW"
else
  skip "EnterWorktree guard" "git or jq missing"
fi

# ── 4a10b2. a subagent is not a worker ───────────────────────────────────────
# The Agent tool (Task in older builds) does the work INSIDE the lead's own
# conversation. It WORKS, which is why it goes unnoticed — and the fleet can see none
# of it: no fleet-list row, no `done` in fleet-inbox, no fleet-worktrees entry, and the
# governor parks SESSIONS so it cannot shed that usage when the account tightens.
# Seen live: a lead reached for two subagents in a row while five workers sat live on
# the project's own socket, and justified it by machine load — which is precisely the
# call the governor exists to make and could not, because it could not see them.
#
# Both directions matter MORE here than for EnterWorktree. A guard that refused every
# Agent call would break read-only research (nothing in fleet-spawn is shaped like it)
# and would strand a WORKER, for whom fleet-spawn is already refused — leaving it no
# way to fan out at all. So the passes below are the real assertions; the block is easy.
group "a subagent is refused where a worker was meant"
if command -v git >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  SA="$(mktemp -d)"
  git init -q -b main "$SA/repo" 2>/dev/null
  git -C "$SA/repo" config user.email t@t; git -C "$SA/repo" config user.name t
  : > "$SA/repo/f"; git -C "$SA/repo" add -A; git -C "$SA/repo" commit -qm init 2>/dev/null
  git -C "$SA/repo" worktree add -q "$SA/wt-a" -b wt-a 2>/dev/null
  # Clean env every time, same reasoning as the EnterWorktree group: the suite usually
  # runs INSIDE a fleet, and an inherited $TMUX would decide "allowed outside a fleet".
  sag() { local json="$1"; shift
    SOUT="$(printf '%s' "$json" | env -u TMUX -u CLAUDE_FLEET_SOCK \
      -u CLAUDE_FLEET_ALLOW_SUBAGENTS "$@" bash "$ROOT/hooks/fleet-guard.sh" 2>&1)"; SRC=$?; }
  # tool_input carries subagent_type; the 4th arg is omitted for the default, unnamed
  # type — which is the shape the real slip had, and must still be refused.
  sj() { local ev="$1" tool="$2" cwd="$3" sub="${4:-}"
    if [ -n "$sub" ]; then
      printf '{"hook_event_name":"%s","tool_name":"%s","cwd":"%s","tool_input":{"subagent_type":"%s"}}' "$ev" "$tool" "$cwd" "$sub"
    else
      printf '{"hook_event_name":"%s","tool_name":"%s","cwd":"%s","tool_input":{}}' "$ev" "$tool" "$cwd"
    fi; }
  shas() { printf '%s' "$SOUT" | grep -c -- "$1" || true; }

  sag "$(sj PreToolUse Agent "$SA/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "Agent is blocked in a lead session"     "2" "$SRC"
  is "...and hands over fleet-spawn"          "1" "$(shas 'fleet-spawn <name> --reuse')"
  is "...and says the fleet cannot see it"    "1" "$(shas 'fleet cannot see it')"
  # Two different mistakes, two different pieces of advice. Neither may answer for the
  # other: a lead told to re-run fleet-spawn because it typed EnterWorktree learns
  # nothing, and this is how one guard growing a second job goes quietly wrong.
  is "...and is NOT the EnterWorktree text"   "0" "$(shas 'MOVE THIS SESSION')"

  sag "$(sj PreToolUse Task "$SA/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "Task (older builds) is blocked too"     "2" "$SRC"

  # ── the directions that prove it is not "deny every subagent" ──
  sag "$(sj PreToolUse Agent "$SA/repo" Explore)" CLAUDE_FLEET_SOCK=cf-x
  is "read-only Explore passes"               "0" "$SRC"
  sag "$(sj PreToolUse Agent "$SA/repo" Plan)" CLAUDE_FLEET_SOCK=cf-x
  is "read-only Plan passes"                  "0" "$SRC"
  sag "$(sj PreToolUse Agent "$SA/repo" general-purpose)" CLAUDE_FLEET_SOCK=cf-x
  is "a type that BUILDS is still blocked"    "2" "$SRC"

  # A WORKER may fan out. fleet-spawn refuses from a linked worktree, so refusing here
  # too would leave a leaf with no way to delegate anything.
  sag "$(sj PreToolUse Agent "$SA/wt-a")" CLAUDE_FLEET_SOCK=cf-x
  is "a leaf's own subagents are allowed"     "0" "$SRC"

  sag "$(sj PreToolUse Agent "$SA/repo")"
  is "allowed outside a fleet"                "0" "$SRC"
  is "...and stays silent there"              ""  "$SOUT"

  sag "$(sj PreToolUse Agent "$SA/repo")" CLAUDE_FLEET_SOCK=cf-x CLAUDE_FLEET_ALLOW_SUBAGENTS=1
  is "the override is a real escape hatch"    "0" "$SRC"

  sag "$(sj Stop Agent "$SA/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "only PreToolUse is inspected"           "0" "$SRC"

  # …and the older refusal did not grow the newer one's advice.
  sag "$(sj PreToolUse EnterWorktree "$SA/repo")" CLAUDE_FLEET_SOCK=cf-x
  is "EnterWorktree is still blocked"         "2" "$SRC"
  is "...and does NOT mention subagents"      "0" "$(shas 'subagent')"
  rm -rf "$SA"
else
  skip "subagent dispatch guard" "git or jq missing"
fi

# ── 4a10b3. every fleet session carries the observation contract ─────────────
# MEASURED, and it is the reason this exists: of 172 build turns that changed a screen
# file, 154 ran a test/lint/build and FOUR opened a browser — on exactly the surfaces
# whose defects came back as photographs. Turns that ran a test drew a correction MORE
# often than turns that ran nothing (39.6% vs 26.3%), so "the suite is green" was never
# the observation it was being read as.
#
# It rides --append-system-prompt rather than the spawn brief because a brief is issued
# once and decays; the corpus holds an agent reporting "I've said this four times and
# it's still true" about an instruction it had already been given. So the assertion that
# matters is that it reaches EVERY exec path, not just the fresh one — a contract that
# is dropped on resume would be in force for a new worker and absent for every long-
# running one, which is the half-working shape this repo keeps getting bitten by.
group "the observation contract reaches claude"
if command -v git >/dev/null 2>&1; then
  OC="$(mktemp -d)"; mkdir -p "$OC/bin" "$OC/work" "$OC/.claude/projects"
  # A stub claude that records its argv, so the exec is observable without a real one.
  # argv, argc, AND the one argument that follows --append-system-prompt, separately.
  { echo '#!/usr/bin/env bash'
    echo 'printf "%s\n" "$@" > "'"$OC"'/argv"'
    echo 'printf "%s" "$#" > "'"$OC"'/argc"'
    echo 'want=0; for a in "$@"; do'
    echo '  if [ "$want" = 1 ]; then printf "%s" "$a" > "'"$OC"'/contract"; want=0; fi'
    echo '  [ "$a" = --append-system-prompt ] && want=1'
    echo 'done'; } > "$OC/bin/claude"
  chmod +x "$OC/bin/claude"
  # THE STUB WRITES ONLY THE CONTRACT ARGUMENT, and that is the whole point of this
  # rewrite. It used to dump every argv entry into one file, and every assertion below
  # grepped that file — so when a stray apostrophe in the contract text ended its
  # single-quoted string, splitting it into a truncated argument plus four bare words plus
  # a 2895-character remainder, every clause was still FOUND somewhere in the file and
  # every row stayed green. Two thirds of the contract had silently stopped reaching the
  # system prompt, and Claude Code was taking the first bare word as an initial prompt and
  # submitting it as a turn in every new session. Asserting on the whole argv is asserting
  # that the text exists somewhere, which is not the claim.
  ch() { rm -f "$OC/argv" "$OC/argc" "$OC/contract"
         ( cd "$OC/work" && env -u CLAUDE_FLEET_NO_OBSERVE_CONTRACT -u CLAUDE_FLEET_FRESH \
             PATH="$OC/bin:$PATH" HOME="$OC" CLAUDE_CONFIG_DIR="$OC/.claude" "$@" \
             bash "$ROOT/bin/claude-here" -- --some-user-arg >/dev/null 2>&1 ); }
  # `-- ` is not decoration: claude-here's first positional is the SLOT, so a bare
  # --some-user-arg is swallowed as a tab label and never reaches claude. Passing it
  # wrongly the first time is what proved this assertion can fail.
  argvhas()     { grep -c -- "$1" "$OC/argv"     2>/dev/null || true; }
  contracthas() { grep -c -- "$1" "$OC/contract" 2>/dev/null || true; }

  ch
  is "a fresh session gets the contract"      "1" "$(argvhas '^--append-system-prompt$')"
  # NO POSITIONAL ARGUMENT MAY REACH claude, because Claude Code takes the first one as an
  # INITIAL PROMPT and submits it as a turn. That is what a broken quote produced: four
  # bare words after the truncation, the first of which became a message in every new
  # session. The count is pinned rather than bounded — a fifth argument appearing is either
  # a deliberate change to this launcher or a string that came apart, and both deserve a
  # red line rather than a shrug.
  # NOT A COUNT. The first version pinned argc at six and went red on CI with four,
  # because `--name <name>` is only added when CLAUDE_FLEET_SOCK and CLAUDE_FLEET_SLOT are
  # set — true in a fleet, false on a clean runner. A number that depends on where the test
  # ran is the trap CLAUDE.md names, and pinning it asserted the environment rather than the
  # code.
  #   What actually matters is that NO BARE WORD reaches claude, because Claude Code takes a
  # positional argument as an INITIAL PROMPT and submits it as a turn. So walk argv: every
  # entry must be a flag, the value of a flag that takes one, or the caller's own argument.
  # Anything else is a string that came apart — which is exactly what "the control there and"
  # was.
  POSITIONALS="$(awk '
    BEGIN { skip = 0 }
    { if (skip) { skip = 0; next }
      if ($0 ~ /^--?[A-Za-z]/) { if ($0 == "--name" || $0 == "--model" || $0 == "--append-system-prompt") skip = 1; next }
      print $0 }' "$OC/argv" 2>/dev/null | head -4 | tr '\n' ' ')"
  is "...and no bare word reaches claude"     "" "${POSITIONALS% }"
  # ...AND THE CONTRACT IS ONE ARGUMENT, whole. Length compared against the source, so a
  # truncation cannot hide: the broken version delivered 673 of 3589 characters and every
  # clause still grepped fine out of the argv dump.
  is "...and it arrives whole, not truncated" "$(python3 - <<'PYX'
import io,re
s=io.open("bin/claude-here",encoding="utf-8").read()
m=re.search(r"CONTRACT=\(--append-system-prompt '(.*?)'\) ;;", s, re.S)
print(len(m.group(1)) if m else 0)
PYX
)" "$(wc -c < "$OC/contract" 2>/dev/null | tr -d ' ')"
  is "...and it is about OBSERVING"           "1" "$(contracthas 'state what you OBSERVED')"
  is "...and it names the test-suite trap"    "1" "$(contracthas 'not observing the thing you changed')"
  # Three clauses, three measurements, asserted separately — a contract that silently
  # lost one would still pass a test that only asked "is there a system prompt".
  #   receipt:    30 of 50 measurable re-reports had NO file changed between the two
  #               statements; the reporter could not see the agent working.
  #   divergence: end-of-turn asking is saturated (25.6% of turns, no effect), so the
  #               clause is about BEHAVIOURAL divergence, not felt uncertainty.
  is "...and carries the receipt clause"      "1" "$(contracthas 'before you start working')"
  is "...and the divergence clause"           "1" "$(contracthas 'would visibly differ')"
  is "...which is NOT ask-when-unsure"        "1" "$(contracthas 'Do not ask because you feel uncertain')"
  # The two axes the first version missed. Written product-shaped ("different screens or
  # different stored data"), the clause did not cover the readings that actually diverge
  # in practice: WHAT is delivered, and WHERE it lands. Both were misread on the session
  # that produced this contract — an analysis request read as a mandate to build, and a
  # second product worked in after being told not to.
  is "...and the deliverable axis"            "1" "$(contracthas 'WHAT IS DELIVERED')"
  is "...and the target-repo axis"            "1" "$(contracthas 'WHICH repository or checkout')"
  # The extraction clause, from the 19-of-36 bucket of requirements the human already
  # held and never wrote down. Its shape is the load-bearing part: it demands the
  # ASSUMPTION be stated, because "anything else I should know" is the saturated question
  # — closing with a question moves the rework rate not at all — so both halves are
  # asserted, the axes AND the refusal to just ask.
  is "...and the extraction axes"             "1" "$(contracthas 'what the UNIT is')"
  is "...and the reuse-not-recreate axis"     "1" "$(contracthas 'reuse instead of recreating')"
  is "...and states an assumption, not a Q"   "1" "$(contracthas 'rather than asking whether anything is missing')"
  # RETROACTIVITY, and the reason it is here rather than in the first six: observed live,
  # a feature built in thirty minutes took its last correction nearly three hours later —
  # "it should backfill the already created drafts". A migration, arriving as a clause.
  is "...and the retroactivity axis"          "1" "$(contracthas 'RETROACTIVELY to records that already exist')"
  # THE REFERENCE. The brief behind that session named the goal, the prepared asset and
  # three exact file:line locations — it was not thin — and still drew "make it bigger",
  # "dont make it bold keep it the same pic", and a backfill. The first correction's own
  # correction pointed at an earlier document of the same kind the product had already
  # produced: a reference that existed all along and arrived only after two wrong
  # guesses. So this axis is asked, not hoped for.
  is "...and the rendered-artifact axis"      "1" "$(contracthas 'RENDERED ARTIFACT')"
  # CLOSING THE LOOP. Entry and observation were both governed and nothing joined them:
  # an agent can truthfully report what it observed and still have built the wrong thing.
  # Target measured at 23 of 79 agent-behaviour corrections ("that is not what I asked").
  # Three halves asserted separately because each carries its own weight — restate the
  # criteria, justify "met" by observation rather than by the code reading right, and say
  # so when none were named, which is the only visible sign the asking half was skipped.
  is "...and closes the loop at done"         "1" "$(contracthas 'CLOSE THE LOOP')"
  is "...met because you LOOKED, not read"    "1" "$(contracthas 'because you looked at the thing it is about')"
  is "...and admits when none were named"     "1" "$(contracthas 'the asking half did not happen')"
  is "...which asks for an existing one"      "1" "$(contracthas 'whether there is an existing one to match')"
  # THE HANDSHAKE, both ends of one loop and therefore one clause. The clauses above
  # govern a session READING a brief; this one governs the moment a brief is written and
  # the moment one is received. It is a single clause because the contract is delivered
  # identically to every session — splitting it would address each half to a session that
  # cannot act on it — so it scopes itself: a main checkout dispatches, a linked worktree
  # is a leaf and only acknowledges.
  #   Measured on the asking half: 36 of 163 screen-attributed corrections were
  # requirements stated for the first time mid-flight, 19 already known to the human and
  # simply not said. On the acknowledging half: 23 of 79 agent-behaviour corrections are
  # "that is not what I asked".
  is "...and the dispatch half of the loop"   "1" "$(contracthas 'NUMBERED LIST')"
  is "...scoped to a main checkout"           "1" "$(contracthas 'a leaf and dispatches nothing')"
  # A RESTATEMENT ALONE WAS THE FIRST DESIGN AND WAS NOT ENOUGH: it makes disagreement
  # displayable, not preventable, since a worker can paraphrase the ask perfectly and
  # still build from a wrong assumption underneath it. The binding to the DECISIONS is
  # the correction, so it is asserted separately from the ack itself — a clause that lost
  # it would still pass a test that only asked whether fleet-ack was named.
  is "...and the acknowledging half"          "1" "$(contracthas 'the decisions you are working from')"
  # AND IT NAMES THE COMMAND, for the same reason the fleet-look row above exists: a
  # mechanism nobody is told about is never reached, and from outside that is
  # indistinguishable from an instruction nobody followed.
  is "...naming fleet-ack, not just the idea" "1" "$(contracthas 'fleet-ack')"
  is "...and where the gap becomes visible"   "1" "$(contracthas 'ASKED next to UNDERSTOOD')"
  # DO NOT WATCH THE PIPELINE. Same session: 173 tool calls between the finishing commit
  # and the first human word, 28 of them sleeps totalling ~16,000 seconds, against TWO
  # records touching anything that could render the artifact the feature was about.
  # The correction that matters is WHY, not whether. The first version said a watched run
  # finishes no sooner — true, and not the cost. The human had stepped away, so the clock
  # was never going to be shorter. The cost is that ENDING a turn is what fires the Stop
  # hook, hence `done` in fleet-inbox and the push — so waiting held shut the one channel
  # built to reach someone who left the desk. Assert the mechanism, or the clause decays
  # back into a productivity slogan.
  is "...and does not hold the turn open"     "1" "$(contracthas 'do not hold the turn open to wait')"
  is "...because ending it is what notifies"  "1" "$(contracthas 'Ending the turn is what notifies')"
  # AND IT NAMES THE INSTRUMENT. fleet-look was built to back the observe clause, shipped,
  # tested, and put on PATH — and nothing told a worker it existed. A mechanism nobody is
  # told about is never reached, and from outside it looks exactly like an instruction
  # nobody followed: the screen goes unopened either way. Asserted so the two cannot drift
  # apart again — the clause and the command ship together or the suite says so.
  is "...and names fleet-look"                "1" "$(contracthas 'fleet-look.mjs')"
  is "...and the tree flag beside it"         "1" "$(contracthas 'add --tree')"
  # The user's own arguments must survive it — an array spliced into the wrong place
  # would eat them, and nothing else in the session would say so.
  is "...and the caller's args still pass"    "1" "$(argvhas '^--some-user-arg$')"

  # The parallel-session path (grid `N`) is a SECOND exec, and it was the one most
  # likely to be missed: it returns before the resume logic is ever reached.
  ch CLAUDE_FLEET_FRESH=1
  is "a parallel session gets it too"         "1" "$(argvhas '^--append-system-prompt$')"

  # ── the direction that proves it is not simply always appended ──
  ch CLAUDE_FLEET_NO_OBSERVE_CONTRACT=1
  is "the opt-out really opts out"            "0" "$(argvhas '^--append-system-prompt$')"
  is "...and the caller's args still pass"    "1" "$(argvhas '^--some-user-arg$')"

  # Every exec path in the file, counted rather than trusted: a fourth one added later
  # without the array is exactly the silent half-coverage described above.
  # NOT anchored to the start of the line. One of the three execs sits after an `echo`
  # on the same line, so `^ *exec claude` counts two of three — and the assertion then
  # compares 2 against 2 and goes green while blind to the parallel-session path, which
  # is the one most likely to be missed. Caught by counting the file by hand; the
  # anchored version could not have failed.
  EXECS="$(grep -c 'exec claude "' "$ROOT/bin/claude-here" || true)"
  WITHC="$(grep -c 'exec claude ".*CONTRACT\[@\]' "$ROOT/bin/claude-here" || true)"
  is "there are three exec paths at all"      "3" "$EXECS"
  is "...and every one carries the contract"  "$EXECS" "$WITHC"
  rm -rf "$OC"
else
  skip "observation contract" "git missing"
fi

# ── 4a10b4. fleet-look: an instruction to observe needs something to observe WITH ─
# MEASURED: of 172 build turns that changed a screen file, 154 ran a test, lint or build
# and FOUR opened a browser. And the sessions where the human was the renderer are the
# ones that iterated — 12 delivering sessions with no screenshot turn took 17 corrections
# across 76 turns, against 215 across 671 for the 7 with fifteen or more.
#
# The assertion that carries this group is the REFUSAL. A 404 renders as a page and
# photographs as a perfectly good PNG; a tool that hands that back lets "I looked at it"
# mean nothing, which is §2.1's failure class arriving through the camera. So the
# not-reachable case must exit non-zero and say why, and that is asserted before anything
# about the happy path.
group "fleet-look photographs, and refuses to photograph nothing"
if command -v node >/dev/null 2>&1; then
  LK="$(mktemp -d)"
  cat > "$LK/p.html" <<'HTML'
<!doctype html><title>Look probe</title><body style="margin:0"><button>send</button>
HTML
  cat > "$LK/a.html" <<'HTML'
<!doctype html><title>Labelled</title><body style="margin:0">
<input aria-label="message"><button>send</button>
HTML
  # NAMESPACED ON PURPOSE. The first version called one of these PASS — which is the
  # harness's own pass COUNTER. ok() then ran PASS=$((PASS+1)) over a sentence, bash
  # evaluated its words as an arithmetic expression, and a bare "at" from the message
  # became an unbound variable that killed the whole run mid-group, after four green rows,
  # with an error naming a line in the harness and no hint which group did it. A group can
  # silently clobber the harness it reports into; prefix anything you define here.
  #
  # No Chrome: it must SAY so and fail, not quietly produce nothing and exit 0 — the
  # skip-that-says-why discipline, in a bin rather than a helper. This case also could not
  # be written at first, because $CHROME pointing at nothing fell THROUGH to another
  # browser; that it was untestable was the bug.
  NOCH="$(CHROME=/nonexistent/chrome node "$ROOT/bin/fleet-look.mjs" "$LK/p.html" 2>&1)"; NOCHRC=$?
  is "no chrome fails rather than passing" "1" "$NOCHRC"
  is "...and names the reason"             "1" "$(printf '%s' "$NOCH" | grep -c 'no chrome' || true)"

  # Unreachable: an image IS produced (so it can be inspected) but the exit is non-zero
  # and the message says a photograph of an error page is not an observation.
  UNRE="$(node "$ROOT/bin/fleet-look.mjs" 'http://127.0.0.1:9/nope' 2>&1)"; UNRERC=$?
  is "an unreachable page is an error"     "1" "$UNRERC"
  is "...and says why, in those words"     "1" "$(printf '%s' "$UNRE" | grep -c 'not an observation' || true)"

  # An image needs no renderer, and saying "rendered by nothing" is more honest than
  # silently re-encoding it through a browser.
  printf '\211PNG\r\n\032\n' > "$LK/x.png"
  LKIMG="$(node "$ROOT/bin/fleet-look.mjs" "$LK/x.png" 2>&1)"
  is "an image passes through"             "1" "$(printf '%s' "$LKIMG" | grep -c 'already an image' || true)"

  # The happy path, only where there is a browser to walk it.
  if node -e 'import("./lib/browser.mjs").then(m=>process.exit(m.findChrome()?0:1))' 2>/dev/null; then
    OUTP="$LK/shot.png"
    LKOK="$(node "$ROOT/bin/fleet-look.mjs" "$LK/p.html" --width 390 --height 300 --out "$OUTP" 2>&1)"; LKOKRC=$?
    is "a local page is photographed"      "0" "$LKOKRC"
    is "...and the status is printed"      "1" "$(printf '%s' "$LKOK" | grep -c 'http status   200' || true)"
    is "...and the title, so a blank page shows" "1" "$(printf '%s' "$LKOK" | grep -c 'Look probe' || true)"
    is "...and a real PNG lands on disk"   "PNG" "$(head -c4 "$OUTP" 2>/dev/null | tail -c3)"
    # Scale 2 is deliberate: a phone-width shot at 1x is unreadable when a human opens it.
    is "...at deviceScaleFactor 2"         "780" "$(node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(b.readUInt32BE(16))' "$OUTP" 2>/dev/null)"
    # THE STRUCTURAL CHANNEL, and it is not decoration. Measured on real visual defects, a
    # model asked whether a screen looks right recalls 20% of LAYOUT bugs and 14% of
    # appearance ones; what fixed that in the same study was a reference image, not a
    # better reader. "Is the control there, named and reachable" is a question about
    # structure, and the tree answers it directly — so the assertion is that a labelled
    # control comes back by its LABEL, which pixels cannot give at any resolution.
    LKTREE="$(node "$ROOT/bin/fleet-look.mjs" "$LK/a.html" --tree --out "$LK/t.png" 2>&1)"
    is "the tree names a labelled control"  "1" "$(printf '%s' "$LKTREE" | grep -c 'textbox: message' || true)"
    is "...and the button by its role"      "1" "$(printf '%s' "$LKTREE" | grep -c 'button: send' || true)"
    is "...and it is off by default"        "0" "$(printf '%s' "$LKOK" | grep -c 'accessibility tree' || true)"

    # ── the golden comparison ──────────────────────────────────────────────
    # The best-evidenced instrument in the research (a reference lifted median precision
    # from 34-50% to 100%, against 20% recall for open-ended looking) and the one most
    # likely to be deleted: goldens drift on antialiasing and font rendering, and a check
    # that is red for reasons nobody can read gets removed to make the suite quiet. So the
    # assertions here are about the GUARDS, not just the verdict.
    cat > "$LK/g.html" <<'HTML'
<!doctype html><title>Golden</title><body style="margin:0;font:16px system-ui"><h1>hello</h1>
HTML
    G1="$(node "$ROOT/bin/fleet-look.mjs" "$LK/g.html" --width 300 --height 200 --golden "$LK/ref.png" --out "$LK/g1.png" 2>&1)"
    # A first run that silently WRITES a baseline is a run that can never fail, and the
    # first one is the most likely to bake a bug in as the expectation. It must say so.
    is "creating a baseline says so"        "1" "$(printf '%s' "$G1" | grep -c 'BASELINE CREATED' || true)"
    is "...and says nothing was compared"   "1" "$(printf '%s' "$G1" | grep -c 'nothing was compared' || true)"

    G2="$(node "$ROOT/bin/fleet-look.mjs" "$LK/g.html" --width 300 --height 200 --golden "$LK/ref.png" --out "$LK/g2.png" 2>&1)"; G2RC=$?
    is "an unchanged page matches"          "0" "$G2RC"
    is "...and reports the fraction"        "1" "$(printf '%s' "$G2" | grep -c 'of pixels differ, allowed' || true)"

    # The direction that matters: it must actually catch a change, or every row above is
    # a green that proved nothing.
    cat > "$LK/g.html" <<'HTML'
<!doctype html><title>Golden</title><body style="margin:0;font:16px system-ui"><h1>hello</h1><p>an extra paragraph nobody asked for</p>
HTML
    G3="$(node "$ROOT/bin/fleet-look.mjs" "$LK/g.html" --width 300 --height 200 --golden "$LK/ref.png" --out "$LK/g3.png" 2>&1)"; G3RC=$?
    is "a changed page is caught"           "1" "$G3RC"
    is "...and the pair is written on red"  "1" "$([ -f "$LK/expected.png" ] && [ -f "$LK/diff.png" ] && echo 1 || echo 0)"
    is "...and their paths are printed"     "1" "$(printf '%s' "$G3" | grep -c 'differences in red' || true)"
    # A reference taken on another browser build is a stale baseline, not a regression —
    # so the build is named on every comparison, or the next reader misdiagnoses it.
    is "...and the browser build is named"  "1" "$(printf '%s' "$G3" | grep -c 'chrome' || true)"
    # A threshold, never equality: subpixel antialiasing moves channels by a few units on
    # text the eye cannot tell apart, and counting those is how this gets deleted.
    is "...the verdict is a fraction"       "1" "$(printf '%s' "$G3" | grep -cE '[0-9]+\.[0-9]+% of pixels differ' || true)"
    # A different viewport is a stale baseline too, and must say which rather than red-ing
    # with a pixel count that looks like a redesign.
    G4="$(node "$ROOT/bin/fleet-look.mjs" "$LK/g.html" --width 420 --height 200 --golden "$LK/ref.png" --out "$LK/g4.png" 2>&1)"; G4RC=$?
    is "a resized reference is refused"     "1" "$G4RC"
    is "...as a stale baseline, by name"    "1" "$(printf '%s' "$G4" | grep -c 'stale baseline' || true)"
  else
    skip "fleet-look happy path" "no chrome on this machine"
  fi
  rm -rf "$LK"
else
  skip "fleet-look" "node missing"
fi

# ── 4a10b5. a bin is only as installed as the things it imports ──────────────
# SEEN LIVE, and it is the repo-vs-runtime trap arriving through a directory nobody had
# needed before. fleet-look.mjs was linked onto PATH, passed thirteen assertions, and died
# on its first real invocation: ERR_MODULE_NOT_FOUND on lib/browser.mjs. The suite runs
# from the REPO, where a relative import resolves; the shipped command runs from $DEST,
# where cf-sync had never copied lib/ because no bin had ever imported from outside bin/.
# Green here, broken in the hand — which is the split cf-sync exists to close.
#
# STRUCTURAL, not a list. It reads the imports out of the bins and asks whether each
# directory is in the one cf-sync actually loops over, so the NEXT directory is caught
# rather than only this one. (The doc-fixtures helper takes the same shape for the same
# reason.) A hardcoded "lib is synced" would go green forever and prove nothing about
# whatever gets added next.
group "every dir a bin imports from is one cf-sync copies"
if command -v node >/dev/null 2>&1; then
  SYNCD="$(sed -n 's/^for d in \(.*\); do$/\1/p' "$ROOT/bin/cf-sync" | head -1)"
  is "cf-sync's list is readable at all" "1" "$([ -n "$SYNCD" ] && echo 1 || echo 0)"
  MISS=""
  for f in "$ROOT"/bin/*.mjs; do
    # every ../<dir>/ reached by a static import in that file
    for d in $(grep -oE "from '\.\./[A-Za-z0-9_-]+/" "$f" 2>/dev/null | sed "s#from '\.\./##; s#/##" | sort -u); do
      case " $SYNCD " in *" $d "*) ;; *) MISS="$MISS $(basename "$f"):$d" ;; esac
    done
  done
  is "...and no bin imports outside it" "" "${MISS# }"
  # Both directions: the check must be able to SEE an import, or it is green by blindness.
  is "the check actually finds imports" "1" \
     "$(grep -c "from '\.\./lib/browser.mjs'" "$ROOT/bin/fleet-look.mjs" 2>/dev/null || echo 0)"
  # NOT a case inside $( ): the `)` that ends a case PATTERN also ends the command
  # substitution it sits in, and bash reports it as a syntax error at a line number in
  # the middle of an assertion. Word-match on the padded list instead.
  is "...and lib is in the list it read" "1" \
     "$(printf '%s' " $SYNCD " | grep -c ' lib ' || true)"
else
  skip "bin import sync" "node missing"
fi

# ── 4a10b6. nothing ships that the name sweep never read ─────────────────────
# SEEN LIVE, ON npm. Version 0.1.0 shipped web/fixtures/ containing a third party's real
# project and session names and captured terminal content, and npm tarballs are immutable:
# no commit fixes a published one. The sweep reads every TRACKED file, and the tarball is
# built from tracked files — so the two agree today by coincidence of overlap, not by
# construction. Add one generated or untracked path to package.json's `files` and the
# package ships something nothing ever swept, with no signal anywhere.
#
# So this asserts the overlap directly: every path npm would pack is a path git tracks.
# Structural, so the NEXT addition is caught rather than this one.
group "the npm package ships only files the sweep reads"
if command -v npm >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  PKD="$(cd "$ROOT" && npm pack --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s)[0].files.forEach(f=>console.log(f.path))}catch{}})')"
  is "npm reports a file list at all"   "1" "$([ -n "$PKD" ] && echo 1 || echo 0)"
  TRACKED="$(cd "$ROOT" && git ls-files)"
  UNSWEPT=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in package.json|README.md|LICENSE) continue ;; esac   # npm adds these itself
    # A HERE-STRING, NOT A PIPE — see the pipefail/SIGPIPE note in CLAUDE.md. `grep -q`
    # exits on its first match, and under `set -o pipefail` the writer's EPIPE (141)
    # becomes the pipeline's status, so a MATCH reads as a failure.
    grep -qxF "$f" <<< "$TRACKED" || UNSWEPT="$UNSWEPT $f"
  done <<< "$PKD"
  is "...and every packed path is tracked" "" "${UNSWEPT# }"
  # Both directions: the check must be able to SEE an untracked path, or it is green by
  # blindness — the exact shape this suite keeps finding elsewhere.
  UNSWEPT2=""
  for f in $(printf '%s\n' "$PKD" | head -3) "generated/not-tracked.json"; do
    grep -qxF "$f" <<< "$TRACKED" || UNSWEPT2="$UNSWEPT2 $f"
  done
  is "...and it would notice an untracked one" "generated/not-tracked.json" "${UNSWEPT2# }"
else
  skip "npm package sweep" "npm or git missing"
fi

# ── 4a10b7. no assertion may pipe into a short-circuiting reader ──────────────
# THIS ONE FAILED ON ONE LEG OF ONE RUN AND BLAMED AN INNOCENT FILE. `set -uo pipefail`
# is on (top of this file), and `grep -q` stops reading at its FIRST match — so the
# writer on its left can take SIGPIPE, and under pipefail that writer's 141 becomes the
# whole pipeline's status. A MATCH therefore reads as a no-match, and only when the
# writer had enough left to block: the tracked-file list is ~4KB, which fits the buffer
# a pipe usually gets and does not fit the smaller one the kernel hands out when it
# cannot spare that. Measured: same commit, green on one runner, red on the other,
# naming the FIRST path in the list — the only iteration that ran with a cold pipe.
#
# The sweep found five more of the same shape, three of them worse: `while ! tmux
# capture-pane | grep -q <pattern>` inverts the status, so a spurious 141 reads as "the
# pattern is not there yet" and the wait loop runs its full count and then asserts against
# a pane it decided never arrived. That failure would surface in a LATER assertion, about
# something else entirely.
#
# There is nothing to assert about a kernel buffer, so assert the SHAPE. A here-string
# has no writer to signal, its exit status is the reader's alone, and it costs nothing
# at these sizes. Structural, so the next one is caught instead of this one.
#
# THE PATTERN IS ANCHORED PAST THE COMMENT MARKER, and that is not tidiness: without the
# anchor this group counted the paragraph above, because the clearest way to describe a
# forbidden shape is to write it out. It went red on both legs for its own prose. `[^#]*`
# cannot cross a `#`, so a line that starts with one can never match, and what is being
# swept is executable text — which is the only place the bug can live.
group "no assertion pipes into a short-circuiting reader"
is "the suite has no pipe into grep -q" "0" "$(matches '^[^#]*[|] *grep -q' "$ROOT/test/run.sh")"
# ...and the sweep can SEE one, or it is green by blindness. The bar is a variable
# because writing the bad shape literally here would make this file fail its own sweep.
BAR='|'
is "...and the sweep would see one"     "1" \
   "$(grep -cE '^[^#]*[|] *grep -q' <<< "$(printf 'printf x %s grep -q y\n' "$BAR")" || true)"
# ...and that it does NOT see the same shape inside a comment, which is the direction that
# made it red: a sweep that cannot tell code from prose forbids explaining itself.
is "...and not one in a comment"        "0" \
   "$(grep -cE '^[^#]*[|] *grep -q' <<< "$(printf '# a bad line: printf x %s grep -q y\n' "$BAR")" || true)"
# ── 4a10b8. a dispatch leaves a trace ────────────────────────────────────────
# SEEN TWICE, on two profiles, hours apart: a session's first turn was the single word
# "the" and its real brief never arrived. From the receiving side that is indistinguishable
# from a worker ignoring its instructions, and from the sending side there was nothing at
# all — nothing recorded what went into the tmux buffer. Three theories were investigated
# and disproved at an hour each, because the only evidence was the transcript of the thing
# that received it.
#
# The log records length and a digest and NOTHING of the body. That constraint is the half
# of this group worth keeping: the first draft logged the opening and closing forty
# characters, and the assertion below caught that for a message under eighty bytes those
# windows overlap and hand back the whole brief. So both directions here are privacy
# directions — the log must tell a full brief from a one-word fragment, and it must do it
# without becoming a second copy of every brief on disk.
group "fleet-send records what it dispatched"
if command -v tmux >/dev/null 2>&1; then
  SNL="$(mktemp -d)"
  tmux -L sndlog kill-server 2>/dev/null
  tmux -L sndlog new-session -d -s w1 'sleep 60' 2>/dev/null; sleep 0.4
  SND() { CLAUDE_FLEET_DIR="$SNL" "$ROOT/bin/fleet-send" -s sndlog w1 "$1" >/dev/null 2>&1; }
  SND "a brief long enough to have two distinct ends"
  SND "the"
  # UNDER EIGHTY BYTES — the length at which a first-40/last-40 excerpt reconstructs the
  # whole message. This is the case that went red, so it stays as its own row.
  SND "sync acme-api to staging"
  SNLOG="$SNL/sndlog.sent"
  is "the log exists after a send"        "1" "$([ -f "$SNLOG" ] && echo 1 || echo 0)"
  is "...one line per dispatch"           "3" "$(grep -c . "$SNLOG" 2>/dev/null || echo 0)"
  # THE POINT: a full brief and a one-word fragment must be told apart from the log alone,
  # because that is the comparison nobody could make when this happened.
  is "...a long brief records its length"  "1" "$(awk -F'\t' '$3>40' "$SNLOG" 2>/dev/null | grep -c . || true)"
  is "...and a 3-byte one records 3"       "1" "$(awk -F'\t' '$3==3' "$SNLOG" 2>/dev/null | grep -c . || true)"
  # It must NOT be a copy of the brief, at ANY length.
  is "...the body is not stored"           "0" "$(grep -c 'long enough to have two distinct ends' "$SNLOG" 2>/dev/null || true)"
  is "...nor a short one, which overlaps"  "0" "$(grep -c 'acme-api' "$SNLOG" 2>/dev/null || true)"
  # THE DIGEST IS THE FIELD THE WHOLE LOG TURNS ON, and it is written by whichever of two
  # tools the host has. An empty one would look like a logged dispatch and answer nothing,
  # so assert its shape, that different bodies differ, and that one body is stable.
  is "...the digest is 12 hex"             "3" "$(awk -F'\t' '$4 ~ /^[0-9a-f]{12}$/' "$SNLOG" 2>/dev/null | grep -c . || true)"
  is "...and three bodies gave 3 digests"  "3" "$(awk -F'\t' '{print $4}' "$SNLOG" 2>/dev/null | sort -u | grep -c . || true)"
  SND "the"
  is "...and the same body repeats one"    "2" "$(awk -F'\t' '$3==3 {print $4}' "$SNLOG" 2>/dev/null | sort | uniq -c | awk '{print $1}' | head -1)"
  tmux -L sndlog kill-server 2>/dev/null; rm -rf "$SNL"
else
  skip "dispatch log" "tmux missing"
fi

# ── 4a10b9. fleet-look must not leave a browser behind ───────────────────────
# MEASURED, AND NOT AS A FAILURE: 266 orphaned headless Chromes and 145 profile
# directories on the machine that wrote this file, from a group that photographs a handful
# of pages per run. Nothing about it looked wrong — the picture was right, the exit code
# was right, and the only symptom was a load average that got blamed on the test suites
# running at the time.
#
# The cause is one line of control flow: cleanup lived in a `finally`, and every exit in
# fleet-look sat INSIDE the try it was attached to. `process.exit()` does not unwind, so
# the finally never ran on any path that mattered — which is every path that succeeded.
#
# ASSERTED ON THE PROFILE DIRECTORY, NOT THE PROCESS, deliberately: an orphaned Chrome
# sometimes notices its debugging socket has closed and exits by itself, which makes a
# process count a coin flip and an assertion on it a flake. The directory is created by
# launch() and removed by close() and by nothing else, so its survival is exactly
# equivalent to "close() was not called", with no timing in it.
#
# EVERY PATH IS COMPARED BY SET DIFFERENCE, never by count, and never cleaned with a glob.
# Two runs of this suite are allowed to overlap (§0), and a live overlapping run owns a
# profile directory with this same prefix — a glob-and-remove would delete another run's
# browser out from under it, which is the fixed-socket-name disaster in a different costume.
#
# A PER-RUN $TMPDIR, for the reason §0 gives every tmux server its own socket directory.
# The profiles are named `gf-browser-*` in the system temp dir, and two runs of this suite
# are allowed to overlap — so a set difference taken over the SHARED prefix attributes a
# concurrent run's leak to this one. Measured while writing this: three directories appeared
# between the before and after snapshots of a run whose own four paths were each provably
# clean in isolation, because two other worktrees were running the suite at that moment and
# one of them was on a branch without the fix. That is a phantom red, and a phantom red is
# indistinguishable from a real one.
#   Pointing the child at its own TMPDIR makes the difference EXACT rather than merely
# quieter: no other run can put a directory into it, and this run cannot put one anywhere
# else. It also makes the process check below precise, since the profile path it greps for
# is now unique to this run.
#
# THE DELIBERATE LEAK IS KILLED, NOT EXITED, AND THAT IS NOT A CONVENIENCE. lib/browser.mjs
# now registers a synchronous `exit` handler, so a launch that merely forgets to close still
# cleans up on the way out — which is the point of it, and which would leave the row below
# green by blindness, proving only that the fixture no longer leaks. SIGKILL is the one exit
# no handler runs on, so it is the only way left to manufacture a real orphan, and it is
# also the real-world case the handler cannot cover: a crash, an OOM, a Ctrl-C on the runner.
group "fleet-look closes what it opened"
if command -v node >/dev/null 2>&1 && command -v pgrep >/dev/null 2>&1; then
  LKC="$(mktemp -d)"
  LKT="$LKC/tmp"; mkdir -p "$LKT"
  printf '<!doctype html><title>Closer</title><body style="margin:0">x\n' > "$LKC/p.html"
  lkdirs()  { ls -d "$LKT"/gf-browser-* 2>/dev/null | sort; }
  # Every process of a headless Chrome carries --user-data-dir, helpers included: measured,
  # ten processes for one browser and all ten match. So this counts the whole tree, which is
  # the thing that was surviving, and not just the one process we spawned.
  lkprocs() { pgrep -f -- "--user-data-dir=$LKT/gf-browser-" 2>/dev/null | wc -l | tr -d ' '; }
  lkdirs > "$LKC/before"
  TMPDIR="$LKT" node "$ROOT/bin/fleet-look.mjs" "$LKC/p.html" --out "$LKC/ok.png" >/dev/null 2>&1
  LKRC_OK=$?
  # The UNREACHABLE path too, because it leaves through die() rather than off the end of the
  # file, and die() was one of the exits that skipped the cleanup.
  TMPDIR="$LKT" node "$ROOT/bin/fleet-look.mjs" 'http://127.0.0.1:9/nope' --out "$LKC/bad.png" >/dev/null 2>&1
  LKRC_BAD=$?
  sleep 1
  lkdirs > "$LKC/after"
  if [ "$LKRC_OK" = 0 ]; then
    is "two looks leave no profile behind"  "" "$(comm -13 "$LKC/before" "$LKC/after" | tr '\n' ' ' | sed 's/ *$//')"
    is "...and the unreachable one still failed" "1" "$LKRC_BAD"
    # THE ROW THIS GROUP WAS RED FOR, and it is NOT a process count taken after the two looks
    # above. That was tried first and it passed with the bug fully restored: on an idle
    # machine the nine helpers notice their parent died within milliseconds, so anything that
    # sleeps before counting reads zero either way. The leak is those nine failing to be
    # SCHEDULED in time, which only happens on a machine that is already busy — and a machine
    # is already busy largely because of the last time this happened.
    #   So the helper's fixture stops them outright instead of hoping to catch them late, and
    # the difference stops being a race: nine survivors against the old close, zero against
    # the new one, no variation across runs. See test/helpers/browser-leak.mjs for why a
    # stopped process is the honest stand-in for an unscheduled one.
    is "...and no helper survives, even one that never noticed" "procs=0 dir=no" \
       "$(TMPDIR="$LKT" node "$ROOT/test/helpers/browser-leak.mjs" 2>/dev/null)"
    # AND BOTH CHECKS CAN SEE A LEAK, or they are green by blindness on any host where the
    # two looks above did nothing. A real launch, SIGKILLed so no exit handler runs.
    TMPDIR="$LKT" node -e '
      import("'"$ROOT"'/lib/browser.mjs")
        .then((m) => m.launch({ width: 200, height: 200 }))
        .then(() => setTimeout(() => {}, 30000))
        .catch(() => process.exit(0));' >/dev/null 2>&1 &
    LKPID=$!
    LKI=0
    while [ "$LKI" -lt 200 ]; do
      [ -n "$(comm -13 "$LKC/after" <(lkdirs))" ] && [ "$(lkprocs)" -gt 0 ] && break
      LKI=$((LKI+1)); sleep 0.1
    done
    kill -9 "$LKPID" 2>/dev/null; wait "$LKPID" 2>/dev/null
    sleep 1
    lkdirs > "$LKC/leaked"
    LKNEW="$(comm -13 "$LKC/after" "$LKC/leaked")"
    LKP="$(lkprocs)"
    is "...and it would see one that was killed mid-look" "yes" \
       "$([ -n "$LKNEW" ] && [ "$LKP" -gt 0 ] && echo yes \
          || echo "no: new profile='$(printf '%s' "$LKNEW" | tr '\n' ' ')' surviving procs=$LKP")"
    # Undo the deliberate leak, by the exact paths it created and no others. The browser
    # first, or removing its profile leaves it running against a directory that is gone.
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      pkill -f -- "--user-data-dir=$d" 2>/dev/null
      rm -rf "$d" 2>/dev/null
    done <<< "$LKNEW"
  else
    skip "fleet-look cleanup" "no chrome on this host (fleet-look exited $LKRC_OK)"
  fi
  rm -rf "$LKC"
else
  skip "fleet-look cleanup" "node or pgrep missing"
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
# The card can be titled something a human chose ("PR 1184 retry work") while the tmux
# session keeps its name. That separation is the whole point: fleet-rename exists to keep
# "worktree basename == session name" true, and fleet-send, the Ctrl-f chord, the
# dev-stack slot and the manifest all key off it. So the label is cosmetic BY
# CONSTRUCTION — a marker file only the card reads — and the card still shows the session
# name, because a card titled "PR 1184 retry work" otherwise tells you nothing to type.
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
  printf 'PR 1184 retry work\n' > "$LB/fleet/cflbltest.w1.label"
  is "labelled: the card is the label"        "PR 1184 retry work" "$(cardtitle)"
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
# ── 4e. A TMUX THAT REWRITES OUR SEPARATOR (<= 3.5) ──────────────────────────
# tmux <= 3.5 pushed every byte of command output through vis(3) — utf8_strvis() with
# VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH, from server_client_print() via
# cmdq_print_data(item, 0, …). So a `\x1f` separator inside a `-F` format came back as
# the four literal characters `\037`, the record never split, and the WHOLE row landed in
# the first field: CLAUDE.md's "the leftover lands on the last variable, and it looks
# like data", arriving through tmux's formatter instead of through `read`. tmux 3.6
# stopped, by passing parse=1 unconditionally in cmd-queue.c.
#
# Ubuntu 24.04's apt tmux is 3.4; Homebrew's is 3.7b. That is the ENTIRE difference —
# measured: tmux 3.4 on a Mac reproduces 122 of the Linux leg's 125 failures, group for
# group. So this is a tmux-VERSION bug that one platform merely exposes.
#
# AND IT IS UNTESTABLE WHERE IT IS DEVELOPED, which is the whole reason for the shim: on
# 3.7b a tab and a \x1f behave identically, so an assertion about the fix would pass
# either way — the same as having no assertion. test/helpers/tmux-vis35.mjs runs the real
# tmux and re-applies that escaping; its output is byte-identical to real tmux 3.4's.
# The first two assertions prove the shim really mangles BEFORE anything trusts it, and
# that it leaves a tab alone, which is the single property the fix rests on.
group "tmux <= 3.5 escapes what it prints"
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  VS="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$VS/bin"
  # a `tmux` that behaves like 3.4, first on PATH
  printf '#!/usr/bin/env bash\nexec node %s %s "$@"\n' \
    "$ROOT/test/helpers/tmux-vis35.mjs" "$(command -v tmux)" > "$VS/bin/tmux"
  chmod +x "$VS/bin/tmux"
  tmux -L cfvis35 kill-server 2>/dev/null
  tmux -L cfvis35 new-session -d -s master   -c "$VS" 'sleep 90' 2>/dev/null
  tmux -L cfvis35 new-session -d -s worker-a -c "$VS" 'sleep 90' 2>/dev/null
  sleep 1
  shimmed() { PATH="$VS/bin:$PATH" "$@"; }
  # 1. THE SHIM IS DOING ITS JOB, asked of it DIRECTLY. Without this the rest is
  # decoration — a shim that quietly did nothing would make every assertion below pass.
  #   Not through tmux, on purpose: the suite has to run on 3.4 as well, where the real
  # tmux has ALREADY escaped and the shim would be escaping an escape. Handing it
  # /usr/bin/printf instead of tmux tests the one thing it is for, on any machine.
  vis35() { node "$ROOT/test/helpers/tmux-vis35.mjs" /usr/bin/printf "$1" 2>/dev/null; }
  is "the shim escapes \\x1f as \\037"  'A\037B'            "$(vis35 'A\037B')"
  is "...and \$name as \\\$name"        'x=\$HOME'          "$(vis35 'x=$HOME')"
  is "...and 0x1b as \\033"             'e\033[1m'          "$(vis35 'e\033[1m')"
  # UTF-8 passes whole (utf8_strvis walks codepoints), which is why the pane detectors
  # are not collateral damage on <= 3.5 — their spinner glyphs arrive intact.
  is "...but leaves UTF-8 alone"        "$(printf '\342\234\273')" "$(vis35 '\342\234\273')"
  # 2. THE ONE PROPERTY THE FIX RESTS ON: a tab is the only byte under 0x20 that vis
  # leaves alone with this flag set (VIS_TAB is not in it), so it crosses every tmux from
  # 3.4 to 3.7b unchanged. Asserted of the shim, and of whatever tmux is actually here —
  # that second one is the assertion that would catch a tmux which broke the premise.
  is "a tab survives the shim"          "$(printf 'A\tB')"    "$(vis35 'A\tB')"
  is "...and this machine's real tmux"  "2" \
     "$(tmux -L cfvis35 list-sessions -F "A$(printf '\t')B" 2>/dev/null \
        | awk -F'\t' '{print NF}' | head -1)"
  is "...and the shim over that tmux"   "2" \
     "$(shimmed tmux -L cfvis35 list-sessions -F "A$(printf '\t')B" 2>/dev/null \
        | awk -F'\t' '{print NF}' | head -1)"

  # 3. THE GRID, end to end, on a tmux that escapes. Before the fix this printed
  # "(no sessions)": every record arrived as one field, so the whole row was the name and
  # isTab()/the status join threw them all away.
  gp() { shimmed env CLAUDE_FLEET_DIR="$VS" node "$ROOT/bin/fleet-grid.mjs" cfvis35 --plain 2>/dev/null; }
  is "--plain still finds the worker"   "1" "$(gp | grep -c '^worker-a ' || true)"
  # the CHECKOUT column comes from #{session_path}, so it is only right if the record
  # split — the header's counts print the same "0 need you" whether it did or not
  is "...with its checkout column"      "1" \
     "$(gp | grep -c "^worker-a *$(basename "$VS")" || true)"
  gj() { shimmed env CLAUDE_FLEET_DIR="$VS" node "$ROOT/bin/fleet-grid.mjs" cfvis35 --json 2>/dev/null; }
  is "--json names the session, not the row" "worker-a" \
     "$(gj | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const j=JSON.parse(s); const c=(j.cards||[]).find(x=>!x.lead);
          console.log(c ? c.name : "(none)"); })' 2>/dev/null)"
  # THE MIDDLE COLUMN, which is the one an unsplit record loses most quietly: `folder`
  # is derived from #{session_path}, so it can only be right if the record really split.
  is "...and #{session_path} landed too"  "$(basename "$VS")" \
     "$(gj | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const j=JSON.parse(s); const c=(j.cards||[]).find(x=>!x.lead);
          console.log(c ? c.folder : "(none)"); })' 2>/dev/null)"
  # 4. AND IT SAYS SO when a record does not split, instead of reporting an empty fleet.
  # That silence is why one formatter change became 122 red assertions rather than one.
  is "an unsplit record is reported"    "1" \
     "$(sed 's/^const TF = .*$/const TF = "\\x1f";/' "$ROOT/bin/fleet-grid.mjs" > "$VS/old.mjs"
        shimmed env CLAUDE_FLEET_DIR="$VS" node "$VS/old.mjs" cfvis35 --plain 2>&1 >/dev/null \
        | grep -c 'rewrote the separator' || true)"
  tmux -L cfvis35 kill-server 2>/dev/null

  # 5. THE STACK'S RECORD, on the same tmux. Four fields, and the last two are EMPTY on a
  # pane that predates them — which is why the parse stays \x1f-based behind a `tr`: a
  # `tr` is a 1:1 byte map so an empty field stays empty, while `IFS=$'\t' read` would
  # collapse it (tab is IFS WHITESPACE) and shift the stamps into the tty.
  MS=cfvis35st
  tmux -L $MS kill-server 2>/dev/null
  tmux -L $MS -f "$ROOT/tmux/cf-stack.tmux.conf" new-session -d -s stack -x 200 -y 50 'sleep 120' 2>/dev/null
  tmux -L $MS split-window -h -t stack 'sleep 120' 2>/dev/null
  tmux -L $MS select-layout -t stack even-horizontal 2>/dev/null
  mi=0; for m in one two; do
    tmux -L $MS set-option -p -t "stack.$mi" @cf_sock "cf-$m" 2>/dev/null
    tmux -L $MS set-option -p -t "stack.$mi" @cf_sess master 2>/dev/null
    mi=$((mi + 1))
  done
  tmux -L $MS set-option -g @cf_fleet_dir "$VS" 2>/dev/null
  tmux -L $MS select-pane -t stack.0 2>/dev/null
  printf 'cf-one\tmaster\ncf-two\tmaster\n' > "$VS/stack.tsv"
  MSOCK="$(tmux -L $MS display-message -p '#{socket_path}' 2>/dev/null)"
  pn() { tmux -L $MS list-panes -t '=stack' -F '#{@cf_sock}' 2>/dev/null | tr '\n' ' '; }
  MV() { shimmed "$ROOT/bin/fleet-stack" move "$1" \
           "$(tmux -L $MS list-panes -t '=stack' -F '#{?pane_active,#{pane_tty},}' 2>/dev/null | tr -d ' \n')" \
           "$MSOCK" 2>&1; }
  is "stack panes start in file order"  "cf-one cf-two " "$(pn)"
  MV right >/dev/null 2>&1
  is "a move works on that tmux too"    "cf-two cf-one " "$(pn)"
  # THE EMPTY-FIELD DIRECTION. Clear @cf_sess only: the record still has four columns,
  # the fourth one empty. It must refuse for the RIGHT reason — "which member is this
  # pane" — and not for the one a collapsed field produces, where the stamps slide left
  # and the tty stops matching any pane.
  tmux -L $MS set-option -pu -t stack.0 @cf_sess 2>/dev/null
  emsg="$(MV right)"
  is "an empty stamp: refuses on the stamp" "1" "$(printf '%s' "$emsg" | grep -c "don't say which member" || true)"
  is "...and NOT on a shifted tty"          "0" "$(printf '%s' "$emsg" | grep -c 'not a pane' || true)"
  tmux -L $MS kill-server 2>/dev/null; rm -rf "$VS"
else
  skip "tmux <= 3.5 escaping" "tmux or node missing"
fi

# THE TWO PARSES, side by side, because the choice between them is the whole reason the
# stack translates at the boundary instead of reading tabs straight. A tab is IFS
# WHITESPACE, so `IFS=$'\t' read` collapses an empty field and shifts every later one
# left — CLAUDE.md's opening entry, and why \x1f was picked for our own wires in the
# first place. `tr` is a 1:1 byte map, so it cannot collapse anything.
#   Neither line tests ghostfleet; both pin the property ghostfleet is built on, in both
# directions, so "just use IFS=$'\t'" cannot look harmless to the next reader.
group "an empty field survives \x1f and not a tab"
rec="$(printf 'a\tb\t\td')"
IFS=$'\t'   read -r f1 f2 f3 f4 <<< "$rec"
IFS=$'\x1f' read -r g1 g2 g3 g4 < <(printf '%s' "$rec" | tr '\t' '\037')
is "IFS=tab shifts the fields left" "a|b|d|" "$f1|$f2|$f3|$f4"
is "tr to \x1f keeps the empty one" "a|b||d" "$g1|$g2|$g3|$g4"

# THE INVARIANT, so the next `-F` cannot quietly reintroduce this. A separator inside a
# tmux format has to be a tab; \x1f is for our OWN wires (the grid's choice line, the
# hooks' jq records, the reply-to file), where `read` is the parser and a tab would
# collapse an empty field. Both directions: the tmux side must have none, and our own
# side must still have some, or a grep that passes because somebody removed every \x1f
# would look identical.
group "the tmux wire separator is a tab, ours is \$'\\x1f'"
FSRC="$ROOT/bin $ROOT/mcp $ROOT/hooks $ROOT/tmux"
is "no tmux -F format carries \\x1f" "0" \
   "$(grep -rn -- '#{' $FSRC 2>/dev/null | grep -c 'x1f\|\\\\037\|\${US}' || true)"
is "the grid's -F does use a tab"    "1" \
   "$(grep -c 'session_name}\${TF}#{session_path}' "$ROOT/bin/fleet-grid.mjs" || true)"
is "the stack's -F does too"         "1" \
   "$(grep -c 'pane_id}\${TF}#{pane_tty}' "$ROOT/bin/fleet-stack" || true)"
# ...and the stack still parses with \x1f, behind the tr that keeps empty fields
is "the stack translates at the edge" "1" \
   "$(grep -c "tr '\\\\t' '\\\\037'" "$ROOT/bin/fleet-stack" || true)"
is "our own wires still use \\x1f"    "1" \
   "$([ "$(grep -c "US=\\\$'\\\\x1f'" "$ROOT/bin/ghostfleet" || true)" -ge 1 ] && echo 1 || echo 0)"


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
# DERIVES that name from the directory: billing-svc-61, acme-api-06, toolbox-4b.
# Nothing in the fleet knows those, so "reply to master" named nothing and the direct
# reply path could not be used at all. claude-here now passes the address the fleet
# already uses, <project>/<session> — the same string fleet-send computes for --reply-to
# and the hook prints in an inbox row.
#
# Both directions, because a HALF name is worse than none: "/master" or "acme-api/" is
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
is "named <project>/<session>"        "acme-api/master" "$(NAMED cf-acme-api master)"
# The SAME expansion fleet-send uses (${sock#cf-}), so a socket without the prefix spells
# one name on both sides instead of two that never meet.
is "...however the socket is spelled" "weird/master"    "$(NAMED weird master)"
is "no socket -> no name"             ""                "$(NAMED '' master)"
is "no session -> no name"           ""                 "$(NAMED cf-acme-api)"
# A name has to be spellable back at us: fleet-send refuses these characters in a reply
# address, and Claude Code renames a session whose name it won't take.
is "an unspellable name is dropped"   ""                "$(NAMED cf-acme-api 'mas ter')"
# The caller's own --name wins, and a second one would be an argument error.
is "an explicit --name is left alone" "boss"            "$(NAMED cf-acme-api master -- --name boss)"
is "...and never doubled"             "1" \
   "$(ARGV cf-acme-api master -- --name boss | tr ' ' '\n' | grep -c -- '--name' || true)"
is "...nor in the --name=x spelling"  "1" \
   "$(ARGV cf-acme-api master -- --name=boss | tr ' ' '\n' | grep -c -- '--name' || true)"
# THE PATH A FLEET SESSION ACTUALLY TAKES is the resume one — a session is created once
# and re-opened for the rest of its life, so a name that only lands on a fresh start would
# be missing from every session anyone talks to.
enc="$(printf '%s' "$CH/work" | sed 's#[/.]#-#g')"; mkdir -p "$CH/cfg/projects/$enc"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}' \
  > "$CH/cfg/projects/$enc/abc123.jsonl"
res="$(ARGV cf-acme-api master)"
is "a resumed session is named too"   "1" "$(printf '%s' "$res" | grep -c -- '--resume abc123' || true)"
is "...with the same name"            "acme-api/master" "$(NAMED cf-acme-api master)"
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
  # AND THE ASSERTION ABOVE NEEDS TEETH, because on its own it cannot fail for the reason
  # it exists: a name resolving to itself is unremarkable unless something shows what the
  # alternative does.
  #
  # TWO PHRASINGS HAVE BEEN TRIED HERE AND BOTH WERE UNSTABLE, so do not restore either.
  # The first asserted that a + name "resolves ELSEWHERE"; the second, that its answer
  # MOVES when another session is created. Both assert on which session a + target lands
  # on, and that is decided relative to whatever tmux considers the CURRENT session —
  # which, with no client attached, is whatever the server last used. Nothing in a test
  # sets it, so the row passes or fails on scheduling.
  #   MEASURED, chasing exactly that: the "moved" phrasing was green here eight runs out
  # of eight and red on another machine running the SAME tmux 3.7b, expecting `moved` and
  # getting `same`. A red that is indistinguishable from a real one, on a suite whose rule
  # is to trust a test only after watching it go red, is worse than no row at all.
  #   The drift is easy to see once it is looked for: `-t +term-api-2` answered
  # `+term-api-2` at one moment and `zz-elsewhere` a moment later, with the session of
  # that name never touched in between.
  #
  # WHAT IS STABLE IS THE HAZARD ITSELF, and it needs no notion of current, no ordering,
  # and no second measurement across time: a + target does not consult the rest of the
  # string at all. So two DIFFERENT sessions whose names both begin with + answer the SAME
  # session, while two whose names begin with _ each answer themselves. That is precisely
  # what breaks every status reader here — they target a bare -t "$name", so with + names
  # they would read one tab while believing they read another.
  #
  # MEASURED on tmux 3.4 (built from source for this) and on 3.7b, byte-identical on both:
  #     -t +term-api-2 -> +term-api-3      -t +term-api-3 -> +term-api-3     (one session)
  #     -t _term-api-2 -> _term-api-2      -t _term-api-3 -> _term-api-3     (two)
  # and `has-session -t +term-api-2` says yes on both, which is why has-session never
  # caught this and why the check has to be a target-RESOLVING command.
  #
  # THE PREFIX IS READ BACK FROM WHAT fleet-tab ACTUALLY NAMED THE TAB rather than
  # hardcoded, because the row exists to protect that choice: reverting bin/fleet-tab to
  # `+` has to make these two fail, and against a hardcoded `_term-…` they would instead
  # pass while measuring a session fleet-tab never made.
  tabs_now="$(tmux -L cftabt list-sessions -F '#{session_name}' 2>/dev/null)"
  tab2="$(grep -E 'term-api-2$' <<<"$tabs_now" | sed -n '1p')"
  sib="${tab2%term-api-2}term-probe"
  tmux -L cftabt new-session -d -s "$sib" -c "$TB/api-3" 'sleep 60' 2>/dev/null
  resolves() { tmux -L cftabt display-message -p -t "$1" '#{session_name}' 2>/dev/null; }
  is "...and a second tab is a SECOND session" "different" \
     "$([ "$(resolves "$tab2")" = "$(resolves "$sib")" ] && echo same || echo different)"
  # ...each answering its own name, which rules out the other way two answers can differ:
  # both being wrong.
  is "...each answering its own name"          "$tab2|$sib" \
     "$(resolves "$tab2")|$(resolves "$sib")"
  # `=` forces an exact name match, so this kills the probe even when its name is a target
  # expression; a bare -t would kill whichever session the expression happens to name.
  tmux -L cftabt kill-session -t "=$sib" 2>/dev/null

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

# ── removing a worktree does not freeze the grid ─────────────────────────────
# THE BUG: removeWorktree() ran execFileSync, and the grid is a single-threaded Node TUI,
# so a checkout with a real node_modules (tens of thousands of files, the better part of a
# minute) took the event loop with it. The banner said "this can take a minute" and then no
# key, no poll and no redraw answered until it finished — reported as "the app froze".
#
# What the suite can hold on to is the two things that are not the drawing: the refusal
# MESSAGE, which is the part with the scars and the part an async rewrite quietly loses,
# and whether a removal in flight is VISIBLE in the status output. The interactive half is
# in the PR, driven through a real tmux pane.
group "worktree removal: the refusal survives, and the wait is visible"
if ! command -v git >/dev/null 2>&1; then
  skip "worktree removal" "git is not installed"
else
  WR="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$WR/fleet"
  git -C "$WR" init -q repo 2>/dev/null
  git -C "$WR/repo" config user.email t@t.invalid 2>/dev/null
  git -C "$WR/repo" config user.name suite 2>/dev/null
  git -C "$WR/repo" config commit.gpgsign false 2>/dev/null
  printf 'x\n' > "$WR/repo/a.txt"
  git -C "$WR/repo" add -A >/dev/null 2>&1; git -C "$WR/repo" commit -qm first >/dev/null 2>&1
  if ! git -C "$WR/repo" rev-parse HEAD >/dev/null 2>&1; then
    skip "worktree removal" "git in this environment cannot commit"
  else
    git -C "$WR/repo" worktree add -q "$WR/dirtywt" -b dirtywt 2>/dev/null
    git -C "$WR/repo" worktree add -q "$WR/cleanwt" -b cleanwt 2>/dev/null
    printf 'uncommitted\n' >> "$WR/dirtywt/a.txt"
    wg() { CLAUDE_FLEET_DIR="$WR/fleet" CLAUDE_FLEET_ROOT="$WR/repo" node "$ROOT/bin/fleet-grid.mjs" cfwtsuite "$@"; }

    # ── the refusal, shaped, from REAL git stderr ───────────────────────────
    # Not a fixture string: the thing that must not drift is what this formatter does to
    # what GIT actually prints, and git's wording is git's to change.
    raw="$(git -C "$WR/repo" worktree remove "$WR/dirtywt" 2>&1 >/dev/null)"
    is "git refuses a dirty worktree"        "1" "$(printf '%s' "$raw" | grep -c 'contains modified or untracked' || true)"
    is "...naming it by its FULL path"       "1" "$(printf '%s' "$raw" | grep -c "$WR/dirtywt" || true)"
    msg="$(printf '%s' "$raw" | wg --wt-remove-msg "$WR/dirtywt")"
    # Every one of these four is a rule the message already had, and the reason each exists
    # is that the full path pushes the actual reason off the end of a one-line banner.
    is "the shown message keeps the reason"  "1" "$(printf '%s' "$msg" | grep -c 'contains modified or untracked files' || true)"
    is "...names the worktree by basename"   "1" "$(printf '%s' "$msg" | grep -c "'dirtywt'" || true)"
    is "...and NOT by its full path"         "0" "$(printf '%s' "$msg" | grep -c "$WR/dirtywt" || true)"
    is "...drops git's 'fatal:' prefix"      "0" "$(printf '%s' "$msg" | grep -c 'fatal' || true)"
    # The card already says `f` is the force key, so the tail is noise that costs the width
    # the reason needs.
    is "...drops the 'use --force' tail"     "0" "$(printf '%s' "$msg" | grep -c 'use --force' || true)"
    is "...and fits a banner"                "yes" "$([ "${#msg}" -le 80 ] && echo yes || echo "no: ${#msg} chars")"
    # $HOME -> ~, on a path that is NOT the worktree's own (that one is already a basename).
    home_msg="$(printf "fatal: '%s' is locked by '%s/elsewhere'\n" "$WR/dirtywt" "$HOME" | wg --wt-remove-msg "$WR/dirtywt")"
    is "a path under HOME shortens to ~"     "1" "$(printf '%s' "$home_msg" | grep -c '~/elsewhere' || true)"
    is "...and the home path itself is gone" "0" "$(printf '%s' "$home_msg" | grep -c "$HOME/elsewhere" || true)"
    # git saying nothing at all is a real case: it must not print an empty line.
    is "silence still says something"        "1" "$(printf '' | wg --wt-remove-msg "$WR/dirtywt" | grep -c 'git worktree remove failed' || true)"

    # ── a removal in flight is VISIBLE, and a dead one is not ───────────────
    # The marker is a FILE for this reason: the state has to be readable by a process that
    # is not the grid — this one, --json, another pane's grid. It carries the writer's pid,
    # so "still going" and "the grid died" are distinguishable from outside.
    printf '{"pid":%s,"at":1,"force":false}' "$$" > "$WR/fleet/cfwtsuite.cleanwt.removing"
    is "--plain says a removal is running"   "1" "$(wg --plain | grep -c '^removing: cleanwt' || true)"
    is "--json flags that worktree"          "true" \
       "$(wg --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const w=JSON.parse(d).free_worktrees.find(x=>x.path.endsWith("/cleanwt"));console.log(String(w&&w.removing))})')"
    is "...and not the other one"            "false" \
       "$(wg --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const w=JSON.parse(d).free_worktrees.find(x=>x.path.endsWith("/dirtywt"));console.log(String(w&&w.removing))})')"
    # THE OTHER DIRECTION. A marker whose grid is gone is not a removal — reporting one
    # would strand the card in a state nothing can clear, which is worse than the freeze
    # this change is fixing.
    printf '{"pid":999999,"at":1,"force":false}' > "$WR/fleet/cfwtsuite.cleanwt.removing"
    is "a dead writer is not a removal"      "0" "$(wg --plain | grep -c '^removing:' || true)"
    is "...and --json agrees"                "false" \
       "$(wg --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const w=JSON.parse(d).free_worktrees.find(x=>x.path.endsWith("/cleanwt"));console.log(String(w&&w.removing))})')"
    is "...and the stale marker is cleared"  "no" \
       "$([ -e "$WR/fleet/cfwtsuite.cleanwt.removing" ] && echo yes || echo no)"

    # ── a removal cut off half way heals itself ─────────────────────────────
    # This is what makes "let the child finish, do not trap the user on this screen" a
    # defensible choice: a SIGKILL leaves the directory gone and the administrative entry
    # behind, git reports that entry as `prunable`, and ONE read of the status prunes it.
    rm -rf "$WR/cleanwt"
    is "git calls the leftover prunable"     "1" "$(git -C "$WR/repo" worktree list --porcelain | grep -c '^prunable ' || true)"
    wg --json >/dev/null
    is "...and one status read heals it"     "0" "$(git -C "$WR/repo" worktree list --porcelain | grep -c '^prunable ' || true)"
    is "...leaving the live worktree alone"  "1" "$(git -C "$WR/repo" worktree list | grep -c dirtywt || true)"

    # ── and it is actually asynchronous ────────────────────────────────────
    # A structural guard, because the whole point is one call that must not block: the next
    # person to touch this should have to argue with a red suite before making it sync again.
    # A REGEX, and it has to exclude the OTHER worktree calls: worktreesOf() legitimately
    # runs execFileSync for `worktree list` and `worktree prune`, and only `remove` is the
    # one that takes a minute. Point 5 of the brief in one assertion — this fix is about one
    # call, not about asyncing the twenty-odd fast reads around it.
    is "the removal is not execFileSync"     "0" \
       "$(grep -cE 'execFileSync.*worktree.*remove' "$ROOT/bin/fleet-grid.mjs" || true)"
    # PRESENCE, not a count: worktreesOf() reads the list twice (once, then again after a
    # prune), and pinning the number would fail the next time somebody reads it a third
    # time — which says nothing about whether the removal blocks.
    is "...the list still is (sync is fine)" "yes" \
       "$(grep -qE 'execFileSync.*worktree., .list' "$ROOT/bin/fleet-grid.mjs" && echo yes || echo no)"
    is "...and the removal is execFile"      "1" "$(grep -c "execFile('nohup', gitArgv" "$ROOT/bin/fleet-grid.mjs" || true)"
    # nohup, and detached: measured — without SIGHUP ignored the child dies the moment the
    # pane closes, so pressing ` would abort the removal half way.
    is "...under nohup, so it outlives the pane" "1" "$(grep -c 'nohup is invoked with an argv array' "$ROOT/bin/fleet-grid.mjs" || true)"
    # Also presence: this file detaches several children (tabs, the stack), and the count
    # of them is not what this row is about.
    is "...and detached from the pane"       "yes" \
       "$(grep -q 'detached: true' "$ROOT/bin/fleet-grid.mjs" && echo yes || echo no)"
    # The card must never read FREE while its files are being deleted.
    is "the card has its own removing state" "1" "$(grep -c '⋯ REMOVING' "$ROOT/bin/fleet-grid.mjs" || true)"
  fi
  rm -rf "$WR"
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

# ── 4d5b. the wake must find the INPUT BOX, not the last ❯ on screen ─────────
# hooks/fleet-event.sh only pastes a worker-finished nudge into master when the composer
# is empty, or it would submit whatever a human was half-way through typing with the nudge
# glued on. It identified that box as "the last line containing ❯", which is not the box:
#
#   * Claude Code echoes every SUBMITTED message back into the transcript as `❯ <text>`
#     and those stay on screen — claude-composer-empty.txt has one, plus THREE prose lines
#     that mention ❯, one of which is the old guard's own `grep '❯'`;
#   * a pane with no composer at all — a shell tab, a permission dialog — has a last ❯
#     that means something else entirely, or none at all.
#
# Both directions, and the second is the one that must never regress: a nudge that pastes
# over a half-typed message is worse than a nudge that waits.
group "the wake finds the input box, not the last ❯"
if command -v awk >/dev/null 2>&1; then
  # the real function, lifted from the hook with only its tmux call swapped for a file —
  # the same way the fleet-send composer detector is tested above
  eval "$(sed -n '/^_input_state() {/,/^}/p' "$ROOT/hooks/fleet-event.sh" \
          | sed 's|tmux -L "$1" capture-pane -p -t "$2" 2>/dev/null|cat "$1"|')"
  st() { _input_state "$FIX/$1" x; echo $?; }          # 0 empty · 1 typed · 2 no box
  is "an empty composer is safe to paste"   "0" "$(st claude-composer-empty.txt)"
  is "a typed composer is NEVER clobbered"  "1" "$(st claude-composer-typed.txt)"
  is "a permission dialog has no box"       "2" "$(st claude-permission-dialog-sgr.txt)"
  is "a shell pane has no box either"       "2" "$(st shell-pane-no-composer.txt)"
  # the older captures, which must not regress
  is "...and the plain-space empty box"     "0" "$(st claude-input-submitted.txt)"
  is "...and the plain-space typed box"     "1" "$(st claude-input-pending.txt)"

  # THE TRAPS, asserted to actually BE in the fixture — a fixture that quietly lost them
  # would leave the assertions above passing for the wrong reason
  is "the empty fixture has an echoed ❯ msg" "1" \
     "$([ "$(LC_ALL=C grep -c '^❯' "$FIX/claude-composer-empty.txt")" -ge 2 ] && echo 1 || echo 0)"
  is "...and prose that mentions ❯"          "1" \
     "$([ "$(grep -c '❯' "$FIX/claude-composer-empty.txt")" -ge 4 ] && echo 1 || echo 0)"
  # U+00A0. A live empty composer pads with a NON-BREAKING space, not U+0020 — so a
  # detector that only strips ASCII whitespace reads an empty box as typed and skips the
  # wake forever. Pinned, because the padding has already changed once.
  is "...and pads with U+00A0, not a space"  "1" \
     "$(LC_ALL=C grep -c "$(printf '\302\240')" "$FIX/claude-composer-empty.txt" >/dev/null 2>&1 && echo 1 || echo 0)"

  # AND WHAT THE OLD GUARD DID, so the fix is visible rather than asserted. It answers
  # "paste" for a pane with no composer at all, which is how a nudge could be typed into
  # a shell and submitted.
  old_guard() { local inl; inl="$(grep '❯' "$1" | tail -1)"
                inl="$(printf '%s' "${inl#*❯}" | tr -d '[:space:]│╭╮╰╯─|')"
                [ -z "$inl" ] && echo paste || echo skip; }
  is "the old guard pastes into a shell"    "paste" "$(old_guard "$FIX/shell-pane-no-composer.txt")"
  is "...and the new one refuses"           "2"     "$(st shell-pane-no-composer.txt)"
else
  skip "wake input-box guard" "awk missing"
fi

# ── 4d5c. a skipped wake must be delayed, never dropped ──────────────────────
# The skip used to leave nothing behind, reasoning that "the next event re-checks right
# away". That holds only if another event comes. When the LAST worker to finish is the one
# skipped, nothing re-checks — ever: the master sits idle with a DONE in its inbox and no
# reason to look, which is indistinguishable from no worker having finished. Measured on
# the live fleet: two DONE rows wrote their inbox entries and sent no nudge, and the stamp
# (written only on a successful send) still read 14 and 22 minutes earlier.
group "a skipped wake comes back"
if command -v tmux >/dev/null 2>&1; then
  ND="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$ND/bin"
  # a fleet-send that records instead of pasting
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/sent.log"\n' "$ND" > "$ND/bin/fleet-send"
  chmod +x "$ND/bin/fleet-send"
  eval "$(sed -n '/^_defer_nudge() {/,/^}/p' "$ROOT/hooks/fleet-event.sh")"
  # THE GUARD IS STUBBED HERE ON PURPOSE. Its correctness is the group above, against real
  # captured panes; what this group tests is the DEFERRAL — that a skip comes back. Feeding
  # it a scripted answer is also the only way to make "the box was busy, then it cleared"
  # deterministic, and replaying a 65-line fixture into a tmux pane does not do that: the
  # pane reflows it at its own width and the composer stops being where it was.
  # ND is exported because _defer_nudge runs its re-check in a DETACHED bash -c and
  # carries the guard across with `export -f` — an exported function whose body reads an
  # un-exported variable is a stub that always answers "not empty" over there
  export ND
  _input_state() { return "$(cat "$ND/state" 2>/dev/null || echo 2)"; }
  _input_empty() { _input_state "$1" "$2"; [ "$?" = 0 ]; }
  echo 1 > "$ND/state"                       # the human is mid-sentence
  FLEET_DIR="$ND"; export FLEET_DIR
  tmux -L cfnudge kill-server 2>/dev/null
  tmux -L cfnudge new-session -d -s master 'sleep 120' 2>/dev/null; sleep 1
  CLAUDE_FLEET_NOTIFY_RETRY_EVERY=1 CLAUDE_FLEET_NOTIFY_RETRY_TRIES=40 PATH="$ND/bin:$PATH" \
    _defer_nudge cfnudge
  sleep 2
  is "the skip armed a re-check"          "1" "$([ -f "$ND/cfnudge.notify.retry" ] && echo 1 || echo 0)"
  is "...with a live pid in it"           "1" \
     "$(p=$(cat "$ND/cfnudge.notify.retry" 2>/dev/null); kill -0 "$p" 2>/dev/null && echo 1 || echo 0)"
  is "...and it has sent nothing yet"     "0" \
     "$([ -f "$ND/sent.log" ] && wc -l < "$ND/sent.log" | tr -d ' ' || echo 0)"
  # ONE PER FLEET: five workers finishing while a human types must not queue five pastes
  first="$(cat "$ND/cfnudge.notify.retry" 2>/dev/null)"
  CLAUDE_FLEET_NOTIFY_RETRY_EVERY=1 CLAUDE_FLEET_NOTIFY_RETRY_TRIES=40 PATH="$ND/bin:$PATH" \
    _defer_nudge cfnudge
  sleep 1
  is "a second skip does not arm another" "$first" "$(cat "$ND/cfnudge.notify.retry" 2>/dev/null)"
  # the human submits: the box clears. NOTHING else happens — no new event, no new hook
  # run — and the wake must still arrive. That is the whole bug.
  echo 0 > "$ND/state"
  for i in $(seq 1 25); do [ -s "$ND/sent.log" ] && break; sleep 1; done
  is "the deferred wake arrives by itself"     "1" "$([ -s "$ND/sent.log" ] && echo 1 || echo 0)"
  is "...addressed to master"                  "1" "$(grep -c master "$ND/sent.log" 2>/dev/null || echo 0)"
  is "...exactly once"                         "1" "$(wc -l < "$ND/sent.log" | tr -d ' ')"
  is "...and stamped, so a burst coalesces"    "1" "$([ -s "$ND/cfnudge.notify.stamp" ] && echo 1 || echo 0)"
  is "...and released its single-flight lock"  "0" "$([ -f "$ND/cfnudge.notify.retry" ] && echo 1 || echo 0)"
  # AND THE OTHER DIRECTION: a box that never clears must not paste, and must not vanish
  # silently either — it leaves a trace naming what went undelivered.
  rm -f "$ND/sent.log" "$ND/cfnudge.notify.stamp"; echo 1 > "$ND/state"
  CLAUDE_FLEET_NOTIFY_RETRY_EVERY=1 CLAUDE_FLEET_NOTIFY_RETRY_TRIES=2 PATH="$ND/bin:$PATH" \
    _defer_nudge cfnudge
  for i in $(seq 1 15); do [ -s "$ND/cfnudge.notify.undelivered" ] && break; sleep 1; done
  is "a box that never clears sends nothing"   "0" \
     "$([ -f "$ND/sent.log" ] && wc -l < "$ND/sent.log" | tr -d ' ' || echo 0)"
  is "...and leaves a trace, not silence"      "1" \
     "$([ -s "$ND/cfnudge.notify.undelivered" ] && echo 1 || echo 0)"
  tmux -L cfnudge kill-server 2>/dev/null; rm -rf "$ND"
else
  skip "deferred wake" "tmux missing"
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
# A sibling was the only layout and is still the default. But one repo's PreToolUse guard
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
# One project here registers ~/acme-api, which is NOT a repo — it holds four independent clones,
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
  #   THE RECORD IS THREE FIELDS NOW — branch, number, state — and the file is `prs.<slug>`
  # rather than `merged.<slug>`, so an old cache holding bare branch names can never be
  # read as a new one. \x1f and not a tab: this is our own wire (CLAUDE.md), and a tab
  # would collapse an empty field and shift the state left into the number.
  printf 'feat/shipped\x1f77\x1fMERGED\n' > "$FD/fleet/prs.acme_widget"
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
  rm -f "$FD/fleet/prs.acme_widget"
  is "silent when nothing is finished" "0" "$(ib | grep -c 'finished & reclaimable' || true)"
  tmux -L cffin kill-server 2>/dev/null; rm -rf "$FD"
else
  skip "finished worktrees" "git or tmux missing"
fi

# ── 4d10b. fleet-merged also answers "which PR", without ever blocking ───────
# The PR number is the most useful single fact about a working session and it was only ever
# visible inside `msg` — the last assistant line, which changes every turn, so a card built
# from that text would gain and lose the number as the agent talks and would show a stray
# issue reference as a PR. So the grid asks fleet-merged, which already resolves branches to
# PR state and already caches.
#
# THE OLD OUTPUT SHAPE IS LOAD-BEARING and is asserted first. fleet-clean and
# fleet-worktrees both match it with `grep -qxF` — an exact whole-line test — so a
# three-field record on stdout would silently make `is_merged` false everywhere: fleet-clean
# would refuse everything (safe, but the feature stops) and fleet-worktrees would call
# finished work FREE. The group above covers those two through their own commands; these
# rows pin the format they depend on.
#
# AND --cached CANNOT REACH gh. That is not a convention here, it is the property that lets
# a 2-second repaint carry this at all — so it is measured with an exploding gh on PATH that
# leaves a marker file behind, at TTL=0 where the fresh path would certainly fetch.
group "fleet-merged: numbers as well as names, and never a network call in a draw"
if command -v git >/dev/null 2>&1; then
  MG="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$MG/fleet" "$MG/bin" "$MG/repo"
  git -C "$MG/repo" init -q 2>/dev/null
  git -C "$MG/repo" remote add origin git@github.com:acme/widget.git 2>/dev/null
  printf 'feat/live\x1f1184\x1fOPEN\nfix/csv\x1f1170\x1fMERGED\nfeat/old\x1f99\x1fMERGED\n' \
    > "$MG/fleet/prs.acme_widget"
  fm() { env CLAUDE_FLEET_DIR="$MG/fleet" "$ROOT/bin/fleet-merged" "$@" "$MG/repo" 2>/dev/null; }
  # 1. the shape fleet-clean and fleet-worktrees read: MERGED branch names, one per line,
  #    and NOTHING else on the line.
  is "default output is bare branch names" "fix/csv feat/old" "$(fm | tr '\n' ' ' | sed 's/ *$//')"
  is "...with no open PR among them"       "0" "$(fm | grep -c 'feat/live' || true)"
  is "...and no second field to confuse grep -qxF" "0" "$(fm | grep -c "$(printf '\037')" || true)"
  # 2. the new shape, for the card
  is "--prs carries branch, number and state" "feat/live|1184|OPEN" \
     "$(fm --prs | head -1 | tr '\037' '|')"
  is "...for every PR it knows, open and merged" "3" "$(fm --prs | grep -c . || true)"
  # 3. --cached is sealed. The marker proves the exploder actually runs, so the negative
  #    result above it is a measurement and not an absence of evidence.
  printf '#!/bin/sh\ntouch %s/GH_RAN\nexit 1\n' "$MG" > "$MG/bin/gh"; chmod +x "$MG/bin/gh"
  cfm() { env PATH="$MG/bin:$PATH" CLAUDE_FLEET_DIR="$MG/fleet" CLAUDE_FLEET_MERGED_TTL=0 \
          "$ROOT/bin/fleet-merged" "$@" "$MG/repo" 2>/dev/null; }
  rm -f "$MG/GH_RAN"
  is "--cached still answers with a stale cache" "3" "$(cfm --cached --prs | grep -c . || true)"
  is "...without calling gh"                     "no" "$([ -f "$MG/GH_RAN" ] && echo yes || echo no)"
  cfm --prs >/dev/null
  is "...and the fresh path DOES call it"        "yes" "$([ -f "$MG/GH_RAN" ] && echo yes || echo no)"
  is "...leaving the cache undamaged"            "3" "$(fm --prs | grep -c . || true)"
  is "...and no lock behind it"                  "0" "$(find "$MG/fleet" -name '*.lock' 2>/dev/null | grep -c . || true)"
  # 4. no cache at all is the cold-start case a card must survive: nothing, exit 0.
  rm -f "$MG/fleet/prs.acme_widget"
  is "no cache: --cached prints nothing"   ""  "$(cfm --cached --prs)"
  is "...and still exits 0"               "0" "$(cfm --cached --prs >/dev/null; echo $?)"
  is "...and never called gh for it"      "no" "$(rm -f "$MG/GH_RAN"; cfm --cached --prs >/dev/null; [ -f "$MG/GH_RAN" ] && echo yes || echo no)"
  # 5. no gh on PATH AT ALL is the other cold case — the one the header promises about.
  is "no gh: --cached is still fine"      "0" \
     "$(env -i PATH=/usr/bin:/bin HOME="$HOME" CLAUDE_FLEET_DIR="$MG/fleet" \
        "$ROOT/bin/fleet-merged" --cached --prs "$MG/repo" >/dev/null 2>&1; echo $?)"
  rm -rf "$MG"
else
  skip "fleet-merged numbers" "git missing"
fi

# ── 4d10c. the number on the card, and the one it must NOT put there ─────────
# FOUND ON THE LIVE FLEET, an hour after the feature worked. The lead's card sits on `main`
# and came back as #1, because the very first PR in this repo was opened FROM main INTO
# main — so the grid labelled the lead with a stranger's four-year-old PR. A session on the
# default branch has no PR of its own by construction, and any row keyed on that branch is a
# fork's PR or somebody's early mistake.
#   Driven through the REAL grid rather than through a unit of it: the rule lives in
# prNumbers(), which reads fleet-merged's cache and asks git for the default branch, and a
# test of either half separately would not have caught this. Both directions in one fixture —
# the same cache holds a row for `main` AND one for the feature branch, so "it dropped the
# right one" is the assertion rather than "it dropped something".
group "the card carries the PR number, and not the default branch's"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  PC="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$PC/fleet"
  git init -q -b main "$PC/repo" 2>/dev/null
  git -C "$PC/repo" config user.email t@t; git -C "$PC/repo" config user.name t
  : > "$PC/repo/f"; git -C "$PC/repo" add -A; git -C "$PC/repo" commit -qm i 2>/dev/null
  git -C "$PC/repo" remote add origin git@github.com:acme/widget.git 2>/dev/null
  # The local ref the rule reads. Set by hand because `git clone` is what normally writes
  # it and there is no clone here — and its ABSENCE is covered by the fallback rows below.
  git -C "$PC/repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main 2>/dev/null
  git -C "$PC/repo" worktree add -q "$PC/repo/.worktrees/feat" -b feat/thing 2>/dev/null
  # main HAS a row in the cache, and that is the point: the rule has to drop it while
  # keeping the feature branch beside it.
  printf 'main\x1f1\x1fMERGED\nfeat/thing\x1f1184\x1fOPEN\n' > "$PC/fleet/prs.acme_widget"
  tmux -L cfprnum kill-server 2>/dev/null
  tmux -L cfprnum new-session -d -s master -c "$PC/repo" 'sleep 60' 2>/dev/null
  tmux -L cfprnum new-session -d -s feat -c "$PC/repo/.worktrees/feat" 'sleep 60' 2>/dev/null
  sleep 0.8
  PJ="$PC/out.json"
  env -u TMUX CLAUDE_FLEET_DIR="$PC/fleet" CLAUDE_FLEET_ROOT="$PC/repo" CLAUDE_FLEET_SCOPE=pn \
    node "$ROOT/bin/fleet-grid.mjs" cfprnum --json > "$PJ" 2>/dev/null
  PQ() { node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const c=o.cards.find(c=>c.name===process.argv[2]);
    console.log(c===undefined?"(no card)":JSON.stringify(c.pr));
  ' "$PJ" "$1"; }
  is "the feature branch gets its number"   '"1184"' "$(PQ feat)"
  is "...and the default branch does NOT"   "null"   "$(PQ master)"
  # ...and the card DRAWS it, which is a different claim from the wire carrying it.
  is "...and the card shows it"             "1" \
     "$(node -e '
        const fs=require("fs");
        import(process.argv[2]).then(g=>{
          const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          const c=o.cards.find(c=>c.name==="feat");
          console.log(g.cardLines(c,false,0).lines[2].includes("#1184")?1:0);
        });
     ' "$PJ" "$ROOT/web/grid.js" 2>/dev/null)"
  # THE FALLBACK, with origin/HEAD deleted: `main` must still be dropped, or a repo that was
  # never cloned (every repo made by `git init`, including this one before the line above)
  # puts a stranger's PR on its lead card.
  git -C "$PC/repo" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null
  env -u TMUX CLAUDE_FLEET_DIR="$PC/fleet" CLAUDE_FLEET_ROOT="$PC/repo" CLAUDE_FLEET_SCOPE=pn \
    node "$ROOT/bin/fleet-grid.mjs" cfprnum --json > "$PJ" 2>/dev/null
  is "with no origin/HEAD, main is still dropped" "null"   "$(PQ master)"
  is "...and the feature branch is untouched"     '"1184"' "$(PQ feat)"
  # AND THE COLD CASE: no cache at all is what a fresh machine, a private repo or a missing
  # gh all look like, and the answer must be a card with no number rather than a hole.
  rm -f "$PC/fleet/prs.acme_widget"
  env -u TMUX CLAUDE_FLEET_DIR="$PC/fleet" CLAUDE_FLEET_ROOT="$PC/repo" CLAUDE_FLEET_SCOPE=pn \
    node "$ROOT/bin/fleet-grid.mjs" cfprnum --json > "$PJ" 2>/dev/null
  is "no cache: the number is null, not missing" "null" "$(PQ feat)"
  is "...and the card still has its key"         "0" \
     "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
                 console.log(o.cards.filter(c=>!("pr" in c)).length)' "$PJ")"
  tmux -L cfprnum kill-server 2>/dev/null; rm -rf "$PC"
else
  skip "the card carries the PR number" "git, tmux or node missing"
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
  printf 'feat/shipped\x1f77\x1fMERGED\n' > "$RC/fleet/prs.acme_widget"   # seed, so no gh call
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

# ── the grid must not lose a session creation in silence ────────────────────
# Pressed `n` in a project, came back to a fleet holding only master and its tabs, and
# nothing anywhere said why. Both grid_loop branches ran a bare `TM new-session` whose
# result was never tested and then an attach that swallowed its own failure — so the
# create and the report of the create were both absent. This is #70's fleet-spawn bug
# living on in the keyboard path, while bin/fleet-companion refused loudly on the same
# operation from the CLI.
#
# DRIVEN, NOT GREPPED, and the failing direction is the whole point: a check that only
# runs on the happy path is the thing being replaced.
group "the grid refuses a session that did not start"
if command -v tmux >/dev/null 2>&1; then
  NS="$(mktemp -d)"; mkdir -p "$NS/bin" "$NS/empty" "$NS/repo" "$NS/home/.claude/fleet"
  # The helper, alone, out of the real file — the branches call it and nothing else
  # decides whether a create worked. Extracted rather than reimplemented, so this cannot
  # pass against a copy that has drifted from the one that ships.
  sed -n '/^_new_session()/,/^}/p' "$ROOT/bin/ghostfleet" > "$NS/helper.sh"
  is "the helper was found in bin/ghostfleet" "1" "$(grep -c '^_new_session()' "$NS/helper.sh" || true)"
  cat > "$NS/drive.sh" <<DRV
#!/usr/bin/env bash
set -uo pipefail
SOCK="\$1"; CFG_DIR="$NS/home/.claude"
TM() { tmux -L "\$SOCK" "\$@"; }
$(cat "$NS/helper.sh")
_new_session "\$2" "$NS/repo" "" "\$3" && echo OK || echo FAILED
DRV
  chmod +x "$NS/drive.sh"
  # TMUX STAYS ON PATH IN EVERY CASE BELOW, and that is not incidental. The first cut of
  # this group ran the failing cases with PATH="$NS/bin:/usr/bin:/bin", which drops
  # Homebrew's bin — so `tmux` itself was not found, the helper got an empty id, and
  # "a session that dies is reported FAILED" passed because the test could not run tmux
  # at all. It stayed green with the check deleted. Measured, not assumed: tmux answers
  # rc=0 with a real id in BOTH failure shapes below, so nothing here is caught by the
  # exit status and a test that thinks it is proves nothing.
  TMUXBIN="$(dirname "$(command -v tmux)")"
  # ── the direction that must WORK: agent-here on PATH, session survives
  printf '#!/bin/sh\nexec sleep 120\n' > "$NS/bin/agent-here"; chmod +x "$NS/bin/agent-here"
  tmux -L cfnsok kill-server 2>/dev/null
  got="$(PATH="$NS/bin:$PATH" "$NS/drive.sh" cfnsok live "")"
  is "a session that starts is reported OK" "OK" "$got"
  is "...and it really is on the fleet"     "1" \
     "$(tmux -L cfnsok list-sessions -F '#{session_name}' 2>/dev/null | grep -cx live || true)"
  # ── FAILURE SHAPE 1: agent-here is not on PATH. install.sh never run, or a runtime
  # half-synced. tmux returns 0 and hands back an id, and the session is ALREADY GONE by
  # the time it does — so the id alone says the opposite of the truth.
  rm -f "$NS/bin/agent-here"
  tmux -L cfnsbad kill-server 2>/dev/null
  got="$(PATH="$NS/empty:$TMUXBIN:/usr/bin:/bin" "$NS/drive.sh" cfnsbad doomed "")"
  is "not-on-PATH is reported FAILED" "FAILED" "$got"
  is "...and left nothing behind"     "0" \
     "$(tmux -L cfnsbad list-sessions -F '#{session_name}' 2>/dev/null | grep -cx doomed || true)"
  # ── FAILURE SHAPE 2, AND THE ONE THE SETTLE IS FOR: agent-here exists and exits at
  # once. tmux returns 0, the session is present the instant we look, and it is gone half
  # a second later. Nothing but waiting can tell this from a healthy start — which is why
  # the helper waits instead of polling until present, and why this case is here: with the
  # sleep removed, everything above still passes and only this goes red.
  printf '#!/bin/sh\nexit 1\n' > "$NS/bin/agent-here"; chmod +x "$NS/bin/agent-here"
  tmux -L cfnsdie kill-server 2>/dev/null
  got="$(PATH="$NS/bin:$PATH" "$NS/drive.sh" cfnsdie diesoon "")"
  is "a session that dies a moment later is reported FAILED" "FAILED" "$got"
  # The fresh variant takes the same path, or the two branches drift apart again — which
  # is exactly how one of them ended up checked and the other not.
  printf '#!/bin/sh\nexec sleep 120\n' > "$NS/bin/agent-here"; chmod +x "$NS/bin/agent-here"
  tmux -L cfnsfr kill-server 2>/dev/null
  is "the fresh variant reports OK too" "OK" "$(PATH="$NS/bin:$PATH" "$NS/drive.sh" cfnsfr fresh1 1)"
  is "...and passes CLAUDE_FLEET_FRESH"  "1" \
     "$(tmux -L cfnsfr show-environment -t fresh1 CLAUDE_FLEET_FRESH 2>/dev/null | grep -c '^CLAUDE_FLEET_FRESH=1' || true)"
  # ...and NOT on the plain one, or "fresh" would mean nothing.
  is "...and the plain one does not"     "0" \
     "$(tmux -L cfnsok show-environment -t live CLAUDE_FLEET_FRESH 2>/dev/null | grep -c '^CLAUDE_FLEET_FRESH=1' || true)"
  for s in cfnsok cfnsbad cfnsdie cfnsfr; do tmux -L "$s" kill-server 2>/dev/null; done
  # BOTH BRANCHES GO THROUGH IT, and neither still calls new-session by hand. A branch
  # that kept its own create would pass every assertion above and still lose a failure.
  is "both grid_loop branches call it" "2" \
     "$(grep -c 'if _new_session "\$name" "\$cwd" "\$agent"' "$ROOT/bin/ghostfleet" || true)"
  is "...and neither creates by hand"  "1" \
     "$(grep -c 'TM new-session -d -P -F' "$ROOT/bin/ghostfleet" || true)"
  is "...and a failure is SAID, not swallowed" "2" \
     "$(grep -c '_fail "could not start' "$ROOT/bin/ghostfleet" || true)"
  # The keyboard path and the CLI path have to agree — the CLI already refused loudly and
  # that difference is what made this look like nothing had happened.
  is "fleet-companion still refuses loudly too" "1" \
     "$(grep -c 'fleet-companion: failed to start session' "$ROOT/bin/fleet-companion" || true)"
  rm -rf "$NS"
else
  skip "grid session creation" "tmux missing"
fi

# ── N is advertised where a person looks BEFORE pressing something ──────────
group "the grid says both new-session keys"
hint="$(grep -a 'n new · N parallel' "$ROOT/bin/fleet-grid.mjs" || true)"
is "the footer offers n AND N"       "1" "$(printf '%s' "$hint" | grep -c 'n new · N parallel' || true)"
# The convention it follows, still there — this was added BECAUSE p/P set the precedent.
is "...beside the p/P it copies"     "1" \
   "$([ "$(grep -ac 'p pause · P resume' "$ROOT/bin/fleet-grid.mjs" || true)" -ge 1 ] && echo 1 || echo 0)"
# WIDTH IS THE OTHER HALF, AND IT IS MEASURED ON THE DRAWN PANE. This footer WRAPS rather
# than truncating and nothing sizes the card area against it, so the cost of an entry is a
# wrapped line — and counting characters in the source cannot see that: the string is
# three template chunks joined with `+`, and the first regex written for it captured only
# the first and reported a footer a third of its real length, green.
#   Pinned at two widths so the next entry has to be measured rather than appended on
# faith: CLAUDE.md is full of rows that fit at one width and clip at another.
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  FW="$(mktemp -d)"; mkdir -p "$FW/.claude/fleet" "$FW/repo"
  tmux -L cffoot kill-server 2>/dev/null
  for s in master a b c d e f g; do tmux -L cffoot new-session -d -s "$s" -c "$FW/repo" 'sleep 90' 2>/dev/null; done
  # WAITED FOR, NOT SLEPT THROUGH. A fixed sleep here is a race against node booting and
  # drawing, and this suite runs it on a loaded machine: measured, a 1.5s sleep lost under
  # the full run and reported an EMPTY pane as a 0-line footer — three rows red, including
  # one that had got shorter and should have passed. A capture that has no footer in it is
  # not a measurement of the footer.
  #   ONE BOOT, THEN RESIZES, because the wait must not be a wait for node to START. This
  # killed the server and created a fresh session per width, so a three-row group paid
  # three cold starts of a Node TUI, and on a loaded runner a cold start outruns whatever
  # budget you pick. The tell was that the group came back red with a DIFFERENT row failing
  # on each re-run — whichever boot happened to be the slow one, while the other two passed.
  # A failure that moves inside one group is a timeout being used as an assertion, so
  # raising the budget only moves the edge; the fix is to stop paying for it three times.
  # Resizing re-measures because the grid reads its width fresh on every render (W() is
  # process.stderr.columns) and repaints on a 1.2s timer, so nothing depends on a resize
  # handler, and tmux resize-window does reach a DETACHED session's process (checked with
  # a node loop printing process.stderr.columns: it follows the resize).
  #   WHAT TO WAIT FOR IS NOT "the pane changed". tmux truncates the pane ITSELF the
  # instant the window narrows, so the capture differs 50ms after resize-window and still
  # holds the previous render: measured going 120→104, the capture was already different
  # at 0.05s and still counted the OLD two-line footer until the repaint landed at 1.23s.
  # A change-detector returns there and measures 2 at 104 — green, and wrong. What is
  # actually being waited for is the GRID having written, and tmux keeps that:
  # #{window_activity} advances only on output (a pane running `sleep` holds its stamp
  # still). Read the stamp AFTER the resize and every write it lets past is a later one,
  # and the width a render used is the width at render time. Its resolution is one second,
  # which can only cost an extra repaint, never return early.
  wrote_since() {                  # $1 = an activity stamp; has the grid drawn past it?
    local act
    act="$(tmux -L cffootd display-message -p -t d '#{window_activity}' 2>/dev/null || true)"
    [ -n "$act" ] && [ "$act" -gt "$1" ]
  }
  footer_drawn() {                 # is a footer on the pane at all?
    grep -q '↑↓←→/hjkl move' <<< "$(tmux -L cffootd capture-pane -p -t d 2>/dev/null)"
  }
  draw_at() {                      # $1 = width; leaves the pane up for the caller
    local i=0 at stamp=''
    at="$(tmux -L cffootd display-message -p -t d '#{window_width}' 2>/dev/null || true)"
    if [ -z "$at" ]; then          # the one cold start, and the only long wait in here
      tmux -L cffootd kill-server 2>/dev/null
      tmux -L cffootd new-session -d -s d -x "$1" -y 24 \
        "HOME='$FW' CLAUDE_FLEET_DIR='$FW/.claude/fleet' CLAUDE_FLEET_ROOT='$FW/repo' node '$ROOT/bin/fleet-grid.mjs' cffoot" 2>/dev/null
    elif [ "$at" != "$1" ]; then   # already up: re-measure by resizing, and wait for the
      tmux -L cffootd resize-window -t d -x "$1" -y 24 2>/dev/null   # repaint that follows
      stamp="$(tmux -L cffootd display-message -p -t d '#{window_activity}' 2>/dev/null || echo 0)"
    fi                             # same width as it is already drawn at: nothing to wait for
    while [ "$i" -lt 200 ]; do
      { [ -z "$stamp" ] || wrote_since "$stamp"; } && footer_drawn && return 0
      i=$((i+1)); sleep 0.1
    done
    return 1
  }
  footer_lines() {                 # $1 = width -> rows the footer occupies once drawn
    draw_at "$1" || { echo "the grid never drew at $1"; return; }
    tmux -L cffootd capture-pane -p -t d 2>/dev/null \
      | awk '/↑↓←→\/hjkl move/{f=1} f && NF {n++} END{print n+0}'
  }
  is "the drawn footer is 2 lines at 120" "2" "$(footer_lines 120)"
  is "...and 3 at 104, the cost of the entry" "3" "$(footer_lines 104)"
  # The banner is what a longer footer pushes off, and at 120 it must survive — that is
  # the property the width budget is protecting, rather than the line count itself.
  # It names the width it never drew at too, like the two rows above: a harness that gave
  # up and a footer that really did push the banner off are different bugs, and a bare 0
  # is both of them.
  is "...and the banner is still on screen at 120" "1" \
     "$(draw_at 120 \
        && (tmux -L cffootd capture-pane -p -t d 2>/dev/null | grep -ci 'ghostfleet' || true) \
        || echo 'the grid never drew at 120')"
  tmux -L cffootd kill-server 2>/dev/null; tmux -L cffoot kill-server 2>/dev/null
  rm -rf "$FW"
else
  skip "footer width" "tmux or node missing"
fi
# And the surprising half is said where the checkout is picked: `n` RESUMES, which is what
# made a second session on master's own checkout read as a duplicate of master.
is "the picker says n resumes"   "1" "$(grep -ac "RESUMES that checkout's conversation" "$ROOT/bin/fleet-grid.mjs" || true)"
is "...and names N as the other" "1" "$(grep -ac 'instead for a fresh one' "$ROOT/bin/fleet-grid.mjs" || true)"
is "...and N says it is fresh"   "1" "$(grep -ac 'a FRESH conversation, alongside' "$ROOT/bin/fleet-grid.mjs" || true)"

# ── a second session in one worktree is reachable from MCP ──────────────────
# fleet-companion is the answer to "give me another session here" and had a CLI and no
# tool, so an agent restricted to MCP could not reach it at all. #89 made that worse by
# giving codex and opencode the tools without the orchestrate skill that would have
# mentioned the command.
group "fleet_companion is a tool, and it says what it costs"
is "the tool exists"            "1" "$(grep -c "name: 'fleet_companion'" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
is "...and it is dispatched"    "1" "$(grep -c "case 'fleet_companion':" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
is "...to the command that owns it" "1" "$(grep -c "run('fleet-companion'" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
# THE WARNING IS THE POINT. bin/fleet-companion's header says two sessions in one tree can
# conflict and to keep the companion to questions and reading; the caller of a tool has no
# header to have read, so a description that omits it hands out a footgun.
cdesc="$(node -e '
  const m = await import(process.argv[1]);
  const t = (m.TOOLS || []).find(x => x.name === "fleet_companion");
  console.log(t ? t.description : "");
' "$ROOT/mcp/fleet-dispatch.mjs" 2>/dev/null)"
is "the description warns about the shared tree" "1" "$(printf '%s' "$cdesc" | grep -c 'same worktree\|SAME worktree' || true)"
is "...says there is no locking"                 "1" "$(printf '%s' "$cdesc" | grep -ci 'no locking' || true)"
is "...and what to keep it to"                   "1" "$(printf '%s' "$cdesc" | grep -ci 'questions and reading' || true)"
# ...and points at the tool that DOES isolate, or the warning is a dead end.
is "...and names the isolated alternative"       "1" "$(printf '%s' "$cdesc" | grep -c 'fleet_spawn' || true)"
# The command's own header still carries it, since the tool text is a copy of that promise
# and a copy whose original changed is the drift this pins.
is "the command still warns too" "1" "$(grep -c 'keep the companion to questions/reading' "$ROOT/bin/fleet-companion" || true)"
# The schema takes what the CLI takes and nothing else: a `session` it resolves to a
# worktree, and `project` for another fleet. An argument the schema declares and the
# dispatch drops reaches the command as nothing at all (#38).
is "session reaches the argv"  "1" "$(grep -c 'a.session ? \[String(a.session)\]' "$ROOT/mcp/fleet-dispatch.mjs" || true)"
# EVERY MCP TOOL GETS A TRUE ANSWER FROM THE DAEMON. Until this one, the two sets were the
# same modulo NOT_YET, so bin/fleet-serve's fallback branch really did mean "typo". A tool
# with no phone surface is a THIRD case, and calling it `unknown tool` to a caller holding
# it would be the daemon lying about which kind of no it is. Partitioned, not counted:
# a name has to fall in exactly one bucket, so the next tool is a deliberate choice.
# THE SCRIPT GOES IN A FILE, not in -e. The first cut inlined it in a single-quoted shell
# string that itself contained a single quote — which CLOSED the string mid-program, so
# node was handed a mangled script and the assertion's `got` came back as fragments of its
# own source. Caught by CI rather than by the run before the push, which is the whole
# argument for not inlining a program inside a quote you are also using.
PARTD="$(mktemp -d)"
cat > "$PARTD/part.mjs" <<'PARTEOF'
import fs from 'node:fs';
const root = process.argv[2];
const m = await import(root + '/mcp/fleet-dispatch.mjs');
const src = fs.readFileSync(root + '/bin/fleet-serve.mjs', 'utf8');
const allowed = new Set([...src.matchAll(/^ {2}(fleet_[a-z_]+): *\{ fields:/gm)].map(x => x[1]));
const notyet  = new Set([...src.matchAll(/^ {2}(fleet_[a-z_]+): '/gm)].map(x => x[1]));
if (!allowed.size || !notyet.size) { console.log('PARSED-NOTHING'); process.exit(0); }
const orphan = m.TOOLS.map(t => t.name).filter(n => !allowed.has(n) && !notyet.has(n));
console.log(orphan.join(',') || 'none');
PARTEOF
# ...and it says so when its regexes matched nothing, rather than answering "no orphans"
# to a parse that found no lists at all — which is the same green-for-the-wrong-reason
# this whole group is about.
part="$(node "$PARTD/part.mjs" "$ROOT" 2>/dev/null)"
rm -rf "$PARTD"
is "the daemon's two lists were parsed" "1" "$([ "$part" != PARSED-NOTHING ] && echo 1 || echo 0)"
is "the only unserved MCP tool is the companion" "fleet_companion" "$part"
is "...and the daemon says so, rather than 'unknown'" "1" \
   "$(grep -c 'is an MCP tool, but this daemon does not serve it' "$ROOT/bin/fleet-serve.mjs" || true)"
is "...keeping 'unknown tool' for a real typo"        "1" \
   "$(grep -c "unknown tool ." "$ROOT/bin/fleet-serve.mjs" || true)"

# ...and an agent can actually reach it, which was half the gap: there is no clean tool
# in MCP at all, so a lead had to shell out to a command that was all-or-nothing.
group "reclaim is reachable from MCP"
# The tool list and the argv it builds moved to mcp/fleet-dispatch.mjs when bin/fleet-serve
# needed the same verbs over HTTP — fleet-mcp.mjs is only the stdio transport now. Same
# assertion, same reason: an option that exists in the schema but never reaches the command
# is an option that is silently ignored.
is "fleet_stop takes reclaim"  "1" "$(grep -c "if (a.reclaim) args.push('--reclaim')" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
is "...and it is in the schema" "1" "$(grep -c "reclaim: { type: 'boolean'" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
# and its escalation, which is the phone's `f = remove anyway` (docs/mobile.md §7). TWO
# tools carry it — fleet_stop for a worktree that still has a session, fleet_worktree_
# remove for a free one — and both hand it to fleet-clean, which owns the rule about which
# gates a force may skip.
is "...and force reaches both tools" "2" "$(grep -c "if (a.force) args.push('--force')" "$ROOT/mcp/fleet-dispatch.mjs" || true)"
is "...refused without reclaim" "1" "$(grep -c 'force needs reclaim' "$ROOT/mcp/fleet-dispatch.mjs" || true)"

# ...and NOT on the lead, from the other caller. plan() is shared, so the daemon group
# below already drives this over HTTP — but an agent reaches it through callTool(), and MCP's
# error channel is a result flagged isError. A refusal that comes back as ordinary output
# renders in the lead's own transcript as a green call, which is the failure fail() exists
# for. Driven, not grepped: plan() refuses before exec, so none of these run a command.
group "the lead cannot be stopped from MCP either"
if command -v node >/dev/null 2>&1; then
  LD="$(cd "$(mktemp -d)" && pwd -P)"
  # A socket no server answers on and a throwaway fleet dir, so the one call that IS
  # allowed through can reach bin/fleet-stop without anything real to stop.
  mcpcall() { env -u TMUX -u CLAUDE_FLEET_SLOT CLAUDE_FLEET_SOCK=cf-nosuch CLAUDE_FLEET_DIR="$LD" \
    node -e 'import(process.argv[1]).then(d => {
      const r = d.callTool(process.argv[2], JSON.parse(process.argv[3]));
      process.stdout.write(typeof r === "string" ? "RAN " + r : "REFUSED " + r.text);
    })' "$ROOT/mcp/fleet-dispatch.mjs" "$1" "$2" 2>&1; }
  is "stopping the lead is an isError"  "1" \
     "$(mcpcall fleet_stop '{"session":"master"}' | grep -c "^REFUSED .*the fleet's lead" || true)"
  is "...and so is reclaiming it"       "1" \
     "$(mcpcall fleet_stop '{"session":"master","reclaim":true}' | grep -c "^REFUSED .*the fleet's lead" || true)"
  is "...and renaming it"               "1" \
     "$(mcpcall fleet_rename '{"session":"master","new_name":"lead"}' | grep -c "^REFUSED .*the fleet's lead" || true)"
  # THE OTHER DIRECTION: a guard that refused every stop would pass all three. This one
  # reaches bin/fleet-stop, which finds nothing to stop on a socket no server answers on
  # and says so — its "no live session" line goes to stderr, so what comes back is the
  # state-clearing line it prints on the way out.
  is "a worker still reaches the command" "1" \
     "$(mcpcall fleet_stop '{"session":"w-one"}' | grep -c "cleared 'w-one' state" || true)"
  is "...and was not refused here"        "0" \
     "$(mcpcall fleet_stop '{"session":"w-one"}' | grep -c '^REFUSED' || true)"
  # ...and a name that CONTAINS the lead's is an ordinary worker. Not hypothetical: the
  # worktree this landed from is called `master-card`, and a prefix or substring match here
  # would refuse to stop it.
  is "a name containing it is a worker"   "1" \
     "$(mcpcall fleet_stop '{"session":"master-card"}' | grep -c "cleared 'master-card' state" || true)"
  # PARK is refused and RESUME is not, which is the asymmetry: you can always turn the lead
  # back on, never off. Both are checked, because an untested asymmetry is one that gets
  # tidied into symmetry by the next reader.
  is "parking the lead is an isError"     "1" \
     "$(mcpcall fleet_pause '{"session":"master"}' | grep -c "^REFUSED .*the fleet's lead" || true)"
  is "...but resuming it is not"          "0" \
     "$(mcpcall fleet_resume '{"session":"master"}' | grep -c '^REFUSED' || true)"
  # It reached exec rather than being turned back by plan(): `RAN` is what the executor
  # returns, and fleet-resume's own "no session" line goes to stderr, so stdout is empty —
  # which is why this asserts the disposition and not the text.
  is "...and reaches the command"         "1" \
     "$(mcpcall fleet_resume '{"session":"master"}' | grep -c '^RAN' || true)"
  rm -rf "$LD"
else
  skip "the lead from MCP" "node missing"
fi

# ── 4d12. --json: the contract the phone renders from ────────────────────────
# `--plain` is formatted FOR A TERMINAL and cannot be parsed. In the fixture below the
# branch elides to `feat/rate-limit-beside-fo…`, the message is clipped at 44 columns,
# and STATUS runs straight into LAST MSG with no separator — `interruptedwas mid-turn`
# — which on a real fleet reads `people-dupespeople-dupes`. The VALUES are whole:
# cardLines() computes the full branch, the full message and the exact idle seconds and
# only truncates on the way to the screen. `--json` emits them before that happens
# (docs/mobile.md §4).
#
# This is a CONTRACT, not a convenience. fleet-serve and the PWA render from it, and §3
# turns entirely on there being ONE producer of "what is this session doing" — a second
# implementation would drift from the grid's, and the grid's is the one with the scars.
# So the two surfaces are asserted to AGREE on the same fixture, and each of the doc's
# three invariants is checked in BOTH directions, because each is a way the summary can
# lie while every field is present and plausible:
#
#   1. all nine statuses survive, uncollapsed
#   2. `unknown` is not `idle` — it means the agent's adapter has no validated busy
#      detector and we genuinely cannot tell; a green dot it has not earned is the exact
#      failure this whole layer exists to prevent
#   3. `limit` is never folded into `ready` — five workers at a usage ceiling reported as
#      "5 ready" is the summary lying at the one glance you would act on
#
# A one-direction version of any of these passes for an emitter that hardcodes the
# answer, which is why every status below is driven through a REAL pane on a real
# socket rather than asserted from the shape of the source.
group "--json: the §4 schema"
if command -v tmux >/dev/null 2>&1; then
  JS="$(cd "$(mktemp -d)" && pwd -P)"
  node -e '
    const fs=require("fs"),path=require("path");
    const JS=process.argv[1], SOCK=process.argv[2], FIX=process.argv[3];
    const F=path.join(JS,"fleet"); fs.mkdirSync(F,{recursive:true});
    fs.mkdirSync(path.join(JS,"panes"),{recursive:true});
    // The panes are verbatim captures: limit and interrupted are both conjunctions over
    // real text (a usage figure >= 100%, a marker at exactly two columns), so a
    // hand-written pane would exercise neither.
    for(const [as,f] of [["busy","claude-busy.txt"],["idle","claude-idle.txt"],
                         ["limit","claude-limit-hit.txt"],["cut","claude-interrupted.txt"]])
      fs.copyFileSync(path.join(FIX,f),path.join(JS,"panes",as+".txt"));
    const now=Math.floor(Date.now()/1000);
    const A=t=>JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:t}]}});
    const U=JSON.stringify({type:"user",message:{role:"user",content:"ok"}});
    // Ages are pinned 2h back, which is what makes `age` assertable at all: --plain
    // renders that as "2h0m ago" while --json must report the seconds, and a fixture
    // whose age was "a few seconds" could not tell the two apart.
    const mk=(slot,o,lines,ageS)=>{
      let tr="";
      if(lines){ tr=path.join(JS,slot+".jsonl"); fs.writeFileSync(tr,lines.join("\n")+"\n");
                 const t=now-(ageS==null?7205:ageS); fs.utimesSync(tr,t,t); }
      fs.writeFileSync(path.join(F,slot+".json"),JSON.stringify(
        Object.assign({sock:SOCK,slot,cwd:path.join(JS,"wt",slot),folder:slot,
                       branch:"main",transcript:tr,ts:now-7205},o)));
    };
    mk("w-working",   {status:"working"}, [A("busy right now")]);
    mk("w-ready",     {status:"ready"},   [A("Done. Draft PR #1165 is up for review.")]);
    mk("w-idle",      {status:"idle"},    null);          // no history at all = brand new
    mk("w-limit",     {status:"ready"},   [A("ran out of room")]);
    mk("w-interrupt", {status:"ready"},   [A("was mid-turn")]);
    mk("w-parked",    {status:"ready"},   [A("parked on purpose")]);
    // A need-you that must SURVIVE: Claude spoke last and the flag is newer than the
    // transcript, so neither staleness rule clears it.
    mk("w-needyou",   {status:"need-you",ts:now-60}, [U,A("Which branch should I cut from?")], 3600);
    // A hook status the vocabulary does not know, and it has to be: with no busy
    // detector, deriveStatus TRUSTS a pushed working/ready/idle, so a fixture whose hook
    // said "ready" would come back ready and never exercise `unknown` at all.
    mk("w-unknown",   {status:"?"},       [A("cannot tell")]);
    // The long values are the whole reason --json exists: both are elided by --plain.
    mk("w-long",      {status:"ready",branch:"feat/rate-limit-beside-form-and-a-very-long-tail"},
                      [A("All three states present. Running the full suite before I push, then I will open the PR.")]);
    fs.writeFileSync(path.join(F,SOCK+".w-parked.parked"),"");
    // An agent with no adapter entry, so it has no validated busy detector -> unknown.
    fs.writeFileSync(path.join(F,SOCK+".w-unknown.agent"),"gemini\n");
    fs.writeFileSync(path.join(F,SOCK+".w-long.label"),"PR 1184 retry work\n");
    // A real scheduled prompt, plus the pid the marker carries and the wire must not.
    fs.writeFileSync(path.join(F,SOCK+".w-ready.sched"),JSON.stringify(
      {at:now+3600,msg:"pick the review back up and push if the suite is green",pid:4242}));
    // ...and one far longer than the 28 columns a card draws. The scheduled text is the
    // only user-authored field of arbitrary length in the schema, so the emitter must not
    // be what shortens it: clipping here would be a display decision taken in the wrong
    // layer, and it would be invisible, because a truncated prompt still reads as one.
    fs.writeFileSync(path.join(F,SOCK+".w-long.sched"),JSON.stringify(
      {at:now+7200,msg:"rebase onto main, ".repeat(40)+"then open the PR",pid:4243}));
    // w-fresh gets NO status file and no transcript, on purpose: it is the only way to
    // reach `age: null`. Every other session here carries a hook timestamp, and
    // ageBase falls back to it — so a fixture where they all do would never test the
    // null the schema promises, and a client that assumed a number would break on the
    // first genuinely new session it met.
    fs.mkdirSync(path.join(JS,"wt","w-fresh"),{recursive:true});
  ' "$JS" cfjsn "$FIX"
  tmux -L cfjsn kill-server 2>/dev/null
  for s in w-working w-ready w-idle w-limit w-interrupt w-parked w-needyou w-unknown w-long w-fresh; do
    case "$s" in
      w-working)   jp=busy  ;;
      w-limit)     jp=limit ;;
      w-interrupt) jp=cut   ;;
      *)           jp=idle  ;;
    esac
    mkdir -p "$JS/wt/$s"
    # 200 columns: Claude drops its own 5h usage figure from a pane under ~100, and the
    # limit signal is a conjunction that needs it. A narrow fixture would fail CLOSED
    # and this group would silently stop testing `limit` at all.
    tmux -L cfjsn new-session -d -s "$s" -c "$JS/wt/$s" -x 200 -y 40 \
      "cat '$JS/panes/$jp.txt'; sleep 300" 2>/dev/null
  done
  sleep 1
  # CLAUDE_CONFIG_DIR at a path that does not exist, so newestTranscript() cannot reach
  # a real conversation for the one session that deliberately has no history.
  # CLAUDE_FLEET_ROOT empty so free_worktrees is [] here; it has its own group below.
  # SCOPE AND PROFILE ARE SET EXPLICITLY, not inherited. Both are exported by every
  # live fleet session, so a suite run from inside one would assert `project` against
  # whatever project it happened to be launched from and pass for the wrong reason —
  # the same "it passed because of where it ran" trap as the codex ready pattern.
  jgrid() { env -u TMUX CLAUDE_FLEET_DIR="$JS/fleet" CLAUDE_FLEET_ROOT= CLAUDE_CONFIG_DIR="$JS/cfg" \
            CLAUDE_FLEET_SCOPE=demoproj CLAUDE_FLEET_PROFILE=work \
            node "$ROOT/bin/fleet-grid.mjs" cfjsn "$@" 2>/dev/null; }
  jgrid --json > "$JS/out.json"; jrc=$?
  jgrid --plain > "$JS/out.plain"
  # An expression over the parsed object. Objects/arrays come back as JSON so a shape
  # can be asserted whole; undefined comes back empty, which is how a MISSING key is
  # told apart from a null one below.
  J() { node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const v=new Function("o","return ("+process.argv[2]+")")(o);
    console.log(v===undefined?"":(v!==null&&typeof v==="object")?JSON.stringify(v):String(v));
  ' "$JS/out.json" "$1"; }
  C() { J "o.cards.find(c=>c.name===\"$1\").$2"; }

  # ── it is machine-readable at all ──────────────────────────────────────────
  is "exits 0"                        "0" "$jrc"
  # stdout is the channel bin/ghostfleet reads the chosen action off, so ONE line and
  # nothing else: a stray console.log would leave a consumer with unparseable bytes.
  is "one line of output"             "1" "$(wc -l < "$JS/out.json" | tr -d ' ')"
  # ONE thing, in bytes that cannot carry formatting. This asserted two things at once
  # (the JSON parses AND node exited 0) and captured the answer as `console.log(1)` — a
  # bare number, which util.inspect paints yellow under FORCE_COLOR. The JSON was fine;
  # the probe's answer was $'\033[33m1\033[39m' and the red line read "expected: 1 / got: 1".
  # The exit status is the whole answer, so let it be the answer and let the shell write
  # the byte.
  is "and it parses"                  "1" \
     "$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$JS/out.json" 2>/dev/null && echo 1 || echo 0)"

  # ── the §4 shape, key for key ─────────────────────────────────────────────
  # Two sibling workers (fleet-serve, fleet-pwa) are written against exactly these
  # names, so a rename is a broken client, not a refactor.
  is "top-level keys"    "project profile counts cards free_worktrees" "$(J 'Object.keys(o).join(" ")')"
  is "counts keys"       "need_you working ready parked limit interrupted" "$(J 'Object.keys(o.counts).join(" ")')"
  is "card keys"         "name label status folder branch agent pr msg age attached sched limit_at lead" \
                         "$(J 'Object.keys(o.cards[0]).join(" ")')"
  is "project is the fleet's project" "demoproj" "$(J 'o.project')"
  is "profile is the profile"         "work"     "$(J 'o.profile')"
  # ...and with no scope exported it comes off the socket, cf- stripped — the same
  # derivation the rest of the fleet uses to turn a socket into a project name.
  is "project falls back to the socket" "derived" \
     "$(env -u CLAUDE_FLEET_SCOPE CLAUDE_FLEET_DIR="$JS/fleet" CLAUDE_FLEET_ROOT= \
        CLAUDE_CONFIG_DIR="$JS/cfg" node "$ROOT/bin/fleet-grid.mjs" cf-derived --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).project))')"
  is "every session is a card"        "10"         "$(J 'o.cards.length')"
  # This fixture has no `master` at all, so `lead` must be present and FALSE on all ten:
  # it is a boolean on every card, not a key that turns up only on the one that has it.
  # The lead's own card has its own group below.
  is "no lead on a fleet without one" "0"          "$(J 'o.cards.filter(c=>c.lead).length')"
  is "...and every card says false"   "10"         "$(J 'o.cards.filter(c=>c.lead===false).length')"

  # ── the values are UNTRUNCATED, which is the point ─────────────────────────
  # Both directions: --plain must be shown to elide, or "json carries it whole" would
  # pass just as happily against a fixture short enough that nothing was ever clipped.
  is "plain elides the long branch"  "1" "$(grep -ac 'feat/rate-limit-beside-fo…' "$JS/out.plain" || true)"
  is "json carries it whole"         "feat/rate-limit-beside-form-and-a-very-long-tail" "$(C w-long branch)"
  is "plain clips the long message"  "1" "$(grep -ac 'Running the full …' "$JS/out.plain" || true)"
  is "json carries it whole"         "All three states present. Running the full suite before I push, then I will open the PR." \
                                     "$(C w-long msg)"
  # --plain renders "2h0m ago" — an hour and a minute of resolution thrown away before
  # it reaches the caller. The window is tied to the fixture's 2h pin, so a build that
  # emitted 0, or the rendered string, or the mtime itself, all fail it.
  is "age is seconds, not '2h0m ago'" "true"   "$(J 'o.cards.find(c=>c.name==="w-long").age>=7205&&o.cards.find(c=>c.name==="w-long").age<7260')"
  is "...and a number"                "number" "$(J 'typeof o.cards.find(c=>c.name==="w-long").age')"
  # null, not 0 and not absent: a brand-new session has no last-spoke time at all, and 0
  # would render as "0s ago" — the freshest possible card, which is the opposite claim.
  is "...and null when there is none" "null"   "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-fresh").age)')"
  # branch is '' rather than null when git cannot answer, because that is what the card
  # is handed; pinned so a client knows which falsy value to expect.
  is "an unknown branch is empty"     '""'     "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-fresh").branch)')"
  # `pr` IS PRESENT AND NULL HERE, and both halves are the assertion. There is no gh in this
  # fixture and no cache behind it, which is the commonest real case — no network, a cold
  # cache, a repo with no PRs — and the contract for it is "the key is there, the value is
  # null, the card draws as it did before the field existed". J prints '' for a MISSING key
  # and 'null' for a null one, so this row tells those two apart: an omitted field would
  # read as false in a client exactly like a real null, right up until it did not.
  is "pr is null when nothing can tell" "null" "$(C w-working pr)"
  is "...on every card, never omitted"  "0" \
     "$(J 'o.cards.filter(c=>!("pr" in c)).length')"

  # ── invariant 1: all nine statuses, no collapsing ─────────────────────────
  # The vocabulary comes from the STATUS table the TUI renders from, so dropping or
  # renaming one goes red here rather than on the phone.
  is "the vocabulary is nine values" "idle interrupted limit need-you parked ready starting unknown working" \
     "$(sed -n '/^const STATUS = {/,/^};/p' "$ROOT/bin/fleet-grid.mjs" \
        | grep -aoE "^  '?[a-z-]+'?:" | tr -d " ':" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
  # ...and eight of the nine are driven end to end, each from a real pane or marker.
  # `starting` is the ninth and is deliberately absent: it is the render-time fallback
  # for a status the table does not know (`STATUS[card.status] || STATUS.starting`), and
  # nothing in gather() can produce it. A client must still handle it — the TUI does —
  # but this fixture cannot manufacture one, and a test that pretended to would be
  # asserting against a value the producer cannot emit.
  is "working survives"     "working"     "$(C w-working status)"
  is "ready survives"       "ready"       "$(C w-ready status)"
  is "idle survives"        "idle"        "$(C w-idle status)"
  is "need-you survives"    "need-you"    "$(C w-needyou status)"
  is "parked survives"      "parked"      "$(C w-parked status)"
  is "limit survives"       "limit"       "$(C w-limit status)"
  is "interrupted survives" "interrupted" "$(C w-interrupt status)"
  is "unknown survives"     "unknown"     "$(C w-unknown status)"
  is "eight distinct statuses in one fleet" "8" "$(J 'new Set(o.cards.map(c=>c.status)).size')"
  is "...and w-fresh is idle too"           "idle" "$(C w-fresh status)"
  # ONE producer (§3): the same fixture read through both surfaces must agree session by
  # session, or the phone and the grid can describe the same fleet differently.
  is "json and plain agree on every status" "" \
     "$(node -e '
       const fs=require("fs");
       const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
       const rows=fs.readFileSync(process.argv[2],"utf8").split("\n").slice(2).filter(Boolean);
       const plain=new Map(rows.map(l=>[l.slice(0,12).trim(),l.slice(61,72).trim()]));
       console.log(j.cards.filter(c=>plain.get(c.name)!==c.status)
                          .map(c=>c.name+":"+c.status+"!="+plain.get(c.name)).join(" "));
     ' "$JS/out.json" "$JS/out.plain")"

  # ── invariant 2: `unknown` is not `idle` ──────────────────────────────────
  # gemini has no adapter entry, so there is no validated busy regex and the pane was
  # never actually read. Anything but `unknown` here is a claim the fleet cannot back.
  is "no detector -> unknown"        "unknown" "$(C w-unknown status)"
  is "...not idle"                   "false"   "$(J 'o.cards.find(c=>c.name==="w-unknown").status==="idle"')"
  is "...and not ready either"       "false"   "$(J 'o.cards.find(c=>c.name==="w-unknown").status==="ready"')"
  # THE OTHER DIRECTION. w-unknown and w-idle are showing the SAME idle pane; the only
  # difference is the .agent marker. Without this, a build that answered `unknown` for
  # every session on earth would pass every assertion above.
  is "a claude session on that pane is idle" "idle"  "$(C w-idle status)"
  is "...and one with history is ready"      "ready" "$(C w-ready status)"
  # An unknown card is not silently counted as something we DO know. It has no bucket of
  # its own (the six are the six the TUI header shows), so what must hold is that it
  # lands in none of them: ready counts w-ready and w-long, and nothing else.
  is "unknown is in no counts bucket" "0" \
     "$(J 'Object.values(o.counts).reduce((a,b)=>a+b,0) - o.cards.filter(c=>["need-you","working","ready","parked","limit","interrupted"].includes(c.status)).length')"

  # ── invariant 3: `limit` is never folded into `ready` ─────────────────────
  # A limited session leaves the input box up and matches every ready signal, so this is
  # the one that silently reads as a healthy fleet.
  is "the limited pane is limit"      "limit"   "$(C w-limit status)"
  is "...and carries its reset time"  "10:20pm" "$(C w-limit limit_at)"
  is "...and is counted as limit"     "1"       "$(J 'o.counts.limit')"
  is "...and NOT as ready"            "2"       "$(J 'o.counts.ready')"   # w-ready + w-long only
  is "no card claims both"            "0"       "$(J 'o.cards.filter(c=>c.status==="ready"&&c.limit_at).length')"
  # the other direction: a healthy idle pane must still reach `ready`, and must not
  # borrow a reset time
  is "a healthy session is ready"     "ready"   "$(C w-ready status)"
  is "...with no reset time"          "null"    "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-ready").limit_at)')"
  is "...and limit stays 1"           "1"       "$(J 'o.counts.limit')"
  # interrupted is the same trap wearing a different sign, and is counted apart too
  is "interrupted has its own bucket" "1"       "$(J 'o.counts.interrupted')"

  # ── the nullable fields, present as null rather than absent ───────────────
  # `label` is '' internally and null on the wire, so a client has one test for "is this
  # card titled by a label" instead of two. A MISSING key would read as empty here too,
  # which is why the assertions go through JSON.stringify.
  is "label: null when unlabelled"   "null" "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-ready").label)')"
  is "label: the string when set"    "PR 1184 retry work" "$(C w-long label)"
  is "sched: null when none"         "null" "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-idle").sched)')"
  # The time AND the prompt, and NOT the pid. `@10:30pm` with no way to say what will be
  # sent is half a fact, and on a phone you cannot step into the session and look; the pid
  # names a process on one machine and means nothing to a client that is not on it.
  is "sched: the epoch and the text" "at msg" "$(J 'Object.keys(o.cards.find(c=>c.name==="w-ready").sched).join(" ")')"
  is "sched: at is a number"         "number" "$(J 'typeof o.cards.find(c=>c.name==="w-ready").sched.at')"
  is "sched: msg is the prompt"      "pick the review back up and push if the suite is green" \
                                     "$(J 'o.cards.find(c=>c.name==="w-ready").sched.msg')"
  # Emitted WHOLE. 736 characters against the 28 a card draws, so a clip anywhere in the
  # emitter fails here; the length and the tail together mean a build that clipped at any
  # width, front or back, goes red rather than one that clipped at exactly 28.
  is "sched: a long prompt is whole" "736" "$(J 'o.cards.find(c=>c.name==="w-long").sched.msg.length')"
  is "...far longer than a card"     "true" "$(J 'o.cards.find(c=>c.name==="w-long").sched.msg.length>28')"
  is "...and ends where it should"   "then open the PR" \
                                     "$(J 'o.cards.find(c=>c.name==="w-long").sched.msg.slice(-16)')"
  # And the other surface genuinely cannot carry it: --plain has no column for the
  # scheduled text at all, which is why the phone has to get it from here.
  is "...and --plain carries none of it" "0" "$(grep -ac 'rebase onto main' "$JS/out.plain" || true)"
  is "limit_at: null when healthy"   "null" "$(J 'JSON.stringify(o.cards.find(c=>c.name==="w-idle").limit_at)')"
  is "attached is a boolean"         "boolean" "$(J 'typeof o.cards[0].attached')"
  # Both directions, through a real client: a field that is always false looks identical
  # to one that works, and "(attached)" is what the card draws when it has no message.
  tmux -L cfjsndrv kill-server 2>/dev/null
  tmux -L cfjsndrv new-session -d -x 200 -y 40 "tmux -L cfjsn attach -t w-ready" 2>/dev/null
  sleep 1
  jgrid --json > "$JS/att.json"
  A_() { node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    console.log(String(o.cards.find(c=>c.name===process.argv[2]).attached));
  ' "$JS/att.json" "$1"; }
  is "an attached session reads true"    "true"  "$(A_ w-ready)"
  is "...and its neighbour stays false"  "false" "$(A_ w-idle)"
  tmux -L cfjsndrv kill-server 2>/dev/null
  is "agent is named on every card"  "10"   "$(J 'o.cards.filter(c=>typeof c.agent==="string"&&c.agent).length')"
  is "...including the non-claude one" "gemini" "$(C w-unknown agent)"
  # cwd is NOT on the wire: the card never draws it, and a field the TUI does not render
  # is a field nothing keeps honest. Same for the schedule marker's pid, which lives on
  # disk and must not reach a client that is not on this machine.
  is "no field the card cannot show" "" "$(J 'o.cards.map(c=>Object.keys(c)).flat().filter(k=>k==="cwd"||k==="limitAt").join(" ")')"
  is "no pid anywhere in the payload" "0" "$(grep -ac '\"pid\"' "$JS/out.json" || true)"
  is "...and nothing but at+msg in sched" "" \
     "$(J 'o.cards.filter(c=>c.sched).map(c=>Object.keys(c.sched)).flat().filter(k=>k!=="at"&&k!=="msg").join(" ")')"

  tmux -L cfjsn kill-server 2>/dev/null
  rm -rf "$JS"
else
  skip "--json schema" "tmux missing"
fi

# ── 4d12b. --json: the LEAD's card ───────────────────────────────────────────
# The bug this group exists for, reported after a week of real use: "it's not opening the
# main agent, just the sessions." gather() filtered `master` out of the cards, and --json
# inherited the filter — so the phone could reach every worker and not the one session you
# send work to.
#
# THE FILTER IS RIGHT FOR THE TUI AND WRONG FOR A REMOTE CLIENT, so every assertion here
# is a PAIR: the lead is in --json, and it is still absent from --plain, from --order and
# from the interactive grid. One direction on its own would pass for a build that had
# simply deleted the filter, which would put a redundant card for yourself on the screen
# you are drawing it from — and one direction the other way passes for the bug.
#
# The interactive grid is driven for real, in a tmux pane, and its pane is CAPTURED: a
# `lead` a client can see and the TUI cannot is not something --plain can prove, since
# --plain is a different code path from renderGrid. (Never headlessly — it blocks on the
# tty; CLAUDE.md.)
group "--json: the lead's card"
if command -v tmux >/dev/null 2>&1; then
  JL="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$JL/fleet" "$JL/wt/main" "$JL/wt/w-one" "$JL/wt/w-two"
  node -e '
    const fs=require("fs"),path=require("path");
    const JL=process.argv[1], SOCK=process.argv[2];
    const F=path.join(JL,"fleet");
    const now=Math.floor(Date.now()/1000);
    const A=t=>JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:t}]}});
    const U=JSON.stringify({type:"user",message:{role:"user",content:"ok"}});
    const mk=(slot,o,lines)=>{
      const tr=path.join(JL,slot+".jsonl");
      fs.writeFileSync(tr,lines.join("\n")+"\n");
      fs.utimesSync(tr,now-3600,now-3600);
      fs.writeFileSync(path.join(F,slot+".json"),JSON.stringify(
        Object.assign({sock:SOCK,slot,cwd:path.join(JL,"wt",slot==="master"?"main":slot),
                       folder:slot==="master"?"main":slot,branch:"main",transcript:tr,ts:now-3600},o)));
    };
    // The LEAD is the one blocked on a question, deliberately: it is the case the counts
    // decision turns on, and the one a phone exists to see.
    mk("master", {status:"need-you",ts:now-60}, [U,A("Which branch should I cut the release from?")]);
    mk("w-one",  {status:"ready"},              [A("Done. PR is up.")]);
    mk("w-two",  {status:"ready"},              [A("Rebased and pushed.")]);
    // A card order the TUI would have written: workers only, and w-two before w-one. The
    // lead is not in it and must still come first — merged into applyOrder() it would land
    // at the END, which is the failure mode this pins.
    fs.writeFileSync(path.join(F,SOCK+".order"),"w-two\nw-one\n");
  ' "$JL" cfjld
  tmux -L cfjld kill-server 2>/dev/null
  for s in master w-one w-two; do
    d="$JL/wt/$s"; [ "$s" = master ] && d="$JL/wt/main"
    tmux -L cfjld new-session -d -s "$s" -c "$d" -x 120 -y 40 "cat '$FIX/claude-idle.txt'; sleep 300" 2>/dev/null
  done
  sleep 1
  lgrid() { env -u TMUX CLAUDE_FLEET_DIR="$JL/fleet" CLAUDE_FLEET_ROOT= CLAUDE_CONFIG_DIR="$JL/cfg" \
            CLAUDE_FLEET_SCOPE=leadproj CLAUDE_FLEET_PROFILE=work \
            node "$ROOT/bin/fleet-grid.mjs" cfjld "$@" 2>/dev/null; }
  lgrid --json  > "$JL/out.json"
  lgrid --plain > "$JL/out.plain"
  lgrid --order > "$JL/out.order"
  L() { node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const v=new Function("o","return ("+process.argv[2]+")")(o);
    console.log(v===undefined?"":(v!==null&&typeof v==="object")?JSON.stringify(v):String(v));
  ' "$JL/out.json" "$1"; }

  # ── it is there, and it is FIRST ───────────────────────────────────────────
  is "the lead is a card"              "1"        "$(L 'o.cards.filter(c=>c.name==="master").length')"
  is "...and the first one"            "master"   "$(L 'o.cards[0].name')"
  # The order file names both workers in reverse, so this is not "first because tmux
  # happened to list it first": the workers' own order is honoured behind the lead.
  is "...ahead of the saved order"     "master,w-two,w-one" "$(L 'o.cards.map(c=>c.name).join(",")')"
  is "every session is a card"         "3"        "$(L 'o.cards.length')"

  # ── how it is MARKED, and the client must not need the name ────────────────
  is "the lead is flagged"             "true"     "$(L 'o.cards[0].lead')"
  is "...and it is a boolean"          "boolean"  "$(L 'typeof o.cards[0].lead')"
  # The other direction: a flag that is true everywhere marks nothing.
  is "the workers are not"             "false,false" "$(L 'o.cards.filter(c=>c.name!=="master").map(c=>c.lead).join(",")')"
  is "exactly one lead"                "1"        "$(L 'o.cards.filter(c=>c.lead===true).length')"
  is "lead is on every card"           "3"        "$(L 'o.cards.filter(c=>typeof c.lead==="boolean").length')"

  # ── the lead's own fields are computed, not stubbed ────────────────────────
  # It goes through the same gather() the workers do, so its status comes off the same
  # pane+hook path. A lead pinned to some placeholder status would look identical here
  # until the day you needed it to be right.
  is "the lead's status is derived"    "need-you" "$(L 'o.cards[0].status')"
  is "...its folder is the checkout"   "main"     "$(L 'o.cards[0].folder')"
  is "...and it carries its message"   "Which branch should I cut the release from?" "$(L 'o.cards[0].msg')"

  # ── it COUNTS, because counts is a fold over cards ─────────────────────────
  # A lead blocked on a question is the most important need_you on the fleet; reporting
  # "0 need you" over it would be the summary lying at the one glance you would act on.
  is "the lead is counted"             "1" "$(L 'o.counts.need_you')"
  is "...and the workers still are"    "2" "$(L 'o.counts.ready')"
  # The same fold, done twice — statusCounts() here and web/grid.js's countsFrom() in the
  # client. Excluding the lead from one and not the other is how the header starts lying.
  is "counts == a fold over the cards" "" "$(node -e '
    const fs=require("fs");
    const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const n=s=>o.cards.filter(c=>c.status===s).length;
    const want={need_you:n("need-you"),working:n("working"),ready:n("ready"),
                parked:n("parked"),limit:n("limit"),interrupted:n("interrupted")};
    console.log(Object.keys(want).filter(k=>want[k]!==o.counts[k]).join(" "));
  ' "$JL/out.json")"

  # ── and the surfaces that must NOT have gained it ─────────────────────────
  is "--plain has no lead row"         "0" "$(grep -ac '^master' "$JL/out.plain" || true)"
  is "...but has both workers"         "2" "$(grep -acE '^w-(one|two) ' "$JL/out.plain" || true)"
  # --order IS the fleet's numbering (the digits, 1-9, Ctrl-f <p> <s>, ⇧←→). A lead in it
  # would renumber every worker at the desk.
  is "--order has no lead"             "0" "$(grep -ac '^master$' "$JL/out.order" || true)"
  is "...and still numbers the workers" "w-two
w-one" "$(cat "$JL/out.order")"

  # ── the interactive grid: the real TUI, its real pane ─────────────────────
  # node --check proves it parses, not that it runs, and --plain is a different code path
  # from renderGrid — so this is the only thing that shows what the screen draws.
  tmux -L cfjldui kill-server 2>/dev/null
  tmux -L cfjldui new-session -d -x 100 -y 40 \
    -e CLAUDE_FLEET_DIR="$JL/fleet" -e CLAUDE_FLEET_ROOT= -e CLAUDE_CONFIG_DIR="$JL/cfg" \
    -e CLAUDE_FLEET_SCOPE=leadproj -e CLAUDE_FLEET_PROFILE=work \
    "node '$ROOT/bin/fleet-grid.mjs' cfjld - > '$JL/tui.out' 2>'$JL/tui.err'; sleep 20" 2>/dev/null
  sleep 3
  tui="$(tmux -L cfjldui capture-pane -p 2>/dev/null)"
  # Counted off the card TITLES rather than any line mentioning a name, so the answer does
  # not depend on how many cards this width puts on a row.
  is "the TUI draws both workers"      "2" "$(printf '%s\n' "$tui" | grep -aoE '─ [0-9] w-(one|two) ' | grep -ac . || true)"
  is "...and no card for itself"       "0" "$(printf '%s\n' "$tui" | grep -ac 'master' || true)"
  # THE HEADER, WHICH IS THE PAIR TO `counts` ABOVE. --json says need_you 1 because its
  # cards include the lead; the TUI says 0 because its cards do not. One rule — counts are
  # a fold over whatever card list you are drawing — and the two surfaces differ only
  # because their lists do.
  is "...and its header counts no lead" "1" \
     "$(printf '%s\n' "$tui" | grep -ac '0 need you · 0 working · 2 ready' || true)"
  # + new session survives — a card list that lost it would be a different bug wearing
  # this one's clothes.
  is "...+ new session is still there" "1" "$(printf '%s\n' "$tui" | grep -ac '+ new session' || true)"
  is "...and it did not crash"         "0" "$(printf '%s\n' "$tui" | grep -acE 'ReferenceError|TypeError|is not defined' || true)"
  tmux -L cfjldui kill-server 2>/dev/null

  tmux -L cfjld kill-server 2>/dev/null
  rm -rf "$JL"
else
  skip "--json the lead" "tmux missing"
fi

# free_worktrees is the one field that comes from git rather than from a pane, and the
# grey FREE cards are what the phone taps to reuse a checkout. Three ways it can be
# wrong, all silent: the main checkout offered as reusable (it is master's slot), a
# worktree with a live session offered as free (you would spawn a second session on
# top of one that is working), and the manifest task lost so the card cannot say what
# the tree was spun up for.
group "--json: free_worktrees"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  JW="$(cd "$(mktemp -d)" && pwd -P)"
  git init -q -b main "$JW/proj" 2>/dev/null
  git -C "$JW/proj" config user.email t@t; git -C "$JW/proj" config user.name t
  : > "$JW/proj/f"; git -C "$JW/proj" add -A; git -C "$JW/proj" commit -qm init 2>/dev/null
  git -C "$JW/proj" worktree add -q "$JW/proj-2" -b feat/x 2>/dev/null
  git -C "$JW/proj" worktree add -q "$JW/proj-3" -b feat/y 2>/dev/null
  mkdir -p "$JW/fleet"
  printf '%s\t-\t-\tteach the phone to read the grid\n' "$JW/proj-2" > "$JW/fleet/cfjsw.manifest.tsv"
  tmux -L cfjsw kill-server 2>/dev/null
  tmux -L cfjsw new-session -d -s master -c "$JW/proj"   'sleep 300' 2>/dev/null
  tmux -L cfjsw new-session -d -s proj-3 -c "$JW/proj-3" 'sleep 300' 2>/dev/null
  sleep 0.6
  jw="$(CLAUDE_FLEET_DIR="$JW/fleet" CLAUDE_FLEET_ROOT="$JW" CLAUDE_FLEET_SCOPE=proj \
        CLAUDE_CONFIG_DIR="$JW/cfg" node "$ROOT/bin/fleet-grid.mjs" cfjsw --json 2>/dev/null)"
  JW_() { printf '%s' "$jw" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const o=JSON.parse(s); const v=new Function("o","return ("+process.argv[1]+")")(o);
      console.log(v===undefined?"":(v!==null&&typeof v==="object")?JSON.stringify(v):String(v));});
  ' "$1"; }
  is "the sessionless worktree is free" "1"      "$(JW_ 'o.free_worktrees.length')"
  is "...by absolute path"              "proj-2" "$(JW_ 'require("path").basename(o.free_worktrees[0].path)')"
  is "...with its branch"               "feat/x" "$(JW_ 'o.free_worktrees[0].branch')"
  is "...and what it was spun up for"   "teach the phone to read the grid" "$(JW_ 'o.free_worktrees[0].task')"
  # `removing` joined this row when the removal became asynchronous: a worktree whose files
  # are being deleted must not read as free to ANY client, and this wire format is what the
  # phone renders from. Pinned as the whole key set on purpose — that is what caught the
  # addition and made it a decision instead of a drift.
  is "free_worktrees keys"              "path branch task removing" "$(JW_ 'Object.keys(o.free_worktrees[0]).join(" ")')"
  # Single quotes around the NAME, not double: backticks inside a double-quoted string are
  # command substitution, so the shell ran `removing` on every suite invocation, printed
  # "command not found" into the log, and rendered this assertion's name with a hole where
  # the word should be. It passed the whole time, which is why it survived — the failure
  # was in the label, and nobody reads a label that is green.
  is '...and `removing` is a boolean'   "boolean" "$(JW_ 'typeof o.free_worktrees[0].removing')"
  is "...false when nothing is going on" "false"  "$(JW_ 'String(o.free_worktrees[0].removing)')"
  # both directions: the two trees that must NOT be offered
  is "the main checkout is not free"    "0" "$(JW_ 'o.free_worktrees.filter(w=>w.path.endsWith("/proj")).length')"
  is "an occupied worktree is not free" "0" "$(JW_ 'o.free_worktrees.filter(w=>w.path.endsWith("/proj-3")).length')"
  is "...it is a card instead"          "1" "$(JW_ 'o.cards.filter(c=>c.name==="proj-3").length')"
  # THE LEAD IS A CARD, and this assertion used to say the opposite — it encoded the bug.
  # `proj` is master's home, so the two lists have to disagree about it on purpose: off
  # free_worktrees because a session is standing in it, and ON cards because that session
  # is the one the phone came for (docs/mobile.md §4). The TUI still draws neither.
  is "the lead IS a card"               "1"      "$(JW_ 'o.cards.filter(c=>c.name==="master").length')"
  is "...and it is first"               "master" "$(JW_ 'o.cards[0].name')"
  is "...flagged as the lead"           "true"   "$(JW_ 'o.cards[0].lead')"
  is "...while the worker is not"       "false"  "$(JW_ 'o.cards.find(c=>c.name==="proj-3").lead')"
  is "...and its checkout is still not free" "0" "$(JW_ 'o.free_worktrees.filter(w=>w.path.endsWith("/proj")).length')"
  tmux -L cfjsw kill-server 2>/dev/null
  rm -rf "$JW"
else
  skip "--json free_worktrees" "git or tmux missing"
fi

# A card's `msg` is a whole assistant turn, bounded only by the 64KB tail read the
# transcript gets — and nothing bounds the SUM across cards. So a few verbose workers
# push this payload past the 64KB pipe buffer, and process.exit() DISCARDS a pending
# stdout write, which on macOS a pipe always is. Measured before the fix: 200 000 bytes
# written, 65 536 arriving, the JSON stopping mid-string with no error on either side.
# The reader cannot even tell it was cut — it sees a parse failure and blames the
# producer. --plain is not exposed to it (its message column is clipped to 46 characters,
# so a row is ~126 bytes and it would take 500 sessions to fill the buffer), which is why
# this needs its own case instead of riding along on the group above.
group "--json survives a payload bigger than a pipe buffer"
if command -v tmux >/dev/null 2>&1; then
  JB="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$JB/fleet"
  # Three workers at 30KB of message each. Deliberately not one at 90KB: lastAssistant()
  # only reads the last 64KB of a transcript, so a single oversized turn is unparseable
  # there and comes back EMPTY — which would have made this group pass by producing no
  # payload at all. The sum across cards is the part with no bound.
  node -e '
    const fs=require("fs"),path=require("path");
    const JB=process.argv[1], n=Math.floor(Date.now()/1000);
    const big="verbose ".repeat(3750).trim();     // 29 999 chars, no whitespace runs to collapse
    for(const s of ["h1","h2","h3"]){
      fs.mkdirSync(path.join(JB,"wt",s),{recursive:true});
      const t=path.join(JB,s+".jsonl");
      fs.writeFileSync(t,JSON.stringify({type:"assistant",message:{role:"assistant",
        content:[{type:"text",text:big}]}})+"\n");
      fs.writeFileSync(path.join(JB,"fleet",s+".json"),JSON.stringify(
        {sock:"cfjsb",slot:s,cwd:path.join(JB,"wt",s),folder:s,branch:"main",
         status:"ready",transcript:t,ts:n-60}));
    }
  ' "$JB"
  tmux -L cfjsb kill-server 2>/dev/null
  for s in h1 h2 h3; do
    tmux -L cfjsb new-session -d -s "$s" -c "$JB/wt/$s" -x 200 -y 40 'sleep 300' 2>/dev/null
  done
  sleep 0.8
  # $() is a real pipe, which is the whole point: to a FILE the same code is safe on every
  # platform, so a test that redirected would pass against the truncating version.
  jb="$(CLAUDE_FLEET_DIR="$JB/fleet" CLAUDE_FLEET_ROOT= CLAUDE_CONFIG_DIR="$JB/cfg" \
        CLAUDE_FLEET_SCOPE=big node "$ROOT/bin/fleet-grid.mjs" cfjsb --json 2>/dev/null)"
  jbq() { printf '%s' "$jb" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ console.log(String(new Function("o","return ("+process.argv[1]+")")(JSON.parse(s)))) }
      catch{ console.log("truncated") }});
  ' "$1"; }
  is "more than one pipe buffer of it" "1" "$([ "${#jb}" -gt 65536 ] && echo 1 || echo 0)"
  is "...and it still parses"          "3" "$(jbq 'o.cards.length')"
  is "...with every message whole"     "29999 29999 29999" \
     "$(jbq 'o.cards.map(c=>c.msg.length).join(" ")')"
  tmux -L cfjsb kill-server 2>/dev/null
  rm -rf "$JB"
else
  skip "--json big payload" "tmux missing"
fi

# ── 4d-bis. a card's message is a PREVIEW, so the markdown comes out ─────────
# Reported from a phone: card summaries read literally `**PR #76 is up — both CI l…`. The
# chat renders markdown (web/md.js) and a card cannot — cardLines() builds a 28-column box
# out of strings, and this file and web/grid.js draw it from the SAME strings, which is the
# only thing keeping the two cards identical. So it is stripped where the message is
# PRODUCED, in lastAssistant(), which is one implementation for the TUI, --plain and --json
# alike, and nothing for grid-parity to keep in step.
#   Both directions, and the second is the point: a stripper that returned "" would pass any
# check for absent asterisks. The words have to still be there, in order.
group "a card's message is stripped of markdown, not of meaning"
if command -v tmux >/dev/null 2>&1; then
  MD="$(cd "$(mktemp -d)" && pwd -P)"; mkdir -p "$MD/fleet"
  node -e '
    const fs=require("fs"),path=require("path");
    const MD=process.argv[1], n=Math.floor(Date.now()/1000);
    const say=(t)=>JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:t}]}});
    const cases={
      m1:"**PR #76 is up** — both CI legs green.",
      m2:"Run `./test/run.sh`: 2087 passed / 0 failed.",
      m3:"## Done\n\n- rebased onto `main`\n- see [the design](https://x.test/a)",
    };
    for(const [s,t] of Object.entries(cases)){
      fs.mkdirSync(path.join(MD,"wt",s),{recursive:true});
      const tr=path.join(MD,s+".jsonl");
      fs.writeFileSync(tr,say(t)+"\n");
      fs.writeFileSync(path.join(MD,"fleet",s+".json"),JSON.stringify(
        {sock:"cfmdp",slot:s,cwd:path.join(MD,"wt",s),folder:s,branch:"main",
         status:"ready",transcript:tr,ts:n-60}));
    }
  ' "$MD"
  tmux -L cfmdp kill-server 2>/dev/null
  for s in m1 m2 m3; do
    tmux -L cfmdp new-session -d -s "$s" -c "$MD/wt/$s" -x 200 -y 40 'sleep 300' 2>/dev/null
  done
  sleep 0.8
  mdj="$(CLAUDE_FLEET_DIR="$MD/fleet" CLAUDE_FLEET_ROOT= CLAUDE_CONFIG_DIR="$MD/cfg" \
         CLAUDE_FLEET_SCOPE=mdp node "$ROOT/bin/fleet-grid.mjs" cfmdp --json 2>/dev/null)"
  mdq() { printf '%s' "$mdj" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ console.log(String(new Function("o","return ("+process.argv[1]+")")(JSON.parse(s)))) }
      catch{ console.log("unparseable") }});
  ' "$1"; }
  is "the three cards are there"        "3" "$(mdq 'o.cards.length')"
  M1="$(mdq 'o.cards.find(c=>c.name==="m1").msg')"
  M2="$(mdq 'o.cards.find(c=>c.name==="m2").msg')"
  M3="$(mdq 'o.cards.find(c=>c.name==="m3").msg')"
  # THE WORDS SURVIVE — asserted first, and as whole strings, so an empty result cannot
  # pass by having no asterisks in it.
  is "bold loses its stars, not its words"  "PR #76 is up — both CI legs green." "$M1"
  is "a code span loses its backticks"      "Run ./test/run.sh: 2087 passed / 0 failed." "$M2"
  is "a heading and bullets flatten to one line" "Done rebased onto main see the design" "$M3"
  # ...and nothing that reads as markup is left anywhere in them.
  is "no asterisks reach a card"   "0" "$(printf '%s' "$M1$M2$M3" | grep -c '[*]' || true)"
  is "no backticks reach a card"   "0" "$(printf '%s' "$M1$M2$M3" | grep -c '`' || true)"
  is "no link brackets reach a card" "0" "$(printf '%s' "$M1$M2$M3" | grep -c '](http' || true)"
  tmux -L cfmdp kill-server 2>/dev/null
  rm -rf "$MD"
else
  skip "card message markdown" "tmux missing"
fi

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

# ── fleet-awake says the same thing on both platforms ────────────────────────
# WHY THESE ARE FAKED PROCESS TABLES rather than real inhibitors: the thing under test
# is what --status SAYS about a hold, and a real hold cannot be arranged on every box
# the suite runs on. macOS has no systemd-inhibit at all, and a Linux CI runner has
# systemd-inhibit but no login session, so logind answers `Failed to inhibit: Access
# denied` to every --mode=block arm (measured on ubuntu-latest; see the group further
# down). Testing only against a real hold means testing the Linux branch nowhere — and
# "nowhere" is exactly how it came to print a shape bin/fleet-serve.mjs cannot read,
# on the only platform that branch ever runs on.
#
# So: a stub pgrep/ps pair reading a fake table, on a PATH that contains ONLY what
# --status calls. That last part is what makes the Linux branch reachable from a Mac —
# `command -v caffeinate` has to be able to come back FALSE.
group "fleet-awake --status: one shape on both platforms"
AWD="$(mktemp -d)"; AWBASH="$(command -v bash)"
mkdir -p "$AWD/bin"
for r in sed grep awk cat; do ln -sf "$(command -v $r)" "$AWD/bin/$r" 2>/dev/null; done
cat > "$AWD/bin/pgrep" <<STUB
#!/bin/sh
pat=""
while [ \$# -gt 0 ]; do case "\$1" in -*) ;; *) pat="\$1" ;; esac; shift; done
o="\$(grep -E -- "\$pat" "$AWD/ptable" 2>/dev/null | awk '{print \$1}')"
[ -n "\$o" ] || exit 1
printf '%s\n' "\$o"
STUB
cat > "$AWD/bin/ps" <<STUB
#!/bin/sh
fmt=""; pid=""
while [ \$# -gt 0 ]; do
  case "\$1" in -o) fmt="\$2"; shift ;; -p) pid="\$2"; shift ;; esac; shift
done
case "\$fmt" in comm=) echo node; exit 0 ;; esac
l="\$(grep -E "^\$pid " "$AWD/pstable" 2>/dev/null)"
[ -n "\$l" ] || exit 1
printf '%s\n' "\${l#* }"
STUB
chmod +x "$AWD/bin/pgrep" "$AWD/bin/ps"
# $1 = the table both stubs read ("" = nothing running). pstable defaults to the same.
awtable() { printf '%s\n' "$1" > "$AWD/ptable"; printf '%s\n' "${2-$1}" > "$AWD/pstable"; }
awstatus() { PATH="$AWD/bin" "$AWBASH" "$ROOT/bin/fleet-awake" --status 2>/dev/null; }
# A real, live pid to be the watched one — `kill -0` decides holding vs stale, and a
# fixture pid that happens to be dead would make every "holding" case read as stale.
sleep 45 & AWLIVE=$!

# The macOS branch, as the reference shape. caffeinate present (its own stub is enough
# — only `command -v` is asked).
: > "$AWD/bin/caffeinate"; chmod +x "$AWD/bin/caffeinate"
awtable "8001 caffeinate -i -s -w $AWLIVE"
is "macOS: names the WATCHED pid" "1" "$(awstatus | grep -c "for pid $AWLIVE " || true)"
is "...and the inhibitor pid too"  "1" "$(awstatus | grep -c 'inhibitor pid 8001' || true)"
rm -f "$AWD/bin/caffeinate"

# THE FIX. Same fact, Linux, and until now it printed `holding sleep — systemd-inhibit
# pid 8002`: the inhibitor's pid, never the watched one, never the words "for pid".
awtable "8002 systemd-inhibit --what=sleep --who=ghostfleet --why=awake-$AWLIVE  --mode=block tail --pid=$AWLIVE -f /dev/null"
is "Linux: names the WATCHED pid"  "1" "$(awstatus | grep -c "for pid $AWLIVE " || true)"
is "...not just the inhibitor's"   "1" "$(awstatus | grep -c 'inhibitor pid 8002' || true)"
# The consumer's predicate, spelled the way the consumer spells it. This is the whole
# contract: bin/fleet-serve.mjs keeps `for pid <pid> ` and this line has to satisfy it.
is "...and satisfies fleet-serve's own test" "1" \
   "$(awstatus | awk -v p="for pid $AWLIVE " 'index($0,p){n++} END{print n+0}')"
is "fleet-serve still asks for that string"  "1" \
   "$(grep -c 'includes(`for pid ${process.pid} `)' "$ROOT/bin/fleet-serve.mjs" || true)"
# The direction that makes the three above mean something: a hold for SOMEBODY ELSE
# must not answer to our pid, or the matcher fleet-serve trusts would accept a
# stranger's inhibitor — the precise thing its comment says it exists to refuse.
awtable "8003 systemd-inhibit --what=sleep --who=ghostfleet --why=awake-777777  --mode=block tail --pid=777777 -f /dev/null"
is "a hold for another pid is not ours" "0" "$(awstatus | grep -c "for pid $AWLIVE " || true)"
is "...it is reported as stale"         "1" "$(awstatus | grep -c 'stale inhibitor pid 8003' || true)"

# The mode is readable from the args, both directions — `on` and `display` now pass
# different --what values, so --status has to tell them apart or the split is invisible.
awtable "8004 systemd-inhibit --what=sleep --who=ghostfleet --why=awake-$AWLIVE  --mode=block tail --pid=$AWLIVE -f /dev/null"
is "default reads as sleep only"   "1" "$(awstatus | grep -c "holding sleep for pid $AWLIVE " || true)"
awtable "8005 systemd-inhibit --what=idle:sleep:handle-lid-switch --who=ghostfleet --why=awake-$AWLIVE  --mode=block tail --pid=$AWLIVE -f /dev/null"
is "display reads as sleep + display" "1" "$(awstatus | grep -c "holding sleep + display for pid $AWLIVE " || true)"

# THE SEPARATOR TRAP, in the one place this file could still hit it. `${args##*awake-}`
# on a string with no `awake-` returns the string UNCHANGED, so a `ps` that lost the
# race and printed nothing would put the whole argv in wpid — non-empty, so every
# `[ -n ]` guard sails past it — and report `stale ... watching dead pid <the entire
# command line>`. pgrep sees the row; ps does not.
awtable "8006 systemd-inhibit --what=sleep --why=awake-$AWLIVE  --mode=block tail" ""
is "no args from ps: says it cannot tell" "1" "$(awstatus | grep -c 'cannot tell whose' || true)"
is "...and never invents a dead pid"      "0" "$(awstatus | grep -c 'watching dead pid' || true)"
kill $AWLIVE 2>/dev/null; wait $AWLIVE 2>/dev/null

# ── and when it CANNOT arm one, it has to say so ─────────────────────────────
# The silent no-op this whole group exists to end: on a box where logind refuses, the
# arm path backgrounds systemd-inhibit with stderr discarded and exits 0, so nothing
# anywhere distinguishes "nobody asked" from "the OS said no". Both directions, because
# a message that is always printed is worth as much as one that never is.
group "fleet-awake --status: a refusal is not silence"
awtable ""
cat > "$AWD/bin/systemd-inhibit" <<'STUB'
#!/bin/sh
echo "Failed to inhibit: Access denied" >&2
exit 1
STUB
chmod +x "$AWD/bin/systemd-inhibit"
is "logind refuses: it says so"     "1" "$(awstatus | grep -c 'no inhibitor could be armed' || true)"
is "...and quotes logind's reason"  "1" "$(awstatus | grep -c 'Access denied' || true)"
is "...and never reads as fine"     "0" "$(awstatus | grep -c 'nothing held' || true)"
# The no-session detail, which is the actual cause on a runner and the thing that turns
# "refused" into something you can act on.
cat > "$AWD/bin/loginctl" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$AWD/bin/loginctl"
is "no sessions: names that too" "1" "$(awstatus | grep -c 'no login session' || true)"
cat > "$AWD/bin/loginctl" <<'STUB'
#!/bin/sh
echo "3 runner seat0 tty1"
STUB
chmod +x "$AWD/bin/loginctl"
is "a box WITH a session: not named" "0" "$(awstatus | grep -c 'no login session' || true)"
rm -f "$AWD/bin/loginctl"
# The other direction: an inhibitor that WOULD be granted must not be slandered.
cat > "$AWD/bin/systemd-inhibit" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$AWD/bin/systemd-inhibit"
is "it would be granted: plain nothing held" "1" "$(awstatus | grep -c 'nothing held' || true)"
is "...and no refusal is claimed"            "0" "$(awstatus | grep -c 'could not be armed\|no inhibitor could be armed' || true)"
rm -f "$AWD/bin/systemd-inhibit"

# ── the arm path passes the flags the header table claims ────────────────────
# `on` was arming --what=idle:sleep, and `idle` is what logind blanks the screen on —
# so every Linux box on the default was silently getting macOS's --display behaviour.
# A recording stub, because the assertion is about the argv and nothing else.
group "fleet-awake arms the flags its table claims"
mkdir -p "$AWD/arm"
ln -sf "$(command -v nohup)" "$AWD/bin/nohup" 2>/dev/null
cat > "$AWD/bin/systemd-inhibit" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >> "$AWD/arm/log"
exit 0
STUB
chmod +x "$AWD/bin/systemd-inhibit"
sleep 45 & AWLIVE2=$!
awarm() { : > "$AWD/arm/log"; awtable "${2:-}"
          PATH="$AWD/bin" "$AWBASH" "$ROOT/bin/fleet-awake" $1 "$AWLIVE2" >/dev/null 2>&1
          sleep 0.4; cat "$AWD/arm/log" 2>/dev/null; }
is "default arms --what=sleep"      "1" "$(awarm ''   | grep -c -- '--what=sleep --who' || true)"
is "...and never blanks the screen" "0" "$(awarm ''   | grep -c -- '--what=idle' || true)"
is "-d arms idle and the lid"       "1" "$(awarm '-d' | grep -c -- '--what=idle:sleep:handle-lid-switch' || true)"
is "...and carries the watched pid" "1" "$(awarm ''   | grep -c -- "--why=awake-$AWLIVE2" || true)"
# Dedupe on the FULL flag set, like the caffeinate branch. Keyed on the awake-<pid>
# marker alone, switching modes on a live pid looked like an existing hold and returned
# early — so `--display` on an already-awake fleet silently kept the dark screen. Both
# directions: the same mode must NOT re-arm, a different one MUST.
HELD_SLEEP="9001 systemd-inhibit --what=sleep --who=ghostfleet --why=awake-$AWLIVE2  --mode=block tail --pid=$AWLIVE2 -f /dev/null"
is "same mode already held: no second" "0" "$(awarm ''   "$HELD_SLEEP" | grep -c 'what=' || true)"
is "switching to display DOES re-arm"  "1" "$(awarm '-d' "$HELD_SLEEP" | grep -c -- '--what=idle:sleep:handle-lid-switch' || true)"
kill $AWLIVE2 2>/dev/null; wait $AWLIVE2 2>/dev/null
rm -rf "$AWD"

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

# ── 5z. fleet-serve: the phone's endpoint ────────────────────────────────────
# docs/mobile.md §1 is the reason this group is long: the endpoint is remote code
# execution BY DESIGN — fleet_spawn runs shell commands, fleet_send injects prompts into
# agents running --dangerously-skip-permissions — so every control on it is load-bearing
# and every one of them is asserted in BOTH directions. A guard that refuses everything
# passes the "it refused" half and is useless; a guard that never fires is
# indistinguishable from one that works. Every assertion here was watched going red with
# its protection removed.
#
# Nothing here touches the live fleet: the server runs against a throwaway $HOME whose
# projects file names TWO fake projects, and against a COPY of bin/ whose fleet-* commands
# are stubs that log their argv. The copy is also what exercises the dispatch for real —
# bin/fleet-serve.mjs imports ../mcp/fleet-dispatch.mjs, so the copy's fleet-serve reaches
# the copy's stubs.

group "fleet-serve refuses a bind that is not the tailnet"
# Pure classification, no listener — which is the point: this half has to work on a
# machine where Tailscale has never been installed, because that is exactly the machine
# where somebody reaches for 0.0.0.0 to "just make it work". `--any` drops the
# is-it-on-an-interface check so the tailnet cases are about the RANGE, not this host.
verdict() { "$ROOT/bin/fleet-serve" check-bind "$1" --any 2>&1 | awk '/^bindable/{print $2}'; }
reason()  { "$ROOT/bin/fleet-serve" check-bind "$1" --any 2>&1 | sed -n 's/^  - //p'; }
for a in 0.0.0.0 :: '*' 0; do
  is "wildcard '$a' is refused"            "no"  "$(verdict "$a")"
  is "...and it says it is a wildcard"     "1"   "$(reason "$a" | grep -c wildcard || true)"
done
is "a public address is refused"           "no"  "$(verdict 8.8.8.8)"
is "...naming remote code execution"       "1"   "$(reason 8.8.8.8 | grep -c 'remote code execution' || true)"
is "a LAN address is refused"              "no"  "$(verdict 192.168.1.5)"
is "...and so is 10/8"                     "no"  "$(verdict 10.1.2.3)"
is "...and 172.16/12"                      "no"  "$(verdict 172.20.0.9)"
is "link-local is refused"                 "no"  "$(verdict 169.254.7.7)"
is "a v4-mapped wildcard is refused"       "no"  "$(verdict ::ffff:0.0.0.0)"
is "a v4-mapped public addr is refused"    "no"  "$(verdict ::ffff:8.8.8.8)"
is "an empty bind is refused"              "no"  "$(verdict '')"
# THE OTHER DIRECTION — the two transports docs/mobile.md §5 sanctions must both work, or
# the refusals above are just a broken program. Tailscale gives a 100.64/10 address;
# Cloudflare Tunnel's cloudflared connects to loopback.
is "loopback is allowed"                   "yes" "$(verdict 127.0.0.1)"
is "...including ::1"                      "yes" "$(verdict ::1)"
is "the tailnet CGNAT range is allowed"    "yes" "$(verdict 100.100.100.100)"
is "...and the low end of 100.64/10"       "yes" "$(verdict 100.64.0.1)"
is "...and the high end"                   "yes" "$(verdict 100.127.255.254)"
is "...but 100.128.x is NOT in it"         "no"  "$(verdict 100.128.0.1)"
is "Tailscale's IPv6 prefix is allowed"    "yes" "$(verdict fd7a:115c:a1e0::1)"
is "...but another ULA is not"             "no"  "$(verdict fd00::1)"
# an address in an allowed RANGE still has to exist on this machine
is "a tailnet addr this host lacks fails"  "no"  \
   "$("$ROOT/bin/fleet-serve" check-bind 100.64.99.99 2>&1 | awk '/^bindable/{print $2}')"
is "...and says why"                       "1"   \
   "$("$ROOT/bin/fleet-serve" check-bind 100.64.99.99 2>&1 | grep -c 'not on any interface' || true)"
is "a name is judged by what it resolves to" "yes" "$(verdict localhost)"
# A REFUSAL THAT ARRIVES HALF-WRITTEN IS WORSE THAN NONE, and the whole value of this one
# is the reason plus the candidate list. console.error to a PIPE is asynchronous, so the
# process.exit() on the next line used to be able to drop it; the refusal writes with
# fs.writeSync now. Read through `cat` on purpose, so it is a pipe and not a tty.
bindrefuse="$(cd "$(mktemp -d)" && pwd -P)"
GHOSTFLEET_SERVE_CONFIG="$bindrefuse/c.json" "$ROOT/bin/fleet-serve" init --bind 127.0.0.1 --port 19001 >/dev/null 2>&1
node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));c.bind="0.0.0.0";fs.writeFileSync(p,JSON.stringify(c))' "$bindrefuse/c.json"
refusal="$(GHOSTFLEET_SERVE_CONFIG="$bindrefuse/c.json" TMUX= "$ROOT/bin/fleet-serve" 2>&1 | cat)"
is "a piped refusal keeps its reason"      "1" "$(printf '%s' "$refusal" | grep -c "is a wildcard" || true)"
is "...and its closing candidate list"     "1" "$(printf '%s' "$refusal" | grep -c "addresses this machine has" || true)"
is "...down to the last line of it"        "1" \
   "$([ "$(printf '%s\n' "$refusal" | tail -1 | grep -c '^fleet-serve:   - ' || true)" = 1 ] && echo 1 || echo 0)"
rm -rf "$bindrefuse"

# ── the live daemon ──────────────────────────────────────────────────────────
# A FIXED PORT WOULD BE THE TMUX-SOCKET BUG AGAIN (§0): two worktrees running the suite
# together would fight over it and the second run would lie. Ask the OS for a free one.
# String(p), NOT a bare number: console.log() runs a non-string through util.inspect,
# which colourises under FORCE_COLOR, and a port with $'\033[33m' round it poisons
# EVERYTHING downstream — $BASE becomes a URL curl cannot reach, `init --port` parses NaN
# and writes null, the daemon silently falls back to its built-in 8787 and is abandoned
# there holding the port, and the next group dies EADDRINUSE. Six groups skipped as
# "server did not come up" while the daemon was up the whole time on a port nobody asked
# for. See the unset at the top of this file for the general guard; this is the local one.
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(String(p)))})' 2>/dev/null; }
# Proven at the site, with the variable put BACK: everything below depends on this being a
# number a URL can hold, and the unset at the top of the file is not allowed to be the
# only reason it is. Both directions — digits with colour forced, and a port that actually
# binds — because "" would satisfy a digits-only check by matching nothing.
group "free_port answers in digits, colour or not"
if command -v node >/dev/null 2>&1; then
  fp="$(FORCE_COLOR=3 free_port)"
  is "a forced-colour port is bare digits" "1" "$(printf '%s' "$fp" | grep -cE '^[0-9]+$' || true)"
  is "...and it is a real port number"     "1" "$([ "${fp:-0}" -gt 0 ] 2>/dev/null && echo 1 || echo 0)"
else
  skip "free_port" "node missing"
fi
SERVE_PIDS=""
serve_stop() {
  [ -n "${SERVE_PIDS:-}" ] && kill $SERVE_PIDS 2>/dev/null
  SERVE_PIDS=""
  # Wait for the port to come back, or the next group's listen() races a kill that has not
  # landed yet and dies with EADDRINUSE — which looks exactly like a broken server.
  [ -n "${BASE:-}" ] || return 0
  i=0; while [ "$i" -lt 40 ] && curl -s -m1 "$BASE/healthz" >/dev/null 2>&1; do i=$((i+1)); sleep 0.1; done
  return 0
}

SV=""
if ! command -v node >/dev/null 2>&1; then
  group "fleet-serve (live)"; skip "fleet-serve HTTP" "node missing"
else
# Inside the run's own namespace, not a mktemp of its own: the sweep above finds a leaked
# daemon by the directory in its argv, and a path outside $TMUX_TMPDIR is a path no future
# run can attribute to a dead one.
SV="$TMUX_TMPDIR/serve"; mkdir -p "$SV"
mkdir -p "$SV/home/.config/ghostfleet" "$SV/home/.claude/fleet" "$SV/repo" "$SV/other"
cp -R "$ROOT/bin" "$ROOT/mcp" "$SV/"
: > "$SV/ran"
for c in fleet-list fleet-send fleet-spawn fleet-worktrees fleet-inbox fleet-answer \
         fleet-pause fleet-resume fleet-rename fleet-project; do
  cat > "$SV/bin/$c" <<STUB
#!/bin/sh
printf '%s' "\$(basename "\$0")" >> "$SV/ran"
for a in "\$@"; do printf ' [%s]' "\$a" >> "$SV/ran"; done
printf ' {scope=%s root=%s sock=%s}\n' "\${CLAUDE_FLEET_SCOPE:-}" "\${CLAUDE_FLEET_ROOT:-}" "\${CLAUDE_FLEET_SOCK:-}" >> "$SV/ran"
echo "STUB \$(basename "\$0") ok"
STUB
  chmod +x "$SV/bin/$c"
done
# fleet-stop and fleet-clean have to behave like the real ones at the point that matters:
# a gated removal that DECLINES, printing the line the force step keys off, and a forced
# one that goes through.
cat > "$SV/bin/fleet-stop" <<STUB
#!/bin/sh
printf 'fleet-stop' >> "$SV/ran"
for a in "\$@"; do printf ' [%s]' "\$a" >> "$SV/ran"; done
printf '\n' >> "$SV/ran"
rec=0; frc=0
for a in "\$@"; do case "\$a" in --reclaim) rec=1 ;; --force) frc=1 ;; esac; done
echo "fleet-stop: killed session"
[ "\$rec" = 1 ] && [ "\$frc" = 0 ] && echo "fleet-stop: kept $SV/repo/wt (see the reason above)"
[ "\$rec" = 1 ] && [ "\$frc" = 1 ] && echo "fleet-stop: force-removed $SV/repo/wt (past fleet-clean's gates, on request)"
exit 0
STUB
cat > "$SV/bin/fleet-clean" <<STUB
#!/bin/sh
printf 'fleet-clean' >> "$SV/ran"
for a in "\$@"; do printf ' [%s]' "\$a" >> "$SV/ran"; done
printf '\n' >> "$SV/ran"
frc=0; for a in "\$@"; do case "\$a" in --force) frc=1 ;; esac; done
if [ "\$frc" = 1 ]; then echo "  remove api-6 (feat/q) — FORCED past the gates, on request"
else echo "  keep api-6 — unpushed local commits on 'feat/q'"; fi
exit 0
STUB
chmod +x "$SV/bin/fleet-stop" "$SV/bin/fleet-clean"
# fleet-read, both modes. 50 messages, so the 20-then-load-more bound is measurable
# rather than asserted, and the --json shape is the one /api/session serves.
cat > "$SV/bin/fleet-read" <<'STUB'
#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.SV_RAN, 'fleet-read' + argv.map(a => ` [${a}]`).join('') + '\n');
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const all = Array.from({ length: 50 }, (_, i) => ({ ts: 1700000000 + i, role: i % 2 ? 'assistant' : 'user', text: `message ${i + 1}` }));
if (argv.includes('--json')) {
  const limit = Number(flag('--limit', 20)), before = flag('--before', null);
  const end = before == null ? all.length : all.findIndex(m => String(m.ts) === String(before));
  const e = end < 0 ? all.length : end, s = Math.max(0, e - limit);
  process.stdout.write(JSON.stringify({ session: 'w1', total: all.length, window_truncated: false,
    messages: all.slice(s, e), next_before: s > 0 ? String(all[s].ts) : null }) + '\n');
} else {
  const n = Number(argv[argv.length - 1]) || 1;
  process.stdout.write(all.slice(-n).map(m => m.text).join('\n') + '\n');
}
STUB
chmod +x "$SV/bin/fleet-read"
printf 'demo\t%s\twork\nother\t%s\twork\n' "$SV/repo" "$SV/other" > "$SV/home/.config/ghostfleet/projects"

PORT="$(free_port)"; PORT="${PORT:-18787}"
BASE="http://localhost:$PORT"
export GHOSTFLEET_SERVE_CONFIG="$SV/serve.json" GHOSTFLEET_SERVE_AUDIT="$SV/audit.jsonl" SV_RAN="$SV/ran" SV_ROOT="$SV"
sv_cli() { HOME="$SV/home" TMUX= node "$SV/bin/fleet-serve.mjs" "$@"; }
sv_code() { sv_cli enroll "$1" | grep -oE '[A-Z0-9]{5}-[A-Z0-9]{5}'; }
# WHY it did not come up, not just THAT it did not. Six groups used to skip with the bare
# words "server did not come up" while the daemon's own first line said exactly what was
# wrong — `port 8787 is already in use`, which would have named the coloured-port bug in
# one read. And a skip exits 0: a suite that could not test the daemon AT ALL still looked
# green apart from three misattributed reds in other groups. So it is a FAILURE. This
# daemon is the suite's own fixture, not a platform capability that might be absent, and
# CLAUDE.md's rule for the whole file applies — silence is the symptom.
SV_WHY=""
sv_start() {
  HOME="$SV/home" TMUX= CLAUDE_FLEET_AWAKE=off node "$SV/bin/fleet-serve.mjs" > "$SV/log.$1" 2>&1 &
  svp=$!
  SERVE_PIDS="$SERVE_PIDS $svp"
  i=0; while [ "$i" -lt 60 ]; do
    curl -s -m1 "$BASE/healthz" >/dev/null 2>&1 && { SV_WHY=""; return 0; }
    kill -0 "$svp" 2>/dev/null || break        # already exited: its log is the answer
    i=$((i+1)); sleep 0.1
  done
  SV_WHY="$(tr '\n' ' ' < "$SV/log.$1" 2>/dev/null | cut -c1-180)"
  [ -n "$SV_WHY" ] || SV_WHY="nothing at all in $SV/log.$1"
  bad "the daemon comes up ($1)" "listening on $BASE" "$SV_WHY"
  return 1
}
sv_cli init --bind 127.0.0.1 --port "$PORT" >/dev/null 2>&1
# Rate limiting has its own group below; here it must not fire. One probe phase makes
# dozens of assertion and verb calls in a second, which no phone ever would, and a 429 in
# the middle of the auth phase would read as an auth failure.
sv_rate() { node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));c.rate={window:60,read:+process.argv[2],write:+process.argv[3],auth:+process.argv[4]};fs.writeFileSync(p,JSON.stringify(c,null,2))' "$SV/serve.json" "$1" "$2" "$3"; }
sv_rate 4000 4000 4000
US=$'\x1f'
pf() { grep -m1 "^$1$US" "$SV/probe.$2" | cut -d "$US" -f2; }   # http status
pb() { grep -m1 "^$1$US" "$SV/probe.$2" | cut -d "$US" -f3; }   # body

# ── auth ─────────────────────────────────────────────────────────────────────
group "fleet-serve: a token exists only because a passkey signed for it"
if sv_start auth; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" auth "$(sv_code phone)" > "$SV/probe.auth" 2>"$SV/probe.auth.err"
  is "a cold read is refused"                "401" "$(pf cold.read auth)"
  is "a cold verb is refused"                "401" "$(pf cold.verb auth)"
  is "a challenge is free to ask for"        "200" "$(pf cold.challenge auth)"
  # §1: registration with no authorisation lets anyone who reaches the port enrol their
  # own passkey. web/README.md's contract has no gate; this server requires the window
  # AND the one-time code, and refuses each missing half by name.
  is "register with no code is refused"      "403" "$(pf register.noCode auth)"
  is "...naming the CLI that opens one"      "1"   "$(pb register.noCode auth | grep -c 'fleet-serve enroll' || true)"
  is "register with a wrong code is refused" "403" "$(pf register.wrongCode auth)"
  is "the right code enrols the passkey"     "200" "$(pf register.ok auth)"
  is "...and returns a token with an expiry" "1"   "$(pb register.ok auth | grep -c '"expires_at":' || true)"
  # THE §5 PROPERTY, both directions on one server: nothing but an assertion mints a
  # token, so nothing else opens the API — including the credential id, which the client
  # keeps in localStorage and is careful to call not-a-secret.
  is "no token: refused"                     "401" "$(pf noToken.read auth)"
  is "a forged token: refused"               "401" "$(pf forgedToken.read auth)"
  is "the credential id as a token: refused" "401" "$(pf credAsToken.read auth)"
  is "...and it says a passkey is needed"    "1"   "$(pb forgedToken.read auth | grep -c '"needs":"passkey"' || true)"
  is "the real token: read allowed"          "200" "$(pf token.read auth)"
  is "the real token: verb allowed"          "200" "$(pf token.verb auth)"
  is "a real assertion mints another"        "200" "$(pf assert.ok auth)"
  is "a challenge we never issued: refused"  "401" "$(pf assert.replay auth)"
  is "an untouched authenticator: refused"   "401" "$(pf assert.noPresence auth)"
  is "a forged signature: refused"           "401" "$(pf assert.badSig auth)"
  is "an unenrolled key: refused"            "401" "$(pf assert.strangeKey auth)"
  # single-use: the same signed challenge twice is a replay, and the second one loses
  is "a challenge works once"                "200" "$(pf assert.firstUse auth)"
  is "...and not twice"                      "401" "$(pf assert.secondUse auth)"
  is "an unexpected Host is refused"         "403" "$(pf host.wrong auth)"
  is "a foreign Origin is refused"           "403" "$(pf origin.wrong auth)"
  is "no fleet command ran for any of it"    "0"   "$(grep -c 'fleet-spawn\|fleet-stop\|fleet-send' "$SV/ran" || true)"

  # ── revocation: one action, landing on a RUNNING daemon ───────────────────
  group "fleet-serve: revoking a client is one action"
  tok="$(pb assert.ok auth | sed 's/.*"token":"\([^"]*\)".*/\1/')"
  cred="$(pb token auth | sed 's/.*"cred":"\([^"]*\)".*/\1/')"
  is "the token works before the revoke"     "200" \
     "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $tok" "$BASE/api/projects")"
  sv_cli revoke phone >/dev/null 2>&1
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" revoked "$tok" "$cred" > "$SV/probe.rev" 2>/dev/null
  is "the same read is now refused"           "401" "$(pf revoked.read rev)"
  is "the same verb is now refused"           "401" "$(pf revoked.verb rev)"
  is "and its passkey cannot mint another"    "401" "$(pf revoked.assert rev)"
  is "no restart was needed"                  "1"   "$(grep -c 'listening on' "$SV/log.auth" || true)"
  is "the client is listed as revoked"        "1"   "$(sv_cli clients 2>/dev/null | grep -c 'phone .*revoked' || true)"
  serve_stop
else
  skip "fleet-serve auth" "server did not come up: $SV_WHY"
fi

# ── verbs ────────────────────────────────────────────────────────────────────
group "fleet-serve: destructive verbs need a fresh passkey, on the tool name"
: > "$SV/ran"
if sv_start verbs; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" verbs "$(sv_code v)" > "$SV/probe.verbs" 2>"$SV/probe.verbs.err"
  is "a fleet tool with no project refused"  "400" "$(pf project.missing verbs)"
  is "...saying there is no default fleet"   "1"   "$(pb project.missing verbs | grep -c 'no default one' || true)"
  is "an unknown project is refused"         "400" "$(pf project.unknown verbs)"
  is "a misspelt argument is refused"        "400" "$(pf arg.typo verbs)"
  is "...and names the argument"             "1"   "$(pb arg.typo verbs | grep -c "unknown argument 'promt'" || true)"
  is "an unknown tool is refused"            "400" "$(pf tool.unknown verbs)"
  # the shared dispatch's own guard (#38) reaches the phone unchanged
  is "a missing required arg is refused"     "400" "$(pf arg.missing verbs)"
  is "...by the SAME message the MCP gives"  "1"   "$(pb arg.missing verbs | grep -c "fleet_send: missing required argument 'prompt'" || true)"
  # the verbs the client asks for that have no MCP tool yet: refused BY NAME, with the
  # reason, so the button behind them fails loudly instead of looking like a typo
  is "a not-yet-a-tool verb says so"         "501" "$(pf tool.notYet verbs)"
  is "...and explains what is missing"       "1"   "$(pb tool.notYet verbs | grep -c 'marker file' || true)"
  is "send needs no passkey"                 "200" "$(pf send.ok verbs)"
  is "...and reaches another project too"    "200" "$(pf send.other verbs)"
  is "answer needs no passkey"               "200" "$(pf answer.ok verbs)"
  is "spawn with no assertion is refused"    "401" "$(pf spawn.noAssertion verbs)"
  is "...asking for one at the action"       "1"   "$(pb spawn.noAssertion verbs | grep -c 'X-Fleet-Assertion' || true)"
  is "spawn with a forged assertion"         "401" "$(pf spawn.badAssertion verbs)"
  is "spawn with a real one runs"            "200" "$(pf spawn.ok verbs)"
  is "rename takes the same step"            "200" "$(pf rename.ok verbs)"
  # stricter than web/api.js's DESTRUCTIVE set, deliberately: its own README says the
  # passkey covers removing a worktree, and §12 calls that the load-bearing one
  is "worktree removal needs one too"        "401" "$(pf wtRemove.noAssertion verbs)"
  is "project_add needs one too"             "401" "$(pf projectAdd.noAssertion verbs)"
  is "another client's assertion is refused" "401" "$(pf spawn.othersAssertion verbs)"
  # `f = remove anyway` — its own step, after a refusal it is answering
  is "force before any refusal"              "409" "$(pf force.beforeRefusal verbs)"
  is "a gated removal reports it declined"   "200" "$(pf remove.declined verbs)"
  is "...and says the worktree was kept"     "1"   "$(pb remove.declined verbs | grep -c 'keep api-6' || true)"
  is "force after the refusal runs"          "200" "$(pf force.ok verbs)"
  is "...reaching fleet-clean with --force"  "1"   "$(grep -c 'fleet-clean .*\[--go\] \[--force\]' "$SV/ran" || true)"
  is "one refusal buys exactly one force"    "409" "$(pf force.twice verbs)"
  is "a reclaim declines the same way"       "200" "$(pf reclaim.declined verbs)"
  is "...and its force then goes through"    "200" "$(pf reclaimForce.ok verbs)"
  is "...reaching fleet-stop with --force"   "1"   "$(grep -c 'fleet-stop .*\[--reclaim\] \[--force\]' "$SV/ran" || true)"
  # THE LEAD, which only became nameable from a phone once it gained a card (§4). Refused
  # in plan() — the layer BOTH callers go through — and not by the client declining to draw
  # the button, which curl does not run. bin/fleet-stop refused it already, but it refused
  # in the shell, and a nonzero exit from a bin/fleet-* command is deliberately handed back
  # as ordinary output here: the refusal arrived as ok:true with "refusing to stop 'master'"
  # in the success toast, and the audit said `result: 'ran'`.
  is "stopping the lead is refused"          "400" "$(pf lead.stop verbs)"
  is "...and says it is the lead"            "1"   "$(pb lead.stop verbs | grep -c "the fleet's lead" || true)"
  is "reclaiming the lead is refused"        "400" "$(pf lead.reclaim verbs)"
  is "renaming the lead is refused"          "400" "$(pf lead.rename verbs)"
  # THE OTHER DIRECTION, twice over. A guard that refused every stop would pass all three
  # above: the force chain higher up stopped 'w1' for real, and a name that merely CONTAINS
  # `master` is an ordinary worker — a prefix or substring match would refuse this repo's
  # own worktrees.
  is "a near-miss name still stops"          "200" "$(pf nearLead.stop verbs)"
  is "...and reached the command"            "1"   "$(grep -c 'fleet-stop .*\[master-card\]' "$SV/ran" || true)"
  # ...and the refused ones never reached a command at all. The stubs log every call, so
  # this is what ran, not what we meant to allow — and it is the SAME pattern shape as the
  # near-miss above, one place looser than `[master]`, so neither of the pair can pass by
  # being unmatchable.
  is "fleet-stop never ran for the lead"     "0"   "$(grep -c 'fleet-stop .*\[master\]' "$SV/ran" || true)"
  is "...and fleet-rename never did"         "0"   "$(grep -c 'fleet-rename .*\[master\]' "$SV/ran" || true)"
  # PARK, same rule — the governor already excludes master from what it parks, and this
  # only became reachable when the lead got a card, where it is one swipe on the first one.
  is "parking the lead is refused"           "400" "$(pf lead.pause verbs)"
  is "...and says it is the lead"            "1"   "$(pb lead.pause verbs | grep -c "the fleet's lead" || true)"
  is "...and fleet-pause never ran for it"   "0"   "$(grep -c 'fleet-pause .*\[master\]' "$SV/ran" || true)"
  # BUT RESUME IS NOT REFUSED. The recovery direction stays open, and an untested
  # asymmetry is one somebody tidies into a bug.
  is "resuming the lead is allowed"          "200" "$(pf lead.resume verbs)"
  is "...and reached the command"            "1"   "$(grep -c 'fleet-resume .*\[master\]' "$SV/ran" || true)"
  # ...and a worker parks as it always did, or "refused" above would be indistinguishable
  # from a verb that is simply broken.
  is "a worker still parks"                  "200" "$(pf worker.pause verbs)"
  is "...reaching fleet-pause"               "1"   "$(grep -c 'fleet-pause .*\[w1\]' "$SV/ran" || true)"
  # THE OTHER DIRECTION on every refusal above: only the calls that were allowed ran.
  is "spawn ran exactly once"                "1"   "$(grep -c '^fleet-spawn ' "$SV/ran" || true)"
  is "the spawn that ran was the right one"  "1"   "$(grep -c 'fleet-spawn \[api-9\]' "$SV/ran" || true)"
  is "api-X never ran"                       "0"   "$(grep -c 'api-X' "$SV/ran" || true)"
  is "fleet-project never ran"               "0"   "$(grep -c '^fleet-project ' "$SV/ran" || true)"
  is "no command was handed 'undefined'"     "0"   "$(grep -c undefined "$SV/ran" || true)"
  # ...and the child's environment is the TARGET's, not the daemon's. The stubs echo what
  # they were given, so this is what they actually ran with rather than what we intended.
  is "a verb carries the target's scope+root" "1" \
     "$(grep -c "fleet-send .*{scope=demo root=$SV/repo sock=cf-demo}" "$SV/ran" || true)"
  is "...and another project's is its own"    "1" \
     "$(grep -c "fleet-send .*{scope=other root=$SV/other sock=cf-other}" "$SV/ran" || true)"
  is "...and never an empty one"              "0"   "$(grep -c '{scope= ' "$SV/ran" || true)"

  # ── audit ─────────────────────────────────────────────────────────────────
  group "fleet-serve: every mutation is audited into fleet-inbox"
  INB="$SV/home/.claude/fleet/cf-demo.inbox"
  is "the inbox row landed in the fleet dir" "1"   "$([ -f "$INB" ] && echo 1 || echo 0)"
  is "a send is in it"                       "1"   "$(grep -c 'mobile.*send session=w1 prompt=' "$INB" || true)"
  is "a spawn is in it"                      "1"   "$(grep -c 'mobile.*spawn name=api-9' "$INB" || true)"
  is "a forced worktree removal is in it"    "1"   "$(grep -c 'mobile.*worktree_remove path=.*force=true' "$INB" || true)"
  is "a forced reclaim is in it"             "1"   "$(grep -c 'mobile.*stop session=w1 reclaim=true force=true' "$INB" || true)"
  is "a REFUSED call is recorded too"        "1"   "$(grep -c 'send session=w1 — REFUSED' "$INB" || true)"
  # ...including each of the lead's three, by name and with its arguments — §7 wants the
  # log to say what was attempted, and a refusal that leaves no row is a refusal nobody
  # can review afterwards.
  is "the lead's stop is audited refused"    "1"   "$(grep -c 'stop session=master — REFUSED' "$INB" || true)"
  is "...its reclaim too"                    "1"   "$(grep -c 'stop session=master reclaim=true — REFUSED' "$INB" || true)"
  is "...and its rename"                     "1"   "$(grep -c 'rename session=master new_name=lead — REFUSED' "$INB" || true)"
  is "...and its park"                       "1"   "$(grep -c 'pause session=master — REFUSED' "$INB" || true)"
  is "...while its resume is audited as ran" "0"   "$(grep -c 'resume session=master — REFUSED' "$INB" || true)"
  is "...and IS in the log"                  "1"   "$(grep -c 'resume session=master' "$INB" || true)"
  # and the near-miss is recorded as having RUN, or "refused" would be indistinguishable
  # from "audited at all"
  is "the near-miss is audited as ran"       "0"   "$(grep -c 'stop session=master-card — REFUSED' "$INB" || true)"
  is "...but it is in the log"               "1"   "$(grep -c 'stop session=master-card' "$INB" || true)"
  # fleet-inbox reads this with IFS=$'\t'; an EMPTY field there collapses and shifts every
  # later column left (CLAUDE.md's oldest trap), so no row may have one.
  is "every row has all four fields"         "0"   "$(awk -F'\t' 'NF!=4 || $1=="" || $2=="" || $3=="" || $4==""' "$INB" | grep -c . || true)"
  rows="$(grep -c . "$INB" || true)"
  is "fleet-inbox renders every row"         "$rows" \
     "$(CLAUDE_FLEET_DIR="$SV/home/.claude/fleet" TMUX= "$ROOT/bin/fleet-inbox" -s cf-demo --all 2>/dev/null | grep -c 'MOBILE' || true)"
  is "a read wrote no inbox row"             "0"   "$(grep -c 'mobile.*read ' "$INB" || true)"
  # §7: the log says what the fingerprint was FOR, not merely that one happened
  is "the audit names the purpose"           "1"   "$(sv_cli audit -n 50 2>/dev/null | grep -c 'spawn .*api-9 .*ran passkey:spawn' || true)"
  is "the audit chain is intact"             "0"   "$(sv_cli audit --verify >/dev/null 2>&1; echo $?)"
  # tamper with it and the chain must notice — a hash chain that never fires is a filename
  cp "$SV/audit.jsonl" "$SV/audit.keep"
  node -e 'const fs=require("fs");const p=process.argv[1];const l=fs.readFileSync(p,"utf8").split("\n").filter(Boolean);l.splice(1,1);fs.writeFileSync(p,l.join("\n")+"\n")' "$SV/audit.jsonl"
  is "a deleted row breaks the chain"        "1"   "$(sv_cli audit --verify >/dev/null 2>&1; echo $?)"
  is "...and it says which row"              "1"   "$(sv_cli audit --verify 2>&1 | grep -c 'BROKEN at row 2' || true)"
  cp "$SV/audit.keep" "$SV/audit.jsonl"
  is "restored, the chain is intact again"   "0"   "$(sv_cli audit --verify >/dev/null 2>&1; echo $?)"
  # ...and it survives a CLI writer interleaving with the daemon's own appends, which is
  # what broke it the first time: the daemon cached the tail and chained past `revoke`'s row
  sv_cli enroll interleave >/dev/null 2>&1
  is "a CLI writer does not break it"        "0"   "$(sv_cli audit --verify >/dev/null 2>&1; echo $?)"
  serve_stop
else
  skip "fleet-serve verbs" "server did not come up: $SV_WHY"
fi

# ── reads ────────────────────────────────────────────────────────────────────
group "fleet-serve: the grid is never launched without --json"
: > "$SV/ran"; : > "$SV/gridran"
# An unknown flag falls through to the interactive TUI, which blocks on the tty forever
# (CLAUDE.md). So the flag is looked for in the FILE first, exactly as bin/ghostfleet does
# for --order. This stub records being launched and then blocks, like the real thing.
cat > "$SV/bin/fleet-grid.mjs" <<'STUB'
#!/usr/bin/env node
// import, not require: this is an .mjs, and a `require('fs')` here would throw before it
// could record anything — so "the grid was never launched" could not fail, which is the
// one thing a test must never be. Verified by removing the guard and watching it go red.
import fs from 'node:fs';
fs.appendFileSync(process.env.GRIDRAN, 'launched\n');
console.error('INTERACTIVE MODE — this would have blocked on the tty');
setInterval(() => {}, 1000);
STUB
chmod +x "$SV/bin/fleet-grid.mjs"
if GRIDRAN="$SV/gridran" sv_start nojson; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" reads "$(sv_code r1)" > "$SV/probe.nojson" 2>/dev/null
  is "a grid without --json gives 503"       "503" "$(pf grid nojson)"
  is "...naming the flag"                    "1"   "$(pb grid nojson | grep -c 'no --json flag' || true)"
  is "...and the grid was never launched"    "0"   "$(grep -c launched "$SV/gridran" || true)"
  serve_stop
else
  skip "fleet-serve grid 503" "server did not come up: $SV_WHY"
fi

group "fleet-serve: reads proxy the grid, per project, and bound the tail"
: > "$SV/ran"
# The §4 payload, echoing back the four env vars the daemon is supposed to set per
# project. That is the whole point of this stub: a daemon that let SCOPE and ROOT inherit
# its own values answered every project with the FIRST one's name and worktrees.
# The §4 payload. free_worktrees is computed the way the real grid computes it — the
# ROOT's worktrees MINUS the sessions live on the SOCKET — because that pairing is the
# whole bug: a daemon that lets SCOPE/ROOT inherit its own values hands this a root from
# one project and a socket from another, the pairing cannot see the sessions, and
# OCCUPIED worktrees come back as FREE. Measured on the deployed runtime: querying
# another project's socket with a ghostfleet environment advertised fleet-pwa, fleet-serve and
# grid-json as free while live agents were mid-turn in all three.
cat > "$SV/bin/fleet-grid.mjs" <<'STUB'
#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
const scope = process.env.CLAUDE_FLEET_SCOPE || '', root = process.env.CLAUDE_FLEET_ROOT || '';
const sock = process.env.CLAUDE_FLEET_SOCK || '';
const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const worktrees = read(`${root}/worktrees`);          // what this ROOT contains
const sessions = read(`${process.env.SV_ROOT}/sessions.${sock}`);   // who is live on this SOCKET
const free = worktrees.filter(w => !sessions.includes(w));
if (process.argv.includes('--json')) {
  const out = JSON.stringify({ project: scope, profile: process.env.CLAUDE_FLEET_PROFILE || '', sock,
    counts: { need_you: 1, working: 0, ready: 0, parked: 1, limit: 2, interrupted: 0 },
    cards: [
      { name: 'api-2', label: null, status: 'need-you', folder: 'api-2', branch: 'feat/a-very-long-branch-name-that-the-tui-would-elide', agent: 'claude', msg: 'Allow `pnpm test`?', age: 3600, attached: false, sched: null, limit_at: null },
      { name: 'api-3', label: null, status: 'limit',    folder: 'api-3', branch: 'feat/y', agent: 'codex',    msg: 'hi', age: 12, attached: false, sched: { at: 1700000000, msg: 'S'.repeat(4000) }, limit_at: '10:20pm' },
      { name: 'api-4', label: null, status: 'unknown',  folder: 'api-4', branch: 'feat/z', agent: 'opencode', msg: '',   age: null, attached: false, sched: null, limit_at: null },
      { name: 'api-5', label: null, status: 'parked',   folder: 'api-5', branch: 'b', agent: 'claude',        msg: '',   age: 1, attached: false, sched: null, limit_at: null },
      { name: 'api-6', label: null, status: 'a-tenth-status', folder: 'api-6', branch: 'c', agent: 'claude',  msg: '',   age: 1, attached: false, sched: null, limit_at: null }],
    free_worktrees: free.map(w => ({ path: `${root}/${w}`, branch: `feat/${w}`, task: 'idle' })) });
  // process.exit() DISCARDS a pending stdout write on a pipe — measured next door at
  // 200,000 bytes written and 65,536 arriving, JSON stopping mid-string. Wait for it.
  process.stdout.write(out + '\n', () => process.exit(0));
} else if (process.argv.includes('--checkouts')) {
  console.log(`scope Z=${scope}`);
  console.log(`roots: ${root}, ${root}/x`);
  console.log('checkouts:');
  console.log(`  ${root}/one`);
  console.log(`  ${root}/two`);
} else { console.error('INTERACTIVE'); setInterval(() => {}, 1000); }
STUB
# demo holds two worktrees and a live session in one of them; other holds two of its own.
# So `free` is only right if the root and the socket handed to the child belong together.
printf 'busy-demo\nfree-demo\n' > "$SV/repo/worktrees"
printf 'busy-other\nfree-other\n' > "$SV/other/worktrees"
printf 'busy-demo\n'  > "$SV/sessions.cf-demo"
printf 'busy-other\n' > "$SV/sessions.cf-other"
chmod +x "$SV/bin/fleet-grid.mjs"
if sv_start json; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" reads "$(sv_code r2)" > "$SV/probe.reads" 2>"$SV/probe.reads.err"
  is "the grid's JSON is served"              "200" "$(pf grid reads)"
  # THE BUG A LONG-LIVED DAEMON GETS WRONG. fleet-grid.mjs derives `project` from
  # CLAUDE_FLEET_SCOPE and its free-worktree list from CLAUDE_FLEET_ROOT. A daemon that
  # inherits its own answers every project with the first one's name and the first one's
  # worktrees — and a "reuse this free worktree" tap would then name a checkout in the
  # WRONG REPO with fleet_spawn behind it. Two projects from one process, or the test
  # passes whether or not the bug exists.
  is "project demo says it is demo"           "1"   "$(pb grid reads | grep -c '"project":"demo"' || true)"
  is "project other says it is other"         "1"   "$(pb grid.other reads | grep -c '"project":"other"' || true)"
  is "demo's free worktree is demo's"         "1"   "$(pb grid reads | grep -c "$SV/repo/free-demo" || true)"
  is "other's free worktree is other's"       "1"   "$(pb grid.other reads | grep -c "$SV/other/free-other" || true)"
  is "...and demo's is not in other's answer" "0"   "$(pb grid.other reads | grep -c "$SV/repo/free-demo" || true)"
  is "each gets its own socket"               "1"   "$(pb grid.other reads | grep -c '"sock":"cf-other"' || true)"
  # THE ASSERTION THAT PROTECTS A DESTRUCTIVE VERB. A worktree with a live session must
  # never be advertised as free — `fleet_spawn --reuse` on one resets and rebranches a
  # checkout somebody is working in. With a mismatched root/socket pair the busy one comes
  # back as free and nothing about the response looks wrong.
  is "an OCCUPIED worktree is never free"     "0"   "$(pb grid reads | grep -c 'busy-demo' || true)"
  is "...in either project"                   "0"   "$(pb grid.other reads | grep -c 'busy-other' || true)"
  is "...and no cross-project leak at all"    "0"   "$(pb grid.other reads | grep -c 'demo' || true)"
  # §4's three rules: the nine statuses survive, unknown is not idle, limit is not ready.
  is "'unknown' is passed through, not idle"  "1"   "$(pb grid reads | grep -c '"status":"unknown"' || true)"
  is "'limit' is passed through, not ready"   "1"   "$(pb grid reads | grep -c '"status":"limit"' || true)"
  is "limit is not folded into ready"         "1"   "$(pb grid reads | grep -c '"limit":2' || true)"
  is "the long branch is NOT elided"          "1"   "$(pb grid reads | grep -c 'feat/a-very-long-branch-name-that-the-tui-would-elide' || true)"
  is "free worktrees carry over"              "1"   "$(pb grid reads | grep -c '"free_worktrees"' || true)"
  # sched became {at, msg} in #41, and `msg` is a user-authored prompt of arbitrary length
  # emitted WHOLE — the client clips, not the server. 4000 characters through, unclipped.
  is "sched carries its at AND its msg"       "1"   "$(pb grid reads | grep -c '"sched":{"at":1700000000' || true)"
  is "...and the msg is not clipped"          "4000" \
     "$(pb grid reads | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String((JSON.parse(s).cards.find(c=>c.sched)||{sched:{msg:""}}).sched.msg.length)))')"
  is "a tenth status is complained about"     "1"   "$(pb grid reads | grep -c 'schema_warnings' || true)"
  is "...and still passed through verbatim"   "1"   "$(pb grid reads | grep -c '"a-tenth-status"' || true)"
  is "an unknown project is refused"          "400" "$(pf grid.unknown reads)"
  # §11.3: a bounded page with an explicit load-more. A PERFORMANCE bound — 46 MB down a
  # WireGuard tunnel on cellular — never to be described as a security control.
  is "the default page is 20 messages"        "20"  "$(pb session reads | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).messages.length)))')"
  is "...and it is the NEWEST 20"             "1"   "$(pb session reads | grep -c '"message 50"' || true)"
  is "...starting at 31, not at 1"            "1"   "$(pb session reads | grep -c '"message 31"' || true)"
  is "...and 30 is NOT in it"                 "0"   "$(pb session reads | grep -c '"message 30"' || true)"
  is "...with a cursor for the next page"     "1"   "$(pb session reads | grep -c '"next_before":' || true)"
  is "each message carries ts and role"       "1"   "$(pb session reads | grep -c '"role":"assistant"' || true)"
  is "limit=5 returns 5"                      "5"   "$(pb session.limit reads | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).messages.length)))')"
  is "limit=0 is refused"                     "400" "$(pf session.zero reads)"
  is "limit past the cap is refused"          "400" "$(pf session.huge reads)"
  is "it went through fleet-read --json"      "1"   "$([ "$(grep -c 'fleet-read .*\[--json\]' "$SV/ran" || true)" -ge 1 ] && echo 1 || echo 0)"
  is "...and never read the transcript here" "0"   "$(grep -c 'readFileSync(tr\|projects/.*jsonl' "$ROOT/bin/fleet-serve.mjs" || true)"
  # the other contract reads
  is "checkouts are served"                   "200" "$(pf checkouts reads)"
  is "...from that project's own root"        "1"   "$(pb checkouts reads | grep -c "$SV/repo/one" || true)"
  is "settings are served"                    "200" "$(pf settings reads)"
  is "...as the tri-state the client wants"   "1"   "$(pb settings reads | grep -c '"global_nudge"' || true)"
  is "projects carry \$HOME for ~ shortening" "1"   "$(pb projects reads | grep -c '"home":' || true)"
  is "...and a rollup counted from cards"     "1"   "$(pb projects reads | grep -c '"need":1' || true)"
  # counts has six keys and a card can hold nine statuses, so a total by SUM is wrong:
  # five cards, and the six counts add to four.
  is "...whose total is the card count"       "1"   "$(pb projects reads | grep -c '"total":5' || true)"
  is "the inbox is readable"                  "200" "$(pf inbox reads)"
  # ...and an answer too big to buffer is REFUSED BY NAME rather than returned short.
  # node hands back the bytes it did collect alongside the error, so the naive
  # `stdout || stderr` returns a payload cut off mid-value — which for text does not fail
  # at all, it just looks like a short answer. The one direction that matters here is the
  # negative: the truncated text must not reach the caller as if it were the whole thing.
  cp "$SV/bin/fleet-inbox" "$SV/bin/fleet-inbox.keep"
  cat > "$SV/bin/fleet-inbox" <<'STUB'
#!/usr/bin/env node
// 4 MB, past the dispatch's 1 MB default for an ordinary verb
process.stdout.write('x'.repeat(4 * 1024 * 1024) + '\nTAIL-MARKER\n');
STUB
  chmod +x "$SV/bin/fleet-inbox"
  ovf="$(node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" reads "$(sv_code ovf)" 2>/dev/null | grep -m1 "^inbox$US" | cut -d "$US" -f3)"
  is "an over-long answer says it was cut"   "1"   "$(printf '%s' "$ovf" | grep -c 'produced more than' || true)"
  is "...and does not return it short"       "0"   "$(printf '%s' "$ovf" | grep -c 'xxxxxxxxxx' || true)"
  mv "$SV/bin/fleet-inbox.keep" "$SV/bin/fleet-inbox"
  # reading the inbox from the phone must not consume the lead's "new since last look"
  is "...never in the consuming form"         "0"   "$(grep -cE '^fleet-inbox \[-s\] \[cf-demo\]( \{|$)' "$SV/ran" || true)"
  is "...and --all did run"                   "1"   "$([ "$(grep -c 'fleet-inbox \[-s\] \[cf-demo\] \[--all\]' "$SV/ran" || true)" -ge 1 ] && echo 1 || echo 0)"
  is "the audit log is readable from here"    "200" "$(pf audit reads)"
  is "health reports the grid flag"           "1"   "$(pb health reads | grep -c '"grid_json":true' || true)"
  serve_stop
else
  skip "fleet-serve reads" "server did not come up: $SV_WHY"
fi

# ── /api/pane: the session's real pane, and the dialog it makes answerable ────
# THE WHOLE POINT OF THE ENDPOINT, and it is a chain rather than a call. The phone used to
# render a session as a message list, and the first person to use it said "i can't see the
# commands that is running" — which was not a rendering shortfall: /api/session goes
# through `fleet-read --json`, whose payload is {ts, role, text}, so a tool call and the
# command inside it are absent from the DATA. `answer keys` had been on that screen since
# #40 and was close to useless, because you could not see what you were answering.
#
# So the three assertions that matter are one story: the pane carries a real permission
# dialog, the verb clears it, and the pane afterwards is different. Any one alone proves
# nothing — a pane that never changes and a verb that does nothing look identical from
# here, which is the shape CLAUDE.md keeps warning about.
#
# NOTHING IS STUBBED ON THIS PATH. The server runs against the REAL $ROOT/bin, so
# fleet_answer reaches the real bin/fleet-answer and the real tmux; and the bytes in the
# pane are the ones Claude Code actually emitted for a "Do you want to create hello.txt?"
# prompt, captured live into test/fixtures/claude-permission-dialog-sgr.txt. They are
# replayed into a pane that then blocks on a keystroke, which keeps Claude's own escapes
# while leaving the key handling deterministic enough for a suite.
group "fleet-serve: /api/pane is the pane, and answer keys clears what it shows"
if [ -z "$SV" ]; then
  skip "/api/pane" "node missing"
else
PN="$TMUX_TMPDIR/pane"; mkdir -p "$PN/home/.config/ghostfleet" "$PN/repo" "$PN/other"
printf 'demo\t%s\twork\nother\t%s\twork\n' "$PN/repo" "$PN/other" > "$PN/home/.config/ghostfleet/projects"
# The dialog, on a pane sized like the one it was captured from, so the geometry the
# endpoint reports can be checked against a number we chose rather than one we read back.
cat > "$PN/dialog.sh" <<SH
#!/bin/sh
clear
cat "$ROOT/test/fixtures/claude-permission-dialog-sgr.txt"
# Blocks until fleet-answer sends a key, then redraws — so "the pane changed" is a real
# consequence of the verb and not of time passing.
read -r answer
clear
printf 'ANSWERED [%s] - dialog cleared\n' "\$answer"
sleep 600
SH
chmod +x "$PN/dialog.sh"
tmux -L cf-demo new-session -d -s dlg -x 100 -y 30 "$PN/dialog.sh" 2>/dev/null
# A SESSION OF THE SAME NAME ON ANOTHER FLEET. CLAUDE.md's most-repeated scar: "a session's
# status must be scoped by its fleet socket — every project has a session called `master`,
# so matching on name alone reports another project's state." A pane read is the worst place
# for that, because the wrong answer is a perfectly plausible screenful of somebody else's
# work. So `dlg` exists on cf-other too, saying something unmistakable, and the assertion
# below is that it never appears.
tmux -L cf-other new-session -d -s dlg -x 100 -y 30 "sh -c 'clear; echo WRONG-FLEET-PANE; sleep 600'" 2>/dev/null
i=0; while [ "$i" -lt 40 ] && ! grep -q 'WRONG-FLEET-PANE' <<< "$(tmux -L cf-other capture-pane -p -t dlg 2>/dev/null)"; do i=$((i+1)); sleep 0.1; done
is "the decoy fleet has a 'dlg' too"        "1"   "$(tmux -L cf-other capture-pane -p -t dlg 2>/dev/null | grep -c 'WRONG-FLEET-PANE' || true)"
# Wait for the dialog to be ON the pane before asserting anything about it: `cat` into a
# fresh pane is fast but not instant, and a race here would read an empty pane and blame
# the endpoint.
i=0; while [ "$i" -lt 60 ] && ! grep -q 'Do you want to create' <<< "$(tmux -L cf-demo capture-pane -p -t dlg 2>/dev/null)"; do i=$((i+1)); sleep 0.1; done
is "the fixture reached a real pane"        "1"   "$(tmux -L cf-demo capture-pane -p -t dlg 2>/dev/null | grep -c 'Do you want to create' || true)"

PNPORT="$(free_port)"; PNPORT="${PNPORT:-18799}"
PNBASE="http://localhost:$PNPORT"
pn_cli() { GHOSTFLEET_SERVE_CONFIG="$PN/serve.json" GHOSTFLEET_SERVE_AUDIT="$PN/audit.jsonl" \
           HOME="$PN/home" TMUX= node "$ROOT/bin/fleet-serve.mjs" "$@"; }
pn_cli init --bind 127.0.0.1 --port "$PNPORT" >/dev/null 2>&1
node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));c.rate={window:60,read:4000,write:4000,auth:4000};fs.writeFileSync(p,JSON.stringify(c,null,2))' "$PN/serve.json"
GHOSTFLEET_SERVE_CONFIG="$PN/serve.json" GHOSTFLEET_SERVE_AUDIT="$PN/audit.jsonl" \
  HOME="$PN/home" TMUX= CLAUDE_FLEET_AWAKE=off node "$ROOT/bin/fleet-serve.mjs" > "$PN/log" 2>&1 &
PN_PID=$!
i=0; up=no; while [ "$i" -lt 60 ]; do curl -s -m1 "$PNBASE/healthz" >/dev/null 2>&1 && { up=yes; break; }; i=$((i+1)); sleep 0.1; done
if [ "$up" != yes ]; then
  skip "/api/pane" "server did not come up"
else
  pncode="$(pn_cli enroll phone | grep -oE '[A-Z0-9]{5}-[A-Z0-9]{5}')"
  node "$ROOT/test/helpers/serve-probe.mjs" "$PNBASE" pane "$pncode" > "$PN/probe" 2>"$PN/probe.err"
  pnf() { grep -m1 "^$1$US" "$PN/probe" | cut -d "$US" -f2; }
  pnb() { grep -m1 "^$1$US" "$PN/probe" | cut -d "$US" -f3; }
  is "the probe ran without complaining"     ""    "$(head -2 "$PN/probe.err" | tr '\n' ' ' | sed 's/ *$//')"

  # ── 1. the pane, with its escapes ──────────────────────────────────────────
  is "a pane is served"                      "200" "$(pnf pane.dialog)"
  is "...and it carries the dialog"          "1"   "$(pnb pane.dialog | grep -c 'Do you want to create' || true)"
  # THROUGH THE RENDERER, not by grepping the wire, and a real capture is why. Claude Code
  # writes filenames as OSC 8 hyperlinks and puts a colour change between `1. ` and `Yes`,
  # so the bytes contain neither `Write(hello.txt)` nor `1. Yes` while the pane on screen
  # plainly reads both. Both of those started life here as greps on the body and went red
  # against a live pane while web/ansi.js was right — so what is asserted is what a phone
  # would SHOW (test/helpers/pane-render.mjs), which is also the only claim worth making.
  pnshow="$(pnb pane.dialog | node "$ROOT/test/helpers/pane-render.mjs" 2>"$PN/render.err")"
  pntext() { printf '%s\n' "$pnshow" | tail -n +2; }
  is "the body renders without complaint"    ""    "$(head -2 "$PN/render.err" | tr '\n' ' ' | sed 's/ *$//')"
  is "...and the numbered choices are legible" "1" "$(pntext | grep -cF '1. Yes' || true)"
  is "...all three of them"                  "3"   "$(pntext | grep -cE '^ *(❯ )?[123]\. ' || true)"
  is "...and the question above them"        "1"   "$(pntext | grep -cF 'Do you want to create hello.txt?' || true)"
  # The command, which is the sentence that started this feature. Its filename is an OSC 8
  # link, so this line is also the proof the label survives and the URL does not.
  is "the tool header is legible"            "1"   "$(pntext | grep -cF 'Write(hello.txt)' || true)"
  is "...and the URL behind it is not shown" "0"   "$(pntext | grep -c 'file:///' || true)"
  # -e IS THE POINT: colour and attributes are how the TUI tells a tool header from prose.
  # JSON spells an ESC as , so these two are what a plain `capture-pane` (no -e)
  # would fail while still returning a perfectly readable pane — which is exactly the sort
  # of half-working that looks fine until someone squints at a phone.
  is "...with the SGR escapes intact"        "1"   "$(pnb pane.dialog | grep -c 'u001b\[38;5;' || true)"
  is "...including the bold the dialog uses" "1"   "$(pnb pane.dialog | grep -c 'u001b\[1m' || true)"
  # ...and the geometry it was captured at, which is the pane the DESK laid out. A phone
  # that had attached would have reflowed this to its own width, so this pair is the
  # no-attach promise measured rather than asserted: the client's own count of the served
  # bytes, against what tmux says the pane is.
  is "the served pane renders 100 columns"   "100" "$(printf '%s\n' "$pnshow" | head -1 | cut -d "$US" -f1)"
  is "...and 30 rows"                        "30"  "$(printf '%s\n' "$pnshow" | head -1 | cut -d "$US" -f2)"
  is "...which is what tmux says it is"      "100x30" "$(tmux -L cf-demo display-message -p -t dlg '#{pane_width}x#{pane_height}' 2>/dev/null)"
  # SCOPED BY THE SOCKET, both directions. `demo` must not return the identically-named
  # session on `other`'s fleet, and `other` must return its own — a reader that answered
  # `demo` for both would pass the first half on its own.
  is "...and not the other fleet's 'dlg'"    "0"   "$(pnb pane.dialog | grep -c 'WRONG-FLEET-PANE' || true)"
  is "the other fleet's 'dlg' is its own"    "1"   "$(pnb pane.otherFleet | grep -c 'WRONG-FLEET-PANE' || true)"
  is "...and not this fleet's dialog"        "0"   "$(pnb pane.otherFleet | grep -c 'Do you want to create' || true)"

  # ── 2. answer keys ─────────────────────────────────────────────────────────
  is "answer keys is accepted"               "200" "$(pnf pane.answer)"
  # ── 3. ...and the pane it showed has changed ───────────────────────────────
  is "the dialog is gone from the pane"      "0"   "$(pnb pane.after | grep -c 'Do you want to create' || true)"
  is "...and the answer landed as sent"      "1"   "$(pnb pane.after | grep -c 'ANSWERED \[1\]' || true)"

  # ── the endpoint's edges, each refused by name ─────────────────────────────
  is "no session is refused"                 "400" "$(pnf pane.noSession)"
  is "...saying which field"                 "1"   "$(pnb pane.noSession | grep -c 'session is required' || true)"
  is "no project is refused"                 "400" "$(pnf pane.noProject)"
  is "an unknown project is refused"         "400" "$(pnf pane.badProject)"
  # A session that is gone gets tmux's own words, not a friendlier invention: which of the
  # socket and the name was wrong is the useful half.
  is "a vanished session is a 502"           "502" "$(pnf pane.gone)"
  is "...quoting tmux"                       "1"   "$(pnb pane.gone | grep -c 'find pane' || true)"
  is "scrollback past the cap is refused"    "400" "$(pnf pane.scrollbackBad)"
  is "...naming the range"                   "1"   "$(pnb pane.scrollbackBad | grep -c '0-2000' || true)"
  is "a negative scrollback is refused"      "400" "$(pnf pane.scrollbackNeg)"
  is "a scrollback in range is served"       "200" "$(pnf pane.scrollbackOk)"
  # THE SECURITY POSTURE, unchanged: this is a READ behind the same session-token gate as
  # every other read, with no auth path of its own (§5, §11.3).
  is "a cold pane read is refused"           "401" "$(pnf pane.noToken)"
  is "...and it asks for a passkey"          "1"   "$(pnb pane.noToken | grep -c '"needs":"passkey"' || true)"

  # IT MUST NOT ATTACH, AND MUST NOT RESIZE. Attaching makes this a tmux CLIENT and a
  # client sizes the window to fit itself, so a phone would reflow the agent's 269-column
  # pane to ~40 and the desk would find its session cropped. Asserted three ways: the code
  # contains neither verb, and after every request above no client has ever attached.
  is "no attach in fleet-serve.mjs"          "0"   "$(grep -cE 'attach-session|attach-client' "$ROOT/bin/fleet-serve.mjs" || true)"
  is "no resize in fleet-serve.mjs"          "0"   "$(grep -cE 'resize-window|resize-pane' "$ROOT/bin/fleet-serve.mjs" || true)"
  is "no client ever attached"               "0"   "$(tmux -L cf-demo list-clients -t dlg 2>/dev/null | wc -l | tr -d ' ')"
  # ...and -J is absent too: joining wrapped lines would un-wrap the grid tmux laid out,
  # which is the one thing the client cannot recover from.
  is "capture-pane is not asked to join"     "0"   "$(grep -c "'-J'" "$ROOT/bin/fleet-serve.mjs" || true)"
fi
kill $PN_PID 2>/dev/null
tmux -L cf-demo kill-server 2>/dev/null
tmux -L cf-other kill-server 2>/dev/null
fi

group "fleet-serve: the REAL grid, two projects, one daemon process"
# The strongest form of the scope/root test: no stub grid, no fake payload — the actual
# bin/fleet-grid.mjs --json, driven through the daemon, against two real repos with a real
# tmux session sitting in one of their worktrees.
#
# mainRepo() reads CLAUDE_FLEET_ROOT and freeWorktrees() pairs that repo's worktrees
# against tmuxList()'s cwds on CLAUDE_FLEET_SOCK, so a daemon that inherits its own values
# hands those two functions a root from one project and a socket from another. The pairing
# then cannot see the sessions, and a worktree with a live agent in it is advertised as
# FREE. Measured on the deployed runtime against another project from a ghostfleet environment:
# fleet-pwa, fleet-serve and grid-json all came back free, all three mid-turn.
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
RG="$TMUX_TMPDIR/realgrid"; mkdir -p "$RG"
mkdir -p "$RG/home/.config/ghostfleet" "$RG/home/.claude/fleet"
for pj in pa pb; do
  mkdir -p "$RG/$pj"
  git init -q "$RG/$pj/main" 2>/dev/null
  ( cd "$RG/$pj/main" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
  # two worktrees, because freeWorktrees() returns [] for a repo that has fewer than two
  git -C "$RG/$pj/main" worktree add -q -b "wt1-$pj" "$RG/$pj/wt1-$pj" 2>/dev/null
  git -C "$RG/$pj/main" worktree add -q -b "wt2-$pj" "$RG/$pj/wt2-$pj" 2>/dev/null
done
printf 'pa\t%s\twork\npb\t%s\twork\n' "$RG/pa" "$RG/pb" > "$RG/home/.config/ghostfleet/projects"
# a live session standing in pa's FIRST worktree, on pa's OWN socket — plus pa's LEAD,
# sitting in the main checkout the way a real one does. pb gets neither, which is what
# makes the Projects-screen assertions below a pair rather than a single reading.
tmux -L cf-pa kill-server 2>/dev/null
tmux -L cf-pa new-session -d -s busy -c "$RG/pa/wt1-pa" 'sleep 120' 2>/dev/null
tmux -L cf-pa new-session -d -s master -c "$RG/pa/main" 'sleep 120' 2>/dev/null
RPORT="$(free_port)"; RPORT="${RPORT:-18899}"
RBASE="http://localhost:$RPORT"
GHOSTFLEET_SERVE_CONFIG="$RG/serve.json" GHOSTFLEET_SERVE_AUDIT="$RG/audit.jsonl" \
  HOME="$RG/home" TMUX= node "$ROOT/bin/fleet-serve.mjs" init --bind 127.0.0.1 --port "$RPORT" >/dev/null 2>&1
rcode="$(GHOSTFLEET_SERVE_CONFIG="$RG/serve.json" GHOSTFLEET_SERVE_AUDIT="$RG/audit.jsonl" \
  HOME="$RG/home" TMUX= node "$ROOT/bin/fleet-serve.mjs" enroll phone | grep -oE '[A-Z0-9]{5}-[A-Z0-9]{5}')"
GHOSTFLEET_SERVE_CONFIG="$RG/serve.json" GHOSTFLEET_SERVE_AUDIT="$RG/audit.jsonl" \
  HOME="$RG/home" TMUX= CLAUDE_FLEET_AWAKE=off node "$ROOT/bin/fleet-serve.mjs" > "$RG/log" 2>&1 &
rgp=$!
SERVE_PIDS="$SERVE_PIDS $rgp"
i=0; while [ "$i" -lt 60 ] && ! curl -s -m1 "$RBASE/healthz" >/dev/null 2>&1; do
  kill -0 "$rgp" 2>/dev/null || break          # already exited: its log is the answer
  i=$((i+1)); sleep 0.1
done
if curl -s -m1 "$RBASE/healthz" >/dev/null 2>&1; then
  cat > "$RG/probe.mjs" <<'PROBE'
// dynamic, because an import specifier cannot be an expression and the helper lives at
// an absolute path this temp dir has no relative route to
const { Authenticator } = await import(process.env.HELPER);
const base = process.argv[2];
const a = new Authenticator({ rpId: 'localhost', origin: base });
await a.enroll(base, process.argv[3]);
for (const p of ['pa', 'pb']) {
  const r = await a.api(base, 'GET', `/api/grid?project=${p}`);
  console.log(`${p}\x1f${r.status}\x1f${JSON.stringify(r.json)}`);
}
// THE SEAM. /api/projects rolls each project up from these same cards, and until now the
// rollup was only ever tested against a STUB grid while the cards were only ever tested
// through the real emitter — so nothing crossed the join, and the lead arriving in `cards`
// changed a screen no assertion was watching.
const pr = await a.api(base, 'GET', '/api/projects');
console.log(`projects\x1f${pr.status}\x1f${JSON.stringify(pr.json)}`);
PROBE
  HELPER="file://$ROOT/test/helpers/serve-client.mjs" node "$RG/probe.mjs" "$RBASE" "$rcode" > "$RG/out" 2>"$RG/err"
  rf() { grep -m1 "^$1$US" "$RG/out" | cut -d "$US" -f2; }
  rb() { grep -m1 "^$1$US" "$RG/out" | cut -d "$US" -f3; }
  is "the real grid answers for pa"          "200" "$(rf pa)"
  is "the real grid answers for pb"          "200" "$(rf pb)"
  is "pa says it is pa"                      "1"   "$(rb pa | grep -c '"project":"pa"' || true)"
  is "pb says it is pb"                      "1"   "$(rb pb | grep -c '"project":"pb"' || true)"
  # THE ONE THAT PROTECTS A DESTRUCTIVE VERB: wt1-pa has a live session in it.
  #   Matched against free_worktrees SPECIFICALLY, not against the whole payload — the
  # busy session's own card carries folder/branch "wt1-pa" too, so a grep over the body
  # matches whether or not the worktree is offered as free. That is the same class of
  # mistake as the test that cannot fail: it went red for the right reason but the wrong
  # substring, on a grid that was behaving correctly.
  freepaths() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).free_worktrees||[]).map(w=>w.path).join(" ")))'; }
  is "pa's occupied worktree is NOT free"    "0"   "$(rb pa | freepaths | grep -c 'wt1-pa' || true)"
  is "...but its idle one is"                "1"   "$(rb pa | freepaths | grep -c 'wt2-pa' || true)"
  # ...and pb, queried from the SAME process, sees only its own tree
  is "pb's free list is pb's"                "1"   "$(rb pb | freepaths | grep -c "$RG/pb" || true)"
  is "...and never mentions pa's"            "0"   "$(rb pb | freepaths | grep -c "$RG/pa" || true)"
  is "...nor does anything else in pb"       "0"   "$(rb pb | grep -c "$RG/pa" || true)"
  is "pa's counts have the six §4 keys"      "6"   \
     "$(rb pa | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(Object.keys(JSON.parse(s).counts).length)))')"
  is "the busy session is a card, not free"  "1"   "$(rb pa | grep -c '"name":"busy"' || true)"
  # ── the Projects screen, from the same cards (the seam) ────────────────────
  # It counts cards.length, so the lead counts there too — which is what the TUI's own
  # Projects screen has ALWAYS done (projectStatus -> sessionStatuses, "Includes master:
  # it's the project's lead session"). The phone was the one under-counting; these two
  # surfaces now agree, and this is the assertion that says so out loud.
  PJ() { node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const p=(o.projects||[]).find(x=>x.name===process.argv[2])||{};
    const v=new Function("p","return ("+process.argv[3]+")")(p);
    console.log(v===undefined?"":(v!==null&&typeof v==="object")?JSON.stringify(v):String(v));
  ' /dev/stdin "$1" "$2" <<< "$(rb projects)"; }
  is "the projects rollup answers"           "200"    "$(rf projects)"
  is "pa counts its lead and its worker"     "2"      "$(PJ pa 'p.sessions.total')"
  # THE SEAM ITSELF, stated as an identity rather than as two numbers I typed: the rollup's
  # total must equal the card count /api/grid served for the same project, from the same
  # daemon, in the same second. That is the join nothing crossed before — and it holds
  # whatever the fleet happens to contain, so it cannot pass by coincidence of fixture.
  is "...which is exactly its card count"    "same"   "$(node -e '
    const fs=require("fs");
    const grid=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const proj=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
    const pa=(proj.projects||[]).find(x=>x.name==="pa")||{};
    const n=(grid.cards||[]).length, t=pa.sessions&&pa.sessions.total;
    console.log(n===t ? "same" : `grid=${n} rollup=${t}`);
  ' <(rb pa) <(rb projects))"
  # ...and the lead is genuinely one of the cards being counted, not a coincidence of two.
  is "...and the lead is one of them"        "1"      "$(rb pa | grep -c '"name":"master"' || true)"
  # ...and the other direction: a project with NO sessions still reads zero, so "counts the
  # lead" cannot be a constant.
  is "pb has no sessions at all"             "0"      "$(PJ pb 'p.sessions.total')"
  is "...and is not silently null"           "object" "$(PJ pb 'typeof p.sessions')"
else
  skip "real grid through the daemon" \
    "server did not come up: $(tr '\n' ' ' < "$RG/log" 2>/dev/null | cut -c1-180)"
fi
serve_stop
tmux -L cf-pa kill-server 2>/dev/null
rm -rf "$RG"
else
  skip "real grid through the daemon" "git, tmux or node missing"
fi

group "fleet-serve rate limits a token that leaked"
sv_rate 3 2 200
if sv_start rate; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" rate "$(sv_code rl)" > "$SV/probe.rate" 2>/dev/null
  burst="$(pb burst rate)"
  is "the burst starts by succeeding"        "1"   "$(printf '%s' "$burst" | grep -c '^\[200' || true)"
  is "...and then gets 429s"                 "1"   "$(printf '%s' "$burst" | grep -c '429' || true)"
  is "it does not 429 from the first call"   "0"   "$(printf '%s' "$burst" | grep -c '^\[429' || true)"
  serve_stop
else
  skip "fleet-serve rate limit" "server did not come up: $SV_WHY"
fi
sv_rate 4000 4000 4000

# ── push: a bell for the two things worth one, and silence for everything else ──
# docs/mobile.md §9 argued against building this. What changed is in the PR; what did NOT
# change is the reason every assertion below comes in pairs. A push that fires when he is
# already looking is noise, a push that never fires is indistinguishable from a fleet with
# nothing to say, and on iOS a worker that takes a push without showing a notification can
# lose the subscription — so "did not send" has to be a decision made HERE, before the
# send, and it has to be provable.
#
# THE FAKE PUSH SERVICE DECRYPTS. Everything that can be wrong with Web Push is wrong
# silently and identically: a DER signature where the service wants raw r||s, a mis-salted
# HKDF, a missing record delimiter — all of them are accepted by the service and show
# nothing on the phone. A test that counted POSTs would pass for every one of them, so
# test/helpers/push-probe.mjs decrypts the body with its own implementation of RFC 8291
# and verifies the VAPID JWT, and these assert the PLAINTEXT.
group "fleet-serve: push tells a phone about the two events, and shuts up otherwise"
if ! command -v curl >/dev/null 2>&1; then
  skip "push" "curl is not installed"
else
  PU="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$PU/home/.config/ghostfleet" "$PU/home/.claude/fleet" "$PU/home/.claude-personal/fleet" "$PU/repo" "$PU/prepo"
  # TWO PROFILES, because a push channel scoped to one fleet dir is the failure CLAUDE.md
  # names: work notifies, personal is silent, and silence has no error in it to find.
  printf 'demo\t%s\twork\npers\t%s\tpersonal\n' "$PU/repo" "$PU/prepo" > "$PU/home/.config/ghostfleet/projects"
  PUPORT="$(free_port)"; PUPORT="${PUPORT:-18901}"
  OKPORT="$(free_port)"; OKPORT="${OKPORT:-18902}"
  GONEPORT="$(free_port)"; GONEPORT="${GONEPORT:-18903}"
  PUBASE="http://localhost:$PUPORT"
  # Its own config and its own HOME: the daemon above has two work projects and no push
  # config, and this group changes both.
  pu() { GHOSTFLEET_SERVE_CONFIG="$PU/serve.json" GHOSTFLEET_SERVE_AUDIT="$PU/audit.jsonl" \
         GHOSTFLEET_PUSH_ALLOW_HTTP=1 HOME="$PU/home" TMUX= CLAUDE_FLEET_AWAKE=off \
         node "$ROOT/bin/fleet-serve.mjs" "$@"; }
  # A status file, exactly as hooks/fleet-event.sh writes one — INCLUDING the fields that
  # must never reach a lock screen. The transcript path and the note are planted secrets:
  # they are what the payload assertions below are looking for and must not find.
  pu_status() {   # $1=fleet-dir $2=file-id $3=sock $4=slot $5=status
    # tmp + mv, because that is what hooks/fleet-event.sh does and the difference is
    # observable: `> file` truncates first, so a reader landing in that window sees an
    # empty file. The daemon treats an unparsable file as "no news" rather than as a new
    # session precisely so that cannot become a notification — this writes atomically so
    # the fixture exercises the real writer's behaviour rather than one the hook never has.
    printf '{"session_id":"%s","zellij":"","sock":"%s","slot":"%s","cwd":"/x/%s","folder":"%s","branch":"main","status":"%s","transcript":"/tmp/SECRET-CLIENT-NAME.jsonl","note":"the DATABASE_URL is postgres://secret","ts":%s}\n' \
      "$2" "$3" "$4" "$4" "$4" "$5" "$(date +%s)" > "$1/.$2.tmp"
    mv -f "$1/.$2.tmp" "$1/$2.json"
  }
  pu_cfg() {      # scan/debounce/quiet, and rate caps a probe phase will not trip
    node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));
      c.rate={window:60,read:4000,write:4000,auth:4000};
      c.push={...(c.push||{}),scan:1,debounce:+process.argv[2],quiet_after_poll:+process.argv[3]};
      fs.writeFileSync(p,JSON.stringify(c,null,2))' "$PU/serve.json" "$1" "$2"
  }
  pu_lines() { wc -l < "$1" 2>/dev/null | tr -d ' '; }
  pu_wait() {     # $1=file $2=lines wanted — waits for an EVENT rather than sleeping for one
    i=0; while [ "$i" -lt 80 ]; do
      [ "$(pu_lines "$1")" -ge "$2" ] 2>/dev/null && return 0
      i=$((i+1)); sleep 0.1
    done; return 1
  }
  pu_payload() { tail -1 "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d).payload))}catch{console.log("")}})'; }
  pu_field() {   # $1=file $2=jsonpath-ish key of the LAST row
    tail -1 "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$2"; }

  pu init --bind 127.0.0.1 --port "$PUPORT" >/dev/null 2>&1
  # debounce 4s, quiet 5s. THE DEBOUNCE HAS TO OUTLAST THE GAP the burst case leaves
  # between its two halves (2s) or two pushes is the CORRECT answer there — and it has to
  # be shorter than the 6s each case waits before it starts, or one case's push suppresses
  # the next case's and every later assertion passes for the wrong reason. Both directions
  # were measured: at debounce=1 the burst case was red on correct code, and the mutation
  # that deletes the debounce was red for that same reason rather than its own.
  pu_cfg 4 5
  : > "$PU/ok.jsonl"; : > "$PU/gone.jsonl"
  # Two fake push services: one that accepts, one that answers 410 Gone. Both directions of
  # pruning in one event — the dead endpoint has to go and the live one has to stay, and a
  # pruner that dropped both would look identical from the "it was removed" side.
  node "$ROOT/test/helpers/push-probe.mjs" --port "$OKPORT"   --status 201 --sub "$PU/sub-ok.json"   --out "$PU/ok.jsonl"   > "$PU/probe-ok.log" 2>&1 &
  SERVE_PIDS="$SERVE_PIDS $!"
  node "$ROOT/test/helpers/push-probe.mjs" --port "$GONEPORT" --status 410 --sub "$PU/sub-gone.json" --out "$PU/gone.jsonl" > "$PU/probe-gone.log" 2>&1 &
  SERVE_PIDS="$SERVE_PIDS $!"
  pu > "$PU/serve.log" 2>&1 &
  SERVE_PIDS="$SERVE_PIDS $!"
  pu_up=0
  i=0; while [ "$i" -lt 80 ]; do
    curl -s -m1 "$PUBASE/healthz" >/dev/null 2>&1 && { pu_up=1; break; }
    i=$((i+1)); sleep 0.1
  done
  if [ "$pu_up" = 0 ]; then
    bad "the push daemon comes up" "listening on $PUBASE" "$(tr '\n' ' ' < "$PU/serve.log" | cut -c1-160)"
  elif ! { [ -f "$PU/sub-ok.json" ] && [ -f "$PU/sub-gone.json" ]; }; then
    bad "the fake push services come up" "two subscription files" "$(ls "$PU" | tr '\n' ' ')"
  else
    # ── the subscription is a credential ────────────────────────────────────
    node "$ROOT/test/helpers/serve-probe.mjs" "$PUBASE" push "$(pu enroll phone | grep -oE '[A-Z0-9]{5}-[A-Z0-9]{5}')" "$PU/sub-ok.json" \
      > "$PU/probe.push" 2>"$PU/probe.push.err"
    ppf() { grep -m1 "^$1$US" "$PU/probe.push" | cut -d "$US" -f2; }
    ppb() { grep -m1 "^$1$US" "$PU/probe.push" | cut -d "$US" -f3; }
    TOK="$(ppb token | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')"
    is "the VAPID key needs a live token"      "401" "$(ppf subscribe.noToken)"
    is "the key is offered to a real one"      "200" "$(ppf key)"
    is "keys are required"                     "400" "$(ppf subscribe.noKeys)"
    is "a non-https endpoint is refused"       "400" "$(ppf subscribe.httpEndpoint)"
    is "a short auth secret is refused"        "400" "$(ppf subscribe.shortAuth)"
    is "a real subscription is taken"          "201" "$(ppf subscribe.ok)"
    is "...and the client can see it"          "1"   "$(ppb key.after | grep -c '"subscribed":1' || true)"
    is "a token was minted for the rest"       "43"  "${#TOK}"

    # ── ONE: a worker blocked on him, with nobody looking ──────────────────
    # THE PROBE ABOVE WAS A POLL. Its last request was a GET, which is exactly the signal
    # the sender reads as "he is looking at it" — so the first delivery case has to wait
    # out the quiet window, or it measures the suppression it is not testing yet. Found by
    # this assertion going red for the right reason.
    sleep 6
    : > "$PU/ok.jsonl"
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2                                    # let the scan take a baseline
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 need-you
    if pu_wait "$PU/ok.jsonl" 1; then
      is "a need-you reaches the phone"        "1" "$(pu_lines "$PU/ok.jsonl")"
      is "...encrypted the way iOS requires"   "aes128gcm" "$(pu_field "$PU/ok.jsonl" content_encoding)"
      is "...with a VAPID JWT that VERIFIES"   "verified"  "$(pu_field "$PU/ok.jsonl" vapid.sig)"
      is "...signed ES256"                     "ES256"     "$(pu_field "$PU/ok.jsonl" vapid.alg)"
      is "...for the push service's origin"    "http://127.0.0.1:$OKPORT" "$(pu_field "$PU/ok.jsonl" vapid.aud)"
      is "...and a record delimiter of 0x02"   "2"         "$(pu_field "$PU/ok.jsonl" delimiter)"
      is "the payload says what happened"      '{"v":1,"kind":"needs-you","n":1,"at":AT,"sessions":[{"project":"demo","session":"api-2","kind":"needs-you"}]}' \
         "$(pu_payload "$PU/ok.jsonl" | sed 's/"at":[0-9]*/"at":AT/')"
      # THE WHOLE OF HIS STATED REQUIREMENT, and structural rather than a spot check: the
      # payload's key set is fixed, so there is no field a sentence could live in. The
      # status file that produced this push carried a transcript path naming a client and
      # a note with a DATABASE_URL in it; neither has anywhere to go.
      is "...and carries no other keys"        '["at","kind","n","sessions","v"]' \
         "$(pu_payload "$PU/ok.jsonl" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(Object.keys(JSON.parse(d)).sort())))')"
      is "...nor any nested ones"              '["kind","project","session"]' \
         "$(pu_payload "$PU/ok.jsonl" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(Object.keys(JSON.parse(d).sessions[0]).sort())))')"
      is "NO transcript path in the payload"   "0" "$(pu_field "$PU/ok.jsonl" payload_text | grep -c 'SECRET-CLIENT-NAME' || true)"
      is "NO note text in the payload"         "0" "$(pu_field "$PU/ok.jsonl" payload_text | grep -c 'DATABASE_URL\|postgres' || true)"
      is "...and no cwd either"                "0" "$(pu_field "$PU/ok.jsonl" payload_text | grep -c '/x/' || true)"
    else
      bad "a need-you reaches the phone" "1 push" "$(pu_lines "$PU/ok.jsonl") — daemon log: $(tr '\n' ' ' < "$PU/serve.log" | tail -c 200)"
    fi

    # ── TWO: he is holding the phone, so say nothing ────────────────────────
    # The suppression has to happen BEFORE the send. A worker that decides not to show a
    # notification can cost the subscription on iOS, so "he is already looking" is a
    # decision only the server can take — and the signal is the poll it just served.
    #   THE WAIT IS LOAD-BEARING: without it the previous case's push is still inside the
    # debounce window, and this case's silence would prove the cooldown works rather than
    # the suppression. Two mechanisms that produce the same zero have to be separated in
    # time or the assertion cannot say which one it caught.
    sleep 6
    : > "$PU/ok.jsonl"
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2
    curl -s -o /dev/null -m2 -H "Authorization: Bearer $TOK" "$PUBASE/api/health"
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 need-you
    sleep 3
    is "a poll a second ago means silence"     "0" "$(pu_lines "$PU/ok.jsonl")"
    # ...and the other direction on the same transition, or a sender that had simply
    # stopped working would look exactly like this.
    sleep 4                                    # older than quiet_after_poll (5s)
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 need-you
    if pu_wait "$PU/ok.jsonl" 1; then is "once he stops looking, it sends"  "1" "$(pu_lines "$PU/ok.jsonl")"
    else bad "once he stops looking, it sends" "1 push" "0"; fi

    # ── THREE: a NON-WORK profile, and the master's own turn ────────────────
    # Two of CLAUDE.md's scars in one assertion. A sender that watched only ~/.claude/fleet
    # would be silent here with no error anywhere; and the master's turns are exactly what
    # the inbox block in hooks/fleet-event.sh deliberately skips, which is why this reads
    # the status transition instead of that feed.
    : > "$PU/ok.jsonl"; sleep 6
    pu_status "$PU/home/.claude-personal/fleet" m1 cf-personal-pers master working
    sleep 2
    pu_status "$PU/home/.claude-personal/fleet" m1 cf-personal-pers master ready
    if pu_wait "$PU/ok.jsonl" 1; then
      is "a personal-profile session delivers" '{"v":1,"kind":"answer","n":1,"at":AT,"sessions":[{"project":"pers","session":"master","kind":"answer"}]}' \
         "$(pu_payload "$PU/ok.jsonl" | sed 's/"at":[0-9]*/"at":AT/')"
    else
      bad "a personal-profile session delivers" "1 push naming pers/master" "nothing — every profile's fleet dir has to be watched"
    fi

    # ── FOUR: five finishing over a few seconds is one buzz ────────────────
    # DELIBERATELY STRADDLING TWO SCANS. The first version flipped all five at once, and
    # that passes on the coalescing inside a single scan alone — proved by deleting the
    # debounce and watching it stay green, which is the "a test that can only pass proves
    # nothing" case CLAUDE.md is about. Three, then a scan, then two more: the second
    # group is a separate tick and only the leading-edge cooldown can swallow it.
    : > "$PU/ok.jsonl"; sleep 6
    for n in 1 2 3 4 5; do pu_status "$PU/home/.claude/fleet" b$n cf-demo bulk-$n working; done
    sleep 2
    for n in 1 2 3; do pu_status "$PU/home/.claude/fleet" b$n cf-demo bulk-$n ready; done
    sleep 2
    for n in 4 5; do pu_status "$PU/home/.claude/fleet" b$n cf-demo bulk-$n ready; done
    sleep 3
    is "a burst is ONE notification"           "1" "$(pu_lines "$PU/ok.jsonl")"
    is "...and it says more than one"          "1" "$(head -1 "$PU/ok.jsonl" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(/^[2-9]$/.test(String(JSON.parse(d).payload.n))?1:0)}catch{console.log(0)}})')"
    is "...naming at most four"                "1" "$(head -1 "$PU/ok.jsonl" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log((JSON.parse(d).payload.sessions||[]).length<=4?1:0)}catch{console.log(0)}})')"

    # ── FIVE: a dead endpoint is dropped, a live one is not ────────────────
    curl -s -o /dev/null -m2 -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      --data "$(cat "$PU/sub-gone.json")" "$PUBASE/api/push/subscribe"
    is "the daemon holds two endpoints now"    "2" \
       "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.clients[0].push||[]).length)' "$PU/serve.json")"
    : > "$PU/ok.jsonl"; : > "$PU/gone.jsonl"; sleep 6
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 ready
    pu_wait "$PU/gone.jsonl" 1 || true
    pu_wait "$PU/ok.jsonl" 1 || true
    sleep 1
    is "the 410 endpoint was tried"            "1" "$(pu_lines "$PU/gone.jsonl")"
    is "...and dropped"                        "1" \
       "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.clients[0].push||[]).length)' "$PU/serve.json")"
    is "...while the 201 endpoint survived"    "1" \
       "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=(c.clients[0].push||[]);console.log(p.length===1&&p[0].endpoint.includes(":'"$OKPORT"'")?1:0)' "$PU/serve.json")"

    # ── SIX: his names are HIS call, so it is a knob and not a code decision ─
    # §9's open question. His project names are client names and a lock screen is readable
    # by whoever is holding the phone, so the default names things and one flag stops it.
    is "the CLI reports the granularity"       "1" "$(pu push 2>&1 | grep -c '^detail     named' || true)"
    is "...and switches it"                    "1" "$(pu push --detail anonymous 2>&1 | grep -c "now 'anonymous'" || true)"
    is "...and refuses a third value"          "1" "$(pu push --detail loud 2>&1 | grep -c "takes 'named'" || true)"
    : > "$PU/ok.jsonl"; sleep 6
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 need-you
    if pu_wait "$PU/ok.jsonl" 1; then
      is "anonymous sends the count only"      '{"v":1,"kind":"needs-you","n":1,"at":AT}' \
         "$(pu_payload "$PU/ok.jsonl" | sed 's/"at":[0-9]*/"at":AT/')"
      is "...with no name anywhere in it"      "0" "$(pu_field "$PU/ok.jsonl" payload_text | grep -c 'demo\|api-2' || true)"
    else
      bad "anonymous sends the count only" "1 push" "0"
    fi
    pu push --detail named >/dev/null 2>&1

    # ── SEVEN: --test proves the whole path from the Mac ───────────────────
    : > "$PU/ok.jsonl"
    is "push --test posts a real one"          "1" "$(pu push --test 2>&1 | grep -c 'accepted; the phone should buzz' || true)"
    is "...and it arrives decryptable"         "push-test" "$(pu_wait "$PU/ok.jsonl" 1 && pu_field "$PU/ok.jsonl" payload.sessions.0.session)"

    # ── EIGHT: revoking the device takes its push with it ──────────────────
    # A revoked phone that kept buzzing would be the one surface where fleet state still
    # reached a device that can no longer read it.
    pu revoke phone >/dev/null 2>&1
    is "revoke drops the subscriptions"        "0" \
       "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.clients[0].push||[]).length)' "$PU/serve.json")"
    : > "$PU/ok.jsonl"; sleep 6
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 working
    sleep 2
    pu_status "$PU/home/.claude/fleet" w1 cf-demo api-2 need-you
    sleep 3
    is "...and nothing is sent after that"     "0" "$(pu_lines "$PU/ok.jsonl")"
  fi
  rm -rf "$PU"
fi

group "fleet-serve asserts Tailscale Funnel is off"
# §11.1: Funnel is the one setting that would undo all of §5, "and it should be asserted,
# not remembered". Three directions, because two of them look alike from outside: on
# (refuse), off (start), and no CLI at all (say UNVERIFIED rather than pass).
mkdir -p "$SV/shim" "$SV/noshim"
cat > "$SV/shim/tailscale" <<'STUB'
#!/bin/sh
case "$*" in "serve status --json") echo '{"AllowFunnel":{"host.example.ts.net:443":true}}' ;; *) echo '{}' ;; esac
STUB
chmod +x "$SV/shim/tailscale"
# Bounded, because the whole point is that this invocation must DIE. Run it straight and
# it hangs the suite the moment the guard is missing — a red assertion wearing a hang, and
# a hang is not a test result. Verified by removing the refusal: it went red here.
( PATH="$SV/shim:$PATH" HOME="$SV/home" TMUX= node "$SV/bin/fleet-serve.mjs" >"$SV/funnel.out" 2>&1; echo "rc=$?" >>"$SV/funnel.out" ) &
fpid=$!
i=0; while [ "$i" -lt 60 ] && kill -0 $fpid 2>/dev/null; do i=$((i+1)); sleep 0.1; done
kill $fpid 2>/dev/null; wait $fpid 2>/dev/null
out="$(cat "$SV/funnel.out" 2>/dev/null)"
is "funnel on: it refuses to start"    "1" "$(printf '%s' "$out" | grep -c 'Funnel is ON' || true)"
is "funnel on: nonzero exit"           "1" "$(printf '%s' "$out" | grep -c 'rc=1' || true)"
cat > "$SV/shim/tailscale" <<'STUB'
#!/bin/sh
echo '{}'
STUB
chmod +x "$SV/shim/tailscale"
is "funnel off: check passes it"       "1" \
   "$(PATH="$SV/shim:$PATH" HOME="$SV/home" TMUX= node "$SV/bin/fleet-serve.mjs" check 2>&1 | grep -c 'funnel     off (asserted)' || true)"
is "no CLI: reported UNVERIFIED"       "1" \
   "$(PATH="$SV/noshim" HOME="$SV/home" TMUX= "$(command -v node)" "$SV/bin/fleet-serve.mjs" check 2>&1 | grep -c 'funnel     unverified' || true)"
is "...and never as a pass"            "0" \
   "$(PATH="$SV/noshim" HOME="$SV/home" TMUX= "$(command -v node)" "$SV/bin/fleet-serve.mjs" check 2>&1 | grep -c 'funnel     off' || true)"

group "fleet-serve holds a sleep inhibitor while it runs"
# CAN this box arm one at all? `command -v systemd-inhibit` says the binary exists, which
# is a different question from whether logind will grant a --mode=block lock, and the
# gap between the two is where the two assertions below spent two CI runs being red for
# somebody else's reason. Ask by doing it: hold one over `true`. --why deliberately
# carries no `awake-` marker, so this can never be picked up as a real hold by the
# pgrep patterns in this group or by fleet-awake's own dedupe.
can_arm_here() {
  command -v caffeinate >/dev/null 2>&1 && return 0
  command -v systemd-inhibit >/dev/null 2>&1 || return 1
  systemd-inhibit --what=sleep --who=ghostfleet-test --why='suite probe ' \
    --mode=block true >/dev/null 2>&1
}
# §8: this Mac is set to sleep after one minute idle ON AC, and the fleet survives only
# because ttyskeepawake holds it up while tmux ttys are active. A daemon nobody is
# attached to has no tty, so it holds its own — through bin/fleet-awake, which already
# carries the macOS/Linux/other guard. Proven by asking the OS, and specifically for OUR
# pid: this machine had an unrelated inhibitor running the whole time, and the first cut
# of the check reported that one and read as a pass no matter what it did.
if command -v caffeinate >/dev/null 2>&1 || command -v systemd-inhibit >/dev/null 2>&1; then
  HOME="$SV/home" TMUX= CLAUDE_FLEET_AWAKE=on node "$SV/bin/fleet-serve.mjs" > "$SV/log.awake" 2>&1 &
  apid=$!
  i=0; while [ "$i" -lt 60 ] && kill -0 "$apid" 2>/dev/null \
        && ! grep -q 'awake:' "$SV/log.awake" 2>/dev/null; do i=$((i+1)); sleep 0.2; done
  # A DAEMON THAT NEVER STARTED READS AS AN INHIBITOR THAT NEVER FIRED: both assertions
  # below come back `expected 1, got 0` when the process died on its first line, and
  # neither one mentions the process. That is how the coloured-port bug spent its life
  # being reported as a broken sleep inhibitor. Ask the prior question first, and quote
  # the daemon.
  if ! grep -q 'awake:' "$SV/log.awake" 2>/dev/null; then
   bad "the daemon under test starts" "an awake: line in its log" \
       "$(tr '\n' ' ' < "$SV/log.awake" 2>/dev/null | cut -c1-180)"
   skip "fleet-serve inhibitor" "the daemon never got as far as arming one"
   kill $apid 2>/dev/null
  elif can_arm_here; then
   is "it reports holding one for its pid" "1" "$(grep -c "awake: holding .* for pid $apid " "$SV/log.awake" || true)"
   is "the OS agrees an inhibitor exists" "1" \
      "$( (pgrep -f "caffeinate .*-w $apid" >/dev/null 2>&1 || pgrep -f "systemd-inhibit .*awake-$apid " >/dev/null 2>&1) && echo 1 || echo 0)"
   kill $apid 2>/dev/null; sleep 1
   is "and it is released when we stop"    "0" \
      "$( (pgrep -f "caffeinate .*-w $apid" >/dev/null 2>&1 || pgrep -f "systemd-inhibit .*awake-$apid " >/dev/null 2>&1) && echo 1 || echo 0)"
  else
   # HAVING THE BINARY IS NOT BEING ALLOWED TO USE IT, and for two CI runs those two
   # states were indistinguishable here: both assertions above came back `expected 1,
   # got 0` on ubuntu-latest and read as a broken inhibitor in our code. It is not ours.
   # logind answers `Failed to inhibit: Access denied` to every --mode=block arm on that
   # box, for every --what, because the caller belongs to no login session
   # (`loginctl list-sessions` → "No sessions"), and systemd-inhibit is armed with its
   # stderr discarded, so it dies instantly and silently.
   #
   # Note WHICH of the four assertions used to pass there: "released when we stop" and
   # "off holds none", both of which expect ZERO inhibitors and got zero from a machine
   # that could never have had one. Two greens measuring nothing, which is the exact
   # shape this suite writes both-directions tests to refuse.
   #
   # So skip the two that this box cannot answer, and assert the one it can — that the
   # daemon SAYS it could not arm one instead of going quiet. That assertion is only
   # reachable on a box like this, which is why it lives here and not with the stubbed
   # groups in §5.
   is "the daemon says it could not arm one" "1" \
      "$(grep -c 'no inhibitor could be armed' "$SV/log.awake" || true)"
   is "...and never claims a hold it lacks"  "0" \
      "$(grep -c "awake: holding " "$SV/log.awake" || true)"
   skip "fleet-serve inhibitor" "logind refuses to inhibit on this box — no login session"
   kill $apid 2>/dev/null; sleep 1
  fi
  # off must mean off, or "on" proves nothing
  HOME="$SV/home" TMUX= CLAUDE_FLEET_AWAKE=off node "$SV/bin/fleet-serve.mjs" > "$SV/log.awakeoff" 2>&1 &
  bpid=$!
  i=0; while [ "$i" -lt 40 ] && ! grep -q 'awake:' "$SV/log.awakeoff" 2>/dev/null; do i=$((i+1)); sleep 0.2; done
  is "CLAUDE_FLEET_AWAKE=off holds none" "0" \
     "$( (pgrep -f "caffeinate .*-w $bpid" >/dev/null 2>&1 || pgrep -f "systemd-inhibit .*awake-$bpid " >/dev/null 2>&1) && echo 1 || echo 0)"
  kill $bpid 2>/dev/null
else
  skip "fleet-serve inhibitor" "no caffeinate or systemd-inhibit on this platform"
fi

group "fleet-serve serves the client, and says when there is none"
# The repo-vs-runtime trap: cf-sync mirrors a hardcoded dir list, and web/ was not on it,
# so a staged runtime had no client at all while the repo looked perfect. Reported once at
# boot rather than as a 404 per request, which reads as the client's bug.
# ITS OWN DAEMON, not a log some other group happened to leave behind. This read
# $SV/log.json — written by the "reads proxy the grid" group four groups up — so when that
# group's daemon could not start, the failure surfaced HERE, on an assertion about web/,
# in a group whose own daemon was fine. A red line has to point at its own subject.
if sv_start noweb; then
  is "no web/ dir: named at startup"   "1" "$(grep -c 'client: NONE at' "$SV/log.noweb" || true)"
  serve_stop
else
  skip "fleet-serve no-client notice" "server did not come up: $SV_WHY"
fi
mkdir -p "$SV/web"; printf '<p>hi</p>' > "$SV/web/index.html"; printf 'export const x=1;\n' > "$SV/web/app.js"
if sv_start web; then
  is "web/ present: named at startup"  "1" "$(grep -c "client: $SV/web" "$SV/log.web" || true)"
  is "index.html is served"            "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
  # An ES module served as text/plain is REFUSED by the browser, and the failure looks
  # like a blank page rather than like a MIME error.
  is ".js is text/javascript"          "1" "$(curl -s -D- -o /dev/null "$BASE/app.js" 2>/dev/null | grep -ci 'content-type: text/javascript' || true)"
  is "...and never text/plain"         "0" "$(curl -s -D- -o /dev/null "$BASE/app.js" 2>/dev/null | grep -ci 'content-type: text/plain' || true)"
  is "the shell needs no token"        "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.html")"
  is "...but the API still does"       "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects")"
  # 404, not 403: node's URL parser collapses ../ before serveStatic ever sees it, so the
  # plain spelling never reaches the prefix check. That is exactly why the ENCODED one is
  # the assertion that matters — %2e%2e%2f survives that parse, and without the decode it
  # would resolve to a literal directory name, meaning the guard behind it could never
  # fire and would be indistinguishable from a working one.
  is "a ../ traversal gets nothing"    "404" "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/../serve.json")"
  is "an encoded traversal is refused" "403" "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/%2e%2e%2fserve.json")"
  is "...and the config never leaks"   "0"   "$(curl -s --path-as-is "$BASE/%2e%2e%2fserve.json" | grep -c 'rp_id' || true)"
  serve_stop
else
  skip "fleet-serve static" "server did not come up: $SV_WHY"
fi
# WEB IS IN THE LIST — asked as membership, not as the list's exact spelling. The first
# version grepped for the whole line, so it went red the day `lib` was legitimately added
# and reported it as "cf-sync no longer copies web", which is a false statement about a
# real change. A pinned string cannot tell an addition from a removal; membership can.
CFSYNC_D="$(sed -n 's/^for d in \(.*\); do$/\1/p' "$ROOT/bin/cf-sync" | head -1)"
is "cf-sync copies web/ to the runtime" "1" "$(printf '%s' " $CFSYNC_D " | grep -c ' web ' || true)"
is "...and bin, which carries the rest" "1" "$(printf '%s' " $CFSYNC_D " | grep -c ' bin ' || true)"

# ── cf-sync reports the truth about whether it synced ────────────────────────
# It used to run rsync and never look at the status — `set -uo pipefail` has no `-e` — so
# a denied directory printed rsync's error and then "cf-sync: synced runtime" right after
# it, exit 0. Seen live when TCC denied web/. That is the repo-vs-runtime trap with its
# only safeguard inverted: the success line is what you check to conclude the runtime is
# current, so it was asserting the trap had not happened while it had.
#
# Behavioural, not grep: every existing cf-sync assertion greps the source for a string,
# which cannot tell whether the exit status is acted on. These run the real script.
group "cf-sync tells the truth about a failed sync"
CS="$(mktemp -d)"
mkdir -p "$CS/repo/bin" "$CS/repo/web"
printf '#!/bin/sh\necho hi\n' > "$CS/repo/bin/thing"; chmod +x "$CS/repo/bin/thing"
printf 'x\n' > "$CS/repo/web/index.html"

# the happy path first, so a later failure is known to be the change and not the setup
out_ok="$(CLAUDE_FLEET_HOME="$CS/rt" "$ROOT/bin/cf-sync" "$CS/repo" 2>&1)"; rc_ok=$?
is "a good sync exits 0"                 "0"   "$rc_ok"
is "...and says it synced"               "1"   "$(printf '%s' "$out_ok" | grep -c 'synced runtime' || true)"
is "...and the file is really there"      "hi"  "$(sh "$CS/rt/bin/thing" 2>/dev/null)"
is "...and the exec bit survived"         "yes" "$([ -x "$CS/rt/bin/thing" ] && echo yes || echo no)"

# Now deny ONE directory and leave the rest fine — the shape of the live failure, and the
# one that matters: a partial sync is the state that runs half-new code.
#
# The denial is on the SOURCE, which is both the real case (TCC guards ~/Documents, which
# is the entire reason this script exists) and the only one that works: denying the
# DESTINATION does not fail, because `rsync -a` preserves the source's permissions and
# resets the mode you set. Measured — chmod 500 on the dest syncs happily, exit 0, while
# chmod 000 on the source gives rsync exit 23 and the same "Permission denied" line seen
# live. A failure injection that does not inject is a test that proves nothing.
chmod 000 "$CS/repo/web"
# Whether the denial TOOK has to be decided WITHOUT asking cf-sync, or the guard becomes
# the bug's alibi: gating on `rc_bad = 0` reads a broken cf-sync as "cannot deny here" and
# SKIPS — and a skip exits 0, so the suite stays green with the defect present. Watched
# that happen on the way in. `ls` answers the question independently.
if ls "$CS/repo/web" >/dev/null 2>&1; then
  chmod 700 "$CS/repo/web" 2>/dev/null || true
  skip "cf-sync failure path" "this user can read a 000 dir (root?), cannot deny the source"
else
  out_bad="$(CLAUDE_FLEET_HOME="$CS/rt2" "$ROOT/bin/cf-sync" "$CS/repo" 2>&1)"; rc_bad=$?
  chmod 700 "$CS/repo/web" 2>/dev/null || true
  is "a failed sync exits non-zero"        "yes" "$([ "$rc_bad" -ne 0 ] && echo yes || echo no)"
  # THE BUG. Before the fix this printed both rsync's error AND the success line.
  is "...and NEVER claims it synced"       "0"   "$(printf '%s' "$out_bad" | grep -c 'synced runtime' || true)"
  is "...and names the directory"          "1"   "$(printf '%s' "$out_bad" | grep -c 'FAILED to sync web/' || true)"
  is "...and warns the runtime is a mix"   "1"   "$(printf '%s' "$out_bad" | grep -c 'MIX of old and new' || true)"
  # the dirs it COULD do are still done, which is why "do not trust it" is the wording
  is "...while the dirs it could do landed" "hi" "$(sh "$CS/rt2/bin/thing" 2>/dev/null)"
  # the retry has to know where to sync from, so the pointer is written even on failure
  is "...and .source is still recorded"    "$CS/repo" "$(cat "$CS/rt2/.source" 2>/dev/null)"
fi
chmod 700 "$CS/rt2/web" 2>/dev/null || true
rm -rf "$CS"

# ── the runtime knows WHICH commit it is, and the control plane says when it is behind ──
# Seen live: four PRs merged, nobody ran cf-sync, and ~/.local/libexec/ghostfleet served
# the PRE-FIX fleet-grid.mjs, fleet-stack, ghostfleet and fleet-awake for about an hour
# while the git repo was current. Nothing anywhere said so. On macOS the difference was
# invisible; on any box with tmux <= 3.5 the stale grid parser IS the bug #68 had just
# fixed. CLAUDE.md opens with "editing a file changes nothing until it's synced" and the
# repo could not tell you when it hadn't been.
#
# BOTH DIRECTIONS MATTER MORE THAN USUAL HERE. A warning that fires on a current runtime
# gets ignored, and an ignored warning is worse than none — so the silent cases are
# asserted as hard as the loud one, and asserted as EXACTLY empty rather than "does not
# match": a wrong line on stdout is the failure mode, whatever it says. And silence must
# never be reachable by claiming "in sync": every uncertain case (no stamp, no source, not
# a checkout, a source that is gone, a stamp about a different source) is silence with no
# claim attached, which is why none of these assert a positive message.
group "stale runtime warning"
if ! command -v git >/dev/null 2>&1; then
  skip "stale runtime warning" "git is not installed"
else
  # pwd -P for the same reason §0 uses it: /tmp and /var here are symlinks, cf-sync
  # records the path it was HANDED, and two spellings of one directory is the trap that
  # already cost this repo a config key nothing could find.
  SY="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$SY/repo/bin" "$SY/repo/hooks"
  printf '#!/bin/sh\necho one\n' > "$SY/repo/bin/thing"
  # The fixture repo carries the REAL control plane, because that is how the runtime gets
  # one: cf-sync mirrors bin/ with --delete, so a copy dropped into the runtime by hand is
  # deleted by the next sync — which is exactly what happened to the first version of this
  # group, and it looked like the reader was broken rather than the fixture.
  cp "$ROOT/bin/ghostfleet" "$SY/repo/bin/ghostfleet"
  # A CI runner has no git identity and a developer's box may sign commits by default;
  # both would fail `git commit` here for reasons that have nothing to do with the code.
  git -C "$SY/repo" init -q .                      2>/dev/null
  git -C "$SY/repo" config user.email t@t.invalid  2>/dev/null
  git -C "$SY/repo" config user.name  suite        2>/dev/null
  git -C "$SY/repo" config commit.gpgsign false    2>/dev/null
  gitc() { git -C "$SY/repo" add -A >/dev/null 2>&1; git -C "$SY/repo" commit -qm "$1" >/dev/null 2>&1; }
  gitc "first"
  if ! git -C "$SY/repo" rev-parse HEAD >/dev/null 2>&1; then
    skip "stale runtime warning" "git in this environment cannot commit"
  else
    # The stamp under test is written by the REAL cf-sync, not forged here: a hand-written
    # fixture would keep passing after the writer stopped agreeing with the reader.
    CLAUDE_FLEET_HOME="$SY/rt" "$ROOT/bin/cf-sync" "$SY/repo" >/dev/null 2>&1
    is "a sync stamps the commit it copied" "$(git -C "$SY/repo" rev-parse HEAD)" \
       "$(head -1 "$SY/rt/.synced" 2>/dev/null)"
    is "...and names the source it read"    "$SY/repo" \
       "$(sed -n 's/^source //p' "$SY/rt/.synced" 2>/dev/null)"
    is "...and dates it for a human"        "1" \
       "$(grep -c '^synced 20[0-9][0-9]-' "$SY/rt/.synced" 2>/dev/null || true)"

    # The control plane resolves its runtime root from its OWN location, so the copy under
    # test is the one the sync just installed, in the runtime. A symlink would resolve back
    # into the repo — correct for ~/.local/bin/ghostfleet, wrong for the runtime root, and
    # that difference is the whole subject of this group.
    RTG="$SY/rt/bin/ghostfleet"
    is "the sync delivered the control plane" "yes" "$([ -x "$RTG" ] && echo yes || echo no)"
    # Not named sc(): §2 already defines one for split_choice, and redefining a
    # suite-wide helper here would silently hand every later caller of it this function.
    synccheck() { bash "$RTG" --sync-check 2>&1; }

    # DIRECTION 1: level with the repo, one second after a real sync.
    is "a fresh sync warns about nothing"   ""    "$(synccheck)"

    # DIRECTION 2: the repo moves and the runtime does not.
    printf '#!/bin/sh\necho two\n' > "$SY/repo/bin/thing"; gitc "second"
    out1="$(synccheck)"
    is "one commit behind is reported"      "1"   "$(printf '%s' "$out1" | grep -c 'runtime is 1 commit behind' || true)"
    is "...singular, not '1 commits'"       "0"   "$(printf '%s' "$out1" | grep -c '1 commits' || true)"
    is "...and it names the fix"            "1"   "$(printf '%s' "$out1" | grep -c 'run cf-sync' || true)"
    is "...and the commit it is stuck on"   "1"   "$(printf '%s' "$out1" | grep -c "synced $(git -C "$SY/repo" rev-parse --short=7 HEAD~1)" || true)"
    gitc_more() { printf '%s\n' "$1" > "$SY/repo/bin/thing"; gitc "$1"; }
    gitc_more three; gitc_more four
    is "the count follows the repo"         "1"   "$(synccheck | grep -c 'runtime is 3 commits behind' || true)"
    is "...on ONE line, quietly"            "1"   "$(synccheck | wc -l | tr -d ' ')"

    # A sync clears it. This is the assertion that proves the two halves are the same
    # mechanism rather than two settings that happen to agree.
    CLAUDE_FLEET_HOME="$SY/rt" "$ROOT/bin/cf-sync" "$SY/repo" >/dev/null 2>&1
    is "syncing again silences it"          ""    "$(synccheck)"

    # DIRECTION 3: every uncertain case, each asserted as EXACTLY silent. None of them may
    # be reached by concluding "in sync" — there is no such conclusion in the code, which
    # is what these are really pinning down.
    cp "$SY/rt/.synced" "$SY/keep.synced"
    gitc_more five                                  # so a WRONG answer would be a warning
    # 'behind the repo', not 'commits behind': one commit is SINGULAR, and a pattern that
    # only matches the plural silently stops testing the very state it is setting up.
    is "behind again, so the rest is meaningful" "1" "$(synccheck | grep -c 'behind the repo' || true)"
    mv "$SY/rt/.synced" "$SY/rt/.synced.off"
    is "no stamp: silence, not a verdict"   ""    "$(synccheck)"
    mv "$SY/rt/.synced.off" "$SY/rt/.synced"
    mv "$SY/rt/.source" "$SY/rt/.source.off"
    is "no recorded source: silence"        ""    "$(synccheck)"
    mv "$SY/rt/.source.off" "$SY/rt/.source"
    printf '%s\n' "$SY/gone" > "$SY/rt/.source"
    is "the source is gone: silence"        ""    "$(synccheck)"
    mkdir -p "$SY/notarepo"; printf '%s\n' "$SY/notarepo" > "$SY/rt/.source"
    is "the source is not a checkout: silence" ""  "$(synccheck)"
    printf '%s\n' "$SY/repo" > "$SY/rt/.source"
    # A stamp ABOUT ANOTHER SOURCE cannot be measured against this one. install.sh really
    # does produce that pair: it puts a clone's pointer back after an npx-cache install.
    sed 's|^source .*|source '"$SY"'/elsewhere|' "$SY/keep.synced" > "$SY/rt/.synced"
    is "stamp names a different source: silence" "" "$(synccheck)"
    # Not a sha. `rev-parse HEAD` in a repo with an unborn HEAD prints the word HEAD, and a
    # stamp holding it would compare unequal forever — a warning nothing could ever clear.
    { echo HEAD; echo "source $SY/repo"; } > "$SY/rt/.synced"
    is "a stamp that is not a sha: silence" ""    "$(synccheck)"
    # A sha this repo has never heard of: measurable-looking, not measurable. It must not
    # come out as "0 commits behind", which is the shape a naive count would print.
    { echo 0123456789abcdef0123456789abcdef01234567; echo "source $SY/repo"; } > "$SY/rt/.synced"
    out2="$(synccheck)"
    is "an unknown commit says so"          "1"   "$(printf '%s' "$out2" | grep -c "not in this repo's HEAD" || true)"
    is "...and never says 0 commits behind" "0"   "$(printf '%s' "$out2" | grep -c '0 commits behind' || true)"

    # A PARTIAL sync leaves $DEST holding neither commit, so the stamp must be REMOVED and
    # not left at its previous value: a stale value is a specific, wrong distance reported
    # for a directory whose contents nothing knows.
    cp "$SY/keep.synced" "$SY/rt/.synced"; printf '%s\n' "$SY/repo" > "$SY/rt/.source"
    chmod 000 "$SY/repo/hooks" 2>/dev/null || true
    if ls "$SY/repo/hooks" >/dev/null 2>&1; then
      chmod 755 "$SY/repo/hooks" 2>/dev/null || true
      skip "a failed sync drops the stamp" "this user can read a 000 dir (root?)"
    else
      CLAUDE_FLEET_HOME="$SY/rt" "$ROOT/bin/cf-sync" "$SY/repo" >/dev/null 2>&1
      chmod 755 "$SY/repo/hooks" 2>/dev/null || true
      is "a failed sync drops the stamp"    "no"  "$([ -e "$SY/rt/.synced" ] && echo yes || echo no)"
      is "...and the runtime then says nothing" "" "$(synccheck)"
    fi

    # A source with no commits to name gets no stamp either — and an older stamp is about
    # code that is no longer in the runtime, so it goes. Into a SECOND runtime dir: this
    # sync would mirror bin/ from a source that has no control plane in it, and deleting
    # the copy under test three assertions before the end is a way to fail that says
    # nothing about the code.
    mkdir -p "$SY/plain/bin" "$SY/rt2"; printf 'x\n' > "$SY/plain/bin/f"
    cp "$SY/keep.synced" "$SY/rt2/.synced"
    CLAUDE_FLEET_HOME="$SY/rt2" "$ROOT/bin/cf-sync" "$SY/plain" >/dev/null 2>&1
    is "a non-git source leaves no stamp"   "no"  "$([ -e "$SY/rt2/.synced" ] && echo yes || echo no)"

    # ORDERING. --sync-check answers above the tmux/node requirement checks and above the
    # sleep inhibitor, because a status question must not need a terminal multiplexer and
    # must NOT arm caffeinate/systemd-inhibit on whatever machine asked. Proved by a
    # fleet-awake that would leave a trace if it were reached.
    printf '#!/bin/sh\ntouch "%s/awake-was-armed"\n' "$SY" > "$SY/rt/bin/fleet-awake"
    chmod +x "$SY/rt/bin/fleet-awake"
    CLAUDE_FLEET_AWAKE=display bash "$RTG" --sync-check >/dev/null 2>&1
    is "--sync-check arms no inhibitor"     "no"  "$([ -e "$SY/awake-was-armed" ] && echo yes || echo no)"
    # PATH without tmux: the answer still comes, so the check cannot be gated behind a
    # requirement it does not have.
    mkdir -p "$SY/nobin"
    printf '%s\n' "$SY/repo" > "$SY/rt/.source"; cp "$SY/keep.synced" "$SY/rt/.synced"
    is "...and needs no tmux" "1" \
       "$(PATH="$SY/nobin:/usr/bin:/bin" bash "$RTG" --sync-check 2>&1 | grep -c 'behind the repo' || true)"
  fi
  rm -rf "$SY"
fi

# ── the client picks the right backend when the DAEMON is what served it ─────
# Found on a real phone: the client fleet-serve serves ran on fixtures, because `gf.base`
# unset meant "fixtures" and nothing ever set it. The phone showed four projects that do
# not exist on this machine, offered a local-only passkey, and never made one request —
# so `fleet-serve clients` said "(no clients enrolled)" and there was nothing to grep.
#
# The helper needs a LIVE daemon, so it runs here rather than in the web/ group below:
# the signal being relied on is a real 401 from a real fleet-serve with nothing enrolled,
# and the whole point is that this is measured and not assumed. It brings its own static
# servers for the other direction.
group "phone client: served by the daemon means talking to the daemon"
if sv_start origin; then
  PWO="$(mktemp -d "$TEST_RUNS.$$.pwo.XXXXXX")"
  node "$ROOT/test/helpers/pwa-origin.mjs" "$BASE" > "$PWO/out" 2> "$PWO/err"
  is "pwa-origin ran"                 "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PWO/err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the same reason as the two helpers below: this one `await import`s the
  # client and starts servers, and a helper that dies emits nothing — which in a
  # 1200-assertion run is indistinguishable from a group that passed.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PWO/out")" -ge 50 ] && echo yes || echo "no: $(wc -l < "$PWO/out") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PWO/out"

  # ── and the client has to RUN, and paint what it decided ──────────────────
  # `node --check` proves syntax, not that it runs (CLAUDE.md), and app.js has already met
  # that once: its boot block sat above the `const SHIP` the lock screen draws, so every
  # screen was blank from a ReferenceError in a file that parses perfectly. pwa-check's
  # answer is structural — declarations before statements — and this is the other half: a
  # 60-line DOM, app.js imported for real, and the painted text read back.
  node "$ROOT/test/helpers/pwa-render.mjs" "$BASE" > "$PWO/render" 2> "$PWO/render.err"
  is "pwa-render ran"                 "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PWO/render.err" | tr '\n' ' ' | sed 's/ *$//')"
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PWO/render")" -ge 28 ] && echo yes || echo "no: $(wc -l < "$PWO/render") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PWO/render"

  # ── and once it IS talking to the daemon, it has to be able to get in ──────
  # The other half of the same seam, found on the same phone: fleet-serve will not enrol a
  # passkey without a window opened from the terminal AND the one-time code it printed —
  # correctly, since the endpoint is remote code execution — and the client had no field
  # to type one into, so every registration was a guaranteed 403. Worse, api.js reported
  # `register → HTTP 403` and threw away the server's sentence, which is the only thing
  # that says what to do next.
  #
  # A NEW client id, not 'phone': the auth group above already enrolled that one, and
  # `fleet-serve enroll` refuses an id that already has a passkey — so reusing it would
  # hand the helper an empty code and fail for a reason that has nothing to do with the
  # client. The caps are the raised ones (sv_rate above); this spends about a dozen from
  # the `auth` bucket, since every ceremony starts with a challenge.
  PWE_CODE="$(sv_code pwaenrol)"
  is "an enrolment window opened"     "yes" "$([ -n "$PWE_CODE" ] && echo yes || echo no)"
  node "$ROOT/test/helpers/pwa-enrol.mjs" "$BASE" "$PWE_CODE" pwaenrol > "$PWO/enrol" 2> "$PWO/enrol.err"
  is "pwa-enrol ran"                  "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PWO/enrol.err" | tr '\n' ' ' | sed 's/ *$//')"
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PWO/enrol")" -ge 40 ] && echo yes || echo "no: $(wc -l < "$PWO/enrol") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PWO/enrol"
  # The client really is enrolled now, as far as the SERVER is concerned — asserted from
  # the other side, because the helper's own view of it is the client's.
  is "the daemon lists the phone as enrolled" "1" "$(sv_cli clients | grep -c '^pwaenrol *active *1' || true)"
  rm -rf "$PWO"
  serve_stop
else
  skip "phone client origin" "server did not come up: $SV_WHY"
fi

group "fleet-serve does not fork the dispatch"
# The whole point of mcp/fleet-dispatch.mjs: two callers of the fleet verbs, ONE copy of
# the argument validation that keeps a dropped key from reaching a worker as the word
# "undefined" (#38). A fleet-serve that shelled out to bin/fleet-* itself would pass every
# HTTP test above and quietly lose that.
is "fleet-serve imports the dispatch"   "1" \
   "$(grep -c "from '../mcp/fleet-dispatch.mjs'" "$ROOT/bin/fleet-serve.mjs" || true)"
is "the MCP server imports it too"      "1" \
   "$(grep -c "from './fleet-dispatch.mjs'" "$ROOT/mcp/fleet-mcp.mjs" || true)"
# The ONLY bin/ commands the daemon runs by hand are READS with no user input in them:
# the grid producer (§3), the sleep inhibitor (§8), and the agent registry, which answers
# `list`/`installed`/`caveat` — a static capability table with literal subcommands, where
# even `caveat <a>` is fed a name that came out of `list` itself. Every fleet VERB still
# goes through the shared planner, so an edit that shells out to fleet-send — or that
# hands one of these an argument off the wire — turns this red rather than passing
# quietly. The list is the assertion: a fourth name here has to be argued for.
is "it runs only reads, by hand" "fleet-agent fleet-awake fleet-grid.mjs" \
   "$(grep -oE "join\(BIN, '[^']+'" "$ROOT/bin/fleet-serve.mjs" | sed "s/.*'\(.*\)'/\1/" | sort -u | tr '\n' ' ' | sed 's/ $//')"
# ...and the registry really is fed literals. A request field reaching it would make the
# daemon a second, unvalidated entry point to a bin/ command, which is the whole thing
# mcp/fleet-dispatch.mjs exists to prevent.
is "...and the registry takes no wire input" "0" \
   "$(sed -n '/function agentCatalogue/,/^}/p' "$ROOT/bin/fleet-serve.mjs" | grep -cE 'req\.|url\.|rawArgs|body' || true)"
is "and every verb goes through it"      "1" \
   "$([ "$(grep -c 'callToolAsync(' "$ROOT/bin/fleet-serve.mjs" || true)" -ge 1 ] && echo 1 || echo 0)"
is "the MCP server no longer execs"      "0" \
   "$(grep -c 'execFileSync\|execFile(' "$ROOT/mcp/fleet-mcp.mjs" || true)"
# All six env vars, per target, in the ONE place that builds a child's environment.
for v in CLAUDE_FLEET_SOCK CLAUDE_CONFIG_DIR CLAUDE_FLEET_DIR CLAUDE_FLEET_PROFILE CLAUDE_FLEET_SCOPE CLAUDE_FLEET_ROOT; do
  is "the dispatch sets $v per target" "1" "$(grep -c "$v: " "$ROOT/mcp/fleet-dispatch.mjs" || true)"
done
# ── attachments: the first bytes this server ever writes to disk ─────────────
# "can I send a picture?", twice. docs/attachments.md measured that an agent given a PATH
# reads the pixels, so the feature is: put the file on this machine, put its path in the
# prompt. That makes /api/attach the first route in ghostfleet that writes externally
# supplied bytes anywhere, and most of what is asserted here is therefore refusals.
#   BOTH DIRECTIONS ON EVERY ONE. A server that refused everything would pass a file full
# of "is it refused?" rows while being useless, so each refusal is paired with the accept
# that proves the route works — and the accepted ones are checked on DISK, because a 201
# with a path in it is not evidence that a file exists.
group "fleet-serve: a photo becomes a file, and everything else is refused"
if sv_start attach; then
  node "$ROOT/test/helpers/serve-probe.mjs" "$BASE" attach "$(sv_code att)" > "$SV/probe.att" 2>"$SV/probe.att.err"
  is "attach-probe ran"                    ""    "$(head -2 "$SV/probe.att.err" | tr '\n' ' ' | sed 's/ *$//')"
  # AUTH: this route changes the filesystem, so it wants the same live token every other
  # mutating call does — and gets it from the central gate rather than its own.
  is "no token, no upload"                 "401" "$(pf attach.noToken att)"
  # ...and the same body with a token lands.
  is "a PNG is stored"                     "201" "$(pf attach.png att)"
  is "a JPEG is stored"                    "201" "$(pf attach.jpg att)"
  # THE FILE IS ON DISK, which the status code does not prove.
  apath="$(pb attach.png att | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).path||"")}catch{console.log("")}})')"
  is "...and the path it returned exists"  "yes" "$([ -n "$apath" ] && [ -f "$apath" ] && echo yes || echo "no: '$apath'")"
  is "...under the fleet dir, keyed by session" "yes" \
     "$(grep -q '/fleet/attach/[^/]*\.attachtest/' <<< "$apath" && echo yes || echo "no: $apath")"
  # THE PATH IS ABOUT TO BE PASTED INTO A TERMINAL. Nothing in it may be a character a
  # shell would read, and no component of it came from the client.
  is "...and holds nothing a shell would read" "yes" \
     "$(grep -qE '^[A-Za-z0-9._/-]+$' <<< "$apath" && echo yes || echo "no: $apath")"
  is "...with a server-generated name"     "yes" \
     "$(grep -qE '^[0-9a-f]{16}\.(jpg|png)$' <<< "$(basename "$apath" 2>/dev/null)" && echo yes || echo "no: $(basename "$apath" 2>/dev/null)")"
  is "...and is not group- or world-readable" "600" \
     "$(ls -l "$apath" 2>/dev/null | awk '{print $1}' | sed 's/^-//;s/rw-------/600/;s/[^0-9]*$//' | head -c3)"
  # SNIFFED, NOT DECLARED. SVG is refused BY NAME because it is an image that is also a
  # script container, and the refusal has to say so or somebody re-adds it as "just an
  # image format".
  is "an SVG is refused"                   "415" "$(pf attach.svg att)"
  is "...and says why, not just no"        "1"   "$(pb attach.svg att | grep -c 'script container' || true)"
  is "a text file is refused"              "415" "$(pf attach.junk att)"
  is "an empty body is refused"            "400" "$(pf attach.empty att)"
  # THE SESSION NAME IS A PATH COMPONENT FROM A PHONE. Refused by shape, so traversal
  # cannot be reached by a case somebody forgot to sanitise.
  is "traversal in the session is refused" "400" "$(pf attach.traversal att)"
  is "a slash in the session is refused"   "400" "$(pf attach.slash att)"
  is "a bare .. is refused"                "400" "$(pf attach.dots att)"
  is "an empty session is refused"         "400" "$(pf attach.emptySession att)"
  is "an unknown project is refused"       "400" "$(pf attach.badProject att)"
  # ...and nothing escaped while trying: no directory outside the attach root was made.
  is "nothing was written outside the key" "0" \
     "$(find "$SV/home/.claude/fleet/attach" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | grep -vc '\.attachtest$' || true)"
  # TOO BIG SAYS THE NUMBER. 7 MB decoded is inside the 8 MB body cap and outside the 6 MB
  # decoded limit, so this is the second check — the one the body cap cannot make.
  is "an oversized photo is refused"       "413" "$(pf attach.tooBig att)"
  is "...naming the limit rather than dying" "1" "$(pb attach.tooBig att | grep -c '6 MB' || true)"
  # ...and the OTHER ceiling, which is a different check in a different place: the body cap
  # fires while the bytes are still arriving, before anything is decoded. It has to answer
  # rather than drop the connection, which is what it used to do.
  is "a body past the cap is refused"      "413" "$(pf attach.pastCap att)"
  is "...and answers instead of dropping"  "1" "$(pb attach.pastCap att | grep -c 'request body' || true)"
  # AUDITED LIKE A MUTATION, because it is one: bytes exist that did not before.
  # Two, because two uploads landed — an exact count, so a route that audited only the
  # first or audited twice per call would both show up.
  is "both uploads are in the audit log"   "2" \
     "$(grep -c '"verb":"attach"' "$SV/audit.jsonl" 2>/dev/null || true)"
  serve_stop
else
  skip "attachments" "$SV_WHY"
fi

rm -rf "$SV"
fi
serve_stop

group "fleet-stop and fleet-clean agree on 'remove anyway'"
# The phone's `f = remove anyway` (§7) and the grid's are the same operation, so it lives
# in fleet-clean — the file that owns worktree removal and the rule about which gates may
# be skipped. fleet-stop delegates to it rather than running its own git.
out="$(TMUX= CLAUDE_FLEET_SOCK=cfforcetest "$ROOT/bin/fleet-stop" --force w1 2>&1; echo "rc=$?")"
is "fleet-stop --force needs --reclaim"  "1" "$(printf '%s' "$out" | grep -c 'only means something with --reclaim' || true)"
is "...and it exits nonzero"             "1" "$(printf '%s' "$out" | grep -c 'rc=1' || true)"
out="$(cd / && TMUX= CLAUDE_FLEET_SOCK=cfforcetest "$ROOT/bin/fleet-clean" --force --go 2>&1; echo "rc=$?")"
is "fleet-clean --force needs --only"    "1" "$(printf '%s' "$out" | grep -c 'needs --only' || true)"
is "...and it exits nonzero"             "1" "$(printf '%s' "$out" | grep -c 'rc=1' || true)"
is "fleet-stop delegates, not git"       "0" \
   "$(grep -c "git -C \"\$MAIN_CO\" worktree remove" "$ROOT/bin/fleet-stop" || true)"
is "...it calls fleet-clean --force"     "1" \
   "$(grep -c -- '--only "\$WT" --go --force' "$ROOT/bin/fleet-stop" || true)"


# ── 5z. the brief protocol: warn about a thin brief, and never refuse ────────
# The gate version of this was designed first and was WRONG, so the assertions here are
# shaped to hold the correction in place rather than to prove the feature works.
#
# It cannot be a gate because it would be a gate on a null result: of six brief features
# measured across this corpus — length, naming a file, naming a route, STATING A
# DONE-CRITERION, carrying a reference image, human-vs-lead authorship — all six sit in a
# 20-30% correction band with fully overlapping intervals. And its failure mode is this
# repo's dominant one: "Done when: implemented" passes any parser, so a gate would buy a
# field that looks disciplined while the decision the human never made stays unmade.
#
# So the load-bearing assertions are the NEGATIVE ones — exit status unchanged, the spawn
# still happens, the source of the warning contains no `exit` — because a later edit that
# "improves" this into a refusal would pass every positive assertion in the group.
group "fleet-spawn warns about a thin brief and dispatches anyway"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  BW="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$BW/home/.config/ghostfleet" "$BW/ok"
  # It PRINTS THE READY MARKER and then sleeps. fleet-spawn dispatches the initial prompt
  # only once the pane looks ready for input, so a pane that never says so would make the
  # dispatcher wait out its ~3min fallback and the "what the worker receives" assertion
  # below could not be written at all. `bypass permissions` is one of the real markers
  # fleet-spawn polls for.
  printf '#!/usr/bin/env bash\nprintf "bypass permissions\\n"\nsleep 60\n' > "$BW/ok/agent-here"
  chmod +x "$BW/ok/agent-here"
  # A fleet-send that records the message it was handed, so what the WORKER receives is
  # observable without a real Claude on the other end. First on PATH, so the backgrounded
  # dispatcher finds it instead of the real one.
  # KEYED BY TARGET SESSION, and that is not tidiness. Every spawn above leaves a
  # BACKGROUNDED dispatcher behind — fleet-spawn returns before it fires — so a single
  # shared path is written by whichever dispatcher happens to reach it, and a wait loop
  # that breaks on "the file is non-empty" can read another spawn's brief entirely.
  # Measured: with the marker deliberately removed, "the ask is still first" went red
  # against a message from a DIFFERENT spawn, which means the green run before it had
  # been passing on the same confusion. One file per target session; the case below uses
  # a session name no other case spawns.
  { echo '#!/usr/bin/env bash'
    echo 'while [ $# -gt 2 ]; do shift; done'
    echo 'printf "%s" "$2" > "'"$BW"'/sent.$1"'; } > "$BW/ok/fleet-send"
  chmod +x "$BW/ok/fleet-send"
  BWOUT=""; BWRC=0
  spawnbw() {                              # $@ = extra fleet-spawn args
    rm -rf "$BW/repo" "$BW/w1" "$BW/slots"; mkdir -p "$BW/fleet"
    git init -q -b main "$BW/repo" 2>/dev/null
    git -C "$BW/repo" config user.email t@t; git -C "$BW/repo" config user.name t
    : > "$BW/repo/f"; git -C "$BW/repo" add -A; git -C "$BW/repo" commit -qm init 2>/dev/null
    BWOUT="$( cd "$BW/repo" && HOME="$BW/home" env -u TMUX \
      CLAUDE_FLEET_SOCK=cfbrief CLAUDE_FLEET_DIR="$BW/fleet" CLAUDE_FLEET_SLOTS="$BW/slots" \
      PATH="$BW/ok:$ROOT/bin:$PATH" "$ROOT/bin/fleet-spawn" w1 --new "$@" 2>&1 )"; BWRC=$?
    tmux -L cfbrief kill-server 2>/dev/null
  }
  bwhas() { printf '%s' "$BWOUT" | grep -c -- "$1" 2>/dev/null || true; }
  briefrows() { [ -f "$BW/fleet/cfbrief.brief.tsv" ] && wc -l < "$BW/fleet/cfbrief.brief.tsv" | tr -d ' ' || echo 0; }

  # ── a thin brief: no done-criterion, one deliverable ──
  spawnbw --prompt 'Fix the parser so it stops dropping the last field'
  is "a brief with no done-criterion warns"   "1" "$(bwhas 'the brief is thin')"
  # THE MARKER IS A POSITION, NOT A SUBSTRING, and the anchor is the assertion. The item #5
  # evaluator identifies treated sessions by finding this at the HEAD of a line; its first
  # run classified a session as treated because the string appeared anywhere in it, and
  # that session was the one WRITING the marker — so the treated arm would have filled
  # with the treatment being built. Anchored here, or the anchoring is not tested.
  is "...and prints the verdict marker"       "1" "$(printf '%s' "$BWOUT" | grep -c '^brief-check: warn' || true)"
  is "...carrying the two fields it judged"   "1" \
     "$(printf '%s' "$BWOUT" | grep -c '^brief-check: warn done-criterion=no deliverables=1' || true)"
  # STDOUT, not stderr: mcp/fleet-dispatch.mjs returns stdout ALONE on the success path and
  # merges stderr in only when the command fails, so a marker on stderr would be invisible
  # to every dispatch through the fleet_spawn MCP tool — which is the path the orchestrate
  # skill tells a lead to prefer. Captured with stderr closed, which is the only way to
  # tell the two apart.
  BWSTDOUT="$( cd "$BW/repo" && HOME="$BW/home" env -u TMUX \
    CLAUDE_FLEET_SOCK=cfbrief CLAUDE_FLEET_DIR="$BW/fleet" CLAUDE_FLEET_SLOTS="$BW/slots" \
    PATH="$BW/ok:$ROOT/bin:$PATH" "$ROOT/bin/fleet-spawn" w9 --new \
    --prompt 'Fix the parser' 2>/dev/null )"
  tmux -L cfbrief kill-server 2>/dev/null
  is "...on STDOUT, where an MCP lead sees it" "1" "$(printf '%s' "$BWSTDOUT" | grep -c '^brief-check: warn' || true)"
  is "...and the teaching text with it"        "1" "$(printf '%s' "$BWSTDOUT" | grep -c 'the brief is thin' || true)"
  is "...and names what is missing"           "1" "$(bwhas 'NO DONE-CRITERION')"
  # The register borrowed from hooks/fleet-guard.sh: name the thing, say why it costs, hand
  # over the next action. A warning that only says "this is thin" is decoration.
  is "...and says why it costs something"     "1" "$(bwhas 'nothing to close')"
  is "...and hands over the eight axes"       "1" "$(bwhas 'NUMBERED LIST')"
  is "...naming the retroactivity axis"       "1" "$(bwhas 'RETROACTIVITY')"
  is "...and names the acknowledging half"    "1" "$(bwhas 'fleet-ack')"
  # THE HALF THAT MUST NOT REGRESS, and the reason this group exists at all.
  is "...and the exit status is still 0"      "0" "$BWRC"
  is "...and the spawn actually happened"     "1" "$(bwhas "started 'w1'")"
  is "...and the prompt is still dispatched"  "1" "$(bwhas 'will dispatch the initial prompt')"

  # ── the OTHER direction: a brief that says what done looks like, one deliverable ──
  # Without this the group would pass for a warning that fires on everything, which is
  # the same as a warning that fires on nothing.
  spawnbw --prompt 'Add the ASKED column to fleet-worktrees. Done when: the header prints ASKED beside UNDERSTOOD.'
  is "a brief with a done-criterion is quiet" "0" "$(bwhas 'the brief is thin')"
  # ...but NOT silent. The marker prints on EVERY dispatch, warned or not: a marker that
  # only appears when the machinery objected cannot separate a treated session that passed
  # from one the machinery never ran in, and the untreated arm would quietly absorb every
  # good brief.
  is "...but still prints an ok marker"       "1" "$(printf '%s' "$BWOUT" | grep -c '^brief-check: ok' || true)"
  is "...with the fields that earned it"      "1" \
     "$(printf '%s' "$BWOUT" | grep -c '^brief-check: ok done-criterion=yes deliverables=1' || true)"
  is "...and still spawns"                    "1" "$(bwhas "started 'w1'")"
  is "...with the same exit status"           "0" "$BWRC"

  # ── several deliverables ──
  spawnbw --prompt "$(printf 'Add the column\nUpdate the docs\nWrite a test\n')"
  is "three build verbs read as three"        "1" "$(bwhas 'READS AS 3 DELIVERABLES')"
  is "...and STILL does not refuse"           "0" "$BWRC"
  is "...and still spawns"                    "1" "$(bwhas "started 'w1'")"

  # A NUMBERED LIST IS PRESENTATION, NOT A DELIVERABLE COUNT — the objection that killed
  # the gate version, kept honest here. Acceptance criteria are a numbered list, and so is
  # a research method; counting list items would call both of them three asks.
  spawnbw --prompt "$(printf 'Build the picker.\nDone when:\n1. The Documents step shows one row per document\n2. The saved row carries the template id\n3. An old envelope renders blank\n')"
  is "criteria as a list are not deliverables" "0" "$(bwhas 'DELIVERABLES')"
  is "...and that brief warns not at all"      "0" "$(bwhas 'the brief is thin')"
  spawnbw --prompt "$(printf 'Investigate the flake.\n1. Read test/run.sh\n2. Run the suite twice\n3. Check the socket namespace\n')"
  is "a method list is not deliverables"       "0" "$(bwhas 'DELIVERABLES')"
  # ...and it is still thin in the OTHER way, so the row above is not passing because the
  # whole warning went silent.
  is "...though it still has no criterion"     "1" "$(bwhas 'NO DONE-CRITERION')"

  # ── the counter, so the bypass rate has a denominator ──
  # Nothing blocks, so every warning IS a bypass; a warned count with no total measures
  # nothing. Every PROMPTED spawn writes a row, warned or not.
  rm -f "$BW/fleet/cfbrief.brief.tsv"
  spawnbw --prompt 'Fix the parser'
  is "a warned dispatch is counted"           "1" "$(briefrows)"
  spawnbw --prompt 'Add the column. Done when: the header prints it.'
  is "...and so is an unwarned one"           "2" "$(briefrows)"
  is "...the verdict column says no"          "1" "$(awk -F'\t' '$4=="no"' "$BW/fleet/cfbrief.brief.tsv" | wc -l | tr -d ' ')"
  is "...and yes for the other"               "1" "$(awk -F'\t' '$4=="yes"' "$BW/fleet/cfbrief.brief.tsv" | wc -l | tr -d ' ')"
  is "...seven columns, none of them empty"   "0" \
     "$(awk -F'\t' 'NF!=7 || $7==""' "$BW/fleet/cfbrief.brief.tsv" | wc -l | tr -d ' ')"
  # NEVER THE BODY — the same privacy boundary the dispatch log keeps. A distinctive word
  # from a brief that was just counted must not be findable in the file.
  is "...and the brief body is NOT in it"     "0" \
     "$(grep -c 'parser' "$BW/fleet/cfbrief.brief.tsv" 2>/dev/null || true)"
  # A spawn with no brief at all has nothing to judge and nothing to count: a row for it
  # would inflate the denominator with dispatches the warning could never have seen.
  rm -f "$BW/fleet/cfbrief.brief.tsv"
  spawnbw
  is "a spawn with no prompt counts nothing"  "0" "$(briefrows)"
  is "...and warns about nothing"             "0" "$(bwhas 'the brief is thin')"

  # ── the verdict has to reach the WORKER, not just the lead ──
  # The objection happens in the lead and the outcome happens in the worker, and nothing
  # else joins those two transcripts — a verdict left behind on the lead makes a false
  # refusal unmeasurable from either end. So the marker rides along in the dispatched
  # prompt, and this asserts what the worker was actually handed rather than what the lead
  # printed. The recording fleet-send stub above is what makes that observable.
  # SPAWNED BY HAND rather than through spawnbw, for two reasons that both have to hold:
  # the session name must be one no other case uses (so no other dispatcher can write this
  # file), and the tmux server must stay UP until the send lands — spawnbw kills it on the
  # way out, which would leave the dispatcher polling a dead pane for its ~3min fallback.
  BWASK='Fix the parser so it stops dropping the last field'
  rm -f "$BW/sent.wdisp"
  rm -rf "$BW/repo" "$BW/wdisp"
  git init -q -b main "$BW/repo" 2>/dev/null
  git -C "$BW/repo" config user.email t@t; git -C "$BW/repo" config user.name t
  : > "$BW/repo/f"; git -C "$BW/repo" add -A; git -C "$BW/repo" commit -qm init 2>/dev/null
  ( cd "$BW/repo" && HOME="$BW/home" env -u TMUX \
      CLAUDE_FLEET_SOCK=cfbrief CLAUDE_FLEET_DIR="$BW/fleet" CLAUDE_FLEET_SLOTS="$BW/slots" \
      PATH="$BW/ok:$ROOT/bin:$PATH" "$ROOT/bin/fleet-spawn" wdisp --new \
      --prompt "$BWASK" >/dev/null 2>&1 )
  # the dispatcher is backgrounded and waits for the pane to look ready; the stub agent
  # prints the marker immediately, so this is ~1s, not the ~3min fallback.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$BW/sent.wdisp" ] && break; sleep 1; done
  tmux -L cfbrief kill-server 2>/dev/null
  is "the worker is handed something"         "1" "$([ -s "$BW/sent.wdisp" ] && echo 1 || echo 0)"
  is "...carrying the verdict marker"         "1" "$(grep -c '^brief-check: warn' "$BW/sent.wdisp" 2>/dev/null || true)"
  # ...and the human ask is still the HEAD of the brief. The marker is a trailing line
  # precisely so it does not push the ask down: the first line is what the worker reads
  # first and what the manifest shows in ASKED.
  is "...with the ask still first"            "1" "$(head -1 "$BW/sent.wdisp" 2>/dev/null | grep -c '^Fix the parser' || true)"
  is "...and the marker last"                 "1" "$(tail -1 "$BW/sent.wdisp" 2>/dev/null | grep -c '^brief-check:' || true)"
  # The manifest and the counter keep measuring the ASK, not the ask plus our own footer,
  # or the digest of a brief would never match the brief that was written.
  # The manifest and the counter keep measuring the ASK, not the ask plus our own footer,
  # or a digest of the brief would never match the brief that was written.
  is "...but ASKED is the ask alone"          "0" \
     "$(grep -c 'brief-check' "$BW/fleet/cfbrief.manifest.tsv" 2>/dev/null || true)"
  # ...and EXACTLY the ask, compared against the brief that was written rather than against
  # a threshold: the marker is ~140 characters, so a counter that had measured the
  # augmented prompt would be obvious against a bound and is unmistakable against equality.
  is "...and so is the counted length"        "$(printf '%s' "$BWASK" | wc -c | tr -d ' ')" \
     "$(awk -F'\t' 'END{print $6}' "$BW/fleet/cfbrief.brief.tsv" 2>/dev/null)"

  # ── the structural guard: this may not become a gate ──
  # Every assertion above would still pass if someone added an `exit 1` to the end of the
  # warning and a --force to get past it. The plan rejected exactly that, on the grounds
  # that a gate built on a null feature is a gate built on nothing, so the refusal to
  # refuse is pinned in the source rather than left to the reviewer of the next diff.
  BWBLOCK="$(sed -n '/the brief is thin/,/brief.tsv/p' "$ROOT/bin/fleet-spawn")"
  is "the warning block contains no exit"     "0" "$(printf '%s' "$BWBLOCK" | grep -cE '(^|[[:space:]])exit[[:space:]]' || true)"
  is "...and there is no --force to add"      "0" "$(grep -c -- '--force' "$ROOT/bin/fleet-spawn" || true)"
  rm -rf "$BW"
else
  skip "the brief warning" "git or tmux missing"
fi

# ── 5z2. the acknowledgement handshake: what the worker heard ────────────────
# The manifest recorded what the LEAD asked and nothing recorded what the worker heard.
# MEASURED: of 79 corrections that are about the agent rather than the code, 23 are "that
# is not what I asked" — the largest of those kinds.
#
# A restatement ALONE was the first design and it was not enough: it makes disagreement
# displayable, not preventable, because a worker can paraphrase the ask perfectly and
# still build from a wrong assumption underneath it. So the ack carries the DECISIONS it
# is working from, and the case with no other symptom — a worker proceeding from a
# decision nobody made — is what fleet-worktrees has to report. Both directions: an ack
# that names decisions must NOT print the marker, or the marker means nothing.
group "fleet-ack records the worker half beside the lead half"
if command -v git >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  AW="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$AW/proj" "$AW/fleet"
  git init -q -b main "$AW/proj/repo" 2>/dev/null
  git -C "$AW/proj/repo" config user.email t@t; git -C "$AW/proj/repo" config user.name t
  : > "$AW/proj/repo/f"; git -C "$AW/proj/repo" add -A
  git -C "$AW/proj/repo" commit -qm init 2>/dev/null
  git -C "$AW/proj/repo" worktree add -q "$AW/proj/w1" -b feat/w1 2>/dev/null
  git -C "$AW/proj/repo" worktree add -q "$AW/proj/w2" -b feat/w2 2>/dev/null
  MF="$AW/fleet/cfack.manifest.tsv"
  # w1: a normal spawn row. w2: a row written BEFORE these columns existed — four fields,
  # which is what every manifest on disk holds today.
  printf '%s\tw1\tfeat/w1\t%s\n' "$AW/proj/w1" 'build the per-document picker' >  "$MF"
  printf '%s\tw2\tfeat/w2\t%s\n' "$AW/proj/w2" 'port the exporter'             >> "$MF"
  ack() { ( cd "$AW/proj/w1" && CLAUDE_FLEET_DIR="$AW/fleet" env -u TMUX \
              "$ROOT/bin/fleet-ack" -s cfack "$@" 2>&1 ); }
  col() { awk -F'\t' -v w="$AW/proj/$1" -v c="$2" '$1==w{print $c; exit}' "$MF"; }

  ACKOUT="$(ack 'add a template picker to the Documents step' --from 'UNIT=per document; RETRO=new drafts only')"
  ACKRC=$?
  is "an ack exits 0"                        "0" "$ACKRC"
  is "...and records the restatement"        "add a template picker to the Documents step" "$(col w1 5)"
  is "...and the decisions beside it"        "UNIT=per document; RETRO=new drafts only"    "$(col w1 6)"
  # WHAT WAS ASKED IS NOT THE WORKER'S TO EDIT. A worker that could rewrite the ask could
  # make any disagreement disappear, which is the one thing this column exists to prevent.
  is "...and does NOT touch what was asked"  "build the per-document picker" "$(col w1 4)"
  is "...leaving one row for that worktree"  "1" "$(awk -F'\t' -v w="$AW/proj/w1" '$1==w' "$MF" | wc -l | tr -d ' ')"
  is "...and the other worktree untouched"   "port the exporter" "$(col w2 4)"
  # THE MARKER, anchored the same way and for the same reason as brief-check above: the
  # evaluator reads a POSITION. The decisions ride on that line rather than a line below,
  # because the claim being made is not that the worker restated something but what it is
  # building FROM.
  is "...and prints the understood marker"   "1" "$(printf '%s' "$ACKOUT" | grep -c '^understood: ' || true)"
  is "...naming the decisions on that line"  "1" \
     "$(printf '%s' "$ACKOUT" | grep -c '^understood: .* · from: UNIT=per document' || true)"
  is "...beside what was asked"              "1" "$(printf '%s' "$ACKOUT" | grep -c '^asked: ' || true)"

  # ── an ack that names NO decision is recorded AS naming none ──
  # It is not upgraded, not defaulted, and not refused. A signal that quietly makes itself
  # look compliant is the failure this whole pair of features exists to expose.
  ACKOUT="$(ack 'add a template picker' )"; ACKRC=$?
  is "an ack with no decisions still works"  "0" "$ACKRC"
  is "...and leaves the decisions empty"     "" "$(col w1 6)"
  is "...but says so, plainly"               "1" "$(printf '%s' "$ACKOUT" | grep -c 'none named' || true)"
  # ON THE MARKER LINE ITSELF, not only in the prose below it. An omitted field and a
  # deliberate "none" are the same bytes to a reader and are not the same event, so the
  # marker states it rather than leaving the field off.
  is "...on the marker line itself"          "1" \
     "$(printf '%s' "$ACKOUT" | grep -c '^understood: .* · from: (none named)' || true)"

  # ONE LINE MEANS ONE LINE: a pasted paragraph would otherwise put a newline into a
  # newline-delimited file and a tab into a tab-delimited one, shifting every later field
  # of every later row — the failure CLAUDE.md names twice.
  ack "$(printf 'first line\nsecond\tline')" --from "$(printf 'a\nb')" >/dev/null 2>&1
  is "a multi-line ack is flattened"         "1" "$(awk -F'\t' -v w="$AW/proj/w1" '$1==w' "$MF" | wc -l | tr -d ' ')"
  is "...into exactly six fields"            "6" "$(awk -F'\t' -v w="$AW/proj/w1" '$1==w{print NF; exit}' "$MF")"

  # ── the usage error, which is an argument error and not a gate ──
  AUOUT="$( ( cd "$AW/proj/w1" && CLAUDE_FLEET_DIR="$AW/fleet" env -u TMUX \
                "$ROOT/bin/fleet-ack" -s cfack 2>&1 ) )"; AURC=$?
  is "an ack with no restatement is usage"   "1" "$AURC"
  # PRESENCE, not a count: the usage text names --from on three lines (the flag, the
  # worked example, and the sentence explaining it), so pinning a number would assert the
  # prose rather than the behaviour and go red on any rewording of the help.
  is "...and shows how to write one"         "1" \
     "$([ "$(printf '%s' "$AUOUT" | grep -c -- '--from' || true)" -ge 1 ] && echo 1 || echo 0)"
  is "...under a usage heading"              "1" "$(printf '%s' "$AUOUT" | grep -c 'fleet-ack: usage' || true)"

  # ── what a lead actually reads ──
  # fleet-worktrees blanks both columns for a worktree with no live session (the manifest
  # then describes a session that is gone), so the row only exists to be read while a
  # session is sitting in it.
  printf '%s\tw1\tfeat/w1\t%s\t%s\t%s\n' "$AW/proj/w1" 'build the per-document picker' \
     'add a template picker to the Documents step' 'UNIT=per document' > "$MF"
  printf '%s\tw2\tfeat/w2\t%s\n' "$AW/proj/w2" 'port the exporter' >> "$MF"
  tmux -L cfack kill-server 2>/dev/null
  tmux -L cfack new-session -d -s w1 -c "$AW/proj/w1" 'sleep 60' 2>/dev/null
  tmux -L cfack new-session -d -s w2 -c "$AW/proj/w2" 'sleep 60' 2>/dev/null
  sleep 0.5
  WTOUT="$( cd "$AW/proj/repo" && CLAUDE_FLEET_DIR="$AW/fleet" env -u TMUX \
              "$ROOT/bin/fleet-worktrees" -s cfack 2>&1 )"
  is "the header shows ASKED"                "1" "$(printf '%s' "$WTOUT" | grep -c 'ASKED' || true)"
  is "...and UNDERSTOOD beside it"           "1" "$(printf '%s' "$WTOUT" | grep -c 'UNDERSTOOD' || true)"
  is "...and TASK is gone"                   "0" "$(printf '%s' "$WTOUT" | grep -c 'TASK' || true)"
  is "an acked worktree shows both"          "1" \
     "$(printf '%s' "$WTOUT" | grep -c 'build the per-document picker.*add a template picker' || true)"
  # RETROACTIVITY: a row written before these columns existed has no fifth field. It must
  # read as blank — an old entry is not a disagreement — and it must not break the table.
  is "a pre-existing 4-column row is blank"  "1" \
     "$(printf '%s' "$WTOUT" | grep -c 'port the exporter *-' || true)"
  is "...and the table still lists both"     "2" \
     "$(printf '%s' "$WTOUT" | grep -cE '^(w1|w2) ' || true)"

  # ── the marker, in BOTH directions ──
  # An ack that names decisions must NOT print "(no decisions)", or the marker is
  # decoration; an ack that names none must, or the case it exists for is invisible.
  is "an ack with decisions has no marker"   "0" "$(printf '%s' "$WTOUT" | grep -c 'no decisions' || true)"
  printf '%s\tw1\tfeat/w1\t%s\t%s\t\n' "$AW/proj/w1" 'build the per-document picker' \
     'add a template picker to the Documents step' > "$MF"
  WTOUT2="$( cd "$AW/proj/repo" && CLAUDE_FLEET_DIR="$AW/fleet" env -u TMUX \
               "$ROOT/bin/fleet-worktrees" -s cfack 2>&1 )"
  is "an ack with none is marked as such"    "1" "$(printf '%s' "$WTOUT2" | grep -c '(no decisions)' || true)"
  # It prints FIRST, so a long restatement cannot truncate the marker away — the column is
  # cut at a fixed width and the absence is the part that must survive the cut.
  is "...and the marker leads the column"    "1" \
     "$(printf '%s' "$WTOUT2" | grep -c '(no decisions) add a template picker' || true)"
  tmux -L cfack kill-server 2>/dev/null
  rm -rf "$AW"
else
  skip "the acknowledgement handshake" "git or tmux missing"
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

  # ── the pane renderer ──────────────────────────────────────────────────────
  # The session screen's DEFAULT view goes through web/ansi.js, so what it gets wrong is
  # what a phone shows instead of a terminal. Driven against real `capture-pane -p -e`
  # bytes (test/fixtures/claude-*-sgr.txt): a live session mid-turn and a live permission
  # dialog. Every one of these was watched going red with its rule removed — the
  # font-weight pair, the cell boxing, the cross-row attribute state, the HTML escaping,
  # the OSC handling and the wide-glyph box, seven deliberate breaks in all.
  node "$ROOT/test/helpers/pane-check.mjs" > "$PW/pane" 2> "$PW/pane.err"
  is "pane-check ran"                 "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/pane.err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: a helper that dies half way emits a few
  # rows and a bare "no mismatches" would call that green.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/pane")" -ge 60 ] && echo yes || echo "no: $(wc -l < "$PW/pane") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/pane"

  # ── the docs' example data ─────────────────────────────────────────────────
  # #59 renamed the fixtures and #60 re-shot the images; docs/mobile.md, which is the
  # document those fixtures implement, was left naming sessions that no longer exist.
  # Nothing failed, because a doc's examples have no compiler — so the spec and the
  # client disagreed about what the app renders, silently, and the real project names
  # #59 removed went on shipping in the one file people actually read. This asks the
  # fixtures instead: every name docs/mobile.md and web/README.md put in a naming
  # position has to be a project, session, worktree or branch that web/fixtures/ has.
  # Each rule was watched going red with an old name pasted back into its own position —
  # a payload value, a card title, a card's worktree line, a --plain row, a confirmation,
  # a socket, a path, and a backticked name in prose.
  node "$ROOT/test/helpers/doc-fixtures.mjs" > "$PW/docs" 2> "$PW/docs.err"
  is "doc-fixtures ran"               "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/docs.err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: a scanner that matches nothing emits no
  # rows, and "no mismatches" over an empty file reads exactly like a clean document.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/docs")" -ge 20 ] && echo yes || echo "no: $(wc -l < "$PW/docs") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/docs"

  # ── what the 🔊 button says ────────────────────────────────────────────────
  # speakable() is pure and exported and had no coverage at all, which is how it shipped
  # reading a 40-character sha out one character at a time — "a bunch of numbers and stuff
  # that is not relevant", from the phone. The table is in both directions on purpose and
  # the SECOND one is the point: a normaliser that deleted every digit would pass every
  # "the sha is gone" check and would be worse than doing nothing, because "1885 passed,
  # 0 failed" is the whole content of that sentence. Every row was watched going red —
  # the pass removed, the pass returning "", the sha guard dropped (which is how the first
  # draft's "cabbage" row was caught proving nothing), the path rule widened, the line
  # number dropped, the URL rule removed and the spoken-slash rule removed.
  node "$ROOT/test/helpers/speak-check.mjs" > "$PW/speak" 2> "$PW/speak.err"
  is "speak-check ran"                "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/speak.err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: this helper `await import`s web/app.js, so
  # a boot that throws emits no rows at all and a bare "no mismatches" would call it green.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/speak")" -ge 50 ] && echo yes || echo "no: $(wc -l < "$PW/speak") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/speak"

  # ── the markdown a bubble renders ──────────────────────────────────────────
  # "the messages are not in nice .md format, they have the ****" — turn() set the bubble
  # with textContent, so every assistant turn was its own source. web/md.js parses to
  # blocks (pure, no DOM) and builds NODES, never innerHTML.
  #   The survival rows come first and they are the point: `return ''` has no asterisks in
  # it either, so every case asserts the WORDS are still there before it asserts the marks
  # are gone. Watched going red with the renderer bypassed, with emphasis allowed to start
  # mid-word (which eats the stars out of 2*3*4), with the code fence re-parsed as markdown,
  # and with safeHref opened up to any scheme.
  node "$ROOT/test/helpers/md-check.mjs" > "$PW/md" 2> "$PW/md.err"
  is "md-check ran"                   "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$PW/md.err" | tr '\n' ' ' | sed 's/ *$//')"
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$PW/md")" -ge 55 ] && echo yes || echo "no: $(wc -l < "$PW/md") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$PW/md"
  rm -rf "$PW"

  # cf-sync mirrors only a whitelist of directories into the runtime, and the client is
  # a RUNTIME asset — fleet-serve serves it from ~/.local/libexec/ghostfleet, not from
  # the repo. Left out of that list, the PWA 404s in the browser while every file in the
  # repo is perfectly correct: the same "the file on disk was current, the process was
  # not" trap CLAUDE.md records for a stale MCP server, and just as invisible from here.
  # ── the page never scrolls sideways, measured in a real engine ─────────────
  # docs/mobile.md has said since #48 that ONE region scrolls and the page never moves
  # sideways. It was a rule somebody had to keep, and on an iPhone at v11 it was not being
  # kept: the send button rendered "senc", the ⋯ sat half off the right edge, and with the
  # actions sheet open every element was displaced ~40px left. Whether a flex row fits is
  # the product of font metrics, padding, shrink rules and the real strings — no amount of
  # reading the stylesheet answers it — so this one drives a headless Chrome and asks
  # documentElement.scrollWidth <= clientWidth on every screen at 390 and at 320.
  #   Watched going red on the real pre-fix state (chrome sized in `em`, no clip backstop):
  # "the header row still fits" and "nothing past the right edge  got=button.@400", which is
  # the ⋯ 80px past a 320px phone. And the probe proves itself on a deliberately 900px page,
  # because "no overflow anywhere" is what a blind measurement says too.
  #   SKIPPED where there is no Chrome. The suite's promise is that it needs no
  # dependencies, and this is the one check that cannot keep it.
  VPO="$(mktemp -d "$TEST_RUNS.$$.vp.XXXXXX")"
  node "$ROOT/test/helpers/viewport-check.mjs" > "$VPO/out" 2> "$VPO/err"
  vprc=$?
  if grep -q 'no chrome' "$VPO/out" 2>/dev/null; then
    skip "the page never scrolls sideways" "no chrome to measure in"
  else
    is "viewport-check ran"             "0" "$vprc"
    is "...without complaining"         ""  "$(head -2 "$VPO/err" | tr '\n' ' ' | sed 's/ *$//')"
    # A floor, for the reason pwa-check documents: a browser that fails to start emits a
    # couple of rows and a bare "no mismatches" would call that green.
    is "...and produced its checks"     "yes" "$([ "$(wc -l < "$VPO/out")" -ge 35 ] && echo yes || echo "no: $(wc -l < "$VPO/out") rows")"
    while IFS=$'\x1f' read -r name want got; do
      # A GROUP THE BROWSER CANNOT RUN SAYS SO INSTEAD OF ASSERTING SOMETHING WEAKER — the
      # same precedent as skipping the whole file where there is no Chrome. Element.focus()
      # only takes when the page is considered focused, and a headless window is not
      # activated on every platform: the keyboard checks passed on Linux and collapsed on
      # macOS for that reason alone.
      if [ "$name" = '#SKIP' ]; then skip "$want" "$got"; continue; fi
      is "$name" "$want" "$got"
    done < "$VPO/out"
  fi
  rm -rf "$VPO"

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
  # ── the version has to be ABOVE main's, not merely different ──────────────
  # The pin above catches "changed the client, forgot to bump". It has no notion of ORDER,
  # and order is what has bitten: #83 took v17, #81 was numbered v16 before it and merged
  # after, so main went BACKWARDS and #84 existed only to undo that; then #86 was numbered
  # v19 while #85 was also v19, caught by hand. Both leave a hash that matches its own
  # bytes, so both are green here without this.
  #   THIS ONE SKIPS ON STAGING, and that is not the same as passing: on staging, or on a
  # branch that has already landed, there is nothing to be ahead of. It also skips in a clone
  # with no origin/staging — but NOT in CI on a pull request, where the absence of the ref
  # means the check silently did nothing in the one place it is the point. See the helper's
  # header.
  #   THE REF IS `origin/staging`, NOT `origin/main`, and the distinction became load-bearing
  # the moment main stopped taking day-to-day merges. The question this asks is "has somebody
  # else already taken this number", and after that split the answer lives on staging: main
  # moves once per release, so comparing against it would leave every branch trivially above
  # a months-old number while three of them raced for the same one — which is #87, the exact
  # bug this exists to prevent, reintroduced by pointing the guard at a branch that stopped
  # moving.
  SWV="$(mktemp -d "$TEST_RUNS.$$.swv.XXXXXX")"
  node "$ROOT/test/helpers/sw-version.mjs" > "$SWV/out" 2> "$SWV/err"
  is "sw-version ran"                 "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$SWV/err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: this file's whole job is one verdict, and
  # a helper that died before reaching it emits a handful of rows and no mismatches.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$SWV/out")" -ge 20 ] && echo yes || echo "no: $(wc -l < "$SWV/out") rows")"
  while IFS=$'\x1f' read -r name want got; do
    if [ "$name" = '#SKIP' ]; then skip "$want" "$got"; continue; fi
    is "$name" "$want" "$got"
  done < "$SWV/out"
  rm -rf "$SWV"
else
  skip "phone client" "web/ not present"
fi

# ── 6a2. no real project, client or employer name in the tree ────────────────
# The repo is public, and about twenty comments named the projects that produced the fixes
# they document — the natural way to write "this is where I saw it", and a name that ships
# in the npm tarball. The names are gone from the comments now, but a one-time sweep only
# fixes today: the next comment somebody writes is the one that puts one back.
#   NOT GATED ON web/. This reads every file git tracks — bin, hooks, mcp, scripts, skill,
# tmux, layouts, test, docs, install.sh and the markdown — so it belongs outside the phone
# client's `if`.
#   THE LIST IS STORED ONE-WAY, which is not decoration: a helper containing the names would
# publish exactly what it exists to remove, and in a worse form than a comment does — one
# tidy machine-readable roster. See the helper's header for what a digest does and does not
# buy, and CLAUDE.md's "Comments and docs" for the rule this enforces.
#   BOTH DIRECTIONS, and the failing one was measured with the real names rather than only
# with the canary: each was planted in a tracked file in turn and the row went red for all
# of them, plus for the spellings they actually arrive in — a socket, a `~/` path, an
# address, an email, a camelCase suffix and a repo URL. The canary in section 3 is what
# keeps that provable from inside the suite, since a real name cannot be committed here.
group "no real project name in the tree"
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  NSW="$(mktemp -d "$TEST_RUNS.$$.nsw.XXXXXX")"
  node "$ROOT/test/helpers/name-sweep.mjs" > "$NSW/out" 2> "$NSW/err"
  is "name-sweep ran"                 "0" "$?"
  is "...without complaining"         ""  "$(head -2 "$NSW/err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: the tree row is ONE assertion, and a helper
  # that died before reaching it emits a few rows and no mismatches — which reads as clean.
  is "...and produced its checks"     "yes" "$([ "$(wc -l < "$NSW/out")" -ge 24 ] && echo yes || echo "no: $(wc -l < "$NSW/out") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$NSW/out"
  rm -rf "$NSW"
else
  skip "no real project name in the tree" "git or node missing"
fi

# ── 6a3. the utilization meter reads a transcript ────────────────────────────
# bin/fleet-meter.mjs turns the corpus under ~/.claude/projects into the numbers plan item
# #2 is judged against. Nothing else in this repo parses that wire format, and a parser is
# exactly the kind of code that fails silently: every one of the four ways this can be wrong
# produces a plausible number rather than an error.
#   THE FIXTURE IS BUILT SO THE FAILING DIRECTION IS THE INTERESTING ONE. Its sidechain
# records carry a `sleep 999`, an Edit of a file nothing else touches, a browser call and
# the word "Done." — the same shapes as the real turns beside them. A reader that has lost
# its eligibility filter does not crash; it reports 1034 seconds of sleep instead of 35,
# three files instead of two, and a done-claim on turn 1 instead of turn 2. So the numbers
# below are asserted as exact values, not as "greater than zero": every one of them moves if
# the filter goes, and none of them moves to something that looks broken.
#   AND THE SAME RECORDS ARE READ TWICE. Section three of the fixture is s1 with every
# isSidechain flipped to true and nothing else changed, so the identical eleven records that
# produce 3 turns and 9 tool calls above must produce 0 and 0 there. That is the pair the
# repo's rule asks for: a detector is only proven by a capture it must match AND a capture
# it must stay silent on, and a meter that counts everything and a meter that counts nothing
# are both green against a fixture read only once.
#   THE PRIVACY ASSERTION IS NOT DECORATION. The corpus is not this repo's — it holds other
# people's work — so the meter emits counts and digests and never a body, a path or a branch
# name. The fixture's branch names and file paths go IN; the group greps the JSON that comes
# out for each of them and requires zero hits. A regression that starts echoing a path would
# otherwise be invisible until it had been committed to a public repo.
group "the utilization meter"
if command -v node >/dev/null 2>&1; then
  MTR="$(mktemp -d "$TEST_RUNS.$$.meter.XXXXXX")"
  mkdir -p "$MTR/corpus/acme-web-proj" "$MTR/empty" "$MTR/ineligible/acme-web-proj"

  # Two sessions. s1 runs three human turns and crosses a branch partway; s2 is one turn
  # that never claims done. Between s1's turns sit the three record kinds that look like a
  # human prompt and are not: a tool_result carrier (most of the file, by volume), an isMeta
  # record — whose text says "No, that is wrong" precisely so a lost filter would score a
  # correction — and a sidechain pair holding a subagent's own tool calls.
  cat > "$MTR/corpus/acme-web-proj/s1.jsonl" <<'MJSON'
{"type":"user","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"add a signature-template picker to the Documents step"}}
{"type":"assistant","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:01:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 5; ./test/run.sh"}},{"type":"tool_use","name":"Read","input":{"file_path":"/w/acme-web/src/never-edited.ts"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/w/acme-web/src/a.ts"}},{"type":"text","text":"Working on it, more to do."}]}}
{"type":"user","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:02:00Z","message":{"role":"user","content":[{"type":"tool_result","content":"3506 passed"}]}}
{"type":"user","isMeta":true,"isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:03:00Z","message":{"role":"user","content":"No, that is wrong: a meta record that must not be a turn"}}
{"type":"user","isSidechain":true,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:04:00Z","message":{"role":"user","content":"subagent brief"}}
{"type":"assistant","isSidechain":true,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:05:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 999"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/w/acme-web/src/sidechain-only.ts"}},{"type":"tool_use","name":"mcp__chrome-devtools__navigate_page","input":{"url":"http://127.0.0.1:8787/"}},{"type":"text","text":"Done."}]}}
{"type":"user","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:06:00Z","message":{"role":"user","content":"No, that is not what I asked for."}}
{"type":"assistant","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:07:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__chrome-devtools__take_screenshot","input":{}},{"type":"tool_use","name":"Edit","input":{"file_path":"/w/acme-web/src/b.ts"}}]}}
{"type":"assistant","isSidechain":false,"gitBranch":"acme-web","sessionId":"meter-s1","timestamp":"2026-01-01T00:08:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Done. The picker is on the Documents step."}]}}
{"type":"user","isSidechain":false,"gitBranch":"acme-api","sessionId":"meter-s1","timestamp":"2026-01-01T00:09:00Z","message":{"role":"user","content":"now wire the same thing on the api side"}}
{"type":"assistant","isSidechain":false,"gitBranch":"acme-api","sessionId":"meter-s1","timestamp":"2026-01-01T00:10:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 600 &"}},{"type":"tool_use","name":"Bash","input":{"command":"sleep 30; tail -f log","run_in_background":true}},{"type":"tool_use","name":"Bash","input":{"command":"sleep 10; sleep 20"}},{"type":"tool_use","name":"Write","input":{"file_path":"/w/acme-web/src/a.ts"}},{"type":"text","text":"Next I will check the wire format."}]}}
MJSON
  cat > "$MTR/corpus/acme-web-proj/s2.jsonl" <<'MJSON'
{"type":"user","isSidechain":false,"gitBranch":"acme-api","sessionId":"meter-s2","timestamp":"2026-01-02T00:00:00Z","message":{"role":"user","content":"why is the toolbox pane blank"}}
{"type":"assistant","isSidechain":false,"gitBranch":"acme-api","sessionId":"meter-s2","timestamp":"2026-01-02T00:00:30Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"fleet-look.mjs http://127.0.0.1:8787/"}},{"type":"text","text":"The pane is blank because the socket is wrong."}]}}
MJSON
  # The same eleven records, every one of them a sidechain. Derived from s1 rather than
  # written out again, so the two can never drift apart and leave the zero direction
  # passing against a fixture that no longer resembles the one it is paired with.
  sed 's/"isSidechain":false/"isSidechain":true/g' \
      "$MTR/corpus/acme-web-proj/s1.jsonl" > "$MTR/ineligible/acme-web-proj/s3.jsonl"

  node "$ROOT/bin/fleet-meter.mjs" --corpus "$MTR/corpus"     --json > "$MTR/full.json" 2> "$MTR/err"
  is "meter ran"                        "0"  "$?"
  is "...without complaining"           ""   "$(head -2 "$MTR/err" | tr '\n' ' ' | sed 's/ *$//')"
  node "$ROOT/bin/fleet-meter.mjs" --corpus "$MTR/empty"      --json > "$MTR/empty.json" 2>/dev/null
  node "$ROOT/bin/fleet-meter.mjs" --corpus "$MTR/ineligible" --json > "$MTR/inel.json"  2>/dev/null

  # process.stdout.write of a String(), never console.log of a bare value: the header
  # explains what util.inspect does to a number, and this helper answers into an `is`.
  m() { node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let v = r; for (const k of process.argv[2].split(".")) v = (v === null || v === undefined) ? v : v[k];
      process.stdout.write(v === undefined ? "(missing)" : String(v));
    ' "$1" "$2"; }

  # ── the parse: every value hand-computed from the fixture above ──
  is "meter: 2 files, 13 records"     "2 13"  "$(m "$MTR/full.json" corpus.files) $(m "$MTR/full.json" corpus.records)"
  is "meter: 4 human turns of 13"     "4"     "$(m "$MTR/full.json" corpus.turns)"
  is "meter: s1 turns"                "3"     "$(m "$MTR/full.json" per_session.0.observed.turns)"
  is "meter: s1 tool calls"           "9"     "$(m "$MTR/full.json" per_session.0.observed.tool_calls)"
  is "meter: s1 tool calls per turn"  "3"     "$(m "$MTR/full.json" per_session.0.observed.tool_calls_per_turn_mean)"
  # 35, not 1034: the sidechain's `sleep 999` is not this session's.
  is "meter: s1 sleep seconds"        "35"    "$(m "$MTR/full.json" per_session.0.observed.sleep_seconds)"
  # 3, not 5: `sleep 600 &` returns at once and a run_in_background call does too.
  is "meter: s1 sleeps counted"       "3"     "$(m "$MTR/full.json" per_session.0.observed.sleep_calls)"
  is "meter: s1 browser calls"        "1"     "$(m "$MTR/full.json" per_session.0.observed.browser_calls)"
  # 2, not 3: a Read carries a file_path and is not a touch.
  is "meter: s1 distinct files"       "2"     "$(m "$MTR/full.json" per_session.0.observed.distinct_files)"
  is "meter: s1 turns to done"        "2"     "$(m "$MTR/full.json" per_session.0.labelled.turns_to_done)"
  is "meter: s1 browser before done"  "true"  "$(m "$MTR/full.json" per_session.0.labelled.browser_before_done_claim)"
  # 1, not 2: the isMeta record says "No, that is wrong" and is not a human turn.
  is "meter: s1 corrections"          "1"     "$(m "$MTR/full.json" per_session.0.labelled.corrections)"
  is "meter: s1 corrections/file"     "0.5"   "$(m "$MTR/full.json" per_session.0.labelled.corrections_per_distinct_file)"
  # s2 never claims done, and has no files, so the ratio is absent rather than zero.
  is "meter: s2 turns to done"        "null"  "$(m "$MTR/full.json" per_session.1.labelled.turns_to_done)"
  is "meter: s2 corrections/file"     "null"  "$(m "$MTR/full.json" per_session.1.labelled.corrections_per_distinct_file)"
  # A session crosses a branch partway, so a TURN carries the branch, not a session.
  is "meter: 2 branches"              "2"     "$(m "$MTR/full.json" corpus.branches)"
  is "meter: branch id is the digest" "$(node "$ROOT/bin/fleet-meter.mjs" --digest acme-web)" "$(m "$MTR/full.json" per_branch.0.id)"
  is "meter: acme-web turns"          "2"     "$(m "$MTR/full.json" per_branch.0.observed.turns)"
  is "meter: acme-api turns"          "2"     "$(m "$MTR/full.json" per_branch.1.observed.turns)"
  is "meter: acme-api sleep seconds"  "30"    "$(m "$MTR/full.json" per_branch.1.observed.sleep_seconds)"
  # The two that cannot be pooled are absent from the pooled block and present in the cohort.
  is "meter: pooled has no to-done"   "(missing)" "$(m "$MTR/full.json" pooled.labelled.turns_to_done)"
  is "meter: cohort to-done median"   "2"     "$(m "$MTR/full.json" cohort.per_session.turns_to_done_median)"

  # ── the zero direction: the same records, all ineligible ──
  is "meter: ineligible records read" "11"    "$(m "$MTR/inel.json" corpus.records)"
  is "meter: ineligible turns"        "0"     "$(m "$MTR/inel.json" corpus.turns)"
  is "meter: ineligible tool calls"   "0"     "$(m "$MTR/inel.json" pooled.observed.tool_calls)"
  is "meter: ineligible sleep"        "0"     "$(m "$MTR/inel.json" pooled.observed.sleep_seconds)"
  is "meter: ineligible browser"      "0"     "$(m "$MTR/inel.json" pooled.observed.browser_calls)"
  is "meter: ineligible files"        "0"     "$(m "$MTR/inel.json" pooled.observed.distinct_files)"
  is "meter: ineligible done-claims"  "0"     "$(m "$MTR/inel.json" pooled.labelled.done_claim_turns)"

  # ── the empty direction ──
  node "$ROOT/bin/fleet-meter.mjs" --corpus "$MTR/empty" >/dev/null 2>&1
  is "meter: empty corpus exits 0"    "0"     "$?"
  is "meter: empty files"             "0"     "$(m "$MTR/empty.json" corpus.files)"
  is "meter: empty turns"             "0"     "$(m "$MTR/empty.json" corpus.turns)"
  is "meter: empty tool calls"        "0"     "$(m "$MTR/empty.json" pooled.observed.tool_calls)"
  # null, not 0. "median turns to done: 0" on an empty cohort reads as the best possible
  # result and means the opposite.
  is "meter: empty to-done median"    "null"  "$(m "$MTR/empty.json" cohort.per_session.turns_to_done_median)"
  is "meter: empty corrections/file"  "null"  "$(m "$MTR/empty.json" pooled.labelled.corrections_per_distinct_file)"

  # ── counts and digests, never content ──
  # Every one of these is IN the fixture the meter just read.
  for leak in acme-web acme-api never-edited sidechain-only 'Documents step' 'toolbox pane' '/w/'; do
    is "meter: '$leak' is not in the output" "0" "$(grep -c -- "$leak" "$MTR/full.json" | tr -d ' ')"
  done

  # An exclusion that has stopped matching must say so rather than quietly excluding
  # nothing — the whole point of naming them in the output.
  is "meter: --why reports absence"   "4"     "$(node "$ROOT/bin/fleet-meter.mjs" --corpus "$MTR/corpus" --why | grep -c 'NOT FOUND')"
  is "meter: --digest is stable"      "$(node "$ROOT/bin/fleet-meter.mjs" --digest acme-web)" "$(node "$ROOT/bin/fleet-meter.mjs" --digest acme-web)"
  rm -rf "$MTR"
else
  skip "the utilization meter" "node missing"
fi

# ── 6a4. the evaluator refuses a verdict it cannot support ───────────────────
# Plan item #5 promotes a warning to a hard gate only where a failure mode SHOWS UP. Four
# measurements decide it, and on the day it ships all four are unmeasurable: #3 and #4 are
# not merged, so nothing has ever left a treatment marker and every rate is over an empty
# denominator.
#   THE REFUSAL IS THE FEATURE, AND IT IS WHAT THIS GROUP MOSTLY TESTS. A rate of 0/0 comes
# out either NaN or a tidy 0, and a tidy 0 here reads as "no false refusals, no bypass, no
# added latency" — the most favourable result available, measuring nothing. That is exactly
# how v1 of the plan was going to justify a gate on a correlation. So the blocked rows are
# asserted to have NO VALUE KEY AT ALL rather than a zero one: "(missing)" is the expected
# value, and a regression that starts emitting 0 goes red instead of looking like good news.
#   BOTH DIRECTIONS ARE REAL CORPORA, NOT A FLAG. The measurable direction is a generated
# corpus big enough to clear every floor, with values that are arithmetic on the counts at
# the top of test/helpers/meter-corpus.mjs. The refusing directions are: a corpus where the
# markers appear only as PROSE, a baseline that froze no sessions, and one whose rule digests
# do not match.
#   THE PROSE CORPUS IS THE ONE THAT CAUGHT A REAL BUG. The evaluator's first run classified
# a session as treated because the word `fleet-ack` appeared in it — and the session it
# appeared in was the one writing the marker. The treated arm would have filled with the
# treatment's own construction, which is unusually careful work, and the treatment would have
# looked like it worked. Markers are matched by POSITION now (a command invoked, a line a
# program printed) as well as by string, and the prose corpus is what keeps that provable.
group "the evaluator refuses what it cannot support"
if command -v node >/dev/null 2>&1; then
  EVD="$(mktemp -d "$TEST_RUNS.$$.eval.XXXXXX")"
  node "$ROOT/test/helpers/meter-corpus.mjs" "$EVD" > "$EVD/gen" 2> "$EVD/err"
  is "evaluator fixture built"        "0"  "$?"
  is "...without complaining"         ""   "$(head -2 "$EVD/err" | tr '\n' ' ' | sed 's/ *$//')"
  # The generator duplicates the reader's salt because importing the reader would run it.
  # One assertion is what stops that duplicate from drifting into a baseline whose ids match
  # nothing — which would present as a control arm of zero, not as an error.
  is "generator salt matches reader"  "$(node "$ROOT/bin/fleet-meter.mjs" --digest acme-web)" \
                                      "$(node "$ROOT/test/helpers/meter-corpus.mjs" --digest acme-web)"

  M="$ROOT/bin/fleet-meter.mjs"
  node "$M" --corpus "$EVD/corpus" --evaluate --baseline-file "$EVD/baseline.json"       --json > "$EVD/full.json" 2>/dev/null
  node "$M" --corpus "$EVD/prose"  --evaluate --baseline-file "$EVD/baseline.json"       --json > "$EVD/prose.json" 2>/dev/null
  node "$M" --corpus "$EVD/corpus" --evaluate --baseline-file "$EVD/baseline-empty.json" --json > "$EVD/noctl.json" 2>/dev/null
  node "$M" --corpus "$EVD/corpus" --evaluate --baseline-file "$EVD/baseline-wrong-rules.json" --json > "$EVD/wrong.json" 2>/dev/null

  # Reads one dotted path. process.stdout.write of a String(), never console.log of a bare
  # value — see the note on util.inspect at the head of this file.
  ev() { node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let v = r; for (const k of process.argv[2].split(".")) v = (v === null || v === undefined) ? v : v[k];
      process.stdout.write(v === undefined ? "(missing)" : String(v));
    ' "$1" "$2"; }
  # Finds a measurement by name rather than by index, so reordering MEASUREMENTS does not
  # silently re-point every assertion at a different metric.
  mm() { node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const m = r.measurements.find((x) => x.measurement === process.argv[2]);
      let v = m; for (const k of process.argv[3].split(".")) v = (v === null || v === undefined) ? v : v[k];
      process.stdout.write(v === undefined ? "(missing)" : String(v));
    ' "$1" "$2" "$3"; }

  # ── the arms. 40 treated and 35 control, never 75 and 0 ──
  is "eval: treated sessions"         "40"    "$(ev "$EVD/full.json" arms.treated.sessions)"
  is "eval: treated turns"            "73"    "$(ev "$EVD/full.json" arms.treated.turns)"
  is "eval: control sessions"         "35"    "$(ev "$EVD/full.json" arms.control.sessions)"
  is "eval: baseline cohort found"    "35"    "$(ev "$EVD/full.json" baseline.sessions_still_on_disk)"
  is "eval: verdict is reportable"    "true"  "$(ev "$EVD/full.json" verdict.reportable)"

  # ── the four, each at a value derived by hand from the generator's counts ──
  # 30 briefs warned; 18 of them drew a correction, so 12 ran clean.
  is "eval: false refusals n"         "30"    "$(mm "$EVD/full.json" false_refusals n_treated)"
  is "eval: false refusals bound"     "0.4"   "$(mm "$EVD/full.json" false_refusals treated_upper_bound)"
  # ...and it is one-armed by construction: there is no untreated rate to compare with.
  is "eval: false refusals no control" "null" "$(mm "$EVD/full.json" false_refusals n_control)"
  # 30 briefs carried a criterion, 9 named nothing observable; control 7 of 35.
  is "eval: bypass n treated"         "30"    "$(mm "$EVD/full.json" bypass_rate n_treated)"
  is "eval: bypass treated"           "0.3"   "$(mm "$EVD/full.json" bypass_rate treated_rate)"
  is "eval: bypass control"           "0.2"   "$(mm "$EVD/full.json" bypass_rate control_rate)"
  # 12s to the first tool call against 4s.
  is "eval: latency treated"          "12"    "$(mm "$EVD/full.json" added_latency_seconds treated_median_seconds)"
  is "eval: latency control"          "4"     "$(mm "$EVD/full.json" added_latency_seconds control_median_seconds)"
  is "eval: latency added"            "8"     "$(mm "$EVD/full.json" added_latency_seconds added_seconds)"
  # 18 of 30 done-claiming sessions carried on afterwards; control 15 of 35, from the
  # committed columns rather than a re-read.
  is "eval: rework treated rate"      "0.6"    "$(mm "$EVD/full.json" rework_turns treated_rate)"
  is "eval: rework control rate"      "0.4286" "$(mm "$EVD/full.json" rework_turns control_rate)"
  is "eval: rework treated median"    "1.5"    "$(mm "$EVD/full.json" rework_turns treated_median_turns)"
  is "eval: rework control median"    "0"      "$(mm "$EVD/full.json" rework_turns control_median_turns)"

  # ── the refusing direction: markers present only as prose ──
  is "eval: prose treated sessions"   "0"      "$(ev "$EVD/prose.json" arms.treated.sessions)"
  is "eval: prose verdict"            "false"  "$(ev "$EVD/prose.json" verdict.reportable)"
  is "eval: prose says why"           "the treated cohort is empty: no session in this corpus carries a treatment marker" \
                                      "$(ev "$EVD/prose.json" verdict.reason)"
  for k in brief_check_in_force brief_check_fired ack_in_force ack_resolved_decisions observe_check_in_force observe_check_fired; do
    is "eval: prose does not set $k"  "0"      "$(ev "$EVD/prose.json" "treatment_markers.$k.sessions_seen")"
  done
  # ...and the same four ARE set when the machinery actually emitted them.
  for k in brief_check_in_force ack_in_force ack_resolved_decisions; do
    is "eval: fixture sets $k"        "yes"    "$([ "$(ev "$EVD/full.json" "treatment_markers.$k.sessions_seen")" -gt 0 ] && echo yes || echo no)"
  done

  # ── A BLOCKED MEASUREMENT HAS NO VALUE, NOT A ZERO ──
  # The single most important pair in this group. A regression that reports 0.0 here would
  # read as the best possible result on a sample that cannot support any result at all.
  is "eval: prose omits bypass rate"     "(missing)" "$(mm "$EVD/prose.json" bypass_rate treated_rate)"
  is "eval: prose omits control rate"    "(missing)" "$(mm "$EVD/prose.json" bypass_rate control_rate)"
  is "eval: prose omits refusal bound"   "(missing)" "$(mm "$EVD/prose.json" false_refusals treated_upper_bound)"
  is "eval: prose omits latency median"  "(missing)" "$(mm "$EVD/prose.json" added_latency_seconds treated_median_seconds)"
  is "eval: prose omits added seconds"   "(missing)" "$(mm "$EVD/prose.json" added_latency_seconds added_seconds)"
  is "eval: prose omits rework rate"     "(missing)" "$(mm "$EVD/prose.json" rework_turns treated_rate)"
  is "eval: prose omits rework median"   "(missing)" "$(mm "$EVD/prose.json" rework_turns treated_median_turns)"
  is "eval: prose bypass blocked"     "false"  "$(mm "$EVD/prose.json" bypass_rate reportable)"
  is "eval: prose names the floor"    "treated n=0, need 30" "$(mm "$EVD/prose.json" bypass_rate blocked_by.0)"
  # The sample size IS a fact and is still reported; only the result is withheld.
  is "eval: prose still reports n"    "0"      "$(mm "$EVD/prose.json" bypass_rate n_treated)"

  # ── the refusing direction: a baseline that froze no sessions ──
  # Per-metric, not all-or-nothing: the one-armed measurement survives an empty control.
  is "eval: no control, bypass blocked"  "false" "$(mm "$EVD/noctl.json" bypass_rate reportable)"
  is "eval: no control, latency blocked" "false" "$(mm "$EVD/noctl.json" added_latency_seconds reportable)"
  is "eval: no control, names control"   "control n=0, need 30" "$(mm "$EVD/noctl.json" bypass_rate blocked_by.0)"
  is "eval: one-armed still reports"     "true"  "$(mm "$EVD/noctl.json" false_refusals reportable)"

  # ── the fourth position: a hook's own stderr, which no agent writes ──
  # Requested by #6, which cannot be measured without it. It is a stronger position than the
  # other three — prompt, output and command all sit somewhere an agent's text can reach,
  # while a hook_success attachment is written by the harness from the hook's own stderr.
  #   THE THIRD CORPUS IS THE ONE THAT MAKES IT A POSITION. `hookwrong` carries a
  # byte-identical `observe-check: warn` line and differs only in attachment.type and
  # hookEvent, so it fails unless the record's own fields are what is being read. Without it
  # this is a string search wearing a longer name, and a hook_additional_context attachment —
  # which an agent CAN influence, since it is fed back into the turn — would read as proof
  # that the machinery ran.
  node "$M" --corpus "$EVD/hook"      --evaluate --baseline-file "$EVD/baseline.json" --json > "$EVD/hook.json" 2>/dev/null
  node "$M" --corpus "$EVD/hookwrong" --evaluate --baseline-file "$EVD/baseline.json" --json > "$EVD/hookw.json" 2>/dev/null
  is "eval: hook stderr sets in-force"  "5" "$(ev "$EVD/hook.json" treatment_markers.observe_check_in_force.sessions_seen)"
  # ...and `fired` is the smaller set, or a cohort defined by it would hold only the turns
  # the check objected to — #5's own warning, applied to #6.
  is "eval: ...and fired only where it warned" "3" "$(ev "$EVD/hook.json" treatment_markers.observe_check_fired.sessions_seen)"
  is "eval: wrong attachment type is not it"   "0" "$(ev "$EVD/hookw.json" treatment_markers.observe_check_in_force.sessions_seen)"
  is "eval: wrong hookEvent is not it"         "0" "$(ev "$EVD/hookw.json" treatment_markers.observe_check_fired.sessions_seen)"
  # #6 IS DECLARED, NOT FOLDED IN. A session treated only by the Stop hook carries no
  # brief-check, so counting it in the #3/#4 arm would put it in the denominator of a rate it
  # cannot contribute a numerator to.
  is "eval: #6 does not define the #3/#4 arm"  "0" "$(ev "$EVD/hook.json" arms.treated.sessions)"
  is "eval: --contract pins it to hook_stderr" "2" \
     "$(node "$M" --contract | grep -c 'only where it can have been emitted: hook_stderr')"

  # ── the two arms must have been measured with the same ruler ──
  is "eval: rules match"              "true"   "$(ev "$EVD/full.json" rules_match_baseline)"
  is "eval: mismatched rules caught"  "false"  "$(ev "$EVD/wrong.json" rules_match_baseline)"
  # ...and against the REAL committed baseline, which is the invariant that keeps every
  # number in docs/meter-baseline-2026-09-01.json comparable to a future run. If a rule in
  # bin/fleet-meter.mjs is edited, this goes red and the baseline has to be retaken.
  mkdir -p "$EVD/none"
  is "eval: committed baseline's rules still current" "true" \
     "$(node "$M" --corpus "$EVD/none" --evaluate --baseline-file "$ROOT/docs/meter-baseline-2026-09-01.json" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).rules_match_baseline)))')"

  # ── a missing baseline is an error, not an empty result ──
  node "$M" --corpus "$EVD/none" --evaluate --baseline-file "$EVD/nope.json" >/dev/null 2>"$EVD/miss"
  is "eval: missing baseline exits 2" "2"      "$?"
  is "eval: ...and says so"           "yes"    "$(grep -q 'cannot read the baseline' "$EVD/miss" && echo yes || echo no)"

  # ── the contract is printable, because unwritten code has to know what to emit ──
  # Counted, not spot-checked: a marker added without a permitted position would be a string
  # search again, and this row is what makes adding one cost a deliberate edit here.
  is "eval: --contract lists every marker with its position" "6" \
     "$(node "$M" --contract | grep -c 'only where it can have been emitted')"
  # A here-string, not a pipe: `grep -q` stops at its first match and `node` then takes
  # SIGPIPE, which pipefail promotes to the pipeline's status — so a MATCH can answer 141,
  # the `&&` never fires, and this row reads "no" for a contract that does say the join.
  is "eval: --contract names the join" "yes"   "$(grep -q 'carry its verdict INTO the dispatched prompt' <<< "$(node "$M" --contract)" && echo yes || echo no)"

  # ── counts and digests, never content — same boundary as the baseline ──
  # Read line by line: two of these contain a space, and a `for` over a bare word list
  # would split them into four assertions about words that are not the thing being checked.
  while IFS= read -r leak; do
    [ -n "$leak" ] || continue
    is "eval: '$leak' is not in the output" "0" "$(grep -c -- "$leak" "$EVD/full.json" | tr -d ' ')"
  done <<'LEAKS'
acme-web
acme-api
meter-eval
per document
one picker
build the thing
LEAKS
  rm -rf "$EVD"
else
  skip "the evaluator refuses what it cannot support" "node missing"
fi

# ── 6b. every command is actually installed ──────────────────────────────────
# A new command that never reaches the install list is invisible until someone hits
# "command not found" — and worse, the SUMMARY line was hand-maintained separately from
# the loop that does the linking, so it had already drifted twice (it was still missing
# fleet-stack, then fleet-slot) and told you it had not linked a command it just had.
# The summary is derived now; this keeps the LIST honest.
group "install list covers every command"
# deliberately not linked: invoked by their parent, not by a user on PATH
NOT_LINKED="fleet-grid.mjs fleet-serve.mjs npx-install.mjs"
for f in "$ROOT"/bin/*; do
  b="$(basename "$f")"
  case " $NOT_LINKED " in *" $b "*) continue ;; esac
  # "does it appear at all", not "exactly once": ghostfleet and fleet-spawn are named
  # in prose elsewhere in the installer, and pinning a COUNT would fail on that.
  is "$b is in install.sh's list" "yes" \
     "$(grep -qE "(^|[( ])$b([ )]|\$)" "$ROOT/install.sh" 2>/dev/null && echo yes || echo no)"
done

# ── 6c. the contract and the hooks, driven by a scripted model ───────────────
# THE MISSING HALF of the group at the top of this file. That one proves the contract
# string reaches the `claude` exec — it was passed. It cannot ask whether it ARRIVED, or
# what happened next, and that is the gap an apostrophe drove through: the system prompt
# was truncated from 3589 characters to 673, the word "the" was submitted as a turn in
# every new session, and twenty-two green assertions failed to notice for a day because
# they grepped the whole argv rather than one argument.
#
# test/helpers/model-fixture.mjs closes it by pointing the real `claude` binary at a
# node:http server on loopback with ANTHROPIC_BASE_URL and the literal API key "fixture".
# Everything except the model's reasoning is real: the binary, bin/claude-here and the
# contract IT ships (extracted from that file at run time, so there is no test-only copy
# to drift), hooks/fleet-guard.sh and hooks/fleet-event.sh as installed hooks, a git
# checkout, the filesystem. One session, three scripted turns, and the row that matters
# is the one this suite could not previously write at all: a real PreToolUse hook refused
# a scripted tool call and its reason came BACK into the conversation, where the fixture
# read it.
#   BOTH DIRECTIONS, for the reason every pane assertion here runs against a busy capture
# AND an idle one. Turn 1 calls a tool the guard does not guard and turn 2 calls the one it
# does, so a guard that refuses everything fails a different row than a guard that can
# never fire. Watched going red on four deliberate breaks: an apostrophe planted in the
# contract, the guard's refusal replaced by exit 0, the guard widened to every tool, and
# the fixture's tool input sent as an object instead of the JSON string partial_json
# requires. Each reddened the row it belongs to and no others — except the apostrophe,
# which reddened two, because word-splitting the rest of the contract also hands the
# session an initial prompt and the run stops being the run under test.
#
# SKIPPED where there is no `claude`, `git` or `jq`, and the last two are not fussiness:
# both hooks open with `command -v jq || exit 0`, so without jq the guard declines in
# silence and "the guard refused" would go red for a reason that has nothing to do with
# the guard. CI runners carry none of the three, so this group skips there and runs on a
# developer machine — the same bargain as viewport-check and its Chrome, and stated here
# rather than left to be discovered.
group "a scripted model drives a real session"
MFX="$(mktemp -d "$TEST_RUNS.$$.mfx.XXXXXX")"
node "$ROOT/test/helpers/model-fixture.mjs" > "$MFX/out" 2> "$MFX/err"
mfxrc=$?
if grep -q '^#SKIP' "$MFX/out" 2>/dev/null; then
  skip "a scripted model drives a real session" \
       "$(head -1 "$MFX/out" | cut -d "$US" -f3)"
else
  is "model-fixture ran"          "0" "$mfxrc"
  is "...without complaining"     ""  "$(head -2 "$MFX/err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: a helper that died before reaching its
  # assertions emits a couple of rows and no mismatches, which reads as clean.
  is "...and produced its checks" "yes" \
     "$([ "$(wc -l < "$MFX/out")" -ge 7 ] && echo yes || echo "no: $(wc -l < "$MFX/out") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$MFX/out"
fi
rm -rf "$MFX"

# ── 6d. the Stop-hook observation check ───────────────────────────────────────
# hooks/fleet-observe.sh records whether a LEAD's turn changed a renderable surface and never
# looked at it. MEASURED, and the measurement is the reason it exists: 67 of 118 sessions that
# claimed done had opened a browser first — 0.568. And of 172 build turns that changed a screen
# file, 154 ran a test, lint or build while FOUR ever opened a browser, on exactly the surfaces
# whose defects came back as photographs.
#
# WARN ONLY, AND THAT IS THE DESIGN RATHER THAN A FIRST STEP. The numbers above justify
# instrumenting the gap; they do not say a refusal closes it. docs/improvement-plan.md #5
# exists because v1 of that plan shipped a hard gate on a correlation, and promoting this to a
# refusal is #5's decision against #5's numbers. So every assertion below is about a RECORD,
# and one of them is that the run did not change.
#
# IT KEYS ON MECHANICAL EVIDENCE, NEVER THE PROSE. A check that reads the done-report for the
# word "observed" is satisfied by a fake observation, and then it measures fluency — the
# performative-compliance failure docs/plan-critique.md names. So it reads the transcript and
# asks whether an observation tool RAN, using bin/fleet-meter.mjs's `observed` rules so the
# check and the meter cannot disagree about what a browser is.
#
# TWO HALVES BELOW, split by what each can prove.
#
# THE UNIT HALF drives the hook directly with synthesised transcripts, one per decision, and
# needs no `claude` — so it runs on both CI legs. Every row is a direction: it warns on a
# surface with no look, records `ok` when the look happened or nothing renderable changed, and
# says NOTHING at all where it could not judge. The three verdicts are distinct on purpose: a
# missing line means untreated, and `ok` means checked-and-clean, and #5's cohort is built from
# the difference. A hook that emitted `ok` when it had not actually looked would put untreated
# sessions in the treated arm, which is the contamination its marker rule exists to stop.
#   THE SCOPING ROW IS THE SHARP ONE: an observation made in an EARLIER turn must not excuse
# this one. Scoped wrongly, the check reports `ok` for every session that ever opened a browser
# once, and it would look like it was working forever.
#
# NO PIPELINE INTO THE ASSERTION, and that is not style. `{ transcript } | obs_run` puts
# obs_run in a SUBSHELL, so `is` would print its red line and increment PASS/FAIL in a copy of
# the shell that then exits — the suite stays green with the defect on screen, which is the
# exact failure this file exists to prevent. The transcript is written to a file first.
group "the Stop-hook observation check"
if command -v jq >/dev/null 2>&1; then
  OBS="$(mktemp -d "$TEST_RUNS.$$.obs.XXXXXX")"
  OBS_EXITS=""
  # Records, as command substitutions rather than as writers, so a transcript reads as a list
  # of what happened in the turn.
  obs_u()    { printf '{"type":"user","promptId":"%s","message":{"role":"user","content":"make the send button fit"}}' "$1"; }
  obs_tool() { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"%s","input":%s}]}}' "$1" "$2"; }
  obs_text() { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'; }
  obs_write() { : > "$OBS/t.jsonl"; local l; for l in "$@"; do printf '%s\n' "$l" >> "$OBS/t.jsonl"; done; }
  # $1=name $2=want-verdict (warn|ok|silent) $3=prompt_id $4=stop_hook_active.
  # THE VERDICT IS READ FROM THE MARKER AT THE HEAD OF A LINE, not from the message body — the
  # advice text under a warn mentions fleet-look and a grep for that would pass on prose.
  obs_run() {
    local rc out verdict
    out="$(printf '{"hook_event_name":"Stop","transcript_path":"%s","prompt_id":"%s","stop_hook_active":%s,"cwd":"%s"}' \
      "$OBS/t.jsonl" "$3" "$4" "$ROOT" \
      | env CLAUDE_FLEET_SOCK="${OBS_SOCK-cf-acme-api}" CLAUDE_FLEET_SLOT="${OBS_SLOT-master}" \
            CLAUDE_FLEET_ALLOW_UNOBSERVED="${OBS_OVERRIDE-0}" TMUX= \
            bash "$ROOT/hooks/fleet-observe.sh" 2>&1 1>/dev/null)"
    rc=$?
    OBS_EXITS="$OBS_EXITS$rc"
    # HERE-STRINGS, NOT PIPES. `grep -q` stops at its first match and the writer then takes
    # SIGPIPE, which `set -o pipefail` promotes to the pipeline's status — so a MATCH can
    # come back as 141 and this `if` would take the WRONG branch, reading a warn as silent.
    # $out is a hook's whole output, which is exactly the unbounded left-hand side that
    # blocks long enough for it to happen. The suite sweeps itself for the pipe form.
    if   grep -qE '^[[:space:]]*observe-check:[[:space:]]*warn\b' <<< "$out"; then verdict=warn
    elif grep -qE '^[[:space:]]*observe-check:[[:space:]]*ok\b'   <<< "$out"; then verdict=ok
    else verdict=silent; fi
    is "$1" "$2" "$verdict"
  }
  OBS_W='{"file_path":"/repo/web/app.js"}'      # a renderable surface, the way this repo ships one
  OBS_H='{"file_path":"/repo/report.html"}'     # renderable anywhere, by extension
  OBS_N='{"file_path":"/repo/bin/fleet-send"}'  # nothing fleet-look could render
  OBS_TEST='{"command":"./test/run.sh"}'
  OBS_LOOK='{"command":"fleet-look.mjs http://127.0.0.1:8787"}'
  OBS_CURL='{"command":"curl -s http://127.0.0.1:8787 | head"}'

  # THE ONE IT EXISTS FOR: a surface changed, a test run, nothing looked at.
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_TEST")" "$(obs_text)"
  obs_run "warns on a lead turn that changed a surface and never looked" warn P1 false
  # CURL IS NOT A BROWSER. A 200 says the route answered; it does not say the screen drew, and
  # turns that changed a screen and never looked at one are the entire finding.
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_CURL")"
  obs_run "...and curl does not count as looking" warn P1 false
  obs_write "$(obs_u P1)" "$(obs_tool Write "$OBS_H")" "$(obs_tool Bash "$OBS_TEST")"
  obs_run "...on a .html surface too" warn P1 false

  # `ok` — the check ran and had nothing to object to. Distinct from silence, because `ok` is
  # what puts a turn in #5's treated cohort and silence is what keeps it out.
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_LOOK")"
  obs_run "records ok when fleet-look ran in the same turn" ok P1 false
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool mcp__chrome-devtools__take_screenshot '{}')"
  obs_run "...or a chrome-devtools call" ok P1 false
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_N")" "$(obs_tool Bash "$OBS_TEST")"
  obs_run "...and when nothing renderable changed" ok P1 false
  obs_write "$(obs_u P1)" "$(obs_text)"
  obs_run "...and when the turn made no tool calls at all" ok P1 false

  # SILENT, on every path where it could not actually judge the turn. An `ok` on any of these
  # would claim a check that did not happen.
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_TEST")"
  obs_run "says nothing on the SECOND Stop of the same turn" silent P1 true
  OBS_SLOT=api-2 obs_run "...for a worker rather than the lead" silent P1 false
  OBS_SOCK= obs_run "...outside a fleet altogether" silent P1 false
  OBS_OVERRIDE=1 obs_run "...under the documented override" silent P1 false
  printf 'not json\n{ oops\n' > "$OBS/t.jsonl"
  obs_run "...on a transcript it cannot parse" silent P1 false
  obs_write "$(obs_u P1)" "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_TEST")"
  obs_run "...when the payload carries no prompt_id" silent "" false

  # SCOPED TO THIS TURN — the row that would otherwise pass forever while the check reported ok
  # for everybody: a browser opened in an EARLIER turn must not excuse this one.
  obs_write "$(obs_u P0)" "$(obs_tool Bash "$OBS_LOOK")" "$(obs_u P1)" \
            "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_TEST")"
  obs_run "an observation in a PREVIOUS turn does not excuse this one" warn P1 false
  obs_write "$(obs_u P0)" "$(obs_tool Bash "$OBS_TEST")" "$(obs_u P1)" \
            "$(obs_tool Edit "$OBS_W")" "$(obs_tool Bash "$OBS_LOOK")"
  obs_run "...and one in THIS turn records ok" ok P1 false

  # A missing transcript is the commonest silent path in practice and the easiest to break by
  # reordering the guards, so it gets its own row rather than being assumed.
  OBS_MISSING="$(printf '{"hook_event_name":"Stop","transcript_path":"%s","prompt_id":"P1","stop_hook_active":false}' \
    "$OBS/definitely-not-here.jsonl" \
    | env CLAUDE_FLEET_SOCK=cf-acme-api CLAUDE_FLEET_SLOT=master TMUX= \
      bash "$ROOT/hooks/fleet-observe.sh" 2>&1 1>/dev/null)"
  is "...and on a transcript that is not there" "" "$OBS_MISSING"

  # WARN ONLY, ASSERTED RATHER THAN INTENDED. Every path above must exit 0: a non-zero exit
  # from a Stop hook is a REFUSAL that re-opens the turn, which is exactly what this item was
  # corrected not to ship. One row over every case, so a single stray `exit 2` cannot hide.
  OBS_NONZERO="$(printf '%s' "$OBS_EXITS" | tr -d 0)"
  is "never exits non-zero on any path" "all zero over 15 cases" \
     "$([ -z "$OBS_NONZERO" ] && echo "all zero over ${#OBS_EXITS} cases" || echo "non-zero somewhere: $OBS_EXITS")"
  # And the source carries no other exit at all, which is what stops a future edit from adding
  # one below the last assertion here.
  is "...and the source has no non-zero exit in it" "yes" \
     "$(grep -qE '^[[:space:]]*exit [1-9]' "$ROOT/hooks/fleet-observe.sh" && echo no || echo yes)"
  rm -rf "$OBS"

  # WIRED, not merely present. A hook nobody installed never fires, and that is
  # indistinguishable from one that had nothing to say — the same argument as the install-list
  # group below. Stop carries TWO of ours, so assert both rather than "Stop is wired".
  is "install.sh wires the check onto Stop" "yes" \
     "$(grep -q 'OBSERVE="\$FLEET_HOME/hooks/fleet-observe.sh"' "$ROOT/install.sh" \
        && grep -q 'command: \$observe' "$ROOT/install.sh" && echo yes || echo no)"
  is "...alongside the status hook, not instead of it" "yes" \
     "$(grep -q 'Stop: stopentry' "$ROOT/install.sh" && echo yes || echo no)"
else
  skip "the Stop-hook observation check" "no jq, and the hook declines without it"
fi

# ── the same check, in real sessions ─────────────────────────────────────────
# THE FIXTURE HALF. Four things cannot be asserted from a synthesised transcript, and each is
# something Claude Code could change under us where the hook would simply go quiet: that the
# warning lands at the POSITION #5's evaluator can trust, that it does NOT re-open the turn,
# that the agent is not told, and — recorded but deliberately unused — that a Stop hook could
# block if #5 ever asks for a refusal.
#   Skipped where there is no `claude`, same bargain as the group above it.
OCO="$(mktemp -d "$TEST_RUNS.$$.oco.XXXXXX")"
node "$ROOT/test/helpers/observe-check.mjs" > "$OCO/out" 2> "$OCO/err"
ocorc=$?
if grep -q '^#SKIP' "$OCO/out" 2>/dev/null; then
  skip "the observation check, in a real session" "$(head -1 "$OCO/out" | cut -d "$US" -f3)"
else
  is "observe-check ran"          "0" "$ocorc"
  is "...without complaining"     ""  "$(head -2 "$OCO/err" | tr '\n' ' ' | sed 's/ *$//')"
  # A floor, for the reason pwa-check documents: a helper that died before its assertions emits
  # a couple of rows and no mismatches, which reads as clean.
  is "...and produced its checks" "yes" \
     "$([ "$(wc -l < "$OCO/out")" -ge 12 ] && echo yes || echo "no: $(wc -l < "$OCO/out") rows")"
  while IFS=$'\x1f' read -r name want got; do
    is "$name" "$want" "$got"
  done < "$OCO/out"
fi
rm -rf "$OCO"

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
for f in "$ROOT"/mcp/*.mjs "$ROOT"/test/helpers/*.mjs; do
  node --check "$f" >/dev/null 2>&1 && ok "$(basename "$f") parses" || bad "$(basename "$f") parses" "ok" "syntax error"
done
node --check "$ROOT/hooks/opencode-fleet-event.js" >/dev/null 2>&1 && ok "opencode plugin parses" || bad "opencode plugin parses" "ok" "syntax error"

printf '\n%s passed  %s%s failed%s  %s skipped\n' "$PASS" "$([ "$FAIL" -gt 0 ] && printf '%s' "$R")" "$FAIL" "$N" "$SKIP"
[ "$FAIL" -eq 0 ]
