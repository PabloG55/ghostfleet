# The fleet's memory — `fleet-know`

A lead that is asked "where does acme-api stand?" has had two ways to answer: from whatever
happens to still be in its context, or by reading files — the worktrees, the ledgers, the PR
cache, a worker's transcript — every time. `fleet-know` is a third: ghostfleet already sees
every session start, every prompt, every turn end, every spawn, merge and ledger item, so it
writes each of those down as it happens, and answers from that.

```
$ fleet-know acme-api
acme-api@laptop · work profile · acme/acme-api
  what it is   The public REST API behind acme-web: Node and Postgres.  [lead]
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
RULES  most specific wins: project: beats profile beats all
  k861059144ea1cf70  [lead project:acme-api] Rate limits are per API key, never per account  (“per key, an account can have many”)
  k9bca217eb72fdd55  [owner profile] Every change lands through a PR, reviewed — main deploys on push
  1 proposed, not in force (fleet-know rule list acme-api)
DECISIONS
  • [lead] Bill the export endpoint per row — a call can be a million rows  [stated, 2026-03-05]  kb52e4ecb1dfaf259
  • [lead] Keep the v1 export endpoint until acme-web moves to v2 — acme-web still calls /v1/export  [stated, 2026-03-05]  kfcd425e3bda4f21f
  • [worker] RFC 4180 quoting; no new dependency — what api-fix said it is building from (fleet-ack)  [ack, 2026-03-05]  k9a58c7f6f69536e8
FACTS
  deploy.target = vercel-production  [lead, master, 2026-03-05]  k0442b5ca1b2b2165
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
`~/.claude-<p>/fleet/know.jsonl` for another). A line is never rewritten, with one exception:
`fleet-know forget <id> --purge`, for a real leak (see [Forgetting](#forgetting)).

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
| every ledger writer (the mod, `fleet-ledger`, the landed and carry passes) | `request.open`, `request.state`, and a `decision` when the owner answered a question (see [The owner's answers](#the-owners-answers)) |
| `fleet-know describe` · `decide` · `relate` | `project.about`, `decision`, `relate` |
| `fleet-know forget` | `forget`, a tombstone naming the event it covers, and nothing of its text |
| `fleet-know rule add` · `accept` · `close` · `share-from` | `rule`, `rule.accept`, `rule.close`, `rule.share` |
| `fleet-know fact`, and the pairing sync when a peer's state moves | `fact` |
| every read · the briefing · `PreCompact` | `know.read`, `know.brief`, `session.compact`: notes the memory keeps about itself, never folded (see [Reads are visible](#reads-are-visible)) |
| the inferred pass (layer 3) | `decision` marked `inferred` |
| `fleet-know backfill` | `pr.open`, `pr.merge`, `request.open`, `request.state`, `decision`, `spawn`, `retire`, `commit`, each at the source's own time and marked `src.via: backfill` (see [Backfill](#backfill)) |

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

- **Nodes:** project, repo, session, branch, PR, request (a ledger item), decision, rule, keyed
  fact, deploy — plus the file and commit nodes `touched` and a deploy point at.
- **Edges:** session *works-on* branch, branch *has-pr* PR, request *closed-by* PR, project
  *depends-on* project, decision *about* project, deploy *of* commit — and the membership
  edges that say which project each belongs to.

**Bi-temporal.** Every edge carries marks of `[valid-from or valid-until, recorded-when]`:
nothing is deleted, an edge is only closed. A query answers *now* by default; `--at <time>`
answers as things stood then (a PR merged at 13:00 is open in a brief `--at 12:30`), and
`--known-at <time>` as they were *known* then, which is what makes a late-arriving fact (a
peer's log fetched tomorrow) visible as late. The few attributes a brief reads as at a time —
a session's status and last sighting, a request's state — keep their history too.

`--known-at` folds the lines recorded by then, rather than filtering the graph as it stands. A
first-wins attribute such as a PR's `merged` holds one value, so a read that leaned on one reported
things nobody had written down yet. That went unseen while a line's recorded time was its valid time to
the second, and a backfill puts months between them. A fold is the price: `rebuild`'s time, on a flag
somebody reaches for rarely, and a plain read pays nothing for it.

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
| `fleet-know rule list [<project>]` | the rules that apply there, most specific first, and the proposals nobody has accepted (see [Rules](#rules)) |
| `fleet-know fact <project> <key>` | one keyed fact, or `not recorded` (see [Closing a fact](#closing-a-fact)) |
| `fleet-know history <project> [--since <date>] [--until <date>]` | what happened to it, one line each, newest last, grouped by day (see [History](#history)) |
| `fleet-know backfill [--profile <p>] [--since <date>] [--dry-run]` | writes, once: the history this machine already has on record, at the time it happened (see [Backfill](#backfill)) |
| `fleet-know reads [--since <time>]` | what the memory was asked, the questions it could not answer first (see [Reads are visible](#reads-are-visible)) |
| `--at <time>` · `--known-at <time>` · `--json` · `--no-sync` | an instant (ISO, epoch or `3d ago`); data instead of text; skip asking paired machines |
| `--trusted` | a project page narrowed to what the owner or a lead said (see [Who said it](#who-said-it)) |

The MCP tool **`fleet_know`** is the same reader (`about`, `waiting`, `touched`, `find`, `rules`,
`fact`, `history`, `since`, `until`, `at`, `trusted`, `json`), so a lead restricted to MCP, or a bot answering the owner's messages, asks it the
same way. Its project argument is `about`, not `project`: everywhere else `project` names the
fleet to act in, and the memory answers about every fleet and paired machine at once.

**Why `find` reads the raw log.** Raw text beat an extracted graph on recall, 74% against
68.5%, in the measurement this design started from: an extraction keeps what its author
thought would be asked, and a prompt, a turn's last words or a refused deploy keep everything.
So the graph answers the structured questions, and `find` goes to the words.

**Decay.** A brief stays one page, and what leaves it is what stopped being true or was only ever
a guess. What the owner or a lead decided holds until somebody closes it: it never ages out, and
the page lists it first, newest first, at most eight with `+ N more still hold`. A worker's or a
model's decision keeps the seven days it always had. A rule never decays. Requests, PRs and deploys
that closed more than a week before the instant asked about are counted on the `EARLIER` line, not
listed. `find` reaches all of it.

**"Not recorded" is an answer.** A word nothing mentions, a path nothing touched, a project nothing
knows and a key that was never set, or has been retired, all say `not recorded: …`. A retired key
says when it closed and that `--at` reads what it was, and never prints the value itself, because
a stale answer given with confidence is worse than none.

**Writing to it by hand:**

```
fleet-know describe acme-api "The public REST API behind acme-web: Node and Postgres."
fleet-know decide acme-api "Keep the v1 export endpoint until acme-web moves to v2" --why "acme-web still calls /v1/export"
fleet-know relate acme-web depends-on acme-api        # --off closes it
fleet-know decide acme-api "Bill the export endpoint per row" --supersedes <id>
fleet-know fact acme-api deploy.target vercel-production
fleet-know rule add "Every change lands through a PR, reviewed" --scope profile
```

## Who said it

Every decision and fact carries an **`authority`**, which the fold derives from where the event
came from. A field in the event claiming one is ignored, so nothing recorded can promote itself.

| | what earns it |
|---|---|
| **`owner`** | `decide`, `describe` or `relate` run at a person's own terminal (a real TTY, no fleet slot, not inside an agent), a `source` of `prompt`, `ledger` or `reply`, and a ledger request whose source is `user` |
| **`lead`** | written from the `master` slot, and a ledger request whose source is `fleet` |
| **`worker`** | any other slot, every `fleet-ack` whoever ran it, a ledger item a session promised itself, and any write that says nothing about itself |
| **`model`** | the inferred pass |

It fails closed: a writer that loses its context can only understate what it knows.

The project page prints it as a short tag: `• [lead] Keep the v1 export endpoint…`, and
`what it is   …  [lead]`. A relation is tagged only below a lead (`billing-svc, toolbox [worker]`),
because almost every one is a lead's and the tag would be noise. A request carries its authority
in `--json` only.

The DECISIONS list on the page is the owner's and the lead's only. Every worker's `fleet-ack` is
stored as a worker decision, so on a busy project they outnumbered what the owner decided and pushed it
below the cap. The section ends with one line counting what was left out (`+7 from workers: --all`),
and no line when nothing was; `--all` (the `all` argument of `fleet_know`) lists them as before. It is a
read-time filter: nothing stored is rewritten, so a decision recorded before this reads the same, and
`fleet-worktrees` still reads the ack's UNDERSTOOD line from the spawn manifest. `--json` is data an agent
reads, so it keeps every decision, each with its `authority`. `history`, `find`, the briefing, rules,
facts and waits are not filtered.

`--trusted`, or `authority: K.TRUSTED` to `brief()`, narrows the page to the owner's and the
lead's word: decisions, relations, and what the project is. If a worker has described the project
since, it shows the last line a lead or the owner wrote, and if neither ever did, it says so. What
*happened* is not narrowed, because a merged PR is a fact whoever opened it: branches, PRs, deploys
and what waits on the owner stay.

## Rules

A rule is what the owner wants to hold from now on, in every session that will ever start. Rules
used to live in one session's private notes, so every other session asked again. They are their own
event, so that nothing about them depends on when they were said.

```
fleet-know rule add "Rate limits are per API key" --scope project:acme-api --why "…" --quote "per key" --supersedes <id>
fleet-know rule list acme-api
fleet-know rule close <id> --reason "…"
fleet-know rule accept <id>
fleet-know rule share-from personal                  # --off revokes
```

| scope | means |
|---|---|
| `project:<name>` | that project |
| `profile` | every project in this profile |
| `all` | every project in this profile, and in a profile that opted in to this one |

With no `--scope`, the project the session is in, or the profile when there is none. The command
says which it took. `--quote` keeps the owner's words, or the id of the prompt they came from.

- **Most specific wins, and the output says so.** `project:` beats `profile` beats `all`. Nothing here
  reads the rules' meaning, so nothing can tell that two contradict each other: the list prints them
  in the order they win and states that order, and `--supersedes` is how the owner settles it.
- **Who said it decides whether it is one.** The owner's and a lead's rules are live at once. A
  worker's is `proposed`: `rule list` shows it apart, the page counts it, the briefing leaves it out,
  and it becomes a rule when an owner or a lead runs `rule accept`, on their word from then. The
  fold checks this, not the command, so a line written by hand changes nothing.
- **Nobody closes what outranks them.** Owner, then lead, then worker. A worker's `--supersedes` is a
  proposal to replace: the old rule stands until the yes, and a lead cannot say yes to replacing the
  owner's.
- **Rules never decay and are never capped by age.** A closed or replaced rule stays in the log.
  `--at` reads it as it stood, `find` reaches its words, and no reader of the current state shows it.

**Across profiles.** A profile sees its own rules and nobody else's. `fleet-know rule share-from
<profile>`, recorded in the receiving profile's log, makes the other profile's `all` rules apply
here too, each marked with where it came from, until `--off` revokes it. It goes one way. `profile`
and `project:` rules do not cross, since `profile` says *this* profile and `project:` names a project
of its own; nor does another profile's proposal, which is that profile's to accept.

**Across machines, nothing.** A rule is not served to a paired machine, and one that arrives anyway is
not kept: a pairing does not get to put a standing rule in front of this machine's leads.

## Closing a fact

`fleet-know decide acme-api "…" --supersedes <id>` closes the old decision. It leaves the page and
stays readable with `--at`. It is refused aloud, with nothing recorded, for an id nobody has, an id
about another project, one already closed, and one whose author outranks you; a hand-written line
that tries any of them is recorded and changes nothing. Decisions print their id at the end of the
line, so there is something to name.

A **keyed fact** is one value per key, and a new value is the old one closing:

```
fleet-know fact acme-api deploy.target vercel-production     # write
fleet-know fact acme-api deploy.target                       # read, or: not recorded
fleet-know fact acme-api deploy.target --off                 # retire the key
```

A worker cannot overwrite the owner's or a lead's fact. A worker's own keeps the seven days on the
page, and `--trusted` omits it.

**The pairing closes itself.** `syncPeers` writes `peer.<machine>.pairing` when a peer's state
*moves*: a 401 or 403 is `refused`, a good fetch is `paired`. It compares against the peer's own meta
file, so a poll that finds nothing new writes nothing, and the log does not become a heartbeat. No
answer at all and a 5xx say nothing about the pairing, since a machine asleep is still paired. It is
a fact about this machine rather than a project, so it never crosses a pairing and is not in the
briefing; it shows on the page as `[observed]`, and `fleet-know fact <project> peer.vm.pairing` reads
it. A project's own fact of the same key gives way to a later sighting, so `peer.vm.pairing = paired`,
written before that machine started refusing, does not go on reading as current.

## The lead's briefing

A lead that starts, resumes or comes back from `/compact` is told the owner's rules, the decisions
that hold and what waits on the owner, so it stops asking what was already decided. An experimental
switch, off on every install:

```
fleet-experimental enable know-brief
```

What the suite's fixture fleet prints, 810 characters:

```
[fleet] Briefing for acme-api, as of 2026-03-05T13:51:00Z. It REPLACES any earlier briefing in this conversation. Live state comes from fleet_know.
RULES (most specific wins: project: beats profile beats all)
- k9bca217eb72fdd55 [owner profile] Every change lands through a PR, reviewed
- k861059144ea1cf70 [lead project:acme-api] Rate limits are per API key, never per account
DECISIONS THAT HOLD (owner and lead only)
- kb52e4ecb1dfaf259 [lead] Bill the export endpoint per row
- kfcd425e3bda4f21f [lead] Keep the v1 export endpoint until acme-web moves to v2
- k0442b5ca1b2b2165 [lead] deploy.target = vercel-production
WAITING ON THE OWNER
- PR #1184 (docs/setup-pass) — its worker reported done; waits for review/merge
- s-master/2 request waiting on you: "Which plan tier should the rate limit apply to?"
```

- **Who gets it:** a project's `master` in the project's own checkout. A linked worktree is a worker
  whatever it is called, so it gets none, and reads rules on demand through `fleet_know`. Neither does
  another agent's session, whose hook would discard it.
- **When:** the `SessionStart` sources `startup`, `resume` and `compact`, as `additionalContext`. Not
  `clear`, where a person asked for an empty context.
- **What:** rules, owner first; decisions and keyed facts from the owner or a lead only; what waits on
  the owner, without a session's state this minute, which is what `fleet_know` is for. A wait is an
  observed state rather than anybody's word, so it has no authority to filter on. Ids and one line
  each. An excluded project gets nothing; a private one is told to its own lead with the private
  warning.
- **At most 2,000 characters**, whatever the log holds. Claude Code turns hook output over 10,000 into
  a file the model is not asked to read, so a log that grew past that would quietly brief nobody.
- **A rule is the last thing cut.** A rule the lead was not told about is one it breaks, and a waiting
  item it was not told about is one `fleet_know` still lists. Sharing the cap by turns got that
  backwards: with 13 rules and 8 waiting items it cut the 3 oldest rules while every waiting item
  showed. So rules claim their room first, and decisions and waits share what is left, closing with
  `+N more: fleet_know`. A long rule gives up the end of its text before any rule gives up its line,
  but not past 48 characters of it.
- **When rules alone will not fit,** one line says so, and the lines kept are the front of the order the
  rules always print in: the owner's before a lead's, then `all` and `profile` before `project:`, then
  the newest. Every other section still gets its heading and one line, however many rules there are,
  so 500 rules cannot hide that something waits on the owner, and the count says how much more does.
- **It replaces the earlier one.** The header says so, because after a resume the old briefing is
  still in the conversation. So a resume or compact where everything an earlier briefing could have
  named has closed says that nothing holds, rather than saying nothing and leaving the old rules
  standing. A log with nothing on record stays silent.
- **It cannot hold up a session start.** The read is this profile's snapshot alone, no paired machine
  and no file saved, and the hook holds it to about a second from outside the process, since a read
  that hangs also blocks any timer set inside it. Over budget, or on anything that goes wrong, it
  prints nothing and writes down why. A missing, empty, torn or unreadable log prints nothing and
  errors nowhere. `CLAUDE_FLEET_KNOW_BRIEF_BUDGET_MS` moves the budget.
- **Every briefing is an event:** `know.brief` with the session, the source, the character count and
  the ids it named, or no characters and the reason. There is no holdout: every lead gets it while the
  switch is on, and that record is what a later evaluation compares sessions by.

Wall clock of the real command, cold-started the way the hook starts it, on an Apple M5 Pro running
other work (load average between 5 and 50 over the run), in the log's shape from
`test/helpers/know-bench.mjs`. A miss for want of a snapshot is not repeated, because the writer that
records it also catches the snapshot up. Going by these numbers, a caught-up read reaches the budget
around 450k events, and from there every briefing misses and says so; rotation is the way past that:

| events | snapshot caught up | no snapshot at all |
|---|---|---|
| 3k | 76 ms | 110 ms |
| 30k | 158 ms | 361 ms |
| 90k | 265 ms | 895 ms |
| 300k | 630 ms | 2.6 s, so it prints nothing and records why |

## Surviving a compaction

With `know-brief` on, the fleet's `PreCompact` hook prints one instruction for a lead's summary: keep
the owner's decisions and rules with their ids, the open asks and the PR numbers in flight. Claude
Code appends what the hook prints to the compaction's own instructions. Every tracked session records
a `session.compact` event with its trigger. The `SessionStart` that follows, source `compact`, briefs
again.

`install.sh` wires the event for everyone, and with the switch off the hook leaves at once: no output,
no event, no change to the session's status. A `PreCompact` is new to the hooks, so an install from
before this needs `./install.sh` once.

## Reads are visible

Every read command and every `fleet_know` call records a `know.read`: the verb, the query, scrubbed
like any other text, the hit count and the calling session.

```
fleet-know reads                  # questions with no answer first
fleet-know reads --since 7d
```

The zero-hit list is what the memory is missing. The same question twice is one row with a count,
and asking for the report is not itself a read.

`know.read`, `know.brief` and `session.compact` are notes the memory keeps about itself, and they
stay out of everything else: never folded, so never on a page and never activity on a project; not
searched by `find`, which would otherwise start finding its own questions; never sent to a paired
machine or kept from one. A read still appends a line, so past 64 KB of them the snapshot's mark
moves on, or a log nobody else writes to would be rescanned from the same place by every read.

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

**Crossing a pairing takes a second switch as well.** `fleet-project set <name> pair hide` keeps a
project from paired machines altogether, not only its memory ([mobile.md](mobile.md#several-machines-one-app-fleet-serve-pair)).
An event crosses only when its project is `include` here **and** `share` there; `private` keeps
meaning what the table says, whatever the pairing setting is. A relation (`depends-on`) that
names a hidden project stays on this machine too, even when the project it belongs to is shared.
As with `private`, an event a paired machine fetched before the project was hidden stays in that
machine's copy.

## Secrets

A prompt and a turn's text are stored as written, and the log crosses pairings. So
`record()` replaces token shapes with `[redacted:<kind>]` before anything reaches the disk, at
any depth of the event (a deploy's command, a PR's title, a file path), and before the text cap,
because half a token cut by the cap no longer matches its shape and is still a leak.

The shapes are one table, `SECRET_SHAPES` in `lib/know.mjs`: private-key blocks, JWTs, Telegram
bot tokens, GitHub tokens, `sk-…` keys, AWS keys, Slack tokens, `Bearer <long>`, and
`password=`/`token=`/`secret=` pairs with a long value. Adding a row is the whole change; the
suite goes red until the row has a sample, which also proves it matches. A value that is a
reference (`$DB_PASSWORD`, `<token>`) or short (`token=abc123`) stays, because a shape that eats
prose would cost more than it saves.

The table does not reach back. A line written before it existed stays as it was on this
machine, until `fleet-know find` shows it and `forget --purge` removes it. It is scrubbed again on
its way across a pairing, in both directions, so a line from before the table never crosses as
it was.

## Forgetting

```
fleet-know find <text…>             # prints each event's id at the end of its row
fleet-know forget <event-id>        # the event drops out of every answer
fleet-know forget <event-id> --purge
```

**`forget`** appends a tombstone. The event leaves the graph, `find` and what a paired machine
can fetch; a line landing later under the same id stays out, and the snapshot is rebuilt without
it at once. The line itself stays in the log, so an ordinary forget can be undone by hand.

**`--purge`** is for a real leak: it also rewrites that one line, keeping its id, time and
project and dropping its text. Every other byte of the file stays as it was, torn lines included.
It writes a temp file beside the log and renames it into place, and keeps no backup. A writer
running all the while loses nothing: the copy catches up with what landed behind it, whatever
reached the old file past the rename is carried across after it, and a writer that writes after
that last look sees that its file is no longer the log and writes the line again. That last case
is a window of microseconds, and it lost a line in three purges of ten under a writer in a tight
loop before writers looked. The same line twice is one event. A session that loaded its code
before this has no such look, so it can still lose a line that way until it restarts.

**A paired machine that already fetched the event keeps its copy until it fetches the
tombstone.** A read asks a peer at most every two minutes, and a machine that is asleep asks when
it wakes, so the copy can outlive the forget by that long. A tombstone holds only the id it
covers, so it crosses whatever the project's privacy setting says. When it arrives, the cached
line is rewritten the way `--purge` rewrites one, whether or not the machine that sent it purged
its own.

**A tombstone is scoped to the file it is in**, which is the file holding its target. One that
came from a paired machine lands in that machine's cache and can only take what came from it. If
it applied everywhere, a paired machine could erase this machine's own memory by naming an id.
Forgetting a cached copy here takes it from this machine's cache only: the machine it came from
still holds it, and the next fetch does not bring it back.

`CLAUDE_FLEET_KNOW=off` refuses aloud and writes nothing: off means no writer writes.

## The owner's answers

A question the owner answered is a decision, and a lead that has to ask it again is the failure this
memory exists to prevent. So an answer becomes a `decision` with authority `owner`, carrying the answer
and the question it answered, and the page and the briefing print it as such:

```
- kb52e4ecb1dfaf259 [owner] The owner already answered "2" (Parquet) to: Which format? 1. CSV 2. Parquet
```

Three shapes count, each read off the ledger (`ownerAnswers` in the mod's `hooks/ledger.js`), live as the
ledger is written and again by a backfill:

- **A reply the owner sent to a turn that asked,** which folds into the ledger item as a `replies` row
  saying who sent it (`source`) and what it answered (`asked`, the numbered list off the end of the turn).
  A row from before those fields existed is not an answer to anything on record: "1" says nothing
  without what it picked, and the item's own text is the owner's ask, not a question put to them. A
  backfill counts those and writes nothing for them. Measured on one machine, every one was a bare digit.
- **A short message right after a numbered question,** which is a new ledger item rather than a reply.
  The question is kept on the item. Past 500 characters it is a new brief, not an answer.
- **A lead's question that a message of the owner's woke.** Only one with a question mark in it. Measured
  on one machine: of 57 wakes, 34 were by a person, and only 1 of those 34 woke an item that asked a
  question at all, so a wake alone proves nothing.

A lead's reply to a worker is not the owner's, whatever it says, and neither is anything a worker writes:
an `ack` stays `worker` even when its text claims otherwise. Authority follows the writer and the source,
never the words.

## History

`fleet-know history <project>` is what happened, in order: merged PRs, decisions and rules with who said
them, deploys, keyed facts changing, workers started and finished, and commits nothing else accounts for.
No model reads anything for it. What the suite's fixture fleet prints:

```
acme-api@laptop · work profile · history, newest last, times in UTC
2026-02-12
  16:00  [owner] rule (profile): Every change lands through a PR, reviewed
2026-03-02
  17:20  [lead] decision: Bill the export endpoint per call (no longer holds)
2026-03-03
  10:00  [lead] rule (project:acme-api): Rate limits are per account
2026-03-04
  02:40  [lead] deploy.target = vercel-preview
2026-03-05
  12:01  worker api-fix started on fix/csv-export: a quote-aware CSV writer, column order kept
  12:03  [worker] decision: RFC 4180 quoting; no new dependency
  13:00  PR #1170 merged (fix/csv-export)
  13:02  worker api-fix finished (fix/csv-export)
  13:10  deploy vercel deploy at a1b2c3d4 (master)
  13:12  [lead] decision: Keep the v1 export endpoint until acme-web moves to v2
  13:13  [lead] rule (project:acme-api): Rate limits are per API key, never per account
  13:13  rule closed (project:acme-api): Rate limits are per account — superseded by k861059144ea1cf70
  13:14  [worker api-fix] proposed a rule (project:acme-api): Retry a failed export three times
  13:15  [lead] decision: Bill the export endpoint per row
  13:16  [lead] deploy.target = vercel-production (was vercel-preview)
  13:20  worker docs-pass started on docs/setup-pass: Tighten the README setup section
```

- **Times are UTC, and each line is at the time it happened,** not when it was recorded.
- **`--since` and `--until` take a date or a time.** A bare `--until 2026-03-05` means the whole of that
  day. `--at` stops the list there, and `--known-at` shows only what had been recorded by then.
- **It prints the newest 200 lines of a range,** whatever the range holds, and says what it left out:
  `+60 earlier: --since 2026-01-10 --until 2026-01-12T22:00:00.000Z`, a range that reads exactly the rest.
- **A commit that names a PR already listed is not said twice.**
- **MCP:** `fleet_know` with `history`, `since` and `until`.

Private and excluded projects follow the same rules as the page: an excluded one has no history here, and
a private one says so at the top.

## Backfill

`fleet-know backfill [--profile <p>] [--since <date>] [--dry-run]` fills in history from what the machine
already has on record. It is a command the owner runs. Nothing in the install runs it, and it calls no
model.

| source | what it reads | what it writes |
|---|---|---|
| merged PRs | `gh pr list` per repo: the real merge time, head branch, title, author | `pr.open`, `pr.merge` |
| ledgers | `<fleet dir>/*.ledger`: each item's ask, state, times and proof, and any owner's answer | `request.open`, `request.state`, `decision` |
| spawn manifests | `<fleet dir>/*.manifest.tsv`: worker, branch, task | `spawn`, and `retire` when the worktree is gone |
| the default branch | `git log --first-parent`: commit time, subject, the PR number a subject names | `commit`, a line and no graph node |

- **Valid then, known now.** Each line's `t` is the source's time and its `rec` is this run, so `--at`
  before a backfilled merge says it had not merged, and `--known-at` before the run says nobody knew.
- **A source with no time gets no line.** A manifest row has no time in it, so it borrows the spawn's
  line in `<sock>.brief.tsv`, then the branch's first reflog line, then the first line of a transcript from
  that folder, and past those it is counted as skipped.
- **Once.** A second run adds nothing, and a later run adds only what is new.
- **Never beside what the live hooks saw.** A live writer saw the same merge at a different time, so its
  id differs, and an id alone would file it twice. The log is read first into one key per fact (a PR's
  merge is one key whoever wrote it), and a merge a live writer recorded keeps the live writer's time.
- **Authority does not change.** A ledger item the owner asked for is `owner`, a lead's brief is `lead`, a
  promise is `worker`, and the only `decision` it writes is an [owner's answer](#the-owners-answers). It
  never invents one.
- **A profile that does not record is not read.** Its folder is not opened unless `--profile` names it,
  because recording is turned on per profile, and history is the same data. It prints which it left and
  why. Naming one starts its log. An excluded project is not asked of `gh`, read, or written.
- **`--dry-run` writes nothing,** not a line, not a snapshot and not a read note, and prints the counts per
  source and per project, and how many of the lines would be the owner's decisions.
- **It prints what it skipped, and why:** a session with no project on the list, a row with no time, a
  repo `gh` could not list, a reply of the owner's whose question is not on record.
- **It leaves the graph built.** Every line is older than the snapshot's high-water, so the next read would
  rebuild anyway, and this puts that wait on the command that caused it, not on a session's start.

**It closes what nobody will.** A ledger item still open a week after it was asked is not a live ask: the
session that could close it is gone, and it would sit on the project's page forever. So one older than
that gets an `expired` state at the end of that week, with a reason saying the backfill wrote it. Only for
what the backfill itself opened: an item a live hook recorded is still the live hook's to close. It is the
one line a backfill writes that no source says outright, and it is marked `by: backfill`.

**What it cannot reach.** A paired machine asks a peer for the lines newer than the last one it fetched, and
a backfilled line carries the time it happened. So lines dated before that point do not reach a machine
that has already fetched past it, and its view of this machine goes on without them. This machine's own
answers are not affected.

## Scale

A read costs CPU in proportion to what it answers, not to the square of the log. A read index
over the edges, built once per graph and never saved, replaced a scan of every edge per PR and
per request; `waiting`, a page per project, was the worst of it. The fold has one of its own,
for finding a session's edges when it ends. Neither changes an answer: the index keeps the
graph's order, and a page, `waiting`, `touched` and `find` were compared byte for byte, old against
new, on a 30k-event log, apart from the authority fields this adds.

Wall clock on an Apple M5 Pro at a load average of 5–8, log of many projects
(`test/helpers/know-bench.mjs`, whose `gen` builds one in a scratch home and refuses anything else):

| events | `fleet-know <project>` | `waiting` | `touched` | `find` | `rebuild` |
|---|---|---|---|---|---|
| 3k | 61 ms | 63 ms | 60 ms | 67 ms | 71 ms |
| 30k | 130 ms | 137 ms | 127 ms | 177 ms | 273 ms |
| 90k | 239 ms | 284 ms | 276 ms | 408 ms | 696 ms |

**A backfill is the case a read pays most for,** since every line it adds is older than what the
snapshot has folded. Same machine at a load average of 5–7, a log of 40 projects with a synthetic
backfill added on top (`know-bench.mjs backfill`, which holds more PRs and workers per commit than the
one real machine measured, so it errs on the costly side):

| log | `fleet-know <project>` | `waiting` | `history` | `--known-at` | `rebuild` |
|---|---|---|---|---|---|
| 10k, before | 82 ms | 84 ms | | | 123 ms |
| 30k, after adding 20k | 134 ms | 142 ms | 175 ms | 227 ms | 231 ms |
| 30k, before | 138 ms | 144 ms | | | 294 ms |
| 90k, after adding 60k | 252 ms | 284 ms | 393 ms | 428 ms | 622 ms |

The command rebuilds before it returns, so these are what any read after it costs. Lines landing with
no rebuild, as when a backfill is killed before its last step, cost the next read one rebuild of its
own: 337 ms at 30k and 1,015 ms at 90k, once. `--known-at` folds the log again per read, on purpose,
because the earliest-wins attributes hold one value and cannot be asked what was known then.

**The log is read a line at a time**, in a bounded buffer, so a file past the 512 MB a string can
hold is only a longer read. A torn line, a foreign line, and one past 1 MB are skipped. Measured
on a 1M-event log of 600 MB: a page takes about 3 s, a rebuild about 12 s. The memory that takes
is the graph's, about 2.5 GB there, not the file's.

**The ceiling is now the snapshot.** It is about 60% of the log's size and is saved as one JSON
string, so past a log of roughly 840 MB it cannot be written, and every read rebuilds instead.
Measured on a log of 900 MB: no snapshot on disk, and a page takes about 17 s. Slower, but it
still answers. Rotation (below) is the way past it.

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
- A forget crosses too, the next time this machine fetches: see [Forgetting](#forgetting).

## Choices made where the design was silent

- **The hook writes detached; every other path writes synchronously.** The Stop hook is on
  the turn's critical path; `fleet-spawn`, `fleet-merged` and the ledger CLI are not, and a
  synchronous write there means the event is in the log before the command returns.
- **A merge's time is when ghostfleet first saw it** — the `fleet-merged` refresh that found it
  merged, or the `gh pr merge` in a turn — not GitHub's `mergedAt`, which would need a network
  call nothing else on this path makes. Seen again later, by another refresh or another
  profile, it is the same merge with the earlier time. A [backfill](#backfill) writes GitHub's time, for
  a merge no live writer saw, and leaves one that was seen alone.
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
  moment the cache was first built. A [backfill](#backfill) is where they come from, at GitHub's times.

## What is not built yet

- **Compaction.** The log only grows (a line is a few hundred bytes; a busy fleet writes a few
  thousand a day). Rotating it into segments, with the snapshot as the fold of the closed ones,
  is the next step when it matters, and the way past the snapshot's ceiling under
  [Scale](#scale).
- **Retroactive redaction.** The table applies from the moment it shipped. Older lines are found
  with `find` and removed with `forget --purge`, one at a time.
- **Owner-sourced decisions and rules from a conversation.** `owner` is earned today by a person's
  own terminal, by ledger items the owner asked for, and by [an answer to a question](#the-owners-answers).
  Nothing yet records a decision the owner stated unprompted, or a rule from a prompt, though the fold
  already reads those sources as the owner's, so a lead writes down what the owner said under its own
  `lead`, with `--quote` keeping the words.
- **What a project is, automatically** — from its README, via the inferred pass. Today it is
  `fleet-know describe`.
- **Inferred facts for the other agents.** The pass lives in the Claude Code mod; codex,
  opencode, agy and cursor sessions get every recorded event but no inferred decisions.
- **Private across a pairing as an option.** Today private never crosses; a "private but
  shared between my own machines" setting is a deliberate extension, not a default.
- **A session's last words at SessionEnd.** A session ended mid-turn records the end, not the
  transcript tail since its last Stop.
