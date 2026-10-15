#!/usr/bin/env node
// test/helpers/pwa-relaunch.mjs — a cold launch is LOCKED; the app's own reload is not.
//
//     node test/helpers/pwa-relaunch.mjs <base> <storage.json>
//
// <storage.json> is what test/helpers/pwa-enrol.mjs left on the "device" after a real
// unlock: { local: [...localStorage], session: [...sessionStorage] }. This is a NEW process
// — the token variable in web/api.js starts empty — and it drives web/passkey.js's own
// resume() against the live daemon, in the three shapes a page load comes in:
//
//   a COLD LAUNCH   — closed from the app switcher, then opened. Measured in an installed
//                     iOS home-screen app: localStorage survives the kill, sessionStorage
//                     does not. So it starts with localStorage only, and must stay locked.
//   a RELOAD        — the app taking a new client from its service worker. Same page
//                     process, so sessionStorage is still there; it must NOT lock.
//   an OLD CLIENT'S COPY — every phone that ran the localStorage version holds a live
//                     token there. The first open of this version must not walk in on it,
//                     and must END it on the server, not just forget it.
//
// The authenticator is a counter that fails the row if touched: resume() never asks for a
// face — the lock screen is where Face ID lives.
import fs from 'node:fs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const dev = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const store = (entries) => {
  const m = new Map(entries);
  return { m, api: {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  } };
};
const local = store(dev.local || []);
// A cold launch: what the kill left of the page's sessionStorage, which is nothing.
const session = store([]);
for (const [name, s] of [['localStorage', local], ['sessionStorage', session]])
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: s.api });
const U = new URL(BASE);
globalThis.location = { origin: U.origin, protocol: U.protocol, host: U.host, hostname: U.hostname };
globalThis.window = { PublicKeyCredential: function PublicKeyCredential() {}, isSecureContext: true };
let sensor = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { credentials: { async get() { sensor++; return null; }, async create() { sensor++; return null; } } },
});

const api = await import(new URL('../../web/api.js', import.meta.url).href);
const pk = await import(new URL('../../web/passkey.js', import.meta.url).href);
const KEY = `gf.session:${BASE}`;
const live = new Map(dev.session || []).get(KEY);
const tok = live ? JSON.parse(live).t : '';
const asks = async (t) => (await fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${t}` } })).status;

// ── a cold launch ──────────────────────────────────────────────────────────
is('the unlocked page held a token', true, !!tok);
is('...which the server honours', 200, tok ? await asks(tok) : 0);
is('a cold launch starts with no token in memory', false, api.haveToken());
is('...and the credential is still on the device', true, !!local.m.size);
is('a cold launch does not resume a session', 'none', await pk.resume());
is('...so the app stays locked', false, api.haveToken());
is('...without asking for Face ID by itself', 0, sensor);

// ── the app reloading itself (a new client from the service worker) ───────
session.m.set(KEY, live);
is('a reload of the same page resumes its session', 'ok', await pk.resume());
is('...without asking for Face ID', 0, sensor);
is('...and the app holds a live token', true, api.haveToken());
// Bound to what the server just said, not what was stored: the read slid it.
const exp = JSON.parse(session.m.get(KEY) || '{}').exp;
is('...whose stored deadline is the server\'s', true, Number.isFinite(exp) && exp > Date.now() / 1000);
is('...and it is never written where a kill would leave it', null, local.m.get(KEY) ?? null);

// ── the copy an older client kept in localStorage ──────────────────────────
// The live token, exactly where the previous version stored it, and a cold launch.
api.clearToken();
session.m.clear();
local.m.set(KEY, JSON.stringify({ t: tok, exp: Date.now() / 1000 + 600 }));
is('an old client\'s stored token is not resumed', 'none', await pk.resume());
is('...so its first open is locked too', false, api.haveToken());
is('...and the copy is taken off the device', null, local.m.get(KEY) ?? null);
is('...and ended on the server, not just forgotten', 401, await asks(tok));
is('...still without the sensor', 0, sensor);

// ── a token the server does not honour, in a reload ────────────────────────
session.m.set(KEY, JSON.stringify({ t: 'not-a-token-this-daemon-minted', exp: Date.now() / 1000 + 600 }));
is('a dead token is refused by the server', 'rejected', await pk.resume());
is('...and cleared', null, session.m.get(KEY) ?? null);
is('...so the next load has nothing to try', 'none', await pk.resume());
// And one the client can see is past its deadline is not even sent.
session.m.set(KEY, JSON.stringify({ t: 'whatever', exp: Date.now() / 1000 - 1 }));
is('a visibly expired one is not tried', 'none', await pk.resume());
is('...and is dropped too', null, session.m.get(KEY) ?? null);
console.log(rows.join('\n'));
