#!/usr/bin/env node
// test/helpers/meter-corpus.mjs — a synthetic transcript corpus for the meter's evaluator.
//
//     node test/helpers/meter-corpus.mjs <dir>            write the corpus and its baseline
//     node test/helpers/meter-corpus.mjs --digest <s>      the id this helper would emit
//
// WHY A GENERATOR AND NOT FORTY HEREDOCS. Item #5 refuses to report on a sample below its
// floor — thirty sessions for a rate — so proving the MEASURABLE direction needs a corpus of
// that size. Forty hand-written transcripts would be unreadable, undiffable, and would drift
// apart the first time one was edited; a generator with counts at the top is a spec a reader
// can check the expected values against by arithmetic. test/run.sh states those values as
// literals, so the two have to agree or a row goes red.
//
// WHY IT WRITES THE BASELINE TOO. The evaluator's control arm is "the sessions the baseline
// froze", identified by digest. A fixture baseline therefore has to name the digests of the
// control sessions this helper just wrote — which only this helper knows. Writing both from
// one place is what keeps them in step.
//
// THE SALT IS DUPLICATED FROM bin/fleet-meter.mjs, DELIBERATELY AND CHECKEDLY. Importing the
// reader would run it: the file is a script with a top-level corpus read, so an import would
// read the caller's real ~/.claude/projects and print a report. Duplicating one constant is
// the smaller evil, and it is not left on trust — test/run.sh asserts this helper's --digest
// against the reader's for the same input, so a drifted salt goes red instead of silently
// producing a baseline whose ids match nothing and a control arm of zero.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SALT = 'ghostfleet-meter-v1:';
const id = (s) => crypto.createHash('sha256').update(SALT + String(s)).digest('hex').slice(0, 12);

if (process.argv[2] === '--digest') { console.log(id(process.argv[3] ?? '')); process.exit(0); }

const DIR = process.argv[2];
if (!DIR) { console.error('usage: meter-corpus.mjs <dir>'); process.exit(2); }

// ── the spec. Every expected value in test/run.sh is arithmetic on these ────
const N_TREATED = 40;   // all carry `brief-check:`, so all are treated
const WARNED    = 30;   // ...of which these carry `brief-check: warn` — the fired marker
const CRITERION = 30;   // ...of which these carry a `Done when:` at all
const VACUOUS   = 9;    // ...of which these name nothing observable
const CORRECTED = 18;   // sessions drawing a correction turn
const EXTRA     = 15;   // sessions drawing a further turn after that
const N_CONTROL = 35;
const C_VACUOUS = 7;
const TREATED_GAP = 12; // seconds from prompt to first tool call, treated
const CONTROL_GAP = 4;  // ...and control. The difference is the "added latency".
const C_TURNS = 10;         // every control row in the fixture baseline
const C_ZERO_REWORK = 20;   // ...of which these claimed done on their last turn

const proj = path.join(DIR, 'corpus', 'acme-web-proj');
fs.mkdirSync(proj, { recursive: true });

const iso = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const rec = (o) => JSON.stringify(o);

// A turn: the human record, an assistant record that calls a tool, the tool_result carrying
// what the command printed, and a closing assistant text. Four records, because the four
// treatment positions the reader distinguishes — prompt, command, output — only exist if the
// fixture actually puts text in each of them.
function turn({ sess, br, at, gap, prompt, cmd, out, say }) {
  const base = { isSidechain: false, gitBranch: br, sessionId: sess };
  const L = [];
  L.push(rec({ ...base, type: 'user', timestamp: iso(at), message: { role: 'user', content: prompt } }));
  L.push(rec({ ...base, type: 'assistant', timestamp: iso(at + gap),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } }));
  L.push(rec({ ...base, type: 'user', timestamp: iso(at + gap + 1),
    message: { role: 'user', content: [{ type: 'tool_result', content: out }] } }));
  L.push(rec({ ...base, type: 'assistant', timestamp: iso(at + gap + 2),
    message: { role: 'assistant', content: [{ type: 'text', text: say }] } }));
  return L;
}

for (let i = 0; i < N_TREATED; i++) {
  const sess = `meter-eval-t${String(i).padStart(3, '0')}`;
  // `brief-check:` leads, and the criterion is separated by a blank line. Order matters: the
  // done-criterion capture stops at the next `key:` line, so a brief-check line placed AFTER
  // `Done when:` would truncate the criterion to nothing and score every brief vacuous.
  const check = i < WARNED ? 'brief-check: warn' : 'brief-check: ok';
  const crit = i >= CRITERION ? ''
    : i < VACUOUS ? '\n\nDone when: implemented'
    : '\n\nDone when: `./test/run.sh` is green';
  const L = [];
  L.push(...turn({
    sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: `${check}\nbuild the thing${crit}`,
    cmd: i % 2 === 0 ? 'fleet-ack "restated: one picker, per document"' : 'echo build',
    out: i % 3 === 0 ? 'understood: the unit is per document' : 'ok',
    say: i < WARNED ? 'Done. The thing is built.' : 'Working on it, more to do.',
  }));
  if (i < CORRECTED) L.push(...turn({
    sess, br: 'acme-web', at: 60, gap: TREATED_GAP,
    prompt: 'No, that is not what I asked for.', cmd: 'echo redo', out: 'ok', say: 'Fixed.',
  }));
  if (i < EXTRA) L.push(...turn({
    sess, br: 'acme-web', at: 120, gap: TREATED_GAP,
    prompt: 'and one more thing on top', cmd: 'echo more', out: 'ok', say: 'Still working.',
  }));
  fs.writeFileSync(path.join(proj, `${sess}.jsonl`), L.join('\n') + '\n');
}

// The control arm. No brief-check line, no fleet-ack, nothing printing `understood:` — so
// nothing marks it treated, which is the property being relied on rather than assumed:
// test/run.sh asserts the arms come out 40 and 35 and not 75 and 0.
const controlIds = [];
for (let i = 0; i < N_CONTROL; i++) {
  const sess = `meter-eval-c${String(i).padStart(3, '0')}`;
  controlIds.push(id(sess));
  fs.writeFileSync(path.join(proj, `${sess}.jsonl`), turn({
    sess, br: 'acme-api', at: 0, gap: CONTROL_GAP,
    prompt: `build the other thing\n\nDone when: ${i < C_VACUOUS ? 'implemented' : '`./test/run.sh` is green'}`,
    cmd: 'echo build', out: 'ok', say: 'Working on it.',
  }).join('\n') + '\n');
}

// ── the fixture baseline ────────────────────────────────────────────────────
// Sorted so `turns_to_done` lands on the same sessions every run: the reader sorts its rows
// by turn count and every control session has one turn, so row order there is not something
// to lean on. An unsorted assignment would make the control rework figure wobble between
// runs and the row would be flaky rather than wrong, which is worse.
controlIds.sort();
const baseline = (rulesDigests) => ({
  date: '2026-01-01',
  generated_at: '2026-01-01T00:00:00.000Z',
  rules: rulesDigests,
  per_session: {
    observed: { columns: ['id', 'turns'], rows: controlIds.map((x) => [x, C_TURNS]) },
    labelled: {
      columns: ['id', 'turns_to_done'],
      // A row whose done-claim is its last turn has no rework; the rest have C_TURNS - 4.
      rows: controlIds.map((x, i) => [x, i < C_ZERO_REWORK ? C_TURNS : 4]),
    },
  },
});
fs.writeFileSync(path.join(DIR, 'baseline.json'), JSON.stringify(baseline({}), null, 2));
// The same file with a rule digest that cannot match, so the suite can prove the
// same-ruler check fires. Without it that check is vacuously true and proves nothing.
fs.writeFileSync(path.join(DIR, 'baseline-wrong-rules.json'),
  JSON.stringify(baseline({ correction: { digest: 'ffffffffffff' } }), null, 2));
// And an empty cohort: a well-formed baseline that froze no sessions. The control arm is
// then 0 and the verdict must refuse on the CONTROL side, not only the treated one.
fs.writeFileSync(path.join(DIR, 'baseline-empty.json'), JSON.stringify({
  date: '2026-01-01', generated_at: '2026-01-01T00:00:00.000Z', rules: {},
  per_session: { observed: { columns: ['id', 'turns'], rows: [] },
                 labelled: { columns: ['id', 'turns_to_done'], rows: [] } },
}, null, 2));

// ── the corpus that only TALKS about the markers ───────────────────────────
// This is the failing direction for the position rule, and it is not hypothetical: the
// evaluator's first run classified a session as treated because the word `fleet-ack`
// appeared in it, and the session that appeared in was the one WRITING the marker. Left
// alone, the treated arm would have filled with the treatment's own construction — sessions
// that are unusually careful — and the treatment would have looked like it worked.
//   So every marker string is present here, in the place prose puts it: mid-sentence in the
// prompt, quoted inside a command, described in output. None is at the head of a line with
// the machinery's payload after it, and none is a command being invoked. The arms must come
// out 0 treated.
const prose = path.join(DIR, 'prose', 'acme-web-proj');
fs.mkdirSync(prose, { recursive: true });
for (let i = 0; i < 4; i++) {
  const sess = `meter-eval-p${String(i).padStart(3, '0')}`;
  fs.writeFileSync(path.join(prose, `${sess}.jsonl`), turn({
    sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'add a brief-check: line to fleet-spawn, and make fleet-ack print understood: when it records the restatement',
    cmd: `grep -n 'fleet-ack' bin/fleet-spawn && echo "prints understood: later"`,
    out: 'the contract says brief-check: ok or brief-check: warn, and fleet-ack prints understood:',
    say: 'Working on it.',
  }).join('\n') + '\n');
}

console.log(`treated ${N_TREATED} control ${N_CONTROL} prose 4 -> ${proj}`);
