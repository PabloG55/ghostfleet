# Jarvis — one session above every fleet

Every project in ghostfleet has a lead: its `master` session, which dispatches workers,
merges and unblocks. Jarvis is one level above all of them. You talk to it — typed at the
desk, typed or **spoken** on the phone — and it can see and act across every fleet on every
profile (work, personal and whatever others you run).

```
            you  ── desk (tmux) ── phone (the Jarvis screen, text or voice)
             │
          Jarvis   master of the `jarvis` project, on one profile
             │  fleet_digest · fleet_send reply_to · fleet_spawn · …
   ┌─────────┼──────────────┬──────────────┐
acme-api   acme-web      billing-svc     scratch        ← each project's own master
 master     master          master        master          and its workers
```

## Setting it up

```bash
ghostfleet jarvis          # the first run creates it; every later run opens it
```

The first run makes a small git repo **outside every checkout**, at
`~/.local/share/ghostfleet/jarvis`, registers it as the project `jarvis` on the work profile
(`fleet-jarvis init --profile personal` puts it elsewhere), and writes a marker at
`~/.config/ghostfleet/jarvis`. From then on it is an ordinary project — it has a socket, a
master, the hooks, the MCP tools and a governor like every other — so `ghostfleet jarvis` is
simply a jump into its master. Nothing about your Jarvis is in this repository: the repo
ships the *template* of its contract (`lib/jarvis-contract.md`), and `init` copies it in as
Jarvis's `CLAUDE.md`. Delete the tag comment at the top of that file and it becomes yours;
`init` will not overwrite it again.

`fleet-jarvis status` says where it lives, whether it is running, whether it can hear, and
what is waiting for your yes.

## What it reads: the digest

`fleet-digest` (and the MCP tool `fleet_digest`) is one pass over every profile's fleet
directory — the status files the hooks write, each fleet's inbox, and the asleep / parked /
exited markers — and prints one summary: who needs you (with the note), what is working,
ready, idle, parked, asleep or exited, what finished or was answered since the last look,
and the open PRs the grid's cache already knows. It reads files and asks nothing: no agent
spends a token. Liveness is checked against each fleet's tmux server, so a status file left
behind by a killed session is not reported as a live one. A plain run advances the "since
last look" stamp; `--peek` (the phone's poll) does not.

## When it wakes: only for a need-you

Jarvis is **not** polling anything, and an idle Jarvis costs zero turns. Exactly one thing
wakes it at once: a session anywhere — any project, any profile, a worker or a lead — that
is blocked on you (a permission prompt, a question, a usage limit). The event hook writes a
row into Jarvis's own inbox and sends it one `[fleet] need-you: <project>/<session> — …`
line, debounced like every other wake and deferred (never pasted) while the input box holds
something you are typing.

Finished work does not wake it. Jarvis reads it from the digest when you next speak to it.
If you do want a periodic word, add `batch=900` to the marker: work finishing is then
batched into **one** nudge per 15 minutes. It is off by default because every Jarvis turn
that ends sends your phone a notification.

## Asking across profiles

A question to a project's lead is `fleet_send reply_to: true`. On Jarvis's own profile the
answer comes back as a direct message. Across profiles it cannot: Claude Code's session
registry lives under each config directory, so a session on another profile is simply not
addressable. `fleet-send` knows this and says so, and the event hook relays the answer into
Jarvis's inbox as an `answered` row instead — the contract tells Jarvis to look there.

## The confirm-list — enforced in code

These need your explicit yes, and the tools **refuse** them until one exists:

| action | where it is stopped |
|---|---|
| merging a PR, pushing | the Bash guard (`hooks/jarvis-guard.sh`, wired only into Jarvis's own project settings) |
| `fleet_stop` in any form, `reclaim`, `force` | the MCP dispatch, and `fleet-stop` in Bash |
| removing a worktree or a project | the MCP dispatch, and `fleet-clean --go`, `git worktree remove`, `fleet-project rm` |
| answering a worker's prompt for you | the MCP dispatch (`fleet_answer`), and `fleet-answer` / `tmux send-keys` in Bash |
| more than one new worker per request | the MCP dispatch and `fleet-spawn` in Bash — the first is free |

A refused call becomes a **proposal** with a four-letter id, and the refusal tells Jarvis to
ask you in one line and stop. Then:

- **say or type yes** into Jarvis. What you type at the desk is recorded by the event hook;
  what you type or say on the phone is recorded by `fleet-serve`, which knows it came from
  your enrolled phone (`~/.config/ghostfleet/jarvis.said`). Anything the *fleet* delivers —
  a `[fleet]` line, a relay, a worker or another lead running `fleet-send` into Jarvis, even
  Jarvis itself — is marked by `fleet-send` as it pastes and never counts as you. A **spoken**
  yes must be at least two words ("yes, do it", "go ahead"): a single word is what an open
  microphone hears in noise, and whisper writes it as "Okay."; or
- **tap yes** on the phone's Jarvis screen, which takes a fresh Face ID like any other
  destructive tap. A tapped **no** needs none. (A typed or spoken yes from the phone is as
  strong as the unlock it came through — Face ID within the last fifteen minutes.)

Jarvis then makes the same call again and it goes through — once. A yes you gave *before*
the question does not answer it; one yes answers only the question asked last; an
unanswered proposal expires after ten minutes. Reads, digests and `reply_to` questions need
nothing.

What this is not: every file involved is writable by any process running as you, so it
guards against Jarvis *acting on a misreading*, not against a model working to defeat it.
The Bash guard checks every command of a line and refuses the obvious forgeries — typing
into its own pane (including tmux's short `send`/`pasteb`), touching
`~/.config/ghostfleet`, granting its own proposal; the MCP door refuses `fleet_send` and
`fleet_answer` into its own session outright. A script written to a file and then run is
beyond what a same-user check can honestly promise to catch.

## Talking to it: conversation mode

On the phone, open **Jarvis** from the top of Projects and tap **talk** once:

1. the mic opens, and a voice-activity detector on the phone ends what you said after about
   a second of quiet;
2. the audio goes to `fleet-serve` as a WAV and is transcribed by **whisper.cpp on the Mac**
   — it never leaves your machine, and nothing is kept once it has been turned into text;
3. the words are shown and sent to Jarvis as `(spoken) …`, and the phone says "checking";
4. Jarvis's answer is read aloud with the same voice as the read-aloud button; the mic stays
   **closed** while it speaks, so it never hears itself;
5. the mic opens again. Tap **stop**, or say nothing for twenty seconds, to end it.

It only works **with the screen on and the app open**: an installed web app gets no
microphone in the background, and the screen says so. Text always works.

Voice needs whisper.cpp and a model on the Mac. The installer offers them (never by
`--yes`: it is a ~550 MB download); later, `fleet-jarvis voice --install` does the same —
Homebrew's `whisper-cpp` and `ggml-large-v3-turbo-q5_0.bin` into `~/.local/share/whisper`.
Without them the talk button says how to enable voice.

## Reaching you: notifications

Jarvis's need-you and its answers reach the phone through the existing Web Push, like any
lead's; tapping one from Jarvis opens the Jarvis screen. After an unlock in the installed
app, a **Turn on notifications** band offers the subscription with one tap (iOS only asks
in answer to a tap), and `fleet-phone` reports `notifications: not set up` until a
subscription exists.

## Fresh every day

A long context is the known failure of a session that never ends, and Jarvis is built never
to end. So its fleet's governor restarts it once a day at `restart_hour` (default 4, in the
marker) — only when it has been idle for ten minutes, never on the first sight of a new
Jarvis, and never twice a day. The new session is a fresh conversation; what the old one was
carrying goes forward as `HANDOFF.md` in Jarvis's home, built from the record rather than
asked of the model: the proposals still waiting on you, the last things you said, its last
answers, and the digest at the moment of the restart. `fleet-jarvis restart --dry-run`
prints the handoff without restarting anything.
