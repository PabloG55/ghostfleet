// Two isolated hosts and an in-memory listener; no provider or live session is contacted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Authenticator, request } from './serve-client.mjs';

const SRC = path.resolve(process.argv[2] || new URL('../..', import.meta.url).pathname);
const P = await import(pathToFileURL(path.join(SRC, 'lib/peers.mjs')));
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'login-check.'));
const rows = [], kids = [], hits = [];
const is = (n, w, g) => rows.push([n, JSON.stringify(w), JSON.stringify(g)].join('\x1f'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);
let replyStatus = 200;
const listener = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url });
  // A provider can echo the code in either place; neither may reach a log or error.
  res.writeHead(replyStatus, { location: `/another-path?code=${sentinel}` }); res.end(sentinel);
});
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
const sentinel = 'callback-secret-' + Math.random().toString(36).slice(2);
const rt = path.join(T, 'rt');
for (const d of ['bin', 'lib', 'mcp', 'mods']) fs.cpSync(path.join(SRC, d), path.join(rt, d), { recursive: true });
async function host(id) {
  const dir = path.join(T, id), home = path.join(dir, 'home');
  const cfg = path.join(dir, 'serve.json');
  const env = { ...process.env, HOME: home, TMUX: '', CLAUDE_FLEET_AWAKE: 'off', GHOSTFLEET_PUSH_ALLOW_HTTP: '1',
    GHOSTFLEET_SERVE_CONFIG: cfg, GHOSTFLEET_SERVE_AUDIT: path.join(dir, 'audit'), GHOSTFLEET_AT_MAC_FILE: path.join(dir, 'absent') };
  for (const k of ['CLAUDE_FLEET_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FLEET_SOCK']) delete env[k];
  fs.mkdirSync(path.join(home, '.config/ghostfleet'), { recursive: true });
  const fleet = path.join(home, '.claude/fleet');
  fs.mkdirSync(fleet, { recursive: true });
  const tg = path.join(home, '.config/ghostfleet/telegram'); fs.mkdirSync(tg);
  fs.writeFileSync(path.join(tg, 'config.json'), JSON.stringify({ link: { project: 'acme-api', session: 'master' } }));
  const project = path.join(dir, 'acme-api'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, '.config/ghostfleet/projects'), `acme-api\t${project}\twork\n`);
  const hole = http.createServer(); await new Promise(r => hole.listen(0, '127.0.0.1', r));
  const hp = hole.address().port; await new Promise(r => hole.close(r));
  const cli = (...args) => execFileSync('node', [path.join(rt, 'bin/fleet-serve.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 });
  cli('init', '--bind', '127.0.0.1', '--port', String(hp));
  const c = read(cfg); c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  c.push = { ...c.push, scan: 1, debounce: 0, quiet_after_poll: 0, at_mac_idle: 0 }; fs.writeFileSync(cfg, JSON.stringify(c));
  const code = cli('enroll', 'phone').match(/[A-Z0-9]{5}-[A-Z0-9]{5}/)[0];
  const log = path.join(dir, 'stdout'), err = path.join(dir, 'stderr');
  const child = spawn('node', [`--title=ghostfleet-test:${T}/fleet-serve.mjs`, path.join(rt, 'bin/fleet-serve.mjs')],
    { env, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(err, 'a')] }); kids.push(child);
  const base = `http://localhost:${hp}`;
  for (let i = 0; i < 80; i++) { if ((await request(base, 'GET', '/healthz').catch(() => ({}))).status === 200) break; await sleep(100); }
  const auth = new Authenticator({ rpId: 'localhost', origin: base }); await auth.enroll(base, code);
  fs.writeFileSync(path.join(fleet, 'conv-1234.json'), JSON.stringify({ sock: 'cf-acme-api', slot: 'api-1', cwd: project }));
  return { id, dir, home, fleet, project, env, cli, base, auth, cfg };
}
try {
  const home = await host('home'), remote = await host('remote');
  const pairCode = home.cli('pair', '--as', 'vm').match(/[A-Z0-9]{5}-[A-Z0-9]{5}/)[0];
  remote.cli('pair', home.base, pairCode, '--as', 'laptop');
  const remotePeer = read(path.join(home.dir, 'serve-peers.json')).peers[0];
  const hole = http.createServer(); await new Promise(r => hole.listen(0, '127.0.0.1', r));
  const pushPort = hole.address().port; await new Promise(r => hole.close(r));
  const sub = path.join(T, 'push-sub.json'), pushed = path.join(T, 'push.jsonl');
  const pushChild = spawn('node', [fileURLToPath(new URL('./push-probe.mjs', import.meta.url)), '--port', String(pushPort), '--sub', sub, '--out', pushed],
    { stdio: ['ignore', fs.openSync(path.join(T, 'push-stdout'), 'a'), fs.openSync(path.join(T, 'push-stderr'), 'a')] }); kids.push(pushChild);
  for (let i = 0; i < 80 && !fs.existsSync(sub); i++) await sleep(100);
  await home.auth.api(home.base, 'GET', '/api/push/key');
  const subscription = await home.auth.api(home.base, 'POST', '/api/push/subscribe', read(sub));
  is('home subscribes through existing push route', 201, subscription.status);
  function capture(h = remote, server = 'example', state = 'issued-state') {
    const authorize = new URL('https://auth.example.com/oauth/authorize');
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: 'placeholder', code_challenge: 'placeholder', code_challenge_method: 'S256',
      redirect_uri: `http://localhost:${port}/callback`, state, scope: 'tools' });
    const input = { session_id: 'conv-1234', cwd: h.project, tool_name: `mcp__${server}__authenticate`,
      tool_response: { content: [{ type: 'text', text: server.startsWith('claude_ai_')
        ? 'This is a claude.ai MCP connector. Ask the user to run /mcp and select it to authenticate.'
        : `Ask the user to open this URL in their browser to authorize the example MCP server:\n\n${authorize}\n\nOnce they complete the flow, the server tools will become available automatically.\nIf the browser shows a connection error on the redirect page, ask the user to paste the full URL from the address bar and call complete_authentication with it.` }] } };
    // Exercise the registered command with the real PostToolUse wire shape, not just its parser.
    const before = new Set(files(h.fleet));
    const hook = read(path.join(SRC, 'mods/ghostfleet/hooks/hooks.json')).hooks?.PostToolUse?.[0];
    is('capture matcher includes authenticate', true, !!hook && new RegExp(`^(?:${hook.matcher})$`).test(input.tool_name));
    execFileSync('node', [path.join(SRC, 'mods/ghostfleet/hooks/login-capture.mjs')], { input: JSON.stringify(input), env: h.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const f = files(h.fleet).find(f => !before.has(f) && f.endsWith('.json') && f.includes('/logins/'));
    const r = read(f); is('capture writes a private pending item', 0o600, f ? fs.statSync(f).mode & 0o777 : 0);
    is('capture keeps the session and project', ['api-1', 'conv-1234', 'cf-acme-api', h.project], [r.session, r.session_id, r.sock, r.project]);
    is('capture uses the ten minute fallback', 600000, r.expires - r.created);
    return r;
  }
  const callback = (r, edit = {}) => {
    const u = new URL(`http://localhost:${port}/callback`); u.search = new URLSearchParams({ code: sentinel, state: r.state });
    for (const [k, v] of Object.entries(edit)) { if (k === 'state') u.searchParams.set(k, v); else u[k] = v; } return u.href;
  };
  const post = async (h, r, cb, assertion = true, project = 'acme-api@laptop') => h.auth.verb(h.base, 'fleet_login_finish',
    { project, id: r.id, callback: cb }, assertion ? await h.auth.fresh(h.base, 'finish login') : null);
  const r = capture();
  for (let i = 0; i < 80 && !fs.existsSync(pushed); i++) await sleep(100);
  const pushRows = () => { try { return fs.readFileSync(pushed, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const payload = pushRows()[0]?.payload;
  is('remote pending login pushes to home phone', 'needs-you', payload?.kind);
  is('push opens the pending login cards', 'waiting', payload?.open);
  is('push names server and session only', { project: 'acme-api', session: 'api-1', kind: 'needs-you', server: 'example' }, payload?.sessions?.[0]);
  is('push carries no authorization URL or state', false, JSON.stringify(payload || {}).includes(r.state) || JSON.stringify(payload || {}).includes('http'));
  const notice = read(path.join(remote.home, '.config/ghostfleet/telegram/outbox', `login-${r.id}.json`));
  is('Telegram uses the existing notice outbox', ['asks', 'api-1', 'example needs authorization. Open the fleet app.'], [notice.event, notice.session, notice.text]);
  is('Telegram carries no URL or state', false, JSON.stringify(notice).includes(r.state) || JSON.stringify(notice).includes('http'));
  let list = await home.auth.api(home.base, 'GET', '/api/logins');
  is('remote login appears on home with its host', ['example', 'laptop', 'acme-api@laptop', 'pending'],
    [list.json?.items?.[0]?.server, list.json?.items?.[0]?.host, list.json?.items?.[0]?.project, list.json?.items?.[0]?.status]);
  is('list never exposes callback state or file', false, ['state', 'file', 'port', 'path'].some(k => k in (list.json?.items?.[0] || {})));
  is('first site is warned', true, list.json?.items?.[0]?.first_site);
  for (const [label, edit, why] of [
    ['wrong state', { state: 'wrong' }, 'state mismatch'], ['wrong port', { port: String(port === 65535 ? port - 1 : port + 1) }, 'port mismatch'],
    ['non-localhost', { hostname: 'auth.example.com' }, 'must be localhost'], ['another path', { pathname: '/other' }, 'path mismatch'],
    ['TLS loopback', { protocol: 'https:' }, 'must be localhost'], ['userinfo', { username: 'someone' }, 'must be localhost'],
  ]) {
    const n = hits.length, result = await post(home, r, callback(r, edit));
    is(`${label} refused with reason`, true, result.status === 400 && result.json?.text.includes(why));
    is(`${label} reaches no listener`, n, hits.length);
  }
  for (const [label, cb] of [['malformed', 'not a URL'], ['duplicate state', callback(r) + '&state=issued-state']]) {
    const result = await post(home, r, cb);
    is(`${label} refused`, 400, result.status); is(`${label} reaches no listener`, 0, hits.length);
  }
  let result = await post(home, r, callback(r), false);
  is('home requires a fresh assertion', 401, result.status); is('missing assertion reaches no listener', 0, hits.length);
  const body = { tool: 'fleet_login_finish', args: { project: 'acme-api', id: r.id, callback: callback(r) } };
  result = await request(remote.base, 'POST', '/api/verb', { body });
  is('unsigned remote request refused', 401, result.status); is('unsigned request reaches no listener', 0, hits.length);
  const unsigned = P.signedHeaders(remotePeer, { method: 'POST', pathq: '/api/verb', body: Buffer.from(JSON.stringify(body)), onBehalf: 'phone' });
  delete unsigned['x-fleet-pair-sig'];
  result = await request(remote.base, 'POST', '/api/verb', { body, headers: unsigned });
  is('known pairing without signature refused', 401, result.status); is('missing signature reaches no listener', 0, hits.length);
  const expired = capture(); const ef = path.join(remote.fleet, 'logins', `${expired.id}.json`);
  fs.writeFileSync(ef, JSON.stringify({ ...expired, expires: Date.now() - 1 }));
  result = await post(home, expired, callback(expired));
  is('expired record refused', true, result.status === 400 && result.json?.text.includes('expired')); is('expired reaches no listener', 0, hits.length);
  fs.writeFileSync(path.join(remote.fleet, 'cf-acme-api.pair'), 'hide\n');
  list = await home.auth.api(home.base, 'GET', '/api/logins');
  is('hidden project absent from peer list', 0, list.json?.items?.length);
  result = await post(home, r, callback(r));
  is('hidden project cannot finish from peer', 400, result.status); is('hidden project reaches no listener', 0, hits.length);
  fs.unlinkSync(path.join(remote.fleet, 'cf-acme-api.pair'));
  result = await post(home, r, callback(r));
  is('home assertion finishes remote login', [200, true, 200], [result.status, result.json?.ok, result.json?.status]);
  is('listener gets exactly one correct GET', [{ method: 'GET', url: `/callback?code=${sentinel}&state=${r.state}` }], hits);
  // Never print the sentinel even if this assertion fails.
  rows[rows.length - 1] = ['listener gets exactly one correct GET', 'true', JSON.stringify(hits.length === 1 && hits[0].method === 'GET' && hits[0].url === `/callback?code=${sentinel}&state=${r.state}`)].join('\x1f');
  result = await post(home, r, callback(r));
  is('second use refused', true, result.status === 400 && result.json?.text.includes('used')); is('second use reaches no listener', 1, hits.length);
  const signed = P.signedHeaders(remotePeer, { method: 'POST', pathq: '/api/verb', body: Buffer.from(JSON.stringify(body)), onBehalf: 'phone' });
  await request(remote.base, 'POST', '/api/verb', { body, headers: signed });
  result = await request(remote.base, 'POST', '/api/verb', { body, headers: signed });
  is('replayed signature refused', true, result.status === 401 && result.json?.text.includes('already')); is('replay reaches no listener', 1, hits.length);
  const plugin = capture(remote, 'plugin_toolbox_example');
  is('plugin servers use the same loopback capture', ['plugin_toolbox_example', 'loopback'], [plugin.server, plugin.kind]);
  const connector = capture(remote, 'claude_ai_Example');
  list = await home.auth.api(home.base, 'GET', '/api/logins');
  is('connector lists its settings link', 'https://claude.ai/settings/connectors', list.json?.items?.find(x => x.id === connector.id)?.authorize);
  result = await post(home, connector, callback(r));
  is('connector refuses a paste', true, result.status === 400 && result.json?.text.includes('connector settings')); is('connector reaches no listener', 1, hits.length);
  const local = capture(home);
  result = await post(home, local, callback(local), false, 'acme-api');
  is('local login also requires a fresh assertion', 401, result.status);
  is('missing local assertion reaches no listener', 1, hits.length);
  result = await post(home, local, callback(local), true, 'acme-api');
  is('same route finishes locally', true, result.json?.ok); is('local callback occurs once', 2, hits.length);
  for (const h of [home, remote]) {
    const audit = fs.readFileSync(path.join(h.dir, 'audit'), 'utf8');
    is(`${h.id} audits the login`, true, audit.includes('fleet_login_finish'));
  }
  const auditRows = h => fs.readFileSync(path.join(h.dir, 'audit'), 'utf8').trim().split('\n').map(JSON.parse);
  is('home audits its fresh passkey and proxy destination', true,
    auditRows(home).some(x => x.verb === 'fleet_login_finish' && x.via === 'proxy' && x.host === 'laptop' && x.confirmed === 'passkey'));
  is('remote audits the signed origin and its own login', true,
    auditRows(remote).some(x => x.verb === 'fleet_login_finish' && x.via === 'pair' && x.origin_host === 'vm' && x.origin_client === 'phone' && x.subject === r.id));
  const consumed = read(path.join(remote.fleet, 'logins', `${r.id}.json`));
  is('consumed record drops URL and state', false, 'authorize' in consumed || 'state' in consumed);
  const redirect = capture(); replyStatus = 302;
  result = await post(home, redirect, callback(redirect));
  is('listener HTTP status is reported', [302, false], [result.json?.status, result.json?.ok]);
  is('listener redirect is never followed', 3, hits.length);
  is('HTTP refusal still consumes record', true, read(path.join(remote.fleet, 'logins', `${redirect.id}.json`)).used);
  replyStatus = 200;
  const a = await home.auth.fresh(home.base, 'finish login');
  await home.auth.verb(home.base, 'fleet_login_finish', { project: 'acme-api@laptop', id: expired.id, callback: callback(expired) }, a);
  result = await home.auth.verb(home.base, 'fleet_login_finish', { project: 'acme-api@laptop', id: expired.id, callback: callback(expired) }, a);
  is('home assertion cannot be reused', 401, result.status);
  const again = capture(); list = await home.auth.api(home.base, 'GET', '/api/logins');
  is('previously seen site no longer warned', false, list.json?.items?.find(x => x.id === again.id)?.first_site);
  listener.close();
  result = await post(home, again, callback(again));
  is('gone listener has a safe reason', 'listener gone or timed out', result.json?.text);
  is('gone listener still consumes record', true, read(path.join(remote.fleet, 'logins', `${again.id}.json`)).used);
  await sleep(100);
  is('sentinel absent from every file and both stdout/stderr', [], files(T).filter(f => fs.readFileSync(f).includes(Buffer.from(sentinel))).map(f => path.relative(T, f)));
} catch (e) { console.error(e.stack); process.exitCode = 1; }
finally {
  for (const child of kids) { child.kill('SIGKILL'); await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)); }
  listener.close();
  console.log(rows.join('\n'));
  fs.rmSync(T, { recursive: true, force: true });
}
