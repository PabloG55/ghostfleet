#!/usr/bin/env node
// test/helpers/sw-version.mjs — the client version has to be ABOVE staging's, not just
// different from the last one.
//
//     node test/helpers/sw-version.mjs        # "name <US> want <US> got" rows
//
// WHAT BIT, THREE TIMES IN ONE DAY. #83 took v17 and #81 was numbered v16 before it and
// merged after, so staging went BACKWARDS from v17 to v16 and #84 existed only to put it
// back as v18. Then #86 was numbered v19 while #85 was also v19, caught by hand on the
// way to the merge button. And it is older than today: a4ec19c and 7fb9857 are both v7.
// Two branches numbering in parallel is not an exotic accident — it is what happens any
// time two branches touch web/ at once.
//
// WHY THE PIN CANNOT SEE IT. pwa-check ties CLIENT-HASH to the bytes of everything
// precached, which catches "changed the client, forgot to bump" — the failure it was built
// for. It has no notion of ORDER. Both "bumped, but downwards" and "bumped, to the same
// number somebody else took" leave a hash that matches its own bytes perfectly, and both
// sail past a green suite.
//   And the cost is the silent kind. The shell is served cache-first, so a phone holding
// v19 asks for a version at least as new before it will replace what it has: a merge that
// leaves staging at v16 does not fail on the phone, it does NOTHING on the phone, for every
// user who already opened the app. From the outside that is indistinguishable from the
// change not working — CLAUDE.md's whole subject, and the reason this is a suite row and
// not a line in a checklist.
//
// THE COMPARISON IS NUMERIC. `v9` and `v19` sort the wrong way as strings, which would
// make this guard start lying at exactly the point the numbers get interesting.
//
// WHAT IT DOES *NOT* DO, on purpose:
//   - it never asks the deployed server. That is on a tailnet, CI cannot reach it, and a
//     check that needs a machine to be up is a check that goes red for weather.
//   - it never makes a network call of its own. The suite's promise is no dependencies and
//     a couple of seconds; the ref is fetched by whoever runs it (CI does it in
//     .github/workflows/test.yml, because actions/checkout is shallow and has no
//     origin/staging until it does).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
// Its own marker, because run.sh counts the two apart: a skip says the machine could not,
// an n/a says the question did not arise. Neither is a pass and only one is a capability.
const naGroup = (what, why) => rows.push('#NA' + US + what + US + why);

// ── the two fields, read out of a sw.js ────────────────────────────────────
// NUMBER, not string. `Number.parseInt` on 'v9' vs 'v19' is the whole reason this function
// exists rather than a `<` between two matches.
export function versionOf(src) {
  const m = /const VERSION = 'ghostfleet-v(\d+)';/.exec(String(src || ''));
  return m ? Number(m[1]) : null;
}
export function hashOf(src) {
  const m = /CLIENT-HASH:\s*([0-9a-f]{12})/.exec(String(src || ''));
  return m ? m[1] : null;
}

// ── the verdict, as a pure function ───────────────────────────────────────
// SEPARATED FROM GIT SO THE FOUR CASES CAN BE DRIVEN. A guard whose only test is the
// current repo state can only ever be exercised in the direction that passes, which is the
// guard we already have (CLAUDE.md: a test that can only pass proves nothing). Section 1
// below feeds this synthetic pairs and watches it refuse them.
//
// THE RULE, in the order it is applied:
//   1. no VERSION at all               -> fail. The file is the pin; an unreadable pin is worse
//                                         than a wrong one, because nothing downstream notices.
//   2. already in staging               -> n/a, NOT skip and NOT pass. On staging itself, or on
//                                         a branch that has landed, there is nothing to be ahead
//                                         of: the question does not arise. A pass would claim an
//                                         ordering nobody checked; a skip would claim the machine
//                                         could not do it. Suppressed on a push run, where the
//                                         comparison is against the first parent instead.
//                                         Ordered AFTER rule 1 on purpose: an unreadable VERSION
//                                         fails first, so a broken subject can never reach here
//                                         and hide behind "not applicable".
//   3. no origin/staging to read           -> skip locally, FAIL in CI on a pull request. A guard
//                                         that quietly no-ops in the one place it matters reads
//                                         as covered and is not.
//   4. above staging                    -> pass.
//   5. equal to staging, same bytes     -> pass. The overwhelming majority of PRs never touch
//                                         web/ at all; requiring a bump from them would make
//                                         this the most-ignored row in the suite within a week.
//   6. anything else                    -> fail. Equal with different bytes is #85/#86. Below is
//                                         #81/#83, and it is a fail even with identical bytes,
//                                         because the number is what a phone compares.
export function verdict(s) {
  const ours = s.ours, theirs = s.theirs;
  if (ours == null) return { kind: 'fail', reason: 'web/sw.js has no `const VERSION = \'ghostfleet-vNN\'` to read' };
  // NOT ON A PUSH RUN. Every push to staging IS staging, so `headInBase` is trivially
  // true there and short-circuiting on it throws away the one question worth asking:
  // did this commit land ahead of the staging it was merged ONTO. That base is its first
  // parent, and pushCI is what selects it (see the runtime half).
  if (s.headInBase && !s.pushCI) {
    return { kind: 'na', reason: 'this commit is already in staging — nothing to be ahead of' };
  }
  if (!s.refPresent) {
    return s.prCI
      ? { kind: 'fail', reason: 'CI has no origin/staging, so the ordering was never checked — the fetch step in .github/workflows/test.yml did not produce it' }
      // A MISSING REF IS A MISSING THING, and the word matters: the suite sorts a skip by
      // whether it names something the machine lacks, and "no origin/staging in this
      // clone" named a fact without naming a lack.
      : { kind: 'skip', reason: 'origin/staging is missing from this clone — `git fetch origin staging` to enable the ordering check' };
  }
  if (theirs == null) return { kind: 'fail', reason: 'origin/staging:web/sw.js has no VERSION to compare against' };
  if (ours > theirs) return { kind: 'pass', reason: `v${ours} is above staging's v${theirs}` };
  if (ours === theirs && s.ourHash != null && s.ourHash === s.theirHash) {
    return { kind: 'pass', reason: `v${ours} matches staging and so does the client, so there is nothing to move for` };
  }
  if (ours === theirs) {
    return { kind: 'fail', reason: `v${ours} is staging's number with different bytes — somebody else already took it; go to v${theirs + 1}` };
  }
  return { kind: 'fail', reason: `v${ours} is BELOW staging's v${theirs} — a phone holding v${theirs} would never load it; go to v${theirs + 1}` };
}

// ── 1. the comparison itself, driven in every direction ───────────────────
// The numbers are the ones that actually happened, so a red row here reads as the incident
// it stands for rather than as arithmetic.
const H = { ourHash: 'aaaaaaaaaaaa', theirHash: 'bbbbbbbbbbbb' };
const base = { refPresent: true, headInBase: false, prCI: false, ...H };
const kindOf = (o) => verdict({ ...base, ...o }).kind;

is('staging+1 is what a branch should be', 'pass', kindOf({ ours: 20, theirs: 19 }));
// THE THREE FAILURES ARE THE POINT OF THE FILE.
is('...staging\'s own number is not', 'fail', kindOf({ ours: 19, theirs: 19 }));
is('...and below staging is not (#81 after #83)', 'fail', kindOf({ ours: 16, theirs: 17 }));
is('...nor is staging-minus-one with a bump in it', 'fail', kindOf({ ours: 18, theirs: 19 }));
// v9 vs v19 IS THE CASE A STRING COMPARE GETS WRONG, in both directions: '9' > '19' and
// '19' < '9'. Asserted both ways round so a lexicographic implementation cannot satisfy
// one of them by accident.
is('v19 is above v9, numerically', 'pass', kindOf({ ours: 19, theirs: 9 }));
is('...and v9 is not above v19', 'fail', kindOf({ ours: 9, theirs: 19 }));
is('...nor v10 above v9\'s successor', 'fail', kindOf({ ours: 10, theirs: 11 }));
// The reason text carries the number to use, because "go and look up staging's" is the step
// where somebody guesses.
is('...and a failure names the number to take', true,
   /go to v18\b/.test(verdict({ ...base, ours: 16, theirs: 17 }).reason));

// A PR THAT NEVER TOUCHED web/ IS THE COMMON CASE. Equal versions with identical bytes is
// most of this repo's history, and a guard that reds those is a guard people learn to
// ignore. Both directions: identical bytes pass, and the moment the bytes differ the same
// pair of numbers fails.
is('an untouched client may keep staging\'s number', 'pass',
   kindOf({ ours: 19, theirs: 19, ourHash: 'cccccccccccc', theirHash: 'cccccccccccc' }));
is('...but not once the bytes differ', 'fail',
   kindOf({ ours: 19, theirs: 19, ourHash: 'cccccccccccc', theirHash: 'dddddddddddd' }));
// ...and the exemption is for EQUAL only. Below staging is wrong even with nothing to deploy,
// because the number is the whole of what a phone compares.
is('...and never excuses a version below staging', 'fail',
   kindOf({ ours: 18, theirs: 19, ourHash: 'cccccccccccc', theirHash: 'cccccccccccc' }));

// The states that are not a comparison at all — and they are not all the same KIND.
// NOT APPLICABLE IS NOT A SKIP AND NOT A PASS. `skip` claims the machine could not do
// it, which is false here and was read (correctly, by the suite's own rule) as a group
// hiding a broken subject behind a capability it never lacked. That is what turned
// staging red. The question genuinely does not arise, so it gets its own answer.
is('on staging itself the question does not arise', 'na', kindOf({ ours: 19, theirs: 19, headInBase: true }));
is('...and a merged branch is the same case', 'na', kindOf({ ours: 19, theirs: 20, headInBase: true }));
// AND AN N/A MUST NOT BE REACHABLE BY BREAKING THE SUBJECT, or it is the same hole with a
// friendlier label. The ordering is the guarantee: an unreadable VERSION is decided
// first, so the one input a person controls cannot buy its way out of the check.
is('an unreadable VERSION fails even where the question would not arise', 'fail',
   kindOf({ ours: null, theirs: 19, headInBase: true }));
// ON A PUSH RUN headInBase IS TRIVIALLY TRUE — every push to staging IS staging — so it
// must NOT short-circuit, or the check never runs on the one ref it protects.
is('a push run still compares, against its first parent', 'pass',
   kindOf({ ours: 20, theirs: 19, headInBase: true, pushCI: true }));
is('...and still catches a client that went backwards there', 'fail',
   kindOf({ ours: 18, theirs: 19, headInBase: true, pushCI: true }));
// THE RACE THIS REPLACED: staging moving on between the merge and the fetch. With the
// base pinned to the first parent, a newer staging is simply not what is being read, so
// the shape that failed 8ee5980 cannot arise. Asserted as the pair it actually was.
is('a commit is judged against what it landed on, not what landed after', 'pass',
   kindOf({ ours: 33, theirs: 33, ourHash: 'aaaaaaaaaaaa', theirHash: 'aaaaaaaaaaaa', headInBase: true, pushCI: true }));
// A LOCAL CLONE WITHOUT THE REF SKIPS. A CI RUN WITHOUT IT DOES NOT — that is the
// no-op-that-reads-as-covered this file's header is about, and it is the one failure mode
// worth failing the build over even though nothing is wrong with the code.
is('a clone with no origin/staging skips', 'skip', kindOf({ ours: 20, theirs: null, refPresent: false }));
is('...but CI on a pull request refuses to', 'fail',
   kindOf({ ours: 20, theirs: null, refPresent: false, prCI: true }));
is('...saying which file has to fetch it', true,
   /workflows\/test\.yml/.test(verdict({ ...base, ours: 20, theirs: null, refPresent: false, prCI: true }).reason));
is('an unreadable version fails rather than skips', 'fail', kindOf({ ours: null, theirs: 19 }));

// The parser, on the shapes it has to survive. `ghostfleet-v9` next to `ghostfleet-v19` is
// the pair the whole numeric argument rests on, so it is read out of real source text.
const swSrc = (v, h) => `// CLIENT-HASH: ${h}\nconst VERSION = 'ghostfleet-v${v}';\nconst SHELL = [];\n`;
is('the version parses as a number', 19, versionOf(swSrc(19, 'a'.repeat(12))));
is('...and single digits do too', 9, versionOf(swSrc(9, 'a'.repeat(12))));
is('...a file without one reads as null', null, versionOf('const VERSION = 3;'));
is('...and so does an empty one', null, versionOf(''));
is('the hash parses', 'e973d7385755', hashOf(swSrc(19, 'e973d7385755')));
is('...and a missing hash is null, not a match', null, hashOf(swSrc(19, 'nope')));

// ── 2. and now the real repo ──────────────────────────────────────────────
const git = (...args) => {
  try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};
const REF = 'origin/staging';
const refPresent = git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`) != null;
// A COMMIT IS ITS OWN ANCESTOR, which is exactly what makes this the right question: on
// staging it answers yes, on a branch that has already landed it answers yes, and on anything
// still in flight it answers no. `--is-ancestor` says so in its EXIT STATUS and prints
// nothing either way, so the status is what gets read — and a shallow clone that cannot see
// the common ancestor exits non-zero too, which lands in the same place as "no", correctly:
// a branch whose history does not reach staging is a branch that has not landed.
const ok = (...args) => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { stdio: 'ignore' });
  return r.status === 0;
};
const headInBase = refPresent && ok('merge-base', '--is-ancestor', 'HEAD', REF);
const pushCI = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'push';

// WHICH STAGING TO COMPARE AGAINST, and on a push run it is not the branch name.
// origin/staging moves: protection here is deliberately not `strict`, so two PRs land a
// minute apart routinely, and a push run that fetches the branch AFTER the next merge
// compares this commit against somebody else's newer client. Measured: 8ee5980 was told
// its v33 was "BELOW staging's v34" by a run testing 8ee5980, because b5af1ec had landed
// in between. The ancestry check that should have caught it cannot: the checkout is
// shallow and origin/staging is fetched shallow too, so the two histories share no
// commit and `--is-ancestor` answers no for want of objects rather than for want of
// ancestry.
//   The staging this commit was merged ONTO is its first parent, it cannot move, and it
// is the thing the question is actually about. Depth 2 in the workflow is what makes it
// readable — a whole history is not needed to see one parent.
const BASE = pushCI ? 'HEAD^1' : REF;
const basePresent = pushCI
  ? git('rev-parse', '--verify', '--quiet', `${BASE}^{commit}`) != null
  : refPresent;

const ourSrc = fs.readFileSync(path.join(ROOT, 'web', 'sw.js'), 'utf8');
const theirSrc = basePresent ? git('show', `${BASE}:web/sw.js`) : null;
const state = {
  ours: versionOf(ourSrc),
  theirs: versionOf(theirSrc),
  ourHash: hashOf(ourSrc),
  theirHash: hashOf(theirSrc),
  refPresent: basePresent,
  headInBase,
  pushCI,
  prCI: process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'pull_request',
};
const v = verdict(state);
if (v.kind === 'skip') skipGroup('the client version is above staging\'s', v.reason);
else if (v.kind === 'na') naGroup('the client version is above staging\'s', v.reason);
else is(`the client version is above staging's — ${v.reason}`, 'pass', v.kind);

console.log(rows.join('\n'));
