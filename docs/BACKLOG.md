# Backlog

The next concrete pieces of work, each sized to one PR. `ROADMAP.md` holds the ideas and the
evidence behind them; this is the queue those ideas turned into. Every entry says what went wrong, how it was seen, and what
"done" means — a line nobody can check is not a backlog item.

Example names below are the demo data in `web/fixtures/` (`acme-api`, `api-fix`, `master`…).

## Shipped since this list was written

- **Jarvis**, the queued "master of masters" — one session above every fleet — shipped in #1.
- The six 0.4.0 bugs that were listed here — `fleet-restart` resuming a stale or empty id
  and failing without a terminal, the suite leaking `fleet-serve` daemons, an edited PR
  body blocking its merge, fixed sleeps in two flaky groups, and the queued-work hook
  firing into idle sessions — and the two cleanups (the phone's `__diag` probes, the
  author's home path in fixtures) are fixed in #3.

## Features

### 7. `ghostfleet update`
Nothing tells a clone or an npm install how to update, and every long-lived piece keeps old
code until it restarts. One command: fetch and fast-forward the tracked branch (`main` for
releases, `staging` to follow development), detect a clone from **before the repository was
recreated** (unrelated histories) and say to re-clone, run the install, restart the phone
daemon, offer `fleet-restart --all`, and say to relaunch the phone app. Plus an "Updating"
section in the README, and a one-line notice in `ghostfleet` when npm has a newer version.

### 8. Agents can see and clear asleep sessions
`fleet_stop` already clears an asleep card, but its description does not say so and
`fleet_list` lists only live sessions, so an agent asked to "clean up the asleep ones"
cannot find them. **Done when:** `fleet_list` shows asleep sessions with their age, and the
`fleet_stop` description names the case.

### 9. Reviews: the paired machine's runs too
The Reviews screen (web/README.md, *Reviews*) lists the runs in this machine's fleet dirs.
A paired machine's runs are the next step: the API is shaped for a `host` beside
`profile`/`run`, and the shots routes are deliberately not in PAIR_READS/PAIR_VERBS yet.

### 11. Make a folder from the add-project browser
`n` = new folder here: asks a name, creates it, offers `git init` (a root with no git has
nothing to branch worktrees from), lands the cursor on it; `s` selects it as before. And a
type-to-filter, so a home directory with dozens of sibling checkouts narrows as you type.
