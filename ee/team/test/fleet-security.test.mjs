import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-fleet-security-'));
fs.mkdirSync(path.join(home, 'mcp')); fs.mkdirSync(path.join(home, 'lib'));
const project = { name: 'acme-api', sock: 'cf-acme-api', cfg: path.join(home, 'cfg'), path: home, profile: 'work' };
fs.writeFileSync(path.join(home, 'mcp', 'fleet-dispatch.mjs'), `
export const calls = [];
export const projects = () => [${JSON.stringify(project)}];
export async function callToolAsync(name, args, opts) { calls.push({ name, args, opts }); return 'ok'; }
`);
fs.writeFileSync(path.join(home, 'lib', 'permission-dialog.mjs'), 'export const promptSummary = () => null;\n');
process.env.GHOSTFLEET_HOME = home;
const fleet = await import('../server/fleet.mjs');
const dispatch = await import(path.join(home, 'mcp', 'fleet-dispatch.mjs'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('only fleet_answer can request owner authority from the dispatcher', async () => {
  for (const tool of ['fleet_send', 'fleet_resume', 'fleet_answer']) {
    await fleet.act(tool, { project: 'acme-api', session: 'master', prompt: 'member prompt' });
    const c = dispatch.calls.at(-1);
    assert.equal(c.opts.human, tool === 'fleet_answer', `${tool}: human becomes --owner on fleet_send`);
  }
});

test('pane reads only a listed literal session, with UTF-8 enabled', async t => {
  const calls = [];
  t.mock.method(cp, 'execFile', (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    cb(null, args.includes('list-sessions') ? 'master\nonboarding\n+master\na.b\na:b\na=b\na{b\na}b\na-b\n' : 'pane', '');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await fleet.pane('acme-api', 'onboarding')).pane, 'pane');
  assert.ok(calls.some(c => c.args.includes('list-sessions')), 'a fresh session list is read');
  assert.ok(calls.every(c => c.args.includes('-u')));
  for (const name of ['missing', '+master', '-master', 'a:b', 'a.b', 'a=b', 'a{b', 'a}b', 'a-b']) {
    const before = calls.filter(c => c.args.includes('capture-pane')).length;
    await assert.rejects(async () => fleet.pane('acme-api', name), e => e.status === 404, name);
    assert.equal(calls.filter(c => c.args.includes('capture-pane')).length, before, name);
  }
});

test('schedule cancellation verifies process identity before sending any signal', async t => {
  const signals = [], started = 'Mon Nov  9 12:00:00 2026';
  let currentStart = started, command = `bash ${home}/bin/fleet-schedule cf-acme-api master 1900000000 continue`;
  t.mock.method(cp, 'execFileSync', (cmd, args) => {
    assert.equal(cmd, 'ps'); return args.includes('lstart=') ? currentStart : command;
  });
  t.mock.method(process, 'kill', (...args) => { signals.push(args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const dir = path.join(project.cfg, 'fleet'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cf-acme-api.master.sched');
  const put = (extra = {}) => fs.writeFileSync(file, JSON.stringify({ at: 1900000000, msg: 'continue', pid: 12345, started, ...extra }));
  put(); currentStart = 'Tue Nov 10 12:00:00 2026';
  fleet.cancelSchedule('acme-api', 'master');
  assert.deepEqual(signals, [], 'a reused PID must not be signalled'); assert.equal(fs.existsSync(file), false);
  put(); currentStart = started; command = 'sleep 100';
  fleet.cancelSchedule('acme-api', 'master'); assert.deepEqual(signals, [], 'another command must not be signalled');
  put({ started: undefined });
  fleet.cancelSchedule('acme-api', 'master'); assert.deepEqual(signals, [], 'legacy records cannot prove identity');
  put(); command = `bash ${home}/bin/fleet-schedule cf-acme-api master 1900000000 continue`;
  fleet.cancelSchedule('acme-api', 'master');
  assert.deepEqual(signals, [[-12345, 'SIGTERM'], [12345, 'SIGTERM']]); assert.equal(fs.existsSync(file), false);
});

test('new schedules persist the process start time used for cancellation', async t => {
  t.mock.method(process, 'kill', () => {});
  t.mock.method(cp, 'execFileSync', () => 'Mon Nov  9 12:00:00 2026\n');
  t.mock.method(cp, 'spawn', () => ({ pid: 23456, unref() {} }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  fleet.schedule('acme-api', 'master', 1900000000, 'continue');
  const m = JSON.parse(fs.readFileSync(path.join(project.cfg, 'fleet', 'cf-acme-api.master.sched')));
  assert.equal(m.started, 'Mon Nov  9 12:00:00 2026');
});
