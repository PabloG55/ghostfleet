#!/usr/bin/env node
// reviews-peer-check — the Reviews routes across two PAIRED fleet-serves: the phone logs in to
// one (the laptop) and reviews the other's (the vm's) runs through it.
//
//     node test/helpers/reviews-peer-check.mjs [root]     # "name <US> want <US> got" rows
//
// `root` is a checkout whose bin/, lib/ and mcp/ are run; it defaults to this one. Pointed at
// a `git archive` of a daemon that has no paired reviews, every row about the vm's runs fails
// for its own reason — no host on a group, a 403 from the vm, a verdict written nowhere —
// which is how each was watched red before it was trusted.
//
// WHAT HAS TO BE TRUE, and why each is asked of the two servers rather than of the source:
//   - ONE LIST, BOTH MACHINES. The vm's runs are in the laptop's list, each labelled with
//     the vm's label, and the same branch on both machines is two cards, not one.
//   - A MACHINE THAT DOES NOT ANSWER costs its own runs and nothing else: the laptop's are
//     all there, one entry says which host is missing, and the answer comes back inside the
//     fan-out's timeout rather than whenever the silent machine gives up.
//   - THE VIDEO PLAYS ON iOS through two hops: a Range on the laptop is a 206 with the vm's
//     Content-Range, and the BYTES are the vm's — compared, not only counted.
//   - A VERDICT LANDS WHERE --check READS IT: in the vm's run dir, not in the laptop's run of
//     the same name, audited on both with who asked.
//   - ONLY A SIGNATURE OPENS THE VM: unsigned, a stranger's pairing, a replay, a second hop.
//   - SWITCHED OFF IS GONE on each side: a vm with Reviews off contributes nothing (not a
//     line), and a laptop with Reviews off shows none, whatever the vm has.
//
// Each host is its own world (HOME, serve.json, audit, port, switch dir). The daemons are
// this script's children, killed by the pids it captured and titled the way the suite's
// orphan sweep recognises.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Authenticator, request } from './serve-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(HERE, '..', '..'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const kids = [];
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'reviews-peer.'));
const holes = [];
function finish(code = 0) {
  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch {} }
  for (const h of holes) { try { h.close(); } catch {} }
  console.log(rows.join('\n'));
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => { console.error(String(e && e.stack || e)); finish(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const RT = path.join(T, 'rt');
for (const d of ['bin', 'mcp', 'lib']) fs.cpSync(path.join(SRC, d), path.join(RT, d), { recursive: true });

// ── runs ────────────────────────────────────────────────────────────────────────────
// Two recordings that differ in every byte, so a range served from the wrong machine is
// caught by its bytes and not only by its length.
const VID = { a: Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)),
              b: Buffer.from(Array.from({ length: 1000 }, (_, i) => 250 - (i % 251))) };
const prov = (branch, at, repo) => ({ commit: '0123456789abcdef0123456789abcdef01234567', branch, dirty: false, repo,
  base: 'http://127.0.0.1:1', viewport: { width: 390, height: 844 }, at, session: branch, slot: 1 });
const recorded = (p, first) => ({ provenance: p, video: 'flow.mp4', duration: 6, problems: 0, steps: [
  { n: 1, name: first, start: 0, end: 3, file: null, url: 'http://127.0.0.1:1/', title: 'Home', notes: [], requests: [] },
  { n: 2, name: 'the next screen', start: 3, end: 6, file: null, url: 'http://127.0.0.1:1/next', title: 'Next', notes: [], requests: [] } ] });
function write(dir, m, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), b);
}

async function host(id, projects, runs) {
  const dir = path.join(T, id), home = path.join(dir, 'home'), xd = path.join(dir, 'xd');
  fs.mkdirSync(path.join(home, '.config', 'ghostfleet'), { recursive: true });
  fs.mkdirSync(xd, { recursive: true });
  fs.writeFileSync(path.join(xd, 'shots.enabled'), 'on\n');
  const lines = [];
  for (const name of projects) { fs.mkdirSync(path.join(dir, name), { recursive: true }); lines.push(`${name}\t${path.join(dir, name)}\twork`); }
  fs.writeFileSync(path.join(home, '.config', 'ghostfleet', 'projects'), lines.join('\n') + '\n');
  const shots = path.join(home, '.claude', 'fleet', 'shots');
  for (const [run, project, branch, at, first] of runs)
    write(path.join(shots, run), recorded(prov(branch, at, path.join(dir, project)), first), { 'flow.mp4': VID[id] });
  // What traversal would reach on the vm: beside its shots dir.
  fs.writeFileSync(path.join(home, '.claude', 'fleet', 'secret.mp4'), 'not yours');
  const port = await freePort();
  const h = { id, dir, home, xd, shots, port, base: `http://localhost:${port}`, log: path.join(dir, 'log'),
              cfg: path.join(dir, 'serve.json'), audit: path.join(dir, 'audit.jsonl'), peers: path.join(dir, 'serve-peers.json') };
  h.env = { ...process.env, HOME: home, TMUX: '', CLAUDE_FLEET_AWAKE: 'off', GHOSTFLEET_SERVE_CONFIG: h.cfg,
            GHOSTFLEET_SERVE_AUDIT: h.audit, CLAUDE_FLEET_EXPERIMENTAL_DIR: xd, GHOSTFLEET_AT_MAC_FILE: path.join(dir, 'no-atmac.json') };
  delete h.env.CLAUDE_FLEET_DIR; delete h.env.CLAUDE_CONFIG_DIR; delete h.env.CLAUDE_FLEET_SOCK;
  h.cli = (...args) => { try { return { code: 0, out: execFileSync('node', [path.join(RT, 'bin', 'fleet-serve.mjs'), ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                          catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  h.cli('init', '--bind', '127.0.0.1', '--port', String(port));
  const c = JSON.parse(fs.readFileSync(h.cfg, 'utf8'));
  c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(h.cfg, JSON.stringify(c, null, 2));
  h.switchTo = (v) => fs.writeFileSync(path.join(xd, 'shots.enabled'), v + '\n');
  return h;
}
async function start(h) {
  const k = spawn('node', [`--title=ghostfleet-test:${process.env.TMUX_TMPDIR || T}/fleet-serve.mjs`, path.join(RT, 'bin', 'fleet-serve.mjs')],
                  { env: h.env, stdio: ['ignore', fs.openSync(h.log, 'a'), fs.openSync(h.log, 'a')] });
  kids.push(k); h.kid = k;
  if (process.env.TMUX_TMPDIR) try { fs.appendFileSync(path.join(process.env.TMUX_TMPDIR, 'serve.pids'), `${k.pid}\n`); } catch {}
  for (let i = 0; i < 80; i++) {
    const r = await request(h.base, 'GET', '/healthz').catch(() => null);
    if (r && r.status === 200) return true;
    if (k.exitCode !== null) break;
    await sleep(100);
  }
  return false;
}
async function stop(h) {
  try { process.kill(h.kid.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 50 && h.kid.exitCode === null && h.kid.signalCode === null; i++) await sleep(50);
}

// The laptop: acme-api's api-fix. The vm: ITS acme-api's api-fix too (the same branch on two
// machines, which must stay two cards), and toolbox's docs-pass. `sign-in-flow` is a run
// NAME on both, so a verdict that lands on the wrong machine has a file to land in.
const A = await host('a', ['acme-api'], [
  ['sign-in-flow', 'acme-api', 'api-fix', '2026-03-05T09:00:00.000Z', 'the laptop sign-in'],
]);
const B = await host('b', ['acme-api', 'toolbox'], [
  ['sign-in-flow', 'acme-api', 'api-fix', '2026-03-06T09:00:00.000Z', 'the vm sign-in'],
  ['2026-03-04_09-00-00', 'toolbox', 'docs-pass', '2026-03-04T09:00:00.000Z', 'the docs index'],
]);
const code = (h) => (h.cli('enroll', 'phone').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
const ca = code(A), cb = code(B);
if (!(await start(A)) || !(await start(B))) {
  is('both daemons come up', 'up', `down: ${fs.readFileSync(A.log, 'utf8').slice(0, 200)} | ${fs.readFileSync(B.log, 'utf8').slice(0, 200)}`);
  finish(1);
}
const pa = new Authenticator({ rpId: 'localhost', origin: A.base });
await pa.enroll(A.base, ca);
// The vm's own phone: what a hidden project's runs look like to the machine that has them.
const pb = new Authenticator({ rpId: 'localhost', origin: B.base });
await pb.enroll(B.base, cb);
const audit = (h) => { try { return fs.readFileSync(h.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const cards = (r) => ((r.json && r.json.groups) || []).map(g => `${g.host || '-'}:${g.project}:${g.branch}`).join(' ');
// Raw bytes, which serve-client's utf8 text cannot give back.
const raw = (base, pathq, headers = {}) => new Promise((resolve) => {
  const u = new URL(pathq, base);
  const req = http.request({ hostname: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
    const parts = []; res.on('data', d => parts.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: Buffer.alloc(0) }));
  req.end();
});

// ── before pairing: the payload A shipped ─────────────────────────────────────────────
let r = await pa.api(A.base, 'GET', '/api/shots');
is('unpaired: the laptop lists its own run only', 'acme-api:api-fix', ((r.json && r.json.groups) || []).map(g => `${g.project}:${g.branch}`).join(' '));
is('unpaired: no host on a group, no hosts list, no missing list', 'false false false',
   [((r.json && r.json.groups) || []).some(g => 'host' in g), !!(r.json && 'hosts' in r.json), !!(r.json && 'missing' in r.json)].join(' '));

// ── pair ──────────────────────────────────────────────────────────────────────────────
let c = A.cli('pair', '--as', 'laptop');
c = B.cli('pair', A.base, (c.out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0], '--as', 'vm');
is('the two pair', 0, c.code);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const vmOnA = (readJson(A.peers).peers || [])[0] || {}, lapOnB = (readJson(B.peers).peers || [])[0] || {};

// ── one list, both machines ───────────────────────────────────────────────────────────
r = await pa.api(A.base, 'GET', '/api/shots');
is('paired: the list has both machines\' runs, newest first, each with its host',
   'vm:acme-api:api-fix laptop:acme-api:api-fix vm:toolbox:docs-pass', cards(r));
is('...the vm\'s groups carry its key, the laptop\'s none', 'vm  vm',
   ((r.json && r.json.groups) || []).map(g => g.host_key).join(' '));
is('...the same branch on two machines is two cards with two keys', 2,
   new Set(((r.json && r.json.groups) || []).filter(g => g.branch === 'api-fix').map(g => g.key)).size);
is('...waiting counts both machines', 3, r.json && r.json.waiting);
is('...the hosts are named, this one first', 'laptop:self vm', ((r.json && r.json.hosts) || []).map(h => `${h.label}${h.self ? ':self' : ''}`).join(' '));
is('...and nothing is missing', 0, ((r.json && r.json.missing) || ['?']).length);

// ── one of the vm's runs, read through the laptop ─────────────────────────────────────
r = await pa.api(A.base, 'GET', '/api/shots/run?host=vm&profile=work&run=sign-in-flow');
is('a vm run is read through the laptop', 200, r.status);
is('...and it is the vm\'s run, not the laptop\'s of the same name', 'the vm sign-in', r.json && r.json.run && r.json.run.steps[0].name);
is('...labelled with its host', 'vm vm', r.json && r.json.run && `${r.json.run.host} ${r.json.run.host_key}`);
const tk = (r.json && r.json.media && r.json.media.ticket) || '';
is('...with a media ticket minted by the laptop', true, tk.length > 20);
r = await pa.api(A.base, 'GET', '/api/shots/run?host=nope&profile=work&run=sign-in-flow');
is('a host that is not paired names nothing', 404, r.status);

// ── the vm's video, ranged, through the laptop ────────────────────────────────────────
const mq = (host, run, file, k) => `/api/shots/media?${new URLSearchParams({ ...(host ? { host } : {}), profile: 'work', run, file, k })}`;
let m = await raw(A.base, mq('vm', 'sign-in-flow', 'flow.mp4', tk), { range: 'bytes=0-1' });
is('the iOS probe (bytes=0-1) on a vm video: 206', 206, m.status);
is('...with the vm\'s Content-Range', 'bytes 0-1/1000', m.headers['content-range']);
is('...and the vm\'s first two bytes', VID.b.subarray(0, 2).toString('hex'), m.body.toString('hex'));
m = await raw(A.base, mq('vm', 'sign-in-flow', 'flow.mp4', tk), { range: 'bytes=500-' });
is('a seek (bytes=500-): 206, the rest of the vm\'s file', '206 bytes 500-999/1000 500 same',
   `${m.status} ${m.headers['content-range']} ${m.headers['content-length']} ${m.body.equals(VID.b.subarray(500)) ? 'same' : 'differs'}`);
is('...served as video, rangeable', 'video/mp4 bytes', `${m.headers['content-type']} ${m.headers['accept-ranges']}`);
m = await raw(A.base, mq('vm', 'sign-in-flow', 'flow.mp4', tk), { range: 'bytes=2000-' });
is('a range past the end: the vm\'s 416, passed through', '416 bytes */1000', `${m.status} ${m.headers['content-range']}`);
m = await raw(A.base, mq('vm', 'sign-in-flow', 'flow.mp4', tk));
is('no range: 200 and the whole vm file', '200 same', `${m.status} ${m.body.equals(VID.b) ? 'same' : 'differs'}`);
m = await raw(A.base, mq('', 'sign-in-flow', 'flow.mp4', tk), { range: 'bytes=0-1' });
is('the vm run\'s ticket does not open the laptop\'s run of the same name', 401, m.status);
m = await raw(A.base, mq('vm', 'sign-in-flow', '../secret.mp4', tk));
is('traversal in the file name is refused', 403, m.status);
m = await raw(A.base, mq('vm', '..', 'secret.mp4', tk));
is('...and the ticket opens no other run name, `..` included', 401, m.status);

// ── a verdict, written on the vm ──────────────────────────────────────────────────────
const post = (p, body) => request(A.base, 'POST', p, { headers: { authorization: `Bearer ${pa.token}`, origin: A.base }, body });
r = await post('/api/shots/verdict', { host: 'vm', profile: 'work', run: 'sign-in-flow', flow: { v: 'approve', note: 'looks right' }, chapters: {} });
is('a verdict on a vm run is accepted', '200 approved', `${r.status} ${r.json && r.json.state && r.json.state.label}`);
const vOn = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h.shots, 'sign-in-flow', 'verdict.json'), 'utf8')); } catch { return null; } };
const flowOf = (h) => (((vOn(h) || {}).flow) || {}).v || null;
is('...it is in the VM\'s run dir, where its --check reads it', 'approve', flowOf(B));
is('...and not in the laptop\'s run of the same name', null, vOn(A));
r = await pa.api(A.base, 'GET', '/api/shots');
is('...and the vm\'s card turns green on the laptop\'s list', 'ok', (((r.json && r.json.groups) || []).find(g => g.host === 'vm' && g.branch === 'api-fix') || { latest: { state: {} } }).latest.state.cls);
const aV = audit(A).find(x => x.verb === 'shots_verdict') || {};
const bV = audit(B).find(x => x.verb === 'shots_verdict') || {};
is('the laptop audits the verdict it forwarded', 'phone proxy vm ran', `${aV.client} ${aV.via} ${aV.host} ${aV.result}`);
is('the vm audits the verdict it wrote, naming where it came from', 'laptop/phone pair laptop phone work/sign-in-flow ran',
   `${bV.client} ${bV.via} ${bV.origin_host} ${bV.origin_client} ${bV.subject} ${bV.result}`);
r = await post('/api/shots/verdict', { host: 'vm', profile: 'work', run: 'sign-in-flow', flow: { v: 'maybe' } });
is('the vm\'s own validation still applies: a bad verdict is its 400, never a 401/403', 400, r.status);
is('...and the vm\'s file is unchanged', 'approve', flowOf(B));

// ── only a signature opens the vm ─────────────────────────────────────────────────────
const signedAs = async (pid, secret, method, pathq, body, onBehalf = 'phone') => {
  const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(18).toString('base64url');
  const canon = ['ghostfleet-pair-v1', pid, method, pathq, String(ts), nonce, onBehalf || '-', crypto.createHash('sha256').update(data).digest('hex')].join('\n');
  const headers = { 'x-fleet-pair': pid, 'x-fleet-pair-ts': String(ts), 'x-fleet-pair-nonce': nonce,
                    'x-fleet-pair-sig': crypto.createHmac('sha256', secret).update(canon).digest('hex'), 'x-fleet-on-behalf': onBehalf };
  return { headers, res: await request(B.base, method, pathq, { headers, ...(body === undefined ? {} : { body }) }) };
};
const vBefore = JSON.stringify(vOn(B));
const reject = { profile: 'work', run: 'sign-in-flow', flow: { v: 'reject', note: 'forged' }, chapters: {} };
r = await request(B.base, 'POST', '/api/shots/verdict', { body: reject });
is('an unsigned verdict on the vm: refused', 401, r.status);
r = await request(B.base, 'GET', '/api/shots/media?profile=work&run=sign-in-flow&file=flow.mp4');
is('unsigned media on the vm without a ticket: refused', 401, r.status);
let s = await signedAs(crypto.randomBytes(18).toString('base64url'), crypto.randomBytes(32).toString('base64url'), 'POST', '/api/shots/verdict', reject);
is('a verdict signed by a host the vm never paired with: refused', 401, s.res.status);
s = await signedAs(lapOnB.id, 'x'.repeat(43), 'GET', '/api/shots/media?profile=work&run=sign-in-flow&file=flow.mp4');
is('vm media signed with the wrong secret: refused', 401, s.res.status);
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots');
is('the laptop\'s real signature lists the vm\'s own runs', '200 acme-api:api-fix toolbox:docs-pass',
   `${s.res.status} ${((s.res.json && s.res.json.groups) || []).map(g => `${g.project}:${g.branch}`).join(' ')}`);
is('...and never fans out again: no host on them, no hosts list', 'false false',
   `${((s.res.json && s.res.json.groups) || []).some(g => 'host' in g)} ${!!(s.res.json && 'hosts' in s.res.json)}`);
r = await request(B.base, 'GET', '/api/shots', { headers: s.headers });
is('the same signed request twice: refused', 401, r.status);
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots/run?host=laptop&profile=work&run=sign-in-flow');
is('a signed request naming yet another host: refused (one hop)', 403, s.res.status);
s = await signedAs(lapOnB.id, vmOnA.out, 'POST', '/api/shots/run', {});
is('a signed POST to a shots read: refused by the scope', 403, s.res.status);
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots/media?profile=work&run=sign-in-flow&file=../secret.mp4');
is('a signed media request still gets the vm\'s path checks', 403, s.res.status);
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots/media?profile=work&run=..&file=secret.mp4');
is('...and a run that is not a folder of the vm\'s runs', 404, s.res.status);
is('...and none of it wrote the vm\'s verdict', vBefore, JSON.stringify(vOn(B)));
const { pairAllows } = await import(path.join(RT, 'bin', 'fleet-serve.mjs'));
is('the scope, exactly: the three reads and the verdict cross, nothing else of shots', 'true true true true false false false',
   [pairAllows('GET', '/api/shots'), pairAllows('GET', '/api/shots/run'), pairAllows('GET', '/api/shots/media'),
    pairAllows('POST', '/api/shots/verdict', {}), pairAllows('GET', '/api/shots/verdict'), pairAllows('POST', '/api/shots', {}),
    pairAllows('POST', '/api/verb', { tool: 'shots_verdict' })].join(' '));

// ── a project the vm keeps from paired machines: its runs go with it ─────────────────
// billing-svc joins the vm with one run, and is hidden (`fleet-project set billing-svc pair
// hide`; its marker is written here directly, the command has its rows in pair-check). A
// second run belongs to a checkout of the same name that is no registered project, which
// carries only a name — and a name that is hidden anywhere fails closed. The laptop's list, a
// run read, its media and a verdict must each answer as a run the vm never had does, and the
// vm's own phone must still have both.
const bProj = path.join(B.home, '.config', 'ghostfleet', 'projects');
const bProjBefore = fs.readFileSync(bProj, 'utf8');
fs.mkdirSync(path.join(B.dir, 'billing-svc'), { recursive: true });
fs.appendFileSync(bProj, `billing-svc\t${path.join(B.dir, 'billing-svc')}\twork\n`);
fs.writeFileSync(path.join(B.home, '.claude', 'fleet', 'cf-billing-svc.pair'), 'hide\n');
write(path.join(B.shots, 'ledger-run'), recorded(prov('ledger-fix', '2026-03-07T09:00:00.000Z', path.join(B.dir, 'billing-svc')), 'the hidden ledger'), { 'flow.mp4': VID.b });
write(path.join(B.shots, 'ledger-copy'), recorded(prov('ledger-copy', '2026-03-08T09:00:00.000Z', path.join(B.dir, 'elsewhere', 'billing-svc')), 'the hidden copy'), { 'flow.mp4': VID.b });
const hiddenIn = (j) => /billing-svc|ledger/.test(JSON.stringify(j || {}));
const said = (x) => `${x.status} ${(x.json && x.json.text) || ''}`;
r = await pa.api(A.base, 'GET', '/api/shots');
is('hidden: the laptop\'s list has none of a hidden project\'s runs', 'vm:acme-api:api-fix laptop:acme-api:api-fix vm:toolbox:docs-pass', cards(r));
is('...and names neither the project nor its branches anywhere in it', false, hiddenIn(r.json));
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots');
is('...the vm\'s own signed answer leaves both runs out', '200 acme-api:api-fix toolbox:docs-pass false',
   `${s.res.status} ${((s.res.json && s.res.json.groups) || []).map(g => `${g.project}:${g.branch}`).join(' ')} ${hiddenIn(s.res.json)}`);
r = await pb.api(B.base, 'GET', '/api/shots');
is('...while the vm\'s own phone lists both', 'billing-svc:ledger-copy billing-svc:ledger-fix',
   ((r.json && r.json.groups) || []).filter(g => g.project === 'billing-svc').map(g => `${g.project}:${g.branch}`).sort().join(' '));
const runNope = await pa.api(A.base, 'GET', '/api/shots/run?host=vm&profile=work&run=no-such-run');
for (const run of ['ledger-run', 'ledger-copy']) {
  r = await pa.api(A.base, 'GET', `/api/shots/run?host=vm&profile=work&run=${run}`);
  is(`...reading ${run} from the laptop is reading a run the vm never had`, said(runNope), said(r));
}
const lr = await pb.api(B.base, 'GET', '/api/shots/run?profile=work&run=ledger-run');
is('...and the vm\'s own phone opens it', '200 the hidden ledger', `${lr.status} ${lr.json && lr.json.run && lr.json.run.steps[0].name}`);
const mNope = (await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots/media?profile=work&run=no-such-run&file=flow.mp4')).res;
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots/media?profile=work&run=ledger-run&file=flow.mp4');
is('...its video, asked for by signature, is a run that never was', said(mNope), said(s.res));
m = await raw(B.base, mq('', 'ledger-run', 'flow.mp4', (lr.json && lr.json.media && lr.json.media.ticket) || ''), { range: 'bytes=0-1' });
is('...and plays on the vm\'s own phone', `206 ${VID.b.subarray(0, 2).toString('hex')}`, `${m.status} ${m.body.toString('hex')}`);
const ledgerVerdict = () => fs.existsSync(path.join(B.shots, 'ledger-run', 'verdict.json'));
const vNope = await post('/api/shots/verdict', { host: 'vm', profile: 'work', run: 'no-such-run', flow: { v: 'approve' }, chapters: {} });
r = await post('/api/shots/verdict', { host: 'vm', profile: 'work', run: 'ledger-run', flow: { v: 'approve' }, chapters: {} });
is('...a verdict on it from the laptop is a verdict on a run that never was', said(vNope), said(r));
const sNope = (await signedAs(lapOnB.id, vmOnA.out, 'POST', '/api/shots/verdict', { profile: 'work', run: 'no-such-run', flow: { v: 'approve' }, chapters: {} })).res;
s = await signedAs(lapOnB.id, vmOnA.out, 'POST', '/api/shots/verdict', { profile: 'work', run: 'ledger-run', flow: { v: 'approve' }, chapters: {} });
is('...and signed straight to the vm', said(sNope), said(s.res));
is('...none of which wrote a verdict there', false, ledgerVerdict());
r = await pb.api(B.base, 'POST', '/api/shots/verdict', { profile: 'work', run: 'ledger-run', flow: { v: 'approve' }, chapters: {} });
is('...while the vm\'s own phone gives it one', '200 true', `${r.status} ${ledgerVerdict()}`);
// Back to the vm the rest of this file expects.
fs.writeFileSync(bProj, bProjBefore);
for (const run of ['ledger-run', 'ledger-copy']) fs.rmSync(path.join(B.shots, run), { recursive: true, force: true });

// ── a vm with Reviews off contributes nothing ─────────────────────────────────────────
B.switchTo('off');
s = await signedAs(lapOnB.id, vmOnA.out, 'GET', '/api/shots');
is('vm off: its shots routes answer a paired host 404 disabled', '404 true', `${s.res.status} ${!!(s.res.json && s.res.json.disabled)}`);
r = await pa.api(A.base, 'GET', '/api/shots');
is('vm off: the laptop lists only its own runs', 'laptop:acme-api:api-fix', cards(r));
is('...and no line about the vm — off is a choice, not an outage', 0, ((r.json && r.json.missing) || ['?']).length);
r = await pa.api(A.base, 'GET', '/api/shots/run?host=vm&profile=work&run=sign-in-flow');
is('vm off: a vm run read is a 404, never a 401/403', 404, r.status);
r = await post('/api/shots/verdict', { host: 'vm', profile: 'work', run: 'sign-in-flow', flow: { v: 'reject' }, chapters: {} });
is('vm off: a verdict is refused and nothing is written there', `404 ${vBefore}`, `${r.status} ${JSON.stringify(vOn(B))}`);
B.switchTo('on');

// ── the laptop with Reviews off shows none, whatever the vm has ───────────────────────
A.switchTo('off');
r = await pa.api(A.base, 'GET', '/api/shots');
is('laptop off: no Reviews at all, though the vm\'s are on', '404 true', `${r.status} ${!!(r.json && r.json.disabled)}`);
m = await raw(A.base, mq('vm', 'sign-in-flow', 'flow.mp4', tk), { range: 'bytes=0-1' });
is('laptop off: the vm\'s media is not proxied either', 404, m.status);
A.switchTo('on');

// ── a vm that does not answer ─────────────────────────────────────────────────────────
// SILENT FIRST: a socket that accepts and never says a word, which is what a sleeping or
// wedged machine looks like — refused is the easy case. The list must come back inside the
// fan-out's timeout with the laptop's runs.
const hole = net.createServer(() => {}); holes.push(hole);
await new Promise(res => hole.listen(0, '127.0.0.1', res));
const pp = readJson(A.peers); const realUrl = pp.peers[0].url;
pp.peers[0].url = `http://localhost:${hole.address().port}`;
fs.writeFileSync(A.peers, JSON.stringify(pp, null, 2), { mode: 0o600 });
let t0 = Date.now();
r = await pa.api(A.base, 'GET', '/api/shots');
const took = Date.now() - t0;
is('a silent vm: the list still answers, inside the fan-out timeout', 'yes', r.status === 200 && took < 7500 ? 'yes' : `status ${r.status} in ${took}ms`);
is('...with the laptop\'s runs intact', 'laptop:acme-api:api-fix', cards(r));
is('...and one entry saying the vm is missing', 'vm:did not answer', ((r.json && r.json.missing) || []).map(x => `${x.host}:${x.why}`).join(' '));
pp.peers[0].url = realUrl;
fs.writeFileSync(A.peers, JSON.stringify(pp, null, 2), { mode: 0o600 });
// ...then GONE: the vm's daemon killed. The poll skips a host that just failed for a few
// seconds, so this is asked once that window has passed, of a host that is really down.
await stop(B);
await sleep(10500);
t0 = Date.now();
r = await pa.api(A.base, 'GET', '/api/shots');
is('a vm that is down: 200 at once, the laptop\'s runs, the vm named missing',
   '200 fast laptop:acme-api:api-fix vm:did not answer',
   `${r.status} ${Date.now() - t0 < 3000 ? 'fast' : 'slow'} ${cards(r)} ${((r.json && r.json.missing) || []).map(x => `${x.host}:${x.why}`).join(' ')}`);
r = await pa.api(A.base, 'GET', '/api/shots/run?host=vm&profile=work&run=sign-in-flow');
is('...opening one of its runs is a 502 that says so, never a 401/403', '502 true', `${r.status} ${!!(r.json && r.json.offline)}`);
r = await pa.api(A.base, 'GET', '/api/projects');
is('...and the phone is still signed in to the laptop', 200, r.status);

finish(0);
