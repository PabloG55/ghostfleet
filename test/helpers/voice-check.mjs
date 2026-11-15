// Scratch-only integration: real fleet-serve, Telegram daemon, fleet-send queue and
// hook relay. No owner credentials, paired machine, live daemon or model is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { request } from './serve-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.GHOSTFLEET_VOICE_TEST_ROOT || path.join(HERE, '../..'));
const mode = process.argv[2];
const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'voice-check.'));
const RT = path.join(T, 'runtime'), kids = [], servers = [], rows = [];
let bad = false;
const is = (name, want, got) => { rows.push(`${name}\x1f${JSON.stringify(want)}\x1f${JSON.stringify(got)}`); if (JSON.stringify(want) !== JSON.stringify(got)) bad = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const start = Date.now(); while (Date.now() - start < ms) { if (await f()) return true; await sleep(50); } return false; };
const read = (f, d = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const json = f => { try { return JSON.parse(read(f)); } catch { return null; } };
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let env;
function cli(file, args, e = env) { return execFileSync(path.join(RT, 'bin', file), args, { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }); }
function child(file, args, e, log) {
  const fd = fs.openSync(log, 'a');
  const k = spawn('node', [file, ...args], { env: e, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); kids.push(k); return k;
}
async function host(name) {
  const dir = path.join(T, name), home = path.join(dir, 'home'), p = await port();
  fs.mkdirSync(path.join(home, '.config/ghostfleet'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/ghostfleet/local-trust'), 'off\n');
  const e = { ...env, HOME: home, GHOSTFLEET_SERVE_CONFIG: path.join(dir, 'serve.json'), GHOSTFLEET_SERVE_AUDIT: path.join(dir, 'audit.jsonl'),
    GHOSTFLEET_TELEGRAM_DIR: path.join(home, '.config/ghostfleet/telegram'), GHOSTFLEET_AT_MAC_FILE: path.join(dir, 'no-keyboard.json') };
  cli('fleet-serve', ['init', '--bind', '127.0.0.1', '--port', String(p)], e);
  const c = json(e.GHOSTFLEET_SERVE_CONFIG); c.rate = { window: 60, read: 4000, write: 4000, auth: 4000, challenge: 4000 };
  fs.writeFileSync(e.GHOSTFLEET_SERVE_CONFIG, JSON.stringify(c));
  return { dir, home, env: e, base: `http://localhost:${p}`, td: e.GHOSTFLEET_TELEGRAM_DIR, log: path.join(dir, 'serve.log') };
}
async function start(h) {
  h.kid = child(path.join(RT, 'bin/fleet-serve.mjs'), [], h.env, h.log);
  if (!(await until(async () => (await request(h.base, 'GET', '/healthz').catch(() => ({}))).status === 200))) throw new Error('scratch fleet-serve did not start');
}
try {
  for (const d of ['bin', 'mcp', 'lib', 'hooks', 'mods']) fs.cpSync(path.join(SRC, d), path.join(RT, d), { recursive: true });
  env = { ...process.env, TMUX: '', PATH: `${RT}/bin:${process.env.PATH}`, CLAUDE_FLEET_NOTIFIER: 'off', CLAUDE_FLEET_AWAKE: 'off', GHOSTFLEET_TELEGRAM_SERVICE: 'pidfile', GHOSTFLEET_TELEGRAM_POLL: '1' };
  for (const key of Object.keys(env)) if (/^(CLAUDE_|CODEX_|GHOSTFLEET_|XDG_)/.test(key) && !['CLAUDE_FLEET_NOTIFIER', 'CLAUDE_FLEET_AWAKE', 'GHOSTFLEET_TELEGRAM_SERVICE', 'GHOSTFLEET_TELEGRAM_POLL'].includes(key)) delete env[key];
  delete env.CLAUDECODE;
  env.TMUX_TMPDIR = path.join(T, 'tmux'); fs.mkdirSync(env.TMUX_TMPDIR, { mode: 0o700 });
  const h = await host('scratch');
  const ff = path.join(h.home, '.claude/fleet'), project = path.join(h.dir, 'acme-api'), session = path.join(h.dir, 'session'), stub = path.join(T, 'stub');
  for (const d of [ff, project, session, stub, h.td]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(h.home, '.config/ghostfleet/projects'), `acme-api\t${project}\twork\n`);
  const wire = on => fs.writeFileSync(path.join(h.home, '.claude/settings.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: path.join(RT, 'hooks/fleet-event.sh') }] }],
    ...(on ? { PreToolUse: [{ hooks: [{ type: 'command', command: path.join(RT, 'hooks/fleet-telegram-guard.sh') }] }] } : {}) } }));
  wire(true);
  const bot = `7:${crypto.randomBytes(20).toString('hex')}`;
  fs.writeFileSync(path.join(stub, 'token'), bot);
  const keys = path.join(h.home, 'keys'); fs.mkdirSync(keys);
  fs.writeFileSync(path.join(keys, 'token'), bot); fs.writeFileSync(path.join(keys, 'chat'), '4242');
  child(path.join(HERE, 'telegram-stub.mjs'), [stub], h.env, path.join(T, 'stub.log'));
  if (!(await until(() => !!read(path.join(stub, 'port'))))) throw new Error('stub did not start');
  h.env.GHOSTFLEET_TELEGRAM_API = `http://127.0.0.1:${read(path.join(stub, 'port')).trim()}`;
  cli('fleet-telegram', ['link', 'acme-api/master'], h.env);
  cli('fleet-telegram', ['config', 'secret-cmd', 'cat "$HOME/keys/$1"'], h.env);
  cli('fleet-telegram', ['config', 'voice-deadline-ms', '12000'], h.env);
  const tm = (...args) => execFileSync('tmux', ['-L', 'cf-acme-api', ...args], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // All shell data is scratch paths, quoted even if a runner has spaces in TMPDIR.
  const sq = s => `'${s.replaceAll("'", "'\\''")}'`;
  const agentEnv = { HOME: h.home, CLAUDE_CONFIG_DIR: path.dirname(ff), TEST_FLEET_DIR: ff, CLAUDE_FLEET_DIR: ff,
    CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'master', CLAUDE_FLEET_NOTIFIER: 'off', CLAUDE_FLEET_QUEUE_EVERY: '0.2',
    HOOK: path.join(RT, 'hooks/fleet-event.sh'), GUARD: path.join(RT, 'hooks/fleet-telegram-guard.sh'), PATH: env.PATH };
  const command = `env ${Object.entries(agentEnv).map(([k, v]) => `${k}=${sq(v)}`).join(' ')} bash ${sq(path.join(HERE, 'voice-session.sh'))} ${sq(session)}`;
  tm('new-session', '-d', '-x', '220', '-y', '40', '-s', 'master', '-c', project, command); servers.push(() => tm('kill-server'));
  if (!(await until(() => tm('capture-pane', '-p', '-t', 'master').includes('❯')))) throw new Error('stub session did not start');
  let bridge = child(path.join(RT, 'bin/fleet-telegram.mjs'), ['run'], h.env, path.join(h.dir, 'telegram.log'));
  if (!(await until(() => !!read(path.join(h.td, 'daemon.pid'))))) throw new Error('scratch Telegram daemon did not start');
  process.env.GHOSTFLEET_TELEGRAM_DIR = h.td;
  const voice = await import(pathToFileURL(path.join(RT, 'lib/voice.mjs')));
  const token = voice.addDevice('scratch');
  await start(h);
  const ask = (text = 'status', t = token, base = h.base, suffix = '', lang = 'en') => request(base, 'POST', '/api/voice/ask' + suffix,
    { headers: t ? { authorization: `Bearer ${t}` } : {}, body: { text, lang } });
  const prompts = () => fs.readdirSync(session).filter(n => /^prompt\./.test(n)).length;
  const sent = () => read(path.join(stub, 'requests.jsonl')).split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(r => r.method === 'sendMessage' && r.ok !== false);
  const desk = text => cli('fleet-send', ['-s', 'cf-acme-api', '--owner', 'master', text], { ...h.env, CLAUDE_CONFIG_DIR: path.dirname(ff), CLAUDE_FLEET_DIR: ff });
  if (mode === 'auth') {
    is('missing token is 401', 401, (await ask('status', '')).status);
    const wrong = `gfvoice_${crypto.randomBytes(32).toString('base64url')}`;
    is('unknown token is 401', 401, (await ask('status', wrong)).status);
    for (const [method, route] of [['GET', '/api/voice'], ['POST', '/api/voice/hear'], ['GET', '/api/jarvis'], ['POST', '/api/jarvis/hear'], ['POST', '/api/jarvis/confirm']]) {
      is(`${method} ${route} still requires its passkey token`, 401, (await request(h.base, method, route, { ...(method === 'POST' ? { body: {} } : {}) })).status);
      is(`a Siri bearer cannot access ${method} ${route}`, 401, (await request(h.base, method, route, { headers: { authorization: `Bearer ${token}` }, ...(method === 'POST' ? { body: {} } : {}) })).status);
    }
    voice.revokeDevice('scratch');
    is('revoked token is 401', 401, (await ask()).status);
    is('unauthorized requests start no turn', 0, prompts());
    is('unauthorized requests create no inbox', false, fs.existsSync(voice.requestsDir()));
  } else if (mode === 'revoke') {
    is('token works before revoke', 200, (await ask()).status);
    cli('fleet-voice', ['token', 'revoke', 'scratch'], h.env);
    is('same running server rejects immediately after CLI revoke', 401, (await ask()).status);
    const list = cli('fleet-voice', ['token', 'list'], h.env);
    is('list shows device, revoke and last use', true, /scratch\trevoked\tlast use: 20/.test(list));
    is('list never shows token', false, list.includes(token));
    is('only the first request started a turn', 1, prompts());
    let rejected = false;
    try { cli('fleet-voice', ['token', 'add', 'scratch-blocked'], h.env); } catch { rejected = true; }
    is('mint refuses redirected agent output', true, rejected);
    is('a refused mint leaves no credential', false, fs.existsSync(path.join(h.td, 'voice-devices/scratch-blocked.json')));
    if (process.platform === 'darwin') {
      const clipbin = path.join(h.dir, 'clipboard-bin'), cliphash = path.join(h.dir, 'clipboard-digest');
      fs.mkdirSync(clipbin);
      fs.writeFileSync(path.join(clipbin, 'pbcopy'), '#!/usr/bin/env node\nconst fs=require("fs"),crypto=require("crypto"); fs.writeFileSync(process.env.TEST_CLIPBOARD_DIGEST,crypto.createHash("sha256").update(fs.readFileSync(0)).digest("hex"));\n', { mode: 0o755 });
      const output = execFileSync('script', ['-q', '/dev/null', path.join(RT, 'bin/fleet-voice'), 'token', 'add', 'scratch-clipboard'],
        { env: { ...h.env, PATH: `${clipbin}:${h.env.PATH}`, TEST_CLIPBOARD_DIGEST: cliphash }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
      is('terminal mint pipes the token only to pbcopy', json(path.join(h.td, 'voice-devices/scratch-clipboard.json'))?.sha256, read(cliphash));
      is('terminal mint prints no bearer', false, output.includes('gfvoice_'));
      is('terminal mint confirms the clipboard', true, output.includes('Token copied to the clipboard'));
    }
  } else if (mode === 'guard') {
    const r = await ask('hola', token, h.base, '', 'es');
    is('Spanish final comes back to HTTP', 'La sesión está lista.', r.json?.text);
    is('response is JSON for speech text and language', true, String(r.headers['content-type']).startsWith('application/json'));
    is('response chooses Spanish speech', 'es', r.json?.lang);
    is('voice uses the Telegram shell refusal and read allowance', 'Bash 2\nRead 0\n', read(path.join(session, 'tools.1')));
    is('voice carries spoken instructions under the guard prefix', true, read(path.join(session, 'prompt.1')).startsWith('[telegram] [voice] Answer in a few short spoken sentences'));
    wire(false);
    const unwired = await ask();
    is('broken wiring refuses the voice turn', true, /could not deliver/.test(unwired.json?.text));
    is('broken wiring starts no extra turn', 1, prompts());
    wire(true); fs.writeFileSync(path.join(ff, 'cf-acme-api.master.agent'), 'opencode');
    is('unsupported agent is refused', true, /could not deliver/.test((await ask()).json?.text));
    is('unsupported agent starts no extra turn', 1, prompts());
    is('HTTP answer is not also sent to Telegram', 0, sent().length);
  } else if (mode === 'queue') {
    desk('slow desk');
    if (!(await until(() => read(path.join(session, 'prompt.1')).includes('slow desk')))) throw new Error('desk fixture did not run');
    const pending = ask('after desk');
    await sleep(700);
    is('voice has not entered the busy desk turn', 1, prompts());
    is('voice is held in the actual Telegram queue', true, await until(() => read(path.join(ff, 'cf-acme-api.master.queue')).includes(Buffer.from('[telegram]').toString('base64').slice(0, 6)), 1200));
    const r = await pending;
    is('voice receives its own final, never the desk final', 'Answer for turn 2.', r.json?.text);
    is('queued voice is a separate guarded turn', 'Bash 2\nRead 0\n', read(path.join(session, 'tools.2')));
    is('queued prompt says it was held', true, read(path.join(session, 'prompt.2')).includes('held until it ended'));
    is('desk shell was unrestricted', true, read(path.join(session, 'tools.1')).includes('Bash 0'));
    is('one question made exactly one more turn', 2, prompts());
  } else if (mode === 'deadline') {
    cli('fleet-telegram', ['config', 'voice-deadline-ms', '700'], h.env);
    desk('slow desk');
    if (!(await until(() => prompts() === 1))) throw new Error('desk fixture did not run');
    const started = Date.now(), r = await ask('hola', token, h.base, '', 'es');
    is('deadline returns the spoken Telegram fallback', 'La respuesta te llegará por Telegram.', r.json?.text);
    is('deadline runs while queued', true, Date.now() - started < 2500);
    is('deadline does not interrupt or join desk', 1, prompts());
    const got = await until(() => sent().some(r => r.body.text.includes('La sesión está lista.')));
    is('late final reaches Telegram through the outbox', true, got);
    await sleep(500);
    is('exactly one late final', 1, sent().filter(r => r.body.text.includes('La sesión está lista.')).length);
    is('the final is absent from the HTTP answer', false, r.json?.text.includes('La sesión está lista.'));
    cli('fleet-telegram', ['config', 'voice-deadline-ms', '12000'], h.env);
    is('fast final is returned directly', 'Answer for turn 3.', (await ask()).json?.text);
    await sleep(500);
    is('fast final is absent from Telegram', 0, sent().filter(r => r.body.text.includes('Answer for turn 3.')).length);
  } else if (mode === 'leaks') {
    const otherToken = voice.addDevice('scratch-other');
    is('request carrying bearers in dictation completes', 200, (await ask(`status ${token} ${otherToken}`)).status);
    const collect = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? collect(path.join(dir, d.name)) : [path.join(dir, d.name)]);
    const files = collect(h.dir).filter(f => !f.includes('/keys/'));
    is('serve.log was actually written', true, read(h.log).includes('/api/voice/ask -> 200'));
    is('the turn prompt was actually captured', 1, prompts());
    is('the ledger actually recorded the received prompt', true, read(path.join(ff, 'voice-session.ledger')).includes('[telegram]'));
    is('token absent from serve.log, ledgers, transcript, prompts and request storage', 0, files.filter(f => read(f).includes(token)).length);
    is('another device token is also absent from every file', 0, files.filter(f => read(f).includes(otherToken)).length);
    is('stored credentials contain only a hash', true, read(path.join(h.td, 'voice-devices/scratch.json')).includes(voice.digest(token)));
    is('prompt redacts even an accidentally dictated bearer', true, read(path.join(session, 'prompt.1')).includes('<redacted>'));
  } else if (mode === 'cleanup') {
    bridge.kill('SIGTERM');
    if (!(await until(() => bridge.exitCode !== null || bridge.signalCode !== null))) throw new Error('scratch bridge did not stop');
    desk('slow desk');
    if (!(await until(() => prompts() === 1))) throw new Error('desk fixture did not run');
    const now = Date.now(), minute = 60000;
    const old = voice.enqueue('old question', 'es', now - 31 * minute);
    const fresh = voice.enqueue('fresh question', 'en', now + minute);
    const queued = voice.enqueue('held question', 'en', now - 31 * minute);
    const stale = voice.enqueue('expired question', 'en', now - 25 * 60 * minute);
    const corrupt = voice.enqueue('bad record', 'en', now);
    const incomplete = voice.enqueue('incomplete record', 'en', now);
    for (const id of [old, fresh]) {
      fs.writeFileSync(path.join(voice.requestDir(id), 'submitted'), '');
      voice.defer(id, 'en');
    }
    for (const id of [stale, corrupt, incomplete]) {
      const f = path.join(voice.requestDir(id), 'request.json'), age = new Date(now - 25 * 60 * minute);
      if (id === corrupt) fs.writeFileSync(f, '{bad JSON');
      if (id === incomplete) fs.rmSync(f);
      fs.utimesSync(id === incomplete ? voice.requestDir(id) : f, age, age);
    }
    bridge = child(path.join(RT, 'bin/fleet-telegram.mjs'), ['run'], h.env, path.join(h.dir, 'telegram.log'));
    is('old finished request is removed by the daemon tick', true, await until(() => !fs.existsSync(voice.requestDir(old)), 1800));
    // Dispatch follows the sweep: reaching the queue also proves the sweep has
    // finished, rather than inspecting a directory part-way through a remove.
    is('unsubmitted request passes into the real queue', true, await until(() => read(path.join(ff, 'cf-acme-api.master.queue')).includes(queued), 1200));
    is('fresh finished request stays', true, fs.existsSync(voice.requestDir(fresh)));
    let submittedReads = 0;
    const originalRead = fs.readFileSync;
    try {
      fs.readFileSync = function (file, ...args) {
        if (file === path.join(voice.requestDir(fresh), 'request.json')) submittedReads++;
        return originalRead.call(this, file, ...args);
      };
      voice.pendingRequests();
    } finally { fs.readFileSync = originalRead; }
    is('dispatch scans do not parse submitted questions', 0, submittedReads);
    is('recent queued request stays despite its old deadline', true, fs.existsSync(voice.requestDir(queued)));
    is('unsubmitted request beyond the hard age cap is gone', false, fs.existsSync(voice.requestDir(stale)));
    is('corrupt request beyond the hard age cap is gone', false, fs.existsSync(voice.requestDir(corrupt)));
    is('incomplete directory beyond the hard age cap is gone', false, fs.existsSync(voice.requestDir(incomplete)));
    const out = path.join(h.td, 'outbox', `late.${old}.json`);
    fs.writeFileSync(out, JSON.stringify({ reply_to: old, event: 'answered', text: JSON.stringify({ text: 'Respuesta tardía.', lang: 'es' }) }));
    is('answer after pruning reaches Telegram', true, await until(() => sent().some(r => r.body.text === 'Respuesta tardía.')));
    await sleep(500);
    is('late answer is delivered once with its JSON wrapper removed', 1, sent().filter(r => r.body.text === 'Respuesta tardía.').length);
    is('late answer leaves the normal outbox', false, fs.existsSync(out));
  } else if (mode === 'pair') {
    const gateway = await host('toolbox'); await start(gateway);
    const open = cli('fleet-serve', ['pair', '--as', 'scratch'], h.env);
    const code = open.match(/[A-Z0-9]{5}-[A-Z0-9]{5}/)?.[0];
    if (!code) throw new Error('scratch pairing did not open');
    cli('fleet-serve', ['pair', h.base, code, '--as', 'toolbox'], gateway.env);
    const r = await ask('through pair', token, gateway.base, '?host=scratch');
    is('paired host forwards without a passkey', 200, r.status);
    is('reply comes from the turn on the target host', 'Answer for turn 1.', r.json?.text);
    is('target turn is guarded', 'Bash 2\nRead 0\n', read(path.join(session, 'tools.1')));
    is('paired host stores no device token hashes', false, fs.existsSync(path.join(gateway.td, 'voice-devices')));
    is('paired host log never contains bearer', false, read(gateway.log).includes(token));
    const scan = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    is('paired host stores no bearer anywhere', false, scan(gateway.dir).some(f => read(f).includes(token)));
    is('missing token through pair is 401', 401, (await ask('status', '', gateway.base, '?host=scratch')).status);
    voice.revokeDevice('scratch');
    is('target revoke is immediate through pair', 401, (await ask('status', token, gateway.base, '?host=scratch')).status);
    is('forwarding did not start duplicate turns', 1, prompts());
    const P = await import(pathToFileURL(path.join(RT, 'lib/peers.mjs')));
    const peer = P.loadPeers(P.peersFile(gateway.env.GHOSTFLEET_SERVE_CONFIG)).peers[0];
    const chained = await P.peerRequest(peer, { method: 'POST', pathq: '/api/voice/ask?host=toolbox', body: { text: 'status', voice_bearer: token } });
    is('a signed second hop is refused', 403, chained.status);
  } else throw new Error('unknown voice check group');
} catch (e) { console.error(`voice-check: ${e.name}: ${e.message}`); bad = true; }
finally {
  for (const k of kids) { try { k.kill('SIGTERM'); } catch {} }
  for (const stop of servers) { try { stop(); } catch {} }
  await sleep(300);
  for (const k of kids) if (k.exitCode === null && k.signalCode === null) { try { k.kill('SIGKILL'); } catch {} }
  console.log(rows.join('\n'));
  fs.rmSync(T, { recursive: true, force: true });
}
process.exitCode = bad ? 1 : 0;
