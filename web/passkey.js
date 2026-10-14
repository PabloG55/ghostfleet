// web/passkey.js — the passkey gate (docs/mobile.md §5, §7).
//
// Two ceremonies, for two different questions:
//   open()   — "is this the owner", when there is no live session to resume: the first
//              launch, or any return after 15 minutes without a request (resume() below
//              is tried first, and only its 401 brings the sensor out).
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

// The fixture stub's life. A server's token is the server's: an IDLE window of
// session_ttl (15 minutes) that every request slides, never a deadline from Face ID.
export const TOKEN_TTL = 15 * 60;
// THERE IS NO SEPARATE "RELOCK AFTER HIDDEN" ANY MORE. It was five minutes backgrounded,
// and it would make a resume after six minutes ask for Face ID while a relaunch after six
// minutes (iOS having evicted the app) walked straight back in on the stored token — the
// same absence answered two ways depending on what the OS did with the process. One rule:
// the idle window, enforced where it means something, on the server.

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
             enrolling: !!j.enrolling, ttl: Number(j.ttl) || 120 };
  }
  const c = new Uint8Array(32); crypto.getRandomValues(c);
  return { challenge: c, rpId: location.hostname, enrolling: true, ttl: 120,
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
// WRAPPED FOR THE SAME REASON open() IS — enrolment runs the same system sheet, so the
// same visibility transition lands in the same place, and a phone that locked itself
// halfway through enrolling would be the worse version of this bug: there is no credential
// to retry with yet.
export async function register(code = '') { return ceremony(() => registerOnce(code)); }
async function registerOnce(code = '') {
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

// ── A CEREMONY IS A STATE, AND THE APP HAS TO BE ABLE TO SEE IT ───────────
// FACE ID IS AN APP SWITCH. On iOS the WebAuthn prompt is a system sheet that takes the
// foreground, so the page goes HIDDEN when it opens and VISIBLE again the instant the face
// matches — while the assertion it just produced is still crossing the network, because the
// token is the thing being fetched. Anything that reacts to "the app came back" therefore
// runs in the middle of an unlock, at the one moment when there is provably no token.
//   app.js's visibilitychange handler did exactly that: `!haveToken() && !bypassAllowed()`
// is unconditionally TRUE for the whole width of a round trip, so returning from the sensor
// locked the app the user was unlocking AND cleared the token. It self-heals a moment later
// when authPost lands, so on a fast link it is a flash; over a tailnet it is a lock screen
// sitting there long enough to be tapped, and tapping it re-enters the same race. That is
// "i put my face and then it asked me again".
//   A COUNTER, NOT A FLAG: fresh() can be asked for while open() is still settling, and a
// flag would be cleared by whichever of the two finished first — leaving the app unguarded
// for the remainder of the other.
let ceremonies = 0;
export function busy() { return ceremonies > 0; }
async function ceremony(fn) {
  ceremonies++;
  // finally, so a dismissed prompt or a refused assertion releases it too. A counter that
  // leaks on the error path would wedge the app permanently un-lockable, which is a worse
  // bug than the one this fixes.
  try { return await fn(); } finally { ceremonies--; }
}

// One assertion. `purpose` is carried into the server's audit row (§7) so the log says
// what the fingerprint was for, not merely that one happened.
async function assertOnce(purpose) {
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

// WRAPPED, AND THE WRAPPER SPANS MORE THAN THE SENSOR. The window that matters is not the
// prompt — it is from the prompt opening to the TOKEN EXISTING, and authPost() below is the
// larger half of that on any link worth worrying about.
const assert = (purpose) => ceremony(() => assertOnce(purpose));

// A LAUNCH TRIES THE SESSION IT ALREADY HAS. The token this origin's daemon minted last is
// kept on the device (api.js), and if the server still honours it — used within the last
// 15 minutes, client not revoked — the app opens without the sensor. One authenticated
// read decides, because only the server knows; its 401 clears the stored copy, so a dead
// token costs one request and then Face ID, exactly as before.
//   'ok' | 'none' (nothing stored, or visibly expired) | 'rejected' (the server said no)
//   | 'offline' (could not ask — the token is kept, and the lock screen stays up).
export async function resume() {
  await api.ready();
  if (api.mode() !== 'server') return 'none';
  if (!api.haveToken() && !api.restoreToken()) return 'none';
  try { await api.getProjects(); return 'ok'; }
  catch (e) {
    if (e instanceof api.AuthError) return 'rejected';
    if (e instanceof api.OfflineError) return 'offline';
    throw e;
  }
}

// ── UNLOCK: THE SENSOR IS ASKED FOR INSIDE THE TAP, OR NOT AT ALL ──────────
// WebKit only shows the passkey sheet to a call made with TRANSIENT USER ACTIVATION — inside
// the tap's own handler. This used to be `await challenge()` and THEN
// navigator.credentials.get(): a network round trip between the tap and the call, so by the
// time the call was made the tap no longer counted, and get() rejected with NotAllowedError
// without ever showing a sheet. Nothing reached the server after the challenge, which is the
// whole signature in the daemon's log: a GET /api/auth/challenge per tap and not one POST
// /api/auth/assert. And because the error was never drawn, the screen did nothing, so the
// owner tapped again — each tap one more challenge — until the auth rate limit answered 429
// to every one of them.
//   So the challenge is fetched BEFORE the tap (prepare(), from the lock screen), refreshed
// before the server forgets it, and open() calls get() synchronously: no await between the
// tap and the sheet. A challenge get() never signed is still good — the server consumes one
// only when an assertion is posted — so a refused or cancelled attempt keeps it for the
// next tap instead of fetching another.
let prepped = null;       // { challenge, rpId, exp } — exp in ms, client clock
let prepping = null;      // the fetch in flight, shared by every caller
let prepErr = null;       // the last prepare() failure, so a render cannot re-ask in a loop
let prepTimer = null;
let wanted = false;       // the lock screen is up and wants a challenge kept warm
let inflight = null;      // the one unlock ceremony allowed at a time
const PREP_MARGIN_MS = 20_000;   // refreshed this long before the server's TTL runs out

export function prepared() { return !!prepped && prepped.exp - PREP_MARGIN_MS > Date.now(); }
export function preparing() { return !!prepping; }
export function prepareError() { return prepErr; }
export function unlocking() { return !!inflight; }

export function prepare() {
  wanted = true;
  if (prepared()) return Promise.resolve(true);
  if (prepping) return prepping;
  prepErr = null;
  prepping = (async () => {
    try {
      const c = await challenge();
      prepped = { challenge: c.challenge, rpId: c.rpId, exp: Date.now() + c.ttl * 1000 };
      clearTimeout(prepTimer);
      // Kept warm for as long as the lock screen is up. A hidden page is skipped: iOS
      // suspends it anyway, and the resume path asks again.
      prepTimer = setTimeout(() => {
        if (!wanted) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        prepare().catch(() => {});
      }, Math.max(1000, c.ttl * 1000 - PREP_MARGIN_MS));
      // A browser timer is a number; node's (the suite drives this file) would keep a test
      // process alive for as long as the lock screen "wanted" a challenge.
      if (prepTimer && typeof prepTimer.unref === 'function') prepTimer.unref();
      return true;
    } catch (e) { prepErr = e; throw e; }
    finally { prepping = null; }
  })();
  return prepping;
}
// Unlocked: nothing to keep warm.
export function release() {
  wanted = false; prepped = null; prepErr = null; autoArmed = false;
  clearTimeout(prepTimer); prepTimer = null;
}

// No live session to resume: assert, then hold the token the API will send.
//   CALLED FROM THE TAP HANDLER WITHOUT AN AWAIT IN FRONT OF IT, and it makes the get()
// call before its own first await — that is the whole fix. A second tap while a ceremony
// is running gets the SAME promise back: it does nothing, and it fetches nothing.
export function open({ auto = false } = {}) {
  if (inflight) return inflight;
  if (!available()) return Promise.reject(new Error(unavailableReason()));
  if (!registered()) return Promise.reject(new Error('no passkey on this device yet'));
  if (!prepared()) {
    // Not ready yet (or the last fetch failed): fetch, but do NOT go on to the sensor —
    // by the time the challenge lands this tap no longer counts, which is the bug.
    if (auto) return Promise.reject(Object.assign(new Error('no challenge ready'), { name: 'NotReady' }));
    const why = prepErr;                     // read before prepare() clears it
    prepare().catch(() => {});
    return Promise.reject(Object.assign(new Error(why ? describe(why) : 'still getting ready — tap unlock again in a moment'), { name: 'NotReady' }));
  }
  const p = prepped;
  let got;
  ceremonies++;
  try {
    got = navigator.credentials.get({
      publicKey: {
        challenge: p.challenge, rpId: p.rpId, timeout: 60_000, userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: b64u.dec(localStorage.getItem(credKey())) }],
      },
    });
  } catch (e) { ceremonies--; return Promise.reject(e); }
  inflight = (async () => {
    try {
      const cred = await got;
      if (!cred) throw Object.assign(new Error('the passkey prompt was dismissed'), { name: 'NotAllowedError' });
      // Signed: whatever the server says next, this challenge is spent.
      if (prepped === p) prepped = null;
      if (api.mode() === 'server') {
        await api.authPost('assert', {
          id: b64u.enc(cred.rawId), purpose: 'open',
          client_data: b64u.enc(cred.response.clientDataJSON),
          authenticator_data: b64u.enc(cred.response.authenticatorData),
          signature: b64u.enc(cred.response.signature),
        });
      } else {
        api.setToken('fixture-stub', Date.now() / 1000 + TOKEN_TTL);
      }
      return true;
    } finally {
      ceremonies--; inflight = null;
      // Still locked (a refusal, a cancel): have the next tap's challenge ready.
      if (wanted && !api.haveToken()) prepare().catch(() => {});
    }
  })();
  return inflight;
}

// ── ONE AUTOMATIC ATTEMPT PER OPEN OR RESUME ──────────────────────────────
// The app tries the sensor by itself when it opens or comes back locked. WebKit may refuse
// a call no tap started (NotAllowedError, at once, no sheet) — then the button is the way
// in, and it has to work on its first tap, which is why the attempt leaves the prepared
// challenge where it was.
//   ARMED, NOT RETRIED. arm() is called for an open or a resume and autoUnlock() disarms
// before it does anything, so a refusal can never come round again on its own: the sheet
// itself hides and re-shows the page, and a resume handler that re-tried on that would be a
// loop that only a tap could break. arm() during a ceremony is that exact event, ignored.
let autoArmed = false;
export function arm() { if (!busy()) autoArmed = true; }
// 'ok' | 'skipped' (not armed, or nothing to try with) | 'refused' (WebKit wanted a tap, or
// the sheet was dismissed — said nowhere, the button is the answer) | an Error to show.
export async function autoUnlock() {
  if (!autoArmed) return 'skipped';
  autoArmed = false;
  if (!available() || !registered() || inflight) return 'skipped';
  try { await prepare(); } catch (e) { return e; }
  if (api.haveToken()) return 'skipped';         // a stored session got there first
  try { await open({ auto: true }); return 'ok'; }
  catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.name === 'NotReady')) return 'refused';
    return e;
  }
}

// WHAT HAPPENED, IN WORDS FOR THE LOCK SCREEN. The old screen showed nothing at all on a
// failure (a toast that was never drawn), so a refused ceremony and a button that does
// nothing were the same thing to look at. Every message says that a tap retries.
export function describe(e) {
  const name = (e && e.name) || '';
  const msg = String((e && e.message) || e || '');
  if (name === 'NotAllowedError' || name === 'AbortError')
    return 'Face ID did not finish — it was cancelled, timed out, or the system refused to show it. Tap unlock to try again.';
  if (name === 'NotReady') return msg;
  if (name === 'InvalidStateError' || name === 'SecurityError')
    return `this passkey cannot be used here (${msg}). Tap unlock to try again, or re-enrol in settings.`;
  if (e instanceof api.OfflineError) return 'could not reach the fleet — check the connection, then tap unlock.';
  if (e && e.status === 429)
    return `the fleet is refusing unlock attempts for ${e.retryAfter ? `${e.retryAfter}s` : 'a minute'} (${msg}). Tap unlock after that.`;
  if (e && e.status) return `the fleet refused: ${msg}. Tap unlock to try again.`;
  return `${msg || 'unlock failed'}. Tap unlock to try again.`;
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
