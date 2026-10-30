#!/usr/bin/env node
// queue-check — what the masters hold for the owner is a page of its own, and Projects
// keeps one line that opens it.
//
//     node test/helpers/queue-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of staging, where
// the list was drawn at the top of Projects, every row about the queue goes red — which is
// how each was watched before it was trusted.
//
// WHY THIS IS A REAL BROWSER AND NOT pwa-render's FAKE DOM. The two things that changed are
// the two a fake DOM cannot say: where the list is drawn at 1600 wide (the RIGHT pane, beside
// Projects) and what a real finger, a real mouse and a real ⏎ do to a <button> sitting inside
// the card list, whose own gesture machine (wire()) listens for pointer events on the cards
// around it. Taps are touch events and clicks are mouse events, both through the browser's
// input path; keys go through Input.dispatchKeyEvent, so the focused element receives them.
//
// ITS OWN SERVER, because the shipped waiting.json is empty and every row here needs a
// queue in it. The fixture is swapped between rows by changing `WAITING` below; everything
// else is served from web-dir as written.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

// One waiting on the owner, one the owner already answered — the two hues #81 drew.
const ITEMS = [
  { project: 'acme-api', profile: 'work', session: 'master', key: 'k:7', id: '7', text: 'merge #12 now, or wait for the review?',
    state: 'waiting', reason: 'waits on the person: pick one', since_ago: 7200, at_ago: 9000 },
  { project: 'toolbox', profile: 'work', session: 'master', key: 'k:2', id: '2', text: 'rename the scratch keys',
    state: 'replied', reason: '', since_ago: 60, at_ago: 20000 },
];
const QUIET = [
  { ...ITEMS[1] },
  { project: 'billing-svc', profile: 'work', session: 'master', key: 'k:4', id: '4', text: 'pick the invoice font',
    state: 'open', reason: '', since_ago: 5 * 3600, at_ago: 5 * 3600 },
];
let WAITING = ITEMS;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/fixtures/waiting.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, items: WAITING }));
  }
  const p = path.join(WEB, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!path.resolve(p).startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let b = null;
try {
  try {
    // A desk with a mouse, declared rather than detected (see desktop-check.mjs: a CI runner
    // has no pointing device, and two panes ask for a fine pointer that hovers). Touch
    // emulation, where the phone rows turn it on, overrides it.
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the queue', 'no chrome to tap in'); server.close(); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  // PAST THE SERVICE WORKER, or the fixture swap below never reaches the page: sw.js answers
  // a request it has seen from its cache, and the second Projects read the same queue as the
  // first. The worker still registers and app.js still listens to it, which is the half a
  // tapped notification needs.
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });
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
    const row = document.querySelector('.queue-row');
    const app = document.getElementById('app'), side = document.getElementById('side');
    const names = (root) => root ? [...root.querySelectorAll('.card .c-name')].map(n => n.textContent.trim()) : [];
    return {
      duo: document.documentElement.classList.contains('duo'),
      main: t('#app > .hdr .scope'),        // the one column, or the right pane
      side: t('#side .hdr .scope'),         // the left pane — '' on a phone
      empty: !!document.querySelector('#app .duo-empty'),
      session: t('#app .sbar .nm'),
      rows: document.querySelectorAll('.queue-row').length,
      rowText: row ? [...row.children].map(c => c.textContent.trim()).join(' ') : '',
      rowHot: !!row && row.classList.contains('hot'),
      rowColor: row ? getComputedStyle(row).color : '',
      rowIn: row ? (row.closest('#side') ? 'side' : row.closest('#app') ? 'app' : '?') : '',
      // what a held item's card looks like, wherever it is drawn
      heldMain: [...(app ? app.querySelectorAll('.card.k-waiting .c-name') : [])].map(n => n.textContent.trim()),
      heldSide: [...(side ? side.querySelectorAll('.card.k-waiting .c-name') : [])].map(n => n.textContent.trim()),
      heldSel: [...document.querySelectorAll('.card.k-waiting')].map(c => c.classList.contains('sel')),
      heads: [...document.querySelectorAll('.cards > .sect')].map(n => n.textContent.trim()),
      projMain: names(app).filter(Boolean),
      nums: [...document.querySelectorAll('.card[data-idx] .c-num')].map(n => n.textContent.trim()).join(','),
      sel: t('#side .card.sel .c-name') || t('#app .card[data-idx].sel .c-name'),
      sheet: t('#sheet h2'),
      sheetText: t('#sheet'),
      toast: t('#app .toast') || t('#side .toast'),
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().map(r => r.tool));
  // Where an element is, for a tap or a click at its centre. Scrolled into view first.
  const centre = (q) => b.evaluate((sel) => {
    const n = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, q);
  const cardSel = (scope, name) => `${scope} .card[data-q="${name}"]`;
  // A held item's card, by its project, tagged so a selector can find it.
  const markHeld = (name) => b.evaluate((nm) => {
    const c = [...document.querySelectorAll('.card.k-waiting')].find(n => (n.querySelector('.c-name') || {}).textContent?.trim() === nm);
    if (!c) return false;
    document.querySelectorAll('[data-q]').forEach(n => n.removeAttribute('data-q'));
    c.setAttribute('data-q', nm);
    return true;
  }, name);
  // THE PHONE SLIDES BETWEEN SCREENS, and while the slide plays a finger lands on its
  // snapshot, not on the cards (desktop-check.mjs's slid()). A thumb waits for it; so does this.
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
  const tapAt = async (p) => {
    if (!p) return false;
    await slid();
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(200);
    return true;
  };
  const clickAt = async (p) => {
    if (!p) return false;
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(200);
    return true;
  };
  const VK = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, '`': 192 };
  async function press(key, { shift = false } = {}) {
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(150);
  }

  // A clean app at a size, past the lock screen, on Projects, with `items` held.
  async function fresh({ w = 1600, h = 900, touch = false, items = ITEMS, hash = '' } = {}) {
    WAITING = items;
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    // A hash alone is a same-document navigation — no load, no boot — so a cold open on
    // #waiting goes by way of a blank page, as a notification that launches the app does.
    if (hash) await goto('about:blank');
    await goto(base + '/index.html' + hash);
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')));
    // the waiting read lands beside the projects read, not before it
    if (items.length && !hash) await until(() => b.evaluate(() => !!document.querySelector('.queue-row, .card.k-waiting')), 4000);
    await sleep(300);
  }
  const PHONE = { w: 390, h: 844, touch: true };
  // THE TOP BAR'S FIRST CONTROL, measured against the column it is drawn in: the queue's
  // `.hdr` and a conversation's `.sbar` both open the column (#app, the one column or the
  // right pane). What a reader sees of a back control — the glyph, the size, the type, the
  // corner — is what is compared, so a lookalike drawn some other way would show.
  const lead = (bar) => b.evaluate((q) => {
    const n = document.querySelector(q), app = document.getElementById('app');
    if (!n || !app) return null;
    const r = n.getBoundingClientRect(), a = app.getBoundingClientRect(), cs = getComputedStyle(n);
    return { tag: n.tagName, text: n.textContent.trim(), font: cs.fontSize, pad: cs.padding,
             w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left - a.left), y: Math.round(r.top - a.top) };
  }, `#app > ${bar} > :first-child`);
  const same = (a, c) => !!a && !!c && a.tag === c.tag && a.text === c.text && a.font === c.font && a.pad === c.pad
    && Math.abs(a.w - c.w) <= 1 && Math.abs(a.h - c.h) <= 1 && Math.abs(a.x - c.x) <= 2 && Math.abs(a.y - c.y) <= 4;
  // EACH STEP STANDS ALONE. Against a client without the queue, back from Projects leaves the
  // page and the browser drops the target; a run that died there would never say which of
  // the rows after it are red. So a step that throws is one red row, and the next one runs.
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }
  let s = null;

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE PHONE: Projects is one line, and the line opens the queue
  // ════════════════════════════════════════════════════════════════════════════════════
  await step('phone: Projects', async () => {
    await fresh(PHONE);
    s = await look();
    is('phone: Projects fills the screen', ['— projects', false], [s.main, s.duo]);
    is('...and draws ONE queue row', 1, s.rows);
    is('...reading queue · 2 ›', 'queue · 2 ›', s.rowText);
    is('...red, because one item waits on the owner', [true, 'rgb(255, 95, 95)'], [s.rowHot, s.rowColor]);
    is('...and none of the held items themselves', [], s.heldMain);
    is('...nor the old heading', [], s.heads.filter(h => /waiting on you/.test(h)));
    // #81's two promises, which the row has to keep as the list did: it carries no number
    // and the cursor never lands on it.
    is('...the projects keep their numbers', '1,2,3,4,5', s.nums);
    is('...and the cursor is on a project', 'acme-api', s.sel);

    await fresh({ ...PHONE, items: QUIET });
    s = await look();
    is('only answered and untouched items: the row is muted', ['queue · 2 ›', false, 'rgb(138, 138, 138)'], [s.rowText, s.rowHot, s.rowColor]);

    await fresh({ ...PHONE, items: [] });
    s = await look();
    is('nothing held: no row at all', 0, s.rows);
  });

  await step('phone: the queue', async () => {
    await fresh(PHONE);
    await tapAt(await centre('.queue-row'));
    s = await settle(x => /queue/.test(x.main));
    is('a tap on the row opens the queue, titled with its count', '— queue · 2', s.main);
    is('...listing exactly what Projects listed, in the same order', ['— queue · 2', ['acme-api', 'toolbox']], [s.main, s.heldMain]);
    is('...and nothing else', ['acme-api', 'toolbox'], s.projMain);
    // the answer sheet, from the queue, exactly as it was from Projects
    await slid();
    await markHeld('acme-api');
    await tapAt(await centre(cardSel('#app', 'acme-api')));
    s = await settle(x => x.sheet);
    is('a tap on an item in the queue opens its answer sheet', ['— queue · 2', true], [s.main, /^answer/.test(s.sheet) && /acme-api · master · #7/.test(s.sheetText)]);
    await b.evaluate(() => { const t = document.querySelector('#sheet textarea'); t.value = 'go ahead'; t.dispatchEvent(new Event('input', { bubbles: true })); return null; });
    await tapAt(await centre('#sheet button.go'));
    s = await settle(x => /sent to/.test(x.toast));
    is('...and send sends it to that master, leaving the owner on the queue', [true, "sent to acme-api's master", '— queue · 2'],
       [(await audit()).includes('fleet_send'), s.toast, s.main]);
    // ...where the next read draws it answered: no item left waiting, so the row goes quiet.
    await b.evaluate(() => { history.back(); return null; });
    s = await settle(x => /projects/.test(x.main) && x.rows === 1);
    is("the phone's back gesture returns to Projects", '— projects', s.main);
    s = await settle(x => !x.rowHot);
    is('...where the answered item has turned the row muted', ['queue · 2 ›', false], [s.rowText, s.rowHot]);

  });

  // A WAY BACK THAT CAN BE SEEN. The gesture, ` and q all went back from the queue, and none
  // of them is on the screen: an owner who opened the queue with a tap had nothing to tap to
  // leave it. The conversation's `‹` is the back control this client already draws, so the
  // queue draws that one, in that corner, and it calls the same back().
  await step('phone: the back control', async () => {
    await fresh(PHONE);
    await slid();
    await tapAt(await centre('.card[data-idx="0"]'));
    await settle(x => /acme-api/.test(x.main));
    await slid();
    await tapAt(await centre('#app .card'));
    s = await settle(x => x.session);
    const conv = await lead('.sbar');
    await fresh(PHONE);
    await tapAt(await centre('.queue-row'));
    s = await settle(x => /queue/.test(x.main));
    const q = await lead('.hdr');
    is("phone: the queue's top bar opens with a ‹", '‹', q && q.text);
    is("...the conversation's own back control, in the same corner", true, same(q, conv));
    if (!same(q, conv)) is('...(measured)', conv, q);
    await tapAt(await centre('#app > .hdr > :first-child'));
    s = await settle(x => /projects/.test(x.main));
    is('a tap on it lands on Projects, the row still there', ['— projects', 1], [s.main, s.rows]);
  });

  // A TAPPED NOTIFICATION. sw.js posts {open:'waiting'} to a window that is open, and opens
  // a cold one on #waiting; both are delivered here the way sw.js delivers them.
  await step('phone: a notification', async () => {
    await fresh(PHONE);
    await slid();
    await tapAt(await centre('.card[data-idx="0"]'));
    await settle(x => /acme-api/.test(x.main));
    await b.evaluate(() => { navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { open: 'waiting' } })); return null; });
    s = await settle(x => /queue/.test(x.main));
    is('a notification tapped with the app open lands on the queue, from wherever it was', '— queue · 2', s.main);
    await b.evaluate(() => { history.back(); return null; });
    s = await settle(x => /projects/.test(x.main));
    is('...one step above Projects: back is Projects, not the grid it was on', '— projects', s.main);
  });
  await step('phone: a notification, cold', async () => {
    await fresh({ ...PHONE, hash: '#waiting' });
    s = await settle(x => /queue/.test(x.main));
    is('a notification that opens the app lands on the queue', '— queue · 2', s.main);
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE DESK: the row at the top of the left pane, the queue on the right
  // ════════════════════════════════════════════════════════════════════════════════════
  await step('desk: a click', async () => {
    await fresh();
    s = await look();
    is('desk: two panes, the row in the LEFT one', [true, 'side', 1], [s.duo, s.rowIn, s.rows]);
    is('...above every project', true, await b.evaluate(() => {
      const row = document.querySelector('#side .queue-row'), card = document.querySelector('#side .card[data-idx]');
      return !!row && !!card && !!(row.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    }));
    is('...and no held items in it', [], s.heldSide);
    await clickAt(await centre('#side .queue-row'));
    s = await settle(x => /queue/.test(x.main));
    is('a click on the row opens the queue in the RIGHT pane', ['— queue · 2', '— projects'], [s.main, s.side]);
    is('...with the items in it', ['acme-api', 'toolbox'], s.heldMain);
    const before = s.main;
    await markHeld('toolbox');
    await clickAt(await centre(cardSel('#app', 'toolbox')));
    s = await settle(x => x.sheet);
    is('...and a click on one opens its answer sheet', true, /^answer/.test(s.sheet) && /toolbox · master · #2/.test(s.sheetText));
    await press('Escape');
    await press('`');
    s = await settle(x => x.empty);
    is('` goes back from the queue: the right pane is empty again, Projects still beside it', ['— queue · 2', true, '— projects'], [before, s.empty, s.side]);

  });

  // ...and in the right pane, where a conversation opened from Projects draws its own `‹`.
  await step('desk: the back control', async () => {
    await fresh();
    await press('Enter');
    s = await settle(x => x.session);
    const conv = await lead('.sbar');
    // left by its own ‹: the composer has the keyboard, so a typed Q would be a letter in it
    await clickAt(await centre('#app > .sbar > :first-child'));
    await settle(x => x.empty);
    await clickAt(await centre('#side .queue-row'));
    s = await settle(x => /queue/.test(x.main));
    const q = await lead('.hdr');
    is("desk: the queue's top bar in the right pane opens with a ‹", '‹', q && q.text);
    is("...the conversation's own back control, in the same corner", true, same(q, conv));
    if (!same(q, conv)) is('...(measured)', conv, q);
    await clickAt(await centre('#app > .hdr > :first-child'));
    s = await settle(x => x.empty);
    is('a click on it lands on Projects: the right pane empty, Projects beside it', ['', true, '— projects'], [s.main, s.empty, s.side]);
  });

  // ⏎ ON THE ROW, with the keyboard's focus on it — and the project cursor where it was.
  await step('desk: the keys', async () => {
    await fresh();
    await b.evaluate(() => { document.querySelector('#side .queue-row').focus(); return null; });
    // ...and a Projects poll in between, which builds the row afresh: a Tab followed by a
    // pause is how a person at a desk reaches it.
    await sleep(5600);
    is('the row keeps the focus across the 5s poll', true, await b.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('queue-row')));
    await press('Enter');
    s = await settle(x => /queue/.test(x.main));
    is('⏎ on the row opens the queue on the right', ['— queue · 2', ''], [s.main, s.session]);
    is("the queue's cursor starts on the first item", [true, false], s.heldSel);
    await press('j');
    is('j moves it down', [false, true], (await look()).heldSel);
    await press('k');
    is('k moves it back', [true, false], (await look()).heldSel);
    await press('ArrowDown');
    await press('Enter');
    s = await settle(x => x.sheet);
    is('↓ then ⏎ answers the item under it', true, /toolbox · master · #2/.test(s.sheetText));
    await press('Escape');
    const was = (await look()).main;
    await press('q');
    s = await settle(x => x.empty);
    is('q goes back from the queue to Projects', ['— queue · 2', true, '— projects'], [was, s.empty, s.side]);

  });

  // Projects' own keys with a queue held: the cursor is a project's, ⏎ a project's.
  await step("desk: Projects' keys", async () => {
    await fresh();
    is('desk: the project cursor starts on project 1', 'acme-api', (await look()).sel);
    await press('j');
    is('...j moves it to project 2, never onto the row', 'acme-web', (await look()).sel);
    await press('Enter');
    s = await settle(x => x.session);
    is("...and ⏎ still opens that project's master", ['master', true], [s.session, /acme-web/.test(s.side)]);
    await fresh();
    await press('3');
    s = await settle(x => x.session);
    is('...and 3 is still project 3', ['master', true], [s.session, /toolbox/.test(s.side)]);

    // From a session at the desk, the notification lands on the queue too, on the right.
    await press('Q', { shift: true });
    await b.evaluate(() => { navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { open: 'waiting' } })); return null; });
    s = await settle(x => /queue/.test(x.main));
    is('desk: a tapped notification opens the queue on the right', ['— queue · 2', '— projects'], [s.main, s.side]);
  });
} finally {
  try { if (b) await b.close(); } catch {}
  server.close();
}
done(0);
