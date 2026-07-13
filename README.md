# claude-fleet

A zellij-native master CLI for running many **Claude Code** sessions in parallel.

One zellij session, one pane — `claude-fleet` is the whole control plane:

```
Projects          ⏎→    Master Claude      C-a s→    the session grid
 ▸ web                   the lead — spawns           api  api-1  api-2 …
 ▸ api                   & coordinates workers  ───▸  ⏎ enter · n new · N parallel
 ▸ + add project        ←`  (back to Projects)       ←`  (back to master)
```

- **Projects** — pick a project and `⏎` drops you straight into its **Master Claude**. `x` removes
  a project from the list; `+ add project` browses to a root folder. Each project has its own
  hidden tmux server (`cf-<project>`) holding its sessions.
- **Master Claude** — the lead session that spawns worktrees and coordinates workers. `C-a s`
  jumps to the session grid; `` ` `` (or `C-a g`) steps back to Projects.
- **The grid** — a card per Claude session (status · branch · last message). Arrow to one, `⏎` to
  drop *inside* it full-screen; `` ` `` back to the grid. Every session keeps running in the
  background, so agents work in parallel while you jump between them. `` ` `` steps back to master.

Nothing else is zellij-native like this — every other terminal fleet tool (nicknisi/fleet,
tmux-claude-session-manager, Recon) is tmux-bound; the rest take over your multiplexer
(Claude Squad, ccmanager) or are web/cloud dashboards (Omnara).

## Orchestrate: a lead session driving workers

Because every session lives on the same tmux socket, a "lead"/**master** session can dispatch
work to siblings, watch them, unblock them, and manage cost — turning a fleet into
lead-and-workers (e.g. an `api` lead handing briefs to `api-1` / `api-2` worktrees). All of it
is callable from a session's Bash (or the `fleet_*` MCP tools).

**The lead's loop — look before you act.** Fleet state lives on disk (worktrees + a manifest of
what each was spun up for), not in the lead's head, so it *reads* the state instead of guessing —
which is what keeps a long-running or restarted lead from getting lost:

1. **`fleet-worktrees`** + **`fleet-inbox`** — what exists / what's free, and who needs you.
2. **Reuse a free worktree** before creating one — `fleet-spawn` refuses to proliferate (it lists
   the free ones) unless you `--reuse <wt>` or `--new`.
3. **`fleet-answer`** to unblock a stuck worker; **`fleet-pause`** to shed cost.

| goal | command |
|------|---------|
| every worktree + which are **FREE** | `fleet-worktrees` |
| live sessions + status | `fleet-list` |
| who needs you / what **finished** (drains since last look) | `fleet-inbox` |
| dispatch a self-contained brief | `fleet-send <session> "…"` |
| read a worker's last N messages | `fleet-read <session> [n]` |
| **reuse** a free worktree for a worker | `fleet-spawn <name> --reuse <wt> --prompt "…"` |
| **recycle** a worktree onto a fresh branch | `fleet-spawn <name> --reuse <wt> --branch <new> --from main` |
| new worktree (only if none free) | `fleet-spawn <name> [--branch b] [--from ref] --new --prompt "…"` |
| unblock a worker stuck on a dialog | `fleet-answer <session> "2"` |
| park / resume a worker (cost) | `fleet-pause <session>` · `fleet-resume <session>` |
| **stop** a worker for good (or a dead orphan) | `fleet-stop <session>` |

```bash
fleet-worktrees                 # → "Free to reuse: api-3"
fleet-inbox                     # → api-1 DONE (feat/x) · api-2 NEEDS YOU: run tests?
fleet-answer api-2 "2"          # unblock the one waiting on a dialog
fleet-spawn fix-auth --reuse api-3 --branch feat/auth --from main \
  --prompt "Fix token refresh in src/auth/*. Done when auth tests pass."
fleet-read fix-auth 3           # check progress
```

The **inbox carries completion too**: a worker's turn ending shows as `DONE`, so
you learn when a brief is ready to review/merge without polling. A fresh worktree
gets the main checkout's `node_modules` symlinked in (workers can run
lint/typecheck/tests; opt out with `CLAUDE_FLEET_LINK_NM=0`), and `--from` bases a
branch on your **local** ref — falling back to the remote tip only when local is
*behind* — so a worker never misses just-committed, unpushed work.

These are also exposed as **MCP tools** (`fleet_list` / `_send` / `_read` / `_spawn` /
`_worktrees` / `_inbox` / `_answer` / `_pause` / `_resume`) via a dependency-free stdio server
(`mcp/fleet-mcp.mjs`) that `install.sh` registers in each config dir. The installed
**`claude-fleet-orchestrate` skill** teaches a lead the loop above — reuse before spawn, pull the
inbox instead of polling every sibling, unblock with `fleet-answer`, mind the shared budget — so
you can just say *"work on a worktree to fix X"* and it reuses a free one. Each session knows its
fleet via `CLAUDE_FLEET_SOCK`; prompts must be self-contained (siblings don't share your context);
only sessions in the *same* fleet are reachable.

**Budget.** One account funds the whole fleet, so wide fan-out drains it N× faster and everyone
stalls at the ceiling together. A **governor** (a dumb non-Claude loop, auto-started per fleet)
parks the newest workers as usage nears the ceiling and resumes them when the window resets; those
events show up in `fleet-inbox`. Opt out with `CLAUDE_FLEET_GOVERNOR=off`, watch-only with `=dry`.

## How it works

- **One tmux server per project** (`tmux -L cf-<project>`) is the hidden substrate. It keeps each
  Claude session alive in the background and handles attach / detach / resize — the battle-tested
  part. You never interact with tmux directly.
- **`claude-fleet`** is a tiny loop: it runs the grid, and when you pick a card it hands off to
  `tmux attach`. Detach (see keys below) and the loop redraws the grid. Node never owns PTYs.
- **`fleet-grid.mjs`** is a flicker-free Node TUI (zero npm deps). Each card joins three sources:
  the tmux session list, the per-session status file that the Claude hooks write to
  `~/.claude/fleet/`, and the last assistant line from the transcript in `~/.claude/projects/`.
- **`claude-here`** is what each session runs, so sessions resume by checkout.

Status per card: `● NEEDS YOU` (permission/question) · `◆ working` · `✓ ready` · `· idle`.
When a session needs you or finishes, you also get a named macOS notification (checkout · branch).

Notifications post via **`osascript`** by default — reliable on modern macOS since it goes through a
system app that's already authorized to post.

**Optional click-to-jump.** Set `CLAUDE_FLEET_NOTIFIER=terminal-notifier` to use
[terminal-notifier](https://github.com/julienXX/terminal-notifier) instead, which makes notifications
**clickable**: a click runs `fleet-jump` → focuses your fleet window ([AeroSpace](https://github.com/nikitabobko/AeroSpace),
matched by window title) and lands you on **master**, so you coordinate through the lead. Caveat:
macOS must *authorize* terminal-notifier (System Settings → Notifications), and its Homebrew build
often ships with a broken signature — re-sign it once:
`codesign --force --deep -s - "$(brew --prefix)"/Cellar/terminal-notifier/*/terminal-notifier.app`.
If a window is ever mis-matched, pin it in `~/.config/claude-fleet/windows`
(`<zellij-session> <aerospace-window-id>` per line).

## Keys

`` ` `` (backtick) is the universal **back** everywhere — it detaches you from a session and steps
back out of the grid / master / projects, mirroring the in-session detach. `q` does the same on the
Node screens.

**Projects:** `↑↓←→` / `hjkl` move · `⏎` open (straight into that project's **Master Claude**) ·
`s` schedule a message to that project's **master** (great for "continue at 3am when the limit
resets" — the card then shows `@3:50a`) · `x` remove a project from the list (its sessions + history
are left untouched — re-add it any time) · `q` / `` ` `` quit.

**In master:** `C-a s` jumps to the **session grid**; `` ` `` (or `C-a g`) jumps back to **Projects**
(master is the per-project hub — leaving it means you're done with that project for now). Leaving
the grid or a worker returns to master.

**In the grid:** `↑↓←→` / `hjkl` move · `⏎` enter the selected session · `n` new session ·
`N` new *parallel* session (fresh conversation) · `s` schedule a message · `x` kill session ·
`q` / `` ` `` step back to master. (The `master` session is its own hub — reach it with `C-a s`, so
it doesn't show here.)

**Schedule a message** (`s` on a grid card — or on a **project** card, which targets that project's
`master`): type a time and it sends a message into that session then — great for resuming when your
usage limit resets. Examples: `3:50am`, `15:30`, `+2h`. Message defaults
to `continue`; customize with `<time> | <message>`. A scheduled card shows `@3:50a`. Under the hood a
detached waiter runs `tmux send-keys` at that time, keeping the Mac awake with `caffeinate`.
*Caveat:* fires only if the machine is awake then — for a closed-lid guarantee also run
`sudo pmset schedule wake "MM/dd/yy HH:mm:ss"`.

**Inside a session:** everything goes to Claude as normal. To pop back a level, detach:
`Ctrl-a` then `g` (mnemonic: **g**rid) — or `Ctrl-a d`. From **master**, `Ctrl-a s` opens the
session grid instead. The session keeps running.
(`Ctrl-a` is the tmux prefix; press it twice to send a literal `Ctrl-a` to Claude.)

## Install

Requires `node` (v18+), `jq`, `tmux`, and macOS (notifications use `osascript`).

```bash
brew install tmux jq
git clone https://github.com/PabloG55/claude-fleet.git
cd claude-fleet
./install.sh
```

The installer symlinks the commands (`claude-fleet`, `claude-here`, and the `fleet-*` helpers —
`list` / `send` / `read` / `spawn` / `worktrees` / `inbox` / `answer` / `pause` / `resume` /
`schedule` / `jump` / `governor` / `statusbar`) into `~/.local/bin`; wires the status + notification
hooks into every Claude config dir it finds (`~/.claude`, `~/.claude-*`, backing each up);
**registers the fleet MCP server** into each config dir's `.claude.json` via `claude mcp add -s user`
(Claude Code reads MCP from `.claude.json`/`.mcp.json`, *not* `settings.json`); installs the
`claude-fleet-orchestrate` skill; and links the zellij layout. Optional but recommended for
clickable notifications: `brew install terminal-notifier` (+ AeroSpace).

## Use it

**One** zellij session runs everything:

```bash
zellij --layout fleet attach -c fleet    # or just run `claude-fleet` in any pane
```

You land on the **Projects** picker. `⏎` on a project drops you into its **Master Claude**; from
there `Ctrl-a s` opens the session grid. In the grid, `n` starts a session in a checkout, `N` a
fresh parallel one, `⏎` enters it, `` ` `` comes back, `q` steps up a level.

**Projects** live in `~/.config/claude-fleet/projects` (`name<TAB>path<TAB>profile`). Add your first
from the picker (`+ add project` → browse to a root folder that holds your checkouts/worktrees), or
edit the file directly. Jump straight in with `claude-fleet <project>`.

## Profiles (work vs personal accounts)

Claude Code keeps each account in its own config dir (`CLAUDE_CONFIG_DIR`) — that dir holds
the login, `settings.json`, `projects/` (transcripts) and the fleet's `fleet/` status. A project's
`profile` (3rd column in the projects file; default `work` = `~/.claude`, `personal` =
`~/.claude-personal`) picks its account, so work and personal never mix:

```
# ~/.config/claude-fleet/projects   (name <TAB> path <TAB> profile)
web	~/code/web	work
api	~/code/api	work
sideproj	~/projects/sideproj	personal
```

Each project's sessions live on their own socket (`cf-<project>`) under that account's config dir,
so accounts never mix. `install.sh` wires the status/notification hooks into every config dir it
finds (`~/.claude` and `~/.claude-*`), so both accounts report status.

## Config

`claude-fleet` sets these per project; each spawned session inherits them (used by the grid, hooks,
and `fleet-*` tools):

| Env var               | Meaning                                                          |
| --------------------- | --------------------------------------------------------------- |
| `CLAUDE_FLEET_SCOPE`  | The project name (shown in the header; scopes checkout discovery).|
| `CLAUDE_FLEET_ROOT`   | The project's root folder (where its checkouts/worktrees live).  |
| `CLAUDE_FLEET_SOCK`   | The project's tmux socket, `cf-<project>`.                       |
| `CLAUDE_CONFIG_DIR`   | The account/config dir for the project's `profile`.              |
| `CLAUDE_FLEET_DIR`    | Per-session status files (`$CLAUDE_CONFIG_DIR/fleet`).           |
| `CLAUDE_FLEET_YOLO`   | `0` to require permission prompts in sessions (default: bypass). |

`claude-fleet <project> --plain` prints a one-shot, non-interactive table for that project (scripts).

## Extras

- `scripts/enable-zellij-resume.sh` — optional: make hand-started `claude` panes resurrect as
  `claude --continue` on zellij re-attach.

## Uninstall

In each config dir (`~/.claude`, `~/.claude-*`): remove the fleet `hooks` blocks and the
`claude-fleet` entry under `mcpServers` from `settings.json` (or restore a `settings.json.bak.*`),
and delete `skills/claude-fleet-orchestrate`. Then delete the symlinks in `~/.local/bin`, and
`tmux -L cf-<project> kill-server` for any live fleets.

## License

MIT © 2026 Pablo Garces
