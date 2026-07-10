---
name: claude-fleet-orchestrate
description: Coordinate AND spawn sibling Claude Code sessions in the same claude-fleet (parallel git worktrees). Use when you are a "lead" session dividing work across siblings — create a NEW worker on its own git worktree/branch, dispatch a prompt to a session, list the fleet, or read a sibling's latest output. Triggers include "spin up a worker for X", "create a new session/worktree on branch Y", "parallelize this into workers", "kick off the workers", "send this to <session>", "have <session> do X", "check what <session> said", "dispatch these briefs to the other worktrees". Runs the fleet-spawn / fleet-send / fleet-list / fleet-read commands (or the fleet_* MCP tools).
---

# Orchestrating sibling fleet sessions

You are running inside a **claude-fleet** session. The env var `CLAUDE_FLEET_SOCK`
identifies your fleet (all sessions share one hidden tmux server). Sibling
sessions are other worktrees/tasks in the same fleet — e.g. an `api` lead
alongside `api-1` and `api-2` workers. You can drive them from your
Bash tool:

- **`fleet-list`** — list sibling sessions and their status (`working` / `ready` /
  `need-you` / `idle`). `(you)` marks the current session.
- **`fleet-send <session> "<prompt>"`** — type a prompt into that session's Claude
  and submit it. Multi-line prompts are sent as one message. This is how you hand
  a worker a task/brief.
- **`fleet-read <session> [n]`** — print the last `n` (default 1) assistant
  messages from that session, so you can see how a worker is doing.
- **`fleet-spawn <name> [--branch <b>] [--from <ref>] [--model <m>] [--prompt "<task>"]`** —
  create a git worktree off the current repo and start a fresh worker session in
  it (in the background), optionally handing it an initial task. Use to spin up a
  new parallel worker on its own branch. Pass `--model opus` for heavier tracks
  (workers otherwise use the account's default model).

These are also exposed as MCP tools (`fleet_list`, `fleet_send`, `fleet_read`,
`fleet_spawn`) if the claude-fleet MCP server is registered — prefer those when
available; otherwise call the shell commands via Bash.

## How to use it

1. `fleet-list` first — see who exists and who's free.
2. `fleet-send <worker> "<self-contained brief>"` to dispatch. Give the worker a
   complete brief (it doesn't share your context): the task, the files/paths, the
   done-criteria.
3. Later, `fleet-read <worker> 3` to check progress before sending the next step.

## Rules

- **Don't spam a busy worker.** If `fleet-list` shows a session `working`, a new
  `fleet-send` will queue after its current turn — fine for the *next* task, but
  don't fire multiple prompts at a working session.
- **Prompts must be self-contained.** A sibling has its own conversation/context;
  paste the full brief, not a reference to "the thing we discussed".
- **You can't see a worker's screen** — use `fleet-read` to observe, not assume.
- Only sessions in *your* fleet (same `CLAUDE_FLEET_SOCK`) are reachable.

## Example

```bash
fleet-list
# dispatch to existing workers:
fleet-send api-1 "Implement the payments module in src/payments/*. Brief: … Done when: the test suite for that module passes."
fleet-send api-2 "Build the app shell + shared UI. Brief: … Done when: the shell renders and auth wraps it."
# or spin up a brand-new worker on its own worktree/branch, briefed in one shot:
fleet-spawn worker4 --branch feat/notifications --prompt "Build the notification jobs. Brief: … Done when: …"
# … later …
fleet-read api-1 3
```
