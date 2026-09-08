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
function turn({ sess, br, at, gap, prompt, cmd, out, say, ask = 0 }) {
  const base = { isSidechain: false, gitBranch: br, sessionId: sess };
  const L = [];
  L.push(rec({ ...base, type: 'user', timestamp: iso(at), message: { role: 'user', content: prompt } }));
  // `ask` appends real AskUserQuestion tool_use blocks. A tool_use record is the only thing
  // that counts as having asked, which is the whole point of the prose corpus below.
  L.push(rec({ ...base, type: 'assistant', timestamp: iso(at + gap),
    message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: cmd } },
      ...Array.from({ length: ask }, (_, i) => ({ type: 'tool_use', name: 'AskUserQuestion',
        input: { questions: [{ question: `which unit, ${i}?`, header: 'Unit', multiSelect: false,
                               options: [{ label: 'per document', description: 'one' },
                                         { label: 'per line', description: 'two' }] }] } })),
    ] } }));
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

// ── the ambiguity gap: recognising, asking, and the distance between ──────
// Ten sessions arranged so all three rates are arithmetic on the counts:
//   0-2  named an ambiguity AND asked      -> recognised, asked, NOT in the gap
//   3-6  named an ambiguity, never asked   -> recognised, in the gap
//   7-8  asked, never named one            -> asked only
//   9    neither
// so asked=5, recognised=7, gap=4 of 10.
const askdir = path.join(DIR, 'ask', 'acme-web-proj');
fs.mkdirSync(askdir, { recursive: true });
for (let i = 0; i < 10; i++) {
  const sess = `meter-eval-a${String(i).padStart(3, '0')}`;
  const names = i < 7;
  const asks = i < 3 || i >= 7 && i < 9;
  fs.writeFileSync(path.join(askdir, `${sess}.jsonl`), turn({
    sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'wire up the picker', cmd: 'echo build', out: 'ok', ask: asks ? 1 : 0,
    say: names ? 'Assuming the unit is per document rather than per line, I built it that way.'
               : 'Built it and the suite is green.',
  }).join('\n') + '\n');
}

// ── the corpus that TALKS about asking, which is not asking ───────────────
// The signal is a tool_use record, and this is the corpus that proves it. Every one of these
// sessions names AskUserQuestion in the prompt, in a command, in output and in the
// assistant's own prose, and quotes the paper's title too — because this brief and that title
// are both going to end up in a real transcript, and neither is a question anybody asked.
// The ask count must be zero.
//   IT ALSO PROVES THE OTHER HALF, DELIBERATELY. The labelled rule DOES match this prose,
// because recognising an ambiguity has no unforgeable position the way a tool call does — it
// is prose by definition. The suite asserts both: asked=0 and recognised>0, so the difference
// between a fact and a label is visible in a row rather than only in a comment.
const talk = path.join(DIR, 'asktalk', 'acme-web-proj');
fs.mkdirSync(talk, { recursive: true });
for (let i = 0; i < 4; i++) {
  const sess = `meter-eval-q${String(i).padStart(3, '0')}`;
  fs.writeFileSync(path.join(talk, `${sess}.jsonl`), turn({
    sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'count the AskUserQuestion calls in the corpus and read Knowing but Not Showing: LLMs Recognize Ambiguity but Rarely Ask Clarifying Questions',
    cmd: `grep -c '"name":"AskUserQuestion"' ~/transcript.jsonl`,
    out: 'AskUserQuestion appears 57 times; models Recognize Ambiguity but rarely ask',
    say: 'The ambiguous case is that AskUserQuestion is a tool call, so assuming a string match would overcount.',
  }).join('\n') + '\n');
}

// ── the ambiguity named by the HUMAN, which is not the session noticing ───
// The measurement asks whether the SESSION recognised something, so the rule reads the
// assistant's own text. A human writing "this is ambiguous, assume per document" in the
// brief has done the recognising FOR it — counting that would score the session for the
// human's care and would make the recognition rate rise whenever the asks got clearer,
// which is backwards. So the prompts here are thick with the rule's own vocabulary and the
// assistant says nothing of the kind; recognition must be zero.
const askhuman = path.join(DIR, 'askhuman', 'acme-web-proj');
fs.mkdirSync(askhuman, { recursive: true });
for (let i = 0; i < 3; i++) {
  const sess = `meter-eval-u${String(i).padStart(3, '0')}`;
  fs.writeFileSync(path.join(askhuman, `${sess}.jsonl`), turn({
    sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'This is ambiguous and two readings are possible: assuming the unit is per document, with parity with the existing surface, and it applies retroactively.',
    cmd: 'echo build', out: 'ok',
    say: 'Built it and the suite is green.',
  }).join('\n') + '\n');
}

// ── the fourth position: a hook's own stderr ───────────────────────────────
// The record the harness writes after running a Stop hook, which is what makes this position
// unforgeable: the agent does not author it. Three sessions where the check objected and two
// where it ran and had nothing to say, so `in force` and `fired` are distinguishable — a
// cohort defined by "fired" would contain only turns the check disliked.
const hook = path.join(DIR, 'hook', 'acme-web-proj');
fs.mkdirSync(hook, { recursive: true });
const hookRec = (sess, br, at, atype, event, stderr) => JSON.stringify({
  type: 'attachment', isSidechain: false, gitBranch: br, sessionId: sess, timestamp: iso(at),
  attachment: { type: atype, hookName: 'observe-check', hookEvent: event, toolUseID: null,
                content: '', stdout: '', stderr, exitCode: 0, command: 'hooks/fleet-event.sh', durationMs: 12 },
});
for (let i = 0; i < 5; i++) {
  const sess = `meter-eval-h${String(i).padStart(3, '0')}`;
  const line = i < 3 ? 'observe-check: warn surfaces=acme-web/app.css looked=0'
                     : 'observe-check: ok   surfaces=2 looked=1';
  const L = turn({ sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'restyle the composer', cmd: 'echo edit', out: 'ok', say: 'Working on it.' });
  L.push(hookRec(sess, 'acme-web', 20, 'hook_success', 'Stop', line + '\n'));
  fs.writeFileSync(path.join(hook, `${sess}.jsonl`), L.join('\n') + '\n');
}

// ── the same line in a record that is NOT the one the contract names ───────
// A position is the record's own fields, not a string found somewhere near them. The line
// here is byte-identical to the one above; only `attachment.type` and `hookEvent` differ, and
// both must come out untreated. Without this the position check is just a string search
// wearing a longer name, and a hook_additional_context attachment — which an agent CAN
// influence, since it is fed back into the turn — would count as proof the machinery ran.
const hookwrong = path.join(DIR, 'hookwrong', 'acme-web-proj');
fs.mkdirSync(hookwrong, { recursive: true });
const WARN = 'observe-check: warn surfaces=acme-web/app.css looked=0';
for (const [i, [atype, event]] of [['hook_additional_context', 'Stop'],
                                   ['hook_success', 'PostToolUse'],
                                   ['hook_success', 'UserPromptSubmit']].entries()) {
  const sess = `meter-eval-x${String(i).padStart(3, '0')}`;
  const L = turn({ sess, br: 'acme-web', at: 0, gap: TREATED_GAP,
    prompt: 'restyle the composer', cmd: 'echo edit', out: 'ok', say: 'Working on it.' });
  L.push(hookRec(sess, 'acme-web', 20, atype, event, WARN + '\n'));
  fs.writeFileSync(path.join(hookwrong, `${sess}.jsonl`), L.join('\n') + '\n');
}

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
    prompt: 'add a brief-check: line to fleet-spawn, make fleet-ack print understood: when it records the restatement, and have the Stop hook emit observe-check: warn when nothing looked',
    cmd: `grep -n 'fleet-ack' bin/fleet-spawn && echo "prints understood: later, plus observe-check: warn"`,
    out: 'the contract says brief-check: ok or brief-check: warn, fleet-ack prints understood:, and the hook prints observe-check: warn',
    say: 'Working on it.',
  }).join('\n') + '\n');
}

console.log(`treated ${N_TREATED} control ${N_CONTROL} ask 10 asktalk 4 askhuman 3 hook 5 hookwrong 3 prose 4 -> ${proj}`);
