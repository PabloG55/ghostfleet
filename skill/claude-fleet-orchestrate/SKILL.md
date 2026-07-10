---
name: claude-fleet-orchestrate
description: Coordinate sibling Claude Code sessions in the same claude-fleet (parallel git worktrees). Use when you are a "lead" session dividing work across siblings — dispatch a prompt to another session, list the fleet, or read a sibling's latest output. Triggers include "send this to <session>", "have widgetco-1 do X", "kick off the workers", "check what <session> said", "dispatch these briefs to the other worktrees". Runs the fleet-list / fleet-send / fleet-read commands.
---

# Orchestrating sibling fleet sessions

You are running inside a **claude-fleet** session. The env var `CLAUDE_FLEET_SOCK`
identifies your fleet (all sessions share one hidden tmux server). Sibling
sessions are other worktrees/tasks in the same fleet — e.g. a `widgetco` lead
alongside `widgetco-1` and `widgetco-2` workers. You can drive them from your
Bash tool:

- **`fleet-list`** — list sibling sessions and their status (`working` / `ready` /
  `need-you` / `idle`). `(you)` marks the current session.
- **`fleet-send <session> "<prompt>"`** — type a prompt into that session's Claude
  and submit it. Multi-line prompts are sent as one message. This is how you hand
  a worker a task/brief.
- **`fleet-read <session> [n]`** — print the last `n` (default 1) assistant
  messages from that session, so you can see how a worker is doing.
- **`fleet-spawn <name> [--branch <b>] [--from <ref>] [--prompt "<task>"]`** —
  create a git worktree off the current repo and start a fresh worker session in
  it (in the background), optionally handing it an initial task. Use to spin up a
  new parallel worker on its own branch.

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
fleet-send widgetco-1 "Implement the policy PDF engine in lib/policy/generation/*. Brief: … Done when: `pnpm test` passes for the generation module."
fleet-send widgetco-2 "Build the app shell + UI primitives in apps/web + packages/ui. Brief: … Done when: the shell renders and Clerk auth wraps it."
# or spin up a brand-new worker on its own worktree/branch, briefed in one shot:
fleet-spawn a4 --branch feat/notifications --prompt "Build the email notification jobs. Brief: … Done when: …"
# … later …
fleet-read widgetco-1 3
```
