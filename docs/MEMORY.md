# The fleet's memory — `fleet-know`

A lead that is asked "where does acme-api stand?" has had two ways to answer: from whatever
happens to still be in its context, or by reading files — the worktrees, the ledgers, the PR
cache, a worker's transcript — every time. `fleet-know` is a third: ghostfleet already sees
every session start, every prompt, every turn end, every spawn, merge and ledger item, so it
writes each of those down as it happens, and answers from that.

```
$ fleet-know acme-api
acme-api@laptop · work profile · acme/acme-api
  what it is   The public REST API behind acme-web: Node and Postgres.
  depends on   billing-svc · used by acme-web
WHERE IT STANDS
  master         need-you  on main  (9m ago)
  docs-pass      done      on docs/setup-pass  (25m ago)
  branch docs/setup-pass (docs-pass) → PR #1184 open: Tighten the README setup section
  PR #1170 merged (fix/csv-export), 1h ago
  last deploy  50m ago — vercel deploy at a1b2c3d4 (master)
OPEN
  waits on you: master needs you: Claude needs your permission to use Bash
  waits on you: PR #1184 (docs/setup-pass) — its worker reported done; waits for review/merge
  waits on you: request waiting on you: "Which plan tier should the rate limit apply to?"
  1 open request:
    "Which plan tier should the rate limit apply to?" (master, 20m ago) [waiting]
DECISIONS
  • Keep the v1 export endpoint until acme-web moves to v2 — acme-web still calls /v1/export  [stated, 2026-03-05]
  • RFC 4180 quoting; no new dependency — what api-fix said it is building from (fleet-ack)  [ack, 2026-03-05]
EARLIER  1 closed request since 2026-02-22 (fleet-know find <text> searches them)
```

That page is the suite's fixture fleet (`test/helpers/know-fixture.mjs`) read at its last
instant; every line of it was derived from recorded events, none was written by hand.

It is one owner per fact: everything lives in the profile dirs that already hold the fleet,
with Node's standard library and nothing else — no notes vault, no other application's data,
nothing sent to GitHub.

## Three layers

### 1. Raw events — the log

One append-only JSONL file per profile, beside that profile's fleet:
`<fleet-dir>/know.jsonl` (so `~/.claude/fleet/know.jsonl` for the work profile,
`~/.claude-<p>/fleet/know.jsonl` for another). A line is never rewritten.

```json
{"id":"k3f9a…","v":1,"t":1772714400000,"kind":"turn.end","machine":"laptop","profile":"work",
 "project":"acme-api","src":{"via":"hook","session":"…","slot":"api-fix","sock":"cf-acme-api"},
 "f":{"branch":"fix/csv-export","repo":"acme/acme-api","status":"done","said":"Opened PR #1170…",
      "files":["src/export/csv.js"],"prs":[{"op":"open","number":1170,"url":"…"}]},"rec":1772714400012}
```

- **`id`** is a hash of the event's content, time and source, so the same fact written twice
  (a hook that fires again, a peer's log fetched twice) is one event, and two different facts
  can never share an id.
- **`t`** is when it happened, **`rec`** when it was written down — the two time axes below.
- **`src`** is the provenance: the session, slot and socket, and which writer (`via`). A PR URL,
  a commit or a ledger id rides in the kind's own fields.

**One writer.** Every event goes through `record()` in `lib/know.mjs`; `fleet-know-event` is
its command-line face, called from:

| path | events |
|---|---|
| `hooks/fleet-event.sh` (detached, see the cost below) | `session.start`, `prompt` (the owner's, never the fleet's own nudges), `need-you`, `turn.end` (with the files edited, PRs opened or merged and deploys run in that turn, read from the transcript since the last Stop), `session.end` |
| `fleet-spawn` · `fleet-ack` · `fleet-stop` | `spawn` (branch, worktree, task, parent), `ack` (what the worker understood, and the decisions it builds from), `retire` |
| `fleet-merged` (the PR cache) | `pr.open`, `pr.merge`, `pr.close` — from what changed between two refreshes |
| every ledger writer (the mod, `fleet-ledger`, the landed and carry passes) | `request.open`, `request.state` |
| `fleet-know describe` · `decide` · `relate` | `project.about`, `decision`, `relate` |
| the inferred pass (layer 3) | `decision` marked `inferred` |

`CLAUDE_FLEET_KNOW=off` in the environment stops every writer, for a run that must leave no
trace.

**The Stop hook's cost.** The hook starts the writer detached and does not wait for it, the
same way it starts the notifier, so a turn's end is not held up by reading its transcript.
Measured on the same Stop payload (40 edits in the turn), before and after alternating, on a
machine at a load average of 8–10:

| | before | after |
|---|---|---|
| spaced 0.8 s apart (a turn's end, realistically) — five rounds of 20 | median 195 ms (rounds 183–206) | median 204 ms (rounds 197–233) |
| back to back, no gap — 30 runs | median 212 ms, p90 299 | median 226 ms, p90 410 |

Spaced like real turns, the difference is inside the spread the rounds show on their own.
Back to back, the detached writer (≈70 ms of its own, 56 of them node starting) competes with
the next hook for the CPU, which is the tail. The writer makes one `git` call per session, not
per event: the folder's repo is cached beside the session's cursor. The suite holds the
property rather than the number — a writer that sleeps for seconds does not hold the hook up.

### 2. The graph — derived, rebuildable

A snapshot JSON beside the log (`<fleet-dir>/know.graph.json`), derived from the events by
code alone — there is nothing in it that is not in the log. Each read folds only the lines
added since the snapshot was written; `fleet-know rebuild` throws it away and folds the whole
log again, and `fleet-know rebuild --check` only compares the two and exits 1 if they differ.

**Folded in time order, not file order.** Lines land in the order their writers *finished*.
The hook's writers are detached, and the mod's ledger writes are fired together, so a close
can reach the log before its open. Folded as they came, a log of the fixture fleet read
backwards kept the worker live, its request open and its merged PR open. So events fold
sorted by (time, id), and the graph is a function of the set of events alone:
`rebuild --check` passes on a log in any order. The cost falls on the incremental read. A new
line older than the last event folded means one rebuild; a carried ledger item, which keeps
the time it was asked, is the usual case. The newest ten seconds of events are kept beside the
snapshot instead of in it and folded into each answer, so writers that race each other by a
few milliseconds never cost a rebuild.

- **Nodes:** project, repo, session, branch, PR, request (a ledger item), decision, deploy —
  plus the file and commit nodes `touched` and a deploy point at.
- **Edges:** session *works-on* branch, branch *has-pr* PR, request *closed-by* PR, project
  *depends-on* project, decision *about* project, deploy *of* commit — and the membership
  edges that say which project each belongs to.

**Bi-temporal.** Every edge carries marks of `[valid-from or valid-until, recorded-when]`:
nothing is deleted, an edge is only closed. A query answers *now* by default; `--at <time>`
answers as things stood then (a PR merged at 13:00 is open in a brief `--at 12:30`), and
`--known-at <time>` as they were *known* then, which is what makes a late-arriving fact (a
peer's log fetched tomorrow) visible as late. The few attributes a brief reads as at a time —
a session's status and last sighting, a request's state — keep their history too.

Two profiles, or two machines, that see the same PR are talking about one node: a repo, a
branch, a PR and a commit are named by the repo, not by where they were seen. A project is
per machine and profile (`acme-api@laptop/work`).

### 3. Inferred facts — off by default

A small model (Haiku) can read each finished turn and record the decisions in it, marked
`inferred` and linked to the turn. It is an experimental switch, off on every install:

```
fleet-experimental enable know-infer
```

It runs in the mod at a turn's end, and the gate fails closed: it calls the model only when
the switch is on **and** the project's privacy answer is exactly `include` — a private or
excluded project, or a privacy lookup that failed, is no call. It costs one Haiku call of at
most 600 tokens per finished turn while on.

## Reading it

| | |
|---|---|
| `fleet-know` | every project it knows, most recent first |
| `fleet-know <project>` | the one-page brief above: what it is; where it stands (live sessions, open branches and PRs, the last deploy); what is open (ledger items, PRs waiting on review); recent decisions with their source. `<project>` may be `name`, `name@machine` or `name/profile` |
| `fleet-know waiting` | everything waiting on the owner, every project and machine |
| `fleet-know touched <path>` | the sessions that touched a file, on which branch, and the PRs that work went into |
| `fleet-know find <text…>` | searches the **raw events**, not only the graph |
| `--at <time>` · `--known-at <time>` · `--json` · `--no-sync` | an instant (ISO, epoch or `3d ago`); data instead of text; skip asking paired machines |

The MCP tool **`fleet_know`** is the same reader (`about`, `waiting`, `touched`, `find`, `at`,
`json`), so a lead restricted to MCP, or a bot answering the owner's messages, asks it the
same way. Its project argument is `about`, not `project`: everywhere else `project` names the
fleet to act in, and the memory answers about every fleet and paired machine at once.

**Why `find` reads the raw log.** Raw text beat an extracted graph on recall, 74% against
68.5%, in the measurement this design started from: an extraction keeps what its author
thought would be asked, and a prompt, a turn's last words or a refused deploy keep everything.
So the graph answers the structured questions, and `find` goes to the words.

**Decay.** A brief stays one page: what closed more than a week before the instant asked about
is counted on the `EARLIER` line, not listed, and `find` still reaches it.

**Writing to it by hand:**

```
fleet-know describe acme-api "The public REST API behind acme-web: Node and Postgres."
fleet-know decide acme-api "Keep the v1 export endpoint until acme-web moves to v2" --why "acme-web still calls /v1/export"
fleet-know relate acme-web depends-on acme-api        # --off closes it
```

## Privacy — include, private, exclude

The graph connects **every profile** by default. Each profile, and each project, can say
otherwise, with three values:

| | recorded | read by this machine's leads | sent to a model vendor (layer 3) | crosses a pairing |
|---|---|---|---|---|
| **`include`** (the default) | yes | yes | only with `know-infer` on | yes |
| **`private`** | yes | yes, and **marked** `[private]` in every answer, text and JSON | **never** | **never** |
| **`exclude`** | **no** | — | — | — |

```
fleet-know privacy                                   # every project, and where its value comes from
fleet-know privacy scratch private                   # one project
fleet-project set scratch know private               # the same switch, beside the project's other settings
fleet-know privacy --profile personal exclude        # a whole profile's default
fleet-know privacy scratch default                   # back to the profile's default
```

The project's setting is a marker beside the fleet's others (`<fleet-dir>/<sock>.know`); the
profile's default is `<fleet-dir>/know.privacy`; with neither, `include`. Every writer reads it
as it writes, so a change applies from the next event with nothing restarted.

**A read applies the stricter of two answers:** the mark an event was written with, and the
project's setting now. So making a project private hides nothing it had already written from
this machine's leads but stops it crossing a pairing at once; switching it to `exclude` stops
new events and hides the old ones from every answer (they stay in the log — nothing is
deleted — and `include` again shows them). Which projects are private is the owner's call; the
switch ships set to `include` everywhere.

## Paired machines

A machine paired through `fleet-serve` (its `PAIRED HOSTS`) is read through the pairing, the
way the Reviews screen lists a paired machine's runs: `fleet-know` asks each peer's
`GET /api/know/events` over the signed request, tags what comes back with that machine, and
merges it in — so `fleet-know acme-api@vm` is a brief about the VM's acme-api, answered here.

- The peer serves only what is `include` **on the peer**, by its own settings as they are now,
  and the receiving side drops anything marked private again on arrival.
- What was fetched is kept here (`<fleet-dir>/know-peers/<machine>.jsonl`), so a peer that is
  asleep or unreachable answers with its last fetched state, marked **stale** with when it
  was fetched — an answer, never an error. A read asks a peer at most every two minutes, and
  one that did not answer is not asked again for a minute, so a dead peer never makes a brief
  wait out its timeout twice. `fleet-know sync` fetches now.
- A paired host never passes on what it fetched from a third: one hop, as every paired request.

## Choices made where the design was silent

- **The hook writes detached; every other path writes synchronously.** The Stop hook is on
  the turn's critical path; `fleet-spawn`, `fleet-merged` and the ledger CLI are not, and a
  synchronous write there means the event is in the log before the command returns.
- **A merge's time is when ghostfleet first saw it** — the `fleet-merged` refresh that found it
  merged, or the `gh pr merge` in a turn — not GitHub's `mergedAt`, which would need a network
  call nothing else on this path makes. Seen again later, by another refresh or another
  profile, it is the same merge with the earlier time.
- **A deploy is either recorded by the script that did it, or a command a turn ran.** This
  repo's own `cf-sync` (and `install.sh`, through it) say so themselves, once a sync has
  succeeded: `fleet-know-event deploy target="ghostfleet runtime" commit=<the commit it
  copied>`. That is the only record that knows the commit, because the usual deploy checks a
  commit out, syncs it and re-parks `HEAD` on a tag in one call, so `HEAD` at the Stop is the
  tag. Nothing is written with `CLAUDE_FLEET_KNOW=off`, without a commit to name, or where
  `fleet-know-event` is not in the runtime. Any deploy script can do the same.
  The fallback is a command a turn ran (`vercel deploy`, `fly deploy`, `supabase functions
  deploy`, `npm publish` and their kin, not `--dry-run` or `--help`, and not one whose result
  was an error), at the commit `HEAD` was at that Stop, which is left out when the same
  command moved `HEAD` (`git checkout`, `switch`, `reset`…). When a script's own record of the
  same project landed in the half hour before, the detected `cf-sync` / `install.sh` deploy is
  not added a second time. The page names a deploy by its short target or verb
  (`ghostfleet runtime`, `npm publish`), never by the head of the command line.
- **An open request is shown by its task, not its opening line.** A brief starts with the same
  boilerplate for every worker, so the line shown is the worker's own `fleet-ack` understood
  line, else the sentence under a `## Task` heading, else the first sentence that is not a
  generic opener, else the branch name. Branch lines use the same rule.
- **A PR from outside the fleet waits on the owner.** `fleet-merged` records who opened each
  open PR (a sidecar beside its cache, so the cache's own columns are unchanged). An open PR
  whose head branch no session or spawn manifest owns, or whose author is not the repo's
  owner, is listed under what waits on you: `PR #1190 from outside-dev waits for review`. A PR
  the project's own workers opened keeps the wording of "its worker reported done".
- **The first PR cache a repo gets records only its open PRs.** Its merged ones are history
  whose merge times are unknown, and inventing them would put three hundred merges at the
  moment the cache was first built.

## What is not built yet

- **Backfill.** Only events from install onward are recorded; the existing ledgers,
  manifests and PR caches are not replayed into the log.
- **Compaction.** The log only grows (a line is a few hundred bytes; a busy fleet writes a few
  thousand a day). Rotating it into segments, with the snapshot as the fold of the closed ones,
  is the next step when it matters.
- **What a project is, automatically** — from its README, via the inferred pass. Today it is
  `fleet-know describe`.
- **Inferred facts for the other agents.** The pass lives in the Claude Code mod; codex,
  opencode, agy and cursor sessions get every recorded event but no inferred decisions.
- **Private across a pairing as an option.** Today private never crosses; a "private but
  shared between my own machines" setting is a deliberate extension, not a default.
- **A session's last words at SessionEnd.** A session ended mid-turn records the end, not the
  transcript tail since its last Stop.
