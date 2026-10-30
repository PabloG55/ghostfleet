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
    // A DESK HAS A MOUSE, AND A CI RUNNER HAS NO POINTING DEVICE AT ALL. Linux headless
    // Chrome on a runner reports (pointer: none) and no hover, so the two panes — which ask
    // for a fine pointer that hovers — never appeared there and twenty rows went red on a
    // client that was right. Declared here instead of detected: the desk this file tests is
    // one with a mouse. Touch emulation, where a row turns it on, still overrides it.
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
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
      caret: a && a.tagName === 'TEXTAREA' ? [a.selectionStart, a.value.length] : null,
      bubbles: document.querySelectorAll('#app .chat .turn').length,
      tiles: document.querySelectorAll('#app .composer .photos .ph').length,
      tileTitle: ((document.querySelector('#app .composer .photos .ph') || {}).title) || '',
      misses: document.querySelectorAll('#side .card.miss, #app .card.miss').length,
      toast: t('#app .toast') || t('#side .toast'),
      lost: t('#app .hint.lost'),
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
  // FOR THE CARD, NOT ONLY FOR THE SCREEN: a grid's header names the project before its
  // cards arrive (they are placeholders until the read lands), and a tap on a placeholder is
  // a tap on nothing — a red row on a slower runner over a client that was right.
  const tap = async (name) => { await until(() => b.evaluate((nm) => [...document.querySelectorAll('.card[data-idx] .c-name')].some(n => n.textContent.trim() === nm) || nm === '', name), 6000); return tapNow(name); };
  const tapNow = (name) => b.evaluate((nm) => {
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

  // ── `/` on Projects: the grid's search, one screen up (fleet-grid.mjs pSearchKey) ─────
  // The fixture's projects in order: acme-api, acme-web, toolbox, billing-svc, scratch (the
  // last on the `personal` tab). A desk has the keys and the prompt row; the phone's field
  // (below) is not drawn here.
  await fresh();
  is('Projects at a desk: no search field, the keys instead', 0, await b.evaluate(() => document.querySelectorAll('.find').length));
  await press('l');                                   // the cursor starts OFF the match
  await press('/', { as: '/' });
  s = await settle(x => x.confirm);
  is('Projects /: opens the search prompt', ['/▏', "type part of a project's name · esc cancel"], [s.confirm, s.keys]);
  await keys('x', 's', '3');                          // the screen's verbs and a digit: all query
  s = await look();
  is('Projects / typing: x, s and digits type, not act', ['/xs3▏', "no project matches 'xs3'", ''], [s.confirm, s.keys, s.session]);
  await keys('Backspace', 'Backspace', 'Backspace', 'A', 'C', 'M', 'E');
  s = await look();
  is('Projects /: case-insensitive, the cursor on the first match', ['/ACME▏', 'acme-api'], [s.confirm, s.sel]);
  is('...the rest dimmed in place', 4, s.misses);     // toolbox, billing-svc, scratch, + new
  await press('Enter');
  is('Projects / ⏎: locks the search', true, /^1 of 2 · n next · N prev/.test((await look()).keys));
  await press('n');
  is('Projects / n: the next match', 'acme-web', (await look()).sel);
  await press('n');
  is('Projects / n: wraps to the first', 'acme-api', (await look()).sel);
  await press('N', { shift: true });
  is('Projects / N: wraps to the last', 'acme-web', (await look()).sel);
  await press('x');
  is('Projects / x (locked): inert', '/ACME', (await look()).confirm);
  await press('Escape');
  s = await settle(x => !x.confirm);
  is('Projects / Esc: clears it, the cursor left on the match', ['', 0, 'acme-web'], [s.confirm, s.misses, s.sel]);
  await keys('/', 'b', 'i', 'l', 'l', 'Enter', 'Enter');
  s = await settle(x => x.session);
  is('Projects / ⏎ ⏎: opens the match on its master', ['master', true], [s.session, /billing-svc/.test(s.side)]);
  // The profile tab still applies: on `work`, scratch (a personal project) is not there to find
  await fresh();
  await b.evaluate(() => { const t = [...document.querySelectorAll('.seg.tabs button')].find(x => x.textContent.trim() === 'work'); if (t) t.click(); return null; });
  await keys('/', 's', 'c', 'r');
  is('Projects /: a project the profile tab hides is not found', "no project matches 'scr'", (await look()).keys);

  // ── the phone's search field ────────────────────────────────────────────────────────
  // Always drawn on a touch screen, never focused for it (focus is the on-screen keyboard),
  // and nothing on screen moves as it is typed into: the list's top is measured before and
  // after, and the cards are dimmed in place rather than filtered out.
  await fresh(390, 844, true);
  const field = () => b.evaluate(() => {
    const f = document.querySelector('#app .find input'), l = document.querySelector('#app > .cards');
    return f ? { value: f.value, focused: document.activeElement === f, count: ((document.querySelector('#app .find .count') || {}).textContent || '').trim(),
                 top: Math.round(l ? l.getBoundingClientRect().top : -1), h: Math.round(f.getBoundingClientRect().height) } : null;
  });
  let f0 = await field();
  is('phone Projects: a search field is drawn', true, !!f0);
  // 'no field' rather than false when there is none, so a client without one is red here too
  is('...and it does not take the focus (no keyboard until it is tapped)', false, f0 ? f0.focused : 'no field');
  await sleep(5600);                                  // one 5s poll and its render
  is('...not after a poll either', false, (await field())?.focused ?? 'no field');
  // A REAL TAP, through the touch path, at the field's centre
  const fxy = await b.evaluate(() => { const r = document.querySelector('#app .find input')?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; });
  if (fxy) {
    for (const type of ['touchStart', 'touchEnd'])
      await b.call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: fxy[0], y: fxy[1] }] });
    await sleep(300);
  }
  is('phone: a tap on the field focuses it', true, !!(await field())?.focused);
  for (const ch of 'web') await b.call('Input.insertText', { text: ch });
  await sleep(300);
  let f1 = await field();
  s = await look();
  is('phone: typing highlights the match, the cursor on it', ['web', '1 match', 'acme-web'], [f1?.value, f1?.count, s.sel]);
  // acme-api, toolbox, billing-svc, scratch and `+ new project` dimmed; all five projects still drawn
  is('...the rest dimmed in place, none hidden', [5, 5], [s.misses, await b.evaluate(() => document.querySelectorAll('#app .card[data-idx] .c-name').length - 1)]);
  is('...and nothing moved: the list starts where it did', true,
     f0 && f1 && f0.top === f1.top && f0.h === f1.h ? true : [f0?.top, f1?.top, f0?.h, f1?.h]);
  is('...no prompt row pushed in above it', ['', true], [s.confirm, !!f1]);
  await sleep(5600);
  f1 = await field();
  is('phone: a poll keeps the field, its text and its focus', ['web', true], [f1?.value, f1?.focused]);
  for (const ch of 'zz') await b.call('Input.insertText', { text: ch });
  await sleep(300);
  f1 = await field();
  is('phone: no match says so, in the field', ['webzz', 'no project matches', f0?.top], [f1?.value, f1?.count, f1?.top]);
  await b.evaluate(() => { document.querySelector('#app .find .clear')?.click(); return null; });
  await sleep(300);
  f1 = await field();
  s = await look();
  is('phone: × clears it, nothing dimmed', ['', '', 0, f0?.top], [f1?.value, f1?.count, s.misses, f1?.top]);
  await b.evaluate(() => { const i = document.querySelector('#app .find input'); if (i) i.focus(); return null; });
  for (const ch of 'bill') await b.call('Input.insertText', { text: ch });
  await sleep(300);
  const lit = (await look()).sel;
  await tap('billing-svc');
  is('phone: the match is lit, and a tap on it opens that project', ['billing-svc', true],
     [lit, /billing-svc/.test((await settle(x => /billing-svc/.test(x.list) || x.session)).list)]);

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
  // Ctrl-a t is the desk's terminal tab. Here it opens the terminal screen in the right pane —
  // and in fixture mode, where there is no tmux to attach to, says so instead of pretending.
  // The terminal itself is test/helpers/term-check.mjs, against a real fleet-serve.
  await toWorker(); await press('a', { ctrl: true }); await press('t', { as: 'Ctrl-a t' });
  is('session Ctrl-a t: the terminal screen, in the right pane', true,
     await until(() => b.evaluate(() => !!document.querySelector('#app .term-screen') && !!document.querySelector('#side .cards')), 3000));
  is('...which with fixtures says there is no shell to open', true,
     await until(() => b.evaluate(() => /needs the fleet server/.test((document.querySelector('#app .term-screen .term-msg') || {}).textContent || '')), 3000));
  await press('`');
  is('...and ` goes back to the session it came from', 'api-fix', (await settle(x => x.session === 'api-fix')).session);

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
  // Letters a grid key would act on, typed as letters: q, x, j, a digit, a comma.
  await keys('q', 'x', 'j', '2', ',');
  s = await look();
  is('composer: no grid key fires while typing', 'qxj2,', s.draft);
  is('...and the screen did not move', 'api-fix', s.session);
  await press('Enter', { shift: true, as: '⇧⏎' });
  is('composer ⇧⏎: a new line', 'qxj2,\n', (await look()).draft);
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
  // GESTURES ARE A FINGER'S: a mouse gets the click and the keys, touch keeps them all
  // ════════════════════════════════════════════════════════════════════════════════════
  // THE MOUSE IS REAL: Input.dispatchMouseEvent goes through the browser's own input path
  // and arrives as pointerType 'mouse', so the mouse rows prove the gate in app.js and not a
  // type this file claimed.
  //   THE SWIPES AND THE TITLE DRAG BY FINGER ARE TYPED POINTER EVENTS, and that is a
  // measured limit rather than a shortcut. Under Chrome's touch emulation a real touch that
  // moves sideways over a card is taken by the browser as a pan — pointerdown, then
  // pointercancel, no pointerup — and a real touch on the title lands on the name inside
  // it, which wire() does not treat as the grip. Both measured identically on staging's
  // client, so neither is this change; both are on the PR's list to check on a real iPhone.
  // Tap and long-press do not move, so those go in as REAL touches.
  const spot = (name, part = 'body') => b.evaluate((nm, pt) => {
    const c = [...document.querySelectorAll('.card[data-idx]')].find(n => (n.querySelector('.c-name') || {}).textContent?.trim() === nm);
    if (!c) return null;
    const t = pt === 'grip' ? c.querySelector('.c-top') : (c.querySelector('.c-msg') || c.querySelector('.c-where') || c);
    const r = t.getBoundingClientRect();
    // The grip is the title ROW: pressed in the gap between the name and the time, so the
    // pointer's target is the row itself (.c-top.t) and not the name inside it.
    // A drag LEFT starts at the right of the card: a mouse's pointerup goes to whatever is
    // under it, so a swipe that ends off the card is a release the card never sees.
    const x = Math.round(pt === 'grip' ? r.left + r.width * 0.6 : pt === 'right' ? r.left + r.width * 0.8 : r.left + Math.min(40, r.width / 3)), y = Math.round(r.top + r.height / 2);
    if (pt === 'grip' && document.elementFromPoint(x, y) !== t) return null;
    return { x, y };
  }, name, part);
  const chatAt = () => b.evaluate(() => {
    const c = document.querySelector('#app .chat'); if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  // A path from p by (dx, dy) in steps, held `ms` before release; `probe` runs mid-gesture.
  async function mouseDrag(p, dx, dy, ms = 0, probe = null) {
    if (!p) return null;                   // nothing there to press: the row says so, the run goes on
    const m = (type, x, y, extra = {}) => b.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    await m('mouseMoved', p.x, p.y, { buttons: 0, button: 'none' });
    await m('mousePressed', p.x, p.y);
    for (let i = 1; i <= 6; i++) await m('mouseMoved', p.x + dx * i / 6, p.y + dy * i / 6);
    if (ms) await sleep(ms);
    const mid = probe ? await probe() : null;
    await m('mouseReleased', p.x + dx, p.y + dy);
    await sleep(300);
    return mid;
  }
  // A finger that MOVES, as typed pointer events on the element under it (the grip itself
  // for `part: 'grip'`, as test/helpers/grip-check.mjs does).
  async function fingerDrag(name, part, dx, dy, probe = null) {
    const fire = (type, ddx, ddy) => b.evaluate((nm, pt, type, ddx, ddy) => {
      const c = [...document.querySelectorAll('.card[data-idx]')].find(n => (n.querySelector('.c-name') || {}).textContent?.trim() === nm)
        || (nm === '#chat' ? document.querySelector('#app .chat') : null);
      if (!c) return false;
      const t = pt === 'grip' ? c.querySelector('.c-top') : (c.querySelector('.c-msg') || c);
      const r = t.getBoundingClientRect();
      const x = Math.round(r.left + Math.min(40, r.width / 3)), y = Math.round(r.top + r.height / 2);
      window.__fd = window.__fd || {}; if (type === 'pointerdown') window.__fd = { t };
      (window.__fd.t || t).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: x + ddx, clientY: y + ddy }));
      return true;
    }, name, part, type, ddx, ddy);
    await fire('pointerdown', 0, 0);
    for (let i = 1; i <= 6; i++) await fire('pointermove', dx * i / 6, dy * i / 6);
    const mid = probe ? await probe() : null;
    await fire('pointerup', dx, dy);
    await sleep(300);
    return mid;
  }
  async function touchDrag(p, dx, dy, ms = 0, probe = null) {
    if (!p) return null;
    const t = (type, x, y) => b.call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await t('touchStart', p.x, p.y);
    for (let i = 1; i <= 6; i++) await t('touchMove', p.x + dx * i / 6, p.y + dy * i / 6);
    if (ms) await sleep(ms);
    const mid = probe ? await probe() : null;
    await t('touchEnd');
    await sleep(300);
    return mid;
  }
  const lifted = () => b.evaluate(() => !!document.querySelector('.card.lift, .card.drop-above, .card.drop-below'));
  // THE PHONE SLIDES BETWEEN SCREENS (a view transition, ~260ms), and while it plays the
  // page under a finger is the transition's snapshot, not the cards: a touch then lands on
  // #app itself. So the touch rows wait for the slide to finish, as a thumb does.
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
  const phoneGrid = async () => { await fresh(390, 844, true); await tap('acme-api'); await settle(onGrid); await slid(); };

  // A desk, a mouse.
  // ABSENCE IS GIVEN A SECOND, the way grip-check gives its `false` rows one: a verb is a
  // round trip away, and a row asked before it could have landed proves nothing.
  await toGrid();
  await mouseDrag(await spot('api-fix', 'right'), -160, 0);
  await sleep(1000);
  is('mouse: a drag that would be a swipe ← pauses nothing', false, await auditHas('fleet_pause'));
  await mouseDrag(await spot('api-fix'), 160, 0);
  await sleep(1000);
  is('mouse: ...nor a swipe → resume anything', false, await auditHas('fleet_resume'));
  is('...and opens nothing either', '', (await look()).session);
  await mouseDrag(await spot('api-fix'), 0, 0, 900);
  is('mouse: held still for 900ms asks nothing (no long-press)', '', (await look()).confirm);
  const grip = await spot('docs-pass', 'grip');
  is('mouse: a drag by the title lifts nothing', false, grip ? await mouseDrag(grip, 0, 140, 0, lifted) : 'no bare grip to press');
  await sleep(1000);
  is('...and reorders nothing', false, await auditHas('fleet_order'));
  await mouseDrag(await spot('api-fix'), 0, 0);
  is('mouse: a plain click still opens the card', 'api-fix', (await settle(x => x.session)).session);
  await mouseDrag(await chatAt(), -200, 0);
  await sleep(600);
  is('mouse: a drag across the chat stays on the session (no swipe to the next)', 'api-fix', (await look()).session);

  // A phone, a finger: every one of those gestures, still there.
  await phoneGrid();
  await fingerDrag('api-fix', 'body', -160, 0);
  is('touch: swipe ← still pauses', true, await until(() => auditHas('fleet_pause'), 3000));
  await phoneGrid();
  await fingerDrag('api-fix', 'body', 160, 0);
  is('touch: swipe → still resumes', true, await until(() => auditHas('fleet_resume'), 3000));
  await phoneGrid();
  await touchDrag(await spot('api-fix'), 0, 0, 900);
  is('touch: a long-press still asks the desk\'s question', "kill session 'api-fix'?", (await settle(x => x.confirm)).confirm);
  await phoneGrid();
  is('touch: a drag by the title still lifts the card', true, await fingerDrag('docs-pass', 'grip', 0, 140, lifted));
  is('...and reorders it', true, await until(() => auditHas('fleet_order'), 3000));
  await phoneGrid();
  await touchDrag(await spot('api-fix'), 0, 0);
  is('touch: a tap still opens the card', 'api-fix', (await settle(x => x.session)).session);
  await slid();
  await fingerDrag('#chat', 'body', -200, 0);
  is('touch: a swipe across the chat still goes to the next session', 'docs-pass', (await settle(x => x.session && x.session !== 'api-fix')).session);

  // ════════════════════════════════════════════════════════════════════════════════════
  // AN iPHONE: touch, the on-screen keyboard, or a keyboard attached
  // ════════════════════════════════════════════════════════════════════════════════════
  // No simulator here, so the phone is Chrome at 390x844 with touch emulation. The on-screen
  // keyboard is emulated the way iOS presents it to a page: the visual viewport shrinks by
  // a third of the screen while a field is focused (the threshold syncViewport() reads).
  const phoneSession = async () => { await phoneGrid(); await tap('api-fix'); await settle(x => x.session === 'api-fix'); await slid(); };
  const onScreenKeyboard = async (up) => {
    await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: up ? 500 : 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
  };

  await phoneSession();
  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  await onScreenKeyboard(true);
  await keys('o', 'k', 'Enter');
  is('iPhone, on-screen keyboard: ⏎ in the composer is still a new line', 'ok\n', (await look()).draft);
  is('...and sends nothing', false, await auditHas('fleet_send'));
  await onScreenKeyboard(false);

  // The `send` button with the box still focused — how a thumb sends on a phone. Since #86
  // kept the composer across renders, the box went on holding the message it had just sent.
  await phoneSession();
  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  for (const ch of 'hello') await b.call('Input.insertText', { text: ch });
  await b.evaluate(() => { document.querySelector('#app .composer button.go')?.click(); return null; });
  is('phone: send with the box focused sends', true, await until(() => auditHas('fleet_send'), 3000));
  await sleep(800);
  is('...and empties the box', '', (await look()).draft);

  // A keyboard attached: the field is focused and NO on-screen keyboard comes up, so the
  // keys that arrive are a real keyboard's — the first ⏎ sends.
  await phoneSession();
  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  await keys('o', 'k');
  await press('Enter', { as: 'iPhone ⏎' });
  is('iPhone, keyboard attached: ⏎ sends', true, await until(() => auditHas('fleet_send'), 3000));
  is('...and empties the box', '', (await settle(x => x.draft === '')).draft);

  // ...and the Mac-grid keys, with nothing focused, on the phone's single column.
  await fresh(390, 844, true);
  const [p0, p1] = await order('');
  await press('j');
  is('iPhone, keyboard attached: j moves the cursor on Projects', [p0, p1], [p0, (await look()).sel]);
  is('...in the single column', false, (await look()).duo);
  await phoneGrid();
  await press('2');
  const opened = (await settle(x => x.session)).session;
  is('iPhone, keyboard attached: 2 opens card 2', 'api-fix', opened);
  await press('`');
  is('iPhone, keyboard attached: ` goes back to the grid', ['api-fix', true], [opened, onGrid(await settle(x => !x.session))]);
  await press('/'); await keys('d', 'o', 'c');
  is('iPhone, keyboard attached: / finds an agent', 'docs-pass', (await look()).sel);
  await press('Escape');
  await phoneSession();
  await press('Escape');                   // a key from nowhere: proves the keyboard
  await press('p');
  is('iPhone, keyboard attached: a letter in a session goes to the composer', 'p', (await look()).draft);
  await press('Enter');
  is('...and ⏎ there sends it', true, await until(() => auditHas('fleet_send'), 3000));

  // iOS's Paste (long-press in the box → Paste): Safari hands the image over in
  // clipboardData.ITEMS with an empty `files`, so this is that shape exactly — the event a
  // DataTransfer-built paste above does not exercise.
  await phoneSession();
  await b.evaluate((png) => {
    const bin = atob(png); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const f = new File([u8], 'image.png', { type: 'image/png' });
    const box = document.querySelector('#app .composer textarea'); if (!box) return null;
    box.focus();
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], types: ['image/png'], items: [{ kind: 'file', type: 'image/png', getAsFile: () => f }] } });
    box.dispatchEvent(ev);
    return null;
  }, PNG);
  s = await settle(x => x.tiles && /failed|ready/.test(x.tileTitle));
  is('iPhone: an image from the Paste menu attaches', 1, s.tiles);
  is('...through the picker\'s path', true, /attachments need a real fleet/.test(s.tileTitle));


  // ════════════════════════════════════════════════════════════════════════════════════
  // DRAFTS: one per session, kept until it is sent
  // ════════════════════════════════════════════════════════════════════════════════════
  // Reached BY TAP and by history.back(), never by a key this change added, so each row is
  // red on staging for the draft and not for the way it got there.
  const typeIn = async (text) => {
    await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
    await b.call('Input.insertText', { text });
    await sleep(200);
  };
  const leaveBox = () => b.evaluate(() => { document.activeElement?.blur?.(); return null; });
  // A reload that keeps storage — the page is opened again, as a relaunch opens it.
  const reopen = async () => {
    await b.call('Page.reload', {});
    await sleep(800);
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click();
      return !!document.querySelector('#app .composer textarea');
    }), 10000);
    await sleep(600);
  };
  const back = async () => { await b.evaluate(() => { history.back(); return null; }); await sleep(700); };

  await toWorker();
  await typeIn('draft one');
  await leaveBox();
  await tap('docs-pass'); await settle(x => x.session === 'docs-pass');
  is('drafts: another chat has its own box', '', (await look()).draft);
  await tap('api-fix');
  is('drafts: back in the first chat, its draft is there', 'draft one', (await settle(x => x.session === 'api-fix' && x.draft)).draft);

  await reopen();
  s = await look();
  is('drafts: after a reload, the same chat and its draft', ['api-fix', 'draft one'], [s.session, s.draft]);

  await b.evaluate(() => { document.querySelector('#app .composer textarea')?.focus(); return null; });
  await press('Enter', { as: 'drafts ⏎' });
  is('drafts: a send that succeeds', true, await until(() => auditHas('fleet_send'), 3000));
  is('...empties the draft', '', (await look()).draft);
  await reopen();
  is('...and it stays gone after a reload', '', (await look()).draft);

  // The page dying WHILE a send is in flight — the app swiped away mid-send on a slow link.
  // The box has emptied, the send has not been answered: the draft must still be there.
  await b.evaluate(() => { localStorage.setItem('gf.fixture.delay', '8000'); return null; });
  await typeIn('sent on a slow link');
  await press('Enter');
  await sleep(300);
  is('drafts: the box empties when send is pressed', '', (await look()).draft);
  await b.evaluate(() => { localStorage.removeItem('gf.fixture.delay'); return null; });
  await reopen();
  is('...but a reload before the send is answered still has the draft', 'sent on a slow link', (await look()).draft);
  await b.evaluate(() => { const t = document.querySelector('#app .composer textarea'); if (t) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } return null; });

  // A send the daemon refuses, as fleet-send refuses one to a worker whose task shipped.
  await b.evaluate(() => { localStorage.setItem('gf.fixture.shipped', 'api-fix'); return null; });
  await typeIn('this one will be refused');
  await press('Enter');
  s = await settle(x => x.toast);
  is('drafts: a send that fails says why', true, /already finished a task that shipped/.test(s.toast));
  is('...and keeps the draft in the box', 'this one will be refused', (await settle(x => x.draft)).draft);
  await reopen();
  is('...and after a reload', 'this one will be refused', (await look()).draft);
  await b.evaluate(() => { localStorage.removeItem('gf.fixture.shipped'); return null; });

  // Two projects, two sessions both called `master`: acme-api's, and the `jarvis` project's
  // (the Jarvis band on Projects opens it — the one other master the fixtures have).
  const toJarvis = async () => {
    await settle(atProjects);
    await b.evaluate(() => { document.querySelector('.jarvis-bar')?.click(); return null; });
    await until(() => b.evaluate(() => !!document.querySelector('#app .composer textarea')), 8000);
    await sleep(400);
  };
  const toAcmeMaster = async () => { await tap('acme-api'); await settle(onGrid); await tap('master'); await settle(x => x.session === 'master'); };
  await fresh();
  await toAcmeMaster();
  await typeIn('for acme-api'); await leaveBox();
  await back(); await back();
  await toJarvis();
  is("drafts: jarvis's master does not see acme-api's master's draft", '', (await look()).draft);
  await typeIn('for jarvis'); await leaveBox();
  await back();
  await settle(atProjects);
  await toAcmeMaster();
  is("drafts: acme-api's master keeps its own", 'for acme-api', (await settle(x => x.draft)).draft);
  await back(); await back();
  await toJarvis();
  is("drafts: ...and jarvis's master its own", 'for jarvis', (await settle(x => x.draft)).draft);
  is('...stored apart, one entry each', 2, await b.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('gf.drafts') || '{}')).length));

  // Photos go with their draft while the page lives, and a reload that drops them says so.
  await fresh();
  await toWorker();
  await typeIn('see this');
  await withFile('paste');
  await settle(x => x.tiles);
  await leaveBox();
  await tap('docs-pass'); await settle(x => x.session === 'docs-pass');
  is('drafts: a pasted photo stays with its own chat', 0, (await look()).tiles);
  await tap('api-fix');
  s = await settle(x => x.session === 'api-fix' && x.tiles);
  is('drafts: ...and is still there on coming back', [1, 'see this'], [s.tiles, s.draft]);
  await reopen();
  s = await look();
  is('drafts: after a reload the words are kept', 'see this', s.draft);
  is('...and the dropped photo is SAID, not silently gone', true, /1 photo attached to this draft did not survive the reload/.test(s.lost));
  await b.evaluate(() => { [...document.querySelectorAll('#app .hint.lost button')].pop()?.click(); return null; });
  is('...until it has been read', '', (await settle(x => !x.lost)).lost);

  // An iPhone, relaunched: the same store, at the phone's size with touch.
  await phoneSession();
  await typeIn('typed on the phone');
  await reopen();
  is('iPhone: a draft survives the app being relaunched', ['api-fix', 'typed on the phone'], [(await look()).session, (await look()).draft]);


  // ════════════════════════════════════════════════════════════════════════════════════
  // A CHAT OPENS READY TO TYPE IN — with a keyboard, and only then
  // ════════════════════════════════════════════════════════════════════════════════════
  await toWorker();
  s = await look();
  is('focus: opening a chat on a desktop focuses its composer', true, s.typing);
  is('...and its messages are drawn all the same', true, (await settle(x => x.bubbles > 0)).bubbles > 0);
  await typeIn('half a thought');
  await leaveBox();
  await tap('docs-pass'); await settle(x => x.session === 'docs-pass');
  await tap('api-fix');
  s = await settle(x => x.session === 'api-fix' && x.typing);
  is('focus: a chat with a saved draft opens with the caret at its end', [14, 14], s.caret);
  // From inside the focused box, the keys tmux answers before the agent does at the desk.
  await press('`', { as: 'composer `' });
  s = await settle(x => !x.session);
  is('focus: ` from the focused composer goes back, as at the desk', true, onGrid(s));
  await tap('api-fix');
  is('...and is not typed into the draft', 'half a thought', (await settle(x => x.session === 'api-fix' && x.draft)).draft);
  await toWorker();
  await press('ArrowRight', { shift: true, as: 'composer ⇧→' });
  is('focus: ⇧→ from the focused composer steps to the next session', 'docs-pass', (await settle(x => x.session && x.session !== 'api-fix')).session);
  is('...which opens focused too', true, (await look()).typing);
  await toWorker();
  await press('s', { ctrl: true, as: 'composer Ctrl-s' });
  is('focus: Ctrl-s from the focused composer goes to the grid', true, onGrid(await settle(x => !x.session)));
  await toWorker();
  await press('f', { ctrl: true }); await press('p');
  is('focus: Ctrl-f p from the focused composer goes to Projects', true, atProjects(await settle(atProjects)));

  // A phone with only its on-screen keyboard: never focused, or the keyboard would rise
  // over the conversation on every open.
  await phoneSession();
  is('focus: a touch-only phone opens a chat unfocused', false, (await look()).typing);
  // ...and an iPhone that has shown it has a keyboard: focused, like a desk.
  await phoneGrid();
  await press('Escape');                   // a key from nowhere: a real keyboard
  await tap('api-fix'); await settle(x => x.session === 'api-fix'); await slid();
  is('focus: an iPhone with a keyboard attached opens a chat focused', true, (await settle(x => x.typing)).typing);

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
