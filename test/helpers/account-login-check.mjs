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
    const finish = async (rec = record, assertion = true, project = 'acme-api') => remote.auth.verb(remote.base, 'fleet_account_login_finish',
      { project, id: rec.id, code }, assertion ? await remote.auth.fresh(remote.base, 'finish login') : null);
    r = await finish(record, false);
    is('local finish requires a fresh assertion', 401, r.status);
    is('missing assertion types nothing', 0, (await state()).count);
    await mode('busy'); r = await finish();
    is('busy finish refuses', true, r.status === 400 && /busy/.test(r.json?.text));
    is('busy finish types nothing', 0, (await state()).count);
    await mode('idle'); r = await finish();
    is('changed prompt refuses', true, r.status === 400 && /prompt/.test(r.json?.text));
    is('changed prompt types nothing', 0, (await state()).count);
    await mode('prompt');
    fs.writeFileSync(file, JSON.stringify({ ...record, expires: Date.now() - 1 })); r = await finish();
    is('expired record refuses', true, r.status === 400 && /expired/.test(r.json?.text));
    is('expired record types nothing', 0, (await state()).count);
    fs.writeFileSync(file, JSON.stringify(record));
    r = await finish();
    is('local assertion submits code', [200, true], [r.status, r.json?.ok]);
    is('stub receives exactly the code plus Enter, once', [1, true], [(await state()).count, (await state()).exact]);
    const history = tm(remote, 'capture-pane', '-p', '-S', '-', '-t', 'api-1');
    is('visible pane and history were cleared', false, history.includes(code) || history.includes('phone-sentinel-'));
    is('consumed record drops authorization URL', false, 'authorize' in read(file));
    r = await finish();
    is('second use refuses', true, r.status === 400 && /used/.test(r.json?.text));
    is('second use types nothing more', 1, (await state()).count);
    is('sentinel absent from everything both hosts wrote', [], files(T).filter(f => fs.statSync(f).isFile() && fs.readFileSync(f).includes(Buffer.from(code))).map(f => path.relative(T, f)));
  } finally { try { tm(remote, 'kill-server'); } catch {} }
}
