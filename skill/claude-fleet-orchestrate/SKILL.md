---
name: claude-fleet-orchestrate
description: Coordinate, spawn, observe, unblock, and budget sibling Claude Code sessions in the same claude-fleet (parallel git worktrees). Use when you are a "lead"/master session dividing work across siblings — see which worktrees are free and REUSE one before creating another, dispatch a prompt to a worker, list the fleet, read a worker's output, check who needs you, unblock a worker stuck on a prompt, or park/resume workers to control cost. Triggers include "spin up a worker for X", "work on a worktree to fix Y", "which worktrees are free / reuse a worktree", "create a new session/worktree on branch Z", "parallelize this into workers", "kick off the workers", "send this to <session>", "have <session> do X", "check what <session> said", "who needs me / check the inbox", "unblock/answer <session>", "pause/park <session>", "resume <session>". Runs the fleet-* commands (or the fleet_* MCP tools).
---

# Orchestrating sibling fleet sessions

You are running inside a **claude-fleet** session (usually the **master**/lead). The
env var `CLAUDE_FLEET_SOCK` identifies your fleet — every session shares one hidden
tmux server. Sibling sessions are other worktrees/tasks in the same fleet (e.g. an
`api` lead alongside `api-1`, `api-2` workers). You drive them from your Bash tool
(or the `fleet_*` MCP tools — **prefer the MCP tools when available**).

## Read the state BEFORE you act

You cannot see the fleet; you have to *look*. Your context drifts and a restarted
lead starts blank, so **do not act from memory — read the real state first:**

- **`fleet-worktrees`** — every git worktree of this repo: its branch, whether a
  session is live on it, git state (clean/dirty, ahead/behind), the task it was
  spun up for, and a **"Free to reuse"** line. This is your map.
- **`fleet-inbox`** — what has needed you since you last looked (see below).
- **`fleet-list`** — the live sessions and their status.

## Reuse a worktree before you spawn a new one

Worktrees are a **reusable resource, not disposable.** Creating a fresh one when
idle ones already exist wastes disk, branches, and your attention — and it's the
classic way a lead "gets lost." So:

1. Run **`fleet-worktrees`**. If it lists a **FREE** worktree that fits, reuse it.
2. Reuse with **`fleet-spawn <name> --reuse <worktree>`** — this starts a worker in
   that existing worktree (on its current branch), without creating anything new.
3. Only create a new worktree when none are free — and `fleet-spawn` enforces this:
   **if free worktrees exist it will refuse and list them** rather than silently
   make another. Add **`--new`** only when you genuinely want a fresh worktree.

## Attention: pull the inbox, don't poll every worker

A worker can't interrupt you, and polling each one with `fleet-read` burns the
**shared account budget** (see below). Instead, attention-needing events are
collected passively — a worker's `need-you` (permission / usage-limit / a real
question) and the governor's park/resume — into an inbox you drain in one call:

- **`fleet-inbox`** — shows what's new since you last looked, then marks it seen.
  Check it at the top of an orchestration turn. Use `fleet-read <worker> 3` only on
  the workers it flags, not on everyone.

## Unblock a worker stuck on a prompt

`fleet-send` types a *task* into a worker and submits a turn — it can't answer a
**dialog**. When a worker is parked on a permission prompt, a "reached usage limit —
retry?", or a trust prompt, use:

- **`fleet-answer <session> "<keys>"`** — sends literal keystrokes (e.g. `"2"`),
  Enter by default. `--no-enter` to skip Enter; `--key <Name>` (repeatable) for
  special keys (Enter, Escape, Up, Down…). It prints the pane afterward so you see
  the effect.

## Budget: one shared account

Every worker AND you drink from **one usage pool**, so wide fan-out drains it N×
faster and everyone stalls at the ceiling together. A **governor** runs alongside
the fleet (a dumb non-Claude loop) and auto-parks the newest workers as usage
climbs, resuming them when the window resets — you'll see those in `fleet-inbox`.
Help it: don't over-fan-out, and **park idle/expensive workers yourself**:

- **`fleet-pause <session>`** — reliably interrupt a worker and mark it OFF (zero
  consumption).
- **`fleet-resume <session> ["<task>"]`** — un-park it; with a task it wakes right
  away. (Sending any new prompt also un-parks a worker.)

## The core commands

| do | command |
|----|---------|
| see all worktrees + which are free | `fleet-worktrees` |
| see live sessions + status | `fleet-list` |
| check who needs you | `fleet-inbox` |
| dispatch a task | `fleet-send <session> "<self-contained brief>"` |
| read a worker's output | `fleet-read <session> [n]` |
| reuse a free worktree | `fleet-spawn <name> --reuse <worktree> [--prompt "…"]` |
| new worker (only if none free) | `fleet-spawn <name> [--branch b] [--from ref] [--new] [--prompt "…"]` |
| unblock a stuck worker | `fleet-answer <session> "<keys>"` |
| park / resume (cost) | `fleet-pause <session>` / `fleet-resume <session>` |

`fleet-spawn` accepts `--model opus` for heavier tracks (workers otherwise use the
account default). It records each worker's task in a manifest, so `fleet-worktrees`
shows *what each worktree is for* — that's how you rebuild your map after a restart
instead of guessing.

## Rules

- **Look before you spawn.** `fleet-worktrees` first; reuse a FREE worktree; only
  `--new` when none fit.
- **Don't spam a busy worker.** If it's `working`, one `fleet-send` queues after the
  current turn — fine for the *next* task; don't fire several at a working session.
- **Prompts must be self-contained.** A sibling has its own context — paste the full
  brief (task, files/paths, done-criteria), not "the thing we discussed".
- **You can't see a worker's screen.** Use `fleet-read` / `fleet-inbox` to observe,
  never assume.
- Only sessions in *your* fleet (same `CLAUDE_FLEET_SOCK`) are reachable.

## Example

```bash
fleet-worktrees          # → "Free to reuse: api-3"
fleet-inbox              # → api-1 NEEDS YOU: permission to run tests

# unblock the one that needs me
fleet-answer api-1 "2"

# reuse the free worktree instead of making a new one
fleet-spawn fix-auth --reuse api-3 \
  --prompt "Fix the token refresh bug in src/auth/*. Brief: … Done when: auth tests pass."

# a genuinely new track (no free worktree fit) — off the fresh remote main
fleet-spawn notifications --from main --new \
  --prompt "Build the notification jobs. Brief: … Done when: …"

# shed an idle worker to protect the shared budget
fleet-pause api-2

# … later …
fleet-inbox              # who needs me now
fleet-read fix-auth 3    # check the one I care about
```
