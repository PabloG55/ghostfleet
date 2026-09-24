#!/usr/bin/env node
// test/helpers/grid-parity.mjs — does the phone draw the same card the TUI draws?
//
//     node test/helpers/grid-parity.mjs      # one "name <US> want <US> got" row per check
//
// The phone used to be a TRANSCRIPTION of bin/fleet-grid.mjs — the same box-drawing
// characters, compared here line for line, because a transcription drifts silently and
// nobody diffs 32 columns of ╭─╮ by eye.
//
// IT IS NOT A TRANSCRIPTION ANY MORE, ON PURPOSE. The phone draws a surface card with a
// status chip and two real lines of the agent's message; the desk still draws the box.
// "They look the same" is a claim this repo has deliberately given up, so asserting it
// would be asserting a decision that was reversed.
//
// WHAT IS NOT GIVEN UP is that they SAY the same thing. Dropping this file along with the
// box art would leave the phone free to quietly stop showing the branch, the PR number or
// which agent is running — each a fact the desk shows, none of them missed until needed.
//
// SO THE CONTRACT IS DERIVED FROM THE TUI RATHER THAN LISTED BY HAND. For every field of
// a card: poke it, and see whether the TUI's rendered card changes. If it does, the desk
// SHOWS that field, and the phone's model must change too. A hand-written list of fields
// is a list somebody must remember to extend; this one extends itself the day fleet-grid
// starts printing something new. The TUI's functions are still LIFTED out by source range
// and evaluated, so it is the real renderer being asked and not a copy of it.
//
// It needs no parser for the TUI's output and knows neither layout, so it cannot go red
// for a cosmetic change on either side — which is exactly what the old assertion did, and
// why it had to be replaced rather than loosened.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-grid.mjs'), 'utf8');

// One TSV row per check: name, want, got — JSON-encoded so a five-line card block stays
// on one line, and so test/run.sh's own `is` does the comparing and the reporting. The
// separator is \x1f, not a tab: a tab is IFS-whitespace and bash collapses empty fields
// with it, which is the trap CLAUDE.md opens with.
const US = '\x1f';
const rows = [];
function is(name, want, got) { rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got)); }

// ── lifting ────────────────────────────────────────────────────────────────
// Take a top-level declaration by its opening line and every line up to the first
// line that closes it at column 0 (`}` or `};`). Every target here is written that
// way; a target that is not throws rather than silently lifting half a function.
function lift(openRe) {
  const lines = SRC.split('\n');
  const start = lines.findIndex(l => openRe.test(l));
  if (start < 0) throw new Error(`grid-parity: nothing in fleet-grid.mjs matches ${openRe}`);
  // a one-liner (`function vis(s) { … }`) closes on its own line
  if (/\}\s*;?\s*$/.test(lines[start]) && lines[start].includes('{') && lines[start].indexOf('{') < lines[start].lastIndexOf('}'))
    return lines[start];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}\s*;?\s*$/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`grid-parity: ${openRe} is not closed at column 0`);
}

const lifted = [
  `import path from 'node:path';`,
  lift(/^const C = \{/),
  lift(/^const STATUS = \{/),
  lift(/^function vis\(/),
  lift(/^function clip\(/),
  lift(/^function padEndV\(/),
  lift(/^function twoCol\(/),
  lift(/^function humanAge\(/),
  lift(/^function clockLabel\(/),
  SRC.split('\n').find(l => /^const CW = /.test(l)),
  lift(/^function cardLines\(/),
  lift(/^function newCardLines\(/),
  lift(/^function freeCardLines\(/),
  lift(/^function boxCard\(/),
  `export { C, STATUS, CW, cardLines, newCardLines, freeCardLines, boxCard, clockLabel, humanAge, clip, padEndV, twoCol, vis };`,
].join('\n\n');

const TUI = await import('data:text/javascript;base64,' + Buffer.from(lifted, 'utf8').toString('base64'));
const PWA = await import(new URL('../../web/grid.js', import.meta.url).href);

// ANSI out, so what is left is the characters that reach the screen.
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// The TUI's card object is camelCase; §4's JSON is snake_case. Feeding the TUI the
// same card the phone gets is the whole comparison, so the adapter is HERE and named
// — inlining it would let a typo read as agreement.
function toTui(c) { return { ...c, limitAt: c.limit_at ?? c.limitAt ?? null }; }

// ── 1. the STATUS table, both directions ───────────────────────────────────
// Nine statuses, the same labels, the same colours. Both directions: a status the PWA
// invented is as wrong as one it dropped.
const tuiKeys = Object.keys(TUI.STATUS).sort();
const pwaKeys = Object.keys(PWA.STATUS).sort();
is('STATUS has the same nine keys', tuiKeys.join(','), pwaKeys.join(','));
is('STATUSES enumerates all nine', tuiKeys.join(','), [...PWA.STATUSES].sort().join(','));
// colour names, resolved through C so the comparison is red-vs-red and not
// '\x1b[38;5;203m'-vs-'#ff5f5f'
const cName = code => Object.keys(TUI.C).find(k => TUI.C[k] === code) || `?${code}`;
for (const k of tuiKeys) {
  is(`STATUS.${k} label`, TUI.STATUS[k].label, PWA.STATUS[k]?.label);
  is(`STATUS.${k} colour`, cName(TUI.STATUS[k].color), PWA.STATUS[k]?.color);
}
// The glyph is the first code point of the label, and it must stay one code point —
// vis() counts code points, so a two-code-point glyph (a flag, an emoji with a
// variation selector) breaks the 32-column arithmetic on both sides at once.
for (const k of tuiKeys) {
  const g = [...PWA.STATUS[k].label][0];
  is(`STATUS.${k} glyph is one code point`, 1, [...g].length);
}
is('CW is the same 30', TUI.CW, PWA.CW);

// ── 2. every FACT of every fixture card ────────────────────────────────────
// THIS USED TO COMPARE THE TWO CARDS LINE FOR LINE, and that contract is deliberately
// over. The phone no longer draws box art: it draws a surface card with a status chip and
// two real lines of the agent's message, because 32 columns of ╭─╮ spent ~210px to state
// three short facts and clipped the one line the app is opened to read. So "they look the
// same" is a claim we have chosen to abandon.
//
// WHAT MUST NOT BE ABANDONED is that they SAY the same thing. Dropping this file with the
// box art would leave the phone free to quietly stop showing the branch, or the PR number,
// or which agent is running — each of them a fact the desk shows and nobody would miss
// until they needed it.
//
// SO THE CONTRACT IS DERIVED RATHER THAN LISTED, and that is the point. A hand-written list
// of fields is a list somebody must remember to extend; this asks the TUI itself. For every
// field of a card: change it, and see whether the TUI's rendered card changes. If it does,
// the desk SHOWS that field — and then the phone's model must change too. A phone that
// drops a fact the desk shows is red; a phone that shows MORE is fine, which is the whole
// licence this redesign was given.
//
// It needs no parser for the TUI's output and no knowledge of either layout, so it cannot
// go red for a cosmetic change on either side — which is exactly what the old assertion
// did, and why it had to go rather than be loosened.
const fixDir = path.join(ROOT, 'web', 'fixtures');
const grids = fs.readdirSync(fixDir).filter(f => /^grid-.*\.json$/.test(f)).sort();
is('there are grid fixtures to render', true, grids.length > 0);

// A distinctive replacement per field, so a change cannot coincide with the old value.
// `null` entries are for fields whose ABSENCE is the interesting state.
const POKE = {
  name: 'zzz-probe-name', label: 'zzz-probe-label', folder: 'zzz-probe-folder',
  branch: 'zzz-probe-branch', agent: 'opencode', pr: '98765', msg: 'zzz probe message',
  age: 4321, status: 'interrupted', lead: true, attached: true,
  sched: { at: 1700000000 }, limit_at: '11:11pm',
};
const modelText = (m) => JSON.stringify(m);

let cardsSeen = 0, freeSeen = 0, shownSeen = 0;
const statusesSeen = new Set();
for (const f of grids) {
  const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
  (g.cards || []).forEach((c, i) => {
    cardsSeen++; statusesSeen.add(c.status);
    // The phone's model must carry the TUI's own status word, verbatim. The chip prints
    // it, and §7 is emphatic that the vocabulary is the desk's rather than a synonym
    // chosen to read better on a phone.
    is(`${f}#${i} ${c.name} status word`, TUI.STATUS[c.status].label, PWA.cardModel(c, false, i).statusLabel);
    for (const [field, poked] of Object.entries(POKE)) {
      const before = TUI.cardLines(toTui(c), false, i).map(strip).join('\n');
      const after  = TUI.cardLines(toTui({ ...c, [field]: poked }), false, i).map(strip).join('\n');
      if (before === after) continue;          // the desk does not show this field here
      shownSeen++;
      const mBefore = modelText(PWA.cardModel(c, false, i));
      const mAfter  = modelText(PWA.cardModel({ ...c, [field]: poked }, false, i));
      is(`${f}#${i} ${c.name}: the phone shows '${field}' too`, true, mBefore !== mAfter);
    }
  });
  (g.free_worktrees || []).forEach((w, i) => {
    freeSeen++;
    const m = PWA.freeModel(w, false, (g.cards || []).length + i);
    // The two facts a free worktree HAS. Asserted by value rather than by diffing, because
    // the TUI's free card is three fixed rows and there is nothing to poke.
    is(`${f} free#${i} branch`, w.branch || '', m.where);
    is(`${f} free#${i} folder`, TUI.freeCardLines(w, false, 0).map(strip).join('\n').includes(m.title), true);
  });
}
// A FLOOR UNDER THE DERIVATION, because "no field changed the TUI's output" would make
// every row above vanish and the file would print a confident nothing. Measured: 44 on
// the shipped fixtures.
is('the derivation found fields the desk shows', true, shownSeen >= 20);
is('the fixtures cover all nine statuses', tuiKeys.join(','), [...statusesSeen].sort().join(','));
is('the fixtures include free worktrees', true, freeSeen > 0);

// ── 3. the counts header ───────────────────────────────────────────────────
// Lifted as an EXPRESSION: renderGrid's own template, with the colour interpolations
// removed, evaluated over counts we choose. That way the clause order (interrupted,
// at limit, parked) and the "only when non-zero" rule are compared against the source
// rather than against my memory of it.
const hdrStmt = (() => {
  const i = SRC.indexOf('  const header = ');
  const j = SRC.indexOf('\n  // Same banner', i);
  if (i < 0 || j < 0) throw new Error('grid-parity: cannot find renderGrid\'s header statement');
  return SRC.slice(i, j);
})();
const hdrExpr = hdrStmt
  .replace(/^\s*const header = /, '')
  .replace(/;\s*$/, '')
  .replace(/\$\{C\.\w+\}/g, '');
const tuiHeader = new Function('need', 'work', 'ready', 'cut', 'limited', 'parked', 'PROFILE', 'Z',
  `return (${hdrExpr});`);
// strip the ` ghostfleet [profile:project]   ` prefix — the phone's header carries the
// project name elsewhere; the COUNTS are what has to match.
const tuiCounts = (n, w, r, cut, lim, park) =>
  tuiHeader(n, w, r, cut, lim, park, 'work', 'acme-api').replace(/^.*?\]\s{2,}/, '');
const CASES = [
  ['a quiet fleet', 0, 0, 0, 0, 0, 0],
  ['the doc\'s example', 0, 2, 4, 0, 0, 0],
  ['one interrupted', 1, 1, 1, 1, 0, 0],
  ['at a limit', 0, 0, 3, 0, 2, 0],
  ['parked', 0, 0, 0, 0, 0, 4],
  ['all of it at once', 2, 3, 4, 1, 2, 5],
];
for (const [name, n, w, r, cut, lim, park] of CASES) {
  is(`counts: ${name}`, tuiCounts(n, w, r, cut, lim, park),
     PWA.countsLine({ need_you: n, working: w, ready: r, interrupted: cut, limit: lim, parked: park }));
}
// ── 3b. the counts COLOURS, which the comparison above deliberately strips ──
// hdrExpr removes every ${C.x} so the words and the numbers can be compared as one string.
// That is right for the text, and it leaves the COLOUR of each clause compared by nobody.
// MEASURED, not assumed: changing the TUI's `interrupted` clause from red to yellow and
// leaving the phone's alone keeps every row in §3 green, and nothing else in the suite
// noticed either.
//   The colour is half of what the status vocabulary means here — red is need-you's alone,
// and yellow is the warning family — so two copies that agree on the words and disagree on
// the colour are still saying different things to a reader glancing at one screen. Pinned
// per clause rather than as a whole line, so a failure names WHICH one drifted.
const tuiClauseColour = (word) => {
  const m = new RegExp('\\$\\{C\\.(\\w+)\\}\\$\\{\\w+\\} ' + word).exec(hdrStmt);
  return m ? m[1] : `(no '${word}' clause in the TUI header)`;
};
const ALL_ON = { need_you: 1, working: 1, ready: 1, interrupted: 1, limit: 1, parked: 1 };
const pwaClauseColour = (word) => {
  const seg = PWA.countsSegments(ALL_ON).find(x => new RegExp(`^\\d+ ${word}$`).test(x.text || ''));
  return seg ? (seg.color || '(no colour)') : `(no '${word}' segment on the phone)`;
};
for (const word of ['need you', 'working', 'ready', 'interrupted', 'at limit', 'parked']) {
  is(`counts colour: ${word}`, tuiClauseColour(word), pwaClauseColour(word));
}
// ...and the one the change above is about, stated as a VALUE rather than only as parity:
// both could drift together and stay equal. Red is reserved for need-you; interrupted
// wears ⚠ and belongs with the warnings.
is('need-you is the only red clause', 'red', tuiClauseColour('need you'));
is('...and interrupted is a warning, not a failure', 'yellow', tuiClauseColour('interrupted'));
is('...on the phone too', 'yellow', pwaClauseColour('interrupted'));
is('...while need-you stays red there', 'red', pwaClauseColour('need you'));

// ...and the same line built from the CARDS, which is what the phone actually renders
for (const f of grids) {
  const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
  const c = PWA.countsFrom(g.cards || []);
  is(`${f}: counts from cards == the TUI's header`,
     tuiCounts(c.need_you, c.working, c.ready, c.interrupted, c.limit, c.parked),
     PWA.countsLine(c));
  // §4 ships a `counts` object too. If it disagreed with the cards under it, one of
  // the two is lying and the fixture would be teaching the wrong lesson.
  is(`${f}: the fixture's counts match its cards`, JSON.stringify(c),
     JSON.stringify({ need_you: g.counts.need_you, working: g.counts.working, ready: g.counts.ready,
                      parked: g.counts.parked, limit: g.counts.limit, interrupted: g.counts.interrupted }));
}

// ── 4. the projects card ───────────────────────────────────────────────────
// boxCard is shared, so what is being compared is the ROW SELECTION — which of
// need/working/parked/total wins, and what the third line says.
const PROJ = JSON.parse(fs.readFileSync(path.join(fixDir, 'projects.json'), 'utf8'));
PWA.setHome(PROJ.home || '');
const tildify = p => (PROJ.home && p.startsWith(PROJ.home) ? '~' + p.slice(PROJ.home.length) : p);
PROJ.projects.forEach((p, i) => {
  const st = p.sessions || { need: 0, working: 0, parked: 0, total: 0 };
  let line, color;
  if (st.need > 0) { line = `● ${st.need} need you`; color = TUI.C.red; }
  else if (st.working > 0) { line = `◆ ${st.working} working`; color = TUI.C.cyan; }
  else if (st.parked > 0 && st.parked === st.total) { line = `⏸ ${st.parked} parked`; color = TUI.C.grey; }
  else if (st.total > 0) { line = `${st.total} session${st.total > 1 ? 's' : ''} · ready`; color = TUI.C.green; }
  else { line = 'no sessions yet'; color = TUI.C.grey; }
  if (p.sched && p.sched.at) line += `  @${TUI.clockLabel(p.sched.at)}`;
  const who = p.agent ? `${p.profile} · ${p.agent}` : p.profile;
  // The rollup is the CONTENT of a project card — need beats working beats all-parked
  // beats any-sessions beats none — and the phone must reach the same verdict from the
  // same numbers. Compared as the derived line rather than as the drawn box, for the
  // reason §2 gives: the picture is intentionally different now, the verdict is not.
  is(`project card ${p.name} rollup`, line, PWA.projectModel(p, i, false).statusLabel +
     (p.sched && p.sched.at ? `  @${TUI.clockLabel(p.sched.at)}` : ''));
  is(`...${p.name} profile and agent`, who, PWA.projectModel(p, i, false).where);
  is(`...${p.name} path, shortened the same way`, tildify(p.path), PWA.projectModel(p, i, false).path);
});
is('the + add project card names itself',
   true, /add project/.test(PWA.addProjectModel(false).title));

// ── 5. the three ways the right-hand slot can lie ──────────────────────────
// sched beats limit beats age, and a limited card shows its RESET time and not how
// long ago it last spoke. Asserted against the lifted cardLines, so it is the TUI's
// precedence being checked and not a restatement of it.
const base = { name: 'x', folder: 'x', branch: 'x', agent: 'claude', msg: 'm', attached: false, sched: null, limit_at: null };
const rightOf = c => PWA.cardModel(c, false, 0).when;
is('working shows busy <age>', 'busy 41s', rightOf({ ...base, status: 'working', age: 41 }));
is('anything else shows <age> ago', '55m ago', rightOf({ ...base, status: 'ready', age: 3300 }));
is('a limited card shows its reset time', '↻ 10:20pm', rightOf({ ...base, status: 'limit', age: 3300, limit_at: '10:20pm' }));
is('...and camelCase reaches it too', '↻ 10:20pm', rightOf({ ...base, status: 'limit', age: 3300, limitAt: '10:20pm' }));
is('a schedule outranks both', `@${PWA.clockLabel(1700000000)}`,
   rightOf({ ...base, status: 'limit', age: 3300, limit_at: '10:20pm', sched: { at: 1700000000 } }));
// Nothing at all, rather than the status word bleeding into the slot: the old form read
// the LAST field of a padded line, so "empty" and "the label" were the same answer there.
is('no age, nothing on the right', '', rightOf({ ...base, status: 'working', age: null }));

// ── 6. the PR number, and the width it must not cost ──────────────────────
// A working session's most useful single fact was only ever visible inside `msg` — the
// last assistant line — so the number came and went as the agent talked. It comes off
// fleet-merged's cache now and lives in l2's right-hand slot.
//   BOTH DIRECTIONS, and the second one is the point: a card with no PR has to render
// EXACTLY as it did before this field existed, byte for byte, on both renderers. `pr:
// null` and no `pr` key at all are both that case — the wire sends null, and an older
// daemon sends neither.
// The same two facts, off the model. What mattered was never the byte-for-byte line — it
// was that a card with no PR loses nothing and gains nothing.
const l2of = c => JSON.stringify([PWA.cardModel(c, false, 0).where, PWA.cardModel(c, false, 0).agent, PWA.cardModel(c, false, 0).pr]);
const wide = { ...base, status: 'working', age: 41, folder: 'api-fix', branch: 'feat/rate-limit' };
is('a card with no PR is unchanged by the field', l2of(wide), l2of({ ...wide, pr: null }));
is('...and an absent key is the same case', l2of(wide), l2of({ ...wide, pr: undefined }));
is('...and it still shows worktree · branch', 'api-fix · feat/rate-limit', PWA.cardModel(wide, false, 0).where);
// ...and the direction that must FAIL if the feature is gone. Asserted on the MODEL now:
// the old rows pinned the whole drawn line, which read as a picture of the card and was
// the right shape while the card WAS a picture. What it was protecting is that the number
// arrives, is not truncated, and does not evict the agent — three claims the model states
// directly, and none of which a CSS change can now break.
is('a card with a PR shows it', '#1184', PWA.cardModel({ ...wide, pr: '1184' }, false, 0).pr);
is('...five digits too, because #1184 is four', '#12345', PWA.cardModel({ ...wide, pr: '12345' }, false, 0).pr);
// A non-claude agent shares that slot, and BOTH are kept: neither is derivable from
// anything else on the grid, so dropping either loses a whole fact. On the phone they are
// two chips and nothing has to give way — which is the one place the redesign genuinely
// bought something the 28-column line could not.
{
  const m = PWA.cardModel({ ...wide, pr: '1184', agent: 'codex' }, false, 0);
  is('the agent keeps its place beside it', 'codex,#1184', `${m.agent},${m.pr}`);
}
is('...and a long agent name costs the number nothing', '#1184',
   PWA.cardModel({ ...wide, pr: '1184', agent: 'opencode' }, false, 0).pr);
is('...and an agent with no PR is untouched', 'codex,',
   (m => `${m.agent},${m.pr}`)(PWA.cardModel({ ...wide, agent: 'codex' }, false, 0)));
// THE FULL BRANCH SURVIVES, which the 28-column line could not promise: it clipped
// `feat/rate-limit` to `feat/rate-l…` the moment a PR number shared the row. The phone
// hands CSS the whole string and lets the browser decide where it ends.
is('...and the branch is never pre-truncated', true,
   !PWA.cardModel({ ...wide, pr: '12345', agent: 'opencode' }, false, 0).where.includes('…'));

// THE GEOMETRY, AT THE WIDTH THAT ACTUALLY SHIPS AND WITH THE WORST STRINGS THERE ARE.
// A detector or a label measured at full width that goes blind in a narrow one is the most
// repeated bug in this repo, so every combination is measured rather than argued: the card
// is CW+2 columns on every line, and the NUMBER is never the thing that gets clipped —
// twoCol truncates its left argument, and the number is on the right.
const LONGEST = { ...wide, folder: 'worktree-with-a-long-name',
                  branch: 'feat/rate-limit-per-key-and-a-very-long-tail' };
for (const [what, c] of [
  ['nothing extra',            LONGEST],
  ['a 4-digit PR',             { ...LONGEST, pr: '1184' }],
  ['a 5-digit PR',             { ...LONGEST, pr: '12345' }],
  ['a 5-digit PR + codex',     { ...LONGEST, pr: '12345', agent: 'codex' }],
  ['a 5-digit PR + opencode',  { ...LONGEST, pr: '12345', agent: 'opencode' }],
  ['a label as well',          { ...LONGEST, pr: '12345', agent: 'opencode', label: 'ship the retry work end to end' }],
]) {
  // THE QUESTION SURVIVED THE REDESIGN; THE ARITHMETIC DID NOT. It used to be "every line
  // is still CW+2 columns", which is a box-art question. What it was PROTECTING is that a
  // long branch does not push the PR number or the agent off the card — and on the phone
  // that is answered by the model carrying them at all, since CSS does the fitting and the
  // browser does the truncating.
  const m = PWA.cardModel(c, false, 0);
  if (c.pr)    is(`the PR survives ${what}`,    '#' + c.pr, m.pr);
  if (c.agent && c.agent !== 'claude') is(`...and the agent ${what}`, c.agent, m.agent);
  // ...and the branch is never silently emptied by a long anything.
  is(`...and the card still says where it is, with ${what}`, true, !!m.where);
}

console.log(rows.join('\n'));
