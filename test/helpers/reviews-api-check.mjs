#!/usr/bin/env node
// reviews-api-check — the Reviews routes (lib/shots.mjs) on a real fleet-serve, driven with a
// real passkey ceremony, over runs in two profiles.
//
//     node reviews-api-check.mjs build <home>
//     node reviews-api-check.mjs probe <base> <enrolment-code> <home> <experimental-dir> <audit-file>
//
// `probe` prints "name <US> want <US> got" rows; test/run.sh compares them.
//
// WHAT HAS TO BE TRUE, and why each is asked of the server rather than of the source:
//   - OFF IS GONE. With the `shots` switch off every route is a 404 that says so, and
//     nothing else the phone reads mentions reviews — a 200 describing "no reviews" would
//     draw an entry. Flipped at runtime, because the daemon reads the switch per request.
//   - ONE ENTRY PER BRANCH, newest first BY WHEN THE RUN HAPPENED. A run recorded with
//     `--out <name>` has a folder named for its flow, and the old index both dated and
//     sorted it by that name.
//   - THE VIDEO PLAYS ON iOS. Safari probes with `Range: bytes=0-1` and will not play from a
//     server that answers with the whole file, so every range shape gets its 206 or 416 with
//     the right headers — and the bytes are compared, not just the status.
//   - A PHONE NAMES THE FILE, so it is checked: traversal, a file that is not media, a run
//     that is not a folder, and a ticket for another run are all refused.
//   - A VERDICT IS THE GATE'S INPUT: what the phone writes is what `fleet-shots --check` reads.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const US = '\x1f';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [mode, ...rest] = process.argv.slice(2);

// 1000 bytes with a position in every byte, so a range that returns the wrong slice is
// caught by comparing bytes rather than only by its length.
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

const prov = (branch, at, repo, extra = {}) => ({ commit: '0123456789abcdef0123456789abcdef01234567', branch, dirty: false,
  repo, base: 'http://127.0.0.1:1', viewport: { width: 390, height: 844 }, at, session: branch, slot: 1, ...extra });
const recorded = (p) => ({ provenance: p, video: 'flow.mp4', duration: 9, problems: 1, steps: [
  { n: 1, name: 'the sign-in screen', start: 0, end: 3, file: null, url: 'http://127.0.0.1:1/login', title: 'Sign in', notes: [],
    requests: [{ method: 'GET', url: 'http://127.0.0.1:1/login', type: 'Document', status: 200 }] },
  { n: 2, name: 'after signing in', start: 3, end: 6, file: null, url: 'http://127.0.0.1:1/login', title: 'Sign in',
    notes: ['POST http://127.0.0.1:1/api/v1/signin answered 404'],
    requests: [{ method: 'POST', url: 'http://127.0.0.1:1/api/v1/signin', type: 'Fetch', status: 404 }] },
  { n: 3, name: 'the dashboard', start: 6, end: 9, file: null, url: 'http://127.0.0.1:1/home', title: 'Home', notes: [], requests: [] } ] });
const stills = (p) => ({ provenance: p, problems: 0, steps: [
  { n: 1, name: 'the docs index', file: '01-index.png', url: 'http://127.0.0.1:1/docs', title: 'Docs', notes: [], requests: [] },
  { n: 2, name: 'a page', file: '02-page.png', at: 'http://127.0.0.1:1/docs/a', title: 'A', notes: [], requests: [] } ] });

function write(dir, m, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), b);
}

if (mode === 'build') {
  const [home] = rest;
  const api = path.join(home, 'code', 'acme-api'), wt = path.join(home, 'code', 'api-fix'), tb = path.join(home, 'code', 'toolbox');
  for (const d of [api, wt, tb]) fs.mkdirSync(d, { recursive: true });
  // A LINKED WORKTREE, as a fleet worker records from: its folder name is nobody's project,
  // and its `.git` file names the repo it belongs to.
  fs.mkdirSync(path.join(api, '.git', 'worktrees', 'api-fix'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(api, '.git', 'worktrees', 'api-fix')}\n`);
  fs.mkdirSync(path.join(home, '.config', 'ghostfleet'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ghostfleet', 'projects'), `acme-api\t${api}\twork\n`);
  fs.writeFileSync(path.join(home, '.config', 'ghostfleet', 'projects.personal'), `toolbox\t${tb}\tpersonal\n`);
  const w = path.join(home, '.claude', 'fleet', 'shots'), pp = path.join(home, '.claude-personal', 'fleet', 'shots');
  // api-fix: three runs, the newest recorded and flagged; the older two must fold away.
  write(path.join(w, '2026-03-01_09-00-00'), recorded(prov('api-fix', '2026-03-01T09:00:00.000Z', wt)), { 'flow.mp4': VIDEO });
  write(path.join(w, '2026-03-03_09-00-00'), recorded(prov('api-fix', '2026-03-03T09:00:00.000Z', wt)), { 'flow.mp4': VIDEO });
  fs.writeFileSync(path.join(w, '2026-03-01_09-00-00', 'verdict.json'), JSON.stringify({ flow: { v: 'reject', note: 'old' }, chapters: {} }));
  // ...and the NEWEST of them in a folder named for its flow, which sorts BEFORE the stamps
  // by name. Its date is the manifest's, and it is api-fix's latest.
  write(path.join(w, 'sign-in-flow'), recorded(prov('api-fix', '2026-03-05T09:00:00.000Z', wt)), { 'flow.mp4': VIDEO });
  // cache-keys: one run, recorded in the main checkout.
  write(path.join(w, '2026-03-02_09-00-00'), recorded(prov('cache-keys', '2026-03-02T09:00:00.000Z', api)), { 'flow.mp4': VIDEO });
  // A stranger's manifest.json: valid JSON, no steps.
  write(path.join(w, 'some-other-program.aA1'), { manifest_version: 3, name: 'Some Component' });
  // personal: a stills run, approved, in another profile.
  write(path.join(pp, '2026-03-04_09-00-00'), stills(prov('docs-pass', '2026-03-04T09:00:00.000Z', tb)),
        { '01-index.png': Buffer.from('\x89PNG\r\n\x1a\n'), '02-page.png': Buffer.from('\x89PNG\r\n\x1a\n') });
  fs.writeFileSync(path.join(pp, '2026-03-04_09-00-00', 'verdict.json'),
                   JSON.stringify({ 1: { v: 'ok', note: '' }, 2: { v: 'skip', note: '' } }));
  // What traversal would reach: beside the shots dir, and in HOME.
  fs.writeFileSync(path.join(home, '.claude', 'fleet', 'secret.png'), 'not yours');
  fs.writeFileSync(path.join(home, 'secret.png'), 'not yours');
  process.exit(0);
}

if (mode !== 'probe') { console.error('usage: reviews-api-check.mjs build|probe …'); process.exit(2); }
const { Authenticator, request } = await import('./serve-client.mjs');
const [base, code, home, expDir, auditFile] = rest;
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const out = () => { console.log(rows.join('\n')); process.exit(0); };
process.on('uncaughtException', (e) => { is('reviews-api-check threw', '', String(e && e.stack || e).slice(0, 300)); out(); });

const a = new Authenticator({ rpId: new URL(base).hostname, origin: base });
const enrol = await a.enroll(base, code);
if (!enrol.json || !enrol.json.token) { is('enrolled', 200, enrol.status); out(); }
const auth = { authorization: `Bearer ${a.token}` };
const get = (p, headers = {}) => request(base, 'GET', p, { headers: { ...auth, ...headers } });
const post = (p, body) => request(base, 'POST', p, { headers: { ...auth, origin: base }, body });
const switchTo = (v) => fs.writeFileSync(path.join(expDir, 'shots.enabled'), v + '\n');
const W = path.join(home, '.claude', 'fleet', 'shots');

// ── off is gone ───────────────────────────────────────────────────────────────
switchTo('off');
const offList = await get('/api/shots');
is('off: /api/shots is a 404', 404, offList.status);
is('...that says it is switched off', true, !!(offList.json && offList.json.disabled && offList.json.experimental));
is('...and how to turn it on', true, /fleet-experimental enable shots/.test((offList.json || {}).text || ''));
is('off: a run read is a 404 too', 404, (await get('/api/shots/run?profile=work&run=sign-in-flow')).status);
is('off: media is a 404 too, not a 401', 404, (await get('/api/shots/media?profile=work&run=sign-in-flow&file=flow.mp4&k=x', {})).status);
is('off: a verdict is refused, and nothing is written', '404:no',
   `${(await post('/api/shots/verdict', { profile: 'work', run: 'sign-in-flow', flow: { v: 'approve' } })).status}:` +
   (fs.existsSync(path.join(W, 'sign-in-flow', 'verdict.json')) ? 'yes' : 'no'));
const offProj = await get('/api/projects');
is('off: Projects still answers', 200, offProj.status);
// KEYS, not text: a project's path may contain any word, and the question is whether the
// payload grew a field for reviews.
const keys = (o, acc = []) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.push(k); keys(v, acc); } return acc; };
is('...and carries no field about reviews', [], keys(offProj.json).filter(k => /shots|review/i.test(k)));
switchTo('on');

// ── the token gate ────────────────────────────────────────────────────────────
is('no token: the list is a 401', 401, (await request(base, 'GET', '/api/shots')).status);
is('no token: a run read is a 401', 401, (await request(base, 'GET', '/api/shots/run?profile=work&run=sign-in-flow')).status);

// ── the list ──────────────────────────────────────────────────────────────────
const L = await get('/api/shots');
is('on: the list answers', 200, L.status);
const G = (L.json && L.json.groups) || [];
const label = (g) => `${g.profile}/${g.project}/${g.branch}`;
is('one entry per branch, newest run first, across both profiles', 'work/acme-api/api-fix,personal/toolbox/docs-pass,work/acme-api/cache-keys',
   G.map(label).join(','));
is('a worktree run is filed under its repo\'s project', 'acme-api', (G[0] || {}).project);
is('two profiles with runs: the cards are labelled', true, !!(L.json && L.json.multi));
const af = G[0] || { latest: {}, earlier: [] };
is('api-fix\'s newest is the run in the NAMED folder', 'sign-in-flow', af.latest.id);
is('...dated by its manifest, not its folder name', '2026-03-05T09:00:00.000Z', af.latest.at);
is('...and the older two fold under it, newest first', '2026-03-03_09-00-00,2026-03-01_09-00-00', (af.earlier || []).map(r => r.id).join(','));
is('...an old rejection is history: the card is the newest run\'s state', 'unreviewed:warn', `${af.latest.state?.label}:${af.latest.state?.cls}`);
is('the approved branch does not wait', false, (G[1] || {}).waiting);
is('two branches wait on you', 2, L.json && L.json.waiting);
is('a stranger\'s manifest.json is not a run', false, /some-other-program/.test(L.text || ''));

// ── a run ─────────────────────────────────────────────────────────────────────
const R = await get('/api/shots/run?profile=work&run=sign-in-flow');
const run = (R.json || {}).run || {};
is('a run read answers', 200, R.status);
is('...with its steps, what each asked for and where it ended', '2:POST:404:http://127.0.0.1:1/login',
   `${run.steps?.[1]?.n}:${run.steps?.[1]?.requests?.[0]?.method}:${run.steps?.[1]?.requests?.[0]?.status}:${run.steps?.[1]?.url}`);
is('...its provenance', '0123456789abcdef0123456789abcdef01234567:false:390', `${run.provenance?.commit}:${run.provenance?.dirty}:${run.provenance?.viewport?.width}`);
is('...its kind and its video', 'recorded:flow.mp4', `${run.kind}:${run.video}`);
is('...and a media ticket', true, typeof R.json?.media?.ticket === 'string' && R.json.media.ticket.length > 20);
const S = await get('/api/shots/run?profile=personal&run=2026-03-04_09-00-00');
is('an old manifest\'s `at` reads as the step URL', 'http://127.0.0.1:1/docs/a', S.json?.run?.steps?.[1]?.url);
is('a run that is not a folder name is a 404', 404, (await get('/api/shots/run?profile=work&run=..')).status);
is('a run in a profile nobody has is a 404', 404, (await get('/api/shots/run?profile=nobody&run=sign-in-flow')).status);
is('a stranger\'s folder is a 404', 404, (await get('/api/shots/run?profile=work&run=some-other-program.aA1')).status);

// ── media ─────────────────────────────────────────────────────────────────────
const k = R.json?.media?.ticket || '';
const M = (q, h = {}) => request(base, 'GET', `/api/shots/media?${q}`, { headers: h });
const mq = (extra = '') => `profile=work&run=sign-in-flow&file=flow.mp4&k=${encodeURIComponent(k)}${extra}`;
const bytes = (r) => Buffer.from(r.text || '', 'latin1');
const raw = (q, h = {}) => new Promise((res, rej) => {
  import('node:http').then(({ default: http }) => {
    const u = new URL(`/api/shots/media?${q}`, base);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (r) => {
      const parts = []; r.on('data', d => parts.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts) }));
    }).on('error', rej);
  });
});
is('media with no ticket is a 401', 401, (await M('profile=work&run=sign-in-flow&file=flow.mp4')).status);
is('...and with a made-up one', 401, (await M('profile=work&run=sign-in-flow&file=flow.mp4&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status);
is('...and with this run\'s ticket for ANOTHER run', 401, (await M(`profile=work&run=2026-03-03_09-00-00&file=flow.mp4&k=${encodeURIComponent(k)}`)).status);
is('...and a bearer token is not a ticket', 401, (await M('profile=work&run=sign-in-flow&file=flow.mp4', auth)).status);
const whole = await raw(mq());
is('the whole file: 200, video/mp4, its length, ranges offered', '200:video/mp4:1000:bytes',
   `${whole.status}:${whole.headers['content-type']}:${whole.headers['content-length']}:${whole.headers['accept-ranges']}`);
is('...and the bytes are the file\'s', true, whole.body.equals(VIDEO));
const probe = await raw(mq(), { range: 'bytes=0-1' });
is('iOS\'s probe, bytes=0-1: a 206 of two bytes', '206:2:bytes 0-1/1000:video/mp4',
   `${probe.status}:${probe.headers['content-length']}:${probe.headers['content-range']}:${probe.headers['content-type']}`);
is('...holding the first two', true, probe.body.equals(VIDEO.subarray(0, 2)));
const mid = await raw(mq(), { range: 'bytes=500-509' });
is('a middle range is that slice', '206:10:bytes 500-509/1000:yes',
   `${mid.status}:${mid.headers['content-length']}:${mid.headers['content-range']}:${mid.body.equals(VIDEO.subarray(500, 510)) ? 'yes' : 'no'}`);
const open = await raw(mq(), { range: 'bytes=990-' });
is('an open-ended range runs to the end', '206:10:bytes 990-999/1000', `${open.status}:${open.headers['content-length']}:${open.headers['content-range']}`);
const tail = await raw(mq(), { range: 'bytes=-5' });
is('a suffix range is the last N bytes', '206:bytes 995-999/1000:yes', `${tail.status}:${tail.headers['content-range']}:${tail.body.equals(VIDEO.subarray(995)) ? 'yes' : 'no'}`);
const over = await raw(mq(), { range: 'bytes=900-5000' });
is('an end past the file is clamped', '206:bytes 900-999/1000', `${over.status}:${over.headers['content-range']}`);
const past = await raw(mq(), { range: 'bytes=1000-' });
is('a start past the file is a 416 naming the size', '416:bytes */1000', `${past.status}:${past.headers['content-range']}`);
is('...and so is a range that is not one', 416, (await raw(mq(), { range: 'bytes=abc' })).status);
is('traversal out of the run is refused', 403, (await M(`profile=work&run=sign-in-flow&file=${encodeURIComponent('../secret.png')}&k=${encodeURIComponent(k)}`)).status);
is('...and out of HOME', 403, (await M(`profile=work&run=sign-in-flow&file=${encodeURIComponent('../../../../secret.png')}&k=${encodeURIComponent(k)}`)).status);
is('...and a run that walks up', 401, (await M(`profile=work&run=..&file=secret.png&k=${encodeURIComponent(k)}`)).status);
is('a file that is not media is refused', 403, (await M(`profile=work&run=sign-in-flow&file=manifest.json&k=${encodeURIComponent(k)}`)).status);
is('...and so is the verdict', 403, (await M(`profile=work&run=sign-in-flow&file=verdict.json&k=${encodeURIComponent(k)}`)).status);
is('media that is not there is a 404', 404, (await M(`profile=work&run=sign-in-flow&file=nope.mp4&k=${encodeURIComponent(k)}`)).status);

// ── a verdict, and the gate that reads it ─────────────────────────────────────
const check = (dir) => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'bin', 'fleet-shots.mjs'), '--check', dir],
    { stdio: 'ignore', env: { ...process.env, CLAUDE_FLEET_EXPERIMENTAL_DIR: expDir } }); return 0; }
  catch (e) { return e.status ?? -1; }
};
const SF = path.join(W, 'sign-in-flow');
is('unreviewed: --check refuses', 1, check(SF));
const v1 = await post('/api/shots/verdict', { profile: 'work', run: 'sign-in-flow', flow: { v: 'approve', note: '' }, chapters: {} });
is('approve with the flagged chapter unexplained: saved, and still flagged', '200:1 flagged', `${v1.status}:${v1.json?.state?.label}`);
is('...so --check still refuses', 1, check(SF));
const v2 = await post('/api/shots/verdict', { profile: 'work', run: 'sign-in-flow', flow: { v: 'approve', note: 'looks right' },
  chapters: { 2: 'the 404 is the stub server', 9: 'a chapter this run lacks' } });
is('a note on the flagged chapter: approved', '200:approved', `${v2.status}:${v2.json?.state?.label}`);
is('...and --check passes on what the phone wrote', 0, check(SF));
is('...and a chapter the run lacks was dropped', false, '9' in (JSON.parse(fs.readFileSync(path.join(SF, 'verdict.json'), 'utf8')).chapters || {}));
is('the list now reads it approved', 'approved', ((await get('/api/shots')).json?.groups || []).find(g => g.branch === 'api-fix')?.latest?.state?.label);
is('a flow verdict that is neither approve nor reject is a 400', 400,
   (await post('/api/shots/verdict', { profile: 'work', run: 'sign-in-flow', flow: { v: 'maybe' } })).status);
const sv = await post('/api/shots/verdict', { profile: 'personal', run: '2026-03-04_09-00-00', state: { 1: { v: 'ok', note: '' }, 2: { v: 'problem', note: 'the link is dead' } } });
is('a stills run takes a verdict per step', '200:1 problem', `${sv.status}:${sv.json?.state?.label}`);
is('...a state of nothing usable is refused', 400, (await post('/api/shots/verdict', { profile: 'personal', run: '2026-03-04_09-00-00', state: { 1: { v: 'yes' } } })).status);
is('a verdict on a run that walks up is a 404', 404, (await post('/api/shots/verdict', { profile: 'work', run: '..', flow: { v: 'approve' } })).status);
is('a GET is not a verdict', 405, (await get('/api/shots/verdict')).status);
is('a verdict from another origin is refused', 403,
   (await request(base, 'POST', '/api/shots/verdict', { headers: { ...auth, origin: 'https://elsewhere.example' }, body: { profile: 'work', run: 'sign-in-flow', flow: { v: 'reject' } } })).status);
let audit = [];
try { audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
const vrows = audit.filter(r => r.verb === 'shots_verdict');
is('every saved verdict is on the audit chain, with who and which run', '3:work/sign-in-flow:yes',
   `${vrows.length}:${vrows[0]?.subject}:${vrows.every(r => r.client === a.clientId) ? 'yes' : 'no'}`);
// THE TICKET DIES WITH THE CLIENT: asked of fleet-serve per request, so a revoke lands on a
// running daemon. Last, because it takes the client with it.
const before = (await raw(mq(), { range: 'bytes=0-1' })).status;
execFileSync(process.execPath, [path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'revoke', a.clientId], { stdio: 'ignore', env: process.env });
is('a revoked client\'s ticket stops working', '206:401', `${before}:${(await raw(mq(), { range: 'bytes=0-1' })).status}`);
out();
