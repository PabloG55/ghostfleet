# Working in this repo

## Commits

- **Branch off `staging`, and open the PR against `staging`.** `staging` is the default
  branch and where all work integrates; `main` is the publishable branch and moves only
  on a release. `git fetch origin && git checkout -B <branch> origin/staging` — a branch
  cut from `main` is cut from the last release, not from what everyone else has landed,
  and it will conflict on the way back in.
- **Never push to `staging` or `main` directly — every change lands through a PR.** Both
  are protected: a PR is required, and both suite legs (`ubuntu-latest`, `macos-latest`)
  must be green. Let review happen even when the change looks obvious.
  - The protection is *not* `strict`, so a PR does not have to be rebased onto the tip
    of `staging` to merge. That is deliberate — it is what lets a fleet of workers land
    in parallel instead of queueing behind each other — and the cost is that two PRs can
    each be green against an older `staging` and break it together. The push-triggered
    run on `staging` is what catches that, so **a red `staging` is everyone's, not the
    last merger's alone.**
  - Admin bypass is on. It exists for a runner outage, not for a hurry.
- **Never add a `Co-Authored-By:` trailer**, and don't add any other AI attribution
  (no "generated with", no tool footer). Commits are authored by the repo owner, full
  stop.
- Write the *why*, not the *what* — the diff already shows what changed. The useful
  message explains the failure mode being fixed: what the wrong behaviour was, why it
  happened, and why the fix is shaped the way it is. Most of this repo's history is
  reliability fixes where the cause was non-obvious, and that reasoning is the part
  worth keeping.

## Comments and docs

Same doctrine as a commit message, with one extra constraint: **this repo is public.**

- **Cite the failure, never the project.** A comment earns its place by the *shape* of
  the failure, and the shape is what carries forward: "reported twice from one project
  after three re-runs" teaches exactly as much as naming the project, and "it went
  unnoticed twice" is the whole of what "twice" was doing there. Counts, sizes, timings
  and orderings all survive the substitution — they are the measurement. A name is not.
- **A comment that needs a real name to make sense is describing the wrong thing.**
  The name is standing in for a structure that should be spelled out instead: that the
  root held four independent clones, that a derived peer name looked like `name-06`,
  that two products shared a container directory. Write the structure and the comment
  gets *better* — the reader learns the layout rather than a label they cannot see.
- **Use the placeholder vocabulary the demo data already uses** — `acme-api`,
  `acme-web`, `toolbox`, `billing-svc`, `scratch` and the session names beside them in
  `web/fixtures/`. They read as examples rather than as redactions, and a reader can
  match them against a fleet they can actually open. Never `REDACTED`, never `xxx`: a
  comment full of holes is worse than a generic example, because the hole tells you
  something was removed and still teaches nothing.
- **This is checked, not remembered.** `test/run.sh`'s name sweep reads every tracked
  file and refuses a set of names it stores as one-way digests, so the check itself
  publishes nothing. Adding one to the sweep needs no name in the diff either — the
  helper prints the digest to paste. And the docs have a second, stronger guard:
  `test/helpers/doc-fixtures.mjs` asks whether an example name is *in* `web/fixtures/`
  rather than whether it is on a list, which catches the next name and not just the
  last one. Prefer that shape wherever it fits.

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
- an **MCP server** is spawned once per Claude session and lives as long as it, so a
  session started before a `cf-sync` keeps calling the old `fleet-mcp.mjs`. Seen live: a
  worker passed `fleet_stop(reclaim: true)` to a five-day-old server, which accepted the
  argument and silently ignored it. The file on disk was current; the process was not.
  Only a NEW session picks it up
- **tmux bindings** load when the fleet's server is re-sourced (re-entering the project)
- **zellij keybinds** only apply to a NEW zellij session
- an **installed PWA** keeps running the old client, and this one lives on another
  device. The shell is served cache-first (`web/sw.js`), so a phone that already has the
  app paints the `app.js` it cached and only revalidates behind the paint. Bumping that
  file's `VERSION` is necessary and NOT sufficient: the bump puts the new bytes in the
  cache, but only a real navigation parses them, and reopening an installed iOS PWA from
  the app switcher is a resume, not a navigation. Swipe it away and relaunch. Seen live:
  the v4 shell was fetched and fully precached one second *after* the page loaded, so the
  phone went on running the v3 client for the next two minutes with the new bytes already
  sitting in its cache. Nothing on the phone distinguishes the two — read `fleet-serve`'s
  request log, where the chat client polls `/api/session` and the pane-first one that
  preceded it polls `/api/pane`

## Testing

Run `./test/run.sh` before pushing — no deps, a couple of seconds. It covers the
things that have actually broken (wire-format parsing, the projects-file columns,
session naming, and every agent's pane detectors against real captured panes), and
its assertions run in BOTH directions on purpose: a busy regex is only proven by
matching a real busy pane AND staying silent on a real idle one. A test that can
only pass proves nothing — when you add one, break the code deliberately and watch
it go red before you trust it.

Run it whenever you like, including while a sibling worktree is running it: each run
puts its tmux servers under its own `$TMUX_TMPDIR`, so they are reachable from that
run and nowhere else — not from another run, and not from the live fleet. A new test
that needs a server just uses `tmux -L <name>` as the rest do; an absolute `-S` path
would step outside the namespace, and so would unsetting `TMUX_TMPDIR`.

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
- **…but `\x1f` must NEVER be the separator inside a tmux `-F` format.** tmux **≤ 3.5**
  pushes every byte of command output through `vis(3)` — `utf8_strvis()` with
  `VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH`, from `server_client_print()` — so a `\x1f` comes
  back as the four literal characters `\037`, the record never splits, and the WHOLE row
  lands in the first field. The entry above, arriving through tmux's formatter instead of
  through `read`. tmux **3.6** stopped (`cmd-queue.c` passes `parse=1` unconditionally).
  **Ubuntu 24.04's apt tmux is 3.4; Homebrew's is 3.7b**, so it reads as "broken on
  Linux" and is nothing of the kind — tmux 3.4 on a Mac reproduced 122 of the Linux
  leg's 125 failures, group for group. Of every byte below `0x20` plus `0x7f`, **a tab is
  the only one all of 3.4/3.5/3.6/3.7b emit verbatim** (measured on four builds, for
  `list-sessions -F` and `display-message -p` alike), and tmux will not let a tab into a
  session name. So: **tab at the tmux boundary, `\x1f` on our own wires** — the grid's
  choice line, the hooks' jq records, the reply-to file — and `tr '\t' '\037'` where a
  shell has to `read` what tmux printed. Two constants, two comments, and a suite group
  that runs the real code through `test/helpers/tmux-vis35.mjs`, because on 3.7b the two
  separators behave identically and an assertion about this would otherwise pass either
  way. Do NOT "just un-escape it": `VIS_NOSLASH` means a backslash is not doubled, so a
  literal `\037` in the data is indistinguishable from an escaped `0x1f`.
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
- **A session NAME can be tmux target syntax.** Tabs were `+term-<session>` until it turned
  out a leading `+` means "the next session". The half that works is what hides it:
  `has-session -t '=+term-api-2'` says yes and `switch-client` goes there, so the feature
  demos fine — while `display-message -t '+term-api-2'` answers for a *different* session
  and `capture-pane` reads that other pane. Every status reader here targets a bare
  `-t "$name"`, so the fleet reads the wrong pane and says nothing. Prefix with `_`, and
  when you invent a name, check it against a target-resolving command, not `has-session`.
  Don't try to reproduce it by asking WHICH session it answers: that is version-dependent
  (tmux 3.7b answers whatever session is *current*, which is the one just created often
  enough to look correct). The part that holds everywhere is that the answer MOVES when
  some other session becomes current, without the session of that name being touched — a
  `+` name is an expression, not a name, and it is right only by luck.
- **A suite with fixed socket names cannot be run twice at once, and the second run
  lies.** `test/run.sh` used forty-odd fixed names, and nearly every group opens with
  `kill-server`, so two worktrees testing together tore each other's fixtures down
  mid-assertion: 46 phantom failures in one measured case, and a red run that went green
  on a quiet retry with no code change. That is worse than no suite — the rule here is to
  trust a test only after watching it go red, and a phantom red looks exactly like a real
  one. Per-run `$TMUX_TMPDIR` now, plus a startup sweep for the servers a killed run
  leaves behind, since a unique name has nobody to kill it next time.
- **macOS-only calls need a guard**: `stat -f`, `date -r`, `osascript`, `caffeinate`. Linux
  and WSL are supported.
