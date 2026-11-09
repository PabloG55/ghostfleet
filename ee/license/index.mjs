// Under the ghostfleet Team License; see ../LICENSE.
import { createPublicKey, verify } from 'node:crypto';
import { PUBLIC_KEY } from './public-key.mjs';

const FREE = 2;
const failure = reason => ({ ok: false, reason });

// Date-only expirations are exclusive UTC midnights, like timestamp expirations.
export function isoTime(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const canonical = new Date(time).toISOString();
  if (canonical.slice(0, 10) !== value.slice(0, 10)) return NaN;
  if (value.length > 10 && canonical !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')) return NaN;
  return time;
}

export function validPayload(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).sort().join(',') === 'expires,id,issued,org,seats,v' &&
    Number.isSafeInteger(payload.v) &&
    typeof payload.id === 'string' && payload.id.trim().length > 0 &&
    typeof payload.org === 'string' && payload.org.trim().length > 0 &&
    Number.isSafeInteger(payload.seats) && payload.seats > 0 &&
    Number.isFinite(isoTime(payload.issued)) && Number.isFinite(isoTime(payload.expires));
}

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid base64url');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Noncanonical base64url');
  return bytes;
}

export function verifyKey(key, options = {}) {
  try {
    const { publicKey = PUBLIC_KEY, now = new Date() } = options;
    if (!publicKey || (typeof publicKey === 'string' && !publicKey.trim())) return failure('no-public-key');
    if (typeof key !== 'string') return failure('malformed');
    const parts = key.split('.');
    if (parts.length !== 3 || parts[0] !== 'gft1') return failure('malformed');
    let bytes, signature, payload;
    try {
      bytes = decode(parts[1]);
      signature = decode(parts[2]);
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { return failure('malformed'); }
    try {
      const verifier = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
      if (verifier.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, verifier, signature)) {
        return failure('bad-signature');
      }
    } catch { return failure('bad-signature'); }
    if (!validPayload(payload)) return failure('malformed');
    if (payload.v !== 1) return failure('unknown-version');
    const time = now instanceof Date ? now.getTime() :
      typeof now === 'number' ? now : isoTime(now);
    if (!Number.isFinite(time)) return failure('malformed');
    if (time >= isoTime(payload.expires)) return failure('expired');
    const { org, seats, expires, id } = payload;
    return { ok: true, org, seats, expires, id };
  } catch { return failure('malformed'); }
}

function check(options, adding) {
  const { users, key, publicKey, now } = options ?? {};
  if (!Number.isSafeInteger(users) || users < 0 || (adding && users === Number.MAX_SAFE_INTEGER)) {
    return { allowed: false, free: FREE, seats: FREE, reason: 'malformed' };
  }
  const license = verifyKey(key, { publicKey, now });
  const seats = license.ok ? Math.max(FREE, license.seats) : FREE;
  const count = users + (adding ? 1 : 0);
  const reason = license.ok ? (count > seats ? 'seat-limit' : null) : license.reason;
  // Only a signed, otherwise valid expired key gets the existing-account exception.
  const allowed = count <= seats || (!adding && reason === 'expired');
  return { allowed, free: FREE, seats, reason: count <= FREE && key == null ? null : reason };
}

export function seatCheck(options) { return check(options, false); }
export function canAdd(options) { return check(options, true); }
