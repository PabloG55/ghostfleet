#!/usr/bin/env node
// Direct localhost trust, with a scratch HOME, runtime, tmux namespace and headless browser.
// Every refusal includes the same request accepted directly, so blanket denial fails too.
// LOCAL_TRUST_SHOTS saves fixture-only proof outside this helper's disposable runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request, Authenticator } from './serve-client.mjs';
import { launch, sleep } from '../../lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-local-trust-'));
const rows = [];
const address = process.env.LOCAL_TRUST_V6 ? '::1' : '127.0.0.1';
const dual = !!process.env.LOCAL_TRUST_DUAL;
const is = (n, w, g) => rows.push([n, JSON.stringify(w), JSON.stringify(g)].join('\x1f'));
let server, peerServer, browser;
const env = { ...process.env, HOME: path.join(tmp, 'home'), TMUX_TMPDIR: tmp, TMUX: '',
  CLAUDE_FLEET_AWAKE: 'off', CLAUDE_FLEET_EDITOR: '/bin/sh', SHELL: '/bin/sh', ENV: '',
  GHOSTFLEET_SERVE_CONFIG: path.join(tmp, 'serve.json'), GHOSTFLEET_SERVE_AUDIT: path.join(tmp, 'audit.jsonl') };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_FLEET_') && !['CLAUDE_FLEET_AWAKE', 'CLAUDE_FLEET_EDITOR'].includes(k)) delete env[k];
const cfg = path.join(env.HOME, '.config/ghostfleet');
const setting = path.join(cfg, 'local-trust');
const cli = (...args) => execFileSync(process.execPath, [path.join(tmp, 'rt/bin/fleet-serve.mjs'), ...args], { env, encoding: 'utf8' });
const tmux = (...args) => execFileSync('tmux', ['-L', 'cf-acme-api', ...args], { env, stdio: 'pipe' });
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  do { const v = await fn(); if (v) return v; await sleep(80); } while (Date.now() < end);
  return false;
}
try {
  fs.mkdirSync(cfg, { recursive: true });
  const shell = path.join(tmp, 'fixture-shell');
  fs.writeFileSync(shell, "#!/bin/sh\nexport PS1='$ '\nexec /bin/sh -i\n", { mode: 0o755 });
  env.SHELL = shell;
  fs.mkdirSync(path.join(env.HOME, '.claude/fleet'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'acme-api'));
  fs.mkdirSync(path.join(tmp, 'rt'));
  for (const d of ['bin', 'lib', 'mcp', 'mods', 'tmux', 'web']) fs.cpSync(path.join(root, d), path.join(tmp, 'rt', d), { recursive: true });
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(tmp, 'rt/install.sh'));
  if (process.env.LOCAL_TRUST_BASELINE) {
    for (const file of ['bin/fleet-serve.mjs', 'web/api.js', 'web/phone.js', 'install.sh'])
      fs.writeFileSync(path.join(tmp, 'rt', file), process.env.LOCAL_TRUST_BASELINE === '1' ? execFileSync('git', ['show', 'HEAD:' + file], { cwd: root }) : fs.readFileSync(path.join(process.env.LOCAL_TRUST_BASELINE, file)));
  }
  if (process.env.LOCAL_TRUST_SERVE_SOURCE) fs.copyFileSync(process.env.LOCAL_TRUST_SERVE_SOURCE, path.join(tmp, 'rt/bin/fleet-serve.mjs'));
  fs.writeFileSync(path.join(cfg, 'projects'), `acme-api\t${tmp}/acme-api\twork\n`);
  // A fixture grid keeps screenshots independent of any real session or account.
  fs.writeFileSync(path.join(tmp, 'rt/bin/fleet-grid.mjs'), `// '--json'\nconsole.log(JSON.stringify(${JSON.stringify({ project: 'acme-api', cards: [], free_worktrees: [], sessions: [], counts: { need_you: 0, working: 0, ready: 0, parked: 0, lost: 0, total: 0 } })}));\n`);
  const free = net.createServer();
  await new Promise(r => free.listen(0, address, r));
  const port = free.address().port;
  await new Promise(r => free.close(r));
  const base = `http://${address.includes(':') ? '[' + address + ']' : address}:${port}`, origin = `http://localhost:${port}`;
  cli('init', '--bind', dual ? '::1' : address, '--port', String(port), '--rp-id', dual ? 'box.example.ts.net' : 'localhost', '--origin', dual ? 'https://box.example.ts.net' : origin);
  const c = JSON.parse(fs.readFileSync(env.GHOSTFLEET_SERVE_CONFIG));
  // Tailnet Host is allowed by this fixture listener, so its refusal measures trust/auth,
  // rather than the earlier Host gate (the real second listener also rejects it there).
  c.origins.push('https://box.example.ts.net', origin);
  c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(env.GHOSTFLEET_SERVE_CONFIG, JSON.stringify(c));
  fs.writeFileSync(setting, 'on\n');
  const log = fs.openSync(path.join(tmp, 'server.log'), 'w');
  server = spawn(process.execPath, [path.join(tmp, 'rt/bin/fleet-serve.mjs')], { env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (!await until(() => request(base, 'GET', '/healthz').then(r => r.status === 200, () => false))) throw new Error('scratch server never answered');
  const headers = { host: `localhost:${port}`, origin };
  const call = (method, route, extra = {}, body) => request(base, method, route, { headers: Object.fromEntries(Object.entries({ ...headers, ...extra }).filter(([, v]) => v !== undefined)), body });
  const open = (extra = {}, kind = 'term') => call('POST', '/api/term/open', extra, { project: 'acme-api', kind, cols: 100, rows: 30 });
  const good = await open();
  const accepted = good.status === 200 && !!good.json?.ticket;
  is('local: terminal ticket without an assertion', true, accepted);
  if (dual) {
    const other = await request(`http://[::1]:${port}`, 'POST', '/api/term/open', { headers, body: { project: 'acme-api' } });
    is('localhost headers on the other listener cannot grant local trust', [true, 401, 'passkey'], [accepted, other.status, other.json?.needs]);
  }
  is('local: editor ticket without an assertion', true, (await open({}, 'edit')).status === 200);
  const health = await call('GET', '/api/health');
  is('local: server announces this connection', true, health.json?.local_trust === true);
  is('local: usage needs no passkey', 200, (await call('GET', '/api/usage')).status);
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-headers-info', 'via', 'x-real-ip', 'x-fleet-on-behalf', 'x-proxy-scratch']) {
    const r = await open({ [h]: '' });
    is(`local + ${h}: only direct gets a ticket`, [true, h === 'x-fleet-on-behalf' ? 403 : 401, h === 'x-fleet-on-behalf' ? null : 'passkey'], [accepted, r.status, r.json?.needs ?? null]);
  }
  const tail = await open({ host: 'box.example.ts.net', origin: 'https://box.example.ts.net' });
  is('tailnet Host: only localhost gets a ticket', [true, dual ? 403 : 401, dual ? null : 'passkey'], [accepted, tail.status, tail.json?.needs ?? null]);
  is('foreign Host is refused before auth', [true, 403], [accepted, (await open({ host: 'evil.example' })).status]);
  for (const route of ['/api/term/open', '/api/term/enable', '/api/auth/end', '/api/verb']) {
    is(`${route}: foreign Origin refused, direct accepted`, [true, 403], [accepted, (await call('POST', route, { origin: 'https://evil.example' }, {})).status]);
  }
  const absent = await open({ origin: undefined });
  is('missing Origin cannot use local trust', [true, 401], [accepted, absent.status]);
  const ws = (ticket, extra = {}, run = false) => new Promise((resolve, reject) => {
    const s = net.connect(port, address);
    s.setTimeout(5000, () => { s.destroy(); reject(new Error('upgrade timed out')); });
    s.on('error', reject);
    s.on('connect', () => {
      const h = { ...headers, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...extra };
      s.write(`GET /api/term/ws?ticket=${ticket || 'missing'} HTTP/1.1\r\n` + Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    });
    let status = null, output = '';
    s.on('data', d => {
      if (status === null) {
        status = Number(d.toString().split(' ')[1]);
        if (!run || status !== 101) { s.destroy(); resolve(run ? { status, output: false } : status); return; }
        const command = Buffer.from("printf '\\162\\145\\154\\141\\171\\055\\157\\153\\n'\r");
        const mask = Buffer.from([1, 2, 3, 4]);
        const payload = Buffer.from(command); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        setTimeout(() => s.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, payload])), 400);
      }
      output += d.toString();
      if (output.includes('relay-ok')) { s.destroy(); resolve({ status, output: true }); }
    });
  });
  const upgrade = await ws(good.json?.ticket);
  is('local WebSocket accepts its ticket', 101, upgrade);
  const fresh = await open();
  for (const extra of [{ origin: 'https://evil.example' }, { origin: undefined }, { 'x-forwarded-for': '' }])
    is(`WebSocket ${JSON.stringify(extra)} refused beside direct acceptance`, [101, 403], [upgrade, await ws(fresh.json?.ticket, extra)]);
  const cors = await call('OPTIONS', '/api/term/open', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
  is('no CORS permission on health, refusal or preflight', [true, false], [accepted,
    [health, cors, await call('POST', '/api/term/open', { origin: 'https://evil.example' }, {})].some(r => 'access-control-allow-origin' in r.headers)]);
  fs.writeFileSync(setting, 'off\n');
  const off = await open();
  is('setting off restores passkey auth', [true, 401, 'passkey'], [accepted, off.status, off.json?.needs]);
  is('setting off invalidates local tickets', [101, 403], [upgrade, await ws(fresh.json?.ticket)]);
  fs.unlinkSync(setting);
  is('missing setting defaults to local trust', true, (await open()).status === 200);
  fs.writeFileSync(setting, 'on\n');
  is('terminal device switch is gone', 410, (await call('POST', '/api/term/enable', {}, { on: true })).status);

  const auth = new Authenticator({ rpId: 'localhost', origin, host: headers.host });
  const code = cli('enroll', 'phone').match(/[A-Z0-9]{5}-[A-Z0-9]{5}/)[0];
  const enrolled = await auth.enroll(base, code);
  if (enrolled.status !== 200) throw new Error('fixture passkey did not enroll');
  const remoteHeaders = { 'x-forwarded-for': '100.64.0.9', authorization: `Bearer ${auth.token}` };
  const remoteOpen = (kind = 'term') => open(remoteHeaders, kind);
  const remoteTerm = await remoteOpen();
  is('signed-in remote opens terminal without assertion', true, remoteTerm.status === 200 && !!remoteTerm.json?.ticket);
  is('signed-in remote opens editor without assertion', 200, (await remoteOpen('edit')).status);
  is('remote without token remains locked', [true, 401, 'passkey'], [remoteTerm.status === 200, (await open({ 'x-forwarded-for': '100.64.0.9' })).status, (await open({ 'x-forwarded-for': '100.64.0.9' })).json?.needs]);
  is('remote token upgrades without assertion', 101, await ws(remoteTerm.json?.ticket, { 'x-forwarded-for': '100.64.0.9' }));
  const ending = await remoteOpen();
  await call('POST', '/api/auth/end', remoteHeaders, {});
  is('ticket dies with the exact session that minted it', [200, 401], [remoteTerm.status, await ws(ending.json?.ticket, { 'x-forwarded-for': '100.64.0.9' })]);

  // Two disposable daemons paired with fixture secrets, in this helper's own namespace.
  const peerDir = path.join(tmp, 'peer');
  fs.mkdirSync(path.join(peerDir, 'home/.config/ghostfleet'), { recursive: true });
  fs.mkdirSync(path.join(peerDir, 'home/.claude/fleet'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'toolbox'));
  fs.writeFileSync(path.join(peerDir, 'home/.config/ghostfleet/projects'), `toolbox\t${tmp}/toolbox\twork\n`);
  const peerEnv = { ...env, HOME: path.join(peerDir, 'home'), GHOSTFLEET_SERVE_CONFIG: path.join(peerDir, 'serve.json'), GHOSTFLEET_SERVE_AUDIT: path.join(peerDir, 'audit.jsonl') };
  const pf = net.createServer(); await new Promise(r => pf.listen(0, '127.0.0.1', r));
  const peerPort = pf.address().port; await new Promise(r => pf.close(r));
  execFileSync(process.execPath, [path.join(tmp, 'rt/bin/fleet-serve.mjs'), 'init', '--bind', '127.0.0.1', '--port', String(peerPort), '--rp-id', 'localhost', '--origin', `http://localhost:${peerPort}`], { env: peerEnv, stdio: 'pipe' });
  const pair = { id: 'fixture-pair', key: 'vm', label: 'toolbox', in: 'fixture-secret', out: 'fixture-secret', url: `http://localhost:${peerPort}`, created: 1 };
  fs.writeFileSync(path.join(tmp, 'serve-peers.json'), JSON.stringify({ self: 'acme-api', peers: [pair] }));
  fs.writeFileSync(path.join(peerDir, 'serve-peers.json'), JSON.stringify({ self: 'toolbox', peers: [{ ...pair, label: 'acme-api', key: 'desk', url: origin }] }));
  const peerLog = fs.openSync(path.join(tmp, 'peer.log'), 'w');
  peerServer = spawn(process.execPath, [path.join(tmp, 'rt/bin/fleet-serve.mjs')], { env: peerEnv, stdio: ['ignore', peerLog, peerLog] }); fs.closeSync(peerLog);
  if (!await until(() => request(`http://127.0.0.1:${peerPort}`, 'GET', '/healthz').then(r => r.status === 200, () => false))) throw new Error('paired scratch server never answered');
  await auth.assert(base); remoteHeaders.authorization = `Bearer ${auth.token}`;
  const pairOpen = kind => call('POST', '/api/term/open', remoteHeaders, { project: 'toolbox@vm', kind, cols: 80, rows: 24 });
  const pairTerm = await pairOpen('term');
  is('paired chat caller opens terminal without assertion', true, pairTerm.status === 200 && !!pairTerm.json?.ticket);
  is('paired chat caller opens editor without assertion', 200, (await pairOpen('edit')).status);
  is('paired terminal carries shell output through the home host', { status: 101, output: true }, await ws(pairTerm.json?.ticket, {}, true));
  const pairEnding = await pairOpen('term');
  await call('POST', '/api/auth/end', remoteHeaders, {});
  is('paired ticket dies with its home session', [200, 401], [pairTerm.status, await ws(pairEnding.json?.ticket)]);

  if (process.platform === 'linux' && process.getuid() === 0) {
    // Child owns its socket AFTER setuid, while the daemon stays uid 0. The proc
    // table must select the client tuple rather than the accepted server socket.
    const script = `process.setuid(Number(process.argv[1])); const h=require('http'); h.get({hostname:process.argv[3],port:Number(process.argv[2]),path:'/api/health',headers:{host:'localhost:'+process.argv[2]}},r=>{let b='';r.on('data',d=>b+=d).on('end',()=>console.log(JSON.stringify({status:r.statusCode,local:JSON.parse(b).local_trust===true})))})`;
    const childGet = uid => new Promise((resolve, reject) => {
      const ch = spawn(process.execPath, ['-e', script, String(uid), String(port), address], { env });
      let out = ''; ch.stdout.on('data', d => out += d); ch.on('error', reject);
      ch.on('exit', n => n ? reject(new Error('uid probe failed')) : resolve(JSON.parse(out)));
    });
    is('Linux same uid trusts loopback', { status: 200, local: true }, await childGet(0));
    is('Linux different uid keeps the app lock', [{ status: 200, local: true }, { status: 401, local: false }], [await childGet(0), await childGet(65534)]);
  } else if (process.platform === 'linux') {
    rows.push('#SKIP\x1fLinux different uid\x1fuid 0 not available; different-uid sockets also measured in Docker');
  }


  // Exercise only the installer's setting function, never the installer itself.
  const installFn = fs.readFileSync(path.join(tmp, 'rt/install.sh'), 'utf8').match(/^local_trust_default\(\) \{[\s\S]*?^\}/m)?.[0] || '';
  const installHome = path.join(tmp, 'install-home'); fs.mkdirSync(installHome);
  const installSetting = path.join(installHome, '.config/ghostfleet/local-trust');
  const runDefault = () => { try { execFileSync('bash', ['-c', installFn + '\nlocal_trust_default'], { env: { ...env, HOME: installHome }, stdio: 'pipe' }); return true; } catch { return false; } };
  const installed = runDefault();
  is('installer enables local trust on a new machine', true, installed && fs.readFileSync(installSetting, 'utf8').trim() === 'on');
  fs.mkdirSync(path.dirname(installSetting), { recursive: true }); fs.writeFileSync(installSetting, 'off\n');
  is('installer preserves an existing off choice', [true, 'off'], [runDefault(), fs.readFileSync(installSetting, 'utf8').trim()]);

  if (!process.env.LOCAL_TRUST_NO_BROWSER) {
  browser = await launch({ width: 1280, height: 800, scale: 1, mobile: false });
  await browser.call('Network.enable');
  await browser.call('Network.setBypassServiceWorker', { bypass: true });
  await browser.call('Page.navigate', { url: origin });
  const app = await until(() => browser.evaluate(() => !!document.querySelector('.app')));
  is('1280 localhost opens straight into the app', true, !!app);
  is('1280 localhost has no lock', true, await browser.evaluate(() => !document.querySelector('.auth-card')));
  const shot = async name => {
    if (!process.env.LOCAL_TRUST_SHOTS) return;
    fs.mkdirSync(process.env.LOCAL_TRUST_SHOTS, { recursive: true });
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.LOCAL_TRUST_SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  await until(() => browser.evaluate(() => [...document.querySelectorAll('.side .nav')].some(n => n.textContent.includes('acme-api'))));
  await sleep(400);
  await shot('local-app');
  await browser.evaluate(() => { location.hash = '#/settings'; });
  await sleep(500);
  is('settings has no terminal switch', [true, false], [!!app, await browser.evaluate(() => [...document.querySelectorAll('.main h2')].some(n => n.textContent.trim() === 'Terminal'))]);
  await browser.evaluate(() => { location.hash = '#/p/acme-api/term'; });
  const terminal = await until(() => browser.evaluate(() => !!document.querySelector('.xterm-screen')));
  is('1280 localhost Terminal tab opens without passkey', true, !!terminal);
  await sleep(400);
  await until(() => browser.evaluate(() => !document.querySelector('.main > p.muted')?.textContent.includes('Loading')));
  await shot('local-terminal');
  }
} catch (e) {
  if (process.env.LOCAL_TRUST_SHOTS) {
    fs.mkdirSync(process.env.LOCAL_TRUST_SHOTS, { recursive: true });
    for (const f of ['server.log', 'peer.log']) if (fs.existsSync(path.join(tmp, f))) fs.copyFileSync(path.join(tmp, f), path.join(process.env.LOCAL_TRUST_SHOTS, f));
  }
  if (/no chrome:/.test(String(e))) rows.push('#SKIP\x1fLocal trust browser proof\x1fno chrome installed');
  else is('local-trust helper ran to completion', '', String(e.stack || e).split('\n').slice(0, 2).join(' '));
} finally {
  try { await browser?.close(); } catch {}
  if (peerServer && peerServer.exitCode === null) { peerServer.kill('SIGTERM'); await new Promise(r => peerServer.once('exit', r)); }
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  try { tmux('kill-server'); } catch {}
  try { execFileSync('tmux', ['-L', 'cf-toolbox', 'kill-server'], { env, stdio: 'pipe' }); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(rows.join('\n'));
