# Three orchestrators, and what they have that this does not

Written 2026-09-01 after finding two tools that solve the same problem as ghostfleet, and
extended 2026-09-15 with a third — every one of them found by accident rather than by
looking, which is itself the finding this document keeps re-establishing. This is not a feature comparison for its
own sake: it exists because both were discovered on the day this project shipped its
measurement layer, and the honest question — *should this keep being built* — deserved
evidence rather than loyalty.

Every claim below says how it was established. Where a claim is read from a README and not
from running the thing, it says so, because that distinction turned out to matter twice.

**HOW TO READ THE EVIDENCE HERE, because v1 of this report got the standard wrong.** It
carefully flagged two *positive* claims about a competitor as unverified, and left every
claim of competitor ABSENCE unflagged — as though absence were the safe direction. It is
the weaker one. *"Documents nothing about X"* is not *"lacks X"*, and **"neither tool has
this" cannot follow from reading a README and some source.** Every absence below should be
read as "not found by reading, not run", and any decision that turns on one should be
checked by running the thing first.

The same correction retires this report's most comforting sentence. v1 concluded that a
competitor arriving independently at the same architecture was evidence the architecture is
right. It is not: **it may simply be the obvious implementation route.** Convergence is
evidence about the problem, not about the solution.

---

## 1. What was found

### Munder Difflin — an Electron desktop app with a visualization

MIT, local-first. Electron + React + TypeScript, with Pixi.js for rendering and `node-pty`
for the agents.

- **Agents are avatars on an office floor.** They walk to desks as they work, and
  **envelopes fly desk-to-desk when they message each other.** Not decoration driven by a
  timer: the animation is driven by hook payloads the agent CLIs post to a local hook
  server.
- **A git-backed hive for messages.** Each agent writes to its own `outbox/`; a router
  delivers into recipients' `inbox/`. Single-committer semantics — the harness commits, not
  the agents — so parallel workers cannot conflict in git.
- **13 agent CLIs.**
- **An autonomous orchestrator agent** that resolves routine work itself and escalates only
  spend, destructive operations, and scope changes to the human.
- **Local models** via Ollama, LM Studio, vLLM.
- **One window**: terminal streams (xterm.js), file tree, git history.
- Isolation is `node-pty` child processes, with per-agent git worktrees **optional**.
- Requires Node 18+ and a C/C++ toolchain. No memory or concurrency figures published.

Two claims here were reported by a second reader of the same repository and are **not**
verified from a run: that it has a cost/runaway circuit breaker with transcript and cost
telemetry, and that its UI has **both** a PTY byte plane and an event/hook plane, with no
documented rule for which wins when they disagree. Both matter to §3 and both are marked
where they are used.

### Herdr — a Rust terminal multiplexer

AGPL-3.0-or-later, commercial licences on request. A single binary of about 10–11 MB.

- **Its own PTY session server**, not tmux. Background, detach and reattach.
- **A socket API agents can call**: split a pane, run a command in one, read another's
  output, and — the interesting one — **`herdr wait --pane 2 --state done`**, so a lead can
  block until a helper reaches a state.
- **State from process-name matching plus terminal output heuristics**, with optional
  per-agent hooks for richer reporting. Four states: working, blocked, done, idle.
- **14+ agents**, and **generic process detection for unlisted ones at reduced
  granularity** — an unknown CLI still runs, with a worse status signal.
- **Named sessions** separate projects.
- No profiles or accounts. No usage, cost, or rate-limit handling documented.
- Terminal only. Remote by ssh; one iOS terminal app has native support.

### CLI Agent Orchestrator (CAO) — found 2026-09-15, and it is the closest of the three

**READ FROM ITS README AND DOCS, NOT RUN. Every line below carries that caveat**, which
matters more here than for the other two: this is the entry most likely to change a decision,
so the weakest evidence is attached to the highest stakes. Nothing below should be treated as
established until somebody runs it.

Apache-2.0, from **awslabs**. ~1.3k stars, 423 commits, 104 open issues — actively developed
with a company behind it, which neither of the others has.

- **tmux 3.3+ as a core dependency, agents in isolated tmux sessions.** That is not a similar
  architecture, it is this one. Where Herdr wrote its own PTY server, CAO made the same bet
  this project did, and did not have to justify it.
- **12 provider CLIs**: Claude Code, Codex, OpenCode, Copilot, Cursor, Kiro, Grok Build,
  Kimi, MiniMax, Antigravity, Hermes, and Oh My Pi (OMP).
- A supervisor delegating to specialists in parallel or sequence.
- A **web UI** plus MCP Apps — browser and host-rendered fleet interfaces.
- A **skills system** (reusable agent guidance, scoped), **persistent cross-session memory**
  with optional self-learning loops, **scheduled workflows and multi-step pipelines**,
  **role-based tool restrictions**, and **EKS deployment** with shared workspace and
  credential delivery.

**What it does to §2.** Two of this project's claimed advantages need re-checking against it
rather than against the other two, and neither can be settled by reading:

- It documents "profiles", but they appear to be *supervisor and agent-config* profiles, not
  several independent accounts on one machine with a port allocator spanning them. If that
  reading is wrong, the profile advantage is gone. **Unverified.**
- Nothing was found about usage, cost, or shedding load against an account ceiling. That is
  an ABSENCE read from a README — the weak direction this report opens by warning about — so
  the governor is *probably* still unique and is not established as such.

**What it does to §3③, which is the real consequence.** The agent-coverage item stops being
one gap among six. Three validated agents against **12 from a tmux-native competitor with AWS
behind it** is the difference between a project that turns some users away and one that turns
away nearly everyone who has already chosen a CLI. OMP is itself only reachable as a
ghostfleet agent through that work.

**What is still worth measuring before conceding anything.** A 12-provider list is a claim
about breadth, not about signal quality: this project's own doctrine is that an agent with no
validated busy detector must report UNKNOWN rather than idle, and a wide list can be wide
because it guesses. The honest comparison is CAO's per-agent capability matrix against this
one's — launch, input, lifecycle, ready/busy, blocked, usage, resume, hooks — with the empty
cells published on both sides. Until that exists, "12 versus 3" is a headline, not a finding.

**Herdr is the closer competitor, and it is the more useful find.** It arrived
independently at this project's central bet — terminal-native, a detachable background
server, and state read from what the terminal actually shows. Read that as evidence about
the PROBLEM, not about the solution: two builders reaching the same shape may mean the shape
is right, or may mean it is the obvious route from the same constraints. What it does settle
is narrower and still useful — reading state from the terminal is not a differentiator,
because the nearest competitor does it too.

---

## 2. What this project has that neither does

Stated so the gaps in §3 are read against something, not as a list of defeats.

- **A governor.** A non-agent daemon that parks the newest workers as account usage climbs
  and resumes them when the window resets, and parks before the *machine* dies as well as
  before the budget does. Herdr documents nothing here. Munder Difflin may have a circuit
  breaker (unverified, above); a breaker that stops a runaway is not the same as a scheduler
  that sheds load to keep a fleet inside one account's ceiling.
- **Profiles.** Several independent agent config directories on one machine — four in use
  where this was written — with the dev-port allocator spanning them, so two products'
  checkouts cannot collide. Neither tool has any notion of whose account a session runs as.
- **A measurement layer.** A pre-registered baseline over the local transcript corpus, a
  meter, and an evaluator that **refuses to report** below a sample floor. Its first real
  reading said the machinery is running and three of four measurements sit at n=2–3 against
  a floor of 30 — that is, it declined to flatter the work that had just shipped.
- **A model fixture.** The real agent binary driven against a loopback HTTP server standing
  in for the model, in under a second, with real hooks firing and a hook's refusal returning
  into the conversation as an ordinary tool result. This is the only item here that is a
  *capability for building the others*, and §3 spends it twice.
- **A purpose-built phone client** rather than a terminal on a phone.
- **An explicit agent adapter with an honest empty state**: an agent with no validated busy
  detector must be reported UNKNOWN, never idle — because a pattern that matches nothing is
  indistinguishable from a worker that is finished, and an empty regex fed to grep matches
  every line and reads as permanently busy.

---

## 3. What to take, ranked by effect over cost

**The order changed after review, and the reasons are kept rather than tidied away.** v1
ranked the blocking wait first because it was cheap; cheap is not valuable, its evidence was
one inference from message size, and — the part that was missed entirely — it is partly
wrong for this architecture. It is now fourth, and §3④ says why in full.

Every item carries a check. v1's checks were mostly too weak: several would have passed for
reasons unrelated to the thing being claimed, which is the same defect an earlier plan was
refuted for. Each one below says what it can and cannot distinguish.

### ① An ownership view, not an office floor — from Munder Difflin, reframed

The avatars are the wrong lesson. The right one is that **their visualization is driven by
events the harness already emits**, and this project already emits richer ones: a dispatch
log with target, byte length and digest; an event file with `done`, `need-you`, `parked`;
and a turn identifier that joins a dispatch to the transcript records of the turn it started.

So the thing to build is not a picture of who is busy. It is a **causal waiting view**: who
asked whom, who owes whom an answer, which turn is armed, when the request started, and what
is blocking the lead from dispatching next. Graph it to find queueing, not to animate
envelopes.

**What would check it — and this is not the obvious metric.** Counting duplicate nudges and
unanswered requests is not enough: a view can move those for unrelated operational reasons,
or leave them flat while genuinely helping. The claim to test directly is
**whether an operator can correctly recover ownership after an interruption** — close the
laptop mid-fleet, come back, and ask who is waiting on what. Score the answer against the
ledger. That fails when the view is decorative, which the count-based check does not.

**What NOT to copy:** the git-backed message bus. Committing messages to reach another agent
is heavier than this project's existing wire format, and it reintroduces a problem already
solved here — a delivery path scoped to one fleet whose failure mode is silence.

### ② Recoverability under partial failure — neither tool was found to have this

*(An absence established by reading, not by running. See the note at the top.)*

The axis both roadmaps appear to miss: **what is the safe, inspectable state after the lead,
the hook server, the UI, the network, or one agent dies mid-dispatch?**

This project has more scar tissue here than either competitor and no systematic answer. Two
failures already written down: a push channel scoped to one fleet where the symptom of
misdelivery is *silence* — nothing to grep, no error, no row — and a prompt sent to a busy
session that consumed the wrong turn's completion, so a request looked as though it had never
fired. Both were patched individually. Neither was solved as a class.

What that class needs is a durable, replayable record of requests and approvals, with
idempotent delivery and a repair path a human can read.

**What would check it, and v1's version of this was too weak to trust.** "Every outstanding
request is either delivered exactly once or visible as outstanding" can fail, so it is not
empty — but it can also PASS while the system delivers once to the *wrong recipient*, drops
an approval, or has its ledger and its recovery code agree on the same false state. The
assertion has to bind the whole tuple: request id, intended recipient, payload digest,
requester, authorization, and terminal outcome. And the faults must be injected at every
write / send / ack / retry boundary, including process restart and network partition — not
merely "drop the network".

**One correction to v1, which overclaimed a capability this project has.** The model fixture
does *not* make those faults injectable. It drives the model and hook paths deterministically
and nothing more: it cannot kill tmux, the lead, the hook server, or persistence at a crash
boundary. A fault harness for this item is work that does not exist yet, and pretending
otherwise is how an item gets ranked above its true cost.

### ③ A generic agent adapter — from Herdr

Three validated agents against their 13 and 14 is the widest real gap, and today an
unlisted CLI cannot be used **at all**. Herdr's answer is a generic process detector that
runs anything with a worse signal, and that answer fits this project's existing doctrine
exactly: the adapter already requires that a missing busy detector report UNKNOWN rather
than idle. A generic adapter is that rule, applied to an agent nobody has characterised.

The honest framing of the current position is not "we are more rigorous". It is that a
person whose CLI is not one of the three is turned away, and rigour does not help them.

**What would check it, and the obvious test mostly proves its own definition.** Asserting
that an unknown CLI reports UNKNOWN shows the fallback exists; it does not show the agent is
usable. Dispatch, inbox and teardown can all work while input semantics, lifecycle events and
completion detection are unusable — which is the difference between spawning a CLI and
supporting it. So the test needs a **real unfamiliar CLI, not a compliant dummy**, scored
against an explicit capability matrix: launch, input, lifecycle, ready/busy, blocked, usage,
resume, hooks. Publish which cells are empty. Both directions: a *known* agent must not
regress onto the generic path, or the adapter table has become decoration.

### ④ A blocking wait on another session's state — from Herdr, demoted

`wait --pane N --state done` lets a lead say "continue when that one is done" in one call,
which neither the inbox (pull) nor the nudge (push) expresses today.

**Why it moved from first to fourth.** v1 argued from the dispatch log: 23 dispatches across
5 workers in a two-hour window, two of them under 1KB, and concluded *"a nudge is what a lead
sends when it cannot tell whether to wait"*. That inference does not survive contact — a
small message can be a correction, a cancellation, a status request, or a wakeup, and none of
those implies sequencing. Message size does not carry intent.

**And there is a design objection that is worse than the weak evidence: a lead that blocks is
a lead that is not draining its inbox.** While it waits on one worker, every other worker's
question goes unanswered, and this project's whole attention model is a lead that stays
responsive. A blocking primitive here can convert one slow worker into a stalled fleet. If it
is built at all, it must be interruptible by an inbox event, which is a different and larger
design than the one-line call it looks like.

**What would check it — not the metric v1 gave.** "Sub-1KB dispatches fall" would pass if
prompts merely got longer, if the lead stopped nudging for unrelated reasons, or if the task
mix changed; it measures message size, not correctness of waiting. What is needed first is
**dispatches labelled by intent** — the log records length and digest, never a body, so
intent has to be recorded at send time or inferred by a rule that is itself declared. Then a
controlled comparison on three quantities: unnecessary nudges, **lead idle time**, and
completion latency. Until intent is labelled, this item has no measurable claim at all.

### ⑤ Local models, cheaper than they look — from Munder Difflin

The model fixture already redirects a real agent binary at an arbitrary HTTP endpoint by
setting one environment variable, and proves the whole stack still runs. The same mechanism
points a worker at a local server.

**What would check it, and v1's check was nearly circular.** "A complete turn with hooks
firing" would pass against the project's own scripted fixture, which is the thing that
already works — it says nothing about whether any real local server is compatible. Each
claimed backend has to be tested with a real local model: the provider's actual wire format,
streaming behaviour, tool-call encoding, and context limit. And because a smaller model
changes what a worker can be trusted with, the plumbing shipping is not the same as a
recommendation to use it: no such recommendation until something measures the difference in
outcome, not just in transport.

### ⑥ An autonomous orchestrator — ranked last on purpose

Munder Difflin has an agent that dispatches on the human's behalf and escalates only spend,
destructive operations, and scope. It is the most impressive thing either tool does and it
should be the **last** thing copied.

The reason is this project's own rule, arrived at after an independent reviewer refuted an
earlier version of its plan: **only a failure mode that shows up in measurement earns a hard
mechanism.** The evaluator currently reports NOT MEASURABLE on three of four measurements.
Automating a dispatch process that cannot yet be shown to help would multiply an unmeasured
process, which is the exact error that review caught.

**And "wait for n≥30 and an opinion" is not a sufficient gate, which v1 got wrong.** A
process can be measurable and still be harmful. Autonomy earns authority only against a
threshold declared in advance: what benefit counts as enough, and what safety property must
hold — which classes of action it may take unsupervised, and what the blast radius is when
its judgment is wrong.

## 4. What not to take, and why

- **Their multiplexer.** Herdr wrote its own; tmux is why this project gets ssh, attach from
  anywhere, and a phone client for free. A rewrite would spend months buying back what a
  dependency already provides.
- **Electron.** Measured on the machine where this was written, the harness cost here is
  about 114 MB — tmux servers, governor daemons, and the screens. A browser engine starts
  higher than that before it draws anything. This is a real advantage and it should not be
  traded for a nicer window.
  - Stated with a correction: at the moment of measuring, this project was **also** leaking
    about 1.9 GB across 66 orphaned web-server processes, from a teardown sweep that could
    never match what it was meant to reap. The architecture was cheap; the implementation was
    not. Fixed the same day, and the lesson is that a footprint claim must be measured rather
    than derived from a design.
- **The single-binary distribution story**, tempting as it is. 10 MB of Rust against ~49,000
  lines of shell and Node is a real disadvantage in installation and maintenance, and it is
  not worth a rewrite. It is worth remembering the next time a component could be one file
  instead of six.

---

## 5. The honest summary, and the choice it forces

Neither tool makes this one redundant. But the differentiators are narrower than they looked
in the morning, and v1's consolation — that a competitor independently arriving at the same
architecture proves the architecture right — has been retired above.

Of what remains genuinely unmatched, on evidence that is reading rather than running: the
governor, the profile axis, and the measurement layer. The first two are product features a
motivated competitor could build in a week. The third is not a product feature at all — it is
the ability to tell whether any of this works, and **a baseline nobody acts on is
instrumentation, not differentiation.**

That conclusion is not defeat, but it does force a choice this report cannot make: **a
temporary advantage is only worth defending if you know what promise it is defending.** If
the promise is spectacle or breadth, this project loses and should stop. If the promise is
reliable operation of real work in real repositories — fewer lost tasks, safe parallel work,
recoverable failure, and decisions an operator can defend — then the ranking above is in the
right order, and §3① and §3② are that promise made concrete.

The test is not this document. It is whether the measurement layer can show a real advantage
after a few real projects. If it cannot, the correct move is to stop, and no amount of
technical seriousness should override that. Do not preserve a project because it is
impressive.

**Two categories this report still does not cover**, named so the omission is deliberate
rather than hidden: it assumes a single operator on one machine and says nothing about what
changes for a team, where ownership and approval get much harder — which is precisely the
axis §3② is about. And it has no answer to the case where a competitor simply adds a governor
and a profile axis, other than the observation that they would then be competing on §3②,
where the scar tissue here is real and theirs is not.
