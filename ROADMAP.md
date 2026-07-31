# Ideas

One-word ideas for ghostfleet. Each is grounded in something that actually bit us
while running the fleet — the evidence line is why it's here, not a guess.

## Top 3 (by time lost / known-bad behavior)

### Doctor
One command that diagnoses the fleet: stale governors, dead `*.governor.pid`, orphan
worktrees, `.parked`/`.sched` markers with no session, mis-routed sockets, sandbox
(EPERM) breakage, a control plane running older code than the runtime.

**Evidence:** every one of those was hand-diagnosed. The two worst were a control
plane started hours before a `cf-sync` (new screens printing actions an old loop
didn't understand — shortcuts silently no-op'd) and `~/Documents` being TCC-protected
so hooks/CLI got "Operation not permitted".

### Handoff
At ~90% context, auto-spawn a successor with a summary of the thread and retire the
old session — for workers *and* the lead.

**Evidence:** sessions repeatedly sat at `ctx:79% / 85% / 94%`. Promoting a fresh
master is manual today (`fleet-open <id> --into master --force`), and a lead that
compacts or dies takes the fleet's inbox/dispatch role with it.

### Pin
Priority per worker so the governor sheds the *least* important one first, instead of
newest-first. Optionally let the lead write the priority order (it knows what's nearly
done); the governor stays dumb and just reads it.

**Evidence:** `fleet-governor` ships with newest-first shedding, which is a coin flip
on what matters — it parked `invite-modal` mid-feature while finished workers idled.

## The rest

### Digest
One rollup across every fleet: who's blocked, what's PR'd, what's stalled, what's
parked. Cheap now that `fleet_projects` can enumerate fleets and read cross-fleet.
**Evidence:** a lead could only see its own fleet, so "how is everything doing" meant
attaching to each project in turn.

### Queue
A backlog the fleet pulls from: a finished worker takes the next brief itself instead
of idling until nudged.
**Evidence:** workers went `ready` and sat there; the lead had to notice and dispatch.

### Train
A merge queue that lands worker PRs in order and rebases the rest on each merge.
**Evidence:** this was being done by hand via a `merger` integration branch, with the
lead resolving the same `api-types`/`api-client` overlaps repeatedly.

### Watch
CI/deploy monitor that pings the lead when checks go red or a deploy fails, instead of
the lead polling for it.
**Evidence:** the lead built a polling watcher and burned its own budget re-checking;
merges were confirmed green by hand.

### Recipe
A saved fan-out plan — N briefs, branch names, models — replayable on a new project.
**Evidence:** each fan-out was re-authored from scratch, and one-shot briefing via
`fleet-spawn --prompt` already proved reliable enough to template.

### Snapshot
Save/restore a whole fleet layout (projects, sessions, branches, what each was for)
across restarts.
**Evidence:** `fleet-worktrees` already reconstructs intent from a manifest; the gap
is rebuilding the live sessions after a machine or zellij restart.

### Forecast
"At this burn you hit the ceiling in ~40 min" — so you can shed deliberately instead
of being parked mid-task.
**Evidence:** the governor only reacts at the threshold; the 5h window ran to 99–102%
and everything stalled together on the shared account.

## Also raised, not yet scoped

- **Cost** — per-project token accounting, so a project's spend is attributable.
- **Weekly** — the governor watches only the 5h window; the weekly cap
  (`7d:79%`) is invisible to it and hit us anyway.
- **Multi-account** — the real ceiling-raiser for parallelism, explicitly out of
  scope for now (single account by choice).

## Native Windows (deliberately not planned)

WSL2 works today — under it this is just Linux. **Native** Windows (cmd/PowerShell, no
WSL) is out of scope by construction, and it's worth writing down why so the answer
doesn't have to be re-derived every time it's asked.

Every capability here comes from tmux: sessions that outlive the window, `capture-pane`
(which is the entire status system — see the pane-vs-mtime problem), `send-keys` for
dispatch, attach/detach, per-project servers, and the key tables behind ^S/^P/^F. tmux is
POSIX-only, so native support isn't a port — it's reimplementing tmux:

- a background **session-host daemon** owning ConPTY handles, since nothing else keeps a
  detached process alive
- a headless terminal emulator (xterm.js) per session, purely so there IS a rendered
  screen to read the way `capture-pane` reads one
- ConPTY writes for dispatch, and the paste-then-submit race re-solved on that path
- attach = render that buffer into the console and forward keys
- ~20 bash scripts rewritten in PowerShell (Git Bash defeats the point — that's POSIX)

Feasible with node-pty + xterm.js (the TUI is already Node), but weeks of work, and it
permanently doubles the platform surface: every feature written twice, every bug twice.

**If demand appears, the cheap move is not a rewrite.** Abstract the session backend
behind five operations — `spawn / list / read-screen / send-keys / attach` — with tmux as
backend #1. A ConPTY backend then becomes additive instead of a fork. Do that refactor
when someone asks, not on spec.
