#!/usr/bin/env node
// test/helpers/serve-session.mjs — what the open chat's poll costs the daemon, measured on a
// real fleet-serve running the real fleet-read over a large transcript.
//
//     node serve-session.mjs build <fleet-dir> <transcript> <sock> <session>
//     node serve-session.mjs probe <base> <enrolment-code> <transcript> <spawn-log> [grid-run-log] [digest-run-log]
//
// `probe` prints one "name <US> want <US> got" row per check; test/run.sh compares them.
//
// THE NUMBERS THIS IS SIZED FROM. The daemon's log for the evening of the report had
// /api/session answering in well under a second most of the time and in 8-26 s in clusters.
// Timed on a fleet dir of 119 status records and a 42 MB transcript, one read was 0.85 s, and
// 0.67 s of that was the LOOKUP — one jq process per status record — not the transcript at
// all. Process spawns are what a loaded Mac inflates first, and every poll paid for all of
// them, from every device the chat was open on, including the polls that queued up behind a
// slow one. So the fixture is that shape: 119 records, a transcript of the size the 46 MB
// one in fleet-serve's comments makes ordinary, and most of its bytes in tool results, which
// is where a real one keeps them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const US = '\x1f';
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'build') {
  const [fleetDir, transcript, sock, session] = rest;
  fs.mkdirSync(fleetDir, { recursive: true });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const fd = fs.openSync(transcript, 'w');
  let t = Date.parse('2026-10-01T00:00:00Z');
  const at = () => new Date(t += 1000).toISOString();
  const pad = 'x'.repeat(200);
  for (let i = 0; i < 8000; i++) {
    const k = i % 4;
    const rec = k === 0 ? { type: 'user', message: { role: 'user', content: `prompt ${i} ${pad}` }, timestamp: at() }
      : k === 1 ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${pad}` },
                    { type: 'tool_use', name: 'Bash', input: { command: `ls ${i}` } }] }, timestamp: at() }
      : k === 2 ? { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'r'.repeat(8000 + (i % 7) * 4000) }] }, timestamp: at() }
      : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i} ${pad}` }] }, timestamp: at() };
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
  }
  fs.closeSync(fd);
  // 118 records belonging to other sessions and other fleets, then this one — so the lookup
  // has to read all of them to find it, as it does on a fleet that has run for a while.
  for (let j = 0; j < 119; j++) {
    const id = crypto.randomUUID(), mine = j === 118;
    fs.writeFileSync(path.join(fleetDir, id + '.json'), JSON.stringify({
      session_id: id, sock: mine ? sock : `cf-scratch-${j % 5}`, slot: mine ? session : `w${j}`,
      transcript: mine ? transcript : path.join(path.dirname(transcript), `${id}.jsonl`),
      ts: 1000 + j, status: 'ready', cwd: path.dirname(transcript) }));
  }
  process.exit(0);
}

if (mode !== 'probe') { console.error('usage: serve-session.mjs build|probe …'); process.exit(2); }
const { Authenticator, request } = await import('./serve-client.mjs');
const [base, code, transcript, spawnLog, gridLog, digestLog] = rest;
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const a = new Authenticator({ rpId: new URL(base).hostname, origin: base });
const enrol = await a.enroll(base, code);
if (!enrol.json || !enrol.json.token) { is('enrolled', 200, enrol.status); console.log(rows.join('\n')); process.exit(0); }
const auth = { authorization: `Bearer ${a.token}` };
const PATH = '/api/session?project=demo&session=api-fix&limit=20';
const get = (headers = {}) => request(base, 'GET', PATH, { headers: { ...auth, ...headers } });
const timed = async (headers) => { const t0 = process.hrtime.bigint(); const r = await get(headers); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
const spawns = () => { try { return fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

const first = await timed();
is('the first read is the newest page', 20, first.r.json && first.r.json.messages ? first.r.json.messages.length : -1);
is('...and it is the transcript we built', true, JSON.stringify(first.r.json || {}).includes('answer 7999'));

// ── COMPRESSED, WHEN ASKED ───────────────────────────────────────────────────
// A page of the chat is the largest JSON a poll carries. A browser says it reads gzip and gets
// it; this client does not say so and must get what it always got.
const zipped = await get({ 'accept-encoding': 'gzip' });
is('a page of the chat is gzipped for a client that reads gzip', 'gzip', (zipped.headers && zipped.headers['content-encoding']) || '');
is('...and plain for one that does not', '', (first.r.headers && first.r.headers['content-encoding']) || '');

// ── THE BOUND ────────────────────────────────────────────────────────────────
// The read every open chat repeats: same page, nothing new. The median of five, so one slow
// spawn on a loaded runner is not the verdict. 250 ms is about a third of what the old reader
// took for this on an idle laptop, and several times what the new one takes.
const BOUND_MS = 250;
const times = [];
for (let i = 0; i < 5; i++) times.push((await timed()).ms);
times.sort((x, y) => x - y);
const median = Math.round(times[2]);
is(`a repeat read of an unchanged 42 MB transcript answers in under ${BOUND_MS} ms (median of 5)`, true, median < BOUND_MS);
if (process.env.SERVE_SESSION_DEBUG) console.error('first', Math.round(first.ms), 'ms; repeats', times.map(Math.round).join(' '), 'ms');

// ── CONDITIONAL ──────────────────────────────────────────────────────────────
const tag = first.r.headers && first.r.headers.etag;
is('the page carries an ETag', true, !!tag);
const same = await get({ 'if-none-match': tag || '"none"' });
is('...and a client that holds it gets a 304', 304, same.status);
is('...with no body (bytes)', 0, (same.text || '').length);
// Both directions: a tag that does not match must still get the page, or a daemon answering
// 304 to everything would pass the two rows above.
const other = await get({ 'if-none-match': '"something-else"' });
is('a tag that does not match gets the page', 200, other.status);

// The transcript moves on: the same tag must now buy the new page, not a 304.
fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T00:00:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'a reply written while the chat was open' }] } }) + '\n');
const moved = await get({ 'if-none-match': tag || '"none"' });
is('after the transcript grows, the old tag gets a 200', 200, moved.status);
is('...carrying the new message', true, (moved.text || '').includes('a reply written while the chat was open'));
is('...under a new tag', true, !!(moved.headers && moved.headers.etag) && moved.headers.etag !== tag);

// ── ONE READ, HOWEVER MANY ASK ───────────────────────────────────────────────
// Six at once is the backlog the log showed — polls that queued behind a slow answer, and the
// same chat open on two devices. They are all asking the same question.
fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T00:00:01Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'and one more after it' }] } }) + '\n');
const s0 = spawns();
const burst = await Promise.all(Array.from({ length: 6 }, () => get()));
is('six reads at once all get the page', 6, burst.filter(r => r.status === 200 && (r.text || '').includes('and one more after it')).length);
is('...from ONE run of fleet-read', 1, spawns() - s0);

// ── ONE GRID PER FLEET, HOWEVER MANY ASK ─────────────────────────────────────
// The grid here is a stand-in that writes a line each time it is run and takes 300 ms to answer,
// so "at once" really overlaps. Two devices on the same screen are two reads of the same fleet;
// the Projects rollup is a third, by another route. Counted in runs, because a run is the
// process the daemon starts, and both directions: kept for ever would pass the first three rows,
// so the same read after the kept one has aged must run again, and so must the read that
// follows a write, though it comes well inside the time a result is kept.
if (gridLog) {
  const runs = () => { try { return fs.readFileSync(gridLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const grid = () => request(base, 'GET', '/api/grid?project=demo', { headers: auth });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(2700);
  let g0 = runs();
  const pair = await Promise.all([grid(), grid()]);
  is('two clients reading a fleet\'s grid at once both get it', 2, pair.filter(r => r.status === 200 && r.json && Array.isArray(r.json.cards)).length);
  is('...from ONE run of fleet-grid', 1, runs() - g0);
  await grid();
  await request(base, 'GET', '/api/projects', { headers: auth });
  is('...and a read just after, and the Projects rollup, start no other', 1, runs() - g0);
  await wait(2700);
  g0 = runs();
  await grid();
  is('a read after the kept grid has aged runs it again', 1, runs() - g0);
  g0 = runs();
  const sent = await request(base, 'POST', '/api/verb', { headers: auth, body: { tool: 'fleet_send', args: { project: 'demo', session: 'api-fix', prompt: 'a line' } } });
  is('a send is answered', true, sent.status > 0);
  await wait(100);
  await grid();
  is('a send to a fleet makes the next read run that fleet\'s grid again', 1, runs() - g0);

  // ── the list without its rollup, and one digest for everyone asking ──────────────────
  // What the app's own poll asks every five seconds. The rollup is a grid per fleet, so the
  // list asked for WITHOUT it must start none, measured after the kept grid has aged so that
  // "none" cannot be the kept one answering; and the same list WITH it must start one, or the
  // first row would pass on a daemon that never ran a grid at all.
  await wait(2700);
  g0 = runs();
  const bare = await request(base, 'GET', '/api/projects?rollup=0', { headers: auth });
  is('the project list without its rollup is answered', true, bare.status === 200 && Array.isArray(bare.json?.projects) && bare.json.projects.length === 1);
  is('...and runs no grid', 0, runs() - g0);
  await request(base, 'GET', '/api/projects', { headers: auth });
  is('...where the list with it runs one', 1, runs() - g0);
  if (digestLog) {
    const druns = () => { try { return fs.readFileSync(digestLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const digest = () => request(base, 'GET', '/api/digest', { headers: auth });
    let d0 = druns();
    const three = await Promise.all([digest(), digest(), digest()]);
    is('three clients asking for the digest at once all get it', 3, three.filter(r => r.status === 200 && r.json && r.json.ok).length);
    is('...from ONE run of fleet-digest', 1, druns() - d0);
    await wait(2700);
    d0 = druns();
    await digest();
    is('a digest asked for after the kept one has aged is run again', 1, druns() - d0);
  }
}

console.log(rows.join('\n'));
