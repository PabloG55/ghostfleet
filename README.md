# claude-fleet

A zellij-native master CLI for running many **Claude Code** sessions in parallel.

If you keep several `claude` sessions open across zellij tabs and different
checkouts, you know the two pain points:

1. **You miss when one finishes or needs input** — every desktop notification
   looks identical, so you can't tell *which* session it came from.
2. **There's no single overview**, and re-attaching a zellij session restarts a
   **blank** `claude` instead of resuming the conversation that was there.

`claude-fleet` fixes both, without changing how you use zellij.

Every other terminal "fleet" tool (nicknisi/fleet, tmux-claude-session-manager,
Recon) is tmux-bound; the rest either take over your multiplexer (Claude Squad,
ccmanager) or are web/cloud dashboards (Omnara). This one is built for zellij and
leans entirely on what Claude Code already writes to `~/.claude/`.

---

## What you get

**1. Identity-rich notifications.** When a session finishes or asks for input,
you get a macOS notification that names the checkout + branch (+ zellij tab), with
a different sound for "done" vs "needs you":

```
✅ Claude — done         claude 3 — acmev2 · fix/proposal-template-builder
🔔 Claude — needs you    claude 2 — acme-1 · chore/trellis-access
```

**2. `claude-fleet` — a one-screen overview** of every live session, sorted so the
ones waiting on you float to the top:

```
 2 need you · 1 working · 1 ready · 0 idle
 TAB       CHECKOUT      BRANCH                   STATUS     LAST MSG                                     IDLE
 claude 2  acme-1    chore/trellis-access     NEEDS YOU  Want me to drill into one spec's assertions busy 3m
 claude    acmev2    bor-workflow-redesign    working    Verifying the slot state and confirming…    busy 1m
 claude 3  acmev2    fix/proposal-…-polish    ready      Churned for 14m 47s                          2m ago
```

Run `claude-fleet` for a snapshot, or `claude-fleet --watch` for a live view.

**3. Resume after exit.** Launch your fleet from a zellij layout that runs
`claude-here` in each tab. Kill the whole zellij session and rebuild it with one
command — every tab comes back **resumed** in the right checkout, not blank.

---

## How it works

Claude Code fires [hook events](https://code.claude.com/docs/en/hooks-guide) and
writes a full JSONL transcript per session to
`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. claude-fleet is three small
bash pieces on top of that:

- **`hooks/fleet-event.sh`** — wired to `UserPromptSubmit`, `Stop`, `Notification`,
  `SessionStart`, `SessionEnd`. On each event it writes
  `~/.claude/fleet/<session_id>.json` (`{zellij, slot, cwd, folder, branch,
  status, transcript, ts}`) and, on Stop/Notification, posts the named
  notification. It exits `0` no matter what, so it can never break a session.
- **`bin/claude-fleet`** — reads those status files, pulls the last assistant line
  from each transcript, prunes dead sessions, and prints the table.
- **`bin/claude-here`** — resume wrapper used as the pane command in a zellij
  layout. It finds the session that belongs to this `(zellij session, tab slot)`
  and `exec claude --resume <id>`; falls back to `claude --continue` for the cwd,
  or a fresh `claude` if there's nothing to resume.

Status values: `working` (turn in progress) · `need-you` (permission / question)
· `ready` (finished responding) · `idle` (just started).

---

## Install

Requires `jq` and macOS (notifications use `osascript`). zellij is optional but is
where the resume feature shines.

```bash
git clone https://github.com/PabloG55/claude-fleet.git
cd claude-fleet
./install.sh
```

The installer symlinks `claude-fleet` / `claude-here` into `~/.local/bin`, merges
the hooks into `~/.claude/settings.json` (backing up the old file first), and — if
you use zellij — links the example layout to `~/.config/zellij/layouts/`.

Restart your Claude Code sessions so the new hooks load, then run `claude-fleet`.

---

## Resume workflow

1. Edit `layouts/acme.kdl` — one tab per checkout, with the right `cwd` and a
   stable `slot` arg (`claude`, `claude 2`, …).
2. Start the fleet:
   ```bash
   zellij --layout acme attach -c acmev2
   ```
3. Work as usual. When you're done for the day, `zellij kill-session acmev2`.
4. Come back and run the same launch command — every tab resumes its conversation.

### Auto-resume hand-started panes (optional)

The layout covers tabs you launch from it. For panes you open by hand (new tab,
type `claude`), enable zellij's own serialization + a command-rewrite so those
resurrect as `claude --continue` too:

```bash
./scripts/enable-zellij-resume.sh
```

It's idempotent, backs up `~/.config/zellij/config.kdl`, validates with
`zellij setup --check`, and appends:

```kdl
// ~/.config/zellij/config.kdl
session_serialization true
post_command_discovery_hook "echo $RESURRECT_COMMAND | sed 's/^claude$/claude --continue/'"
```

Only a bare `claude` is rewritten — `nvim`, shells, `claude --resume …`, and the
`claude-here` wrapper are left untouched. Restart zellij for it to take effect.

---

## Config

| Env var            | Default            | Meaning                                   |
| ------------------ | ------------------ | ----------------------------------------- |
| `FLEET_PRUNE_SECS` | `43200` (12h)      | Drop status files older than this.        |
| `CLAUDE_FLEET_DIR` | `~/.claude/fleet`  | Where status files live.                  |
| `CLAUDE_FLEET_BIN` | `~/.local/bin`     | Install target for the two commands.       |

## Uninstall

Remove the five hook blocks from `~/.claude/settings.json` (or restore a
`settings.json.bak.*`), and delete the symlinks in `~/.local/bin`.

## License

MIT © 2026 Pablo Garces
