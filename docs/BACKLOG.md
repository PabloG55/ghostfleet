# Backlog

The next concrete pieces of work, each sized to one PR. `ROADMAP.md` holds the ideas and the
evidence behind them; this is the queue those ideas turned into, plus the bugs the 0.4.0
cycle found and left open. Every entry says what went wrong, how it was seen, and what
"done" means — a line nobody can check is not a backlog item.

Example names below are the demo data in `web/fixtures/` (`acme-api`, `api-fix`, `master`…).

## Bugs

### 1. `fleet-restart` resumes a conversation id that is stale or empty
A lead was relaunched by `fleet-restart --all` onto an id with **no transcript anywhere** —
recorded when the session had been reopened into a fresh conversation that never took a
turn — so the resume failed and the pane closed, taking the card with it. The real
conversation was the newest transcript in that checkout not held by another live session.
Hibernation fixed the same shape in #14 by reading the id the live process is writing;
restart still trusts the recorded one.
**Done when:** restart takes the id from the live process (and corrects the record), and
when no conversation can be established it **refuses that session with the reason** instead
of killing it.

### 2. `fleet-restart` without a terminal says "Device not configured"
Run from a prompt with no tty, the `[y/N]` read fails on `/dev/tty` and prints a shell
error, then "nothing done". Correct outcome, useless message.
**Done when:** with no tty it says `no terminal to confirm on — re-run with --yes` and
exits non-zero. Ship with 1.

### 3. The suite leaks `fleet-serve` daemons
Eight were found alive on loopback ports, started from test runs in worktrees that had
since been removed — the oldest two days old. The startup sweep does not catch them.
**Done when:** the group that starts them is named, it reaps what it starts on every exit
path (including a killed run), and a suite assertion proves a run leaves no `fleet-serve`
it did not find.

### 4. Editing a PR's description can block its merge
Editing the body fires a second `pull_request` run on the same commit that skips the test
job, which reports a single skipped `test`. GitHub then reads the required
`test (ubuntu-latest)` / `test (macos-latest)` from that newest suite, finds neither, and
reports the PR `BLOCKED` with every required check green. Re-running the real run did not
clear it; a new commit did.
**Done when:** a body edit either re-runs nothing or re-runs the matrix, and a PR edited
after its checks passed stays mergeable.

### 5. Fixed sleeps make two groups flaky on slow runners
The phone gesture helper waits 1s for a card; the agent-column row waits 12s for the
screen. Both went red on the ubuntu leg on branches that did not touch them, and green
on a re-run.
**Done when:** both wait for the thing to appear (with a ceiling), not for a clock.

### 6. The queued-work hook fires when the session is idle
The `UserPromptSubmit` hook from #15 labelled a prompt as "arrived while you were still
working on: …" when no turn was running, and quoted the prompt itself as the task in hand.
**Done when:** the hook adds context only while a turn is genuinely running (measured,
not inferred from a stale status), and never quotes the prompt it is annotating.

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

### 9. `fleet-shots`: one recording per flow, and a better review page
Instead of a folder of stills, the worker records **one video of the whole flow** — every
button of the new feature pressed in order, in the same phone-sized browser — with each step
as a **chapter** (named by what it asked for) you can jump to. Stills only where a step
failed. Approve or reject the **flow**, with an optional note per chapter. The review page is
rebuilt in the phone client's palette and type: video beside the chapter list on desktop,
stacked on a phone; space plays, ←/→ step chapters, `a` approves, `r` rejects.

### 10. Nested leads: a worker can run its own workers
Today `fleet-spawn` refuses from a linked worktree, so a worker that wants a team spawns
from the main checkout and its workers become flat siblings of the lead's — the lead gets
their events and nothing ties them together. Seen with one worker running four children as
siblings. Proposed (awaiting decisions):
- children branch from the **sub-lead's** branch and PR into it; the sub-lead opens one PR
- same fleet, each child tagged with its parent
- the sub-lead's card reads `◆ working · 4 workers · 0 need you`; ⏎ opens its sub-grid
- children's done / need-you go to the **sub-lead's** inbox; the lead sees the rollup
- exactly two levels (a sub-worker cannot spawn)
- stopping a sub-lead asks, then stops and reclaims its children

### 11. Make a folder from the add-project browser
`n` = new folder here: asks a name, creates it, offers `git init` (a root with no git has
nothing to branch worktrees from), lands the cursor on it; `s` selects it as before. And a
type-to-filter, so a home directory with dozens of sibling checkouts narrows as you type.

## Cleanup

### 12. Remove the phone probes
The `__diag` beacons (load / lifecycle / geo) found the Face-ID reload and the iOS 26
viewport bug. Both are fixed on the device. They were shipped to be removed once the fix held.

### 13. A placeholder for the author's home path
Three fixture files and two comments carry a real home path. Harmless, but the placeholder
vocabulary exists for exactly this.
