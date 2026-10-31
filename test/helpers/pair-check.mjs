#!/usr/bin/env node
// pair-check — two fleet-serves on loopback, paired, driven the way a phone drives one.
//
//     node test/helpers/pair-check.mjs [root]     # "name <US> want <US> got" rows
//
// `root` is a checkout whose bin/, mcp/, lib/ and mods/ are run; it defaults to this one.
// Pointing it at a `git archive` of staging is how every row was watched red: that daemon
// has no `pair`, no proxy and no merge, so each row about them fails there for its own
// reason rather than because the harness broke.
//
// TWO HOSTS, EACH ITS OWN WORLD: its own HOME, its own serve.json, audit log and port, its
// own projects (one name, acme-api, on BOTH — the collision the `@host` address exists to
// survive), and its own record of which fleet commands ran. The fleet commands are stubs
// that write their argv and the project scope into that host's file, so "the send ran on
// the VM, and only there" is a line in one file and its absence from the other.
//
// The daemons are this script's children, killed by the pids it captured — never by
// pattern — and titled the way the suite's orphan sweep recognises, so a killed run's
// leftovers are still found.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'pair-check.'));
function finish(code = 0) {
  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch {} }
  console.log(rows.join('\n'));
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => { console.error(String(e && e.stack || e)); finish(1); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ── one runtime, both hosts ─────────────────────────────────────────────────────────
const RT = path.join(T, 'rt');
for (const d of ['bin', 'mcp', 'lib']) fs.cpSync(path.join(SRC, d), path.join(RT, d), { recursive: true });
fs.mkdirSync(path.join(RT, 'mods', 'ghostfleet'), { recursive: true });
fs.cpSync(path.join(SRC, 'mods', 'ghostfleet', 'hooks'), path.join(RT, 'mods', 'ghostfleet', 'hooks'), { recursive: true });
const stub = `#!/bin/sh
printf '%s' "$(basename "$0")" >> "$MH_RAN"
for a in "$@"; do printf ' [%s]' "$a" >> "$MH_RAN"; done
printf ' {scope=%s root=%s}\\n' "\${CLAUDE_FLEET_SCOPE:-}" "\${CLAUDE_FLEET_ROOT:-}" >> "$MH_RAN"
echo "STUB $(basename "$0") ok"
`;
for (const c of ['fleet-send', 'fleet-hibernate', 'fleet-pause', 'fleet-resume', 'fleet-spawn', 'fleet-stop',
                 'fleet-rename', 'fleet-list', 'fleet-inbox', 'fleet-worktrees', 'fleet-answer', 'fleet-clean']) {
  fs.writeFileSync(path.join(RT, 'bin', c), stub, { mode: 0o755 });
}
// The grid: §4's shape, naming the project it was asked about from the env the daemon set.
fs.writeFileSync(path.join(RT, 'bin', 'fleet-grid.mjs'), `#!/usr/bin/env node
const scope = process.env.CLAUDE_FLEET_SCOPE || '';
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ project: scope, profile: process.env.CLAUDE_FLEET_PROFILE || '', sock: process.env.CLAUDE_FLEET_SOCK || '',
    counts: { need_you: 0, working: 1, ready: 0, parked: 0, limit: 0, interrupted: 0 },
    cards: [{ name: 'w1', label: null, status: 'working', folder: 'w1', branch: 'feat/' + scope, agent: 'claude', msg: 'on ' + process.env.MH_HOST, age: 5, attached: false, sched: null, limit_at: null }],
    free_worktrees: [] }) + '\\n', () => process.exit(0));
} else if (process.argv.includes('--checkouts')) { process.stdout.write('{"roots":[],"checkouts":[]}\\n', () => process.exit(0)); }
else { process.stderr.write('stub grid: refusing to be interactive\\n'); process.exit(2); }
`, { mode: 0o755 });
fs.writeFileSync(path.join(RT, 'bin', 'fleet-read'), `#!/usr/bin/env node
const all = [{ ts: 1700000000, role: 'user', text: 'hello from ' + process.env.MH_HOST }];
process.stdout.write(JSON.stringify({ session: 'w1', total: 1, window_truncated: false, messages: all, next_before: null }) + '\\n');
`, { mode: 0o755 });

// ── the two hosts ───────────────────────────────────────────────────────────────────
// a: the laptop — acme-api (work) and scratch (personal). b: the VM — acme-api and toolbox.
const now = Date.now();
async function host(id, projects) {
  const dir = path.join(T, id), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'ghostfleet'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'fleet'), { recursive: true });
  const lines = [];
  for (const [name, prof] of projects) { fs.mkdirSync(path.join(dir, name), { recursive: true }); lines.push(`${name}\t${path.join(dir, name)}\t${prof}`); }
  fs.writeFileSync(path.join(home, '.config', 'ghostfleet', 'projects'), lines.join('\n') + '\n');
  const port = await freePort();
  const h = { id, dir, home, port, base: `http://localhost:${port}`, ran: path.join(dir, 'ran'), log: path.join(dir, 'log'),
              cfg: path.join(dir, 'serve.json'), audit: path.join(dir, 'audit.jsonl'), peers: path.join(dir, 'serve-peers.json') };
  h.env = { ...process.env, HOME: home, TMUX: '', CLAUDE_FLEET_AWAKE: 'off', GHOSTFLEET_SERVE_CONFIG: h.cfg,
            GHOSTFLEET_SERVE_AUDIT: h.audit, MH_RAN: h.ran, MH_HOST: id };
  delete h.env.CLAUDE_FLEET_DIR; delete h.env.CLAUDE_CONFIG_DIR; delete h.env.CLAUDE_FLEET_SOCK;
  fs.writeFileSync(h.ran, '');
  h.cli = (...args) => { try { return { code: 0, out: execFileSync('node', [path.join(RT, 'bin', 'fleet-serve.mjs'), ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                          catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  h.cli('init', '--bind', '127.0.0.1', '--port', String(port));
  const c = JSON.parse(fs.readFileSync(h.cfg, 'utf8'));
  c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(h.cfg, JSON.stringify(c, null, 2));
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
// A master holding one item for the owner, on that host's work fleet dir.
function plantWaiting(h, sock, sid, text) {
  const fd = path.join(h.home, '.claude', 'fleet');
  fs.writeFileSync(path.join(fd, `${sid}.json`), JSON.stringify({ session_id: sid, sock, slot: 'master', status: 'ready', ts: Math.floor(now / 1000) }) + '\n');
  fs.writeFileSync(path.join(fd, `${sid}.ledger`), JSON.stringify({ v: 1, seq: 2, items: [
    { id: '1', text, at: now - 3 * 3600e3, state: 'waiting', source: 'user', progress: { at: now - 2 * 3600e3, reason: 'waits on the person: pick one' } }] }));
}

const A = await host('a', [['acme-api', 'work'], ['scratch', 'personal']]);
const B = await host('b', [['acme-api', 'work'], ['toolbox', 'work']]);
plantWaiting(A, 'cf-acme-api', 'mh-a-master', 'the laptop ask');
plantWaiting(B, 'cf-toolbox', 'mh-b-master', 'the vm ask');
const code = (h) => (h.cli('enroll', 'phone').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
const ca = code(A), cb = code(B);
if (!(await start(A)) || !(await start(B))) {
  is('both daemons come up', 'up', `down: ${fs.readFileSync(A.log, 'utf8').slice(0, 200)} | ${fs.readFileSync(B.log, 'utf8').slice(0, 200)}`);
  finish(1);
}
const pa = new Authenticator({ rpId: 'localhost', origin: A.base });
const pb = new Authenticator({ rpId: 'localhost', origin: B.base });
await pa.enroll(A.base, ca);
await pb.enroll(B.base, cb);
const names = (r) => ((r.json && r.json.projects) || []).map(p => p.name).sort().join(' ');
const ranLines = (h, re) => fs.readFileSync(h.ran, 'utf8').split('\n').filter(l => re.test(l));

// ── before pairing: nothing changes for a machine on its own ────────────────────────
let r = await pa.api(A.base, 'GET', '/api/projects');
is('unpaired: the laptop lists its own projects only', 'acme-api scratch', names(r));
is('unpaired: no host field is added to any row', false, ((r.json && r.json.projects) || []).some(p => 'host' in p));
is('unpaired: no hosts list', false, !!(r.json && 'hosts' in r.json));
r = await pa.api(A.base, 'GET', '/api/grid?project=toolbox@vm');
is('unpaired: an @address names nothing', 404, r.status);

// ── pairing ─────────────────────────────────────────────────────────────────────────
// Plain http to a machine that is not this one is refused before anything is sent.
let c = B.cli('pair', 'http://vm.example.test:8787', 'ABCDE-FGHJK');
is('pairing over plain http to another machine is refused', 'refused',
   c.code !== 0 && /plain http is refused/.test(c.out) ? 'refused' : `code ${c.code}: ${c.out.slice(0, 160)}`);
c = B.cli('pair', A.base, 'ABCDE-FGHJK');
is('joining with no pairing open is refused', 'refused', c.code !== 0 && /no pairing is open/.test(c.out) ? 'refused' : `code ${c.code}: ${c.out.slice(0, 160)}`);
c = A.cli('pair', '--as', 'laptop');
const pcode = (c.out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
is('`fleet-serve pair` prints a one-time code', true, !!pcode);
c = B.cli('pair', A.base, 'ZZZZZ-ZZZZZ', '--as', 'vm');
is('a wrong code is refused', 'refused', c.code !== 0 && /wrong or missing pairing code/.test(c.out) ? 'refused' : `code ${c.code}: ${c.out.slice(0, 160)}`);
// The host that printed the code also refuses a joiner that advertises a plain-http URL
// back to itself from anywhere but loopback.
r = await request(A.base, 'POST', '/api/pair/accept', { body: { code: pcode, id: crypto.randomBytes(18).toString('base64url'), label: 'evil', url: 'http://evil.example.test', secret: 'x'.repeat(43) } });
is('...and a joiner whose own URL is plain http elsewhere', 400, r.status);
c = B.cli('pair', A.base, pcode, '--as', 'vm');
is('the right code pairs the two', 0, c.code);
is('...and names the other side', true, /paired with 'laptop'/.test(c.out));
c = B.cli('pair', A.base, pcode, '--as', 'vm');
is('the code works once', 'refused', c.code !== 0 && /no pairing is open/.test(c.out) ? 'refused' : `code ${c.code}: ${c.out.slice(0, 160)}`);

// The credential: stored at 0600, on both sides, and never written anywhere else.
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const pairsOn = (h) => (readJson(h.peers).peers || []).length;
const mode = (f) => { try { return (fs.statSync(f).mode & 0o777).toString(8); } catch { return 'missing'; } };
is('the laptop stores the pairing at 0600', '600', mode(A.peers));
is('the vm stores the pairing at 0600', '600', mode(B.peers));
const vmOnA = (readJson(A.peers).peers || [])[0] || {}, lapOnB = (readJson(B.peers).peers || [])[0] || {};
is('each side holds the other\'s half: laptop signs with what the vm verifies', true, !!vmOnA.out && vmOnA.out === lapOnB.in);
is('...and the other way round, with a different secret', true, !!lapOnB.out && lapOnB.out === vmOnA.in && vmOnA.in !== vmOnA.out);
is('the laptop calls the vm by its key', 'vm', vmOnA.key);

// ── one app, both machines ──────────────────────────────────────────────────────────
r = await pa.api(A.base, 'GET', '/api/projects');
is('from the laptop: both machines\' projects', 'acme-api acme-api@vm scratch toolbox@vm', names(r));
const row = (r, n) => ((r.json && r.json.projects) || []).find(p => p.name === n) || {};
is('...each row says which host it is on', 'laptop laptop vm vm',
   ['acme-api', 'scratch', 'acme-api@vm', 'toolbox@vm'].map(n => row(r, n).host).join(' '));
is('...this host\'s rows come first, so their digits do not move', 'acme-api scratch',
   ((r.json && r.json.projects) || []).slice(0, 2).map(p => p.name).join(' '));
is('...the vm\'s rollup comes through', 1, row(r, 'toolbox@vm').sessions && row(r, 'toolbox@vm').sessions.total);
is('...and the hosts list has both, the vm online', 'laptop:self vm:true',
   ((r.json && r.json.hosts) || []).map(x => `${x.label}:${x.self ? 'self' : x.online}`).join(' '));
r = await pb.api(B.base, 'GET', '/api/projects');
is('from the vm: the same, the other way round', 'acme-api acme-api@laptop scratch@laptop toolbox', names(r));
is('...the laptop\'s personal profile kept', 'personal', row(r, 'scratch@laptop').profile);

r = await pa.api(A.base, 'GET', '/api/grid?project=toolbox@vm');
is('a remote grid is served through the home host', 200, r.status);
is('...naming the project by the address it was asked with', 'toolbox@vm', r.json && r.json.project);
is('...and the host', 'vm', r.json && r.json.host);
is('...and it is the vm\'s grid, not the laptop\'s', 'on b', r.json && r.json.cards && r.json.cards[0].msg);
r = await pa.api(A.base, 'GET', '/api/grid?project=acme-api@vm');
is('the same NAME on both hosts is two projects', 'on b', r.json && r.json.cards && r.json.cards[0].msg);
r = await pa.api(A.base, 'GET', '/api/grid?project=acme-api');
is('...and the bare name is still this host\'s', 'on a', r.json && r.json.cards && r.json.cards[0].msg);
r = await pa.api(A.base, 'GET', '/api/session?project=toolbox@vm&session=w1');
is('a remote conversation is read', 'hello from b', r.json && r.json.messages && r.json.messages[0].text);

const sentBefore = ranLines(A, /^fleet-send/).length;
r = await pa.verb(A.base, 'fleet_send', { project: 'toolbox@vm', session: 'w1', prompt: 'hello from the laptop' });
is('a send to a remote session is accepted', 200, r.status);
is('...and ran on the vm, in its toolbox fleet', 1, ranLines(B, /^fleet-send .*hello from the laptop.*scope=toolbox root=.*\/b\/toolbox/).length);
// acme-api is on BOTH machines, so this is the send that could land on the wrong one.
r = await pa.verb(A.base, 'fleet_send', { project: 'acme-api@vm', session: 'w1', prompt: 'to the vm acme-api' });
is('a send to acme-api@vm ran on the vm\'s acme-api', 1, ranLines(B, /^fleet-send .*to the vm acme-api.*scope=acme-api root=.*\/b\/acme-api/).length);
is('...and not on the laptop, which has an acme-api too', sentBefore, ranLines(A, /^fleet-send/).length);
r = await pa.verb(A.base, 'fleet_wake', { project: 'acme-api@vm', session: 'w1' });
is('a remote session is woken', 200, r.status);
is('...on the vm\'s acme-api, not the laptop\'s', 1, ranLines(B, /^fleet-hibernate .*\[--wake\] \[w1\].*scope=acme-api root=.*\/b\/acme-api/).length);
is('...and the laptop woke nothing', 0, ranLines(A, /^fleet-hibernate/).length);
r = await pa.verb(A.base, 'fleet_pause', { project: 'toolbox@vm', session: 'w1' });
is('park crosses', 200, r.status);
r = await pa.verb(A.base, 'fleet_resume', { project: 'toolbox@vm', session: 'w1' });
is('resume crosses', 200, r.status);

// What does NOT cross, refused on the home host with the reason, and nothing run anywhere.
r = await pa.verb(A.base, 'fleet_stop', { project: 'toolbox@vm', session: 'w1' }, await pa.fresh(A.base, 'stop'));
// 400 and never 403: the client reads a 403 as a dead session and locks the app.
is('a passkey verb does not cross', 400, r.status);
is('...and says a passkey only works where it was made', true, /passkey only works on the host it was made on/.test(r.text));
is('...and nothing was stopped on either host', 0, ranLines(A, /^fleet-stop/).length + ranLines(B, /^fleet-stop/).length);
r = await pa.api(A.base, 'POST', '/api/term/open', { project: 'toolbox@vm', cols: 80, rows: 24 }, { headers: { 'x-fleet-assertion': JSON.stringify(await pa.fresh(A.base, 'terminal')) } });
// remote:true — refused BECAUSE the project is on another machine, not because this
// device's terminal happens to be off (which would also be a 403).
is('the terminal does not cross', '403 remote', `${r.status} ${r.json && r.json.remote ? 'remote' : 'local'}`);
is('...and says why, in one line', true, r.json && /terminal never crosses machines/.test(r.json.text) && !/\n/.test(r.json.text));
r = await pa.api(A.base, 'GET', '/api/checkouts?project=toolbox@vm');
is('a read outside the scope does not cross', 400, r.status);

r = await pa.api(A.base, 'GET', '/api/waiting');
const items = ((r.json && r.json.items) || []).map(i => `${i.project}:${i.host}:${i.text}`).sort().join(' | ');
is('the queue is merged: each master\'s item, with its host', 'acme-api:laptop:the laptop ask | toolbox@vm:vm:the vm ask', items);
r = await pa.api(A.base, 'GET', '/api/usage');
is('usage is merged without failing on a host whose accounts are off', 200, r.status);

// Both audit logs: the laptop records that it forwarded, the vm that it ran, each naming the
// originating host and client.
const audit = (h) => { try { return fs.readFileSync(h.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const aSend = audit(A).find(x => x.verb === 'fleet_send') || {};
const bSend = audit(B).find(x => x.verb === 'fleet_send') || {};
is('the laptop audits the send it forwarded', 'phone proxy vm toolbox@vm ran', `${aSend.client} ${aSend.via} ${aSend.host} ${aSend.project} ${aSend.result}`);
is('the vm audits the send it ran, naming where it came from', 'laptop/phone pair laptop phone toolbox ran',
   `${bSend.client} ${bSend.via} ${bSend.origin_host} ${bSend.origin_client} ${bSend.project} ${bSend.result}`);
is('both chains still verify', 'ok ok', [A, B].map(h => /chain intact/.test(h.cli('audit', '--verify').out) ? 'ok' : 'broken').join(' '));
// No secret ever reaches a log, an audit row or a URL.
const secrets = [vmOnA.out, vmOnA.in];
const leaks = [A.log, B.log, A.audit, B.audit].filter(f => { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch {} return secrets.some(s => s && t.includes(s)); });
is('no pairing secret appears in either log or either audit', '', leaks.map(f => path.basename(path.dirname(f)) + '/' + path.basename(f)).join(' '));

// A label is chosen at pairing and can be changed on either side; the address never moves.
r = await pa.api(A.base, 'POST', '/api/pairs/label', { host: 'vm', label: 'cloud box' });
is('a machine can be renamed from the phone', 200, r.status);
r = await pa.api(A.base, 'GET', '/api/projects');
is('...its rows carry the new label, at the same address', 'cloud box', row(r, 'toolbox@vm').host);
c = A.cli('relabel', 'cloud box', 'vm');
r = await pa.api(A.base, 'GET', '/api/projects');
is('...and it can be renamed back from the terminal', 'vm', c.code === 0 ? row(r, 'toolbox@vm').host : `code ${c.code}: ${c.out.slice(0, 120)}`);

// ── identity: only a signature makes one ─────────────────────────────────────────────
r = await pb.api(B.base, 'GET', '/api/projects', undefined, { headers: { 'x-fleet-on-behalf': 'someone-else' } });
is('an identity header on a phone\'s own token is refused', 403, r.status);
const signed = async (secret, method, pathq, body, onBehalf = 'phone', tamper = {}) => {
  const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(18).toString('base64url');
  const canon = ['ghostfleet-pair-v1', lapOnB.id || '-', method, pathq, String(ts), nonce, onBehalf || '-',
                 crypto.createHash('sha256').update(data).digest('hex')].join('\n');
  const h = { 'x-fleet-pair': lapOnB.id || '-', 'x-fleet-pair-ts': String(ts), 'x-fleet-pair-nonce': nonce,
              'x-fleet-pair-sig': crypto.createHmac('sha256', secret || '-').update(canon).digest('hex'), 'x-fleet-on-behalf': onBehalf, ...tamper };
  const opts = { headers: h };
  if (body !== undefined) opts.body = body;
  return { headers: h, res: await request(B.base, method, pathq, opts) };
};
let s = await signed(vmOnA.out, 'GET', '/api/projects');
is('a correctly signed request is served', 200, s.res.status);
is('...and a paired request never fans out again', 'acme-api toolbox', names(s.res));
r = await request(B.base, 'GET', '/api/projects', { headers: s.headers });
is('the same signed request twice: refused', 401, r.status);
s = await signed('x'.repeat(43), 'GET', '/api/projects');
is('a request signed with the wrong secret: refused', 401, s.res.status);
s = await signed(vmOnA.out, 'GET', '/api/projects', undefined, 'phone', { 'x-fleet-on-behalf': 'someone-else' });
is('a forged on-behalf name under a real signature: refused', 401, s.res.status);
s = await signed(vmOnA.in, 'GET', '/api/projects');
is('a signature reflected with the other direction\'s secret: refused', 401, s.res.status);
s = await signed(vmOnA.out, 'GET', '/api/audit');
is('a signed request outside the scope: refused', 403, s.res.status);
s = await signed(vmOnA.out, 'POST', '/api/verb', { tool: 'fleet_spawn', args: { project: 'toolbox', name: 'x' } });
is('a signed spawn: refused', 403, s.res.status);
s = await signed(vmOnA.out, 'GET', '/api/grid?project=toolbox@laptop');
is('a signed request naming yet another host: refused, never forwarded', 403, s.res.status);
is('...and none of it ran a spawn anywhere', 0, ranLines(B, /^fleet-spawn/).length + ranLines(A, /^fleet-spawn/).length);

// ── a host that is down stays visible ───────────────────────────────────────────────
await stop(B);
r = await pa.api(A.base, 'GET', '/api/projects');
const vmRow = ((r.json && r.json.hosts) || []).find(x => x.label === 'vm') || {};
is('with the vm down, the laptop still answers', 200, r.status);
is('...the vm is listed offline, not missing', false, vmRow.online);
is('...with when it was last seen', true, Number(vmRow.last_seen) > 0 && /ago|just now/.test(String(vmRow.last_seen_ago)));
is('...and its projects are not drawn as if they were there', 'acme-api scratch', names(r));
r = await pa.api(A.base, 'GET', '/api/grid?project=toolbox@vm');
is('opening one of its projects says offline · last seen', true, r.status === 502 && /vm is offline .*· last seen/.test(r.json && r.json.text));
r = await pa.verb(A.base, 'fleet_send', { project: 'toolbox@vm', session: 'w1', prompt: 'into the void' });
is('a send to the down host fails loudly', 502, r.status);
is('...and is audited as unreachable', 'unreachable', (audit(A).filter(x => x.verb === 'fleet_send').pop() || {}).result);
await start(B);
// BACK, AND SEEN TO BE BACK, before anything below reads the list: a host that just failed
// is skipped by the poll for a few seconds, so an unpair asserted inside that window would
// pass on a list that was short for a different reason.
let back = false;
for (let i = 0; i < 40 && !back; i++) {
  r = await pa.api(A.base, 'GET', '/api/projects');
  back = (((r.json && r.json.hosts) || []).find(x => x.label === 'vm') || {}).online === true && /toolbox@vm/.test(names(r));
  if (!back) await sleep(500);
}
is('when the vm comes back, the laptop lists it online with its projects again', true, back);

// ── unpair, from either side, on both ───────────────────────────────────────────────
c = A.cli('unpair', 'vm');
is('`fleet-serve unpair` revokes on both sides', true, c.code === 0 && /here and there/.test(c.out));
is('...the laptop has no pairing left', 0, pairsOn(A));
is('...nor the vm', 0, pairsOn(B));
r = await pa.api(A.base, 'GET', '/api/projects');
is('the laptop lists its own projects again', 'acme-api scratch', names(r));
is('...with no hosts list', false, !!(r.json && 'hosts' in r.json));
r = await pb.api(B.base, 'GET', '/api/projects');
is('the vm lists its own projects again', 'acme-api toolbox', names(r));
s = await signed(vmOnA.out, 'GET', '/api/projects');
is('the old credential no longer opens the vm', 401, s.res.status);
is('both audit logs record the unpair', 'yes yes', [A, B].map(h => audit(h).some(x => x.verb === 'unpair') ? 'yes' : 'no').join(' '));

// Pair again, then unpair from the phone's settings with the other side asleep: it is gone
// here regardless, and the sleeping side's credential stops working here at once.
c = A.cli('pair', '--as', 'laptop');
B.cli('pair', A.base, (c.out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0], '--as', 'vm');
// The vm forgets the laptop without telling it (an unpair whose notice never arrived).
const bp = readJson(B.peers); bp.peers = []; fs.writeFileSync(B.peers, JSON.stringify(bp), { mode: 0o600 });
r = await pa.api(A.base, 'GET', '/api/grid?project=toolbox@vm');
is('a pairing the other side dropped: a 502 that says so, never a 401 that locks the phone', '502 yes',
   `${r.status} ${r.json && /no longer accepts/.test(r.json.text) ? 'yes' : 'no'}`);
r = await pa.api(A.base, 'GET', '/api/projects');
is('...and the phone is still signed in to the laptop', 200, r.status);
await stop(B);
r = await pa.api(A.base, 'POST', '/api/pairs/unpair', { host: 'vm' });
is('unpair from settings with the other host asleep: done here anyway', true, r.status === 200 && r.json && r.json.told === false);
is('...and gone from this side', 0, pairsOn(A));

finish(0);
