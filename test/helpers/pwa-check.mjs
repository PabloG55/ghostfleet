#!/usr/bin/env node
// test/helpers/pwa-check.mjs — the phone client's structural promises.
//
//     node test/helpers/pwa-check.mjs        # one "name <US> want <US> got" row per check
//
// grid-parity.mjs proves the CARDS match the TUI's. This file proves the things that
// make it a shippable PWA rather than a page that happens to render, and every check
// here is a failure that is invisible until someone is standing outside with a phone:
//
//   - a CDN link or a bare import specifier: works on this laptop, dead on the tailnet
//     (§5 — the Mac has no route to the internet on the phone's behalf, and there is no
//     build step to resolve a bare specifier anyway)
//   - a fixture added and not precached: the app installs, and then shows a blank
//     screen the first time it is opened offline
//   - an icon whose real pixels do not match its declared size: iOS silently falls
//     back to a screenshot of the page
//   - a confirmation reworded away from the TUI's: §7 says the guardrails ARE the TUI's
//     own prompts, so a rewrite is a redesign of the one thing standing between a
//     pocket and a deleted checkout
//   - a status vocabulary that quietly collapses two values into one label

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const read = f => fs.readFileSync(path.join(WEB, f), 'utf8');
const exists = f => fs.existsSync(path.join(WEB, f));

// Imported HERE, at the top, not beside the section that first uses them. The first cut
// put `const G = await import(...)` down in §6 and referenced G from §5d above it: a
// ReferenceError from the temporal dead zone, the same one this file now asserts app.js
// cannot have. It emitted ZERO rows, and a bare "no mismatches" check called that green
// — which is why test/run.sh puts a floor under the row count before it trusts any of
// this.
const G = await import(new URL('../../web/grid.js', import.meta.url).href);
const api = await import(new URL('../../web/api.js', import.meta.url).href);

const HTML = read('index.html');
const CSS = read('app.css');
const JS_FILES = ['app.js', 'api.js', 'grid.js', 'passkey.js', 'sw.js'];
const JS = Object.fromEntries(JS_FILES.map(f => [f, read(f)]));

// ── 1. nothing loads from off this machine ────────────────────────────────
// Checked as REFERENCES rather than by grepping for "http", so a URL inside a comment
// (there are several, pointing at the doc) does not read as a dependency.
const htmlRefs = [...HTML.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1]);
is('index.html loads nothing remote', '', htmlRefs.filter(u => /^[a-z]+:\/\//i.test(u)).join(','));
is('index.html has no protocol-relative ref', '', htmlRefs.filter(u => u.startsWith('//')).join(','));
is('every local file index.html asks for exists', '',
   htmlRefs.filter(u => !/^[a-z]+:/i.test(u) && !exists(u.replace(/^\.\//, ''))).join(','));
is('the stylesheet pulls in no font or image host', '',
   [...CSS.matchAll(/url\(\s*['"]?([^'")]+)/g)].map(m => m[1]).filter(u => /^[a-z]+:\/\//i.test(u)).join(','));
// Bare specifiers need a bundler or an import map; this repo has neither, and a bare
// specifier is exactly what a habit of writing `import x from "lodash"` produces.
const specs = [];
for (const [f, src] of Object.entries(JS)) {
  for (const m of src.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) specs.push([f, m[1]]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) specs.push([f, m[1]]);
}
is('every import is a relative path', '',
   specs.filter(([, s]) => !s.startsWith('./') && !s.startsWith('../')).map(([f, s]) => `${f}:${s}`).join(','));
is('every imported module exists', '',
   specs.filter(([, s]) => !exists(s.replace(/^\.\//, ''))).map(([f, s]) => `${f}:${s}`).join(','));
// ONE file talks to the network — api.js — and the invariant is worth an assertion
// because breaking it is so natural: a screen that fetches its own thing works
// perfectly against fixtures and then reaches for a URL that does not exist. (sw.js is
// exempt: intercepting fetch is what a service worker IS.)
for (const f of ['app.js', 'grid.js', 'passkey.js']) {
  is(`${f} does not fetch directly`, 0, (JS[f].match(/\bfetch\(/g) || []).length);
}
is('api.js is the file that does', true, (JS['api.js'].match(/\bfetch\(/g) || []).length > 0);

// ── 2. installable, and offline-usable ────────────────────────────────────
const man = JSON.parse(read('manifest.webmanifest'));
for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color']) {
  is(`manifest has ${k}`, true, man[k] != null);
}
is('manifest display is standalone', 'standalone', man.display);
// The PNG's real pixels, out of its IHDR — a resized icon that kept its old filename is
// otherwise undetectable, and iOS answers it by ignoring the icon entirely.
function pngSize(rel) {
  const b = fs.readFileSync(path.join(WEB, rel));
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'not a png';
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}
for (const ic of man.icons) {
  const rel = ic.src.replace(/^\.\//, '');
  is(`icon ${ic.src} exists`, true, exists(rel));
  if (exists(rel)) is(`icon ${ic.src} really is ${ic.sizes}`, ic.sizes, pngSize(rel));
}
is('an apple-touch-icon is linked', true, /rel="apple-touch-icon"/.test(HTML));
is('...and it is 180x180', '180x180', exists('icons/apple-touch-icon.png') ? pngSize('icons/apple-touch-icon.png') : 'missing');

// The precache list, in BOTH directions. A stale entry breaks nothing visibly; a
// MISSING entry breaks the app only offline, only on the first try, and only for
// whoever is standing on a train.
const shell = [...read('sw.js').matchAll(/'(\.\/[^']*)'/g)].map(m => m[1].replace(/^\.\//, '')).filter(Boolean);
is('every precached file exists', '', shell.filter(f => f && !exists(f)).join(','));
const shipped = [
  'index.html', 'app.css', ...JS_FILES.filter(f => f !== 'sw.js'), 'manifest.webmanifest',
  ...fs.readdirSync(path.join(WEB, 'icons')).filter(f => f.endsWith('.png')).map(f => `icons/${f}`),
  ...fs.readdirSync(path.join(WEB, 'fixtures')).filter(f => f.endsWith('.json')).map(f => `fixtures/${f}`),
];
is('every shipped file is precached', '', shipped.filter(f => !shell.includes(f)).join(','));
is('the service worker never caches a verb', true, /req\.method !== 'GET'/.test(read('sw.js')));

// ── 3. the fixtures are §4, exactly ───────────────────────────────────────
const NINE = ['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted'];
const TOP = ['project', 'profile', 'counts', 'cards', 'free_worktrees'].sort().join(',');
const CARD = ['name', 'label', 'status', 'folder', 'branch', 'agent', 'msg', 'age', 'attached', 'sched', 'limit_at', 'lead'].sort().join(',');
const COUNTS = ['need_you', 'working', 'ready', 'parked', 'limit', 'interrupted'].sort().join(',');
const fixDir = path.join(WEB, 'fixtures');
const grids = fs.readdirSync(fixDir).filter(f => /^grid-.*\.json$/.test(f)).sort();
for (const f of grids) {
  const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
  is(`${f}: top-level keys are §4's`, TOP, Object.keys(g).sort().join(','));
  is(`${f}: counts keys are §4's`, COUNTS, Object.keys(g.counts).sort().join(','));
  (g.cards || []).forEach((c, i) => {
    is(`${f}#${i}: card keys are §4's`, CARD, Object.keys(c).sort().join(','));
    is(`${f}#${i}: status is one of the nine`, true, NINE.includes(c.status));
    // A BOOLEAN, never absent and never a string: the client gates three destructive
    // buttons on it, and `undefined` is falsy in exactly the way a real `false` is.
    is(`${f}#${i}: lead is a boolean`, 'boolean', typeof c.lead);
  });
  // At most one lead per fleet, and where there is one it is FIRST — gather({lead:true})
  // puts it there deliberately (it is the card you opened the app to find), so a fixture
  // that showed it anywhere else would be teaching a layout the emitter cannot produce.
  const leads = (g.cards || []).filter(c => c.lead);
  is(`${f}: at most one lead`, true, leads.length <= 1);
  if (leads.length) is(`${f}: the lead is the first card`, true, g.cards[0].lead === true);
  (g.free_worktrees || []).forEach((w, i) => {
    is(`${f} free#${i}: keys are §4's`, 'branch,path,task', Object.keys(w).sort().join(','));
  });
}
// The session payload: 20 messages and a cursor, per §11.3.
const sessions = fs.readdirSync(fixDir).filter(f => /^session-/.test(f));
is('there is a session fixture longer than one page', true,
   sessions.some(f => (JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8')).messages || []).length > 20));

// ── 4. §7's guardrails, in §7's words ─────────────────────────────────────
// Extracted from fleet-grid.mjs rather than typed here, so a reworded TUI prompt shows
// up as a mismatch instead of as two apps that disagree in front of a deleted checkout.
const GRID = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-grid.mjs'), 'utf8');
const APP = JS['app.js'];
// Each entry: what the TUI's source must still contain, and the phrase the phone must
// carry. Read out of fleet-grid.mjs first — if the TUI reworded a prompt, the FIRST
// assertion fails and says so, instead of the second one blaming the phone.
const PROMPTS = [
  ["kill session '",                                          'the kill question'],
  ['y = yes · any other key = cancel',                         'the y/cancel keys'],
  ['f = remove anyway · any key = cancel',                     'the force key'],
  ["remove worktree '",                                        'the worktree question'],
  ['deleting the checkout — this can take a minute on a big one', 'the long-delete warning'],
  ["' from projects?",                                         'the project question'],
];
for (const [text, name] of PROMPTS) {
  is(`the TUI still has ${name}`, true, GRID.includes(text));
  is(`the phone reproduces ${name}`, true, APP.includes(text));
}
// Forcing takes a different key, not a second yes: "a second y on a prompt that just
// refused is a reflex, and this particular one throws away real work."
is('the force step does not accept a second y', true,
   /if \(c\.force\) \{ if \(k === 'f' \|\| k === 'F'\)/.test(APP));

// ── 5. the destructive set, and where it is enforced ──────────────────────
is('§7\'s destructive verbs take a passkey', 'fleet_rename,fleet_spawn,fleet_stop', [...api.DESTRUCTIVE].sort().join(','));
is('...and so does removing a worktree', true, /removeWorktree[\s\S]{0,400}assertFor\(/.test(APP));
is('stop --reclaim is reachable', true, /fleet_stop'[^\n]*reclaim: true/.test(APP));
is('reclaim takes BOTH confirmations', true, /reclaim-kill/.test(APP) && /reclaim-wt/.test(APP));

// ── 5a. ...and not on the lead ─────────────────────────────────────────────
// The lead's card looks exactly like a worker's — same five lines, same box — so the one
// thing standing between "master" and `stop --reclaim` on this screen is that the button
// is not drawn. It is read off §4's `lead` flag, NEVER by comparing the name: the producer
// decided which session is the lead once, and three copies of that comparison (the card
// list, the session screen, each button) is three things to keep in step.
//   None of this is the enforcement — mcp/fleet-dispatch.mjs refuses the call whoever asks
// — which is why the run.sh group drives the refusal through the planner as well.
is('the lead is read off the card, not the name', true,
   /function isLeadCard\(name\) \{ const c = cardOf\(name\); return !!\(c && c\.lead\); \}/.test(APP));
is('...and kill goes through the guard', true, /function askKill\(name\) \{ if \(name && !leadGuard\(/.test(APP));
is('...and reclaim too', true, /function askReclaim\(name\) \{ if \(name && !leadGuard\(/.test(APP));
is('...and rename too', true, /function sheetRename\(name\) \{[\s\S]{0,400}?leadGuard\(name, 'renamed'\)/.test(APP));
is('the lead keeps send/answer/pause', true, /const lead = !!\(c && c\.lead\);/.test(APP));
is('...and says why the rest are gone', true, /cannot be stopped, reclaimed or renamed/.test(APP));
// Fixture mode stands in for the SERVER, so it has to refuse what the server refuses —
// otherwise the demo teaches the opposite of what the daemon does.
is('fixture mode refuses to stop the lead', true, /refusing to stop 'master'/.test(JS['api.js']));
is('...and to rename it', true, /refusing to rename 'master'/.test(JS['api.js']));
// The two things §7 says cannot transfer. A substitute for either is the mistake; the
// app is required to SAY they are absent rather than leave a gap.
is('the stack is not rebuilt', 0, (APP.match(/renderStack|stackScreen/g) || []).length);
is('...and is named as deliberately absent', true, /a phone has no side/.test(APP));
is('no terminal or editor tab', 0, (APP.match(/fleet_tab|fleet-tab/g) || []).length);
is('...and that is named too', true, /no local shell/.test(APP));
is('the page bound is 20', 20, api.PAGE);

// ── 5b. nothing runs before its declarations exist ────────────────────────
// The bug this exists for: app.js's boot block sat at the TOP of the file, above the
// `const SHIP` the lock screen draws, so the very first render threw "Cannot access
// 'SHIP' before initialization" and every screen was blank. The file is valid syntax,
// so `node --check` passes it — the same "--check proves syntax, not that it runs" trap
// CLAUDE.md records for the grid, except a browser is the only thing that can run this
// one and the suite has no browser.
//
// So the rule is structural: every top-level DECLARATION comes before the first
// top-level STATEMENT. That is what makes a temporal-dead-zone reference impossible
// rather than merely absent today.
for (const f of ['app.js', 'api.js', 'grid.js', 'passkey.js']) {
  const lines = JS[f].split('\n');
  let lastDecl = -1, firstStmt = Infinity;
  lines.forEach((l, i) => {
    if (/^(?:export\s+)?(?:const|let|var|function|class)\s/.test(l)) lastDecl = i;
    // an executable statement at column 0: a bare call, an await, or a control keyword
    else if (/^(?:await\s|if\s*\(|for\s*\(|while\s*\(|[A-Za-z_$][\w$.]*\s*\()/.test(l)
             && !/^(?:import|export)\b/.test(l)) firstStmt = Math.min(firstStmt, i);
  });
  is(`${f}: nothing executes before the last declaration`, true, firstStmt > lastDecl);
}

// ── 5c. a card is drawn at one weight ─────────────────────────────────────
// `.card.sel { font-weight: 700 }` — the obvious translation of the TUI's C.bold — makes
// the SELECTED card wider than the others, because the bold face has no box-drawing
// glyphs and ─ ╭ ╮ ╰ ╯ fall back to a font with a different advance. 366px → 517px on
// the same 32-character line, measured. The card you just tapped is the one that loses
// its right border, which is about as hard to reproduce deliberately as a bug gets.
// Comments stripped FIRST: the rule this guards is preceded by a long comment
// explaining it, and an anchor of "start-of-file or }" therefore never matched — the
// assertion passed with `font-weight: 700` sitting right there. Watched going red only
// after the strip, which is the whole reason the repo insists on watching.
const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const cardRules = [...cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => [m[1].trim(), m[2]])
  .filter(([sel]) => /\.card/.test(sel));
is('there are .card rules to check', true, cardRules.length > 0);
is('no .card rule sets font-weight', '',
   cardRules.filter(([, body]) => /font-weight/.test(body)).map(([sel]) => sel).join(' | '));
// ...and the width probe has to be made of the characters that actually break: a probe
// of letters would measure a face the card never uses for its border.
is('the width probe measures a box rule', true, /probe\.textContent = '╭' \+ '─'/.test(APP));

// ── 5d. one cell per character, whatever the font does ────────────────────
// The bug: ⧗ (the limit glyph) measures 1.274 cells and ⏸ 1.046 in every monospace face
// on this machine, so `⧗ limit` pushed its line a quarter of a column wide and the
// card's right border stepped outside the box — on whichever card happened to be at a
// usage ceiling. The TUI's own suite pins its glyphs to one COLUMN by measuring them in
// a real pane; the phone cannot pick a font that behaves, so it pins them to one CELL.
//
// cells() is the split that does it, and these are its invariants: nothing added,
// nothing dropped, and every non-ASCII code point in a box of its own.
is('the card renders through cells()', true, /for \(const tok of G\.cells\(line\)\)/.test(APP));
is('...into a 1ch box', true, /\.card \.c \{[^}]*width: 1ch/.test(CSS));
{
  let joined = 0, split = 0, notOne = 0, asciiLeak = 0, lines = 0;
  const nonAscii = s => [...s].filter(c => c.codePointAt(0) >= 0x80).length;
  for (const f of grids) {
    const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
    const blocks = [
      ...(g.cards || []).map((c, i) => G.cardLines(c, false, i)),
      ...(g.free_worktrees || []).map((w, i) => G.freeCardLines(w, false, i)),
      G.newCardLines(false),
    ];
    for (const b of blocks) for (const line of b.lines) {
      lines++;
      const toks = G.cells(line);
      if (toks.map(t => t.text).join('') !== line) joined++;
      if (toks.filter(t => t.cell).length !== nonAscii(line)) split++;
      if (toks.some(t => t.cell && [...t.text].length !== 1)) notOne++;
      if (toks.some(t => !t.cell && nonAscii(t.text) > 0)) asciiLeak++;
    }
  }
  is('there were card lines to split', true, lines > 100);
  is('cells() loses no character', 0, joined);
  is('cells() boxes every non-ASCII code point', 0, split);
  is('...one code point per box', 0, notOne);
  is('...and leaves nothing non-ASCII outside a box', 0, asciiLeak);
}
// The nine glyphs specifically. `unknown` leads with '?', which is ASCII and therefore
// already exactly one advance in a monospace face — it needs no box, and an assertion
// demanding one was simply wrong (caught by running it). Every other glyph is non-ASCII
// and must come back boxed.
for (const st of NINE) {
  const glyph = [...G.STATUS[st].label][0];
  const ascii = glyph.codePointAt(0) < 0x80;
  const boxed = G.cells(G.STATUS[st].label).some(t => t.cell && t.text === glyph);
  is(`the ${st} glyph occupies exactly one cell`, true, ascii || boxed);
}

// ── 5e. the pane view keeps the card's two rules, and its own promise ─────
// The session screen's default is now the real tmux pane (web/ansi.js). It is a much
// bigger character grid than a card — 269 columns on this machine's fleets, measured — so
// the two geometry rules above matter MORE here, not less, and each is checked as a
// negative because a rule that never fires looks exactly like one that works.
const paneRules = [...cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => [m[1].trim(), m[2]])
  .filter(([sel]) => /\.pane/.test(sel));
is('there are .pane rules to check', true, paneRules.length > 0);
// Rule one, and the reason ansi.js renders SGR 1 as the bright half of the palette: the
// bold face has no box-drawing glyphs, so a weight change moves ─ ╭ ╮ ╰ ╯ and not │.
is('no .pane rule sets font-weight', '',
   paneRules.filter(([, body]) => /font-weight/.test(body)).map(([sel]) => sel).join(' | '));
// COMMENTS STRIPPED FIRST, and this is the same trap as the .card rule above: ansi.js's
// header explains at length why bold must not be a weight, so a bare grep for
// "font-weight" matched its own reasoning and the assertion could never pass. Only what
// the file EMITS counts.
const ansiCode = read('ansi.js').replace(/^\s*\/\/.*$/gm, '');
is('...and the renderer emits none either', '',
   (ansiCode.match(/font-weight/g) || []).join(','));
// Rule two: one cell per cell, boxed, through the SAME cells() the card uses.
is('the pane renders through cells()', true, /import \{ cells[^}]*\} from '\.\/grid\.js'/.test(read('ansi.js')));
is('...into a 1ch box', true, /\.pane \.c \{[^}]*width: 1ch/.test(CSS));
is('...and a 2ch box for a two-column cell', true, /\.pane \.c\.w \{[^}]*width: 2ch/.test(CSS));
// NEVER WRAPPED. `white-space: pre` is the whole difference between a terminal and a
// paragraph, and `pre-wrap` here would reflow a 269-column grid into porridge.
is('the pane never wraps', true, /\.pane \{[^}]*white-space: pre[;\s]/.test(cssNoComments));
// ...and the sideways scroll it needs instead is INSIDE its own box. A body that scrolls
// horizontally slides the whole app off the screen, header and verbs with it.
is('the pane box scrolls on its own', true, /\.pane-box \{[^}]*overflow: auto/.test(cssNoComments));
is('...without chaining to the page', true, /\.pane-box \{[^}]*overscroll-behavior: contain/.test(cssNoComments));
// The poll STOPS when the page is hidden, cleared rather than skipped: a phone waking its
// radio every two seconds in a pocket is the cost this is about, and `if (hidden) return`
// inside the callback still pays it.
is('hiding the page tears the pane timer down', true, /document\.hidden\)\s*\{[^}]*stopPanePoll\(\)/.test(APP));
is('...and the timer is a real clearInterval', true, /clearInterval\(paneTimer\)/.test(APP));
is('...and it never runs while hidden', true, /panePollWanted = \(\) =>\s*\n?\s*!document\.hidden/.test(APP));
// WHERE THE READER SCROLLED TO SURVIVES A RE-RENDER, and this pair guards a bug that a
// fake DOM cannot see and a real browser found immediately. refresh()'s 5s grid poll ends
// in render(), which rebuilds the session screen — so the "open at the end" rule threw the
// reader to the bottom of the pane every five seconds. Measured in headless Chrome at
// 390x844: scrolled to (top 40, left 300), and five seconds later (253, 0), which is the
// bottom of a 269-column pane at column zero, mid-sentence. Asserted here as the SHAPE of
// the fix — the offset lives outside the nodes, and the jump-to-end is conditional — and
// verified as behaviour in a browser, because an assertion against a stub DOM would only
// prove the stub.
is('the pane scroll offset outlives the nodes', true, /^let paneScroll = null;/m.test(APP));
is('...and the jump-to-end is conditional', true, /if \(!paneScroll \|\| paneScroll\.atEnd\)/.test(APP));
is('...fed by the box\'s own scroll events', true, /addEventListener\('scroll', \(\) => rememberPaneScroll/.test(APP));

// A tap on a card lands on the PANE. The message list stays reachable — it pages back over
// the whole transcript, which a pane cannot — so both halves are asserted.
is('a session opens on the pane', true, /S\.view = 'pane';/.test(APP));
is('...and the message list is still reachable', true, /pick\('msgs', 'messages'\)/.test(APP));
// api.js is still the only file that talks to the network, pane included.
is('the pane read goes through api.js', true, /export async function getPane/.test(read('api.js')));
is('...and ansi.js fetches nothing', '', (read('ansi.js').match(/\bfetch\(/g) || []).join(','));

// ── 6. no status is quietly folded into another ────────────────────────────
is('nine statuses, nine distinct labels', 9, new Set(NINE.map(s => G.STATUS[s].label)).size);
is('unknown is not idle', true, G.STATUS.unknown.label !== G.STATUS.idle.label && G.STATUS.unknown.color !== G.STATUS.idle.color);
is('limit is not ready', true, G.STATUS.limit.label !== G.STATUS.ready.label && G.STATUS.limit.color !== G.STATUS.ready.color);
is('interrupted is not ready', true, G.STATUS.interrupted.label !== G.STATUS.ready.label && G.STATUS.interrupted.color !== G.STATUS.ready.color);
// The counts line, the other place a fold hides: five limited workers must never be
// summarised as five ready ones.
is('limit is counted apart from ready', '0 need you · 0 working · 0 ready · 5 at limit',
   G.countsLine({ need_you: 0, working: 0, ready: 0, limit: 5, interrupted: 0, parked: 0 }));
is('interrupted is counted apart from ready', '0 need you · 0 working · 0 ready · 3 interrupted',
   G.countsLine({ need_you: 0, working: 0, ready: 0, limit: 0, interrupted: 3, parked: 0 }));
is('a zero clause is not printed', '0 need you · 2 working · 4 ready',
   G.countsLine({ need_you: 0, working: 2, ready: 4, limit: 0, interrupted: 0, parked: 0 }));

// ── 7. the schedule form's clock ──────────────────────────────────────────
// parseWhen is mirrored from the TUI; the clock is pinned so the assertions cannot be
// flaky at a second boundary. 2026-08-21 09:00 local.
const NOW = Math.floor(new Date(2026, 7, 21, 9, 0, 0).getTime() / 1000);
const at = s => G.parseWhen(s, NOW);
is('+2h', NOW + 7200, at('+2h'));
is('+30m', NOW + 1800, at('+30m'));
is('15:30 today', Math.floor(new Date(2026, 7, 21, 15, 30, 0).getTime() / 1000), at('15:30'));
is('3:50am has passed, so tomorrow', Math.floor(new Date(2026, 7, 22, 3, 50, 0).getTime() / 1000), at('3:50am'));
is('a bare hour', Math.floor(new Date(2026, 7, 21, 11, 0, 0).getTime() / 1000), at('11'));
is('25:00 is not a time', null, at('25:00'));
is('nonsense is not a time', null, at('soon'));
is('empty is not a time', null, at(''));

// ── 8. the offline promise ────────────────────────────────────────────────
is('the last payload is kept for a cold open', true, /localStorage\.setItem\(LS_LAST/.test(APP));
is('...and a stale screen says how old it is', true, /offline — last fetched/.test(APP));
// §5's rule about the token, checked as CODE and not as prose: the first version of
// this assertion matched api.js's own comment explaining why the token is not stored,
// and so passed while proving nothing. Only a real write counts.
const stores = [...read('api.js').matchAll(/(?:localStorage|sessionStorage)\.setItem\(([^)]*)\)/g)].map(m => m[1]);
is('no storage write mentions the token', '', stores.filter(a => /token/i.test(a)).join('|'));
is('the token lives in a module variable', true, /^let token = null, tokenExp = 0;$/m.test(read('api.js')));

// ── 9. the probe asks a route the server really has ───────────────────────
// api.js decides between the daemon and the bundled fixtures by asking ONE endpoint, and
// reads a 401 there as proof of a fleet (§5: the API refusing an unauthenticated request
// is the enforcement). Both halves of that are cross-file facts about fleet-serve, and
// both break silently:
//
//   - an INVENTED path answers 401 today only because the token gate runs before the
//     routing table. Move the gate and it 404s, api.js reads "no server", and every
//     phone the daemon serves quietly falls back to sample data — the bug this whole
//     section exists for, one release later.
//   - a path in fleet-serve's OPEN set answers 200 with no token, so a probe there
//     proves the endpoint exists but says nothing about auth being enforced.
const SERVE = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'utf8');
is('the probe path is a route fleet-serve has', true,
   new RegExp(`p === '${api.PROBE_PATH}'`).test(SERVE));
is('...and it sits behind the token gate', false,
   new RegExp(`OPEN = new Set\\(\\[[^\\]]*'${api.PROBE_PATH}'`).test(SERVE));
// One file knows where the fleet lives — the same invariant as "one file fetches", and
// broken the same way: a screen that reads the setting itself gets its own opinion about
// which backend it is talking to.
is('only api.js reads the backend setting', '',
   ['app.js', 'passkey.js', 'grid.js'].filter(f => /gf\.base/.test(JS[f])).join(','));

console.log(rows.join('\n'));
