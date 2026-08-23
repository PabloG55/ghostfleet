# Operations: the special cases

Split out of the README, which had grown to the point where the three reference sections
were 78% of it. This is one of them, unchanged apart from its links — plus two sections
that used to sit among the keybindings and are operational rather than keys: where a
worktree goes, and updating Claude Code under a live fleet.

Everything below is real, but you'll reach for it far less often than what's above — multi-account
setups, migrating an existing scattered workflow, notification tuning, and the mechanics behind a
couple of conveniences.

## Already running Claude by hand? Adopt it

If you already work the scattered way — a Claude session per terminal tab or zellij
pane, spread across a repo and its worktrees — you don't have to start over.
`fleet-adopt` finds those conversations, registers the project, and reopens each one as
a card on that project's fleet, with a single master over them.

```bash
fleet-adopt ~/acme                 # DRY RUN: shows what it would adopt
fleet-adopt ~/acme --go --start    # adopt them + start the master
```

```
fleet-adopt · /Users/you/acme · profile work · fleet cf-acme · DRY RUN
  175944ef   ~/acme/api              Want me to pull that request row + audit…
  0621074a   ~/acme/acme-1           I killed the stale processes and relaunc…
  6fff3551   ~/acme/acme-2           Confirmed — that commit belongs to a sep…
  8 conversation(s) -> cards on cf-acme, one master over them
```

Options: `--days N` how far back to look (default 30), `--per-dir N` conversations per
checkout (default 1 = the newest), `--profile P`, `--start`, `--go`.

It **reopens** conversations — a running process can't be moved between terminals. You
don't have to go closing panes yourself, though: adopt detects which conversations are
open right now (a live Claude carries its conversation id in its own argv) and handles
them rather than silently duplicating:

- **default** — those rows are skipped, naming the pid holding each one
- `--takeover` — quits that Claude for you (the same as typing `/exit`), then adopts it
- `--force` — adopt anyway, accepting two live copies (rarely what you want)

```bash
fleet-adopt ~/acme --go --takeover --start   # adopt everything, closing panes for me
```

To register a project without adopting anything (the CLI form of "+ add project", and
what a lead session uses via the `fleet_project_add` tool):

```bash
fleet-project add ~/code/newapp --start   # register it and boot its master
fleet-project list
```

## Cycling sessions with Shift-arrows

`Shift-→` / `Shift-←` step along the project's ring — **master first, then the workers in the
same order the grid numbers them**, wrapping at both ends:

```
master  ⇄  worker 1  ⇄  worker 2  ⇄  …  ⇄  back to master
```

That's the *card* order, so reordering with `⇧hjkl` in the grid moves the ring with it.

It's instant: both sessions live on the same tmux server, so the client just switches and nothing
redraws — no detach, no grid, the control plane never wakes up. (`Ctrl-f`'s jump chord still has
to go the long way round, because it crosses *projects*, and those are separate tmux servers a
client can't switch between.) Backing out with `` ` `` respects where you actually **ended up**,
not where you started: cycle master → worker and `` ` `` drops you at the grid, not at Projects.

**Shift** rather than Ctrl on purpose: every no-prefix binding is stolen from the app, so the only
question is what you can afford to lose. `Ctrl-←/→` is word-jump in Claude's input and you'd miss
it; `Shift-←/→` does nothing in a Claude session, tmux only spends it in the prefix table, and
zellij's arrow bindings are all `Alt-`. `Ctrl-a ←` / `Ctrl-a →` work too, prefixed.

## Scheduling a message

`s` on a grid card — or on a **project** card, which targets that project's `master`: type a time
and it sends a message into that session then — great for resuming when your usage limit resets.
Examples: `3:50am`, `15:30`, `+2h`. Message defaults to `continue`; customize with
`<time> | <message>`. A scheduled card shows `@3:50a`. Under the hood a detached waiter runs
`tmux send-keys` at that time, holding the machine awake for the wait.

*Caveat:* fires only if the machine is awake then — for a closed-lid guarantee also run
`sudo pmset schedule wake "MM/dd/yy HH:mm:ss"`.

## Staying awake

Running `ghostfleet` holds an *idle sleep off* assertion for as long as the control plane is up
(`caffeinate -i -s` on macOS, `systemd-inhibit` on Linux — see `bin/fleet-awake`). A sleeping box
freezes every worker mid-turn and eats scheduled sends, and leaves nothing behind to say why.

By default the **screen still goes dark** on its own timer (macOS `displaysleep`, 5 min on
battery) while the machine stays fully awake. That is indistinguishable from a slept machine at a
glance, so a working fleet can read as a broken one — check it, don't guess:

```bash
fleet-awake --status
# holding sleep for pid 27809 (bash) — inhibitor pid 27817
# kernel: PreventUserIdleSystemSleep=1 PreventUserIdleDisplaySleep=0
```

Keeping the **screen** on is a separate switch, because idle-sleep and display-sleep are
different assertions — and on battery the display dies at 5 minutes, which is what locks
you out. Persist it once:

```bash
echo display > ~/.config/ghostfleet/awake     # display | on | off
```

### The two platforms do not assert the same thing

The same word in that file buys you different things on each OS, and until this was
written down `on` quietly meant *"system awake, screen may sleep"* on macOS and *"system
awake **and** screen pinned"* on Linux — because `idle`, which is what logind blanks the
screen on, was in the Linux default. It is now in `display`, where it belongs:

| `awake` | macOS (`caffeinate`) | Linux (`systemd-inhibit --what=`) |
|---|---|---|
| `on` | `-i -s` — system stays up, screen blanks on its own timer | `sleep` — same |
| `display` | `-d -i -s` — system up **and** screen pinned | `idle:sleep:handle-lid-switch` — same, **and a closed lid is ignored** |
| `off` | nothing | nothing |

**One asymmetry is left, and it cannot be removed:** on Linux, `display` also inhibits
`handle-lid-switch`, so closing the lid does not suspend. macOS has no equivalent to
switch off — a closed lid always sleeps there, which is the caveat above. If you want the
Linux box to behave like the Mac on a lid close, use `on`.

### When it cannot hold one at all

`systemd-inhibit` being installed is not the same as logind being willing. A box with no
login session — a container, a CI runner, some headless setups — gets
`Failed to inhibit: Access denied` for every `--what`, and because the inhibitor is armed
detached with its stderr discarded, nothing about that used to reach you. `--status` now
asks the question directly and reports the refusal instead of the reassuring default:

```bash
fleet-awake --status
# no inhibitor could be armed: logind refused (Access denied) — this box has no login session
```

`fleet-serve` logs the same line at startup (`awake: …`), so a daemon that cannot keep its
host awake says so in the first thing it writes rather than being discovered by a fleet
that froze overnight. Nothing fails over it: arming is still silent and still exits 0.

The file is read at every launch, so it survives relaunches and terminals that never
sourced your shell rc — `CLAUDE_FLEET_AWAKE=display` works too, but only for the process
you set it on, which is one forgotten relaunch away from locking again. The env var still
wins when set, so `CLAUDE_FLEET_AWAKE=off ghostfleet` is a clean one-off. A
**closed lid still sleeps** either way — the `pmset schedule wake` line above is the only hard
guarantee across one. `CLAUDE_FLEET_AWAKE=off` inhibits nothing.

## The fleet from a phone (`fleet-serve`)

`fleet-serve` puts the fleet on a phone: an HTTP endpoint over **Tailscale**, serving the
grid the TUI already computes and the same verbs a lead session drives. The design, the
threat model and the measurements behind it are in [docs/mobile.md](mobile.md); this
is the setup.

**Read §1 of that document before opening this port.** The endpoint is remote code
execution *by design* — `spawn` runs shell commands, `send` injects prompts into agents
running `--dangerously-skip-permissions` — so it is never publicly routable and every
mutating call is authenticated, confirmed and recorded.

```bash
tailscale ip -4                                    # the address to bind to
fleet-serve init --bind 100.x.y.z --rp-id <name>.ts.net
fleet-serve check                                  # preflight: bind, funnel, config
fleet-serve enroll phone                           # prints a one-time code
fleet-serve                                        # run it
```

Open the printed origin on the phone, type the code, and approve the passkey. The code is
single-use and expires; it returns a bearer token **once** (only its digest is stored).

**The bind address is explicit and it fails closed.** There is no default, and only
loopback and the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) are accepted — a
wildcard, a LAN address or a public one is refused before the socket opens, naming which
it was. Both transports docs/mobile.md sanctions land inside that rule: Tailscale gives
you a `100.64/10` address, and Cloudflare Tunnel's `cloudflared` connects to loopback.

```bash
fleet-serve check-bind 0.0.0.0        # bindable: no — it listens on every interface
fleet-serve check-bind 192.168.1.5    # bindable: no — reachable by that whole network
```

**A passkey at every open, enforced server-side.** The assertion mints a session token
that lives ~15 minutes, and the API rejects any request without a live one — a bearer
token on its own gets a 401, because a lock that only gates the UI is decoration.
`spawn`, `stop`, `rename` and `project_add` need a *second* assertion bound to that exact
action, plus the grid's own `y` confirmation; a forced reclaim needs its own `f` step on
top, and only after a plain reclaim has reported why it declined.

```bash
fleet-serve clients                   # who is enrolled
fleet-serve revoke phone              # one action; a running daemon honours it at once
fleet-serve audit -n 20               # every mutation, oldest prev-hash first
fleet-serve audit --verify            # the chain, so a deleted row is visible
```

Every mutation also lands as a `MOBILE` row in that fleet's `fleet-inbox`, so it shows up
where you already look rather than in a log nobody reads.

**Two things to do yourself.** `fleet-serve` holds a `caffeinate`/`systemd-inhibit`
handle while it runs (see *Staying awake*), but a Mac configured to sleep on AC will still
sleep the moment the last tmux tty goes quiet — run `sudo pmset -c sleep 0` once. And
WebAuthn needs a secure context on a non-loopback origin, so get a certificate for the
MagicDNS name (`tailscale cert <name>.ts.net`) and point `tls` at it in
`~/.config/ghostfleet/serve.json`.

**Never turn on Tailscale Funnel.** That is the one setting that publishes this to the
open internet; `fleet-serve` refuses to start while it is on, and says so when it cannot
check.

## Notifications

Notifications post via **`osascript`** by default — reliable on modern macOS since it goes through a
system app that's already authorized to post. When a session needs you or finishes, you get a
named notification (checkout · branch).

**Optional click-to-jump.** Set `CLAUDE_FLEET_NOTIFIER=terminal-notifier` to use
[terminal-notifier](https://github.com/julienXX/terminal-notifier) instead, which makes notifications
**clickable**: a click runs `fleet-jump` → focuses your fleet window ([AeroSpace](https://github.com/nikitabobko/AeroSpace),
matched by window title) and lands you on **master**, so you coordinate through the lead. Caveat:
macOS must *authorize* terminal-notifier (System Settings → Notifications), and its Homebrew build
often ships with a broken signature — re-sign it once:
`codesign --force --deep -s - "$(brew --prefix)"/Cellar/terminal-notifier/*/terminal-notifier.app`.
If a window is ever mis-matched, pin it in `~/.config/ghostfleet/windows`
(`<zellij-session> <aerospace-window-id>` per line).

Each popup leads with the **`Ctrl-f` chord that lands on that exact session** — e.g.
`Ctrl-f 2 1 · acme-api-1 — …`, or `Ctrl-f 2 ⏎` for a master. It's first in the string
because notifications truncate from the right, and that's the part you act on. Neither
digit is guessable: the project's is its position in *its profile's* list, and the
session's is its position in the grid's **card order**, which `⇧hjkl` can rewrite — so
the chord is read from the same source `Ctrl-f` itself counts through. When it can't be
worked out (an unregistered project, or a position past 9, which the chord can't
express) it's simply absent — a chord that sends you to the wrong session is worse than
none.

## Profiles (work vs personal accounts)

Claude Code keeps each account in its own config dir (`CLAUDE_CONFIG_DIR`) — that dir holds
the login, `settings.json`, `projects/` (transcripts) and the fleet's `fleet/` status. A project's
`profile` (3rd column in the projects file; default `work` = `~/.claude`, `personal` =
`~/.claude-personal`) picks its account, so work and personal never mix:

```
# ~/.config/ghostfleet/projects   (name <TAB> path <TAB> profile <TAB> agent)
web	~/code/web	work
api	~/code/api	work	opencode
sideproj	~/projects/sideproj	personal
```

The 4th column is the project's **default agent** (`claude` · `opencode` · `codex`) —
inherited by its master and by every session created in it, and pre-selected on the
grid's agent screen so you don't re-pick it each time. Omit it for `claude`. Set it
without hand-editing: `fleet-project add <path> --agent opencode`.

Each project's sessions live on their own socket under that account's config dir, so accounts never
mix. Work keeps the bare `cf-<project>`; every other profile is namespaced `cf-<profile>-<project>`,
so the same project name in two profiles can't collide.

<details>
<summary>Two ways to split, and which you want</summary>

The table above is the *mixed* list: one Projects screen showing work and personal side by side.
The other way gives each profile its **own** projects list, so the screen only ever shows one side:

```bash
ghostfleet            # work      -> ~/.config/ghostfleet/projects           + ~/.claude
ghostfleet personal   # personal  -> ~/.config/ghostfleet/projects.personal  + ~/.claude-personal
ghostfleet <anything> # any name works: projects.<name> + ~/.claude-<name>
```

Use the **mixed list** if you want everything on one screen and only the account to differ. Use
**`ghostfleet <profile>`** if you want work and personal genuinely separate — different project
lists, different account, different sockets. The two can coexist; a row's 3rd column always wins,
so a row marked `work` inside `projects.personal` really does run on `~/.claude`.

</details>

<details>
<summary>Setting up the second account</summary>

The config dir holds the login, so a new profile starts logged out. **Log in before installing**,
because `install.sh` only wires hooks and MCP into `~/.claude-*` dirs that already look like config
dirs — an empty one is skipped, and you'd get a profile whose sessions never report status:

```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude    # then /login with the other account
./install.sh                                   # NOW it sees the dir and wires it up
ghostfleet personal                            # empty picker -> "+ add project"
```

Re-run `./install.sh` any time you add a profile; it's idempotent and backs up each `settings.json`.

</details>

<details>
<summary>The one sharp edge</summary>

`ghostfleet <name>` checks the **work** list first and jumps into that project if the name matches.
Anything else is read as a *profile* — so the `ghostfleet <project>` shortcut (and `--plain`) only
ever reaches **work** projects. A personal project's name is not a jump target:

```console
$ ghostfleet sideproj
ghostfleet: no profile "sideproj"
  (looked for /Users/you/.config/ghostfleet/projects.sideproj)

  "sideproj" is a PROJECT in the "personal" profile, not a profile.
  Open it from that profile's screen:  ghostfleet personal

  known profiles:  work personal
  new profile:     ghostfleet sideproj --new
```

(`--new` is how you'd deliberately create a *third* profile — see below.)

An unknown profile is **refused, not created** — a typo and a personal project name used to both
land you at an identical blank picker with a phantom `projects.<typo>` left behind, which told you
nothing about which mistake you'd made. Creating a profile is now the explicit `--new`:

```bash
ghostfleet client --new   # writes ~/.config/ghostfleet/projects.client, then opens it
```

</details>

## Where a worktree goes, and which ones you can reuse

`w` puts a worktree beside the repo — unless the repo says otherwise. A repo that runs
its own worktree doctrine (a `.worktrees/` directory, or one declared in `.gitignore`)
gets its worktrees there instead. `CLAUDE_FLEET_WORKTREE_DIR` overrides either way;
`sibling` forces the classic layout.

This matters when the repo *enforces* its convention. One repo here has a `PreToolUse` guard
that denies any edit whose path lacks `.worktrees/` — it never asks git whether the path
*is* a worktree — so a sibling worktree was refused as "the shared main checkout", the
agent obeyed the refusal, and created a **second worktree nested inside the first**, plus
a full dependency install. Two worktrees per task, with the session attached to the one
that wasn't being edited.

**A project can also be several clones.** `fleet-worktrees` spans every clone under the
project root, not just the one you're standing in. One project here registers a *container*
directory that isn't a repo at all — it holds four independent clones, each owning its own
worktrees. A lead saw 2 and was blind to the other 17, so *reuse before proliferate* could
never fire and every task made another one. `--here` restricts it to the current repo.

**A branch name git already reads as a ref is refused up front.** git resolves a bare
name as `$GIT_DIR/<name>` *before* `refs/heads/<name>`, and the git dir is a shared
drawer — opencode writes `$GIT_DIR/opencode`. So after a worker called `opencode` has
run once, that name is ambiguous, and `git worktree add … -b opencode` dies on
`fatal: invalid reference: opencode` **after** creating the branch: half-succeeded, no
worktree, and a stray branch to clean up by hand. `fleet-spawn` now checks before it
creates anything, names the file, and offers `--branch <other>` or moving the file away.
Only content git can *parse* as a ref counts, so a branch called `config` is still fine
— `[core]` is not a ref. **Don't name a worker after its own agent.**

## Two ways to register a project, and what each one costs

A project's `path` (2nd column of the projects file) is read as **either** the repo
itself **or** a container of checkouts, and three places have to work out which:

| | reads it as | when the path is a repo | when it's a container |
|---|---|---|---|
| `enter_master` (`bin/ghostfleet`) | where master opens | the repo | `<root>/<name>`, else a child repo, else the root |
| `mainRepo()` (`bin/fleet-grid.mjs`) | where `w` runs `fleet-spawn` | the repo | `<root>/<scope>`, else a child repo, else the root |
| `route_to_owner` (`bin/fleet-spawn`) | which fleet a worker joins | matches the repo | matches the repo's **parent** |

They used to *contradict* each other. `route_to_owner` only ever matched the parent, so
pointing the path at the repo — which is what `mainRepo()` wants — meant owner-routing
found nothing and the worker kept whatever socket was ambient. Satisfying one broke the
other. It now tries the parent first (every previous routing decision is unchanged) and
then the repo itself, so both conventions route.

**Point it at the repo** when the project *is* one repo. Every step above is then exact,
and nothing has to guess.

**Point it at the container** when the project is genuinely several clones (one project
here is four) — that's the only path that can name them all, and `fleet-worktrees` needs it to
see every clone's worktrees. Two things to know when you do:

- **Name the main checkout after the project.** `<root>/<name>` is step 2 for
  `enter_master` and `checkoutOf()`; `mainRepo()` uses `CLAUDE_FLEET_SCOPE` for that
  step, which every real caller sets to the project name — but its fallback is derived
  from the *socket*, and a non-work profile's socket carries its profile
  (`cf-personal-galapass` → `personal-galapass`), which is nobody's directory. So a
  hand-run `fleet-grid.mjs cf-personal-galapass --plain` skips step 2.
- **Step 3 is a scan, and a linked worktree is a repo too.** It used to return whatever
  `readdir` yielded first, and on a container root that was a *worktree* — whereupon
  `fleet-spawn`, run there, correctly refused to spawn a worker from inside a worktree,
  and the create failed for a reason nothing on screen explained. The scan now sorts and
  prefers a real checkout (a `.git` **directory**; a worktree's `.git` is a file). Check
  what it picked with `fleet-grid.mjs <socket> --checkouts`, which prints `main repo:`.

## Putting a worker on a specific fleet

`fleet-spawn` picks the fleet in this order, and both directions exist on purpose:

1. **`-s <socket>`** (or `CLAUDE_FLEET_SOCK_FORCE`) — an explicit socket wins, and is
   also *pinned*: `route_to_owner` leaves it alone.
2. **`$TMUX`**, when it names a `cf-*` server — the live tmux server the caller sits in.
3. **`$CLAUDE_FLEET_SOCK`**.

`$TMUX` beats the env var because the env var goes stale: a long-running
`--resume`/`--fork` Claude carries whatever socket its earlier context exported, while
the server it is actually sitting in cannot be out of date.

The explicit override beats `$TMUX` because **`$TMUX` is inherited**, and a program a
fleet session launched is not "in" that fleet in any useful sense. Measured: `vhs`,
started from a fleet session to record `ghostfleet demo`, handed the recorded shell the
*recorder's* socket — so the grid on screen created a worktree and the worker went onto
the recorder's fleet. Nothing errored. The grid drew the new worktree as
`· FREE — no session yet`, because the session was real and simply on a socket that grid
never reads. The grid now passes `-s` for its own `w` creates; `env -u TMUX` still works
and is still worth having in a recording script.

Cross-project spawns from a lead (`fleet_spawn` with `project:`) deliberately *don't*
pass `-s`: they run `fleet-spawn` inside the target's checkout and let `route_to_owner`
find the fleet, which is the mechanism that makes targeting work at all.

## Updating Claude Code under a fleet

Fleet sessions run with `DISABLE_AUTOUPDATER=1`. Claude Code's background-service
supervisor watches its own executable's mtime and self-restarts when it moves — but the
updater is still writing that ~300MB file, so the exec lands on a path that exists, has
a fresh mtime, and isn't executable yet:

```
[supervisor] binary at …/claude.exe changed (mtime changed) — self-restarting for upgrade
[supervisor] upgrade self-respawn failed to spawn: EACCES: permission denied … bg workers may be orphaned
```

The session then drops into the **agents view** carrying `Couldn't restart the
background service`. It self-heals in ~2s, which is why it persists as an annoyance
rather than getting fixed. A fleet makes it routine instead of rare: one update swaps
the binary under *every* live session at once, so they all lose the race together.

So update deliberately, with the fleet idle:

```bash
npm i -g @anthropic-ai/claude-code     # or however you installed it
```

The cost is real: **a long-lived fleet drifts behind the released version until you do.**
`CLAUDE_FLEET_AUTOUPDATE=1` opts back in.

## Extras

- `scripts/enable-zellij-resume.sh` — optional: make hand-started `claude` panes resurrect as
  `claude --continue` on zellij re-attach.
