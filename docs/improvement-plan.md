# Improvement plan — making the lead ask, decompose, and dispatch well

**The goal, in the words it was asked in:** something that makes the master smart enough to
ask questions back, understand all the problems, and send the work to agents accordingly.

Everything shipped so far is worker-side. The lead is the bottleneck: it receives a vague ask
and passes the vagueness along, one brief at a time.

Two evidence bases are cited throughout and neither is decoration.

- **The corpus** — 324 hand-labelled corrections across 104 real sessions, 59 project
  directories, 2026-08-06 to 08-29. Every number below marked MEASURED comes from it.
- **`docs/external-tools-review.md`** — `gentle-ai` and `engram`, both cloned at pinned
  commits and read as source. Its adopt list is four items; its reject list is seven, which
  is the honest ratio and is why only two of its items appear here.

---

## 0. What is already in force, so the plan is not read as starting from zero

- a ten-clause contract in every session's system prompt, delivered whole (3589 chars,
  verified by capturing the argument rather than grepping the file — it was silently
  truncated to 673 for a day and twenty-two green assertions did not notice)
- `fleet-look` — render a URL, page, PDF or image to a PNG the agent can read; `--tree` for
  the accessibility tree; golden comparison with a pixel-fraction threshold and a written
  expected/actual/diff triple on failure
- a `PreToolUse` guard refusing dispatch-by-subagent from a lead
- a dispatch log: what was sent, its length and digest, never its body

---

## 1. The ranked plan

### #1 — The dispatch gate. `fleet-spawn` refuses a brief that cannot be worked from

**Do this first. It is the only item that cannot be forgotten.**

`--prompt` becomes a checked artifact. Refused, with the reason and the fix, unless it carries:

- a **done-criterion** — a line beginning `Done when:`
- **named surfaces** when the brief touches UI — what a human will look at
- **exactly one deliverable** — a brief with `1.` `2.` `3.` is three asks

**MEASURED, and it is the strongest single contrast in the corpus.** Two sessions, same
surface, days apart. *"Build a per-document signature-template picker on the envelope
builder's Documents step"* — 2 turns, 95 files touched, **0 corrections**. *"Three items on
the signature-envelope builder … items 1 and 2 are small, item 3 is research first"* — 67
turns, **26 corrections**. Across all 17 sessions that took 0 or 1 corrections, **none
bundled two or more named asks**; 13 of 15 in the 5+ group ran past 15 turns against 1 of 17
in the clean group.

**Why a gate and not a clause.** A clause is read once and decays — this corpus contains an
agent's own *"Nobody has opened the UI. I've said this four times and it's still true."* A
refusal fires at the moment the mistake is being made, every time. The same argument already
paid for itself twice here: the `EnterWorktree` guard, and the subagent guard.

**Cost.** ~1 day. No dependency.

**What it does NOT fix.** A single well-formed ask that is simply wrong. And it cannot supply
a done-criterion the lead does not know — it can only refuse to proceed without one.

---

### #2 — Point the eight extraction axes at the human, before dispatch

The axes exist and are aimed at workers. Aim them at the lead's own input first: run the ask
against them and put the **unanswered** ones back as a numbered list.

The axes, each derived from a late requirement that actually arrived: the **unit** (per line,
per document, per policy) · **parity** with an existing surface · **reuse** rather than
recreate · the **gate** that must pass before advancing · **completeness** of a list ·
**eligibility and exit** · **retroactivity** — does it apply to records that already exist ·
and for a rendered artifact, **is there an existing one to match**.

**MEASURED.** 36 of 163 screen-attributed corrections were requirements stated for the first
time mid-flight. Sorted by knowability: 5 genuinely unknowable until the screen existed, 11
implied by the original ask and never written down, 19 already known to the human and simply
not said. **30 of 36 addressable.** They arrived at positions #3, #4, #5, #7, #15 of runs that
went on to take 24, 34 and 42 corrections; one was restated at #39 and again at #45 of 67.

**Not "ask more questions".** End-of-turn asking is saturated — the assistant already closes
with a question or an offer in **25.6% of turns** with a statistically identical rework rate.
The axes are specific and answerable in seconds; "anything else I should know" is not.

**Cost.** Hours — a clause, and the axes are already written.

**What it does NOT fix.** It makes the lead *ask* whether grouping is per-line or per-document.
It does not tell it the answer. The 19 requirements held and unsaid become questions, not
correct guesses. **That is the ceiling of this whole plan and it should not be oversold.**

---

### #3 — Make the worker's understanding visible beside the ask

The worker's first act writes its one-line restatement into its manifest entry, and
`fleet-worktrees` grows a column. ASKED beside UNDERSTOOD, so a divergence is visible in
seconds, before the work.

**MEASURED.** 23 of 79 corrections that are about the agent rather than the code are *"that
is not what I asked / you went the wrong way"* — the largest of those kinds. Today the
manifest records what the lead asked and nothing records what the worker thinks it heard, so
a mismatch is invisible until a correction.

**Cost.** ~half a day. A clause, a manifest field, a column.

**What it does NOT fix.** A worker that restates correctly and then builds something else.

---

### #4 — The doctor envelope, from `engram`

Adopted as a **shape**, not a dependency: every diagnostic emits a `reason_code` and a
`safe_next_step`, and destructive commands take `--plan` / `--dry-run` / `--apply`.

**Why it earns a place now.** A docker-stack reaper is about to be written, and "what would
this delete" is its entire safety question. Retrofitting the envelope afterwards is how a
reaper gets a `--force` flag and no explanation. Seen today: `fleet-stop --reclaim` printed
*"kept the worktree (see the reason above)"* — and the reason had scrolled off. With the
envelope that is `reason_code: session_gone_path_unknown` plus the exact command to run.

**Cost.** Near zero as a convention; the cost is applying it to `fleet-clean`, `fleet-adopt`
and the reaper.

**What it does NOT fix.** Nothing about intent. This is legibility of refusals.

---

### #5 — `Derivation`, from `gentle-ai`: "I could not measure this" as a type

Their `Dimension` carries `Value *int` and `Derivation string` restricted to
`measured | proxy | unobservable`, with the pointer so an unobservable dimension serialises
as `null` rather than a fabricated `0`. Their comment states the rule: *"emitted with every
dimension so a proxy can never be read as a measurement."*

**Why here.** Closing the loop already asks a worker to mark each criterion met or unchecked
— as prose, so nobody can count it. As a type, "3 criteria, 1 unchecked" is queryable, and
*"I verified it"* stops being confusable with *"I assumed it."*

**Cost.** Low. Pays only once something consumes the field, which is #6.

---

### #6 — The utilization meter

A script over `~/.claude/projects/` emitting, per session and per branch: tool calls per turn,
whether a browser was opened before a done-claim, turns-to-done, seconds spent sleeping in a
turn, corrections per distinct file touched. Thresholds flagged.

**Why it belongs, and why it is ranked here rather than first.** Every one of those numbers
was produced retrospectively, by hand, weeks after the fact: 4 of 172 build turns opened a
browser; one window carried 173 tool calls of which 28 were sleeps totalling ~16,000 seconds,
32% of that session's API calls; median 4 turns for clean sessions against 63 for the 5+
group; 0.009 corrections per file touched against 0.116. **None of that needs a fake model or
a new dependency — it is a reader over transcripts, and it can run nightly against real
sessions.**

But it **measures**; it does not treat. It answers "did #1 to #3 work" and that is why it
follows them rather than leading.

**Cost.** ~1–2 days. No dependency.

**Correction to an earlier claim, recorded because it was stated confidently and wrongly:**
"the only test is re-running the corpus analysis in three to four weeks" is false. Most of it
can be a daily check.

---

### #7 — A Stop-hook enforcer, then the fixture server from `gentle-ai`

A `Stop` hook reads the turn's own output and refuses a done-report that names no
observation. Then a scripted-model fixture server — `node:http` on loopback speaking the model
wire protocol, agent binary and prompt asset real, only the model's reasoning faked — proves
the hook fires and does not fire, deterministically, with no API key and no token cost.

**The order is deliberate and inverts the external review's.** That review ranks the fixture
server #1 and it is right that ghostfleet's contract is tested for **delivery, not
compliance** — twenty-two assertions all answering *"was the string passed?"*, which is
exactly how a contract truncated to a fifth stayed green for a day. But a fixture server
replaces the **model**, so the agent's decisions become the script: it cannot show that an
agent complied, only that the surrounding machinery responded. **It tests an enforcer. We do
not have one yet.** Build the enforcer, then the harness that proves it.

**Cost.** Enforcer ~1 day. Fixture server: the largest item here, and it should not start
until #1–#3 have been measured by #6.

---

## 2. Rejected, with the reason

| | why |
|---|---|
| `engram` as a memory system | a problem this repo does not have; needs a binary and a daemon on a port |
| `engram`'s private-redaction | strictly weaker than the digest-based name sweep already here |
| `gentle-ai` as configurator/installer | inverts ownership of `install.sh` |
| RDD, receipts, lifecycle gates | ceremony without a gate — branch protection already gates |
| personas and output styles | asserted where this repo is measured |
| the SDD artifact chain | contradicted by this repo's own 25.6% finding on saturated asking |
| a council or debate layer | debate costs 2.1–3.4× tokens for accuracy comparable or worse; a single agent at 10× budget matches it. Neither repo proposes it either |
| a brief-quality gate on prompt *features* | six features of the opening prompt — length, naming a file, naming a route, stating a done-criterion, carrying a reference image, human-vs-lead authorship — all land in a 20–30% band with fully overlapping intervals. **#1 gates on STRUCTURE (one ask, a done-line), not on quality, and the distinction is load-bearing** |

---

## 3. Order, and what would falsify the plan

1. **#1 the gate** — the only unforgettable item
2. **#4 the envelope** — before the reaper, not after
3. **#2 axes at the human**, **#3 restatement visible** — same week, both cheap
4. **#6 the meter** — then wait for numbers
5. **#7 enforcer, then fixture server** — only if #6 says #1–#3 moved something

**What would falsify it.** After four weeks with #1–#3 in force, re-label a fresh sample by
the same protocol. The plan is wrong if:

- `P(correction | the previous turn was a correction)` has not moved off **46.6%** toward the
  27.1% base rate, and
- cluster C (a requirement stated mid-flight) has not fallen from **36 of 163**, and
- the browser-before-done rate has not moved off **4 of 172**

If the gate is in force and multi-ask briefs simply reappear behind `--one-brief`, that is not
a measurement problem — it is the gate being routed around, and it should be reported as such
rather than counted as compliance.

**One caveat on the measurement itself.** The sessions that produced this plan are now in the
corpus, and they are outliers — a deleted checkout, a leak sweep, and a day of process work.
They will skew the next sample and should be excluded explicitly rather than allowed to move
the number quietly.
