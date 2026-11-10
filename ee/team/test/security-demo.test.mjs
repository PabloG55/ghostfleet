import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createUsers } from '../server/users.mjs';
import { rig, password } from './helpers/demo-rig.mjs';

test('demo AI and voice routes spawn nothing and preserve voice files', async t => {
  const r = await rig(t), c = await r.login('admin'); r.clear();
  const replies = [];
  replies.push(await r.call('POST', '/api/route', { text: 'review acme-web' }, c));
  replies.push(await r.call('POST', '/api/automations/ai', { messages: [{ text: 'review daily' }] }, c));
  replies.push(await r.call('POST', '/api/voices/install', { key: 'es_MX-claude-high' }, c));
  replies.push(await r.call('POST', '/api/voices/delete', { key: 'es_ES-carlfm-x_low' }, c));
  assert.deepEqual(r.calls().filter(x => ['spawn', 'execFile'].includes(x.kind)), []);
  for (const reply of replies) { assert.equal(reply.status, 200); assert.match(JSON.stringify(reply.body), /demo/i); }
  assert.equal(fs.readFileSync(r.model, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(`${r.model}.json`, 'utf8'), 'keep');
});

test('demo attachments live under demo GFW_DATA', async t => {
  const r = await rig(t), c = await r.login('member');
  const v = await r.call('POST', '/api/attach?project=acme-web&session=master&name=demo.txt', Buffer.from('demo'), c);
  assert.equal(v.status, 200); assert.ok(v.body.path.startsWith(r.dir + path.sep), v.body.path);
});
