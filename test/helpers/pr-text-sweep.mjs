#!/usr/bin/env node
// test/helpers/pr-text-sweep.mjs — no withheld name in a pull request's title or body.
//
//     PR_TITLE=… PR_BODY=… node test/helpers/pr-text-sweep.mjs   # the CI gate
//     node test/helpers/pr-text-sweep.mjs --selftest             # rows, for the suite
//
// THE HOLE THIS CLOSES IS A TIMING ONE. Every other guard here reads something that
// exists when it runs: tracked files, the commits being pushed, the tip tree. A pull
// request's BODY is none of those. It is not in the repository at all until the moment
// of squash-merge, when GitHub composes it into the commit message — which is after the
// last check has passed and after the last human has looked. So the body was the one
// piece of text that reached public history having been read by nothing.
//   It happened: a PR body carried a restart snapshot listing real session names, and on
// merge that body became a commit message on staging. Nothing was broken; there was
// simply no check that could have seen it.
//
// ONE LIST, ONE TOKENIZER. This imports `candidates`, `digest` and `DENY` from the sweep
// rather than restating them. A copy would be the "renderer nobody ships" shape the sweep
// warns about in its own header — passing against a matcher that is not the one the suite
// proves — and the shortest entry is three letters, so a substring search here would fire
// on ordinary English and get itself switched off within a week.
//
// IT REPORTS THE PLACE AND NEVER THE NAME. A guard that prints what it found publishes
// the thing it exists to suppress, into a CI log that is as public as the repository. The
// author knows which word it is the moment they are told which line.
import { candidates, digest, DENY } from './name-sweep.mjs';

// Lines, because a location has to be actionable: "the body" is a thing to re-read and
// "the body, line 12" is a thing to fix. The title is one line by construction.
export function scanText(title, body, deny = DENY) {
  const hit = (line) => [...candidates(line)].some(c => deny.has(digest(c)));
  const at = [];
  for (const [i, line] of String(title ?? '').split('\n').entries()) {
    if (hit(line)) at.push(i === 0 ? 'the title' : `the title, line ${i + 1}`);
  }
  // `?? ''` because a body is legitimately absent — GitHub sends null for an empty one,
  // and a guard that throws on the ordinary case is a guard that gets removed.
  for (const [i, line] of String(body ?? '').split('\n').entries()) {
    if (hit(line)) at.push(`the body, line ${i + 1}`);
  }
  return at;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  if (process.argv.includes('--selftest')) {
    const US = '\x1f';
    const rows = [];
    const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
    // Assembled from two pieces so the literal is never one token in this file, which
    // would make the tree sweep flag this file. The same trick, for the same reason, as
    // the sweep's own canary.
    const CANARY = ['notareal', 'projectname'].join('');
    const D = new Set(DENY); D.add(digest(CANARY));

    // BOTH DIRECTIONS, or this passes just as happily with an empty deny list, a broken
    // tokenizer or a typo in the salt — which is the same sweep-with-no-evidence the
    // name-sweep header refuses to ship.
    is('a planted name in the title is caught', 1,
       scanText(`Fix the thing on ${CANARY}`, '', D).length);
    is('...and says it was the title', 'the title',
       scanText(`Fix the thing on ${CANARY}`, '', D)[0]);
    is('a planted name in the body is caught', 'the body, line 3',
       scanText('Fix the thing', `one\ntwo\nseen on ${CANARY} last week\nfour`, D)[0]);
    is('...and both at once are both reported', 2,
       scanText(`On ${CANARY}`, `also ${CANARY}`, D).length);
    // THE LOCATION MUST NOT CARRY THE NAME. The whole point is that a public CI log can
    // say where without saying what, so this is asserted rather than left to review.
    is('the report never contains the name', false,
       scanText(`On ${CANARY}`, `also ${CANARY}`, D).join(' ').includes(CANARY));
    // A clean PR, in the vocabulary the fixtures already use.
    is('a clean title and body pass', 0,
       scanText('The card list snaps to a card, and stops when motion is not wanted',
                'Measured on acme-api/api-fix and acme-web/docs-pass; toolbox unaffected.', D).length);
    is('an absent body is not a crash', 0, scanText('A tidy title', null, D).length);
    is('...nor an absent title', 0, scanText(null, null, D).length);
    console.log(rows.join('\n'));
    process.exit(0);
  }

  // ── the CI gate ─────────────────────────────────────────────────────────
  // Read from the ENVIRONMENT, never from the command line. A title is attacker-supplied
  // text on a public repository, and `run: node x "${{ github.event.pull_request.title }}"`
  // is a shell injection with a friendly name — the interpolation happens before any shell
  // quoting can help. env: hands the value to the process without it ever being parsed.
  const at = scanText(process.env.PR_TITLE, process.env.PR_BODY);
  if (at.length === 0) {
    console.log('pr-text: no withheld name in the title or body');
    process.exit(0);
  }
  console.error(`pr-text: REFUSED — a withheld name in ${at.length} place(s):`);
  for (const where of at) console.error(`    ${where}`);
  console.error('');
  console.error('  A PR body becomes a commit message on squash-merge, and this remote is');
  console.error('  PUBLIC. Edit the title or body; the check re-runs on edit.');
  console.error('  The name is not printed here, because this log is public too.');
  process.exit(1);
}
