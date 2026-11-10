import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rig } from './helpers/demo-rig.mjs';
import { connect, masked } from './helpers/terminal-ws.mjs';
import { OP } from '../../../lib/web-term.mjs';

const open = (r, cookie, kind = 'term', project = 'acme-web') => r.call('POST', '/api/term/open', { project, kind }, cookie);
const ready = peer => peer.wait(({ messages }) => messages.some(m => m.t === 'ready'));
const closed = peer => peer.wait(({ messages }) => messages.some(m => m.close));
const subprocesses = r => r.calls().filter(x => x.kind !== 'scrypt');

test('terminal roles: admin and project member can open both kinds', async t => {
  const r = await rig(t);
  for (const role of ['admin', 'member']) {
    const cookie = await r.login(role);
    for (const kind of ['term', 'edit']) {
      const response = await open(r, cookie, kind);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.session, `_${kind}-acme-web`);
      assert.equal(response.body.kind, kind);
      assert.equal(response.body.ttl, 30);
      assert.equal(response.body.idle, 1800);
      const peer = await connect({ port: r.port, cookie, ticket: response.body.ticket });
      t.after(() => peer.socket?.destroy());
      assert.equal(peer.status, 101); await ready(peer);
      assert.match(peer.output(), kind === 'edit' ? /Demo editor.*\r\n\/\/ acme-web\/scratch.js/ : /Demo terminal/);
      peer.input('terminal-sentinel'); peer.resize(100, 40);
      await peer.wait(({ output }) => output.includes('terminal-sentinel'));
      peer.close(); await closed(peer);
    }
  }
  assert.deepEqual(subprocesses(r), [], 'all demo terminal and editor routes must avoid child_process');
});

test('terminal roles: viewer and other-project member get 404; temporary password gets 403', async t => {
  const r = await rig(t);
  for (const kind of ['term', 'edit']) {
    assert.equal((await open(r, await r.login('viewer'), kind)).status, 404);
    assert.equal((await open(r, await r.login('member'), kind, 'toolbox')).status, 404);
    assert.equal((await open(r, await r.login('scratch'), kind)).status, 403);
  }
  assert.equal((await open(r, '')).status, 401);
  const c = await r.login('member');
  assert.equal((await open(r, c, 'shell')).status, 400);
  assert.equal((await open(r, c, 'term', 'missing')).status, 404);
  assert.equal((await r.call('GET', '/api/term/open', undefined, c)).status, 405);
  assert.deepEqual(subprocesses(r), []);
});

test('terminal WebSocket requires the exact app Origin and checked Host', async t => {
  const r = await rig(t), cookie = await r.login('member');
  for (const origin of ['http://evil.example', `http://127.0.0.1:${r.port + 1}`, null]) {
    const { body } = await open(r, cookie);
    const result = await connect({ port: r.port, cookie, ticket: body.ticket, origin,
      headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } });
    assert.equal(result.status, 403, String(origin));
  }
  const { body } = await open(r, cookie);
  assert.equal((await connect({ port: r.port, cookie, ticket: body.ticket, headers: { Host: 'evil.example' } })).status, 403);
  assert.deepEqual(subprocesses(r), []);
});

test('terminal WebSocket refuses missing, reused, expired and other-login tickets', async t => {
  const r = await rig(t), cookie = await r.login('member'), other = await r.login('admin');
  assert.equal((await connect({ port: r.port, cookie })).status, 401);
  const { body } = await open(r, cookie);
  const peer = await connect({ port: r.port, cookie, ticket: body.ticket });
  t.after(() => peer.socket?.destroy());
  assert.equal(peer.status, 101); await ready(peer);
  assert.equal((await connect({ port: r.port, cookie, ticket: body.ticket })).status, 401);
  peer.close(); await closed(peer);
  const expired = (await open(r, cookie)).body.ticket;
  r.advance(31000);
  assert.equal((await connect({ port: r.port, cookie, ticket: expired })).status, 401);
  r.advance(0);
  const stolen = (await open(r, cookie)).body.ticket;
  assert.equal((await connect({ port: r.port, cookie: other, ticket: stolen })).status, 401);
  assert.equal((await connect({ port: r.port, cookie, ticket: stolen })).status, 401, 'a refused login spends the ticket');
  const anonymous = (await open(r, cookie)).body.ticket;
  assert.equal((await connect({ port: r.port, ticket: anonymous })).status, 401);
  assert.deepEqual(subprocesses(r), []);
});

test('terminal takeover closes only the same user, project and kind with a reason', async t => {
  const r = await rig(t), cookie = await r.login('member'), admin = await r.login('admin');
  const peers = [];
  const attach = async (c, kind, project) => {
    const { body } = await open(r, c, kind, project);
    const peer = await connect({ port: r.port, cookie: c, ticket: body.ticket });
    peers.push(peer); assert.equal(peer.status, 101); await ready(peer); return peer;
  };
  t.after(() => peers.forEach(p => p.socket?.destroy()));
  const first = await attach(cookie, 'term');
  const editor = await attach(cookie, 'edit');
  const otherUser = await attach(admin, 'term');
  const otherProject = await attach(admin, 'term', 'toolbox');
  const second = await attach(cookie, 'term');
  await closed(first);
  assert.ok(first.messages.some(m => m.t === 'closed' && m.code === 4001 && /took over/.test(m.why)));
  assert.ok(first.messages.some(m => m.close === 4001 && /took over/.test(m.why)));
  for (const peer of [second, editor, otherUser, otherProject]) {
    assert.equal(peer.messages.some(m => m.t === 'closed'), false);
    peer.input('still-attached'); await peer.wait(({ output }) => output.includes('still-attached'));
    peer.close(); await closed(peer);
  }
});

test('terminal idle expires after 30 minutes with no input or output', async t => {
  const r = await rig(t), cookie = await r.login('member');
  const { body } = await open(r, cookie);
  const peer = await connect({ port: r.port, cookie, ticket: body.ticket });
  t.after(() => peer.socket?.destroy()); await ready(peer);
  r.advance(1799000);
  peer.pong();
  peer.input('keep-alive'); await peer.wait(({ output }) => output.includes('keep-alive'));
  r.advance(1801000);
  peer.pong();
  peer.input('still-here'); await peer.wait(({ output }) => output.includes('still-here'));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(peer.messages.some(m => m.t === 'closed'), false);
  r.advance(3602000); await closed(peer);
  assert.ok(peer.messages.some(m => m.close === 4000 && /Idle/.test(m.why)));
});

test('terminal audit records one open and close with metadata and no terminal bytes', async t => {
  const r = await rig(t), cookie = await r.login('member');
  const sentinel = 'terminal-audit-sentinel';
  for (const kind of ['term', 'edit']) {
    const { body } = await open(r, cookie, kind);
    const peer = await connect({ port: r.port, cookie, ticket: body.ticket });
    t.after(() => peer.socket?.destroy()); await ready(peer);
    peer.input(sentinel); await peer.wait(({ output }) => output.includes(sentinel));
    r.advance(kind === 'term' ? 1200 : 2400);
    peer.close(); await closed(peer);
  }
  const text = fs.readFileSync(path.join(r.dir, 'activity.jsonl'), 'utf8');
  assert.equal(text.includes(sentinel), false);
  const rows = text.trim().split('\n').map(JSON.parse).filter(r => r.verb.startsWith('terminal_'));
  assert.equal(rows.length, 4);
  for (const kind of ['term', 'edit']) {
    const pair = rows.filter(r => r.kind === kind);
    assert.deepEqual(pair.map(r => r.verb), ['terminal_open', 'terminal_close']);
    assert.ok(pair.every(r => r.user === 'member' && r.project === 'acme-web' && r.subject === `_${kind}-acme-web`));
    assert.ok(pair[1].duration >= 1);
    assert.ok(pair.every(r => !('input' in r) && !('output' in r) && !('args' in r)));
  }
});

test('terminal upgrade handles pipelined frames and closes malformed input', async t => {
  const r = await rig(t), cookie = await r.login('member');
  const { body } = await open(r, cookie);
  const peer = await connect({ port: r.port, cookie, ticket: body.ticket,
    headers: { 'X-Test-Upgrade-Head': masked(OP.binary, 'pipelined').toString('base64') } });
  t.after(() => peer.socket?.destroy()); await ready(peer);
  await peer.wait(({ output }) => output.includes('pipelined'));
  peer.socket.write(Buffer.from([0x82, 1, 120])); await closed(peer);
  assert.ok(peer.messages.some(m => m.close === 1002));
});

test('terminal rechecks project grants and forced password change at upgrade and while connected', async t => {
  const r = await rig(t), cookie = await r.login('member'), admin = await r.login('admin');
  const { body } = await open(r, cookie);
  await r.call('POST', '/api/admin/users/update', { id: 'member', projects: { 'acme-web': 'viewer' } }, admin);
  assert.equal((await connect({ port: r.port, cookie, ticket: body.ticket })).status, 404);
  await r.call('POST', '/api/admin/users/update', { id: 'member', projects: { 'acme-web': 'member' } }, admin);
  const next = (await open(r, cookie)).body;
  const peer = await connect({ port: r.port, cookie, ticket: next.ticket });
  t.after(() => peer.socket?.destroy()); await ready(peer);
  await r.call('POST', '/api/admin/users/reset', { id: 'member' }, admin);
  await closed(peer);
  assert.ok(peer.messages.some(m => m.close === 4003));
});
