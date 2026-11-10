#!/usr/bin/env node
// test/helpers/phone-check.mjs — the phone app in a real browser: web/ui's screens behind the
// passkey lock, at a phone's width and a narrower one.
//
//     node test/helpers/phone-check.mjs [web-dir]          fixture mode, every screen
//     node test/helpers/phone-check.mjs --served <base>    the lock, against a running fleet-serve
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing. `web-dir`
// defaults to this checkout's web/; a copy with one thing broken in it is how each row was
// watched going red.
//
// WHAT IT MEASURES, and why each is here rather than in pwa-check.mjs:
//   - THE LOCK decides what it offers from the probe, and the bypass must never be offered on a
//     page served BY the daemon (the --served mode, against the suite's own fleet-serve).
//   - EVERY SCREEN DRAWS, with no page error, no native <select> (web/ui's own pickers only: a
//     native one is iOS's wheel, a second design inside the first) and no sideways scroll at 390
//     and at 320 — the page never moves sideways, and wide content scrolls inside its own box.
//   - THE DRAWER holds the projects, under a heading per profile and per paired machine.
//   - THE LEAD is offered no stop, rename or pause, and this server's refused verbs (label,
//     schedule) are not offered at all.
//   - A POLL DOES NOT TAKE THE KEYBOARD AWAY: the composer keeps its node, its focus and its
//     text across the 5 s refresh. The old client rebuilt the page on a timer and closed the
//     keyboard on people mid-sentence; Preact keeps the node, and this is the measurement.
//   - THE KEYBOARD GEOMETRY (web/ui/viewport.js) against a visual viewport this file shrinks
//     itself: headless Chrome has no on-screen keyboard, so a stand-in object takes the
//     platform's place before any module runs, and the CSS half is pinned in pwa-check.mjs.
//   - THE OWNER'S MUSIC: nothing on the way through the screens claims the audio session. The
//     old client paused whatever the phone was playing on the first touch; the audio APIs are
//     stubbed and every call recorded.
import fs from 'node:fs';
import path from 'node:path';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const served = argv[0] === '--served' ? argv[1] : '';
const WEB = path.resolve(!served && argv[0] ? argv[0] : path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// Installed before any of the page's own code, in every document: a visual viewport this file
// can shrink, and a recorder on every API that claims the audio session.
const STUBS = `(() => {
  const vv = new EventTarget(); let H = null, T = 0;
  Object.defineProperties(vv, {
    height: { get: () => (H == null ? innerHeight : H) }, width: { get: () => innerWidth },
    offsetTop: { get: () => T }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    pageTop: { get: () => T }, pageLeft: { get: () => 0 } });
  try { Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true }); } catch {}
  window.__vv = (h, top = 0) => { H = h; T = top; vv.dispatchEvent(new Event('resize')); };
  const log = window.__audio = [];
  const note = (what) => log.push(what);
  for (const k of ['AudioContext', 'webkitAudioContext']) {
    const C = window[k]; if (!C) continue;
    window[k] = function (...a) { note(k); return new C(...a); }; window[k].prototype = C.prototype;
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { note('play'); return play.call(this); };
  try { const s = window.speechSynthesis; if (s) { const sp = s.speak.bind(s); s.speak = (u) => { note('speak'); return sp(u); }; } } catch {}
  try { const md = navigator.mediaDevices; if (md) { const g = md.getUserMedia.bind(md); md.getUserMedia = (c) => { note('getUserMedia'); return g(c); }; } } catch {}
  try { if (navigator.audioSession) { const a = navigator.audioSession; Object.defineProperty(a, 'type', { set: (v) => note('audioSession=' + v), get: () => 'auto' }); } } catch {}
})();`;

const errors = [];
let b = null, srv = null;
async function open(w, h) {
  b = await launch({ width: w, height: h, scale: 2, mobile: true });
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').split('\n')[0]);
  });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });
}
const until = async (fn, ...a) => {
  for (let i = 0; i < 150; i++) { const v = await b.evaluate(fn, ...a).catch(() => null); if (v) return v; await sleep(100); }
  return null;
};
const texts = (sel) => b.evaluate((s) => [...document.querySelectorAll(s)].map(x => x.textContent.trim()), sel);
const clickText = (sel, re) => b.evaluate((s, r) => {
  const x = [...document.querySelectorAll(s)].find(n => new RegExp(r, 'i').test(n.textContent));
  if (x) x.click(); return !!x;
}, sel, re);

try {
  if (served) {
    // ── against a running fleet-serve: the lock offers enrolment, never the way past it ──
    await open(390, 844);
    await b.call('Page.navigate', { url: served.replace(/\/$/, '') + '/' });
    const card = await until(() => !!document.querySelector('.auth-card .stack'));
    is('the lock is drawn once the probe answers', true, !!card);
    const notes = (await texts('.gate-notes p')).join(' | ');
    is('...naming the server it found', true, notes.includes(served.replace(/\/$/, '')));
    is('...and that a 401 is what proved it', true, /\(401\)/.test(notes));
    is('...and not claiming demo data', false, /Demo data/.test(notes));
    const btns = (await texts('.auth-card button')).join(' | ');
    is('it does NOT offer the fixture bypass', false, /without a passkey/i.test(btns));
    is('...nor "look again", which is for fixtures', false, /Look for the server again/.test(btns));
    const passkeys = await b.evaluate(() => typeof PublicKeyCredential !== 'undefined');
    if (passkeys) {
      is('it offers to enrol, with the code field', true, !!(await until(() => !!document.querySelector('.auth-card input[autocomplete="one-time-code"]'))));
      is('...and not a bare "register a passkey"', false, /Register a passkey/.test(btns));
      is('...saying what the window is', true, !!(await until(() => /enrolment window|one-time code/i.test(document.querySelector('.auth-card .stack p')?.textContent || ''))));
    }
    is('no page error', '', errors.join(' | '));
  } else {
    srv = await serveDir(WEB);
    await open(390, 844);
    await b.call('Page.navigate', { url: srv.base + '/' });

    // ── the lock, in fixture mode ──────────────────────────────────────────────
    is('the lock is drawn', true, !!(await until(() => !!document.querySelector('.auth-card'))));
    const bypass = await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
    is('...and once the probe answers, demo data offers the way past it', true, !!bypass);
    const lockBtns = (await texts('.auth-card button')).join(' | ');
    is('...and to look for the server again', true, /Look for the server again/.test(lockBtns));
    is('...and says the data is not real', true, (await texts('.gate-notes p')).some(x => /Demo data/.test(x)));
    is('...and asks for no enrolment code', 0, await b.evaluate(() => document.querySelectorAll('.auth-card input[autocomplete="one-time-code"]').length));
    // The product's name, as the team app draws it: lowercase, in the pixel face.
    const brand = await b.evaluate(() => { const n = document.querySelector('.auth-card .brand b'); return n ? { t: n.textContent, f: getComputedStyle(n).fontFamily } : null; });
    is('the name is ghostfleet, lowercase', 'ghostfleet', brand?.t);
    is('...in the pixel face', true, /Silkscreen/i.test(brand?.f || ''));
    is('...which is loaded, not a fallback', true, await b.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Silkscreen'); }));
    // "Which server?" opens the connection picker on the lock itself — web/ui's, not a native one.
    await clickText('.auth-card .link-btn', 'Which server');
    is('the lock can say which server', true, !!(await until(() => !!document.querySelector('.auth-card [role=combobox]'))));
    is('...with no native <select> on the lock', 0, await b.evaluate(() => document.querySelectorAll('select').length));
    // The language toggle redraws the lock in Spanish, and back.
    await clickText('.auth-card .lang-toggle button', '^es$');
    is('the lock speaks Spanish', true, !!(await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /Seguir sin llave de acceso/.test(x.textContent)))));
    await clickText('.auth-card .lang-toggle button', '^en$');
    await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));

    const histBefore = await b.evaluate(() => history.length);
    await clickText('.auth-card button', 'without a passkey');
    is('past the lock is the app', true, !!(await until(() => !!document.querySelector('.app'))));
    // A login lands on the main page, and REPLACES the entry: one pushed while the lock was what
    // was painted is previewed AS the lock by iOS's back swipe.
    is('...on the main page', '#/', await b.evaluate(() => location.hash));
    is('...without an entry for the back swipe to show the lock', histBefore, await b.evaluate(() => history.length));
    is('demo data says so across the top', true, !!(await until(() => /Demo data/.test(document.querySelector('.demo-bar')?.textContent || ''))));

    // ── every screen, at two widths ───────────────────────────────────────────
    const has = (f) => fs.existsSync(path.join(ROOT, 'web', 'ui', f));
    const ROUTES = [['home', '#/'], ['map', '#/map'], ['project', '#/p/acme-api'], ['lead session', '#/p/acme-api/s/master'],
      ['session', '#/p/acme-api/s/api-fix'], ['pane', '#/p/acme-api/s/api-fix?tab=pane'], ['settings', '#/settings'], ['activity', '#/activity'],
      ...(has('queue.jsx') ? [['queue', '#/queue'], ['held', '#/held'], ['reviews', '#/reviews'], ['stacks', '#/stacks'],
        ['automations', '#/automations'], ['sign-ins', '#/sign-ins'], ['search', '#/search']] : [])];
    // A phone, a narrow phone, and a desk: the same screens at 1280 draw the sidebar beside them.
    for (const [w, h] of [[390, 844], [320, 700], [1280, 900]]) {
      await b.viewport(w, h);
      for (const [name, hash] of ROUTES) {
        const before = errors.length;
        await b.evaluate((x) => { location.hash = x; }, hash);
        await sleep(900);
        const m = await b.evaluate(() => {
          const main = document.querySelector('.main');
          const doc = document.scrollingElement;
          return { drawn: !!main && main.textContent.trim().length > 0, selects: document.querySelectorAll('select').length,
                   docX: doc.scrollWidth - doc.clientWidth, mainX: main ? main.scrollWidth - main.clientWidth : -1 };
        });
        is(`${w} ${name}: drawn`, true, m.drawn);
        is(`${w} ${name}: no page error`, '', errors.slice(before).join(' | '));
        is(`${w} ${name}: no native <select>`, 0, m.selects);
        is(`${w} ${name}: the page does not scroll sideways`, true, m.docX <= 1 && m.mainX <= 1);
      }
    }
    is('at a desk the projects are beside the page, not in a drawer', true,
       await b.evaluate(() => { const s = document.querySelector('.side'); return !!s && s.getBoundingClientRect().left >= 0 && s.getBoundingClientRect().width > 200; }));
    await b.viewport(390, 844);
    await sleep(300);
    // "Nothing scrolls sideways" is also what a blind measurement says, so it is shown seeing
    // one: a 900px child put into the page has to read as overflow.
    is('...and the measurement sees a page that does scroll sideways', true, await b.evaluate(() => {
      const d = document.createElement('div'); d.style.cssText = 'width:900px;height:1px';
      const main = document.querySelector('.main'); main.appendChild(d);
      const doc = document.scrollingElement;
      const seen = doc.scrollWidth - doc.clientWidth > 1 || main.scrollWidth - main.clientWidth > 1;
      d.remove(); return seen;
    }));

    // ── the drawer: the projects, a heading per profile ───────────────────────
    await b.evaluate(() => { location.hash = '#/'; });
    await sleep(600);
    await b.evaluate(() => document.querySelector('.topbar .icon-btn')?.click());
    is('the menu opens the drawer', true, !!(await until(() => !!document.querySelector('.side.open'))));
    is('...holding every project', 'acme-api,acme-web,billing-svc,scratch,toolbox',
       (await texts('.side.open .side-list .nav .grow')).sort().join(','));
    is('...under a heading per profile, in the projects file\'s order', 'work,personal', (await texts('.side.open .side-prof .grow')).join(','));
    is('...with no machine headings for one machine', 0, (await texts('.side.open .side-host')).length);
    await b.evaluate(() => document.querySelector('.side-scrim')?.click());

    // ── the lead's actions, and the verbs this server refuses ─────────────────
    const menuOf = async (hash) => {
      await b.evaluate((x) => { location.hash = x; }, hash);
      await until(() => !!document.querySelector('.sess-tools .menu-wrap .btn'));
      await b.evaluate(() => document.querySelector('.sess-tools .menu-wrap .btn').click());
      await until(() => !!document.querySelector('.sess-tools .menu'));
      const r = { menu: await texts('.sess-tools .menu button'), tools: await texts('.sess-tools > .btn') };
      await b.evaluate(() => document.querySelector('.sess-tools .menu-wrap .btn').click());
      return r;
    };
    const lead = await menuOf('#/p/acme-api/s/master');
    is('the lead is offered no stop', false, lead.menu.some(x => /^Stop/.test(x)));
    is('...no rename', false, lead.menu.some(x => /^Rename/.test(x)));
    is('...and no pause', false, lead.tools.some(x => /Pause/.test(x)));
    const worker = await menuOf('#/p/acme-api/s/api-fix');
    is('a worker is offered a stop, and one that removes its checkout', 'Stop and delete worktree…,Stop session…',
       worker.menu.filter(x => /^Stop/.test(x)).sort().join(','));
    is('...and a rename', true, worker.menu.some(x => /^Rename/.test(x)));
    is('...and not the label or the schedule, which this server refuses', '', worker.menu.filter(x => /label|Schedule/i.test(x)).join(','));

    // ── a poll does not take the keyboard away ────────────────────────────────
    await until(() => !!document.querySelector('.composer textarea'));
    await b.evaluate(() => { const ta = document.querySelector('.composer textarea'); ta.__mark = 1; ta.focus(); });
    await b.call('Input.insertText', { text: 'half a sentence' });
    await sleep(6500);                                   // past one 5 s poll, and its answer
    const kept = await b.evaluate(() => { const a = document.activeElement; return { same: !!a && a.__mark === 1, value: a?.value || '' }; });
    is('the composer keeps its node across a poll', true, kept.same);
    is('...and its text', 'half a sentence', kept.value);

    // ── the keyboard: the app follows the visible area while it is up ────────
    await b.evaluate(() => window.__vv(431));
    await sleep(100);
    const up = await b.evaluate(() => ({ kb: document.documentElement.classList.contains('kb'),
      h: document.documentElement.style.getPropertyValue('--app-h'), box: Math.round(document.getElementById('app').getBoundingClientRect().height),
      scrolled: scrollY, composer: Math.round(document.querySelector('.composer')?.getBoundingClientRect().bottom || 0) }));
    is('a keyboard is noticed while typing', true, up.kb);
    is('...the app is sized to what is visible', '431px', up.h);
    is('...and laid out to it', 431, up.box);
    is('...so the composer sits above it', true, up.composer > 0 && up.composer <= 431);
    is('...and the window was not scrolled', 0, up.scrolled);
    await b.evaluate(() => { document.activeElement?.blur(); window.__vv(null); });
    await sleep(100);
    const down = await b.evaluate(() => ({ kb: document.documentElement.classList.contains('kb'),
      h: document.documentElement.style.getPropertyValue('--app-h'), top: document.documentElement.style.getPropertyValue('--app-top') }));
    is('...and when it goes, the class goes', false, down.kb);
    is('...and both properties are REMOVED, not emptied', '|', `${down.h}|${down.top}`);
    // A pinch zoom shrinks the visual viewport too; with nothing being typed into it is not a
    // keyboard, and the layout is left alone.
    await b.evaluate(() => window.__vv(431));
    await sleep(100);
    is('a smaller visual viewport with nothing focused is not a keyboard', false,
       await b.evaluate(() => document.documentElement.classList.contains('kb')));
    await b.evaluate(() => window.__vv(null));

    // ── the owner's music ─────────────────────────────────────────────────────
    is('nothing on the way through claimed the audio session', '', (await b.evaluate(() => window.__audio)).join(','));

    // ── a reload keeps its place ──────────────────────────────────────────────
    // The place is the address (web/ui/history.js): a reload, a link opened or a desk tab whose
    // session ran out goes back through the lock and lands where it was, not on the main page.
    await b.evaluate(() => { location.hash = '#/p/acme-web'; });
    await sleep(400);
    await b.evaluate(() => location.reload());
    await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
    await clickText('.auth-card button', 'without a passkey');
    await until(() => !!document.querySelector('.app'));
    await sleep(600);
    is('...and lands where it was', '#/p/acme-web', await b.evaluate(() => location.hash));
    is('...drawing that project', true, await b.evaluate(() => /acme-web/.test(document.querySelector('.main h1')?.textContent || '')));

    // ── paired machines: a heading per machine, and one that is down says so ──
    for (const mode of ['online', 'offline']) {
      await b.evaluate((m) => { localStorage.setItem('gf.fixture.paired', m); location.hash = '#/'; location.reload(); }, mode);
      await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
      await clickText('.auth-card button', 'without a passkey');
      await until(() => !!document.querySelector('.app'));
      await b.evaluate(() => document.querySelector('.topbar .icon-btn')?.click());
      await until(() => document.querySelectorAll('.side.open .side-host').length > 1);
      const hosts = await b.evaluate(() => [...document.querySelectorAll('.side.open .side-host')].map(h => `${h.querySelector('.grow')?.textContent}:${h.querySelector('small')?.textContent || ''}`));
      is(`${mode}: a heading per machine, this one first`, 2, hosts.length);
      is(`${mode}: ...this one says so`, true, /:this machine$/.test(hosts[0] || ''));
      if (mode === 'online') {
        is('online: the peer\'s projects are under it, without their @key', true,
           await b.evaluate(() => { const hs = [...document.querySelectorAll('.side.open .side-list > *')]; const i = hs.findIndex(n => n.classList.contains('side-host') && n !== hs[0]);
             return hs.slice(i + 1).some(n => n.matches('.nav') && /^acme-api$/.test(n.querySelector('.grow')?.textContent || '')); }));
      } else {
        is('offline: the peer keeps its heading and says it is not answering', true, /:not answering$/.test(hosts[1] || ''));
      }
    }
    is('no page error, anywhere on the way', '', errors.join(' | '));
  }
} catch (e) {
  is('phone-check ran to the end', '', String((e && e.stack) || e).split('\n').slice(0, 2).join(' '));
} finally {
  try { await b?.close(); } catch {}
  try { srv?.close(); } catch {}
}
console.log(rows.join('\n'));
process.exit(0);
