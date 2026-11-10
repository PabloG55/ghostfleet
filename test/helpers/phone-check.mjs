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
    const STACK = JSON.stringify([{ project: 'acme-api', session: 'api-fix' }, { project: 'acme-api', session: 'docs-pass' }]);
    const ROUTES = [['home', '#/'], ['map', '#/map'], ['project', '#/p/acme-api'], ['lead session', '#/p/acme-api/s/master'],
      ['session', '#/p/acme-api/s/api-fix'], ['pane', '#/p/acme-api/s/api-fix', 'Screen'], ['settings', '#/settings'], ['activity', '#/activity'],
      ['queue', '#/queue'], ['held', '#/held'], ['reviews', '#/reviews'], ['one review', '#/reviews/-/work/2026-03-05_14-02-11'],
      ['stack picker', '#/stack-picker'], ['stack', `#/stack/${encodeURIComponent(STACK)}`], ['automations', '#/automations'],
      ['sign-ins', '#/sign-ins'], ['search', '#/search?q=api']];
    // Is the newest chat message clear of the Assistant button, with the page at its end? (below)
    const clear = () => b.evaluate(() => {
      const c = document.querySelector('.chat'), fab = document.querySelector('.as-launch'), main = document.querySelector('.main');
      const msgs = c ? c.querySelectorAll('.msg') : [];
      if (!c || !fab || !msgs.length) return 'no chat, message or button';
      if (main) main.scrollTop = main.scrollHeight;
      const L = msgs[msgs.length - 1].getBoundingClientRect(), B = fab.getBoundingClientRect();
      const short = Math.round(c.scrollHeight - c.clientHeight - c.scrollTop);
      const hit = L.right > B.left && L.left < B.right && L.bottom > B.top && L.top < B.bottom;
      return short > 1 ? `${short} px short of its end` : hit ? `under the button by ${Math.round(L.bottom - B.top)} px` : 'clear';
    });
    // A phone, a narrow phone, and a desk: the same screens at 1280 draw the sidebar beside them.
    for (const [w, h] of [[390, 844], [320, 700], [1280, 900]]) {
      await b.viewport(w, h);
      for (const [name, hash, tab] of ROUTES) {
        const before = errors.length;
        await b.evaluate((x) => { location.hash = x; }, hash);
        await sleep(900);
        // The pane has no address of its own: it is the session's Screen tab. This row was once
        // `…/api-fix?tab=pane`, which the router reads as a session NAMED "api-fix?tab=pane", and
        // every row passed on a page about a session that does not exist.
        if (tab) {
          await b.evaluate((x) => [...document.querySelectorAll('.tabs [role=tab]')].find(e => e.textContent.trim() === x)?.click(), tab);
          await sleep(900);
          is(`${w} ${name}: the pane is drawn, from the session's own capture`, true,
             await b.evaluate(() => (document.querySelector('pre.pane')?.textContent || '').trim().length > 40));
        }
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
        // A PROJECT'S HEADER IS ONE HEIGHT BEFORE AND AFTER ITS DATA. The lead's button is drawn once
        // the grid answers, and on a phone it pushed the actions onto a second line: 49 px under a
        // finger, so term-check's tap on the Terminal tab landed on "Start the lead" one run in six
        // here and on CI's Mac, asking for a passkey and starting an agent. This route's lead is up,
        // so a lead button is put in, in each label and each language, beside that language's "New
        // session", and the header must not change height from loading (no lead button, "Loading…")
        // to loaded (the button and the counts).
        if (name === 'project') {
          const moved = await b.evaluate(async () => {
            const head = document.querySelector('.proj-head'), row = head && head.querySelector('.row'), sub = head && head.querySelector('p.muted');
            const add = row && row.lastElementChild;
            if (!add || !sub) return 'no header, actions or counts';
            const text = (e) => [...e.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).pop();
            const keep = [text(add).textContent, sub.textContent], bad = [];
            const lead = add.cloneNode(true); lead.className = 'btn ghost';
            for (const l of ['en', 'es']) {
              const x = (await import(location.origin + '/ui/words/' + l + '.js')).default;
              text(add).textContent = ' ' + x['project.newSession'];
              for (const k of ['project.leadStart', 'project.leadWake', 'project.leadResume', 'project.leadReopen']) {
                text(lead).textContent = ' ' + x[k];
                lead.remove(); sub.textContent = x['common.loading'];
                const a = head.getBoundingClientRect().height;
                row.prepend(lead); sub.textContent = `${x['project.sessions'].replace('{n}', 12)} · ${x['project.freeWts'].replace('{n}', 3)}`;
                const z = head.getBoundingClientRect().height;
                if (Math.abs(z - a) > 0.5) bad.push(`${l} "${x[k]}": ${Math.round(a)} to ${Math.round(z)} px`);
              }
            }
            lead.remove(); text(add).textContent = keep[0]; sub.textContent = keep[1];
            return bad.join(', ') || 'one height';
          });
          is(`${w} project: the header is one height before and after the lead's button lands, in both languages`, 'one height', moved);
        }
        // THE NEWEST MESSAGE CLEARS THE ASSISTANT BUTTON. The chat leaves room under its list for the
        // floating button (ui.css), and that room is only any use at the list's end: the chat jumped
        // there when a message arrived and not when its end moved, so under this route's permission
        // card it sat 29 px short as opened, the newest message's last line under the button. Asked
        // as opened, with the page scrolled to its end, and again with the screen 120 px shorter, as
        // a keyboard makes it: that moves the end every time, not only when a font lands late.
        if (name === 'session') {
          await b.evaluate(() => document.fonts.ready.then(() => 0));
          await sleep(300);
          is(`${w} session: the newest message clears the Assistant button, as opened`, 'clear', await clear());
          await b.viewport(w, h - 120);
          await sleep(600);
          is(`${w} session: ...and with the screen 120 px shorter, as a keyboard makes it`, 'clear', await clear());
          await b.viewport(w, h);
          await sleep(400);
        }
        // THE SESSION'S TAB ROW FITS, Editor included. A served phone adds Terminal and Editor
        // beside Chat and Screen for a project on this machine, and demo data has no machine, so
        // the row is copied with the two added, in the page's own CSS and each language's words,
        // and every tab has to end at least 8 px inside it. Its first words, "Conversation" and
        // "Agent's screen", ran 36 px past the edge at 390 and 106 px at 320; the one-word Spanish
        // four ended 0 px inside at 320 until the narrow padding (terminal.css), a fit only on paper.
        // And the copy is as tall as its tabs: with Terminal and Editor in it the bar is a scroll
        // container, and under this route's permission card it was squashed to 12 px of 47.
        if (name === 'session') {
          const over = await b.evaluate(async () => {
            const row = document.querySelector('.tabs[role=tablist]');
            if (!row) return 'no tab row';
            const bad = [];
            for (const l of ['en', 'es']) {
              const w = (await import(location.origin + '/ui/words/' + l + '.js')).default;
              const probe = row.cloneNode(false);
              for (const k of ['sess.chat', 'sess.screen']) { const x = document.createElement('button'); x.setAttribute('role', 'tab'); x.textContent = w[k]; probe.append(x); }
              for (const k of ['term.tab.term', 'term.tab.edit']) { const x = document.createElement('a'); x.setAttribute('role', 'tab'); x.className = 'tool-tab'; x.textContent = w[k]; probe.append(x); }
              row.after(probe);
              const r = probe.getBoundingClientRect(), end = r.right - parseFloat(getComputedStyle(probe).paddingRight);
              const past = Math.round(Math.max(...[...probe.children].map(e => e.getBoundingClientRect().right)) - end);
              if (past > -8 || probe.scrollWidth > probe.clientWidth) bad.push(`${l}: ${past > 0 ? `${past} px past the edge` : `${-past} px of room`}`);
              // ...and at its full height: the copy sits in the session's column as the bar does.
              const tall = Math.round(probe.getBoundingClientRect().height);
              if (tall + 1 < probe.scrollHeight) bad.push(`${l}: squashed to ${tall} of ${probe.scrollHeight} px`);
              probe.remove();
            }
            return bad.join(', ') || 'fits';
          });
          is(`${w} session: its four tabs fit the row with 8 px to spare and at full height, in both languages`, 'fits', over);
        }
        if (tab) { await b.evaluate(() => [...document.querySelectorAll('.tabs [role=tab]')].find(e => e.textContent.trim() === 'Chat')?.click()); await sleep(300); }
      }
    }
    // A session in a stack column sits under the column's own header (stacks.jsx), so it does not
    // repeat its back link and its title there: two "← acme-api" links one above the other read as
    // two places to go back to.
    await b.evaluate((x) => { location.hash = x; }, `#/stack/${encodeURIComponent(STACK)}`);
    await sleep(900);
    is('a session in a stack has no back link or title of its own', '0 0 2', await b.evaluate(() =>
      [document.querySelectorAll('.stack-column .sess-head .back-link').length,
       document.querySelectorAll('.stack-column .sess-head h1').length,
       document.querySelectorAll('.stack-column .sess-head.embedded').length].join(' ')));
    // ── an empty page says it is empty, once ─────────────────────────────────
    // The demo data has no pending sign-in and no held wake. Pending sign-ins drew its title and
    // nothing under it, and Held items drew its hint about a held wake above "Nothing is waiting".
    const mainText = () => b.evaluate(() => document.querySelector('.main')?.textContent || '');
    await b.evaluate((x) => { location.hash = x; }, '#/sign-ins');
    await sleep(900);
    is('pending sign-ins, with none, says so', 'No sign-in is waiting for you',
       await b.evaluate(() => document.querySelector('.main .empty')?.textContent.trim() || '(nothing under the title)'));
    await b.evaluate((x) => { location.hash = x; }, '#/queue');
    await sleep(900);
    is('...and above Queue that line is not drawn', false, /No sign-in is waiting/.test(await mainText()));
    await b.evaluate((x) => { location.hash = x; }, '#/held');
    await sleep(900);
    is('held items, with none, drop the hint about a held one', false, /A wake is waiting for an empty input box/.test(await mainText()));
    is('...and say nothing is waiting', true, /Nothing is waiting on you/.test(await mainText()));
    // The tree's "└─" is drawing, not words: read aloud, every row began "box drawings light up".
    await b.evaluate((x) => { location.hash = x; }, '#/p/acme-api');
    await sleep(900);
    is("the project tree's connectors are hidden from a screen reader", 'all hidden', await b.evaluate(() => {
      const all = document.querySelectorAll('.tree-branch'), hid = document.querySelectorAll('.tree-branch[aria-hidden="true"]');
      return all.length && hid.length === all.length ? 'all hidden' : `${hid.length} of ${all.length} hidden`;
    }));
    // ── a stack's reads (SessionView `quiet`, stacks.jsx) ─────────────────────
    // Every read in fixture mode is a fetch of a fixture file, so counting fetches per session over
    // a few seconds is the read rate. At a desk the focused column reads its pane every 2.5 s and the
    // others every 15 s; on a phone only the column on screen is mounted, so it is the only one read.
    const STACK3 = JSON.stringify([{ project: 'acme-api', session: 'api-fix' }, { project: 'acme-api', session: 'docs-pass' }, { project: 'acme-api', session: 'master' }]);
    const reads = async (ms) => {
      await b.evaluate(() => {
        if (!window.__fetch0) { window.__fetch0 = window.fetch; window.fetch = (u, o) => { (window.__reads ||= []).push(String(u?.url || u)); return window.__fetch0(u, o); }; }
        window.__reads = [];
      });
      await sleep(ms);
      return b.evaluate(() => {
        const n = {};
        for (const u of window.__reads) { const m = /fixtures\/(pane|session)-acme-api-([\w-]+)\.json/.exec(u); if (m) n[`${m[1]} ${m[2]}`] = (n[`${m[1]} ${m[2]}`] || 0) + 1; }
        return n;
      });
    };
    await b.evaluate((x) => { location.hash = x; }, `#/stack/${encodeURIComponent(STACK3)}`);
    await until(() => document.querySelectorAll('.stack-column .sess-head').length === 3);
    await sleep(1500);
    const desk = await reads(8000);
    is('at a desk a stack reads the focused column\'s pane as a session does', true, (desk['pane api-fix'] || 0) >= 3);
    is('...and the others at most once in that time', '0,0', `${Math.max(0, (desk['pane docs-pass'] || 0) - 1)},${Math.max(0, (desk['pane master'] || 0) - 1)}`);
    await b.viewport(390, 844);
    await b.evaluate(() => { location.hash = '#/'; });
    await sleep(300);
    await b.evaluate((x) => { location.hash = x; }, `#/stack/${encodeURIComponent(STACK3)}`);
    await until(() => !!document.querySelector('.stack-column.stack-active .sess-head'));
    await sleep(1500);
    is('on a phone a stack mounts only the column on screen', 1, await b.evaluate(() => document.querySelectorAll('.stack-column .sess-head').length));
    const phone = await reads(6000);
    is('...and reads only that session', 'api-fix', [...new Set(Object.keys(phone).map(k => k.split(' ')[1]))].sort().join(','));
    await b.viewport(1280, 900);
    await sleep(300);
    is('at a desk the projects are beside the page, not in a drawer', true,
       await b.evaluate(() => { const s = document.querySelector('.side'); return !!s && s.getBoundingClientRect().left >= 0 && s.getBoundingClientRect().width > 200; }));
    // Automations are a switch on the daemon, and fixture mode answers like one with it off (a 404):
    // the old client then had no Automations, and the shared app had a link onto "HTTP 404".
    await b.evaluate(() => { location.hash = '#/automations'; });
    await sleep(900);
    is('automations switched off: no link to them, and their address says this server has none', 'false true',
       await b.evaluate(() => [[...document.querySelectorAll('.side a.nav')].some(a => /automations/i.test(a.textContent)),
                               /does not have this page/.test(document.querySelector('.main')?.textContent || '')].join(' ')));
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

    // ── what Jarvis is waiting on a yes for, answered from the assistant ─────
    // The old Jarvis screen's list, which the one assistant draws now (assistant.jsx Proposals).
    // The fixture holds one proposal. A No costs no passkey, so it can be pressed here; the Yes is
    // the adapter's assertFor, the same path as every passkey verb.
    await b.evaluate(() => { location.hash = '#/'; });
    const ask = await until(() => { const r = document.querySelector('.home-agent .as-ask'); return r && [r.querySelector('.grow'), ...r.querySelectorAll('button')].map(n => n.textContent.replace(/\s+/g, ' ').trim()).join(' | '); });
    is('the home card lists what Jarvis waits on a yes for', 'Jarvis asks: stop acme-api/docs-pass and remove its worktree? K7Q2 | Yes | No', ask);
    is('...above the place to talk', true, await b.evaluate(() => {
      const a = document.querySelector('.home-agent .as-asks'), c = document.querySelector('.home-agent .console');
      return !!(a && c && (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));
    await clickText('.home-agent .as-ask button', '^No$');
    is('...a No answers it, and it leaves the list', true, !!(await until(() => !document.querySelector('.home-agent .as-ask'))));
    is('...saying what will not happen', true, !!(await until(() => /Jarvis will not stop acme-api\/docs-pass/.test(document.querySelector('.toasts')?.textContent || ''))));
    // The toast follows the button; what was SENT is the fixture's own record of the call, read
    // from the module instance the app runs (the same URL, so the same module).
    is('...and what was sent is a no, for that proposal', '[{"id":"K7Q2","answer":"no"}]', await b.evaluate(async () =>
      JSON.stringify((await (await import('./api.js')).getAudit()).rows.filter(r => r.verb === 'jarvis_confirm').map(r => r.args))));

    // ── "Turn on notifications", offered after an unlock (src/push.js offerWanted) ──
    // Demo data cannot subscribe, so the bar is never drawn here; the rule that decides it is
    // asked directly, from the same module instance the app runs (the source is served as written).
    is('demo data is offered no notifications', false, await b.evaluate(() => !!document.querySelector('.notify-bar')));
    is('the offer: who is asked', 'yes no no no no yes no', await b.evaluate(async () => {
      const { offerWanted } = await import('./src/push.js');
      const now = 1e12, day = 86400e3, base = { server: true, token: true, blocked: '', laterAt: 0, now, on: false };
      return [base, { ...base, server: false }, { ...base, token: false }, { ...base, blocked: 'iOS only allows…' },
              { ...base, laterAt: now - day }, { ...base, laterAt: now - 4 * day }, { ...base, on: true }]
        .map(c => offerWanted(c) ? 'yes' : 'no').join(' ');
    }));
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/api-fix'; });

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

    // ── a draft per session (web/ui/drafts.js) ────────────────────────────────
    // api-fix's box holds "half a sentence" from above. Each session's box is its own, and the
    // words come back after leaving, after a reload, and go only when a send of them succeeds.
    const boxOf = async (hash) => {
      await b.evaluate((x) => { location.hash = x; }, hash);
      await until((x) => location.hash === x && !!document.querySelector('.composer textarea'), hash);
      await sleep(300);
      return b.evaluate(() => document.querySelector('.composer textarea').value);
    };
    is('another session\'s box is its own', '', await boxOf('#/p/acme-api/s/docs-pass'));
    is('...and the draft is there on coming back', 'half a sentence', await boxOf('#/p/acme-api/s/api-fix'));
    // The files a draft had cannot survive a reload; the draft remembers how many, and says so.
    await b.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('gfw.drafts') || '{}');
      o['acme-api\x1fapi-fix'] = { ...o['acme-api\x1fapi-fix'], files: 2 };
      localStorage.setItem('gfw.drafts', JSON.stringify(o));
      location.reload();
    });
    await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
    await clickText('.auth-card button', 'without a passkey');
    await until(() => !!document.querySelector('.app'));
    is('...and after a reload', 'half a sentence', await boxOf('#/p/acme-api/s/api-fix'));
    is('...saying how many of its files the reload dropped', '2 files attached to this draft did not survive the reload. Attach them again. OK',
       (await texts('.composer .att-lost')).join(' ').replace(/\s+/g, ' '));
    await clickText('.composer .att-lost button', '^OK$');
    is('...until that has been read', 0, (await texts('.composer .att-lost')).length);
    await clickText('.composer button[type=submit]', 'Send');
    is('a send that succeeds empties the box', true, !!(await until(() => document.querySelector('.composer textarea')?.value === '')));
    is('...and the draft goes with it', '', await boxOf('#/p/acme-api/s/docs-pass') + await boxOf('#/p/acme-api/s/api-fix'));
    is('...from storage too', false, await b.evaluate(() => 'acme-api\x1fapi-fix' in JSON.parse(localStorage.getItem('gfw.drafts') || '{}')));

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

    // ── an address changed the moment the app appears ─────────────────────────
    // The router reads the address when it first draws and listens only from after that paint, so a
    // change in between (a link handled at start-up, a notification's way in) fired its hashchange
    // to nobody: the address said the queue and the page went on drawing the main page. The window
    // is one frame, so the change is made from inside the page, in the task that sees the app appear;
    // polled from here across a round trip, it lands after the listener and passes on broken code.
    await b.evaluate(() => { location.hash = '#/'; location.reload(); });
    await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
    await b.evaluate(() => new Promise((ok) => {
      [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey/i.test(x.textContent)).click();
      const t0 = Date.now();
      const tick = () => {
        if (document.querySelector('.app')) { location.hash = '#/queue'; ok(true); }
        else if (Date.now() - t0 > 5000) ok(false);
        else setTimeout(tick, 0);
      };
      tick();
    }));
    await sleep(900);
    is('an address changed as the app first draws is the page it shows', 'Queue',
       await b.evaluate(() => document.querySelector('.main h1')?.textContent.trim() || ''));

    // ── paired machines: a heading per machine, and one that is down says so ──
    // A red here once came with the page drawing neither the lock nor the app for over a minute after
    // the reload, on CI's Mac and in none of fifteen loops of this sequence locally, and the row said
    // only "0". So a count that is not 2 carries which waits ran out and what the page held then.
    for (const mode of ['online', 'offline']) {
      await b.evaluate((m) => { localStorage.setItem('gf.fixture.paired', m); location.hash = '#/'; location.reload(); }, mode);
      const locked = await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
      await clickText('.auth-card button', 'without a passkey');
      const drawn = await until(() => !!document.querySelector('.app'));
      await b.evaluate(() => document.querySelector('.topbar .icon-btn')?.click());
      await until(() => document.querySelectorAll('.side.open .side-host').length > 1);
      const hosts = await b.evaluate(() => [...document.querySelectorAll('.side.open .side-host')].map(h => `${h.querySelector('.grow')?.textContent}:${h.querySelector('small')?.textContent || ''}`));
      const page = hosts.length === 2 ? '' : await b.evaluate(() => JSON.stringify({
        ready: document.readyState, lock: !!document.querySelector('.auth-card'), app: !!document.querySelector('.app'),
        drawer: !!document.querySelector('.side.open'), nodes: document.body ? document.body.getElementsByTagName('*').length : -1,
        sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), hash: location.hash,
        scripts: performance.getEntriesByType('resource').filter(r => /\.js$/.test(r.name)).map(r => `${r.name.replace(location.origin, '')}:${Math.round(r.duration)}ms`).join(' '),
      })).catch(e => 'no answer: ' + e.message);
      is(`${mode}: a heading per machine, this one first`, 2, page ? `${hosts.length}; lock ${locked ? 'came' : 'never came'}, app ${drawn ? 'drawn' : 'never drawn'}; ${page}` : hosts.length);
      is(`${mode}: ...this one says so`, true, /:this machine$/.test(hosts[0] || ''));
      if (mode === 'online') {
        is('online: the peer\'s projects are under it, without their @key', true,
           await b.evaluate(() => { const hs = [...document.querySelectorAll('.side.open .side-list > *')]; const i = hs.findIndex(n => n.classList.contains('side-host') && n !== hs[0]);
             return hs.slice(i + 1).some(n => n.matches('.nav') && /^acme-api$/.test(n.querySelector('.grow')?.textContent || '')); }));
      } else {
        is('offline: the peer keeps its heading and says it is not answering', true, /:not answering$/.test(hosts[1] || ''));
      }
    }

    // ── a session opened cold, from its link ─────────────────────────────────
    // As a notification opens one: the app loads on the session's address and lands there past the
    // lock. Reached by its hash the chat was short of its end only some of the time (the picture in
    // docs/mobile/session.png was one); opened cold it sat 29 px short every time, the newest
    // message's last line under the Assistant button. After every screen above, because the load
    // locks the app again.
    //   COLD MEANS A NEW DOCUMENT, and a navigate is not one when only the fragment differs. From
    // `/#/` to `/#/p/acme-api/s/api-fix` Chrome moves within the page it has: no loader, no lock,
    // the app's own state carried over. This row was written that way first, and measured: a mark
    // left on the window survived the "load", the wait for the lock ran its whole 15 s on every run,
    // and the chat it judged was the warm one. So the page goes to about:blank first, and the row
    // below says the load was a page of its own that came up locked.
    await b.viewport(390, 844);
    await b.evaluate(() => { window.__warm = 1; });
    await b.call('Page.navigate', { url: 'about:blank' });
    await until(() => location.href === 'about:blank');
    await b.call('Page.navigate', { url: srv.base + '/#/p/acme-api/s/api-fix' });
    const coldLock = await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
    is('390 session, opened cold from its link: a page of its own, come up locked', 'yes yes',
       `${await b.evaluate(() => (window.__warm ? 'no' : 'yes'))} ${coldLock ? 'yes' : 'no'}`);
    await clickText('.auth-card button', 'without a passkey');
    await until(() => document.querySelectorAll('.chat .msg').length > 3 && !!document.querySelector('.as-launch'));
    await b.evaluate(() => document.fonts.ready.then(() => 0));
    await sleep(300);
    is('390 session, opened cold from its link: the newest message clears the Assistant button', 'clear', await clear());

    // ── one answer to "is this run done": the client's state against the server's ──
    // The phone works a recorded run's state out the moment a verdict is tapped (and fixture mode
    // never asks a server at all), so web/api.js's copy must say what lib/shots.mjs says, which is
    // what `fleet-shots --check` and the list are built from. Compared case by case: two spellings
    // of one rule are a rule that drifts, and the drift would read as a review that will not close.
    const { runState } = await import(new URL('../../lib/shots.mjs', import.meta.url).href);
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
    is('the phone\'s run state matches the server\'s, case by case', JSON.stringify(server), JSON.stringify(client));
    is('...and the cases are not all one answer', true, new Set(server.map(s => JSON.stringify(s))).size >= 3);
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
