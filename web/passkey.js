// web/passkey.js — the passkey gate (docs/mobile.md §5, §7).
//
// Two ceremonies, for two different questions:
//   open()   — "is this the owner", at every cold start and after the app has been
//              backgrounded for a few minutes.
//   fresh()  — "is this the owner, right now", at the moment a destructive verb is
//              tapped. spawn, stop, rename. §7 calls this making the phone STRICTER
//              than the terminal, which cannot ask for a fingerprint.
//
// WHAT THIS FILE IS NOT. It is not the security boundary. §5: "Server-enforced, not
// client-enforced. A lock screen that only gates the UI is decoration — `curl` with the
// bearer token would walk straight past it." So the assertion's only real job is to make
// the server mint a short-lived token, and the server refuses every request without a
// live one. In fixture mode there IS no server, so the token below is a local stub and
// the UI says so in those words rather than implying a protection it does not have.
// Anyone reading this to decide whether the endpoint is safe should read fleet-serve.

import * as api from './api.js';

export const TOKEN_TTL = 15 * 60;              // §5: ~15 minutes
export const RELOCK_AFTER_HIDDEN = 5 * 60_000; // §5: "backgrounded for a few minutes"

const LS_CRED = 'gf.cred';                     // credential id, base64url. Not a secret.

// A CREDENTIAL BELONGS TO A BACKEND, and one key used to hold them all. The phone had
// registered a passkey in FIXTURE mode — a local-only credential the server has never
// seen — so in server mode registered() was true, the lock screen offered "unlock with
// Face ID" instead of enrolment, the assertion 401'd, and the button appeared to do
// nothing. Same class as the default-to-fixtures bug: fixture mode leaving state that
// makes server mode look already-enrolled.
//
// Scoped by ORIGIN, which is how WebAuthn scopes the key anyway — a credential is created
// for an rpId, and one made at another hostname cannot be asserted here. 'fixtures' is a
// realm of its own because the challenge it signed was generated in this file and proves
// nothing to anybody; that is the whole of §5.
//
// The legacy unscoped key is deliberately NOT migrated. Which realm it belonged to is
// precisely what was never recorded, and reading it as a server's would be the bug again
// — so it counts for nothing, forget() clears it, and a fixture-mode passkey costs one
// more prompt to recreate.
function realm() {
  const m = api.mode();
  if (m === 'server') return api.baseUrl();
  return m === 'fixtures' ? 'fixtures' : '';   // 'probing': no realm, so nothing is registered yet
}
// Exported because it IS the storage location, and test/helpers/pwa-enrol.mjs writes a
// credential through it to stand the client where the phone was.
export function credKey() { const r = realm(); return r ? `${LS_CRED}:${r}` : ''; }

// The server normalises the enrolment code the same way (fleet-serve's normCode), so this
// exists to be no STRICTER than it is: a phone keyboard is a bad place to insist on case
// and a hyphen. pwa-enrol.mjs lifts the server's copy and compares the two, because two
// copies of one rule is how they drift.
export const normCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const b64u = {
  enc(buf) {
    let s = ''; const b = new Uint8Array(buf);
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  },
};

export function available() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext === true;
}
// Why the gate cannot run, in the words that tell you how to fix it. A phone on the
// tailnet reaching http://100.x.y.z is NOT a secure context, and that is the likely
// way to meet this — hence a name for it rather than a silent fallback.
export function unavailableReason() {
  if (typeof window === 'undefined') return 'no browser';
  if (!window.isSecureContext) return 'not a secure context — WebAuthn needs https:// or localhost';
  if (!window.PublicKeyCredential) return 'this browser has no WebAuthn';
  return '';
}
export function registered() {
  const k = credKey();
  if (!k) return false;
  try { return !!localStorage.getItem(k); } catch { return false; }
}
export function forget() {
  const k = credKey();
  try { if (k) localStorage.removeItem(k); localStorage.removeItem(LS_CRED); } catch {}
  api.clearToken();
}

// The server owns the challenge; without one, a local random value keeps the ceremony
// exercisable in fixture mode. A locally-generated challenge proves nothing to anybody
// — which is exactly why it is confined to the mode with nothing to prove it to.
async function challenge() {
  // Nothing here decides which backend it is talking to, and it must not: the whole
  // ceremony hangs off api.mode(), which is a probe's answer on a same-origin open.
  // Awaiting it HERE covers register(), open() and fresh() in one place, because all
  // three ask for a challenge before they ask for anything else.
  await api.ready();
  if (api.mode() === 'server') {
    const j = await api.authChallenge();
    return { challenge: b64u.dec(j.challenge), rpId: j.rp_id || location.hostname,
             user: j.user || { id: 'ghostfleet', name: 'ghostfleet' },
             // Whether the terminal has a window open, and for whom. It travels with the
             // challenge because that is the one request a cold client is allowed to make.
             enrolling: !!j.enrolling };
  }
  const c = new Uint8Array(32); crypto.getRandomValues(c);
  return { challenge: c, rpId: location.hostname, enrolling: true,
           user: { id: 'ghostfleet-fixtures', name: 'ghostfleet (fixtures)' } };
}

// Asked BEFORE the sensor. Without it the ceremony runs, the user touches Face ID, and
// only then does the server say no enrolment is open — biometrics spent on a refusal that
// was knowable in advance.
export async function enrolmentState() {
  await api.ready();
  if (api.mode() !== 'server') return { open: true, client: 'fixtures', local: true };
  const j = await api.authChallenge();
  return { open: !!j.enrolling, client: (j.user && j.user.id) || '' };
}

// `code` is the one-time code `fleet-serve enroll <client-id>` printed. The server will
// not enrol a passkey without a window opened from the terminal AND that code, and it is
// right not to: the endpoint is remote code execution, and trust-on-first-use loses to
// whoever wins the race to be first. The client had no way to send one, so registration
// was a guaranteed 403 — the code is the missing field, not a softening of the rule.
export async function register(code = '') {
  if (!available()) throw new Error(unavailableReason());
  const { challenge: ch, rpId, user, enrolling } = await challenge();
  const server = api.mode() === 'server';
  if (server && !enrolling)
    throw new Error('no enrolment is open. On the Mac: fleet-serve enroll <client-id> — it prints a one-time code');
  if (server && !normCode(code))
    throw new Error('an enrolment code is required — `fleet-serve enroll <client-id>` prints one');
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: ch,
      rp: { id: rpId, name: 'ghostfleet' },
      user: { id: new TextEncoder().encode(user.id), name: user.name, displayName: user.name },
      // ES256 then RS256 — the two every platform authenticator here supports.
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      // The secure enclave specifically: §5 wants a key that cannot be copied off the
      // device, which is the property a roaming authenticator does not give.
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    },
  });
  if (!cred) throw new Error('registration was dismissed');
  if (server) {
    // NOTHING IS STORED UNTIL THE SERVER HAS SAID YES. Storing first is the other half of
    // the dead end: a refused registration still left a credential behind, so the next
    // open offered "unlock with Face ID" for a passkey the server had never seen, and
    // every assertion 401'd.
    await api.authPost('register', {
      code: normCode(code),
      id: b64u.enc(cred.rawId),
      attestation: b64u.enc(cred.response.attestationObject),
      client_data: b64u.enc(cred.response.clientDataJSON),
    });
  } else {
    api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
  }
  try { localStorage.setItem(credKey(), b64u.enc(cred.rawId)); } catch {}
  return true;
}

// One assertion. `purpose` is carried into the server's audit row (§7) so the log says
// what the fingerprint was for, not merely that one happened.
async function assert(purpose) {
  if (!available()) throw new Error(unavailableReason());
  if (!registered()) throw new Error('no passkey on this device yet');
  const { challenge: ch, rpId } = await challenge();
  const id = b64u.dec(localStorage.getItem(credKey()));
  const got = await navigator.credentials.get({
    publicKey: {
      challenge: ch, rpId, timeout: 60_000, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id }],
    },
  });
  if (!got) throw new Error('the passkey prompt was dismissed');
  const a = {
    id: b64u.enc(got.rawId), purpose,
    client_data: b64u.enc(got.response.clientDataJSON),
    authenticator_data: b64u.enc(got.response.authenticatorData),
    signature: b64u.enc(got.response.signature),
  };
  if (api.mode() !== 'server') return { ...a, stub: false, local_only: true };
  return a;
}

// Cold start / after backgrounding: assert, then hold the token the API will send.
export async function open() {
  const a = await assert('open');
  if (api.mode() === 'server') {
    await api.authPost('assert', a);
  } else {
    api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
  }
  return true;
}

// The destructive-verb prompt. A separate ceremony every time — never a cached "you
// asserted a minute ago", because the thing it is standing in front of is a deleted
// checkout (§12).
export async function fresh(purpose) { return assert(purpose); }

// Fixture mode with no authenticator (or before a passkey exists) still has to be
// usable, or the client cannot be reviewed at all. Clearly named, and refused outright
// once a real server is configured — there the server rejects an unauthenticated
// request anyway, so pretending otherwise would only hide the reason.
// `!== 'server'` was wrong once the mode can be 'probing': that reads as "not a server"
// for as long as the probe is in flight, which is exactly when a phone on the daemon's
// own URL would be offered a way past the gate. Only a RESOLVED fixtures mode has
// nothing to enforce.
export function bypassAllowed() { return api.mode() === 'fixtures'; }
export function bypass() {
  if (!bypassAllowed()) throw new Error('a configured server enforces the passkey — there is nothing to bypass');
  api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
  return true;
}
