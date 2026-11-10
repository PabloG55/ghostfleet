import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { save } from '../server/attach.mjs';
const MB = 1024 * 1024;
test('attachments accept 25 MB and reject larger files before writing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(save(dir, 'scratch.bin', Buffer.alloc(25 * MB)).size, 25 * MB);
  assert.throws(() => save(dir, 'scratch.bin', Buffer.alloc(25 * MB + 1)), e => e.status === 413 && /25 MB/.test(e.message));
  assert.equal(fs.readdirSync(dir).length, 1);
});
test('session attachments accept exactly 200 MB and reject overflow without deleting anything', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, 'old.bin'); fs.closeSync(fs.openSync(old, 'w')); fs.truncateSync(old, 200 * MB - 4);
  const accepted = save(dir, 'scratch.txt', Buffer.from('four'));
  assert.equal(accepted.size, 4);
  assert.throws(() => save(dir, 'scratch.txt', Buffer.from('x')), e => e.status === 413 && /200 MB/.test(e.message));
  assert.equal(fs.statSync(old).size, 200 * MB - 4); assert.equal(fs.readdirSync(dir).length, 2);
});
