#!/usr/bin/env node
// test/helpers/pwa-relaunch.mjs — a relaunch inside the idle window needs no Face ID.
//
//     node test/helpers/pwa-relaunch.mjs <base> <storage.json>
//
// <storage.json> is what test/helpers/pwa-enrol.mjs left in localStorage after a real
// unlock. This is a NEW process — the token variable in web/api.js starts empty, exactly as
// it does when iOS has evicted the home-screen app and the owner taps it again — and it
// drives web/passkey.js's own resume() against the live daemon. The authenticator is a
// counter that fails the row if touched: the point is that it is NOT asked.
//
// Then the other direction, because a resume that always said 'ok' would pass the first
// half: a token the server does not know is refused, CLEARED from storage (so it is tried
// once, not at every launch), and still without the sensor — the lock screen is where
// Face ID lives, not resume().
import fs from 'node:fs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const stored = new Map(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  },
});
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

is('a relaunch starts with no token in memory', false, api.haveToken());
is('...but one on the device', true, !!stored.get(KEY));
is('the relaunch resumes the stored session', 'ok', await pk.resume());
is('...without asking for Face ID', 0, sensor);
is('...and the app holds a live token', true, api.haveToken());
// Bound to what the server just said, not what was stored: the read slid it.
const exp = JSON.parse(stored.get(KEY) || '{}').exp;
is('...whose stored deadline is the server\'s', true, Number.isFinite(exp) && exp > Date.now() / 1000);

// A token the server does not honour (expired, revoked — it cannot tell which, and need not).
api.clearToken();
stored.set(KEY, JSON.stringify({ t: 'not-a-token-this-daemon-minted', exp: Date.now() / 1000 + 600 }));
is('a dead stored token is refused by the server', 'rejected', await pk.resume());
is('...and cleared from the device', null, stored.get(KEY) ?? null);
is('...still without the sensor', 0, sensor);
is('...so the next launch has nothing to try', 'none', await pk.resume());
// And one the client can see is past its deadline is not even sent.
stored.set(KEY, JSON.stringify({ t: 'whatever', exp: Date.now() / 1000 - 1 }));
is('a visibly expired one is not tried', 'none', await pk.resume());
is('...and is dropped too', null, stored.get(KEY) ?? null);
console.log(rows.join('\n'));
