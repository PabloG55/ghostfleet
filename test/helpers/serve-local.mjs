#!/usr/bin/env node
// test/helpers/serve-local.mjs — the two listeners, and that nothing crosses between them.
//
//     node test/helpers/serve-local.mjs <fleet-serve.mjs> <port> <tailnet-host> <tailnet-origin>
//
// Run with the daemon's own HOME and GHOSTFLEET_SERVE_CONFIG: it opens each enrolment window
// itself with `fleet-serve enroll`, one at a time, because a second window replaces the
// first.
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// The daemon under test is configured the way the owner's is, with one substitution: the
// configured bind is ::1 instead of a 100.x address, since a runner has no tailnet, and
// its rp_id and origin are a tailnet name. The localhost listener is then 127.0.0.1 on the
// same port, answering to `localhost:<port>`. Both are reached by ADDRESS, with the Host
// each one expects, because `localhost` resolves to ::1 first on some machines, and that
// would quietly be the other listener.
//
// Each refusal is asserted beside the acceptance it mirrors. A listener that refused
// everything would pass every "is refused" row, and the rows that make that visible are
// the ones that enrol and sign in.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Authenticator, request } from './serve-client.mjs';

const [serveJs, port, tailHost, tailOrigin] = process.argv.slice(2);
const enrolCode = (id) => (execFileSync(process.execPath, [serveJs, 'enroll', id], { encoding: 'utf8' })
  .match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

const TAIL = `http://[::1]:${port}`, LOCAL = `http://127.0.0.1:${port}`;
const LHOST = `localhost:${port}`, LORIGIN = `http://localhost:${port}`;
const tailHdr = { host: tailHost };
const localHdr = { host: LHOST };
const text = (r) => (r.json && (r.json.text || r.json.error)) || '';

// ── both answer, each as itself ───────────────────────────────────────────────
is('the configured bind still answers', 200, (await request(TAIL, 'GET', '/healthz')).status);
is('127.0.0.1 answers too, on the same port', 200, (await request(LOCAL, 'GET', '/healthz')).status);
const tch = await request(TAIL, 'GET', '/api/auth/challenge', { headers: tailHdr });
const lch = await request(LOCAL, 'GET', '/api/auth/challenge', { headers: localHdr });
is('the tailnet listener is its own rp_id', tailHost, tch.json && tch.json.rp_id);
is('the localhost listener is rp_id localhost', 'localhost', lch.json && lch.json.rp_id);
is('the page is served at localhost', 200, (await request(LOCAL, 'GET', '/', { headers: localHdr })).status);

// ── Host: each socket answers to its own names only ───────────────────────────
is('Host localhost is refused on the tailnet socket', 403,
   (await request(TAIL, 'GET', '/', { headers: localHdr })).status);
is('the tailnet Host is refused on the localhost socket', 403,
   (await request(LOCAL, 'GET', '/', { headers: tailHdr })).status);
is('127.0.0.1 is not a name the localhost socket answers to', 403,
   (await request(LOCAL, 'GET', '/', { headers: { host: `127.0.0.1:${port}` } })).status);

// ── Origin on a POST: the other listener's is as foreign as any site's ────────
// /api/auth/assert with an empty body: the origin gate is the first thing a POST meets, so
// 403 is that gate refusing and anything else is the request getting past it.
const post = (base, host, origin) => request(base, 'POST', '/api/auth/assert',
  { headers: { host, origin }, body: {} }).then(r => r.status);
is('a POST with the tailnet Origin is refused at localhost', 403, await post(LOCAL, LHOST, tailOrigin));
is('a POST with the localhost Origin is refused on the tailnet', 403, await post(TAIL, tailHost, LORIGIN));
is('...while its own Origin passes the gate at localhost', 'not 403',
   (await post(LOCAL, LHOST, LORIGIN)) === 403 ? '403' : 'not 403');
is('...and on the tailnet', 'not 403', (await post(TAIL, tailHost, tailOrigin)) === 403 ? '403' : 'not 403');

// ── enrolment: each listener's passkey, made on its own socket ────────────────
// The rpId and origin each authenticator signs are the ones a browser at that origin would
// sign. `mac` is enrolled at localhost, `phone` on the tailnet.
const mac = new Authenticator({ rpId: 'localhost', origin: LORIGIN, host: LHOST });
const phone = new Authenticator({ rpId: tailHost, origin: tailOrigin, host: tailHost });
// Then a passkey made for the OTHER relying party, offered through a window that is open:
// right code, wrong socket for what it signed. It must not be enrolled.
const strayOn = async (base, host, rpId, origin) => {
  const a = new Authenticator({ rpId, origin, host });
  return a.enroll(base, enrolCode('stray'));
};
const s1 = await strayOn(TAIL, tailHost, 'localhost', LORIGIN);
is('a localhost passkey cannot enrol on the tailnet', 400, s1.status);
const s2 = await strayOn(LOCAL, LHOST, tailHost, tailOrigin);
is('a tailnet passkey cannot enrol at localhost', 400, s2.status);
const me = await mac.enroll(LOCAL, enrolCode('mac'));
is('a localhost passkey enrols at localhost', 200, me.status);
const pe = await phone.enroll(TAIL, enrolCode('phone'));
is('a tailnet passkey enrols on the tailnet', 200, pe.status);

// ── assertions: verified only where they were made for ────────────────────────
is('the localhost passkey signs in at localhost', 200, (await mac.assert(LOCAL)).status);
const macTok = mac.token;
is('the tailnet passkey signs in on the tailnet', 200, (await phone.assert(TAIL)).status);
const phoneTok = phone.token;

// Cross: the same authenticator, posting to the OTHER listener. The challenge comes from
// the socket it is posted to, so the refusal is about the relying party, not a challenge
// from somewhere else.
const crossMac = new Authenticator({ rpId: 'localhost', origin: LORIGIN, host: tailHost });
Object.assign(crossMac, { credId: mac.credId, priv: mac.priv, pub: mac.pub, counter: mac.counter + 10 });
const cm = await crossMac.assert(TAIL);
is('a localhost assertion is refused on the tailnet', 401, cm.status);
is('...because it is localhost\'s passkey', 'yes', /enrolled for 'localhost'/.test(text(cm)) ? 'yes' : text(cm));
const crossPhone = new Authenticator({ rpId: tailHost, origin: tailOrigin, host: LHOST });
Object.assign(crossPhone, { credId: phone.credId, priv: phone.priv, pub: phone.pub, counter: phone.counter + 10 });
const cp = await crossPhone.assert(LOCAL);
is('a tailnet assertion is refused at localhost', 401, cp.status);
is('...because it is the tailnet\'s passkey', 'yes', new RegExp(`enrolled for '${tailHost.replace(/\./g, '\\.')}'`).test(text(cp)) ? 'yes' : text(cp));

// Below the credential tag: the localhost passkey asserted at localhost, but signed over
// the tailnet's origin or rpId. The tag would pass; what refuses it is clientData.origin
// and the rpIdHash, read against the listener rather than against the config.
const wrongOrigin = new Authenticator({ rpId: 'localhost', origin: tailOrigin, host: LHOST });
Object.assign(wrongOrigin, { credId: mac.credId, priv: mac.priv, pub: mac.pub, counter: mac.counter + 20 });
const wo = await wrongOrigin.assert(LOCAL);
is('the tailnet origin in clientData is refused at localhost', 401, wo.status);
is('...by the origin check', 'yes', /is not in this listener's origins/.test(text(wo)) ? 'yes' : text(wo));
const wrongRp = new Authenticator({ rpId: tailHost, origin: LORIGIN, host: LHOST });
Object.assign(wrongRp, { credId: mac.credId, priv: mac.priv, pub: mac.pub, counter: mac.counter + 30 });
const wr = await wrongRp.assert(LOCAL);
is('the tailnet rpIdHash is refused at localhost', 401, wr.status);
is('...by the rpId check', 'yes', /different rpId than 'localhost'/.test(text(wr)) ? 'yes' : text(wr));

// A challenge one listener issued is not the other's to spend.
const tailCh = await request(TAIL, 'GET', '/api/auth/challenge', { headers: tailHdr });
mac._base = LOCAL;
const borrowed = await mac.signChallenge({ tamper: { challenge: tailCh.json.challenge } });
const bc = await request(LOCAL, 'POST', '/api/auth/assert', { headers: localHdr, body: borrowed });
is('a tailnet challenge cannot be spent at localhost', 401, bc.status);
is('...it is not one this listener issued', 'yes', /not one this listener issued/.test(text(bc)) ? 'yes' : text(bc));

// ── sessions: a token is good on the socket that minted it ────────────────────
const health = (base, host, tok) => request(base, 'GET', '/api/health',
  { headers: { host, authorization: `Bearer ${tok}` } }).then(r => r.status);
is('the localhost token reads at localhost', 200, await health(LOCAL, LHOST, macTok));
is('...and is dead on the tailnet', 401, await health(TAIL, tailHost, macTok));
is('the tailnet token reads on the tailnet', 200, await health(TAIL, tailHost, phoneTok));
is('...and is dead at localhost', 401, await health(LOCAL, LHOST, phoneTok));

// ── the challenge offers only the passkeys this listener can verify ───────────
const allowOf = async (base, host) => ((await request(base, 'GET', '/api/auth/challenge', { headers: { host } })).json?.allow || []).map(x => x.id);
is('localhost offers its own passkey', 'yes', (await allowOf(LOCAL, LHOST)).includes(mac.credentialId) ? 'yes' : 'no');
is('...and not the tailnet\'s', 'no', (await allowOf(LOCAL, LHOST)).includes(phone.credentialId) ? 'yes' : 'no');
is('the tailnet offers its own passkey', 'yes', (await allowOf(TAIL, tailHost)).includes(phone.credentialId) ? 'yes' : 'no');
is('...and not localhost\'s', 'no', (await allowOf(TAIL, tailHost)).includes(mac.credentialId) ? 'yes' : 'no');

// The two tokens, for the restart rows in test/run.sh: a restored session has to land back
// on the listener that minted it.
if (process.env.LH_TOKENS) fs.writeFileSync(process.env.LH_TOKENS, `${macTok} ${phoneTok}\n`);

console.log(rows.join('\n'));
