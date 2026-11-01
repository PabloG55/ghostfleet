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

**A passkey whenever there is no live session, enforced server-side.** The assertion mints
a session token that dies after 15 minutes *without a request* (`session_ttl`; every
authenticated request slides it), and the API rejects any request without a live one — a
bearer token on its own gets a 401, because a lock that only gates the UI is decoration.
Live sessions are kept as hashes in `serve-sessions.json` (0600, beside `serve.json`), so
restarting the daemon logs nobody out; `fleet-serve revoke <id>` deletes them there and
refuses them on the running daemon at once.
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

### Pushing to the phone

The phone can be **notified** rather than polled, for two events only: a session that needs
you, and a session that has an answer. It is a bell, not a feed — one notification per
burst, and nothing at all while you are looking at the phone, because a push a backgrounded
service worker declines to show can cost the subscription on iOS.

Turn it on in the phone's **settings** sheet and approve the browser prompt — that is the
whole setup. There is no key to generate: the VAPID keypair is written to `serve.json` by
the first subscription.

```bash
fleet-serve push                       # detail, keypair, debounce, quiet window, who is subscribed
fleet-serve push --detail anonymous    # counts only, no names on a lock screen
fleet-serve push --test                # send one to every subscriber, through the real path
```

Two requirements that are easy to miss and produce silence rather than an error: the origin
needs a **real certificate** (Web Push will not subscribe to a self-signed one at all), and
on iOS the app has to be **installed to the home screen** first. `--test` is the fastest way
to tell those apart — it encrypts and posts the same payload the watcher does, and prints
the HTTP status per subscriber rather than a guess.

`--detail anonymous` is worth a thought rather than a default. The payload carries a state
and a name and never transcript text, but a project name is a client name and a lock screen
is readable by whoever is holding the phone; anonymous reduces it to a count.

### Photos from the phone, and who deletes them

The camera in the composer uploads the **original** bytes and this machine converts them —
`sips` on macOS, else `heif-convert`, else `magick`. On a machine with none of the three a
JPEG or a PNG is stored as it is; a **HEIC is refused**, naming all three, because an
iPhone's default format is not something an agent can read.

Bytes land under the fleet dir, keyed the way every other per-session file is:

```
$CLAUDE_FLEET_DIR/attach/<sock>.<session>/<random>.jpg
```

Deliberately **not** in the worktree: an untracked file there reads as *dirty* to
`fleet-clean`, `fleet-worktrees` and `fleet-spawn` alike, so one photo would permanently
remove a worktree from both the reuse pool and the cleanup sweep.

**Two bounds, and they do different jobs.** A single photo over **6 MB** is refused with a
message that says 6 MB (the request body cap is 9 MB, which is that same 6 MB after base64).
And each session's directory is held to **24 MB, oldest deleted first**, enforced on every
upload — `fleet-clean` can only help once a session is dead, and a session that lives for
weeks and gets a photo a day needs the bound while it is still running.

Nothing serves those bytes back out: there is no read route, which removes a whole class of
problem by not existing. Filenames are generated here and never the client's, and content is
sniffed rather than taken on trust — SVG is refused by name, because it is an image that is
also a script container.

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
digit is guessable: the project's is its position in the **whole projects file**, across
every profile — `proj_nth()` in `bin/ghostfleet` counts every non-comment line of it and
filters by nothing, and `fleet-grid`'s own projects screen reads the same list the same
way. (This said "its position in its profile's list" and was simply wrong. It is the
sentence that would talk somebody into numbering the phone's profile tabs per-tab, which
is why it is corrected here rather than left as a harmless slip.) The
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

The 4th column is the project's **default agent** (`claude` · `opencode` · `codex` · `agy` · `cursor`) —
inherited by its master and by every session created in it, and pre-selected on the
grid's agent screen so you don't re-pick it each time. Omit it for `claude`.

Set it without hand-editing, from any of three places: the command line
(`fleet-project add <path> --agent opencode` for a new project, `fleet-project agent <name>
<agent>` for one that already exists, `--none` to put it back to the default), the `AGENT`
column on the TUI's `,` page (space cycles it), or the phone — on the add-project sheet,
and on a per-project row in its `, settings` sheet for the projects that already exist.
**Only agents whose binary is actually installed are offered**, because picking one that
cannot run leaves the next master dead with nothing on screen to say why, and each option
carries what choosing it costs — see the capability
matrix in [docs/multi-agent-sessions.md](multi-agent-sessions.md).

**Changing it moves the RUNNING master too** (`lib/agent-switch.sh`). An idle master is
switched within a few seconds; one in the middle of a turn finishes that turn first, and
meanwhile the settings row and the project's card say `switching to <agent>…`. Changing
it again before it fires takes the latest value, and changing it back cancels it. The
new agent starts with a short handoff — it is now the master, run `fleet-worktrees` and
`fleet-inbox` — and nothing of the old conversation. That conversation is not lost:
before the pane is killed its id is recorded in `<fleet dir>/<sock>.<slot>.convs.json`,
one entry per agent (`{"claude": {"id": …, "model": …, "ts": …}, …}`), and switching
BACK to an agent that can resume reopens exactly that id — never `--continue`. codex
can since 0.160.1 (its rollout survives a pane kill, and `codex-here` records which one is
the pane's); a codex with no recorded conversation starts fresh, and the settings row says so. If the new agent is not installed the switch is refused untouched;
if it starts and dies, the old agent is brought back on its own conversation, the setting
is put back, and the row says why. Running workers keep their agent; new ones take the
column. `fleet-project agent <name> <agent> --session <s>` does the same for one session
(a sub-master) and leaves the column alone.

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

## Several Claude accounts on one profile (experimental)

> **Experimental — off by default; enable with `fleet-experimental enable accounts`.** With it
> off nothing below runs, and nothing it reads or writes exists.

Rotating between Claude accounts to get past usage limits may conflict with Anthropic's terms
of service; whether to use this, and how, is your responsibility.

A profile keeps **one** config dir — its conversations, settings, plugins, folder trust and
`fleet/` dir never move. What changes is the **login** that dir holds, which is exactly what
`/login` to another account does by hand. An *account* here is a saved login for a profile, and
a profile can have any number of them. The order you add them in only breaks ties.

```bash
fleet-experimental enable accounts
# in a session of the profile (or: CLAUDE_CONFIG_DIR=~/.claude claude), /login as the first account, then
fleet-accounts add work main
# /login as the next account, then
fleet-accounts add work backup
fleet-accounts use work main          # put the first one back; `add` leaves the profile on the login it just saved
fleet-accounts list
```

```
accounts; switch at 97% of the 5h or 7d limit, spending the week that ends first

work  (~/.claude)
    main    5h  97% (resets 14:00, read 10m ago)         7d  30% (resets Tue 09:00, read 10m ago)     exhausted until 14:00
  * backup  5h —                                         7d  90% (resets Fri 15:00, read 2d ago)      active
```

**Which account it runs on: the allowance that expires first.** What is left of a weekly window
when it resets is lost, so of the accounts under the threshold on **both** the 5-hour and the
weekly window, the profile runs on the one whose weekly window resets soonest. Two weeks that end
within 5 hours of each other count as a tie, and the one with more weekly room wins it. An account
with no weekly reading counts as resetting last. In the listing above, main's week ends three
days before backup's. So main is used until its 5-hour window runs out, the profile goes to backup,
and it **comes back to main once main's 5-hour window resets** (14:00). That way main's week is
spent before it expires, and backup's last 10% is kept for when it is needed.

**Anti-thrash.** A switch away from an account that still has room happens only when the other
account's week ends **more than 5 hours sooner**. Five hours is one 5-hour window: two weeks that
end closer than that expire practically together, so switching between them buys nothing. The
profile is also **held for 15 minutes after any switch**, long enough for the new login to be
read, so the next choice is made on a real figure. Neither rule applies when the account in use is
over the threshold or unusable; then it moves at once.

**By hand.** `fleet-accounts use <profile> <name>` switches now and **pins** that account for
**2 hours**: the planner leaves it there, unless it reaches the threshold or stops working. A
`/login` by hand to a saved account is adopted and pinned the same way. `fleet-accounts list`
shows the pin and when it ends.

**Readings are only as fresh as the last turn on that login.** Figures come from the mod's session
records (`usage.limits.five_hour` / `seven_day`), so only the account in use is ever read. Nothing
sends a request on an inactive account to refresh its figures, and `list` shows how old each figure
is (`read 2d ago`). So a **planned** move (`backup's week resets first`) is made only to an account
whose **7d** figure was read in the **last 6 hours**: the weekly figure is what that move is decided
on, and a turn can report a 5h figure without a 7d one, so a fresh 5h reading does not count. An
older one is shown as `ready, stale (no planned move onto it)` and
is used only as a **failover**, when the account in use cannot run, because a stale account beats
stopping. The cost of trusting an old figure is not bounded the way it looks: a turn refused at the
limit carries no usage figures, so it never becomes a reading. An account read three days ago at
0% can have hit its weekly limit since, and nothing in its figures says so.

**A turn refused at the limit is a reading.** When a turn fails with Claude's own usage-limit
message, `You've hit your weekly limit · resets Oct 29 at 1am (America/New_York)` (or `session
limit`, or a per-model limit), the StopFailure hook keeps that sentence beside `rate_limit` in the
session's record. The account it was on is marked **OUT** until the reset the sentence names, in
the zone it names. If there is no time it can read, the mark lasts until the stored weekly reset or
24 hours after the failure, whichever is later. An OUT account is never chosen before then, not even
as a failover. If it is the account in use, the profile leaves it **at once**, the same way it
leaves one at the threshold: no 15-minute hold, and a by-hand pin does not keep it there. With
nowhere to go, the profile is exhausted until the earliest reset. `list` shows `OUT until Thu 01:00
(hit its weekly limit)`. A `rate_limit` without that sentence is a plain 429 that ran out of retries,
and marks nothing. The failure that lands in the 90-second grace window right after a switch still
counts when the account switched away from had room, because a limit there can only be the new
account's. `fleet-accounts use` on an OUT account switches anyway (you may know the limit was
lifted) and says so; the next turn refused at the limit marks it again.

**What happens at the limit.** When either figure reaches the threshold (`fleet-accounts
threshold`, default 97), the profile moves to the best account that still has room, chosen by the
rule above. The current login is copied back into its slot, the next one is put where Claude Code
reads its login, and an inbox row plus a phone push say
`work: switched from main to backup (5h at 97%)`. A planned move back (`switched from backup to main
(main's week resets first, …)`) gets an inbox row but no push. That is the whole switch, the same thing a
`/login` by hand does: **no session is restarted**. Each running Claude re-reads its login by
itself (from the Keychain every 30 seconds on macOS, from `.credentials.json` on Linux), so a
session mid-turn finishes that turn and its next request goes out on the new account, with its
screen, its scrollback and anything it has running in the background left as they were. For a
short grace window after a switch (`CLAUDE_FLEET_ACCOUNTS_GRACE`, default 90 seconds) a session
may still be on the old login, so usage read in that window is credited to neither account.

**When every account is spent**, every worker in the profile's fleets is parked (the lead is
not), an inbox row and a push say `all work accounts exhausted until 14:00`, and at the
earliest reset the profile moves to that account and the parked workers are resumed where they
are, as `fleet-resume` does it: the park is cleared and a prompt telling them to continue is typed
into the session that is already running.

**A project whose budget limit is `ignored`** (the grid's settings screen, or the web client's
project sheet; on disk `<sock>.governor-off` in the fleet dir) is the exception: the accounts
engine reads the same marker the governor does, and parks nothing there. Its workers keep running
on what the active account has left until Claude itself refuses a turn — at which point that
account is marked `OUT` until the reset Claude names, the profile fails over if anything has room,
and a session left on Claude's limit message shows as at its limit like any other. The notice
still comes, worded for what is true: that project's inbox row ends `budget ignored here, so
workers keep running until Claude refuses them`, and the push and `list` say `workers keep
running (budget ignored)` (or `workers paused, except where the budget is ignored` when the
profile's fleets differ). The setting is read every tick, so switching a project to `ignored`
mid-episode resumes the workers the engine parked there on the next one, and switching it back
parks them again.

**A login that stops working** — expired, revoked, or never refreshed — is seen three ways: Claude
Code blanking the tokens in the stored login (what it does when a refresh is refused), a turn
ending in `StopFailure` with `authentication_failed` (`fleet-accounts add` wires that hook into
the profile's `settings.json`), or a session launched on it showing Claude's own `Please run
/login` line. The account is marked **NEEDS-LOGIN**, said once (`work/backup needs /login — run:
…` with the exact command), and skipped until you `/login` to it again and re-run `fleet-accounts
add work backup`, which clears the mark. It is never retried in a loop, and the profile's own
first account expiring is the same case.

**An account its organization has turned off** is a different case. A turn fails with
`oauth_org_not_allowed` ("Your organization has disabled Claude subscription access for Claude
Code"), and a `/login` gets the same refusal. That account is marked **BLOCKED**, said once with
a push, and skipped. `list` shows it with the fix: only an admin of that organization can turn
access back on. `use` refuses it. The mark clears by itself when a later reading on that login
succeeds (a turn went through), or when you `/login` to it and `fleet-accounts add` it again.

**On the phone and in the web client.** The top of Projects carries one line per profile: its
active account and that account's 5h and 7d figures with time to reset (`main · 5h 37% (2h10m) ·
7d 42% (Sat)`), green while the figures are fresh, yellow when they are over 6 hours old (with
how old) or the login in use is not saved, red when the account cannot run (`OUT until …`,
`NEEDS-LOGIN`, `BLOCKED`, over the threshold) or every account is out (`all accounts exhausted
until … — workers paused`, or `workers keep running (budget ignored)`). A tap opens every account of every profile the way `list` prints
them, with the threshold and any pin. It is `list`'s own data — `fleet-serve` serves
`lib/accounts.mjs`'s `describe()`, which `list` prints from — for the profiles the daemon lists,
read every 45 seconds and on reopening the app, and it carries account labels, figures, times and
states only. With the experiment off the line says so and nothing else. Switching stays at the
desk.

**Where the logins are.** Claude Code keeps a config dir's login in the macOS Keychain (item
`Claude Code-credentials-<hash of the config dir>`) or, on Linux, `<config dir>/.credentials.json`,
and who it belongs to in `.claude.json`'s `oauthAccount`. ghostfleet keeps each *saved* account
only in the same place: a Keychain item of its own (`ghostfleet-claude-login`, account
`<profile>.<name>`) or a 0600 file beside `.credentials.json`. `accounts.json` in the profile's
`fleet/` dir holds the order, the readings and a one-way id per login — never a token — and
nothing here prints or logs one. Tokens that Claude Code refreshes while an account is in use are
copied back into its slot on every governor tick and at the moment of switching away, and an
older saved copy is never written over a newer live one.

`fleet-accounts remove <profile> <name>` forgets one (not the one in use — switch first).
Codex, opencode, agy and cursor keep their single login and are not touched.

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

## Retiring a finished worker

**A worker is disposable: one task, one session.** When its PR merges it is retired, and the
next task goes to a new session — `fleet-spawn`, with `--reuse` if you want the folder back.
Handing a finished worker the next brief is the habit this replaces: its context still holds
the last task, and the new one gets worked through the files it already read and the
approach it already chose. `fleet-send` now refuses that send when the worker's task has
shipped — its branch's PR merged, or its tree is clean and even with the integration branch
after a `DONE` — and names `fleet-spawn` instead. It never refuses a follow-up while the PR
is still OPEN (a red CI row, a review note), a session that has not finished a turn yet, a
`--reply-to` question, or the master. `--anyway` sends regardless. `fleet-inbox` lists
finished workers whose sessions are still up, each with its `fleet-stop --reclaim <name>`.

**`--reclaim` works the moment the PR squash-merges.** It used to refuse exactly then, twice
in one day: the squash lands one new commit, so the branch's commits are not in the
integration branch; the merge deletes the remote branch, so there is nothing to be "fully
pushed" to; and the cached PR list, fetched before the merge, still said open for ten
minutes. So for the one worktree being reclaimed, `fleet-clean --only` asks GitHub about that
branch directly (`gh pr view --json state`), and MERGED on a clean tree is enough. A dirty
tree is still kept — an edit after the merge is still work.

**And `--reclaim --force` no longer loses the tree.** The refused run had already killed the
session and dropped its manifest row, so the escalation it suggested could not find out where
the session had been: "could not tell which worktree it was in — nothing removed", with the
worktree still on disk. A kept reclaim now leaves the path in
`<fleet dir>/<socket>.<session>.reclaim-kept`, and the manifest row is read before it is
deleted.

## The context ceiling

**Every session ghostfleet starts gets a 300k-token context ceiling.** Masters and workers alike
get it, through every route: spawn, the grid, wake, resume and restart. All of them start the
session through `bin/claude-here`, which exports `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`. Claude
Code then compacts the conversation once it nears that size, instead of near the model's 1M window.

**Why.** Each call re-reads the whole context from the prompt cache, so a long session costs more
on every call it makes. One busy fleet was measured over 13 days (146 sessions, 68k model calls):

- 83% of the token cost was cache reads.
- The average call carried 420k tokens.
- 54% of the spend was on calls at 500k+, and 30% on calls at 700k+.
- Sessions only compacted near 965k.

**How it behaves, measured on scratch sessions:**

- A 300k window is 280k after Claude Code reserves 20k for output.
- The compaction threshold works out to about 238k. A 172k session did not compact under it.
- A 334k session compacted before its next call. That compaction cost one summary pass (334k
  read, under 1k written), and the call after it read 14k tokens instead of 334k.

Two other variables look like they do the same job and don't:

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` leaves the window at 1M, so the UI's "% left" stays wrong. It
  is also a test override that forked agents ignore.
- `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` is only the size floor for idle compaction, and a
  server-side flag decides per account whether idle compaction runs at all. In a test on an
  account with the flag on, two idle 172k sessions were left 58 minutes; neither compacted, even
  with the floor at 100k. So masters get the same ceiling as workers.

**Changing it.** Set it per project:

```bash
fleet-project set acme-api context-window 400k     # or 0.5m, 450000
fleet-project set acme-api context-window off      # no ceiling: the model's whole window, as before
fleet-project set acme-api context-window default  # drop the override
fleet-project get acme-api                         # what it resolves to, and from where
```

That writes `<fleet dir>/<socket>.context-window`. To change the default for every project, put
one value in `~/.config/ghostfleet/context-window`. A project's own file beats it, and the
built-in 300k comes last.

A few rules apply to the values:

- Below 200k the value is raised to 200k. Claude Code does not compact ahead of time under that
  size.
- Above 1M the value is held at 1M.
- A bare number under 1000 (`300`) is refused rather than read as 300 tokens.
- A file that doesn't parse is skipped with a warning, not treated as `off`.

Workers can't change it: the guard that stops a worker from loosening its own limits blocks every
`fleet-project set`.

**It applies when a session starts.** A running session keeps the window it started with until
its next start: wake, restart, or the grid's reopen. To move a whole fleet now, restart its
sessions.

**If you exported `CLAUDE_CODE_AUTO_COMPACT_WINDOW` yourself, your value wins.** ghostfleet marks
the values it sets itself (`CLAUDE_FLEET_CONTEXT_WINDOW`). An inherited value with that mark is
recomputed for the project at hand. That matters because a lead that starts another project's
fleet would otherwise pass its own ceiling to that fleet.

**Did it work?** Ask the meter, over the weeks before and after the change:

```bash
fleet-meter --context --until 2026-11-02     # before
fleet-meter --context --since 2026-11-02     # after
```

It prints:

- the share of spend and calls in each context-size bucket (`<200k`, `200-300k`, `300-500k`,
  `500-700k`, `>=700k`);
- the compactions, with the median size each one cut from (about 250k once the ceiling is in
  force, about 965k before);
- turns, calls and spend by what started each turn: a person, a `[fleet]` nudge, a task
  notification, or a ledger gate.

Like the rest of `fleet-meter` it prints counts and digests, never content. Spend is priced at
list price per model; `--json` also carries the raw token counts per bucket, so you can re-weight
them with your own prices. It reads the corpus of the profile it runs under
(`$CLAUDE_CONFIG_DIR/projects`), or `--corpus DIR`.

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
  (`cf-personal-scratch` → `personal-scratch`), which is nobody's directory. So a
  hand-run `fleet-grid.mjs cf-personal-scratch --plain` skips step 2.
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

## The mod: Claude reporting on itself (Claude Code 2.1.287+)

Everything above reads a Claude session from **outside**: a regex over its pane for "is
it working", its status bar for the 5h budget, a shell hook that fires on five events and
guesses the rest. Most of the fleet's status bugs came from there: a 56-column pane that
drops the spinner's timer, a leftover login line read as a spinner, a governor log full of
`no budget reading this tick — no pane carries the 5h figure`.

`mods/ghostfleet` is a Claude Code **mod**: a plugin of function hooks that runs inside
every Claude session and reports from there. It does three things:

| | from | written to |
|---|---|---|
| **state** | `turn.start` → `working`, `turn.complete` → `ready` (`interrupted` on Esc), the permission dialog → `need-you` (the engine's `tool.check` verdict is `ask` on a real call), the call resolving → `working` again | the session's status record, `<fleet dir>/<session_id>.json`, merged beside the shell hook's fields as `source: "mod"`, `state`, `turnId`, `mod: { pid, hb }` |
| **budget** | `session.measure`: the engine's own context and rate-limit figures, pushed after each turn | the same record, `usage.limits.five_hour: { pct, resets }` |
| **`/fleet`, `/inbox`** | `fleet-list` and `fleet-inbox`, run as processes | the transcript, **without starting a turn**, mid-turn too |
| **ledger** | `prompt.submit` (every message, mid-turn ones too, and the note it carries), `tool.call` (`ledger_close`, `ledger_drop`, `ledger_add`) and `turn.complete` (the turn's text) | `<fleet dir>/<session_id>.ledger`, the record's `ledger: { open, promises, oldest_at, judge_failing? }`, a row above the prompt; see "The request ledger" |

**Who believes it.** The grid (and so the phone), the push/digest scan and `fleet-list`
take the mod's `state` over the pane while it is still being written: the pid that wrote
it is alive and its once-a-minute heartbeat is under 150 s old (`lib/mod-status.mjs`).
Otherwise (a crash, the plugin off, an older Claude, any other agent) they do exactly what
they did before. `fleet-grid.mjs --json` says which on every card (`status_from: "mod"` or
`"pane"`). The governor takes the highest 5h figure whose window has not reset yet, from
any record in the profile's fleet dir, and names it in its log:

```
[fleet-governor 09:14:02] budget 37% (healthy) — from the mod: master, read 40s ago, window resets 13:00
```

With no such figure it scrapes the panes as before.

**What it cannot see.** `classic.PermissionRequest` and `classic.Notification` never
reach a user-installed mod on this Claude build (the debug log says they are `bypassed by
cc-plugin-sec-default`), which is why the dialog is read from `tool.check`. That verdict
cannot tell a person's dialog from **auto mode's** classifier, and a hook cannot read the
permission mode, so in auto mode a classified call reads `need-you` until it resolves.
Bypass mode is unaffected: its verdict is `allow`. A hard rate limit has no event either.
The grid reads it from the 5h figure the mod writes (`limit` at 100%).

**`/inbox` and the model.** A command's output is a transcript row the model reads as well
as you. For `/inbox` that is the point: it marks the rows seen exactly as `fleet-inbox`
does, so if the model could not read them they would be gone from the one place it looks.

**Installing it.** `install.sh` runs `fleet-mod install`, which adds the runtime
(`~/.local/libexec/ghostfleet`, itself a marketplace) and installs `ghostfleet@ghostfleet`
at user scope into every profile the hooks are wired into, after backing up each one's
`settings.json` and plugin registries. It is idempotent, and does nothing on a Claude
without mods. See what it would do first:

```bash
fleet-mod install --dry-run     # every backup and `claude plugin` command, per profile
fleet-mod status                # where each profile stands
```

**Deploying a change.** A marketplace that is a folder is read **in place**:
`claude plugin list` shows `Read from: ~/.local/libexec/ghostfleet/mods/ghostfleet`. So
`cf-sync` is the whole deploy, as for every other file: a new session loads the new mod,
a running one picks it up on `/reload-plugins`. No version bump, no reinstall.

**Sessions that predate it.** A running Claude keeps the plugins it started with, so an
install reaches only sessions started after it; the rest are still read from their panes.
`fleet-mod reload` brings them onto it, across every fleet and every profile:

```
$ fleet-mod reload                 # the plan; changes nothing
SESSION              PROFILE         VERSION  STATE    ACTION
cf-acme-api/master   ~/.claude       2.1.284  ready    restart
cf-acme-api/api-fix  ~/.claude       2.1.292  idle     reload
cf-acme-web/master   ~/.claude-work  2.1.292  working  skip: busy
cf-acme-web/scratch  ~/.claude-work  ?        -        skip: not claude (codex)
cf-toolbox/master    ~/.claude       2.1.292  ready    already on mod
$ fleet-mod reload --apply         # do it, then read every record back: ✓ on mod / ✗ why
```

- **reload**: `/reload-plugins` typed into the session. No turn starts, and on a new
  enough Claude the mod is loaded and writing its record within a couple of seconds.
- **restart**: a process older than 2.1.287 cannot run the mod whatever is on disk, because
  it keeps the version it started with. On 2.1.284, `/reload-plugins` reads the plugin as
  enabled and then refuses its hooks (the debug log: "hooks modules are not turned on for
  installed plugins in this process"), with nothing in `/plugin`'s Errors tab. So it is
  relaunched on the current binary by `fleet-restart`'s by-id path, the same conversation,
  never `--continue`. A session whose conversation cannot be established is left alone
  with the reason.
- **Only an idle session with an empty input box is touched.** A turn running (or a
  background command that will start one), a permission dialog, a question waiting on you,
  something half-typed, a pane with no input box drawn: each is listed with why, and left
  as it was. Neither is the session running the command.
- **Done means the record says so.** Each session gets 15 seconds to write `source: "mod"`
  from a live process after the action; otherwise it is ✗ with what its pane said.

`--only <sock>[/<session>]` narrows it to one fleet or one session; `--reload-only` never
restarts. The running version comes from Claude's own note about the process
(`<profile>/sessions/<pid>.json`), or failing that the newest `version` in its transcript.
`install.sh` says how many sessions predate the mod when there are any.

**Seeing it loaded.** In a session, `/plugin` lists it as `1 mod active · ghostfleet`.
`claude plugin list` shows it `✔ enabled`. A card whose `status_from` is `mod` is the
proof that matters. `CLAUDE_FLEET_PANE_BUSY=off` turns the pane regex off for a grid run,
so a card that still goes `working` → `ready` got that from the mod and from nothing else.

**Turning it off.** `/plugin disable ghostfleet@ghostfleet` in one profile;
`fleet-mod uninstall` everywhere (it backs up first, too); `CLAUDE_FLEET_MOD=off
./install.sh` to install without it. The fleet then reads Claude from outside, as before:
the heartbeat stops and within 150 s every reader falls back to the pane.

**It is code that runs with your permissions**, inside every Claude session in those
profiles, so it is kept small enough to read (`mods/ghostfleet/hooks/register.js`) and
does very little. It makes no network calls. Its one model call is the ledger's judge (see
"The request ledger" below): a small model, once per answered turn per ten open items, and
only when something is still open after the agent closed what it finished;
`CLAUDE_FLEET_LEDGER=off` removes it. Its observers
(state, budget, the band) fail open: one that throws or overruns is skipped by the engine and
the session carries on as if the mod were not there. Its guards fail closed (see "The
guards" below). Every file and process call is bounded, so a stalled disk cannot hold a turn
open. What it touches, as `claude plugin validate` reads it:

```
$ claude plugin validate mods/ghostfleet
  ❯ ./register.js hooks: session.start, turn.start, turn.step, turn.complete, tool.check, tool.call, session.end, session.measure, command.run{command=fleet}, command.run{command=inbox}, tool.call{tool=Bash}, tool.call{tool=/"^mcp__"/}, ui.render{component=AbovePrompt}, prompt.submit, command.run{command=ledger}, tool.call{tool=mcp__ghostfleet__ledger_close}, tool.call{tool=mcp__ghostfleet__ledger_drop}, tool.call{tool=mcp__ghostfleet__ledger_add}
  ❯ ./register.js answers its own command: command.run{command=fleet}
  ❯ ./register.js answers its own command: command.run{command=inbox}
  ❯ ./register.js answers its own command: command.run{command=ledger}
  ❯ ./register.js gating hook without .catch: tool.check
  ❯ ./register.js gating hook without .catch: tool.call
  ❯ ./register.js gating hook with .catch: tool.call{tool=Bash}
  ❯ ./register.js gating hook with .catch: tool.call{tool=/"^mcp__"/}
  ❯ ./register.js gating hook without .catch: prompt.submit
  ❯ ./register.js gating hook without .catch: tool.call{tool=mcp__ghostfleet__ledger_close}
  ❯ ./register.js gating hook without .catch: tool.call{tool=mcp__ghostfleet__ledger_drop}
  ❯ ./register.js gating hook without .catch: tool.call{tool=mcp__ghostfleet__ledger_add}
  ❯ ./register.js calls: $.clock.after (via startState), $.clock.every (via deliveryStart, startBand, startState), $.clock.now, $.clock.sleep (via bounded), $.command.register (via ledgerStart, startCommands), $.env.get (via fleetDir, identity, jarvisDir, ledgerConfigOf, mergeGuard, registeredProject), $.fs.exists (via maybeJarvis, readLedger, registeredProject), $.fs.list (via childBranches, deliverTick, deliveryStart, mergeGuard, refresh, registeredProject), $.fs.read (via childBranches, childrenOf, maybeJarvis, readLedger, readRecord, readTeamRecords, refreshPrs, registeredProject), $.fs.write (via applyLedger, applyPatch, writeSpool), $.model.complete (via judgeTurn), $.process.run, $.prompt.submit (via deliverTick, judgeTurn), $.session.cwd (via answerGuardBash, mergeGuard, refreshPrs), $.session.id (via applyPatch, deliveryStart, ledgerPath, ownRecord), $.session.messages (via judgeTurn), $.session.root (via mergeGuard), $.session.surfaces (via judgeTurn), $.session.turns (via startS… [+117 chars]
  ❯ ./register.js env writes: nothing
  ❯ ./register.js env reads: CLAUDE_CONFIG_DIR, CLAUDE_FLEET_DIR, CLAUDE_FLEET_JARVIS_DIR, CLAUDE_FLEET_LEDGER, CLAUDE_FLEET_LEDGER_GATE, CLAUDE_FLEET_LEDGER_MODEL, CLAUDE_FLEET_LEDGER_PROMISES, CLAUDE_FLEET_SLOT, CLAUDE_FLEET_SOCK, CLAUDE_JOB_DIR, HOME, TMUX, TMUX_PANE
  ❯ ./register.js state writes: ghostfleet.band, ghostfleet.ledger
  ❯ ./register.js state reads: ghostfleet.band, ghostfleet.ledger

✔ Validation passed
```

The first three "gating hook without .catch" lines are the observers, and are deliberate: a
hook there with no `.catch` fails open, which is right for one that only reads what `next(e)`
returned and hands it back unchanged. The last three serve the ledger's own tools: a failure
there fails the agent's `ledger_close` call and nothing else, and the item stays open for
the judge. The two "with .catch" are the guards, whose handler
refuses.
`claude plugin test mods/ghostfleet` runs its hooks against the engine.

### The lead's band

A master, and a sub-lead (a worker with children), draws its team above the prompt:

```
3 workers · 1 working · 1 need you · 2 PRs green · 1 red
```

- **Who is on the team.** master: every session on its socket but itself and the terminal
  tabs. A sub-lead: its children (`<sock>.<child>.parent`). A worker without children draws
  nothing and starts no process for it; it becomes a band the tick after its first child.
- **Where the numbers come from.** The status records in the fleet dir, read every 5 s (a
  record is reread only when its mtime moved), the mod's `state` while its heartbeat is
  fresh and the shell hook's `status` otherwise, and `tmux list-sessions` for who is alive.
  PRs come from `gh pr list` every 2 minutes. master's are the open PRs from a branch its
  manifest names, so a finished worker's green PR still counts; a sub-lead's are the ones
  into its own branch. `PRs ?` means gh did not answer, never zero.
- **Narrow panes.** Words shorten first, then `need you` moves to the front, then only the
  essentials stay: `1 need · 1 busy · 4w` at 28 columns, `1!` at the very end.
- **Cost.** No turn, no model call. A redraw happens only when what the line says changes.

### The guards

The fleet's refusals used to live only in shell hooks and inside commands, and a shell hook
can only fail **open**: one that cannot find jq exits 0 and the call goes ahead. The mod
puts the same refusals in front of the tool as `tool.call` hooks, each registered with a
`.catch` that answers `deny`. If a guard throws, gets no answer, or runs out of time, the
call is **refused**, with the reason:

| guard | refuses | how it decides |
|---|---|---|
| Jarvis's confirm-list | the listed Bash commands and `fleet_*` MCP calls, from Jarvis's master | `lib/mod-gate.mjs` asks the same gate the MCP door and `hooks/jarvis-guard.sh` ask (`lib/jarvis.mjs`), under the same lock |
| a worker does not merge its own PR | `gh pr merge`, the REST and GraphQL merges, any `merge_pull_request` MCP tool, and a worker changing its own boundary, from a linked worktree | the rule from `hooks/fleet-guard.sh`, ported (`mods/ghostfleet/hooks/guard-shape.js`; the suite holds the two to the same verdicts) |
| an agent does not approve another agent's tool call | an approving key from `fleet-answer` (Bash) or `fleet_answer` (MCP) into a permission dialog | `fleet-answer --check`: fleet-answer's own decision, sending nothing |

Same switches, same defaults: "workers can merge" and "agents can approve tool calls" (off),
per project or per session, and Jarvis's confirm-list ignores both. The shell versions stay
wired and are what guards every session without the mod: another agent, an older Claude, a
profile where the mod is off.

**What changes when a guard cannot decide.** The shell merge guard lets a merge through when
jq is missing, and when git cannot be asked. The mod refuses it: "this command could not be
checked, so it is refused (a guard fails closed)". For Jarvis only the commands the
confirm-list could act on are put to the gate (`gh`, `git`, `tmux`, `fleet-*`, Jarvis's files
and verbs, its own socket), so a broken gate refuses those and not every `ls`.

**One yes, one action, through two doors.** Where both the mod and an older door run (the
Bash hook, the MCP server), the same call is asked about twice: the mod first, the older door
after it. A pass at the mod's door leaves a single-use relay for that exact call, valid for
60 s, which only another door can take; the mod asking again is a second action and needs a
second yes.

**A scratch Jarvis.** `CLAUDE_FLEET_JARVIS_DIR` moves Jarvis's marker, ledger, proposals
and its on/off switch, `jarvis.enabled` (and nothing else) to another directory. Switched
off, every one of those readers answers "no Jarvis" — nothing is gated (docs/jarvis.md,
"The switch"). Every reader honours it: `lib/jarvis.mjs`,
`hooks/jarvis-guard.sh`, `bin/fleet-answer` and the mod. That is how the confirm-list is
proven on a scratch fleet without touching the real marker.

**Where it runs among other mods** (Claude Code docs, "The order mods run in"): `PreToolUse`
hooks from managed settings run before every mod, and a block there is final. Then the
built-in `sec-default` guard and an organization's prepended mods, then mods a person
installs (this one), then the settings hooks of every other file, `hooks/fleet-guard.sh` and
`hooks/jarvis-guard.sh` among them. A profile signed in to a Team or Enterprise plan loads
`sec-default` even with no managed settings. It restricts mods that *approve* calls, and these
guards only refuse, so nothing changes there. An organization that sets
`allowManagedModsOnly` (or `allowManagedHooksOnly`) keeps the mod from loading; the shell
guards then do the work, as before the mod, and `allowManagedHooksOnly` turns those off too.

### Delivering prompts through the mod

`fleet-send` used to deliver every prompt the way a person would: paste it into the pane's
input box and press Enter. That paste could land on a half-typed message, the Enter could
race the paste and never submit ("could not confirm submit"), and a prompt pasted into a
busy session folded into the running turn. For a Claude session whose mod is live,
`fleet-send` now hands the prompt to the mod instead. The mod submits it with
`$.prompt.submit({ text, asUser: true })` as a turn of its own, once the session is idle,
and records which turn it started. The composer is never touched.

| | paste (no mod) | mod |
|---|---|---|
| idle session | paste + Enter, confirmed by watching the box | handed over, submitted, confirmed by the turn's id (`fleet-send: → w1`) |
| a half-typed message in the box | the paste joins it | left exactly where it is |
| busy session | `queued #N`, drained after Stop | the same queue and drain, which hands each prompt to the mod (no waiting for an empty box) |
| `--now` | pasted into the running turn | **still the paste**: the API runs a plugin's prompt only once idle |
| `--reply-to` | armed by the next UserPromptSubmit | armed by the mod at the `turn.start` of that prompt's turn |

**Which sessions.** A believable mod record for that socket and slot (`lib/mod-status.mjs`),
whose `<session_id>.handoff/.ready` names the same process (`lib/mod-target.mjs`). A
phase-one mod that only reports, codex/opencode/agy/cursor, an older Claude, a disabled
plugin and a machine without node all get the paste, exactly as before.
`CLAUDE_FLEET_MOD_DELIVER=off` forces the paste for one call or one hook.

**The channel** is a spool directory per session, `<fleet dir>/<session_id>.handoff/`,
which the mod polls every 500 ms. Claude Code's own cross-session messaging was the
alternative. It needs a Claude session to send (`fleet-send` is also run by shells, codex,
opencode and the phone server), it cannot cross profiles, the target reads its messages as
a peer's words, and a message is lost if the mod reloads. A file has none of those
problems.

```
<id>.json      fleet-send left it: { id, text, reply? }
<id>.taken     the mod claimed it (a rename) while no turn was running
<id>.done      the receipt: { turnId } once its turn started, { ran } for a slash command
               that ran without starting one, or { dropped | error }
<id>.failed    a failed receipt nobody read within the hour, kept for fleet-inbox
<id>.revoked   fleet-send took it back unclaimed and pasted it instead
.ready         the pid of the mod process that delivers from here
```

Each step is a rename, so exactly one side owns an entry at a time. If the mod has not
claimed the entry within `CLAUDE_FLEET_MOD_CLAIM` seconds (default 3), `fleet-send`
renames it to `.revoked`. If the session went busy in that gap, the prompt is queued.
Otherwise it is pasted, with a note on stderr. If the mod claimed it first, the revoke's
rename fails, so a prompt is never both submitted and pasted. Receipts are kept for an
hour.

**A prompt may start with a slash command.** `fleet-spawn w1 --prompt "/some-skill redo the
settings page …"` runs `/some-skill` with everything after it as its arguments, exactly as if
it had been typed, and its turn is the one the receipt names. The host refuses a text
beginning with `/` as a plain prompt, so the mod runs it through `$.command.run` instead.
There is no escape for a literal leading slash. The host refuses `//x`, ` /x` and `/x` alike
as prompt text, so a `//` brief, a bare `/` or a path (`/tmp/log …`) is refused with a
message that says to reword it. A command that answers without a turn (a panel, a local
command) is receipted `ran`, and `fleet-send` prints `→ w1 (ran /cost; it started no turn)`.
The mod's own `/fleet`, `/inbox` and `/ledger` cannot be run this way: the host skips a
plugin's own hooks when it runs a command itself. Use `fleet-list`, `fleet-inbox` and
`fleet-ledger` instead.

**A delivery that fails is never silent.** `fleet-send` waits for the receipt, prints the
mod's error and exits 1, and removes a failed receipt once it has reported it. Two senders
have no reader for that output, so they file the failure as a `failed` row in the inbox of
the worker's lead: `fleet-spawn`'s deferred brief (also printed on the terminal
`fleet-spawn` ran in, when there is one) and the queue's drain. Any failed receipt still on
disk 30 seconds after it was written was read by nobody. `fleet-inbox` files it as a
`failed` row naming the worker, the opening words of the prompt and the error, then clears
it (`lib/handoff-sweep.mjs`).

**What stays the same.** Outputs and exit codes, the queue and its card count, the
`[fleet]` preambles, the nudges and their deferral (they still wait for an empty box,
because they may still be pasted), and the `.sent` log. The Jarvis delivery marker is now
written by the side that delivers: `fleet-send` when it pastes, and the mod, inside
Jarvis's own session, just before it submits. Either way a prompt the fleet delivered into
Jarvis's master never counts as the owner speaking, even when the sender's `HOME` is not
Jarvis's. The phone's prompts go through `fleet-send` as before.

**Only the addressed server's mod.** A record matches by socket name and slot, and a name
is not a server. The record's `pane` names the tmux server it runs on (`%N@<server pid>`),
and `fleet-send` passes the pid of the server it addresses, so a record of the same name on
another server is never handed the prompt. Without this, a fixture server under a test
run's own `$TMUX_TMPDIR`, reached with the caller's fleet dir, delivered into the live
session of that name.

**Who sent it.** Each `.sent` row carries a fifth field:
`from=<sock>/<session> cwd=<dir> by=<parent command>`. The session comes from `$TMUX`, and
is marked `env:` when it was only read from the environment. `-` means no fleet session. One new failure gets a code: a prompt the mod could not submit (a hook dropped it, the
host refused it, a command that does not exist) exits 1 with `not delivered` and the
mod's own words.

**Seeing it.** The transcript labels a delivered prompt `Prompt from the ghostfleet
plugin`. The record's `turnId` and the handoff's `<id>.done` name the same turn.

### The request ledger

A person types three messages while a turn runs. The prompt tells the model to treat each
as queued work and never end a turn with one of them neither done nor reported not-done,
and that instruction is dropped often enough to matter: the second message's answer is
never written, and nobody finds out until they go looking. So does "I'll merge when it's
green", said once and never done. The mod holds both to account from inside the session.

```
ledger · 2 open · oldest 4m “add a changelog line” · promise: merge the PR once CI is green
```

The ledger is a hybrid. **The agent closes its own items** as it finishes them, through
three tools the mod registers, each with proof; **the judge is the backup**, asked only about
what the agent left open; and **the gate** re-prompts once, only about the latest prompt.

- **What becomes an item.** Every message the person submits: typed at an idle prompt,
  typed over a running turn (`prompt.submit` fires at Enter, with that turn's id), or sent
  from the phone. A message of two or more plain asks (list lines, questions, sentences that
  open with a verb of work or "can you") is one item per ask, so each closes on its own
  proof; anything less plain, a paste, or a message over 4,000 characters stays one item. A
  prompt `fleet-send` hands the mod (see above) is one item, never split. Not items: slash
  commands, background-task notifications, `/loop` firings, the ledger's own re-prompt, and
  **the fleet's own wake-ups** ("a worker finished, run fleet-inbox", Jarvis's and the batch
  wake): `hooks/fleet-event.sh` sends those with `fleet-send --nudge`, which marks the
  handoff entry `kind: "nudge"` (and the queue record, for a busy lead), and the mod records
  nothing for a marked entry. The marker is the test, never the wording. A nudge that falls
  back to the paste (a lead whose mod is not delivering) arrives as typed text and is
  recorded like one. Only messages after the mod loaded: nothing is backfilled.
- **The note.** Each prompt carries a note to the model, never shown the person: the open
  items with their ids, requests first and newest first, then promises, **eight at most**
  (each cut to 100 characters, so the note stays under ~1.5k), `+N more open (/ledger lists
  them)` past that, and the rule: close with `ledger_close` and proof. No note when nothing
  is open. A plugin's own submit cannot carry context, so a prompt `fleet-send` delivered
  gets its note on the first tool result of the turn it started instead.
- **The agent's tools.** `mcp__ghostfleet__ledger_close(id, proof)`: the proof is required
  and non-empty (a path, link, commit, PR number, command result) and kept on the item.
  `ledger_drop(id, reason)`: not a real ask, or the person cancelled it; state `dropped`.
  `ledger_add(text)`: an ask the split missed, added to the latest prompt so the gate covers
  it. Every close records who made it: `closedBy` is `agent`, `judge`, or `person` (`hand`
  in a file written before this). Old ledgers need no migration: their items are closable
  by the tools as they are.
- **A brief from the lead is done only with proof.** An item whose source is `fleet` (a
  prompt `fleet-send` delivered) is closed as `done` by `ledger_close` with its proof, or by
  the person by hand, and never by the judge. The judge reads a turn's prose, not its work:
  measured on one fleet, 40% of all closed items were judge-closed with no proof, and in one
  weekend every "done" across 23 workers was, with nothing merged. A brief the judge reads
  as done stays **open**, carries `answered: { at, turnId, reason }`, and shows as
  `[answered, no proof]` in `/ledger` and `fleet-ledger list`; the judge may still keep it
  open, report it in progress, or hold it waiting. The person's own messages and the
  agent's promises are judged exactly as before. Not retroactive: items closed before this
  keep their state. An item a stopped worker's ledger carried to its lead is `fleet` too (see
  below), and needs proof the same way.
- **The judge, as backup.** At the end of each answered main-loop turn, after the agent's
  own closes, a small-model call (`haiku` by default) for every ten items **still open**,
  newest first, reads them and the turn's text (all of its blocks, cut from the middle past
  6,000 characters, plus up to two earlier turns since the oldest open item) and answers
  strict JSON: each item `done`, `in-progress` (the turn reported its state and the work
  goes on elsewhere: a worker, a build, CI, the person's pick), `not-done` (said so, **with
  a reason**), or `open` (the turn did not address it), and whether the turn ends waiting on
  the person (`waitingOnPerson`). An `in-progress` item stays open, marked `[in progress]`
  in `/ledger`, and is judged again on later turns. A part
  an item itself put off ("not in this reply") is not owed yet. A bare "go ahead" or "thanks"
  closes once the agent acted. **A turn in which the agent closed items and left nothing
  open makes no call at all**, promise wording or not (a brief the judge read as answered is
  still open, so it is judged again each turn until it is closed with proof); otherwise the
  call is made only when
  something is open or the answer reads like a promise, so a quiet session costs nothing.
  Measured on haiku, one call for 46 items needed 1,737 tokens of reply and was cut off at
  700 before its closing brace; a call of ten takes at most ~600, and each may now use
  1,500. A reply cut off anyway still applies every item it finished. The judge still reads
  older open items too, and may close them; it is only the gate that ignores them.
- **Promises.** The same call lists commitments from the final message ("next I'll add the
  tests"), firm ones only: not offers that wait on the person, not "I'll keep doing X". Each
  becomes an item with `source: promise`, drawn separately on the band, and closed the same
  way by a later turn's text, or by the agent with `ledger_close`. A promise the judge has
  been shown and kept open for five judged turns closes as `stale`: nothing gates a promise,
  so one the session dropped would otherwise sit on the band for a week. Requests never go
  stale.
  One commitment is one promise: the judge is shown the open promises and names the one a
  new phrasing restates, and a phrasing that shares most of its content words with an open
  promise (or any earlier phrasing of it) is that promise too. What the agent asks the
  person to do ("still waiting on you: run X") is never a promise, nor is waiting on them
  ("I'll wait for your reply", "once they decide"), nor the follow-through of an item judged
  `in-progress` ("I'll ship it when the worker lands"). At most five are open;
  a sixth closes the oldest as `stale`.
- **The gate.** Items **from the latest prompt** still open after the judge get **one**
  framed re-prompt ("the ghostfleet plugin sent a message") naming them and asking the agent
  to finish and close each with proof, or say why not. The latest prompt is the last message
  typed at an idle prompt or delivered by `fleet-send`, plus every message typed over the
  turn it started (those queue behind it, so that turn's end is not gated and the next turn
  answers them together), plus what `ledger_add` added. **An older open item is never
  re-prompted**: it stays on the band and in `/ledger`, closable by the agent, the judge or
  the person. A ledger written before prompts were numbered has no item in any window, so
  none of its items is ever re-prompted. The bound is in the data: an item carries `gated`
  once asked, and is never asked again, across reloads too. Never after Esc (an `aborted`
  turn is not judged at all), never for a subagent's run, never in `-p` or the SDK, never
  when another turn has started since (a queued message runs first, and its own end is
  judged next), and never about a queued or interrupted message that never reached the
  model: Up pulls a queued message back into the composer with no event to say so, so
  before a re-prompt every such open item has to be found among the session's user
  messages, and one that is not is dropped (resubmitted, it is a new item). Promises show
  and do not gate, unless `CLAUDE_FLEET_LEDGER_PROMISES=gate`, and then only a promise made
  in the latest prompt's turns.
  **Never about an `in-progress` item**: naming it gets the same report back. And no
  re-prompt at all at the end of a turn that the gate's own re-prompt started, one that
  ends asking the person something or waiting on their decision, a lead's turn while its
  workers are still working or waiting on a person, or one within five minutes of the last
  re-prompt. Each of these leaves the items open and un-gated, and the file keeps
  `judge.held` (`gate-turn`, `waiting`, `workers`, `cooldown`)
  with the ids it held back. An item the turn simply never mentioned is still re-prompted
  once.
  **The proof nudge.** A brief the judge reads as answered is never named by the re-prompt
  above; the same re-prompt instead asks for its proof ("a brief from the lead reads as
  answered, but a brief counts as done only with proof: close it with `ledger_close` and a PR
  number, commit or file path, or say what is still missing"). It is bounded the same way and
  in the data: a brief carries `proofAskedAt` once asked and is **never asked again**, however
  many later turns the judge reads it as answered, across reloads too. The holds above apply
  to it (the nudge's own turn is a gate turn, so its end is never re-prompted; nor is one
  inside the five-minute cooldown, which the nudge shares with the re-prompt), so a worker
  that already ended its turn is woken at most once per brief. One that answers the nudge
  in prose keeps the brief open as `[answered, no proof]`, for the lead to see. A nudge held
  back is not spent: the next turn the judge reads the brief as answered may ask. Not sent
  when `CLAUDE_FLEET_LEDGER_GATE=off`.
- **It fails open.** A judge that errors, times out (30 s) or answers anything but the JSON
  asked for closes nothing and re-prompts nothing; the file keeps `judge: { ok: false, why }`,
  the band leads with `judge failing: <why>` while anything is open, the record carries
  `ledger.judge_failing`, and `fleet-ledger list` ends with the last judge's status, failing
  or ok. The ledger is a nag, not a guard.
- **Waiting on the person.** An item the judge reports `in-progress` because it waits on
  the person ("waits on the person: their pick between A and B") leaves the open list and the
  gate as `waiting`, and comes back when the person's message speaks to it. A master's
  waiting items are what an unattended run ends up holding, so they leave the session two
  ways. **On the phone:** `fleet-serve` reads each project's master's ledger (every project
  and profile it lists; workers' items reach the owner through their master), Projects
  carries one `queue · n ›` row (red while any item waits on the owner, grey when every item
  is answered or untouched, absent when nothing is held), and the row opens the queue: the
  project, the ask, how long it has waited, and what the master said it needs. At a desk the
  queue opens in the right pane beside Projects; its `‹`, the same back control a conversation has, returns to Projects; a tapped "waiting on you" notification opens it. Beside them, an item the owner replied to that
  the master has not closed yet, and a request nobody has touched in four hours, but never one
  that is only `[answered, no proof]`: the owner's phone messages reach a master as `fleet`
  items, so each one answered in prose stays open for its proof, and what it still owes is the
  agent's, not the owner's. An item carried from a stopped worker is the master's own request
  by then and is listed by the same rules; its row names the worker and what it last said. A tap replies
  with an ordinary message to that master quoting the item, which wakes it; the owner never
  closes one, and it leaves the list when the master closes or drops it. An item newly
  waiting rings the phone once per project. **In the session:** a short status question
  ("whats the status", "status?", "any update?", "qué falta", "cómo vamos") carries a second
  note, `[ghostfleet ledger: waiting on the person]`, listing those same items with what the
  agent last said about each and the instruction to ask the person each one. Before it, the
  only trace a waiting item left in any prompt was nothing: the open-items note lists open
  items, `/ledger` gave a count, and a status answer had whatever the model still remembered
  of the turn that asked.
- **By hand.** `fleet-ledger [-s socket] [session] [list|all|close <id>|clear]` from any
  shell, by session name on that fleet or by session id; `/ledger` (same verbs) inside the
  session, without a turn. `clear` closes every open item and keeps the history; `all` shows
  who closed each and the proof or reason. Items older than 7 days drop off the band and
  the gate; the file keeps the newest 200.
- **A stopped worker's unfinished items go to its lead.** `fleet-stop` (with or without
  `--reclaim`, and the MCP `fleet_stop`, which runs it) hands each item still `open`,
  `waiting` or `not-done` to the lead's ledger: its sub-lead's when it has one, else
  `master`'s, on the same socket and in that fleet's own directory (another profile is
  another directory, so the dir is resolved from the socket, not from whoever ran the stop).
  Each arrives as an open item `[<worker>] <ask>`, dated at the stop so a two-week-old ask
  lands inside the band, with `carried: { from, state, note }` holding where it came from,
  what it was there, and its last progress or reason; `fleet-ledger master` shows that
  beside it. It is listed and in the lead's prompt note like any other open item, but never
  re-prompted at a turn's end: the lead's turn was not asked it. The lead finishes it,
  re-dispatches it, or drops it with a reason, with the ordinary tools. A carried item is
  `fleet`, so it is **done only with proof** like any brief, whatever it was in the worker:
  the lead's judge reading it as done leaves it open as `[answered, no proof]`, and the proof
  nudge never names it (it is never re-prompted). Done, dropped and
  stale items stay behind. In the worker's file each carried item becomes `carried`, with
  the lead's id, so a second stop never carries it twice. Not retroactive: ledgers of
  workers stopped before this are left as they are.
  When the lead cannot take them, the stop still completes and says so, naming the
  `fleet-ledger --session <id> all` that reads them where they stayed (the worker's own
  ledger, which a stop never deletes): the lead has no status record on that socket; it
  keeps no ledger (codex, an older Claude, `CLAUDE_FLEET_LEDGER=off`; none is created for
  it, since nobody would read it); its file is not readable JSON (never written over); or
  it changed under all five tries of the write.

**The file is not a `*.json`.** `<session_id>.ledger` holds JSON, but eight readers glob
`<fleet dir>/*.json` as status records (fleet-list, the governor, the grid, fleet-read,
fleet-stop, …), and a ledger named `.json` would be read as a session. It is written
atomically, beside itself and renamed over, by the mod and by `fleet-ledger` alike; both
re-read it before each change, so a close from outside is never undone by the mod's next
write. It outlives the session, so `--resume` comes back to the same ledger.

**For readers.** The status record's `ledger` field (`open`, `promises`, `oldest_at` in
epoch seconds) is carried by the shell hook like the mod's other fields, so `fleet-list`,
the grid card and the phone can show it. None of them draws it yet.

| switch | default | effect |
|---|---|---|
| `CLAUDE_FLEET_LEDGER=off` | on | the whole feature: no file, no record field, no `/ledger`, no model call, no re-prompt |
| `CLAUDE_FLEET_LEDGER_GATE=off` | on | record, judge and show; never re-prompt, nor ask a brief for its proof |
| `CLAUDE_FLEET_LEDGER_PROMISES=show\|gate\|off` | `show` | `gate` lets an open promise be re-prompted once too; `off` stops extracting them |
| `CLAUDE_FLEET_LEDGER_MODEL` | `haiku` | the judge's model (an alias or a full id) |

Each is read from the session's environment, so a settings file's `env` block sets it for a
profile and an exported variable for one session. Codex, opencode, agy, cursor, an older
Claude, and an organization that blocks mods have no ledger and behave exactly as before.

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
