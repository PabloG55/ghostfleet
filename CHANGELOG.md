# Changelog

What changed between releases, and why it might matter to you. Written for somebody
deciding whether to upgrade rather than for somebody reading the diff — the commit log has
the detail, and every entry here names the PR that carries the argument.

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
