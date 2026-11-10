// No emoji in the product. An emoji is drawn by the platform's font, so the same button was a
// colour picture on a phone and a thin outline on a desktop, and neither was the brand's; the app
// draws its icons as pixel sprites (the shared screens' web/ui/icon.jsx, at the repo's root) instead.
//
// "Emoji" is wider than the code points that are emoji by default: a warning sign, a gear, a moon
// or a pause bar are text characters that a phone still draws in colour. So the rule is every
// Extended_Pictographic code point, the whole Miscellaneous Symbols block (U+2600-26FF, where the
// moon U+263E lives without being pictographic), flags, the emoji selector and the keycap. The marks
// the TUI uses as plain text (· › ▸ ▾ ● ◆ ✓ ✕, box drawing) are none of those. This file spells
// its own samples as escapes so that it passes its own scan.
//
// An emoji may stand only where a sprite physically cannot: plain text that leaves the app (a
// Telegram message, a system or push notification, the tab title) and a native <option>. Even
// there no symbol is preferred, and today every one of those reads fine without, so ALLOWED names
// no product file. Nothing read aloud may carry one, ever. The pane's renderer is the repo's own
// web/ansi.js, outside this folder, and it shows whatever the session printed, so it is not
// ours to scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u2600-\u26FF\uFE0F\u20E3]/gu;

// Every emoji that may stay, by file and character, with how many times it may appear and why.
// A count, not a pass for the whole file: one more of the same character is a failure, and so is
// one fewer, so an entry cannot outlive the reason it was written for.
const ALLOWED = [
  // The brand manual is the lead's document; whether its samples follow the app is the lead's call.
  // It lives in the repo's brand/ (the core's, MIT), which this app takes its look from, so the
  // scan reads that folder too: see files().
  { file: '../../brand/manual.html', ch: '\u23F8', count: 3, why: "status glyph samples (parked); the app draws a pause sprite" },
  { file: '../../brand/manual.html', ch: '\u26A0', count: 3, why: "status glyph samples (interrupted); the app draws a warning sprite" },
  { file: '../../brand/manual.html', ch: '\u263E', count: 3, why: "status glyph samples (asleep); the app draws a moon sprite" },
  { file: '../../brand/manual.html', ch: '\u25B6', count: 2, why: "the 'Try it now' sample button, en and es" },
  { file: '../../brand/manual.html', ch: '\u{1F389}', count: 4, why: "the voice guide's counter-example of what not to say" },
];

const TEXT = /\.(m?js|jsx|css|html|json|md|sh|txt|svg|webmanifest)$/;
function files() {
  // This folder, the brand folder at the root whose tokens.css the app imports, and the shared
  // screens (web/ui) the app is built from: an emoji in either reaches the product as surely as
  // one in web/src. Paths come back relative to this folder.
  return execFileSync('git', ['ls-files', '.', '../../brand', '../../web/ui'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter(f => f && TEXT.test(f) && fs.existsSync(path.join(ROOT, f)));
}

function emojiIn(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(EMOJI)) hits.push({ line: i + 1, col: m.index + 1, cp: `U+${m[0].codePointAt(0).toString(16).toUpperCase()}`, ch: m[0] });
  });
  return hits;
}

test('the rule catches what a platform draws as an emoji, and lets the text marks through', () => {
  for (const c of ['\u{1F399}', '\u26A1', '\u2699', '\u263E', '\u26BF', '\u23F8', '\u25B6', '\u2709', '\uFE0F', '\u{1F1EA}'])
    assert.equal(emojiIn(c).length, 1, `missed U+${c.codePointAt(0).toString(16)}`);
  for (const c of ['·', '›', '▸', '▾', '●', '◆', '✓', '✕', '─', '│', '└', '…', '←', '→', '⎇'])
    assert.equal(emojiIn(c).length, 0, `flagged the text mark ${c}`);
});

test('no emoji anywhere in the repo but the allowed places, and exactly as many there', () => {
  const list = files();
  assert.ok(list.some(f => f.startsWith('server/')) && list.some(f => f.startsWith('shared/i18n/'))
    && list.some(f => f.startsWith('../../web/ui/')) && list.length > 50,
    `read only ${list.length} files`);
  const bad = [], seen = new Map();
  for (const f of list) for (const h of emojiIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
    const rule = ALLOWED.find(a => a.file === f && a.ch === h.ch);
    if (rule) seen.set(rule, (seen.get(rule) || 0) + 1);
    else bad.push(`${f}:${h.line}:${h.col} ${h.ch} ${h.cp}`);
  }
  assert.deepEqual(bad, [], `emoji found; draw a pixel icon (web/ui/icon.jsx) instead:\n${bad.join('\n')}`);
  for (const a of ALLOWED)
    assert.equal(seen.get(a) || 0, a.count, `${a.file}: U+${a.ch.codePointAt(0).toString(16).toUpperCase()} allowed ${a.count} times (${a.why})`);
});

// A name the sprite table does not have renders nothing at all, silently: the tables that name
// icons must name real ones.
test('every icon a table names is drawn', async () => {
  const src = fs.readFileSync(path.join(ROOT, '../../web/ui/icon.jsx'), 'utf8');
  const drawn = new Set([...src.match(/const ROWS = \{([\s\S]*?)\n\};/)[1].matchAll(/^ {2}([a-z]+):/gm)].map(m => m[1]));
  assert.ok(drawn.size >= 20, `read ${drawn.size} icons`);
  const { ACTIONS } = await import('../shared/automations.js');
  for (const [k, a] of Object.entries(ACTIONS)) assert.ok(drawn.has(a.icon), `action '${k}' names icon '${a.icon}'`);
  const ui = fs.readFileSync(path.join(ROOT, '../../web/ui/ui.jsx'), 'utf8');
  const jsx = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter(f => /\.jsx$/.test(f)).map(f => path.join(ROOT, dir, f));
  const named = [...ui.matchAll(/icon: '([a-z]+)'/g), ...[...jsx('web/src'), ...jsx('../../web/ui')]
    .flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/<Icon name="([a-z]+)"|icon="([a-z]+)"/g)])]
    .map(m => m[1] || m[2]);
  assert.ok(named.length > 30, `found ${named.length} icon uses`);
  for (const n of named) assert.ok(drawn.has(n), `icon '${n}' is used but not drawn`);
});
