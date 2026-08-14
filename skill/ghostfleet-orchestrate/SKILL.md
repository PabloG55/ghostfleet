---
name: ghostfleet-orchestrate
description: Coordinate, spawn, observe, unblock, and budget sibling Claude Code sessions in the same ghostfleet (parallel git worktrees). Use when you are a "lead"/master session dividing work across siblings — see which worktrees are free and REUSE one before creating another, dispatch a prompt to a worker, list the fleet, read a worker's output, check who needs you, unblock a worker stuck on a prompt, or park/resume workers to control cost. USE THIS FOR ANY MENTION OF A WORKTREE IN A FLEET SESSION — "start a worktree", "make/create a worktree", "spin up a worktree", "worktree this", "start a wrotree" and every other typo of it. In a ghostfleet session that ALWAYS means a ghostfleet worktree (a sibling of the repo, run by a NEW session), never Claude Code's built-in EnterWorktree tool, which would move THIS session into <repo>/.claude/worktrees/ and abandon the thread the user is talking to. Other triggers: "spin up a worker for X", "work on a worktree to fix Y", "which worktrees are free / reuse a worktree", "create a new session/worktree on branch Z", "parallelize this into workers", "kick off the workers", "send this to <session>", "have <session> do X", "check what <session> said", "who needs me / check the inbox", "unblock/answer <session>", "pause/park <session>", "resume <session>". Runs the fleet-* commands (or the fleet_* MCP tools).
---

# Orchestrating sibling fleet sessions

You are running inside a **ghostfleet** session (usually the **master**/lead). The
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

## "Start a worktree" means fleet-spawn — never EnterWorktree

Claude Code ships its own worktree tool, **`EnterWorktree`**, and in here it is always
the wrong one. It creates the tree at `<repo>/.claude/worktrees/<name>` and then
**relocates the calling session into it**. So a lead told *"start a worktree and open a
PR"* that reaches for it gets a worktree — and silently walks off its own checkout. No
new session, no new pane, and the thread the user was talking to is now somewhere else.
It looks half-right, which is exactly why it slipped through twice before anyone noticed.

| | ghostfleet | built-in `EnterWorktree` |
|---|---|---|
| where | sibling of the repo | `<repo>/.claude/worktrees/<name>` |
| who works it | a **new** session; you keep yours | **this** session, moved |
| gets | node_modules, dev-stack slot, manifest entry | none of it |

A `PreToolUse` hook refuses `EnterWorktree` in a fleet session and points back here, so
if you see that refusal it is not an obstacle to route around — reach for `fleet-spawn`
(or just `git checkout -b` and do the work yourself, which needs no worktree at all).

`ExitWorktree` is never blocked: a session that already got moved needs its way back.

## First: are you the lead, or are you already a worker?

**If this session is already in a git worktree, do not spawn anything.** You are a
worker, and workers are leaves — spawning here adds a second worktree beside the one you
are sitting in. When you finish a PR and are asked to start fresh work, re-branch where
you stand:

```bash
git fetch origin && git checkout -B <new-branch> origin/main
```

That is the whole operation: same worktree, same session, same dev-stack slot, and the
dependencies you already installed. `fleet-spawn` refuses from a linked worktree and
says this, so if you see that refusal it is not an obstacle to work around — it means
the request was "start new work", not "start a new worker".

Everything below is for a **lead** in the project's main checkout.

## Reuse a worktree before you spawn a new one

Worktrees are a **reusable resource, not disposable.** Creating a fresh one when
idle ones already exist wastes disk, branches, and your attention — and it's the
classic way a lead "gets lost." So:

1. Run **`fleet-worktrees`**. If it lists a **FREE** worktree that fits, reuse it.
2. Reuse with **`fleet-spawn <name> --reuse <worktree>`** — starts a worker in that
   existing worktree on its current branch. To **recycle** it onto a fresh branch in
   one step, add `--branch <new> --from <base>`: e.g.
   `fleet-spawn fix --reuse api-3 --branch feat/x --from main` cleans it
   (`reset --hard`) and checks out the new branch off the base.
3. Only create a new worktree when none are free — and `fleet-spawn` enforces this:
   **if free worktrees exist it will refuse and list them** rather than silently
   make another. Add **`--new`** only when you genuinely want a fresh worktree.

## Attention & completion: pull the inbox, don't poll

A worker can't interrupt you, and polling each one with `fleet-read` burns the
**shared account budget** (see below). Instead the events you act on are collected
passively into an inbox you drain in one call:

- a worker **`done`** — its turn finished (idle). This is your **completion
  signal**: when a dispatched brief is ready to review/merge, or the worker is free
  for the next task. (A worker's autonomous turn ends once, so one `done` per brief.)
- a worker **`need-you`** — permission / usage-limit / a real question.
- governor **`parked`/`resumed`** — budget shedding.

- **`fleet-inbox`** — shows what's new since you last looked, then marks it seen.
  Check it at the top of an orchestration turn; `fleet-read <worker> 3` only on the
  ones it flags. A `done` → dispatch the next step or merge; a `need-you` →
  `fleet-answer`. If the **push** is enabled for this fleet, you'll instead be
  *woken* by a nudge — *"[fleet] a worker finished or needs you…"*. When you get it,
  just drain `fleet-inbox` and act; it's an automated note, don't reply to it. (The
  push is debounced — a burst of finishes wakes you once. If it's off, you're not
  woken while idle, so drain the inbox whenever you next act.)

## Asking a session a question (not dispatching work)

A plain `fleet-send` is **one-way**. The target works and its turn ends, but that `done`
event goes to *its own* fleet's master — never to you — so a question sent to another
project's session looks ignored no matter how long you wait. When you want an answer:

- **`fleet-send --reply-to me <session> "<question>"`** (MCP: `fleet_send` with
  `reply_to: true`) — records your address, and when that session's turn ends the hook
  relays its answer into **your** `fleet-inbox` and wakes you. Add `-s <socket>` (MCP:
  `project`) to ask another project's session; that is the case it exists for.
- The answer arrives as an `ANSWERED` row naming `<project>/<session>`, with the reply's
  first ~200 characters. Pull the rest with `fleet-read -s <socket> <session> 3`.
- The target is told it is answering an agent, so **ending its turn is the reply** — it
  doesn't run anything. If it hits a permission prompt mid-request you get an `ASKS` row
  instead, and can unblock it with `fleet-answer`; the address survives until it answers.
- One request, one answer. Ask again to ask again.

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
- **`fleet-stop <session>`** — done *for good*: kills the session and clears its
  state. Pause is temporary; **stop is gone.** Use it when a worker is finished, or
  when you removed its git worktree and the session now lingers as `dead` in
  `fleet-list` (the fleet's only clean "stop"). It doesn't touch git — run
  `git worktree prune` if the dir is stale.

## The core commands

| do | command |
|----|---------|
| see all worktrees + which are free | `fleet-worktrees` |
| see live sessions + status | `fleet-list` |
| check who needs you / what finished | `fleet-inbox` — its footer also names worktrees whose PR merged and are safe to reclaim |
| a worker is done for good | `fleet-stop <session> --reclaim` — stops it AND removes its worktree when safe, or keeps it and says why |
| dispatch a task | `fleet-send <session> "<self-contained brief>"` |
| **ask** a session something (answer comes back) | `fleet-send --reply-to me <session> "<question>"` |
| read a worker's output | `fleet-read <session> [n]` |
| reuse a free worktree | `fleet-spawn <name> --reuse <worktree> [--prompt "…"]` |
| recycle a worktree onto a new branch | `fleet-spawn <name> --reuse <wt> --branch <new> --from <base>` |
| new worker (only if none free) | `fleet-spawn <name> [--branch b] [--from ref] [--new] [--prompt "…"]` |
| unblock a stuck worker | `fleet-answer <session> "<keys>"` |
| park / resume (cost) | `fleet-pause <session>` / `fleet-resume <session>` |
| stop a worker for good (or a dead orphan) | `fleet-stop <session>` |

`fleet-spawn` accepts `--model opus` for heavier tracks (workers otherwise use the
account default). It records each worker's task in a manifest, so `fleet-worktrees`
shows *what each worktree is for* — that's how you rebuild your map after a restart
instead of guessing. `--from` bases the branch on your **local** ref (use
`--from HEAD` for the current one) and only falls back to the remote tip if local
is *behind* — so a worker never misses your just-committed, unpushed work. A fresh
worktree also gets the main checkout's `node_modules` symlinked in, so workers can
actually run lint/typecheck/tests.

## Rules

- **Look before you spawn.** `fleet-worktrees` first; reuse a FREE worktree; only
  `--new` when none fit.
- **Stuck ≠ busy — reach for `fleet-answer`, not another `fleet-send`.** A worker
  that ignores a `fleet-send`, or shows `working` with no progress, is usually
  **blocked on a dialog** (a permission prompt, a "reached usage limit — retry?",
  a trust prompt). A prompt can't dismiss a dialog — send the keystroke:
  `fleet-answer <session> "2"`. (`fleet-inbox` flags these as `need-you`.) This is
  the single most common mis-step; when in doubt, `fleet-read`/`fleet-answer` to
  see and clear the dialog before sending more work.
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
