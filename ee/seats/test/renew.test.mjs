// Under the ghostfleet Team License; see ../../LICENSE.
// Both directions on purpose: every refusal here has an acceptance beside it that differs in
// one field, so a renewKey that accepted everything, or nothing, fails half of this file.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { renewKey } from '../renew.mjs';
import { describeKey, verifyKey } from '../index.mjs';
import { PUBLIC_KEY, RENEW_URL } from '../public-key.mjs';

const now = '2030-06-01T12:00:00.000Z';
const URL_ = 'https://license.invalid/renew';
const payload = { v: 1, id: 'acme-api-subscription', org: 'acme-api', seats: 5,
  issued: '2030-01-01', expires: '2030-07-01' };
let privateKey, publicKey, otherPrivate, current, lapsed;
const mint = (value, signer = privateKey) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return `gft1.${bytes.toString('base64url')}.${sign(null, bytes, signer).toString('base64url')}`;
};
// A fetch that records what it was asked and answers what the test says.
function service(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    const { status = 200, body } = typeof answer === 'function' ? answer() : answer;
    return { status, json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; } };
  };
  return { fetch, calls };
}
const renew = (svc, options = {}) => renewKey({ key: current, url: URL_, publicKey, now, fetch: svc.fetch, ...options });

before(() => {
  ({ privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }));
  otherPrivate = generateKeyPairSync('ed25519').privateKey;
  current = mint(payload);
  lapsed = mint({ ...payload, expires: '2030-05-01' });
});

test('the shipped renewal URL is empty, like the public key', () => {
  assert.equal(RENEW_URL, '');
  assert.equal(PUBLIC_KEY, '');
});

test('an empty URL makes no request at all', async () => {
  for (const url of ['', '   ', undefined]) {
    const svc = service({ body: { key: mint({ ...payload, expires: '2031-07-01' }) } });
    // `undefined` falls back to the shipped RENEW_URL, which is empty.
    assert.deepEqual(await renew(svc, { url }), { ok: false, reason: 'unavailable' });
    assert.equal(svc.calls.length, 0);
  }
});

test('no key, or a key that is not authentic, makes no request', async () => {
  const svc = service({ body: { key: mint({ ...payload, expires: '2031-07-01' }) } });
  assert.deepEqual(await renew(svc, { key: null }), { ok: false, reason: 'no-key' });
  assert.deepEqual(await renew(svc, { key: '' }), { ok: false, reason: 'no-key' });
  assert.deepEqual(await renew(svc, { key: mint(payload, otherPrivate) }),
    { ok: false, reason: 'current-invalid', detail: 'bad-signature' });
  assert.deepEqual(await renew(svc, { key: 'gft1.nonsense' }), { ok: false, reason: 'current-invalid', detail: 'malformed' });
  assert.equal(svc.calls.length, 0);
});

test('the request is a POST of the current key and nothing else', async () => {
  const svc = service({ body: { key: mint({ ...payload, expires: '2031-07-01' }) } });
  await renew(svc);
  assert.equal(svc.calls.length, 1);
  const { url, init } = svc.calls[0];
  assert.equal(url, URL_);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { key: current });
  assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Content-Type']);
  assert.equal(init.redirect, 'error');
});

test('a later key of the same license is accepted', async () => {
  const next = mint({ ...payload, issued: '2030-06-01', expires: '2031-07-01' });
  const r = await renew(service({ body: { key: next } }));
  assert.deepEqual(r, { ok: true, key: next,
    license: { ok: true, org: 'acme-api', seats: 5, expires: '2031-07-01', id: 'acme-api-subscription' } });
});

test('a renewal may change the seat count', async () => {
  const next = mint({ ...payload, seats: 9, expires: '2031-07-01' });
  assert.equal((await renew(service({ body: { key: next } }))).license.seats, 9);
});

test('an expired current key can still be renewed', async () => {
  assert.equal(verifyKey(lapsed, { publicKey, now }).reason, 'expired');
  const next = mint({ ...payload, expires: '2031-07-01' });
  const r = await renew(service({ body: { key: next } }), { key: lapsed });
  assert.equal(r.ok, true);
  assert.equal(r.key, next);
});

test('the same key back, or one that expires no later, is not newer', async () => {
  assert.deepEqual(await renew(service({ body: { key: current } })), { ok: false, reason: 'not-newer' });
  const earlier = mint({ ...payload, expires: '2030-06-15' });
  assert.deepEqual(await renew(service({ body: { key: earlier } })), { ok: false, reason: 'not-newer' });
  const sameDay = mint({ ...payload, issued: '2030-02-02', expires: '2030-07-01' });
  assert.deepEqual(await renew(service({ body: { key: sameDay } })), { ok: false, reason: 'not-newer' });
});

test('a valid later key of another id or another org is refused', async () => {
  const otherId = mint({ ...payload, id: 'acme-web-subscription', expires: '2031-07-01' });
  assert.deepEqual(await renew(service({ body: { key: otherId } })), { ok: false, reason: 'other-license' });
  const otherOrg = mint({ ...payload, org: 'acme-web', expires: '2031-07-01' });
  assert.deepEqual(await renew(service({ body: { key: otherOrg } })), { ok: false, reason: 'other-license' });
});

test('a returned key that does not verify is rejected with why', async () => {
  const forged = mint({ ...payload, expires: '2031-07-01' }, otherPrivate);
  assert.deepEqual(await renew(service({ body: { key: forged } })), { ok: false, reason: 'rejected', detail: 'bad-signature' });
  assert.deepEqual(await renew(service({ body: { key: 'gft1.x.y' } })), { ok: false, reason: 'rejected', detail: 'malformed' });
  // Later than the current one, and already over: a renewal that is itself expired unlocks nothing.
  const stale = mint({ ...payload, expires: '2030-05-20' });
  assert.deepEqual(await renew(service({ body: { key: stale } }), { key: lapsed }),
    { ok: false, reason: 'rejected', detail: 'expired' });
});

test('404 is an unknown license; every other failure is transient', async () => {
  assert.deepEqual(await renew(service({ status: 404, body: {} })), { ok: false, reason: 'unknown-license' });
  for (const status of [500, 503, 429, 204, 301, 403])
    assert.deepEqual(await renew(service({ status, body: { key: mint({ ...payload, expires: '2031-07-01' }) } })),
      { ok: false, reason: 'transient', detail: `status ${status}` });
  assert.deepEqual(await renew(service({ body: undefined })), { ok: false, reason: 'transient', detail: 'body' });
  assert.deepEqual(await renew(service({ body: { key: 7 } })), { ok: false, reason: 'transient', detail: 'body' });
  assert.deepEqual(await renew(service({ body: null })), { ok: false, reason: 'transient', detail: 'body' });
  assert.deepEqual(await renew(service(Object.assign(new Error('down'), { name: 'TypeError' }))),
    { ok: false, reason: 'transient', detail: 'TypeError' });
});

test('describeKey reads an expired key without granting it', () => {
  assert.deepEqual(describeKey(lapsed, { publicKey, now }),
    { ok: true, org: 'acme-api', seats: 5, expires: '2030-05-01', id: 'acme-api-subscription', expired: true });
  assert.equal(describeKey(current, { publicKey, now }).expired, false);
  assert.deepEqual(describeKey(mint(payload, otherPrivate), { publicKey, now }), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(describeKey(current, { publicKey: '', now }), { ok: false, reason: 'no-public-key' });
  assert.deepEqual(describeKey(current, { now }), { ok: false, reason: 'no-public-key' });
});
