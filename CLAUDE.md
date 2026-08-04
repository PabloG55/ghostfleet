# Working in this repo

## Commits

- **Never push to `main` directly — every change lands through a PR.** Branch, commit
  there, open the PR; let review happen even when the change looks obvious.
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

Run `./test/run.sh` before pushing — no deps, a couple of seconds. It covers the
things that have actually broken (wire-format parsing, the projects-file columns,
session naming, and every agent's pane detectors against real captured panes), and
its assertions run in BOTH directions on purpose: a busy regex is only proven by
matching a real busy pane AND staying silent on a real idle one. A test that can
only pass proves nothing — when you add one, break the code deliberately and watch
it go red before you trust it.

It can't cover the interactive parts, so also verify against the live fleet, and
prefer proof over assertion:

- `fleet-grid.mjs --plain` exercises the real status path without drawing the TUI
- **never** launch the interactive grid headlessly — it blocks on the tty and hangs
- destructive commands (`fleet-clean`, `fleet-adopt`) are dry-run by default; test that
  path first, on a real project
- when a signal is claimed to be reliable, check it in both directions — a detector that
  never fires looks identical to one that works

## Things that have bitten, repeatedly

- **`IFS=$'\t'` collapses empty fields** (tab is IFS-whitespace), shifting every later
  field left. Use `$'\x1f'` for any record with optional fields.
- **The leftover lands on the last variable, and it looks like data.** `read -r n p prof`
  against a four-column line puts the 4th field *inside* `prof` — and anything derived
  from it (the fleet socket) is wrong too. Its expansion cousin: `${x#*$SEP}` on a string
  with **no** separator returns the string *unchanged*, so a short record sets the field
  to the whole cwd — non-empty, so every `[ -n "$x" ]` fallback sails past it. Name every
  column the format has, and test for the *separator*, not for emptiness.
- **A test can pass because of where it ran.** A codex ready-pattern of `· /` matched its
  capture only because that worktree sat in `/private/tmp`; codex abbreviates `$HOME`, so
  it matched nowhere real. Same day, a config key written from `$PWD` instead of `pwd -P`
  was never found, because `/tmp` is a symlink to `/private/tmp`. If a fixture came from a
  temp dir, ask what it would look like under `$HOME`.
- **Re-sourcing a tmux config adds bindings but never removes deleted ones.** A running
  fleet keeps a binding you deleted from the file until its server dies, so a removed
  no-prefix binding goes on swallowing that key. Leave an explicit `unbind -n`.
- **`node --check` proves syntax, not that it runs.** A missing `let` is a ReferenceError
  that only fires on the keystroke that reaches it — and it kills the whole grid pane.
  Drive the real TUI in a scratch tmux pane and send it keys.
- **A session's status must be scoped by its fleet socket.** Every project has a session
  called `master`, so matching on name alone reports another project's state.
- **The pane is the truth for "is it working".** Transcript mtime says idle mid-generation
  and busy when a background write lands.
- **A detector measured at full width can go blind in a narrow one.** Claude *composes*
  its spinner line to fit the pane and drops the elapsed-time counter first, so at 56
  columns `✻ Flowing… (almost done thinking with xhigh effort)` carries no `(NNs`, no
  `↓ N tokens` and no `esc to interrupt` — the old regex read a thinking agent as idle
  for a full minute. And there is no threshold to code around: the phase text grows
  through a turn, so the same pane at the same width stops matching partway in. Measure
  a new pattern across widths, not just at yours.
- **`tmux attach </dev/tty` refuses to attach.** `ttyname()` of that fd is the literal
  string `/dev/tty`, not the device, and tmux errors `can't use /dev/tty`. Everything
  before the attach still works, so a screen builds all its panes and then silently
  fails to show them. The node screens all take `</dev/tty`; anything that *attaches*
  must not (see `TM attach` in grid_loop, and `fix_stdin_tty` in fleet-stack).
- **Every push channel is scoped to ONE fleet socket, and silence is the symptom.** A
  worker's Stop reaches `master` on *its own* socket and nobody else, and it skips masters
  entirely — so a question sent to another project got worked on and answered into thin
  air. From the asking side that is indistinguishable from being ignored: no error, no
  row, nothing to grep. When you add a cross-fleet path, carry the asker's socket AND its
  fleet dir (another profile is another directory), and assert the delivery lands in the
  *asker's* dir, not yours.
- **A prompt sent to a busy session Stops the WRONG turn first.** `fleet-send` pastes into
  the input box; if a turn is already running the prompt queues behind it, so the next
  `Stop` belongs to work you never asked for. Anything that waits for "the answer to my
  prompt" has to be armed by the `UserPromptSubmit` that actually starts a turn — the
  version that just took the next Stop answered with a stranger's work and consumed the
  request, which then looked like the relay had never fired at all.
- **macOS-only calls need a guard**: `stat -f`, `date -r`, `osascript`, `caffeinate`. Linux
  and WSL are supported.
