#!/usr/bin/env node
// desktop-check — the phone client on a desk: two panes on a wide window, the Mac grid's
// keys, Enter to send, and an image pasted or dropped into the conversation.
//
//     node test/helpers/desktop-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointing it at an older client (a `git
// archive` of staging, say) is how every row below was watched going red before it was
// trusted. Rows that staging already passed — keys it already had right — were watched red
// by breaking this client on purpose instead (the mutations are listed in the PR).
//
// KEYS ARE PRESSED, NOT DISPATCHED. Input.dispatchKeyEvent goes through the browser's own
// keyboard path — the focused element receives it, a printable key types into a focused
// textarea, Enter in one fires its keydown before any newline — which is the difference
// between "the handler does X when called" and "pressing the key does X". A synthetic
// KeyboardEvent on window would skip exactly the part the composer rules are about.
// Focus emulation is on because a headless window is not activated on every platform, and
// without it Element.focus() silently does nothing (see viewport-check.mjs).
//
// EVERY KEY IN web/README.md's TABLE IS PRESSED BY A ROW HERE. The table is parsed and each
// desk key in it must appear in PRESSED below (or be one the table itself marks as the
// browser's or absent): a key added to the table without a row is a red row, not a gap.
import fs from 'node:fs';
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

// The desk keys this file presses, as the README's table spells them. Filled in by press().
const PRESSED = new Set();

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the desktop client', 'no chrome to press keys in'); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const base = srv.base;
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  async function until(cond, ms = 8000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }

  // ── the page, read back ─────────────────────────────────────────────────────────────
  const look = () => b.evaluate(() => {
    const t = (q) => ((document.querySelector(q) || {}).textContent || '').trim();
    const sel = document.querySelector('#side .card.sel .c-name, #app .card.sel .c-name');
    const a = document.activeElement;
    return {
      duo: document.documentElement.classList.contains('duo'),
      // which list is on screen (left pane, or the whole screen on a phone)
      list: t('#side .hdr .scope') || t('#app > .hdr .scope'),
      side: t('#side .hdr .scope'),   // the LEFT pane's list only — '' when there is none
      main: t('#app > .hdr .scope'),  // a list drawn in the one column — '' when there is none
      // which session is open on the right ('' when none)
      session: t('#app .sbar .nm'),
      empty: !!document.querySelector('#app .duo-empty'),
      sel: sel ? sel.textContent.trim() : '',
      confirm: t('#side .confirm .q') || t('#app .confirm .q'),
      keys: t('#side .confirm .keys') || t('#app .confirm .keys'),
      sheet: t('#sheet h2'),
      draft: (document.querySelector('#app .composer textarea') || {}).value ?? null,
      typing: !!a && a.tagName === 'TEXTAREA',
      tiles: document.querySelectorAll('#app .composer .photos .ph').length,
      tileTitle: ((document.querySelector('#app .composer .photos .ph') || {}).title) || '',
      misses: document.querySelectorAll('#side .card.miss, #app .card.miss').length,
      toast: t('#app .toast') || t('#side .toast'),
    };
  });
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().map(r => r.tool));
  const auditHas = async (tool) => (await audit()).includes(tool);

  // ── a key, through the browser's keyboard ───────────────────────────────────────────
  const VK = { Enter: 13, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
               '`': 192, '/': 191, ',': 188 };
  async function press(key, { ctrl = false, shift = false, as = null } = {}) {
    PRESSED.add(as || ((ctrl ? 'Ctrl-' : '') + (shift ? '⇧' : '') + key));
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = ctrl ? '' : key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
                modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) };
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(150);
  }
  const keys = async (...ks) => { for (const k of ks) await press(k); };

  // A clean app at a size, past the lock screen, on Projects.
  async function fresh(w = 1600, h = 900, mobile = false) {
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: mobile, ...(mobile ? { maxTouchPoints: 5 } : {}) });
    await b.call('Emulation.setEmitTouchEventsForMouse', { enabled: mobile });
    await goto(base + '/index.html');
    await b.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    await goto(base + '/index.html');
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')));
    await sleep(300);
  }
  // Settled reads: a screen change is a render (and sometimes a history pop) away.
  const settle = async (pred) => { await until(async () => pred(await look()), 4000); return look(); };
  const onGrid = (s) => /acme-api/.test(s.list) && !s.session;
  const atProjects = (s) => /projects/.test(s.list) && !s.session;
  // SETUP BY TAP, NOT BY KEY. Both clients — this one and the one before it — open a card on
  // a tap, so a row reached this way is red only for the key it is about. Reached by a key
  // that is itself new, every row after it would be red because the setup was.
  const tap = (name) => b.evaluate((nm) => {
    const c = [...document.querySelectorAll('.card[data-idx]')].find(n => (n.querySelector('.c-name') || {}).textContent?.trim() === nm)
      || (nm === '' ? document.querySelector('.card') : null);
    if (!c) return false;
    for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1 }));
    return true;
  }, name);
  const toGrid = async () => { await fresh(); await tap('acme-api'); await settle(onGrid); };

  // ════════════════════════════════════════════════════════════════════════════════════
  // LAYOUT
  // ════════════════════════════════════════════════════════════════════════════════════
  await fresh();
  let s = await look();
  is('desktop 1600x900: two panes', true, s.duo);
  is('...Projects in the left pane', true, /projects/.test(s.side));
  is('...and nothing open on the right yet', true, s.empty);
  // The two panes really are side by side, not stacked: the list's right edge is at or left
  // of the conversation's left edge, and the conversation reaches the window's right edge.
  is('...side by side, the conversation filling the rest of the width', true, await b.evaluate(() => {
    const side = document.getElementById('side');
    if (!side) return false;
    const l = side.getBoundingClientRect(), r = document.getElementById('app').getBoundingClientRect();
    return l.width > 200 && l.right <= r.left + 1 && Math.abs(r.right - innerWidth) <= 1 && r.width > innerWidth / 2;
  }));
  // The breakpoint, both sides of it.
  await b.call('Emulation.setDeviceMetricsOverride', { width: 1023, height: 800, deviceScaleFactor: 1, mobile: false });
  is('1023px wide: one column, as on a phone', false, (await settle(x => !x.duo)).duo);
  await b.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
  is('1024px wide: two panes', true, (await settle(x => x.duo)).duo);

  // A wide TOUCH screen — a tablet held sideways — keeps the layout it had.
  await fresh(1180, 820, true);
  is('a 1180px touch screen: one column, as before', false, (await look()).duo);

  await fresh(390, 844, true);
  s = await look();
  is('phone 390x844: one column', false, s.duo);
  is('...the left pane is not drawn at all', 'none', await b.evaluate(() => { const n = document.getElementById('side'); return n ? getComputedStyle(n).display : 'none'; }));
  is('...and Projects fills the screen as before', true, /projects/.test(s.main));

  // ════════════════════════════════════════════════════════════════════════════════════
  // PROJECTS (fleet-grid.mjs onKeyProjects)
  // ════════════════════════════════════════════════════════════════════════════════════
  // THE ORDER IS READ ONCE, FROM THE CARDS, before any key — never from where a key left the
  // cursor. A "back" row that compared against what the forward key produced would pass on
  // a client with no key handler at all: neither moved, so the two agree.
  const order = (scope) => b.evaluate((q) => [...document.querySelectorAll(q + ' .card[data-idx] .c-name')].map(n => n.textContent.trim()), scope);
  const walk = async (where) => {
    const [first, second] = await order('');
    for (const [k, as, want] of [['j', 'j', second], ['k', 'k', first], ['ArrowDown', '↓', second], ['ArrowUp', '↑', first],
                                 ['l', 'l', second], ['h', 'h', first], ['ArrowRight', '→', second], ['ArrowLeft', '←', first]]) {
      const was = (await look()).sel;
      await press(k, { as });
      // A step is a [from, to] pair: both ends are what the order says they should be.
      is(`${where} ${as}: ${want === second ? 'on' : 'back'} one card`, [want === second ? first : second, want], [was, (await look()).sel]);
    }
  };
  await fresh();
  await walk('Projects');

  for (const K of ['H', 'J', 'K', 'L']) {
    await fresh();
    await press('j');
    await press(K, { shift: true, as: K });
    is(`Projects ${K}: reorders the project (fleet_project_order)`, true, await until(() => auditHas('fleet_project_order'), 3000));
  }

  await fresh();
  await press('Enter', { as: '⏎' });
  s = await settle(x => x.session);
  is("Projects ⏎: opens the project's MASTER, as at the desk", 'master', s.session);
  is('...with its grid beside it', true, /acme-api/.test(s.side));

  await fresh();
  await press('3', { as: '1-9' });
  s = await settle(x => x.session);
  is('Projects 3: opens project 3, on its master', 'master', s.session);
  is('...project 3 being toolbox, its grid beside it', true, /toolbox/.test(s.side));

  await fresh();
  await press('s', { ctrl: true });
  s = await settle(x => /acme-api/.test(x.list));
  is("Projects Ctrl-s: straight to that project's grid", true, onGrid(s));
  is('...with nothing open beside it', true, s.empty);

  await fresh();
  await press('s');
  const sheetUp = (await settle(x => x.sheet)).sheet;
  is("Projects s: schedule a message to that project's master", 'schedule a message — → master', sheetUp);
  await press('Escape', { as: 'Esc' });
  is('...and Esc closes the sheet', ['schedule a message — → master', ''], [sheetUp, (await settle(x => !x.sheet)).sheet]);

  await fresh();
  await press(',');
  is('Projects ,: settings', true, /^settings/.test((await settle(x => x.sheet)).sheet));

  await fresh();
  await press('x');
  const asked = (await settle(x => x.confirm)).confirm;
  is("Projects x: the desk's question", "remove 'acme-api' from projects?", asked);
  await press('n', { as: 'any other key' });
  is('...any other key cancels it', [asked, ''], ["remove 'acme-api' from projects?", (await settle(x => !x.confirm)).confirm]);
  await press('x');
  await press('y');
  is('...and y removes it (fleet_project_remove)', true, await until(() => auditHas('fleet_project_remove'), 3000));

  // ════════════════════════════════════════════════════════════════════════════════════
  // Ctrl-f, THE JUMP CHORD (tmux/cf.tmux.conf cfjump tables)
  // ════════════════════════════════════════════════════════════════════════════════════
  await fresh();
  await press('f', { ctrl: true });
  const JUMP1 = "jump → project? 1-9  ·  s + digit = that project's grid  ·  p = projects  ·  esc";
  const jumpUp = (await settle(x => x.confirm)).confirm;
  is("Ctrl-f: tmux's own prompt", JUMP1, jumpUp);
  await press('Escape', { as: 'Ctrl-f Esc' });
  is('Ctrl-f Esc: cancels', [JUMP1, ''], [jumpUp, (await settle(x => !x.confirm)).confirm]);
  await press('f', { ctrl: true }); await press('1', { as: 'Ctrl-f <p>' });
  is('Ctrl-f 1: asks for the session', 'jump → project 1: session? 1-9  ·  ⏎ or m = master  ·  s = grid  ·  esc', (await settle(x => /session\?/.test(x.confirm))).confirm);
  await press('m', { as: 'Ctrl-f <p> m' });
  s = await settle(x => x.session);
  is("Ctrl-f 1 m: project 1's master", 'master', s.session);
  await fresh();
  await press('f', { ctrl: true }); await press('1'); await press('Enter', { as: 'Ctrl-f <p> ⏎' });
  is("Ctrl-f 1 ⏎: project 1's master", 'master', (await settle(x => x.session)).session);
  await fresh();
  await press('f', { ctrl: true }); await press('1'); await press('2', { as: 'Ctrl-f <p> <s>' });
  s = await settle(x => x.session);
  is('Ctrl-f 1 2: project 1, card 2', 'api-fix', s.session);
  await fresh();
  await press('f', { ctrl: true }); await press('1'); await press('s', { as: 'Ctrl-f <p> s' });
  is("Ctrl-f 1 s: project 1's grid", true, onGrid(await settle(onGrid)));
  await fresh();
  await press('f', { ctrl: true }); await press('s', { as: 'Ctrl-f s <p>' });
  is('Ctrl-f s: asks which grid', 'jump → grid of project? 1-9  ·  esc', (await settle(x => /grid of/.test(x.confirm))).confirm);
  await press('1');
  is("Ctrl-f s 1: project 1's grid", true, onGrid(await settle(onGrid)));
  await toGrid();
  await press('f', { ctrl: true }); await press('p', { as: 'Ctrl-f p' });
  is('Ctrl-f p: Projects', true, atProjects(await settle(atProjects)));

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE GRID (fleet-grid.mjs onKey, mode 'grid')
  // ════════════════════════════════════════════════════════════════════════════════════
  await toGrid();
  await walk('grid');
  const [, g1] = await order('');

  for (const K of ['H', 'J', 'K', 'L']) {
    await toGrid(); await press('j'); await press('j');
    await press(K, { shift: true, as: K });
    is(`grid ${K}: reorders the card (fleet_order)`, true, await until(() => auditHas('fleet_order'), 3000));
  }

  await toGrid(); await press('j');
  await press('Enter', { as: '⏎' });
  s = await settle(x => x.session);
  is('grid ⏎: opens the selected card on the right', g1, s.session);
  is('...and the grid stays in the left pane', true, /acme-api/.test(s.side));

  await toGrid(); await press('2', { as: '1-9' });
  is('grid 2: opens card 2', 'api-fix', (await settle(x => x.session)).session);

  for (const [k, want] of [['n', 'new session'], ['N', 'new session'], ['w', 'new worktree'], ['s', 'schedule a message'], [',', 'settings']]) {
    await toGrid(); await press('j');
    if (k === 'N') await press('N', { shift: true, as: 'N' }); else await press(k);
    is(`grid ${k}: ${want}`, true, (await settle(x => x.sheet)).sheet.startsWith(want));
  }
  await toGrid(); await press('j'); await press('p');
  is('grid p: pauses the selected session (fleet_pause)', true, await until(() => auditHas('fleet_pause'), 3000));
  await toGrid(); await press('j'); await press('P', { shift: true, as: 'P' });
  is('grid P: resumes it (fleet_resume)', true, await until(() => auditHas('fleet_resume'), 3000));
  await toGrid(); await press('j'); await press('x');
  is("grid x: the desk's question", "kill session 'api-fix'?", (await settle(x => x.confirm)).confirm);
  await press('y');
  is('...and y kills it (fleet_stop)', true, await until(() => auditHas('fleet_stop'), 3000));

  await toGrid(); await press('Q', { shift: true, as: 'Q' });
  is('grid Q: Projects', true, atProjects(await settle(atProjects)));
  await toGrid(); await press('p', { ctrl: true });
  is('grid Ctrl-p: Projects', true, atProjects(await settle(atProjects)));
  for (const [k, o, as] of [['q', {}, 'q'], ['`', {}, '`'], ['c', { ctrl: true }, 'Ctrl-c']]) {
    await toGrid(); await press(k, { ...o, as });
    s = await settle(x => x.session);
    is(`grid ${as}: back up to the project's master, as at the desk`, 'master', s.session);
  }

  // ── `/` ────────────────────────────────────────────────────────────────────────────
  await toGrid();
  await press('/');
  is('grid /: opens the search prompt', '/▏', (await settle(x => x.confirm)).confirm);
  await keys('p', 'a');   // `p` is a LETTER here, not a pause
  s = await look();
  is('/ typing: every key types into the query', '/pa▏', s.confirm);
  is('...the cursor on the first match', 'docs-pass', s.sel);
  is('...the rest dimmed in place', true, s.misses > 0);
  await press('Enter', { as: '/ ⏎' });
  is('/ ⏎: locks the search', true, /n next · N prev/.test((await look()).keys));
  await press('n', { as: '/ n' });
  is('/ n: the next match', 'list-pages', (await look()).sel);
  await press('N', { shift: true, as: '/ N' });
  is('/ N: the previous match', 'docs-pass', (await look()).sel);
  await press('Backspace', { as: '/ ⌫' });
  is('/ ⌫: back to editing', '/p▏', (await look()).confirm);
  await press('Enter'); await press('/', { as: '/ /' });
  is('/ / (locked): back to editing', true, /▏$/.test((await look()).confirm));
  const srchUp = (await look()).confirm;
  await press('Escape', { as: '/ Esc' });
  is('/ Esc: clears it', ['/p▏', ''], [srchUp, (await settle(x => !x.confirm)).confirm]);
  await keys('/', 'l', 'i', 's', 't', 'Enter'); await press('q', { as: '/ q' });
  is('/ q (locked): clears the search before it would leave', true, onGrid(await settle(x => !x.confirm)));
  await keys('/', 'd', 'o', 'c', 's', 'Enter');
  await press('Enter', { as: '/ ⏎ ⏎' });
  is('/ ⏎ (locked): opens the match', 'docs-pass', (await settle(x => x.session)).session);

  // ════════════════════════════════════════════════════════════════════════════════════
  // A SESSION (tmux/cf.tmux.conf: the -n bindings, then Ctrl-a's table)
  // ════════════════════════════════════════════════════════════════════════════════════
  const toWorker = async () => { await toGrid(); await tap('api-fix'); await settle(x => x.session === 'api-fix'); };
  const toMaster = async () => { await toGrid(); await tap('master'); await settle(x => x.session === 'master'); };

  await toWorker(); await press('`');
  s = await settle(x => !x.session);
  is('session `: a worker goes back to the grid', true, onGrid(s));
  await toMaster(); await press('`');
  is('session `: a master goes back to Projects', true, atProjects(await settle(atProjects)));

  await toMaster(); await press('ArrowRight', { shift: true, as: '⇧→' });
  is('session ⇧→: the next session in the ring', 'api-fix', (await settle(x => x.session !== 'master')).session);
  await toWorker(); await press('ArrowLeft', { shift: true, as: '⇧←' });
  is('session ⇧←: the previous one', 'master', (await settle(x => x.session === 'master')).session);
  await toMaster(); await press('ArrowLeft', { shift: true });
  s = await settle(x => x.session !== 'master');
  is('...wrapping past master to the end of the ring', true, !!s.session && !['master', 'api-fix'].includes(s.session));

  await toWorker(); await press('s', { ctrl: true });
  is('session Ctrl-s: the grid', true, onGrid(await settle(x => !x.session)));
  await toWorker(); await press('p', { ctrl: true });
  is('session Ctrl-p: Projects', true, atProjects(await settle(atProjects)));
  await toWorker(); await press('f', { ctrl: true });
  is('session Ctrl-f: the jump chord', true, /^jump → project\?/.test((await settle(x => x.confirm)).confirm));

  for (const [k, o, as, want] of [
    ['g', {}, 'Ctrl-a g', onGrid], ['d', {}, 'Ctrl-a d', onGrid],
    ['s', {}, 'Ctrl-a s', onGrid], ['p', {}, 'Ctrl-a p', atProjects],
  ]) {
    await toWorker(); await press('a', { ctrl: true, as: 'Ctrl-a' }); await press(k, { ...o, as });
    is(`session ${as}`, true, want(await settle(want)));
  }
  await toWorker(); await press('a', { ctrl: true }); await press('f', { as: 'Ctrl-a f' });
  is('session Ctrl-a f: the jump chord', true, /^jump → project\?/.test((await settle(x => x.confirm)).confirm));
  await toMaster(); await press('a', { ctrl: true }); await press('ArrowRight', { as: 'Ctrl-a →' });
  is('session Ctrl-a →: the next session', 'api-fix', (await settle(x => x.session !== 'master')).session);
  await toWorker(); await press('a', { ctrl: true }); await press('ArrowLeft', { as: 'Ctrl-a ←' });
  is('session Ctrl-a ←: the previous one', 'master', (await settle(x => x.session === 'master')).session);

  // Everything else goes to the agent — here, the composer.
  await toWorker(); await press('p');
  s = await look();
  is('session p: typed into the composer, as it would reach the agent', 'p', s.draft);
  is('...and the composer has the focus for the rest of the sentence', true, s.typing);
  is('...and nothing was paused', false, await auditHas('fleet_pause'));

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE COMPOSER
  // ════════════════════════════════════════════════════════════════════════════════════
  await toWorker();
  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  await keys('q', '`', 'x', 'j');
  s = await look();
  is('composer: no key fires while typing', 'q`xj', s.draft);
  is('...and the screen did not move', 'api-fix', s.session);
  await press('Enter', { shift: true, as: '⇧⏎' });
  is('composer ⇧⏎: a new line', 'q`xj\n', (await look()).draft);
  is('...and nothing was sent', false, await auditHas('fleet_send'));
  await keys('o', 'k');
  await press('Enter', { as: 'composer ⏎' });
  is('composer ⏎ on a desktop: sends (fleet_send)', true, await until(() => auditHas('fleet_send'), 3000));
  is('...and empties the box', '', (await settle(x => x.draft === '')).draft);
  await keys('h', 'i');
  await press('Escape', { as: 'composer Esc' });
  s = await look();
  is('composer Esc: leaves the box', false, s.typing);
  is('...keeping what was typed', 'hi', s.draft);
  await press('`');
  is('...so the keys work again', true, onGrid(await settle(x => !x.session)));

  // The phone: ⏎ is the new line it has always been.
  await fresh(390, 844, true);
  await tap('acme-api');
  await until(() => b.evaluate(() => /:/.test((document.querySelector('#app > .hdr .scope') || {}).textContent || '')));
  await tap('api-fix');
  await until(() => b.evaluate(() => !!document.querySelector('#app .composer textarea')));
  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  await keys('o', 'k', 'Enter');
  is('phone: ⏎ in the composer is still a new line', 'ok\n', (await look()).draft);
  is('...and sends nothing', false, await auditHas('fleet_send'));

  // ════════════════════════════════════════════════════════════════════════════════════
  // IMAGES: paste and drop, through the picker's own path
  // ════════════════════════════════════════════════════════════════════════════════════
  // A 1x1 PNG. In fixture mode api.attach refuses every file with its own sentence, which
  // is exactly what makes the path visible: a tile that says it is the one the picker's
  // file gets came through addPhotos → uploadPhoto → api.attach, and nothing else says it.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withFile = (how, type = 'image/png', name = 'shot.png') => b.evaluate((how, png, type, name) => {
    const bin = atob(png); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const f = new File([u8], name, { type });
    const dt = new DataTransfer(); dt.items.add(f);
    if (how === 'paste') {
      const box = document.querySelector('#app .composer textarea'); if (!box) return null; box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } else if (how === 'drop') {
      const tgt = document.querySelector('#app .chat') || document.getElementById('app');
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      tgt.dispatchEvent(over);
      window.__over = over.defaultPrevented && document.getElementById('app').classList.contains('drop-on');
      tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      document.querySelector('#app .composer .cam')?.click();
      const pick = document.querySelector('input.pick');
      if (!pick) return null;
      pick.files = dt.files; pick.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return null;
  }, how, PNG, type, name);

  await toWorker();
  await withFile('picker');
  const viaPicker = (await settle(x => x.tiles && /failed|ready/.test(x.tileTitle))).tileTitle;
  is('the picker: a tile, refused by api.attach in fixture mode', true, /attachments need a real fleet/.test(viaPicker));

  await toWorker();
  await withFile('paste');
  s = await settle(x => x.tiles && /failed|ready/.test(x.tileTitle));
  is('Ctrl/Cmd-V of an image: attached, shown before sending', 1, s.tiles);
  is('...through the picker\'s path (the same tile, the same answer)', viaPicker, s.tileTitle);
  await b.evaluate(() => { document.querySelector('#app .composer .ph-x')?.click(); return null; });
  is('...and × removes it', 0, (await settle(x => !x.tiles)).tiles);

  await toWorker();
  await withFile('drop');
  s = await settle(x => x.tiles && /failed|ready/.test(x.tileTitle));
  is('an image dropped on the conversation: attached', 1, s.tiles);
  is('...the conversation said it would take it', true, await b.evaluate(() => !!window.__over));
  is('...through the picker\'s path', viaPicker, s.tileTitle);

  await toWorker();
  await withFile('drop', 'text/plain', 'notes.txt');
  s = await settle(x => x.toast);
  is('a dropped non-image attaches nothing', 0, s.tiles);
  is('...and says why', true, /only images/.test(s.toast));

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE TABLE: every desk key in web/README.md has a row above
  // ════════════════════════════════════════════════════════════════════════════════════
  // The README beside the client under test: an older client's README has no table, and
  // that is one of the things it is red for.
  const readme = (() => { try { return fs.readFileSync(path.join(WEB, 'README.md'), 'utf8'); } catch { return ''; } })();
  const at = readme.indexOf('<!-- desk-keys -->'), end = readme.indexOf('<!-- /desk-keys -->');
  is('web/README.md carries the desk key table', true, at >= 0 && end > at);
  const tableKeys = [];
  for (const line of readme.slice(at, end).split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m || /^-+$/.test(m[1]) || m[1] === 'desk key') continue;
    // A row the table itself marks as the browser's, or as a desk feature this client does
    // not have, has nothing to press.
    if (/browser keeps|not in this client|no meaning in a browser/.test(line)) continue;
    // `` ` `` is how markdown spells a code span holding a backtick: that cell IS the key `.
    for (const k of m[1].split(' · ')) tableKeys.push(/^``\s*`\s*``$/.test(k.trim()) ? '`' : k.trim().replace(/^`|`$/g, ''));
  }
  const missing = tableKeys.filter(k => !PRESSED.has(k));
  is('...with at least the keys this file presses', true, tableKeys.length >= 40);
  is('every key in the table is pressed by a row', [], missing);
} catch (e) {
  is('desktop-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
}
done(0);
