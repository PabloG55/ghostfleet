#!/usr/bin/env node
// test/helpers/grid-parity.mjs — does the phone draw the same card the TUI draws?
//
//     node test/helpers/grid-parity.mjs      # one "name <US> want <US> got" row per check
//
// The PWA (web/grid.js) is a transcription of bin/fleet-grid.mjs's cardLines(),
// newCardLines(), freeCardLines(), boxCard() and the counts header. A transcription
// drifts, and this particular drift is silent: a card that still renders is a card that
// still looks right, and nobody diffs 32 columns of box-drawing by eye.
//
// So nothing here is TABULATED. The real functions are LIFTED out of fleet-grid.mjs by
// source range, evaluated, and their output — ANSI stripped — is compared line for line
// against the PWA's for the same card. Change either side and this goes red; change
// both the same way and it stays green, which is the point.
//
// The same lifting trick the suite already uses for orderFile/writeOrder (test/run.sh
// §"card order"), for the same reason: a second copy of the code under test proves
// nothing about the first.

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

// ── 2. every card of every fixture, line for line ──────────────────────────
const fixDir = path.join(ROOT, 'web', 'fixtures');
const grids = fs.readdirSync(fixDir).filter(f => /^grid-.*\.json$/.test(f)).sort();
is('there are grid fixtures to render', true, grids.length > 0);
let cardsSeen = 0, freeSeen = 0;
const statusesSeen = new Set();
for (const f of grids) {
  const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
  (g.cards || []).forEach((c, i) => {
    cardsSeen++; statusesSeen.add(c.status);
    for (const sel of [false, true]) {
      const t = TUI.cardLines(toTui(c), sel, i).map(strip);
      const p = PWA.cardLines(c, sel, i).lines;
      is(`${f}#${i} ${c.name}${sel ? ' (selected)' : ''}`, t.join('\n'), p.join('\n'));
    }
    // the arithmetic the glyph width exists to protect: every line is CW+2 columns
    const widths = new Set(PWA.cardLines(c, false, i).lines.map(l => PWA.vis(l)));
    is(`${f}#${i} ${c.name} is ${PWA.CARD_COLS} columns`, `${PWA.CARD_COLS}`, [...widths].join(','));
  });
  (g.free_worktrees || []).forEach((w, i) => {
    freeSeen++;
    const idx = (g.cards || []).length + i;
    const t = TUI.freeCardLines(w, false, idx).map(strip);
    is(`${f} free#${i} ${w.branch}`, t.join('\n'), PWA.freeCardLines(w, false, idx).lines.join('\n'));
  });
}
is('the + new session card', TUI.newCardLines(false).map(strip).join('\n'), PWA.newCardLines(false).lines.join('\n'));
is('...and selected', TUI.newCardLines(true).map(strip).join('\n'), PWA.newCardLines(true).lines.join('\n'));
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
  const t = TUI.boxCard(`${i < 9 ? `${i + 1} ` : ''}${p.name}`, [who, tildify(p.path), line], color, false).map(strip);
  is(`project card ${p.name}`, t.join('\n'), PWA.projectCard(p, i, false).lines.join('\n'));
});
is('the + add project card',
   TUI.boxCard('+ add project', ['choose a root', 'folder…', ''], TUI.C.yellow, false).map(strip).join('\n'),
   PWA.addProjectCard(false).lines.join('\n'));

// ── 5. the three ways the right-hand slot can lie ──────────────────────────
// sched beats limit beats age, and a limited card shows its RESET time and not how
// long ago it last spoke. Asserted against the lifted cardLines, so it is the TUI's
// precedence being checked and not a restatement of it.
const base = { name: 'x', folder: 'x', branch: 'x', agent: 'claude', msg: 'm', attached: false, sched: null, limit_at: null };
const rightOf = c => PWA.cardLines(c, false, 0).lines[1].slice(2, -2).trimEnd().split(/\s{2,}/).pop();
is('working shows busy <age>', 'busy 41s', rightOf({ ...base, status: 'working', age: 41 }));
is('anything else shows <age> ago', '55m ago', rightOf({ ...base, status: 'ready', age: 3300 }));
is('a limited card shows its reset time', '↻ 10:20pm', rightOf({ ...base, status: 'limit', age: 3300, limit_at: '10:20pm' }));
is('...and camelCase reaches it too', '↻ 10:20pm', rightOf({ ...base, status: 'limit', age: 3300, limitAt: '10:20pm' }));
is('a schedule outranks both', `@${PWA.clockLabel(1700000000)}`,
   rightOf({ ...base, status: 'limit', age: 3300, limit_at: '10:20pm', sched: { at: 1700000000 } }));
is('no age, nothing on the right', '◆ working', rightOf({ ...base, status: 'working', age: null }));

// ── 6. the PR number, and the width it must not cost ──────────────────────
// A working session's most useful single fact was only ever visible inside `msg` — the
// last assistant line — so the number came and went as the agent talked. It comes off
// fleet-merged's cache now and lives in l2's right-hand slot.
//   BOTH DIRECTIONS, and the second one is the point: a card with no PR has to render
// EXACTLY as it did before this field existed, byte for byte, on both renderers. `pr:
// null` and no `pr` key at all are both that case — the wire sends null, and an older
// daemon sends neither.
const l2of = c => PWA.cardLines(c, false, 0).lines[2];
const wide = { ...base, status: 'working', age: 41, folder: 'api-fix', branch: 'feat/rate-limit' };
is('a card with no PR is unchanged by the field', l2of(wide), l2of({ ...wide, pr: null }));
is('...and an absent key is the same case', l2of(wide), l2of({ ...wide, pr: undefined }));
is('...and it still shows worktree · branch', '│ api-fix · feat/rate-limit    │', l2of(wide));
// ...and the direction that must FAIL if the feature is gone. Asserted as the WHOLE line,
// so the row reads as a picture of the card rather than as a claim about a substring — and
// so a number that appeared in the right slot but ate the wrong characters is still red.
is('a card with a PR shows it',
   '│ api-fix · feat/rate-l… #1184 │', l2of({ ...wide, pr: '1184' }));
is('...five digits too, because #1184 is four',
   '│ api-fix · feat/rate-… #12345 │', l2of({ ...wide, pr: '12345' }));
// A non-claude agent already owns this slot. Both are shown, and the NUMBER IS RIGHTMOST
// so it sits in the same column on every card — scanning nine of them for a number is the
// whole point, and one that shifts left on the single codex card is one you hunt for.
is('the agent keeps its place beside it',
   '│ api-fix · feat/… codex #1184 │', l2of({ ...wide, pr: '1184', agent: 'codex' }));
is('...with the number last, always', true,
   l2of({ ...wide, pr: '1184', agent: 'opencode' }).trimEnd().endsWith('#1184 │'));
is('...and an agent with no PR is untouched',
   '│ api-fix · feat/rate-l… codex │', l2of({ ...wide, agent: 'codex' }));

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
  const lines = PWA.cardLines(c, false, 0).lines;
  is(`every line is CW+2 with ${what}`, String(PWA.CW + 2), [...new Set(lines.map(PWA.vis))].join(','));
  if (c.pr) is(`...and the PR survives ${what}`, true, lines[2].includes('#' + c.pr));
  // ...and the TUI agrees, which is what keeps the two renderers one design.
  is(`...TUI and phone agree with ${what}`,
     TUI.cardLines(toTui(c), false, 0).map(strip).join('\n'), lines.join('\n'));
}

// twoCol's OWN floor, well below anything the card can reach, recorded so a future width
// change has a number to check against rather than a habit. 28 is what l2 passes.
const floorFor = r => { for (let w = 40; w >= 2; w--) if (PWA.vis(PWA.twoCol(LONGEST.branch, r, w)) > w) return w; return 0; };
is('#12345 holds down to a 8-column slot', 7, floorFor('#12345'));
is('...and `opencode #12345` down to 17', 16, floorFor('opencode #12345'));
is('...against the 28 the card gives it', 28, PWA.CW - 2);

console.log(rows.join('\n'));
