import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rig } from './helpers/demo-rig.mjs';

test('HTTP uploads report both attachment limits as 413', async t => {
  const r = await rig(t), c = await r.login('member');
  const route = '/api/attach?project=acme-web&session=master&name=scratch.bin';
  const dir = path.join(r.dir, 'attach', 'acme-web.master');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.bin'); fs.closeSync(fs.openSync(old, 'w')); fs.truncateSync(old, 200 * 1024 * 1024 - 1);
  assert.equal((await r.call('POST', route, Buffer.from('x'), c)).status, 200);
  const full = await r.call('POST', route, Buffer.from('x'), c);
  assert.equal(full.status, 413); assert.match(full.body.text, /200 MB/);
  const large = await r.call('POST', route, Buffer.alloc(25 * 1024 * 1024 + 1), c);
  assert.equal(large.status, 413); assert.match(large.body.text, /25/);
  assert.equal(fs.statSync(old).size, 200 * 1024 * 1024 - 1);
});
