import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createUsers } from '../server/users.mjs';
import { rig, password } from './helpers/demo-rig.mjs';

test('voice mutation routes hide from viewers and members; admins pass the guard', async t => {
  const r = await rig(t);
  for (const role of ['viewer', 'member', 'admin']) {
    const c = await r.login(role);
    for (const verb of ['install', 'delete']) {
      const v = await r.call('POST', `/api/voices/${verb}`, { key: 'unknown' }, c);
      if (role === 'admin') assert.ok([200, 400].includes(v.status), `${role}/${verb} passes the guard`);
      else assert.equal(v.status, 404, `${role}/${verb}`);
    }
  }
});

test('presence enforces the project grant in both directions', async t => {
  const r = await rig(t), c = await r.login('member');
  for (const [project, status] of [['billing-svc', 404], ['acme-web', 200]])
    assert.equal((await r.call('POST', '/api/presence', { project, session: 'master' }, c)).status, status);
});

test('profile quotas hide from viewers and remain available to members and admins', async t => {
  const r = await rig(t);
  for (const role of ['viewer', 'member', 'admin'])
    assert.equal((await r.call('GET', '/api/usage', undefined, await r.login(role))).status, role === 'viewer' ? 404 : 200);
});
