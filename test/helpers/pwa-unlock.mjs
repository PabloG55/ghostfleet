#!/usr/bin/env node
// test/helpers/pwa-unlock.mjs — the unlock tap, under WebKit's one rule, against a real daemon.
//
//     node test/helpers/pwa-unlock.mjs <base> <enrolment-code> [client-id]
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE BUG THIS EXISTS FOR. WebKit shows the passkey sheet only to a navigator.credentials.get()
// made with transient user activation — inside the tap's own handler. The unlock button
// awaited a challenge fetch first, so the call arrived after the tap had stopped counting and
// was refused without a sheet. The daemon's log is the fingerprint: one GET
// /api/auth/challenge per tap, never a POST /api/auth/assert, and — because the refusal was
// never drawn — taps in bursts of four or five until the rate limit locked the owner out.
//
// So the fake below holds get() to that rule exactly: activation is true only for the
// synchronous extent of tap(), and a get() made outside it rejects with NotAllowedError, the
// way WebKit does. That is stricter than any real browser that propagates a gesture through
// a short fetch, and it is the shape the client has to survive.
import { Authenticator } from './serve-client.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  },
});
// The session token's store (api.js). Node 20 has none, and a missing one is a token that
// silently never persists — stubbed, so the client runs here as it does on the phone.
const session = new Map();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => { session.set(k, String(v)); },
    removeItem: (k) => { session.delete(k); },
  },
});
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const CODE = process.argv[3] || '';
const U = new URL(BASE);
globalThis.location = { origin: U.origin, protocol: U.protocol, host: U.host, hostname: U.hostname };
globalThis.window = { PublicKeyCredential: function PublicKeyCredential() {}, isSecureContext: true };

// What crossed the wire, by route — the client is judged by what it ASKED the daemon for.
const asked = { challenge: 0, assert: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.includes('/api/auth/challenge')) asked.challenge++;
  if (u.includes('/api/auth/assert')) asked.assert++;
  return realFetch(url, init);
};

const auth = new Authenticator({ rpId: U.hostname, origin: BASE });
const b64u = (b) => Buffer.from(b).toString('base64url');
let activation = false;
function tap(fn) { activation = true; try { return fn(); } finally { activation = false; } }
const notAllowed = () => Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });

// How the next sheet behaves once it IS shown: 'sign', 'cancel', 'forge', or 'hold' (it
// stays up until release() — what a slow face looks like to the page).
let sheet = 'sign', held = null, gets = 0, shown = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
    credentials: {
      async create({ publicKey }) {
        const r = auth.createResult(b64u(publicKey.challenge));
        return { rawId: r.rawId, response: { attestationObject: r.attestationObject, clientDataJSON: r.clientDataJSON } };
      },
      // NOT async: the activation check has to happen at the moment of the call.
      get({ publicKey }) {
        gets++;
        if (!activation) return Promise.reject(notAllowed());
        shown++;
        const answer = () => {
          if (sheet === 'cancel') throw notAllowed();
          const r = auth.getResult(b64u(publicKey.challenge));
          const sig = sheet === 'forge' ? Buffer.alloc(70) : r.signature;
          return { rawId: r.rawId, response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: sig } };
        };
        if (sheet === 'hold') return new Promise((res, rej) => { held = () => { try { sheet = 'sign'; res(answer()); } catch (e) { rej(e); } }; });
        return Promise.resolve().then(answer);
      },
    },
  },
});

const api = await import(new URL('../../web/api.js', import.meta.url).href);
const pk = await import(new URL('../../web/passkey.js', import.meta.url).href);
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.log('CRASH' + US + '""' + US + JSON.stringify(String(e && e.stack || e).split('\n')[0])); process.exit(1); });
const settle = (p) => p.then(() => 'ok', (e) => e);
// 'ok', or the error as words: a row that wanted 'ok' then says what it got instead of {}.
const outcome = (p) => p.then(() => 'ok', (e) => `${e && e.name}: ${e && e.message}`);

api.reprobe(); api.setBaseUrl(BASE); await api.ready();
let enrolled = false;
try { enrolled = await pk.register(CODE); } catch (e) { is('enrolment error', '', String(e.message || e)); }
is('the phone enrols', true, enrolled);
api.clearToken();

// ── 1. the challenge is fetched BEFORE the tap, and the tap signs it ──────
await pk.prepare();
is('a challenge is ready before any tap', true, pk.prepared());
let before = { ...asked };
sheet = 'sign';
is('the first tap unlocks', 'ok', await outcome(tap(() => pk.open())));
is('...because the sensor was asked inside the tap', 1, shown);
is('...with no challenge fetched between tap and sheet', 0, asked.challenge - before.challenge);
is('...and the assertion reached the daemon', 1, asked.assert - before.assert);
is('...which minted a session', true, api.haveToken());

// ── 2. taps while a ceremony runs do nothing, and fetch nothing ───────────
api.clearToken();
await pk.prepare();
before = { ...asked }; const gets0 = gets;
sheet = 'hold';
const p1 = tap(() => pk.open());
const again = [];
for (let i = 0; i < 4; i++) again.push(tap(() => pk.open()));
for (const p of [p1, ...again]) p.catch(() => {});      // judged below, never unhandled
// Counted after a pause, because the old client's per-tap fetch was ASYNC: counted at once,
// it read 0 on the code that fetched four challenges, and passed for the wrong reason.
await new Promise((r) => setTimeout(r, 150));
is('four more taps start no ceremony', 1, gets - gets0);
is('...and ask the daemon for nothing', 0, asked.challenge - before.challenge);
is('...they are the same unlock', true, again.every((p) => p === p1));
is('the app can see one is running', true, pk.unlocking() && pk.busy());
if (held) held();
is('the held sheet unlocks', 'ok', await outcome(p1));
is('...one assertion for five taps', 1, asked.assert - before.assert);
is('...and nothing is running after it', false, pk.unlocking());

// ── 3. one automatic attempt; WebKit refuses it; the FIRST tap still works ─
api.clearToken();
await pk.prepare();
before = { ...asked }; const gets1 = gets;
sheet = 'sign';
pk.arm();
is('the automatic attempt is refused without a tap', 'refused', await pk.autoUnlock());
is('a second automatic attempt does not happen', 'skipped', await pk.autoUnlock());
is('...one get() for the whole open', 1, gets - gets1);
is('...and the refused attempt kept its challenge', 0, asked.challenge - before.challenge);
is('the first tap after it unlocks', 'ok', await outcome(tap(() => pk.open())));
is('...still without fetching a challenge', 0, asked.challenge - before.challenge);

// ...and a resume that is really the Face ID sheet coming back arms nothing.
api.clearToken();
await pk.prepare();
sheet = 'hold';
const p2 = tap(() => pk.open());
pk.arm();                                 // the visibilitychange the sheet itself causes
if (held) held(); await settle(p2);
api.clearToken();
is('the sheet hiding the page is not a resume', 'skipped', await pk.autoUnlock());

// ── 4. a failure is said, in words, and the retry costs nothing extra ─────
api.clearToken();
await pk.prepare();
before = { ...asked };
sheet = 'cancel';
const cancelled = await settle(tap(() => pk.open()));
is('a cancelled sheet is an error', 'NotAllowedError', cancelled && cancelled.name);
is('...described with how to retry', true, /Tap unlock to try again/.test(pk.describe(cancelled)));
is('...and its challenge is kept for that retry', true, pk.prepared());
sheet = 'sign';
is('the retry tap unlocks', 'ok', await outcome(tap(() => pk.open())));
is('...with no challenge fetched for it', 0, asked.challenge - before.challenge);

api.clearToken();
await pk.prepare();
before = { ...asked };
sheet = 'forge';
const forged = await settle(tap(() => pk.open()));
is('a refused assertion is an error', 401, forged && forged.status);
is('...described as the fleet refusing', true, /the fleet refused/.test(pk.describe(forged)));
// A posted assertion spends its challenge, so ONE fresh one is fetched for the next tap.
await new Promise((r) => setTimeout(r, 50));
is('...and one fresh challenge is ready for the next tap', true, pk.prepared() && asked.challenge - before.challenge === 1);
is('a rate-limit is described with its wait', true,
   /refusing unlock attempts for 42s/.test(pk.describe(Object.assign(new Error('rate limited'), { status: 429, retryAfter: 42 }))));

pk.release();
is('the authenticator was driven', true, gets > 0);
console.log(rows.join('\n'));
process.exit(0);
