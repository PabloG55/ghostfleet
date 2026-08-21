#!/usr/bin/env node
// test/helpers/pwa-enrol.mjs — the phone enrols, with the code, against a real daemon.
//
//     node test/helpers/pwa-enrol.mjs <base> <enrolment-code> [client-id]
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE BUGS THIS EXISTS FOR, both found on a phone that could not get in:
//
//   1. fleet-serve will not enrol a passkey without a window opened from the terminal AND
//      the one-time code it printed — the endpoint is remote code execution, and
//      trust-on-first-use loses to whoever wins the race to be first. The client never
//      sent a code, so registration was a guaranteed 403; and api.js threw the server's
//      sentence away and reported `register → HTTP 403`, so the phone showed a button
//      that did nothing for twenty minutes.
//   2. the phone had registered in FIXTURE mode — a credential the server has never seen
//      — and one localStorage key held credentials for every backend. So in server mode
//      pk.registered() was true, the lock screen offered "unlock with Face ID" instead of
//      enrolment, and the assertion 401'd.
//
// So this drives web/passkey.js's OWN register() and open() through a synthetic
// authenticator, against a live fleet-serve. Not a reimplementation of the ceremony: the
// half that was broken is the body the client builds, so the client has to build it.
//
// IT SPENDS ABOUT A DOZEN REQUESTS FROM THE `auth` RATE BUCKET — every ceremony starts by
// asking for a challenge, and the default cap is 10 a minute. test/run.sh raises the caps
// (`sv_rate 4000 4000 4000`) before it gets here; a standalone run against a stock config
// will see the LAST rows go red with "rate limited", which is the cap and not the client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Authenticator } from './serve-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// ── the browser, stubbed before the client is imported ────────────────────
// defineProperty for localStorage: node ≥22 makes it a lazy accessor that prints an
// ExperimentalWarning to STDERR the moment it is READ, and run.sh asserts this helper's
// stderr is empty.
const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  },
});
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const CODE = process.argv[3] || '';
const CLIENT = process.argv[4] || 'phone';       // whoever `fleet-serve enroll` opened it for
const U = BASE ? new URL(BASE) : null;
globalThis.location = U ? { origin: U.origin, protocol: U.protocol, host: U.host, hostname: U.hostname }
                        : { origin: 'null', protocol: 'file:', host: '', hostname: '' };
// available() wants these three, and nothing else in the client touches `window`.
globalThis.window = { PublicKeyCredential: function PublicKeyCredential() {}, isSecureContext: true };

const auth = new Authenticator({ rpId: U ? U.hostname : 'localhost', origin: BASE });
const b64u = (b) => Buffer.from(b).toString('base64url');
let creates = 0, gets = 0;
// defineProperty again, and for a second reason: node's `navigator` is a getter-only
// global, so a plain assignment throws "Cannot set property navigator of #<Object> which
// has only a getter" and takes the whole helper with it.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
  credentials: {
    // The challenge arrives as the Uint8Array web/passkey.js decoded from the server's
    // base64url; the authenticator signs over the STRING, so it goes back the way it came.
    async create({ publicKey }) {
      creates++;
      const r = auth.createResult(b64u(publicKey.challenge));
      return { rawId: r.rawId, response: { attestationObject: r.attestationObject, clientDataJSON: r.clientDataJSON } };
    },
    async get({ publicKey }) {
      gets++;
      const r = auth.getResult(b64u(publicKey.challenge));
      return { rawId: r.rawId,
               response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature } };
    },
  },
  },
});

const api = await import(new URL('../../web/api.js', import.meta.url).href);
const pk = await import(new URL('../../web/passkey.js', import.meta.url).href);

is('a live fleet-serve base was given', true, !!BASE);
is('an enrolment code was given', true, !!CODE);

// ── 1. the code is normalised the way the SERVER normalises it ────────────
// Two copies of one rule, so they are compared rather than trusted. The server hashes
// normCode(code), so a client that is STRICTER than this makes a code the server would
// have accepted unusable — on a phone keyboard, where case and the hyphen are exactly
// what goes wrong.
const SERVE_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'utf8');
const NORM_LINE = /^const normCode = .*$/m.exec(SERVE_SRC);
is('fleet-serve\'s normCode was found to compare against', true, !!NORM_LINE);
const serverNorm = NORM_LINE ? new Function(`${NORM_LINE[0]}\nreturn normCode;`)() : null;
for (const typed of ['GP7CX-ZRDR5', 'gp7cx-zrdr5', ' gp7cx zrdr5 ', 'GP7CXZRDR5', 'Gp7Cx-ZrDr5', '']) {
  is(`normCode(${JSON.stringify(typed)}) matches the server`,
     serverNorm ? serverNorm(typed) : 'no server copy', pk.normCode(typed));
}

// ── 2. a fixture-mode passkey is not a passkey for a server ───────────────
// The invariant: fixture mode must never leave state that makes server mode look
// already-enrolled. Written through pk.credKey(), which is where register() writes it.
async function standAt(kind) {              // 'fixtures' | 'server'
  api.reprobe();
  if (kind === 'fixtures') api.useFixtures(); else api.setBaseUrl(BASE);
  return api.ready();
}
stored.clear();
await standAt('fixtures');
stored.set(pk.credKey(), 'ZmFrZS1maXh0dXJl');       // what register() stores in fixture mode
is('a fixture passkey counts in fixture mode', true, pk.registered());
await standAt('server');
is('...and NOT in server mode', false, pk.registered());
is('...so the phone lands in enrolment, not unlock', true, !pk.registered());
// and the other direction: a server credential is not a fixture one
stored.clear();
await standAt('server');
stored.set(pk.credKey(), 'ZmFrZS1zZXJ2ZXI');
is('a server passkey counts in server mode', true, pk.registered());
await standAt('fixtures');
is('...and NOT in fixture mode', false, pk.registered());
// the phone's actual state: a credential under the OLD unscoped key
stored.clear();
stored.set('gf.cred', 'ZmFrZS1sZWdhY3k');
await standAt('server');
is('the legacy unscoped key counts for no server', false, pk.registered());
await standAt('fixtures');
is('...and is not attributed to fixtures either', false, pk.registered());
// forget() takes the legacy key with it, so it does not linger for good
stored.set(pk.credKey(), 'ZmFrZQ');
pk.forget();
is('forget() clears this backend\'s credential', null, localStorage.getItem(pk.credKey()));
is('...and the legacy one too', null, localStorage.getItem('gf.cred'));

// ── 3. registering against the server: the refusals, then the enrolment ───
if (BASE && CODE) {
  stored.clear();
  await standAt('server');

  // No code: refused BEFORE the sensor. A phone that has to touch Face ID to be told the
  // field was empty has spent a ceremony on something knowable in advance.
  let before = creates, err = '';
  try { await pk.register(''); } catch (e) { err = String(e.message || e); }
  is('register with no code is refused', true, /enrolment code is required/.test(err));
  is('...without touching the authenticator', 0, creates - before);
  is('...and nothing is stored', null, localStorage.getItem(pk.credKey()));

  // A wrong code: the SERVER refuses, and its sentence is what the user is shown. This is
  // the row that was `register → HTTP 403`.
  before = creates; err = '';
  try { await pk.register('WRONG-CODE1'); } catch (e) { err = String(e.message || e); }
  is('a wrong code reaches the server', 1, creates - before);
  is('...and its own words come back', true, /wrong or missing enrolment code/.test(err));
  is('...naming the field to send it in', true, /`code` in the register body/.test(err));
  is('...and still nothing is stored', null, localStorage.getItem(pk.credKey()));
  is('...and no token was minted', false, api.haveToken());

  // The window is open, for this client id, and the client can see that before it asks
  // for a fingerprint.
  const st = await pk.enrolmentState();
  is('the client can see the window is open', true, st.open);
  is('...and for which client id', CLIENT, st.client);

  // THE ONE THE PHONE IS BLOCKED ON.
  let ok = false; err = '';
  try { ok = await pk.register(CODE); } catch (e) { err = String(e.message || e); }
  is('register WITH the code succeeds', true, ok);
  is('...with no error', '', err);
  is('...and the server minted a session', true, api.haveToken());
  is('...and the credential is stored for this origin', true, !!localStorage.getItem(pk.credKey()));
  is('...under a key scoped to the origin', `gf.cred:${BASE}`, pk.credKey());
  is('...and fixture mode is still not registered', false, (await standAt('fixtures'), pk.registered()));
  await standAt('server');
  is('...and the credential survives the round trip', true, pk.registered());

  // The enrolled passkey now signs in on its own — which is what proves the server really
  // took it, not that the client believes it did.
  api.clearToken();
  let opened = false; err = '';
  try { opened = await pk.open(); } catch (e) { err = String(e.message || e); }
  is('the enrolled passkey unlocks', true, opened);
  is('...with a live token behind it', true, api.haveToken());
  is('...and no error', '', err);

  // One use, and it is spent. The client's own pre-check says so in the SERVER's words,
  // which is why the server is asked for them here rather than trusted to match.
  let serverText = '';
  try {
    await api.authPost('register', { code: CODE, id: 'x', attestation: 'x', client_data: 'x' });
  } catch (e) { serverText = String(e.message || e); }
  is('the window is one-use', true, /no enrolment is open/.test(serverText));
  const after = await pk.enrolmentState();
  is('...and the client sees it closed', false, after.open);
  before = creates; err = '';
  try { await pk.register(CODE); } catch (e) { err = String(e.message || e); }
  is('registering again is refused', true, /no enrolment is open/.test(err));
  is('...in the server\'s own words', serverText, err);
  is('...without touching the authenticator', 0, creates - before);
}

is('the authenticator was actually driven', true, creates > 0 && gets > 0);
console.log(rows.join('\n'));
