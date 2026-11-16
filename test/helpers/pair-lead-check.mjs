#!/usr/bin/env node
// pair-lead-check — a project's lead brought up from the phone, in every state it can be down
// in, on the phone's own machine AND on the machine the phone reaches through a pairing.
//
//     node test/helpers/pair-lead-check.mjs [root]     # "name <US> want <US> got" rows
//     PAIR_LEAD_SHOTS=<dir> node …                     # also keep the phone's screenshots
//
// `root` is a checkout whose bin/, mcp/, lib/, mods/ and web/ are run; it defaults to this one.
// Pointed at a `git archive` of a daemon that forwarded neither a reopen nor a start, every row
// about the pairing goes red for its own reason: the reopen is answered "not shared with paired
// machines", and the phone's own lead.js gives up on a project with no lead on another machine.
//
// THE SHAPE OF THE FAILURE IT GUARDS: after a reboot most leads are LOST, the phone's lead
// button sends fleet_reopen for a lost one, and the phone reaches that machine THROUGH a paired
// one, which forwarded only send/wake/park/resume. So the one button that mattered most after a
// reboot was the one that could not cross — and a reopen refused on the far side came back as a
// 200, so the phone said "The lead is ready." over it.
//
// TWO HOSTS, each its own HOME, serve.json, audit log and port: a (the machine the phone is on,
// with acme-api) and b (the vm, with toolbox, and billing-svc kept from paired machines). Each
// host's grid is a stub that draws its master card from a per-project STATE file — up, asleep,
// lost, parked, none — and the verbs that bring a lead back are stubs that log their argv and
// move that file to `up`, so "the reopen ran on the vm, in toolbox, and the lead is up" is a
// line in one file and a card in the next read. A FAIL file beside a state makes that project's
// verbs refuse the way the real ones do (stderr, exit 1), which is what the failure rows need.
//
// The daemons and Chrome are this script's children, killed by the pids it captured — never by
// pattern.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Authenticator, request } from './serve-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(HERE, '..', '..'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const kids = [];
let browser = null;
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'pair-lead.'));
if (!process.env.TMUX_TMPDIR) { process.env.TMUX_TMPDIR = path.join(T, 'tx'); fs.mkdirSync(process.env.TMUX_TMPDIR, { mode: 0o700 }); }
async function finish(code = 0) {
  try { await browser?.close(); } catch {}
  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch {} }
  console.log(rows.join('\n'));
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => { console.error(String(e && e.stack || e)); finish(1); });
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); finish(1); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ── one runtime, both hosts ─────────────────────────────────────────────────────────
const RT = path.join(T, 'rt');
for (const d of ['bin', 'mcp', 'lib', 'web']) fs.cpSync(path.join(SRC, d), path.join(RT, d), { recursive: true });
fs.mkdirSync(path.join(RT, 'mods', 'ghostfleet'), { recursive: true });
fs.cpSync(path.join(SRC, 'mods', 'ghostfleet', 'hooks'), path.join(RT, 'mods', 'ghostfleet', 'hooks'), { recursive: true });
// Every verb stub: log, then act on the project's state file. The project is the fleet the
// daemon scoped the run to, or — for the start, which is run by NAME and with no -s — the
// name after `start`. A verb aimed at a lead in the wrong state refuses, as the real one does.
const stub = `#!/bin/sh
me="$(basename "$0")"
printf '%s' "$me" >> "$MH_RAN"
for a in "$@"; do printf ' [%s]' "$a" >> "$MH_RAN"; done
printf ' {scope=%s}\\n' "\${CLAUDE_FLEET_SCOPE:-}" >> "$MH_RAN"
p="\${CLAUDE_FLEET_SCOPE:-}"
[ "$me" = fleet-project ] && [ "\${1:-}" = start ] && p="\${2:-}"
st="$(cat "$MH_STATE/$p" 2>/dev/null || echo none)"
fail() { echo "$1" >&2; exit 1; }
[ -n "$p" ] && [ -e "$MH_STATE/$p.fail" ] && fail "$me: $(cat "$MH_STATE/$p.fail")"
case "$me" in
  fleet-hibernate) [ "$st" = asleep ] || fail "fleet-hibernate: FAILED — 'master' is not asleep"; echo up > "$MH_STATE/$p"; echo "fleet-hibernate: woke 'master'" ;;
  fleet-restart)   [ "$st" = lost ]   || fail "fleet-restart: 'master' is not lost — it is $st"; echo up > "$MH_STATE/$p"; echo "fleet-restart: reopened 'master'" ;;
  fleet-resume)    [ "$st" = parked ] || fail "fleet-resume: 'master' is not parked"; echo up > "$MH_STATE/$p"; echo "fleet-resume: resumed 'master'" ;;
  fleet-project)   [ "\${1:-}" = start ] || { echo "STUB fleet-project ok"; exit 0; }
                   [ "$st" = none ] || fail "fleet-project: master already running"; echo up > "$MH_STATE/$p"; echo "fleet-project: started master in $p" ;;
  *) echo "STUB $me ok" ;;
esac
`;
for (const c of ['fleet-send', 'fleet-hibernate', 'fleet-pause', 'fleet-resume', 'fleet-restart', 'fleet-project', 'fleet-spawn', 'fleet-stop',
                 'fleet-rename', 'fleet-list', 'fleet-inbox', 'fleet-worktrees', 'fleet-answer', 'fleet-clean']) {
  fs.writeFileSync(path.join(RT, 'bin', c), stub, { mode: 0o755 });
}
fs.writeFileSync(path.join(RT, 'bin', 'fleet-grid.mjs'), `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const scope = process.env.CLAUDE_FLEET_SCOPE || '';
let st = 'none'; try { st = fs.readFileSync(path.join(process.env.MH_STATE, scope), 'utf8').trim(); } catch {}
if (process.argv.includes('--json')) {
  if (st === 'unreadable') { process.stderr.write('stub grid: the fleet could not be read\\n'); process.exit(3); }
  const lead = st === 'none' ? [] : [{ name: 'master', label: null, lead: true, status: st === 'parked' ? 'parked' : st === 'up' ? 'ready' : 'idle',
    asleep: st === 'asleep', lost: st === 'lost', exited: false, folder: scope, branch: 'main', agent: 'claude', msg: '', age: 60,
    attached: false, sched: null, limit_at: null, queued: 0 }];
  const w = { name: 'w1', label: null, lead: false, status: 'working', asleep: false, lost: false, exited: false, folder: 'w1', branch: 'feat/x',
    agent: 'claude', msg: 'on ' + process.env.MH_HOST, age: 5, attached: false, sched: null, limit_at: null, queued: 0 };
  process.stdout.write(JSON.stringify({ project: scope, profile: process.env.CLAUDE_FLEET_PROFILE || '', sock: process.env.CLAUDE_FLEET_SOCK || '',
    counts: { need_you: 0, working: 1, ready: st === 'up' ? 1 : 0, parked: st === 'parked' ? 1 : 0, limit: 0, interrupted: 0 },
    cards: [...lead, w], free_worktrees: [] }) + '\\n', () => process.exit(0));
} else if (process.argv.includes('--checkouts')) { process.stdout.write('{"roots":[],"checkouts":[]}\\n', () => process.exit(0)); }
else { process.stderr.write('stub grid: refusing to be interactive\\n'); process.exit(2); }
`, { mode: 0o755 });
fs.writeFileSync(path.join(RT, 'bin', 'fleet-read'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ session: 'master', total: 0, window_truncated: false, messages: [], next_before: null }) + '\\n');
`, { mode: 0o755 });

// ── the two hosts ───────────────────────────────────────────────────────────────────
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
              state: path.join(dir, 'state'), cfg: path.join(dir, 'serve.json'), audit: path.join(dir, 'audit.jsonl'),
              trust: path.join(home, '.config/ghostfleet/local-trust') };
  fs.mkdirSync(h.state);
  h.env = { ...process.env, HOME: home, TMUX: '', CLAUDE_FLEET_AWAKE: 'off', GHOSTFLEET_SERVE_CONFIG: h.cfg,
            GHOSTFLEET_SERVE_AUDIT: h.audit, MH_RAN: h.ran, MH_HOST: id, MH_STATE: h.state };
  for (const k of Object.keys(h.env)) if (k.startsWith('CLAUDE_FLEET_') && k !== 'CLAUDE_FLEET_AWAKE') delete h.env[k];
  delete h.env.CLAUDE_CONFIG_DIR;
  fs.writeFileSync(h.ran, '');
  h.cli = (...args) => { try { return { code: 0, out: execFileSync('node', [path.join(RT, 'bin', 'fleet-serve.mjs'), ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                          catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  h.cli('init', '--bind', '127.0.0.1', '--port', String(port), '--rp-id', 'localhost', '--origin', h.base);
  const c = JSON.parse(fs.readFileSync(h.cfg, 'utf8'));
  c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(h.cfg, JSON.stringify(c, null, 2));
  h.set = (project, st) => fs.writeFileSync(path.join(h.state, project), st + '\n');
  h.get = (project) => { try { return fs.readFileSync(path.join(h.state, project), 'utf8').trim(); } catch { return 'none'; } };
  h.failWith = (project, why) => why ? fs.writeFileSync(path.join(h.state, project + '.fail'), why) : fs.rmSync(path.join(h.state, project + '.fail'), { force: true });
  h.ranSince = (n) => fs.readFileSync(h.ran, 'utf8').split('\n').filter(Boolean).slice(n);
  h.mark = () => fs.readFileSync(h.ran, 'utf8').split('\n').filter(Boolean).length;
  h.audit_ = () => { try { return fs.readFileSync(h.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
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

const A = await host('a', [['acme-api', 'work']]);
const B = await host('b', [['toolbox', 'work'], ['billing-svc', 'work']]);
// billing-svc is kept from paired machines (fleet-project set billing-svc pair hide), so a
// start aimed at it through the pairing must be answered as a project the vm never had.
fs.writeFileSync(path.join(B.home, '.claude', 'fleet', 'cf-billing-svc.pair'), 'hide\n');
const code = (h) => (h.cli('enroll', 'phone').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
const ca = code(A);
if (!(await start(A)) || !(await start(B))) {
  is('both daemons come up', 'up', `down: ${fs.readFileSync(A.log, 'utf8').slice(0, 300)} | ${fs.readFileSync(B.log, 'utf8').slice(0, 300)}`);
  await finish(1);
}
const pa = new Authenticator({ rpId: 'localhost', origin: A.base });
await pa.enroll(A.base, ca);
const pcode = (A.cli('pair', '--as', 'laptop').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
const paired = B.cli('pair', A.base, pcode, '--as', 'vm');
is('the two hosts pair', 0, paired.code);

// THE PHONE'S OWN FUNCTION (web/src/lead.js), with the phone's verb path: a reply with
// ok:false is a throw carrying the daemon's text, exactly as web/api.js verb() does.
const { makeLead } = await import(pathToFileURL(path.join(SRC, 'web', 'src', 'lead.js')).href);
const act = async (tool, args) => {
  const r = await pa.verb(A.base, tool, args);
  if (!r.json || r.json.ok === false || r.status >= 400) throw new Error((r.json && r.json.text) || `HTTP ${r.status}`);
  return r.json;
};
const lead = makeLead({
  // ...and the phone's grid read, `fresh` included (web/api.js getGrid): lead.js decides from it.
  grid: async (p, o = {}) => (await pa.api(A.base, 'GET', `/api/grid?project=${encodeURIComponent(p)}${o.fresh ? '&fresh=1' : ''}`)).json || {},
  projects: async () => (await pa.api(A.base, 'GET', '/api/projects')).json || {},
  act, remote: (p) => /@[^@]+$/.test(String(p || '')), wait: () => sleep(60),
  noLead: (p) => new Error(`${p} has no lead to start from this phone.`), tries: 40, every: 60,
});
const tryLead = async (p) => { try { return await lead(p); } catch (e) { return { threw: e.message }; } };

// ── every state, on this machine and through the pairing ─────────────────────────────
// The verb each state takes, and the stub that runs it on the machine the project is on.
const WAY = { asleep: ['wake', 'fleet-hibernate'], lost: ['reopen', 'fleet-restart'], parked: ['resume', 'fleet-resume'], none: ['start', 'fleet-project'] };
for (const [where, h, other, name, project] of [['here', A, B, 'acme-api', 'acme-api'], ['through the pairing', B, A, 'toolbox', 'toolbox@vm']]) {
  for (const st of ['asleep', 'lost', 'parked', 'none']) {
    h.set(name, st);
    const mh = h.mark(), mo = other.mark();
    const r = await tryLead(project);
    const [did, cmd] = WAY[st];
    is(`${where}: ${st === 'none' ? 'a project with no lead' : (st === 'asleep' ? 'an ' : 'a ') + st + ' lead'} is brought up by ${did}`, `${did} master`,
       r.threw ? `threw: ${r.threw}` : `${r.started} ${r.lead}`);
    const ran = h.ranSince(mh).filter(l => l.startsWith(cmd + ' '));
    is(`...the ${cmd} ran once, on the machine that has ${name}`, 1, ran.length);
    // The start names the project and nothing else: no path ever reaches fleet-project.
    if (st === 'none') is('...as a start of that project by name, never an add of a path', true, /^fleet-project \[start\] \[[^\]/]+\] \[--profile\] \[work\]/.test(ran[0] || ''));
    is('...nothing ran on the other machine', 0, other.ranSince(mo).length);
    is('...and the lead is up', 'up', h.get(name));
  }
  h.set(name, 'up');
  const m = h.mark();
  const r = await tryLead(project);
  is(`${where}: a lead already up is left alone`, 'null master', r.threw ? `threw: ${r.threw}` : `${r.started} ${r.lead}`);
  is('...and nothing was run for it', 0, h.ranSince(m).length);
}

// ── a failure says why, on the phone, never a silent success ─────────────────────────
// The reopen that cannot happen: the real fleet-restart refuses a record with no
// conversation id on stderr with exit 1, and the daemon used to drop that status.
B.set('toolbox', 'lost'); B.failWith('toolbox', 'no recorded conversation for \'master\' — nothing to reopen');
let r = await tryLead('toolbox@vm');
is('through the pairing: a reopen that fails is an error on the phone', true, !!r.threw);
is('...naming the reason the vm gave', true, /no recorded conversation for 'master'/.test(r.threw || ''));
is('...and the lead is still lost, not drawn as ready', 'lost', B.get('toolbox'));
B.set('toolbox', 'asleep'); B.failWith('toolbox', "FAILED — 'master' exited during the settle window");
r = await tryLead('toolbox@vm');
is('through the pairing: a wake that fails says why', true, /exited during the settle window/.test(r.threw || ''));
B.set('toolbox', 'none'); B.failWith('toolbox', 'could not start master');
r = await tryLead('toolbox@vm');
is('through the pairing: a start that fails says why', true, /could not start master/.test(r.threw || ''));
B.failWith('toolbox', null);
A.set('acme-api', 'lost'); A.failWith('acme-api', "no recorded conversation for 'master' — nothing to reopen");
r = await tryLead('acme-api');
is('here: a reopen that fails is an error too, not "the lead is ready"', true, /no recorded conversation/.test(r.threw || ''));
A.failWith('acme-api', null); A.set('acme-api', 'up');

// ── a start never begins a new conversation over one that can come back ──────────────
// Asked directly, not through lead.js, which would have picked the right verb: this is the
// daemon's own check, the one a stale card or another client would meet.
for (const [st, verb] of [['lost', 'fleet_reopen'], ['asleep', 'fleet_wake'], ['parked', 'fleet_resume']]) {
  B.set('toolbox', st);
  const m = B.mark();
  r = await pa.verb(A.base, 'fleet_lead_start', { project: 'toolbox@vm' });
  is(`a start over ${st === 'asleep' ? 'an' : 'a'} ${st} lead is refused, naming ${verb}`, `400 false ${verb}`,
     `${r.status} ${r.json && r.json.ok} ${((r.json && r.json.text) || '').match(/fleet_\w+/)?.[0] || r.text.slice(0, 120)}`);
  is('...and nothing was started', 0, B.ranSince(m).filter(l => l.startsWith('fleet-project')).length);
}
B.set('toolbox', 'up');
r = await pa.verb(A.base, 'fleet_lead_start', { project: 'toolbox@vm' });
is('a start of a lead already running is a no-op, said so', true, r.status === 200 && /already running/.test((r.json && r.json.text) || ''));
B.set('toolbox', 'unreadable');
r = await pa.verb(A.base, 'fleet_lead_start', { project: 'toolbox@vm' });
is('a start whose fleet cannot be read is refused rather than guessed', true, r.status >= 400 && /could not read/.test((r.json && r.json.text) || ''));
B.set('toolbox', 'up');

// ── what a start over the pairing cannot reach ──────────────────────────────────────
const before = B.mark() + A.mark();
r = await pa.verb(A.base, 'fleet_lead_start', { project: 'billing-svc@vm' });
is('a start of a project the vm keeps from paired machines: answered as one it never had', true,
   r.status === 400 && /unknown project 'billing-svc'/.test((r.json && r.json.text) || ''));
r = await pa.verb(A.base, 'fleet_lead_start', { project: 'nope@vm' });
is('a start of a project the vm does not have is refused', true, r.status === 400 && /unknown project 'nope'/.test((r.json && r.json.text) || ''));
r = await pa.verb(A.base, 'fleet_lead_start', { project: 'toolbox@vm', path: path.join(T, 'elsewhere') });
is('a start carries no path', true, r.status === 400 && /unknown argument 'path'/.test((r.json && r.json.text) || ''));
r = await pa.verb(A.base, 'fleet_project_add', { path: path.join(B.dir, 'toolbox'), name: 'toolbox@vm', start: true }, await pa.fresh(A.base, 'add'));
is('an add (which takes a path) still does not cross', true, r.status === 400);
is('...and none of these ran anything on either machine', 0, B.mark() + A.mark() - before);
const { pairAllows } = await import(path.join(RT, 'bin', 'fleet-serve.mjs'));
is('the pair scope: reopen and start cross, add and spawn do not', 'true true false false',
   ['fleet_reopen', 'fleet_lead_start', 'fleet_project_add', 'fleet_spawn'].map(tool => pairAllows('POST', '/api/verb', { tool })).join(' '));

// ── both audit logs say what happened ───────────────────────────────────────────────
const bAudit = B.audit_();
const bReopen = bAudit.filter(a => a.verb === 'fleet_reopen' && a.via === 'pair');
is('the vm audits each reopen it ran for the pairing', true, bReopen.length >= 2);
is('...a failed one as failed, with its reason', true, bReopen.some(a => a.result === 'failed' && /no recorded conversation/.test(a.output || '')));
is('...and a start refused over a lost lead as refused', true,
   bAudit.some(a => a.verb === 'fleet_lead_start' && a.result === 'refused' && /fleet_reopen/.test(a.output || '')));

// ── the phone's page, through the pairing: a lost lead, Reopen, ready ────────────────
// The real client in headless Chrome at a phone's size, on the machine the phone talks to
// (local trust on, so no passkey ceremony is needed to look), opened on the vm's project.
let launch = null;
try { ({ launch } = await import(pathToFileURL(path.join(SRC, 'lib', 'browser.mjs')).href)); } catch {}
if (process.env.PAIR_LEAD_NO_BROWSER || !launch) {
  rows.push(`#SKIP${US}the phone's project page reopening a lost lead through the pairing${US}${launch ? 'PAIR_LEAD_NO_BROWSER' : 'no lib/browser.mjs'}`);
} else {
  fs.writeFileSync(A.trust, 'on\n');
  B.set('toolbox', 'lost');
  const shots = process.env.PAIR_LEAD_SHOTS || '';
  const shot = async (n) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, n + '.png'), Buffer.from(data, 'base64'));
  };
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; do { const v = await fn().catch(() => false); if (v) return v; await sleep(120); } while (Date.now() < end); return false; };
  try {
    browser = await launch({ width: 390, height: 844, scale: 2, mobile: true });
    await browser.call('Network.enable');
    await browser.call('Network.setBypassServiceWorker', { bypass: true });
    await browser.call('Page.navigate', { url: `${A.base}/#/p/${encodeURIComponent('toolbox@vm')}` });
    // The header's button, by its four labels: the master card and the tree row say "lead" too.
    const btn = () => browser.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim())
      .find(t => /^(Start|Reopen|Wake|Resume) the lead$/.test(t)) || '');
    const offered = await until(async () => /Reopen the lead/.test(await btn()));
    is('the phone\'s page offers to reopen the vm\'s lost lead', 'Reopen the lead', offered ? 'Reopen the lead' : `button: ${await btn()}`);
    await sleep(300);
    await shot('pair-lead-lost');
    await browser.evaluate(() => { [...document.querySelectorAll('button')].find(b => /Reopen the lead/.test(b.textContent))?.click(); });
    const ready = await until(() => browser.evaluate(() => /The lead is ready\./.test(document.body.innerText)));
    is('...a tap reopens it through the pairing and says it is ready', true, !!ready);
    is('...on the vm', 'up', B.get('toolbox'));
    const gone = await until(async () => !(await btn()), 6000);
    is('...and the button is gone, the lead being up', true, !!gone);
    await sleep(200);
    await shot('pair-lead-reopened');
    // The failure, on the same page: the reason is on the screen.
    B.set('toolbox', 'lost'); B.failWith('toolbox', "no recorded conversation for 'master' — nothing to reopen");
    await until(async () => /Reopen the lead/.test(await btn()));
    await browser.evaluate(() => { [...document.querySelectorAll('button')].find(b => /Reopen the lead/.test(b.textContent))?.click(); });
    const said = await until(() => browser.evaluate(() => /Could not start the lead:.*no recorded conversation/.test(document.body.innerText)));
    is('...and a reopen that fails puts its reason on the phone', true, !!said);
    await sleep(200);
    await shot('pair-lead-failed');
    B.failWith('toolbox', null);
  } catch (e) {
    if (/no chrome:/.test(String(e))) rows.push(`#SKIP${US}the phone's project page reopening a lost lead through the pairing${US}no chrome installed`);
    else is('the phone\'s page ran to completion', '', String(e.stack || e).split('\n').slice(0, 2).join(' '));
  }
}
await finish(0);
