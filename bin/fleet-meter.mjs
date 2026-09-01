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
});

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
      if (isMeta(r) || hasToolResult(r.message)) continue;
      const branch = r.gitBranch || '';
      if (branch) branches.add(branch);
      cur = newTurn(branch, r.timestamp || null);
      const t = textOf(r.message);
      cur.nudge = NUDGE.test(t);
      // The first turn of a session is the brief. See CORRECTION above.
      cur.correction = turns.length > 0 && CORRECTION.test(t);
      turns.push(cur);
      continue;
    }

    if (r.type !== 'assistant' || !cur) continue;
    if (r.timestamp) cur.ended = r.timestamp;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;

    let sawText = false, lastText = '';
    for (const b of content) {
      if (b?.type === 'text') { sawText = true; lastText = b.text || ''; continue; }
      if (b?.type !== 'tool_use') continue;
      cur.tools++;
      const name = b.name || '';
      const inp = b.input || {};
      if (BROWSER_TOOL.test(name)) cur.browser++;
      if (WRITE_TOOL.has(name) && typeof inp.file_path === 'string' && inp.file_path) cur.files.add(id(inp.file_path));
      if (name === 'Bash' || name === 'Monitor') {
        const cmd = String(inp.command ?? '');
        if (BROWSER_BASH.test(cmd)) cur.browser++;
        if (name === 'Bash' && inp.run_in_background !== true && !BACKGROUNDED.test(cmd)) {
          SLEEP_RE.lastIndex = 0;
          let m;
          while ((m = SLEEP_RE.exec(cmd))) { cur.sleepSeconds += Number(m[1]); cur.sleepCalls++; }
        }
      }
    }
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
    .split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
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
