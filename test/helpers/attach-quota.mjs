#!/usr/bin/env node
// test/helpers/attach-quota.mjs — a message of photos never deletes itself.
//
//     node test/helpers/attach-quota.mjs <scratch-dir>
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// The phone uploads a message's photos one request at a time, and every upload runs the
// per-session quota, which drops the OLDEST files first. At 24 MB, ten full-size photos on a
// machine with no converter deleted the first six of their own message before it was sent,
// so the agent got six paths to nothing. This stands up the worst case on disk — sparse
// files, so 78 MB of "photos" costs nothing — and asks the server's own enforceQuota().
import fs from 'node:fs';
import path from 'node:path';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const serve = await import(new URL('../../bin/fleet-serve.mjs', import.meta.url).href);
const api = await import(new URL('../../web/api.js', import.meta.url).href);
const MAX = 6 * 1024 * 1024;

is('the phone and the server agree on photos per message', serve.ATTACH_PER_MESSAGE, api.ATTACH_PER_MESSAGE);
is('...and it is ten', 10, api.ATTACH_PER_MESSAGE);

const dir = path.join(process.argv[2], 'quota.acme-api');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const t0 = Date.now() / 1000 - 3600;
const put = (name, at) => {
  const f = path.join(dir, name);
  fs.closeSync(fs.openSync(f, 'w'));
  fs.truncateSync(f, MAX);                    // sparse: the size is real, the blocks are not
  fs.utimesSync(f, at, at);
  return f;
};
// An earlier message, then this one: ten photos at the size limit, landing one by one, with
// the quota run after each — exactly what /api/attach does.
const earlier = [0, 1, 2].map((i) => put(`old-${i}.jpg`, t0 + i));
const mine = [];
for (let i = 0; i < serve.ATTACH_PER_MESSAGE; i++) {
  mine.push(put(`new-${i}.jpg`, t0 + 100 + i));
  serve.enforceQuota(dir);
}
is('every photo of the message is still on disk', serve.ATTACH_PER_MESSAGE, mine.filter((f) => fs.existsSync(f)).length);
is('...the first one included', true, fs.existsSync(mine[0]));
// BOTH DIRECTIONS: the quota still does its job, on the earlier message.
is('the earlier message is what made room', 0, earlier.filter((f) => fs.existsSync(f)).length);

fs.rmSync(dir, { recursive: true, force: true });
console.log(rows.join('\n'));
