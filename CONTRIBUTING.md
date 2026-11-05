# Contributing

Short version: **bugs are very welcome, a bigger feature goes in behind a switch that is
off by default, and a test that cannot fail does not count.**

## What this project is, so the rest makes sense

ghostfleet is one person's daily driver that happens to be public. It is not staffed, it
has no roadmap, and there is no SLA on anything here. I answer issues when I answer them.
Saying that plainly up front is meant to be useful to you: it tells you what a slow reply
means, and it tells you not to wait on me before forking.

MIT means you can take it anywhere, and you do not need my permission or my attention to
do that.

## Bugs

**Please file them, especially on Linux and WSL2.** I develop on macOS, and the class of
bug I cannot find alone is the environmental one — a different tmux, a different coreutils,
a different shell. The single worst offender so far: tmux **≤ 3.5** pushes command output
through `vis(3)`, so the `\x1f` byte this code uses as a field separator comes back as the
four literal characters `\037`, records stop splitting, and the whole row lands in the
first field. Homebrew ships 3.7b and Ubuntu 24.04 ships 3.4, so the identical code looks
"broken on Linux" and is nothing of the kind.

That is why the issue form asks for `tmux -V` before it asks what went wrong.

**Before you paste output:** the Projects screen is your entire project list, and a
screenshot of it publishes every client name on your machine. Read what you paste.

## Features

Fixes and environment support are easy yeses. A bigger feature is welcome too, on one
condition: it goes in behind an experimental switch, and that switch is **off** by default.

The condition is honest self-interest. This is my daily driver, and every option in it has
to keep working across four agents, three platforms and several tmux versions. A feature
that arrives switched off changes nothing for anybody who did not turn it on — me included —
so it can land, be lived with by the people who want it, and earn its place before it costs
everyone else anything. How that is done is the next section, and it is not optional.

Before you build it, open a short issue that describes the shape: what it does, which routes
it adds to `fleet-serve`, what it draws on the phone and in the terminal, and whether it
needs anything new from the login. Agreeing on that first is much cheaper for both of us
than agreeing on it in review, and a "let me ask before I write this" issue is a completely
reasonable thing to open.

## Adding an experimental feature

The three features already behind a switch (`jarvis`, `shots`, `accounts`) follow these
rules; they are written down here so the next one does not have to reverse-engineer them.
`<feature>` below stands for your feature's name.

**1. One switch, one entry.** Add one entry to `FEATURES` in
[`lib/experimental.mjs`](lib/experimental.mjs) — a `name`, a one-line `what`, the `file`
its switch lives in (under `cfgDir()`), a `used()` test, and optionally an `apply(on)` for
whatever turning it on or off must do besides flipping the file. Never a copy of the switch
logic: reading, defaulting and writing it down are `enabled()`, `set()` and `settle()`, once,
for every feature. The rule that file states is that the switch is a file holding `on` or
`off`; with no file yet, an install that has *already used* the feature resolves on and
every other install resolves off, and the first deliberate ask (`install.sh`,
`fleet-experimental`, the feature's own command) writes that answer down. A feature that is
new has no users to protect, so make `used()` look for something only the feature itself can
create, as the `accounts` entry does — then it is off on every install until somebody turns
it on. One entry is all it takes to appear in `fleet-experimental list` and in the
Experimental section of the settings page (`,` on the Projects screen).

**2. Its own module.** The logic lives in `lib/<feature>.mjs`, and so do its HTTP routes:
the module exports one function that takes the request and answers the routes that are its
own, and [`bin/fleet-serve.mjs`](bin/fleet-serve.mjs) gains **one dispatch line** in `api()`
that hands the request to it — not a block of routes. Jarvis predates this rule, and its
routes still sit inline in `fleet-serve.mjs` under "Jarvis: the master of masters". That
is where they happen to be, not a shape to copy.

**3. No second server, no login of its own.** The feature is served by `fleet-serve` and
takes the caller's identity from it. By the time `api()` reaches your dispatch line, the
request has passed the passkey-minted token check and carries `req.client` and
`req.session`; anything destructive asks for a fresh passkey assertion
(`X-Fleet-Assertion`) the way the verbs in `TOOLS_ALLOWED` marked `passkey: true` do. A
paired machine reaches only what `pairAllows()` lets through — `PAIR_READS` and
`PAIR_VERBS` — so a new route is unreachable from another machine unless you add it there
on purpose, and the issue should say why. A feature that needs a new *kind* of identity —
a second person, a device that is not an enrolled phone, a credential no passkey minted —
raises that in the issue before any code is written. That is the part I will most want to
talk through.

**4. Off means gone, not hidden** — the same promise as
[docs/jarvis.md, "The switch"](docs/jarvis.md#the-switch). Switched off:

- every route of the feature answers **404** with `disabled: true` (plus
  `experimental: true` and a `text` saying how to enable it — `disabledWhy()` writes that
  sentence), never a 200 that describes an absent feature, which a client would draw;
- the phone draws nothing for it — no band, no card, no screen, no button;
- the terminal shows nothing for it — no card, no row, no key, apart from its own row in
  the settings page's Experimental section;
- its own command, if it has one, refuses with that same sentence.

The client learns the switch **from the server**, never from a build flag: a field on a
payload it already polls (the way `jarvis_enabled` rides on `/api/projects`), or the 404.

**5. Screens are Preact.** A screen for the feature is a Preact component under `web/src/`,
built by vite (`vite.config.mjs`, `pnpm run build`) into the committed bundle.
[web/README.md, "A build step, for one screen"](web/README.md#a-build-step-for-one-screen)
explains why the build exists and what it costs, and the seam comment at the top of
`web/src/screens.jsx` says where Preact ends and `app.js` begins — read both before adding
a screen. Any client change bumps `VERSION` in `web/sw.js` and re-pins its `CLIENT-HASH`
line; the suite goes red and prints the hash to paste (`test/helpers/pwa-check.mjs`). An
installed phone keeps running its old client until it is relaunched — `CLAUDE.md`,
"Deploying a change".

**6. A test that proves the off state.** In `test/run.sh`, with the switch off: the
feature's routes answer 404 with `disabled: true`, and nothing new is drawn — not in the
payloads the client reads, not on the Projects screen. The suite keeps the switches in the
run's own directory (`CLAUDE_FLEET_EXPERIMENTAL_DIR`), so a test flips them freely without
touching yours. The group "Jarvis is experimental: off by default, and off means gone" is
the model to follow. Then remove the gate in the code, watch the test go red, and only then
trust it.

**7. Graduating.** Once the feature has been stable for a while, it leaves
`lib/experimental.mjs` and becomes an ordinary setting on the settings page. That happens in
**a separate PR**, never folded into a change to the feature itself, so the moment it stops
being experimental is one commit that can be found and reverted on its own — and that PR
carries each install's existing answer over, so nobody's "on" silently becomes "off" or the
other way round.

## Branches

**Open your PR against `staging`, not `main`.** `staging` is the default branch, so a
plain `gh pr create` or the GitHub UI already picks it — this note is for anyone whose
muscle memory says otherwise.

| branch | what it is | how it moves |
|---|---|---|
| `staging` | where everything integrates; the default branch | one PR at a time, suite green on both platforms |
| `main` | the publishable branch — what a release points at | only by a `staging` → `main` PR, at release time |

Both are protected: a pull request is required and both suite legs (`ubuntu-latest`,
`macos-latest`) must pass. Neither can be force-pushed or deleted.

Required checks are deliberately **not** "strict" — you do not have to rebase onto the
tip of `staging` before merging. This repo's whole subject is running agents in parallel,
and a strict gate would make every merge invalidate every other open PR. The trade is
real and worth naming: two PRs can each be green against an older `staging` and still
break it together. That is what the push-triggered run on `staging` is for, and it is why
a red `staging` belongs to whoever is around, not to whoever merged last.

**Releases go `staging` → `main` as a merge commit, never a squash.** A squash would put
a brand-new commit on `main` that shares no history with the branch it came from, so the
*next* release would conflict with everything in between. A merge keeps `main` a genuine
ancestor of `staging` and every release after it trivial. The whole release, through to
npm, is in [docs/releasing.md](docs/releasing.md).

## Arm the pre-push hook, first thing

This repo is public, and it is written by people whose day job is not. Comments, fixtures
and captured panes all want to name the project that produced the bug they document, and
`test/run.sh`'s name sweep exists to refuse that. The sweep reads every file git *tracks* —
which means it is silent about a branch you never checked out and never ran it on.

That gap has been measured, on this repo: 37 branches were once live on the public remote
carrying hundreds of occurrences of names that were on `main` and `staging` nowhere, with
every suite run green throughout. A push is the moment private becomes public, so there is
a check at the push:

```bash
git config core.hooksPath .githooks
```

One command, per clone — `core.hooksPath` is repo-local config and a fresh clone does not
inherit it. Run it before your first push. `.githooks/pre-push` then refuses a push whose
tip tree, *file names*, newly-introduced blobs, commit messages or branch name carry a
withheld name, and prints what it found and where. The last two are worth calling out
because the tracked-file sweep structurally cannot see either one.

It shares the sweep's tokenizer and its one-way digest list rather than carrying a copy, so
there is a single matcher to keep honest. If it fires on an ordinary English word, the list
is in `test/helpers/name-sweep.mjs` and `--digest` prints a line to paste without putting a
name in the diff. To override once, knowing what you are doing: `git push --no-verify`.

## Pull requests

Run the suite first:

```bash
./test/run.sh          # no dependencies, a couple of seconds
./test/run.sh 'some group'      # only the groups whose names contain that
./test/run.sh --shard 2/4       # one of CI's four slices of the whole suite
```

CI runs the suite as four shards per platform. A shard is made of whole groups, balanced by
`test/shard-times.tsv`, and `test (ubuntu-latest)` / `test (macos-latest)` only go green
once every shard has passed and their records show each group ran exactly once. A new group
needs nothing from you: it is charged the table's median until the table is refreshed
(`node test/helpers/shard-plan.mjs times` over a run's `groups-run-*` artifacts). If a group
needs another one's setup, declare it with `# needs:` and the two will share a shard.

Then three things that are unusual enough to state:

**1. A test that can only pass proves nothing.** Every detector assertion in this repo runs
in both directions on purpose — a busy-pane regex is only proven by matching a real busy
pane *and* staying silent on a real idle one. When you add a test, break the code
deliberately and watch it go red before you trust it. If you cannot make it fail, it is not
testing what you think.

**2. Write the commit message about the failure, not the diff.** The diff already shows
what changed. What is worth keeping is what the wrong behaviour was, why it happened, and
why the fix is shaped this way. Most of this history is reliability fixes where the cause
was non-obvious, and that reasoning is the valuable part. Look at `git log` before writing
yours — the house style is obvious once you see a few.

**3. Interactive parts need real verification.** The suite cannot cover the TUI. Drive it
in a scratch tmux pane and send it keys; `node --check` proves syntax, not that a keystroke
does not kill the grid pane. Say in the PR what you actually ran.

`CLAUDE.md` at the repo root is the working notes — it is written for coding agents, but it
is also the most direct list of what has bitten people here and is worth a read before
changing anything load-bearing.

## Security

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting — **Security → Report a vulnerability** on this repository — which opens a private
thread with the maintainer and gives a chance to fix it before it is public.

If that is unavailable to you, open a public issue saying only that you have a security
report and no details, and you will be contacted privately.
