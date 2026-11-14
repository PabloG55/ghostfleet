#!/usr/bin/env node
// test/helpers/explain-check.mjs — "Explícame": what waits on the person, and the plain-words
// explanation of one item, in a real browser at a phone's width and at a desk's.
//
//     node test/helpers/explain-check.mjs            rows for test/run.sh
//     SHOTS=<dir> node test/helpers/explain-check.mjs   ...and a PNG of each state, for a look
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// WHAT IT PINS, against web/fixtures/waiting.json in the fixture backend (web/api.js):
//   - every item for the person is a card, each numbered question its own, with an Explain
//     button on every one and the question's options on its card;
//   - Explain sends ONE request (fleet_ledger explain, for that item of that session), and the
//     answer opens in a SHEET on a phone (anchored to the bottom, full width) and a DIALOG at a
//     desk (centred), never inline in the list;
//   - the sheet says it is asking while the session has not answered, says the session is busy
//     and the request waits when it is mid-turn, and shows the explanation once it arrives;
//   - the item's options sit in the sheet, and choosing one answers the item: the reply goes to
//     the session quoting the item, the ledger marks it answered with that option, and it leaves
//     the list.
// Each was watched red, rebuilt from the mutated source: the sheet class taken off Modal (the
// phone row fails on its anchor and nothing else), the options dropped from the sheet (14 rows),
// the ledger's answer call removed from queue.jsx (4), and Explain sending nothing (10).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const SHOTS = process.env.SHOTS || '';
const done = (code) => { process.stdout.write(rows.join('\n') + (rows.length ? '\n' : '')); process.exit(code); };

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    b = await launch({ width: 1280, height: 800, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { process.stdout.write('no chrome\n'); process.exit(0); }
    throw e;
  }
  await b.call('Network.setBypassServiceWorker', { bypass: true });
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
  // The centre of the first `sel` inside a card whose text has `card`, whose own text starts with `text`.
  const centreOf = (sel, text = '', card = '') => b.evaluate((s, tx, cd) => {
    const scope = cd ? [...document.querySelectorAll('.foryou-card')].filter(c => c.textContent.includes(cd)) : [document];
    const n = scope.flatMap(c => [...c.querySelectorAll(s)]).find(x => !tx || x.textContent.trim().startsWith(tx));
    if (!n) return null;
    n.scrollIntoView({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, sel, text, card);
  async function tap(sel, text = '', card = '') {
    const p = await until(() => centreOf(sel, text, card), 4000);
    if (!p) return false;
    await press(p.x, p.y);
    return true;
  }
  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
  const audit = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().map(r => ({ tool: r.tool, args: r.args })));
  const cards = () => b.evaluate(() => [...document.querySelectorAll('.foryou-card')].map(c => ({
    head: (c.querySelector('h3') || {}).textContent || '',
    text: c.textContent,
    explain: [...c.querySelectorAll('.foryou-actions button')].some(x => x.textContent.trim() === 'Explain'),
    options: [...c.querySelectorAll('.foryou-options li')].map(x => x.textContent.trim()),
  })));
  const sheet = () => b.evaluate(() => {
    const m = document.querySelector('.scrim > .modal');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return {
      sheet: m.classList.contains('sheet'), title: ((m.querySelector('header h2') || {}).textContent || '').trim(),
      left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top),
      vw: innerWidth, vh: innerHeight,
      status: ((m.querySelector('.explain-wait[role=status]') || {}).textContent || '').trim(),
      text: ((m.querySelector('.explain-text') || {}).textContent || '').trim(),
      options: [...m.querySelectorAll('.explain-options button')].map(x => x.textContent.trim()),
    };
  });

  async function fresh(size) {
    touch = size.touch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: size.touch, ...(size.touch ? { maxTouchPoints: 5 } : {}) });
    await b.call('Page.navigate', { url: base + '/index.html' });
    await sleep(400);
    await b.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    await b.call('Page.navigate', { url: base + '/index.html' });
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => /^continue without a passkey/i.test(x.textContent.trim()));
      if (e) e.click();
      return !!document.querySelector('.app .main');
    }), 10000);
    await sleep(300);
    await b.evaluate(() => { location.hash = '#/queue'; return null; });
    await until(() => b.evaluate(() => document.querySelectorAll('.foryou-card').length >= 4), 8000);
    await sleep(300);
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }

  const Q1 = 'Should the cache fix ship before the release';
  const Q3 = 'Which store should billing-svc use';
  const sizes = [['phone', { w: 390, h: 844, touch: true }], ['desk', { w: 1280, h: 800, touch: false }]];
  for (const [at, size] of sizes) {
    await step(`${at} · the list`, async () => {
      await fresh(size);
      const c = await cards();
      is(`${at} · every item for the person is a card: three questions and a request held for them`, 4, c.length);
      is(`${at} · ...each with an Explain button`, 4, c.filter(x => x.explain).length);
      const q1 = c.find(x => x.text.includes(Q1)) || {};
      is(`${at} · a numbered question says which it is`, true, /question 1/.test(q1.head || ''));
      is(`${at} · ...and carries its options`, ['a) ship it now, in this release', 'b) hold it for the next release'], q1.options || []);
      await shot(`${at}-for-you`);
    });
    await step(`${at} · explain`, async () => {
      const before = (await audit()).length;
      is(`${at} · Explain was tapped`, true, await tap('.foryou-actions button', 'Explain', Q1));
      const s = await until(sheet, 3000);
      is(`${at} · it opens over the list`, true, !!s);
      const asked = (await audit()).slice(0, (await audit()).length - before).filter(r => r.tool === 'fleet_ledger');
      is(`${at} · ...having sent ONE explain request, for that item of that session`, '[{"project":"acme-web","session":"master","verb":"explain","id":"12"}]',
         JSON.stringify(asked.map(r => r.args)));
      is(`${at} · ...and while the session has not answered, it says it asked`, true, /^Asked master to explain it/.test((s && s.status) || ''));
      if (at === 'phone') {
        is('phone · it is a sheet: full width, anchored to the bottom', true, !!s && s.sheet && s.left === 0 && s.right === s.vw && Math.abs(s.bottom - s.vh) <= 1);
      } else {
        is('desk · it is a dialog: centred, not full width, not on the bottom edge', true, !!s && s.left > 40 && s.vw - s.right > 40 && s.vh - s.bottom > 20);
      }
      const got = await until(async () => { const x = await sheet(); return x && x.text ? x : null; }, 8000);
      is(`${at} · the explanation arrives in it`, true, /My recommendation: a\./.test((got && got.text) || ''));
      is(`${at} · ...with the item's options beside it`, ['a) ship it now, in this release', 'b) hold it for the next release'], (got && got.options) || []);
      is(`${at} · ...and never inline in the list`, false, (await cards()).some(x => /My recommendation/.test(x.text)));
      await shot(`${at}-explain-sheet`);
    });
    await step(`${at} · answer from the sheet`, async () => {
      const before = (await audit()).length;
      is(`${at} · an option was tapped`, true, await tap('.explain-options button', 'b)'));
      const gone = await until(async () => !(await sheet()), 4000);
      is(`${at} · choosing one closes the sheet`, true, !!gone);
      const all = await audit();
      const made = all.slice(0, all.length - before).reverse().map(r => r.tool === 'fleet_send'
        ? `send ${r.args.project}/${r.args.session}: ${r.args.prompt}` : `${r.tool} ${r.args.verb} ${r.args.id} ${r.args.option || ''}`.trim());
      is(`${at} · ...the session is told, quoting the item, then the ledger marks it answered with that option`,
         ['send acme-web/master: Re your ledger item 12: "Should the cache fix ship before the release, or wait for the next one?"\n\nb) hold it for the next release',
          'fleet_ledger answer 12 b'], made);
      const left = await until(async () => { const c = await cards(); return c.length === 3 ? c : null; }, 7000);
      is(`${at} · ...and it leaves the list, the others staying`, false, !left || left.some(x => x.text.includes(Q1)));
    });
    await step(`${at} · a busy session`, async () => {
      is(`${at} · Explain on an item whose session is mid-turn`, true, await tap('.foryou-actions button', 'Explain', Q3));
      const s = await until(async () => { const x = await sheet(); return x && /busy/.test(x.status) ? x : null; }, 4000);
      is(`${at} · the sheet says the session is busy and the request waits, interrupting nothing`, true,
         /master is busy, so the request waits for its current turn to end and nothing is interrupted/.test((s && s.status) || ''));
      is(`${at} · ...and the options are there to answer without waiting`, ['a) sqlite, a file beside the service', 'b) postgres, the database it already has'], (s && s.options) || []);
      if (at === 'phone') await shot('phone-explain-busy');
    });
  }
} catch (e) {
  is('explain-check ran to the end', 'yes', String((e && e.stack) || e).split('\n')[0].slice(0, 200));
} finally {
  try { if (b) await b.close(); } catch {}
  try { if (srv) await srv.close(); } catch {}
}
done(0);
