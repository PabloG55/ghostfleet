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

## Keys

**In the grid:** `↑↓←→` / `hjkl` move · `⏎` enter the selected session · `n` new session ·
`q` quit to the shell.

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

## Config

| Env var             | Default            | Meaning                                            |
| ------------------- | ------------------ | -------------------------------------------------- |
| `CLAUDE_FLEET_DIR`  | `~/.claude/fleet`  | Where per-session status files live.               |
| `CLAUDE_FLEET_SCOPE`| `$ZELLIJ_SESSION_NAME` | Override the fleet scope / tmux socket name.   |

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
