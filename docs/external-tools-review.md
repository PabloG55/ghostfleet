# External tools review — gentle-ai and engram

What, if anything, ghostfleet should take from two external repos.

- `Gentleman-Programming/gentle-ai` — read at `72e0ccc`, 1228 Go files, ~38 MB
- `Gentleman-Programming/engram` — read at `e86ca46`, 208 Go files, ~76 MB

Both were cloned and read as source. Where a claim below could only be found in a
README it is labelled **their claim**; where it was checked in code, the file is named.

---

## The short answer

**Three things are worth taking, and only one of them is code.**

The single finding that matters: ghostfleet's standing contract — the ten clauses in
`bin/claude-here` — is tested for **delivery**, not for **compliance**. The group
`the observation contract reaches claude` in `test/run.sh:2081` runs a stub `claude`
that writes its `argv` to a file and greps it. Twenty-two assertions, every clause
covered, and all of them answer *"was the string passed?"*. Nothing anywhere proves a
session that received the contract behaves any differently from one that did not.

gentle-ai has solved exactly that problem, in CI, with no API key and no token cost.
That is candidate #1 and it is the only one worth real engineering time.

Everything else in both repos is either something ghostfleet already does better, or a
solution to a problem ghostfleet does not have. Details, including the reasoning for
each rejection, are in **What not to adopt** below — that section is longer than the
adopt list, which is the honest ratio here.

---

## What each repo actually is

### gentle-ai — an ecosystem configurator for coding agents

Not an orchestrator and not an agent. It configures agent runtimes **already on the
machine**: it writes system prompts, skills, MCP server entries, model routing, personas
and Spec-Driven-Development command sets into the config directories of 16 different
agents (Claude Code, OpenCode, Codex, Cursor, Windsurf, Kiro, Gemini CLI, and so on). It
explicitly refuses to install an agent runtime for you and prints the command instead.

The problem it solves: *"I installed a coding agent and it's just a chatbot."* One
binary configures whichever agents you use, identically, and keeps them in sync.

There is no overlap with ghostfleet's actual job. gentle-ai never runs two agents at
once, has no concept of a session pool, no usage governor, no worktree lifecycle. It
writes config files and exits. The overlap is entirely in the **second-order** material
it has accumulated around that job: how it tests agent behaviour, and how it measures
whether its own output is honest.

It also carries a large opt-in subsystem, **Receipt-Driven Development (RDD)**: a review
lifecycle where a candidate's bytes are frozen, hashed, and turned into a signed receipt,
with lifecycle gates that fail closed. Off by default. Assessed and rejected below.

### engram — persistent memory for coding agents

A single Go binary wrapping SQLite + FTS5, exposed as CLI, HTTP API, MCP server and a
TUI. Agents call `mem_save`, `mem_search`, `mem_context`, `mem_session_summary`. Hooks on
`SessionStart` / `UserPromptSubmit` / `Stop` / compaction keep it fed and re-inject
context after a compaction.

The problem it solves: an agent forgets everything when the session ends, so the same
decision gets re-derived and the same bug re-fixed across sessions.

Its design discipline is real — the agent curates what is worth saving rather than
capturing every tool call, which is the distinction it draws against `claude-mem` in
`docs/COMPARISON.md`. That is a defensible choice and it is well argued.

It is also a problem ghostfleet does not have, for a structural reason given below.

---

## Ranked candidates

### 1. A scripted-model fixture server, so agent behaviour is testable in CI

**Adopt. This is the one worth building.**

**The mechanism, concretely.** An agent's model call is an HTTP POST carrying messages
and tool definitions; the response names the next tool to call. That protocol is
standardised, so *anything that speaks it is, to the agent, a model*. gentle-ai stands up
a `httptest.NewServer` on loopback that returns a scripted sequence of tool calls, points
the agent at it through a custom provider, and runs the rest of the stack for real.

Verified in code, not just in their docs — `e2e/organicruntime/organic_runtime_test.go`
has seven `httptest.NewServer` call sites (lines 277, 402, 597, 771, 1067, 4488), and the
provider declaration at line 898 is `"npm": "@ai-sdk/openai-compatible"` with a loopback
`baseURL` and the literal string `fixture` as the API key. Nothing validates the key,
because nothing on the other end is a vendor API. No agent code is patched — as their
`docs/testing-agents-deterministically.md` puts it, this is a door OpenCode already left
open.

What stays real: the agent binary (version-pinned, mismatch fails the test), its plugin,
the git repository and its bare remote, the filesystem effects, and — the load-bearing
part — **the prompt asset is read from the same file shipped to users**, so there is no
test-only copy to drift. Only the model's reasoning is fake.

**What it would replace or add here.** It adds the missing half of `test/run.sh:2081`.
Today that group proves the contract string reaches the `claude` exec. A fixture server
would let it prove the clauses *do something*: script a model that reports done without
naming an observation, and assert the session's own output is missing what the contract
requires — the one assertion class ghostfleet cannot currently write at all.

This matters more here than it does for gentle-ai, because ghostfleet's contract is its
most heavily-evidenced artifact. Twenty-two assertions in the suite carry measured
justifications in their comments (30 of 50 re-reports with no file changed between
statements; 25.6% end-of-turn asking with no effect; 23 of 79 "that is not what I asked"
corrections). All of that evidence went into *choosing the words*. None of it is
protected against the words silently ceasing to work.

**Cost.** Real, and the largest on this list. A loopback HTTP server is Node stdlib
(`node:http`), so **no dependency** — the `package.json` constraint holds. The cost is
elsewhere:

- Ghostfleet's contract ships **only** through `bin/claude-here`. `bin/opencode-here` and
  `bin/codex-here` do not carry it (checked: `grep -n 'append-system-prompt\|CONTRACT'`
  over all three returns nothing outside `claude-here`). gentle-ai's fixture drives
  OpenCode. So the technique is verified for the runtime whose ghostfleet path has no
  contract to test, and the runtime that has the contract is the one where the approach is
  **unverified**. Claude Code reads `ANTHROPIC_BASE_URL`, which is the obvious way in, but
  I did not test it and this report should not be read as saying it works.
- The suite is currently a couple of seconds with no deps. An E2E leg is neither.
- A scripted model proves the *plumbing* of a behaviour, not the behaviour of a real
  model. It can prove "a session that omits an observation is caught". It cannot prove
  "Opus omits observations less often with the contract than without". Only the corpus
  can answer that, and the corpus is not a CI artifact.

**Evidence it works.** The mechanism is verifiable from code — the server exists, the
provider is wired, four journeys assert routing invariants. That it *catches regressions*
is their claim; there is no before/after defect count in the repo. Rate this as a
verified mechanism with an asserted benefit.

**What it would NOT help with.** Anything about a real model's judgment. Every pane
detector, tmux separator, socket-scoping and wire-format failure in `CLAUDE.md` — the
actual bulk of ghostfleet's history — is untouched by this. It buys one specific thing:
the contract stops being an untested asset.

---

### 2. `Derivation` — "I could not measure this" as a type, not a sentence

**Adopt. Cheap, and it is ghostfleet's own doctrine expressed as a data shape.**

**The mechanism, concretely.** In `bench/metrics.go`, every metric is a `Dimension`:

```go
type Dimension struct {
	Value      *int   `json:"value"`
	Derivation string `json:"derivation"`   // measured | proxy | unobservable
	Note       string `json:"note,omitempty"`
}
```

`Value` is a **pointer** so an unobservable dimension serialises as `null` rather than a
fabricated `0`. The comment on the constant block states the rule: *"It is emitted with
every dimension so a proxy can never be read as a measurement."*

Two rules in `bench/classify.go` (verified: `Classify` at line 528, tested against
recorded real output in `bench/testdata/observations.json` via `classify_test.go:21`)
extend the same discipline to author judgment. When the corpus wants to declare a block
a *correct* refusal rather than a failure, that declaration costs two things:

- **A shape from a closed vocabulary** — `operator-knowledge`, `world-action`,
  `human-authority`. An unrecognised shape is a corpus error and the run refuses to start.
- **A verified quote of the product's own text.** The classifier checks the quoted words
  are really in the emitted bytes. The comment at line 97: *"a quote that is not in the
  output is not a quote."* `Error: no.` cannot be declared by-design, because there is
  nothing to quote.

And the framing rule: an exemption is a **reclassification, never a subtraction** — the
block stays in the total, and declarations that did *not* apply are still printed,
because a refused declaration is the first sign the product's message changed.

**What it would replace or add here.** Ghostfleet's contract already says the right
thing in prose: *"say which criterion is unchecked rather than letting it read as passed"*
and *"an unchecked criterion named is worth more than a green that proved nothing."* This
is that instruction, enforced by a struct instead of hoped for from a model.

Two places it fits:

- **`fleet-look`'s golden comparison** already does the honest half — a fraction against a
  threshold, never equality, with expected/actual/diff written out on red. What it does
  not distinguish is *compared and matched* from *nothing to compare against*. A `--golden`
  run with no reference and a passing run are both success today.
- **Doctor** (roadmap top-1, unbuilt). Every check should be able to answer "I could not
  determine this" distinctly from "this is fine". A doctor that reports `0 problems`
  because four probes silently failed is precisely the green-that-proved-nothing this repo
  keeps legislating against.

**Cost.** Near zero. It is a convention plus a nullable field; no dependency, no new
binary, no daemon.

**Evidence it works.** The discipline is verifiable in code and the classifier is
unit-tested against recorded output. Whether it *changed any outcome* for gentle-ai is
not evidenced in the repo — but this one barely needs external evidence, because
ghostfleet already independently arrived at the same principle in prose and is only
missing the enforcement.

**What it would NOT help with.** It makes dishonest reporting harder to write. It does
not make anyone look at a screen. `fleet-look` is still the instrument for that.

---

### 3. engram's doctor envelope — a shape to copy, not a dependency to take

**Adopt the shape. Do not take the binary.**

**The mechanism, concretely.** `engram doctor` (`docs/DOCTOR.md`,
`cmd/engram/doctor.go`, 299 lines) is read-only by default and emits a stable JSON
envelope: a top-level `status` of `ok|warning|blocked|error`, a `summary` with counts,
and per check a `check_id`, `result`, `severity`, `reason_code`, `evidence`,
`safe_next_step`, and `requires_confirmation`. Repair is a separate verb requiring
`--project`, `--check`, and **exactly one** of `--plan`, `--dry-run`, `--apply`. The same
contract is exposed to agents as an MCP tool, `mem_doctor`.

**What it would add here.** Doctor is ghostfleet's roadmap top-1 with a concrete
evidence line already written — stale governors, dead `*.governor.pid`, orphan worktrees,
`.parked`/`.sched` markers with no session, mis-routed sockets, EPERM breakage, a control
plane older than the runtime. The diagnosis list exists; the output shape does not. Three
pieces are worth copying verbatim:

- **`reason_code` as a stable identifier separate from prose.** Ghostfleet's failures are
  overwhelmingly diagnosed by a human reading a message. A stable code is greppable and
  survives a reworded message.
- **`safe_next_step` per check.** This is the same idea as gentle-ai's in-band/out-of-band
  split: a diagnosis that names no runnable continuation makes the reader go and look it
  up. Ghostfleet is well placed for this — the fixes are already commands
  (`cf-sync`, `fleet-clean`, `ensure_governor`).
- **Three explicit repair modes rather than a boolean.** `CLAUDE.md` already mandates
  dry-run-by-default for `fleet-clean` and `fleet-adopt`. `--plan` (what I would do),
  `--dry-run` (what it would touch), `--apply` is a strictly better articulation of a rule
  the repo already holds, and refusing when none is named beats defaulting.

**Cost.** Zero. This is a design shape read off someone else's docs, not code to import
and not a runtime to install. Taking the engram *binary* is a separate proposition and is
rejected below.

**Evidence it works.** Assertion only. The envelope is documented and the command exists;
nothing in the repo measures whether it shortened a diagnosis. It is recommended because
it is *coherent* and because ghostfleet has already committed to building the thing.

---

### 4. The black-box tester protocol — three rules for live-fleet verification

**Adopt as doctrine. It is three sentences in a doc.**

`bench/AGENT-PROMPT.md` is a ready-to-paste prompt handed to an agent that tests
gentle-ai. Its three framing rules are better than the prompt:

1. **The agent may not read the source.** *"The test answers one single question: does the
   tool explain itself? An agent that has read the implementation gets unstuck with
   information a real user does not have, and the result comes out clean for the wrong
   reason."*
2. **A flow that gets stuck and cannot be continued is not a failure of the test — it is
   the finding.** *"The worst thing a tester can do is resolve the block on their own and
   write down PASS."*
3. **`CI=1` on every command**, because an agent harness allocating a pty makes the tool
   think a human is there to answer, and it waits forever.

There is a fourth rule of the same kind in `bench/README.md`, the **shim fidelity rule**:
a stream that is a character device is passed through untouched instead of being teed,
because replacing it with a pipe flips the tool's own interactivity check — *"a benchmark
that changes the thing it measures is worthless."*

**What it would add here.** `CLAUDE.md` says the suite cannot cover the interactive parts,
so verify against the live fleet and prefer proof over assertion. It does not say who
verifies, or under what constraints. Rule 1 is the sharp one: a ghostfleet worker asked to
verify a fleet behaviour has the whole repo open and will read `fleet-spawn` to work out
what should have happened — and then the run comes out clean for the wrong reason. Rule 2
matters because this repo's own history is full of blocks that got hand-resolved and
forgotten.

The shim fidelity rule is already ghostfleet-shaped thinking. It is the same class of
failure as *a detector measured at full width goes blind in a narrow one*, and as
`tmux attach </dev/tty` refusing because `ttyname()` returns the literal string. It would
sit comfortably in the *Things that have bitten* list.

**Cost.** Zero. Documentation.

**Evidence.** Assertion. It is stated as design rationale, with no measured comparison
between agents that read the source and agents that did not.

**What it would NOT help with.** It constrains verification that someone remembers to
run. It adds no automation.

---

## What not to adopt

### engram, as a memory system — a problem ghostfleet does not have

Ghostfleet's unit of work is a **worktree**, and worktrees are deliberately disposable.
`fleet-clean` exists to destroy them. The durable record of what a worker learned is the
**PR** — that is what `staging` is for, and why `CLAUDE.md` spends its longest section on
writing the *why* into a commit message. A worker that finishes has already externalised
its memory into the only store that outlives it and is reviewable by a human.

Engram is built for the opposite shape: one long-lived developer returning to one
long-lived project, wanting last week's decision back. That is a real problem. It is not
this one.

The costs, if it were adopted anyway:

- A **new external binary**, installed out of band (`brew install`). The `package.json`
  constraint survives literally — engram is Go, not npm — which is exactly why it deserves
  scrutiny rather than a pass. The constraint is load-bearing because ghostfleet installs
  by copying files into `~/.local/libexec/ghostfleet` and running. A hard prerequisite in
  `install.sh` breaks that even though it never touches a dependency key.
- A **second always-on daemon**, per the setup hook: `session-start.sh` runs
  `engram serve` in the background on port 7437 and `sleep 0.5`. Ghostfleet already runs a
  governor daemon and has a scar about daemons running stale code
  (`ensure_governor` restarts one whose code changed), plus a standing rule about never
  broad-`pkill`-ing a shared daemon. A second one, listening on a fixed port shared across
  every project on the machine, is a meaningful addition to that surface.
- `curl` and `jq` on the session-start path, adding two failure modes to session startup —
  the most latency-sensitive path in the product.
- **Its own claim, not verified here:** "zero runtime deps". Precisely, this is true of
  the *shipped binary* — pure-Go SQLite via `modernc.org/sqlite`, no cgo. The `go.mod` has
  roughly 60 modules at build time. The claim is about distribution and is fair; it is not
  a claim that the project is small.

If the underlying want is *"a lead should not lose the thread when it compacts"* — that
is roadmap **Handoff**, and it is a different mechanism: spawn a successor and retire the
old session. Engram would not do that. Its compaction hook persists a summary into a
database; it does not move the fleet's dispatch role to a live session.

### engram's private-redaction — strictly weaker than what is already here

`plugin/pi/private-redaction.js` is 44 lines. It strips `<private>…</private>` blocks
from strings, URL query values, and recursively through payloads. Its own docstring is
honest: *"a convenience convention, not a general-purpose secret scanner."*

Against ghostfleet's threat model this is not a smaller version of the name sweep, it is
the wrong shape:

- It only catches what someone **remembered to tag**. Ghostfleet's actual leaks were names
  nobody tagged — fixtures that were the owner's real projects, a live PR link, a real
  tailnet address. A tag-based scrubber cannot catch any of those.
- It replaces content with the literal string `[REDACTED]`, which `CLAUDE.md` forbids by
  name: *"Never `REDACTED`, never `xxx`: a comment full of holes is worse than a generic
  example, because the hole tells you something was removed and still teaches nothing."*
- `test/run.sh`'s sweep reads **every tracked file** and matches against one-way digests,
  so the check itself publishes nothing; `test/helpers/doc-fixtures.mjs` goes further and
  asks whether an example name is *in* `web/fixtures/` — membership, not a blacklist,
  which catches the next name and not just the last one.

Ghostfleet's mechanism is better on every axis that matters here. There is nothing to take.

### gentle-ai as an installer/configurator — inverted ownership

gentle-ai would want to own what ghostfleet's `install.sh` already owns: MCP registration,
hooks, skills, system prompts. Adopting it means ghostfleet's wiring becomes managed
config written by a second tool that also manages 15 other agents' config on the same
machine, on its own release cadence. `CLAUDE.md`'s deploy section is a careful account of
which long-lived processes pick up a change and when; adding a second writer to those
files makes that reasoning harder, not easier.

It also requires **Node.js 18+ and npm as a hard prerequisite on every platform,
regardless of which components you select** (`docs/quickstart.md:38`).

And the fit is poor in the other direction too: gentle-ai's value is breadth across
runtimes. Ghostfleet drives three (`claude`, `opencode`, `codex`), already declares agent
capabilities rather than hardcoding them (there is a suite group for exactly that), and
the fleet's whole design is one project's agents on one hidden tmux server.

### RDD, receipts and lifecycle gates — ceremony without a gate

The heaviest subsystem in gentle-ai: freeze the candidate's bytes, hash them, verify the
obligation, emit a receipt, revalidate the gate. Genuinely well built — the observation
corpus shows `review validate --gate pre-commit` denying with a structured envelope
naming `lineage_id`, `base_tree`, `candidate_tree`, `paths_digest`, `policy_hash`,
`evidence_hash` and a typed `denial`.

Reject, for two reasons:

1. **Ghostfleet already has the gate, and it is enforced by something that cannot be
   talked out of it.** `staging` and `main` are branch-protected: a PR is required and both
   suite legs must be green. A receipt is a claim an agent produces about its own work.
   GitHub refusing the push is not.
2. **RDD explicitly does not gate delivery.** Their own README: *"Review outcomes are
   informational and never authorize, block, or govern delivery"*, and *"Ordinary
   repository policy owns delivery."* So it would add substantial machinery in front of a
   decision it then declines to make. For a single-owner repo whose delivery is already
   PR-gated, that is cost with no corresponding authority.

The *idea* behind it — an agent asserting "I verified it, it passes" is prose, not proof —
is correct and is exactly ghostfleet's thesis. Ghostfleet's answer to it is `fleet-look`
and the observation contract, which attack the same problem at the point where it
actually fails here: not *did the bytes change under review*, but *did anyone look at the
screen*. Candidate #1 strengthens that answer. RDD would replace it with a different one
aimed at a governance problem this repo does not have.

### gentle-ai's persona and output styles — asserted where ghostfleet is measured

A "teaching-oriented persona", shipped as Claude Code output styles and per-agent persona
files (`persona-claude-gentleman.golden` and siblings). No evidence of effect is offered
and none is implied — it is a product choice about voice.

Ghostfleet's system-prompt real estate is currently spent on ten clauses, each traceable
to a count in a corpus of 324 corrections across 104 sessions. Adding unmeasured
personality prose to that same channel dilutes the one thing making the channel
defensible. If anything, the contract's existing length is the risk to watch.

### SDD (spec/design/tasks artifacts) — resolved differently, already

gentle-ai's SDD generates durable proposal → spec → design → tasks artifacts before
implementation, with ten agents and a command set per runtime.

Ghostfleet's equivalent decision is already made and points the other way: the contract
says *ask only where two concrete implementations would visibly differ*, and *state the
structural assumptions as concrete answers rather than asking whether anything is
missing* — backed by the measurement that end-of-turn clarifying questions are saturated
at 25.6% of turns with no measurable effect on rework. SDD is that same instinct
industrialised into files. On this repo's own evidence, generating more up-front artifacts
is the intervention already shown not to move the number.

Worth noting the two are not really in conflict: gentle-ai gates SDD behind *"durable
artifacts would materially reduce substantial ambiguity"* and refuses to enter it
silently. That is a compatible position, arrived at from the other side. It just is not a
mechanism to import.

### Multi-agent debate — neither repo proposes it

Named here only to close it out, since it was raised as a comparison axis. Neither repo
implements debate: gentle-ai's parallelism is delegation to narrow single-purpose workers,
and its review actors are lenses over frozen bytes, not adversaries arguing. That is
consistent with ghostfleet's own measurement that debate underperforms self-consistency at
2.1–3.4× the tokens. Nothing here challenges that finding.

---

## Summary table

| # | Mechanism | Source | Cost | Dependency | Evidence |
|---|---|---|---|---|---|
| 1 | Scripted-model fixture server for behaviour E2E | gentle-ai `e2e/organicruntime/` | High | None (`node:http`) | Mechanism verified in code; benefit asserted |
| 2 | `Derivation` (measured/proxy/unobservable) + verified-quote exemptions | gentle-ai `bench/metrics.go`, `classify.go` | Low | None | Verified in code; unit-tested against recorded output |
| 3 | Doctor envelope: `reason_code`, `safe_next_step`, `--plan/--dry-run/--apply` | engram `docs/DOCTOR.md` | None (a shape) | None | Assertion |
| 4 | Black-box tester rules + shim fidelity rule | gentle-ai `bench/AGENT-PROMPT.md`, `bench/README.md` | None (docs) | None | Assertion |
| — | engram as a memory system | engram | High | Binary + daemon on :7437 + curl/jq | Problem not present here |
| — | private-redaction | engram `plugin/pi/` | — | — | Strictly weaker than the name sweep |
| — | gentle-ai as configurator | gentle-ai | High | Node 18+ / npm, always | Inverts ownership of `install.sh` |
| — | RDD / receipts / gates | gentle-ai | High | None | Branch protection already gates; RDD declines to |
| — | Persona / output styles | gentle-ai | Low | None | No evidence offered |
| — | SDD artifact chain | gentle-ai | High | None | Contradicted by this repo's own 25.6% finding |

---

## What I looked at, and what I did not

**Observed.** Both repos cloned and read at the commits named at the top. For the two
recommendations that carry weight I read the implementation rather than the docs: the
`httptest` server and its `openai-compatible` provider declaration in
`organic_runtime_test.go`; `Dimension`/`Derivation` in `bench/metrics.go`; `Classify`,
`ByDesignDeclaration.Validate` and `verified` in `bench/classify.go`, plus the
`classify_test.go` fixture load. On the ghostfleet side I read the contract string in
`bin/claude-here:227`, the whole of the `the observation contract reaches claude` group
at `test/run.sh:2081`, `hooks/fleet-guard.sh`, `bin/fleet-look.mjs`, and confirmed by grep
that no `ANTHROPIC_BASE_URL` / `baseURL` / scripted-model path exists anywhere in `bin/`,
`test/`, `mcp/` or `hooks/`, and that `append-system-prompt` appears only in
`bin/claude-here`.

**Not checked.** Neither repo was built or run — no `go build`, no `gentle-ai`
binary, no `engram` binary, no test suite of theirs executed. So every statement about
what these tools *do at runtime* is read off source and docs, not off observed behaviour.
Specifically unverified: that the bench harness's driven mode is deterministic and
offline (their claim, and its `--binary` indirection makes it plausible); that the
Organic Runtime E2E currently passes; and that `engram doctor` emits the envelope its
docs specify.

**The one gap that would change a recommendation.** Candidate #1 is verified for
OpenCode, which is the ghostfleet runtime that does *not* receive the contract. Whether
Claude Code can be pointed at a loopback fixture the same way is untested here. If it
cannot, candidate #1 shrinks to testing the `opencode-here` path and the case for
building it weakens considerably. That should be the first thing checked, and it is
cheap to check.
