# Verdict: the plan mistakes formatted briefs for understood work

**Verdict: do not build the ranked plan as written.** Its central intervention (#1) is a hard
gate justified by two sessions and a selected cross-section, but it only proves a surface form.
It cannot establish that the lead learned the missing decision, that the human answered the
question, or that the worker received the answer. The proposed outcomes then mix all three
interventions with task mix and observation opportunity. A pass would not show #1 worked; a
failure would not cleanly falsify it.

The reported corpus may still contain a real signal. Since the 324 labels are unavailable, this
review treats every reported count as accurate. Even under that generous assumption, the
inferences below do not follow. If labels or denominators are wrong, the case for #1 and #2
weakens further; it does not rescue the causal claims.

## Findings, ordered by severity

### 1. #1 is a prompt-feature gate under another name

The plan rejects a “brief-quality gate on prompt features” because its six features have
overlapping 20–30% intervals ([plan lines 199–200](improvement-plan.md#L199)). It immediately
makes `Done when:` mandatory ([lines 38–42](improvement-plan.md#L38)). That is exactly one
of the rejected features: stating a done-criterion. Calling it “structure” does not remove the
conflict. A numbered list is presentation, not a reliable deliverable count: it can be one
change’s acceptance criteria, a research method, or named UI states; three independent asks can
be prose.

The headline contrast is observational, n=2, and confounded on its face: the clean session
touched 95 files in two turns, while the other was explicitly three items including research
first ([lines 44–50](improvement-plan.md#L44)). It does not isolate bundling from scope, task
type, difficulty, prior state, model behavior, or human availability. The 17 clean versus 15
high-correction sessions is a conditional association, not an estimate that refusal changes
corrections. No count says how often one-deliverable briefs failed, multi-ask work succeeded, or
the proposed parser classifies either. “None of 17” is descriptive, not a mandate to block work.

The cost is understated. The promised semantics require a UI classifier, deliverable parser,
escape-hatch/audit policy, shell/MCP parity, refusal copy, and fixtures proving false accepts and
false rejects. The repository doctrine requires testing both directions for a claimed detector
([CLAUDE.md lines 105–117](../CLAUDE.md#L105)); the plan supplies no fixture set or operational
definition. This is not a one-day validation check.

Finally, the easy bypass is `Done when: implemented`. The plan admits it cannot supply what the
lead does not know ([lines 59–60](improvement-plan.md#L59)). That defeats its claim to make the
lead ask better questions. It selects for agents that can format a brief and blocks valid
multi-part work until it is artificially split.

### 2. The proposed evaluation cannot falsify its theory

The plan says #1–#3 are falsified if three rates do not move after four weeks
([lines 211–221](improvement-plan.md#L211)). None identifies their effect.

- `P(correction | previous turn was a correction)` measures correction streaks. It can rise
  because uncertainty surfaces earlier, and fall because task mix changes. It is not a measure
  of answered axes, brief validity, or lead/worker agreement.
- 36/163 is among *screen-attributed corrections*, whereas #1 and #3 apply to all work and #2
  is not limited to screens. A fall can mean fewer screen tasks, fewer inspections, or a changed
  labelling denominator. There is no pre-registered denominator, minimum sample, control, or
  effect size.
- Browser-before-done (4/172) measures observation compliance, not decomposition. It is rare,
  task-dependent, and has no stated causal path from one deliverable to browser use.
  `fleet-look` also makes browser use an incomplete observation proxy.

Excluding current outliers after observing they are outliers ([lines 223–226](improvement-plan.md#L223))
is an avoidable selection rule. Define inclusion, unit, label protocol, denominator, and success
threshold before collection. Establish the meter before changing behavior, then use a comparable
cohort or randomized rollout. Otherwise “wait for numbers” cannot decide whether to keep #1.

### 3. #2 overreads its counts and has no closure mechanism

“30 of 36 addressable” is arithmetic (11 implied plus 19 held but unsaid), not an observed
intervention effect ([lines 75–79](improvement-plan.md#L75)). It assumes the lead asks the right
axis, the human answers, the answer arrives before dispatch, and the lead updates the worker
brief. The proposal implements only the first. The 25.6% generic-question finding
([lines 81–83](improvement-plan.md#L81)) does not show these eight questions are answerable in
seconds, cover the missing requirements, or work at a different time.

A list of every unanswered axis will create false uncertainty for small tasks and turn the lead
into a questionnaire generator. What is missing—and should rank first—is a closed-loop brief
protocol: each *material* ambiguity is answered, explicitly defaulted with risk accepted, or
blocks dispatch; resolved decisions are included in the worker’s immutable brief. Start it
warning-only and instrument response latency and false blocks. That is the missing causal link
between “ask” and “dispatch accordingly.”

### 4. #3 makes disagreement displayable, not preventable

23/79 supports looking at misunderstanding, but not the assertion that an extra manifest column
makes divergence visible “before the work” ([lines 93–106](improvement-plan.md#L93)). The lead
still has to invoke and read `fleet-worktrees`; nothing pauses the worker until comparison. A
worker can paraphrase faithfully while sharing the same wrong assumption, or make a plausible
one-line summary hide the decisive detail. The existing task display is deliberately truncated,
so a second short field risks false reassurance. Make this an acknowledgement handshake against
the resolved decisions, with lead accept/revise for material mismatch; otherwise it is telemetry
and belongs after measurement.

### 5. #7 is ordered backwards; the fixture argument does not hold

The plan correctly says a scripted model cannot show a real model follows an instruction
([lines 175–181](improvement-plan.md#L175)); the external review says the same
([external review lines 125–128](external-tools-review.md#L125)). That is not an argument to
delay the fixture until after an enforcer and live rollout. It is why the fixture is useful: it
tests the deterministic boundary the corpus cannot—shipped prompt delivery, hook invocation,
transcript timing, refusal/retry, and compliant/non-compliant enforcer paths.

Build a feasibility spike first. The external review says the technique is verified for OpenCode
but **unverified for Claude Code**, the sole runtime receiving the contract
([external review lines 117–123](external-tools-review.md#L117); [474–479](external-tools-review.md#L474)).
If Claude cannot use the loopback provider, #7 is materially different or not viable. Delaying
that check spends effort before resolving the plan’s highest-risk assumption.

A Stop hook that “refuses a done-report” also has unaddressed risks. The doctrine records that
Stop can race the final transcript write and that a busy session can associate with the wrong
Stop ([CLAUDE.md lines 181–185](../CLAUDE.md#L181)). A free-form “names an observation” check
can loop a worker, suppress a valid completion, judge an earlier turn, or accept a meaningless
sentence. The harness must precede the enforcer, with armed, turn-scoped adversarial cases.

### 6. #6 is necessary earlier and less automatic than claimed

The meter needs a baseline before #1–#3, not after. But transcript reading cannot automatically
recover the unavailable correction labels; browser event is not visual verification; files
touched is scope, not quality; and sleep time can be human absence rather than waste. The plan
corrects one unsupported testing claim ([lines 162–164](improvement-plan.md#L162)), then repeats
the error by treating retrospective manual measures as daily automatic checks.

Reading `~/.claude/projects/` also expands processing of client material excluded from this
review. Specify retention/redaction and mechanically extracted versus manually labelled fields.
No npm dependency is needed, but no dependency is not no cost or no privacy surface.

### 7. #4 and #5 do not earn their places

#4 is sensible for a future doctor/reaper, but it does not advance the lead-understanding goal.
“Every diagnostic” plus new `--plan`/`--dry-run`/`--apply` semantics
([lines 110–122](improvement-plan.md#L110)) is scope creep before the doctor exists. Adopt the
envelope with the reaper specification, not ahead of evaluating the core intervention.

Drop #5 entirely. Its `Derivation` type is useful where a program owns a measurement. Here the
producer is worker prose, while #6 is a transcript reader. The plan concedes it “pays only once
something consumes the field” ([lines 135–139](improvement-plan.md#L135)), then omits #5 from
its final order ([lines 203–209](improvement-plan.md#L203)). That is evidence of no integration.
Do not add a field merely to make unverifiable self-reports queryable.

## Rejections that are wrong or overbroad

The council/debate rejection is adequate for a general debate layer, not for a narrow independent
pre-dispatch critic. Its token result and “neither repo proposes it” ([lines 197–198](improvement-plan.md#L197))
do not rule out one cheap reviewer checking a resolved brief against known code. Compare that
experimentally with the closed-loop protocol.

The SDD rejection is wrong in inference. A rate for generic end-of-turn questions cannot refute
a conditional lightweight decision record used only where ambiguity is material. The external
review itself says SDD is gated on whether durable artifacts reduce substantial ambiguity
([external review lines 407–423](external-tools-review.md#L407)). Reject the large artifact
chain if desired, not every durable clarification artifact.

The memory-system rejection is plausible on daemon/dependency cost, but a PR does not retain
unanswered questions, rejected approaches, live fleet state, or lead context. “Do not install
engram” is supportable; “this memory failure cannot exist” is not.

## Recommended order

1. Fixture feasibility spike and deterministic harness, using the shipped prompt and real hooks.
   Stop if Claude Code cannot use the loopback path.
2. Baseline meter plus a pre-registered manual-label sample. Keep correction labelling separate
   from mechanically observable events and state the privacy boundary.
3. Closed-loop, warning-only brief protocol for material ambiguities.
4. Worker acknowledgement handshake tied to resolved decisions.
5. Evaluate false refusals, bypasses, response latency, and rework against baseline. Only then
   promote demonstrated failure modes to hard gates.
6. Stop-hook enforcer, if the harness proves turn-scoped behavior.
7. Doctor envelope when the reaper is actually built.

Drop #5. Do not ship #1 in its present `Done when:`/enumeration form. Its most likely failure
mode is performative compliance: the lead manufactures one deliverable and a vacuous done line,
the worker echoes it, every visible field looks disciplined, and the human’s missing choice
remains missing.
