# Working in this repo

## Commits

- **Never add a `Co-Authored-By:` trailer**, and don't add any other AI attribution
  (no "generated with", no tool footer). Commits are authored by the repo owner, full
  stop.
- Write the *why*, not the *what* — the diff already shows what changed. The useful
  message explains the failure mode being fixed: what the wrong behaviour was, why it
  happened, and why the fix is shaped the way it is. Most of this repo's history is
  reliability fixes where the cause was non-obvious, and that reasoning is the part
  worth keeping.

## Deploying a change

The repo is the source; the **runtime** that actually executes is the staged copy at
`~/.local/libexec/ghostfleet` (staged out of `~/Documents` because macOS TCC blocks
executing from there). Editing a file changes nothing until it's synced:

```bash
cf-sync            # repo -> runtime
./install.sh       # only when adding a NEW command, wiring hooks, or MCP
```

The control plane re-execs itself when its own file changes, so a `cf-sync` normally
takes effect on the next Projects screen. Long-lived processes do NOT:

- a **running grid/Projects screen** keeps the old Node code until you back out and
  re-enter it
- a **governor** is a daemon; `ensure_governor` restarts one whose code changed
- **tmux bindings** load when the fleet's server is re-sourced (re-entering the project)
- **zellij keybinds** only apply to a NEW zellij session

## Testing

There's no test suite; verify against the live fleet instead, and prefer proof over
assertion:

- `fleet-grid.mjs --plain` exercises the real status path without drawing the TUI
- **never** launch the interactive grid headlessly — it blocks on the tty and hangs
- destructive commands (`fleet-clean`, `fleet-adopt`) are dry-run by default; test that
  path first, on a real project
- when a signal is claimed to be reliable, check it in both directions — a detector that
  never fires looks identical to one that works

## Things that have bitten, repeatedly

- **`IFS=$'\t'` collapses empty fields** (tab is IFS-whitespace), shifting every later
  field left. Use `$'\x1f'` for any record with optional fields.
- **A session's status must be scoped by its fleet socket.** Every project has a session
  called `master`, so matching on name alone reports another project's state.
- **The pane is the truth for "is it working".** Transcript mtime says idle mid-generation
  and busy when a background write lands.
- **macOS-only calls need a guard**: `stat -f`, `date -r`, `osascript`, `caffeinate`. Linux
  and WSL are supported.
