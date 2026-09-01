#!/usr/bin/env bash
# ghostfleet Stop-hook observation check — WARN ONLY. It records whether a LEAD's turn changed
# a surface somebody could look at and never looked at it. It never refuses, never exits
# non-zero, and never changes what the session does next.
#
# ── WHY WARN AND NOT REFUSE, WHICH IS THE WHOLE DESIGN ───────────────────────
# The evidence for this item is a gap, not a remedy. MEASURED by the baseline: 67 of 118
# sessions that claimed done had opened a browser first — 0.568. That justifies INSTRUMENTING
# the gap. It does not say a refusal is what closes it, and nothing in this repo can currently
# say so. docs/improvement-plan.md #5 exists precisely because v1 of that plan shipped a hard
# gate on a correlation, and the critique's finding was upheld: a gate built on a null or
# unevaluated feature is a gate built on nothing. So promotion from warning to refusal is #5's
# decision, taken against #5's numbers, not this file's to assume.
#   The same doctrine as #3 and #4: warn, count, and let the evaluator decide.
#
# THE MECHANISM WOULD HAVE ALLOWED A REFUSAL, and that is recorded rather than used. Measured
# with test/helpers/model-fixture.mjs: a Stop hook CAN block — exit 2 puts its stderr back into
# the conversation as a user message prefixed "Stop hook feedback:" and the session keeps
# working, and the second Stop of the same turn carries stop_hook_active=true, which is what
# would keep such a refusal from looping. Both facts are pinned by the suite so that the day
# #5 says "promote this", the mechanism is known to work rather than hoped to.
#
# ── WHAT IT KEYS ON, AND WHY NOT THE WORDS ───────────────────────────────────
# NEVER the text of the done-report. A check that reads the report for the word "observed" is
# satisfied by naming a FAKE observation, and then it measures fluency instead of work — the
# performative-compliance failure docs/plan-critique.md names: the lead manufactures one
# deliverable and a vacuous done line, every visible field looks disciplined, and the missing
# choice stays missing. A signal that reports a state other than the one it is in is what a
# large share of this repo's PRs exist to fix, and keying on prose would have added one.
#
# So it reads the TRANSCRIPT and asks whether an observation tool actually RAN. The rules are
# bin/fleet-meter.mjs's `observed` half, reused rather than re-invented so the check and the
# meter cannot disagree about what a browser is:
#
#   observation : any mcp__chrome-devtools__* tool call, or a shell command naming
#                 fleet-look / playwright / puppeteer / chromium
#   NOT         : curl. A 200 says the route answered; it does not say the screen drew, and
#                 turns that changed a screen and never looked at one are the whole finding.
#                 Counting curl would report those turns as having looked.
#   touched     : Edit / Write / NotebookEdit / MultiEdit — written, not read
#
# ── THE TURN, AND WHY THE SCOPING IS EXACT ───────────────────────────────────
# MEASURED: the payload's prompt_id equals the promptId on the transcript's user records, so
# the turn is "everything after the FIRST user record carrying this prompt_id".
#   FIRST and not last, which is not stylistic. If this ever becomes a refusal, a
# blocked-and-continued turn gets a SECOND user record with the same prompt_id — the injected
# feedback message — so scoping to the last one would hide every tool call made before the
# objection, and the turn would look emptier the more it had been told to do.
#
# A third fact is measured and deliberately NOT used: last_assistant_message carries only the
# FINAL TEXT BLOCK of a multi-block message, not the whole message. It is the obvious thing to
# key on and it is the wrong thing twice over — it is prose, and it is partial.
#
# ── HOW THE WARNING IS EMITTED, WHICH TOOK MEASURING ─────────────────────────
# stderr with exit 0, and that is the only one of four candidates that is genuinely a warning.
# Measured, driving a real session per channel and counting the model turns it caused:
#
#   stderr + exit 0                    2 turns (the baseline)  transcript: yes  model: no
#   stdout {"systemMessage":...}       2 turns                 transcript: yes  model: no
#   stdout plain text                  2 turns                 transcript: yes  model: no
#   stdout {"additionalContext":...}   TEN turns               transcript: yes  model: YES
#
# additionalContext is the tempting one, because it is the only channel that reaches the agent
# without exit 2. It is not a warning: it RE-OPENS the turn. The session went round eight extra
# times, each Stop appending another copy of the same context, and nothing in the payload says
# it is happening. A "warn-only" hook built on it would quietly multiply every lead turn that
# touched a surface — which is worse than the refusal it was trying not to be.
#
# So the agent is NOT told. This writes a record for the operator and for the evaluator, and
# the contract in the system prompt is what speaks to the agent.
#
# ── THE MARKER IS A POSITION, NOT A STRING ───────────────────────────────────
# docs/improvement-plan.md #5's evaluator identifies treated sessions mechanically, and its
# first run classified a session as treated because the marker string merely APPEARED in it —
# the session that appeared in being the one writing the marker, which would have filled the
# treated arm with the treatment's own unusually-careful construction work. So a marker
# declares WHERE it may appear, and the position has to be somewhere only machinery can write.
#
# MEASURED, this is where this line lands, and it is a fourth position beyond the three that
# evaluator currently declares (prompt / output / command):
#
#   an `attachment` record, `attachment.type == "hook_success"`,
#   `attachment.hookEvent == "Stop"`, the line at the head of `attachment.stderr`
#
# Nothing an agent writes can produce that record, so this position needs no anchoring to be
# safe — and it is anchored anyway, to the head of a line with the payload after it, so that a
# grep over raw transcript text is right too. `observe-check:` alone is prose;
# `observe-check: warn` at the head of a line is a program talking.
#
#   observe-check: ok    surfaces=<n> looked=<0|1>      the check ran and had nothing to say
#   observe-check: warn  surfaces=<names> looked=0      a surface changed and nothing looked
#
# `ok` is emitted too, and that is the cohort rather than noise: IN FORCE means the machinery
# ran at all, FIRED means it objected. A cohort defined by "fired" would contain only turns the
# check disliked, so any rate computed over it is measured against a population selected for
# being warned. That is #5's own warning, and this emits both levels so it cannot happen here.
#
# ── SILENT EVERY TIME IT CANNOT TELL ─────────────────────────────────────────
# No line at all — not even `ok` — when the check could not actually evaluate the turn: no jq,
# no transcript, an unreadable or truncated transcript, no prompt_id, not a fleet session, not
# a lead, or the override. An `ok` on those paths would claim a check that did not happen, and
# would put untreated sessions in the treated cohort, which is the same contamination the
# position rule above exists to stop.
#
# A SEPARATE script from hooks/fleet-event.sh on purpose, which must always exit 0 as well:
# keeping them apart is what stops one file's bug from becoming the other's. The same
# reasoning that split fleet-guard.sh out.

# Route by the LIVE tmux server, not a possibly-stale CLAUDE_FLEET_SOCK — same reasoning as
# the other two hooks: a --resume/--fork Claude can carry an env var from an earlier context.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

command -v jq >/dev/null 2>&1 || exit 0
[ "${CLAUDE_FLEET_ALLOW_UNOBSERVED:-0}" != 1 ] || exit 0

input="$(cat)"
# US and not tab, because STOP_ACTIVE and the paths are optional and tab is IFS-whitespace: an
# absent field would collapse and shift every later one left. Our own wire, so the unit
# separator is right here — the rule about tmux's formatter rewriting it does not reach a hook.
IFS=$'\x1f' read -r EVENT TRANSCRIPT PROMPT_ID STOP_ACTIVE CWD < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.transcript_path // ""),
      (.prompt_id // ""),
      (.stop_hook_active // false | tostring),
      (.cwd // .workspace.current_dir // "") ] | join("\u001f")' 2>/dev/null
)

[ "$EVENT" = "Stop" ] || exit 0
# ONE LINE PER TURN, not one per Stop. Nothing here blocks, so a second Stop of the same turn
# can only come from somebody else's hook — and a turn that emitted two records would be
# counted twice by anything averaging over them.
[ "$STOP_ACTIVE" != true ] || exit 0
[ -n "$PROMPT_ID" ] || exit 0
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# A LEAD'S DONE-CLAIM ONLY. Every project has a session called `master` and that is the lead; a
# worker keeps today's behaviour. Narrower than the contract's audience on purpose, and it is
# also what keeps the cohort clean: one session per fleet is instrumented.
[ -n "${CLAUDE_FLEET_SOCK:-}" ] || exit 0
[ "${CLAUDE_FLEET_SLOT:-}" = master ] || exit 0

# ── read the turn ────────────────────────────────────────────────────────────
# STREAMED, not slurped. `jq -s` would load a whole transcript into memory on every Stop and a
# long session's is megabytes; `jq -n 'reduce inputs'` walks it in one pass with a fixed
# footprint. A Stop hook runs on the human's critical path, so this has to be cheap.
#
# THE `started` FLAG IS WHAT MAKES IT TURN-SCOPED. Records before this turn's opening user
# record are not counted at all, so an observation made in an EARLIER turn cannot excuse this
# one — which is the point of scoping, and the mistake that would make the check report `ok`
# for every session that ever opened a browser once.
IFS=$'\x1f' read -r TOUCHED OBSERVED SURFACES < <(
  jq -rn --arg pid "$PROMPT_ID" '
    def isrender:
      # A RENDERABLE SURFACE, not any file. fleet-look renders a URL, page, PDF or image, so
      # warning about a turn that changed a shell script or a TUI would be a warning nothing
      # could satisfy. Two halves: extensions that are always a rendering layer, and a plain
      # script UNDER a client directory, which is how this repo ships its own screens
      # (web/app.js). A bare .js outside those directories is a KNOWN blind spot, left blind
      # deliberately: widen it when the meter shows cases being missed, not on a guess.
      test("[.](html?|css|scss|sass|less|svg|jsx|tsx|vue|svelte)$"; "i")
      or test("(^|/)(web|public|client|www)/.*[.](js|mjs|ts)$"; "i");
    reduce inputs as $e (
      { started: false, touched: [], observed: false };
      if ($e.type == "user") and ($e.promptId == $pid) and (($e.message.content | type) == "string")
        then .started = true
      elif .started and ($e.type == "assistant") and (($e.message.content | type) == "array")
        then reduce ($e.message.content[] | select(.type == "tool_use")) as $t (.;
               if ($t.name | test("^mcp__chrome-devtools__")) then .observed = true else . end
             | if ($t.name == "Bash")
                 and ((($t.input.command // "")) | test("\\b(fleet-look|playwright|puppeteer|chromium)\\b"; "i"))
                 then .observed = true else . end
             | if (["Edit","Write","NotebookEdit","MultiEdit"] | index($t.name))
                 and ((($t.input.file_path // "")) | isrender)
                 then .touched += [$t.input.file_path] else . end)
        else . end)
    | [ (.touched | unique | length | tostring), (.observed | tostring),
        (.touched | unique | map(sub("^.*/"; "")) | .[0:4] | join(" ")) ]
    | join("\u001f")' "$TRANSCRIPT" 2>/dev/null
)

# A TRANSCRIPT THIS COULD NOT READ IS NOT A FINDING. jq failed, the file is truncated, or the
# schema moved: TOUCHED comes back empty or non-numeric and the check says nothing at all,
# rather than reporting an `ok` it did not earn.
case "${TOUCHED:-}" in ''|*[!0-9]*) exit 0 ;; esac

# `ok`, on both of the paths where the check ran and had nothing to object to: nothing
# renderable changed, or something did and the turn looked at it. Both are IN FORCE, and the
# fields say which so the two are separable afterwards.
if [ "$TOUCHED" = 0 ] || [ "$OBSERVED" = true ]; then
  printf 'observe-check: ok surfaces=%s looked=%s\n' \
    "$TOUCHED" "$([ "$OBSERVED" = true ] && echo 1 || echo 0)" >&2
  exit 0
fi

{ printf 'observe-check: warn surfaces=%s looked=0\n' "$SURFACES"
  echo "  This turn changed a surface somebody could look at, and no observation tool ran in"
  echo "  it. Measured over real work: 154 of 172 build turns that changed a screen ran a test,"
  echo "  a lint or a build, and FOUR ever opened a browser — on exactly the surfaces whose"
  echo "  defects came back as photographs."
  echo "      fleet-look.mjs <url | file.html | file.pdf | file.png>   # prints a PNG path; read it"
  echo "      fleet-look.mjs <url> --tree                             # is the control there and named"
  echo "  A WARNING, not a refusal: nothing was blocked and the session was not told. Whether"
  echo "  this should ever refuse is docs/improvement-plan.md #5's decision, against its"
  echo "  numbers. Silence it with CLAUDE_FLEET_ALLOW_UNOBSERVED=1"; } >&2
exit 0
