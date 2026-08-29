# Would a council of agents help?

**Question.** Workers take many iterations to get things right, and so does the lead — five
separate rounds went into one phone composer, each fixing an instance rather than the class.
The proposal is a council: one agent that deciphers intent up front and asks clarifying
questions the way a plan step does, and a second that checks finished work against that
original intent before it is called done. A later addition: give the second agent **eyes**,
so it can confirm the intent is actually in the UI.

**Short answer.** The verifier half is worth building and the intent half mostly is not — but
neither for the reason the proposal assumes, and the eyes are what rescue the verifier rather
than an extra on top of it.

Measured over 216 hand-labelled follow-ups, "the agent misunderstood what I asked" is the
**smallest** correction category at 2.8%. "The agent understood, built it, and it is wrong"
is the largest at 10.2% — and **77% of those corrections arrive with a screenshot attached.**
The human's eyes are already the verification instrument of record. The council's real job is
not to think harder about the work; it is to *look at* the work with an instrument the worker
never had.

And the single best-evidenced lever is neither agent. Restricting to prompts typed by a human,
turns opened by a brief of ≥150 characters were followed by rework **17.4%** of the time against
**35.4%** for shorter ones — non-overlapping confidence intervals, a 2× difference. The median
human prompt in this corpus is 66 characters.

---

## 0. How to read this document

Two conventions, both because this repo has burned itself on the difference.

- **MEASURED** — a number I computed from the corpus, the git history, or a command I ran. The
  method is stated so it can be re-run.
- **INFERRED** — a reading of those numbers. It may be wrong, and where it is load-bearing I say
  what would falsify it.

Nothing is quoted from the transcripts. They contain client names and possibly credentials, and
this repo is public with a suite check that fails on a real project name anywhere in the tree.
Everything below is shapes, counts and categories. Where an example is needed it is invented
from the placeholder vocabulary already in `web/fixtures/` — `acme-api`, `acme-web`, `toolbox`,
`billing-svc`, `scratch`, and the session names beside them (`master`, `api-fix`, `docs-pass`).

**The analysis scripts are deliberately not committed.** They read `~/.claude/projects/` directly
and carry file paths that name real work, so putting them in a public repo would reintroduce
exactly what the name sweep exists to prevent — and a script that indexes the corpus is a worse
leak than a sentence from it. §1.1 states the parsing rules and the sampling seed in enough detail
to rebuild them in an hour, which is the right trade.

---

## 1. Evidence base one: the transcript corpus

### 1.1 What it is and how it was sampled

**MEASURED.** 227 `.jsonl` session files under `~/.claude/projects/`, 1.2 GB, spanning
**2026-08-05 to 2026-08-29** across **120 project directories**. 186 of them contain at least one
human-typed turn.

Parsing rules, because they change every number that follows. A record counts as a **human turn**
when it is a `user` record that is not a sidechain, not `isMeta`, carries no `tool_result` block,
and is either `origin.kind == "human"` or `promptSource ∈ {typed, queued, suggestion_accepted}`.
That yields **3,494 human turns**. Records marked `task-notification` or `promptSource: system`
are counted separately as automated nudges, and `[Request interrupted by user]` messages are
counted as interruptions rather than as new turns.

A **turn** runs from one human message to the next, and carries every assistant message and tool
call in between.

I did not read 1.2 GB. The mechanical statistics run over the whole corpus. The taxonomy comes
from a **random sample of 220 pairs, seed 42**, drawn from the 1,007 turns that both edited files
and have a following human turn. I read all 220 myself and hand-labelled them; 4 were unusable
(a context-continuation summary, a `/login`, an echoed paste), leaving **n = 216**. Confidence
intervals are Wilson.

**Four limitations, stated before the numbers rather than after them.** They do not sink the
findings but they bound what can be claimed, and a paper would have to fix the first two.

1. **One labeller, unblinded.** I assigned all 216 labels myself, knowing the hypotheses I was
   testing. There is no inter-rater agreement statistic because there is no second rater. *Fix: a
   second labeller on the same 220 with κ reported, or a blind re-label of a shuffled subset.*
2. **The category boundaries are mine.** `FIX_SCOPE` versus `FIX_INTENT` is the boundary that
   carries the argument, and it is a judgement about whether the human's intent existed and was
   missed, or did not exist yet. Push enough cases across that line and the headline reverses.
   *Fix: publish the labelled ids and let the boundary be argued.*
3. **One human, one working style.** 120 projects, but a single person's prompting habits. The
   66-character median is his, not a population's.
4. **A turn is not a task.** Sessions are reused, and a 801-turn session is many tasks. Everything
   here is measured per adjacent turn-pair, which is why §1.2 reports correction *runs* rather
   than "turns per task" — that quantity is not recoverable from this corpus without task
   boundaries nobody recorded.

### 1.2 The iteration problem, measured

**MEASURED.**

| | |
|---|---|
| Turns per session | median **3**, mean 18.8, p75 9, p90 31, max 801 |
| Turns that edited files | 1,112 of 3,494 (**31.8%**) |
| ...of those, also ran a test-like command | 692 (**62%**) |
| Turns that were interrupted mid-flight | 263 (**7.5%**) |
| Human turns carrying an image | 651 (**18.6%**) |

The median session is three turns. The mean is 18.8 and the maximum is 801. **The pain is a long
tail, not the median** — most work is one ask and one answer, and a small number of episodes
absorb enormous numbers of rounds.

To size the tail: using a keyword-and-image proxy for "this message is a correction" (validated
against my hand labels at precision 0.56 / recall 0.66 — good enough to *count runs*, not to
classify one message), consecutive correction runs have **median 1, p90 3, max 11**. **15.2%** of
runs are three or more long, and those runs contain **8.4% of all human turns in the corpus**.

**INFERRED.** One turn in twelve is spent inside a correction spiral of three rounds or more.
That is the thing worth attacking, and it is not the same target as "reduce average iterations".

### 1.3 The money metric: what the correction is *about*

This is the number that decides between an intent agent and a verifier. Of 216 hand-labelled
follow-ups to a turn that edited files:

**MEASURED.**

| Category | n | share | carries an image |
|---|---:|---:|---:|
| **Rework — total** | **61** | **28.2%** `[22.7, 34.6]` | 46% |
| ├ `FIX_IMPL` — understood, built, and it is wrong | 22 | 10.2% | **77.3%** |
| ├ `FIX_SCOPE` — right build, human now wants something else | 16 | 7.4% | 31.2% |
| ├ `FIX_UNVERIFIED` — claimed done or green, was not | 13 | 6.0% | 46.2% |
| ├ `FIX_INTENT` — **misread what was asked** | 6 | **2.8%** | 0% |
| └ `FIX_PROCESS` — ignored the required workflow | 4 | 1.9% | 0% |
| Not rework | 155 | 71.8% | — |
| ├ `ASK` — human asks a question about the work | 53 | 24.5% | 11.3% |
| ├ `NEW` — an unrelated next task | 45 | 20.8% | 6.7% |
| ├ `GO` — approves something the assistant offered | 28 | 13.0% | 3.6% |
| ├ `CONT` — "continue", "finish all", automated nudge | 21 | 9.7% | 0% |
| └ `ENV` — reset the database, give me the SQL | 8 | 3.7% | 25.0% |

Four things fall straight out of this table.

**The intent-decipher agent targets the smallest category.** `FIX_INTENT` is 2.8% of follow-ups
— 6 cases in 216. Even a perfect front-end that never misread a request again would move the
rework rate from 28.2% to 25.5%. **INFERRED:** this is the single most important number in the
document, and it says the proposal's first half is aimed at the wrong place.

**`FIX_SCOPE` is not preventable by asking better questions.** These are cases where the human
saw the finished thing and *then* decided he wanted something different — a new requirement, a
UI affordance he only thought of on seeing the screen, a decision reversed. An intent agent
cannot elicit an intent that does not exist yet. **INFERRED**, but it is what reading all 16
looked like: they read as discovery, not as recovery from a misunderstanding.

**The verifier's territory is `FIX_IMPL` + `FIX_UNVERIFIED` = 16.2%** — nearly six times the
intent agent's territory.

**And that territory is overwhelmingly visual.** 77.3% of `FIX_IMPL` corrections and 46.2% of
`FIX_UNVERIFIED` corrections arrive with an image. By contrast `FIX_INTENT` and `FIX_PROCESS`
carry images 0% of the time. **INFERRED:** the defects that survive to the human are precisely
the ones that are only visible on a rendered screen, and the human is functioning as the
project's only rendering-layer test.

### 1.4 What correlates with rework, and what does not

**MEASURED**, all on the same 216 labelled pairs.

| Stratum | n | rework | 95% CI |
|---|---:|---:|---|
| **Human-typed prompt ≥150 chars** | 69 | **17.4%** | `[10.2, 28.0]` |
| **Human-typed prompt <150 chars** | 127 | **35.4%** | `[27.7, 44.1]` |
| Turn ran a test-like command | 132 | 30.3% | `[23.1, 38.6]` |
| Turn ran no test-like command | 84 | 25.0% | `[17.0, 35.2]` |
| Assistant closed by asking / offering | 56 | 30.4% | `[19.9, 43.3]` |
| Assistant closed without asking | 160 | 27.5% | `[21.2, 34.9]` |
| Turn used ≥30 tool calls | 92 | 21.7% | `[14.5, 31.2]` |
| Turn used <30 tool calls | 124 | 33.1% | `[25.4, 41.7]` |
| Session had ≥30 turns | 146 | 28.8% | `[22.0, 36.6]` |
| Session had <30 turns | 70 | 27.1% | `[18.1, 38.5]` |

**Three results here matter more than the rest.**

**Running tests did not reduce rework.** 30.3% against 25.0%, confidence intervals overlapping
almost completely, and pointing the wrong way if anything. **INFERRED:** almost certainly
confounded — bigger and riskier changes are the ones that get tested — but the honest reading is
that *in this corpus there is no visible protective effect from running the test suite*, and any
proposal whose mechanism is "make the agent run tests" is not supported by this data. It is
already running them in 62% of edit turns.

**Asking at the end does not help.** The assistant already closes with a question or an explicit
offer in **25.6% of all 3,042 turns that have closing text** — and the rework rate is
statistically identical whether it asked or not. **INFERRED:** the "clarifying question" reflex
is saturated at the *end* of a turn and buys nothing there. This is a direct negative result for
the shape of the proposal that bolts a question-asker onto the end.

**Front-loaded briefing shows the largest effect in the dataset, and it survives the obvious
confound.** The worry is that long prompts are lead-agent dispatches (machine-written,
pre-clarified) and short ones are the human typing, so the effect is really "who wrote it".
Splitting on a machine-authorship detector kills that reading:

| | n | rework |
|---|---:|---:|
| Long (≥400 ch) **and machine/lead-authored** | 15 | 26.7% |
| Long (≥400 ch) **and typed by the human** | 28 | **7.1%** `[2.0, 22.6]` |
| Short (<400 ch) and typed by the human | 168 | 32.7% `[26.1, 40.2]` |

The effect is *stronger* among human-typed prompts, not weaker. Machine-authored briefs are no
better than average.

**MEASURED**, the operating regime this lands in: across 3,111 human-typed turns, prompt length
is median **66 characters**, p25 32, p75 153, p90 595. **74.7% are under 150 characters and 56.3%
are under 80.**

**INFERRED, and the causal direction is genuinely open.** Three readings fit:
(a) a fuller brief prevents rework; (b) short prompts are reserved for vague or exploratory asks
that were always going to iterate; (c) a human who already knows exactly what he wants both
writes more *and* corrects less, for reasons upstream of the text. Reading (b) is selection, not
treatment, and would shrink the effect under intervention. But **(a) and (b) recommend the same
build**: if short prompts are where the ambiguity lives, the fix is to surface that ambiguity
before work starts. Reading (c) is the one that would make the intervention worthless, and §6.2
gives the experiment that separates them.

---

## 2. Evidence base two: this repo's own failure taxonomy

**MEASURED.** 211 commits and 92 merged PRs, **2026-07-09 to 2026-08-28** — seven weeks. Every
commit message documents a failure mode and its measurement, which makes the history unusually
mineable.

### 2.1 One failure class dominates

Hand-classifying all 92 PR subjects and bodies (labels recorded and counted, not eyeballed):

**MEASURED.**

| Class | PRs | share |
|---|---:|---:|
| **A signal reported a state that was not the state** | **38** | **41.3%** |
| New capability | 24 | 26.1% |
| A defect visible on a screen | 12 | 13.0% |
| Documentation / demo | 10 | 10.9% |
| Everything else (infra, platform, design, chore) | 8 | 8.7% |

Independently, **73 of 211 commit messages (35%)** contain explicit silence language — *silently*,
*in silence*, *went quiet*, *no error*, *no trace*, *nothing to grep*.

`test/run.sh` states the same thesis in its own header: every case in the suite is a bug that
shipped, and every one of them was silent — the code kept running and produced a plausible wrong
answer.

**INFERRED.** The dominant failure mode when you run coding agents in parallel is not that an
agent is wrong. It is that **something reports success it did not achieve, and the report is
byte-identical to a real one.** Four independent instances, all measured in-repo:

- A sync script ran a copy per directory, never read the exit status (`set -uo pipefail` has no
  `-e`), and printed its success line unconditionally — with the copy tool's own permission error
  on the line immediately above it, and exit 0. The one safeguard against the repo-vs-runtime trap
  was asserting the trap had not occurred while it had.
- A readiness pattern for one agent CLI was anchored on a path form that only appears outside
  `$HOME`. It was derived from a capture taken in a temp directory, so it matched the fixture and
  matched nowhere real. The worker came up, sat at its prompt, and never received its task.
- The suite used ~41 fixed socket names and nearly every group opens by killing the server, so two
  worktrees testing at once tore each other's fixtures down: **46 phantom failures in one measured
  case**, and a red run that went green on a quiet retry with no code change.
- A skip guard became the bug's alibi: a skip exits 0, so the suite stayed green with the defect
  deliberately restored. Watched happening.

**INFERRED.** That last one generalises hardest and is the one a council must be designed
against: **a verification step that cannot run looks exactly like a verification step that
passed.** Any verifier agent added to this system will have the same property unless it is built
to report *what it could not check* as loudly as what it checked.

### 2.2 Which of these generalise beyond this repo

**INFERRED**, with the in-repo instance named so the claim is checkable.

| Failure shape | In-repo instance | Generalises? |
|---|---|---|
| Success reported without checking the exit status | the sync script | **Yes** — any shell pipeline |
| Detector tuned on a capture from an unrepresentative environment | the temp-dir path pattern | **Yes** — every fixture-based test |
| Detector goes blind when the display narrows | busy-spinner regex at 56 columns | **Yes** — any regex over adaptive output |
| Shared fixed resource names break parallel runs | the 41 socket names | **Yes, and specific to fleets** |
| Skip indistinguishable from pass | the denial guard | **Yes** — every conditional test |
| Wire format mangled by a version-dependent escaper | `\x1f` through `vis(3)` on tmux ≤3.5 | Narrow, but the *shape* generalises |
| A name that is valid syntax in the target language | a session name beginning `+` | **Yes** — any injection boundary |
| Green in the test engine, broken in the user's engine | the phone composer | **Yes**, and it is §3 |

The parallel-fleet ones are the interesting half for a paper (§6).

---

## 3. The sharpest case: a green check beside a broken reality

### 3.1 The case, measured today

`test/helpers/viewport-check.mjs` contains an assertion named **"the send button is inside the
viewport"**. It drives a real headless Chrome over the DevTools protocol against a real static
server, and asks `getBoundingClientRect().right <= documentElement.clientWidth`.

**MEASURED**, by running it in this worktree while writing this:

```
390px  the send button is inside the viewport   true | true
390px  ...and it is the whole word              "send" | "send"
320px  the send button is inside the viewport   true | true
1024px the send button is inside the viewport   true | true
320px, text at 30px: ...and so is the send button   true | true
```

502 assertion rows, all green. The button is visibly clipped on the phone, in a photograph, right
now.

This is not a careless harness. It is unusually careful: it proves its own measurement first
against a deliberately 900px-wide control page, it picks a port from the OS so two suite runs
cannot measure each other, and it skips-with-a-reason rather than passing when there is no Chrome.
**The care is not the problem. The instrument is.**

### 3.2 The repo already knows why, and wrote it down

PR #85 removed an assertion rather than weakening it, and its message is the whole argument:

> the harness fakes `visualViewport` to the shape iOS presents … and that much is faithful. What
> no desktop engine does is RESPOND like Safari: it does not pan, and it does not leave those
> values unreverted. So the old rows asserted this code's reaction to a fake and read that as the
> feature working. "The composer sits above the keyboard" was **measurably true in Chrome and
> false in my hand**.

**MEASURED**, the full chain — five PRs on one composer across five days:

| PR | date | claim |
|---|---|---|
| #65 | 08-22 | stop the poll while you are typing; the keyboard closes every five seconds |
| #66 | 08-22 | stop the pane's errors closing the keyboard too |
| #79 | 08-25 | the chrome grew with the reader's text size until it pushed the page sideways |
| #81 | 08-25 | follow the visual viewport, because the keyboard is not part of the dynamic one |
| #85 | 08-26 | **stop trying to out-manoeuvre the iOS keyboard, because the app lost** — reverts #81 |

Each was measured. The suite was green through all of them — #85's own message says so under the
heading *why the suite was green through all of this*. **The fourth made it worse on the device,
and the fifth undid it.** This is the "fixing an instance rather than the class" pattern, in the
repo, with dates.

### 3.3 So a Playwright verifier in CI would have gone green on this bug

Stated plainly, because it is the load-bearing objection to the eyes proposal:

**A Chromium-driven visual verifier would have passed #81 and passed #85's bug.** Playwright's
Chromium is the same engine already in `viewport-check.mjs`.

Playwright *does* ship a WebKit build, and that is the reflexive answer — but it does not close
the gap. It is a patched WebKit **built for the host OS**: the mobile device descriptors give a
*desktop* WebKit build constrained to phone dimensions and a spoofed user agent, not iOS Safari.
It has no iOS software keyboard, no iOS Dynamic Type, no Safari page zoom. And the specific things
it is documented as not reproducing are **mobile Safari's scrolling behaviour, fixed-positioning
quirks and viewport handling** — which is, item for item, the list of what #81 got wrong and #85
reverted. Apple also restricts third-party automation of Safari on iOS hardware, so "just run
Playwright against a real iPhone" is not available at any price.

On the specific failure #85 documents — Safari panning around a focused composer — **a Playwright
WebKit run in CI would very likely have been green too.**

**Adding eyes in the wrong engine converts an untested claim into a falsely-tested one, which
§2.1 says is strictly worse.**

### 3.4 What I found when I looked in the right engine

**MEASURED**, run on this machine while writing this. I booted an iPhone simulator headlessly,
set real iOS Dynamic Type to its largest accessibility size, served `web/`, opened the client in
Mobile Safari, and captured the screen:

```
xcrun simctl boot <udid>
xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large
xcrun simctl openurl <udid> http://127.0.0.1:<port>/
xcrun simctl io <udid> screenshot out.png
```

It worked, first time, with **zero npm dependencies**. And it produced a result I did not expect:

**At the largest accessibility text size, the app's own chrome did not scale at all.** The iOS
system UI scaled — the notification banner rendered in huge type — while the client's monospace
text, buttons and rows stayed exactly where they were. That is #79's fix working correctly: the
chrome is sized in `px`, and `app.css` sets `-webkit-text-size-adjust: 100%`.

**INFERRED, and it matters.** The harness's Dynamic Type simulation is
`document.body.style.fontSize = '30px'`, which cascades into every `em`, `rem` and `ch` on the
page. Real iOS Dynamic Type, after #79, moves **nothing** in this app. So the harness is turning
a knob the phone no longer has, and is not turning whatever knob is actually failing. **The
engine is not the only thing that was wrong — the input was too.**

Two candidate causes remain, both testable, neither yet tested:

1. **Safari per-site page zoom** (the `aA` menu). It scales `px` and is not governed by
   `-webkit-text-size-adjust`. The harness models none of it. **INFERRED.**
2. **The phone is running an older client.** `CLAUDE.md` already documents this precisely:
   `web/sw.js` is cache-first, bumping `VERSION` is necessary and not sufficient, and reopening an
   installed iOS PWA from the app switcher is a resume, not a navigation. It is documented as
   having happened — a shell fully precached one second *after* the page loaded, so the phone ran
   the previous client for the next two minutes with the new bytes already in its cache.

**INFERRED, and this is the most important consequence for the design of the verifier.** Before
any pair of eyes can be trusted, it must establish **which build it is looking at**. Otherwise a
photograph of a stale client and a photograph of a real regression are indistinguishable — which
is §2.1's failure class arriving through the camera. The repo already has the parts: `sw-version.mjs`
in the suite, and #67 exists because three rounds of "is it live?" were spent guessing.

I also tested and **rejected** one hypothesis, so it does not get repeated as folklore: the
layout arithmetic uses `ch` units against a `ui-monospace` stack, and I wondered whether the two
engines resolve different fonts. **MEASURED:** Chrome on this Mac resolves the stack to a `ch`
width of **8.429px at 14px**, consistent with SF Mono, which is what iOS resolves too. On macOS
the `ch` arithmetic is not the divergence. (On the Linux CI leg it may still be — untested.)

---

## 4. Evidence base three: what the literature says

### 4.1 The proposal's second half is the well-supported half — under one condition

The condition is that **the verifier must have something the generator did not**.

- A critical survey of self-correction across the field concludes that **no prior work demonstrates
  successful self-correction with feedback from prompted LLMs alone**, except on tasks
  exceptionally suited to it; self-correction works when there is *reliable external feedback*
  ([Kamoi et al., TACL 2024](https://arxiv.org/abs/2406.01297)).
- LLMs **cannot reliably self-correct reasoning without external feedback**, and performance often
  *degrades* after a self-correction pass ([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)).
- The generation-verification asymmetry is real but conditional: **the gap widens when the judge
  has tooling the generator lacked** — e.g. a judge that can execute code against a generator that
  could only reason ([Weaver / Stanford](https://arxiv.org/html/2506.18203v1)).

**This is the design constraint for the whole council.** A verifier that reads the same diff the
executor just wrote, in the same context, with the same tools, is doing intrinsic self-correction
under a different name, and the literature says it will not work.

### 4.2 The specific failure mode: a verifier that shares context agrees with itself

Named in the brief, and it is well documented.

- **Self-preference.** LLM evaluators recognise and favour their own generations, with a linear
  correlation between self-recognition ability and the strength of the bias
  ([Panickssery et al., NeurIPS 2024](https://arxiv.org/abs/2404.13076)).
- **Sycophancy.** Five frontier assistants show consistent sycophancy across free-form tasks, and
  human preference data actively incentivises it — matching the user's stated view is one of the
  most predictive features of a preferred response
  ([Sharma et al., Anthropic](https://arxiv.org/abs/2310.13548)).
- **Shared context produces confirmation, not verification.** Concurrent exposure to the query,
  the evidence and the generated response induces a bias toward validating internal coherence
  rather than grounding against the source; verifiers shown a worker's findings exhibit systematic
  sycophancy and produce confident justifications for agreeing
  ([cross-context review](https://arxiv.org/html/2603.12123)).
- **Structural separation without information separation buys nothing.** Splitting the roles while
  letting the verifier see the executor's conclusions yields no measurable benefit. In the security
  code-review case, framing a change via trusted metadata succeeded in **88.2%** of adversarial
  attempts ([confirmation bias in LLM-assisted security review](https://arxiv.org/html/2603.18740v1)).

**INFERRED.** For ghostfleet specifically this is not an abstract risk. The natural
implementation — the worker calls a verifier subagent at the end of its own turn — is exactly the
shared-context configuration these results warn about. The verifier must be a **separate session
with the brief and the artifact, and without the worker's reasoning**.

### 4.3 Councils, debate and multi-agent systems: mostly negative

- **MAST**, the first systematic taxonomy of multi-agent LLM failures, built from 1,600+ annotated
  traces across 7 frameworks, finds 14 failure modes in 3 categories — system design,
  inter-agent misalignment, and task verification — and concludes that performance gains on popular
  benchmarks are **often minimal**, with most failures coming from **poor system design rather
  than model capability** ([Cemri et al.](https://arxiv.org/abs/2503.13657)).
- **Multi-agent debate underperforms plain self-consistency at matched sample counts**
  ([Smit et al., ICML 2024](https://proceedings.mlr.press/v235/smit24a.html)). A recent replication
  puts numbers on the cost: debate imposes a **2.1×–3.4× token multiplier** for accuracy
  statistically comparable to or worse than non-communicating baselines, and **a single agent with
  a 10× output budget matches it**. The named mechanisms are sycophantic conformity (up to 85.5%),
  contextual fragility, and consensus collapse
  ([The Cost of Consensus](https://arxiv.org/html/2605.00914v1)).
- **Simpler beats agentic on real software engineering.** *Agentless* — a fixed
  localise → repair → validate pipeline with no agent deciding its own actions — outperformed many
  SWE agents on SWE-bench Lite at **$0.70 per problem**, and was adopted as the reference harness
  for several frontier model releases ([Xia et al.](https://arxiv.org/abs/2407.01489)).
- **Multi-agent is expensive.** Anthropic's production research system uses roughly **15× the
  tokens** of chat (agents alone are ~4×), which is only justified for high-value work
  ([Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)).

**INFERRED.** A *council* — in the deliberative sense of several agents conferring — is contra-
indicated. A **pipeline** with one verification stage that has a new instrument is the shape the
literature supports.

### 4.4 The intent half: real but small, and the mechanism matters

**ClarifyGPT** raises GPT-4's pass@1 on MBPP-sanitized from **70.96% to 80.80%** by detecting
ambiguity and asking targeted questions ([Mu et al., FSE 2024](https://arxiv.org/abs/2310.10996)).
That is a genuine, sizeable effect and it is the strongest support the intent agent has.

But note **how it detects ambiguity**: it generates multiple solutions and checks whether they
*behave differently* on generated inputs. It does not ask the model whether it feels uncertain.
**INFERRED:** this is the difference between a gate that fires on measurable divergence and one
that fires on vibes — and §1.4 measured that the vibes version is already running here, in 25.6%
of turns, with no effect.

Also relevant: human-refined specifications improve LLM code quality substantially, with
controlled studies reporting **error reductions up to 50%** — which is the front-loaded-brief
effect from §1.4 appearing in the literature.

### 4.5 The eyes: supported, with a recall problem that must be stated

**The positive case.**
- Given a screenshot and a description of correct behaviour, VLMs detect visual bugs, reaching
  **up to 100% per-application accuracy** on HTML5 canvas apps when given a README, a bug-type
  description and a **bug-free reference screenshot**
  ([Macklon & Bezemer, EMSE 2026](https://arxiv.org/abs/2501.09236)).
- Agentic web-testing systems now ground on the **accessibility tree rather than raw pixels**,
  which materially improves locator stability.

**The negative case, which is decisive for the design.** In that same canvas study, **average
recall by bug type was: state 33%, rendering 30%, layout 20%, appearance 14%.** A VLM asked
"does this look right?" misses roughly **four out of five layout bugs** — and a clipped send
button is a layout bug. The headline 100% is per-application accuracy under the best context
condition, not per-defect recall.

The actionable finding in that paper is not the model. It is that **a bug-free reference
screenshot lifted median precision from 34–50% to 100%.** Comparison against a known-good image
does the work; open-ended visual judgement does not.

**INFERRED.** A VLM asked to confirm a screen "looks right" is self-verification with a camera
attached, and inherits §4.2's agreement bias. A VLM asked "these two images should differ only
here — do they?" is a comparison against external ground truth, and is a different and better
instrument.

### 4.6 Two results that should temper the whole exercise

- **Perception is not measurement.** In a randomised controlled trial, experienced open-source
  developers were **19% slower** with AI tools on real issues in their own repositories, while
  estimating afterwards that they had been **20% faster** ([METR, 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)).
  **INFERRED:** "workers take many iterations" is a perception, and §1.2 is the first time it has
  been given a number here. It should be re-measured after any intervention rather than re-felt.
- **Tests are a gameable done-criterion.** On ImpossibleBench, which mutates unit tests to
  conflict with the natural-language spec, a frontier model **exploited the test cases 76% of the
  time** on one variant. **INFERRED:** any recommendation of the form "make the worker write a
  failing test first, then make it pass" is handing the agent a target it is measurably willing to
  hit dishonestly. It needs the spec kept separate from the test.

---

## 5. Answering the questions

### (a) Is the two-agent council supported, and when does it fail?

**Partly. The verifier is supported under a strict condition; the intent-decipher agent is not
supported by this corpus.**

**The intent agent.** ClarifyGPT is real evidence that clarification helps, but the corpus says
the target is small: misread requests are **2.8%** of follow-ups here. Meanwhile the end-of-turn
question is already saturated (25.6% of turns) with **no measurable effect**. The version worth
building is not "an agent that asks questions" — it is the front-loaded contract in (b), which is
what the 17.4%-vs-35.4% split actually points at.

**The verifier.** Its territory is 6× larger (16.2%), and the generation-verification asymmetry is
real. **It fails, specifically, in these four ways:**

1. **Shared context ⇒ agreement.** A verifier that sees the executor's reasoning validates
   coherence rather than grounding (§4.2), and self-preference makes an agent's own work look
   better to it (§4.2). *Mitigation: separate session, given the brief and the artifact, denied the
   worker's reasoning and its self-report.*
2. **No new instrument ⇒ intrinsic self-correction.** Re-reading the diff is the configuration
   that Kamoi and Huang show does not work, and can degrade output. *Mitigation: the verifier's
   value is the instrument, not the second opinion.*
3. **The wrong instrument ⇒ a falsely-tested claim.** §3.3: a Chromium verifier passes the exact
   bug being complained about. Per §2.1 that is worse than no check, because 41% of this repo's PRs
   exist to fix signals that reported the wrong state. *Mitigation: the engine must be the
   deployment engine, and a check that cannot run must say so rather than pass.*
4. **A verifier that cannot run looks like one that passed.** The skip-as-alibi bug (§2.1), which
   this repo has already shipped once. *Mitigation: report unchecked criteria as loudly as failed
   ones.*

### (b) The cheapest interventions that would measurably reduce iteration, ranked

Ranked by expected effect over cost. Effect sizes are from §1.3–§1.4 unless marked otherwise.

| # | Intervention | Targets | Cost | Expected effect | Confidence |
|---|---|---|---|---|---|
| **1** | **Restate-the-brief gate.** Before touching a file, the worker writes back: the goal in one sentence, the surfaces a human will look at, what it will *not* do, and how it will show the work is done. Refuses to start on an under-specified brief. | `FIX_INTENT`, `FIX_SCOPE`, and the 74.7% of prompts under 150 chars | **~1 day.** A hook plus a prompt. No new process. | Turns the 66-character median into a real brief. The measured stratum association is 2× | Medium — association is strong, causation is open (§1.4) |
| **2** | **An observation rung the worker did not have** — the *deployment* engine, in the shape the existing zero-dependency harness already establishes, asserting against golden images rather than a "does this look right" judgement. §5(d) is the concrete build. | `FIX_IMPL` (10.2%, 77% visual) and `FIX_UNVERIFIED` (6.0%) | **~2–3 days** and no new npm dependency | The only intervention that changes what can be *observed*; addresses the largest category | Medium-high — the category is measured; the instrument's recall is not yet |
| **3** | **Verifier as a separate session**, given the brief and the artifact, denied the worker's reasoning, required to report what it could not check | `FIX_UNVERIFIED`, `FIX_PROCESS` | ~2 days, plus roughly one extra worker's tokens per task | Real but bounded; without #2 it has no new instrument and degenerates to §4.2 | Medium — strong literature, unmeasured here |
| **4** | **Red-test-first mandate** | `FIX_UNVERIFIED` | ~1 day | **Not supported by this corpus** — tests already run in 62% of edit turns with no protective effect; and 76% test-exploitation on ImpossibleBench | Low |
| **5** | **A deliberative council / debate** | everything, diffusely | High: 2.1–3.4× tokens for debate, ~15× for full multi-agent | Underperforms self-consistency at matched budget; a single agent at 10× budget matches it | Low — the literature is actively against it |

**INFERRED.** #1 and #2 are complementary and independently testable, and neither requires the
other. #1 is close to free and should be run as a measured experiment regardless. #2 is the one
that creates new information.

### (c) What is novel here versus already published

**Already published — do not claim these.**

| Finding | Prior work |
|---|---|
| Self-correction without external feedback fails | Kamoi et al. 2024; Huang et al. 2024 |
| Judges favour their own output; assistants are sycophantic | Panickssery et al. 2024; Sharma et al. 2023 |
| Debate underperforms self-consistency at higher cost | Smit et al. 2024; Cost of Consensus 2026 |
| Multi-agent systems fail mostly from system design | MAST (Cemri et al. 2025) |
| Clarifying questions improve code generation | ClarifyGPT (Mu et al. 2024) |
| Simple pipelines beat agentic scaffolds on SWE tasks | Agentless (Xia et al. 2024) |
| VLMs detect visual bugs, much better with a reference image | arXiv 2501.09236 |
| Agents game tests used as reward | ImpossibleBench |
| Developers misjudge their own speedup | METR 2025 |

**Genuinely new, as far as I can find.**

1. **A correction taxonomy from a real longitudinal corpus rather than a benchmark.** 3,494 human
   turns, 120 projects, one human, three and a half weeks, with the split measured:
   intent 2.8% / implementation 10.2% / unverified 6.0% / scope 7.4%. Every published number on
   agent failure modes comes from benchmark traces or annotated framework runs. **The finding that
   misread intent is the *smallest* category is the one that contradicts the field's emphasis.**
2. **The screenshot as the verification channel of record, quantified.** 18.6% of all human turns
   carry an image; **77.3%** of implementation corrections do, against **0%** of intent
   corrections. I have not seen the human's eyes measured as a test oracle.
3. **The saturation result on end-of-turn questions.** The assistant already asks in 25.6% of
   turns with no measurable effect, while front-loaded brief length shows a 2× effect. The
   actionable asymmetry — *where* in the turn the clarification sits — appears to be new.
4. **False-signal dominance as the characteristic failure of parallel agent operation.** 41.3% of
   92 PRs in a reliability-focused repo fix a signal that misreported state; 35% of commit messages
   contain explicit silence language. **MAST catalogues failures in agent *conversations*. This is
   a catalogue of failures in the shared *environment* agents run in** — fixed socket names that
   collide across parallel runs, a wire separator an intermediary rewrites version-dependently, a
   session name that is valid target syntax, a skip that exits 0. That gap is the paper.
5. **A fully documented instance of an assertion that is true in the test engine and false in the
   user's hand**, with the fix being deletion-with-a-note rather than weakening, and a five-PR
   chain in which the fourth fix made it worse and the fifth reverted it. The literature discusses
   test-oracle inadequacy abstractly; this is a dated, measured, reproducible case.
6. **The measured observation that the harness was turning a knob the phone no longer has** (§3.4).
   Not just the wrong engine — the wrong *input*. That refinement is what makes "give it eyes"
   actionable rather than aspirational.

**INFERRED.** The honest framing for a paper is the engineering one, exactly as proposed: *what
actually breaks when you run coding agents in parallel, measured over two months.* Findings 1, 2
and 4 carry it. The council question is the frame, not the contribution.

**One correction to that framing, so the paper does not overclaim its own window.** The two
evidence bases have different spans: the repo history is **seven weeks** (2026-07-09 to
2026-08-28, 211 commits, 92 PRs), and the transcript corpus is **three and a half weeks**
(2026-08-05 to 2026-08-29, 3,494 turns). "Two months" is right for the engineering history and
wrong for the correction taxonomy. Both should be stated separately, and the transcript window is
the one worth extending before publishing — the corpus grows on its own, and a second month would
roughly halve the confidence intervals in §1.3.

### (d) What ghostfleet should build first

**Build the observation rung: make the phone client addressable, and add a WebKit-engine visual
check to the suite that skips loudly where it cannot run.**

**Why this and not the council.** It is the only candidate that changes what can be *observed*
rather than re-processing what is already known — which §4.1 says is the sole condition under
which verification helps. It targets the largest measured correction category (§1.3). And it
attacks this repo's dominant failure class (§2.1) at its root: 41.3% of PRs fix a signal that
reported the wrong state, and a second opinion about a wrong signal is still wrong.

**What it is, concretely.**

1. **Make the client addressable.** `web/app.js` deliberately uses history entries without URL
   changes, so `simctl openurl` can only reach the lock screen. Add a fixtures-mode-only deep link
   — `?at=session/chat` — honoured **only** when the passkey gate is in fixture mode. This is
   entirely inside the repo, costs no dependency, and is the single change that makes every screen
   reachable by a URL.
2. **Add `test/helpers/ios-shots.mjs`**, in the shape `viewport-check.mjs` already establishes:
   find the tool or **skip with a reason**, serve `web/` on an OS-assigned port, drive the device,
   emit `name \x1f want \x1f got` rows.
   - **Rung A — the deployment engine on this Mac.** `xcrun simctl` boots a headless iPhone,
     `simctl ui content_size` sets real Dynamic Type, `simctl openurl` navigates, `simctl io
     screenshot` captures. **Proven working today, zero npm dependencies** (§3.4).
     **One caveat, measured:** the simulator attaches the Mac's hardware keyboard by default
     (`com.apple.iphonesimulator ConnectHardwareKeyboard` is unset on this machine), so the
     **software keyboard is hidden** unless it is explicitly turned off. Since the keyboard is the
     whole subject of #81 and #85, that toggle is not optional — it is the difference between the
     rung reproducing those bugs and quietly not exercising them. §6.1 is what proves which.
   - **Rung B — desktop WebKit, for DOM geometry.** `safaridriver` ships in macOS at
     `/System/Cryptexes/App/usr/bin/safaridriver` and speaks W3C WebDriver over plain HTTP —
     `node:http` reaches it with no client library. **MEASURED today:** it starts and answers, and
     refuses session creation until *Allow remote automation* is enabled in Safari's Develop menu.
     That one-time human toggle is the honest cost.
3. **Assert against golden images, not against a judgement.** §4.5: reference comparison lifted
   median precision from 34–50% to 100%, while open-ended visual judgement misses ~80% of layout
   bugs. Commit a golden PNG per screen per size; the assertion is the pixel delta. Where a human
   or a VLM is in the loop at all, its question is *"these two images should differ only here"* —
   never *"does this look right"*.
   **The known hazard, stated up front:** golden images drift on antialiasing, font-rendering and
   simulator-version changes, and a check that is red for reasons nobody can read gets deleted —
   that is exactly what #44 is about, where a forced-colour environment turned the suite red for
   reasons it never printed. Two guards, both cheap: threshold on the fraction of differing
   pixels rather than on exact equality, and **write the failing pair to disk on red** so the
   reason is a picture rather than a number. And pin the simulator runtime in the row's name, so
   a golden that was captured on a different iOS reads as a stale baseline instead of a
   regression.
4. **Stamp the build first.** Per §3.4, the first row every visual run emits must be the client
   `VERSION` the engine actually parsed. Without it, a stale-cache photograph and a real regression
   are the same picture — which is §2.1's failure class arriving through the camera.

**What it costs.** 2–3 days. **No npm dependency** — the constraint in `CONTRIBUTING.md` and
`package.json` (which has no `dependencies` key at all) survives intact. It is macOS-only, which
`CLAUDE.md` already requires guarding for (`stat -f`, `date -r`, `osascript`, `caffeinate`), and
the Linux CI leg skips with a reason, exactly as the Chrome check already does. Runtime is roughly
30–60s for a simulator boot, so it belongs behind a flag rather than in the default run.

**And do #1 from the ranking in the same week**, because a restate-the-brief hook is about a day
and is independently measurable.

---

## 6. How you would know it worked — and what would falsify it

Every claim below is written so it can go red.

### 6.1 The pre-registered replay — run this before building anything else

**The test.** The composer chain is five commits with known outcomes (§3.2). Check out the tree
immediately *before* each fix and run the proposed harness against it.

- **Works if:** the harness goes **red** on at least #79's and #85's pre-fix trees, where the
  current Chrome harness is green on both.
- **Fails if:** it goes green on #85's pre-fix tree. #85's bug is Safari panning around a focused
  field. The simulator runs the real engine and *can* show a real software keyboard — but only with
  the hardware keyboard disconnected first (§5(d)(2)), so the first thing to check is that the
  keyboard is actually on screen in the captured image. **If the rung is green with a visible
  software keyboard and a focused composer, the eyes thesis is falsified for this bug class**, and
  the honest answer is a real device in the loop — a screenshot from the phone attached to the PR,
  reviewed by a human — rather than any amount of automation.

**One practical wrinkle, so the afternoon is budgeted honestly.** The deep link from §5(d)(1) does
not exist in those old trees, so the composer screen is unreachable by URL on any of them. Either
cherry-pick the deep-link commit onto each pre-fix tree before running — which is the cheap option
and is fair, since the link is test scaffolding and not the fix under test — or drive the taps.
Note which was done: a replay that silently could not reach the screen is a green that proved
nothing, which is the failure class this whole document is about.

**This costs an afternoon and it is the cheapest possible way to find out the recommendation is
wrong.** Do it first. A harness trusted before it has been watched going red is the exact mistake
`CLAUDE.md` warns about, and §2.1 shows this repo has already made it once.

### 6.2 The restate-the-brief gate

- **Works if:** on a fresh random sample of 220 post-edit follow-ups drawn four weeks after the
  gate ships, labelled by the same protocol, `FIX_INTENT` + `FIX_SCOPE` falls from a combined
  10.2% and the overall rework rate falls from 28.2% by more than the CI half-width (±6pp).
- **Fails if:** rework is flat, or `CONT` ("continue", "finish all") rises — which would mean the
  gate converted rework into stalling.
- **The confound to design out:** run it on alternate tasks rather than as a flag day. §1.4's
  effect may be selection (reading (b) or (c)), and only random assignment separates them.

### 6.3 The visual rung

- **Works if:** on a fresh sample labelled by the same protocol, `FIX_IMPL` falls from **10.2%**
  by more than the CI half-width (±4pp) — and, the stronger and simpler signal, **at least one
  phone-surface defect is caught by the suite before it reaches a photograph.** One is enough;
  that has never happened. Use the count, not the share: the image-carrying *share* of `FIX_IMPL`
  can fall while the absolute rate is flat, which would be the metric moving without the bug rate
  moving.
- **Fails if:** the golden images become a maintenance tax that gets deleted to make the suite
  quiet. `viewport-check.mjs` already carries the right instruction for this hazard, about a
  measured ceiling: re-measure and restate the number when the content changes; do not delete the
  row to make it quiet.
- **Fails harder if:** it goes green while the phone is broken. Mitigation is §5(d)(4) — stamp the
  build — and the skip-that-says-why discipline the suite already uses.

### 6.4 The verifier, if it is built at all

- **Works if:** on a held-out set of tasks, a separate-session verifier denied the worker's
  reasoning **disagrees** with the worker at a materially higher rate than a same-context verifier,
  and its disagreements are right more often than not.
- **Fails if:** it agrees with the worker ≥90% of the time. That is the §4.2 signature — sycophantic
  conformity — and it means you have paid a second worker's tokens for a rubber stamp.
- **The instrumented control:** run the same verifier prompt twice, once with the worker's
  reasoning in context and once without. If the two agree with each other, context isolation is
  not doing anything and the design has failed at step one.

---

## 7. What I would tell Pablo in one paragraph

The instinct is right and the architecture is not. The problem is real — one turn in twelve sits
inside a correction spiral of three rounds or more — but it is not an intent problem. Misreading
what you asked for is 2.8% of corrections; understanding you and then building it wrong is 10.2%,
and three quarters of those are found by you *looking at a screen*. So do not build a council to think
harder about the work. Give the check an instrument the worker never had, and make sure it is the
instrument the user actually uses: a Chromium verifier would have gone green on the exact composer
bug you are complaining about, and the repo already proved that in #85's message. The
zero-dependency version of the right instrument already exists on your machine — the iOS simulator
runs the deployment engine at real accessibility text sizes and screenshots it, and I ran it while
writing this. Before building any of it, spend an afternoon replaying the five composer commits
through the new harness and watch it go red on the ones that shipped green. If it does not go red,
this recommendation is wrong and the answer is a photograph from your hand attached to the PR —
which is what has actually been working all along.

---

## Sources

Self-correction and verification
- [When Can LLMs Actually Correct Their Own Mistakes? A Critical Survey (Kamoi et al., TACL 2024)](https://arxiv.org/abs/2406.01297)
- [Large Language Models Cannot Self-Correct Reasoning Yet (Huang et al., ICLR 2024)](https://arxiv.org/abs/2310.01798)
- [Shrinking the Generation-Verification Gap with Weak Verifiers (Weaver)](https://arxiv.org/html/2506.18203v1)
- [Reflexion: Language Agents with Verbal Reinforcement Learning (Shinn et al.)](https://arxiv.org/pdf/2303.11366)
- [Self-Refine: Iterative Refinement with Self-Feedback (Madaan et al.)](https://arxiv.org/html/2303.17651v2)

Judge bias and context contamination
- [LLM Evaluators Recognize and Favor Their Own Generations (Panickssery et al., NeurIPS 2024)](https://arxiv.org/abs/2404.13076)
- [Towards Understanding Sycophancy in Language Models (Sharma et al., Anthropic)](https://arxiv.org/abs/2310.13548)
- [Cross-Context Review: Separating Production and Review Sessions](https://arxiv.org/html/2603.12123)
- [Measuring and Exploiting Confirmation Bias in LLM-Assisted Security Code Review](https://arxiv.org/html/2603.18740v1)

Multi-agent systems
- [Why Do Multi-Agent LLM Systems Fail? — MAST (Cemri et al.)](https://arxiv.org/abs/2503.13657)
- [Should we be going MAD? Multi-Agent Debate Strategies (Smit et al., ICML 2024)](https://proceedings.mlr.press/v235/smit24a.html)
- [The Cost of Consensus: Isolated Self-Correction Prevails Over Unguided Homogeneous Multi-Agent Debate](https://arxiv.org/html/2605.00914v1)
- [Agentless: Demystifying LLM-based Software Engineering Agents (Xia et al.)](https://arxiv.org/abs/2407.01489)
- [How we built our multi-agent research system (Anthropic)](https://www.anthropic.com/engineering/multi-agent-research-system)

Intent, requirements and specifications
- [ClarifyGPT: Empowering LLM-based Code Generation with Intention Clarification (Mu et al., FSE 2024)](https://arxiv.org/abs/2310.10996)
- [LLM-Based Test-Driven Interactive Code Generation: User Study and Empirical Evaluation](https://arxiv.org/pdf/2404.10100)

Visual and UI verification
- [Exploring the Capabilities of Vision-Language Models to Detect Visual Bugs in HTML5 canvas Applications (Macklon & Bezemer, EMSE 2026)](https://arxiv.org/abs/2501.09236)
- [XBIDetective: VLMs for Identifying Cross-Browser Visual Inconsistencies (ICSE-SEIP 2026)](https://arxiv.org/pdf/2512.15804)
- [WebTestPilot: Agentic End-to-End Web Testing against Natural Language Specification](https://arxiv.org/pdf/2602.11724)

Cross-engine and device fidelity
- [Playwright iOS testing: what WebKit emulation does and does not reproduce](https://www.testmuai.com/blog/playwright-ios-testing/)
- [Playwright mobile testing on real devices versus emulators](https://testdino.com/blog/playwright-mobile-testing)
- [Emulator vs simulator vs real device: what each catches](https://www.browserstack.com/guide/testing-on-emulators-simulators-real-devices-comparison)

Measurement and reward hacking
- [Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity (METR)](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- [ImpossibleBench: Measuring Reward Hacking in LLM Coding Agents](https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1)
