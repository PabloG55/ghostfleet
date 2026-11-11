// server/license.mjs — the subscription key of this install: where it is kept, what it allows,
// and the daily question to the license service. ee/seats decides (verifyKey, canAdd, renewKey);
// this file only counts accounts, stores the key, and schedules.
//
// WHAT IS ENFORCED, AND WHAT IS NOT. The seat limit is checked when an account is ADDED: a new
// account from the admin panel or from admin-cli.mjs, and a disabled account being re-enabled.
// Nothing else asks. An install that is already over its seats, or whose key expired or stopped
// verifying, keeps working exactly as it did: nobody is signed out and no route is closed. Only
// the next addition is refused, with the reason and where to paste a key, and admins see a
// banner saying so. Locking a team out of its own fleet over a lapsed payment would turn a
// billing problem into an outage, and the people it hits are not the ones who can fix it.
//
// A counted account is one that is not disabled.
//
// The key lives in GFW_DATA/<mode>/license.json (0600) beside users.json, never in the repo.
// The demo neither stores nor enforces nor asks anything: it shows a sample license from memory.
import fs from 'node:fs';
import path from 'node:path';
import { verifyKey, describeKey, canAdd, seatCheck } from '../../seats/index.mjs';
import { renewKey } from '../../seats/renew.mjs';
import { PUBLIC_KEY, RENEW_URL } from '../../seats/public-key.mjs';
import { t } from '../shared/i18n/index.js';

const FILE = 'license.json';
const DAY = 86400;
export const countedAccounts = (users) => users.filter(u => !u.disabled).length;

export function readLicense(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeLicense(dir, v) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, FILE), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// none: no key stored. valid / expired: an authentic key, in date or not. invalid: a stored key
// that does not verify (`reason` is ee/seats' word for why).
export function licenseState(key, { publicKey = PUBLIC_KEY, now = new Date() } = {}) {
  if (key == null || key === '') return { status: 'none', reason: null };
  const d = describeKey(key, { publicKey, now });
  if (!d.ok) return { status: 'invalid', reason: d.reason };
  const { org, seats, expires, id } = d;
  return { status: d.expired ? 'expired' : 'valid', reason: d.expired ? 'expired' : null, org, seats, expires, id };
}

// May one more account be added? The one question both the server and admin-cli.mjs ask, from
// the same file, so the console cannot add what the panel refuses.
export function seatGate({ dir, users, demo = false, publicKey = PUBLIC_KEY, now = new Date() }) {
  const counted = countedAccounts(users);
  if (demo) return { allowed: true, counted, seats: null, status: 'none', expires: null };
  const { key = null } = readLicense(dir);
  const state = licenseState(key, { publicKey, now });
  const r = canAdd({ users: counted, key, publicKey, now });
  return { allowed: r.allowed, counted, seats: r.seats, status: state.status, expires: state.expires || null };
}
// The refusal says how many seats there are and where a key goes; a bare "limit reached" sends
// the admin looking for a setting that is not there.
export function refusalText(g) {
  const vars = { seats: g.seats, n: g.counted, date: g.expires || '' };
  return t(`err.seats.${g.status}`, vars);
}

export function createLicense({ dir, demo = false, users, readJson, writeJson, audit, httpErr,
  fetch = globalThis.fetch, clock = () => new Date(), publicKey = PUBLIC_KEY, renewUrl = RENEW_URL }) {
  const sec = () => Math.floor(clock().getTime() / 1000);
  const auto = () => readJson('settings.json', {}).license?.autoRenew !== false;
  const setAuto = (on) => { const all = readJson('settings.json', {}); all.license = { ...(all.license || {}), autoRenew: on }; writeJson('settings.json', all); };
  const gate = () => seatGate({ dir, users: users(), demo, publicKey, now: clock() });

  // Throws the refusal when one more account does not fit.
  function assertCanAdd() {
    const g = gate();
    if (!g.allowed) throw httpErr(403, refusalText(g));
  }

  function view() {
    const counted = countedAccounts(users());
    if (demo) {
      const expires = new Date(clock().getTime() + 365 * DAY * 1000).toISOString().slice(0, 10);
      return { ok: true, demo: true, status: 'valid', reason: null, org: 'acme-web', seats: 10, expires, id: 'demo',
        counted, free: 2, capacity: 10, over: false, verifiable: true, by: null, at: null,
        renewal: { available: false, auto: true, last: null } };
    }
    const lic = readLicense(dir);
    const state = licenseState(lic.key, { publicKey, now: clock() });
    const capacity = seatCheck({ users: counted, key: lic.key ?? null, publicKey, now: clock() }).seats;
    return { ok: true, demo: false, status: state.status, reason: state.reason,
      org: state.org || null, seats: state.seats || null, expires: state.expires || null, id: state.id || null,
      counted, free: 2, capacity, over: counted > capacity,
      // false: this build has no public key yet, so no key can be told from a forgery.
      verifiable: !!(publicKey && String(publicKey).trim()),
      by: lic.by || null, at: lic.at || null,
      renewal: { available: !!(renewUrl && renewUrl.trim()), auto: auto(), last: lic.lastCheck || null } };
  }

  // A pasted key is stored only if it verifies today. Storing whatever was pasted would let a
  // truncated paste replace a working key, and the install would drop to the free two seats
  // over a clipboard mistake.
  function set(me, raw) {
    const key = String(raw || '').trim();
    const v = verifyKey(key, { publicKey, now: clock() });
    if (!v.ok) throw httpErr(400, t(`err.license.${v.reason}`));
    writeLicense(dir, { key, by: me.id, at: sec() });
    audit({ user: me.id, verb: 'license_set', subject: v.org, result: 'ran', output: `${v.seats} · ${v.expires}` });
  }
  function remove(me) {
    const lic = readLicense(dir);
    if (!lic.key) return;
    writeLicense(dir, {});
    audit({ user: me.id, verb: 'license_remove', subject: licenseState(lic.key, { publicKey, now: clock() }).org || '-', result: 'ran' });
  }

  // One question to the service. Whatever comes back, enforcement is untouched unless a newer
  // key of this same license was accepted: a failed check only leaves its reason behind.
  let asking = null;
  function check(by) {
    if (asking) return asking;
    asking = (async () => {
      if (demo || !renewUrl || !renewUrl.trim()) return { ok: false, reason: 'unavailable' };
      if (!auto()) return { ok: false, reason: 'off' };
      const before = readLicense(dir);
      const r = await renewKey({ key: before.key ?? null, url: renewUrl, publicKey, now: clock(), fetch });
      if (r.reason === 'no-key') return r;
      // The answer took a while: a key pasted meanwhile is the admin's choice and wins.
      const cur = readLicense(dir);
      const res = r.ok && cur.key !== before.key ? { ok: false, reason: 'changed' } : r;
      const lastCheck = { at: sec(), ok: res.ok, reason: res.ok ? null : res.reason, ...(res.detail ? { detail: String(res.detail).slice(0, 80) } : {}) };
      if (res.ok) {
        writeLicense(dir, { key: res.key, by: 'renewal', at: sec(), lastCheck });
        audit({ user: by || 'system', verb: 'license_renew', subject: res.license.org, result: 'ran', output: `${res.license.seats} · ${res.license.expires}` });
      } else writeLicense(dir, { ...cur, lastCheck });
      return { ok: res.ok, reason: lastCheck.reason, ...(lastCheck.detail ? { detail: lastCheck.detail } : {}) };
    })().finally(() => { asking = null; });
    return asking;
  }

  // Once a day, counted from the last check on disk so a restart does not ask again.
  async function tick() {
    if (demo || !renewUrl || !renewUrl.trim() || !auto()) return null;
    const lic = readLicense(dir);
    if (!lic.key || sec() - (lic.lastCheck?.at || 0) < DAY) return null;
    try { return await check('system'); } catch (e) { console.error(`license: ${e.message}`); return null; }
  }
  function start() {
    if (demo || !renewUrl || !renewUrl.trim()) return;
    setTimeout(tick, 30000).unref();
    setInterval(tick, 3600 * 1000).unref();
  }

  // /api/admin/license, behind admin.mjs's admin-only door.
  async function act(me, b) {
    const action = String(b?.action || '');
    if (!['set', 'remove', 'auto', 'check'].includes(action)) throw httpErr(400, t('err.license.action'));
    if (demo) return { ...view(), text: t('demo.license') };
    let checked = null;
    if (action === 'set') set(me, b.key);
    else if (action === 'remove') remove(me);
    else if (action === 'auto') {
      const on = b.on === true;
      setAuto(on);
      audit({ user: me.id, verb: 'license_auto', subject: on ? 'on' : 'off', result: 'ran' });
    } else checked = await check(me.id);
    return { ...view(), ...(checked ? { checked } : {}) };
  }

  return { view, act, assertCanAdd, gate, check, tick, start };
}
