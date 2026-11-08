// The AI account (contrato §3): the API key goes in and never comes back out — not in a
// view, not in the activity log, not anywhere in GFW_DATA but its own 0600 file — and each
// profile gets an apiKeyHelper that is ours to add and ours to remove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAiAccount, hint } from '../server/ai-account.mjs';
import { createUsers } from '../server/users.mjs';

const KEY = 'sk-ant-api03-FAKEkeyFAKEkeyFAKEkeyFAKE-Ab9Z';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.mjs');

// GFW_DATA plus two profile config dirs, all under one temp root.
function rig({ codexHelp = '  mcp-server  Start Codex as an MCP server (stdio)\n', demo = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-ai-'));
  const dir = path.join(root, 'data'); fs.mkdirSync(dir);
  const cfg = (p) => path.join(root, `claude-${p}`);
  const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return d; } };
  const writeJson = (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v, null, 2), { mode: 0o600 });
  const audits = [], calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cfg: opts.env?.CLAUDE_CONFIG_DIR });
    if (cmd === 'codex' && args[0] === '--version') return { ok: true, out: 'codex-cli 0.151.0' };
    if (cmd === 'codex' && args[0] === '--help') return { ok: true, out: `Commands:\n  exec  Run\n${codexHelp}` };
    return { ok: true, out: '' };
  };
  const ai = createAiAccount({ dir, demo, readJson, writeJson, exec, audit: (r) => audits.push(r),
    profiles: async () => ['work', 'personal'].map(profile => ({ profile, cfg: cfg(profile) })) });
  // Everything under GFW_DATA except the one file that is meant to hold the key.
  const leaks = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f !== ai.paths.keyFile && fs.readFileSync(f, 'utf8').includes(KEY)) out.push(f);
    } };
    walk(dir);
    return out;
  };
  return { root, dir, cfg, ai, audits, calls, leaks };
}
const ana = { id: 'ana', name: 'Ana', role: 'admin' };
const settingsOf = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));

test('the key is stored 0600 in secrets/ and never returned, audited or written anywhere else', async () => {
  const r = rig();
  const v = await r.ai.act(ana, { action: 'key', key: KEY });
  assert.equal(v.key.set, true);
  assert.equal(v.key.hint, 'sk-…Ab9Z');
  assert.ok(!JSON.stringify(v).includes(KEY), 'the view carries the full key');
  assert.ok(!JSON.stringify(await r.ai.view()).includes(KEY), 'a later GET carries the full key');
  assert.ok(!JSON.stringify(r.audits).includes(KEY), 'the activity log carries the key');
  assert.equal(fs.readFileSync(r.ai.paths.keyFile, 'utf8'), KEY);
  assert.equal(fs.statSync(r.ai.paths.keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(r.ai.paths.keyFile)).mode & 0o777, 0o700);
  assert.deepEqual(r.leaks(), []);
  // The helper is what a profile runs: it has to print exactly the key.
  assert.equal(execFileSync('sh', ['-c', r.ai.paths.helperCmd], { encoding: 'utf8' }), KEY);
});

test('a GFW_DATA path with a quote and a space still gives a helper that runs', async () => {
  const r = rig();
  const odd = path.join(r.root, "it's data"); fs.mkdirSync(odd);
  const ai = createAiAccount({ dir: odd, readJson: () => ({}), writeJson: () => {}, profiles: async () => [], exec: async () => ({ ok: false, out: '' }) });
  await ai.act(ana, { action: 'key', key: KEY });
  assert.equal(execFileSync('sh', ['-c', ai.paths.helperCmd], { encoding: 'utf8' }), KEY);
});

test('something that is not an Anthropic key is refused and nothing is written', async () => {
  const r = rig();
  await assert.rejects(r.ai.act(ana, { action: 'key', key: 'hunter2' }), { status: 400 });
  assert.equal(fs.existsSync(r.ai.paths.keyFile), false);
});

test('shared-subscription needs the warning accepted, and records who and when', async () => {
  const r = rig();
  await assert.rejects(r.ai.act(ana, { action: 'mode', mode: 'shared-subscription' }), { status: 428 });
  await assert.rejects(r.ai.act(ana, { action: 'mode', mode: 'shared-subscription', accept: 'yes' }), { status: 428 });
  const before = Math.floor(Date.now() / 1000);
  const v = await r.ai.act(ana, { action: 'mode', mode: 'shared-subscription', accept: true });
  assert.equal(v.mode, 'shared-subscription');
  assert.equal(v.shared.by, 'ana');
  assert.ok(v.shared.at >= before);
});

test('api-key mode puts OUR apiKeyHelper in every profile, keeps their settings, and takes it back out', async () => {
  const r = rig();
  fs.mkdirSync(r.cfg('work'), { recursive: true });
  fs.writeFileSync(path.join(r.cfg('work'), 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] } }));
  await assert.rejects(r.ai.act(ana, { action: 'mode', mode: 'api-key' }), { status: 400 });   // no key yet
  await r.ai.act(ana, { action: 'key', key: KEY });
  await r.ai.act(ana, { action: 'mode', mode: 'api-key' });
  for (const p of ['work', 'personal']) assert.equal(settingsOf(r.cfg(p)).apiKeyHelper, r.ai.paths.helperCmd);
  assert.equal(settingsOf(r.cfg('work')).model, 'opus');
  assert.ok(!fs.readFileSync(path.join(r.cfg('work'), 'settings.json'), 'utf8').includes(KEY), 'the key itself went into a profile');
  await r.ai.act(ana, { action: 'mode', mode: 'per-user' });
  for (const p of ['work', 'personal']) assert.equal('apiKeyHelper' in settingsOf(r.cfg(p)), false);
  assert.equal(settingsOf(r.cfg('work')).model, 'opus');
});

test('a helper the owner set by hand is never overwritten or removed', async () => {
  const r = rig();
  fs.mkdirSync(r.cfg('work'), { recursive: true });
  fs.writeFileSync(path.join(r.cfg('work'), 'settings.json'), JSON.stringify({ apiKeyHelper: '/opt/vault/get-key' }));
  await r.ai.act(ana, { action: 'key', key: KEY });
  const v = await r.ai.act(ana, { action: 'mode', mode: 'api-key' });
  assert.equal(settingsOf(r.cfg('work')).apiKeyHelper, '/opt/vault/get-key');
  assert.equal(v.applied.steps.find(s => s.profile === 'work').ok, false);
  await r.ai.act(ana, { action: 'mode', mode: 'per-user' });
  assert.equal(settingsOf(r.cfg('work')).apiKeyHelper, '/opt/vault/get-key');
});

test('clearing the key deletes it and leaves api-key mode', async () => {
  const r = rig();
  await r.ai.act(ana, { action: 'key', key: KEY });
  await r.ai.act(ana, { action: 'mode', mode: 'api-key' });
  const v = await r.ai.act(ana, { action: 'clear-key' });
  assert.equal(v.key.set, false);
  assert.equal(v.mode, null);
  assert.equal(fs.existsSync(r.ai.paths.keyFile), false);
  assert.equal(fs.existsSync(r.ai.paths.helper), false);
  assert.equal('apiKeyHelper' in settingsOf(r.cfg('work')), false);
});

test('codex is added with `claude mcp add -s user` in each profile, only when codex lists mcp-server', async () => {
  const r = rig();
  await r.ai.act(ana, { action: 'mcp', name: 'codex', on: true });
  const adds = r.calls.filter(c => c.cmd === 'claude' && c.args[1] === 'add');
  assert.deepEqual(adds.map(c => c.cfg).sort(), [r.cfg('personal'), r.cfg('work')].sort());
  assert.deepEqual(adds[0].args, ['mcp', 'add', '-s', 'user', 'codex', '--', 'codex', 'mcp-server']);

  const old = rig({ codexHelp: '' });                // a codex that dropped the subcommand
  const v = await old.ai.view();
  assert.equal(v.mcp.codex.available, false);
  assert.match(v.mcp.codex.why, /mcp-server/);
  await assert.rejects(old.ai.act(ana, { action: 'mcp', name: 'codex', on: true }), { status: 400 });
  assert.equal(old.calls.some(c => c.cmd === 'claude'), false);
});

test('gemini cannot be switched on: there is no server to run', async () => {
  const r = rig();
  assert.equal((await r.ai.view()).mcp.gemini.available, false);
  await assert.rejects(r.ai.act(ana, { action: 'mcp', name: 'gemini', on: true }), { status: 400 });
});

test('demo touches no profile: the steps are reported as simulated', async () => {
  const r = rig({ demo: true });
  await r.ai.act(ana, { action: 'key', key: KEY });
  const v = await r.ai.act(ana, { action: 'mode', mode: 'api-key' });
  assert.ok(v.applied.steps.every(s => s.simulated));
  assert.equal(fs.existsSync(r.cfg('work')), false);
  assert.equal(r.calls.some(c => c.cmd === 'claude'), false);
});

test('a profile login is read as who and which plan, never a token', async () => {
  const r = rig();
  fs.mkdirSync(r.cfg('work'), { recursive: true });
  fs.writeFileSync(path.join(r.cfg('work'), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'it@acme.example', planDisplayName: 'Max', organizationName: 'Acme' } }));
  fs.writeFileSync(path.join(r.cfg('work'), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRET', refreshToken: 'sk-ant-ort01-SECRET', subscriptionType: 'max' } }));
  const v = await r.ai.view();
  assert.deepEqual(v.profiles.find(p => p.profile === 'work').login, { loggedIn: true, email: 'it@acme.example', plan: 'Max', org: 'Acme' });
  assert.equal(v.profiles.find(p => p.profile === 'personal').login.loggedIn, false);
  assert.ok(!JSON.stringify(v).includes('SECRET'));
});

test('per-user keeps a profile per person and refuses a name that is not a profile', async () => {
  const r = rig();
  const v = await r.ai.act(ana, { action: 'per-user', user: 'beto', profile: 'beto' });
  assert.deepEqual(v.perUser, { beto: 'beto' });
  await assert.rejects(r.ai.act(ana, { action: 'per-user', user: 'beto', profile: '../../etc' }), { status: 400 });
  assert.deepEqual((await r.ai.act(ana, { action: 'per-user', user: 'beto', profile: '' })).perUser, {});
});

test('hint shows only the last four characters', () => {
  assert.equal(hint(KEY), 'sk-…Ab9Z');
});

// Through the real server, in demo mode: what the browser can reach.
test('over HTTP: only an admin reaches it, and no response ever carries the full key', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-ai-http-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  // Accounts come from the console (admin-cli), not from the web: write them the same way.
  const store = createUsers(path.join(data, 'demo'));
  store.add('Ana', 'secreto1', { role: 'admin' });
  store.add('Beto', 'secreto2', { role: 'member', projects: {} });
  const srv = spawn(process.execPath, [SERVER, '--demo'], { env: { ...process.env, GFW_PORT: String(port), GFW_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  let log = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`server did not start: ${log}`)), 15000);
    srv.stdout.on('data', (d) => { log += d; if (log.includes(`127.0.0.1:${port}`)) { clearTimeout(to); resolve(); } });
    srv.stderr.on('data', (d) => { log += d; });
  });
  const base = `http://127.0.0.1:${port}/api`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'X-GFW': '1', 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const anaC = (await call('POST', '/login', { name: 'Ana', password: 'secreto1' })).cookie;
  const betoC = (await call('POST', '/login', { name: 'Beto', password: 'secreto2' })).cookie;

  assert.equal((await call('GET', '/admin/ai', null, betoC)).status, 404);
  assert.equal((await call('POST', '/admin/ai', { action: 'key', key: KEY }, betoC)).status, 404);
  assert.equal((await call('GET', '/admin/ai')).status, 401);

  const seen = [];
  seen.push(await call('POST', '/admin/ai', { action: 'key', key: KEY }, anaC));
  seen.push(await call('POST', '/admin/ai', { action: 'mode', mode: 'api-key' }, anaC));
  seen.push(await call('GET', '/admin/ai', null, anaC));
  seen.push(await call('GET', '/activity?limit=50', null, anaC));
  for (const s of seen) { assert.equal(s.status, 200, s.text); assert.ok(!s.text.includes(KEY), `a response carried the key: ${s.text.slice(0, 200)}`); }
  assert.equal(JSON.parse(seen[2].text).key.hint, 'sk-…Ab9Z');
  assert.ok(!log.includes(KEY), 'the server log carries the key');

  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
  walk(data);
  const holders = files.filter(f => fs.readFileSync(f, 'utf8').includes(KEY));
  assert.deepEqual(holders.map(f => path.relative(data, f)), [path.join('demo', 'secrets', 'anthropic-api-key')]);
  assert.equal(fs.statSync(holders[0]).mode & 0o777, 0o600);
});
