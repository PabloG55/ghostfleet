#!/usr/bin/env node
// found-check — one search on the web's Projects screen that finds projects AND sessions,
// and the phone grid's own "find a session" field.
//
//     node test/helpers/found-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a client whose Projects search
// finds only projects (a `git archive` of staging) every row about sessions goes red, which
// is how they were watched red first; the rows staging could not tell apart (a project query,
// the desk grid's `/`, the Queue row) were watched red against copies of this client broken
// on purpose (listed in the PR).
//
// FIXTURE MODE throughout, at 1600x900 with keys and at 390x844 with touch, and once more
// with a second machine paired (api.js pairedFixture). The fixture's sessions that matter:
//   acme-api — master (main), api-fix (feat/retry-backoff), docs-pass (docs/openapi-examples),
//              types, labelled "PR 198 strict types" (strict-null-checks), and four more
//   toolbox  — search-index (feat/search-index), cli-flags (feat/cli-flags)
// and with the vm paired, acme-api@vm draws acme-api's cards again, so `retry` finds api-fix
// twice: once on each machine, which is the only thing that tells the two rows apart.
// Read back from what is DRAWN, never from the client's state.
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
const until = async (f, ms = 8000) => { const t0 = Date.now(); let v = await f(); while (!v && Date.now() - t0 < ms) { await sleep(80); v = await f(); } return v; };

// ITS OWN SERVER, for one reason: the shipped waiting.json is empty, and the Queue row is
// only drawn while something is held — a row that is not there is never dimmed or counted,
// which proves nothing. queue-check serves the same way.
const HELD = [{ project: 'acme-api', profile: 'work', session: 'master', key: 'k:7', id: '7', text: 'merge #12 now, or wait for the review?',
  state: 'waiting', reason: 'waits on the person: pick one', since_ago: 7200, at_ago: 9000 }];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/fixtures/waiting.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, items: HELD }));
  }
  const p = path.join(WEB, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!path.resolve(p).startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

let b = null;
try {
  try {
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the Projects search', 'no chrome to press keys in'); done(0); }
    throw e;
  }
  await b.call('Emulation.setFocusEmulationEnabled', { enabled: true });

  // ── driving it ──────────────────────────────────────────────────────────────────────
  // KEYS ARE PRESSED, NOT DISPATCHED (desktop-check says why).
  const VK = { Enter: 13, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, '/': 191, '`': 192 };
  async function press(key, { shift = false } = {}) {
    const one = key.length === 1;
    const vk = VK[key] || (one ? key.toUpperCase().charCodeAt(0) : 0);
    const text = key === 'Enter' ? '\r' : one ? key : '';
    const p = { key, code: one ? '' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...p, text, unmodifiedText: text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(140);
  }
  const type = async (s) => { for (const ch of s) await press(ch); };
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  const centre = (q, text = null) => b.evaluate((q, t) => {
    const n = [...document.querySelectorAll(q)].find(x => t == null || x.textContent.trim() === t);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height / 2, 18))];
  }, q, text);
  async function tap(q, text = null) {
    const c = await centre(q, text); if (!c) return false;
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c[0], y: c[1] }] }); await sleep(40);
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(300);
    return true;
  }
  async function click(q, text = null) {
    const c = await centre(q, text); if (!c) return false;
    for (const t of ['mousePressed', 'mouseReleased'])
      await b.call('Input.dispatchMouseEvent', { type: t, x: c[0], y: c[1], button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(250);
    return true;
  }
  const typeInto = async (s) => { for (const ch of s) await b.call('Input.insertText', { text: ch }); await sleep(300); };
  // A SCREEN CHANGE SLIDES on a phone (slideNav); a tap inside the slide hits the snapshot.
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));

  // What is on screen. `list` is the column the Projects (or grid) cards are in — the left
  // pane at a desk, the whole screen on a phone.
  const look = () => b.evaluate(() => {
    const t = (q, r = document) => ((r.querySelector(q) || {}).textContent || '').trim();
    const list = document.querySelector('#side > .cards') || document.querySelector('#app > .cards');
    const kids = list ? [...list.children] : [];
    const sect = kids.findIndex(n => n.classList.contains('sect') && /^sessions/.test(n.textContent.trim()));
    const found = sect < 0 ? [] : kids.slice(sect + 1).filter(n => n.classList.contains('card')).map(n => ({
      name: t('.c-name', n), where: [...n.querySelectorAll('.c-where')].map(w => w.textContent.trim()).join(' | '),
      num: !!n.querySelector('.c-num'), sel: n.classList.contains('sel'), miss: n.classList.contains('miss') }));
    const f = document.querySelector('#app .find input');
    const qr = document.querySelector('.queue-row');
    const firstCard = list && list.querySelector('.card[data-idx]');
    return {
      scope: t('#side > .hdr .scope') || t('#app > .hdr .scope'),
      session: t('#app .sbar .nm'),
      side: t('#side > .hdr .scope'),
      prompt: t('#side .confirm .q') || t('#app .confirm .q'),
      keys: t('#side .confirm .keys') || t('#app .confirm .keys'),
      sel: t('#side .card.sel .c-name') || t('#app .card.sel .c-name'),
      lit: kids.slice(0, sect < 0 ? kids.length : sect).filter(n => n.classList.contains('card') && n.dataset.idx && !n.classList.contains('miss'))
        .map(n => t('.c-name', n)),
      misses: (list ? list.querySelectorAll('.card.miss').length : 0),
      sect: sect < 0 ? '' : kids[sect].textContent.trim(),
      // the sessions header comes after every project card: projects first, then sessions
      after: sect < 0 ? null : kids.slice(sect + 1).every(n => !n.classList.contains('k-project')),
      found,
      field: f ? { value: f.value, placeholder: f.placeholder, focused: document.activeElement === f,
                   count: t('#app .find .count'), h: Math.round(f.getBoundingClientRect().height) } : null,
      top: list ? Math.round(list.getBoundingClientRect().top) : -1,
      queue: qr ? { miss: qr.classList.contains('miss'), above: !!firstCard && qr.getBoundingClientRect().bottom <= firstCard.getBoundingClientRect().top } : null,
      cards: list ? [...list.querySelectorAll('.card[data-idx] .c-name')].map(n => n.textContent.trim()) : [],
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };

  // A clean app at a size, past the lock screen, on Projects.
  async function fresh(w = 1600, h = 900, mobile = false, paired = '') {
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: mobile, ...(mobile ? { maxTouchPoints: 5 } : {}) });
    await b.call('Emulation.setEmitTouchEventsForMouse', { enabled: mobile });
    await goto(base + '/index.html');
    await b.evaluate((pm) => { try { localStorage.clear(); sessionStorage.clear(); if (pm) localStorage.setItem('gf.fixture.paired', pm); } catch {} return null; }, paired);
    await goto(base + '/index.html');
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click();
      return !!document.querySelector('.card .c-name');
    }), 8000);
    await sleep(400);
  }
  // EACH PART ON ITS OWN: a client without the search fails the first row that needs it,
  // and the parts after it must still each say red rather than not be asked at all.
  const part = async (name, fn) => { try { await fn(); } catch (e) { is(`${name} ran`, 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`); } };
  let s;

  // ════════════════════════════════════════════════════════════════════════════════════
  // AT A DESK: `/` on Projects, the keys
  // ════════════════════════════════════════════════════════════════════════════════════
  await part('desk', async () => {
    await fresh();
    await press('/'); await type('retry');
    s = await settle(x => x.found.length > 0);
    is("desk / retry: a session found by its branch, under the projects", ['sessions · 1', ['api-fix']], [s.sect, s.found.map(f => f.name)]);
    is('...its row names its project', true, /^acme-api · /.test(s.found[0]?.where || ''));
    is('...and carries no digit (a digit on Projects opens a project)', false, s.found[0]?.num ?? 'no row');
    is('...the prompt counts it', true, /^1 match/.test(s.keys) || s.keys);
    is('...no project matches, so every project is dimmed and the cursor is on the session', [[], 6, 'api-fix'], [s.lit, s.misses, s.sel]);
    // five projects, the usage line and the Queue row put it below the fold at 900px
    is('...scrolled into view, inside the list', true, await b.evaluate(() => {
      const l = document.querySelector('#side > .cards'), c = l && l.querySelector('.card.sel');
      if (!c) return 'no selected card';
      const a = l.getBoundingClientRect(), r = c.getBoundingClientRect();
      return (r.top >= a.top - 1 && r.bottom <= a.bottom + 1) || [Math.round(r.top), Math.round(r.bottom), Math.round(a.top), Math.round(a.bottom)];
    }));
    await press('Escape');
    s = await settle(x => !x.prompt);
    is('desk / Esc: the session rows go with the search', ['', []], [s.sect, s.found]);

    // by session name, and by label
    await press('/'); await type('search');
    s = await settle(x => x.found.length > 0);
    is('desk / search: a session found by its name, in another project', [['search-index'], true],
       [s.found.map(f => f.name), /^toolbox · /.test(s.found[0]?.where || '')]);
    await press('Escape'); await settle(x => !x.prompt);
    await press('/'); await type('pr 198');
    s = await settle(x => x.found.length > 0);
    is("desk / pr 198: a session found by its label, drawn by its label", ['PR 198 strict types'], s.found.map(f => f.name));
    await press('Escape'); await settle(x => !x.prompt);

    // A PROJECT QUERY IS #94's: the projects lit in place, no sessions section
    await press('/'); await type('acme');
    s = await settle(x => /match/.test(x.keys));
    is('desk / acme: a project query behaves as before', [['acme-api', 'acme-web'], 4, '', true],
       [s.lit, s.misses, s.sect, /^2 matches/.test(s.keys) || s.keys]);
    await press('Escape'); await settle(x => !x.prompt);

    // BOTH AT ONCE: projects first, then sessions; n walks from one into the other
    await press('/'); await type('api');
    s = await settle(x => x.found.length > 0);
    // api-fix by its name, docs-pass by its branch (docs/openapi-examples)
    is('desk / api: the project lit and the sessions listed, projects first, the cursor on the project', [['acme-api'], ['api-fix', 'docs-pass'], true, 'acme-api'],
       [s.lit, s.found.map(f => f.name), s.after, s.sel]);
    await press('Enter');
    s = await look();
    is('desk / api ⏎: locked, three matches', true, /^1 of 3/.test(s.keys) || s.keys);
    await press('n');
    s = await settle(x => x.sel === 'api-fix');
    is('desk / n: from the project into the sessions', ['api-fix', true], [s.sel, /^2 of 3/.test(s.keys) || s.keys]);
    await press('Enter');
    s = await settle(x => x.session === 'api-fix');
    is("desk / ⏎ on a session: opens that session's conversation, its project beside it", ['api-fix', true], [s.session, /acme-api/.test(s.side) || s.side]);
    // ` is the desk's way out of a session; from a found one it is back to the search
    await b.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch {} return null; });
    await press('`');
    s = await settle(x => !x.session && /projects/.test(x.scope));
    is('desk ` from it: back on Projects, the search still there, on the session it opened', ['', '— projects', '/api', 'api-fix', ['api-fix', 'docs-pass']],
       [s.session, s.scope, s.prompt, s.sel, s.found.map(f => f.name)]);
    await press('Enter');
    s = await settle(x => x.session === 'api-fix');
    is('...and ⏎ opens it again', 'api-fix', s.session);
    await click('#app .sbar button', '‹');
    s = await settle(x => !x.session && /projects/.test(x.scope));
    is('desk ‹ from it: back on Projects with the search', ['/api', 'api-fix'], [s.prompt, s.sel]);
    await press('Escape'); await settle(x => !x.prompt);

    // a session in another project than the one last open
    await press('/'); await type('cli-');
    s = await settle(x => x.found.length > 0);
    await press('Enter'); await press('Enter');
    s = await settle(x => x.session === 'cli-flags');
    is('desk: a session in another project opens there', ['cli-flags', true], [s.session, /toolbox/.test(s.side) || s.side]);

    // A DESK KEEPS ITS `/` ON THE GRID: the prompt row, no field
    await fresh();
    await click('#side .card .c-name', 'acme-api');
    await settle(x => /acme-api/.test(x.scope));
    await press('/');
    s = await settle(x => !!x.prompt);
    is("desk grid /: the prompt row, as before, and no field", ['/▏', "type part of an agent's name · esc cancel", 0],
       [s.prompt, s.keys, await b.evaluate(() => document.querySelectorAll('.find').length)]);
    await press('Escape');
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // ON A PHONE: the field on Projects
  // ════════════════════════════════════════════════════════════════════════════════════
  await part('phone', async () => {
    await fresh(390, 844, true);
    let s0 = await look();
    is('phone Projects: the field says it finds sessions too', 'find a project or session', s0.field?.placeholder ?? 'no field');
    await tap('#app .find input');
    await typeInto('retry');
    s = await settle(x => x.found.length > 0);
    is('phone: typing a session\'s branch finds it, with its project', [['api-fix'], true, '1 match'],
       [s.found.map(f => f.name), /^acme-api · /.test(s.found[0]?.where || ''), s.field?.count]);
    is('...nothing above the list moved', [s0.top, s0.field?.h], [s.top, s.field?.h]);
    is('...the Queue row stays above the cards, lit, and is not counted', { miss: false, above: true }, s.queue);
    await tap('#app .cards .card .c-name', 'api-fix');
    s = await settle(x => x.session === 'api-fix');
    is("phone: a tap on the session opens its conversation", 'api-fix', s.session);
    await slid();
    await tap('#app .sbar button', '‹');
    s = await settle(x => !x.session && /projects/.test(x.scope));
    await slid();
    is('phone ‹: back on Projects with the search still there', ['retry', ['api-fix']], [s.field?.value, s.found.map(f => f.name)]);
    is('...and the field not focused for you (no keyboard)', false, s.field?.focused ?? 'no field');
    await b.evaluate(() => { document.querySelector('#app .find .clear')?.click(); return null; });
    s = await settle(x => !x.found.length);
    is('phone ×: clears the sessions with the query', ['', []], [s.field?.value, s.found]);
    // a project query is #94's: lit in place, counted, no sessions section
    await tap('#app .find input');
    // toolbox has sessions of its own, and a project's name does not find them: they are not
    // named toolbox, and listing them would bury the one card the reader asked for
    await typeInto('toolbox');
    s = await settle(x => /match/.test(x.field?.count || ''));
    is('phone: a project query behaves as before', [['toolbox'], '1 match', ''], [s.lit, s.field?.count, s.sect]);
    await b.evaluate(() => { document.querySelector('#app .find .clear')?.click(); return null; });
    await sleep(300);

    // A SESSION-ONLY QUERY: no project matches `docs`, so its one match is below five dimmed
    // projects and `+ add project` — off an 844px screen unless the list is brought to it.
    // A FRESH PAGE, AND THE WORD IN ONE INSERTION, the way iOS predictive text commits it: no
    // grid is cached yet, so the match exists only once the read the query started comes back,
    // after the last keystroke — and the reveal has to follow that read, not the keystroke.
    await fresh(390, 844, true);
    await tap('#app .find input');
    await b.call('Input.insertText', { text: 'docs' });
    s = await settle(x => x.found.length > 0);
    await sleep(400);
    const seen = await b.evaluate(() => {
      const l = document.querySelector('#app > .cards'), c = l && l.querySelector('.card.sel'), f = document.querySelector('#app .find input');
      if (!c) return 'no selected card';
      const a = l.getBoundingClientRect(), r = c.getBoundingClientRect();
      const bottom = Math.min(a.bottom, innerHeight);
      return { name: c.querySelector('.c-name').textContent.trim(), inView: r.top >= a.top - 1 && r.top + Math.min(r.height, 60) <= bottom + 1,
               typing: document.activeElement === f};
    });
    is('phone docs: a session-only query leaves its first result visible, the field still typing', { name: 'docs-pass', inView: true, typing: true },
       typeof seen === 'object' ? { name: seen.name, inView: seen.inView, typing: seen.typing } : seen);
    // NOT ASSERTED HERE: that the page and the visual viewport stay put while the list scrolls.
    // Headless Chrome raises no on-screen keyboard, so the page never shifts, and a row about it
    // stayed green with scrollIntoView() put back. Only a real phone can show that half.
    await b.evaluate(() => { document.querySelector('#app .find .clear')?.click(); return null; });
    await sleep(300);

    // ── the phone grid gets the field ──
    await b.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch {} return null; });
    await tap('#app .cards .card .c-name', 'acme-api');
    s = await settle(x => /acme-api/.test(x.scope) && x.cards.length > 3);
    await slid();
    s0 = await look();
    is('phone grid: a "find a session" field', 'find a session', s0.field?.placeholder ?? 'no field');
    is('...not focused for you', false, s0.field?.focused ?? 'no field');
    await tap('#app .find input');
    is('...until it is tapped', true, (await look()).field?.focused ?? 'no field');
    await typeInto('docs');
    s = await settle(x => /match/.test(x.field?.count || ''));
    is('phone grid: typing lights the match, the rest dimmed in place', ['1 match', 'docs-pass', s0.cards.length - 1, s0.cards.length],
       [s.field?.count, s.sel, s.misses, s.cards.length]);
    is('...nothing moved, and no prompt row pushed in', [s0.top, s0.field?.h, ''], [s.top, s.field?.h, s.prompt]);
    await typeInto('zz');
    s = await settle(x => /no /.test(x.field?.count || ''));
    is('phone grid: no match says so, in the field', 'no session matches', s.field?.count);
    await b.evaluate(() => { document.querySelector('#app .find .clear')?.click(); return null; });
    s = await settle(x => !x.field?.value);
    is('phone grid ×: clears it, nothing dimmed', ['', 0], [s.field?.value, s.misses]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // A SECOND MACHINE PAIRED: a session on it is found, and says which machine
  // ════════════════════════════════════════════════════════════════════════════════════
  await part('paired', async () => {
    await fresh(1600, 900, false, 'online');
    await press('/'); await type('retry');
    s = await settle(x => x.found.length > 1);
    is('paired / retry: the session on each machine', ['sessions · 2', ['api-fix', 'api-fix']], [s.sect, s.found.map(f => f.name)]);
    is('...each row naming its project and its machine', [true, true],
       [/^acme-api · laptop · /.test(s.found[0]?.where || ''), /^acme-api · vm · /.test(s.found[1]?.where || '')]);
    await press('Enter'); await press('n');
    s = await settle(x => x.found[1]?.sel);
    await press('Enter');
    s = await settle(x => x.session === 'api-fix');
    is("paired: ⏎ on the vm's row opens the vm's session", ['api-fix', true], [s.session, /vm/.test(s.side) || s.side]);
    await fresh(390, 844, true, 'online');
    await tap('#app .find input');
    await typeInto('retry');
    s = await settle(x => x.found.length > 1);
    is('paired phone: the field finds the remote one too, labelled with its machine', true,
       s.found.some(f => /^acme-api · vm · /.test(f.where)) || s.found);
  });
} finally {
  try { if (b) await b.close(); } catch {}
  srv.close();
}
done(0);
