#!/usr/bin/env node
// place-nav-check — a reload keeps the tab's place, each tab its own, and a link opens its
// screen: the real client, in a real browser, against the fixture fleet.
//
//     node test/helpers/place-nav-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of staging — whose
// client restores from the one stored state and lands every unlock on Projects — the reload,
// two-tab and link rows go red, which is how each was watched before it was trusted. The
// history-depth rows hold on both: writing the address must not change how deep back goes.
//
// A REAL BROWSER because every claim is about one: what a reload does to `location`, what a
// second tab of the same origin does to localStorage, and where the platform's back goes
// from an entry the app pushed. A fake DOM has no reload and no second tab.
//
// FIXTURE MODE, so the lock screen is on every load (the fixture keeps no session across a
// reload — api.js), and every row passes through it: the place lands AFTER the unlock, and
// nothing of it is drawn before.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipRow = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

const srv = await serveDir(WEB);
let b = null;
try {
  try { b = await launch({ width: 390, height: 844, scale: 1, mobile: true }); }
  catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipRow('a place in the address', 'no chrome to reload in'); srv.close(); done(0); }
    throw e;
  }
  const errs = [];
  b.onEvent((m, p) => { if (m === 'Runtime.exceptionThrown') errs.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).split('\n')[0]); });

  async function until(cond, ms = 6000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }

  // One tab's handle: navigation, reading the page back, and its gestures.
  async function tab(t, { w = 390, h = 844, touch = true } = {}) {
    await t.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await t.call('Emulation.setTouchEmulationEnabled', { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) });
    await t.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Past the service worker: a cached shell from an earlier step would be a different client.
    await t.call('Network.enable');
    await t.call('Network.setBypassServiceWorker', { bypass: true });
    // WHERE THE APP IS, in words: `lock`, `projects/<tab>`, `grid:<project>`,
    // `session:<project>/<name>/<view>`, `reviews`, `review:<branch>`.
    const look = () => t.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const tx = (s) => ((q(s) || {}).textContent || '').trim();
      const lock = [...document.querySelectorAll('button')].some(x => x.textContent.trim().startsWith('continue without a passkey'));
      let where = '?';
      if (lock) where = 'lock';
      else if (q('#app .sbar .who .nm')) {
        const view = [...document.querySelectorAll('#app .sbar .seg button')].find(x => x.classList.contains('on'));
        where = `session:${tx('#app .sbar .who .scope')}/${tx('#app .sbar .who .nm')}/${view ? view.textContent.trim() : ''}`;
      } else {
        const sc = tx('#app > .hdr .scope');
        const on = [...document.querySelectorAll('#app .seg.tabs button.on')].map(x => x.textContent.trim().split(' ')[0])[0] || 'all';
        if (/^— projects/.test(sc)) where = `projects/${on}`;
        else if (/^— reviews/.test(sc)) where = 'reviews';
        else if (q('#app .rv-br')) where = `review:${tx('#app .rv-br')}`;
        else { const m = /\[[^:\]]*:([^\]]+)\]/.exec(sc); if (m) where = `grid:${m[1]}`; else where = sc || '?'; }
      }
      return { where, q: location.search + location.hash, href: location.href, hl: history.length,
               // anything of a session drawn while the lock is up
               leak: lock && !!(q('#app .sbar') || q('#app .chat') || q('#app .card')) };
    });
    const settle = async (pred, ms) => { await until(async () => { try { return pred(await look()); } catch { return false; } }, ms); return look(); };
    const navigate = async (u) => { await t.call('Page.navigate', { url: u }); await sleep(500); };
    const reload = async () => { await t.call('Page.reload', {}); await sleep(500); };
    const unlock = async () => {
      await until(() => t.evaluate(() => [...document.querySelectorAll('button')].some(x => x.textContent.trim().startsWith('continue without a passkey'))));
      await t.evaluate(() => { const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey')); if (e) e.click(); return null; });
      await settle(s => s.where !== 'lock' && s.where !== '?');
      await sleep(400);                    // the trail is pushed after the paint (afterPaint)
    };
    const slid = () => until(() => t.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
    const point = (sel, text) => t.evaluate((s, x) => {
      const n = [...document.querySelectorAll(s)].find(e => !x || e.textContent.trim() === x || e.textContent.trim().startsWith(x + ' '));
      if (!n) return null;
      n.scrollIntoView({ block: 'center' });
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 24) };
    }, sel, text);
    const tap = async (sel, text) => {
      await slid();
      const p = await point(sel, text);
      if (!p) throw new Error(`nothing to tap: ${sel} ${text}`);
      if (touch) {
        await t.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
        await t.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await t.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await t.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await t.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
      await sleep(300);
    };
    const card = async (name) => { await tap('#app .card .c-name', name); };
    const back = async () => { await slid(); await t.evaluate(() => { setTimeout(() => history.back(), 0); return null; }); await sleep(700); };
    return { t, look, settle, navigate, reload, unlock, tap, card, back };
  }
  // A clean origin: nothing stored, nothing in the history but a page before this one, so
  // "back left the app" has somewhere to go that is not the app.
  async function fresh(T, url) {
    await T.navigate(`${srv.base}/index.html`);
    await T.t.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    await T.navigate('about:blank');
    await T.navigate(url || `${srv.base}/index.html`);
  }
  const A = await tab(b);
  let s;

  // ══ a reload on a session screen stays there ═════════════════════════════════════════
  await step('reload', async () => {
    await fresh(A);
    await A.unlock();
    await A.card('acme-api');
    s = await A.settle(x => x.where === 'grid:acme-api');
    const hl0 = s.hl;
    await A.card('api-fix');
    s = await A.settle(x => x.where.startsWith('session:'));
    is('walking in names the session in the address', ['session:acme-api/api-fix/chat', '?screen=session&p=acme-api&s=api-fix'], [s.where, s.q]);
    is('...and pushes the one entry it always did', hl0 + 1, s.hl);
    await A.tap('#app .sbar .seg button', 'pane');
    s = await A.settle(x => x.where.endsWith('/pane'));
    is('the pane switch REPLACES the address, no new entry', ['?screen=session&p=acme-api&s=api-fix&view=pane', hl0 + 1], [s.q, s.hl]);
    await A.reload();
    s = await A.look();
    is('a reload shows the lock first, and none of the session under it', ['lock', false], [s.where, s.leak]);
    is('...with the place still in the address', '?screen=session&p=acme-api&s=api-fix&view=pane', s.q);
    await A.unlock();
    s = await A.look();
    is('...and the unlock lands on that session, in its pane', 'session:acme-api/api-fix/pane', s.where);
    await A.back();
    s = await A.settle(x => x.where === 'grid:acme-api');
    is('back from it is its grid', ['grid:acme-api', '?screen=grid&p=acme-api'], [s.where, s.q]);
    await A.back();
    s = await A.settle(x => x.where.startsWith('projects'));
    is('...then Projects', ['projects/all', '?screen=projects'], [s.where, s.q]);
  });

  // ══ a tab is not navigation ══════════════════════════════════════════════════════════
  await step('tab', async () => {
    s = await A.look();
    const hl0 = s.hl;
    await A.tap('#app .seg.tabs button', 'personal');
    s = await A.settle(x => x.where === 'projects/personal');
    is('a Projects tab is written to the address', ['projects/personal', '?screen=projects&tab=personal'], [s.where, s.q]);
    is('...by replacing it: back is still where it was', hl0, s.hl);
    await A.reload(); await A.unlock();
    s = await A.look();
    is('...and a reload keeps the tab', 'projects/personal', s.where);
  });

  // ══ a jump across the stack is not undone by its own address ════════════════════════
  // Ctrl-p from a session changes the screen at once and pops two entries with ONE
  // history.go(-2), which lands later. The screen is painted in between, and a paint that
  // rewrote the address then would write Projects into the SESSION's entry — the one being
  // left, so going forward to it and reloading opens Projects. Whether a given run would notice
  // depends on timing; the ORDER does not — no replaceState or pushState between a go() and
  // its popstate — so that is the claim, and then the effect: the next back leaves the app.
  await step('jump', async () => {
    await fresh(A);
    await A.unlock();
    await A.card('acme-api');
    await A.settle(x => x.where === 'grid:acme-api');
    await A.card('api-fix');
    await A.settle(x => x.where.startsWith('session:'));
    await A.t.evaluate(() => {
      const w = window; w.__gfRace = []; w.__gfPend = 0;
      const go = history.go.bind(history), rs = history.replaceState.bind(history), ps = history.pushState.bind(history);
      history.go = (n) => { w.__gfPend++; return go(n); };
      history.replaceState = (...a) => { if (w.__gfPend) w.__gfRace.push('replace ' + a[2]); return rs(...a); };
      history.pushState = (...a) => { if (w.__gfPend) w.__gfRace.push('push ' + a[2]); return ps(...a); };
      // capture: at the window, ahead of the app's own popstate listener
      addEventListener('popstate', () => { if (w.__gfPend) w.__gfPend--; }, true);
      return null;
    });
    await A.t.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
    await A.t.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
    s = await A.settle(x => x.where.startsWith('projects') && x.q === '?screen=projects');
    is('Ctrl-p from a session: Projects, and the address says so', ['projects/all', '?screen=projects'], [s.where, s.q]);
    is('...and nothing rewrote the address while its pop was on the way',
       [], await A.t.evaluate(() => window.__gfRace));
    await A.back();
    s = await A.look();
    is('...so the next back leaves the app', 'about:blank', s.href);
  });

  // ══ a full history: the browser has thrown the app's root away ════════════════════════
  // A tab's history is capped (50 entries in Chrome), and a full one prunes the oldest entry
  // its page pushed past WITHOUT A GESTURE before the oldest entry — which can be the app's
  // own root, so a jump that pops by navDepth lands on the page before the app. Built here on
  // purpose: fillers up to the cap, then the walk made by script (no user activation), and the
  // first row asks the browser whether the root really went, so a Chrome that stops pruning
  // this way says so instead of letting the rows below pass for nothing. A tab of its own,
  // because a full history would change what every later step's back means.
  await step('full history', async () => {
    const C = await tab(await b.newTab());
    await C.navigate('about:blank');
    for (let i = 0; i < 49; i++) { await C.t.call('Page.navigate', { url: `data:text/html,fill-${i}` }); await sleep(40); }
    await C.navigate(`${srv.base}/index.html`);
    await C.unlock();
    const open = (name) => C.t.evaluate((x) => {
      const n = [...document.querySelectorAll('#app .card .c-name')].find(e => e.textContent.trim() === x || e.textContent.trim().startsWith(x + ' '));
      const c = n && n.closest('.card');
      if (!c) return false;
      // untrusted pointer events: the app's tap, with no user activation behind it
      const r = c.getBoundingClientRect(), at = { bubbles: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, clientX: r.left + r.width / 2, clientY: r.bottom - 6 };
      c.dispatchEvent(new PointerEvent('pointerdown', at));
      c.dispatchEvent(new PointerEvent('pointerup', at));
      return true;
    }, name);
    await open('acme-api');
    await C.settle(x => x.where === 'grid:acme-api');
    await open('api-fix');
    await C.settle(x => x.where.startsWith('session:'));
    await sleep(400);                                  // the pushes land after the paint
    const h = await C.t.call('Page.getNavigationHistory', {});
    const ours = h.entries.filter(x => x.url.startsWith(srv.base)).map(x => new URL(x.url).searchParams.get('screen'));
    is('a full history walked without a gesture: the browser kept no root of the app', false, ours.includes('projects'));
    await C.t.evaluate(() => { window.__gfSamePage = 1; return null; });
    await C.t.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
    await C.t.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
    await sleep(800);
    s = await C.settle(x => x.where.startsWith('projects'));
    is('...Ctrl-p still lands on Projects, on this page and not the one before it',
       ['projects/all', '?screen=projects', 1], [s.where, s.q, await C.t.evaluate(() => window.__gfSamePage || 0)]);
    await C.back();
    s = await C.look();
    is('...and the next back leaves the app', true, /^data:text\/html,fill-/.test(s.href));
  });

  // ══ two tabs, two places ═════════════════════════════════════════════════════════════
  // One browser, so one localStorage: the stored state is whichever wrote last, and each tab
  // has to come back from its own address instead.
  await step('two tabs', async () => {
    await fresh(A);
    await A.unlock();
    await A.card('acme-api');
    await A.settle(x => x.where === 'grid:acme-api');
    await A.card('docs-pass');
    s = await A.settle(x => x.where.startsWith('session:'));
    is('tab 1 is on a session', 'session:acme-api/docs-pass/chat', s.where);
    const B = await tab(await b.newTab());
    await B.navigate('about:blank');
    await B.navigate(`${srv.base}/index.html`);
    await B.unlock();
    await B.tap('.rv-row', '');
    s = await B.settle(x => x.where === 'reviews');
    is('tab 2 is on Reviews', ['reviews', '?screen=reviews'], [s.where, s.q]);
    const stored = await B.t.evaluate(() => { try { return JSON.parse(localStorage.getItem('gf.last')).screen; } catch { return ''; } });
    is('...and it is the one the shared store remembers', 'reviews', stored);
    await A.reload(); await A.unlock();
    s = await A.look();
    is('tab 1 reloads to its own session, not to the store', ['session:acme-api/docs-pass/chat', '?screen=session&p=acme-api&s=docs-pass'], [s.where, s.q]);
    await B.reload(); await B.unlock();
    s = await B.look();
    is('tab 2 reloads to its own Reviews', ['reviews', '?screen=reviews'], [s.where, s.q]);
    try { await B.t.call('Page.close'); } catch {}
  });

  // ══ a link opens its screen, and back walks the trail a walk would have left ═════════
  await step('link: session', async () => {
    // tab=work in a browser with nothing stored: no cached projects to vouch for the tab yet
    await fresh(A, `${srv.base}/index.html?screen=session&tab=work&p=acme-api&s=api-fix`);
    s = await A.look();
    is('a link opens on the lock, and nothing of the session under it', ['lock', false], [s.where, s.leak]);
    const hl0 = s.hl;
    await A.unlock();
    s = await A.look();
    is('...then its session, the tab kept in the address', ['session:acme-api/api-fix/chat', '?screen=session&tab=work&p=acme-api&s=api-fix'], [s.where, s.q]);
    is('...over the two entries a walk from Projects would have pushed', hl0 + 2, s.hl);
    await A.back();
    s = await A.settle(x => x.where === 'grid:acme-api');
    is('back: its grid', ['grid:acme-api', '?screen=grid&tab=work&p=acme-api'], [s.where, s.q]);
    await A.back();
    s = await A.settle(x => x.where.startsWith('projects/work'));
    is('back: Projects, on the tab the link named', ['projects/work', '?screen=projects&tab=work'], [s.where, s.q]);
    await A.back();
    s = await A.look().catch(() => ({ href: '?' }));
    is('back: and only now out of the app', 'about:blank', s.href);
  });
  await step('link: master from Projects', async () => {
    await fresh(A, `${srv.base}/index.html?screen=session&p=acme-api&s=master&from=projects`);
    await A.unlock();
    s = await A.look();
    is('a master entered from Projects', 'session:acme-api/master/chat', s.where);
    await A.back();
    s = await A.settle(x => x.where.startsWith('projects'));
    is('...is one back from Projects', 'projects/all', s.where);
    await A.back();
    s = await A.look().catch(() => ({ href: '?' }));
    is('...and the next back leaves', 'about:blank', s.href);
  });
  await step('link: a run', async () => {
    await fresh(A, `${srv.base}/index.html?screen=review&profile=work&run=2026-03-05_14-02-11`);
    await A.unlock();
    s = await A.settle(x => x.where.startsWith('review:'));
    is('a link to a run opens the run', true, s.where.startsWith('review:'));
    await A.back();
    s = await A.settle(x => x.where === 'reviews');
    is('...back is the list', ['reviews', '?screen=reviews'], [s.where, s.q]);
    await A.back();
    s = await A.settle(x => x.where.startsWith('projects'));
    is('...then Projects', 'projects/all', s.where);
  });
  await step('link: missing session', async () => {
    // "you cannot be on a screen whose subject is missing": the same fall the stored state takes
    await fresh(A, `${srv.base}/index.html?screen=session&p=acme-api`);
    await A.unlock();
    s = await A.settle(x => x.where === 'grid:acme-api');
    is('a link to a session with no name lands on its grid', ['grid:acme-api', '?screen=grid&p=acme-api'], [s.where, s.q]);
  });

  // ══ the old ways in still work ═══════════════════════════════════════════════════════
  await step('#reviews', async () => {
    await fresh(A, `${srv.base}/index.html#reviews`);
    await A.unlock();
    s = await A.settle(x => x.where === 'reviews');
    is('#reviews still opens Reviews, and the address then says so', ['reviews', '?screen=reviews'], [s.where, s.q]);
    await A.back();
    s = await A.settle(x => x.where.startsWith('projects'));
    is('...one back from Projects, as before', 'projects/all', s.where);
  });
  await step('no place', async () => {
    // a bare address — the installed app's start_url — is the stored state's, as before:
    // and a login with nothing to land on lands on Projects (loggedIn), whatever was stored
    await fresh(A);
    await A.unlock();
    await A.card('acme-api');
    await A.settle(x => x.where === 'grid:acme-api');
    await A.navigate('about:blank');
    await A.navigate(`${srv.base}/index.html`);
    s = await A.look();
    is('a bare address opens on the lock', 'lock', s.where);
    await A.unlock();
    s = await A.look();
    is('...and its unlock lands on Projects, as before', 'projects/all', s.where);
  });
  is('no page errors along the way', [], errs);
} finally {
  try { if (b) await b.close(); } catch {}
  srv.close();
}
done(0);
