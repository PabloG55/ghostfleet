#!/usr/bin/env node
// dialogs-check — every dialog has a way out you can see, and the room behind it is one too.
//
//     node test/helpers/dialogs-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// "we need an X on the modals; if you click outside it should exit". Asked of every dialog
// the fixture fleet can open on the phone's screens (web/ui's Modal and Confirm), at a phone
// (390x844, a finger) and at a desk (1600x900, a mouse), with real input events (CDP), never
// el.click():
//
//   THE X        a <button> in the dialog's top-right corner whose accessible name is
//                "Close" — asked of Chrome's accessibility tree, not of an attribute, because
//                the tree is what a screen reader is handed — that a finger can hit, and a
//                press on it closes.
//   THE ROOM     a tap (phone) or a click (desk) on the scrim beside the dialog closes it.
//   A DRAG OUT   a press that starts INSIDE the dialog and lets go over the scrim does not.
//                Chrome fires that click on the nearest common ancestor, which is the scrim
//                itself, so a handler that only asks "was the click on the scrim" fails here.
//   TEXT         what was typed into the queue's reply is there again after a tap beside it,
//                and only in the reply to THAT item.
//   THE CONFIRM  a press outside a destructive confirm cancels it and is EATEN: nothing is
//                stopped or deleted, and the control under the press does not act either.
//                Outside only ever cancels — it never reaches the yes, nor what lies beneath.
//
// `web-dir` defaults to this checkout's web/. Each row was watched red against a client with
// the guard it asks about taken out.
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

// Two items waiting, so a draft can be asked whether it stays with its own.
const WAITING = { ok: true, items: [
  { project: 'acme-api', session: 'master', id: '7', text: 'merge the cache fix now or after the release', state: 'waiting', reason: 'waits on the person: pick one', since_ago: 600, at_ago: 900 },
  { project: 'toolbox', session: 'master', id: '3', text: 'keep the old flag as an alias', state: 'waiting', reason: 'waits on the person: yes or no', since_ago: 300, at_ago: 400 },
] };

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    // A desk with a mouse, declared — a CI runner has no pointing device (desktop-check.mjs).
    // The phone half turns touch emulation on over it.
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the dialogs', 'no chrome to tap in'); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  // A slow runner, on demand: GF_CPU_THROTTLE=5 makes this laptop lose the way a loaded CI box does.
  if (+process.env.GF_CPU_THROTTLE > 1) await b.call('Emulation.setCPUThrottlingRate', { rate: +process.env.GF_CPU_THROTTLE });
  await b.call('DOM.enable');
  await b.call('Accessibility.enable');
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const real = window.fetch.bind(window);
    const lag = ${+process.env.GF_FETCH_DELAY || 0};
    window.fetch = (url, opts) => lag ? new Promise(r => setTimeout(r, lag * Math.random())).then(() => real(url, opts)) : String(url).includes('/fixtures/waiting.json')
      ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(WAITING))}, { status: 200 }))
      : real(url, opts);` });
  // GF_COVER_MS=1500: a fixed layer over the whole phone for that long after every load and route change, as a toast or
  // a half-drawn sheet is on a slow runner. The tap has to wait for the control to be hittable.
  if (+process.env.GF_COVER_MS) await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const cv = document.createElement('div'); let t0 = 0;
    cv.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
    const arm = () => { t0 = Date.now(); document.documentElement.appendChild(cv); };
    addEventListener('DOMContentLoaded', arm); addEventListener('hashchange', arm);
    setInterval(() => { if (Date.now() - t0 > ${+process.env.GF_COVER_MS}) cv.remove(); }, 50);` });
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') console.error('page threw:', ((p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text)) || '').split('\n')[0]);
  });
  const base = srv.base;
  async function until(cond, ms = 6000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }

  // ── input: a finger on the phone, a mouse at the desk ──────────────────────────────
  let touch = false;
  async function press(x, y) {
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(250);
  }
  async function drag(from, to) {
    const steps = 8;
    const at = (i) => ({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      for (let i = 1; i <= steps; i++) await b.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] });
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(i), button: 'left', buttons: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
    }
    await sleep(250);
  }
  // The centre of the first element matching `sel` whose text starts with `text`.
  const centreOf = (sel, text = '') => b.evaluate((s, tx) => {
    const n = [...document.querySelectorAll(s)].find(x => !tx || x.textContent.trim().startsWith(tx));
    if (!n) return null;
    n.scrollIntoView({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    // A press lands on whatever is topmost at the point, not on the control that is there: a toast,
    // the floating Assistant or a half-drawn sheet over it eats the tap and nothing opens. Not
    // pressable until the control itself is what a finger would hit.
    const top = document.elementFromPoint(x, y);
    return top && (top === n || n.contains(top)) ? { x, y } : null;
  }, sel, text);
  //   What kept the last tap from pressing its control, for the row that then finds no dialog. A
  // red here used to say only `false`, and twice on a runner nobody can watch that was all there
  // was to go on: two different dialogs in two runs, every wait spent, nothing to tell an app that
  // never came up from a control that was missing or one with something lying over it.
  let missed = '';
  const inTheWay = (sel, text = '') => b.evaluate((s, tx) => {
    const where = location.hash || '#/';
    if (!document.querySelector('.app .main')) return `the app never came up (${where})`;
    const n = [...document.querySelectorAll(s)].find(x => !tx || x.textContent.trim().startsWith(tx));
    if (!n) return `no ${s}${tx ? ` "${tx}"` : ''} on ${where}`;
    const r = n.getBoundingClientRect();
    const top = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    if (!top) return `${s} has no box on screen (${where})`;
    const name = (e) => e.tagName.toLowerCase() + [...e.classList].map(c => '.' + c).join('');
    return `${s} is under ${name(top)}${top.parentElement ? ` in ${name(top.parentElement)}` : ''} (${where})`;
  }, sel, text);
  async function tap(sel, text = '') {
    missed = '';
    let p = await until(() => centreOf(sel, text), 4000);
    if (!p) { missed = await inTheWay(sel, text); return false; }
    // Session data and fonts can land between locating More and the pointer press.
    // Use its settled position, as the team browser helper does for the owner picker.
    for (let i = 0; i < 20; i++) {
      await sleep(80);
      const now = await centreOf(sel, text);
      if (!now) { missed = await inTheWay(sel, text); return false; }
      if (now.x === p.x && now.y === p.y) break;
      p = now;
    }
    await press(p.x, p.y);
    return true;
  }

  // ── the page, read back ────────────────────────────────────────────────────────────
  const dlgUp = () => b.evaluate(() => !!document.querySelector('.scrim > .modal'));
  const dlgTitle = () => b.evaluate(() => ((document.querySelector('.modal header h2') || {}).textContent || '').trim());
  // The X: where it is, relative to the dialog, how big, and what the accessibility tree calls it.
  const xRect = () => b.evaluate(() => {
    const box = document.querySelector('.scrim > .modal');
    const x = box && box.querySelector('header button.x');
    if (!box || !x) return null;
    const r = x.getBoundingClientRect(), s = box.getBoundingClientRect();
    return { tag: x.tagName.toLowerCase(), x: r.left + r.width / 2, y: r.top + r.height / 2,
             right: r.left > s.left + s.width * 0.6, top: r.top < s.top + 72,
             inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
             w: r.width, h: r.height };
  });
  async function axNames(scope) {
    const { root } = await b.call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await b.call('DOM.querySelector', { nodeId: root.nodeId, selector: scope });
    if (!nodeId) return [];
    const { nodes = [] } = await b.call('Accessibility.queryAXTree', { nodeId, accessibleName: 'Close', role: 'button' });
    return nodes.filter(n => !n.ignored).map(n => n.name && n.name.value);
  }
  // A point on the scrim: above or below a dialog that leaves room there, else beside it.
  const scrimPoint = () => b.evaluate(() => {
    const s = document.querySelector('.scrim > .modal');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    if (r.top > 24) return { x: innerWidth / 2, y: Math.max(4, r.top / 2) };
    if (innerHeight - r.bottom > 24) return { x: innerWidth / 2, y: (r.bottom + innerHeight) / 2 };
    return r.left > 24 ? { x: r.left / 2, y: innerHeight / 2 } : null;
  });
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().map(r => r.tool));
  const hash = () => b.evaluate(() => location.hash);
  const goTo = async (to) => { await b.evaluate((h) => { location.hash = h; }, `#${to}`); await sleep(500); };
  // "The dialog came", as a row's `got`: true, or why not — the tap's reason when it never
  // pressed, else that it pressed and nothing answered, and on which screen.
  const came = async (cond, ms) => !!(await until(cond, ms)) || missed || `pressed, and nothing opened (${(await hash()) || '#/'})`;

  async function fresh(size, store = {}) {
    touch = size.touch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: size.touch, ...(size.touch ? { maxTouchPoints: 5 } : {}) });
    await b.call('Page.navigate', { url: base + '/index.html' });
    await sleep(400);
    await b.evaluate((st) => { try { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); } catch {} return null; }, store);
    await b.call('Page.navigate', { url: base + '/index.html' });
    // The fixture backend's lock, passed the way it offers.
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => /^continue without a passkey/i.test(x.textContent.trim()));
      if (e) e.click();
      return !!document.querySelector('.app .main');
    }), 10000);
    await sleep(300);
    await b.evaluate(() => document.fonts.ready.then(() => 0));
    await tap('.modal .x');
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }
  // Where the dialogs live.
  const toProject = (p) => async () => { await goTo(`/p/${p}`); await until(() => centreOf('.page button', 'New session'), 8000); };
  const toSession = async () => { await goTo('/p/acme-api/s/api-fix'); await until(() => b.evaluate(() => !!document.querySelector('.session .request-return') && !!document.querySelector('.sess-title .branch')), 8000); await tap('.modal .x'); };
  // No menu, no item: the second tap would only wait out its own 4 s and replace why with "no item".
  const fromMenu = (item) => async () => { if (await tap('.sess-tools button', 'More')) await tap('.menu button', item); };
  const toQueue = async () => { await goTo('/queue'); await until(() => centreOf('.extra-card button', 'Reply'), 8000); };

  // Every dialog the fixture fleet can open on the phone's screens, from the screen it lives on.
  // Label and schedule are not here: the phone's server does not serve them (adapter NOT_SERVED).
  const DIALOGS = [
    { name: 'permission request', home: toSession, open: () => tap('.request-return') },
    { name: 'assistant approval', home: async () => { await goTo('/'); await tap('.modal .x'); }, open: () => tap('.proposal-return') },
    { name: 'new session', home: toProject('acme-api'), open: () => tap('.page button', 'New session') },
    { name: 'delete a free worktree', home: toProject('toolbox'), open: () => tap('.free-row button', 'Delete') },
    { name: 'rename', home: toSession, open: fromMenu('Rename') },
    { name: 'stop', home: toSession, open: fromMenu('Stop session') },
    { name: 'stop and delete the worktree', home: toSession, open: fromMenu('Stop and delete') },
    { name: 'reply', home: toQueue, open: () => tap('.extra-card button', 'Reply') },
    { name: 'details', home: toSession, open: fromMenu('Details') },
  ];

  const sizes = [['phone', { w: 390, h: 844, touch: true }], ['desk', { w: 1600, h: 900, touch: false }]];
  for (const [at, size] of sizes) {
    for (const d of DIALOGS) {
      const n = `${at} · ${d.name}`;
      await step(n, async () => {
        await fresh(size);
        await d.home();
        await d.open();
        is(`${n}: the dialog opened`, true, await came(dlgUp, 4000));
        const title = await dlgTitle();
        const x = await xRect();
        is(`${n}: an X, top right, on screen`, { tag: 'button', right: true, top: true, inView: true },
           x ? { tag: x.tag, right: x.right, top: x.top, inView: x.inView } : null);
        // A finger's size where a finger is the pointer: 40px, the key row's own.
        if (touch) is(`${n}: ...a finger can hit it (40px or more)`, true, !!x && x.w >= 40 && x.h >= 40 || (x ? `${x.w}x${x.h}` : null));
        is(`${n}: ...named "Close"`, ['Close'], await axNames('.scrim > .modal'));
        if (x) await press(x.x, x.y);
        is(`${n}: ...and it closes the dialog`, false, await until(async () => !(await dlgUp()), 2000) ? false : await dlgUp());
        // The room behind it.
        await d.open(); await until(dlgUp, 4000);
        const p = await scrimPoint();
        if (p) await press(p.x, p.y);
        is(`${n}: a ${touch ? 'tap' : 'click'} beside it closes it`, false, await until(async () => !(await dlgUp()), 2000) ? false : await dlgUp());
        // A drag from the title out onto the scrim is not a request to leave.
        await d.open(); await until(dlgUp, 4000);
        const from = await centreOf('.modal header h2'), to = await scrimPoint();
        if (from && to) await drag(from, to);
        is(`${n}: a drag from inside to outside leaves it open`, [true, title], [await dlgUp(), await dlgTitle()]);
      });
    }

    // ── the words in a reply survive a tap beside it, and stay with their item ─────────
    await step(`${at} · the reply keeps its words`, async () => {
      await fresh(size);
      await toQueue();
      await tap('.extra-card button', 'Reply');
      is(`${at} · reply: the dialog opened`, true, await came(dlgUp, 6000));
      await tap('.modal textarea');
      const words = `the answer typed at the ${at}`;
      await b.call('Input.insertText', { text: words });
      const p = await scrimPoint();
      if (p) await press(p.x, p.y);
      // CLOSED AND THEN THE WORDS, in one row: a dialog that never closed still holds them, and
      // that is not what this row is asking.
      const closed = !!(await until(async () => !(await dlgUp()), 2000));
      is(`${at} · reply: a ${touch ? 'tap' : 'click'} beside it closes it`, true, closed);
      is(`${at} · reply: ...and nothing was sent`, false, (await audit()).includes('fleet_send'));
      await tap('.extra-card button', 'Reply');
      await until(dlgUp, 4000);
      is(`${at} · reply: closed, then reopened, the words are still there`, [true, words], [closed, await b.evaluate(() => (document.querySelector('.modal textarea') || {}).value ?? null)]);
      // The OTHER item's reply starts empty: the words are an answer to the first one only.
      const x = await xRect(); if (x) await press(x.x, x.y);
      await until(async () => !(await dlgUp()), 2000);
      const second = await b.evaluate(() => {
        const btn = [...document.querySelectorAll('.extra-card')].filter(c => c.querySelector('button'))[1]?.querySelector('button');
        if (!btn) return null; btn.scrollIntoView({ block: 'nearest' }); const r = btn.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (second) await press(second.x, second.y);
      await until(dlgUp, 4000);
      is(`${at} · reply: ...and the other item's reply is its own, empty`, ['toolbox', ''],
         await b.evaluate(() => [/toolbox/.test((document.querySelector('.modal header h2') || {}).textContent || '') ? 'toolbox' : 'other', (document.querySelector('.modal textarea') || {}).value ?? null]));
    });

    // ── the destructive confirm: outside only ever cancels, and is eaten ──────────────
    // EATEN, asked of a control that SURVIVES the cancel's render, under the press: a session's
    // back link, a project's New session. Let the press through and the screen moves, or a
    // second dialog opens.
    await step(`${at} · stop confirm`, async () => {
      await fresh(size);
      await toSession();
      await fromMenu('Stop session')();
      const q = () => b.evaluate(() => /^Stop the session/.test(((document.querySelector('.modal header h2') || {}).textContent || '').trim()));
      is(`${at} · stop: the confirm asks`, true, await came(q, 3000));
      const x = await xRect();
      if (x) await press(x.x, x.y);
      is(`${at} · stop: the X cancels it`, false, await q());
      is(`${at} · stop: ...and stops nothing`, false, (await audit()).includes('fleet_stop'));
      await fromMenu('Stop session')();
      await until(q, 3000);
      const where = await b.evaluate(() => { const a = document.querySelector('.sess-head a.back-link'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }; });
      const before = await hash();
      if (where) await press(where.x, where.y);
      is(`${at} · stop: a press outside it cancels it`, false, await q());
      is(`${at} · stop: ...never confirms it`, false, (await audit()).includes('fleet_stop'));
      await sleep(300);
      is(`${at} · stop: ...and is eaten — the back link under it did not go back`, before, await hash());
    });
    await step(`${at} · delete-worktree confirm`, async () => {
      await fresh(size);
      await toProject('toolbox')();
      await tap('.free-row button', 'Delete');
      const q = () => b.evaluate(() => /^Delete free worktree/.test(((document.querySelector('.modal header h2') || {}).textContent || '').trim()));
      is(`${at} · delete: the confirm asks`, true, await came(q, 3000));
      const where = await b.evaluate(() => { const n = [...document.querySelectorAll('.page button')].find(x => x.textContent.trim().startsWith('New session')); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (where) await press(where.x, where.y);
      is(`${at} · delete: a press on New session under it cancels it`, false, await q());
      is(`${at} · delete: ...never confirms it`, false, (await audit()).includes('fleet_worktree_remove'));
      await sleep(300);
      is(`${at} · delete: ...and is eaten — New session did not open`, false, await dlgUp());
    });
  }

  // ── a session's Details: a Stop at the desk on localhost, never on the phone ──────────
  // The fixture answers as the daemon does: `gf.fixture.local` is the owner's own browser on this
  // machine; without it, the phone. scratch's leftovers fixture is the demo's personal project (a
  // done session with a dev server and a watcher that ignores TERM); acme-api is a work one.
  // The stop's confirm is the sheet's sibling, so "the dialog" here is the LAST one up.
  const LEFT = { 'gf.fixture': 'grid-scratch-leftovers.json' };
  const LOCAL = { ...LEFT, 'gf.fixture.local': '1' };
  const toPlayground = async (more = 'More') => { await goTo('/p/scratch/s/playground'); await until(() => centreOf('.sess-tools button', more), 8000); };
  const openDetails = async (more = 'More', item = 'Details') => { await tap('.sess-tools button', more); await tap('.menu button', item); return !!(await until(() => b.evaluate(() => !!document.querySelector('.details .details-group, .details p.muted')), 4000)); };
  const shown = () => b.evaluate(() => [...document.querySelectorAll('.details .details-what b')].map(x => x.textContent.trim()));
  const stops = () => b.evaluate(() => [...document.querySelectorAll('.details .details-stop button')].map(x => x.textContent.trim()));
  const upTop = () => b.evaluate(() => { const m = [...document.querySelectorAll('.scrim > .modal')]; return { n: m.length, title: ((m[m.length - 1] || document).querySelector('header h2')?.textContent || '').trim() }; });
  const topPoint = (where) => b.evaluate((w) => {
    const m = [...document.querySelectorAll('.scrim > .modal')].pop(); if (!m) return null;
    if (w === 'x') { const r = m.querySelector('header button.x').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    const r = m.getBoundingClientRect(); return { x: innerWidth / 2, y: Math.max(4, r.top / 2) };
  }, where);
  const flagAndChip = () => b.evaluate(() => [(document.querySelector('.details-flag')?.textContent || '').trim(), (document.querySelector('.sess-meta .pill')?.textContent || '').trim()]);
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await b.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(250); };

  await step('phone · details', async () => {
    await fresh(sizes[0][1], LEFT);
    await toPlayground();
    is('phone · details: the sheet opens and lists what the session left', [true, [':5173', ':9229']], [await openDetails(), await shown()]);
    is('phone · details: ...with no stop control at all', [], await stops());
  });
  await step('desk · details stop', async () => {
    await fresh(sizes[1][1], LOCAL);
    await toPlayground();
    await openDetails();
    is('desk · details: on localhost, a personal project\'s rows each offer a stop', ['Stop', 'Stop'], await stops());
    const [flag, chip] = await flagAndChip();
    is('desk · details: the flag calls the session what its header chip does', ['Ready', true, false], [chip, flag.startsWith(`${chip} — `), /\bdone\b/.test(flag)]);
    const ask = async () => { await tap('.details-stop button', 'Stop'); return upTop(); };
    is('desk · stop: a modal over the sheet names the one row it stops', { n: 2, title: 'Stop :5173 node (pid 51240)?' }, await ask());
    let p = await topPoint('x'); if (p) await press(p.x, p.y);
    is('desk · stop: its X cancels it, the sheet stays, nothing stopped', [{ n: 1, title: 'playground · details' }, [':5173', ':9229']], [await upTop(), await shown()]);
    await ask(); p = await topPoint('beside'); if (p) await press(p.x, p.y);
    is('desk · stop: a click beside it cancels it and is eaten: the sheet stays', [{ n: 1, title: 'playground · details' }, [':5173', ':9229']], [await upTop(), await shown()]);
    await ask(); await esc();
    is('desk · stop: Esc cancels the confirm, not the sheet under it', [{ n: 1, title: 'playground · details' }, [':5173', ':9229']], [await upTop(), await shown()]);
    await ask(); await tap('.scrim > .modal footer button', 'Stop it');
    is('desk · stop: confirmed, exactly that row goes', [1, [':9229']], [(await until(async () => (await shown()).length === 1 && await upTop(), 4000) || {}).n, await shown()]);
    await ask(); await tap('.scrim > .modal footer button', 'Stop it');
    await until(async () => (await stops()).includes('Force stop…'), 4000);
    is('desk · stop: a process TERM left running is said so, and only now offered a force stop', [[':9229'], ['Force stop…'], true],
       [await shown(), await stops(), await b.evaluate(() => /still running/.test(document.querySelector('.details-left')?.textContent || ''))]);
    await tap('.details-stop button', 'Force stop');
    is('desk · stop: the force stop is a second modal of its own', { n: 2, title: 'Force stop :9229 node (pid 51302)?' }, await upTop());
    await tap('.scrim > .modal footer button', 'Send KILL');
    is('desk · stop: ...and confirmed, the row goes', [], (await until(async () => (await shown()).length === 0 && [], 4000)) || await shown());
  });
  await step('desk · details on a work project', async () => {
    await fresh(sizes[1][1], { 'gf.fixture.local': '1' });
    await goTo('/p/acme-api/s/docs-pass'); await until(() => centreOf('.sess-tools button', 'More'), 8000);
    await openDetails();
    is('desk · details: a work-profile project offers no stop, even on localhost', [[':5173', ':8080', 'docs-pass-db-1'], []], [await shown(), await stops()]);
  });
  await step('desk · details in Spanish', async () => {
    // The lock's way past is passed in English; the language is switched after it, as a person would.
    await fresh(sizes[1][1], LOCAL);
    await b.evaluate(() => { localStorage.setItem('gfw.lang', 'es'); return null; });
    await b.call('Page.reload', {});
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => /^seguir sin llave de acceso/i.test(x.textContent.trim()));
      if (e) e.click();
      return !e && !!document.querySelector('.app .main');
    }), 10000);
    await tap('.modal .x');
    await toPlayground('Más');
    await openDetails('Más', 'Detalles');
    const [flag, chip] = await flagAndChip();
    is('desk · details: in Spanish too, the flag says the chip\'s word', ['Lista', true, false], [chip, flag.startsWith(`${chip} — `), /terminó/.test(flag)]);
    is('desk · details: ...and the stop is named in Spanish', ['Detener', 'Detener'], await stops());
  });
} catch (e) {
  is('dialogs-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
}
done(0);
