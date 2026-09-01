#!/usr/bin/env node
// bin/fleet-meter.mjs — utilization numbers over the local transcript corpus.
//
//     fleet-meter                      the summary, for a human
//     fleet-meter --json               every row, machine-readable
//     fleet-meter --baseline           the pre-registration document (JSON on stdout)
//     fleet-meter --by branch          summarise per branch instead of per session
//     fleet-meter --corpus DIR         read DIR instead of ~/.claude/projects
//     fleet-meter --include-excluded   do NOT apply the exclusion list
//     fleet-meter --why                say which sessions the exclusion list matched
//     fleet-meter --digest STRING      print the id to paste into EXCLUDE
//     fleet-meter --evaluate           plan item #5, against the committed baseline
//     fleet-meter --evaluate --baseline-file P   ...against some other baseline
//     fleet-meter --contract           what #3 and #4 must emit for #5 to be measurable
//
// WHY THIS EXISTS. Every number in docs/improvement-plan.md was produced by hand, weeks
// after the fact, by reading transcripts. Numbers gathered that way cannot be re-gathered:
// nobody can check them, and nobody can repeat the measurement after a change to see
// whether the change did anything. This reads the same files and prints the same kind of
// number in a couple of minutes, from a rule written down rather than from a judgment made
// once and forgotten.
//
// ── THE ONE RULE THAT SHAPES THE WHOLE FILE ─────────────────────────────────
// A COUNT AND A LABEL ARE NOT THE SAME KIND OF THING, so they do not share an output.
// "This turn issued 173 tool calls" is a fact: the records say so, and two readers who
// disagree about it disagree about arithmetic. "This turn was a correction" is a judgment,
// and a regex making that judgment is still a judgment — a fast, consistent, WRONG-in-a-
// fixed-direction one. Mixing the two produces a number nobody can audit, because a reader
// who distrusts the correction rule has no way to keep the parts that do not depend on it.
//   So `observed` contains only quantities derived by counting records, and NOTHING in it
// looks at a single character of message text. `labelled` contains everything derived by
// matching text against a pattern, and each entry carries the pattern's source and its
// digest, so a later run can prove it used the same rule rather than a rule quietly retuned
// to make a result come out. Two of the five numbers are observed; three are labelled.
//
// ── AND THE SECOND RULE: COUNTS AND DIGESTS, NEVER CONTENT ──────────────────
// The corpus is not this repo's. It holds work for other people, and a transcript carries
// their file paths, their branch names, their business in the message bodies. So no output
// of this program — not --json, not the committed baseline, not an error message — contains
// a message body, a file path, a project directory name, or a branch name. Sessions and
// branches appear as a salted twelve-character digest, which is stable across runs, so two
// baselines taken a month apart can be compared row by row without either naming anything.
// This follows the dispatch log, which records a prompt's length and digest and never its
// text, and the name sweep, which stores what it forbids one-way for the same reason.
//   The digest is not secrecy. A branch name is short and guessable and anyone holding one
// can confirm it by hashing it. It stops the repo from PUBLISHING a roster of them, which
// is the whole of what is being asked for.
//   The one place a real name may appear is EXCLUDE below: hand-written, in the diff, and
// reviewed by a person. Anything DERIVED FROM THE DATA is digested unconditionally — there
// is no per-branch "is this one safe" test, because that test gets got wrong exactly once
// and the wrong answer is committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ── identity ────────────────────────────────────────────────────────────────
// Public salt, same trick as test/helpers/name-sweep.mjs: it defeats a precomputed table
// and nothing else. Bumping it invalidates every id in every baseline ever written, which
// is the point of naming it v1 — a future change to the scheme gets a new name rather than
// silently making two baselines incomparable.
const SALT = 'ghostfleet-meter-v1:';
const id = (s) => crypto.createHash('sha256').update(SALT + String(s)).digest('hex').slice(0, 12);

// ── what counts as a turn, and what is not a human ──────────────────────────
// A turn opens at a human prompt and runs to the next human prompt or to end of file. The
// interesting quantities are all per-turn, so getting this boundary wrong moves every
// number at once, in the same direction, invisibly.
//   THREE KINDS OF RECORD LOOK LIKE A HUMAN AND ARE NOT. A sidechain record is a subagent's
// own conversation, so its tool calls belong to no human turn. An isMeta record is the
// harness talking to itself. And a user record carrying a tool_result block is the
// TRANSPORT for a tool's output — by volume it is most of them: 482 of 517 user records in
// one measured session, so treating them as prompts would report a session of 24 turns as
// a session of 506, and divide every per-turn number by twenty.
//   The filter is exactly those three and no more. It is deliberately not extended to the
// automated nudge a worker's Stop hook pastes into the lead's input box, which arrives
// indistinguishable from a typed prompt; the baseline reports how many of those there are
// instead, so the effect on the totals can be seen rather than argued about.
const NUDGE = /^\s*\[fleet\]/;

const isSidechain = (r) => r.isSidechain === true;
const isMeta = (r) => r.isMeta === true;
const hasToolResult = (m) => Array.isArray(m?.content) && m.content.some((b) => b && b.type === 'tool_result');

// Text, for the LABELLED half only. The observed half never calls this.
//   The wrappers are stripped first. A prompt arrives carrying <system-reminder> blocks the
// harness injected and <local-command-stdout> from a slash command, and neither was typed
// by anybody — a correction rule that reads them is labelling the harness's own prose.
const strip = (t) => String(t)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
  .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
  .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, ' ');

const textOf = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return strip(c);
  if (!Array.isArray(c)) return '';
  return strip(c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n'));
};

// ── rule 1 (observed): a sleep inside a turn ────────────────────────────────
// Bare seconds only, because that is the only form the corpus contains: 3,796 occurrences,
// not one of them carrying an m/h/s suffix. The leading class is what stops `--sleep 5` and
// `no_sleep 30` from counting, and it is a class rather than \b because \b matches between
// `-` and `s`.
//   BACKGROUNDED SLEEPS DO NOT COUNT. `sleep 600 &` and a run_in_background call both return
// at once; the wall clock of the turn does not include them, and counting them would report
// a turn that waited for nothing as the most patient in the corpus.
//   THE EXCLUSION IS PER COMMAND, NOT PER SLEEP, so a command holding both a backgrounded
// and a foreground sleep contributes nothing rather than contributing the foreground one.
// That undercounts, and it is deliberate: the alternative is a second pass deciding which
// `&` belongs to which `sleep`, and a wrong answer THERE would overcount — inventing
// patience the turn did not have, in the one metric whose whole point is that a turn spent
// its time waiting. An undercount is the safe direction for a number being used to argue
// that too much time goes on sleeping.
//   A Monitor call is not a sleep either, even when its command loops. Monitor waits on a
// condition and returns when the condition holds; that is the sanctioned alternative to
// sleeping, and counting it would score the fix as the problem.
const SLEEP_RE = /(?:^|[;&|(\s])sleep\s+([0-9]+(?:\.[0-9]+)?)(?![0-9.])/g;
const BACKGROUNDED = /sleep\s+[0-9]+(?:\.[0-9]+)?\s*&(?!&)/;

// ── rule 2 (observed): a browser was opened ─────────────────────────────────
// "Opened a browser" means something rendered the page. Every chrome-devtools tool call
// qualifies, and so does a shell that drove a real engine: fleet-look, playwright,
// puppeteer, a bare chromium.
//   CURL IS NOT A BROWSER and is excluded on purpose, though it is the commonest way a turn
// touches a running app — 1,313 Bash calls in this corpus. A 200 from curl says the route
// answered; it does not say the screen drew, and the plan's whole finding is about turns
// that changed a screen and never looked at one. Counting curl would report those turns as
// having looked.
const BROWSER_TOOL = /^mcp__chrome-devtools__/;
const BROWSER_BASH = /\b(fleet-look|playwright|puppeteer|chromium)\b/i;

// ── rule 2b (observed): a file was TOUCHED ──────────────────────────────────
// Touched means written. Read carries a file_path too, and counting it looked harmless
// until the arithmetic: reads outnumber writes, they are the denominator of "corrections
// per distinct file touched", and including them dropped that ratio by a third across the
// corpus while changing nothing about how often anyone was corrected. A denominator that
// grows when the agent is being CAREFUL is the wrong denominator.
const WRITE_TOOL = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// ── rule 3 (labelled): a done-claim ─────────────────────────────────────────
// Matched against the turn's FINAL assistant text — the message that ends the turn, not
// anything said on the way there. An agent narrating "once that's done" mid-turn is not
// claiming to be finished; the last thing it says before handing back is.
// ANCHORED TO THE START OF A LINE, because "done" is one of the commonest words in the
// corpus and an unanchored match labels essentially every turn. A claim is a sentence that
// OPENS with the claim, or a heading, or a tick. The leading class skips a markdown bullet
// or heading marker and is ONE class rather than `\s*` followed by a class that also holds
// `\s` — two quantifiers over overlapping sets, which is how a regex over a few hundred
// megabytes of transcript stops being linear.
const DONE_CLAIM = /(?:^|\n)[\s*_#>-]*(?:✅|✓|☑|(?:all\s+)?done\b|complete[d]?\b|finished\b|fixed\b|shipped\b|landed\b|(?:it|that|this)(?:'s| is)\s+(?:done|fixed|working|ready)\b|(?:i(?:'ve| have)\s+)?(?:implemented|fixed|added|shipped|landed)\b|ready\s+to\s+(?:merge|review|ship)\b|all\s+(?:the\s+)?tests?\s+pass)/i;

// ── rule 4 (labelled): a correction ─────────────────────────────────────────
// A human turn that tells the agent it went the wrong way, as opposed to one that asks for
// the next thing. This is the judgment in the file and it is the reason `labelled` exists
// as a separate section: the rule below is a stand-in for a person reading the turn, it is
// wrong in both directions, and a reader who does not accept it can discard every number
// that depends on it and keep the rest.
//   THE FIRST TURN OF A SESSION IS NEVER A CORRECTION however it reads. It is the brief, and
// a brief that opens "don't use X" would otherwise be counted as the agent having already
// failed at something it had not been asked to do yet.
const CORRECTION = /\b(?:no,|nope\b|wrong\b|not what i (?:asked|wanted|meant)|that'?s not|you (?:missed|broke|didn'?t|forgot|were supposed)|still (?:broken|failing|wrong|not)|revert\b|undo\b|instead of|i (?:said|told you)|why did you|stop\b|doesn'?t work|didn'?t work|does not work|it'?s (?:still )?(?:broken|failing))/i;

const RULES = {
  turn: 'opens at an eligible human user record, runs to the next one or to end of file',
  eligibility: 'a user record that is not isSidechain, not isMeta, and carries no tool_result block',
  sleep: { kind: 'observed', pattern: String(SLEEP_RE), excludes: String(BACKGROUNDED) },
  browser: { kind: 'observed', tools: String(BROWSER_TOOL), bash: String(BROWSER_BASH) },
  file_touched: { kind: 'observed', tools: [...WRITE_TOOL], note: 'written, not read — see WRITE_TOOL' },
  done_claim: { kind: 'labelled', pattern: String(DONE_CLAIM), applied_to: "the turn's final assistant text" },
  correction: { kind: 'labelled', pattern: String(CORRECTION), applied_to: 'a human turn other than the first of its session' },
};
for (const k of ['sleep', 'browser', 'file_touched', 'done_claim', 'correction']) RULES[k].digest = id(JSON.stringify(RULES[k]));

// ════════════════════════════════════════════════════════════════════════════
// PLAN ITEM #5 — THE EVALUATOR
// ════════════════════════════════════════════════════════════════════════════
// Item #5 promotes a warning to a hard gate only when a failure mode SHOWS UP in
// measurement. Four measurements decide it: false refusals, bypass rate, added latency per
// dispatch, and rework. Everything above this line is the ruler; this is the reading.
//
// ── THE THING THIS FILE MUST DO ON THE DAY IT SHIPS IS REFUSE ───────────────
// #3 and #4 are not merged. The treated cohort is therefore empty, and every rate over an
// empty denominator is either NaN or, worse, a tidy 0 — which reads as "no false refusals,
// no bypass, no added latency", the most flattering result available, and is the precise
// mistake v1 of the plan was going to make: justify a gate on a number that measured
// nothing. So "not measurable" is a first-class output here, it says why, and it says what
// it is waiting for. It is the same correction as the medians above returning null rather
// than 0 on an empty cohort, applied to a whole verdict instead of one field.
//
// ── WHAT MAKES A SESSION *TREATED*, AND WHY NOT BY DATE ─────────────────────
// A date cut is the obvious move and it is wrong. #3 and #4 land in `fleet-spawn` and the
// manifest, not in every session: a session that ran an hour after the merge, from a shell
// that never invoked the changed path, is untreated in every respect except its timestamp.
// A date cut sweeps all of those in, and since they behave exactly like the control it
// dilutes any real effect toward zero — a treatment that worked would read as no effect.
// So treatment is identified MECHANICALLY, by a marker the machinery itself leaves in the
// transcript.
//
// ── AND THAT MAKES THIS FILE A CONTRACT, WHICH IS DELIBERATE ────────────────
// The markers below do not exist yet, because the code that emits them does not exist yet.
// Pre-registering them is the point: #3 and #4 have to emit these to be measurable, and an
// implementation that ships without them gets an EMPTY treated cohort rather than a wrong
// one — the evaluator says "marker not found" instead of quietly measuring some other
// population. If a future implementer picks different words, the fix is to change the
// marker here in one place and say in the commit that the pre-registration moved.
//   `--contract` prints exactly what has to be emitted, so nobody has to read this comment
// to find out.
//
// Two levels per intervention, and conflating them is the trap: IN FORCE means the
// machinery ran at all (this is what defines the cohort), FIRED means it actually objected
// (this is the denominator for false refusals). A cohort defined by "fired" would contain
// only briefs the checker disliked, so the false-refusal rate would be measured against a
// population selected for being warned — which is how you get a rate of 100%.
//
// ── A MARKER IS A POSITION AS WELL AS A STRING, AND THE FIRST VERSION WAS NOT ─
// MEASURED, on the first run of this evaluator: `/\bfleet-ack\b/` classified a session as
// TREATED because the word appeared in it. Nothing had run — the transcript merely talked
// about the marker, which is precisely what the session BUILDING #3 and #4 does all day.
// The treated arm would therefore have filled up with the treatment's own construction, and
// since those sessions are unusually careful, the treatment would have looked like it
// worked. That is the same contamination the baseline's exclusion list exists to stop,
// arriving through a door the exclusion list does not cover.
//   So a marker now declares WHERE it may appear, and each position is somewhere only the
// machinery can put it:
//     prompt   the text of a human turn      — #3's verdict carried into the dispatch
//     output   a tool_result's text          — what a command printed
//     command  a Bash/Monitor command string — the agent invoking something
// A worker INVOKES fleet-ack, so `command`. fleet-ack PRINTS its acknowledgement, so
// `output`. Talking about either in prose is neither, and no longer counts.
//   ANCHORING DOES THE OTHER HALF. Every pattern is pinned to the start of a line and
// requires the machinery's own payload after it — `brief-check:` alone is prose, and
// `brief-check: warn` at the head of a line is a program talking. Same correction as the
// done-claim rule above, for the same reason: an unanchored common word matches everything.
//   THIS IS BEING FIXED BEFORE ANYTHING HAS BEEN MEASURED AGAINST IT, which is the only
// time changing a pre-registered rule is legitimate. Once a treated cohort exists, moving
// these means starting the measurement again and saying so.
const TREATMENT = {
  brief_check_in_force: {
    of: '#3', level: 'in force', where: ['output', 'prompt'],
    contract: "fleet-spawn must print a line beginning 'brief-check: ok' or 'brief-check: warn' on every dispatch, and carry it into the dispatched prompt",
    re: /(?:^|\n)[^\S\n]*brief-check:[ \t]*(?:ok|warn)\b/i,
  },
  brief_check_fired: {
    of: '#3', level: 'fired', where: ['output', 'prompt'],
    contract: "when the brief has no done-criterion or reads as several asks, that line must read 'brief-check: warn'",
    re: /(?:^|\n)[^\S\n]*brief-check:[ \t]*warn\b/i,
  },
  ack_in_force: {
    of: '#4', level: 'in force', where: ['command'],
    contract: "the worker's acknowledgement recorder must be invoked as a command named 'fleet-ack'",
    re: /(?:^|[;&|(]|\n)[ \t]*fleet-ack(?:\s|$)/,
  },
  ack_resolved_decisions: {
    of: '#4', level: 'fired', where: ['output'],
    contract: "fleet-ack must print a line beginning 'understood:' naming which of the lead's resolved decisions the worker is working from",
    re: /(?:^|\n)[^\S\n]*understood:[ \t]*\S/i,
  },
};
for (const [k, v] of Object.entries(TREATMENT)) { v.pattern = String(v.re); v.digest = id(k + '|' + v.pattern + '|' + v.where.join(',')); }

// ── THE MARKER HAS TO REACH THE SESSION WHOSE OUTCOME IS BEING JUDGED ───────
// This is the one demand the evaluator makes of #3 rather than merely observing it, and it
// is worth stating plainly because it is a design constraint on unwritten code.
//   A false refusal is "the checker objected AND the work turned out fine". The objection
// happens in the LEAD; the work turning out fine happens in the WORKER. Nothing links one
// transcript to the other — a session id in the lead's tool output is not in the worker's
// records — so measured from the lead's side the outcome is invisible, and measured from the
// worker's side the objection is. Either way the rate cannot be computed.
//   So the contract requires the verdict to travel WITH the dispatch, into the prompt the
// worker receives. Then both halves are in one transcript and the measurement is
// session-local, which is the only shape that works without a join nothing supports.
// Stated as a limitation rather than hidden: if #3 ships without carrying its verdict
// forward, false refusals are not measurable at all and this file will say so.

// ── measurement 1 (labelled): a false refusal ───────────────────────────────
// Denominator: sessions whose brief carried a FIRED brief-check. Numerator: those that then
// went fine anyway — reached a done-claim and drew no correction. "Went fine" is the
// judgment, and it is composed of the two labelled rules above rather than a new one, so a
// reader who has already rejected the correction rule does not have to reject a second
// thing for the same reason.
//   IT IS AN UPPER BOUND, NOT A RATE. A brief the checker warned about may have been fixed
// by the human before dispatch, in which case the warning was RIGHT and the smooth run is
// the warning working. Nothing in the transcript distinguishes that from a warning that was
// never needed. So this counts warnings-followed-by-clean-runs, which is the largest the
// false-refusal rate could be, and the output names it `_upper_bound` so nobody quotes it
// as the rate itself.

// ── measurement 2 (labelled): a vacuous done-criterion ─────────────────────
// The plan's own example is `Done when: implemented`, which passes any parser and says
// nothing. Vacuity is judged by asking whether the criterion names anything a person could
// go and LOOK AT: a path, a command, a count, a named artifact. That is the same standard
// the contract in every session's system prompt applies to a done-report, so the rule is
// not invented here.
//   SHORTNESS ALONE IS NOT VACUITY and the floor is deliberately low. `Done when: CI green`
// is eight characters and perfectly observable. What makes a criterion vacuous is the
// absence of an observable, not its length, so the length floor only catches the degenerate
// case where there is not room for one.
const DONE_WHEN = /(?:^|\n)[\s*_#>-]*done\s+when\s*:?[ \t]*([\s\S]{0,400}?)(?=\n\s*\n|\n[\s*_#>-]*[a-z-]+\s*:|$)/i;
const OBSERVABLE = /(`[^`]+`)|(\S+\/\S+)|(\b\w+\.(?:mjs|js|ts|tsx|json|sh|md|html|css|py|go|yml|yaml)\b)|(\b\d+\b)|(\b(?:test|tests|suite|green|red|screen|render|renders|rendered|pr|exit|row|rows|log|logs|output|column|columns|assert|asserts|passes|prints|reports|emits)\b)/i;
const VACUOUS_MIN_CHARS = 8;

// ── measurement 3 (observed): added latency per dispatch ───────────────────
// Seconds from the human record's timestamp to the timestamp of the first assistant message
// in that turn that actually calls a tool. Nothing in it reads message text, so it sits on
// the observed side.
//   IT INCLUDES MODEL TIME AND IS USELESS AS AN ABSOLUTE. The gap covers the model reading,
// thinking and generating, which dwarfs anything a pre-dispatch protocol adds. Only the
// DIFFERENCE between two arms means anything, and only when both arms were measured over a
// comparable period — which is exactly why the control here is the baseline's frozen cohort
// and not a number retyped from the plan.

// ── measurement 4 (labelled): rework ───────────────────────────────────────
// Turns after the first done-claim. The count is arithmetic; the BOUNDARY is a label, since
// it is the done-claim rule that decides where "after" starts, so the whole measurement is
// labelled. Its control needs no re-reading at all: the committed baseline already carries
// `turns` and `turns_to_done`, and rework is the subtraction.

const MEASUREMENTS = {
  false_refusals: {
    kind: 'labelled', unit: 'session',
    of: 'a session whose brief carried a fired brief-check, that then reached a done-claim with no correction',
    min_n: 30,
    why_min_n: 'the rule of three: with 0 events in 30 trials the 95% upper bound on the rate is 3/30 = 10%. Below 30 the interval is wider than any effect that would justify promoting a warning to a gate, so a number there could not decide the question it is being asked',
    needs: ['brief_check_fired', 'done_claim', 'correction'],
  },
  bypass_rate: {
    kind: 'labelled', unit: 'session',
    of: 'a brief carrying a Done when: whose criterion names nothing observable',
    min_n: 30,
    why_min_n: 'the rule of three, as above: this is a proportion and 30 is where its interval becomes narrower than the effect',
    needs: ['done_when', 'observable'],
  },
  added_latency_seconds: {
    kind: 'observed', unit: 'turn',
    of: 'seconds from a human turn to the first tool call in it; reported as the difference of medians between arms',
    min_n: 20,
    why_min_n: 'a median, not a proportion. The nonparametric interval on a median is built from order statistics, and below about 20 it spans nearly the whole sample — an "added latency" would be indistinguishable from the spread it was drawn out of',
    needs: [],
  },
  rework_turns: {
    kind: 'labelled', unit: 'session',
    of: 'turns after the first done-claim, and the share of done-claiming sessions with any',
    min_n: 30,
    why_min_n: 'reported both as a rate (share of sessions with any rework) and a median, so it takes the stricter of the two floors',
    needs: ['done_claim'],
  },
};
for (const [k, v] of Object.entries(MEASUREMENTS)) v.digest = id(k + '|' + JSON.stringify(v));

// ── the exclusion list ──────────────────────────────────────────────────────
// THE SESSIONS THAT PRODUCED THE PLAN THIS METER EXISTS TO TEST. They are outliers on every
// axis the meter measures, and leaving them in would let the plan's own authoring inflate
// the baseline the plan is judged against — a measurement contaminated by the act of
// deciding to measure.
//   RECORDED HERE RATHER THAN APPLIED SILENTLY, and repeated into the baseline document, so
// a reader can re-run with --include-excluded and see exactly what the exclusion bought.
// Each is named by its id — the digest of its session id, printable with --digest — because
// the alternative name is a project directory, and those are not this repo's to publish.
// `--why` prints which ones actually matched, so an entry that has stopped matching (a
// pruned transcript, a renamed session) shows up as absent instead of quietly excluding
// nothing.
const EXCLUDE = [
  { id: '33a05219cca5',    label: 'lead',           reason: 'the long-lived lead session that wrote the plan: ten days, thirty-two branches, and the single window the plan cites for its sleep finding. Its per-turn numbers are the anecdote, so it cannot also be the control' },
  { id: 'f1a7b4df2d14',   label: 'sweep',          reason: 'a deleted checkout whose work was a leak sweep — hundreds of near-identical edits over a name list, which is real work and nothing like a build turn' },
  { id: 'c55a0ffeba10',  label: 'review',         reason: 'a day of process work: the external-tools review that became an input to the plan. No code, so every per-file number is a division by nothing' },
  { id: '2004bc3f23b7',   label: 'meter',          reason: 'the session that wrote this file. It is still growing as the baseline is taken, so including it would make the baseline unreproducible by construction' },
];

// ── reading ─────────────────────────────────────────────────────────────────
function corpusFiles(root) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(root, d);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    let fl = []; try { fl = fs.readdirSync(p); } catch { continue; }
    for (const f of fl) if (f.endsWith('.jsonl')) out.push(path.join(p, f));
  }
  return out.sort();
}

// One turn's accumulator. Text is looked at as it arrives and then dropped: nothing here
// holds a message body past the line that produced it, so a corpus of any size costs the
// same memory and no body can leak into an output by accident.
const newTurn = (branch, ts) => ({
  branch, started: ts, ended: ts,
  tools: 0, sleepSeconds: 0, sleepCalls: 0, browser: 0,
  files: new Set(), doneClaim: false, correction: false, nudge: false,
  // ── item #5's fields. Added beside the baseline's rather than folded into them, and
  // nothing above reads them, so the pre-registered numbers and their digests are exactly
  // what they were the day the baseline was taken. A metric that changes when a new metric
  // is added is not a baseline.
  firstToolAt: null,          // timestamp of the first tool-calling message in this turn
  doneWhen: null,             // 'observable' | 'vacuous' — only ever set on a session's first turn
  treated: new Set(),         // which TREATMENT markers this turn saw
});

// Marker scanning is one function so the four markers are applied uniformly to every place
// text can arrive, rather than three of them being checked in one branch and forgotten in
// another — which is how a cohort ends up defined by where somebody remembered to look.
function markTreatment(turn, text, where) {
  if (!text) return;
  for (const [k, v] of Object.entries(TREATMENT))
    if (v.where.includes(where) && v.re.test(text)) turn.treated.add(k);
}

// A tool_result's content is often a plain string rather than text blocks, and textOf()
// returns '' for it. That emptiness is why this exists: the markers live in command output,
// which is exactly the shape textOf() cannot see.
function rawText(m) {
  const c = m?.content;
  if (typeof c === 'string') return strip(c);
  if (!Array.isArray(c)) return '';
  return strip(c.map((b) => (typeof b?.content === 'string' ? b.content
    : Array.isArray(b?.content) ? b.content.map((x) => x?.text || '').join('\n')
    : b?.text || '')).join('\n'));
}

// null when the brief has no `Done when:` at all — which is NOT the same as a vacuous one
// and must not be pooled with it. The bypass rate's denominator is briefs that carried a
// criterion; a brief with none never entered the question.
function classifyDoneWhen(text) {
  const m = DONE_WHEN.exec(text || '');
  if (!m) return null;
  const crit = String(m[1] || '').trim();
  if (crit.length < VACUOUS_MIN_CHARS) return 'vacuous';
  return OBSERVABLE.test(crit) ? 'observable' : 'vacuous';
}

async function readSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const turns = [];
  let cur = null, sessionId = null, bad = 0, records = 0;
  const branches = new Set();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    records++;
    if (isSidechain(r)) continue;
    if (r.sessionId && !sessionId) sessionId = r.sessionId;

    if (r.type === 'user') {
      // A tool_result is not a turn — but it is where a command's OUTPUT lands, and three of
      // the four treatment markers are things a command prints. So it is scanned for markers
      // on the way past and then dropped, exactly as before, without becoming a turn. Miss
      // this and `fleet-spawn: brief-check: warn` is invisible: the cohort comes out empty
      // for a fleet that is fully treated, which looks identical to a fleet that is not.
      if (isMeta(r) || hasToolResult(r.message)) {
        if (cur) markTreatment(cur, rawText(r.message) || textOf(r.message), 'output');
        continue;
      }
      const branch = r.gitBranch || '';
      if (branch) branches.add(branch);
      cur = newTurn(branch, r.timestamp || null);
      const t = textOf(r.message);
      cur.nudge = NUDGE.test(t);
      markTreatment(cur, t, 'prompt');
      // Only the FIRST turn of a session carries the brief, so only it is asked for a
      // done-criterion. A `Done when:` typed in a later turn is a mid-flight requirement,
      // not the criterion the dispatch was judged against, and counting it would let one
      // session contribute several denominators.
      if (turns.length === 0) cur.doneWhen = classifyDoneWhen(t);
      // The first turn of a session is the brief. See CORRECTION above.
      cur.correction = turns.length > 0 && CORRECTION.test(t);
      turns.push(cur);
      continue;
    }

    if (r.type !== 'assistant' || !cur) continue;
    if (r.timestamp) cur.ended = r.timestamp;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;

    let sawText = false, lastText = '', sawTool = false;
    for (const b of content) {
      if (b?.type === 'text') { sawText = true; lastText = b.text || ''; continue; }
      if (b?.type !== 'tool_use') continue;
      sawTool = true;
      cur.tools++;
      const name = b.name || '';
      const inp = b.input || {};
      if (BROWSER_TOOL.test(name)) cur.browser++;
      if (WRITE_TOOL.has(name) && typeof inp.file_path === 'string' && inp.file_path) cur.files.add(id(inp.file_path));
      if (name === 'Bash' || name === 'Monitor') {
        const cmd = String(inp.command ?? '');
        if (BROWSER_BASH.test(cmd)) cur.browser++;
        // #4's marker is the worker INVOKING its recorder, so it is in the command the
        // agent wrote, not in anything printed back.
        markTreatment(cur, cmd, 'command');
        if (name === 'Bash' && inp.run_in_background !== true && !BACKGROUNDED.test(cmd)) {
          SLEEP_RE.lastIndex = 0;
          let m;
          while ((m = SLEEP_RE.exec(cmd))) { cur.sleepSeconds += Number(m[1]); cur.sleepCalls++; }
        }
      }
    }
    // The FIRST tool-calling message fixes the latency, so a later one must not move it.
    // Written as an explicit null check rather than `||=` because a turn whose first action
    // came at second zero is a real measurement and must not be overwritten as absent.
    if (sawTool && cur.firstToolAt === null && r.timestamp) cur.firstToolAt = r.timestamp;
    // The turn's final assistant text is whatever the last text-bearing message said. A
    // later message with only tool calls does not clear it — the claim was still made.
    if (sawText) cur.doneClaim = DONE_CLAIM.test(strip(lastText));
  }
  return { sessionId, file, turns, bad, records, branches: [...branches] };
}

// ── aggregation ─────────────────────────────────────────────────────────────
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const round = (n, p = 3) => Number.isFinite(n) ? Number(n.toFixed(p)) : null;
const secs = (a, b) => (a && b) ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : 0;

// Both halves of one unit's row. `observed` never reads a label; `labelled` may read a
// count (turns_to_done is an index into turns) but nothing in `observed` depends on it, so
// discarding `labelled` leaves `observed` whole.
function summarise(turns) {
  const perTurnTools = turns.map((t) => t.tools);
  const perTurnSleep = turns.map((t) => t.sleepSeconds);
  const files = new Set();
  for (const t of turns) for (const f of t.files) files.add(f);

  const observed = {
    turns: turns.length,
    tool_calls: perTurnTools.reduce((a, b) => a + b, 0),
    tool_calls_per_turn_mean: turns.length ? round(perTurnTools.reduce((a, b) => a + b, 0) / turns.length) : 0,
    tool_calls_per_turn_median: round(median(perTurnTools)),
    tool_calls_max_turn: turns.length ? Math.max(...perTurnTools) : 0,
    sleep_seconds: round(perTurnSleep.reduce((a, b) => a + b, 0), 1),
    sleep_seconds_per_turn_mean: turns.length ? round(perTurnSleep.reduce((a, b) => a + b, 0) / turns.length, 1) : 0,
    sleep_seconds_max_turn: turns.length ? round(Math.max(...perTurnSleep), 1) : 0,
    sleep_calls: turns.reduce((a, t) => a + t.sleepCalls, 0),
    sleep_turns: turns.filter((t) => t.sleepCalls > 0).length,
    browser_calls: turns.reduce((a, t) => a + t.browser, 0),
    browser_turns: turns.filter((t) => t.browser > 0).length,
    distinct_files: files.size,
    wall_seconds: turns.length ? secs(turns[0].started, turns[turns.length - 1].ended) : 0,
    nudge_turns: turns.filter((t) => t.nudge).length,
  };

  const doneIdx = turns.findIndex((t) => t.doneClaim);
  // "A browser was opened before a done-claim" is asked of the run up to and including the
  // turn that claims done, not of the whole session. A browser opened afterwards — during
  // the rework the claim provoked — is the opposite of the thing being measured.
  const upToDone = doneIdx < 0 ? null : turns.slice(0, doneIdx + 1);
  const corrections = turns.filter((t) => t.correction).length;

  const labelled = {
    done_claim_turns: turns.filter((t) => t.doneClaim).length,
    turns_to_done: doneIdx < 0 ? null : doneIdx + 1,
    browser_before_done_claim: upToDone ? upToDone.some((t) => t.browser > 0) : null,
    browser_calls_before_done_claim: upToDone ? upToDone.reduce((a, t) => a + t.browser, 0) : null,
    corrections,
    corrections_per_distinct_file: files.size ? round(corrections / files.size, 4) : null,
  };
  return { observed, labelled };
}

// THE COHORT ROLL-UP, and why two of the five numbers cannot be pooled.
// Pooling works for a count: total tool calls over total turns is a real quantity, and it
// is the shape the plan's own ratios were computed in. It is a category error for the other
// two. Flatten every session into one list and "turns to the first done-claim" becomes the
// position of the first done-claim ANYWHERE IN THE CORPUS — which came out as 2, a number
// about nothing, and "was a browser opened before it" becomes a question about the corpus's
// second turn. Those two are per-session facts and only a distribution ACROSS sessions says
// anything, so they live here and are absent from the pooled block rather than being
// printed there as an impressive-looking 2.
//   Sessions that never claim done are counted rather than dropped: a cohort where a third
// of the sessions never say they finished is telling you something, and a median taken over
// the two-thirds that did would hide it.
function cohort(rows) {
  const done = rows.filter((r) => r.labelled.turns_to_done !== null);
  const withFiles = rows.filter((r) => r.labelled.corrections_per_distinct_file !== null);
  return {
    units: rows.length,
    units_claiming_done: done.length,
    units_never_claiming_done: rows.length - done.length,
    // null, not 0, when nothing is there to take a median of. An empty cohort printing
    // "median turns to done: 0" reads as a finding — the best possible result — when what
    // it means is that no session in the cohort ever claimed to be finished.
    turns_to_done_median: done.length ? round(median(done.map((r) => r.labelled.turns_to_done))) : null,
    turns_to_done_mean: done.length ? round(done.reduce((a, r) => a + r.labelled.turns_to_done, 0) / done.length) : null,
    browser_before_done_claim_units: done.filter((r) => r.labelled.browser_before_done_claim).length,
    browser_before_done_claim_fraction: done.length
      ? round(done.filter((r) => r.labelled.browser_before_done_claim).length / done.length, 4) : null,
    tool_calls_per_turn_median_of_units: rows.length ? round(median(rows.map((r) => r.observed.tool_calls_per_turn_mean))) : null,
    sleep_seconds_median_of_units: rows.length ? round(median(rows.map((r) => r.observed.sleep_seconds)), 1) : null,
    corrections_per_distinct_file_median_of_units: withFiles.length
      ? round(median(withFiles.map((r) => r.labelled.corrections_per_distinct_file)), 4) : null,
  };
}

// ── item #5: reading a baseline file back ───────────────────────────────────
// The committed baseline is columns-and-rows, so this turns one of its tables back into
// objects keyed by session id. WHY IT MATTERS THAT THE COHORT IS IN THAT FILE: it froze a
// LIST OF SESSIONS, not just a set of totals, and a frozen list of sessions is a control
// group. A column the baseline never computed can still be computed over exactly those
// sessions later and remain a pre-registered control, because what pre-registration buys is
// the population, not the arithmetic. That is what lets latency and bypass — neither of
// which the baseline holds a column for — be measured against it honestly.
//   The alternative was an addendum recomputed over "the corpus as it is now", which has
// grown by every session run since, including the sessions that BUILT the treatment. A
// control arm containing the treatment's own construction is not a control arm.
function readBaseline(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (t) => {
    const out = new Map();
    for (const r of t.rows) out.set(r[0], Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
    return out;
  };
  const obs = rows(raw.per_session.observed);
  const lab = rows(raw.per_session.labelled);
  return { file, date: raw.date, generated_at: raw.generated_at, rules: raw.rules, obs, lab,
           ids: new Set(obs.keys()) };
}

// ── item #5: the four measurements ──────────────────────────────────────────
const isTreated = (sess) => sess.turns.some((t) => t.treated.has('brief_check_in_force') || t.treated.has('ack_in_force'));

const latencies = (sessions) => sessions.flatMap((s) => s.turns
  .filter((t) => t.started && t.firstToolAt)
  .map((t) => Math.max(0, (Date.parse(t.firstToolAt) - Date.parse(t.started)) / 1000)));

function falseRefusals(sessions) {
  const warned = sessions.filter((s) => s.turns.some((t) => t.treated.has('brief_check_fired')));
  const fine = warned.filter((s) => s.turns.some((t) => t.doneClaim) && !s.turns.some((t) => t.correction));
  return { n: warned.length, events: fine.length };
}

function bypass(sessions) {
  const withCriterion = sessions.filter((s) => s.turns[0]?.doneWhen !== null && s.turns[0]?.doneWhen !== undefined);
  const vacuous = withCriterion.filter((s) => s.turns[0].doneWhen === 'vacuous');
  return { n: withCriterion.length, events: vacuous.length };
}

function rework(sessions) {
  const claimed = [];
  for (const s of sessions) {
    const i = s.turns.findIndex((t) => t.doneClaim);
    if (i < 0) continue;
    claimed.push(s.turns.length - (i + 1));
  }
  return { n: claimed.length, events: claimed.filter((x) => x > 0).length, values: claimed };
}

// Rework for the CONTROL arm needs no transcript at all: the committed baseline already
// carries `turns` and `turns_to_done` per session, and rework is the subtraction. This is
// the only one of the four whose control is the frozen file itself rather than a
// recomputation over the frozen cohort, and the difference is worth keeping visible —
// `control_source` says which, per measurement, so nobody has to assume they are equal.
function reworkFromBaseline(base) {
  const vals = [];
  for (const [id_, lab] of base.lab) {
    if (lab.turns_to_done === null || lab.turns_to_done === undefined) continue;
    const obs = base.obs.get(id_);
    if (!obs) continue;
    vals.push(obs.turns - lab.turns_to_done);
  }
  return { n: vals.length, events: vals.filter((x) => x > 0).length, values: vals };
}

function evaluate(kept, base) {
  const treated = kept.filter(isTreated);
  const treatedIds = new Set(treated.map((s) => s.id));
  // A baseline session cannot be treated — the code did not exist — but it is excluded
  // explicitly anyway. A control arm that can contain a treated unit is not one, and the
  // day that assumption stops holding is the day nobody re-checks it.
  const control = kept.filter((s) => base.ids.has(s.id) && !treatedIds.has(s.id));

  const seen = {};
  for (const k of Object.keys(TREATMENT)) seen[k] = kept.filter((s) => s.turns.some((t) => t.treated.has(k))).length;

  const rate = (x) => (x.n ? round(x.events / x.n, 4) : null);
  const t = {
    false_refusals: falseRefusals(treated), bypass_rate: bypass(treated),
    added_latency_seconds: latencies(treated), rework_turns: rework(treated),
  };
  const c = {
    false_refusals: null,                      // the machinery did not exist: not 0, absent
    bypass_rate: bypass(control), added_latency_seconds: latencies(control),
    rework_turns: reworkFromBaseline(base),
  };
  const CONTROL_SOURCE = {
    false_refusals: 'not_applicable — a brief-check cannot have fired before it existed, so there is no untreated rate to compare against. This measurement is one-armed and is reported as an upper bound on the treated arm alone',
    bypass_rate: 'baseline_cohort — recomputed over exactly the session ids the baseline froze',
    added_latency_seconds: 'baseline_cohort — recomputed over exactly the session ids the baseline froze',
    rework_turns: 'baseline_file — derived from the committed columns (turns minus turns_to_done); no transcript re-read',
  };

  const nOf = (x) => (x === null ? null : Array.isArray(x) ? x.length : x.n);
  const out = [];
  for (const [name, spec] of Object.entries(MEASUREMENTS)) {
    const nT = nOf(t[name]), nC = nOf(c[name]);
    const blocked = [];
    if (nT < spec.min_n) blocked.push(`treated n=${nT}, need ${spec.min_n}`);
    if (nC !== null && nC < spec.min_n) blocked.push(`control n=${nC}, need ${spec.min_n}`);
    const row = {
      measurement: name, kind: spec.kind, unit: spec.unit, of: spec.of, digest: spec.digest,
      control_source: CONTROL_SOURCE[name],
      min_n: spec.min_n, why_min_n: spec.why_min_n,
      n_treated: nT, n_control: nC,
      reportable: blocked.length === 0,
    };
    // THE VALUE IS OMITTED, NOT ZEROED, when the sample cannot carry it. A field reading
    // 0 is a claim; an absent field is the truth. This is the whole reason the file exists
    // in the shape it does, so it is enforced here rather than left to the printer.
    if (blocked.length) { row.blocked_by = blocked; out.push(row); continue; }
    if (name === 'added_latency_seconds') {
      row.treated_median_seconds = round(median(t[name]), 1);
      row.control_median_seconds = round(median(c[name]), 1);
      row.added_seconds = round(median(t[name]) - median(c[name]), 1);
    } else if (name === 'rework_turns') {
      row.treated_rate = rate(t[name]); row.control_rate = rate(c[name]);
      row.treated_median_turns = round(median(t[name].values), 1);
      row.control_median_turns = round(median(c[name].values), 1);
    } else if (name === 'false_refusals') {
      row.treated_upper_bound = rate(t[name]);
      row.note = 'an upper bound, not a rate: a warning the human acted on before dispatching produces the same clean run as a warning that was never needed';
    } else {
      row.treated_rate = rate(t[name]); row.control_rate = rate(c[name]);
    }
    out.push(row);
  }

  const unmet = out.filter((m) => !m.reportable);
  const waiting = Object.entries(TREATMENT).filter(([k]) => seen[k] === 0)
    .map(([k, v]) => ({ marker: k, of: v.of, level: v.level, contract: v.contract, pattern: v.pattern, digest: v.digest, seen: 0 }));

  return {
    ran_at: new Date().toISOString(),
    baseline: { file: path.relative(process.cwd(), base.file) || base.file, date: base.date, taken_at: base.generated_at,
                sessions_frozen: base.ids.size,
                sessions_still_on_disk: [...base.ids].filter((x) => kept.some((s) => s.id === x)).length,
                rule_digests: Object.fromEntries(Object.entries(base.rules).filter(([, v]) => v && v.digest).map(([k, v]) => [k, v.digest])) },
    // If a rule digest here differs from the one the baseline recorded, the comparison is
    // between two different rulers and the delta is meaningless. Checked rather than
    // assumed, because the failure is silent and the number still prints.
    rules_match_baseline: Object.entries(RULES).filter(([, v]) => v && v.digest)
      .every(([k, v]) => !base.rules[k]?.digest || base.rules[k].digest === v.digest),
    arms: {
      treated: { sessions: treated.length, turns: treated.reduce((a, s) => a + s.turns.length, 0),
                 identified_by: 'a transcript carrying brief_check_in_force or ack_in_force — mechanically, never by date' },
      control: { sessions: control.length, turns: control.reduce((a, s) => a + s.turns.length, 0),
                 identified_by: 'session id present in the baseline file, and not treated' },
    },
    treatment_markers: Object.fromEntries(Object.entries(TREATMENT)
      .map(([k, v]) => [k, { of: v.of, level: v.level, where: v.where, contract: v.contract, pattern: v.pattern, digest: v.digest, sessions_seen: seen[k] }])),
    measurements: out,
    verdict: unmet.length === 0
      ? { reportable: true, reason: 'every measurement has a sample at or above its floor' }
      : { reportable: false,
          reason: treated.length === 0
            ? 'the treated cohort is empty: no session in this corpus carries a treatment marker'
            : `${unmet.length} of ${out.length} measurements are below their sample floor`,
          detail: treated.length === 0
            ? 'Plan items #3 and #4 are not merged, so the machinery that would leave a marker has never run. This is the expected answer until they land, and it is printed instead of numbers because every rate over an empty denominator is either NaN or a flattering 0 — and a 0 here would read as "no false refusals, no bypass, no added latency", which is the most favourable result available and measures nothing.'
            : 'The markers are present, so the machinery is running; there is simply not enough of it yet. Re-run when the counts below reach their floors.',
          waiting_for: waiting,
          unmet: unmet.map((m) => ({ measurement: m.measurement, blocked_by: m.blocked_by })) },
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('--digest')) {
  const s = val('--digest', '');
  if (!s) { console.error('usage: fleet-meter --digest <string>'); process.exit(2); }
  console.log(id(s));
  process.exit(0);
}
if (has('-h') || has('--help')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8')
    // Bounded by the blank comment line that ends the usage block rather than by a
    // hand-counted length: the count was 12, the block grew to 13, and --contract stopped
    // being mentioned anywhere a user would look.
    .split('\n').slice(1).map((l) => l.replace(/^\/\/ ?/, ''))
    .slice(0, 40).reduce((acc, l) => (acc.done || l.trim() === '' && acc.out.length > 3
      ? { ...acc, done: true } : { out: [...acc.out, l], done: false }), { out: [], done: false }).out.join('\n'));
  process.exit(0);
}

const ROOT = val('--corpus', path.join(process.env.HOME || '', '.claude', 'projects'));
const BY = val('--by', 'session');
const applyExclusions = !has('--include-excluded');

const files = corpusFiles(ROOT);
const sessions = [];
let unparsable = 0, records = 0;
for (const f of files) {
  const s = await readSession(f);
  unparsable += s.bad; records += s.records;
  if (!s.turns.length) continue;
  s.id = id(s.sessionId || path.basename(f, '.jsonl'));
  sessions.push(s);
}

const excludedIds = new Set(EXCLUDE.map((e) => e.id));
const matched = sessions.filter((s) => excludedIds.has(s.id)).map((s) => s.id);
const kept = applyExclusions ? sessions.filter((s) => !excludedIds.has(s.id)) : sessions;

if (has('--why')) {
  for (const e of EXCLUDE) {
    console.log(`${e.id}  ${matched.includes(e.id) ? 'matched  ' : 'NOT FOUND'}  ${e.label}`);
  }
  process.exit(0);
}

// Per branch: a session can cross branches, so a TURN is what carries a branch, not a
// session. Attributing a whole session to the branch it opened on would put a fortnight of
// unrelated work under whichever name happened to be checked out first.
const byBranch = new Map();
for (const s of kept) for (const t of s.turns) {
  const k = t.branch || '(none)';
  if (!byBranch.has(k)) byBranch.set(k, []);
  byBranch.get(k).push(t);
}

const allTurns = kept.flatMap((s) => s.turns);
const pooledAll = summarise(allTurns);
// The two per-session facts are struck from the pooled block rather than left in it wrong.
// See cohort() for what replaces them.
const { wall_seconds: _pooledWall, ...pooledObserved } = pooledAll.observed;
const pooled = {
  // wall_seconds is struck here for the same reason as the two labelled numbers below, and
  // it announced itself: pooling it takes the first turn of the first session to the last
  // turn of the LAST session in file order, which is not chronological, so the subtraction
  // came out negative and the clamp printed a confident 0. It survives per session and per
  // branch, where it means what it says.
  observed: pooledObserved,
  labelled: {
    done_claim_turns: pooledAll.labelled.done_claim_turns,
    corrections: pooledAll.labelled.corrections,
    corrections_per_distinct_file: pooledAll.labelled.corrections_per_distinct_file,
  },
};
const perSession = kept.map((s) => ({ id: s.id, ...summarise(s.turns) }))
  .sort((a, b) => b.observed.turns - a.observed.turns);
const perBranch = [...byBranch.entries()].map(([b, ts]) => ({ id: b === '(none)' ? '(none)' : id(b), ...summarise(ts) }))
  .sort((a, b) => b.observed.turns - a.observed.turns);
const cohortSession = cohort(perSession);
const cohortBranch = cohort(perBranch);

const report = {
  tool: 'fleet-meter',
  format: 1,
  generated_at: new Date().toISOString(),
  corpus: {
    files: files.length, records, unparsable_lines: unparsable,
    sessions_read: sessions.length, sessions_kept: kept.length,
    branches: perBranch.length, turns: allTurns.length,
  },
  rules: RULES,
  exclusions: EXCLUDE.map((e) => ({ ...e, matched: matched.includes(e.id) })),
  exclusions_applied: applyExclusions,
  pooled,
  cohort: { per_session: cohortSession, per_branch: cohortBranch },
  per_session: perSession,
  per_branch: perBranch,
};

// ── item #5: --evaluate ─────────────────────────────────────────────────────
if (has('--evaluate') || has('--contract')) {
  const bfile = path.resolve(val('--baseline-file',
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'meter-baseline-2026-09-01.json')));
  if (has('--contract')) {
    console.log('What #3 and #4 must emit for item #5 to be measurable.\n');
    for (const [k, v] of Object.entries(TREATMENT))
      console.log(`  ${v.of} (${v.level})  ${k}\n    ${v.contract}\n    matched by ${v.pattern}\n    only where it can have been emitted: ${v.where.join(', ')}   digest ${v.digest}\n`);
    console.log('  ...and #3 must carry its verdict INTO the dispatched prompt, so the objection and');
    console.log('  the outcome land in one transcript. Nothing joins a lead\'s records to a worker\'s,');
    console.log('  so a verdict left behind in the lead makes false refusals unmeasurable.');
    process.exit(0);
  }
  let base;
  try { base = readBaseline(bfile); }
  catch (e) { console.error(`fleet-meter: cannot read the baseline at ${bfile}\n  ${e.message}`); process.exit(2); }
  const ev = evaluate(kept, base);
  if (has('--json')) { console.log(JSON.stringify(ev, null, 2)); process.exit(0); }

  const V = ev.verdict;
  console.log(`baseline  ${ev.baseline.file}  taken ${ev.baseline.date}  ${ev.baseline.sessions_frozen} sessions frozen, ${ev.baseline.sessions_still_on_disk} still on disk`);
  console.log(`rules     ${ev.rules_match_baseline ? 'match the baseline' : 'DO NOT MATCH the baseline — the two arms were measured with different rulers'}`);
  console.log(`arms      treated ${ev.arms.treated.sessions} sessions / ${ev.arms.treated.turns} turns    control ${ev.arms.control.sessions} / ${ev.arms.control.turns}`);
  console.log(`          treated is identified ${ev.arms.treated.identified_by}\n`);

  console.log(V.reportable ? 'VERDICT: reportable' : 'VERDICT: NOT MEASURABLE');
  console.log(`  ${V.reason}`);
  if (V.detail) console.log(`\n  ${V.detail.replace(/(.{1,88})(\s|$)/g, '$1\n  ').trimEnd()}`);
  console.log('');

  for (const m of ev.measurements) {
    const head = `  ${m.measurement.padEnd(24)}${m.kind === 'observed' ? 'observed' : 'labelled'}`;
    if (!m.reportable) {
      // No number, of any kind, on this branch. Not a 0, not a NaN, not a dash that a
      // spreadsheet will coerce. The sample size is a fact and is printed; the result is
      // not a fact and is not.
      console.log(`${head}  — not measurable: ${m.blocked_by.join('; ')}`);
      continue;
    }
    if (m.measurement === 'added_latency_seconds')
      console.log(`${head}  treated ${m.treated_median_seconds}s  control ${m.control_median_seconds}s  added ${m.added_seconds}s`);
    else if (m.measurement === 'rework_turns')
      console.log(`${head}  rate ${m.treated_rate} vs ${m.control_rate}   median turns ${m.treated_median_turns} vs ${m.control_median_turns}`);
    else if (m.measurement === 'false_refusals')
      console.log(`${head}  upper bound ${m.treated_upper_bound} (n=${m.n_treated}); one-armed by construction`);
    else
      console.log(`${head}  treated ${m.treated_rate} vs control ${m.control_rate}`);
  }

  if (!V.reportable && V.waiting_for.length) {
    console.log('\nwaiting for  — no session has ever carried these');
    for (const w of V.waiting_for) console.log(`  ${w.of} ${w.level.padEnd(9)} ${w.contract}`);
    console.log('\n  fleet-meter --contract  prints this as a checklist for whoever builds #3 and #4.');
  }
  process.exit(0);
}

if (has('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

// ── the baseline document ───────────────────────────────────────────────────
// WHY THIS IS A SEPARATE OUTPUT AND NOT JUST --json. A baseline is a promise made before
// the result is known: this cohort, these exclusions, these rules, this date. Its value is
// entirely in being unchangeable afterwards, so the document states the protocol alongside
// the numbers and gets committed. A number without the rule that produced it can be
// reproduced by retuning the rule.
//   THE PER-UNIT TABLES ARE COLUMNS-AND-ROWS RATHER THAN OBJECTS, and that is not
// compression for its own sake. Indented JSON puts every field of every one of 564 units on
// its own line, so a diff between two baselines is four hundred thousand characters in
// which nothing is legible. One line per unit makes the diff say exactly which units moved
// and by how much, which is the only operation this file will ever be asked to support.
//   THE OBSERVED AND LABELLED COLUMNS STAY IN SEPARATE TABLES. Flattening them into one row
// would put a count and a judgment side by side under one header, which is the thing the
// whole file is arranged to prevent — a reader who rejects the correction rule has to be
// able to take a pair of scissors to this document and keep the half that does not depend
// on it.
if (has('--baseline')) {
  const table = (rows, half) => {
    const cols = Object.keys(rows.length ? rows[0][half] : {});
    return { columns: ['id', ...cols], rows: rows.map((r) => [r.id, ...cols.map((c) => r[half][c])]) };
  };
  const doc = {
    what_this_is: [
      'A pre-registered baseline for plan item #2 of docs/improvement-plan.md, taken BEFORE any other',
      'item in that plan shipped. Its purpose is to make a later measurement attributable: v1 of the',
      'plan compared a future sample against past numbers on a moving corpus with no control, and an',
      'independent critic correctly said that cannot attribute a change to a cause.',
      '',
      'Reproduce with:  fleet-meter --baseline',
      '',
      "The corpus is the reader's own ~/.claude/projects, so these numbers are reproducible by",
      'whoever holds that corpus and by nobody else. That is exactly why the rules, their digests',
      'and the exclusion ids are written down here rather than left implicit in the totals: a number',
      'whose rule is not recorded can be reproduced later by retuning the rule.',
    ],
    what_is_in_here_and_what_is_not: [
      "COUNTS AND DIGESTS ONLY. The corpus this was read from is not this repository's, and it holds",
      'work belonging to other people. No message body, no file path, no project directory and no',
      'branch name appears below. Sessions and branches are salted twelve-character digests, stable',
      'across runs, so a baseline taken a month from now can be compared to this one row by row',
      'without either of them naming anything.',
      '',
      'The suite asserts this in the failing direction rather than trusting it: it feeds the reader a',
      'fixture whose branch names and file paths it then greps the output for, and requires zero hits.',
    ],
    generated_at: report.generated_at,
    date: report.generated_at.slice(0, 10),
    cohort: {
      definition: 'every *.jsonl transcript under the reader\'s ~/.claude/projects at the date above, minus the exclusions',
      ...report.corpus,
      turn_rule: RULES.turn,
      eligibility_rule: RULES.eligibility,
    },
    exclusions_applied: report.exclusions_applied,
    exclusions: report.exclusions,
    rules: report.rules,
    pooled: report.pooled,
    cohort_distribution: report.cohort,
    caveats: [
      'WHAT THESE NUMBERS ARE NOT COMPARABLE TO. The plan quotes five hand-counted figures. None of',
      'them is the same quantity as its namesake here, and reading them as a before/after pair would',
      'be the exact error this file exists to prevent:',
      '',
      "  - '4 of 172 build turns that changed a screen file ever opened a browser' is conditioned on",
      '    turns that changed a screen file. The meter emits the unconditioned number, because the',
      "    brief fixes the metric list at five and 'turns that changed a screen file' is a sixth.",
      '',
      "  - '173 tool calls of which 28 were sleeps totalling about 16,000 seconds' is counted per",
      "    WINDOW, which is not a unit the transcript records. The nearest thing the meter can see is",
      '    a session: one session in this corpus carries 18,917 seconds of sleep across 68 calls in 18',
      '    turns. Same order of magnitude, different denominator, and it cannot be re-derived from the',
      '    records — which is the argument for automating the count, not a check that it was right.',
      '',
      "  - 'median 4 turns for sessions with 0-1 corrections against 63 for the 5+ group' is a split by",
      '    correction count that the meter does not perform; the per-session table below carries both',
      '    columns, so the split can be done by anyone, from this file, without re-reading the corpus.',
      '',
      'AN AUTOMATED NUDGE PASSES THE ELIGIBILITY FILTER. When a worker finishes, its Stop hook pastes',
      "a prompt into the lead's input box, and it arrives indistinguishable from a typed one: same",
      'record type, no flag, no marker. The filter is the one the brief resolved — sidechain, isMeta,',
      'tool_result — and it is not quietly extended, so the count is reported instead. There are',
      'nudge_turns of them out of turns; they inflate turn counts and deflate tool-calls-per-turn, in',
      'that direction, by that much.',
      '',
      'THE CORPUS IS LIVE WHILE IT IS BEING READ. Other sessions on this machine append to it as the',
      'reader runs, so two runs minutes apart differ by a handful of turns and the totals here are a',
      'snapshot at generated_at, not a fixed quantity anyone can re-derive. This is a reason to quote',
      'THIS FILE rather than a fresh run when the baseline is cited, and it is the reason the session',
      'that wrote the meter is on the exclusion list: it was growing while the baseline was taken, so',
      'leaving it in would have made the document unreproducible by its own author.',
      '',
      'THREE OF THE FIVE NUMBERS ARE LABELS, NOT MEASUREMENTS. turns_to_done, browser_before_done_claim',
      'and corrections all rest on a regex standing in for a person reading the turn. The regexes are',
      'printed in full above with their digests. They are wrong in both directions and consistently',
      'so, which is the only property being claimed for them. Everything under an "observed" key is',
      'free of them: discard the labelled half and the observed half is still whole.',
    ],
    the_follow_up_this_is_for: [
      'Plan item #5 measures the interventions against this file. For that comparison to mean',
      'anything, the follow-up run must:',
      '',
      '  1. use the same rule digests as those recorded above. If a rule changes, the follow-up is a',
      '     new baseline and not a comparison — say so rather than quietly reporting a delta.',
      '  2. keep the same exclusions, and add the sessions that build the interventions to them, by',
      '     the same argument that excludes the sessions that wrote the plan.',
      '  3. report the ARRIVING cohort separately from this one. Every session below already exists;',
      '     a corpus-wide re-read after the interventions ship mixes changed behaviour into unchanged',
      '     history and dilutes any effect toward zero. The comparable quantity is sessions that begin',
      '     after the intervention date against the rows in this file, not corpus against corpus.',
      '  4. state the n of the arriving cohort before quoting a median from it.',
    ],
    per_session: { observed: table(perSession, 'observed'), labelled: table(perSession, 'labelled') },
    per_branch: { observed: table(perBranch, 'observed'), labelled: table(perBranch, 'labelled') },
  };
  // The nudge count is a fact about this run, so it is interpolated rather than left as a
  // word a reader has to go and look up in the tables.
  doc.caveats = doc.caveats.map((l) => l
    .replace('nudge_turns of them out of turns', `${report.pooled.observed.nudge_turns} of them out of ${report.corpus.turns} turns`));
  // Serialise by hand so a table row lands on one line and everything else stays indented.
  // The sentinel is plain ASCII on purpose. A control character reads as the obvious choice
  // for something that cannot occur in the data, and it does not survive the round trip:
  // JSON.stringify writes a NUL as the six characters \u0000, so the regex looking for the
  // byte matched nothing, every table came out as its marker string, and the document was
  // valid JSON eight kilobytes long instead of a hundred and forty — a silent, plausible,
  // wrong answer, which is the failure mode this whole suite is arranged around.
  const stash = [];
  const marked = JSON.parse(JSON.stringify(doc, (k, v) =>
    (k === 'rows' && Array.isArray(v)) ? (stash.push(v), `@@ROW${stash.length - 1}@@`) : v));
  let out = JSON.stringify(marked, null, 2);
  out = out.replace(/"@@ROW(\d+)@@"/g, (_, i) =>
    '[\n' + stash[Number(i)].map((r) => '        ' + JSON.stringify(r)).join(',\n') + '\n      ]');
  if (out.includes('@@ROW')) { console.error('fleet-meter: table rows did not expand'); process.exit(1); }
  console.log(out);
  process.exit(0);
}

// The human summary. Digests are printed at eight characters here only because a column has
// to fit; --json carries the full twelve, and it is the twelve that a later run compares.
const rows = BY === 'branch' ? perBranch : perSession;
const o = pooled.observed, l = pooled.labelled;
const c = BY === 'branch' ? cohortBranch : cohortSession;
console.log(`corpus  ${files.length} files  ${records} records  ${kept.length}/${sessions.length} sessions  ${allTurns.length} turns  ${perBranch.length} branches`);
console.log(`        exclusions ${applyExclusions ? 'applied' : 'NOT applied'} (${matched.length}/${EXCLUDE.length} matched)\n`);
console.log('observed  — counted from records, no text was read');
console.log(`  tool calls per turn        mean ${o.tool_calls_per_turn_mean}  median ${o.tool_calls_per_turn_median}  max ${o.tool_calls_max_turn}`);
console.log(`  seconds sleeping per turn  total ${o.sleep_seconds}  mean ${o.sleep_seconds_per_turn_mean}  max ${o.sleep_seconds_max_turn}  (${o.sleep_calls} sleeps in ${o.sleep_turns} turns)`);
console.log(`  browser opened             ${o.browser_turns} turns  ${o.browser_calls} calls`);
console.log(`  distinct files touched     ${o.distinct_files}`);
console.log(`  automated nudges counted as human turns  ${o.nudge_turns}`);
console.log('\nlabelled  — a pattern stood in for a judgment; see rules.*.digest');
console.log(`  done-claim turns           ${l.done_claim_turns}`);
console.log(`  corrections                ${l.corrections}   per distinct file ${l.corrections_per_distinct_file}`);
console.log(`\nacross ${c.units} ${BY === 'branch' ? 'branches' : 'sessions'}  — the two numbers that cannot be pooled`);
console.log(`  turns to first done-claim  median ${c.turns_to_done_median}  mean ${c.turns_to_done_mean}  (${c.units_never_claiming_done} never claimed)`);
console.log(`  browser before done-claim  ${c.browser_before_done_claim_units}/${c.units_claiming_done} = ${c.browser_before_done_claim_fraction}`);
console.log(`  medians of the per-unit    tc/turn ${c.tool_calls_per_turn_median_of_units}  sleep s ${c.sleep_seconds_median_of_units}  corr/file ${c.corrections_per_distinct_file_median_of_units}`);
console.log(`\nper ${BY} (top 15 by turns)`);
console.log(`  ${'id'.padEnd(10)}${'turns'.padStart(7)}${'tc/turn'.padStart(9)}${'sleep s'.padStart(9)}${'brws'.padStart(6)}${'files'.padStart(7)}${'to-done'.padStart(9)}${'corr/file'.padStart(11)}`);
for (const r of rows.slice(0, 15)) {
  console.log(`  ${String(r.id).slice(0, 8).padEnd(10)}${String(r.observed.turns).padStart(7)}${String(r.observed.tool_calls_per_turn_mean).padStart(9)}${String(r.observed.sleep_seconds).padStart(9)}${String(r.observed.browser_turns).padStart(6)}${String(r.observed.distinct_files).padStart(7)}${String(r.labelled.turns_to_done ?? '-').padStart(9)}${String(r.labelled.corrections_per_distinct_file ?? '-').padStart(11)}`);
}
