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

The governor's OTHER ceiling is deliberately not on this list. **Machine metering** —
`kern.memorystatus_vm_pressure_level` and the process table vs `kern.maxproc` — reads
kernel counters rather than a pane, so it needs no adapter and already governs a fleet
of any agent, Claude or not. Where budget metering asks *whose account is this and what
does its status bar say*, the machine ceiling asks a question every agent answers the
same way: how much of this box is left.


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
- **Tools without instructions, and (for codex) without a fleet.** Since 2026-08-27 all
  three agents have the `fleet_*` tools. Two things still degrade: neither non-Claude agent
  gets `skill/ghostfleet-orchestrate`, so it has the tools and no instructions for them; and
  a **codex** session must pass `project` explicitly, because codex starts MCP servers with
  a scrubbed environment and the tools cannot otherwise tell which fleet they are in. See
  Q4 for the measurements. Hooks are unaffected by any of it — MCP is tools, hooks are push
  events, and codex still supplies none.
- **A missing busy regex is not "never busy".** An agent with no validated detector is
  reported as *unknown*, never as idle — the always-idle failure mode is the one this repo
  has been bitten by before.

## Selecting an agent

- `fleet-spawn <name> --agent opencode` — per worker
- `CLAUDE_FLEET_AGENT=opencode` — env, honoured by the session launcher
- the card shows the agent whenever it isn't claude
- default stays `claude`, so nothing changes for anyone who ignores this

`fleet-spawn` refuses an unknown agent, and refuses a known one whose binary isn't on
PATH, *before* it creates a worktree — a half-built worker whose pane dropped to a
shell is worse than a clear error. It also prints a warning when the chosen adapter is
unverified or can't resume.

## What a non-Claude master actually loses

The plumbing to run a project's master on `codex` or `opencode` has been there for a while
and was unreachable from any screen — the answer to "make the master opencode" was *edit
`~/.config/ghostfleet/projects` by hand*. It is a picker now, on the phone's **add project**
sheet and on its **per-project settings** row, and as an `AGENT` column on the TUI's `,`
page. Only **installed** agents are offered: an option that cannot run is worse than a
missing one, because picking it leaves the next master dead at `exec agent-here` with
nothing on screen to say why.

**Probed on this machine on 2026-08-26**, and the MCP rows re-probed on the 27th when that
wiring landed, because the cost of the choice is the part that had to be established rather
than guessed:

| | claude | opencode | codex | agy | cursor |
|---|---|---|---|---|---|
| fleet event hooks | ✅ `settings.json` | ✅ `opencode-fleet-event.js` | ❌ **nothing** | ✅ `~/.gemini/config/hooks.json` (done + working; no permission event) | ✅ `~/.cursor/hooks.json` (done + working + need-you on an error; no permission event) |
| ghostfleet MCP registered | ✅ per profile, in `.claude.json` | ✅ `opencode.jsonc` | ✅ `~/.codex/config.toml` | ✅ `~/.gemini/config/mcp_config.json` | ✅ `~/.cursor/mcp.json` |
| …and a call with no `project` finds its own fleet | ✅ | ✅ | ❌ **name it every time** | ✅ | ❌ **name it every time** |
| orchestrate skill | ✅ symlinked into `<profile>/skills/` | ❌ | ❌ | ✅ `~/.gemini/config/skills/` | ✅ `~/.cursor/skills/` |
| resume across a pane kill | ✅ | ✅ | ❌ | ✅ | ✅ |

agy was added on 2026-10-01 and cursor on 2026-10-06, both measured the same way — see
[agy](#agy-antigravity-cli) and [cursor](#cursor-cursor-agent) below.

The MCP row went green for all three on 2026-08-27, and the row under it is what that did
*not* buy. **MCP gives tools; hooks give push events**, and one is not a substitute for the
other: a codex master can now call the fleet — list it, send to it, spawn into it — and
still cannot tell it anything. No inbox row, no master woken, its status read from its pane
exactly as before. "You can see it, you will not be told."

The third row is codex's own behaviour rather than a gap in the installer: it starts an MCP
server with a **scrubbed environment**, so nothing the session exported reaches the tools
and `fleet_list` with no arguments cannot tell which fleet it is in — where the identical
call from opencode resolves its own. From codex, name the project on every call. Q4 has both
transcripts.

What that costs in practice is composed from the five capability fields rather than
written out per agent, so a fourth agent gets its warning by declaring them — and a clause
that stops being true is shrunk rather than left standing, which is what happened to the
"no fleet_* tools" line on the 27th:

```
$ fleet-agent caveat claude     (empty — nothing is given up)
$ fleet-agent caveat opencode   no orchestrate skill: it has the fleet_* tools but not the
                                instructions, so it will not drain the inbox or dispatch
                                siblings unless you tell it to
$ fleet-agent caveat codex      no fleet events: status is guessed from its pane, and a
                                question it asks may never reach the inbox. fleet_* tools
                                must name the project: … . no orchestrate skill: … . no
                                resume: recycling its pane loses the conversation
```

Both pickers print that beside the option and the TUI column carries the short form.
**Shipping the option silently would be worse than not shipping it** — a fleet whose codex
master never reaches the inbox reads as broken rather than as degraded.

## What shipped

| Piece | Where |
|---|---|
| the adapter table + per-session agent marker | `bin/fleet-agent` |
| launcher dispatch (default path unchanged) | `bin/agent-here` |
| OpenCode launch/resume | `bin/opencode-here` |
| Codex launch | `bin/codex-here` |
| OpenCode → fleet events | `hooks/opencode-fleet-event.js` |
| agy launch/resume | `bin/agy-here` |
| agy → fleet events | `hooks/agy-fleet-event.sh` |
| cursor launch/resume | `bin/cursor-here` |
| cursor → fleet events | `hooks/cursor-fleet-event.sh` |

A session's agent is recorded in `<sock>.<session>.agent`, alongside the existing
`.parked` / `.sched` / `.notify-lead` markers and socket-namespaced for the same
reason: every project has a `master`. **Absent means claude**, so every session that
already exists, and every code path that has never heard of agents, stays on the
default with no migration.

The four coupling sites now ask the adapter: `bin/claude-here` (via `agent-here`),
busy detection in `fleet-grid.mjs` / `fleet-send` / `fleet-worktrees` / `fleet-spawn`,
the event bridge, and `fleet-governor`'s metering.

### Keeping the default honest

Claude's three busy regexes are transcribed **verbatim** from the pre-adapter code and
were diffed byte-for-byte against `git show HEAD` to prove it. `fleet-grid.mjs --plain`
on three live Claude fleets produces output identical to the old grid once the new
AGENT column is removed. Claude never goes through an adapter lookup at all — its
pattern is inlined and `agent-here` execs `claude-here` directly.

### Traps found while wiring it, worth not re-introducing

- **An empty busy regex must never reach `grep -E`.** `grep -qE ""` matches every
  line, so an agent with no detector would report as permanently *busy*. Every call
  site guards for it and reports *unknown* instead.
- **`-s <socket>` is mandatory when one fleet touches another.** `fleet-agent` prefers
  the live `$TMUX` server like the rest of the fleet, but `fleet-spawn` routes workers
  to their *owning* project's socket, which is often not the lead's. Resolving from
  `$TMUX` there filed the marker under the caller's fleet and the worker came back as
  plain claude. `-s` is accepted anywhere after the subcommand, because accepting it in
  only one position is the same silent-wrong-answer trap.
- **The grid resolves `fleet-agent` as its own sibling, not through PATH.** A PATH miss
  made every non-claude agent lose its detector and silently fall back to the last
  hook status — wrong, with no error anywhere.
- **OpenCode republishes a user message after `session.idle`.** Treating each copy as a
  new turn rewrote `ready` back to `working` a second after finishing, so a done worker
  looked permanently busy. The plugin de-dupes by message id.
- **`set -u` + an empty bash array kills the pane on macOS.** bash 3.2 treats
  `"${empty[@]}"` as unbound and aborts, so `CLAUDE_FLEET_YOLO=0` (or simply no model)
  made the launcher exit instead of starting the agent. The new launchers expand
  through `${a[@]+"${a[@]}"}`; `claude-here` only gets away with the bare form because
  it never sets `-u`. Found by testing the yolo switch in *both* positions — the
  default path was fine, which is exactly why the opt-out needed exercising too.

### Known rough edges

- `fleet-send`'s submit confirmation parses Claude's `╭ … ╰` input box. OpenCode's
  input box is drawn differently, so confirmation falls back to the busy check. In
  practice the turn starts and busy goes true, which confirms it; only a turn that
  finishes faster than the poll can emit a spurious "could not confirm submit"
  warning. The prompt still lands.
- `fleet-agent installed` reports an agent whenever its binary is on PATH. "On PATH" is
  not "works" — see the codex note below, where the binary was on PATH and every
  invocation died until a first-launch dialog was cleared.
- The OpenCode bridge is installed globally into `~/.config/opencode/plugin/`. It is
  inert without `CLAUDE_FLEET_SOCK`, so ordinary `opencode` use is unaffected.

## Open questions — answered

Measured 2026-08-01 against **OpenCode 1.18.11** on macOS. Every OpenCode claim below was
produced by running the real binary; the captures are quoted verbatim. **Codex could not be
run on the day these were taken** — see the codex section, which records both what that
turned out to be (a first-launch dialog, not a missing binary) and the two things about
codex that are still genuinely unverified.

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

### Codex — the "could not be executed" was a dialog, not a limitation

> **Corrected.** This section said codex was *not runnable on this machine* — every
> invocation, `codex --version` included, dying with `ENOENT` on a vendored native binary —
> and concluded that no answer for codex could be evidence-backed. **The binary was there.**
> macOS Gatekeeper was holding it at a first-launch quarantine dialog, and an unanswered
> dialog looks exactly like a missing file to anything that only reads the exit status. With
> the dialog cleared codex runs, and it has since been measured: it reads an image from a
> path (`docs/attachments.md` §2), its busy and idle panes are captured as fixtures
> (`test/fixtures/codex-*.txt`) and its detectors are asserted against them in both
> directions, and the capability matrix above was probed against a running binary.
>
> The correction is kept visible rather than edited away, because the failure mode is real
> and will recur: a first-launch dialog on a machine nobody is looking at is
> indistinguishable from a broken install, and "not runnable" was an *inference* printed
> beside measurements. What remains genuinely unverified for codex is narrower and is marked
> as such below.

What was established without executing it, and still stands:

- `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl` exists on disk with 19 real
  rollout files, so sessions *are* persisted per-conversation with a UUID in the filename —
  suggestive of a resumable id, but whether `codex resume <id>` pins to a cwd is **untested**.
- `~/.codex/config.toml` is real TOML and already carries per-directory state
  (`[projects."/path"] trust_level`), so a `notify` key has somewhere to live.
- Codex's `notify` hook is documented as a program invoked with a JSON argument; it is the
  plausible `need-you` bridge, but **nothing here was observed firing.**
- Its `notify` hook is still **not wired**, which is the `❌ fleet event hooks` row in the
  matrix above: a codex master's status is read from its pane, and a question it asks may
  never reach the inbox.
- `codex resume <id>` pinning to a cwd remains **untested**, and the matrix records the
  consequence rather than the mechanism: recycling a codex pane loses the conversation.

Its busy and idle pane text is no longer unknown — the fixtures are in `test/fixtures/` and
the detectors run against them in both directions, which is the bar CLAUDE.md sets for
calling a signal reliable. What is still missing for codex is the event bridge and resume,
both of which the matrix above states at the point where the choice is made.

### Q4 (answered 2026-08-27). MCP registration — wired, with one asymmetry

`install.sh` registers the fleet's MCP server for **all three** agents now:

| agent | where | how |
|---|---|---|
| claude | `<config dir>/.claude.json`, **once per profile** | `claude mcp add -s user` (or jq, if the CLI is absent) |
| codex | `~/.codex/config.toml`, **once, globally** | `codex mcp add ghostfleet -- node <server>` |
| opencode | `~/.config/opencode/opencode.jsonc`, **once, globally** | jq — not `opencode mcp add`, see below |

One registration per CLI is correct rather than a compromise: for Claude a profile *is* a
config dir, while codex and opencode keep a single global config and have no per-profile
equivalent. The server does not carry a fleet — `mcp/fleet-mcp.mjs` resolves which fleet
and profile it serves from the session's `CLAUDE_FLEET_SOCK` / `CLAUDE_CONFIG_DIR` at
runtime, and `agent-here` exports both per session — so one entry serves every fleet and
every profile.

**`fleet_list` from a codex session needs an explicit `project`; from opencode it does
not.** This is the one asymmetry, and it is codex's behaviour rather than a gap in the
wiring. Measured by *calling* the tool, not by reading `codex mcp list`:

```
# codex, CLAUDE_FLEET_SOCK exported, fleet_list with no arguments:
mcp: ghostfleet/fleet_list (completed)
fleet-list: no socket (run inside a fleet session, or pass -s <socket>)

# codex, same session, fleet_list(project: "ghostfleet"):
SESSION                STATUS
ci                     ready
docs-sync              working
master                 ready       …

# opencode, CLAUDE_FLEET_SOCK exported, fleet_list with NO arguments:
SESSION                STATUS
install-nonint         working    (you)          <- resolved its own fleet
```

codex launches an MCP server with a **scrubbed environment**, so nothing the session
exported reaches the server and the tools cannot tell which fleet they are in.
`-c shell_environment_policy.inherit=all` does not change it — that policy governs codex's
shell tool, not its MCP children. So from codex, name the project on every call
(`fleet_list(project: …)`, `fleet_send(project: …, …)`); `fleet_send`'s `reply_to` needs a
resolvable self and is unavailable there for the same reason. This is recorded as the
`mcp_self` field in `bin/fleet-agent` and printed in its caveat, so the pickers say it too.

**Why `opencode mcp add` is not used.** It exists and takes a command after `--`
(undocumented in its `--help`), but it cannot be pointed at a file: with
`XDG_CONFIG_HOME` set it created a directory literally named `undefined` in the working
directory, and with `HOME` set it ignored it and wrote the invoking user's real
`~/.config/opencode/opencode.jsonc`. Both exited 0 printing "added to <path>", one of them
naming a path it had not written. A tool that reports success while writing elsewhere
cannot be tested without editing the developer's own config, so the installer writes the
JSONC itself — the same fallback it already has for `.claude.json`. A `.jsonc` that jq
cannot parse (it may hold comments) is left untouched, with the entry printed for pasting.

**MCP is tools; hooks are push events.** Wiring MCP gives codex neither hooks nor the
orchestrate skill: it writes no inbox row, wakes no master, its status is still read from
its pane, and nothing tells the session the fleet exists. "You can see it, you will not be
told" is exactly as true for codex after this as before. opencode has both halves and
reaches near parity, minus the skill. `skill/ghostfleet-orchestrate` is a Claude Code
feature and stays Claude-only — both non-Claude agents have the tools without the
instructions for using them.

**Already-running sessions do not gain the tools.** An MCP server is spawned once per
session and lives as long as it, so a session open when the installer ran keeps the server
it started with. `install.sh` says this in its own output, because the person who needs it
has usually just re-run the installer to fix exactly this.

## agy (Antigravity CLI)

Measured 2026-10-01 against **agy 1.2.14** on macOS, signed in, in tmux panes at 30, 40,
56, 80, 120, 140 and 200 columns. Everything below was observed, not read off docs; where
agy's own embedded docs disagreed with the binary, the binary won.

**One configuration root.** agy reads `~/.gemini/config/` globally: `hooks.json`,
`mcp_config.json` and `skills/<name>/SKILL.md`. So `install.sh`'s `register_agy` gives it
all three halves from one place — events, tools and the orchestrate skill — which makes it
the one non-claude agent with the skill. `fleet-agent caveat agy` is empty.

**Events.** agy has lifecycle hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`,
`PostInvocation`, `Stop`), JSON on stdin, JSON expected on stdout. `hooks/agy-fleet-event.sh`
translates the two that matter into the payload `hooks/fleet-event.sh` already reads and
pipes it through, so the inbox, sub-lead routing, lead wake and reply-to relay are the same
code for every agent:

| agy event | fleet event |
|---|---|
| `PreInvocation`, `invocationNum` 0 | `UserPromptSubmit` → working, un-park |
| `PreInvocation`, later | working |
| `Stop`, `terminationReason` contains "error" | `need-you` |
| `Stop`, otherwise | `ready` + `done` |

Measured with a probe hook: one turn that called three tools fired `PreInvocation` with
`invocationNum` 0, 1, 2, 3 and then one `Stop` with `terminationReason: "NO_TOOL_CALL"` —
upper case, where the embedded docs say `model_stop`. The hook inherits the session's
environment (`CLAUDE_FLEET_SOCK`, `CLAUDE_FLEET_SLOT`, `$TMUX`, `$TMUX_PANE` all arrived).
**There is no permission-asked event**, so a tool prompt is seen only on the pane.

Two traps, both measured:

- **A `PreToolUse` handler that prints `{}` denies the tool.** `decision` is required, and
  every tool call in the probe session came back "tool call denied by pre-tool hook". The
  bridge registers no `PreToolUse`, and the suite asserts it stays that way.
- **agy's own transcript is not Claude's shape** (one step per line, the model's text in a
  `PLANNER_RESPONSE` step's `content`), so the bridge writes the turn's last response into a
  fleet-side `<sock>.<slot>.agy.jsonl` in the shape the grid reads, as the opencode bridge does.

**The pane.**

```
⣟  The system ensures safety by preventing simultaneo...      <- working: spinner at column 0
esc to cancel                    Gemini 3.8 Flash · high       <- footer while a turn runs
? for shortcuts                  Gemini 3.8 Flash · high       <- footer when idle
```

The footer is the obvious busy signal and the wrong one: it **still says `esc to cancel`
while a permission dialog waits on a human**, so it reads a blocked worker as working. The
spinner line is present in every working frame (366 of them, all eight braille glyphs,
always followed by two spaces) and absent from the dialog, so `busy_re` is the spinner at
column 0. agy indents its own prose by two, which is what keeps a model writing *about* a
spinner from matching. `blocked_re` is the dialog's `Requesting permission for:` or the
trust prompt; `ready_re` is the idle footer — not the `> ` composer, which the trust dialog
also draws.

**Resume.** `agy -c` is cwd-scoped (codeword in repoA, newer conversation in repoB, `-c`
from each answered with its own) and survives a pane kill (codeword planted in a TUI pane,
tmux server killed, `-c` recalled it). `agy --conversation <id>` with an id that does not
exist **warns and starts a fresh conversation, exit 0**, so `agy-here` checks for
`conversations/<id>.db` and refuses instead.

**Trust.** Every folder agy has not seen opens on "Do you trust the contents of this
project?", `--dangerously-skip-permissions` does not cover it, and trust is **not**
inherited — a fresh folder under an already-trusted `$HOME` still asked. Every new worktree
would therefore come up on the dialog and have its brief typed into it, so under yolo
`agy-here` appends the worktree's physical path to `trustedWorkspaces`, the same answer the
dialog records — the shape `codex-here` already uses for codex's trust table.

## cursor (`cursor-agent`)

Measured 2026-10-06 against **cursor-agent 2026.10.01-e373342** on macOS, signed in on a free
plan, in tmux panes at 30, 40, 56, 80, 120, 140 and 200 columns, and then as a real worker:
`fleet-spawn --agent cursor` into a scratch project on its own socket and its own fleet dir.
Where cursor's bundled docs and the binary disagreed, the binary won.

The installer puts it at `~/.local/bin/cursor-agent` **and** `~/.local/bin/agent`. The second
name is generic enough to be anything on another machine's PATH, so the fleet runs only
`cursor-agent`.

**One configuration root, shared with the IDE.** `~/.cursor/` holds `hooks.json`, `mcp.json`
and `skills/<name>/SKILL.md`, and `install.sh`'s `register_cursor` writes all three. The
Cursor IDE reads the same files, so every write merges into them, and the first time a file
that already existed is changed its original is copied to `<file>.pre-ghostfleet` — once,
never refreshed by a later run. `CURSOR_CONFIG_DIR` moves cursor's settings and chats but
**not** these two JSON files, whose paths it builds from the home directory; the installer
follows the binary, not the variable.

**It also runs Claude's hooks.** cursor's hook loader reads `~/.claude/settings.json`
beside its own `hooks.json` (Claude-compatibility, on by default, no switch found) and the
orchestrate skill from `~/.claude/skills/` the same way. The hooks get **cursor's** payload:
cursor's event names (`stop`, `beforeSubmitPrompt`, `sessionStart`), no `cwd`, cursor's
transcript. Before this change a cursor session in a fleet pane was therefore already writing
records through `fleet-event.sh`: measured, one landed in the live fleet dir with status
`working`, an empty cwd, and the slot of the pane that launched the session. `fleet-event.sh`
now drops any payload that carries `cursor_version`. The bridge's own payload never does, and
the check reads the key, not the bytes, so a Claude prompt that merely mentions the key is
unaffected.

**Events.** `hooks/cursor-fleet-event.sh` is registered for two of cursor's events and
translates them into the payload `fleet-event.sh` reads, like the agy bridge:

| cursor event | fleet event |
|---|---|
| `beforeSubmitPrompt` | `UserPromptSubmit` → working, un-park, arm a reply-to relay |
| `stop`, `status: "error"` | `need-you`, with the transcript's own error text |
| `stop`, otherwise | `ready` + `done` |

A probe hook on every event showed the order of one turn: `beforeSubmitPrompt`, then the tool
events, then `afterAgentResponse` and `stop` in the same second and in **either order**. So the
card's last message is read at `stop` from cursor's transcript, not taken from
`afterAgentResponse`. That transcript is almost Claude's shape, keyed on `role` where the grid
reads `type`, so the bridge appends the turn's last assistant text to a fleet-side
`<sock>.<slot>.cursor.jsonl`. The error mapping was seen for real: the free plan refuses every
named model ("Free plans can only use Auto"), and that turn ended `status: "error"`. **There is
no permission-asked event**: `beforeShellExecution` fires before cursor's own approval check,
the same for a command it will allow as for one it is about to ask about. Every event carries
the account's email (`user_email`). The bridge passes on only the named fields, and the suite
checks that the address reaches no file.

**The pane.**

```
 ⠰⠰ Working                                                <- working: two braille cells at column 1
  → Add a follow-up                       ctrl+c to stop   <- the composer, WHILE a turn runs
  → Add a follow-up                                        <- the composer when idle
```

- **busy** is the spinner line: one space, a two-cell braille spinner, a space, the phase
  (`Working`, `Running`). Across 333 frames it matched all 129 working frames and nothing else.
  The composer's `ctrl+c to stop` is never drawn without the spinner, but the spinner sometimes
  appears without it: the first frame of a turn draws the spinner a beat before the hint.
  Neither is drawn while the permission dialog waits, so cursor does not have agy's footer
  trap. Column 1 is the prose guard, because cursor indents everything it prints by two.
- **A still frame lied.** The first captures resized the pane every quarter second, and
  every one froze on `⠀⠞`, so the first regex spelled U+2800 as the spinner's first cell.
  A turn left alone at one width animated through eight frames (`⠀⠞ ⠰⠰ ⠘⠆ ⠰⠳ ⠠⠜ ⠘⠤ ⠠⠛ ⠘⠣`).
  That regex missed 21 of the turn's 25 working frames, and the grid called the worker ready
  three seconds before it finished.
- **ready** is the placeholder alone on its line. `→ Add a follow-up` is also drawn while
  the turn runs, with the stop hint after it, so a placeholder match alone read every busy
  pane as ready.
- **blocked** is the dialog's `Run this command?` (at column 1), the trust box's live
  selector `▶ [a] Trust this`, or the prompt Escape opens (next bullet). Not the trust box's
  title: once answered, the box stays on screen, title and all, with `⏳ Trusting
  workspace...` in place of the selector, above a composer that is ready.

**The permission dialog** (with `CLAUDE_FLEET_YOLO=0` only) is keyed by **letters**: `→ Run
(once) (y)`, `Add … to allowlist? (tab)`, `Run Everything (shift+tab)`, `Skip & tell the agent
what to do instead (esc or n)`. The selected option uses the composer's own arrow.
`lib/permission-dialog.mjs` reads it at every width and fingerprints it the same at 30, 56
and 80 columns. It returns no typeable options, as for opencode: the phone sends an option and
then Enter, and Enter after `y` would land in the composer. **Escape is half a decline.**
Measured on a live worker, it opens `→ Tell the agent what to do instead (Enter to send, empty
to skip, Esc to cancel)`. A second Escape goes back to the dialog, and Enter on the empty line
completes the skip ("The shell command was blocked"). So `fleet-answer` names both keys, and
the second is answerable on its own because that line is no longer a permission dialog.
`fleet-answer --key Enter` on the dialog itself was refused.

**Resume.** `--resume <chatId>` reopens exactly that chat, and it survives a pane kill:
a codeword was planted, the pane killed, and `fleet-restart --reopen` relaunched with
`--resume <id>` and the codeword came back. The id is the hooks' `conversation_id`, so the
record carries it. **An unknown id is not refused.** cursor opens an empty chat under it, with
no warning, and creates `chats/<md5>/<id>/` while it does, so the directory existing proves
nothing. `cursor-here` requires that chat's `meta.json` to say `"hasConversation": true`.
Chats live at `<config>/chats/<md5 of the physical cwd>/<id>/`. `--continue` is cwd-scoped,
but in a checkout with no chat it **exits 1** ("No previous chats found."), which would close
the pane. So `cursor-here` uses it only when that hash directory holds a chat that took a turn,
and starts a fresh one otherwise.

**Trust and approvals.** Every folder cursor has not seen opens on the trust box, and
`--force` does not cover it. Under yolo, `cursor-here` passes `--force --trust
--approve-mcps`. None of the three is written back to `cli-config.json` (measured: no diff
after a `--force` turn). **`--model` is**: one launch with it rewrote the account's default
model, so every later cursor session, the owner's own included, came up on it. `cursor-here`
never passes `CLAUDE_FLEET_MODEL`; pick cursor's model with `/model` inside the session.

**MCP: tools, not its own fleet.** cursor starts the ghostfleet server without the session's
environment, which is codex's behaviour. A real worker with `CLAUDE_FLEET_SOCK`, `$TMUX` and
`CLAUDE_FLEET_PROJECTS` exported called `fleet_list` with no arguments and got `fleet-list: no
socket`. Naming the project resolved it from the default projects file, not the one the session
had exported. So `mcp_self` is `no`, and that is the whole of `fleet-agent caveat cursor`.

**Worth knowing before pointing cursor at a repo with commit rules.** cursor's
`cli-config.json` has `attribution.attributeCommitsToAgent` and `attributePRsToAgent`, both on
in the account measured. The fleet does not change them, and what they add to a commit was
not measured.
