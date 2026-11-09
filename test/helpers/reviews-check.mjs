#!/usr/bin/env node
// reviews-check — the recorded flows a branch's run left behind are reviewed in the app:
// a Reviews row on Projects, one card per branch, the run with its video and chapters, and
// the verdict that `fleet-shots --check` reads.
//
//     node test/helpers/reviews-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of staging, which
// has no Reviews screen, every row about it goes red — which is how each was watched
// before it was trusted.
//
// A REAL BROWSER, for the same reason queue-check is one: what is being claimed is where
// things are drawn at 390 and at 1280, what a finger and a mouse do to them, and whether a
// tap on a chapter moves a <video>. A fake DOM has no video and no layout.
//
// ITS OWN SERVER, so the switch can be thrown: `OFF` answers the shots index 404, which is
// what fleet-serve answers with the `shots` switch off, and the client has to take that as
// "there is no such screen" — no row, no entry, and a #reviews link that lands on Projects.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from '../../lib/browser.mjs';
import { serveFile } from '../../lib/shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipRow = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

let OFF = false;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (OFF && rel === '/fixtures/shots.json') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, disabled: true }));
  }
  const p = path.join(WEB, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!path.resolve(p).startsWith(WEB)) { res.writeHead(403); return res.end(); }
  // Ranged, as fleet-serve and any real static host serve it: a <video> cannot seek a file
  // handed over whole, so without this the chapter rows would be testing the server.
  if (req.headers.range) return serveFile(req, res, p, TYPES[path.extname(p)] || 'application/octet-stream');
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
    b = await launch({ width: 1280, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipRow('the reviews screen', 'no chrome to tap in'); server.close(); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Past the service worker, or OFF never reaches the page: sw.js precaches shots.json.
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  const errs = [];
  b.onEvent((m, p) => { if (m === 'Runtime.exceptionThrown') errs.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).split('\n')[0]); });
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
    const row = document.querySelector('.rv-row');
    const vid = document.querySelector('#app video');
    const chs = [...document.querySelectorAll('#app .rv-ch')];
    return {
      duo: document.documentElement.classList.contains('duo'),
      main: t('#app > .hdr .scope'),
      side: t('#side .hdr .scope'),
      empty: !!document.querySelector('#app .duo-empty'),
      rows: document.querySelectorAll('.rv-row').length,
      rowText: row ? [...row.children].map(c => c.textContent.trim()).join(' ') : '',
      rowIn: row ? (row.closest('#side') ? 'side' : row.closest('#app') ? 'app' : '?') : '',
      // the branch cards, wherever the list is drawn
      branches: [...document.querySelectorAll('.rv-group > .card .c-name')].map(n => n.textContent.trim()),
      branchState: Object.fromEntries([...document.querySelectorAll('.rv-group')].map(g =>
        [((g.querySelector('.card .c-name') || {}).textContent || '').trim(), ((g.querySelector('.card .c-meta > :first-child') || {}).textContent || '').trim()])),
      sideSel: [...document.querySelectorAll('#side .rv-group > .card.sel .c-name')].map(n => n.textContent.trim()),
      old: document.querySelectorAll('.rv-old').length,
      more: t('.rv-more'),
      branch: t('#app .rv-br'),
      video: vid ? vid.getAttribute('src') || '' : '',
      ready: vid ? vid.readyState : -1,
      time: vid ? Math.round(vid.currentTime * 10) / 10 : -1,
      inline: vid ? vid.hasAttribute('playsinline') : false,
      chapters: chs.length,
      flagged: chs.map((c, i) => c.classList.contains('flag') ? i + 1 : 0).filter(Boolean),
      // what a reader sees of each tab: its fill, and whether it carries the warn dot
      tabLook: chs.map(c => [getComputedStyle(c).backgroundColor, getComputedStyle(c, '::after').content !== 'none']),
      on: chs.map((c, i) => c.classList.contains('on') ? i + 1 : 0).filter(Boolean),
      now: t('#app .rv-now'),
      steps: document.querySelectorAll('#app .rv-step').length,
      gate: t('#app .rv-gate .rv-gt'),
      saved: t('#app .rv-gate .rv-saved'),
      gateCls: ((document.querySelector('#app .rv-gate') || {}).className || '').replace('rv-gate', '').trim(),
      prov: t('#app .rv-prov'),
      // the verdict is pinned: its band is a sibling of the scroller, not inside it
      barPinned: !!document.querySelector('#app.shell > .rv-bar'),
      barBottom: (() => { const n = document.querySelector('#app .rv-bar'); return n ? Math.round(innerHeight - n.getBoundingClientRect().bottom) : -1; })(),
      // SIDEWAYS SCROLL: the page itself, and anything drawn past the right edge
      wide: document.scrollingElement.scrollWidth > innerWidth + 1
        || [...document.querySelectorAll('#app *, #side *')].some(n => { const r = n.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }),
      toast: t('#app .toast') || t('#side .toast'),
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };
  const centre = (q, text = '') => b.evaluate((sel, tx) => {
    const n = [...document.querySelectorAll(sel)].find(x => !tx || x.textContent.includes(tx));
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 24) } : null;
  }, q, text);
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
  const tapAt = async (p) => {
    if (!p) throw new Error('nothing there to tap');
    await slid();
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
  };
  const clickAt = async (p) => {
    if (!p) throw new Error('nothing there to click');
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(250);
  };
  // Typed for real: focus the field, then insert the text the way a keyboard does.
  const typeInto = async (q, idx, text) => {
    await b.evaluate((sel, i) => { const n = document.querySelectorAll(sel)[i]; n.scrollIntoView({ block: 'center' }); n.focus(); return null; }, q, idx);
    await b.call('Input.insertText', { text });
    await sleep(150);
  };
  const VK = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39, '`': 192 };
  async function press(key) {
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(150);
  }
  async function fresh({ w = 1280, h = 900, touch = false, hash = '', off = false } = {}) {
    OFF = off;
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    await goto('about:blank');
    await goto(base + '/index.html' + hash);
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')));
    if (!off && !hash) await until(() => b.evaluate(() => !!document.querySelector('.rv-row')), 4000);
    await sleep(300);
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }
  const PHONE = { w: 390, h: 844, touch: true };
  let s = null;

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE SWITCH: off is gone, not empty
  // ════════════════════════════════════════════════════════════════════════════════════
  await step('off', async () => {
    await fresh({ ...PHONE, off: true });
    s = await look();
    is('switch off: Projects draws no Reviews row', ['— projects', 0], [s.main, s.rows]);
    await fresh({ ...PHONE, off: true, hash: '#reviews' });
    s = await settle(x => /projects/.test(x.main));
    is('...and a #reviews link lands on Projects, with no list drawn', ['— projects', [], 0], [s.main, s.branches, s.rows]);
    await fresh({ off: true });
    s = await look();
    is('...nor at a desk', [true, 0], [s.duo, s.rows]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE PHONE
  // ════════════════════════════════════════════════════════════════════════════════════
  await step('phone: Projects', async () => {
    await fresh(PHONE);
    s = await look();
    is('phone: Projects draws ONE Reviews row', ['— projects', 1], [s.main, s.rows]);
    is('...naming the branches and how many wait on a review', 'reviews · 3 2 to review ›', s.rowText);
    is('...with nothing drawn past the right edge', false, s.wide);
  });

  await step('phone: the list', async () => {
    await fresh(PHONE);
    await tapAt(await centre('.rv-row'));
    s = await settle(x => /reviews/.test(x.main));
    is('a tap on the row opens Reviews, titled with its count', '— reviews · 3', s.main);
    // ONE CARD PER BRANCH, newest run first; the profile shows because two profiles have runs
    is('...one card per branch, the newest run first', ['api-fix', 'cache-keys', 'docs-pass'], s.branches);
    is("...each showing its newest run's state", { 'api-fix': 'unreviewed', 'cache-keys': '1 flagged', 'docs-pass': 'approved' }, s.branchState);
    is('...the older runs folded away', [0, '2 earlier runs'], [s.old, s.more]);
    await tapAt(await centre('.rv-more'));
    s = await settle(x => x.old === 2);
    is('...and a tap unfolds them', [2, 'hide 2 earlier'], [s.old, s.more]);
    is('...with nothing drawn past the right edge', false, s.wide);
  });

  await step('phone: a recorded run', async () => {
    await fresh(PHONE);
    await tapAt(await centre('.rv-row'));
    await settle(x => x.branches.length);
    await tapAt(await centre('.rv-group > .card', 'api-fix'));
    s = await settle(x => x.chapters > 0);
    is('a tap on a branch opens its newest run', ['— review', 'api-fix'], [s.main, s.branch]);
    is('...its video, inline (an iPhone otherwise takes it full screen)', [true, true], [/fixtures\/shots\/flow\.mp4$/.test(s.video), s.inline]);
    is('...one chapter per step, the step the run flagged marked', [4, [3], 4], [s.chapters, s.flagged, s.steps]);
    // CURRENT IS NOT FLAGGED. At 0:00 the first chapter is the current one, and the flagged
    // chapter is marked as a property, never drawn as the filled tab — the two once read alike.
    is('...at 0:00 the FIRST chapter is current, not the flagged one', [[1], '01'], [s.on, s.now.slice(0, 2)]);
    is('...drawn filled, unlike every other tab', true, !!s.tabLook[0] && s.tabLook.slice(1).every(t => t[0] !== s.tabLook[0][0]));
    is('...and the flagged tab carries the warn dot without the fill', [false, true, false, false, true],
       [s.tabLook[0][1], s.tabLook[2][1], s.tabLook[1][1], s.tabLook[3][1], s.tabLook[2][0] === s.tabLook[1][0]]);
    is('...its provenance', true, /7e41c09/.test(s.prov) && /\d+×\d+/.test(s.prov));
    is('...and the verdict pinned to the bottom of the screen', [true, true], [s.barPinned, s.barBottom >= 0 && s.barBottom < 40]);
    is('...unreviewed', ['warn', 'not reviewed — watch it, then approve or reject'], [s.gateCls, s.gate]);
    is('...with nothing drawn past the right edge', false, s.wide);

    // A TAP ON A CHAPTER PLAYS FROM THERE. The strip says so at once; the video says so
    // once it has loaded, which a Chrome built without H.264 never does.
    await tapAt(await centre('#app .rv-ch:nth-child(3)'));
    s = await settle(x => x.on[0] === 3);
    is('a tap on chapter 3 makes it the current one', [[3], true], [s.on, /^03/.test(s.now)]);
    s = await settle(x => x.ready > 0 && x.time >= 6, 4000);
    if (s.ready > 0) is('...and the video plays from where step 3 starts', true, s.time >= 6 && s.time < 9);
    else skipRow('the video seeks to the chapter', 'this Chrome cannot decode the H.264 fixture');

    // THE VERDICT AND ITS GATE: the owner's approve is a pass, flagged step or not.
    await tapAt(await centre('#app .rv-acts .go'));
    s = await settle(x => x.gateCls === 'ok');
    is('approve: the gate passes over a flagged chapter', ['ok', 'approved — fleet-shots --check passes this run'], [s.gateCls, s.gate]);
    await typeInto('#app .rv-step .rv-note', 2, 'the 404 is the empty-state copy, fixed in #14');
    s = await settle(x => x.gateCls === 'ok');
    is('...and an optional note on chapter 3 changes nothing', ['ok', 'approved — fleet-shots --check passes this run'], [s.gateCls, s.gate]);
    await sleep(900);   // past the typing debounce, so the write lands before back
    await b.evaluate(() => { history.back(); return null; });
    s = await settle(x => /reviews/.test(x.main) && x.branches.length);
    is('back: the branch card carries the new state', 'approved', s.branchState['api-fix']);
    await b.evaluate(() => { history.back(); return null; });
    s = await settle(x => /projects/.test(x.main) && x.rows === 1);
    is('...and Projects counts one fewer to review', 'reviews · 3 1 to review ›', s.rowText);
  });

  await step('phone: a run of stills', async () => {
    await fresh(PHONE);
    await tapAt(await centre('.rv-row'));
    await settle(x => x.branches.length);
    await tapAt(await centre('.rv-group > .card', 'cache-keys'));
    s = await settle(x => x.steps > 0 && /unreviewed/.test(x.gate));
    is('a run of stills: no video, a verdict per step', [-1, 0, 3], [s.ready, s.chapters, s.steps]);
    is('...two steps left to mark', ['warn', '2 unreviewed — mark each step'], [s.gateCls, s.gate]);
    await tapAt(await centre('#app .rv-acts button', 'mark the other'));
    s = await settle(x => /flagged/.test(x.gate));
    is('"mark the other 2 ok" leaves the step the run flagged owing a reason', '1 flagged step needs a reason', s.gate);
    await typeInto('#app .rv-step .rv-note', 2, 'the cache is cold on a fresh box; expected');
    s = await settle(x => x.gateCls === 'ok');
    is('...which a note supplies', 'approved — fleet-shots --check passes this run', s.gate);
    is('...with nothing drawn past the right edge', false, s.wide);
  });

  await step('phone: #reviews', async () => {
    await fresh({ ...PHONE, hash: '#reviews' });
    s = await settle(x => /reviews/.test(x.main));
    is('a #reviews link opens the list (fleet-shots serve prints one)', '— reviews · 3', s.main);
    await b.evaluate(() => { history.back(); return null; });
    s = await settle(x => /projects/.test(x.main));
    is('...one step above Projects', '— projects', s.main);
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // THE DESK: the list beside its run, as the queue sits beside Projects
  // ════════════════════════════════════════════════════════════════════════════════════
  await step('desk', async () => {
    await fresh();
    s = await look();
    is('desk: the row in the LEFT pane', [true, 'side', 1], [s.duo, s.rowIn, s.rows]);
    await clickAt(await centre('#side .rv-row'));
    s = await settle(x => /reviews/.test(x.main));
    is('a click opens Reviews in the RIGHT pane, Projects beside it', ['— reviews · 3', '— projects'], [s.main, s.side]);
    await clickAt(await centre('#app .rv-group > .card', 'api-fix'));
    s = await settle(x => x.chapters > 0);
    is('a click on a branch: the run on the right, the list moves left', ['— review', '— reviews · 3', 'api-fix'], [s.main, s.side, s.branch]);
    is('...and only the open run is lit in the list', ['api-fix'], s.sideSel);
    is('...with nothing drawn past the right edge', false, s.wide);
    await clickAt(await centre('#side .rv-group > .card', 'cache-keys'));
    s = await settle(x => x.branch === 'cache-keys');
    is('another branch from the list beside it swaps the run', [['cache-keys'], 3, 0], [s.sideSel, s.steps, s.chapters]);
    await press('q');
    s = await settle(x => /reviews/.test(x.main));
    is('q from a run: back to the list, Projects beside it', ['— reviews · 3', '— projects'], [s.main, s.side]);
    await press('q');
    s = await settle(x => x.empty);
    is('q again: Projects, the right pane empty', [true, '— projects'], [s.empty, s.side]);
  });

  await step('desk: the keys', async () => {
    await fresh({ hash: '#reviews' });
    s = await settle(x => /reviews/.test(x.main) && x.branches.length);
    await press('Enter');
    s = await settle(x => x.chapters > 0);
    is('desk: ⏎ opens the branch under the cursor', 'api-fix', s.branch);
    await press('ArrowRight');
    s = await settle(x => x.on.length);
    is('→ steps to the next chapter', [2], s.on);
    await press('a');
    s = await settle(x => /approved/.test(x.gate));
    is('a approves, and the flagged chapter does not hold it back', 'approved — fleet-shots --check passes this run', s.gate);
    await press('r');
    s = await settle(x => /rejected/.test(x.gate));
    is('r rejects', ['bad', 'rejected — --check refuses this run'], [s.gateCls, s.gate]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // ONE ANSWER TO "IS THIS RUN DONE": the client's state against the server's
  // ════════════════════════════════════════════════════════════════════════════════════
  // The phone computes a run's state the moment a verdict is tapped (and fixture mode
  // never asks a server at all), so its copy must say what lib/shots.mjs says, which is
  // what --check and the list are built from. Compared case by case.
  await step('parity', async () => {
    const { runState } = await import(pathToFileURL(path.join(ROOT, 'lib', 'shots.mjs')).href);
    const rec = { video: 'flow.mp4', steps: [{ n: 1 }, { n: 2 }, { n: 3, notes: ['GET /x answered 404'] }] };
    const still = { steps: [{ n: 1 }, { n: 2 }, { n: 3, notes: ['expected text not on the page: Ok'] }] };
    const CASES = [
      [rec, {}], [rec, { flow: { v: 'approve' } }], [rec, { flow: { v: 'approve' }, chapters: { 3: 'fine' } }],
      [rec, { flow: { v: 'reject', note: 'no' } }], [rec, { flow: { v: 'approve' }, chapters: { 3: '  ' } }],
      [still, {}], [still, { 1: { v: 'ok' } }], [still, { 1: { v: 'ok' }, 2: { v: 'ok' }, 3: { v: 'ok' } }],
      [still, { 1: { v: 'ok' }, 2: { v: 'ok' }, 3: { v: 'ok', note: 'why' } }], [still, { 2: { v: 'problem' } }],
      [still, { 1: { v: 'skip' }, 2: { v: 'ok' }, 3: { v: 'skip', note: 'later' } }],
    ];
    const client = await b.evaluate(async (cases) => {
      const api = await import(location.origin + '/api.js');
      return cases.map(([m, v]) => api.shotsState(m, v));
    }, CASES);
    const server = CASES.map(([m, v]) => runState(m, v));
    is("the phone's run state matches the server's, case by case", server, client);
  });

  is('no page threw', [], errs);
} finally {
  if (b) await b.close().catch(() => {});
  server.close();
}
done(0);
