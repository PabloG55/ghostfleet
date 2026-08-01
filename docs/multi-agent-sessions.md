# Running Codex and OpenCode sessions in the fleet

**Status:** design, not yet implemented. Tracking branch `feat/multi-agent-sessions`.

## Is it possible

Yes, and most of the fleet doesn't care. The substrate — a tmux server per project,
worktrees, the Node grid, scheduling, pause/resume, the inbox — has nothing to do with
Claude. It moves panes around and reads their text.

What *is* Claude-specific is four things, and they're the whole job:

| # | Coupling | Where | Applies to Codex / OpenCode? |
|---|----------|-------|------------------------------|
| 1 | **Launch + resume** — `exec claude --resume <id> --dangerously-skip-permissions --model …`, transcript discovery under `$CLAUDE_CONFIG_DIR/projects/<enc-cwd>/*.jsonl`, `--fork-session`, `claude agents --json` | `bin/claude-here` | No — each CLI has its own resume model |
| 2 | **Busy detection** — a regex over Claude's spinner: `… (9m 31s · ↓ 34.4k tokens)`, `esc to interrupt` | `bin/fleet-grid.mjs` (`BUSY_RE`), `bin/fleet-send`, `bin/fleet-worktrees`, `bin/fleet-spawn` | No — different UIs, different text |
| 3 | **`need-you` / `done` events** — Claude Code hooks (`Notification`, `Stop`, `SessionStart`, `UserPromptSubmit`, `SessionEnd`) wired into each config dir by `install.sh` | `hooks/fleet-event.sh` | No — neither has the same hook contract |
| 4 | **Budget metering** — scrapes `NN%(` (the 5h usage figure) out of Claude's status bar to park workers at the ceiling | `bin/fleet-governor` (`pct_of`) | No — no equivalent signal |

Everything else — `fleet-spawn`, `fleet-worktrees`, `fleet-pause`/`resume`, `fleet-schedule`,
`fleet-cycle`, the grid, profiles — is agent-agnostic already.

## The shape

An **agent** is a new per-session axis, orthogonal to the existing *profile* axis. Profile
answers *whose account*; agent answers *which CLI*.

Each agent supplies one adapter:

```
launch      argv to start it, fresh
resume      argv to continue the conversation for this cwd (or "" = unsupported)
busy_re     regex identifying "generating" in a captured pane
hooks       does it emit need-you/done into the fleet's event file?
budget      can we read a usage percentage out of the pane?
```

That table is the entire abstraction. `claude-here` becomes the `claude` adapter rather
than the only path, and the four Claude-specific sites above consult the adapter for the
session's agent instead of assuming.

## What degrades, and it must degrade honestly

This matters more than the feature. A signal that silently never fires looks identical to
one that works — the repo has been bitten by exactly that before, which is why
`CLAUDE.md` says to check a claimed signal in *both* directions.

- **No hooks (Codex, OpenCode).** `need-you` can't be pushed. Those sessions fall back to
  pane heuristics, which detect *working* well and *blocked* poorly. A Codex card must not
  render a confident "ready" it hasn't earned; the grid should show the agent on the card
  so an unknown state is legible as "we can't tell for this agent" rather than "idle".
- **No budget signal.** The governor meters a shared Claude account. It must treat
  non-Claude sessions as unmeterable and skip them — never park them on a reading taken
  from a different agent's pane, and never count them toward the ceiling.
- **Resume semantics differ.** `claude-here` guarantees re-opening a session resumes its
  conversation. If an agent can't do that, opening it starts fresh; say so at launch
  rather than pretending.

## Selecting an agent

Proposed, smallest surface that fits what exists:

- `CLAUDE_FLEET_AGENT=codex` — env, honoured by the session launcher
- `fleet-spawn <name> --agent codex` — per worker
- grid `n` picks the agent when more than one is installed; the card shows it
- default stays `claude`, so nothing changes for anyone who ignores this

## Open questions

1. Does `codex resume` / OpenCode's session model give a stable id we can pin a pane to,
   the way `claude --resume <uuid>` does? If not, "re-open the session you left" is not
   deliverable for that agent and should be documented as such, not faked.
2. Can either emit a notification we can turn into `need-you`? Codex has a `notify` hook
   in its config; OpenCode has plugins/events. If yes, they get real blocked-detection
   instead of heuristics.
3. MCP: `install.sh` registers the fleet's MCP server via `claude mcp add` into
   `.claude.json`. Do the others read MCP from somewhere we can write, so a worker can
   still call `fleet_*` tools and talk to its lead?

Answer 1 and 2 before writing the adapters — they decide whether this is "full parity" or
"pane-only, honestly labelled".
