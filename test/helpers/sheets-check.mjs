#!/usr/bin/env node
// sheets-check — every sheet has a way out you can see, and the room behind it is one too.
//
//     node test/helpers/sheets-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// "we need an X on the modals; if you click outside it should exit". Asked of every sheet
// the fixture fleet can open, at a phone (390x844, a finger) and at a desk (1600x900, a
// mouse), with real input events (CDP), never el.click():
//
//   THE X        a <button> in the sheet's top-right corner whose accessible name is
//                "close" — asked of Chrome's accessibility tree, not of an attribute, because
//                the tree is what a screen reader is handed — and a press on it closes.
//   THE ROOM     a tap (phone) or a click (desk) on the scrim beside the sheet closes it.
//   A DRAG OUT   a press that starts INSIDE the sheet and lets go over the scrim does not.
//                Chrome fires that click on the nearest common ancestor, which is the scrim
//                itself, so a handler that only asks "was the click on the scrim" fails here.
//   TEXT         what was typed into a sheet is there again after a tap beside it — the queue
//                answer (row.draft) and the schedule box (no store of its own before this).
//   THE CONFIRM  the bar that asks `kill session 'x'?` has the same X, and a press outside it
//                cancels and is EATEN: nothing is stopped, and the card under the press does
//                not open either. Outside only ever cancels — it never reaches the yes.
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of staging it is how
// each row was watched going red before it was trusted; the two that staging passes by
// doing nothing at all (a drag that does not close, an outside press that does not confirm)
// were watched red by breaking this client instead — the PR lists the mutations.
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

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    // A desk with a mouse, declared — a CI runner has no pointing device (desktop-check.mjs).
    // The phone half turns touch emulation on over it.
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the sheets', 'no chrome to tap in'); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  await b.call('DOM.enable');
  await b.call('Accessibility.enable');
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') console.error('page threw:', ((p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text)) || '').split('\n')[0]);
  });
  const base = srv.base;
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  async function until(cond, ms = 6000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(120));

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
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, sel, text);
  async function tap(sel, text = '') {
    await slid();
    const p = await until(() => centreOf(sel, text), 4000);
    if (!p) return false;
    await press(p.x, p.y);
    return true;
  }

  // ── the page, read back ────────────────────────────────────────────────────────────
  const sheetUp = () => b.evaluate(() => !!document.querySelector('#sheet .sheet'));
  const sheetTitle = () => b.evaluate(() => ((document.querySelector('#sheet h2') || {}).textContent || '').trim());
  // The X: where it is, relative to the sheet, and what the accessibility tree calls it.
  const xRect = (scope) => b.evaluate((sc) => {
    const box = document.querySelector(sc);
    const x = box && box.querySelector('.sheet-x');
    if (!box || !x) return null;
    const r = x.getBoundingClientRect(), s = box.getBoundingClientRect();
    return { tag: x.tagName.toLowerCase(), x: r.left + r.width / 2, y: r.top + r.height / 2,
             right: r.left > s.left + s.width * 0.6, top: r.top < s.top + 72,
             inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
  }, scope);
  async function axNames(scope) {
    const { root } = await b.call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await b.call('DOM.querySelector', { nodeId: root.nodeId, selector: scope });
    if (!nodeId) return [];
    const { nodes = [] } = await b.call('Accessibility.queryAXTree', { nodeId, accessibleName: 'close', role: 'button' });
    return nodes.filter(n => !n.ignored).map(n => n.name && n.name.value);
  }
  // A point on the scrim: above a phone's bottom sheet, beside a desk's centred one.
  const scrimPoint = () => b.evaluate(() => {
    const s = document.querySelector('#sheet .sheet');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return r.top > 24 ? { x: innerWidth / 2, y: Math.max(4, r.top / 2) } : { x: Math.max(4, r.left / 2), y: innerHeight / 2 };
  });
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().map(r => r.tool));

  async function fresh(size, { paired = '' } = {}) {
    touch = size.touch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: size.touch, ...(size.touch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate((pm) => { try { localStorage.clear(); sessionStorage.clear(); if (pm) localStorage.setItem('gf.fixture.paired', pm); } catch {} return null; }, paired);
    await goto(base + '/index.html');
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')));
    await sleep(400);
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }
  // Where the sheets live. The grid is the left pane at a desk and the screen on a phone.
  const gridMore = (at) => `${at === 'desk' ? '#side' : '#app'} > .hdr button.more`;
  const toGrid = async () => { await tap('.card.k-project .c-name', 'acme-api'); await until(() => centreOf('.card[data-idx] .c-name', 'api-fix')); };
  const toSession = async () => { await toGrid(); await tap('.card[data-idx] .c-name', 'api-fix'); await until(() => centreOf('#app .sbar button', '⋯')); };
  const viaSession = (row) => async () => { await tap('#app .sbar button', '⋯'); if (row) await tap('#sheet .rows button', row); };
  const viaGrid = (at, row) => async () => { await tap(gridMore(at)); if (row) await tap('#sheet .rows button', row); };

  // Every sheet the fixture fleet can open, from the screen it lives on.
  const SHEETS = (at) => [
    { name: 'actions (projects)', home: async () => {}, open: async () => { await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`); } },
    { name: 'settings', home: async () => {}, open: async () => { await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`); await tap('#sheet .rows button', 'settings'); } },
    { name: 'add project', home: async () => {}, open: async () => { await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`); await tap('#sheet .rows button', 'add'); } },
    { name: 'actions (grid)', home: toGrid, open: viaGrid(at) },
    { name: 'new session', home: toGrid, open: viaGrid(at, 'new') },
    { name: 'new worktree', home: toGrid, open: viaGrid(at, 'worktrees') },
    { name: 'actions (session)', home: toSession, open: viaSession() },
    { name: 'answer keys', home: toSession, open: viaSession('answer keys') },
    { name: 'schedule', home: toSession, open: viaSession('s sched') },
    { name: 'label', home: toSession, open: viaSession('l label') },
    { name: 'rename', home: toSession, open: viaSession('r rename') },
  ];

  const sizes = [['phone', { w: 390, h: 844, touch: true }], ['desk', { w: 1600, h: 900, touch: false }]];
  for (const [at, size] of sizes) {
    for (const sh of SHEETS(at)) {
      const n = `${at} · ${sh.name}`;
      await step(n, async () => {
        await fresh(size);
        await sh.home();
        await sh.open();
        is(`${n}: the sheet opened`, true, !!(await until(sheetUp, 4000)));
        const title = await sheetTitle();
        const x = await xRect('#sheet .sheet');
        is(`${n}: an X, top right, on screen`, { tag: 'button', right: true, top: true, inView: true },
           x ? { tag: x.tag, right: x.right, top: x.top, inView: x.inView } : null);
        is(`${n}: ...named "close"`, ['close'], await axNames('#sheet .sheet'));
        if (x) await press(x.x, x.y);
        is(`${n}: ...and it closes the sheet`, false, await until(async () => !(await sheetUp()), 2000) ? false : await sheetUp());
        // The room behind it.
        await sh.open(); await until(sheetUp, 4000);
        const p = await scrimPoint();
        if (p) await press(p.x, p.y);
        is(`${n}: a ${touch ? 'tap' : 'click'} beside it closes it`, false, await until(async () => !(await sheetUp()), 2000) ? false : await sheetUp());
        // A drag from the title out onto the scrim is not a request to leave.
        await sh.open(); await until(sheetUp, 4000);
        const from = await centreOf('#sheet h2'), to = await scrimPoint();
        if (from && to) await drag(from, to);
        is(`${n}: a drag from inside to outside leaves it open`, [true, title], [await sheetUp(), await sheetTitle()]);
      });
    }

    // ── the text a sheet holds survives a tap beside it ───────────────────────────────
    await step(`${at} · the queue answer keeps its words`, async () => {
      await fresh(size, { paired: 'online' });
      await tap('.queue-row', 'queue');
      // The queue is a screen of its own on a phone: its card only once the slide has landed
      // and the read has filled it — a tap on the screen it is leaving is a tap on nothing.
      await until(() => centreOf('.card.k-waiting .c-name'), 8000);
      await slid(); await sleep(300);
      await tap('.card.k-waiting .c-name');
      is(`${at} · answer: the sheet opened`, true, !!(await until(sheetUp, 6000)));
      await tap('#sheet textarea');
      const words = `the answer typed at the ${at}`;
      await b.call('Input.insertText', { text: words });
      const p = await scrimPoint();
      if (p) await press(p.x, p.y);
      // CLOSED AND THEN THE WORDS, in one row: a sheet that never closed still holds them, and
      // that is not what this row is asking.
      const closed = !!(await until(async () => !(await sheetUp()), 2000));
      is(`${at} · answer: a ${touch ? 'tap' : 'click'} beside it closes it`, true, closed);
      is(`${at} · answer: ...and nothing was sent`, false, (await audit()).includes('fleet_send'));
      await tap('.card.k-waiting .c-name');
      await until(sheetUp, 4000);
      is(`${at} · answer: closed, then reopened, the words are still there`, [true, words], [closed, await b.evaluate(() => (document.querySelector('#sheet textarea') || {}).value ?? null)]);
    });
    await step(`${at} · the schedule box keeps its words`, async () => {
      await fresh(size);
      await toSession();
      await viaSession('s sched')();
      await until(sheetUp, 4000);
      await tap('#sheet input[type=text]');
      await b.call('Input.insertText', { text: '+2h | carry on' });
      // The X this time: every way out keeps what was typed, not only the scrim.
      const x = await xRect('#sheet .sheet');
      if (x) await press(x.x, x.y);
      const closed = !!(await until(async () => !(await sheetUp()), 2000));
      is(`${at} · schedule: closed with the X`, true, closed);
      is(`${at} · schedule: ...and nothing was scheduled`, false, (await audit()).includes('fleet_schedule'));
      await viaSession('s sched')();
      await until(sheetUp, 4000);
      is(`${at} · schedule: closed, then reopened, the words are still there`, [true, '+2h | carry on'], [closed, await b.evaluate(() => (document.querySelector('#sheet input[type=text]') || {}).value ?? null)]);
      is(`${at} · schedule: ...and its preview read them again`, true, await b.evaluate(() => /^message: carry on$/.test([...document.querySelectorAll('#sheet p')].map(p => p.textContent).find(t => t.startsWith('message:')) || '')));
    });

    // ── the destructive confirm: outside only ever cancels ────────────────────────────
    await step(`${at} · kill confirm`, async () => {
      await fresh(size);
      await toSession();
      await viaSession('x kill')();
      const bar = at === 'desk' ? '#app .confirm, #side .confirm' : '#app .confirm';
      const q = () => b.evaluate((s) => ((document.querySelector(s) || {}).textContent || '').includes("kill session 'api-fix'?"), bar);
      is(`${at} · kill: the confirm bar asks`, true, !!(await until(q, 3000)));
      const x = await xRect('.confirm');
      is(`${at} · kill: the bar has the X, on screen`, { tag: 'button', right: true, inView: true }, x ? { tag: x.tag, right: x.right, inView: x.inView } : null);
      is(`${at} · kill: ...named "close"`, ['close'], await axNames('.confirm'));
      if (x) await press(x.x, x.y);
      is(`${at} · kill: the X cancels it`, false, await q());
      is(`${at} · kill: ...and stops nothing`, false, (await audit()).includes('fleet_stop'));
      // Outside: on the conversation (phone), on another card in the grid beside it (desk).
      await viaSession('x kill')();
      await until(q, 3000);
      const where = at === 'desk' ? await centreOf('#side .card[data-idx] .c-name', 'docs-pass') : await centreOf('#app .chat');
      if (where) await press(where.x, where.y);
      is(`${at} · kill: a press outside the bar cancels it`, false, await q());
      is(`${at} · kill: ...never confirms it`, false, (await audit()).includes('fleet_stop'));
      is(`${at} · kill: ...and is eaten — the screen under it did not move`, 'api-fix',
         await b.evaluate(() => ((document.querySelector('#app .sbar .nm') || {}).textContent || '').trim()));
    });
    await step(`${at} · remove-project confirm`, async () => {
      await fresh(size);
      await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`);
      await tap('#sheet .rows button', 'remove');
      const q = () => b.evaluate(() => /remove '.*' from projects\?/.test(((document.querySelector('.confirm') || {}).textContent || '')));
      is(`${at} · remove: the confirm bar asks`, true, !!(await until(q, 3000)));
      const card = await b.evaluate(() => [...document.querySelectorAll('.card.k-project .c-name')].map(n => n.textContent.trim())[1] || '');
      await tap('.card.k-project .c-name', card);
      is(`${at} · remove: a press on another project cancels it`, false, await q());
      is(`${at} · remove: ...never confirms it`, false, (await audit()).includes('fleet_project_remove'));
      is(`${at} · remove: ...and does not open that project either`, true,
         await b.evaluate(() => !!document.querySelector('.card.k-project') && !document.querySelector('#app .sbar')));
      // EATEN, asked of a control that SURVIVES the cancel's render. A card does not: the
      // render replaces it under the finger, so its pointerup never arrives whether or not
      // the press was eaten, and a row about a card cannot tell the two apart. The header's
      // ⋯ is a Preact node that stays put — let its click through and the sheet opens.
      await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`);
      await tap('#sheet .rows button', 'remove');
      await until(q, 3000);
      await tap(`${at === 'desk' ? '#side' : '#app'} > .hdr button.more`);
      is(`${at} · remove: a press on the ⋯ cancels it and opens nothing`, [false, false], [await q(), await sheetUp()]);
    });
  }
} catch (e) {
  is('sheets-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
}
done(0);
