// The same limit through the real server process, in REAL mode: the route, the cookie, the
// admin door and the file on disk, not the functions called by hand. The fleet it reads is an
// empty one: HOME is a scratch folder, and GHOSTFLEET_HOME is this checkout.
//   The demo is asked the same questions beside it, because the demo must NOT refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createUsers } from '../server/users.mjs';
import { rig as demoRig } from './helpers/demo-rig.mjs';

const PW = 'a-long-password-123';
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function realServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-license-http-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(home);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const mint = (over = {}) => {
    const bytes = Buffer.from(JSON.stringify({ v: 1, id: 'acme-api-subscription', org: 'acme-api', seats: 3, issued: '2026-01-01', expires: '2999-01-01', ...over }));
    return `gft1.${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`;
  };
  const store = createUsers(path.join(data, 'real'));
  store.add('admin', PW, { role: 'admin' });
  store.add('member', PW);
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', here('./helpers/license-preload.mjs'), here('../server/index.mjs'), '--port', String(port)], {
    env: { ...process.env, HOME: home, GHOSTFLEET_HOME: here('../../..'), GFW_DATA: data, GFW_MODE: '', GFW_BIND: '', GFW_HOSTS: '',
           TEST_LICENSE_PUBLIC_KEY: publicKey, TEST_LICENSE_RENEW_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function call(method, route, body, cookie = '') {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'X-GFW': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, cookie: r.headers.get('set-cookie'), body: await r.json() };
  }
  for (let i = 0; i < 200; i++) {
    try { if ((await call('GET', '/api/health')).status === 200) break; } catch {}
    assert.equal(child.exitCode, null, log);
    await new Promise(r => setTimeout(r, 50));
  }
  const login = async (name, password = PW) => { const r = await call('POST', '/api/login', { name, password }); assert.equal(r.status, 200, log); return r.cookie.split(';')[0]; };
  return { call, login, mint, dir: path.join(data, 'real') };
}

test('real mode: the third account is refused without a key and created with one', async t => {
  const s = await realServer(t), admin = await s.login('admin'), member = await s.login('member');
  const before = await s.call('GET', '/api/admin/license', undefined, admin);
  assert.equal(before.status, 200);
  assert.deepEqual([before.body.status, before.body.counted, before.body.capacity, before.body.renewal.available], ['none', 2, 2, false]);

  const refused = await s.call('POST', '/api/admin/users', { name: 'toolbox' }, admin);
  assert.equal(refused.status, 403);
  assert.match(refused.body.text, /2 are free/);
  assert.match(refused.body.text, /Administration → License/);

  assert.equal((await s.call('GET', '/api/admin/license', undefined, member)).status, 404);
  assert.equal((await s.call('POST', '/api/admin/license', { action: 'set', key: s.mint() }, member)).status, 404);
  assert.equal((await s.call('POST', '/api/admin/license', { action: 'set', key: 'gft1.nonsense' }, admin)).status, 400);

  const pasted = await s.call('POST', '/api/admin/license', { action: 'set', key: s.mint() }, admin);
  assert.equal(pasted.status, 200);
  assert.deepEqual([pasted.body.status, pasted.body.org, pasted.body.seats, pasted.body.capacity], ['valid', 'acme-api', 3, 3]);
  assert.equal(fs.statSync(path.join(s.dir, 'license.json')).mode & 0o777, 0o600);

  const created = await s.call('POST', '/api/admin/users', { name: 'toolbox' }, admin);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const fourth = await s.call('POST', '/api/admin/users', { name: 'billing-svc' }, admin);
  assert.equal(fourth.status, 403);
  assert.match(fourth.body.text, /covers 3 accounts and 3 are active/);

  // Over the limit after the key is removed: everyone still gets in, only additions stop.
  assert.equal((await s.call('POST', '/api/admin/license', { action: 'remove' }, admin)).body.over, true);
  assert.equal((await s.call('GET', '/api/projects', undefined, member)).status, 200);
  assert.ok(await s.login('toolbox', created.body.password), 'the account beyond the free two still signs in');
  assert.equal((await s.call('POST', '/api/admin/users', { name: 'billing-svc' }, admin)).status, 403);
  // With no renewal URL in the build, the button answers without asking anyone.
  assert.deepEqual((await s.call('POST', '/api/admin/license', { action: 'check' }, admin)).body.checked, { ok: false, reason: 'unavailable' });
});

test('demo mode: a sample license, accounts are not limited, nothing is written', async t => {
  const r = await demoRig(t), admin = await r.login('admin');
  const v = await r.call('GET', '/api/admin/license', undefined, admin);
  assert.deepEqual([v.status, v.body.demo, v.body.status, v.body.counted], [200, true, 'valid', 4]);
  assert.equal((await r.call('POST', '/api/admin/users', { name: 'billing-svc' }, admin)).status, 200, 'a fifth account in the demo');
  const set = await r.call('POST', '/api/admin/license', { action: 'set', key: 'gft1.x.y' }, admin);
  assert.equal(set.status, 200); assert.match(set.body.text, /Demo/);
  assert.equal(fs.existsSync(path.join(r.dir, 'license.json')), false);
  assert.equal((await r.call('GET', '/api/admin/license', undefined, await r.login('viewer'))).status, 404);
  assert.deepEqual(r.calls().filter(c => c.kind !== 'scrypt'), [], 'the demo started no subprocess');
});
