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

*(Updated after the research below. OpenCode degrades far less than this section originally
assumed; Codex degrades to nothing, because it could not be run at all.)*

- **Hooks.** OpenCode **does** push events (`permission.asked` → `need-you`, `session.idle`
  → `done`), so it does not fall back to heuristics — see Q2. Codex is unverified, so it is
  wired for pane-only detection and its card must not render a confident "ready" it hasn't
  earned. The grid shows the agent on the card so an unknown state is legible as "we can't
  tell for this agent" rather than "idle".
- **No budget signal.** True for both. The governor meters a shared Claude account. It must
  treat non-Claude sessions as unmeterable and skip them — never park them on a reading
  taken from a different agent's pane, and never count them toward the ceiling.
- **Resume semantics differ.** `claude-here` guarantees re-opening a session resumes its
  conversation. OpenCode matches this via cwd-scoped `--continue` (verified). Codex is
  unverified: opening it starts fresh, and it says so at launch rather than pretending.
- **A missing busy regex is not "never busy".** An agent with no validated detector is
  reported as *unknown*, never as idle — the always-idle failure mode is the one this repo
  has been bitten by before.

## Selecting an agent

Proposed, smallest surface that fits what exists:

- `CLAUDE_FLEET_AGENT=codex` — env, honoured by the session launcher
- `fleet-spawn <name> --agent codex` — per worker
- grid `n` picks the agent when more than one is installed; the card shows it
- default stays `claude`, so nothing changes for anyone who ignores this

## Open questions — answered

Measured 2026-08-01 against **OpenCode 1.18.11** on macOS. Every OpenCode claim below was
produced by running the real binary; the captures are quoted verbatim. **Codex could not be
tested at all** — see the codex section, and treat everything there as unverified.

### Q1. Stable, resumable session id pinned to a cwd?

**OpenCode: yes — better than expected.** Sessions get a stable `ses_*` id and are stored in
SQLite at `~/.local/share/opencode/opencode.db`, table `session`, which carries a
`directory` column — a real cwd pin, the same thing `claude-here` reconstructs by encoding
the cwd into a transcript path.

Three separate resume affordances, all real:

| Flag | Behaviour |
|------|-----------|
| `--continue` / `-c` | continue the last session **for this directory** |
| `--session <ses_…>` | continue exactly that id |
| `--fork` | branch instead of appending (pairs with either of the above) |

The load-bearing question was whether `--continue` is cwd-scoped or globally "newest", because
a global one would resume worker A's conversation inside worker B's checkout. **Verified in
both directions**: two git repos, a codeword planted in each, `repoB`'s session created last.

```
$ cd repoA && opencode run --continue "What codeword did I ask you to remember?"
ALPHA                     # NOT BRAVO — did not take the globally-newest session
$ cd repoB && opencode run --continue "What codeword did I ask you to remember?"
BRAVO
```

So `--continue` alone gives the fleet correct per-worktree resume, and `--session` gives
`fleet-open <id>` an exact pin. This is parity with `claude --resume`.

**Caveat, and it bites:** `opencode session list` is **not** cwd-scoped — run from an unrelated
directory it still lists every session in the data dir. Only the *resume* path is scoped. Do
not build "which session belongs to this worktree" on top of `session list`; read the
`directory` column, which is authoritative.

### Q2. A notification we can turn into `need-you`?

**OpenCode: yes, a real push — no heuristics needed.** Plugins are **auto-discovered** from
`.opencode/plugin/*.js` (project) — no `opencode.json` entry required, which matters because
it means the fleet can install its event bridge per-worktree without editing user config. A
plugin exports an async function and returns hook handlers; a catch-all `event` hook sees
every event on the bus.

Proven by writing a probe plugin and reading what actually fired:

```
LOADED directory=…/repoA worktree=…/repoA
EVENT session.created  {"sessionID":"ses_04175caffffe…","info":{…,"directory":"…"}}
EVENT session.idle     {"sessionID":"ses_04175caffffe…"}          # exactly once, at end of turn
EVENT permission.asked {"id":"per_fbe8ba6f9001…","sessionID":"ses_0417462e1ffe…",
                        "permission":"bash","patterns":["python3 -c \"print(6*7)\""],…}
```

That is a direct mapping onto the fleet's existing event vocabulary:

| Fleet event | OpenCode event |
|-------------|----------------|
| `need-you`  | `permission.asked` |
| `done`      | `session.idle` (fired once per completed turn) |
| session id / cwd registration | `session.created` |
| error       | `session.error` |

So OpenCode does **not** degrade to pane-only. It gets pushed blocked-detection, the same
class of signal Claude Code hooks provide.

### Q3. What a pane actually looks like — captured, not guessed

`tmux capture-pane -p` against a live OpenCode TUI, 200x50. Three states, all real:

**WORKING** (footer line, mid tool-call):
```
 ⬝⬝⬝⬝⬝⬝■■  esc interrupt                                  12.5K (6%)  ctrl+p commands    • OpenCode 1.18.11
```

**IDLE** (same line once the turn ended — the interrupt hint is replaced by the cwd):
```
 /private/tmp/…/scratchpad/repoA                          13.8K (7%)  ctrl+p commands    • OpenCode 1.18.11
```

**BLOCKED** on a permission prompt:
```
 ┃  △ Permission required
 ┃    # Shell command
 ┃  $ python3 -c "print(6*7)"
 ┃   Allow once   Allow always   Reject          ctrl+f fullscreen  ⇆ select  enter confirm
```

Findings that change the adapter design:

- The busy token is **`esc interrupt`**, *not* Claude's `esc to interrupt`. The existing
  `BUSY_RE` would never match an OpenCode pane — a silent always-idle, exactly the failure
  mode `CLAUDE.md` warns about. Each agent needs its own regex.
- Checked in both directions: `grep -c 'esc interrupt'` is **≥1 while generating** and
  **0 when idle** and **0 while blocked** on the permission prompt.
- Blocked correctly reads as *not working*, so `need-you` is not masked by the busy check —
  and `△ Permission required` / `Allow once` gives a **pane-level blocked detector** as a
  fallback for when the plugin isn't installed.
- Do **not** use elapsed time as a busy signal here. OpenCode prints `· 22.1s` on the message
  header **after** the turn completes — the opposite of Claude, where the timer means live.

**Budget:** the footer's `13.8K (7%)` is *context window* usage and `$0.00 spent` is session
cost. Neither is Claude's 5h account window. There is no equivalent signal, so OpenCode
sessions must be treated as unmeterable — never counted toward the ceiling, never parked on a
reading taken from a Claude pane.

### Codex — NOT VERIFIED, could not be executed

Codex is on `PATH` but **not runnable on this machine**: `@openai/codex` is a thin Node
wrapper that spawns a vendored native binary, and that binary is absent, so every invocation
(`codex --version` included) dies with `ENOENT` on
`…/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`. Machine-level issue, out of
scope for this branch, deliberately not worked around.

Consequently **no Q1/Q2/Q3 answer for Codex is evidence-backed.** What can be established
without executing it:

- `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl` exists on disk with 19 real
  rollout files, so sessions *are* persisted per-conversation with a UUID in the filename —
  suggestive of a resumable id, but whether `codex resume <id>` pins to a cwd is **untested**.
- `~/.codex/config.toml` is real TOML and already carries per-directory state
  (`[projects."/path"] trust_level`), so a `notify` key has somewhere to live.
- Codex's `notify` hook is documented as a program invoked with a JSON argument; it is the
  plausible `need-you` bridge, but **nothing here was observed firing.**
- Its busy/idle pane text is **unknown**. No regex is guessed for it.

The codex adapter in this branch is therefore structurally complete but **explicitly marked
untested**, and its busy regex is empty — which the adapter layer treats as "this agent has no
working detector", not as "never busy". It must be validated against a real codex before
anyone relies on it.

### Q4 (still open). MCP registration

`install.sh` registers the fleet's MCP server via `claude mcp add` into `.claude.json`.
OpenCode has both an `mcp` key in `opencode.json` and an `opencode mcp` subcommand, so the
bridge is clearly writable — not wired up in this PR.
