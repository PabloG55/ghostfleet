import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createUsers } from '../server/users.mjs';
import { rig, password } from './helpers/demo-rig.mjs';

test('temporary passwords only allow self, password, logout and health', async t => {
  const r = await rig(t), c = await r.login('scratch');
  for (const p of ['/api/projects', '/api/users', '/api/lang', '/api/act'])
    assert.equal((await r.call(p === '/api/lang' || p === '/api/act' ? 'POST' : 'GET', p, undefined, c)).status, 403, p);
  assert.equal((await r.call('GET', '/api/me', undefined, c)).status, 200);
  assert.equal((await r.call('GET', '/api/health', undefined, c)).status, 200);
  assert.equal((await r.call('POST', '/api/password', { old: password, new: 'changed-password-123' }, c)).status, 200);
  assert.equal((await r.call('GET', '/api/projects', undefined, c)).status, 200);
  assert.equal((await r.call('POST', '/api/logout', {}, c)).status, 200);
});

test('password changes revoke other logins and keep the current login', async t => {
  const r = await rig(t), a = await r.login('member'), b = await r.login('member');
  assert.equal((await r.call('POST', '/api/password', { old: 'oldpass', new: password }, a)).status, 200);
  assert.equal((await r.call('GET', '/api/projects', undefined, b)).status, 401);
  assert.equal((await r.call('GET', '/api/projects', undefined, a)).status, 200);
});

test('new passwords require twelve characters, including newly created accounts', async t => {
  const r = await rig(t), c = await r.login('member');
  const short = await r.call('POST', '/api/password', { old: 'oldpass', new: 'elevenchars' }, c);
  assert.equal(short.status, 400); assert.match(short.body.text, /12/);
  assert.equal((await r.call('POST', '/api/password', { old: 'oldpass', new: 'twelvechars!' }, c)).status, 200);
  assert.throws(() => createUsers(r.dir).add('toolbox', 'elevenchars'), e => e.status === 400);
});

test('missing Host is rejected; approved and foreign hosts keep their behavior', async t => {
  const r = await rig(t);
  const raw = (host) => new Promise(resolve => {
    const s = net.connect(r.port, '127.0.0.1', () => s.write(`GET /api/health HTTP/1.0\r\n${host ? `Host: ${host}\r\n` : ''}\r\n`));
    let out = ''; s.on('data', d => { out += d; }); s.on('end', () => resolve(Number(out.split(' ')[1])));
  });
  assert.equal(await raw(''), 400); assert.equal(await raw('localhost'), 200); assert.equal(await raw('foreign.invalid'), 403);
});

test('sliding logins refresh the cookie at most once per minute and still expire idle', async t => {
  const r = await rig(t), c = await r.login('member');
  assert.equal((await r.call('GET', '/api/projects', undefined, c)).cookie, null);
  r.advance(61000);
  const refreshed = await r.call('GET', '/api/projects', undefined, c);
  assert.match(refreshed.cookie || '', /Max-Age=43200/); assert.ok(refreshed.cookie.startsWith(c + ';'));
  assert.equal((await r.call('GET', '/api/projects', undefined, c)).cookie, null);
  r.advance(43200000 + 62000);
  assert.equal((await r.call('GET', '/api/projects', undefined, c)).status, 401);
});

test('unknown and disabled login names still call scrypt', async t => {
  const r = await rig(t); r.clear();
  assert.equal((await r.call('POST', '/api/login', { name: 'missing', password: 'wrong' })).status, 401);
  assert.equal(r.calls().filter(x => x.kind === 'scrypt').length, 1);
  const salt = r.calls().find(x => x.kind === 'scrypt').salt;
  r.clear();
  await r.call('POST', '/api/login', { name: 'another-missing', password: 'wrong' });
  assert.equal(r.calls().find(x => x.kind === 'scrypt').salt, salt, 'unknown names use the same fixed dummy');
  r.clear(); await r.call('POST', '/api/login', { name: 'member', password: 'wrong' });
  assert.equal(r.calls().filter(x => x.kind === 'scrypt').length, 1);
  const store = createUsers(r.dir); store.find('viewer').disabled = true; store.save();
  r.clear();
  assert.equal((await r.call('POST', '/api/login', { name: 'viewer', password })).status, 401);
  assert.equal(r.calls().filter(x => x.kind === 'scrypt').length, 1);
});

test('parallel guesses are limited by normalized name for fifteen minutes', async t => {
  const r = await rig(t);
  const failures = await Promise.all(Array.from({ length: 8 }, () => r.call('POST', '/api/login', { name: 'MEMBER', password: 'wrong' })));
  assert.equal(failures.filter(x => x.status === 401).length, 5);
  assert.equal(failures.filter(x => x.status === 429).length, 3);
  assert.equal((await r.call('POST', '/api/login', { name: 'member', password: 'oldpass' })).status, 429);
  r.advance(901000); assert.ok(await r.login('member'));
});

test('guesses across different names are limited by source address', async t => {
  const r = await rig(t);
  const failures = await Promise.all(Array.from({ length: 23 }, (_, i) => r.call('POST', '/api/login', { name: `scratch-${i}`, password: 'wrong' })));
  assert.equal(failures.filter(x => x.status === 401).length, 20);
  assert.equal(failures.filter(x => x.status === 429).length, 3);
  r.advance(901000); assert.ok(await r.login('admin'));
});
