# Pre-promotion leak sweep

**A report, not a remediation. Nothing here has been changed or removed.**

## Recommendation

**Do not rewrite history. It would cost everything a rewrite costs and would not remove the
data.** Fix the four things still in the working tree with an ordinary commit, and decide
separately — on the strength of §2.4 alone, not on the project names — whether the exposure
warrants deleting and recreating the repository.

That is not the usual answer, so here is the measurement it rests on.

`git filter-repo` rewrites the commits reachable from your branches. It does not touch
`refs/pull/*/head`, and **GitHub keeps those forever**. PR #59's head commit `0abb103` is
*not an ancestor of `main`* — it is the pre-squash branch commit — and today:

```
https://raw.githubusercontent.com/PabloG55/ghostfleet/0abb103…/web/fixtures/projects.json
  -> HTTP 200
```

That file is the real project list. A rewrite of `main` would break 72 merged PR
permalinks and every existing clone, and that URL would still return 200. The rewrite is
strictly worse than useless here: full price, no delivery.

**What would actually work**, in ascending cost:

| | removes the data? | cost |
| --- | --- | --- |
| do nothing | no | none |
| fix the working tree (§3) | no — history keeps it | one commit, no permalink breakage |
| `filter-repo` + force-push | **no** — PR refs still serve it | 72 dead permalinks, every clone broken |
| `filter-repo` + ask GitHub Support to purge & GC | yes, on GitHub | the above, plus a support round-trip, plus forks/caches you cannot reach |
| delete and recreate the repository | yes, on GitHub | the above, plus every PR, issue, star and watcher |

**And the clock has already run.** The repository has been **public since 2026-08-01** —
this is not a pre-publication review, it is an after-the-fact one. Anything here should be
treated as already disclosed; the question is not "prevent" but "is it worth paying the
above to reduce what a curious reader finds". My answer is no for §2.1–§2.3 and §2.5, and
**that is Pablo's call, not mine, for §2.4.**

**A note on this document.** It deliberately does not reprint the leaked values — not the
tailnet address, not the 27 names, not the branch names, not the conversation text. It
cites paths, blobs and commits instead. A findings report that quotes everything becomes
the most convenient index of the leak, in the same public repository, and undoes its own
purpose.

---

## 1. Scope and method

Not a `grep` of the checkout. The tree has been sanitised twice and **both fixes left the
originals in history** — that is the whole subject.

- All 73 `refs/pull/*/head` fetched, so PR-only objects were in scope.
- **838 distinct blobs** enumerated with `git rev-list --objects --all`, and every one of
  the 809 text blobs read in full and matched against 25 patterns (client and project
  names, four network-address classes, ten credential shapes).
- Distinct values extracted per network pattern, so placeholders could be told from real
  addresses rather than assumed.
- **29 binary blobs handled by looking at them.** Every image ever committed was extracted;
  the nine superseded ones were rendered, and each GIF was decomposed to frames
  (`ffmpeg -vf fps=1`) and viewed as contact sheets. Both versions of each re-shot image
  were examined, and the current ones too, to confirm the fix holds.
- Reachability verified live against GitHub rather than assumed — blob API by sha, and
  `raw.githubusercontent` at introducing commits and at PR heads.

## 2. Findings

### 2.0 No credentials. None.

All ten credential patterns — private keys, AWS, GitHub PATs, Anthropic/OpenAI keys, Slack,
bearer tokens, JWTs, Doppler, and generic `key=`/`secret=`/`token=` assignments — matched
**zero blobs** across all 838. No `.env`, `.pem`, `.key`, `.npmrc`, `.netrc`, `serve.json`
or credential-shaped filename has ever been committed on any ref.

This is the finding that would have changed the recommendation, and it is absent. Everything
below is disclosure of *names and work content*, not of access.

### 2.1 The superseded phone fixtures — the real project list, in JSON

**Severity: moderate.** **Reachable: yes, at HTTP 200, from a ref a rewrite would not touch.**

PR #59 ("Stop shipping my real project names as the phone client's demo data") replaced
`web/fixtures/*` with `acme-api`/`gf-demo` data. The originals are `web/fixtures/*.json` at
the pre-#59 commits — machine-readable, one object per project, each with `name`, `path`,
`socket` and session counts. **27 distinct names appear in that fixture history that are not
in the current fixtures.**

This is the most *scrapeable* of the findings: no OCR, no video, just JSON at a stable URL.

### 2.2 The superseded recordings — the same list, plus worker and branch names

**Severity: moderate.** **Reachable: yes.**

PR #60 re-shot every phone image. Nine paths have two versions in history; the superseded
ones were examined frame by frame.

- `docs/mobile/projects.png` (introduced `a653f87`) — the Projects screen: five real
  projects with their `~/Documents/...` paths, including **two names absent from the
  original search list**, which is exactly why the task said to treat that list as a
  starting point.
- `docs/mobile/statuses.png`, `docs/mobile/grid.png` (both `a653f87`) — eight worker cards
  with real session names, real branch names, and two internal PR numbers from a private
  repository.
- `docs/mobile/phone-demo.gif` — a 17-frame walkthrough that shows the project list, the
  grid and the chat in sequence. The single worst artefact, because one file carries all
  three surfaces.

Worth recording: these frames are headed **`⚠ fixtures`**. They were recorded in fixture
mode. The fixtures *were* the real data at the time — which is what #59 later fixed — so
"it was a demo recording" is not a defence for anything shot before #59.

**`docs/mobile/grid.png` and `docs/mobile/session.png` are not in the current tree at all.**
They were deleted, not replaced. Both are still served: a `raw.githubusercontent` request
for a fully-deleted path at its old commit returns **HTTP 200** with the bytes.

### 2.3 A live tailnet address, in the current tree

**Severity: low-moderate.** **Reachable: yes — and it is in `main` today.**

`test/run.sh:4420` uses a CGNAT-range address as the fixture for "the tailnet CGNAT range is
allowed". Four other addresses in that test are obvious synthetics (range boundaries,
`10.1.2.3`, `192.168.1.5`); this one is not, and **it matches this machine's live
`tailscale ip -4` exactly**. It has been in the tree since PR #42.

A Tailscale address is not a credential: reaching it requires being on the tailnet, which
requires auth, and `docs/mobile.md` documents Tailnet Lock on top. This is reconnaissance
value — it confirms the node exists and names it — not access. It is also the one finding
that is **cheap to fix properly**: substitute any other in-range address, and the test is
equally valid. Rotating the actual Tailscale address is possible but disruptive and, given
§0's timeline, largely symbolic.

One `*.ts.net` hostname is present, in a test helper; on inspection it reads as a
placeholder, but it is worth a second look by someone who knows the tailnet's naming.

### 2.4 Internal engineering conversation — the one worth an actual decision

**Severity: the highest here, and the only finding I would not simply accept.**
**Reachable: yes.**

The superseded `docs/mobile/session.png` and `docs/mobile/session.gif` are a phone chat view
scrolled through a real work session. They are not a project name. Across their frames they
carry, in plain readable text:

- an internal specification reference, by document and section number;
- two draft PR numbers from a private repository;
- the name of a shared UI component, and a design argument about where a date comparison
  should live;
- a database query-plan result with before/after timings and a note about which index a
  second feature relies on;
- an observation that a product surface displays expired records without marking them
  expired — which reads as a defect disclosure about a live insurance product;
- responsive breakpoints, and a migration in progress.

That is a window into a private codebase's design, its performance characteristics and one
of its defects. It is qualitatively different from "the folder was called superkey", and it
is the only material here for which I would consider the delete-and-recreate cost defensible.
**I am not recommending it — the exposure is already three and a half weeks old and the
content is prose in a GIF rather than anything actionable against a system. But this is the
paragraph to re-read before deciding, and it should be decided on this and not on §2.1.**

### 2.5 Two un-sanitised pane captures, in the current tree

**Severity: low.** **Reachable: yes — in `main` today.**

`test/fixtures/` holds eleven real terminal captures. Nine were sanitised to
`pablo@example.com | Example Account`. Two were not:

- `test/fixtures/claude-working-pane-sgr.txt` — carries the real account, an account-tier
  string, a real session name and a real client-work branch name.
- `test/fixtures/claude-idle-quoting-limit.txt` — carries the real account and organisation;
  its project is `ghostfleet` itself, so it discloses little beyond the org.

Three further fixtures carry `feat/…` branch names from another project. All are fixable
with an ordinary commit; the captures' *purpose* (proving the pane detectors against real
output) survives sanitising, which is what the other nine demonstrate.

`pablo@superkey.com` in commit author trailers is expected and out of scope, as briefed.
`/Users/pgarces` paths are in the documentation on purpose and are likewise out of scope.

## 3. What I would do, if it were mine

**One ordinary commit**, no history involvement, fixing what ships today:

1. `test/run.sh:4420` — swap the live tailnet address for another in-range value.
2. `test/fixtures/claude-working-pane-sgr.txt` — sanitise as the other nine already are.
3. `test/fixtures/claude-idle-quoting-limit.txt` — same.
4. The three `feat/…` branch names in the remaining captures — same.

That stops the bleeding without touching a single permalink. It does not remove anything
from history, and nothing available at reasonable cost does.

**Then decide §2.4 on its own merits.** If that content is unacceptable, the only remedy
that works is deleting and recreating the repository, and the price is every PR, issue and
star. If it is acceptable — and after three and a half weeks public, with the content being
design discussion rather than anything operable — then accept it and promote.

**A cheap habit worth more than any of this:** the fixtures and the recordings both leaked
because the *demo data was the real data*. #59 fixed the fixtures and #60 re-shot against
them. The rule that prevents the next one is that a recording is made from synthetic
fixtures, and the synthetic fixtures are checked before the recording, not after.

## 4. What this sweep does not cover

- **Forks, clones and caches.** If anything here has been forked or crawled, no action in
  this repository reaches it. Search-engine and archive caches are out of reach entirely.
- **The `.mp4` sources.** `docs/*.mp4` were enumerated and are current-tree only, with no
  superseded versions; their frames were not examined individually, on the grounds that
  their `.gif` derivatives were and are the same recordings.
- **Whether any of the 27 names is commercially sensitive.** I can count them and say where
  they are. Which of them matter is Pablo's knowledge, not mine.
- **Issue and PR text, and review comments.** This swept git objects. GitHub-side prose was
  not read, and a leak there would not be visible to any of the methods above.
- **The GIF frames' full text.** Each was read for identity and content, not transcribed. A
  determined reader with OCR would extract more than this report enumerates.
