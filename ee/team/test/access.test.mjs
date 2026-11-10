// Roles and per-project access (contract §2): the rule itself, then the same rule as the
// server applies it, end to end, on a demo instance with a temp GFW_DATA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { can, visibleProjects, denial, migrate, TOOL_ACTION, canSeeAutomation } from '../server/access.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.resolve(ROOT, '../../scratch.tmp');
fs.mkdirSync(SCRATCH, { recursive: true });

const admin = { id: 'ana', role: 'admin', projects: {} };
const member = { id: 'beto', role: 'member', projects: { 'acme-api': 'member', 'acme-web': 'viewer', toolbox: 'admin' } };

test('a global admin can do everything, anywhere', () => {
  for (const a of ['read', 'prompt', 'spawn', 'stop', 'assign', 'manage']) assert.equal(can(admin, 'billing-svc', a), true, a);
});

test('a project that is not in the map does not exist for a member', () => {
  for (const a of ['read', 'prompt', 'spawn', 'stop', 'assign', 'manage']) assert.equal(can(member, 'billing-svc', a), false, a);
  assert.deepEqual(denial(member, 'billing-svc', 'prompt')?.status, 404);
});

test('viewer reads; member also prompts, spawns, stops; project admin also assigns and manages', () => {
  const row = (p) => ['read', 'prompt', 'spawn', 'stop', 'assign', 'manage'].map(a => can(member, p, a));
  assert.deepEqual(row('acme-web'), [true, false, false, false, false, false]);
  assert.deepEqual(row('acme-api'), [true, true, true, true, false, false]);
  assert.deepEqual(row('toolbox'), [true, true, true, true, true, true]);
  assert.equal(denial(member, 'acme-web', 'prompt')?.status, 403);
  assert.equal(denial(member, 'acme-api', 'prompt'), null);
});

test('disabled, roleless, unknown action, odd project names: all refused', () => {
  assert.equal(can({ ...admin, disabled: true }, 'acme-api', 'read'), false);
  assert.equal(can({ id: 'x', projects: { 'acme-api': 'admin' } }, 'acme-api', 'read'), false);
  assert.equal(can(member, 'acme-api', 'delete-everything'), false);
  assert.equal(can(member, 'constructor', 'read'), false);
  assert.equal(can(member, '__proto__', 'read'), false);
  assert.equal(can(null, 'acme-api', 'read'), false);
  assert.equal(can({ ...member, projects: { 'acme-api': 'owner' } }, 'acme-api', 'read'), false);
});

test('visibleProjects filters fleet objects and plain names', () => {
  const all = ['acme-api', 'acme-web', 'billing-svc', 'scratch'].map(name => ({ name, sessions: [] }));
  assert.deepEqual(visibleProjects(member, all).map(p => p.name), ['acme-api', 'acme-web']);
  assert.deepEqual(visibleProjects(admin, all).length, 4);
  assert.deepEqual(visibleProjects(member, ['scratch', 'acme-api']), ['acme-api']);
});

test('every fleet verb maps to an action; an unmapped verb is refused', () => {
  for (const [tool, a] of Object.entries(TOOL_ACTION)) assert.ok(['prompt', 'spawn', 'stop'].includes(a), tool);
  assert.equal(can(member, 'acme-api', TOOL_ACTION.fleet_made_up), false);
});

test('automations that name a hidden project are hidden', () => {
  const a = { trigger: { type: 'event', project: '*' }, steps: [{ project: '{proyecto}' }, { project: 'acme-api' }] };
  assert.equal(canSeeAutomation(member, a), true);
  assert.equal(canSeeAutomation(member, { ...a, steps: [{ project: 'billing-svc' }] }), false);
});

test('migration: first becomes admin, the rest member everywhere, once', () => {
  const users = [{ id: 'ana' }, { id: 'beto' }, { id: 'caro' }];
  assert.equal(migrate(users, ['acme-api', 'acme-web']), true);
  assert.equal(users[0].role, 'admin');
  assert.deepEqual(users[1], { id: 'beto', role: 'member', projects: { 'acme-api': 'member', 'acme-web': 'member' }, tokenCap: null, disabled: false });
  assert.equal(users[2].role, 'member');
  // A second start, with a project created since, changes nothing.
  users[1].projects = { 'acme-api': 'viewer' };
  assert.equal(migrate(users, ['acme-api', 'acme-web', 'toolbox']), false);
  assert.deepEqual(users[1].projects, { 'acme-api': 'viewer' });
});

// ── the server, end to end ──────────────────────────────────────────────────────────────
async function boot(dataRoot) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const env = { ...process.env, GFW_DATA: dataRoot, GFW_PORT: String(port) };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs'), '--demo'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`el servidor no arrancó:\n${out}`)), 15000);
    proc.stdout.on('data', d => { out += d; if (out.includes(`:${port}`)) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => { clearTimeout(t); reject(new Error(`el servidor salió (${c}):\n${out}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, jar) => {
    const r = await fetch(base + p, { method, headers: { 'X-GFW': '1', 'Content-Type': 'application/json', ...(jar?.c ? { Cookie: jar.c } : {}) },
                                      body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (jar && c) jar.c = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { proc, call, env };
}

test('server: a member with one project sees only it, and every other door answers 404', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(SCRATCH, 'gfw-access-'));
  let proc;
  t.after(async () => { if (proc) { const ended = once(proc, 'exit'); proc.kill(); await ended; } fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const env = { ...process.env, GFW_DATA: dataRoot };
  const printed = execFileSync(process.execPath, [path.join(ROOT, 'server/admin-cli.mjs'), 'create-admin', 'Ana', '--demo'], { env, encoding: 'utf8' });
  const adminPw = /temporary password: (\S+)/.exec(printed)[1];

  const started = await boot(dataRoot); proc = started.proc;
  const { call } = started;

  // No account creation from the web, at all.
  assert.equal((await call('POST', '/api/setup', { users: [{ name: 'Eve', password: 'xxxxxx' }] })).status, 401);
  assert.equal((await call('POST', '/api/users', { name: 'Eve', password: 'xxxxxx' })).status, 401);

  const A = {}, M = {};
  assert.equal((await call('POST', '/api/login', { name: 'ana', password: adminPw }, A)).status, 200);
  assert.equal((await call('POST', '/api/password', { old: adminPw, new: 'admin-password-123' }, A)).status, 200);
  const made = await call('POST', '/api/admin/users', { name: 'Beto', role: 'member', projects: { 'toolbox': 'member' } }, A);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal((await call('POST', '/api/login', { name: 'beto', password: made.body.password }, M)).status, 200);
  assert.equal((await call('POST', '/api/password', { old: made.body.password, new: 'member-password-123' }, M)).status, 200);

  const mine = (await call('GET', '/api/projects', null, M)).body.projects.map(p => p.name);
  assert.deepEqual(mine, ['toolbox']);
  assert.ok((await call('GET', '/api/projects', null, A)).body.projects.length > 1);

  const send = (project) => call('POST', '/api/act', { tool: 'fleet_send', args: { project, session: 'master', prompt: 'hola' } }, M);
  const other = await send('acme-web');
  assert.equal(other.status, 404, JSON.stringify(other.body));
  assert.equal((await send('toolbox')).status, 200);

  for (const [m, p, b] of [['GET', '/api/grid?project=acme-web'], ['GET', '/api/session?project=acme-web&session=master'],
                           ['GET', '/api/pane?project=acme-web&session=master'], ['POST', '/api/lead', { project: 'acme-web' }],
                           ['POST', '/api/assign', { project: 'acme-web', session: 'master', owner: 'beto' }],
                           ['POST', '/api/attach?project=acme-web&session=master&name=a.txt'],
                           ['GET', '/api/admin/users'], ['POST', '/api/admin/users', { name: 'Eve', role: 'admin' }]])
    assert.equal((await call(m, p, b, M)).status, 404, `${m} ${p}`);
  // Activity shows nothing from projects Beto cannot see.
  const rows = (await call('GET', '/api/activity', null, M)).body.rows;
  assert.ok(rows.every(r => !r.project || r.project === 'toolbox'), JSON.stringify(rows.map(r => r.project)));

  // Disabling ends the open login.
  const id = made.body.user.id;
  assert.equal((await call('POST', '/api/admin/users/update', { id, disabled: true }, A)).status, 200);
  assert.equal((await call('GET', '/api/projects', null, M)).status, 401);
  // The last admin cannot be demoted.
  assert.equal((await call('POST', '/api/admin/users/update', { id: 'ana', role: 'member' }, A)).status, 409);
});

test('server: an installation from before roles is migrated once at start', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(SCRATCH, 'gfw-migrate-'));
  let proc;
  t.after(async () => { if (proc) { const ended = once(proc, 'exit'); proc.kill(); await ended; } fs.rmSync(dataRoot, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dataRoot, 'demo'));
  const { hashPw } = await import('../server/users.mjs');
  const old = (id) => ({ id, name: id, color: 'cyan', ...hashPw('secreto') });
  fs.writeFileSync(path.join(dataRoot, 'demo', 'users.json'), JSON.stringify({ users: [old('ana'), old('beto')] }));
  proc = (await boot(dataRoot)).proc;
  const u = JSON.parse(fs.readFileSync(path.join(dataRoot, 'demo', 'users.json'), 'utf8')).users;
  assert.equal(u[0].role, 'admin');
  assert.equal(u[1].role, 'member');
  assert.deepEqual(Object.keys(u[1].projects).sort(), ['acme-web', 'billing-svc', 'scratch', 'toolbox']);
});
