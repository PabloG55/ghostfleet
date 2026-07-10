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

Because every session lives on the same tmux socket, a "lead" session can dispatch work to
siblings and read their output — turning a fleet into lead-and-workers (e.g. an `api` lead handing
briefs to `api-1` / `api-2` worktrees). Three commands, callable from a session's Bash:

- **`fleet-list`** — sibling sessions + status (`(you)` marks the caller).
- **`fleet-send <session> "<prompt>"`** — type a prompt into that session's Claude and submit it
  (multi-line safe via bracketed paste; warns if the target is mid-turn).
- **`fleet-read <session> [n]`** — print the sibling's last `n` assistant messages.
- **`fleet-spawn <name> [--branch b] [--prompt "…"]`** — create a git **worktree** off the current
  repo and start a fresh worker session in it (background), optionally briefed in one shot.

```bash
fleet-list
fleet-send api-1 "Implement the payments module in src/payments/*. Done when the tests pass."
fleet-spawn worker4 --branch feat/notifications --prompt "Build the notification jobs. Done when …"
fleet-read api-1 3     # check progress
```

These are also exposed as **MCP tools** (`fleet_list` / `fleet_send` / `fleet_read` / `fleet_spawn`)
via a dependency-free stdio server (`mcp/fleet-mcp.mjs`) that `install.sh` registers in each config
dir — so a lead session can call them as structured tool-calls, not just Bash. The installed
**`claude-fleet-orchestrate` skill** tells a lead these exist, so you can just say "spin up a worker
for X and brief it." Each session knows its fleet via `CLAUDE_FLEET_SOCK`; prompts must be
self-contained (siblings don't share your context); only sessions in the *same* fleet are reachable.

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
`x` remove a project from the list (its sessions + history are left untouched — re-add it any time) ·
`q` / `` ` `` quit.

**In master:** `C-a s` jumps to the **session grid**; `` ` `` (or `C-a g`) jumps back to **Projects**
(master is the per-project hub — leaving it means you're done with that project for now). Leaving
the grid or a worker returns to master.

**In the grid:** `↑↓←→` / `hjkl` move · `⏎` enter the selected session · `n` new session ·
`N` new *parallel* session (fresh conversation) · `s` schedule a message · `x` kill session ·
`q` / `` ` `` step back to master. (The `master` session is its own hub — reach it with `C-a s`, so
it doesn't show here.)

**Schedule a message** (`s` on a card): type a time and it sends a message into that session then —
great for resuming when your usage limit resets. Examples: `3:50am`, `15:30`, `+2h`. Message defaults
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

The installer symlinks the commands (`claude-fleet`, `claude-here`, `fleet-send` / `-list` / `-read`
/ `-spawn` / `-schedule` / `-jump`) into `~/.local/bin`; wires the status + notification hooks and the
fleet MCP server into every Claude config dir it finds (`~/.claude`, `~/.claude-*`, backing each up);
installs the `claude-fleet-orchestrate` skill; and links the zellij layout. Optional but recommended
for clickable notifications: `brew install terminal-notifier` (+ AeroSpace).

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
