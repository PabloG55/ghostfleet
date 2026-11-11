// The seat limit and the license key, in both directions: every refusal has an acceptance
// beside it that differs in one thing (one more seat, a key that verifies, the setting on), so
// a gate that refused everything, or nothing, fails half of this file.
//   Keys are signed with a pair generated here and thrown away; the shipped public key stays
// empty. The functions take the public key as an argument; the admin-cli tests, which need a
// real process to accept a key, start it with helpers/license-preload.mjs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUsers } from '../server/users.mjs';
import { createAdmin } from '../server/admin.mjs';
import { createLicense, seatGate, licenseState, readLicense } from '../server/license.mjs';

const PW = 'a-long-password-123';
const NOW = '2030-06-01T12:00:00.000Z';
const payload = { v: 1, id: 'acme-api-subscription', org: 'acme-api', seats: 3, issued: '2030-01-01', expires: '2030-07-01' };
let publicKey, privateKey, otherPrivate, tmp;
const mint = (over = {}, signer = privateKey) => {
  const bytes = Buffer.from(JSON.stringify({ ...payload, ...over }));
  return `gft1.${bytes.toString('base64url')}.${sign(null, bytes, signer).toString('base64url')}`;
};
before(() => {
  ({ privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }));
  otherPrivate = generateKeyPairSync('ed25519').privateKey;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-license-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The admin routes over a real users.json and a real license.json, without a listening server.
function rig({ accounts = 1, demo = false, renewUrl = '', fetch, key = publicKey } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const store = createUsers(dir);
  store.add('admin', PW, { role: 'admin' });
  for (let i = 1; i < accounts; i++) store.add(`person ${i}`, PW);
  const file = (n) => path.join(dir, n);
  const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const writeJson = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v), { mode: 0o600 });
  const httpErr = (status, text) => Object.assign(new Error(text), { status });
  const log = [], calls = [];
  const time = { now: new Date(NOW) };
  const counting = async (...a) => { calls.push(a); if (!fetch) throw new Error('no network in this test'); return fetch(...a); };
  const license = createLicense({ dir, demo, users: () => store.list, readJson, writeJson, audit: r => log.push(r), httpErr,
    fetch: counting, clock: () => time.now, publicKey: key, renewUrl });
  const route = createAdmin({ store, fleet: { projects: async () => [] }, audit: r => log.push(r), dropLogins() {}, httpErr, license });
  async function call(method, p, data, me = store.find('admin')) {
    let out = null;
    try {
      const answered = await route(me, { method }, {}, new URL(p, 'http://x'), { body: async () => data || {}, send: (_res, status, body) => { out = { status, body }; } });
      assert.equal(answered, true, `${method} ${p} was not answered`);
    } catch (e) { if (!e.status) throw e; out = { status: e.status, body: { ok: false, text: e.message } }; }
    return out;
  }
  const add = (name) => call('POST', '/api/admin/users', { name });
  const paste = (k) => call('POST', '/api/admin/license', { action: 'set', key: k });
  const view = async () => (await call('GET', '/api/admin/license')).body;
  return { dir, store, license, call, add, paste, view, log, calls, time, readJson };
}
const answers = (status, body) => async () => ({ status, json: async () => body });

test('without a key two accounts are free and the third is refused, saying where a key goes', async () => {
  const r = rig();
  assert.equal((await r.add('acme-web')).status, 200);
  const third = await r.add('toolbox');
  assert.equal(third.status, 403);
  assert.match(third.body.text, /\b2 are free\b/);
  assert.match(third.body.text, /Administration → License/);
  assert.equal(r.store.list.length, 2, 'the refused account was not written');
});

test('a valid key allows as many accounts as it has seats, and refuses the next one', async () => {
  const r = rig({ accounts: 2 });
  assert.equal((await r.paste(mint())).status, 200);
  assert.equal((await r.add('toolbox')).status, 200, 'third account, three seats');
  const fourth = await r.add('billing-svc');
  assert.equal(fourth.status, 403);
  assert.match(fourth.body.text, /covers 3 accounts and 3 are active/);
  assert.match(fourth.body.text, /Administration → License/);
  assert.equal((await r.paste(mint({ seats: 4 }))).status, 200);
  assert.equal((await r.add('billing-svc')).status, 200, 'and with a fourth seat it fits');
});

test('a disabled account does not count, and re-enabling one is an addition', async () => {
  const r = rig({ accounts: 3 });
  const off = (id, disabled) => r.call('POST', '/api/admin/users/update', { id, disabled });
  assert.equal((await off('person-2', true)).status, 200);
  assert.equal((await r.view()).counted, 2);
  const back = await off('person-2', false);
  assert.equal(back.status, 403, 're-enabling would make three');
  assert.match(back.body.text, /Administration → License/);
  assert.equal(r.store.find('person-2').disabled, true);
  assert.equal((await off('person-1', true)).status, 200);
  assert.equal((await off('person-2', false)).status, 200, 'one active: re-enabling makes two');
  assert.equal((await r.add('scratch')).status, 403, 'two active and one disabled: still full');
  assert.equal((await r.paste(mint())).status, 200);
  assert.equal((await off('person-1', false)).status, 200, 'with three seats the third comes back');
});

test('an install already over its seats keeps working; only additions are refused', async () => {
  const r = rig({ accounts: 4 });
  const v = await r.view();
  assert.deepEqual([v.status, v.counted, v.capacity, v.over], ['none', 4, 2, true]);
  assert.equal((await r.call('GET', '/api/admin/users')).body.users.length, 4);
  assert.equal((await r.call('POST', '/api/admin/users/update', { id: 'person-1', role: 'admin' })).status, 200);
  assert.equal((await r.call('POST', '/api/admin/users/reset', { id: 'person-2' })).status, 200);
  assert.equal((await r.call('POST', '/api/admin/users/update', { id: 'person-3', disabled: true })).status, 200);
  assert.equal((await r.add('scratch')).status, 403);
  assert.equal(r.store.list.filter(u => !u.disabled).length, 3, 'nobody else was switched off');
});

test('an expired key still names its organization, refuses additions with the date, and locks nobody out', async () => {
  const r = rig({ accounts: 3 });
  assert.equal((await r.paste(mint())).status, 200);
  r.time.now = new Date('2030-07-02T00:00:00.000Z');
  const v = await r.view();
  assert.deepEqual([v.status, v.org, v.seats, v.expires, v.capacity, v.over], ['expired', 'acme-api', 3, '2030-07-01', 2, true]);
  const add = await r.add('scratch');
  assert.equal(add.status, 403);
  assert.match(add.body.text, /expired on 2030-07-01/);
  assert.equal((await r.call('POST', '/api/admin/users/update', { id: 'person-1', role: 'admin' })).status, 200);
});

test('a pasted key is stored only if it verifies, and never comes back out', async () => {
  const r = rig();
  const good = mint();
  assert.equal((await r.paste(good)).status, 200);
  const bad = [['gft1.nonsense', /not a license key/], [mint({}, otherPrivate), /not issued|altered/],
               [mint({ expires: '2030-05-01' }), /already expired/], ['', /not a license key/]];
  for (const [k, why] of bad) {
    const x = await r.paste(k);
    assert.equal(x.status, 400, k.slice(0, 20));
    assert.match(x.body.text, why);
    assert.equal(readLicense(r.dir).key, good, 'the working key stayed');
  }
  assert.equal(fs.statSync(path.join(r.dir, 'license.json')).mode & 0o777, 0o600);
  const v = await r.view();
  assert.equal(v.status, 'valid');
  assert.ok(!JSON.stringify(v).includes(good.split('.')[2]), 'the view carries no key material');
  assert.equal((await r.call('POST', '/api/admin/license', { action: 'remove' })).body.status, 'none');
  assert.equal(readLicense(r.dir).key, undefined);
  assert.deepEqual(r.log.filter(x => x.verb.startsWith('license_')).map(x => x.verb), ['license_set', 'license_remove']);
});

test('a build without a public key accepts no key and says so', async () => {
  const r = rig({ key: '' });
  const x = await r.paste(mint());
  assert.equal(x.status, 400);
  assert.match(x.body.text, /cannot verify license keys yet/);
  assert.equal((await r.view()).verifiable, false);
  assert.equal((await r.add('acme-web')).status, 200, 'the free two still work');
  assert.equal((await r.add('toolbox')).status, 403);
});

test('a stored key that stops verifying reads as invalid and grants nothing', async () => {
  const r = rig({ accounts: 2 });
  fs.writeFileSync(path.join(r.dir, 'license.json'), JSON.stringify({ key: mint({ seats: 50 }, otherPrivate) }));
  const v = await r.view();
  assert.deepEqual([v.status, v.reason, v.capacity, v.org], ['invalid', 'bad-signature', 2, null]);
  const add = await r.add('toolbox');
  assert.equal(add.status, 403);
  assert.match(add.body.text, /not valid/);
});

test('someone who is not an admin gets a 404 for the license, read or write', async () => {
  const r = rig({ accounts: 2 });
  const member = r.store.find('person-1');
  for (const [m, body] of [['GET'], ['POST', { action: 'remove' }], ['POST', { action: 'set', key: mint() }]]) {
    const x = await r.call(m, '/api/admin/license', body, member);
    assert.equal(x.status, 404);
  }
  assert.equal(readLicense(r.dir).key, undefined);
});

test('with no renewal URL nothing is ever requested, and the panel is told so', async () => {
  const r = rig({ renewUrl: '', fetch: answers(200, { key: mint({ expires: '2031-07-01' }) }) });
  await r.paste(mint());
  assert.equal((await r.view()).renewal.available, false);
  const x = await r.call('POST', '/api/admin/license', { action: 'check' });
  assert.deepEqual(x.body.checked, { ok: false, reason: 'unavailable' });
  r.time.now = new Date('2030-06-05T12:00:00.000Z');
  assert.equal(await r.license.tick(), null);
  assert.equal(r.calls.length, 0);
  assert.equal(readLicense(r.dir).lastCheck, undefined);
});

test('renewal on: a later key of the same license replaces the stored one and its seats apply', async () => {
  const next = mint({ seats: 4, expires: '2031-07-01' });
  const r = rig({ accounts: 3, renewUrl: 'https://license.invalid/renew', fetch: answers(200, { key: next }) });
  const current = mint();
  await r.paste(current);
  assert.equal((await r.add('scratch')).status, 403, 'three seats, three accounts');
  const x = await r.call('POST', '/api/admin/license', { action: 'check' });
  assert.deepEqual(x.body.checked, { ok: true, reason: null });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(JSON.parse(r.calls[0][1].body), { key: current }, 'only the key is sent');
  assert.equal(readLicense(r.dir).key, next);
  const v = await r.view();
  assert.deepEqual([v.seats, v.expires, v.renewal.last.ok, v.renewal.auto, v.renewal.available], [4, '2031-07-01', true, true, true]);
  assert.equal((await r.add('scratch')).status, 200, 'the fourth seat arrived with the renewal');
  assert.ok(r.log.some(l => l.verb === 'license_renew'));
});

test('a renewal that is not this license is refused, recorded, and changes nothing', async () => {
  const cases = [
    [answers(200, { key: mint({ id: 'acme-web-subscription', seats: 50, expires: '2031-07-01' }) }), 'other-license'],
    [answers(200, { key: mint({ seats: 50, expires: '2031-07-01' }, otherPrivate) }), 'rejected'],
    [answers(200, { key: mint({ seats: 50, expires: '2030-06-20' }) }), 'not-newer'],
    [answers(404, {}), 'unknown-license'],
    [answers(503, {}), 'transient'],
    [async () => { throw new TypeError('fetch failed'); }, 'transient'],
  ];
  for (const [fetch, reason] of cases) {
    const r = rig({ accounts: 3, renewUrl: 'https://license.invalid/renew', fetch });
    const current = mint();
    await r.paste(current);
    const x = await r.call('POST', '/api/admin/license', { action: 'check' });
    assert.equal(x.body.checked.reason, reason);
    assert.equal(x.body.checked.ok, false);
    assert.equal(readLicense(r.dir).key, current, `${reason}: the key in use stayed`);
    const v = await r.view();
    assert.deepEqual([v.status, v.seats, v.renewal.last.ok, v.renewal.last.reason], ['valid', 3, false, reason]);
    assert.equal((await r.add('scratch')).status, 403, `${reason}: still three seats`);
  }
});

test('renewal off: no request from the button or the clock, and the setting persists', async () => {
  const r = rig({ renewUrl: 'https://license.invalid/renew', fetch: answers(200, { key: mint({ expires: '2031-07-01' }) }) });
  const current = mint();
  await r.paste(current);
  assert.equal((await r.view()).renewal.auto, true, 'on unless switched off');
  const off = await r.call('POST', '/api/admin/license', { action: 'auto', on: false });
  assert.equal(off.body.renewal.auto, false);
  assert.equal(r.readJson('settings.json', {}).license.autoRenew, false);
  assert.deepEqual((await r.call('POST', '/api/admin/license', { action: 'check' })).body.checked, { ok: false, reason: 'off' });
  r.time.now = new Date('2030-06-05T12:00:00.000Z');
  assert.equal(await r.license.tick(), null);
  assert.equal(r.calls.length, 0, 'nothing left the machine');
  assert.equal(readLicense(r.dir).key, current);
  // And back on, the same button does ask.
  await r.call('POST', '/api/admin/license', { action: 'auto', on: true });
  assert.equal((await r.call('POST', '/api/admin/license', { action: 'check' })).body.checked.ok, true);
  assert.equal(r.calls.length, 1);
});

test('the clock asks once a day, counted from the last check, and not without a key', async () => {
  const r = rig({ renewUrl: 'https://license.invalid/renew', fetch: answers(200, { key: 'gft1.x.y' }) });
  assert.equal(await r.license.tick(), null, 'no key, nothing to ask about');
  assert.equal(r.calls.length, 0);
  await r.paste(mint());
  assert.equal((await r.license.tick()).reason, 'rejected');
  assert.equal(r.calls.length, 1);
  r.time.now = new Date('2030-06-02T11:00:00.000Z');
  assert.equal(await r.license.tick(), null, '23 hours later: not yet');
  assert.equal(r.calls.length, 1);
  r.time.now = new Date('2030-06-02T12:00:01.000Z');
  assert.equal((await r.license.tick()).reason, 'rejected');
  assert.equal(r.calls.length, 2);
});

test('a key pasted while the service was answering is not overwritten by the answer', async () => {
  const renewed = mint({ expires: '2031-07-01' });
  let pasteDuring;
  const r = rig({ renewUrl: 'https://license.invalid/renew', fetch: async () => { await pasteDuring(); return { status: 200, json: async () => ({ key: renewed }) }; } });
  await r.paste(mint());
  const byHand = mint({ seats: 9, expires: '2030-12-01' });
  pasteDuring = () => r.paste(byHand);
  const x = await r.call('POST', '/api/admin/license', { action: 'check' });
  assert.equal(x.body.checked.reason, 'changed');
  assert.equal(readLicense(r.dir).key, byHand);
});

test('the demo shows a sample license from memory: no file, no limit, no request', async () => {
  const r = rig({ accounts: 4, demo: true, renewUrl: 'https://license.invalid/renew', fetch: answers(200, {}) });
  const v = await r.view();
  assert.deepEqual([v.demo, v.status, v.counted, v.renewal.available], [true, 'valid', 4, false]);
  assert.equal((await r.add('scratch')).status, 200);
  for (const b of [{ action: 'set', key: mint() }, { action: 'remove' }, { action: 'auto', on: false }, { action: 'check' }]) {
    const x = await r.call('POST', '/api/admin/license', b);
    assert.equal(x.status, 200);
    assert.match(x.body.text, /Demo/);
  }
  assert.equal(await r.license.tick(), null);
  assert.equal(r.calls.length, 0);
  assert.equal(fs.existsSync(path.join(r.dir, 'license.json')), false);
  assert.equal(fs.existsSync(path.join(r.dir, 'settings.json')), false);
});

test('seatGate and licenseState agree with what the routes do', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gate-'));
  const users = [{ id: 'a' }, { id: 'b' }, { id: 'c', disabled: true }];
  assert.deepEqual(seatGate({ dir, users, publicKey, now: NOW }), { allowed: false, counted: 2, seats: 2, status: 'none', expires: null });
  assert.equal(seatGate({ dir, users: users.slice(0, 1), publicKey, now: NOW }).allowed, true);
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key: mint() }));
  assert.deepEqual(seatGate({ dir, users, publicKey, now: NOW }), { allowed: true, counted: 2, seats: 3, status: 'valid', expires: '2030-07-01' });
  assert.equal(seatGate({ dir, users, publicKey: '', now: NOW }).allowed, false, 'the shipped empty public key accepts nothing');
  assert.equal(licenseState(null).status, 'none');
});

// ── admin-cli.mjs, as the process an operator runs ───────────────────────────────────────
const CLI = fileURLToPath(new URL('../server/admin-cli.mjs', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./helpers/license-preload.mjs', import.meta.url));
function cli(data, name, { withKey = true } = {}) {
  const r = spawnSync(process.execPath, [...(withKey ? ['--import', PRELOAD] : []), CLI, 'create-admin', name], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, GFW_DATA: data, GFW_MODE: '', TEST_LICENSE_PUBLIC_KEY: publicKey, TEST_LICENSE_RENEW_URL: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const liveMint = (over = {}, signer) => mint({ issued: '2026-01-01', expires: '2999-01-01', ...over }, signer);

test('create-admin makes the first two accounts and refuses the third without a key', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'cli-'));
  assert.equal(cli(data, 'acme-api').code, 0);
  assert.equal(cli(data, 'acme-web').code, 0);
  const third = cli(data, 'toolbox');
  assert.equal(third.code, 1);
  assert.match(third.err, /2 are free/);
  assert.match(third.err, /Administration → License/);
  assert.equal(createUsers(path.join(data, 'real')).list.length, 2);
});

test('create-admin adds the third with a valid key, and not with a forged one', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'cli-'));
  cli(data, 'acme-api'); cli(data, 'acme-web');
  const file = path.join(data, 'real', 'license.json');
  fs.writeFileSync(file, JSON.stringify({ key: liveMint({}, otherPrivate) }));
  const forged = cli(data, 'toolbox');
  assert.equal(forged.code, 1);
  assert.match(forged.err, /not valid/);
  fs.writeFileSync(file, JSON.stringify({ key: liveMint() }));
  const ok = cli(data, 'toolbox');
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /admin created: toolbox/);
  const fourth = cli(data, 'billing-svc');
  assert.equal(fourth.code, 1);
  assert.match(fourth.err, /covers 3 accounts and 3 are active/);
});

test('from the shipped tree, with its empty public key, a signed key still unlocks nothing', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'cli-'));
  cli(data, 'acme-api'); cli(data, 'acme-web');
  fs.writeFileSync(path.join(data, 'real', 'license.json'), JSON.stringify({ key: liveMint() }));
  assert.equal(cli(data, 'toolbox', { withKey: false }).code, 1);
  assert.equal(cli(data, 'toolbox').code, 0, 'the same data, verified against the pair that signed it');
});

test('the demo console is not limited', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'cli-'));
  for (const n of ['acme-api', 'acme-web', 'toolbox']) {
    const r = spawnSync(process.execPath, [CLI, 'create-admin', n, '--demo'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GFW_DATA: data } });
    assert.equal(r.status, 0, r.stderr);
  }
});
