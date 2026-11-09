# Changelog

What changed between releases, and why it might matter to you. Written for somebody
deciding whether to upgrade rather than for somebody reading the diff — the commit log has
the detail, and every entry here names the PR that carries the argument.

## Unreleased

**`fleet-restart` no longer loses a session whose old process is slow to exit, and no longer says
it restarted one it lost.** In one restart 22 of 42 sessions vanished, with every fleet reporting
them as relaunched and exiting 0: on a swapping machine the old processes took 20-60 s to exit,
the new launcher gave them 3 s, refused, and closed the pane. Now:

- It waits for the old process before starting the new one, up to 120 s, then sends `TERM` to
  that pid and no other (`CLAUDE_FLEET_RESTART_WAIT`, `CLAUDE_FLEET_RESTART_TERM_WAIT`).
- It counts a session only once an agent is seen on the right conversation, so a restart takes a
  few seconds longer per session (`CLAUDE_FLEET_RESTART_CONFIRM`). Anything else is listed under
  `Failed:` with its reason and the exact command that brings it back, and the exit status is
  non-zero. **A script that reads `fleet-restart`'s exit status can now see a failure.**
- A launcher that refuses a conversation another process holds files a `failed` row in the inbox
  and closes its pane, which then reads as `lost` with the reopen beside it.
- `--reopen` falls back to the newest restart snapshot naming that socket and slot when the slot's
  records name nothing, or name an id with no transcript, and says where the id came from. It still
  never guesses the newest conversation in a folder.
- `--reopen <name>` no longer kills a live session whose name starts with `<name>`.

## 0.7.0 — 2026-11-09

**After upgrading**, the pieces that are long-lived keep their old code until they restart.
`ghostfleet update` runs the install, restarts a launchd `fleet-serve`, offers
`fleet-restart --all` and tells you to relaunch the phone app. A bare `cf-sync` does none of
that. What this release changes, piece by piece:

- **The install:** run `./install.sh`, not only `cf-sync`. `fleet-accounts`, `fleet-know`,
  `fleet-know-event`, `fleet-model`, `fleet-telegram` and `fleet-web` are new commands, and
  each profile's `settings.json` gains two hooks: `PreCompact` (#145) and the Telegram guard
  (#134). An upgrade through npm or `ghostfleet update` does this for you.
- **`fleet-serve` is a daemon: restart it** for everything below that reaches the phone or
  the web, among them the localhost listener (#93), pairing (#99), the terminal (#89), the
  queue (#81, #90), Reviews (#124) and automations (#137). Only a launchd job is restarted
  for you. Run by hand, or under systemd, restart it yourself.
- **The installed phone app runs the client it cached**, and this release takes it from v72
  to v100. Swipe it away and relaunch it, since reopening it from the app switcher is a
  resume and keeps the old one. The launch that fetches the new client can still paint the
  cached one, so if nothing looks different, do it once more.
- **A running Claude session keeps its mod and its MCP server.** `fleet-mod reload --apply`
  moves every idle session onto the new mod, one at a time, and says which it skipped
  (#132). The mod carries the ledger (#83, #108, #109, #117), delivery (#100, #132), the
  memory's writes (#133) and peek (#128). Use it rather than sending `/reload-plugins` by
  hand, which reloads a session on the old mod twice. A reload does not replace the MCP
  server, only a new start does, and that is what `fleet-restart --all` is for: it
  relaunches each session on its own conversation. It is needed for `fleet_know`,
  `fleet_model`, `fleet_project_model`, `fleet_telegram_send` and `fleet_spawn`'s `kind`.
  The same start picks up the context ceiling (#111), a project's default model (#135) and
  the profile's environment (#72).
- **A running grid or Projects screen** keeps the old code until you back out and re-enter
  it. Re-entering a project also restarts its governor, which notices its code changed. The
  tmux bindings and the zellij layout did not change, so neither needs anything.

**This release gives the fleet a memory and makes the web client a place to work.**
`fleet-know` records what the fleet does as it works, so a lead answers "where does acme-api
stand" from that record instead of reading files, and a session's reasons outlive it. The
phone and web client gain a real terminal and editor, a two-pane desk layout, the stack, one
search across machines, and a second machine in the same app. A Telegram chat can talk
straight to a session. Several Claude logins can share a usage limit. And the wake path is
quieter and more honest: a lead hears about a finished worker once, after the worker has
gone quiet, and a wake that did not land says so.

**Behind a switch, and off until you turn it on** (`fleet-experimental enable <name>`, with
the defaults in `lib/experimental.mjs`):

- `accounts`: several Claude logins per profile, moved between at a usage limit (#68).
- `peek`: a pasted `[Image #N]` previewed on hover in Claude Code (#128).
- `know-infer`: a small model reads each finished turn for decisions. It sends that turn's
  text to the model vendor, and only for a project whose memory setting is `include` (#133).
- `know-brief`: a project's lead starts, resumes and comes back from `/compact` briefed
  (#145).
- `automations`: a trigger and steps `fleet-serve` runs on its own (#137).

`jarvis` and `shots` are unchanged: on only if this install had already used them. The
review gate (#122) is off by default too, as a per-project setting rather than a switch. The
memory's own recording is **on**, with no switch; its entry below says how to narrow or stop
it.

### Added

- **The fleet keeps a memory, recording from the day you install** (#133, #140, #142, #152,
  #154). `fleet-know <project>` prints where a project stands: what it is, its sessions,
  branches and PRs, the last deploy, what waits on you, and the decisions that hold, each
  saying who said it (workers' decisions are a count, and `--all` lists them). `waiting`
  lists what waits on you across every project and paired machine, `touched <path>` finds
  who changed a file, `find <text>` searches everything recorded, `history <project>` reads
  it back by day, and `--at` / `--known-at` answer as things stood and as they were known.
  Agents get it as the MCP tool `fleet_know`. The log is per profile, in that profile's
  fleet dir. It goes to a machine you paired, to a session that asks, and with `know-infer`
  on to the model vendor, and nowhere else.
  `fleet-know privacy <project> include|private|exclude` sets what is kept: `exclude` writes
  nothing, and `private` is never sent to a model or across a pairing.
  `CLAUDE_FLEET_KNOW=off` stops it all. Secret-shaped text is scrubbed as it is recorded,
  which does not reach lines already written, and `fleet-know forget <id> [--purge]` takes a
  line back. `fleet-know backfill [--dry-run]` fills in the past from merged PRs, ledgers,
  spawn manifests and git logs; nothing runs it for you. It adds about 10 ms to a turn's
  end, and a project page answers in under 300 ms at 30k events. docs/MEMORY.md.
- **A project's lead can start already knowing your rules (experimental, off)** (#145,
  #152). With `know-brief` on, a lead that starts, resumes or comes back from `/compact`
  gets a briefing of at most 2,000 characters: your standing rules, the decisions from you
  and from leads that still hold, and what waits on you. A worker never gets one.
  `fleet-know rule add|list|accept|close|share-from` keeps the rules, `decide --supersedes`
  and `fact` let a fact close, and your answer to a numbered question becomes a decision.
  `PreCompact` is wired for everyone, and leaves at once with the switch off.
- **A Telegram chat talks to a fleet session, and the session is the bot** (#134, #141,
  #144). `fleet-telegram link <project>/<session>`, then `start`. No second agent decides
  when the session has finished: the reply is the final message of the turn that prompt
  started. Only the allowlisted chat is delivered. A Telegram turn may use only what is on a
  tool list, which starts as reading, the fleet's own tools and writing in a scratch folder,
  so no `Bash`. A guard refuses the rest, including any tool shipped later, and a desk turn
  in the same session is untouched. `config allow` widens it with `Bash(<prefix> *)` entries
  and a `:checkout` scope; docs/TELEGRAM.md says plainly that an editable script plus a
  command entry for it is a remote shell. Photos, any file up to 20 MB, voice notes (with
  your own `transcribe-cmd`, and answered aloud with `speak-cmd`) and replies that keep what
  they quote all arrive. The token comes only from a command you name and is never stored.
  Agents can message you unprompted with `fleet_telegram_send`.
- **Several Claude logins per profile, moved between at a usage limit (experimental, off)**
  (#68, #69, #70, #71, #78, #79, #80, #91, #146). `fleet-experimental enable accounts`, then
  `fleet-accounts add <profile> <name>`. At 97% of a 5-hour or 7-day window the profile
  moves to another login and **nothing restarts**: a running Claude re-reads its login, so
  no session loses its place. While every account has room it spends the allowance that
  expires first. An account that hit a limit is out until its reset, and a planned move does
  not trust a stale reading. With all of them spent, workers (never the lead) are parked and
  resumed at the earliest reset, with one inbox row and one push, unless the project's
  budget is set to ignored. A hand `/login` to a login you have not saved pauses failover,
  and `list` says so. Saved logins live only in the OS secret store, or a mode-600 file on
  Linux. Claude only.
- **What each login has left, on the phone and the web** (#85). With `accounts` on, Projects
  opens with a line per profile (`main · 5h 37% (2h10m) · 7d 42% (Sat)`) and a tap shows
  every account. Read only.
- **Two machines in one app** (#99, #119, #121, #126). `fleet-serve pair --as laptop` on
  one, `fleet-serve pair <url> <code> --as vm` on the other, and `acme-api@vm` sits beside
  your own projects under one passkey: grids, chat, photos, panes, the queue, usage,
  Reviews, and wake, park and resume. The terminal, anything that needs a passkey, and
  project settings do not cross. Requests are signed per direction, both sides audit them,
  plain http is refused except on loopback, and an offline machine is a card rather than an
  error. Push now holds while you are at either keyboard, by tmux activity as well as the
  Mac's input, so Linux holds at all for the first time.
- **A real terminal and editor in the web client** (#89, #106, #107). `Ctrl-a t` opens the
  project's fleet tab and `Ctrl-a n` the editor, behind four gates: off per device, a fresh
  passkey on every open, an Origin check with a one-use 30-second ticket, and only inside
  the fleet's tmux. Idle closes it after 15 minutes. It works on a phone too: at least 64
  columns, pinch or A−/A+, touch as a mouse, and a two-band key row with Ctrl and Alt
  latches. If you audit such things, the CSP gains `style-src 'unsafe-inline'` for it.
- **The web client works at a desk** (#87). At 1024 px and up with a mouse: two panes, the
  grid's keys (web/README.md has the table), ⏎ sends and ⇧⏎ is a newline, images paste and
  drop, and a draft per session survives a reload. The session screen's own letter keys
  (p/P/x/r/l/s/q) are gone; those actions are under `⋯`.
- **The web client on the machine itself, with no tailnet** (#93). `ghostfleet web` opens
  `http://localhost:8787`, with its own passkey (`fleet-serve enroll mac`). It is a second
  listener on loopback, and nothing crosses between the two. A missing tailnet address no
  longer crash-loops the daemon: it retries every 30 seconds, and `fleet-serve check`
  reports it.
- **The stack on the web** (#101). A picker, then up to four columns plus chips at a desk,
  and a swipe between them on the phone.
- **One search finds projects and sessions** (#75, #94, #104). `/` at a desk and a field on
  the phone, by name, label or branch, across paired machines. `/` on the terminal grid
  finds an agent and highlights it in place.
- **The address carries your place, per tab** (#131). A reload lands where that tab was, and
  a link can name a screen, a project or a session. It never skips or previews the passkey
  lock, and no token or message text goes in it.
- **Everything a lead still holds reaches the phone** (#81, #90). A Queue page, with a
  `queue · n ›` row on Projects, red while something waits, and one push per project for a
  new waiting item. A reply goes back naming the ledger item. A short status question to a
  lead ("whats the status") makes it list each one and ask.
- **A review gate, per project and off by default** (#122).
  `fleet-project set <p> review-gate on` and `fleet-review round|pass|stuck|status`:
  `gh pr merge`, a REST or MCP merge, `--auto` and GraphQL are refused unless the last
  verdict at the current head is a pass. It is not a sandbox, and a merge from GitHub's web
  page is not seen.
- **A running session can move to another model and stay there** (#135, #139).
  `fleet-model <session> <model>`, or the MCP tool `fleet_model`. The conversation
  continues, your profile's `settings.json` is put back (a hand `/model` makes that model
  the default for every later session), and the pin survives hibernate, restart and reopen.
  A launch takes the pin, then the model it was spawned with, then
  `fleet-project set <p> model <m|default>`, then the profile's; a master never takes the
  project default. `fleet-list` gains a `MODEL` column. Claude only.
- **A worker's model by the kind of job** (#115).
  `fleet-spawn --kind verify|ci|docs|video|build` with
  `fleet-project set <project> model-<kind> <model|default>`. With neither set, nothing
  changes.
- **A pasted image, previewed while you write (experimental, off)** (#125, #128). A row
  above the prompt lists the draft's `[Image #N]`: hover previews, click opens the system
  viewer, and a sent prompt's images work the same. A borderless window on macOS, terminal
  graphics in Ghostty or kitty outside tmux, a half-block card elsewhere.
  `fleet-experimental enable peek`.
- **Automations (experimental, off by default)** (#137). A trigger — on days at a time,
  once, every N minutes, or a session changing state — and steps the fleet runs on its own
  through the same verb path a tap takes: send, start, pause, resume, wake, interrupt,
  reopen, stop, plus "tell me", "wait" and "continue only if…". Built on the phone by taps
  or by saying it in a sentence. A start or a stop asks for the passkey when the automation
  is saved, since nobody holds the phone when it runs, and again on "run now", since
  somebody does. A missed schedule is not run late, and a run going when it is switched off,
  deleted or edited stops. The sentence builder names only projects whose memory setting is
  `include` to the model vendor. While an enabled automation listens for a session changing,
  each registered project costs one `fleet-grid --json` every 8 seconds.
  `fleet-experimental enable automations`; docs/automations.md.

### Changed

- **Every Claude fleet session now starts with a 300k context ceiling** (#111). It compacts
  around 238k. Measured before the change: 83% of cost was cache reads, and 54% of spend
  came from calls at 500k or more.
  `fleet-project set <project> context-window <size|off|default>`, or
  `~/.config/ghostfleet/context-window`; `off` launches as before, and a value you exported
  is kept. `fleet-meter --context` shows the effect.
- **A worker's DONE now waits for a quiet window before it wakes the lead** (#112). 600
  seconds by default, then one wake naming every worker, dropping any that went busy again
  or that you already read. These nudges were 64% of a lead's turns. A need-you is still
  immediate. `CLAUDE_FLEET_NOTIFY_QUIET=0` or `<sock>.notify-quiet` restores the old timing.
  A wake blocked by text in the input box is held rather than expired, and says so on the
  band and the phone.
- **A turn that ends with its own background job running is WAITING, not DONE** (#130). It
  wakes nobody, and the turn with nothing left running is the DONE, so a lead is not woken
  before the PR exists. If the job outlives 30 minutes, or ends with no turn following, a
  watcher files the DONE. A repeat DONE with nothing new is no row and no wake. If it cannot
  tell, it wakes, as before. The phone's push path is unchanged, so a waiting turn can still
  buzz it.
- **A resume turn that made nothing is RESUMED, not DONE** (#92). It wakes nobody and sends
  no push, and `fleet-inbox` folds them into one line.
- **The ledger holds a brief to its proof, and stops counting what a turn already answered**
  (#82, #83, #108, #109, #117). A brief from the lead is done only with proof, with one
  nudge per brief. A person's message is owed only once it outlives its turn; 75% used to
  close before the next message. Words sent from the phone count as the person's
  (`fleet-send --owner`, only through the passkey door). Waiting items untouched for 24
  hours become `expired`. `fleet-stop` hands a worker's open items to the lead,
  `fleet-inbox` does it for a worker that died, and a merged PR closes them. Items already
  closed keep their state, and `fleet-ledger drop-carried` clears what an older carry left
  behind.
- **A NEED-YOU says who and what** (#76). `permission · Bash command: …`, `question: …`,
  `limit: …`, each with its own immediate nudge, and `fleet-inbox` pins what is pending
  under `NEEDS YOU NOW`.
- **Reviews move into the phone app, and `fleet-shots serve` is retired** (#124, #126,
  #129). A `reviews · n` row behind `shots`, one card per branch, a video with chapters,
  from every paired machine. `fleet-shots serve` now prints `<origin>/#reviews` and exits
  non-zero, so a script calling it will notice. `list`, `verdict` and `--check` stay, and
  your approve of a recorded flow is now enough for `--check`, with any flags printed as
  accepted.
- **Every login lands on Projects** (#105). A back swipe no longer previews the lock screen,
  and Face ID after a cold relaunch no longer reopens the chat. Your draft is kept, and a
  tapped notification still goes where it points.
- **The web client is redesigned on one token system over the same palette** (#102, #103).
  Count tiles wrap two by two on a 320 px phone. The GIFs in the docs still show the old
  client.
- **`fleet-list` starts one `jq` where it started hundreds** (#148). 50 sessions took 122 s
  and take 0.78 s, with byte-identical output.
- **The desk stack picker fits its window** (#96): `↑ N more` / `↓ N more`, `/` to search,
  resize, and held keys count.
- **Talking to a session no longer needs Jarvis on** (#73).
- **The repository is open core now** (#138, #147). Everything is still MIT except `ee/`,
  which holds only its Team License today, so nothing needs a subscription and the npm
  package is MIT-only. Contributions now sign a CLA, by a click on the bot's page.
  docs/LICENSING.md.

### Fixed

- **A fleet runs under its own profile, whoever started its tmux server** (#67, #72). Hooks
  wrote to the default fleet dir, the phone showed no messages and a `--reply-to` question
  was never answered, with no error anywhere. `fleet-restart` and the grid now use the
  fleet's account, not the caller's. The governor corrects the server's environment and
  files one inbox row naming any session still on the old one, with its `fleet-restart`
  line; it restarts nothing itself.
- **With no UTF-8 locale, the fleet read as empty and a working agent as idle** (#151). tmux
  turns a tab and every non-ASCII byte into `_` for such a client, so records stopped
  splitting; and `✻` did not match in the C locale, so an agent switch could replace a
  spinning agent mid-turn. launchd and systemd start daemons with no locale, on any
  platform.
- **A wake that fails says so, and one that does not land is retried** (#95, #123). A wake
  counts only if the session stays up 5 seconds, and a failure reports at once with its last
  lines. A nudge that did not land is retried after 60 seconds and 180 more, then becomes a
  `failed` row and a phone marker. A lead had sat idle for 8 hours behind one. A queued wake
  is followed across a compaction.
- **A brief that opens with a slash command runs it** (#100). `//`, a bare `/` and a path
  are refused, as are the mod's own `/fleet`, `/inbox` and `/ledger`, with a pointer. A
  delivery that fails becomes a `failed` inbox row for the lead.
- **A handed-over `/reload-plugins` runs once, and `fleet-mod reload` finds sessions on old
  mod code** (#132). One send had caused 65 reloads. A deploy bumps no version, so each
  session now records a digest of the code it loaded, and `fleet-mod status` says how many
  are behind. Slash text an old mod refuses is pasted instead of failing, and peek survives
  a reload.
- **A queued prompt survives the drain dying** (#110). `fleet-inbox` lists what was
  stranded, and `fleet-send --requeue <session> <id>`, `--discard` and `--stranded` deal
  with it.
- **`fleet-send` can see a prompt the pane wrapped across rows** (#144). It reported a
  landed send with the prompt still in the box. Prompts under 24 characters, which could
  earn a second Enter and an empty turn, are fixed with it.
- **An agent started from another agent's tool shell files nothing under its name** (#114).
  One worker's nine short probes had filed nine DONEs and woken its lead nine times.
- **The merge guard judges what a command runs** (#116), not the words inside a `fleet-ack`,
  `fleet-send`, `fleet-ledger` or `git commit` message. A chained or `$(…)` merge is still
  refused.
- **An open chat converges to the transcript** (#86). A reply lands while you type, opening
  always loads, sideways scroll and selection survive a poll, and older messages load as you
  scroll up. A repeat read of a 42 MB transcript went from about 1,000 ms to 74 ms.
- **Every sheet has an X and closes on an outside press** (#106), keeping what you typed.
- **A burst of keys is each of them, and the settings pages fit their terminal** (#145,
  #150). `jjj` in one read moved nothing. Both settings pages now keep their title and keys
  at any size.
- **A mouse drag in the editor tab copies** (#74). A keyboard selection does not.
- **`fleet-list`'s MODEL read `?` when installed** (#139), because the symlink hid `lib/`;
  lost sessions were never listed either.
- **Entering a master no longer flashes `duplicate session: master`** (#127).
- **The guard that keeps two panes off one conversation no longer switches itself off on a
  busy machine** (#88, #97), and a worktree's path no longer leaks into the built client's
  comments.
- **`fleet-merged` serves a good cache when `gh` is absent** (#153), rather than exiting.

Nothing to upgrade for: the suite and CI (#77, #84, #98, #143, #149), and docs alone
(#113, #118, #120).

## 0.6.1 — 2026-10-16

**A first install from npm on WSL now goes cleanly.** Four things a fresh
`npx -y ghostfleet-cli --yes` on a new WSL2 distro, with no clone on the machine, tripped
over (#64):

### Fixed

- **`ghostfleet --help` prints its usage and exits** instead of opening the Projects
  screen. And any form that would open a screen with no terminal behind it — `wsl -- bash
  -lc 'ghostfleet'`, a script, a pipe — now exits 1 with "needs a terminal" rather than
  waiting forever on a screen nobody can see. The forms that never needed one (`update`,
  `<project> --plain`, `--sync-check`, `--update-check`) are unchanged.
- **The installer's closing line tells an npx user a command they can run.** It said
  `./install.sh --verbose`, because the npx shim ran the installer from inside the package
  directory; it now runs from your own directory, and an npx install is told
  `npx ghostfleet-cli --verbose`.
- **An npx install no longer points the runtime at npm's cache.** `.source` recorded
  `~/.npm/_npx/<hash>/…`, which npm prunes, after which `cf-sync` asked for a repository
  you never cloned. No pointer is written for the npx cache now, `cf-sync` says to re-run
  `npx ghostfleet-cli` (or `ghostfleet update`) when there is nothing usable to sync from,
  and the "a newer version is on npm" notice, which stayed silent without a pointer, now
  shows for these installs too.
- **A WSL distro that opens as root is called out.** Ubuntu 26.04's WSL image already has a
  UID-1000 user, so the account you create gets 1001, WSL's stored default no longer
  resolves (`getpwuid(1000) failed`) and you land as root — where a ghostfleet install
  would sit in `/root` without your Claude sign-in. The installer now warns when it runs as
  root inside WSL and names the fix, and docs/windows.md leads with
  `wsl --manage <Distro> --set-default-user <you>`, keeping `/etc/wsl.conf` as the fallback
  for older WSL.

## 0.6.0 — 2026-10-14

**This release is mostly about two things: the ledger, and the phone.** The ledger stops
being something a side model guesses at from the turn's prose — the agent now closes its
own items with proof as it works, and the judge only reads what is left — and it stops
recording the fleet's own wake-ups, resends and bare "2"s as asks. The phone client took
most of the rest: it can answer a claude question picker, send several photos in one
message, keep every queued message and take one back to edit, interrupt a turn, and hold a
conversation in conversation mode without cutting the owner off mid-thought. Alongside
that, a lead or a codex session that a crash took down comes back on its own conversation,
never on one another pane has open.

0.5.1 was merged but never published to npm, so if you are upgrading from npm's 0.5.0 its
ledger fix (below, under 0.5.1) arrives with this release too.

**After upgrading**, the pieces that are long-lived keep their old code until they restart:

- a running Claude session keeps the mod and the MCP server it started with —
  `/reload-plugins` in it, or start a new one, for the ledger tools and `fleet_interrupt` /
  `fleet_queue` / `fleet_unqueue`; Jarvis needs a restart for the mod's delivery marking
  (#50);
- `fleet-serve` is a daemon: restart it for the unlock rate limits (#46), `/api/auth/end`
  (#54) and the session queue (#56);
- the installed phone app runs the client it cached: swipe it away and relaunch it, since
  reopening it from the app switcher is a resume and keeps the old one. The first cold
  launch after the upgrade still runs the old client; the one after that locks (#54).

### Added

- **The agent closes its own ledger items, with proof, and the judge is only the backup**
  (#39). The judge was the only way an item closed, and it read the turn's prose rather than
  its work: a commit that landed counted only if the text said so, and every turn that left
  anything open cost a model call. The mod now registers `ledger_close(id, proof)`,
  `ledger_drop(id, reason)` and `ledger_add(text)` (a close with no proof and a drop with no
  reason are refused), each prompt carries a short hidden note of what is open, the judge
  is asked only about what the agent left open — a turn that closed everything makes no
  call at all — and the gate re-prompts only the latest prompt's items. A message with two
  or more plain asks becomes one item per ask. Every close records who made it: `agent`,
  `judge` or `person`.
- **`fleet-ledger close`, `drop` and `add`, for an older session** (#51), with `--session
  <id>`. They run through the same functions the mod's tools use, and close `stale`,
  `waiting` and `expired` items as well as open ones.
- **A claude question picker can be answered from the phone, one tab at a time** (#40). A
  session sitting on an `AskUserQuestion` picker used to show "Nothing to answer": a picker
  whose descriptions wrapped put its selected option further up than the menu reader
  looked. The phone's answer sheet now shows the question and one button per option,
  follows a multi-question picker tab by tab to its Submit step, and takes a typed answer
  for the free-text row. `fleet-answer` no longer adds an Enter after a picker's option
  number — a digit already moves to the next tab, so `3` + Enter answered the next
  question too. A send to a session waiting on a question says "queued behind a question",
  on the phone with a button that opens the sheet.
- **The phone sends several photos in one message** (#48), up to ten, each a tile above the
  box with its own ×. Send waits for every upload and refuses while one is failing. The
  daemon's per-session attachment quota is now at least one whole message: before, ten large
  photos on a machine with no image converter deleted the first six of their own message
  while the rest were still uploading.
- **The phone keeps every queued message, and can take one back to edit** (#56). Two sends
  to a busy session drew one bubble; now each stays, in order, marked `queued · tap to
  edit`, across polls and across leaving the chat. A tap pulls it back into the box and out
  of the fleet's queue (`fleet-send --unqueue`), and says so if it was typed in first. A
  photo's path goes in where the caret was and follows later edits.
- **Interrupt a turn from the phone's ⋯ menu, the lead included** (#56). `fleet-pause
  --interrupt` (and the `fleet_interrupt` tool) sends Escape until the turn ends, and never
  parks or kills — so it is allowed on a lead and on Jarvis.
- **Conversation mode can be talked over** (#60). While an answer is read the mic stays
  open, and the owner talking over it stops the whole reply and starts listening, keeping
  the first word; a tap on the band does the same. The app's own voice is gated out against
  echo measured on a real speaker and mic. **Unchecked on a phone:** whether iOS then plays
  replies through the earpiece rather than the loudspeaker — see the PR before relying on
  it.

### Changed

- **Jarvis restarts when its conversation outgrows `restart_tokens`, not at 4am** (#45). The
  daily restart threw away a good conversation every morning whatever it held. The trigger
  is now the context the model last saw (default 200k tokens), still only when Jarvis is
  idle, and `fleet-jarvis status` shows where it stands. An old marker's `restart_hour` is
  read and ignored.
- **Closing the phone app from the app switcher locks it** (#54). The session token was kept
  in `localStorage`, which survives a kill, so closing the app and looking away for a
  second got the same answer. It is in `sessionStorage` now: a resume stays unlocked, the
  app's own reload to take a new client stays unlocked, a cold launch asks for Face ID. An
  iOS eviction of a backgrounded app is also a cold launch, so it locks too. The token an
  older client left behind is removed and ended on the server on first open.
- **A project card on the phone takes a tap and nothing else** (#55). Ordinary thumb
  movement was reaching a long-press "remove from projects?" and a title drag that the
  server refused with a red banner. Both are gone, with the `x` key; remove stays under
  `⋯ → remove`. Session cards keep all their gestures.
- **Messages enter once, screens slide like iOS, and back no longer flashes white** (#57).
  The phone rebuilds the screen on every poll, so an entrance tied to drawing replayed over
  the whole transcript; a new message now fades in once and a sent one rises from the
  composer. The page's dark background is inline, so a back gesture before the stylesheet
  arrives shows dark, not white. `prefers-reduced-motion` turns the motion off.
- **The phone waits in skeletons instead of loading text** (#58) — the chat, Jarvis's chat
  and the pane draw placeholder bubbles until the first answer arrives — and the composer's
  placeholder is `message…`, which fits on one line at every phone width.

### Fixed

- **A lead comes back on its own conversation, and never on one another pane has open**
  (#47). After a crash, opening a project rebuilds `master` without naming a conversation,
  and on tmux the launcher then took the newest conversation in the folder. In a fleet whose
  cards share one folder that is whichever card wrote last: a lead came back running a
  worker's conversation, the worker's card vanished, and later a lead was launched with
  `--resume` of a conversation that was live in its own card. Claude and codex launchers now
  resume the slot's own recorded conversation first; fall back only to one no other card
  claims and no live process holds; and refuse an explicit id that another process holds.
  Two records for one slot are settled first by a deliberate placement (`fleet-open <id>
  --into <slot>` now records one), then by the conversation's name history (the slot it was
  first named as), and only then by which was written last; `fleet-restart --reopen` does
  the same. Every such choice, and every conversation that moves into another pane's slot,
  is written to `<fleet dir>/slot-claim.log`.
- **A lead is woken when a worker needs it, even with Claude's suggestion in its input box**
  (#49). Claude fills an empty input box with greyed text — `Try "…"` in a new session, a
  suggested next prompt after a turn — and the wake read that text as something a person had
  typed, so it never pasted into an idle lead: it retried for ten minutes and gave up into a
  file nobody reads, while the worker sat on its permission prompt. Grey text now counts as
  empty (real typing is never drawn grey). And a wake that does give up — because somebody
  really is mid-sentence — leaves an `UNDELIVERED` row in that lead's inbox, and
  `fleet-serve` sends it to the phone as a needs-you for the lead.
- **A click on a session card opens it the first time** (#44). The grid refreshes with
  synchronous tmux work that holds the screen for most of a second on a fleet of twenty
  sessions, and a click that landed during a refresh reached it as a press and a release in
  one read — which the screen didn't recognise as a click, so it dropped it. On a 21-session
  fleet that was every combined press-and-release, and half of all clicks. Every screen now
  splits what it reads into separate events first (mouse reports, arrows, ⏎, Esc), and holds
  a mouse report the terminal sent in two pieces until the rest arrives, so the click, the
  arrow typed beside it, and a lone Esc all land. A paste is still one piece of text.
- **A screen never outlives the ghostfleet that opened it** (#43). Kill the launcher while
  the grid or the Projects screen is up and the screen used to carry on in the background,
  repainting every second over whatever ran next in that window — a second `ghostfleet`
  there showed a blank screen and a cursor until the old one was `kill -9`'d. A screen now
  exits within about a second of losing its launcher (or its terminal), hands the shell back
  a normal screen with the mouse off, and leaves the terminal's own modes to whoever owns it
  now. A SIGTERM also exits within a few seconds when a tmux server has stopped answering:
  the refresh's tmux, git and pgrep calls are bounded, instead of holding the screen, and
  every signal sent to it, for as long as tmux took.
- **A codex session the machine killed comes back on its own conversation, the same way a
  claude one does** (#42). Codex has no hooks, so a codex pane left no fleet record: after a
  crash or reboot its conversation was intact on disk but showed nowhere as `lost`, and the
  only way back was `codex resume --last`, which picks the newest conversation in the
  folder. `codex-here` now records the rollout the codex process has open as `<fleet
  dir>/<id>.json`, in the same shape claude's hook writes, and keeps it current if the pane
  starts a new conversation. A dead codex session is then `lost` in `fleet-list`, the grid,
  the phone and the digest, and ⏎ / `fleet_reopen` / `fleet-restart --reopen` / `fleet-open
  <id>` bring it back with `codex resume <id>` in its own checkout. Re-measured on codex-cli
  0.160.1: the rollout is written as the conversation goes (0.146 wrote it only on a clean
  exit), so the codex adapter's `resume` is now `yes`, and an agent switch back to codex
  resumes its conversation too. A conversation already open in another pane is not reopened
  a second time.
- **A reopened session runs as its own agent, under its fleet's config** (#42). The reopen
  now passes the recorded agent explicitly, so it no longer takes whatever agent the
  caller's environment had. When no tmux server is left (after a crash), the one it starts
  loads the fleet's tmux config and the session's profile, not `~/.tmux.conf` and whoever
  ran the reopen.
- **A pane id reused after a crash no longer hides a lost session** (#42). Pane ids restart
  at `%0` with every tmux server, and pids are reused across a reboot, so a new server could
  carry the `%0@<pid>` an old record names. That match now counts only when the record is no
  older than the server holding the pane (tmux's own `start_time`), so a session renamed by
  hand on a running server still is not lost.
- **The phone's chat shows a codex conversation** (#42). `fleet-read` (and so
  `/api/session`) reads a codex rollout's user and assistant messages and drops what codex
  injects itself (the environment block, AGENTS.md).
- **The ledger's judge no longer breaks for good past ~20 open items** (#38). It asked for one
  verdict per open item in a single 700-token reply; past about twenty the reply was cut
  off, dropped whole, and nothing closed, so every later turn failed the same way while the
  band showed only a growing count. It now asks ten items a call, newest first, and keeps
  what a cut-off reply finished. A failing judge is on the band (`judge failing: <why>`) and
  in `fleet-ledger list`, and a promise no judged turn addresses in five closes as `stale`.
  A session's existing backlog is judged on its next answered turn.
- **Promises stop multiplying** (#38). The same follow-up restated in new words each turn was a
  new promise each time, and steps the agent asked the person to take ("still waiting on
  you: run X") were recorded as the agent's own. The judge now names the open promise a
  phrasing restates, a word-overlap check catches the ones it misses, person-addressed
  steps are dropped, and at most five promises are open at once.
- **The ledger's gate stops re-prompting work the session already reported on** (#41). "Open"
  meant both "the turn ignored this" and "the turn reported on it while a worker builds it",
  and the gate re-prompted both, so an agent that had just said "the build is in progress in
  a worker" was told to finish it now and could only say the same thing again. The judge now
  has an `in-progress` verdict: the item stays open, on the band and in `/ledger` (marked
  `[in progress]`), and the gate never names it. There is also no re-prompt at the end of a
  turn that asks the person something or waits on their decision, a turn the gate's own
  re-prompt started, a lead's turn while its workers are still working, or within five
  minutes of the last re-prompt. "I'll wait for your reply" is no longer recorded as a
  promise. An item a turn never mentions is still re-prompted once.
- **Unlocking the phone asks for Face ID inside the tap, and tapping cannot lock the owner
  out** (#46). After an iOS update the installed app stopped unlocking: the button fetched
  its challenge and only then asked for the passkey, which spent the tap, so WebKit
  refused with no sheet and no message — and every further tap was one more challenge,
  until the daemon's auth limit answered 429 to all of them. The challenge is now fetched
  before the tap, one ceremony runs at a time, the error is on screen, and challenges have
  their own rate bucket; only refused assertions count toward the auth limit.
- **The suite stops sending prompts into the live fleet, and a fleet delivery into Jarvis is
  never the owner's yes** (#50). A worker running `test/run.sh` exported its own fleet
  directory, the suite's Jarvis group fell back to it, and a live mod record matched by socket
  name alone — so the real Jarvis received `ok`, recorded as the owner's own words, about a
  hundred times over two weeks. The suite now runs under its own `HOME` with the caller's
  fleet variables unset; `fleet-send` hands a prompt only to the mod of the tmux server it
  addresses; the mod marks what it delivers into Jarvis from inside Jarvis's session; and a
  `.sent` row names its caller.
- **The ledger stops tracking nudges and resends, and stale or waiting items can still
  close** (#51). Measured on one lead's week of ledger (156 items): ten of its fourteen fleet
  items were the same wake-up nudge, a message stopped and resent counted twice, a stale
  promise could never be judged again even after its work landed, an item waiting on the
  person counted as open, and a bare "2" answering a numbered question became an ask of its
  own. A replay of that shape goes from 33 items, 14 open at the end, to 18 items and 1.
- **A phone send that did not arrive says so** (#52). An undelivered `fleet-send` reached
  the phone as a quiet 200; it is now a red toast naming the session, with the typed text
  and photos back in the box. A photos-only message no longer starts with `/` (which the mod
  refuses as a slash command), and background-task notices, compaction summaries and
  slash-command wrappers stop drawing as the owner's bubbles: compactions and runs of tool
  calls are small folded cards.
- **The session screen stays inside the visible area while the iOS keyboard is up** (#53).
  In the installed app the keyboard shrank the visible area but not the screen, so iOS
  scrolled the page and the header went up under the status bar. The screen now takes its
  height from the visible area while the keyboard is up, and the layout is exactly the old
  one when it closes.
- **A picked photo no longer goes missing** (#56). The poll's redraw could drop the file
  input the photo picker belonged to before the pick came back; there is one persistent
  input now, outside everything a redraw rebuilds.
- **The phone app stops pausing the owner's music when it opens** (#59). The first tap
  anywhere claimed the iOS audio session for playback, which interrupts other apps' audio.
  Audio is now claimed only inside a tap that asks for sound (a bubble's speaker, `talk`)
  and given back when the voice ends or is stopped.
- **Conversation mode waits through a pause, and long replies are read to the end** (#60).
  A turn ended one second after the owner stopped making sound, shorter than a breath taken
  to think; the pause is now a setting (3.5 s by default, 1.5–8 s), shown as a draining bar
  that refills when speech resumes, and a tap on the band sends now. Replies were cut at 1200
  characters, so a long one never reached its closing question; they are now read in chunks,
  the next prepared while the current one plays.

## 0.5.1 — 2026-10-08

**After upgrading**, a running session keeps the ledger it loaded: `/reload-plugins` in it
(or start a new one) to get these fixes.

### Fixed

- **The ledger's gate stopped re-prompting requests the session had already answered**
  (#35). The judge now reads every text block of the turn, not only the last, so "the draft
  is above" closes the request the draft answered; a plain status report ("I'll merge once CI
  is green") closes the item as reported-waiting instead of leaving it open; an item is the
  person's own words, with pasted material marked rather than standing in for them; and a
  message stopped with Esc and sent again is one item, not two.

## 0.5.0 — 2026-10-07

**After upgrading**, run `fleet-mod reload` to see which running Claude sessions predate the
mod, then `fleet-mod reload --apply`: a session reaches the mod only by starting after the
install, so everything below that lives in the mod passes the ones already running by.

### Added

- **A request ledger, a one-shot gate and promises** (the mod's ledger, docs/OPERATIONS.md;
  #26). Every message a Claude session receives, typed mid-turn or sent by the fleet, is an
  item until the session finishes it or reports it not done; the band shows
  `ledger · 3 open · oldest …`. At the end of a turn a small model judges which items the
  final message answered, and if any are left the session gets **one** follow-up naming them
  — never a second for the same item, never after Esc, never in a subagent; a judge that
  fails lets the turn end. Commitments the agent makes ("I'll merge when green") are kept as
  promises, shown but not chased unless `CLAUDE_FLEET_LEDGER_PROMISES=gate`. `/ledger` and
  `fleet-ledger [session] list|close <id>|clear` read and close them by hand;
  `CLAUDE_FLEET_LEDGER=off` and `CLAUDE_FLEET_LEDGER_GATE=off` switch it off.

- **`fleet-mod reload` moves running sessions onto the mod** (#29). A dry run by default: a
  table of every live session on every profile with its running Claude version and what it
  would do. `--apply` sends `/reload-plugins` to one new enough to load the mod, and restarts
  an older one onto its own conversation by id; only idle sessions with an empty input box
  are touched, and each row ends ✓ or ✗ by the session's own status record. A process keeps
  the version it started with, so a session older than 2.1.287 cannot load a mod by
  reloading — measured, and the reason this restarts rather than reloads.

- **Changing a project's agent switches its running master** (#27). The settings page's agent
  column, `fleet-project agent` and the `fleet_project_agent` tool used to apply to the *next*
  master only. Now an idle master is restarted under the new agent at once, and a busy one
  after its turn (`switching to codex…` on its card). Each agent's conversation is kept per
  slot, so switching back resumes the one it had — except codex, which cannot resume a killed
  pane and says so. A new agent that fails to start rolls back to the old one, resumed. A
  master can switch itself. Running workers keep their agent.

- **The phone talks to any session, and reads to you in the Mac's voice** (#11, #12, #14).
  Speak mode on every session, not only Jarvis; a play button on every message; Kokoro on the
  Mac picks a voice per sentence, falling back to the phone's own voice when it is not
  installed (`fleet-jarvis voice --kokoro --install`, or the installer's new question, #19).
  Copy one message's markdown, and tables render as tables. Pushes are held while you are at
  the Mac (input in the last two minutes and the screen unlocked), for up to ten minutes.

- **Sessions a crash killed come back as lost cards** (#21). A session from the last seven
  days with a record but no process and no marker shows as lost; ⏎ reopens it on its own
  conversation and `x` dismisses it.

- **`ghostfleet update`** and a folder browser that filters and makes folders (#4).


- **A Claude Code mod that reports a session's state and budget from inside it**
  (`mods/ghostfleet`, docs/OPERATIONS.md "The mod"; Claude Code 2.1.287+). `working`,
  `ready`, `interrupted` and `need-you` come from the turn and permission events themselves
  rather than from a regex over the pane, and the grid, the phone, the digest and
  `fleet-list` prefer them while the session that wrote them is alive, falling back to the
  pane otherwise. The governor reads the engine's own 5h figure, so a narrow pane no longer
  leaves it blind. `/fleet` and `/inbox` answer without starting a turn, mid-turn too.
  `install.sh` installs it into every profile, after backing each one up. The new
  `fleet-mod` command plans it (`--dry-run`), reports it (`status`) or removes it
  (`uninstall`), and `CLAUDE_FLEET_MOD=off` skips it.
  Known gap: in auto mode, a call the classifier decides reads `need-you` until it resolves.

- **A lead's team above its prompt** (the mod's band, docs/OPERATIONS.md "The lead's band").
  A master, and a worker once it has children, draws one line above its prompt:
  `3 workers · 1 working · 1 need you · 2 PRs green`, from the fleet's status records every
  5 s and `gh pr list` every 2 minutes, without starting a turn. It narrows with the pane and
  keeps `need you` in view at any width. `PRs ?` when gh cannot answer. Workers draw nothing.

- **The fleet's guards also run inside Claude, and fail closed there** (the mod's guards,
  docs/OPERATIONS.md "The guards"). Jarvis's confirm-list, "a worker does not merge its own
  PR" and "an agent does not approve another agent's tool call" are now `tool.call` hooks in
  front of Bash and the MCP tools, with the same rules, switches and defaults. A guard that
  cannot decide (git, gh, node or fleet-answer not answering) now **refuses** the call,
  where the shell hook let it through; a session without the mod keeps the shell versions,
  unchanged. One yes is still one action when both run.

- **Prompts delivered through the mod instead of typed into the pane** (docs/OPERATIONS.md
  "Delivering prompts through the mod"). For a Claude session whose mod is live,
  `fleet-send` (and so `fleet_send`, the phone and every nudge) hands the prompt to the mod,
  which submits it as a turn of its own once the session is idle. A half-typed message in the
  box stays where it is. "Could not confirm submit" gives way to the id of the turn the
  prompt started, and a `--reply-to` is armed by that turn rather than by whichever prompt
  comes next. The queue, the outputs and the exit codes are unchanged. `--now` still pastes.
  Sessions without a live mod get the paste, as before, and so does any call with
  `CLAUDE_FLEET_MOD_DELIVER=off`.

- **cursor (Cursor's CLI, `cursor-agent`) as a fifth agent** (docs/multi-agent-sessions.md).
  `fleet-spawn --agent cursor`, the project agent column and the phone's pickers offer it once
  `cursor-agent` is on PATH. `install.sh` writes an event bridge, the ghostfleet MCP server and
  the orchestrate skill into `~/.cursor/` (merging, and keeping each edited file's original as
  `<file>.pre-ghostfleet`); restart and reopen resume a worker's own chat by id across a pane
  kill. One thing short of parity, measured: cursor starts MCP servers without the session's
  environment, so a cursor session's `fleet_*` calls must name the project, as codex's do.
  Also fixed for every fleet that runs cursor at all: `cursor-agent` runs Claude's hooks from
  `~/.claude/settings.json` too, with its own payload, which `fleet-event.sh` read as a stray
  "working" record with no cwd — it now ignores a cursor payload that did not come through
  the bridge.
- **agy (Google's Antigravity CLI) as a fourth agent** (docs/multi-agent-sessions.md).
  `fleet-spawn --agent agy`, the project agent column and the phone's pickers all offer it
  once `agy` is on PATH. It is the first non-claude agent at full parity: `install.sh` writes
  an event bridge, the ghostfleet MCP server and the orchestrate skill into
  `~/.gemini/config/`, `agy -c` resumes per checkout across a pane kill, and its pane signals
  were measured at seven widths — including that its footer says "esc to cancel" while a
  permission dialog is waiting, so busy keys on the spinner instead. New worktrees are
  pre-trusted so a worker does not open on agy's folder-trust prompt.
- **Jarvis** — one conversational session above every project's lead, on every profile
  (docs/jarvis.md). `ghostfleet jarvis` creates it the first time (a small repo outside your
  checkouts, registered like any project) and opens it every time after. It reads
  **`fleet-digest`** / **`fleet_digest`** — one pass over every profile's status files,
  inboxes and markers, no agent asked anything — and is woken **only** by a need-you
  anywhere, so an idle Jarvis costs zero turns. Merging, pushing, stopping, removing,
  answering a worker's prompt and a second worker per request are **refused by the tools**
  until the owner says or taps yes. It restarts fresh once a day while idle, carrying a
  `HANDOFF.md` forward.
- **Nested leads: a worker can run its own workers** (docs/ORCHESTRATION.md). `fleet-spawn`
  from a worker's worktree used to refuse; it now makes a **child** of that worker — branched
  from its branch, PR into it, same fleet, tagged with its parent. The child's done and
  need-you go to the **sub-lead's** inbox and wake it; the top master sees one card reading
  `2 workers · 1 needs you`, and ⏎ (or a tap on the phone) opens the sub-lead's **sub-grid**.
  Exactly two levels: a sub-worker cannot spawn. `fleet-stop` on a sub-lead with workers now
  refuses until `--children`, which stops and reclaims them first. The subagent guard's
  worktree exemption now covers only sub-workers — a top-level worker is pointed at
  `fleet-spawn` like a lead. A sub-lead may merge its **children's** PRs into its own branch
  with *workers can merge* off (base = its branch, head = a child's branch); its own PR
  upward is still its master's to merge. Phone client v49.
- **Conversation mode on the phone**: a Jarvis screen (from the top of Projects) where one tap
  on *talk* runs a spoken conversation — on-device voice detection, transcription by
  whisper.cpp on the Mac (audio never leaves it), answers read aloud. Optional:
  `fleet-jarvis voice --install`, or the installer's new question. Screen on, app open only.

### Fixed

- **A fleet codex session stopped on "Background server has incompatible feature settings".**
  codex's shared background server updates itself, so it can run a newer codex than the one
  on PATH, and every session of the older one then asked whether to restart it (#30). Fleet
  codex sessions now start with `--no-daemon` where codex has the flag, and never restart the
  shared server; `CLAUDE_FLEET_CODEX_DAEMON=1` restores the old behaviour. A codex stopped on
  that dialog, or on 0.160's new folder-trust dialog, reads as need-you rather than ready (#27).
- **The phone signed you out every 15 minutes, in use or not** (#13). The window now slides
  with every request, survives a server restart and resumes on relaunch.
- **A sub-lead's card showed its own pane, not its team** (#20), and **a sub-lead was not
  nudged by its workers** — the most specific nudge setting now wins for a sub-lead, as it
  already did for a master (#22).
- **A cursor session read as working while idle** (#18): its busy pattern matched any glyph
  where cursor's spinner is braille.
- **A conversation sent to the background vanished from the fleet.** Claude Code's
  `/background` (or ← into its agent view) carries a conversation on under a new session id,
  in a process its daemon started earlier with *another* session's environment. The fleet
  kept showing the old conversation, frozen, on the grid, in `fleet-read` and on the phone,
  while the live one's rows went to whichever fleet had started the daemon. The new id now
  takes the slot its old transcript hands it (`continued-in`). The readers follow that line
  too, and a backgrounded session nobody hands off claims no slot at all. The hook now logs
  each silent exit and each record it removes to `<fleet dir>/hook-debug.log`.
- **Hibernation slept a backgrounded conversation on its predecessor's clock, then woke the
  predecessor.** The pane of a conversation sent to the background still says it is in the
  *old* id. So `fleet-hibernate` and the governor dated the slot by a transcript that had stopped
  two days earlier, slept it as idle while the live conversation was six hours old, killed
  the background process running it (its daemon is a child of the pane), and wrote the old id
  into the asleep marker, so the wake resumed a two-day-old conversation. The idle clock,
  the marker and `fleet-restart`'s resume now follow `continued-in` to the newest
  conversation. A conversation a live background process is running is never slept
  (the governor's log says so). A wake from a marker written before this resumes the
  successor. Every dry run had also been deleting the live id's record, which is what removed
  the record the readers above had to learn to read around.
- **Notifications had never been turned on**, because nothing asked. After an unlock the
  installed app now offers *Turn on notifications* with one tap, and `fleet-phone` reports
  `notifications: not set up` until a subscription exists.
- **Apple refused real pushes with HTTP 403.** The VAPID subject defaulted to
  `mailto:ghostfleet@<host>.local`; it is now the server's https origin, and a push service's
  refusal reason is logged instead of discarded. Restart `fleet-serve` to pick it up.
- **A lead could approve a worker's tool call.** `fleet-answer` and the `fleet_answer` MCP
  tool pressed any key into any pane, a permission dialog included. Now, when the pane is
  showing one (claude, codex or opencode), an approving key is refused unless
  `--human-approved` is passed — a flag the MCP tool cannot set — and the refusal prints the
  dialog: the tool and the exact command. Declining still works. Jarvis's question quotes
  the same dialog, and its owner's yes is what lets the approval through; the phone, where
  the owner taps the answer, is unaffected. Needs a **new** Claude session to reach the MCP
  server (see CLAUDE.md, "Deploying a change").
- **A worker could merge its own PR.** `gh pr merge` (and the GitHub MCP merge tool) from a
  session in a linked worktree is now refused by the PreToolUse guard; the lead merges.
  Re-run `./install.sh` to widen the guard's matcher to Bash.
- Both of the above are **settings**, off by default: *workers can merge* and *agents can
  approve tool calls*. Turn either on for a project (`fleet-project set <project>
  workers-merge on`, or the grid's `,` page) or for one worker that is the sub-master of
  its task (`--session <worker>`); its siblings stay blocked, `fleet-rename` carries the
  override and `fleet-stop` clears it. A worker cannot turn them on for itself, and Jarvis
  ignores both. Every refusal names the setting that would allow it.
- **A phone answer could land as a chat message.** The phone answered the prompt it had
  drawn from its last pane poll; if that prompt was answered at the desk or timed out in
  between, "1" and Enter went into the composer as a turn. The answer now carries the
  prompt's fingerprint (kind, tool, command, options, from `/api/pane`), and
  `fleet-answer --expect` re-captures just before sending and refuses "the prompt changed"
  otherwise. An answer with no prompt on screen is refused. The phone's answer sheet shows
  the prompt it is answering. **Relaunch the installed app** (client v47): an older one
  sends no fingerprint, and its answers are refused with a message saying to reload.

### Changed

- **Jarvis and `fleet-shots` are experimental, and off unless you turn them on**
  (docs/jarvis.md "The switch"). `fleet-experimental list | enable <f> | disable <f>`, or the
  Experimental section of the settings page; `fleet-jarvis enable|disable` are aliases. A
  machine that already uses `fleet-shots` (its `<fleet dir>/shots` exists) resolves to on;
  off, every `fleet-shots` subcommand refuses and says how to enable it (`--help` still works).
  For Jarvis, a machine where it is already set up resolves to on and keeps working with no
  action; a new install is off. Off means gone: no band, screen or talk button on the phone (the play button and
  Kokoro stay), every `/api/jarvis*` route a 404, no card for its project, no wakes, its
  guards no-ops, and its session stopped with its conversation kept — enable resumes that
  same conversation. `install.sh` asks about whisper only once Jarvis is on.

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
