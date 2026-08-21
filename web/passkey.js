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
export function registered() { try { return !!localStorage.getItem(LS_CRED); } catch { return false; } }
export function forget() { try { localStorage.removeItem(LS_CRED); } catch {} api.clearToken(); }

// The server owns the challenge; without one, a local random value keeps the ceremony
// exercisable in fixture mode. A locally-generated challenge proves nothing to anybody
// — which is exactly why it is confined to the mode with nothing to prove it to.
async function challenge() {
  if (api.mode() === 'server') {
    const j = await api.authChallenge();
    return { challenge: b64u.dec(j.challenge), rpId: j.rp_id || location.hostname,
             user: j.user || { id: 'ghostfleet', name: 'ghostfleet' } };
  }
  const c = new Uint8Array(32); crypto.getRandomValues(c);
  return { challenge: c, rpId: location.hostname, user: { id: 'ghostfleet-fixtures', name: 'ghostfleet (fixtures)' } };
}

export async function register() {
  if (!available()) throw new Error(unavailableReason());
  const { challenge: ch, rpId, user } = await challenge();
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
  try { localStorage.setItem(LS_CRED, b64u.enc(cred.rawId)); } catch {}
  if (api.mode() === 'server') {
    await api.authPost('register', {
      id: b64u.enc(cred.rawId),
      attestation: b64u.enc(cred.response.attestationObject),
      client_data: b64u.enc(cred.response.clientDataJSON),
    });
  } else {
    api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
  }
  return true;
}

// One assertion. `purpose` is carried into the server's audit row (§7) so the log says
// what the fingerprint was for, not merely that one happened.
async function assert(purpose) {
  if (!available()) throw new Error(unavailableReason());
  if (!registered()) throw new Error('no passkey on this device yet');
  const { challenge: ch, rpId } = await challenge();
  const id = b64u.dec(localStorage.getItem(LS_CRED));
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
export function bypassAllowed() { return api.mode() !== 'server'; }
export function bypass() {
  if (!bypassAllowed()) throw new Error('a configured server enforces the passkey — there is nothing to bypass');
  api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
  return true;
}
