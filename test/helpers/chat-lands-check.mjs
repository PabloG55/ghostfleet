#!/usr/bin/env node
// test/helpers/chat-lands-check.mjs — an open chat converges to the transcript without being
// reopened. In a real browser, at phone size, against a daemon that misbehaves on purpose.
//
//     node test/helpers/chat-lands-check.mjs        # one "name <US> want <US> got" row per check
//
// THE REPORT: an agent's reply sometimes did not appear in the open chat until the owner
// left it and came back. Reopening always showed it, so the data was there and the open view
// was not getting it. The daemon's log for the same evening said why that was possible:
// /api/session usually answered in well under a second but regularly took 8-26 s, slow
// answers clustered, and the phone then drew a burst of 429s — five in one second — from
// its own backlog of polls.
//
// SO THE FAKE DAEMON MISBEHAVES IN EXACTLY THOSE WAYS, one at a time: a transcript read
// that is slow, a slow one overtaken by a fast one, a burst of 429s with a Retry-After, a
// read still in flight when the app goes to the background. Every scenario writes the
// reply into the transcript WHILE the chat is open and asks the screen, not the state,
// whether it arrived. The client is the real one, unmodified, in server mode: the fixture
// backend would turn every non-200 into "offline", so a 429 could not even be expressed
// there. What it reads is web/fixtures/, so a reader can open the same conversation in
// fixture mode and see what these rows see.
//
// What it cannot be is a phone. The visibility change is simulated (document.hidden and a
// visibilitychange event), which is what an iOS resume delivers to the page — but not the
// part where iOS kills the socket of a request in flight, which this models only as a
// request that answers late with old data. That half is unchecked here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

const fx = (f) => JSON.parse(fs.readFileSync(path.join(WEB, 'fixtures', f), 'utf8'));
const PROJECT = 'acme-api', SESSION = 'api-fix', OTHER = 'docs-pass';
const REPLY = 'The backoff column is gone and the suite is green on both legs.';
// (The fixture conversation already holds a small table, which md.js FITS to its bubble
// rather than scrolling, so every lookup below takes the last scrolling one.)
// A turn with a table wider than any phone and a code line longer than one: the two things in
// a bubble that scroll sideways in a box of their own (web/md.js), and so the two things a
// rebuilt message list throws back to the left edge.
const WIDE = [
  'Retry budget per endpoint, after the change:',
  '',
  '| endpoint | attempts before | attempts after | backoff before | backoff after | p99 before | p99 after |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| acme-api /v1/charges | 5 unbounded | 3 bounded | linear 200ms | exponential 100ms-3.2s | 4120 ms | 1310 ms |',
  '| acme-api /v1/refunds | 5 unbounded | 3 bounded | linear 200ms | exponential 100ms-3.2s | 3980 ms | 1270 ms |',
  '| billing-svc /invoices | 8 unbounded | 4 bounded | none | exponential 250ms-8s | 9050 ms | 2210 ms |',
  '',
  '```',
  'retry(fn, { attempts: 3, base: 100, cap: 3200, jitter: "full", on: [502, 503, 504], budget: "acme-api.charges", report: "billing-svc" })',
  '```',
].join('\n');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ── the fake fleet-serve ────────────────────────────────────────────────────
// /api/session takes its SNAPSHOT when the request arrives and answers after `delay` — the
// shape of the real one, which runs fleet-read at the start and replies when it finishes. That
// is what makes a slow answer a STALE one: it says what the transcript held when it was asked.
async function fakeDaemon() {
  const st = {
    convo: { [SESSION]: fx(`session-${PROJECT}-${SESSION}.json`).messages.slice(),
             [OTHER]: fx(`session-${PROJECT}-${OTHER}.json`).messages.slice() },
    delay: () => 0,              // (n, session) -> ms, n = this session read's ordinal
    first: null,                 // (n) -> 'fail' | '429' | 'hang' | null: what read n gets instead
    limitedUntil: 0,             // every read before this gets a 429
    log: [],                     // { path, session, at, end, status }
    inflight: 0, maxInflight: 0, reads: 0,
    slowAll: 0,                  // every OTHER read takes this long too: a loaded Mac is slow at all of them
    busy: 0, maxBusy: 0,         // reads of any kind in flight
    older: 0, maxOlder: 0,       // reads of an OLDER page (`before`) in flight
    olderFails: 0,               // how many older-page reads to fail before answering
  };
  const json = (res, code, j, extra = {}) => {
    const body = JSON.stringify(j);
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(body);
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (!p.startsWith('/api/')) {
      const f = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
      if (!path.resolve(f).startsWith(WEB)) { res.writeHead(403); return res.end(); }
      return fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(buf);
      });
    }
    const row = { path: p, url: req.url, session: u.searchParams.get('session') || '', at: Date.now(), end: 0, status: 0 };
    st.log.push(row);
    const reply = (code, j, extra) => { row.end = Date.now(); row.status = code; json(res, code, j, extra); };
    if (p === '/api/health') return reply(200, { ok: true, version: 'chat-lands-check' });
    if (req.method === 'GET' && Date.now() < st.limitedUntil)
      return reply(429, { ok: false, text: 'rate limited' }, { 'Retry-After': String(Math.ceil((st.limitedUntil - Date.now()) / 1000)) });
    if (p === '/api/projects') return reply(200, { ...fx('projects.json'), jarvis_enabled: false });
    if (p === '/api/grid') {
      st.busy++; st.maxBusy = Math.max(st.maxBusy, st.busy);
      return setTimeout(() => { st.busy--; reply(200, fx(`grid-${PROJECT}.json`)); }, st.slowAll);
    }
    if (p === '/api/settings') return reply(200, { global_nudge: false, sessions: {} });
    if (p === '/api/session') {
      const ms = st.convo[row.session] || [];
      const before = u.searchParams.get('before');
      const end = before ? Math.max(0, ms.findIndex(m => String(m.ts) === before)) : ms.length;
      const start = Math.max(0, end - 20);
      const body = { session: row.session, total: ms.length, messages: ms.slice(start, end),
                     next_before: start > 0 ? String(ms[start].ts) : null, ...(before ? {} : { queue: [] }) };
      // The contract the real daemon serves: an ETag over the body, and a 304 to a client
      // that already holds it. A client that never sends If-None-Match simply never sees one.
      const tag = '"' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"';
      if (before && st.olderFails > 0) { st.olderFails--; return reply(502, { ok: false, text: 'an older page that failed once' }); }
      if (before) {
        // An older page: a little slow, so two asked together would overlap and be counted.
        st.older++; st.maxOlder = Math.max(st.maxOlder, st.older);
        return setTimeout(() => { st.older--; reply(200, body); }, 400);
      }
      const n = ++st.reads;
      const odd = st.first && st.first(n);
      if (odd === 'fail') return reply(502, { ok: false, text: 'fleet-read --json did not return JSON: (a read that failed once)' });
      if (odd === '429') return reply(429, { ok: false, text: 'rate limited' }, { 'Retry-After': '2' });
      if (odd === 'hang') return;                    // never answers: a socket iOS killed, say
      st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
      st.busy++; st.maxBusy = Math.max(st.maxBusy, st.busy);
      let gone = false;
      res.on('close', () => { if (!row.end) { gone = true; st.inflight--; st.busy--; row.end = Date.now(); row.status = -1; } });
      setTimeout(() => {
        if (gone) return;
        st.inflight--; st.busy--;
        if (req.headers['if-none-match'] === tag) { row.end = Date.now(); row.status = 304; res.writeHead(304, { ETag: tag }); return res.end(); }
        reply(200, body, { ETag: tag });
      }, st.delay(n, row.session));
      return;
    }
    return reply(404, { ok: false, text: 'not in the fake' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { st, base: `http://127.0.0.1:${server.address().port}`, close: () => { try { server.closeAllConnections?.(); server.close(); } catch {} } };
}

// The installed app reopened on the session it was showing: a token this page process minted
// (sessionStorage, which a reload keeps) and the last screen (localStorage). Plus a visibility
// switch the scenario can flip — document.hidden and the event, which is what a resume hands
// the page.
const INIT = (session) => `(() => {
  try {
    sessionStorage.setItem('gf.session:' + location.origin, JSON.stringify({ t: 'chat-lands-token', exp: Date.now() / 1000 + 3600 }));
    localStorage.setItem('gf.last', JSON.stringify({ at: Math.floor(Date.now() / 1000), screen: 'session',
      project: '${PROJECT}', session: '${session}', view: 'chat' }));
  } catch {}
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  window.__setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) { try { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); } catch {} }
  };
})();`;

const until = async (fn, ms) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(100); } return v; };

// One Chrome and one daemon per scenario, so no scenario can see another's state.
async function scenario(name, run, { desktop = false, wide = false, open = null, history = 0 } = {}) {
  const d = await fakeDaemon();
  // A longer conversation than the fixture's, written BEFORE it: three more pages to scroll up
  // through, each message tall enough that a page fills a screen.
  if (history) {
    const t0 = d.st.convo[SESSION][0].ts - history * 60;
    d.st.convo[SESSION].unshift(...Array.from({ length: history }, (_, i) => ({ ts: t0 + i * 60,
      role: i % 2 ? 'assistant' : 'user',
      text: `earlier ${i + 1}: ${i % 2 ? 'the acme-api retry change, reviewed line by line, with the billing-svc caller checked against it' : 'and the toolbox build?'}` })));
  }
  if (open) open(d.st);
  if (wide) d.st.convo[SESSION].push({ ts: d.st.convo[SESSION][d.st.convo[SESSION].length - 1].ts + 60, role: 'assistant', text: WIDE });
  let b = null;
  try {
    b = desktop ? await launch({ width: 1280, height: 800, scale: 1 })
                : await launch({ width: 390, height: 844, scale: 2, mobile: true });
    if (!desktop) await b.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.call('Page.addScriptToEvaluateOnNewDocument', { source: INIT(SESSION) });
    await b.call('Page.navigate', { url: d.base + '/' });
    const chat = () => b.evaluate(() => { const c = document.querySelector('.chat'); return c ? c.textContent : ''; });
    const has = async (s) => (await chat()).includes(s);
    const last = wide ? 'Retry budget per endpoint' : d.st.convo[SESSION][d.st.convo[SESSION].length - 1].text;
    const say = (text) => d.st.convo[SESSION].push({ ts: Math.floor(Date.now() / 1000) + 1000, role: 'assistant', text });
    // An OPEN scenario is about the opening itself: it starts as soon as there is a chat on
    // screen to look at, and decides for itself whether the conversation ever arrives.
    if (open) {
      const shown = await until(() => b.evaluate(() => !!document.querySelector('.chat')), 15000);
      if (!shown) { is(`${name}: the chat screen is drawn`, true, false); return; }
      await run({ b, d, st: d.st, has, say, last });
      return;
    }
    const opened = await until(() => has(last), 20000);
    if (!opened) { is(`${name}: the chat opened on the fixture conversation`, true, false); return; }
    await run({ b, d, st: d.st, has, say });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) throw e;
    is(`${name}: ran`, 'yes', `no: ${String((e && e.message) || e).split('\n')[0]}`);
  } finally {
    if (b) await b.close();
    d.close();
  }
}

// Watches the screen from the moment the reply first shows until `ms` later and says whether
// it was ever missing again — the stale-overwrite question, asked of what was DRAWN.
async function staysFor(has, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!(await has(REPLY))) return false; await sleep(100); }
  return true;
}

const SCENARIOS = [
  // ── the control: nothing misbehaves ────────────────────────────────────────────
  // Green on the client that had the bug, and it is here for that: it is what proves the rows
  // below can see a reply land at all, so a red one is the scenario and not the harness.
  ['normal', async ({ st, has, say }) => {
    await sleep(800);
    say(REPLY);
    is('normal: a reply written while the chat is open appears without reopening', true, !!(await until(() => has(REPLY), 9000)));
    // ...and once it has, an idle chat goes on asking — cheaply. A page the client already
    // holds comes back as a 304 with no body, which is the whole poll on a cellular tunnel.
    const t0 = Date.now();
    await sleep(7000);
    const after = st.log.filter(r => r.path === '/api/session' && r.at >= t0);
    is('normal: ...and it keeps asking after the reply has landed', true, after.length >= 1);
    is('normal: ...with a conditional read the daemon answers 304', true, after.some(r => r.status === 304));
  }],

  // ── the owner is typing the next message ──────────────────────────────────────────
  // pollPaused() held the WHOLE poll while the composer had focus — so the keyboard would not
  // close under a half-typed message — and the reply then waited for the keyboard to go away.
  ['typing', async ({ b, has, say }) => {
    await b.evaluate(() => { const t = document.querySelector('.composer textarea'); t.focus(); return null; });
    await b.call('Input.insertText', { text: 'and also check the toolbox build' });
    await sleep(500);
    say(REPLY);
    is('typing: the reply lands while the owner is typing the next message', true, !!(await until(() => has(REPLY), 9000)));
    is('typing: ...and the box keeps its focus', true, await b.evaluate(() => {
      const a = document.activeElement; return !!a && a.tagName === 'TEXTAREA' && a.isConnected; }));
    is('typing: ...and its words', 'and also check the toolbox build',
       await b.evaluate(() => { const t = document.querySelector('.composer textarea'); return t ? t.value : ''; }));
  }],

  // ── a slow daemon ─────────────────────────────────────────────────────────────
  // 7 s a read, past the client's 5 s poll: the old client sent the next one anyway, and a
  // backlog of them is what came back as a burst. The grid is slow too, because a Mac too
  // busy to read a transcript quickly is too busy for everything else.
  ['slow', async ({ st, has, say }) => {
    st.delay = () => 7000; st.slowAll = 7000;
    st.maxInflight = st.inflight; st.maxBusy = st.busy;
    await sleep(500);
    say(REPLY);
    is('slow: with every read taking 7 s, the reply still appears', true, !!(await until(() => has(REPLY), 24000)));
    is('slow: ...and never more than one transcript read is in flight', 1, st.maxInflight);
    // One for the screen's own poll and one for the chat's: two pollers, never a backlog.
    is('slow: ...nor more than two reads of any kind', true, st.maxBusy <= 2);
  }],

  // ── a slow answer overtaken by a fast one ─────────────────────────────────────────
  // The read that was asked BEFORE the reply was written answers AFTER one that has it. The
  // screen must keep the newer: drawing whichever came back last puts the reply on screen and
  // then takes it away again.
  ['stale', async ({ b, st, has, say }) => {
    const n0 = st.reads;
    st.delay = (n) => (n === n0 + 1 ? 9000 : 0);
    await until(() => st.reads > n0, 8000);         // the slow one is asked, before the reply
    // Long enough that it is worth not waiting for, and then the reply.
    await sleep(3500);
    say(REPLY);
    // A second read, as anything that re-reads does: the 5 s poll for the old client, the
    // window taking focus for any client.
    await b.evaluate(() => { window.dispatchEvent(new Event('focus')); return null; });
    const shown = await until(() => has(REPLY), 12000);
    is('stale: the reply appears', true, !!shown);
    is('stale: ...and an older read landing later never takes it off the screen', true, shown ? await staysFor(has, 9000) : false);
  }],

  // ── a 429 burst ───────────────────────────────────────────────────────────────
  // The daemon says wait 20 s. A client that asks again before then spends the bucket it is
  // being told is empty — the old one asked every 5 s regardless — and one that never asks
  // again is the chat that never updates.
  ['429', async ({ st, has, say }) => {
    await sleep(500);
    const t0 = Date.now();
    st.limitedUntil = t0 + 20000;
    say(REPLY);
    const shown = await until(() => has(REPLY), 30000);
    const limited = st.log.filter(r => r.at >= t0 && r.at < st.limitedUntil && r.path.startsWith('/api/') && r.path !== '/api/health');
    is('429: told to wait 20 s, the client asks at most twice in that time (once per poller)', true, limited.length <= 2);
    is('429: ...and the reply appears once the daemon answers again', true, !!shown);
    is('429: ...within 4 s of it doing so', true, !!shown && Date.now() - st.limitedUntil < 4000);
  }],

  // ── backgrounded and resumed ──────────────────────────────────────────────────────
  // A read is in flight when the app leaves the screen; the reply is written while it is away;
  // it comes back. The reply has to be on screen at once — and stay there when the read from
  // before the background finally answers with what the transcript held then.
  ['resume', async ({ b, st, has, say }) => {
    const n0 = st.reads;
    st.delay = (n) => (n === n0 + 1 ? 9000 : 0);
    await until(() => st.reads > n0, 8000);
    await b.evaluate(() => { window.__setHidden(true); return null; });
    say(REPLY);
    await sleep(1500);
    await b.evaluate(() => { window.__setHidden(false); return null; });
    const shown = await until(() => has(REPLY), 3000);
    is('resume: the reply is on screen within 3 s of coming back', true, !!shown);
    is('resume: ...and the read from before the background does not take it away', true, shown ? await staysFor(has, 8000) : false);
  }],

  // ── a slow read of the session just left ───────────────────────────────────────────
  // Swiped to the next session while a read of this one was still out: when it answers, it
  // answers for a screen that has gone, and drawing it would put one session's conversation
  // under another's name.
  ['switch', async ({ b, st, has }) => {
    const n0 = st.reads, mine = st.convo[SESSION][st.convo[SESSION].length - 1].text;
    const theirs = st.convo[OTHER][st.convo[OTHER].length - 1].text;
    st.delay = (n, who) => (who === SESSION && n > n0 ? 6000 : 0);
    await until(() => st.reads > n0, 8000);
    await b.evaluate(() => {
      const c = document.querySelector('.chat'), r = c.getBoundingClientRect(), y = r.top + r.height / 2;
      const ev = (type, x) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch' }));
      ev('pointerdown', r.left + r.width * 0.8); ev('pointerup', r.left + r.width * 0.2);
      return null;
    });
    is('switch: a swipe opens the next session', true, !!(await until(() => has(theirs), 8000)));
    let leaked = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) { if (await has(mine)) { leaked = true; break; } await sleep(100); }
    is("switch: ...and the last session's slow read never draws there", false, leaked);
  }],

  // ── a wide table and a wide code line keep where the owner scrolled them ─────────────────
  // Reported from the phone and a desktop browser alike: scroll a table sideways, and it snaps
  // back to its first column — every poll rebuilt the message list, and a new element starts
  // at scrollLeft 0. So: scrolled, then a poll that brings nothing (which must change NO DOM
  // at all), then one that brings a message (which must add it and touch nothing else).
  ...['phone', 'desktop'].map((where) => [`scroll-${where}`, async ({ b, st, has, say }) => {
    const n = `scroll (${where})`;
    const wide = await b.evaluate(() => {
      const t = [...document.querySelectorAll('.chat .md-table:not(.fit)')].pop(), c = [...document.querySelectorAll('.chat .md-code')].pop();
      const out = {};
      for (const [k, e] of [['table', t], ['code', c]]) {
        if (!e) { out[k] = -1; continue; }
        e.scrollLeft = 140; e.__gfMark = k; out[k] = e.scrollLeft;
      }
      return out;
    });
    is(`${n}: fixture: the table is wider than its bubble, and scrolled`, true, wide.table > 0);
    is(`${n}: fixture: the code line is too, and scrolled`, true, wide.code > 0);
    // Text selected in the bubble above, as someone copying a number out of it would.
    await b.evaluate(() => {
      const td = [...document.querySelectorAll('.chat .md-table:not(.fit) td')].find(x => /4120 ms/.test(x.textContent));
      const r = document.createRange(); r.selectNodeContents(td);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return null;
    });
    // Every mutation under #app from here, so "nothing changed" is counted rather than inferred.
    await b.evaluate(() => {
      window.__muts = 0;
      new MutationObserver((l) => { window.__muts += l.length; })
        .observe(document.getElementById('app'), { subtree: true, childList: true, attributes: true, characterData: true });
      return null;
    });
    const t0 = Date.now();
    await sleep(6500);                         // past the 5 s poll AND the chat's own
    const asked = st.log.filter(r => r.path === '/api/session' && r.at >= t0).length;
    is(`${n}: the chat polled while nothing changed`, true, asked >= 1);
    is(`${n}: ...and a poll that brought nothing changed no DOM at all`, 0, await b.evaluate(() => window.__muts));
    const where1 = await b.evaluate(() => ({ t: ([...document.querySelectorAll('.chat .md-table:not(.fit)')].pop() || {}).scrollLeft,
      c: ([...document.querySelectorAll('.chat .md-code')].pop() || {}).scrollLeft }));
    is(`${n}: ...the table is where it was scrolled to`, wide.table, where1.t);
    is(`${n}: ...and so is the code line`, wide.code, where1.c);
    say(REPLY);
    is(`${n}: a new message arrives`, true, !!(await until(() => has(REPLY), 9000)));
    await sleep(500);
    const after = await b.evaluate(() => {
      const t = [...document.querySelectorAll('.chat .md-table:not(.fit)')].pop(), c = [...document.querySelectorAll('.chat .md-code')].pop();
      return { t: t && t.scrollLeft, c: c && c.scrollLeft, same: !!t && t.__gfMark === 'table' && !!c && c.__gfMark === 'code',
               sel: String(getSelection()) };
    });
    is(`${n}: ...and the table keeps its scroll`, wide.table, after.t);
    is(`${n}: ...and the code line keeps its scroll`, wide.code, after.c);
    is(`${n}: ...because they are the same elements, not rebuilt ones`, true, after.same);
    is(`${n}: ...and the selection in it survives`, '4120 ms', after.sel.trim());
  }, { desktop: where === 'desktop', wide: true }]),

  // ── the owner scrolled up to read history ─────────────────────────────────────────
  // The conversation's own scroll: up in the history, a poll and a new message must leave the
  // reader where they are — not at the bottom, and not at the top.
  ['history', async ({ b, has, say }) => {
    const up = await b.evaluate(() => {
      const c = document.querySelector('.chat');
      c.scrollTop = Math.max(0, Math.floor((c.scrollHeight - c.clientHeight) / 3));
      c.dispatchEvent(new Event('scroll'));
      return { top: c.scrollTop, end: c.scrollHeight - c.clientHeight };
    });
    is('history: fixture: the chat is scrolled up, away from the end', true, up.top > 0 && up.top < up.end - 50);
    await sleep(6500);
    is('history: a poll leaves the reader where they were', up.top, await b.evaluate(() => document.querySelector('.chat').scrollTop));
    say(REPLY);
    await until(() => has(REPLY), 9000);
    await sleep(500);
    is('history: ...and so does a new message', up.top, await b.evaluate(() => document.querySelector('.chat').scrollTop));
  }],

  // ── opening a chat: it loads, whatever the first read does ──────────────────────────
  // "Sometimes opening a chat shows nothing until I SEND a message." The first read of the
  // conversation can be slow (the daemon's log had 8-26 s), refused (429) or fail, and the
  // old client had two ways to leave the screen empty after it: the read was retried only by
  // the 5 s poll, which is held while the composer has focus — and a phone owner opening a
  // chat taps straight into the box — and a read that DID land while they typed was not drawn
  // (renderUnlessTyping) until something forced a render, which a send does. So: open, type
  // at once, and the conversation must arrive with nothing sent; and while it has not, the
  // screen says so in words, not with an empty list.
  ...[['slow', (n) => null, 6000], ['429', (n) => (n === 1 ? '429' : null), 0], ['fail', (n) => (n === 1 ? 'fail' : null), 0],
      ['hang', (n) => (n === 1 ? 'hang' : null), 0]].map(([kind, first, slow]) => [`open-${kind}`, async ({ b, st, has, last }) => {
    const n = `open (${kind})`;
    await b.evaluate(() => { const t = document.querySelector('.composer textarea'); if (t) t.focus(); return null; });
    await b.call('Input.insertText', { text: 'check the billing-svc build' });
    let said = '', skeleton = false;
    const t0 = Date.now();
    const shown = await until(async () => {
      if (await has(last)) return true;
      const st = await b.evaluate(() => { const c = document.querySelector('.chat'), l = c && c.querySelector('.loading');
        return { line: l ? l.textContent : '', busy: !!c && c.getAttribute('aria-busy') === 'true' && !!c.querySelector('.bub.skel') }; });
      if (st.line) said = st.line;
      if (st.busy) skeleton = true;
      return false;
    }, kind === 'hang' ? 25000 : 15000);
    is(`${n}: the conversation appears without sending anything`, true, !!shown);
    // Waiting is drawn as the skeleton, without words (the phone's rule since v70); a read that
    // FAILED is said in words, with the reason and that it is being asked again.
    // A read that never answers is given up on and asked again at once, so it is a wait too:
    // the "retrying" line is up only for the instant between the two.
    if (kind === 'slow' || kind === 'hang') is(`${n}: ...and while it waited, the chat drew its skeleton`, true, skeleton);
    else is(`${n}: ...and once a read had failed, the chat said it was retrying`, true, /retrying/.test(said));
    is(`${n}: ...and nothing was sent`, 0, st.log.filter(r => r.path === '/api/verb').length);
    is(`${n}: ...and the half-typed message is still in the box`, 'check the billing-svc build',
       await b.evaluate(() => { const t = document.querySelector('.composer textarea'); return t ? t.value : ''; }));
    if (process.env.CHAT_LANDS_DEBUG) console.error(n, Date.now() - t0, 'ms', JSON.stringify(said));
  }, { open: (st) => { st.first = first; if (slow) st.delay = (k) => (k === 1 ? slow : 0); } }]),

  // ── older messages load by scrolling up ─────────────────────────────────────────────
  // "AUTO-LOAD older messages": the reader scrolls to the top and the page above arrives with
  // no press, prepended so the message they were reading stays exactly where it was; one fetch
  // at a time; at the start a quiet marker, and nothing fetched after it.
  ['older-auto', async ({ b, st, has }) => {
    const olderAsked = () => st.log.filter(r => r.path === '/api/session' && /\bbefore=/.test(r.url || '')).length;
    const toTop = () => b.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); return null; });
    // The message at the top of the screen once the reader has scrolled up: its place on
    // screen is what must not change when the page above it arrives.
    await toTop();
    const anchor = await b.evaluate(() => {
      const c = document.querySelector('.chat'), top = c.getBoundingClientRect().top;
      const t = [...c.querySelectorAll('.turn')].find(n => n.getBoundingClientRect().bottom > top + 1);
      if (!t) return null;
      t.__gfAnchor = 1;
      return { y: t.getBoundingClientRect().top, text: t.textContent.slice(0, 40) };
    });
    is('older-auto: fixture: there is a message at the top of the screen', true, !!anchor);
    // The middle of the page directly above the one on screen (the newest 20 are on screen).
    const firstOlder = st.convo[SESSION][st.convo[SESSION].length - 30].text;
    const loaded = await until(() => has(firstOlder), 6000);
    is('older-auto: scrolled to the top, the older page loads with no press', true, !!loaded);
    await sleep(400);
    const y = await b.evaluate(() => { const t = [...document.querySelectorAll('.chat .turn')].find(n => n.__gfAnchor); return t ? t.getBoundingClientRect().top : null; });
    is('older-auto: ...and the message the reader was on did not move', true, !!loaded && y != null && anchor && Math.abs(y - anchor.y) <= 2);
    // Up again, page by page, to the start.
    let marker = false;
    for (let i = 0; i < 12 && !marker; i++) {
      await toTop(); await sleep(700);
      marker = await b.evaluate(() => !!document.querySelector('.chat .start') && /start of conversation/.test(document.querySelector('.chat .start').textContent));
    }
    is('older-auto: at the start, a quiet "start of conversation" marker', true, marker);
    is('older-auto: ...and the very first message is there', true, await has(st.convo[SESSION][0].text));
    is('older-auto: ...one older page in flight at a time', 1, st.maxOlder);
    const n0 = olderAsked();
    for (let i = 0; i < 3; i++) { await toTop(); await sleep(400); }
    is('older-auto: ...and past the start nothing more is fetched', true, marker && olderAsked() === n0);
    is('older-auto: ...and no "load older" button, since nothing failed', 0,
       await b.evaluate(() => [...document.querySelectorAll('.chat button')].filter(x => /older/.test(x.textContent)).length));
  }, { history: 56 }],

  // ...and when that fetch FAILS, the button comes back, as the only way to ask again: retrying
  // on every scroll event would be a retry loop at the speed of a thumb.
  ['older-fail', async ({ b, st, has }) => {
    st.olderFails = 1;
    const above = st.convo[SESSION][st.convo[SESSION].length - 30].text;
    await b.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); return null; });
    const said = await until(() => b.evaluate(() => { const r = document.querySelector('.chat .older'); return r && /did not load/.test(r.textContent) ? r.textContent : ''; }), 6000);
    is('older-fail: a failed older page says so at the top', true, !!said);
    const asked = st.log.filter(r => /\bbefore=/.test(r.url || '')).length;
    for (let i = 0; i < 3; i++) { await b.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); return null; }); await sleep(300); }
    is('older-fail: ...and scrolling does not keep retrying it', asked, st.log.filter(r => /\bbefore=/.test(r.url || '')).length);
    const pressed = await b.evaluate(() => { const x = [...document.querySelectorAll('.chat .older button')].find(n => /older/.test(n.textContent)); if (!x) return false; x.click(); return true; });
    is('older-fail: ...with the button to ask again', true, pressed);
    is('older-fail: ...which loads it', true, !!(await until(() => has(above), 6000)));
  }, { history: 56 }],

  // ── after "load older" ────────────────────────────────────────────────────────────
  // Paging back used to freeze the transcript: "refetching would throw away the older messages
  // you deliberately went and got", so it stopped refetching at all.
  ['older', async ({ b, st, has, say }) => {
    const first = st.convo[SESSION][0].text;
    // Up to the ceiling, which is what loads the page above now (older-auto).
    await b.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); return null; });
    is('older: the older page is loaded', true, !!(await until(() => has(first), 5000)));
    say(REPLY);
    is('older: after loading older messages, a new reply still appears', true, !!(await until(() => has(REPLY), 9000)));
    is('older: ...and the older messages are still there', true, await has(first));
  }],
];

let failed = null;
try {
  // AT MOST FOUR CHROMES AT ONCE: each scenario is a browser of its own, and a machine running
  // a fleet has other things to do.
  const queue = SCENARIOS.slice();
  const lanes = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) { const [name, run, opts] = queue.shift(); await scenario(name, run, opts); }
  });
  await Promise.all(lanes);
} catch (e) {
  if (/no chrome/i.test(String(e && e.message))) { skipGroup('an open chat converges', 'no chrome to run the client in'); done(0); }
  failed = e;
}
if (failed) { console.error(String(failed && failed.stack || failed)); }
// Grouped by scenario rather than by finishing order, so a diff between two runs lines up.
const order = SCENARIOS.map(([n]) => n);
const scen = (r) => { const h = r.split(':')[0]; const m = /^scroll \((\w+)\)$/.exec(h); return order.indexOf(m ? `scroll-${m[1]}` : h); };
rows.sort((a, b) => scen(a) - scen(b));
done(failed ? 1 : 0);
