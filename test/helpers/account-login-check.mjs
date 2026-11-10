import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function checkAccountLogin({ home, remote, rt, T, is, read, files, sleep, request, remotePeer, P }) {
  const code = `phone-sentinel-${crypto.randomBytes(12).toString('hex')}#placeholder-state`;
  const tm = (h, ...args) => execFileSync('tmux', ['-u', '-L', 'cf-acme-api', ...args],
    { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // Both test hosts use one run namespace; only the remote owns this scratch session.
    const control = path.join(T, 'stub-port');
    const hash = crypto.createHash('sha256').update(code + '\r').digest('hex');
    tm(remote, 'new-session', '-d', '-s', 'api-1', '-x', '120', '-y', '36', 'node',
      fileURLToPath(new URL('./account-login-stub.mjs', import.meta.url)), control, hash);
    for (let i = 0; i < 100 && !fs.existsSync(control); i++) await sleep(50);
    const base = `http://127.0.0.1:${fs.readFileSync(control, 'utf8')}`;
    const state = async () => (await request(base, 'GET', '/')).json;
    const mode = async value => { await request(base, 'GET', `/mode?value=${value}`); await sleep(70); };
    const start = () => remote.auth.verb(remote.base, 'fleet_account_login_start', { project: 'acme-api', session: 'api-1' });
    await mode('busy');
    let r = await start();
    is('busy start refuses without queuing /login', true, r.status === 400 && /busy/.test(r.json?.text));
    is('busy start types nothing', 0, (await state()).count);
    await mode('expired');
    r = await start();
    is('start sends /login to this session and captures its URL', [200, 'prompt'], [r.status, (await state()).mode]);
    const file = path.join(remote.fleet, 'logins', `${r.json?.id}.json`), record = read(file);
    is('pending record is private', 0o600, fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0);
    is('pending record binds session, fleet, profile, expiry and pane', true,
      record.session === 'api-1' && record.sock === 'cf-acme-api' && record.profile === 'work'
      && record.expires - record.created === 600000 && /^%\d+$/.test(record.pane));
    is('start does not type a credential', 0, (await state()).count);
  } finally { try { tm(remote, 'kill-server'); } catch {} }
}
