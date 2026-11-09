#!/usr/bin/env node
// test/helpers/automations-check.mjs — the automations screens, in a real browser, at the two
// sizes they are used at: touch at 390x844 and a mouse and keys at 1280x900.
//
//     node test/helpers/automations-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. A copy with one thing broken in it is how each
// row was watched go red; the bundle is the built web/screens.js, so that is what gets broken.
//
// IN SERVER MODE, AGAINST A STAND-IN DAEMON. The fixture backend answers 404 for this screen,
// which the client reads as "the switch is off", so fixture mode cannot draw it at all. The
// stand-in is what lets a row ask the two questions that matter here and that no screenshot
// answers: what was actually POSTed, and when. A proposal from the sentence builder must reach
// the daemon only after a person saves it, and a save that needs a passkey must not be sent
// without one. What it holds is placeholder data.
//
// WHAT IT CANNOT BE IS A PHONE. There is no authenticator here, so the passkey rows prove the
// refusal path and not the ceremony; lib/automations.mjs's own group holds the daemon's half.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

// ── the stand-in daemon ──────────────────────────────────────────────────────────────────
const nowS = () => Math.floor(Date.now() / 1000);
const FLEET = [
  { name: 'acme-api', sessions: [{ name: 'master', lead: true }, { name: 'api-fix', lead: false }, { name: 'docs-pass', lead: false }] },
  { name: 'acme-web', sessions: [{ name: 'master', lead: true }, { name: 'checkout', lead: false }] },
  { name: 'toolbox', sessions: [{ name: 'search-index', lead: false }] },
  { name: 'billing-svc', sessions: [{ name: 'master', lead: true }] },
];
const WEEKDAYS = { type: 'schedule', mode: 'days', at: '09:00', days: [1, 2, 3, 4, 5], date: '', minutes: 60 };
const LONG = 'a nightly clean-up with a long name that will not fit on one line of a phone at all';
const populated = () => { const t = nowS(); return {
  ok: true, fleet: FLEET,
  automations: [
    { id: 'a1', name: 'morning review', enabled: true, nextRun: t + 3600 * 14, lastRun: { at: t - 3600 * 10, ok: true }, trigger: WEEKDAYS,
      steps: [{ action: 'wake', project: 'acme-api', session: 'api-fix' }, { action: 'send', project: 'acme-api', session: 'master', prompt: 'review what is open' }] },
    { id: 'a2', name: 'tell me when a worker needs me', enabled: true, nextRun: null, lastRun: { at: t - 1200, ok: false },
      trigger: { type: 'event', event: 'need-you', project: 'acme-web', session: '*', cooldown: 10 }, steps: [{ action: 'notify', text: '{session} needs you in {project}' }] },
    { id: 'a3', name: LONG, enabled: false, nextRun: null, trigger: { type: 'schedule', mode: 'every', minutes: 720, at: '10:00', days: [], date: '' },
      steps: [{ action: 'stop', project: 'toolbox', session: 'search-index' }, { action: 'spawn', project: 'toolbox', name: 'search-index-{date}', prompt: 'rebuild the index', branch: '' }] },
    { id: 'a4', name: 'once before the release', enabled: true, nextRun: t + 86400 * 12, trigger: { type: 'schedule', mode: 'once', date: '2031-03-20', at: '07:30', days: [], minutes: 60 },
      steps: [{ action: 'wait', minutes: 5 }, { action: 'send', project: 'billing-svc', session: 'master', prompt: 'tag the release' }] },
  ],
  runs: [
    { at: t - 1200, auto: 'a2', name: 'tell me when a worker needs me', status: 'error', trigger: 'acme-web/checkout needs you', steps: [{ action: 'notify', what: 'tell me', ok: false, text: 'no space left on device' }] },
    { at: t - 86400, auto: 'a1', name: 'morning review', status: 'skipped', trigger: 'weekdays at 09:00', text: 'the daemon was not running at that time' },
  ],
  notices: [
    { id: 'n1', at: t - 1200, auto: 'a2', name: 'tell me when a worker needs me', kind: 'bad', seen: false, text: '"tell me when a worker needs me" failed at step 1: no space left on device' },
    { id: 'n2', at: t - 86400, auto: 'a1', name: 'morning review', kind: 'warn', seen: false, text: '"morning review" did not run at 09:00: fleet-serve was not running then. It was not run late.' },
  ],
}; };
const empty = () => ({ ok: true, fleet: FLEET, automations: [], runs: [], notices: [] });
// What the sentence builder proposes. One that stays within a plain save, one with a step the
// passkey guards, and one that names a project the fleet does not have, which is what a model does.
const PLAIN = { name: 'morning share-out', enabled: true, trigger: WEEKDAYS, steps: [{ action: 'send', project: 'acme-api', session: 'master', prompt: 'share out what is open' }] };
const GUARDED = { ...PLAIN, name: 'stop the docs pass', steps: [{ action: 'wake', project: 'acme-api', session: 'api-fix' }, { action: 'send', project: 'acme-api', session: 'master', prompt: 'share out' }, { action: 'stop', project: 'acme-api', session: 'docs-pass' }] };
const UNKNOWN = { ...PLAIN, name: 'a target that is gone', steps: [{ action: 'wake', project: 'acme-gone', session: 'old-worker' }] };

const st = {};
function reset({ state = 'populated', delay = 0, draft = PLAIN } = {}) {
  Object.assign(st, { off: state === 'off', fail: state === 'error' ? 500 : 0, delay, draft, draftFail: '', refuse: '', log: [], reads: 0, gets: 0, late: '',
    data: state === 'empty' ? empty() : populated() });
}
reset();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(j)); };
const SIGNED_IN = `<script>try{sessionStorage.setItem('gf.session:'+location.origin,JSON.stringify({t:'check-token',exp:Date.now()/1000+3600}));}catch(e){}</script>`;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith('/api/')) {
    const f = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      if (path.basename(f) === 'index.html') buf = String(buf).replace('<head>', '<head>' + SIGNED_IN);
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  }
  let text = '';
  req.on('data', c => { text += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch {}
    if (req.method === 'POST') st.log.push({ path: p, body, assertion: req.headers['x-fleet-assertion'] || null });
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/projects') {
      const pj = JSON.parse(fs.readFileSync(path.join(WEB, 'fixtures', 'projects.json'), 'utf8'));
      st.reads++;
      if (st.late) pj.projects = [...pj.projects, { ...pj.projects[0], name: st.late }];
      return json(res, 200, { ...pj, jarvis_enabled: false, automations_enabled: !st.off, automations_unseen: st.off ? 0 : st.data.notices.filter(n => !n.seen).length });
    }
    if (p === '/api/settings') return json(res, 200, { global_nudge: false, sessions: {} });
    if (p === '/api/waiting') return json(res, 200, { ok: true, waiting: [] });
    if (p === '/api/usage') return json(res, 200, { ok: true });
    if (p.startsWith('/api/automations') && st.off) return json(res, 404, { ok: false, text: 'not here' });
    if (p === '/api/automations' && req.method === 'GET') {
      st.gets++;
      if (st.fail) return json(res, st.fail, { ok: false, text: 'the read failed' });
      return setTimeout(() => json(res, 200, st.data), st.delay);
    }
    if (p === '/api/automations/draft') {
      if (st.draftFail) return json(res, 502, { ok: false, text: st.draftFail });
      return json(res, 200, { ok: true, reply: `This does what you said: ${st.draft.name}.`, automation: st.draft });
    }
    if (p === '/api/automations/seen') { st.data.notices.forEach(n => { n.seen = true; }); return json(res, 200, { ok: true }); }
    if (p === '/api/automations/run') return json(res, 200, { ok: true, text: 'done', steps: [] });
    if (p === '/api/automations/delete') { st.data.automations = st.data.automations.filter(a => a.id !== body.id); return json(res, 200, { ok: true }); }
    if (p === '/api/automations') {
      if (st.refuse) return json(res, 400, { ok: false, text: st.refuse });
      const a = { ...body.automation, id: body.automation.id || 'new-1' };
      const i = st.data.automations.findIndex(x => x.id === a.id);
      if (i >= 0) st.data.automations[i] = a; else st.data.automations.push(a);
      return json(res, 200, { ok: true, automation: a });
    }
    return json(res, 404, { ok: false, text: 'not in this check' });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── the bundle says what it holds ────────────────────────────────────────────────────────
// A build can exit 0 and emit none of the screen (CLAUDE.md), and every check of the file's
// existence then passes on nothing. So: names only the SOURCE of this screen defines.
const bundle = fs.readFileSync(path.join(WEB, 'screens.js'), 'utf8');
for (const name of ['AutomationsScreen', 'autos-open', 'not in the fleet now', 'replace the steps with this']) {
  is(`the built bundle holds the screen: ${name}`, true, bundle.includes(name));
}

let b = null;
try {
  try {
    b = await launch({ width: 1280, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the automations screens', 'no chrome to tap in'); server.close(); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });

  async function until(cond, ms = 6000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(60); v = await cond(); }
    return v;
  }
  let touch = false;
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(120));
  // The element, by selector and optionally by its exact words: the one a person would aim at.
  const where = (q, words) => b.evaluate((q, words) => {
    const n = [...document.querySelectorAll(q)].find(x => x.offsetParent !== null && (words == null || x.textContent.trim() === words));
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, q, words);
  const hit = async (q, words) => {
    await slid();
    const p = await where(q, words);
    if (!p) return false;
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await sleep(180);
    return true;
  };
  const VK = { Enter: 13 };
  async function press(key) {
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(150);
  }
  // Typed for real, so it arrives the way a person's does, and replaces what the field held.
  const type = async (q, words) => {
    const there = await b.evaluate((q) => { const n = document.querySelector(q); if (!n) return false; n.focus(); n.select && n.select(); return true; }, q);
    if (!there) throw new Error(`nothing to type into: ${q}`);
    await b.call('Input.insertText', { text: words });
    await sleep(100);
  };
  const look = () => b.evaluate(() => {
    const t = (q) => ((document.querySelector(q) || {}).textContent || '').trim();
    const all = (q) => [...document.querySelectorAll(q)].filter(n => n.offsetParent !== null);
    return {
      scope: t('#app > .hdr .scope'),
      cards: all('#app .autos-card').length,
      skel: all('#app .card.skel').length,
      empty: t('#app .autos-empty h3'),
      emptyText: t('#app .autos-empty p'),
      alert: t('#app .autos-err'),
      failed: t('#app .autos-empty[role=alert] p'),
      toast: t('#app .toast'),
      text: (document.querySelector('#app') || {}).textContent || '',
      buttons: all('#app button').map(n => n.textContent.trim()),
    };
  });
  const settle = async (pred, ms = 6000) => { await until(async () => pred(await look()), ms); return look(); };
  const isOn = (q) => b.evaluate((q) => { const n = document.querySelector(q); return n ? n.getAttribute('aria-checked') : null; }, q);
  const posts = (p) => st.log.filter(r => r.path === p);

  const PHONE = { tag: 'phone', w: 390, h: 844, touch: true };
  const DESK = { tag: 'desk', w: 1280, h: 900, touch: false };
  async function fresh(size, opts) {
    reset(opts);
    touch = size.touch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: size.touch, ...(size.touch ? { maxTouchPoints: 5 } : {}) });
    // A cold open: the app comes back to the screen it was left on (web/place.js), which is a row of
    // its own below and would otherwise be every row's starting point.
    await b.call('Page.navigate', { url: base + '/index.html' });
    await sleep(150);
    await b.evaluate(() => { try { localStorage.clear(); } catch {} return null; });
    await b.call('Page.navigate', { url: 'about:blank' });
    await sleep(50);
    st.reads = 0;
    await b.call('Page.navigate', { url: base + '/index.html' });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')), 8000);
    // The menu's entry is decided by the first answer, and cards can be drawn before it from what
    // the last visit left. A person opening the menu that early sees it without the entry too.
    await until(() => st.reads > 0, 8000);
    await sleep(300);
  }
  const openMenu = async () => { await hit('.hdr .more'); await until(() => b.evaluate(() => !!document.querySelector('#sheet button')), 2000); };
  const menuWords = () => b.evaluate(() => [...document.querySelectorAll('#sheet button')].map(n => n.textContent.trim()));
  const openList = async () => {
    await openMenu();
    const p = await b.evaluate(() => { const n = [...document.querySelectorAll('#sheet button')].find(x => /^automations/.test(x.textContent.trim())); if (n) n.click(); return !!n; });
    await until(() => b.evaluate(() => /automations/.test(((document.querySelector('#app > .hdr .scope') || {}).textContent || ''))), 3000);
    await slid();
    return p;
  };

  // ── off means gone ─────────────────────────────────────────────────────────────────────
  await fresh(PHONE, { state: 'off' });
  await openMenu();
  is('off: no way in from the menu', false, (await menuWords()).some(w => /^automations/.test(w)));

  await fresh(PHONE);
  await openList();
  await settle(s => s.cards > 0);
  st.off = true;
  const left = await settle(s => s.scope !== '— automations', 12000);
  is('off while the screen is open: the next read leaves it', ['— projects', 0], [left.scope, left.cards]);

  for (const size of [PHONE, DESK]) {
    const T = size.tag;

    // ── the states that are not the list ─────────────────────────────────────────────────
    await fresh(size, { delay: 2500 });
    await openList();
    const loading = await look();
    is(`${T}: a read in flight draws the shape of the list`, 3, loading.skel);
    is(`${T}: ...and the one action waits for it`, true, await b.evaluate(() => { const n = document.querySelector('#app .autos-bar .go'); return !!n && n.disabled; }));
    const barWhileLoading = await b.evaluate(() => Math.round(document.querySelector('#app .autos-bar').getBoundingClientRect().top));
    const arrived = await settle(s => s.cards > 0, 5000);
    is(`${T}: ...and the list takes its place`, [0, 4], [arrived.skel, arrived.cards]);
    is(`${T}: ...without moving the bar`, barWhileLoading, await b.evaluate(() => Math.round(document.querySelector('#app .autos-bar').getBoundingClientRect().top)));

    await fresh(size, { state: 'error' });
    await openList();
    const failed = await settle(s => !!s.failed);
    is(`${T}: a failed read says so, in words`, true, /fleet-serve answered with an error/.test(failed.failed));
    is(`${T}: ...and not with a request path`, false, /\/api\//.test(failed.text));
    st.fail = 0;
    // Asked at once, or the row proves only that the next poll came round.
    const getsBefore = st.gets;
    await hit('#app .autos-empty button', 'try again');
    is(`${T}: ...try again asks at once`, true, await until(() => st.gets > getsBefore, 700));
    is(`${T}: ...and try again recovers`, 4, (await settle(s => s.cards > 0)).cards);

    await fresh(size, { state: 'empty' });
    await openList();
    const none = await settle(s => !!s.empty);
    is(`${T}: nothing yet says what one is`, ['no automations yet', true], [none.empty, /trigger and some steps/.test(none.emptyText)]);
    await hit('#app .autos-bar button', 'new automation');
    is(`${T}: ...and the way to make one opens the editor`, '— new automation', (await settle(s => s.scope === '— new automation')).scope);

    // ── the list ─────────────────────────────────────────────────────────────────────────
    await fresh(size);
    await openList();
    await settle(s => s.cards > 0);
    // The list snaps to its cards, and a block with no snap point of its own is scrolled past: at
    // phone size the notices sat above the top edge, on a screen whose whole point is telling you.
    is(`${T}: what needs a look is in view on opening`, 'in view', await b.evaluate(() => {
      const n = document.querySelector('#app .autos-block'), c = document.querySelector('#app .cards.autos');
      if (!n || !c) return 'not drawn';
      const r = n.getBoundingClientRect(), p = c.getBoundingClientRect();
      return r.top >= p.top - 1 && r.top < p.bottom ? 'in view' : `top ${Math.round(r.top)} of ${Math.round(p.top)}..${Math.round(p.bottom)}`;
    }));
    is(`${T}: nothing runs past the side of the screen`, [], await b.evaluate(() => {
      const out = [];
      const de = document.documentElement;
      if (de.scrollWidth > innerWidth) out.push(`page ${de.scrollWidth}`);
      for (const q of ['#app', '#app .cards.autos']) { const n = document.querySelector(q); if (n && n.scrollWidth > n.clientWidth + 1) out.push(`${q} ${n.scrollWidth}/${n.clientWidth}`); }
      return out;
    }));
    is(`${T}: a row has one control besides opening it`, [2, 2, 2, 2], await b.evaluate(() => [...document.querySelectorAll('#app .autos-card')].map(c => c.querySelectorAll('button').length)));
    const listNow = await look();
    is(`${T}: run and delete are not on the list`, [false, false], [listNow.buttons.includes('run now'), listNow.buttons.includes('delete')]);
    is(`${T}: a long name ends in an ellipsis, not under the switch`, ['ellipsis', true], await b.evaluate((name) => {
      const n = [...document.querySelectorAll('#app .autos-open')].find(x => x.textContent.trim() === name);
      const sw = n.closest('.c-top').querySelector('[role=switch]');
      return [getComputedStyle(n).textOverflow, n.getBoundingClientRect().right <= sw.getBoundingClientRect().left + 1];
    }, LONG));
    is(`${T}: a one-off's date is in words, not as stored`, false, /2031-03-20/.test(listNow.text));
    is(`${T}: ...and it names the year when that is not this one`, true, /once, .*2031 at 07:30/.test(listNow.text));
    is(`${T}: a switch is named for its automation and says its state`, ['morning review', 'true'], await b.evaluate(() => { const n = document.querySelector('#app .autos-card [role=switch]'); return [n.getAttribute('aria-label'), n.getAttribute('aria-checked')]; }));
    is(`${T}: a skipped run says what happened in words`, true, /skipped/.test(listNow.text) && /not running at that time/.test(listNow.text));

    if (size.touch) {
      // The rows' own hit area is the card, so the stretched name is measured there.
      const small = () => b.evaluate(() => [...document.querySelectorAll('#app .autos button:not(.autos-open), #app .autos-bar button, #app .autos input, #app .autos select, #app .autos textarea, #app .autos summary')]
        .filter(n => n.offsetParent !== null)
        .map(n => { const r = n.getBoundingClientRect(); return { n: (n.getAttribute('aria-label') || n.textContent || n.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter(x => x.w < 44 || x.h < 44));
      is('phone: every control on the list is big enough for a thumb', [], await small());
      await hit('#app .autos-open', 'morning review');
      await settle(s => s.scope === '— edit automation');
      is('phone: ...and in the editor', [], await small());
      is('phone: a field is big enough that iOS does not zoom into it', [], await b.evaluate(() => [...document.querySelectorAll('#app .autos input, #app .autos select, #app .autos textarea')]
        .filter(n => parseFloat(getComputedStyle(n).fontSize) < 16).map(n => n.tagName)));
      await hit('#app .autos-acts button', 'cancel');
      await settle(s => s.scope === '— automations');
    }

    // The whole card opens it, and the switch does not.
    await hit('#app .autos-card .autos-steps');
    is(`${T}: a tap anywhere on a card opens it`, '— edit automation', (await settle(s => s.scope === '— edit automation')).scope);
    await hit('#app .autos-acts button', 'cancel');
    await settle(s => s.scope === '— automations');

    // Tapped in its middle this proves little: the knob paints above the stretched name whatever the
    // switch does, and a thumb lands anywhere in the 44px round it.
    await where('#app .autos-card [role=switch]');
    is(`${T}: the whole of the switch's target is the switch, not the card behind it`, 4, await b.evaluate(() => {
      const r = document.querySelector('#app .autos-card [role=switch]').getBoundingClientRect();
      // The middle of each side: a button's rounded corner is not its target in any browser.
      return [[2, r.height / 2], [r.width - 2, r.height / 2], [r.width / 2, 2], [r.width / 2, r.height - 2]]
        .filter(([x, y]) => document.elementFromPoint(r.left + x, r.top + y)?.closest('[role=switch]')).length;
    }));
    await hit('#app .autos-card [role=switch]');
    const flipped = await settle(s => s.scope === '— automations');
    await until(() => posts('/api/automations').length > 0, 2000);
    is(`${T}: the switch saves it off, there on the list`, ['— automations', false], [flipped.scope, (posts('/api/automations')[0] || { body: { automation: {} } }).body.automation.enabled]);
    is(`${T}: ...and shows it off`, 'false', await isOn('#app .autos-card [role=switch]'));

    // Switching on what can start or stop sessions is the save that asks for the passkey.
    st.log = [];
    await hit(`#app .autos-card [aria-label="${LONG}"]`);
    const noKey = await settle(s => /passkey/.test(s.toast), 3000);
    is(`${T}: no passkey: switching on what needs one sends nothing`, 0, posts('/api/automations').length);
    is(`${T}: ...says why`, true, /passkey/.test(noKey.toast));
    is(`${T}: ...and it stays off`, 'false', await isOn(`#app .autos-card [aria-label="${LONG}"]`));

    await hit('#app .autos-head button', 'mark as seen');
    is(`${T}: mark as seen clears it at once and tells the daemon`, [false, 1], [(await look()).text.includes('needs a look'), posts('/api/automations/seen').length]);

    // ── the editor ───────────────────────────────────────────────────────────────────────
    await fresh(size);
    await openList();
    await settle(s => s.cards > 0);
    await hit('#app .autos-open', 'morning review');
    await settle(s => s.scope === '— edit automation');
    const pinned = () => b.evaluate(() => { const r = document.querySelector('#app .autos-bar').getBoundingClientRect(); return { inView: r.bottom <= innerHeight + 1 && r.top > 0, top: Math.round(r.top), scrolls: !!document.querySelector('#app .cards .autos-bar') }; });
    const pin = await pinned();
    is(`${T}: save is pinned, outside what scrolls`, [true, false], [pin.inView, pin.scrolls]);
    await b.evaluate(() => { const c = document.querySelector('#app .cards'); c.scrollTop = c.scrollHeight; return null; });
    await sleep(80);
    is(`${T}: ...and stays where it was at the end of the form`, pin.top, (await pinned()).top);

    // One control on a step until it is asked for.
    is(`${T}: a step shows one control until asked`, [1, 1], await b.evaluate(() => [...document.querySelectorAll('#app .autos-head')].filter(h => /^\d+\./.test(h.textContent.trim())).map(h => h.querySelectorAll('button').length)));
    is(`${T}: ...and no arrows or remove before that`, false, (await look()).buttons.some(w => ['move up', 'move down', 'remove'].includes(w)));
    await hit('#app [aria-label="actions for step 1"]');
    const { buttons } = await look();
    is(`${T}: asking shows them, and says it is open`, ['true', true], [
      await b.evaluate(() => document.querySelector('#app [aria-label="actions for step 1"]').getAttribute('aria-expanded')),
      ['move up', 'move down', 'remove'].every(w => buttons.includes(w))]);
    is(`${T}: the first step cannot move up`, true, await b.evaluate(() => document.querySelector('#app [data-move="0:up"]').disabled));
    await hit('#app [data-move="0:down"]');
    is(`${T}: moving a step takes it down the list`, ['2. wake'], await b.evaluate(() => [...document.querySelectorAll('#app .autos-head h3')].map(h => h.textContent.trim()).filter(w => /wake/.test(w))));
    is(`${T}: ...and focus goes with it, so the next press lands on the same step`, '1:up', await b.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-move')) || (document.activeElement || {}).tagName));
    is(`${T}: ...and nothing has been sent`, 0, posts('/api/automations').length);
    await hit('#app .autos-step-acts button', 'remove');
    is(`${T}: removing one leaves focus on the form`, true, await b.evaluate(() => !!document.activeElement && document.activeElement.closest('.autos-add') !== null));
    await hit('#app .autos-acts button', 'cancel');
    await settle(s => s.scope === '— automations');

    // Run is of what is saved.
    await hit('#app .autos-open', 'morning review');
    await settle(s => s.scope === '— edit automation');
    const runNow = () => b.evaluate(() => { const n = [...document.querySelectorAll('#app .autos-line button')].find(x => x.textContent.trim() === 'run now'); return n ? n.disabled : null; });
    is(`${T}: run now is here, for what is saved`, false, await runNow());
    await type('#app .autos-field input[type=text]', 'morning review, edited');
    is(`${T}: ...and waits when the form holds more than that`, [true, true], [await runNow(), /Save your changes first/.test((await look()).text)]);

    // A refusal comes back to the form, with what was typed.
    st.refuse = 'that name is taken by something else';
    await hit('#app .autos-acts button', 'save');
    const refused = await settle(s => !!s.alert, 3000);
    is(`${T}: a refused save says why beside the button`, 'that name is taken by something else', refused.alert);
    is(`${T}: ...stays open`, '— edit automation', refused.scope);
    is(`${T}: ...and keeps what was typed`, 'morning review, edited', await b.evaluate(() => document.querySelector('#app .autos-field input[type=text]').value));
    await type('#app .autos-field input[type=text]', 'morning review, again');
    is(`${T}: ...and the next keystroke clears the complaint`, '', (await look()).alert);
    st.refuse = '';
    await hit('#app .autos-acts button', 'save');
    is(`${T}: the save that lands goes back to the list`, '— automations', (await settle(s => s.scope === '— automations')).scope);
    is(`${T}: ...and the row says the new name at once`, true, (await look()).buttons.includes('morning review, again'));

    // Delete costs two taps, and the first one is not the one that does it.
    await hit('#app .autos-open', 'morning review, again');
    await settle(s => s.scope === '— edit automation');
    await hit('#app .autos-line button', 'delete');
    is(`${T}: the first tap on delete sends nothing`, 0, posts('/api/automations/delete').length);
    await hit('#app .autos-line button', 'keep it');
    is(`${T}: ...and it can be taken back`, true, (await look()).buttons.includes('delete'));
    await hit('#app .autos-line button', 'delete');
    await hit('#app .autos-line button', 'delete it');
    await until(() => posts('/api/automations/delete').length > 0, 2000);
    is(`${T}: the second one does it`, ['a1'], posts('/api/automations/delete').map(r => r.body.id));
    is(`${T}: ...and lands on the list`, '— automations', (await settle(s => s.scope === '— automations')).scope);

    // ── asking for it ────────────────────────────────────────────────────────────────────
    await fresh(size, { draft: GUARDED });
    await openList();
    await settle(s => s.cards > 0);
    await hit('#app .autos-open', 'morning review');
    await settle(s => s.scope === '— edit automation');
    const barTop = (await pinned()).top;
    await hit('#app .autos-seg button', 'ask for it');
    is(`${T}: the tab does not move the bar`, barTop, (await pinned()).top);
    is(`${T}: run and delete are not under the composer`, [false, false], await b.evaluate(() => { const w = [...document.querySelectorAll('#app button')].map(n => n.textContent.trim()); return [w.includes('run now'), w.includes('delete')]; }));
    is(`${T}: asking waits for a sentence`, true, await b.evaluate(() => [...document.querySelectorAll('#app .autos-compose button')].some(n => n.disabled)));
    is(`${T}: a save here is not the primary: it keeps the steps it had`, false, await b.evaluate(() => [...document.querySelectorAll('#app .autos-acts button')].some(n => n.textContent.trim() === 'save' && n.classList.contains('go'))));
    await type('#app .autos-compose textarea', 'every weekday, stop the docs pass');
    await hit('#app .autos-compose button', 'ask');
    const proposed = await settle(s => /This does what you said/.test(s.text), 3000);
    is(`${T}: the proposal spells out every step it would take`, 3, await b.evaluate(() => document.querySelectorAll('#app .autos-proposal .autos-steps > li').length));
    is(`${T}: ...the last of them by name`, true, /stop docs-pass \(acme-api\)/.test(proposed.text));
    is(`${T}: ...says a save will ask for the passkey`, true, /saving it asks for your passkey/.test(proposed.text));
    is(`${T}: ...and nothing has reached the automations`, 0, posts('/api/automations').length);
    is(`${T}: ...the sentence went to the draft, and only there`, 1, posts('/api/automations/draft').length);
    is(`${T}: ...and the box is ready for the next one`, '', await b.evaluate(() => document.querySelector('#app .autos-compose textarea').value));
    await hit('#app .autos-proposal button', 'replace the steps with this');
    await settle(s => /switched on/.test(s.text), 2000);
    is(`${T}: taking it puts the steps in the form`, ['1. wake', '2. send a prompt', '3. stop'], await b.evaluate(() => [...document.querySelectorAll('#app .autos-head h3')].map(h => h.textContent.trim())));
    is(`${T}: ...and still nothing is saved`, 0, posts('/api/automations').length);
    await hit('#app .autos-acts button', 'save');
    const unkeyed = await settle(s => !!s.alert, 3000);
    is(`${T}: no passkey: saving a proposal that stops a session sends nothing`, 0, posts('/api/automations').length);
    is(`${T}: ...says why, beside the button`, true, /passkey/.test(unkeyed.alert));

    // What a model proposed that the fleet does not have must read as that, not as a blank.
    await fresh(size, { draft: UNKNOWN });
    await openList();
    await settle(s => s.cards > 0);
    await hit('#app .autos-bar button', 'new automation');
    await settle(s => s.scope === '— new automation');
    await hit('#app .autos-seg button', 'ask for it');
    await type('#app .autos-compose textarea', 'wake the old worker');
    await hit('#app .autos-compose button', 'ask');
    await settle(s => /This does what you said/.test(s.text), 3000);
    await hit('#app .autos-proposal button');
    await settle(s => /switched on/.test(s.text), 2000);
    is(`${T}: a project the fleet does not have says so`, ['acme-gone (not in the fleet now)', 'old-worker (not in the fleet now)'], await b.evaluate(() => [...document.querySelectorAll('#app .autos-block .autos-field select')].map(n => (n.selectedOptions[0] || {}).textContent).filter(w => /not in the fleet/.test(w || ''))));

    // A failed draft gives the sentence back.
    await fresh(size);
    await openList();
    await settle(s => s.cards > 0);
    await hit('#app .autos-open', 'morning review');
    await settle(s => s.scope === '— edit automation');
    await hit('#app .autos-seg button', 'ask for it');
    st.draftFail = 'the model did not answer';
    await type('#app .autos-compose textarea', 'a sentence worth keeping');
    await hit('#app .autos-compose button', 'ask');
    const draftNo = await settle(s => /the model did not answer/.test(s.text), 3000);
    is(`${T}: a failed draft says so in the conversation`, true, /the model did not answer/.test(draftNo.text));
    is(`${T}: ...and the sentence is back in the box`, 'a sentence worth keeping', await b.evaluate(() => document.querySelector('#app .autos-compose textarea').value));
    is(`${T}: ...and out of the conversation, so asking again does not send it twice`, 0, await b.evaluate(() => document.querySelectorAll('#app .autos-msg.user').length));
    await hit('#app .autos-seg button', 'steps');
    await hit('#app .autos-seg button', 'ask for it');
    is(`${T}: going to the steps and back keeps the conversation`, true, /the model did not answer/.test((await look()).text));
  }

  // ── keys, at a desk ────────────────────────────────────────────────────────────────────
  // Before this screen had keys of its own they fell through to Projects underneath: a ⏎ on the
  // automations list opened a project, with nothing on screen to say why.
  await fresh(DESK);
  await openList();
  await settle(s => s.cards > 0);
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('Enter');
  is('desk: ⏎ on the list does not open a project behind it', '— automations', (await look()).scope);
  await press('n');
  is('desk: n starts a new one', '— new automation', (await settle(s => s.scope === '— new automation', 2000)).scope);
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('q');
  is('desk: a bare q in the editor does not throw the form away', '— new automation', (await look()).scope);
  await type('#app .autos-field input[type=text]', 'q');
  is('desk: ...and in a field it is a letter', 'q', await b.evaluate(() => document.querySelector('#app .autos-field input[type=text]').value));
  await hit('#app .autos-acts button', 'cancel');
  await settle(s => s.scope === '— automations');
  await b.evaluate(() => { document.activeElement && document.activeElement.blur(); return null; });
  await press('q');
  is('desk: q on the list backs out of it', 0, (await settle(s => s.cards === 0, 2000)).cards);

  // In two panes Projects is beside this screen, and nothing else reads it while this one is open.
  await fresh(DESK);
  await openList();
  await settle(s => s.cards > 0);
  st.late = 'late-arrival';
  is('desk: the Projects list beside it keeps moving', true, await until(() => b.evaluate(() => [...document.querySelectorAll('#side .card .c-name')].some(n => n.textContent.trim() === 'late-arrival')), 12000));

  // ── coming back to it ─────────────────────────────────────────────────────────────────
  // A relaunch restores the screen it was left on. It did that here with no trail behind it, so the
  // first swipe back left the app, and with no read of Projects, so the menu beside it had no way
  // back in. An installed app launches its start address with no query, hence the plain path.
  const relaunch = async (url = '/index.html') => {
    await b.call('Page.navigate', { url: 'about:blank' });
    await sleep(50);
    await b.call('Page.navigate', { url: base + url });
    await sleep(500);
  };
  await fresh(PHONE);
  await openList();
  await settle(s => s.cards > 0);
  await sleep(200);
  await relaunch();
  is('phone: a relaunch comes back to the list', ['— automations', 4], await (async () => { const s = await settle(x => x.cards > 0); return [s.scope, s.cards]; })());
  // A swipe, not the header's button: that one knows where to go without any history, and a swipe
  // with nothing behind it leaves the app. Here "behind it" is about:blank, so the miss is visible.
  let behind;
  try {
    await b.evaluate(() => { history.back(); return null; });
    await sleep(400);
    behind = (await settle(s => s.scope === '— projects', 3000)).scope;
  } catch { behind = 'left the app'; }
  is('phone: ...with the trail back to Projects, not out of the app', '— projects', behind);

  await fresh(PHONE);
  await openList();
  await settle(s => s.cards > 0);
  await hit('#app .autos-open', 'morning review');
  await settle(s => s.scope === '— edit automation');
  await relaunch();
  is('phone: a relaunch from the editor is the list: a draft is not kept', '— automations', (await settle(s => s.cards > 0)).scope);

  await fresh(PHONE);
  await openList();
  await settle(s => s.cards > 0);
  await sleep(200);
  st.off = true;
  await relaunch();
  is('phone: off, a relaunch that would come back here lands on Projects', '— projects', (await settle(s => s.scope === '— projects', 4000)).scope);

  await fresh(DESK);
  await openList();
  await settle(s => s.cards > 0);
  await sleep(200);
  is('desk: the address names the screen', '?screen=automations', await b.evaluate(() => location.search.replace(/&.*/, '')));
  await relaunch('/index.html?screen=automations');
  is('desk: and a reload of it comes back', ['— automations', 4], await (async () => { const s = await settle(x => x.cards > 0); return [s.scope, s.cards]; })());
  await until(() => b.evaluate(() => !!document.querySelector('#side .hdr .more')), 3000);
  await until(() => st.reads > 0, 8000);
  await sleep(300);
  await openMenu();
  is('desk: ...with the way back in, in the menu beside it', true, (await menuWords()).some(w => /^automations/.test(w)));

  // ── back, on a phone ───────────────────────────────────────────────────────────────────
  await fresh(PHONE);
  await openList();
  await settle(s => s.cards > 0);
  await hit('#app .autos-open', 'morning review');
  await settle(s => s.scope === '— edit automation');
  await hit('#app > .hdr .back');
  is('phone: back from the editor goes to the list', '— automations', (await settle(s => s.scope === '— automations', 3000)).scope);
  await hit('#app > .hdr .back');
  is('phone: back from the list goes to Projects', '— projects', (await settle(s => s.scope === '— projects', 3000)).scope);
} finally {
  if (b) { try { await b.close(); } catch {} }
  server.close();
}
done(0);
