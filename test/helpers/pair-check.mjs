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
import zlib from 'node:zlib';
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
// The panes below are real tmux servers, and they live under the run's own dir: never the
// default one, where a live fleet's servers are.
if (!process.env.TMUX_TMPDIR) { process.env.TMUX_TMPDIR = path.join(T, 'tx'); fs.mkdirSync(process.env.TMUX_TMPDIR, { mode: 0o700 }); }
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
# A send TYPES into the session's pane when the fleet has one, as the real one does, so a send
# that must not happen is asserted on the pane and not only on this file. Its arguments end in
# \`-- <session> <prompt>\`; with no server on that socket it types nothing anywhere.
if [ "$(basename "$0")" = fleet-send ] && [ -n "\${CLAUDE_FLEET_SOCK:-}" ]; then
  while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
  [ "\${1:-}" = -- ] && shift
  [ $# -ge 2 ] && tmux -L "$CLAUDE_FLEET_SOCK" has-session -t "=$1" 2>/dev/null && tmux -L "$CLAUDE_FLEET_SOCK" send-keys -t "$1" -l "$2"
fi
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
  fs.writeFileSync(path.join(home, '.config/ghostfleet/local-trust'), 'off\n');
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
function plantWaiting(h, sock, sid, text, fd = path.join(h.home, '.claude', 'fleet')) {
  fs.writeFileSync(path.join(fd, `${sid}.json`), JSON.stringify({ session_id: sid, sock, slot: 'master', status: 'ready', ts: Math.floor(now / 1000) }) + '\n');
  fs.writeFileSync(path.join(fd, `${sid}.ledger`), JSON.stringify({ v: 1, seq: 2, items: [
    { id: '1', text, at: now - 3 * 3600e3, state: 'waiting', source: 'user', progress: { at: now - 2 * 3600e3, reason: 'waits on the person: pick one' } }] }));
}

const A = await host('a', [['acme-api', 'work'], ['scratch', 'personal']]);
const B = await host('b', [['acme-api', 'work'], ['toolbox', 'work']]);
plantWaiting(A, 'cf-acme-api', 'mh-a-master', 'the laptop ask');
plantWaiting(B, 'cf-toolbox', 'mh-b-master', 'the vm ask');
// WHETHER SOMEONE IS AT A KEYBOARD is injected on both, the way the push group injects it:
// the VM says someone typed there 7s ago, the laptop has no reading at all (a missing file is
// what a Linux host without HID looks like). Neither then reads the keyboard of the machine
// running this.
fs.writeFileSync(path.join(T, 'b-atmac.json'), '{"idle":7,"locked":false}');
B.env.GHOSTFLEET_AT_MAC_FILE = path.join(T, 'b-atmac.json');
A.env.GHOSTFLEET_AT_MAC_FILE = path.join(T, 'a-atmac-none.json');
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
const audit = (h) => { try { return fs.readFileSync(h.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
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

// ── a photo crosses where a send does ───────────────────────────────────────────────
// One app drives both machines, so a photo for acme-api@vm has to land on the VM: the session
// that reads it runs there, and a laptop path would name nothing on that disk. The laptop
// forwards, the vm stores and answers with ITS path, and the send after it carries that path.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const attachRoot = (h) => path.join(h.home, '.claude', 'fleet', 'attach');
const filesUnder = (d) => { try { return fs.readdirSync(d, { recursive: true }).filter(n => fs.statSync(path.join(d, n)).isFile()); } catch { return []; } };
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'acme-api@vm', session: 'w1', data: PNG });
const vmPath = String((r.json && r.json.path) || '');
is('a photo for a remote session is stored', 201, r.status);
is('...on the vm, under its own attach dir', true, vmPath.startsWith(attachRoot(B) + path.sep) && fs.existsSync(vmPath));
is('...and the path handed back is the vm\'s, unchanged', true, !!vmPath && !vmPath.startsWith(A.home));
is('...byte for byte what the phone sent', true, fs.existsSync(vmPath) && fs.readFileSync(vmPath).equals(Buffer.from(PNG, 'base64')));
is('...and nothing was written on the laptop', 0, filesUnder(attachRoot(A)).length);
is('...the answer says which machine holds it', 'vm', r.json && r.json.host);
// The send after it names that path, and it is the vm's acme-api that gets it.
r = await pa.verb(A.base, 'fleet_send', { project: 'acme-api@vm', session: 'w1', prompt: `${vmPath} what is on this screen?` });
is('the send carrying the photo\'s path reaches the vm\'s session', 1,
   vmPath ? ranLines(B, new RegExp(`^fleet-send .*\\[w1\\].*${vmPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} what is on this screen.*scope=acme-api root=.*/b/acme-api`)).length : 0);
is('...and not the laptop\'s', 0, vmPath ? ranLines(A, new RegExp(vmPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length : -1);
// Bigger than the 1 MB every other signed POST is held to: a real 800x600 PNG, stored
// uncompressed, so the pair's body cap has to be the photo cap for it to arrive at all.
const bigPng = (() => {
  const w = 800, h = 600, rowsB = Buffer.alloc((w * 3 + 1) * h);
  crypto.randomFillSync(rowsB); for (let y = 0; y < h; y++) rowsB[y * (w * 3 + 1)] = 0;
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rowsB, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
})();
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'acme-api@vm', session: 'w1', data: bigPng.toString('base64') });
is('a photo over 1 MB crosses too', '201 on the vm',
   `${r.status} ${r.json && String(r.json.path || '').startsWith(attachRoot(B) + path.sep) && fs.existsSync(r.json.path) ? 'on the vm' : (r.json && r.json.text || '').slice(0, 120)}`);
// What the vm refuses for itself still comes back refused, with its own reason.
const vmFiles = filesUnder(attachRoot(B)).length;
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'acme-api@vm', session: 'w1',
                 data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64') });
is('an SVG for a remote session is refused by the vm', '415 SVG', `${r.status} ${r.json && /SVG is refused/.test(r.json.text) ? 'SVG' : (r.json && r.json.text)}`);
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'acme-api@vm', session: '../w1', data: PNG });
is('...and so is a session name that is a path', 400, r.status);
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'nope@vm', session: 'w1', data: PNG });
is('...and a project the vm does not have', true, r.status === 400 && /unknown project 'nope'/.test(r.json && r.json.text));
is('...none of which wrote anything on the vm', vmFiles, filesUnder(attachRoot(B)).length);
// Audited on both: the laptop that it forwarded, the vm that it stored, naming the origin.
const aAtt = audit(A).find(x => x.verb === 'attach') || {};
const bAtt = audit(B).find(x => x.verb === 'attach') || {};
is('the laptop audits the photo it forwarded', 'phone proxy vm acme-api@vm w1 ran',
   `${aAtt.client} ${aAtt.via} ${aAtt.host} ${aAtt.project} ${aAtt.subject} ${aAtt.result}`);
is('the vm audits the photo it stored, naming where it came from', 'laptop/phone pair laptop phone acme-api w1 ran',
   `${bAtt.client} ${bAtt.via} ${bAtt.origin_host} ${bAtt.origin_client} ${bAtt.project} ${bAtt.subject} ${bAtt.result}`);
// ONE RULE: a photo is allowed exactly where a send is, so a read-only pairing drops both.
const { pairAllows } = await import(path.join(RT, 'bin', 'fleet-serve.mjs'));
is('whether someone is at a keyboard crosses, as a read', 'true false', [pairAllows('GET', '/api/presence'), pairAllows('POST', '/api/presence', {})].join(' '));
is('a photo crosses while a send does', 'true true', [pairAllows('POST', '/api/verb', { tool: 'fleet_send' }), pairAllows('POST', '/api/attach', {})].join(' '));
is('...and a read-only pairing refuses both', 'false false',
   [pairAllows('POST', '/api/verb', { tool: 'fleet_send' }, new Set()), pairAllows('POST', '/api/attach', {}, new Set())].join(' '));
is('...while a pairing that kept wake but not send refuses the photo', false, pairAllows('POST', '/api/attach', {}, new Set(['fleet_wake'])));

// What does NOT cross, refused on the home host with the reason, and nothing run anywhere.
r = await pa.verb(A.base, 'fleet_stop', { project: 'toolbox@vm', session: 'w1' }, await pa.fresh(A.base, 'stop'));
// 400 and never 403: the client reads a 403 as a dead session and locks the app.
is('a passkey verb does not cross', 400, r.status);
is('...and says a passkey only works where it was made', true, /passkey only works on the host it was made on/.test(r.text));
is('...and nothing was stopped on either host', 0, ranLines(A, /^fleet-stop/).length + ranLines(B, /^fleet-stop/).length);
// Chat permission also grants the paired terminal; local-trust.mjs drives its socket.
r = await pa.api(A.base, 'POST', '/api/term/open', { project: 'toolbox@vm', cols: 80, rows: 24 });
is('the paired terminal opens without another assertion', true, r.status === 200 && !!r.json?.ticket);
if (r.status === 200) { try { execFileSync('tmux', ['-L', 'cf-toolbox', 'kill-server'], { stdio: 'pipe' }); } catch {} }
r = await pa.api(A.base, 'GET', '/api/checkouts?project=toolbox@vm');
is('a read outside the scope does not cross', 400, r.status);

r = await pa.api(A.base, 'GET', '/api/waiting');
const items = ((r.json && r.json.items) || []).map(i => `${i.project}:${i.host}:${i.text}`).sort().join(' | ');
is('the queue is merged: each master\'s item, with its host', 'acme-api:laptop:the laptop ask | toolbox@vm:vm:the vm ask', items);
r = await pa.api(A.base, 'GET', '/api/usage');
is('usage is merged without failing on a host whose accounts are off', 200, r.status);

// Both audit logs: the laptop records that it forwarded, the vm that it ran, each naming the
// originating host and client.
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
const signed = async (secret, method, pathq, body, onBehalf = 'phone', tamper = {}, sendBody = body) => {
  const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(18).toString('base64url');
  const canon = ['ghostfleet-pair-v1', lapOnB.id || '-', method, pathq, String(ts), nonce, onBehalf || '-',
                 crypto.createHash('sha256').update(data).digest('hex')].join('\n');
  const h = { 'x-fleet-pair': lapOnB.id || '-', 'x-fleet-pair-ts': String(ts), 'x-fleet-pair-nonce': nonce,
              'x-fleet-pair-sig': crypto.createHmac('sha256', secret || '-').update(canon).digest('hex'), 'x-fleet-on-behalf': onBehalf, ...tamper };
  const opts = { headers: h };
  if (sendBody !== undefined) opts.body = sendBody;
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
// /api/presence is in PAIR_READS on purpose: the push hold on each machine asks the other.
// It is told two numbers' worth and nothing else, and only over the pairing.
s = await signed(vmOnA.out, 'GET', '/api/presence');
is('a paired host may ask whether someone is at a keyboard here', 200, s.res.status);
is('...and is told idle and locked, and nothing else', '["idle","locked"]', JSON.stringify(Object.keys(s.res.json || {}).sort()));
is('...from this host\'s own reading', '7 false', `${s.res.json && s.res.json.idle} ${s.res.json && s.res.json.locked}`);
r = await request(B.base, 'GET', '/api/presence');
is('...while nobody unpaired and unenrolled may ask it', 401, r.status);
// THE ASKING HALF, through the real pairing: the laptop's `fleet-serve push` reads presence the
// way its watcher does, so the VM's answer has to cross the signed request to appear here.
c = A.cli('push');
is('the laptop reads the vm\'s presence over the pairing', true, c.code === 0 && /^now +at the keyboard \(peer vm, idle 7s\)$/m.test(c.out));
s = await signed(vmOnA.out, 'POST', '/api/verb', { tool: 'fleet_spawn', args: { project: 'toolbox', name: 'x' } });
is('a signed spawn: refused', 403, s.res.status);
s = await signed(vmOnA.out, 'GET', '/api/grid?project=toolbox@laptop');
is('a signed request naming yet another host: refused, never forwarded', 403, s.res.status);
is('...and none of it ran a spawn anywhere', 0, ranLines(B, /^fleet-spawn/).length + ranLines(A, /^fleet-spawn/).length);
// A forwarded photo is a signed request like any other, and refused like one.
const vmBefore = filesUnder(attachRoot(B)).length;
const pic = { project: 'acme-api', session: 'w1', data: PNG };
s = await signed(vmOnA.out, 'POST', '/api/attach', pic);
is('a signed photo is stored by the vm', 201, s.res.status);
r = await request(B.base, 'POST', '/api/attach', { body: pic });
is('an unsigned photo: refused', 401, r.status);
s = await signed(vmOnA.out, 'POST', '/api/attach', pic, 'phone', {}, { ...pic, session: 'w2' });
is('a signed photo whose body was changed on the way: refused', 401, s.res.status);
s = await signed(vmOnA.out, 'POST', '/api/attach', pic, 'phone', { 'x-fleet-pair-sig': 'f'.repeat(64) });
is('a photo with a forged signature: refused', 401, s.res.status);
s = await signed(vmOnA.out, 'POST', '/api/attach', { ...pic, project: 'acme-api@laptop' });
is('a signed photo naming yet another host: refused, never forwarded', 403, s.res.status);
is('...and only the one good photo was written', vmBefore + 1, filesUnder(attachRoot(B)).length);

// ── the fleet's memory crosses as a read (docs/MEMORY.md) ──────────────────────────
// The vm records through the writer every path uses (fleet-know-event), with toolbox set
// private THERE first; the laptop then asks its own fleet-know about acme-api@vm, which can
// only be answered by fetching the vm's events over the signed pairing.
const know = (h, bin, ...args) => { try { return { code: 0, out: execFileSync('node', [path.join(RT, 'bin', bin), ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                                    catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const bFleet = path.join(B.home, '.claude', 'fleet');
fs.writeFileSync(path.join(bFleet, 'cf-toolbox.know'), 'private\n');
know(B, 'fleet-know-event.mjs', 'spawn', `fleet=${bFleet}`, 'sock=cf-acme-api', `cwd=${path.join(B.dir, 'acme-api')}`, 'worker=api-fix', 'branch=fix/vm-only', 'task=Retry the vm-only webhook backoff', 'parent=master');
know(B, 'fleet-know-event.mjs', 'spawn', `fleet=${bFleet}`, 'sock=cf-toolbox', `cwd=${path.join(B.dir, 'toolbox')}`, 'worker=docs-pass', 'branch=docs/private-only', 'task=A private toolbox task', 'parent=master');
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
const kev = (s.res.json && s.res.json.events) || [];
is('a paired host may read this host\'s memory', 200, s.res.status);
is('...which carries the acme-api spawn, with its task', true, kev.some(e => e.kind === 'spawn' && e.project === 'acme-api' && /vm-only webhook/.test(e.f && e.f.task)));
is('...and nothing of the project that is private here', false, JSON.stringify(kev).includes('private toolbox task'));
r = await request(B.base, 'GET', '/api/know/events?after=0');
is('...while an unsigned, unenrolled ask is refused', 401, r.status);
c = know(A, 'fleet-know.mjs', 'acme-api@vm', '--json');
const kb = (() => { try { return JSON.parse(c.out); } catch { return {}; } })();
is('the laptop\'s fleet-know answers about acme-api@vm, fetched over the pairing', 'vm fix/vm-only', `${kb.machine} ${((kb.branches || [])[0] || {}).name}`);
is('...and reads the vm as fresh', 'false', String(((kb.peers || []).find(x => x.key === 'vm') || {}).stale));
c = know(A, 'fleet-know.mjs', 'find', 'webhook', 'backoff');
is('...and `find` searches the vm\'s raw events too', true, c.code === 0 && /acme-api@vm .*vm-only webhook backoff/.test(c.out));
c = know(A, 'fleet-know.mjs', 'toolbox@vm');
is('...but holds nothing of the vm\'s private project', true, c.code === 1 && !/private toolbox task/.test(c.out));

// ── what a host forgets, the host that fetched it drops ─────────────────────────────
// The copy the laptop already fetched is the hard half of forget: a tombstone on the vm alone
// leaves the text on another disk. So it crosses too, over the same signed read, to the file
// that holds the copy and nowhere else.
const aPeerLog = path.join(A.home, '.claude', 'fleet', 'know-peers', 'vm.jsonl');
const peerLogText = () => { try { return fs.readFileSync(aPeerLog, 'utf8'); } catch { return ''; } };
const kvm = (worker, branch, task) => know(B, 'fleet-know-event.mjs', 'spawn', `fleet=${bFleet}`, 'sock=cf-acme-api', `cwd=${path.join(B.dir, 'acme-api')}`, `worker=${worker}`, `branch=${branch}`, `task=${task}`, 'parent=master');
kvm('csv-export', 'fix/vm-forget', 'A staging detail the vm will forget');
kvm('rate-limit', 'fix/vm-stays', 'A sibling task that stays');
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
const leaked = ((s.res.json && s.res.json.events) || []).find(e => /will forget/.test(e.f && e.f.task)) || {};
c = know(A, 'fleet-know.mjs', 'sync');
is('forget: the laptop fetched the event, so the laptop holds it', true, /will forget/.test(peerLogText()));
c = know(B, 'fleet-know.mjs', 'forget', leaked.id || 'none');
is('the vm forgets it, and says a paired machine keeps its copy until it fetches', true, c.code === 0 && /keeps its copy until/.test(c.out));
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
is('...the vm no longer serves it', false, JSON.stringify(s.res.json || {}).includes('will forget'));
is('...and a reader that did not ask is not sent the tombstone', false, ((s.res.json && s.res.json.events) || []).some(e => e.kind === 'forget'));
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0&tombstones=1');
is('...the sync\'s read carries it, naming the event and not its text', true, ((s.res.json && s.res.json.events) || []).some(e => e.kind === 'forget' && e.f && e.f.target === leaked.id));
c = know(A, 'fleet-know.mjs', 'find', 'staging', 'detail');
is('...the laptop still has its copy until it fetches: the documented window', true, /will forget/.test(c.out));
c = know(A, 'fleet-know.mjs', 'sync');
is('after a sync the laptop\'s cached line has gone from its disk', 'no yes', `${peerLogText().includes('will forget') ? 'yes' : 'no'} ${peerLogText().includes('sibling task that stays') ? 'yes' : 'no'}`);
c = know(A, 'fleet-know.mjs', 'find', 'staging', 'detail');
is('...and its find no longer reaches it', false, /will forget/.test(c.out));
c = know(A, 'fleet-know.mjs', 'find', 'sibling', 'task');
is('...while the event beside it still answers', true, /sibling task that stays/.test(c.out));
// A tombstone is scoped to the file holding the copy. If it applied everywhere, a paired machine
// could erase this machine's own memory by naming an id.
kvm('docs-sweep', 'fix/vm-scope', 'An event this machine holds as well');
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
const heldBoth = ((s.res.json && s.res.json.events) || []).find(e => /holds as well/.test(e.f && e.f.task)) || {};
know(A, 'fleet-know.mjs', 'sync');
fs.appendFileSync(path.join(A.home, '.claude', 'fleet', 'know.jsonl'), JSON.stringify({ ...heldBoth, machine: 'laptop' }) + '\n');
know(B, 'fleet-know.mjs', 'forget', heldBoth.id || 'none');
know(A, 'fleet-know.mjs', 'sync');
c = know(A, 'fleet-know.mjs', 'find', 'holds', 'as', 'well');
// Matching more than the query: find's no-match line repeats what it was asked.
is('the vm\'s tombstone takes the copy the vm sent, and not this machine\'s own line', 'no yes', `${peerLogText().includes('holds as well') ? 'yes' : 'no'} ${/An event this machine holds as well/.test(c.out) ? 'yes' : 'no'}`);
// A key the vm's own writer was handed never leaves the vm's disk at all.
const crossing = `gh${'p'}_${'a1B2'.repeat(9)}`;
kvm('cache-keys', 'fix/vm-token', `Rotate the deploy key ${crossing} tonight`);
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
is('a token in a task is replaced before it can cross', 'no yes', `${JSON.stringify(s.res.json || {}).includes(crossing) ? 'yes' : 'no'} ${JSON.stringify(s.res.json || {}).includes('[redacted:github-token]') ? 'yes' : 'no'}`);
is('...and is not on the disk of the machine that wrote it', false, fs.readFileSync(path.join(bFleet, 'know.jsonl'), 'utf8').includes(crossing));

// ── a project this machine keeps from paired machines (fleet-project … pair) ────────
// The vm gains three projects: billing-svc (work), hidden on its own; acme-web and scratch in
// a personal profile whose DEFAULT is hide, with scratch shared back on its own. So the two
// hidden ones are hidden two different ways, and scratch proves the project beats the
// profile. Each paired route is asked twice: signed as the laptop, where the hidden two must
// be absent, and by the vm's own phone, which must see all five. `nope` is a project the vm
// never had, and a hidden project must be answered exactly the way it is.
const bProjects = path.join(B.home, '.config', 'ghostfleet', 'projects');
const bProjectsBefore = fs.readFileSync(bProjects, 'utf8');
const bPersonal = path.join(B.home, '.claude-personal', 'fleet');
const HIDDEN = ['billing-svc', 'acme-web'];
for (const n of ['billing-svc', 'acme-web', 'scratch']) fs.mkdirSync(path.join(B.dir, n), { recursive: true });
fs.mkdirSync(bPersonal, { recursive: true });
fs.appendFileSync(bProjects, `billing-svc\t${path.join(B.dir, 'billing-svc')}\twork\n`);
fs.writeFileSync(path.join(B.home, '.config', 'ghostfleet', 'projects.personal'),
  `acme-web\t${path.join(B.dir, 'acme-web')}\tpersonal\nscratch\t${path.join(B.dir, 'scratch')}\tpersonal\n`);
const fp = (...args) => { try { return { code: 0, out: execFileSync('bash', [path.join(RT, 'bin', 'fleet-project'), ...args], { env: B.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                          catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const marks = [[path.join(bFleet, 'cf-billing-svc.pair'), 'hide'], [path.join(bPersonal, 'pair.default'), 'hide'],
               [path.join(bPersonal, 'cf-personal-scratch.pair'), 'share']];
const markText = () => marks.map(([f]) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return 'missing'; } }).join(' ');
c = fp('set', 'billing-svc', 'pair', 'hide');
is('fleet-project hides one project from paired machines', true, c.code === 0 && /'billing-svc' to a paired machine: hide \(from project/.test(c.out));
c = fp('set', '--profile', 'personal', 'pair', 'hide');
is('...sets a profile\'s default', true, c.code === 0 && /profile 'personal': a paired machine gets hide/.test(c.out));
c = fp('set', 'scratch', 'pair', 'share');
is('...and shares one project of that profile back', true, c.code === 0 && /'scratch' to a paired machine: share \(from project/.test(c.out));
is('...each written where the daemon reads it', 'hide hide share', markText());
// The daemon's contract is the file, so a route row below fails on the daemon's account and
// not the command's: on a checkout without the command, the same bytes are written here.
for (const [f, v] of marks) if (!fs.existsSync(f)) fs.writeFileSync(f, v + '\n');
c = fp('pair');
is('fleet-project pair: per project, its profile, the setting, where it comes from, whether a peer sees it',
   'acme-api work share default yes|toolbox work share default yes|billing-svc work hide project no|acme-web personal hide profile no|scratch personal share project yes',
   c.out.split('\n').slice(1).filter(Boolean).map(l => l.trim().split(/\s+/).join(' ')).join('|'));
c = fp('pair', '--json');
const pairRowsB = (() => { try { return JSON.parse(c.out).rows || []; } catch { return []; } })();

// THE PANES: a real tmux server for one hidden and one shared session, so a send that must
// not happen is checked on the screen it would have typed into.
const TX = (sock, ...a) => { try { return execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8', env: { ...process.env, TMUX: '' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }); } catch { return null; } };
const PANES = { 'cf-billing-svc': 'billing pane: hidden', 'cf-personal-scratch': 'scratch pane: shared' };
for (const [sock, text] of Object.entries(PANES)) TX(sock, 'new-session', '-d', '-s', 'w1', '-x', '100', '-y', '12', `printf '%s\\n' '${text}'; exec cat`);
const screen = (sock) => TX(sock, 'capture-pane', '-p', '-t', 'w1') || '';
for (let i = 0; i < 30 && !Object.entries(PANES).every(([k, v]) => screen(k).includes(v)); i++) await sleep(100);
const waitFor = async (sock, text) => { for (let i = 0; i < 30 && !screen(sock).includes(text); i++) await sleep(100); return screen(sock).includes(text); };
is('the vm has a live pane in a hidden and in a shared project', 'yes yes', Object.entries(PANES).map(([k, v]) => screen(k).includes(v) ? 'yes' : 'no').join(' '));

plantWaiting(B, 'cf-billing-svc', 'mh-b-billing', 'the hidden billing ask');
plantWaiting(B, 'cf-personal-acme-web', 'mh-b-acme-web', 'the hidden personal ask', bPersonal);
plantWaiting(B, 'cf-personal-scratch', 'mh-b-scratch', 'the shared personal ask', bPersonal);

// The answer a peer gets for a project, with the name taken out: a hidden project's must be
// a project-that-never-was's, word for word, so nothing in it says the project is there.
const shape = (res, name) => `${res.status} ${String((res.json && (res.json.text || res.json.error)) || '').split(name).join('<name>')}`;
const anyName = (j) => HIDDEN.filter(n => JSON.stringify(j || {}).includes(n)).join(' ');

// ── reads, signed as the laptop ──
s = await signed(vmOnA.out, 'GET', '/api/projects');
is('hidden: a paired machine\'s project list leaves both out', 'acme-api scratch toolbox', names(s.res));
is('...and names neither anywhere in the payload', '', anyName(s.res.json));
r = await pb.api(B.base, 'GET', '/api/projects');
is('...while this machine\'s own phone lists all five of its own', 'acme-api acme-web billing-svc scratch toolbox', names(r).split(' ').filter(n => !n.includes('@')).join(' '));
r = await pa.api(A.base, 'GET', '/api/projects');
is('...and the laptop\'s phone, through the pairing, sees the vm\'s three', 'acme-api@vm scratch@vm toolbox@vm',
   names(r).split(' ').filter(n => n.endsWith('@vm')).join(' '));
is('...with neither name anywhere in what the laptop merged', '', anyName(r.json));
for (const [route, q] of [['/api/grid', ''], ['/api/session', '&session=w1'], ['/api/pane', '&session=w1'], ['/api/settings', '']]) {
  const nope = (await signed(vmOnA.out, 'GET', `${route}?project=nope${q}`)).res;
  const hid = (await signed(vmOnA.out, 'GET', `${route}?project=billing-svc${q}`)).res;
  const byProfile = (await signed(vmOnA.out, 'GET', `${route}?project=acme-web${q}`)).res;
  is(`hidden: ${route} answers a peer as it answers a project that never was`, `${shape(nope, 'nope')} | ${shape(nope, 'nope')}`,
     `${shape(hid, 'billing-svc')} | ${shape(byProfile, 'acme-web')}`);
  const shared = (await signed(vmOnA.out, 'GET', `${route}?project=scratch${q}`)).res;
  const local = await pb.api(B.base, 'GET', `${route}?project=billing-svc${q}`);
  is(`...the shared one is served to the peer, and the hidden one to this machine`, '200 200', `${shared.status} ${local.status}`);
}
s = await signed(vmOnA.out, 'GET', '/api/pane?project=scratch&session=w1');
is('...a shared pane is the pane', true, JSON.stringify(s.res.json || {}).includes('scratch pane: shared'));
r = await pb.api(B.base, 'GET', '/api/pane?project=billing-svc&session=w1');
is('...and the hidden pane is there for this machine', true, JSON.stringify(r.json || {}).includes('billing pane: hidden'));
r = await pa.api(A.base, 'GET', '/api/grid?project=billing-svc@vm');
const rNope = await pa.api(A.base, 'GET', '/api/grid?project=nope@vm');
is('...through the laptop, a hidden project is a project the vm does not have', shape(rNope, 'nope'), shape(r, 'billing-svc'));

s = await signed(vmOnA.out, 'GET', '/api/waiting');
const qItems = (j) => ((j && j.items) || []).filter(i => !String(i.project).includes('@')).map(i => `${i.project}:${i.text}`).sort().join(' | ');
is('hidden: the queue a peer reads holds nothing of a hidden project', 'scratch:the shared personal ask | toolbox:the vm ask', qItems(s.res.json));
is('...and names neither', '', anyName(s.res.json));
r = await pb.api(B.base, 'GET', '/api/waiting');
is('...while this machine\'s queue holds all of them',
   'acme-web:the hidden personal ask | billing-svc:the hidden billing ask | scratch:the shared personal ask | toolbox:the vm ask', qItems(r.json));
r = await pa.api(A.base, 'GET', '/api/waiting');
is('...and the laptop\'s merged queue has the vm\'s shared items and no name of the hidden ones', 'yes ',
   `${/the shared personal ask/.test(JSON.stringify(r.json || {})) ? 'yes' : 'no'} ${anyName(r.json)}`);
// /api/usage and /api/presence take no filter: usage is a profile's accounts and their figures,
// presence two readings of this machine's keyboard, and neither names a project.

// ── verbs: refused like a project that never was, and nothing typed ──
const beforeHidden = screen('cf-billing-svc');
const ranBefore = fs.readFileSync(B.ran, 'utf8').split('\n').length;
const sendNope = (await signed(vmOnA.out, 'POST', '/api/verb', { tool: 'fleet_send', args: { project: 'nope', session: 'w1', prompt: 'typed by a peer' } })).res;
s = await signed(vmOnA.out, 'POST', '/api/verb', { tool: 'fleet_send', args: { project: 'billing-svc', session: 'w1', prompt: 'typed by a peer' } });
is('hidden: a signed send is refused the way a project that never was is', shape(sendNope, 'nope'), shape(s.res, 'billing-svc'));
r = await pa.verb(A.base, 'fleet_send', { project: 'billing-svc@vm', session: 'w1', prompt: 'typed through the laptop' });
const vNope = await pa.verb(A.base, 'fleet_send', { project: 'nope@vm', session: 'w1', prompt: 'typed through the laptop' });
is('...and so is the same send from the laptop\'s phone', shape(vNope, 'nope'), shape(r, 'billing-svc'));
for (const tool of ['fleet_wake', 'fleet_pause', 'fleet_resume']) {
  const a = (await signed(vmOnA.out, 'POST', '/api/verb', { tool, args: { project: 'acme-web', session: 'w1' } })).res;
  const b = (await signed(vmOnA.out, 'POST', '/api/verb', { tool, args: { project: 'nope', session: 'w1' } })).res;
  is(`...${tool} too, on a project hidden by its profile`, shape(b, 'nope'), shape(a, 'acme-web'));
}
const pic2 = { project: 'billing-svc', session: 'w1', data: PNG };
const filesBefore = filesUnder(attachRoot(B)).length;
s = await signed(vmOnA.out, 'POST', '/api/attach', pic2);
const attNope = (await signed(vmOnA.out, 'POST', '/api/attach', { ...pic2, project: 'nope' })).res;
is('...and a photo', shape(attNope, 'nope'), shape(s.res, 'billing-svc'));
await sleep(300);
is('...the hidden pane is exactly as it was: nothing was typed', beforeHidden, screen('cf-billing-svc'));
is('...no fleet command ran on the vm for any of it', ranBefore, fs.readFileSync(B.ran, 'utf8').split('\n').length);
is('...and no photo was stored', filesBefore, filesUnder(attachRoot(B)).length);
r = await pa.verb(A.base, 'fleet_send', { project: 'scratch@vm', session: 'w1', prompt: 'typed through the pairing' });
is('shared: the same send to a shared project is typed into its pane', '200 yes', `${r.status} ${await waitFor('cf-personal-scratch', 'typed through the pairing') ? 'yes' : 'no'}`);
r = await pb.verb(B.base, 'fleet_send', { project: 'billing-svc', session: 'w1', prompt: 'typed on this machine' });
is('...and this machine\'s own phone still types into the hidden one', '200 yes', `${r.status} ${await waitFor('cf-billing-svc', 'typed on this machine') ? 'yes' : 'no'}`);

// ── memory: include AND share, or it stays here ──
// toolbox is private + share (above); billing-svc include + hide; acme-web include + hidden by
// its profile; acme-api and scratch include + share. A relation is held to the project it
// names as well: acme-api depends on billing-svc stays here, on toolbox it crosses.
fs.writeFileSync(path.join(bFleet, 'cf-billing-svc.know'), 'include\n');
const kspawn = (fleet, sock, dir, branch, task) => know(B, 'fleet-know-event.mjs', 'spawn', `fleet=${fleet}`, `sock=${sock}`, `cwd=${path.join(B.dir, dir)}`, 'worker=w1', `branch=${branch}`, `task=${task}`, 'parent=master');
kspawn(bFleet, 'cf-billing-svc', 'billing-svc', 'fix/ledger-rounding', 'A hidden billing task');
kspawn(bPersonal, 'cf-personal-acme-web', 'acme-web', 'fix/nav-focus', 'A hidden personal task');
kspawn(bPersonal, 'cf-personal-scratch', 'scratch', 'fix/notes-sync', 'A shared personal task');
kspawn(bFleet, 'cf-acme-api', 'acme-api', 'fix/shared-retry', 'A shared work task');
know(B, 'fleet-know.mjs', 'relate', 'acme-api', 'depends-on', 'billing-svc');
know(B, 'fleet-know.mjs', 'relate', 'acme-api', 'depends-on', 'toolbox');
s = await signed(vmOnA.out, 'GET', '/api/know/events?after=0');
const kj = JSON.stringify(s.res.json || {});
const relTo = ((s.res.json && s.res.json.events) || []).filter(e => e.kind === 'relate').map(e => e.f && e.f.to).sort().join(' ');
is('memory: include + share crosses, in either profile', 'yes yes', `${kj.includes('A shared work task') ? 'yes' : 'no'} ${kj.includes('A shared personal task') ? 'yes' : 'no'}`);
is('memory: include + hide does not, hidden on its own or by its profile', 'no no', `${kj.includes('A hidden billing task') ? 'yes' : 'no'} ${kj.includes('A hidden personal task') ? 'yes' : 'no'}`);
is('memory: private + share does not either', false, kj.includes('private toolbox task'));
is('...a relation naming a hidden project stays here, the one beside it crosses', 'toolbox', relTo);
is('...and no hidden project is named anywhere in what crosses', '', anyName(s.res.json));
c = know(A, 'fleet-know.mjs', 'sync');
is('the laptop\'s copy, after a sync, holds the shared and not the hidden', 'yes no no',
   `${peerLogText().includes('A shared personal task') ? 'yes' : 'no'} ${peerLogText().includes('A hidden billing task') ? 'yes' : 'no'} ${HIDDEN.some(n => peerLogText().includes(n)) ? 'yes' : 'no'}`);
c = know(B, 'fleet-know.mjs', 'find', 'hidden', 'billing');
is('...while this machine\'s own fleet-know still finds the hidden project\'s task', true, c.code === 0 && /A hidden billing task/.test(c.out));

// THE COMMAND AND THE DAEMON AGREE: what fleet-project pair says a peer sees is what it lists.
s = await signed(vmOnA.out, 'GET', '/api/projects');
const listed = new Set(((s.res.json && s.res.json.projects) || []).map(p => p.name));
is('fleet-project pair says what the daemon does, project for project', 'acme-api:yes toolbox:yes billing-svc:no acme-web:no scratch:yes',
   pairRowsB.map(x => `${x.project}:${x.peer_sees && listed.has(x.project) ? 'yes' : (!x.peer_sees && !listed.has(x.project) ? 'no' : 'DISAGREE')}`).join(' '));
// A value this version does not know reads as hide: naming machines later must fail closed here.
fs.writeFileSync(path.join(bPersonal, 'cf-personal-scratch.pair'), 'share:laptop\n');
s = await signed(vmOnA.out, 'GET', '/api/projects');
is('a value this version does not know hides the project', 'acme-api toolbox', names(s.res));

// Back to the vm the rest of this file expects: its two projects, and no panes.
fs.writeFileSync(bProjects, bProjectsBefore);
fs.rmSync(path.join(B.home, '.config', 'ghostfleet', 'projects.personal'), { force: true });
for (const sock of Object.keys(PANES)) TX(sock, 'kill-server');

// ── a host that is down stays visible ───────────────────────────────────────────────
await stop(B);
// The memory: a peer that does not answer is its last fetched state, marked stale — an
// answer, never an error.
c = know(A, 'fleet-know.mjs', 'sync');
is('with the vm down, fleet-know sync says it was not reached', true, c.code === 0 && /^vm +not reached .*marked stale$/m.test(c.out));
c = know(A, 'fleet-know.mjs', 'acme-api@vm');
is('...and a brief still answers from its last fetched state, marked stale', true, c.code === 0 && /branch fix\/vm-only/.test(c.out) && /^\(vm: stale — last fetched /m.test(c.out));
r = await pa.api(A.base, 'GET', '/api/projects');
const vmRow = ((r.json && r.json.hosts) || []).find(x => x.label === 'vm') || {};
is('with the vm down, the laptop still answers', 200, r.status);
is('...the vm is listed offline, not missing', false, vmRow.online);
c = A.cli('push');
is('with the vm down, its presence is no reading: nothing would be held', true, c.code === 0 && /^now +no reading — nothing would be held$/m.test(c.out));

is('...with when it was last seen', true, Number(vmRow.last_seen) > 0 && /ago|just now/.test(String(vmRow.last_seen_ago)));
is('...and its projects are not drawn as if they were there', 'acme-api scratch', names(r));
r = await pa.api(A.base, 'GET', '/api/grid?project=toolbox@vm');
is('opening one of its projects says offline · last seen', true, r.status === 502 && /vm is offline .*· last seen/.test(r.json && r.json.text));
r = await pa.verb(A.base, 'fleet_send', { project: 'toolbox@vm', session: 'w1', prompt: 'into the void' });
is('a send to the down host fails loudly', 502, r.status);
is('...and is audited as unreachable', 'unreachable', (audit(A).filter(x => x.verb === 'fleet_send').pop() || {}).result);
r = await pa.api(A.base, 'POST', '/api/attach', { project: 'acme-api@vm', session: 'w1', data: PNG });
// 502, never a 401/403: those make the phone throw its token away over another machine's nap.
is('a photo for the down host fails, naming that machine', true, r.status === 502 && /^vm is offline .*· last seen/.test(r.json && r.json.text));
is('...and the laptop audits it as unreachable', 'unreachable', (audit(A).filter(x => x.verb === 'attach').pop() || {}).result);
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
