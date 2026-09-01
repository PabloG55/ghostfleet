# Improvement plan — v2, after critique

**The goal, in the words it was asked in:** something that makes the master smart enough to
ask questions back, understand all the problems, and send the work to agents accordingly.

**This is a rewrite.** v1 was reviewed by an independent critic that did not share its author's
context (`docs/plan-critique.md`, codex/gpt-5.6-terra), and the critique was largely upheld.
What changed and why is recorded in §4 rather than quietly absorbed, because the reasons are
more useful than the conclusions.

The single most damaging finding, stated in the critic's words: v1 rejected a brief-quality
gate on prompt features because six such features show no measurable effect — and then made
`Done when:` mandatory, **which is one of those six features.** *"Calling it 'structure' does
not remove the conflict."* That is correct, and it is the kind of contradiction an author
cannot see in their own plan.

---

## 0. What is already in force, so this is not read as starting from zero

- a ten-clause contract in every session's system prompt, delivered whole (3589 chars,
  verified by capturing the argument rather than grepping the file — it was silently truncated
  to 673 for a day while twenty-two green assertions failed to notice)
- `fleet-look` — render a URL, page, PDF or image to a PNG the agent can read; `--tree` for the
  accessibility tree; golden comparison with a pixel-fraction threshold and an
  expected/actual/diff triple written on failure
- a `PreToolUse` guard refusing dispatch-by-subagent from a lead
- a dispatch log: what was sent, its length and digest, never its body

---

## 1. The plan

### #1 — Fixture feasibility spike. Find out if the harness is even possible

**First, and it may end here.** Stand up a loopback HTTP server speaking the model wire
protocol, point a real session at it, and answer one question: **can Claude Code be driven
this way at all, with the shipped prompt asset and real hooks?** If it cannot, stop — and
several later items lose their foundation, which is worth knowing in a day rather than after
building on them.

**Why this moved from last to first.** v1 argued a fixture server replaces the model, so it
cannot show that an agent complied, only that surrounding machinery responded — and demoted it
to seventh. The mechanism claim is still true. The ordering was wrong: a Stop-hook enforcer is
being planned against a hook API nobody has verified can see turn-scoped output. Building the
enforcer first is building on an assumption; the spike is how the assumption gets tested, and
it is cheap.

**Verified in gentle-ai's code, not just their docs:** seven `httptest.NewServer` sites in
`e2e/organicruntime/`, an OpenAI-compatible provider pointed at loopback with the literal API
key `fixture`, no agent code patched. The prompt asset is read from the same file shipped to
users, so there is no test-only copy to drift.

**Cost.** 1–2 days for the spike. `node:http`, no dependency.

**What it does NOT do.** It cannot prove an agent complied with a clause — the model's
decisions are the script. It proves the machinery around them.

**BUILT, AND THE ANSWER IS YES.** `test/helpers/model-fixture.mjs`, one group in
`test/run.sh`, `node:http` only. It cost hours rather than the 1–2 days budgeted, because
the door was already open: Claude Code reads `ANTHROPIC_BASE_URL` and posts an ordinary
`POST /v1/messages?beta=true` to whatever is there, with `x-api-key: fixture` and nothing
on the other end validating it. **No agent code patched**, which was the property worth
copying.

What was OBSERVED, in order, driving the real 2.1.252 binary through `bin/claude-here`:

- the request arrives — a standard Messages API body, `stream: true`, so the fixture has to
  answer in SSE rather than JSON; tool input comes back as a JSON **string** in
  `partial_json`, and sending the object instead calls the tool with no arguments
- **the shipped contract is in it.** A 3-block `system` array whose last block carries the
  3589 characters extracted from `bin/claude-here` at run time. There is no test-only copy,
  which was gentle-ai's load-bearing detail and transfers intact
- a scripted `Write` produced a real file with the scripted bytes
- **a real `PreToolUse` hook refused a scripted tool call and its reason came back into the
  conversation as an ordinary `tool_result`, where the fixture read it.** That is the
  assertion class `docs/external-tools-review.md` says this suite could not write at all.
  Scripted `Agent` from a lead → `hooks/fleet-guard.sh` exits 2 → its stderr returns
- the whole session costs **0.6 seconds**. The E2E-leg cost the review warned about does not
  materialise, because the latency being removed is the model's

**The gap the review named is closed.** Its own "one gap that would change a
recommendation" was that the technique was verified for OpenCode — the runtime whose
ghostfleet path carries no contract — and unverified for Claude Code, the one that has it.
It is now verified for Claude Code, on the contract, by the assertion above.

**And it settles #6 rather than only enabling it** — see there.

**The honest limits.** It skips where there is no `claude`, `git` or `jq`, so it runs on a
developer machine and skips on both CI legs; a green CI leg is not evidence this ran. It
proves plumbing, not compliance, exactly as stated above. And nothing here was
packet-captured: the telemetry-suppressing environment variables are set and every model
call went to loopback, but "no egress at all" is asserted from the fixture's request log,
not measured at the socket.

---

### #2 — Baseline meter, and a pre-registered sample, before anything is changed

A reader over `~/.claude/projects/` emitting, per session and per branch: tool calls per turn,
whether a browser was opened before a done-claim, turns-to-done, seconds spent sleeping inside
a turn, corrections per distinct file touched.

**Two rules the critique insisted on and v1 did not have.**

- **Mechanically observable events stay separate from hand-labelled corrections.** A sleep count
  is a fact; "this was a correction" is a judgment. Mixing them produces a number nobody can
  audit.
- **The sample is pre-registered, and it is drawn BEFORE the interventions ship.** v1's
  falsification compared a future sample against past numbers on a moving corpus with no
  control. That cannot attribute a change to a cause. State the cohort, the protocol and the
  exclusions in advance — including that the sessions which produced this plan are outliers and
  are excluded by name.

**Why it is second rather than sixth.** Everything below is judged against it. Shipping the
interventions first and measuring afterwards is what makes a result unfalsifiable.

**MEASURED, and all of it retrospectively by hand — which is the argument for automating it:**
4 of 172 build turns that changed a screen file ever opened a browser; one window carried 173
tool calls of which 28 were sleeps totalling ~16,000 seconds, 32% of that session's API calls;
median 4 turns for sessions with 0–1 corrections against 63 for the 5+ group; 0.009 corrections
per distinct file touched against 0.116.

**Cost.** 1–2 days. No dependency. Privacy boundary stated explicitly: counts and digests, never
message bodies — the same rule the dispatch log already follows.

---

### #3 — A closed-loop brief protocol. **Warning-only. Not a gate.**

Before dispatch, the lead runs the ask against the eight extraction axes and puts the
**unanswered material ones** back as a numbered list. `fleet-spawn` **warns** when a brief has
no done-criterion or reads as several asks. It does not refuse.

**Why warning and not refusing — this is the correction that matters most.** v1 made it a hard
gate and justified it as gating on *structure* rather than on *quality*. That distinction does
not survive: `Done when:` is literally one of the six prompt features measured at no effect
(length, naming a file, naming a route, stating a done-criterion, carrying a reference image,
human-vs-lead authorship — all in a 20–30% band with fully overlapping intervals). A gate built
on a null feature is a gate built on nothing.

**And its named failure mode is this repo's own dominant one.** In the critic's words:
*"performative compliance: the lead manufactures one deliverable and a vacuous done line, the
worker echoes it, every visible field looks disciplined, and the human's missing choice remains
missing."* `Done when: implemented` passes any parser. A signal that reports a state other than
the one it is in is exactly what 41% of this repo's PRs exist to fix, and a hard gate here
would have manufactured a new one.

**What the evidence actually supports.** The two-session contrast — *"build a per-document
signature-template picker on the envelope builder's Documents step"* at 2 turns and 0
corrections, against *"three items … item 3 is research first"* at 67 turns and 26 — is n=2 and
confounded on its face: it does not separate bundling from scope, difficulty, task type or human
availability. That 17 clean sessions bundled no multiple asks is a conditional association. Both
are reasons to **warn and count**, not to block.

**The axes**, each derived from a late requirement that actually arrived: the **unit** (per line,
per document, per policy) · **parity** with an existing surface · **reuse** rather than recreate ·
the **gate** before advancing · **completeness** of a list · **eligibility and exit** ·
**retroactivity** · and for a rendered artifact, **is there an existing one to match**.

**MEASURED.** 36 of 163 screen-attributed corrections were requirements stated for the first time
mid-flight. By knowability: 5 unknowable until the screen existed, 11 implied and never written
down, 19 already known to the human and not said — **30 of 36 addressable.** They arrived at
positions #3, #4, #5, #7, #15 of runs that took 24, 34 and 42 corrections; one was restated at
#39 and again at #45 of 67.

**Not "ask more questions".** End-of-turn asking is saturated at **25.6% of turns** with a
statistically identical rework rate. The axes are specific and answerable in seconds.

**Cost.** Hours for the clause. ~1 day for the warning and its counters.

**Ceiling, stated where a reader would otherwise oversell it.** The axes make the lead *ask*
whether grouping is per-line or per-document. They do not supply the answer. The 19 requirements
held and unsaid become questions, not correct guesses.

---

### #4 — Worker acknowledgement handshake, tied to resolved decisions

The worker's first act records its one-line restatement **and which of the lead's stated
decisions it is working from**, into the manifest. `fleet-worktrees` shows ASKED beside
UNDERSTOOD.

**Why "tied to resolved decisions" and not just a restatement.** v1 proposed the restatement
alone; the critique's objection is that it *"makes disagreement displayable, not preventable"* —
a worker can restate correctly and build something else, and nothing closes the loop. Binding
the acknowledgement to the specific answers from #3 gives the pair something to disagree
*about*, and makes a worker proceeding without a resolved decision visible.

**MEASURED.** 23 of 79 corrections that are about the agent rather than the code are *"that is
not what I asked / you went the wrong way"* — the largest of those kinds. The manifest records
what the lead asked and nothing records what the worker heard.

**Cost.** ~half a day.

---

### #5 — Evaluate, then promote only demonstrated failures to hard gates

Against the #2 baseline, measure: false refusals, bypass rate (how often `Done when:` is
vacuous), added latency per dispatch, and rework. **Only a failure mode that shows up here earns
a hard gate.**

This is the item v1 did not have at all, and its absence is why v1 could ship a gate on a
correlation. It is also the honest answer to *"did any of this work"*.

---

### #6 — Stop-hook observation check — **built, and WARN ONLY**

A `Stop` hook records whether a **lead's** turn changed a surface somebody could look at and
never looked at it. It does not refuse, does not exit non-zero, and does not change what the
session does next. `hooks/fleet-observe.sh`, wired onto `Stop` beside `fleet-event.sh`.

**Warn and not refuse, which is a correction to this item as written.** v2 specified a hook
that *"refuses a done-report naming no observation"*. That is a hard gate, and #5 in this same
document says only a failure mode that shows up in its evaluation earns one. The evidence here
is a gap, not a remedy: **67 of 118 sessions that claimed done had opened a browser first —
0.568**, and separately 4 of 172 build turns that changed a screen file ever opened a browser.
That justifies instrumenting the gap. It does not say a refusal is what closes it, and nothing
in this repo can currently say so. Shipping the refusal would have been asserting the fix
works — the exact shape of error #5 exists to prevent, and the one the critique caught in v1.
Promotion is #5's call against #5's numbers.

**It keys on mechanical evidence, never on the prose of the done-claim.** A hook that reads the
report for the word "observed" is satisfied by naming a *fake* observation, and then it measures
fluency instead of work — `docs/plan-critique.md`'s performative-compliance finding, arriving
through the door this item opens. So it reads the transcript and asks whether an observation
tool actually **ran**, reusing `bin/fleet-meter.mjs`'s `observed` rules (chrome-devtools tools,
or a shell command naming `fleet-look` / `playwright` / `puppeteer` / `chromium`; **curl
excluded** — a 200 says the route answered, not that the screen drew).

#### The three questions, measured

**Q1 — can a `Stop` hook block? YES, and it is deliberately not used.** exit 2 puts the hook's
stderr into the conversation as a user message prefixed `Stop hook feedback:` and the session
keeps working; the second `Stop` of the same turn carries `stop_hook_active: true`, which is
the re-entry flag that keeps such a refusal from looping. Both are pinned by the suite using a
**test-only** hook, so that if #5 ever says promote, the mechanism is known to work rather than
hoped to — but the shipped behaviour does not depend on the answer.

**Q2 — does `last_assistant_message` carry the whole final message? NO — only its last text
block.** A scripted final message of two text blocks arrived as the second one alone. It is the
obvious thing to key on and it is wrong twice over: it is prose, and it is partial. Recorded so
that the day it changes, the row that changes is a row about a fact.

**Q3 — can a `Stop` hook see the turn's tool calls? YES, and scoped exactly.** The payload's
`prompt_id` equals the `promptId` on the transcript's user records, so the turn is everything
after the **first** user record carrying that id. First and not last: a blocked-and-continued
turn gets a *second* user record with the same id (the injected feedback), so scoping to the
last one would hide every tool call made before the objection — the turn would look emptier the
more it had been told to do.

#### A fourth question nobody asked, and it decided the design

**Where can a non-blocking `Stop` hook's warning actually go?** Four channels, each driven
through a real session and scored by the model turns it caused:

| channel | model turns | in transcript | reaches the agent |
|---|---|---|---|
| stderr, exit 0 | **2** (the baseline) | yes | no |
| stdout `{"systemMessage":…}` | 2 | yes | no |
| stdout, plain text | 2 | yes | no |
| stdout `{"additionalContext":…}` | **10** | yes | **yes** |

`additionalContext` is the tempting one — the only channel that reaches the agent without
exit 2 — and it is **not a warning**: it re-opens the turn. The session went round eight extra
times, each `Stop` appending another copy of the same context, with nothing in the payload
saying so. A "warn-only" hook built on it would quietly multiply every lead turn that touched a
surface, which is worse than the refusal it was avoiding. So the hook uses **stderr with
exit 0**, the agent is not told, and the contract in the system prompt remains what speaks to
the agent.

#### The marker, and a position #5 does not yet declare

Per #5's rule — a marker is a **position**, not a string, because its first run classified a
session as treated on a bare word match and the session it matched was the one *writing* the
marker. Measured, this is where the line lands:

> an `attachment` record, `attachment.type == "hook_success"`,
> `attachment.hookEvent == "Stop"`, the line at the head of `attachment.stderr`

```
observe-check: ok   surfaces=<n> looked=<0|1>     the check ran and had nothing to say
observe-check: warn surfaces=<names> looked=0     a surface changed and nothing looked
```

Both levels are emitted, because **in force** (the machinery ran) is the cohort and **fired**
(it objected) is the denominator — a cohort defined by "fired" contains only turns the check
disliked, which is #5's own warning. Nothing is emitted at all where the check could not
actually judge the turn, so an untreated session never lands in the treated arm.

**This is a FOURTH position, and #5 declares only three** (`prompt`, `output`, `command`). A
hook-stderr attachment is none of them, and no agent's prose can forge that record — it is a
stronger position than the three, not a weaker one. **#5 has to add it or this item is
unmeasurable**, and that is a dependency stated rather than assumed. The pattern to add:

```
observe_check_in_force: { of: '#6', level: 'in force', where: ['hook_stderr'],
  re: /(?:^|\n)[^\S\n]*observe-check:[ \t]*(?:ok|warn)\b/i }
observe_check_fired:    { of: '#6', level: 'fired',    where: ['hook_stderr'],
  re: /(?:^|\n)[^\S\n]*observe-check:[ \t]*warn\b/i }
```

#### Scope, and where it stays quiet

Lead only (`CLAUDE_FLEET_SLOT` = `master`), so one session per fleet is instrumented and a rule
that turns out to be wrong costs one turn rather than the whole fleet's. Silent — not even
`ok` — on every path where it could not judge: no `jq`, no transcript, an unreadable or
truncated one, no `prompt_id`, a second `Stop` of the same turn, outside a fleet, not a lead, or
`CLAUDE_FLEET_ALLOW_UNOBSERVED=1`.

**"Renderable surface" is a definition this item had to invent, and it is the one real judgment
call in here.** `fleet-meter.mjs` deliberately does not define "screen file" — it says so, and
emits the unconditioned number instead. Warning on *any* changed file would fire on shell
scripts and TUI code where no render exists to satisfy it, so the rule is: extensions that are
always a rendering layer (`.html .css .scss .svg .jsx .tsx .vue .svelte` …), plus a plain script
under a `web/` `public/` `client/` `www/` directory, which is how this repo ships its own
screens. **A bare `.js` outside those directories is a known blind spot, left blind on
purpose** — widen it when the meter shows cases being missed, not on a guess.

**What is NOT established.** Whether warning changes anything. That is the whole point of
leaving it to #5, and this item ships the instrument, not the claim.

---

### #7 — Doctor envelope, when the reaper is actually built

`reason_code`, `safe_next_step`, and `--plan` / `--dry-run` / `--apply` on destructive commands.
Adopted as a shape from `engram`, not a dependency.

**Deferred, not dropped, and the reason is a correction.** v1 ranked this fourth on the argument
that it must exist *before* the docker-stack reaper. That still holds — but no reaper exists yet,
and a convention with nothing applying it is documentation. It lands with the reaper.

Its value is concrete: today `fleet-stop --reclaim` printed *"kept the worktree (see the reason
above)"* and the reason had scrolled off. With the envelope that is
`reason_code: session_gone_path_unknown` plus the exact command.

---

## 2. Dropped

**`Derivation` (`measured | proxy | unobservable` as a type, from gentle-ai).** v1 ranked it
fifth. It is a good shape and it does not earn a place yet: nothing consumes the field until #2
exists, and #2 can emit its own honest nulls without adopting a type system for them. Revisit if
#2's output starts being read by something that could confuse a proxy for a measurement.

---

## 3. Rejected — and three of v1's rejections were wrong

| | status |
|---|---|
| `engram` as an installed memory system | **rejected on cost** — a binary and a daemon on a port. But v1 overreached: *"do not install engram"* is supportable, *"this memory failure cannot exist"* is not. A PR does not retain unanswered questions, rejected approaches, or lead context. The gap is real; the product is not the answer |
| `engram`'s private-redaction | rejected — strictly weaker than the digest-based name sweep already here |
| `gentle-ai` as configurator/installer | rejected — inverts ownership of `install.sh` |
| RDD, receipts, lifecycle gates | rejected — branch protection already gates |
| personas and output styles | rejected — asserted where this repo is measured |
| the SDD artifact chain | **v1's rejection was wrong in inference.** A rate for generic end-of-turn questions cannot refute a *conditional* lightweight decision record used only where ambiguity is material. Reject the large artifact chain; do not reject every durable clarification artifact. What survives is folded into #3 |
| a council or debate layer | **v1 over-rejected.** The token result rules out a general debate layer, not one cheap independent pre-dispatch critic checking a resolved brief against known code. That is a candidate for the #5 experiment, not a settled rejection — and this document is the evidence, since an independent critic just found a contradiction its author could not |
| a hard brief-quality gate | rejected **as a gate**, kept as a warning in #3, for the reason in #3 |

---

## 4. What changed from v1, and why

| | v1 | v2 |
|---|---|---|
| the brief gate | hard refusal, ranked #1, justified as "structure not features" | **warning only**, ranked #3 — `Done when:` *is* one of the six null features |
| fixture server | ranked #7, on the argument that it cannot prove compliance | **ranked #1 as a feasibility spike** — the enforcer below it rests on an unverified hook API |
| the meter | ranked #6, "measures rather than treats" | **ranked #2** — a baseline drawn *before* the change, or nothing below it is attributable |
| falsification | future sample vs past numbers | **pre-registered cohort, stated exclusions, mechanical events kept apart from labels** |
| restatement | worker echoes the ask | **tied to resolved decisions** — echoing displays disagreement without preventing it |
| an evaluation step | absent | **#5, and its absence is why v1 could gate on a correlation** |
| `Derivation` | ranked #5 | **dropped** |
| doctor envelope | ranked #4, "before the reaper" | **deferred to the reaper** |
| council / SDD / memory rejections | stated as settled | **three narrowed or reopened** |

**One thing v1 got right and is worth keeping:** a clause is read once and decays — this corpus
holds an agent's own *"Nobody has opened the UI. I've said this four times and it's still
true."* That argument is why #3 still ships a mechanism rather than a paragraph. It is only the
strength of that mechanism that was wrong.
