# claude-fleet

A zellij-native master CLI for running many **Claude Code** sessions in parallel.

One zellij session per project → **one tab, one pane** → that pane is a **card grid of
every Claude session in that project**. Arrow to a card, hit Enter, and you're *inside* that
session full-screen; detach and you're back at the grid. Every session keeps running in the
background the whole time, so your agents work in parallel while you jump between them.

```
zellij session "acme"  →  one pane:
╭─ claude-fleet [acme] ──────  2 need you · 1 working ─╮
│ ╭ acme ─────────────╮ ╭ acme-1 ───────────────╮ │
│ │ ● NEEDS YOU    1m ago  │ │ ● NEEDS YOU        7m ago  │ │
│ │ fix/proposal-template  │ │ chore/api-vercel-migrate   │ │
│ │ "Want me to drill…"    │ │ "Save as → Quote then…"    │ │
│ ╰────────────────────────╯ ╰────────────────────────────╯ │
│ ╭ acme-2 ───────────╮ ╭ + new session ─────────────╮ │
│ │ ◆ working     busy 4m  │ │ start a Claude session     │ │
│ │ feat/email-signature   │ │ in a checkout…             │ │
│ ╰────────────────────────╯ ╰────────────────────────────╯ │
╰ ↑↓←→/hjkl move · ⏎ enter session · n new · q quit ────────╯
```

Nothing else is zellij-native like this — every other terminal fleet tool (nicknisi/fleet,
tmux-claude-session-manager, Recon) is tmux-bound; the rest take over your multiplexer
(Claude Squad, ccmanager) or are web/cloud dashboards (Omnara).

## Orchestrate: a lead session driving workers

Because every session lives on the same tmux socket, a "lead" session can dispatch work to
siblings and read their output — turning a fleet into lead-and-workers (e.g. `widgetco` handing
briefs to `widgetco-1` / `widgetco-2` worktrees). Three commands, callable from a session's Bash:

- **`fleet-list`** — sibling sessions + status (`(you)` marks the caller).
- **`fleet-send <session> "<prompt>"`** — type a prompt into that session's Claude and submit it
  (multi-line safe via bracketed paste; warns if the target is mid-turn).
- **`fleet-read <session> [n]`** — print the sibling's last `n` assistant messages.
- **`fleet-spawn <name> [--branch b] [--prompt "…"]`** — create a git **worktree** off the current
  repo and start a fresh worker session in it (background), optionally briefed in one shot.

```bash
fleet-list
fleet-send widgetco-1 "Implement the policy PDF engine in lib/policy/generation/*. Done when tests pass."
fleet-spawn a4 --branch feat/notifications --prompt "Build the email notification jobs. Done when …"
fleet-read widgetco-1 3     # check progress
```

These are also exposed as **MCP tools** (`fleet_list` / `fleet_send` / `fleet_read` / `fleet_spawn`)
via a dependency-free stdio server (`mcp/fleet-mcp.mjs`) that `install.sh` registers in each config
dir — so a lead session can call them as structured tool-calls, not just Bash. The installed
**`claude-fleet-orchestrate` skill** tells a lead these exist, so you can just say "spin up a worker
for X and brief it." Each session knows its fleet via `CLAUDE_FLEET_SOCK`; prompts must be
self-contained (siblings don't share your context); only sessions in the *same* fleet are reachable.

## How it works

- **One tmux server per zellij session** (`tmux -L cf-<zellij-session>`) is the hidden
  substrate. It keeps each Claude session alive in the background and handles attach / detach /
  resize — the battle-tested part. You never interact with tmux directly.
- **`claude-fleet`** is a tiny loop: it runs the grid, and when you pick a card it hands off to
  `tmux attach`. Detach (see keys below) and the loop redraws the grid. Node never owns PTYs.
- **`fleet-grid.mjs`** is a flicker-free Node TUI (zero npm deps). Each card joins three sources:
  the tmux session list, the per-session status file that the Claude hooks write to
  `~/.claude/fleet/`, and the last assistant line from the transcript in `~/.claude/projects/`.
- **`claude-here`** is what each session runs, so sessions resume by checkout.

Status per card: `● NEEDS YOU` (permission/question) · `◆ working` · `✓ ready` · `· idle`.
When a session needs you or finishes, you also get a named macOS notification (checkout · branch).

**Click-to-jump.** With `terminal-notifier` + [AeroSpace](https://github.com/nikitabobko/AeroSpace) installed,
clicking a notification runs `fleet-jump`, which focuses the terminal window running that session's
zellij session (matched by window title) and lands the fleet pane on the exact session — via
`tmux switch-client` if a session is attached, or a jump-request the grid auto-attaches if it's at the
grid. If the title heuristic ever misses a window, pin it in `~/.config/claude-fleet/windows`
(`<zellij-session> <aerospace-window-id>` per line). Without terminal-notifier it falls back to a plain
(non-clickable) `osascript` notification.

## Keys

**In the grid:** `↑↓←→` / `hjkl` move · `⏎` enter the selected session · `n` new session ·
`s` schedule a message · `x` kill session · `q` quit to the shell.

**Schedule a message** (`s` on a card): type a time and it sends a message into that session then —
great for resuming when your usage limit resets. Examples: `3:50am`, `15:30`, `+2h`. Message defaults
to `continue`; customize with `<time> | <message>`. A scheduled card shows `@3:50a`. Under the hood a
detached waiter runs `tmux send-keys` at that time, keeping the Mac awake with `caffeinate`.
*Caveat:* fires only if the machine is awake then — for a closed-lid guarantee also run
`sudo pmset schedule wake "MM/dd/yy HH:mm:ss"`.

**Inside a session:** everything goes to Claude as normal. To pop back to the grid, detach:
`Ctrl-a` then `g` (mnemonic: **g**rid) — or `Ctrl-a d`. The session keeps running.
(`Ctrl-a` is the tmux prefix; press it twice to send a literal `Ctrl-a` to Claude.)

## Install

Requires `node` (v18+), `jq`, `tmux`, and macOS (notifications use `osascript`).

```bash
brew install tmux jq
git clone https://github.com/PabloG55/claude-fleet.git
cd claude-fleet
./install.sh
```

The installer symlinks `claude-fleet` / `claude-here` into `~/.local/bin`, wires the status +
notification hooks into `~/.claude/settings.json` (backing up the old file), and links the
zellij layout.

## Use it

One zellij session per project — the session name scopes the fleet and its tmux server:

```bash
zellij --layout fleet attach -c acme     # one pane, running the grid
zellij --layout fleet attach -c widgetco     # a separate fleet, separate tmux server
```

Then press `n` to start a session in a checkout (auto-discovered under `~/<session-name>/*`),
work in it, detach back to the grid, start another. The two projects never see each other's
sessions.

Prefer no layout? Just run `claude-fleet` in any zellij pane.

## Profiles (work vs personal accounts)

Claude Code keeps each account in its own config dir (`CLAUDE_CONFIG_DIR`) — that dir holds
the login, `settings.json`, `projects/` (transcripts) and the fleet's `fleet/` status. A fleet
is pinned to one profile, so work and personal never mix:

```bash
claude-fleet            # work profile   -> ~/.claude
claude-fleet personal   # personal       -> ~/.claude-personal
claude-fleet <name>     # any profile    -> ~/.claude-<name>
```

Each profile gets its own tmux socket (`cf-<profile>-<session>`), its own grid, reads its own
`projects/`, and launches sessions with that `CLAUDE_CONFIG_DIR`. The header shows which one
you're in: `claude-fleet [personal:widgetco]`. `install.sh` wires the status/notification hooks
into every config dir it finds (`~/.claude` and `~/.claude-*`), so both accounts report status.

Tip — mirror your shell aliases:

```bash
alias fleet='claude-fleet'            # work
alias fleet-personal='claude-fleet personal'
```

## Config

| Env var               | Default                     | Meaning                                          |
| --------------------- | --------------------------- | ------------------------------------------------ |
| `CLAUDE_CONFIG_DIR`   | `~/.claude`                 | The profile/account dir (set by the profile arg).|
| `CLAUDE_FLEET_PROFILE`| `work`                      | Profile name shown in the header.                |
| `CLAUDE_FLEET_DIR`    | `$CLAUDE_CONFIG_DIR/fleet`  | Where per-session status files live.             |
| `CLAUDE_FLEET_SCOPE`  | `$ZELLIJ_SESSION_NAME`      | Fleet scope / tmux socket + checkout root.        |
| `CLAUDE_FLEET_YOLO`   | `1`                         | `0` to require permission prompts in sessions.    |

`claude-fleet --plain` prints a one-shot, non-interactive table (handy for scripts).

## Extras

- `scripts/enable-zellij-resume.sh` — optional: make hand-started `claude` panes resurrect as
  `claude --continue` on zellij re-attach.
- `layouts/acme.kdl` — the v1 tab-per-checkout layout (each tab runs `claude-here`), kept as
  an alternative to the single-pane grid.

## Uninstall

Remove the hook blocks from `~/.claude/settings.json` (or restore a `settings.json.bak.*`),
delete the symlinks in `~/.local/bin`, and `tmux -L cf-<name> kill-server` for any live fleets.

## License

MIT © 2026 Pablo Garces
