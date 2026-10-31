#!/usr/bin/env node
// stack-check — the desk's stack on the web: several sessions, across projects, on screen
// at once. A picker grouped by machine and project; side-by-side columns at a desk, a swipe
// apart on a phone; and four open chats that stay inside the daemon's per-device read limit.
//
//     node test/helpers/stack-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a client without a stack (a `git
// archive` of staging) every row about the stack goes red, which is how they were watched
// red first; the rows staging could not tell apart were watched red against copies of this
// client broken on purpose (listed in the PR).
//
// Three halves:
//   · FIXTURE MODE at 1600x900 with a mouse and at 390x844 with touch — the screens, the
//     keys, the composers and the gestures, read back from what is DRAWN.
//   · FIXTURE MODE with a second machine paired — the picker's grouping by host, and a
//     column whose session lives on the other machine.
//   · SERVER MODE against a fake fleet-serve that counts — the read rate, which the fixture
//     backend cannot express (it has no ETag, no 429 and no per-device bucket). The limit
//     asserted is the one bin/fleet-serve.mjs ships, read out of its DEFAULTS rather than
//     copied here, so a change to the daemon's number is a change to this row.
//
// KEYS ARE PRESSED, NOT DISPATCHED (desktop-check says why), and every key in web/README.md's
// stack table is pressed by a row here: a key added to the table without one is a red row.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });
const PRESSED = new Set();
const fx = (f) => JSON.parse(fs.readFileSync(path.join(WEB, 'fixtures', f), 'utf8'));
const until = async (f, ms = 8000) => { const t0 = Date.now(); let v = await f(); while (!v && Date.now() - t0 < ms) { await sleep(80); v = await f(); } return v; };

// The daemon's own number: `rate: { window: 60, read: 240, … }` in DEFAULTS.
const LIMIT = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'utf8');
  const m = /rate:\s*\{\s*window:\s*(\d+),\s*read:\s*(\d+)/.exec(src);
  return m ? { window: Number(m[1]), read: Number(m[2]) } : null;
})();

// ── one browser, driven ─────────────────────────────────────────────────────────────────
function driver(b) {
  const VK = { Enter: 13, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
               ' ': 32, '/': 191, '`': 192, '<': 188, '>': 190 };
  const ARROW = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  async function press(key, { ctrl = false, shift = false, as = null } = {}) {
    PRESSED.add(as || ((ctrl ? 'Ctrl-' : '') + (shift ? '⇧' : '') + (key === ' ' ? 'space' : key === 'Enter' ? '⏎' : key === 'Escape' ? 'Esc' : key === 'Backspace' ? '⌫' : ARROW[key] || key)));
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = ctrl ? '' : key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
                modifiers: (ctrl ? 2 : 0) | (shift || ('<>'.includes(key) && one) ? 8 : 0) };
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(140);
  }
  const type = async (s) => { for (const ch of s) await press(ch, { as: 'text' }); };
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  async function clickAt(x, y) {
    for (const t of ['mousePressed', 'mouseReleased'])
      await b.call('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(200);
  }
  const center = (q, i = 0, text = null) => b.evaluate((q, i, t) => {
    const ns = [...document.querySelectorAll(q)].filter(n => t == null || n.textContent.trim() === t);
    const n = ns[i]; if (!n) return null;
    const r = n.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height / 2, 18))];
  }, q, i, text);
  async function click(q, i = 0, text = null) { const c = await center(q, i, text); if (!c) return false; await clickAt(c[0], c[1]); return true; }
  async function tap(q, i = 0, text = null) {
    const c = await center(q, i, text); if (!c) return false;
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c[0], y: c[1] }] }); await sleep(40);
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
    return true;
  }
  // A finger (or a mouse) dragged across the column's conversation, as typed pointer events —
  // the path the chat's swipe listens on (desktop-check's fingerDrag).
  const drag = (dx, pointerType = 'touch') => b.evaluate((dx, pt) => {
    const c = document.querySelector('#app .scol .chat'); if (!c) return false;
    const r = c.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    for (const [t, d] of [['pointerdown', 0], ['pointermove', dx / 2], ['pointerup', dx]])
      c.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerType: pt, pointerId: 7, clientX: x + d, clientY: y }));
    return true;
  }, dx, pointerType);
  const look = () => b.evaluate(() => {
    const t = (q, r = document) => ((r.querySelector(q) || {}).textContent || '').trim();
    const cols = [...document.querySelectorAll('#app .stack > .scol')].map(c => {
      const box = c.querySelector('.composer textarea'), r = c.getBoundingClientRect();
      return { nm: t('.sbar .nm', c), on: c.classList.contains('on'), draft: box ? box.value : null,
               turns: c.querySelectorAll('.chat .turn').length, text: t('.chat', c).slice(0, 4000),
               tiles: c.querySelectorAll('.composer .photos .ph').length,
               left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    });
    const a = document.activeElement, ac = a && a.closest && a.closest('.scol');
    return {
      picker: !!document.querySelector('#app .pick-list'),
      stack: !!document.querySelector('#app .stack'),
      groups: [...document.querySelectorAll('#app .pick-list > .sect')].map(n => n.textContent.trim()),
      rows: [...document.querySelectorAll('#app .pick-list .pickrow .c-name')].map(n => n.textContent.trim()),
      stacked: [...document.querySelectorAll('#app .pick-list .pickrow.stacked .c-name')].map(n => n.textContent.trim()),
      line: t('#app .confirm') || t('#app > .hint'),
      cols, name: t('#app .stack-bar .nm'), pos: t('#app .stack-bar .pos'),
      hidden: [...document.querySelectorAll('#app .stack-bar .stack-hidden button')].map(n => n.textContent.trim()),
      focus: ac ? t('.sbar .nm', ac) || 'column' : a ? a.tagName : '',
      typing: !!a && a.tagName === 'TEXTAREA',
      session: t('#app > .sbar .nm'),
      duo: document.documentElement.classList.contains('duo'),
      stored: (() => { try { return JSON.parse(localStorage.getItem('gf.stack') || 'null'); } catch { return null; } })(),
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog()
    .map(r => ({ tool: r.tool, project: r.args && r.args.project, session: r.args && r.args.session, prompt: r.args && r.args.prompt })));
  return { press, type, goto, click, clickAt, tap, drag, look, settle, audit, center };
}

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the stack', 'no chrome to press keys in'); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const D = driver(b);
  const { press, type, click, look, settle, audit } = D;
  const base = srv.base;

  // A clean app at a size, past the lock screen, on Projects. `paired` puts a second machine
  // in the fixtures (api.js pairedFixture).
  async function fresh(w = 1600, h = 900, mobile = false, paired = '') {
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: mobile, ...(mobile ? { maxTouchPoints: 5 } : {}) });
    await b.call('Emulation.setEmitTouchEventsForMouse', { enabled: mobile });
    await D.goto(base + '/index.html');
    await b.evaluate((pm) => { try { localStorage.clear(); sessionStorage.clear(); if (pm) localStorage.setItem('gf.fixture.paired', pm); } catch {} return null; }, paired);
    await D.goto(base + '/index.html');
    await unlock();
  }
  async function unlock() {
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click();
      return !!document.querySelector('.card .c-name, #app .stack, #app .pick-list');
    }), 8000);
    await sleep(300);
  }
  const pickRow = (name, i = 0) => click('#app .pick-list .pickrow .c-name', i, name);
  // A SCREEN CHANGE SLIDES on a phone (slideNav, a view transition), and a tap inside those
  // 260ms hits the snapshot, not the card under it — measured here: the pointerdown landed on
  // #app. desktop-check's slid(): wait for the slide to end before the finger lands.
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
  // The newest assistant turn's first line: it is on the newest page, which is what a column opens on.
  const firstLine = (f) => String((fx(f).messages || []).filter(m => m.role === 'assistant').pop().text).split('\n')[0].slice(0, 40);

  // EACH PART ON ITS OWN: a client without a stack fails the first row that needs one, and
  // the parts after it must still each say red, rather than not be asked at all.
  let s;
  const part = async (name, fn) => { try { await fn(); } catch (e) { is(`${name} ran`, 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`); } };
  await part('the desk', async () => {
  // ════════════════════════════════════════════════════════════════════════════════════
  // THE PICKER, AT A DESK
  // ════════════════════════════════════════════════════════════════════════════════════
  await fresh();
  await press('x', { ctrl: true });
  s = await settle(x => x.picker && x.rows.length > 3);
  is('desk: Ctrl-x on Projects opens the stack picker', true, s.picker);
  is('...in the right pane, Projects beside it', true, s.picker && s.duo);
  is('...every session of every project with one, grouped by project', ['acme-api', 'toolbox'], s.groups);
  is('...the sessions under acme-api are its grid\'s cards', true,
     ['master', 'api-fix', 'docs-pass'].every(n => s.rows.includes(n)) && s.rows.includes('search-index'));
  await press(' ');
  s = await settle(x => x.stacked.length === 1);
  is('picker space: adds the session under the cursor', ['master'], s.stacked);
  is('...and keeps it on this device', [{ project: 'acme-api', session: 'master' }], s.stored && s.stored.members);
  await press('j'); await press(' ');
  s = await settle(x => x.stacked.length === 2);
  is('picker j then space: the next one', ['master', 'api-fix'], s.stacked);
  await press(' ');
  s = await settle(x => x.stacked.length === 1);
  is('picker space again: takes it back out', ['master'], s.stacked);
  await press('k'); await press('ArrowDown'); await press('ArrowDown'); await press('ArrowUp');
  await press(' ');
  is('picker k ↓ ↓ ↑: the cursor walks the rows', ['master', 'api-fix'], (await settle(x => x.stacked.length === 2)).stacked);
  await pickRow('docs-pass');
  is('picker click: toggles the clicked session', ['master', 'api-fix', 'docs-pass'], (await settle(x => x.stacked.length === 3)).stacked);
  await pickRow('docs-pass');
  is('...and a second click takes it out', ['master', 'api-fix'], (await settle(x => x.stacked.length === 2)).stacked);
  // `/` — the desk's matcher, narrowing, space still toggling.
  await press('/'); await type('search');
  s = await settle(x => x.rows.length === 1);
  is('picker /: narrows to what matches, by the desk\'s matcher', ['search-index'], s.rows);
  is('...and says so in the search line', true, /^\/search/.test(s.line) && /1 match/.test(s.line));
  await press(' ');
  is('picker / space: adds the match without typing a space', true, (await settle(x => x.stacked.includes('search-index'))).stacked.includes('search-index'));
  await press('Enter');
  s = await look();
  is('picker / ⏎: keeps the search', true, /1 of 1/.test(s.line));
  await press('n'); await press('N'); await press('Backspace'); await press('/');
  is('picker / n N ⌫ /: still searching, one letter shorter', true, /^\/searc/.test((await look()).line));
  await press('Escape');
  s = await settle(x => x.rows.length > 3);
  is('picker / Esc: the whole list again', true, s.rows.length > 3);
  // c clears the whole stack; put it back by keys for what follows.
  await press('c');
  s = await settle(x => !x.stacked.length);
  is('picker c: clears the stack', [true, []], [s.picker, (s.stored && s.stored.members) || null]);
  await press('Enter');
  is('picker ⏎ with nothing stacked: says so and stays', true, /empty/.test((await look()).line) && (await look()).picker);
  for (const n of ['master', 'api-fix', 'search-index']) await pickRow(n);
  await settle(x => x.stacked.length === 3);

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE STACK, AT A DESK: columns side by side
  // ════════════════════════════════════════════════════════════════════════════════════
  await press('Enter');
  s = await settle(x => x.cols.length === 3 && x.cols.every(c => c.turns || /No messages/.test(c.text)), 8000);
  is('picker ⏎: the stack opens, three columns', ['master', 'api-fix', 'search-index'], s.cols.map(c => c.nm));
  is('...side by side across the right pane', true, s.cols.length === 3 &&
     s.cols.every((c, i) => c.width > 250 && (i === 0 || c.left >= s.cols[i - 1].right - 1)));
  is('...each its own conversation', [true, true, true], [
    s.cols[0]?.text?.includes(firstLine('session-acme-api-master.json')),
    s.cols[1]?.text?.includes(firstLine('session-acme-api-api-fix.json')),
    /No messages yet/.test(s.cols[2]?.text)]);
  is('...the first one focused, its composer ready to type in', ['master', true], [s.focus, s.typing]);
  is('...and only one column has the focus', 1, s.cols.filter(c => c.on).length);

  // Each composer sends to its own session.
  await type('one for master'); await press('Enter');
  await click('#app .scol textarea', 1);
  s = await look();
  is('click a column\'s box: that column takes the focus', ['api-fix', true], [s.cols.find(c => c.on)?.nm, s.typing]);
  await type('one for api-fix'); await press('Enter');
  await click('#app .scol textarea', 2);
  await type('one for search-index'); await press('Enter');
  await sleep(500);
  const sent = (await audit()).filter(r => r.tool === 'fleet_send').map(r => `${r.project}/${r.session}:${r.prompt}`);
  is('each composer sends to its own session', [
    'acme-api/master:one for master', 'acme-api/api-fix:one for api-fix', 'toolbox/search-index:one for search-index'].sort(), sent.sort());
  s = await look();
  is('...and each send is drawn in its own column', [true, true],
     [s.cols[0]?.text?.includes('one for master'), s.cols[1]?.text?.includes('one for api-fix')]);
  is('...and in no other', false, s.cols[0]?.text?.includes('one for api-fix') || s.cols[1]?.text?.includes('one for master'));

  // Drafts: a half-typed message stays with its column.
  await click('#app .scol textarea', 0); await type('half for master');
  await click('#app .scol textarea', 1); await type('half for api-fix');
  s = await look();
  is('drafts: each column keeps its own half-typed message', ['half for master', 'half for api-fix', ''], s.cols.map(c => c.draft));
  // ⇧⏎ is a new line in a column's box too, not a send.
  await press('Enter', { shift: true });
  is('composer ⇧⏎: a new line, not a send', 'half for api-fix\n', (await look()).cols[1]?.draft);
  await press('Backspace', { as: 'text' });

  // Paste: an image lands in the column it was pasted into.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await b.evaluate((png) => {
    const bin = atob(png); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([u8], 'shot.png', { type: 'image/png' }));
    const box = document.querySelectorAll('#app .scol .composer textarea')[2]; box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return null;
  }, PNG);
  s = await settle(x => x.cols.some(c => c.tiles));
  is('paste: an image pasted into a column\'s box lands in that column', [0, 0, 1], s.cols.map(c => c.tiles));

  // The focus keys: the desk stack's ⇧← / ⇧→ ring, which wraps — from inside a box too.
  await click('#app .scol textarea', 0);
  await press('ArrowRight', { shift: true });
  s = await look();
  is('⇧→ (from the focused box): the next column takes the focus', ['api-fix', 'api-fix'], [s.cols.find(c => c.on)?.nm, s.focus]);
  await press('ArrowRight', { shift: true }); await press('ArrowRight', { shift: true });
  is('⇧→ at the last column: wraps to the first', 'master', (await look()).cols.find(c => c.on)?.nm);
  await press('ArrowLeft', { shift: true });
  is('⇧← at the first column: wraps to the last', 'search-index', (await look()).cols.find(c => c.on)?.nm);
  is('...and the drafts went nowhere', ['half for master', 'half for api-fix'], (await look()).cols.slice(0, 2).map(c => c.draft));
  // Keys with nothing focused: the desk's prefix table.
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('ArrowLeft', { shift: true });
  is('⇧← with no box focused: the focus moves too', 'api-fix', (await look()).cols.find(c => c.on)?.nm);
  await press('a', { ctrl: true }); await press('<', { as: 'Ctrl-a <' });
  s = await look();
  is('Ctrl-a <: moves the focused column one place left', ['api-fix', 'master', 'search-index'], s.cols.map(c => c.nm));
  is('...and the stack remembers the order', ['api-fix', 'master', 'search-index'], (s.stored?.members || []).map(m => m.session));
  const before = (await look()).cols.map(c => c.nm);
  await press('a', { ctrl: true }); await press('>', { as: 'Ctrl-a >' });
  // A PAIR, because "back" is where it started: a move that does nothing would match alone.
  is('Ctrl-a >: and back', [['api-fix', 'master', 'search-index'], ['master', 'api-fix', 'search-index']],
     [before, (await look()).cols.map(c => c.nm)]);
  await press('a', { ctrl: true }); await press('ArrowRight', { as: 'Ctrl-a →' });
  is('Ctrl-a →: the next column', 'search-index', (await look()).cols.find(c => c.on)?.nm);
  await press('a', { ctrl: true }); await press('ArrowLeft', { as: 'Ctrl-a ←' });
  is('Ctrl-a ←: the previous one', 'api-fix', (await look()).cols.find(c => c.on)?.nm);
  // ⇧← / Ctrl-a ← put the focus in the box (a keyboard is there), so let it go first: this
  // row is about the stack handing a key to the box, not the box taking it itself.
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('p');
  is('a letter with no box focused: typed into the focused column', 'half for api-fixp', (await look()).cols[1]?.draft);
  await press('Backspace', { as: 'text' });

  // #86's rules, per column: a poll that brings nothing changes no DOM, a column scrolled up
  // stays where it was, and the focused box keeps its focus while polls land.
  // The column scrolled is NOT the focused one, and is left well clear of its top: near the
  // top of the FOCUSED column is where the older page loads (nearTop), and that is a scroll
  // the app makes on purpose — measured, it moved 40 to 504 when the scroll event beat the
  // click, holding the reader's place over the page it had just put above them.
  await click('#app .scol textarea', 0);
  const scroll = await b.evaluate(() => { const c = document.querySelectorAll('#app .scol .chat')[1]; c.scrollTop = 400; return c.scrollTop; });
  await sleep(300);
  await b.evaluate(() => {
    window.__mut = 0;
    window.__mo = new MutationObserver((ms) => { window.__mut += ms.length; });
    window.__mo.observe(document.querySelector('#app .stack'), { subtree: true, childList: true, attributes: true, characterData: true });
    return null;
  });
  await sleep(11000);
  s = await look();
  const quiet = await b.evaluate(() => { window.__mo.disconnect(); return window.__mut; });
  is('polling: eleven seconds of polls that bring nothing change no DOM in the stack', 0, quiet);
  is('...a column scrolled up stays where its reader left it', scroll,
     await b.evaluate(() => document.querySelectorAll('#app .scol .chat')[1].scrollTop));
  is('...and the focused box kept its focus throughout', ['master', true], [s.focus, s.typing]);

  // Close a column.
  await click('#app .scol .scol-bar button', 2);
  s = await settle(x => x.cols.length === 2);
  is('×: closes the column', ['master', 'api-fix'], s.cols.map(c => c.nm));
  is('...and takes it out of the stack', ['master', 'api-fix'], (s.stored?.members || []).map(m => m.session));

  // The selection survives a reload — the stack, its order and its drafts.
  await b.call('Page.reload'); await sleep(800); await unlock();
  s = await settle(x => x.cols.length === 2 && x.cols[1].turns > 0, 8000);
  is('reload: the stack comes back as it was', ['master', 'api-fix'], s.cols.map(c => c.nm));
  is('...with each column\'s draft', ['half for master', 'half for api-fix'], s.cols.map(c => c.draft));

  // More than four: the first four, and a chip for each of the rest that swaps it in.
  await press('x', { ctrl: true });
  await settle(x => x.picker && x.rows.length > 3);
  for (const n of ['docs-pass', 'list-pages', 'cache-keys', 'csv-export']) await pickRow(n);
  await settle(x => x.stacked.length === 6);
  await press('Escape');
  s = await settle(x => x.cols.length === 4);
  is('picker Esc (opened from the stack): back to the stack', true, s.stack);
  is('six stacked at a desk: the first four as columns', ['master', 'api-fix', 'docs-pass', 'list-pages'], s.cols.map(c => c.nm));
  is('...and the other two as chips in the bar', ['cache-keys', 'csv-export'], s.hidden);
  const focusedBefore = s.cols.find(c => c.on)?.nm;
  await click('#app .stack-bar .stack-hidden button', 1);
  s = await settle(x => x.hidden.length === 2 && x.cols.some(c => c.nm === 'csv-export'));
  is('a chip: swaps that session in for the focused column', true,
     s.cols.some(c => c.nm === 'csv-export' && c.on) && s.hidden.includes(focusedBefore));
  is('...still four columns', 4, s.cols.length);
  await press('a', { ctrl: true }); await press('x', { as: 'Ctrl-a x' });
  is('Ctrl-a x: the picker, from the stack', true, (await settle(x => x.picker)).picker);
  await press('q');
  is('picker q: back', true, (await settle(x => x.stack)).stack);
  await press('`');
  s = await settle(x => !x.stack && !x.picker);
  // Reopened by a reload, the stack was opened from nowhere: back is Projects, with nothing
  // open beside it.
  is('` in the stack: back out to where it was opened from', true, !s.stack && !s.picker &&
     await b.evaluate(() => /projects/.test((document.querySelector('#side .hdr .scope') || {}).textContent || '') && !!document.querySelector('#app .duo-empty')));

  });
  await part('the other ways in', async () => {
  // The other ways in, at a desk: t and Ctrl-x on a grid, Ctrl-x in a session.
  await fresh();
  await press('Enter');                    // Projects ⏎: the project's master, as at the desk
  await until(() => b.evaluate(() => (document.querySelector('#app > .sbar .nm') || {}).textContent === 'master'));
  await press('x', { ctrl: true });
  is('Ctrl-x in a session: the picker', true, (await settle(x => x.picker)).picker);
  await press('Escape');
  is('picker Esc: back to the session', 'master', (await settle(x => x.session === 'master')).session);
  await press('s', { ctrl: true });
  await until(() => b.evaluate(() => /acme-api/.test((document.querySelector('#side .hdr .scope') || {}).textContent || '')));
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('t');
  is('t on a grid: the picker', true, (await settle(x => x.picker)).picker);

  });
  await part('a second machine', async () => {
  // ════════════════════════════════════════════════════════════════════════════════════
  // A SECOND MACHINE: grouped by host, and a column on the other machine
  // ════════════════════════════════════════════════════════════════════════════════════
  await fresh(1600, 900, false, 'online');
  await press('x', { ctrl: true });
  s = await settle(x => x.picker && x.groups.length >= 4, 8000);
  const vmAt = s.groups.indexOf('vm');
  is('paired: the picker groups by machine, then by project', true,
     vmAt > 0 && s.groups[vmAt + 1] === 'acme-api' && s.groups.slice(0, vmAt).includes('acme-api'));
  // The vm's api-fix is the second api-fix in the list.
  await pickRow('api-fix', 1); await pickRow('master', 0);
  await press('Enter');
  s = await settle(x => x.cols.length === 2 && x.cols.every(c => c.turns), 8000);
  is('...a column on the other machine draws its conversation', 2, s.cols.filter(c => c.turns > 0).length);
  is('...says which machine it is on', true, await b.evaluate(() => /acme-api on vm/.test(document.querySelectorAll('#app .scol .scol-bar .scope')[0].textContent)));
  is('...and has no terminal control, as no remote session does', 0, await b.evaluate(() =>
    [...document.querySelectorAll('#app .stack button')].filter(x => /terminal/i.test(x.textContent)).length));
  await click('#app .scol textarea', 0); await type('to the vm'); await press('Enter');
  await sleep(500);
  is('...and its composer sends to the other machine\'s session', true,
     (await audit()).some(r => r.tool === 'fleet_send' && r.project === 'acme-api@vm' && r.session === 'api-fix' && r.prompt === 'to the vm'));

  });
  await part('the phone', async () => {
  // ════════════════════════════════════════════════════════════════════════════════════
  // THE PHONE: one conversation at a time, a swipe apart
  // ════════════════════════════════════════════════════════════════════════════════════
  await fresh(390, 844, true);
  await D.tap('#app .hdr .more');
  is('phone: Projects\' ⋯ offers the stack', true, await b.evaluate(() => [...document.querySelectorAll('#sheet button')].some(x => x.textContent.trim() === 'stack')));
  await D.tap('#sheet button', 0, 'stack');
  s = await settle(x => x.picker && x.rows.length > 3);
  is('...which opens the picker, one column wide', [true, false], [s.picker, s.duo]);
  is('...with a field to find a session (a phone has no `/`)', true, await b.evaluate(() => !!document.querySelector('#app .pick-list') &&
     /session/.test((document.querySelector('#app .find input') || {}).placeholder || '')));
  await slid();
  for (const n of ['master', 'api-fix', 'docs-pass']) await D.tap('#app .pick-list .pickrow .c-name', 0, n);
  s = await settle(x => x.stacked.length === 3);
  is('phone: a tap toggles', ['master', 'api-fix', 'docs-pass'], s.stacked);
  await b.evaluate(() => { const i = document.querySelector('#app .find input'); i.value = 'docs'; i.dispatchEvent(new Event('input', { bubbles: true })); return null; });
  is('phone: the field narrows the list', ['docs-pass'], (await settle(x => x.rows.length === 1)).rows);
  await b.evaluate(() => { const i = document.querySelector('#app .find input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return null; });
  await D.tap('#app .sbar button.go');
  s = await settle(x => x.cols.length === 1 && x.cols[0].turns > 0, 8000);
  await slid();
  is('phone: the stack opens one conversation at a time', 1, s.cols.length);
  is('...its agent named in the bar, with where it is in the stack', ['master', '1/3'], [s.name, s.pos]);
  is('...and nothing focused, so no keyboard rises over it', [1, false], [s.cols.length, s.typing]);
  await D.drag(-200);
  s = await settle(x => x.pos === '2/3');
  is('phone: swipe ← goes to the next', ['api-fix', '2/3'], [s.name, s.pos]);
  s = await settle(x => x.cols[0]?.text?.includes(firstLine('session-acme-api-api-fix.json')));
  is('...whose own conversation is drawn', true, !!s.cols[0]?.text?.includes(firstLine('session-acme-api-api-fix.json')));
  await D.drag(-200); await settle(x => x.pos === '3/3');
  await D.drag(-200); await sleep(500);
  is('phone: swipe ← at the last stays there', ['docs-pass', '3/3'], [(await look()).name, (await look()).pos]);
  await D.drag(200);
  is('phone: swipe → goes back', ['api-fix', '2/3'], [(await settle(x => x.pos === '2/3')).name, (await look()).pos]);
  await D.drag(-200, 'mouse'); await sleep(500);
  is('phone: a mouse drag is not a swipe (a gesture is a finger\'s)', '2/3', (await look()).pos);
  await D.tap('#app .stack-bar .stack-pos button', 0);
  is('phone: ◂ steps back too', '1/3', (await settle(x => x.pos === '1/3')).pos);
  await D.tap('#app .stack-bar .stack-pos button', 1);
  is('phone: ▸ steps forward', '2/3', (await settle(x => x.pos === '2/3')).pos);
  // A phone's composer sends to the conversation on screen.
  await D.tap('#app .scol textarea');
  await b.evaluate(() => { const t = document.querySelector('#app .scol textarea'); t.value = 'from the phone'; t.dispatchEvent(new Event('input', { bubbles: true })); return null; });
  await D.tap('#app .scol .composer button.go');
  await sleep(500);
  is('phone: send goes to the conversation on screen', true,
     (await audit()).some(r => r.tool === 'fleet_send' && r.session === 'api-fix' && r.prompt === 'from the phone'));

  });
  // ════════════════════════════════════════════════════════════════════════════════════
  // THE TABLE: every key in web/README.md's stack table has a row above
  // ════════════════════════════════════════════════════════════════════════════════════
  const readme = (() => { try { return fs.readFileSync(path.join(WEB, 'README.md'), 'utf8'); } catch { return ''; } })();
  const at = readme.indexOf('<!-- stack-keys -->'), end = readme.indexOf('<!-- /stack-keys -->');
  is('web/README.md carries the stack key table', true, at >= 0 && end > at);
  const tableKeys = [];
  for (const line of readme.slice(at, end).split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m || /^-+$/.test(m[1]) || m[1] === 'key') continue;
    for (const k of m[1].split(' · ')) tableKeys.push(/^``\s*`\s*``$/.test(k.trim()) ? '`' : k.trim().replace(/^`|`$/g, ''));
  }
  is('...with the stack\'s keys in it', true, tableKeys.length >= 15);
  is('every key in the stack table is pressed by a row', [], tableKeys.filter(k => !PRESSED.has(k)));
} catch (e) {
  is('stack-check ran', 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
  b = null;
}

// ════════════════════════════════════════════════════════════════════════════════════
// THE READ RATE, against a fake fleet-serve that counts
// ════════════════════════════════════════════════════════════════════════════════════
// Four columns open, every session working (the live cadence), every read counted by the
// daemon the way its bucket counts them: per device, per minute, every GET under /api/.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const FOUR = [['acme-api', 'master'], ['acme-api', 'api-fix'], ['acme-api', 'docs-pass'], ['toolbox', 'search-index']];
async function fakeDaemon() {
  const convo = {};
  for (const [p, s] of FOUR) {
    let ms; try { ms = fx(`session-${p}-${s}.json`).messages.slice(); } catch { ms = [{ ts: 1700000000, role: 'assistant', text: `${s} has started on the index.` }]; }
    convo[`${p}/${s}`] = ms;
  }
  const st = { convo, log: [], inflight: 0, maxInflight: 0 };
  const grid = (p) => {
    const g = p === 'toolbox' ? fx('grid-free.json') : fx('grid-acme-api.json');
    return { ...g, cards: g.cards.map(c => ({ ...c, status: 'working' })) };
  };
  const json = (res, code, j, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(j)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (!p.startsWith('/api/')) {
      const f = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
      if (!path.resolve(f).startsWith(WEB)) { res.writeHead(403); return res.end(); }
      return fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(buf); });
    }
    if (req.method === 'GET') st.log.push({ at: Date.now(), path: p, project: u.searchParams.get('project') || '', session: u.searchParams.get('session') || '' });
    if (p === '/api/health') return json(res, 200, { ok: true, version: 'stack-check' });
    if (p === '/api/projects') return json(res, 200, { ...fx('projects.json'), jarvis_enabled: false });
    if (p === '/api/grid') return json(res, 200, grid(u.searchParams.get('project')));
    if (p === '/api/session') {
      const key = `${u.searchParams.get('project')}/${u.searchParams.get('session')}`;
      const ms = st.convo[key] || [];
      const body = { session: u.searchParams.get('session'), total: ms.length, messages: ms.slice(-20), next_before: ms.length > 20 ? String(ms[ms.length - 20].ts) : null, queue: [] };
      const tag = '"' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"';
      st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
      return setTimeout(() => {
        st.inflight--;
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag }); return res.end(); }
        json(res, 200, body, { ETag: tag });
      }, 250);
    }
    return json(res, 404, { ok: false, text: 'not in the fake' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { st, base: `http://127.0.0.1:${server.address().port}`, close: () => { try { server.closeAllConnections?.(); server.close(); } catch {} } };
}
let d = null;
try {
  d = await fakeDaemon();
  b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
    args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  // The installed app reopened on the stack it was showing: a token this page process minted
  // and the last screen (chat-lands-check's INIT, with a stack).
  const members = FOUR.map(([project, session]) => ({ project, session }));
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try {
    sessionStorage.setItem('gf.session:' + location.origin, JSON.stringify({ t: 'stack-check-token', exp: Date.now() / 1000 + 3600 }));
    localStorage.setItem('gf.last', JSON.stringify({ at: Math.floor(Date.now() / 1000), screen: 'stack', view: 'chat' }));
    localStorage.setItem('gf.stack', JSON.stringify({ members: ${JSON.stringify(members)}, at: 0 }));
  } catch {} })();` });
  await b.call('Page.navigate', { url: d.base + '/' });
  const opened = await until(() => b.evaluate(() => {
    const cs = [...document.querySelectorAll('#app .stack > .scol')];
    return cs.length === 4 && cs.every(c => c.querySelectorAll('.chat .turn').length > 0);
  }), 15000);
  is('read rate: four columns open, each with its conversation', true, !!opened);
  await sleep(3000);                         // past the first reads of every column
  const WINDOW_S = 30;
  const t0 = Date.now();
  // Halfway through, a reply lands in a column that is NOT focused: the shared poll must
  // still bring it, or the rate was bought by not reading.
  const REPLY = 'The docs pass found two more drifted schemas.';
  await sleep(WINDOW_S * 500);
  d.st.convo['acme-api/docs-pass'].push({ ts: Math.floor(Date.now() / 1000) + 1000, role: 'assistant', text: REPLY });
  const tR = Date.now();
  const landed = await until(() => b.evaluate((r) => (document.querySelectorAll('#app .stack > .scol')[2] || {}).textContent?.includes(r), REPLY), 12000);
  is('read rate: a reply in a column that is not focused still appears (within 12 s)', true, !!landed);
  const took = Math.round((Date.now() - tR) / 100) / 10;
  await sleep(Math.max(0, WINDOW_S * 1000 - (Date.now() - t0)));
  const reads = d.st.log.filter(r => r.at >= t0 && r.at < t0 + WINDOW_S * 1000);
  const perMin = Math.round(reads.length * 60 / WINDOW_S);
  const bySession = {};
  for (const r of reads.filter(r => r.path === '/api/session')) bySession[r.session] = (bySession[r.session] || 0) + 1;
  is('read rate: the daemon\'s per-device limit was found in fleet-serve', true, !!LIMIT);
  is(`read rate: four live chats read under the daemon's limit (${perMin}/min against ${LIMIT && LIMIT.read}/min; ` +
     `session ${Object.entries(bySession).map(([k, v]) => `${k} ${v}`).join(', ')}, grid ${reads.filter(r => r.path === '/api/grid').length} in ${WINDOW_S}s; reply took ${took}s)`,
     true, !!LIMIT && Object.keys(bySession).length === 4 && perMin < LIMIT.read && perMin <= 130);
  is('read rate: every column is still being read', 4, Object.keys(bySession).length);
  is('read rate: the columns that are not focused are read one at a time (at most two transcript reads in flight)', true,
     Object.keys(bySession).length === 4 && d.st.maxInflight <= 2);
} catch (e) {
  if (/no chrome/i.test(String(e && e.message))) skipGroup('the stack\'s read rate', 'no chrome');
  else is('stack-check read rate ran', 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (d) d.close();
}
done(0);
