import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createUsers, hashPw } from '../../server/users.mjs';

export const password = 'demo-password-123';
export async function rig(t) {
  const scratch = new URL('../../../../scratch.tmp/', import.meta.url).pathname;
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'gfw-security-'));
  const dir = path.join(root, 'demo'); fs.mkdirSync(dir);
  const users = createUsers(dir);
  for (const role of ['admin', 'member', 'viewer']) users.add(role, password, { role: role === 'admin' ? 'admin' : 'member', projects: { 'acme-web': role === 'viewer' ? 'viewer' : 'member' } });
  users.add('scratch', password, { projects: { 'acme-web': 'member' } }).mustChange = true; users.save();
  // An old short password remains valid until changed.
  Object.assign(users.find('member'), hashPw('oldpass')); users.save();
  const callsFile = path.join(root, 'calls'), clock = path.join(root, 'clock'), portFile = path.join(root, 'port');
  fs.writeFileSync(callsFile, ''); fs.writeFileSync(clock, '0');
  const voiceDir = path.join(root, 'piper');
  fs.mkdirSync(path.join(voiceDir, 'voices'), { recursive: true });
  const model = path.join(voiceDir, 'voices', 'es_ES-carlfm-x_low.onnx');
  fs.writeFileSync(model, 'keep'); fs.writeFileSync(`${model}.json`, 'keep');
  const child = spawn(process.execPath, ['--import', new URL('./demo-preload.mjs', import.meta.url).pathname,
    new URL('../../server/index.mjs', import.meta.url).pathname, '--demo', '--port', '0'], {
    env: { ...process.env, GFW_DATA: root, GFW_PIPER_DIR: voiceDir, TEST_CALLS: callsFile, TEST_CLOCK: clock, TEST_PORT: portFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  t.after(async () => { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; !fs.existsSync(portFile) && i < 200; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(portFile), log);
  const port = Number(fs.readFileSync(portFile));
  async function call(method, route, data, cookie = '') {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'X-GFW': '1', Cookie: cookie }, body: data === undefined ? undefined : Buffer.isBuffer(data) ? data : JSON.stringify(data) });
    return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
  }
  const login = async (name, pw = name === 'member' ? 'oldpass' : password) => {
    const r = await call('POST', '/api/login', { name, password: pw });
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie.split(';')[0];
  };
  const calls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, dir, call, login, calls, clear: () => fs.writeFileSync(callsFile, ''), advance: ms => fs.writeFileSync(clock, String(ms)), port, model };
}
