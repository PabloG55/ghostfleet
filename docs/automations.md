# Automations — a trigger and steps the fleet runs on its own

> **Experimental — off by default; enable with `fleet-experimental enable automations`** (or
> its row in the Experimental section of the settings page). `fleet-experimental disable
> automations` turns it off again.

An automation is **one trigger and a list of steps**, run in order by `fleet-serve` itself:

- "weekdays at 09:00, send the lead of acme-api: review what is open"
- "when any session in acme-web needs you, tell me"
- "every night at 02:00, start a session in toolbox called nightly-{date} with: run the checks"

It is built on the phone — by taps, or by saying it in a sentence and checking the steps that
come back — and it runs whether or not a phone is open.

## The switch

One global setting, `~/.config/ghostfleet/automations.enabled` (`on` or `off`), in
`lib/experimental.mjs` beside the other experimental features. A new install is off. An
install that already has saved automations resolves to on.

Off means **gone, not hidden**:

- every `/api/automations*` route answers a 404 that says the feature is disabled and how to
  turn it on;
- `/api/projects` says `automations_enabled: false`, and the phone has no menu entry and no
  screen;
- nothing is scheduled and nothing is watched. Saved automations stay on disk and are armed
  again **from the moment the switch is turned back on** — a schedule missed while it was off
  is not run late.

## Triggers

| trigger | what it means |
|---|---|
| on days at a time | `at: "HH:MM"`, `days: [0..6]` (0 is Sunday) |
| once | a date and a time; it switches itself off after |
| every N minutes | 15 minutes at least |
| a session changes | `finished` (working → ready or idle), `need-you`, `started`, `limit`, `interrupted`; in one project or any, one session or any, with a cooldown per session so a flapping session does not fire it twice |

The event trigger reads the same grid the phone draws (`gridJson`), every 8 seconds, for every
registered project. Its steps can name **the event's** project and session (`{project}`,
`{session}`), which is how "when a worker finishes, ask it for a summary" is written once for
every worker.

## Steps

`send`, `spawn`, `pause`, `resume`, `wake`, `interrupt`, `reopen`, `stop` — each is the verb of
the same name, run through the same path a tap on the phone takes (`runVerb` in
`bin/fleet-serve.mjs`), audited the same way, with the client recorded as
`automation:<name>`. Three steps are the automation's own:

- **tell me** — a notice on the phone's automations screen (and a count on its menu entry);
- **wait** — 1 to 60 minutes;
- **continue only if…** — the session is in one of the listed statuses; if it is not, the run
  ends there, which is not an error.

Prompts, names and notices may use `{date}`, `{time}`, `{project}` and `{session}`.

## Start and stop: the passkey is asked at SAVE time

`fleet_spawn` and `fleet_stop` need a fresh passkey assertion on every call from the phone
(§7 of docs/mobile.md). An automation runs with nobody holding the phone, so it cannot ask
then. The rule instead: **saving** an automation that contains a start or a stop, switched on,
needs a fresh assertion (`X-Fleet-Assertion`), exactly as tapping start or stop would. The
approval is stored on the automation and recorded in the audit row (`confirmed:
passkey:<purpose>`). Every edit is a new save and asks again. Without one, the save is
refused with **428** and `needs: "passkey"` — not 401, which the phone reads as a dead session.

Saving one switched off needs no passkey; it cannot run until it is switched on, which is a
save.

## Ask for it in a sentence

The editor's "ask for it" tab sends the conversation and the current draft to
`/api/automations/draft`, which runs one `claude -p` with no tools, no MCP, no settings and
nothing kept (`--no-session-persistence`), given the fleet's projects and sessions and a JSON
schema for the answer. What comes back is normalised by the same code a save uses and put in
the editor as a **draft**: nothing is saved until the owner saves it, and a draft holding
start or stop still asks for the passkey there. One draft at a time.
`CLAUDE_FLEET_AUTOMATIONS_AGENT` replaces the `claude` binary (the suite points it at a stub).

## Safety rails

- A run never overlaps itself: a trigger that fires while the previous run is going is logged
  as skipped.
- 30 runs in an hour switches the automation off with a notice — that is a loop.
- A step that fails ends the run, with a notice.
- At most 20 steps; prompts are capped at 4000 characters.

## Files

`~/.config/ghostfleet/automations/` (`CLAUDE_FLEET_AUTOMATIONS_DIR` moves it), mode 0700:
`automations.json`, `runs.jsonl` (the last runs, trimmed) and `notices.json`, each 0600.

## What it does not do (yet)

- **This machine only.** The routes are not in the paired-host lists, so a phone talking to a
  paired machine through this one cannot reach that machine's automations.
- **No push.** A notice waits on the automations screen; it does not send a notification.
- No terminal screen: automations are built on the phone. `fleet-experimental` switches them.
