# Changelog

What changed between releases, and why it might matter to you. Written for somebody
deciding whether to upgrade rather than for somebody reading the diff — the commit log has
the detail, and every entry here names the PR that carries the argument.

## 0.4.0 — 2026-09-24

**This release is about sessions that outlive their process.** A session used to be exactly
as durable as the process running it: type `exit` and the card went with it, update Claude
Code and you had no way onto the new binary that did not lose the fleet, rename one and its
conversation could no longer be found, and forty idle sessions held the memory of forty busy
ones. Each of those now ends the *process* and keeps the *conversation*, and the card stays
on screen saying so — asleep, exited, or back. The phone client was rebuilt screen by screen
alongside it, and a first install on a machine with nothing on it now either works or says
exactly what is missing.

Nothing in a config file changes shape: the projects file is read exactly as before, and
every new field has a default that means "what happened before". A handful of commands do
behave differently by default, and those are listed under **Changed** rather than buried.
Hibernation, the biggest new thing here, is **off** until you switch it on.

This entry also covers three changes that reached `main` after the 0.3.0 package was
published and so were in no release until now. They are cited by commit subject, as is
everything from before the repository was recreated; PR numbers below are the new
repository's.

### If you install one thing from this release

**`fleet-restart --all`, once, after you upgrade.** Nothing in this release reaches a
session that was already running: the hooks, the launch contract, the task queue, the
rename fix and the exit handling are all read when a session starts. This relaunches every fleet session onto
the current binary, each one resuming **its own** conversation by recorded id — never
`--continue`, which in a checkout with twelve sessions opens the newest conversation in the
folder for all twelve. A session that was mid-turn is told to continue; an idle one is not
prompted, because starting work nobody asked for is worse than a stale binary; one that was
waiting on you is relaunched, listed by name, and **not** prompted, since the question it
asked lives in the pane and not in the conversation. It writes a snapshot before the first
kill, restarts the session you ran it from last, and `--dry-run` prints the plan. It is also
the answer to every future "I updated Claude Code with the fleet running". ("Twelve sessions
in one checkout, and --continue could reach one of them")

### Upgrading

- **The phone client goes `ghostfleet-v24` → `ghostfleet-v45`.** (v24 is what the 0.3.0
  package actually shipped; its notes said v23.) Same caveat as every release: swipe the app
  away and relaunch, because reopening from the app switcher is a resume, not a navigation.
  The settings sheet shows which client is running. v25 is the first client with a build
  step, and a phone that somehow kept a pre-v25 shell does not degrade, it fails to start —
  relaunching is what fixes it.
- **An installed home-screen icon must be removed and added again, once.** The status bar
  is now opaque (`black`) instead of `black-translucent`, and iOS stores that style inside
  the web clip when you add it, so an existing icon keeps the old bar — and with it the
  unpainted band under the composer — however many times it relaunches. Re-adding it is a
  new client as far as the passkey is concerned, so it asks for an enrolment: run
  `fleet-serve enroll <client> --add` on the desk first. The same applies to a Chrome
  home-screen shortcut. (#11)
- **Hibernation is off by default.** `touch ~/.claude/fleet/hibernate.enabled` to switch it
  on; until then `fleet-hibernate` is a dry run that prints what it *would* sleep and
  `--apply` refuses.
- **Restart the fleet.** `fleet-restart --all`, above. Until a session restarts it runs the
  old hooks and the old contract — so a second task sent to it can still replace the first,
  which is the bug #15 fixes.

### New

- **A second task sent to a busy agent is queued as its own turn, not folded into the
  first.** Claude Code merges a message submitted mid-turn *into* the running turn, and the
  agent reads it as a change of direction — so task A was silently dropped for task B, while
  `fleet-send` said the prompt "will queue after this turn". It now really queues: traffic for
  a working Claude session waits in a per-session queue, and the turn-ending hook delivers the
  next one as its own turn once the composer is empty, carrying any `--reply-to` with it. A
  prompt you type by hand mid-turn is labelled to the agent as queued work rather than a
  replacement. The card says `queued: N` on the desk and on the phone. `codex` and `opencode`
  targets are unchanged, because nothing drains a queue for them. (#15)
- **Hibernation: give the memory back without losing the conversation.** Parking a session
  stopped its tokens and left its process exactly where it was — measured at ~350 MB each
  whether it is thinking or has sat at a prompt for weeks, and 64 of them held 21.75 GB on
  a machine 39.6 of 40 GB into swap while `fleet-pause` reported "idle, zero consumption".
  `fleet-hibernate` ends the process of a session idle past a threshold (48h by default) and
  keeps its conversation; opening its card wakes it by resume-by-id, to a ready prompt in
  about 0.6s at any transcript size. The governor can do it under memory pressure, oldest
  idle first. It vetoes anything it cannot prove is safe — unsent text in the composer, a
  folder with no trust record, a session whose live conversation it cannot establish — and
  it never sleeps a lead (`master`) on a rule: only `fleet-hibernate --apply master -s
  <fleet>` does. A slept session is a card that says `☾ asleep` with `⏎ wakes`, on the desk
  and on the phone, and the new-session screen lists the checkout's asleep and exited
  sessions so you can reopen one from there. (#2, #3, #5, #8, #10, #14)
- **Typing `exit` no longer takes the card with it.** The pane is held, the card stays and
  says `✗ exited` with `⏎ resumes`, and entering the session brings the conversation back.
  `fleet-restart --reopen <session>` does the same from anywhere. ("Typing exit took the
  card with it, and the conversation had nowhere to be seen")
- **`ghostfleet demo` works on a machine that is not the one it was recorded on.**
  `fleet-demo` builds the profile the README opens with — three throwaway repos under
  `~/gf-demo`, named `acme-api`, `acme-web` and `toolbox`, so the fleet you get is the one in
  the pictures. On the phone the demo is hidden as soon as you have real projects, and shown
  in full while it is all there is. ("A first run that shows the product instead of an empty
  screen", "Hide the demo fleet from a real phone, and give the phone client a route into
  it")
- **One install for everything `^N` needs.** The installer (`npx ghostfleet-cli` and
  `./install.sh`) offers Claude Code and Neovim + LazyVim beside tmux and jq; both are
  optional, and `--yes` takes everything. `^N` on a machine with no editor now says so and
  how to fix it, instead of `returned 1`. And `c` on the `+ add project` card, in the folder
  browser and on the first-run screen clones a repo (a URL or `owner/repo`) and registers it
  as a project. (#9)
- **Workers are disposable.** A new task is a new session: `fleet-inbox` lists finished
  workers whose sessions are still live, each with the `fleet-stop --reclaim` that retires
  it, and `--reclaim` now works straight after a squash merge instead of calling the branch
  unpushed for up to ten minutes. (#16)
- **The phone's cards stopped being a picture of a card.** They were the TUI's box art at a
  measured font size — ~210px to state three facts, and the branch lost characters the
  moment a card had a PR. They are native cards now, the agent's last line is readable, and
  the grid's footer of key-letter verbs became a `⋯` sheet in the header, so at 390px the
  grid shows five of nine sessions where it showed three. Verbs that act on one card live in that card's sheet,
  which names the session before it offers anything destructive. Screen changes slide in the
  direction you went, behind `prefers-reduced-motion`. ("The card stops being a picture of a
  card", "The title of a card was the one place a tap did nothing", "The grid spent a third
  of the screen on controls and showed three of nine cards", #6)

### Changed

- **`fleet-send` to a working Claude session queues instead of pasting.** `--now` keeps the
  old paste-into-the-running-turn behaviour. The queue moves with `fleet-rename` and is
  cleared by `fleet-stop`. (#15)
- **`fleet-send` refuses a worker whose task has shipped**, and points at `fleet-spawn`.
  Shipped means a linked worktree that finished a turn since it started, with no open PR,
  and either a merged PR or a clean tree even with `origin/HEAD`. `--anyway` (MCP:
  `anyway: true`) sends it regardless; a same-PR follow-up, a session that has not finished
  a turn, a `--reply-to` question and the master always go through. (#16)
- **`fleet-spawn` refuses to reuse a worktree whose session is busy**, rather than starting
  `<name>~2` next to it — which is what `--reuse` already did. (#16)
- **`interrupted` is yellow, not red.** Red is reserved for `need-you`, the one status that
  means a human must act now. ("interrupted is a warning, not a failure")
- **A session's state record follows its current name.** The hook reads the pane's session
  name on every event instead of the name it was launched with, and records gain a `pane`
  field. Additive; nothing reads it that did not before. (#13)
- **`--json` gains `asleep` and `exited`** beside the status, and `queued` with the count of
  waiting prompts. `STATUSES` is still the same nine. (#8, #15)
- **The installer arms the repo's pre-push hook** when run from a clone, by setting
  `core.hooksPath`. A `hooksPath` already pointing somewhere else is reported and left
  alone. ("The guard was one forgotten command away from being decorative")
- **Building the phone client from a clone needs node 20.19 or newer** (vite's floor), and
  the installer says so before it starts instead of failing inside vite. The published
  package ships the built client and still runs on node 18. `cf-sync` prefers pnpm and falls
  back to npm. (#12, "A rewrite would spend the debugging; one screen at a time does not",
  "Two scars from the build work, and pnpm without making npm a trap")

### Fixed

- **A first install on a bare machine reported success and installed nothing.** On a fresh
  Ubuntu 24.04, `./install.sh --yes` exited 0 having linked zero commands, with a false
  `✓ claude installed` and a list of next steps that did not exist. It now installs node, jq
  and tmux, stops on the one thing it cannot, and names every missing prerequisite in one
  block with one command. (#12)
- **A renamed session lost its conversation.** The name was captured at launch, so after a
  rename `fleet-read` said "no transcript yet", the phone's chat said "No messages yet", and
  hibernation vetoed it for having no conversation id. `fleet-rename` now moves everything
  keyed by the name — the record, the markers, the tabs, pending reply-to markers — from the
  CLI, MCP and the phone alike, not only from the grid. (#13)
- **The phone's bottom band.** On iOS 26 an installed web app with a translucent status bar
  is drawn under the bar but sized to the screen *minus* it, so the bottom strip was outside
  the web view and no CSS could reach it (WebKit bug 301108). The bar is opaque now; the
  colours are unchanged. This is the change that needs the icon re-added, above. (#6, #7,
  #11)
- **Face ID asked twice.** The prompt is an app switch, so the page came back before the
  token it produced had arrived and re-locked itself; and separately, a deployed update
  waited for the app to *unlock* before reloading, which is exactly the transition that
  costs a passkey. Both are fixed. ("Returning from the Face ID sheet locked the app that was
  unlocking", "A Face ID that bought one second of app, and an inset paid for twice")
- **The phone scrolled back to the top every five seconds**, because the grid rebuilt its
  scrolling container on every poll. It keeps the container now. ("The grid rebuilt its
  scrolling container, so the reader had to be rescued")
- **iOS zoomed the page when you tapped the message box**, which read as the chat
  overflowing sideways; nothing overflowed. ("iOS zoomed the page when you tapped the message
  box")
- **The chat had a 1.4px gutter**, and the session header wrapped to three rows at 390px.
  ("The chat had 1.4 pixels of gutter and a column of nothing opposite", "A row that may wrap
  will wrap, and this one wrapped three times")
- **A wake that had worked was about to report failure** and leave the asleep marker over a
  running session, because readiness was read from a footer phrase that permission bypass
  changes. It is read from the composer box now. (#5)
- **`fleet-shots serve` crashed on a stranger's `manifest.json`** in the directory it
  served, instead of skipping it. ("One stranger's file must not take the whole review server
  down")
- **`fleet-send --reply-to` promised a direct reply that could not arrive** across two
  profiles, so the asker waited instead of draining its inbox. It now says which path the
  answer will take. ("A reply that cannot arrive must not be promised")

### Safety

- **The name guards read who a commit is from**, not only what it says: author and committer
  in the pre-push hook, every commit in the suite's sweep, and a CI job that reads a PR's
  title and body before GitHub composes them into history. ("Check who a commit is from, not
  only what it says", "The PR body is the one piece of text that reaches history unread")
- **An image in the docs showed a real fleet**, past every guard, because every guard skipped
  binaries. ("A figure nobody looked at, showing a real fleet, in the docs the whole time")
- **A worktree's `node_modules` link could be committed**, because `node_modules/` matches
  directories and git records a symlink as a file. ("A trailing slash let a worktree's
  node_modules link into history")

### Known

- **The phone client carries a diagnostic beacon**, on by default: a handful of requests
  under `/__diag/…` to your own `fleet-serve`, which logs their paths. Nothing leaves your
  machine. It exists to settle which of two stories the request log tells about a re-lock,
  and comes out once it has; turn it off with `localStorage['gf.diag'] = '0'`. (#1, #4)

## 0.3.0 — 2026-09-18

**This release is about proof.** 0.2.0 taught the phone to survive a real device; this one
is mostly about not having to take an agent's word for anything — what it changed, whether
the page it built actually renders, whether a second model agrees, and whether a name that
should never have left this machine is about to.

Nothing here is breaking. No config file changes shape, and every new field has a default
that means "what happened before". The phone client goes `ghostfleet-v21` → **`ghostfleet-v23`**,
and the same caveat as last time applies: swipe the app away and relaunch, because reopening
from the app switcher is a resume, not a navigation.

### If you install one thing from this release

**`git config core.hooksPath .githooks`.** One command, per clone. It arms a pre-push hook
that refuses to publish a withheld project or client name — from the tree, from a *file
name*, from a commit message, from the branch name, or from a blob added and deleted inside
the same push. It exists because the sweep that was supposed to prevent this reads the files
git tracks, which is the tree you happen to be standing in: 37 branches were live on a public
remote carrying names that were on neither integration branch, with every suite run green
throughout. (#134)

### New

- **`fleet-shots` — photograph a flow and review it one step at a time.** Give it a flow
  file (`goto`, `fill`, `click`, `waitFor`, `expect`) and it drives real Chrome, screenshots
  each step, records the requests the page actually made, and writes a run you open in a
  local server. The review is a **stepper**, not a scrolling list, because a list of five
  screenshots gets skimmed: approve, changes or skip, one at a time, with a rail to go back
  to the one you were unsure about. `changes` deliberately does not advance — the step you
  are rejecting is the one worth writing a note on. A step the run itself flagged clears
  only with a verdict **and** a reason, so a click cannot launder a measured failure, and
  `fleet-shots --check <dir>` exits non-zero until it is genuinely reviewed. (#132, #133)
- **`fleet-review` — ask a different model to read the diff.** A session grading its own
  work is the author marking their own paper. This hands the diff to an installed CLI that
  is *not* the one running, names which model answered, and **refuses rather than faking it**
  when no other agent ships a non-interactive review — an agent with none says so and exits
  non-zero, because prose that looks like a review is worse than no review. (#129)
- **Your own terminal and editor belong on the stack.** `Ctrl-t` and `Ctrl-n` are now one
  per folder rather than one per press, and both are stackable beside the agent. Tabs are
  sessions, so they appear on the stack screen grouped under the session they came from.
  (#128, #130)
- **A worktree gets a teardown**, since it already had a setup hook. (#125)
- **The agent column cycles**, and now says so — a ring drawn as a radio button reads as a
  dead key, so it shows its position. (#127)

### Fixed

- **The phone lost your place in a conversation.** Restoring a scroll position re-read
  `scrollTop` after assigning it so the DOM's clamp would win — right once layout has
  settled, wrong while it is still happening. A rebuilt list measures shorter for a frame,
  the request clamps to 0, and writing that back destroyed the only record of where you
  were reading. One short frame and the place was gone for good, which is why it read as
  "sometimes forgets". It had also been failing its own test one run in three for weeks,
  and `prepublishOnly` runs the suite — so it was quietly killing a third of all releases.
  (#139)
- **`fleet-look` left a headless Chrome behind on every call.** Closing the browser kills one
  of its ten processes; it is now asked to close. (#118)
- **A tab could beget tabs**, because a tab is a session and the origin was only resolved
  conditionally. (#128)
- **A `+` session name is tmux target syntax, not a name** — `has-session` says yes while
  `display-message` answers for a different session entirely. Every reader targets a bare
  name now, and tab names start with `_` so they cannot be read as an expression. (#120)
- **The projects card named the configured agent as though it were the running one.** (#126)
- **The stack screen had mouse tracking on and never read an event.** (#123)
- **An apostrophe truncated the contract to a fifth of itself** and typed a word into every
  session it reached. (#108)
- **The composer grew with the reader's text until send was under the keyboard.** (#98)
- **A `grep` that matched could read as a failure** under `pipefail`, on one runner only:
  `grep -q` closes its input on the first match, the writer takes SIGPIPE, and 141 becomes
  the pipeline's status. The suite now sweeps itself for the shape. (#111)
- **A daemon is parked before the machine dies, not just before the budget does**, and a
  daemon that cannot be reached is reaped rather than left holding a port. (#133)

### Safety

- **Nothing ships that has not been looked at.** `prepublishOnly` ran the suite, but the
  suite read `git ls-files` while `npm pack` reads the working directory — so an untracked
  file inside a published directory reached the registry unswept. The release now asks npm
  what it will ship and reads *that*, including file names and anything shipping that git
  does not track. (#134)
- **A real tailnet address and a live link were in a fixture.** (#103)
- **A subagent is refused where a fleet exists**, not only where the session is already in
  one. (#122)

## 0.2.0 — 2026-08-27

**The phone client stopped being a viewer.** In 0.1.0 it showed you the fleet and let you
answer a prompt. It now tells you when something needs you, reads a message aloud properly,
renders what an agent actually wrote, and takes a photo from your camera roll to a worker.
Most of the rest of this release is the phone learning to survive a real device — a real
text size, a real keyboard, a real rotation.

Nothing here is breaking. The TUI is unchanged except where noted, no config file changes
shape, and every new field has a default that means "what happened before".

### If you install one thing from this release

**The phone must refetch to get any of it.** The shell is served cache-first, so a phone
that already has the app paints the client it cached and revalidates behind it — which is
indistinguishable from an upgrade that did nothing. On iOS, reopening from the app switcher
is a *resume*, not a navigation: swipe the app away and relaunch it. The settings sheet
shows the running client version, which is the fastest way to tell whether you got it:
0.1.0 shipped `ghostfleet-v4` and this one ships **`ghostfleet-v21`**.

### New

- **Push notifications to the phone** for the two events worth interrupting you: a session
  that needs you, and a session that has an answer. A bell, not a feed — one notification
  per burst, and nothing at all while you are looking at the phone. The payload carries a
  state and a name and never transcript text, and `fleet-serve push --detail anonymous`
  reduces it to a count, because a project name is a client name and a lock screen is
  readable by whoever is holding the phone. Setup is in
  [docs/OPERATIONS.md](docs/OPERATIONS.md). (#83)
- **Send a photo from the phone.** A camera beside the composer; the path the photo lands at
  appears in the box before you send, so what reaches the agent is an ordinary prompt that
  names a file. `claude` and `codex` both read images from a path — measured — and the
  composer warns you when you aim one at an `opencode` worker, whose answer depends on its
  model. The original bytes are uploaded and converted **here**, so an iPhone's HEIC is not
  a problem the browser has to solve. (#86, research in #73)
- **Any message can be played aloud**, not just the newest. Tap a bubble to reveal a play
  control; tap another and it moves. A voice picker and a speaking rate live in settings.
  (#78, #82)
- **The Projects screen is tabbed by profile** — `all`, then one per profile, derived from
  your projects file rather than hardcoded, with a `need you` count on a tab that has one.
  Card numbers are unchanged by the tab you are on, because that number is the same one
  `Ctrl-f` counts. (#76)
- **A thinking indicator.** Three dots while a session is working, so the gap between your
  prompt and the answer stops looking like a send that failed. (#80)
- **Pick a project's agent from a screen.** Its master can run `codex` or `opencode`
  instead of `claude` — the plumbing existed and the only way to reach it was editing
  `~/.config/ghostfleet/projects` by hand. It is now a picker on the phone (both for a new
  project and for one that exists) and an `AGENT` column on the TUI's `,` page. Only agents
  actually installed are offered, and each option says what choosing it costs: there is a
  measured capability matrix in
  [docs/multi-agent-sessions.md](docs/multi-agent-sessions.md). (#88)
- **`codex` and `opencode` sessions get the `fleet_*` tools.** The installer registers the
  fleet's MCP server for all three agents now, so a non-Claude master can list the fleet,
  send to a sibling and spawn a worker from a tool call rather than only by running
  `fleet-*` in its own shell. Two things that does *not* buy, both measured rather than
  assumed: **MCP gives tools, hooks give push events** — a codex session can call the fleet
  and still cannot tell it anything, so no inbox row and no master woken — and codex starts
  its MCP server with a **scrubbed environment**, so from codex every call has to name the
  project (`fleet_list(project: …)`) where the identical call from opencode resolves its own
  fleet. `fleet-agent caveat` prints both, and the pickers show it beside the option. (#89)
- **A tablet gets more than one column**, and rotation is no longer pinned to portrait. The
  card is a fixed block of characters, so a wider viewport gets more cards — the same
  arithmetic the TUI does. Phones are one column at every text size, unchanged. (#78)

### Changed behaviour

- **The read-aloud names identifiers instead of spelling them.** A 40-character sha used to
  take about fifty seconds to read out one character at a time; it is now "a commit". Counts,
  PR numbers, versions, percentages and durations survive untouched, because those are the
  numbers you act on. (#72)
- **An assistant's message is rendered, not shown as its source.** Bold, code, links, lists
  and headings were arriving as literal `**` and backticks. Card preview lines are stripped
  rather than rendered — a card is one truncated line, and half a bold inside an ellipsis is
  worse than plain text. (#72, #86)
- **The speaker moved off the composer** and onto whichever message you tapped. The number
  of visible play controls is the same — one — but it is now attached to the message you
  want rather than always the newest. (#78)
- **`fleet-serve` accepts a larger body on one route only.** The photo endpoint takes 9 MB;
  everything else still takes 1 MB. A photo over 6 MB is refused with a message that says
  6 MB. (#86)

### Fixed — bugs you may have hit

- **The phone scrolled sideways and clipped its own controls.** At larger Dynamic Type sizes
  the session bar grew past the width of the screen, and once the page could scroll
  horizontally *every* screen showed a clipped right edge — the send button rendering
  `senc`, the `⋯` half off the edge, the whole app displaced when a sheet opened. The chrome
  is sized in pixels now and the page is forbidden to scroll sideways at all. (#79)
- **Every list lost your place on the 5s poll.** The pane and the chat remembered where you
  were; the projects and grid card lists did not, so a poll landing while you were scrolled
  down threw you back to the top. (#72)
- **"Load 20 older" threw you to the top of the conversation** — the exact thing it exists to
  prevent. (#72)
- **The composer did not grow with the text.** A three-line message showed one line and a
  sliver of the second, because the box was rebuilt from your draft on every poll and never
  re-measured. (#79)
- **A worker's "I am done" nudge could be silently dropped.** The hook looked for the input
  box by scanning the whole pane for a `❯`, which matches every submitted message still on
  screen — and answered "safe to paste" for a pane with no input box at all, such as a shell
  tab. A refusal now defers and re-checks instead of vanishing, and anything undelivered
  leaves a marker. (#77)
- **The iOS keyboard still pans the page**, and that is now deliberate rather than
  unexamined. When you focus the composer, Safari scrolls the page to reveal it, because the
  keyboard is not part of the dynamic viewport. An attempt to hold the layout still against
  that landed and was reverted inside this release — **it never reached a published version,
  so you cannot have hit it** — but it is recorded because of how it failed: on a real
  iPhone it pinned the composer to the *top* of the screen with the transcript black
  beneath it, while passing a completely green suite. No desktop engine pans the way Safari
  does, so the tests were measuring the client's reaction to a fake. The reasoning is kept in
  [docs/mobile.md](docs/mobile.md) so the next person to try does not repeat it. (#81, #85)

### For contributors

- **A support stance, issue forms and `CONTRIBUTING.md`** — one person, no SLA, features
  often declined, said plainly so a later "no" is cheap to say and fair to receive. The bug
  form asks for your OS and `tmux -V` before it asks what broke, because nearly every
  expensive bug here has been environmental. (#74)
- **The suite refuses a client version that is not above `main`'s.** Three merges in one day
  numbered in parallel and `main`'s client version went *backwards*, which on a cache-first
  shell means every phone that already has the app silently ignores the update. (#87)
- The suite also measures the phone's layout in a real headless browser now — no sideways
  overflow on any screen, at two widths and six text sizes. (#79)
- **The comments stopped naming real projects, and the published tarball is what makes
  that a release note.** Fifty-six comment lines across thirteen files cited the case that
  produced a fix by naming the project it happened in, and **twenty-four of those were in
  `bin/`, `hooks/` and `mcp/`** — the directories npm actually ships, so every install
  carried them. They cite the failure now and use `web/fixtures`' own demo names, which a
  reader can open; every measurement in them survived, because what the comment teaches is
  the shape rather than the label. This stops future distribution and recalls nothing: the
  0.1.0 tarball is unchanged, and history is deliberately untouched because #75 measured
  that rewriting it would not remove the blobs anyway — GitHub still serves them from PR
  head refs, and there is a live fork. A rule in `CLAUDE.md` and a check over every tracked
  file keep it that way, and the check stores its list as salted one-way digests: a helper
  holding the names would publish exactly what it exists to remove, in the worst form —
  one machine-readable roster. (#90, #75)
- **The phone harness reproduces its own CI failures on a fast machine.** `main` was red on
  macOS and green on ubuntu for the same commit; the cause was a test firing *half* a
  gesture — a `pointerdown` with no `pointerup`, which is a long-press in the making — which
  armed a confirmation half a second later on a screen the test had already left, where it
  showed up as somebody else's failure three sections away. `GF_SLOW_MS=<n>` adds latency to
  every fetch in the harness and reproduces it in twenty seconds; inert when unset. No
  production code changed, and the app's behaviour was correct throughout. (#92)

## 0.1.0 — 2026-08-22

First published release. The fleet, the TUI, the stack view, the MCP server and the phone
client as a viewer.
