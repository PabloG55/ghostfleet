#!/usr/bin/env node
// wake-check — an asleep session woken from the phone, on the machine the phone reaches through a
// pairing, with the real fleet-hibernate and the real fleet-grid doing the waking and the reading.
//
//     node test/helpers/wake-check.mjs [root]      # "name <US> want <US> got" rows
//     WAKE_CHECK_SHOTS=<dir> node …                # also keep the phone's screenshots
//
// `root` is a checkout whose bin/, mcp/, lib/, mods/ and web/ are run; it defaults to this one.
//
// THE SHAPE OF THE FAILURE IT GUARDS: the phone reaches most asleep sessions through a paired
// machine, and the daemon half of that path worked — a wake verb crossed, fleet-hibernate brought
// the session up, both audit logs said so. What did not work was the tap. When the phone moved to
// the shared screens, a tap on an asleep card (or an asleep boat on the board) only opened the
// session's page, so the session stayed asleep and the page had nobody on it; the one wake left
// was an unnamed sun in that page's header, and when it failed its reason was a toast. From the
// phone that is "waking a session does nothing". So the rows here are about what the phone does:
// a tap wakes before it opens, a good wake leaves no Asleep behind, and a failed one says why in
// a sheet and opens nothing. The daemon rows come first, so a red in the client half is not
// mistaken for a path that never worked.
//
// TWO HOSTS, each its own HOME, serve.json, audit log and port: a (the machine the phone is on)
// and b (the vm, with toolbox). b's fleet is a real tmux server under this run's $TMUX_TMPDIR,
// with master up and docs-pass asleep (its marker and a transcript to resume, as hibernation
// leaves them). The agent is a stub on b's PATH that draws Claude's composer, so fleet-hibernate's
// readiness check reads it as up; a file beside it makes the stub die at start with a reason, the
// way an agent whose folder has gone does, which is what the failure rows need.
//
// The daemons, the tmux server and Chrome are this script's own, stopped by the pids and the
// socket it holds — never by pattern.
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
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'wake.'));
if (!process.env.TMUX_TMPDIR) { process.env.TMUX_TMPDIR = path.join(T, 'tx'); fs.mkdirSync(process.env.TMUX_TMPDIR, { mode: 0o700 }); }
let B = null;
const bTmux = (...args) => execFileSync('tmux', ['-L', 'cf-toolbox', ...args], { env: B.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
async function finish(code = 0) {
  try { await browser?.close(); } catch {}
  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch {} }
  try { if (B) bTmux('kill-server'); } catch {}
  console.log(rows.join('\n'));
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => { console.error(String(e && e.stack || e)); finish(1); });
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); finish(1); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; do { const v = await fn().catch(() => false); if (v) return v; await sleep(120); } while (Date.now() < end); return false; };

// ── one runtime, both hosts, and the agent b wakes ───────────────────────────────────
const RT = path.join(T, 'rt');
for (const d of ['bin', 'mcp', 'lib', 'web']) fs.cpSync(path.join(SRC, d), path.join(RT, d), { recursive: true });
fs.mkdirSync(path.join(RT, 'mods', 'ghostfleet'), { recursive: true });
fs.cpSync(path.join(SRC, 'mods', 'ghostfleet', 'hooks'), path.join(RT, 'mods', 'ghostfleet', 'hooks'), { recursive: true });
const STUB = path.join(T, 'stub'); fs.mkdirSync(STUB);
const BAD = path.join(T, 'agent-bad');
fs.writeFileSync(path.join(STUB, '_screen'), `#!/bin/sh
draw() { printf '\\033[2J\\033[H────────\\n❯ \\0337\\n────────\\n  ctx:3%%  auto mode on\\0338'; }
draw
while IFS= read -r line; do draw; done
`, { mode: 0o755 });
fs.writeFileSync(path.join(STUB, 'agent-here'), `#!/bin/sh
[ -e "${BAD}" ] && { echo "agent-here: could not start: $(cat "${BAD}")"; exit 1; }
exec "${STUB}/_screen"
`, { mode: 0o755 });

async function host(id, projects) {
  const dir = path.join(T, id), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'ghostfleet'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/ghostfleet/local-trust'), 'off\n');
  fs.mkdirSync(path.join(home, '.claude', 'fleet'), { recursive: true });
  const lines = [];
  for (const [name, prof] of projects) { fs.mkdirSync(path.join(dir, name), { recursive: true }); lines.push(`${name}\t${path.join(dir, name)}\t${prof}`); }
  fs.writeFileSync(path.join(home, '.config', 'ghostfleet', 'projects'), lines.join('\n') + '\n');
  const port = await freePort();
  const h = { id, dir, home, port, base: `http://localhost:${port}`, log: path.join(dir, 'log'), cfg: path.join(dir, 'serve.json'),
              audit: path.join(dir, 'audit.jsonl'), trust: path.join(home, '.config/ghostfleet/local-trust'), fleet: path.join(home, '.claude', 'fleet') };
  h.env = { ...process.env, HOME: home, TMUX: '', PATH: `${STUB}:${path.join(RT, 'bin')}:${process.env.PATH}`, CLAUDE_FLEET_AWAKE: 'off',
            CLAUDE_FLEET_WAKE_SETTLE: '1', GHOSTFLEET_SERVE_CONFIG: h.cfg, GHOSTFLEET_SERVE_AUDIT: h.audit };
  for (const k of Object.keys(h.env)) if (k.startsWith('CLAUDE_FLEET_') && !['CLAUDE_FLEET_AWAKE', 'CLAUDE_FLEET_WAKE_SETTLE'].includes(k)) delete h.env[k];
  delete h.env.CLAUDE_CONFIG_DIR; delete h.env.TMUX_PANE;
  h.cli = (...args) => { try { return { code: 0, out: execFileSync('node', [path.join(RT, 'bin', 'fleet-serve.mjs'), ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
                          catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  h.cli('init', '--bind', '127.0.0.1', '--port', String(port), '--rp-id', 'localhost', '--origin', h.base);
  const c = JSON.parse(fs.readFileSync(h.cfg, 'utf8'));
  c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(h.cfg, JSON.stringify(c, null, 2));
  h.audit_ = () => { try { return fs.readFileSync(h.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return h;
}
async function start(h) {
  const k = spawn('node', [`--title=ghostfleet-test:${process.env.TMUX_TMPDIR || T}/fleet-serve.mjs`, path.join(RT, 'bin', 'fleet-serve.mjs')],
                  { env: h.env, stdio: ['ignore', fs.openSync(h.log, 'a'), fs.openSync(h.log, 'a')] });
  kids.push(k);
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
B = await host('b', [['toolbox', 'work']]);
// b's fleet, as a fleet has one: its server, and its lead up on the stub agent.
bTmux('new-session', '-d', '-s', 'master', '-x', '100', '-y', '30', `exec ${STUB}/_screen`);
const ID = 'eeeeeeee-1111-1111-1111-000000000002';
const repo = path.join(B.dir, 'toolbox');
const pd = path.join(B.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(pd, { recursive: true });
fs.writeFileSync(path.join(pd, ID + '.jsonl'), '{"type":"user","message":{"role":"user","content":"x"}}\n');
const MARK = path.join(B.fleet, 'cf-toolbox.docs-pass.asleep');
const up = () => { try { bTmux('has-session', '-t', '=docs-pass'); return true; } catch { return false; } };
const marked = () => fs.existsSync(MARK);
// Asleep as hibernation leaves it: no session under the name, a marker naming its conversation.
const asleep = (why = null) => {
  if (why) fs.writeFileSync(BAD, why); else fs.rmSync(BAD, { force: true });
  try { bTmux('kill-session', '-t', '=docs-pass'); } catch {}
  fs.writeFileSync(MARK, `0\t${ID}\t${repo}\t30\n`);
};
asleep();

const ca = (A.cli('enroll', 'phone').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
if (!(await start(A)) || !(await start(B))) {
  is('both daemons come up', 'up', `down: ${fs.readFileSync(A.log, 'utf8').slice(0, 300)} | ${fs.readFileSync(B.log, 'utf8').slice(0, 300)}`);
  await finish(1);
}
const pa = new Authenticator({ rpId: 'localhost', origin: A.base });
await pa.enroll(A.base, ca);
const pcode = (A.cli('pair', '--as', 'laptop').out.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
is('the two hosts pair', 0, B.cli('pair', A.base, pcode, '--as', 'vm').code);
const card = async (name) => ((await pa.api(A.base, 'GET', `/api/grid?project=${encodeURIComponent('toolbox@vm')}&fresh=1`)).json?.cards || []).find(c => c.name === name);

// ── the daemon half: a wake crosses the pairing and the real fleet-hibernate does it ──────
let c = await card('docs-pass');
is('through the pairing, the vm\'s docs-pass is an asleep card', 'asleep', c ? (c.asleep ? 'asleep' : `not asleep: ${c.status}`) : 'no card');
let r = await pa.verb(A.base, 'fleet_wake', { project: 'toolbox@vm', session: 'docs-pass' });
is('a wake through the pairing is a 200', '200 true', `${r.status} ${r.json && r.json.ok}${r.json && !r.json.ok ? ' ' + r.json.text : ''}`);
is('...the session is up on the vm', true, up());
is('...and its asleep marker is gone', false, marked());
c = await card('docs-pass');
is('...so the card read back through the pairing is no longer asleep', false, c ? !!c.asleep : 'no card');
const viaPair = B.audit_().filter(a => a.verb === 'fleet_wake' && a.via === 'pair');
const viaProxy = A.audit_().filter(a => a.verb === 'fleet_wake' && a.via === 'proxy');
is('...audited on the vm as the pairing\'s', 1, viaPair.length);
is('...and on the laptop as the proxy\'s', 1, viaProxy.length);

asleep('the folder is gone');
r = await pa.verb(A.base, 'fleet_wake', { project: 'toolbox@vm', session: 'docs-pass' });
const why = (r.json && r.json.text) || '';
is('a wake that fails through the pairing is an error, never a 200', '400 false', `${r.status} ${r.json && r.json.ok}`);
is('...that says why, in the agent\'s own last line', true, /could not start: the folder is gone/.test(why));
is('...and that it can be woken again', true, /still asleep, so it can be woken again/.test(why));
is('...without fleet-hibernate\'s FAILED prefix, which the daemon strips', false, /^fleet-hibernate: FAILED/m.test(why));
is('...it stays asleep: the marker is kept and nothing runs under its name', 'true false', `${marked()} ${up()}`);

// ── the client half: the phone's own pages, through the pairing ─────────────────────────
// The real client in headless Chrome, on the machine the phone talks to (local trust on, so no
// passkey ceremony stands between the tap and the verb), opened on the vm's project.
let launch = null;
try { ({ launch } = await import(pathToFileURL(path.join(SRC, 'lib', 'browser.mjs')).href)); } catch {}
if (process.env.WAKE_CHECK_NO_BROWSER || !launch) {
  rows.push(`#SKIP${US}the phone waking an asleep session through the pairing${US}${launch ? 'WAKE_CHECK_NO_BROWSER' : 'no lib/browser.mjs'}`);
  await finish(0);
}
fs.writeFileSync(A.trust, 'on\n');
const shots = process.env.WAKE_CHECK_SHOTS || '';
const shot = async (n) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, n + '.png'), Buffer.from(data, 'base64'));
};
const P = `#/p/${encodeURIComponent('toolbox@vm')}`, S = `${P}/s/docs-pass`;
const go = async (hash) => { await browser.evaluate((h) => { location.hash = h; }, hash); await sleep(150); };
const hash = () => browser.evaluate(() => location.hash);
// The card for docs-pass on the project page, as a reader sees it: its pill's word and whether it
// is busy. Found by its name, so the tree's row of the same name is not it.
const cardSays = () => browser.evaluate(() => {
  const el = [...document.querySelectorAll('article.card')].find(a => a.querySelector('h3')?.firstChild?.textContent === 'docs-pass');
  return el ? `${el.querySelector('.pill')?.textContent.trim()}${el.getAttribute('aria-busy') === 'true' ? ' (busy)' : ''}` : '';
});
const tapCard = () => browser.evaluate(() => {
  [...document.querySelectorAll('article.card')].find(a => a.querySelector('h3')?.firstChild?.textContent === 'docs-pass')?.click();
});
// Measured once its slide-in has finished (ui.css sheet-up): mid-animation it sits up to 24 px
// lower than where it rests.
const sheet = () => browser.evaluate(async () => {
  const d = document.querySelector('[role=dialog]');
  if (!d) return null;
  await Promise.all(d.getAnimations({ subtree: true }).map(a => a.finished.catch(() => null)));
  const b = d.getBoundingClientRect();
  return { title: d.getAttribute('aria-label') || '', text: d.innerText, sheet: d.classList.contains('sheet'),
           bottom: Math.round(innerHeight - b.bottom), left: Math.round(b.left), right: Math.round(innerWidth - b.right) };
});
const toastSays = () => browser.evaluate(() => [...document.querySelectorAll('.toast')].map(n => n.innerText).join(' | '));
// Waits for the sheet, and keeps every toast it saw on the way: a failure that was a toast is gone
// seven seconds later, so a look at the end would find no toast whatever the client did.
const sheetOrToast = async (ms = 30000) => {
  const seen = new Set(), end = Date.now() + ms;
  do {
    const t = await toastSays().catch(() => '');
    if (t) seen.add(t);
    const s = await sheet().catch(() => null);
    if (s) return { s, toasts: [...seen].join(' | ') };
    await sleep(120);
  } while (Date.now() < end);
  return { s: null, toasts: [...seen].join(' | ') };
};
const button = (word) => browser.evaluate((w) => !![...document.querySelectorAll('button')]
  .find(b => b.getAttribute('aria-label') === w || b.textContent.trim() === w), word);
const press = (word) => browser.evaluate((w) => { [...document.querySelectorAll('button')]
  .find(b => b.getAttribute('aria-label') === w || b.textContent.trim() === w)?.click(); }, word);
try {
  browser = await launch({ width: 390, height: 844, scale: 2, mobile: true });
  await browser.call('Network.enable');
  await browser.call('Network.setBypassServiceWorker', { bypass: true });

  // A tap on the asleep card wakes it, says so while the wake is out, and opens it once it is up.
  asleep();
  await browser.call('Page.navigate', { url: `${A.base}/${P}` });
  is('the phone\'s project page draws the vm\'s docs-pass as Asleep', 'Asleep', await until(async () => (await cardSays()) === 'Asleep' && 'Asleep') || await cardSays());
  await shot('390-asleep');
  await tapCard();
  let busy = false, openedUp = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (/busy/.test(await cardSays())) busy = true;
    if ((await hash()) === S) { openedUp = up(); break; }
    await sleep(80);
  }
  is('a tap on the asleep card wakes it through the pairing', true, up());
  is('...the card says Starting while the wake is out', true, busy);
  is('...and the session opens once the vm says it is up', true, openedUp);
  is('...its marker gone on the vm', false, marked());
  const awake = await until(async () => !(await button('Wake')) && (await browser.evaluate(() => !!document.querySelector('.sess-meta .pill, .session .pill'))), 8000);
  is('...the page it opens is the awake session, with no Wake left to press', true, !!awake);
  await go(P);
  const left = await until(async () => { const s = await cardSays(); return s && s !== 'Asleep' && !/busy/.test(s) && s; }, 8000);
  is('...and the card it left behind is no longer Asleep', 'not Asleep', left ? 'not Asleep' : await cardSays());
  await shot('390-woken');

  // A tap whose wake fails opens nothing, and the bottom sheet says why.
  asleep('the folder is gone');
  await until(async () => (await cardSays()) === 'Asleep', 8000);
  await tapCard();
  const { s: s1, toasts: t1 } = await sheetOrToast();
  is('a tap whose wake fails opens the wake\'s sheet', 'Could not wake docs-pass', s1 ? s1.title : `none; toasts: ${t1}`);
  is('...saying why, in the agent\'s own last line', true, !!s1 && /could not start: the folder is gone/.test(s1.text));
  is('...docked to the bottom of a phone, its full width', 'sheet 0 0 0', s1 ? `${s1.sheet ? 'sheet' : 'dialog'} ${s1.bottom} ${s1.left} ${s1.right}` : 'none');
  is('...the session was not opened', P, await hash());
  is('...and the reason is not a toast', '', t1.includes('the folder is gone') ? t1 : '');
  is('...it is still asleep on the vm', 'true false', `${marked()} ${up()}`);
  await shot('390-failed-sheet');
  // Try again, once the cause is gone: the wake runs again from the sheet and the session opens.
  fs.rmSync(BAD, { force: true });
  await press('Try again');
  is('the sheet\'s Try again wakes it and opens it', `${S} true`, await until(async () => (await hash()) === S && `${S} ${up()}`, 30000) || `${await hash()} ${up()}`);
  is('...and the sheet has gone', null, await sheet());

  // The session page's own Wake, failing: the same sheet, not a toast.
  asleep('the folder is gone');
  await go(P); await go(S);
  await until(() => button('Wake'), 10000);
  await press('Wake');
  const { s: s2, toasts: t2 } = await sheetOrToast();
  is('the session page\'s Wake that fails opens the same sheet', 'Could not wake docs-pass', s2 ? s2.title : `none; toasts: ${t2}`);
  is('...and not a toast', '', t2.includes('the folder is gone') ? t2 : '');

  // At a desk's width the same failure is a centred dialog, not a sheet docked to the bottom.
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const s3 = await sheet();
  is('at a desk\'s width the same failure is a centred dialog', true,
     !!s3 && s3.bottom > 16 && Math.abs(s3.left - s3.right) <= 2 && s3.left > 16);
  await shot('1280-failed-dialog');
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await press('Close');

  // The board: an asleep boat on the other machine is drawn as off, and a tap on it wakes it.
  asleep();
  await go('#/');
  const boat = () => browser.evaluate(() => {
    const a = [...document.querySelectorAll('a.fboat')].find(x => /\/s\/docs-pass$/.test(x.getAttribute('href') || ''));
    return a ? ([...a.classList].find(k => k.startsWith('lk-')) || 'no look') : '';
  });
  is('the board draws the vm\'s asleep session as off, not as a warning', 'lk-off', await until(async () => (await boat()) === 'lk-off' && 'lk-off', 20000) || await boat());
  await browser.evaluate(() => { [...document.querySelectorAll('a.fboat')].find(x => /\/s\/docs-pass$/.test(x.getAttribute('href') || ''))?.click(); });
  is('...a tap on that boat wakes it and then opens it', `${S} true`, await until(async () => (await hash()) === S && `${S} ${up()}`, 30000) || `${await hash()} ${up()}`);
} catch (e) {
  if (/no chrome:/.test(String(e))) rows.push(`#SKIP${US}the phone waking an asleep session through the pairing${US}no chrome installed`);
  else is('the phone\'s pages ran to completion', '', String(e.stack || e).split('\n').slice(0, 2).join(' '));
}
await finish(0);
