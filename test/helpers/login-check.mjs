#!/usr/bin/env node
// login-check — where a login lands, and what a back swipe shows after one.
//
//     node test/helpers/login-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of the staging that
// preceded the fix, the rows about the landing and the history go red, which is how they were
// watched before they were trusted. The rows that staging already passed (a deep link, a
// resume) were watched red against copies of this client broken on purpose.
//
// TWO REPORTS FROM ONE PHONE. "When you log in it should always show you the main page": the
// client restored whatever screen it was left on, so a login an hour later opened a session
// nobody asked for. And "when you swipe back you see the login page for a second and then it
// takes you back": the restored screen's back trail was pushed at boot, while the lock screen
// was what was painted, and iOS previews an entry with the picture it took as the page left it.
//
// THE PREVIEW IS MODELLED, because headless Chrome draws no back-swipe preview of its own.
// WebKit's is a snapshot of an entry taken as the page leaves it — at a pushState, a back or a
// go — so a recorder installed before app.js tracks what each animation frame painted (the
// lock screen, the app, or nothing yet) and logs it beside every history call the app makes.
// An entry left while the lock screen (or nothing) was painted is an entry whose preview is the
// lock screen. The view transition's old snapshot is the same kind of picture, so it is logged
// too. Then a real back is taken and every frame of it is sampled, the preview first.
//
// Fixture mode, at 390x844 with touch and at 1600x900 with a mouse, and SERVER MODE against a
// fake fleet-serve for the two paths fixtures cannot reach: a reload that kept its session (no
// login, so it keeps its screen) and a relock — a token the server stopped honouring — followed
// by a passkey unlock, through a virtual authenticator, from inside a session.
import crypto from 'node:crypto';
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
const fx = (f) => JSON.parse(fs.readFileSync(path.join(WEB, 'fixtures', f), 'utf8'));
const until = async (f, ms = 8000) => { const t0 = Date.now(); let v = await f(); while (!v && Date.now() - t0 < ms) { await sleep(80); v = await f(); } return v; };

// ── the recorder, in every document before app.js runs ──────────────────────────────────
const RECORDER = `(() => {
  // Where this document's history starts: a launched app's first entry is its root, and a back
  // from there leaves the app (the tab here has an about:blank before it, which a phone does not).
  const at = () => (window.navigation && navigation.currentEntry ? navigation.currentEntry.index : history.length - 1);
  const R = window.__nav = { painted: 'none', log: [], frames: null, len0: history.length, idx0: at(), at };
  const what = () => document.querySelector('.lock') ? 'lock'
    : (document.getElementById('app') || {}).childElementCount ? 'app' : 'none';
  // A rAF callback runs just before its frame is painted, so this is what each frame showed.
  const tick = () => { R.painted = what(); if (R.frames) R.frames.push(R.painted); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const wrap = (o, m, op) => { const f = o[m].bind(o); o[m] = (...a) => { R.log.push({ op, painted: R.painted }); return f(...a); }; };
  wrap(history, 'pushState', 'push'); wrap(history, 'back', 'back'); wrap(history, 'go', 'go');
  if (typeof document.startViewTransition === 'function') wrap(document, 'startViewTransition', 'slide');
})();`;

// What the page is showing, read back from what is drawn and from what the app saved.
const look = (b) => b.evaluate(() => {
  let last = null; try { last = JSON.parse(localStorage.getItem('gf.last') || 'null'); } catch {}
  const R = window.__nav || { log: [], len0: 0 };
  return {
    lock: !!document.querySelector('.lock'),
    screen: last ? last.screen : '',
    session: ((document.querySelector('#app .sbar .nm') || {}).textContent || '').trim(),
    cards: document.querySelectorAll('.card .c-name').length,
    pushed: history.length - R.len0,
    depth: R.at ? R.at() - R.idx0 : -1,             // entries of ours below this one
    // every history call (and slide) made while the lock screen, or nothing yet, was painted
    underLock: R.log.filter(x => x.painted !== 'app').map(x => `${x.op}:${x.painted}`),
    log: R.log.map(x => `${x.op}:${x.painted}`),
  };
});
// A back, the way the system takes one: the preview first — the picture the entry below was
// left with, which is the last call's `painted` — then every frame until it has settled. An
// entry left before anything was painted counts as the lock screen: the app boots locked, so
// the first picture there is to take is the lock.
async function backFrames(b) {
  // Nothing of ours below: a back leaves the app (here, to the tab's about:blank), so there is
  // no frame of the app to sample — and the row that asked for one is red on what it reads.
  if ((await look(b)).depth <= 0) return { preview: 'none', frames: [], lockFrames: 0 };
  const preview = await b.evaluate(() => { const l = window.__nav.log; return l.length && l[l.length - 1].painted === 'app' ? 'app' : 'lock'; });
  await b.evaluate(() => { window.__nav.frames = []; history.back(); return null; });
  await sleep(900);
  const frames = await b.evaluate(() => { const f = window.__nav.frames; window.__nav.frames = null; return f; });
  return { preview, frames, lockFrames: [preview, ...frames].filter(f => f === 'lock').length };
}
// A resume from the background: hidden, then shown, as the visibilitychange the app listens to.
const resume = (b) => b.evaluate(async () => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 300));
  hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 900));
  return null;
});
const LAST = (screen, extra = {}) => JSON.stringify({ at: Math.floor(Date.now() / 1000), screen, project: 'acme-api', session: screen === 'session' ? 'api-fix' : null, view: 'chat', ...extra });

// ════════════════════════════════════════════════════════════════════════════════════
// FIXTURE MODE
// ════════════════════════════════════════════════════════════════════════════════════
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const serveStatic = (res, p) => {
  const f = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!path.resolve(f).startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(buf); });
};
const fixtureServer = http.createServer((req, res) => serveStatic(res, new URL(req.url, 'http://x').pathname));
await new Promise(r => fixtureServer.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fixtureServer.address().port}`;

let b = null;
try {
  try {
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('where a login lands', 'no chrome'); fixtureServer.close(); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  const bypass = () => b.evaluate(() => {
    const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
    if (e) e.click(); return !!e;
  });

  // The first project's card, pressed the way a person would: a finger, or a mouse.
  async function openCard(touch) {
    const c = await b.evaluate(() => {
      const n = document.querySelector('#side .card .c-name') || document.querySelector('#app .card .c-name');
      if (!n) return null;
      const r = n.closest('.card').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 18)) };
    });
    if (!c) return false;
    await until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000);
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] }); await sleep(40);
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    await sleep(300);
    return true;
  }
  // A cold open with `last` saved, at a size, on the lock screen. A hash goes by way of a blank
  // page, as a notification that launches the app does (a hash alone is no load).
  async function coldOpen({ w, h, touch }, last, hash = '') {
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate((l) => { try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('gf.last', l); } catch {} return null; }, last);
    await goto('about:blank');
    await goto(base + '/index.html' + hash);
    await until(() => b.evaluate(() => [...document.querySelectorAll('button')].some(x => x.textContent.trim().startsWith('continue without a passkey'))));
  }

  for (const [tag, size] of [['phone', { w: 390, h: 844, touch: true }], ['desk', { w: 1600, h: 900, touch: false }]]) {
    // ── (a) a login lands on Projects, whatever was saved ────────────────────────────
    await coldOpen(size, LAST('session'));
    let s = await look(b);
    is(`${tag}: the lock screen is up over a saved session (the screen a login used to reopen)`, [true, 'session'], [s.lock, s.screen]);
    await bypass();
    s = await until(async () => { const x = await look(b); return !x.lock && x.cards > 0 && x.screen === 'projects' && !x.session ? x : null; }, 5000) || await look(b);
    is(`${tag}: a login lands on Projects, not on the saved session`, ['projects', '', false], [s.screen, s.session, s.lock]);
    await sleep(400);
    s = await look(b);
    // ── (c) and the lock screen is nowhere in the history ───────────────────────────
    is(`${tag}: ...at the root of the history, with nothing pushed behind it (a back leaves the app)`, [0, 0], [s.depth, s.pushed]);
    is(`${tag}: ...and no history entry left while the lock screen (or nothing) was painted`, [], s.underLock);
    // Where staging was: a trail under the restored screen, each entry left under the lock.
    let bk = s.depth > 0 ? await backFrames(b) : { lockFrames: 0 };
    is(`${tag}: a back after the login shows no lock-screen frame`, 0, bk.lockFrames);
    // a step in and a back out, after the login: the preview is the screen that was left
    await coldOpen(size, LAST('session'));
    await bypass();
    await until(async () => (await look(b)).cards > 0, 5000);
    await sleep(400);
    const opened = await openCard(size.touch);
    s = await until(async () => { const x = await look(b); return x.screen !== 'projects' ? x : null; }, 4000) || await look(b);
    is(`${tag}: a card on Projects opens a screen a step in`, [true, true], [opened, s.screen !== 'projects' && s.depth >= 1]);
    await sleep(500);
    bk = await backFrames(b);
    s = await until(async () => { const x = await look(b); return x.screen === 'projects' ? x : null; }, 3000) || await look(b);
    is(`${tag}: back from it previews Projects and never the lock screen`, ['app', 0], [bk.preview, bk.lockFrames]);
    is(`${tag}: ...and lands on Projects`, 'projects', s.screen);

    // ── (b) a tapped notification still goes where it said ───────────────────────────
    await coldOpen(size, LAST('session'), '#waiting');
    await bypass();
    s = await until(async () => { const x = await look(b); return x.screen === 'queue' ? x : null; }, 5000) || await look(b);
    is(`${tag}: a tapped "waiting on you" lands on the queue, over a saved session`, ['queue', ''], [s.screen, s.session]);
    await sleep(500);
    s = await look(b);
    is(`${tag}: ...one entry above Projects`, [1, 1], [s.depth, s.pushed]);
    is(`${tag}: ...pushed (and slid) from a painted Projects, never from the lock screen`, [], s.underLock);
    bk = await backFrames(b);
    s = await until(async () => { const x = await look(b); return x.screen === 'projects' ? x : null; }, 3000) || await look(b);
    is(`${tag}: back from the queue is Projects, with no lock-screen frame`, ['projects', 0], [s.screen, bk.lockFrames]);

    // ── (d) a resume from the background is not a login ─────────────────────────────
    await coldOpen(size, LAST('projects'));
    await bypass();
    await until(async () => (await look(b)).cards > 0, 5000);
    await sleep(400);
    await openCard(size.touch);
    const before = await until(async () => { const x = await look(b); return x.screen !== 'projects' ? x : null; }, 4000) || await look(b);
    await sleep(500);
    await resume(b);
    s = await look(b);
    is(`${tag}: a resume from the background keeps the screen it was on`, [true, before.screen, before.session, false],
       [before.screen !== 'projects', s.screen, s.session, s.lock]);
  }
} catch (e) {
  is('login-check ran', 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  fixtureServer.close();
  b = null;
}

// ════════════════════════════════════════════════════════════════════════════════════
// SERVER MODE: a reload that kept its session, and a relock unlocked with a passkey
// ════════════════════════════════════════════════════════════════════════════════════
// The fake answers the reads from the fixtures, mints a token for any assertion (the
// signature is the real daemon's to check — serve-local.mjs proves that half), and can be
// told to stop honouring the token it minted, which is a relock from the client's side.
const b64u = (buf) => Buffer.from(buf).toString('base64url');
async function fakeDaemon() {
  const st = { reject: false, token: 'login-check-token', asserts: 0 };
  const json = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(j)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (!p.startsWith('/api/')) return serveStatic(res, p);
    if (p === '/api/health') return json(res, 200, { ok: true, version: 'login-check' });
    if (p === '/api/auth/challenge') return json(res, 200, { challenge: b64u(crypto.randomBytes(32)), rp_id: 'localhost', user: { id: 'phone', name: 'phone' }, enrolling: false, ttl: 120 });
    if (p === '/api/auth/assert') {
      let body = ''; req.on('data', d => { body += d; });
      return req.on('end', () => { st.asserts++; st.reject = false; st.token = 'login-check-token-' + st.asserts; json(res, 200, { token: st.token, expires_at: Math.floor(Date.now() / 1000) + 900 }); });
    }
    const auth = String(req.headers.authorization || '');
    if (st.reject || auth !== `Bearer ${st.token}`) return json(res, 401, { ok: false, text: 'no session' });
    if (p === '/api/projects') return json(res, 200, { ...fx('projects.json'), jarvis_enabled: false });
    if (p === '/api/grid') return json(res, 200, fx('grid-acme-api.json'));
    if (p === '/api/session') {
      let ms = []; try { ms = fx(`session-acme-api-${u.searchParams.get('session')}.json`).messages; } catch {}
      return json(res, 200, { session: u.searchParams.get('session'), total: ms.length, messages: ms.slice(-20), next_before: null, queue: [] });
    }
    if (p === '/api/waiting') return json(res, 200, { items: [] });
    return json(res, 404, { ok: false, text: 'not in the fake' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { st, port: server.address().port, close: () => { try { server.closeAllConnections?.(); server.close(); } catch {} } };
}
let d = null;
try {
  d = await fakeDaemon();
  // localhost, for WebAuthn: an IP address is not a valid rp id (local-enrol-check's mapping).
  const origin = `http://localhost:${d.port}`;
  b = await launch({ width: 390, height: 844, scale: 1, mobile: true, args: ['--host-resolver-rules=MAP localhost 127.0.0.1'] });
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  // The phone's passkey, held by a virtual platform authenticator that answers by itself.
  await b.call('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await b.call('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } });
  const credId = crypto.randomBytes(16);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await b.call('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: credId.toString('base64'), isResidentCredential: true, rpId: 'localhost',
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    userHandle: Buffer.from('phone').toString('base64'), signCount: 0 } });
  // The installed app, reloaded by its own service worker inside a live session: a token this
  // page process minted, the passkey it enrolled, and the session it was reading.
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try {
    sessionStorage.setItem('gf.session:' + location.origin, JSON.stringify({ t: 'login-check-token', exp: Date.now() / 1000 + 900 }));
    localStorage.setItem('gf.cred:' + location.origin, ${JSON.stringify(b64u(credId))});
    if (!sessionStorage.getItem('lc.seeded')) { sessionStorage.setItem('lc.seeded', '1'); localStorage.setItem('gf.last', ${JSON.stringify(LAST('session'))}); }
  } catch {} })();` });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await b.call('Page.navigate', { url: origin + '/' });
  let s = await until(async () => { const x = await look(b); return !x.lock && x.session ? x : null; }, 10000) || await look(b);
  is('server: a reload that kept its session is not a login — it reopens the session it was on', ['session', 'api-fix', false], [s.screen, s.session, s.lock]);
  await sleep(500);
  s = await look(b);
  is('server: ...with its back trail (grid, Projects) behind it', 2, s.pushed);
  is('server: ...pushed once the session was painted, not under the lock screen', [], s.underLock);
  // Now the server stops honouring the token: the next read is a 401, and the app locks.
  d.st.reject = true;
  const locked = await until(async () => (await look(b)).lock, 9000);
  is('server: a token the server stopped honouring locks the app, in the session', true, !!locked);
  // The unlock: the automatic attempt, or the button if the browser wanted a tap.
  const t0 = Date.now();
  let unlocked = false;
  while (!unlocked && Date.now() - t0 < 10000) {
    unlocked = !(await look(b)).lock;
    if (!unlocked) {
      await b.evaluate(() => { const e = [...document.querySelectorAll('button')].find(x => /^unlock with /.test(x.textContent.trim())); if (e) e.click(); return null; });
      await sleep(400);
    }
  }
  s = await until(async () => { const x = await look(b); return !x.lock && x.screen === 'projects' && x.cards > 0 ? x : null; }, 6000) || await look(b);
  is('server: a passkey unlock from inside a session lands on Projects', ['projects', '', false, true], [s.screen, s.session, s.lock, d.st.asserts >= 1]);
  await sleep(800);
  s = await look(b);
  // Its trail is still there, as forward entries; what matters is that it was unwound to the
  // root from a painted Projects — so the entries above hold Projects, and none is below.
  is('server: ...at the root of the history, the session\'s trail unwound', 0, s.depth);
  is('server: ...and unwound from a painted Projects, never under the lock screen', ['go:app'], s.log.slice(-1));
} catch (e) {
  if (/no chrome/i.test(String(e && e.message))) skipGroup('where a passkey unlock lands', 'no chrome');
  else is('login-check server mode ran', 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (d) d.close();
}
done(0);
