#!/usr/bin/env node
// test/helpers/pwa-origin.mjs — which backend the phone client picks, and why.
//
//     node test/helpers/pwa-origin.mjs <live-fleet-serve-base>
//
// One "name <US> want <US> got" row per check, like the other helpers; test/run.sh does
// the comparing.
//
// THE BUG THIS EXISTS FOR. `web/api.js` chose fixtures whenever `gf.base` was unset, and
// nothing ever set it — so the client fleet-serve itself serves ran on sample data. A
// phone on the tailnet opened the daemon's own URL and was shown four projects that do
// not exist on this machine, with a local-only passkey and no enrolment prompt, and
// `fleet-serve clients` still said "(no clients enrolled)" because the client had never
// made a request. Nothing about that looks like a failure from either end.
//
// So the assertion that matters here is the POSITIVE one: served by the daemon, with no
// setting at all, the client must choose SERVER. A suite that only proved "a static
// server means fixtures" would have passed on the broken code — that half was never
// wrong. Every case below is therefore run in both directions, and the two escape
// hatches (force fixtures while the daemon serves the page, force an origin while
// something else does) are asserted as overriding, one each way.
//
// It talks to a REAL fleet-serve on loopback for the server case and to two real static
// servers for the fixture cases, because the interesting part is a response nobody wrote
// down here: the 401 body, its content type, and the fact that the gate answers before
// the routing table does.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// ── the browser's two globals, stubbed BEFORE api.js is imported ───────────
// defineProperty, not assignment, and not a read first: node ≥22 defines `localStorage`
// as a lazy accessor that prints "localStorage is not available because
// --localstorage-file was not provided" to STDERR the moment it is touched. run.sh
// asserts this helper's stderr is empty, so a stray read would fail the group with a
// warning that has nothing to do with the client.
const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  },
});
// Where the page is standing. A file:// open has origin 'null', which is the case that
// must not be probed at all.
function pageAt(origin) {
  if (!origin) { globalThis.location = { origin: 'null', protocol: 'file:', host: '', hostname: '' }; return; }
  const u = new URL(origin);
  globalThis.location = { origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname };
}
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { fetches++; return realFetch(...a); };

const api = await import(new URL('../../web/api.js', import.meta.url).href);
const pk = await import(new URL('../../web/passkey.js', import.meta.url).href);

// ── the servers ───────────────────────────────────────────────────────────
function listen(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => res({ server: s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const SHELL = fs.readFileSync(path.join(ROOT, 'web', 'index.html'));
// `cd web && python3 -m http.server` — the way this client gets reviewed (web/README.md).
// The shell at /, a text/html 404 for everything else.
const plain = await listen((req, res) => {
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SHELL); return; }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE HTML>\n<title>404 Not Found</title>\n');
});
// The nastier static server: an SPA fallback, so /api/health answers 200 with a PAGE. A
// status check alone reads that as success; only the content type gives it away.
const spa = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SHELL); });
// A port with nothing listening: the connection is refused rather than answered.
const closed = await listen(() => {});
const DEAD = closed.base;
await new Promise((r) => closed.server.close(r));

const LIVE = (process.argv[2] || '').replace(/\/+$/, '');
is('a live fleet-serve base was given', true, !!LIVE);

// ── 1. probeVerdict, on responses written out by hand ──────────────────────
// The decision itself, with no network in it: every shape the probe can meet, and what
// it has to conclude. The 401 row is the whole fix — it is the answer a cold, unenrolled
// daemon gives, and reading it as "no server" is the bug.
const V = [
  ['401 + the auth envelope is PROOF of a server', 'server',
   { status: 401, contentType: 'application/json; charset=utf-8', body: { ok: false, text: 'no live session — assert a passkey at /api/auth', needs: 'passkey' } }],
  ['200 + an authenticated health answer', 'server',
   { status: 200, contentType: 'application/json; charset=utf-8', body: { ok: true, version: '0.9.0' } }],
  ['429 rate limited is still the API', 'server',
   { status: 429, contentType: 'application/json; charset=utf-8', body: { ok: false, text: 'rate limited' } }],
  ['403 on an unexpected Host is still the API', 'server',
   { status: 403, contentType: 'application/json; charset=utf-8', body: { ok: false, error: "unexpected Host 'x'" } }],
  ['500 is a broken fleet, not an absent one', 'server',
   { status: 500, contentType: 'application/json; charset=utf-8', body: { ok: false, text: 'config unreadable' } }],
  ['404 text/html is a static server', 'fixtures',
   { status: 404, contentType: 'text/html; charset=utf-8', body: null }],
  ['404 is not this API even when it is JSON', 'fixtures',
   { status: 404, contentType: 'application/json', body: { ok: false, text: 'not found' } }],
  ['200 text/html is an SPA fallback, not an answer', 'fixtures',
   { status: 200, contentType: 'text/html; charset=utf-8', body: null }],
  ['200 JSON from somebody else\'s service', 'fixtures',
   { status: 200, contentType: 'application/json', body: { hello: 'world' } }],
  ['a JSON content type with an unparseable body', 'fixtures',
   { status: 200, contentType: 'application/json', body: null }],
  ['an array is not an envelope', 'fixtures',
   { status: 200, contentType: 'application/json', body: [] }],
  ['nothing answered at all', 'fixtures', { status: 0, contentType: '', body: null }],
];
for (const [name, want, r] of V) is(name, want, api.probeVerdict(r));

// ── 2. the premise, measured against the real daemon ──────────────────────
// Not "we believe a cold GET is 401" — the response, from a fleet-serve that is running
// with nothing enrolled. If this ever stops being a 401 with a JSON envelope, the probe
// above is deciding on a signal that no longer exists, and these rows are what says so.
if (LIVE) {
  let pr = null, body = null, ct = '';
  try {
    pr = await realFetch(LIVE + api.PROBE_PATH, { headers: { accept: 'application/json' } });
    ct = (pr.headers.get('content-type') || '').split(';')[0];
    body = await pr.json();
  } catch (e) { body = { fetchError: String(e && e.message || e) }; }
  is(`a cold ${api.PROBE_PATH} is refused`, 401, pr ? pr.status : 0);
  is('...as JSON, not a page', 'application/json', ct);
  is('...naming the passkey as what is missing', 'passkey', body && body.needs);
  is('...and the probe reads that as a server', 'server',
     api.probeVerdict({ status: pr ? pr.status : 0, contentType: ct, body }));
}

// ── 3. the decision, end to end, against real servers ─────────────────────
async function decide(origin, setup) {
  stored.clear();
  if (setup) setup();
  pageAt(origin);
  return api.reprobe();
}

if (LIVE) {
  // THE ROW THIS FILE IS FOR: no setting, served by the daemon, and it must not pick
  // fixtures.
  const r = await decide(LIVE);
  is('served BY fleet-serve, unset: server', 'server', r.mode);
  is('...talking to the origin it was served from', LIVE, r.base);
  is('...because it asked, not because it was told', 'probe', r.source);
  is('...and baseUrl() is that origin', LIVE, api.baseUrl());
  is('...and the mode chip names the host', LIVE.replace(/^https?:\/\//, ''), api.modeLabel());
  is('...and the lock screen says which origin', true, r.detail.includes(LIVE));
  is('...and there is nothing to bypass', false, pk.bypassAllowed());
}

// A bare static server is how the client gets reviewed (web/README.md), and it has to
// keep landing in fixtures.
{
  const r = await decide(plain.base);
  is('a static server, unset: fixtures', 'fixtures', r.mode);
  is('...with no base to send requests to', '', r.base);
  is('...and it says the origin has no fleet', true, r.detail.includes(plain.base));
  is('...and the fixture bypass is offered', true, pk.bypassAllowed());
}
{
  const r = await decide(spa.base);
  is('an SPA fallback (200 text/html): fixtures', 'fixtures', r.mode);
  is('...named as having no fleet behind it', true, /no fleet is behind it/.test(r.detail));
}
{
  const r = await decide(DEAD);
  is('nothing listening: fixtures', 'fixtures', r.mode);
  is('...and it says nothing answered', true, /nothing answered/.test(r.detail));
}
{
  const before = fetches;
  const r = await decide(null);            // a file:// open
  is('file://: fixtures', 'fixtures', r.mode);
  is('...without asking anybody', 0, fetches - before);
}

// ── 4. an explicit setting wins, in BOTH directions ───────────────────────
if (LIVE) {
  // Fixtures on purpose while the daemon is the thing serving the page — the demo case.
  const r = await decide(LIVE, () => api.useFixtures());
  is('forced fixtures beat a live origin', 'fixtures', r.mode);
  is('...and say it was a choice', 'setting', r.source);
  is('...without a probe', 'fixtures — chosen in settings', r.detail);
  // A base on purpose while something else serves the page.
  const s = await decide(plain.base, () => api.setBaseUrl(LIVE));
  is('a forced base beats a static origin', 'server', s.mode);
  is('...and it is the base that was set', LIVE, s.base);
  is('...named as a setting, not a probe', 'setting', s.source);
}

// ── 5. "unset" and "fixtures" are different values now ────────────────────
// The half of the bug that is invisible: while both were the empty string, "I have not
// said" could only be read as "fixtures", and no default could ever be added.
stored.clear();
is('nothing stored is auto', 'auto', api.pref().kind);
api.useAutoDetect();
is('...and so is auto, once chosen', 'auto', api.pref().kind);
is('...which stores nothing at all', null, localStorage.getItem('gf.base'));
api.useFixtures();
is('forced fixtures is its own value', 'fixtures', api.pref().kind);
is('...distinguishable from unset', 'fixtures', localStorage.getItem('gf.base'));
api.setBaseUrl('http://mac.ts.net:8787/');
is('a URL is a URL', 'server', api.pref().kind);
is('...with its trailing slash gone', 'http://mac.ts.net:8787', api.pref().base);
api.setBaseUrl('');
is('an emptied URL box means auto, not fixtures', 'auto', api.pref().kind);

// ── 6. the window before the answer is not fixtures ───────────────────────
// A mode that reads 'fixtures' until the probe returns is the same bug on a shorter
// clock: the screens would draw sample data, and the lock screen would offer the
// gate-free path, on a page served by the daemon.
stored.clear();
pageAt(LIVE || plain.base);
api.reprobe();
is('before the answer, the mode is probing', 'probing', api.mode());
is('...not fixtures', false, api.mode() === 'fixtures');
is('...and nothing may be bypassed yet', false, pk.bypassAllowed());
is('...and there is no base to fetch from', '', api.baseUrl());
await api.ready();
// An explicit setting needs no window at all: it is known synchronously.
stored.clear(); api.useFixtures(); pageAt(LIVE || plain.base);
is('an explicit setting skips probing', 'fixtures', api.mode());
stored.clear(); api.setBaseUrl('http://mac.ts.net:8787');
is('...in the server direction too', 'server', api.mode());

plain.server.close(); spa.server.close();
console.log(rows.join('\n'));
