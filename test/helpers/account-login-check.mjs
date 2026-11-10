import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkAccountLogin({ home, remote, rt, T, pushed, is, read, files, sleep, request, remotePeer, P }) {
  const code = `phone-sentinel-${crypto.randomBytes(12).toString('hex')}#placeholder-state`;
  let currentSocket = 'cf-acme-api';
  const tm = (h, ...args) => execFileSync('tmux', ['-u', '-L', currentSocket, ...args],
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
    is('busy start types nothing', 0, (await state()).commands);
    await mode('expired');
    const grid = JSON.parse(execFileSync(process.execPath, [path.join(rt, 'bin/fleet-grid.mjs'), 'cf-acme-api', '--json'],
      { env: remote.env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const gridRow = grid.cards?.find(x => x.name === 'api-1');
    is('grid reports needs-you with an account login reason', ['need-you', 'Claude account sign-in'], [gridRow?.status, gridRow?.login_reason]);
    let list = await home.auth.api(home.base, 'GET', '/api/logins');
    const needed = list.json?.items?.find(x => x.kind === 'account');
    is('phone sees account need with host, session and profile', ['laptop', 'api-1', 'work', 'needs-login'],
      [needed?.host, needed?.session, needed?.profile, needed?.status]);
    const notice = read(path.join(remote.home, '.config/ghostfleet/telegram/outbox/account-cf-acme-api-api-1.json'));
    is('Telegram names the session and profile without URL', true,
      /api-1.*work.*Claude account sign-in/.test(notice.text) && !JSON.stringify(notice).includes('http'));
    for (let i = 0; i < 80 && !fs.existsSync(pushed); i++) await sleep(100);
    const push = fs.existsSync(pushed) ? JSON.parse(fs.readFileSync(pushed, 'utf8').trim().split('\n')[0]).payload : {};
    is('account need reaches the home push subscription', ['needs-you', 'waiting', 'api-1', 'Claude account'],
      [push.kind, push.open, push.sessions?.[0]?.session, push.sessions?.[0]?.server]);
    is('account push carries no URL or code', false, JSON.stringify(push).includes('http') || JSON.stringify(push).includes(code));
    await mode('idle'); await sleep(1300); await mode('expired');
    for (let i = 0; i < 80; i++) {
      if (fs.existsSync(pushed) && fs.readFileSync(pushed, 'utf8').trim().split('\n').length >= 2) break;
      await sleep(100);
    }
    is('a later account expiry can ring again for the same session', true,
      fs.existsSync(pushed) && fs.readFileSync(pushed, 'utf8').trim().split('\n').length >= 2);
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
    const { accountPaneLease } = await import(pathToFileURL(path.join(rt, 'lib/account-logins.mjs')));
    const releaseRead = accountPaneLease(remote.fleet, 'cf-acme-api', 'api-1');
    const releaseOtherRead = accountPaneLease(remote.fleet, 'cf-acme-api', 'api-1');
    const submission = finish();
    const privateFile = path.join(remote.fleet, 'cf-acme-api.api-1.account-private');
    for (let i = 0; i < 80 && !fs.existsSync(privateFile); i++) await sleep(10);
    const blockedPane = await remote.auth.api(remote.base, 'GET', '/api/pane?project=acme-api&session=api-1&scrollback=2000');
    is('pane reads are blocked while the code is being submitted', true, blockedPane.status === 502 && !('pane' in (blockedPane.json || {})));
    await sleep(50);
    is('preexisting pane readers drain before typing', 0, (await state()).count);
    releaseRead(); releaseOtherRead();
    r = await submission;
    is('local assertion submits code', [200, true], [r.status, r.json?.ok]);
    is('stub receives exactly the code plus Enter, once', [1, true], [(await state()).count, (await state()).exact]);
    is('retained input is cleared after submission', 1, (await state()).cleared);
    const history = tm(remote, 'capture-pane', '-p', '-S', '-', '-t', 'api-1');
    is('visible pane and history were cleared', false, history.includes(code) || history.includes('phone-sentinel-'));
    is('cleanup preserves the accepted prompt for the phone', true, history.includes('Login successful'));
    is('consumed record drops authorization URL', false, 'authorize' in read(file));
    await mode('prompt');
    r = await finish();
    is('second use refuses', true, r.status === 400 && /used/.test(r.json?.text));
    is('second use types nothing more', 1, (await state()).count);
    await mode('prompt');
    r = await home.auth.verb(home.base, 'fleet_account_login_start', { project: 'acme-api@laptop', session: 'api-1' });
    is('home starts the remote session through its pair', 200, r.status);
    const pairedFile = path.join(remote.fleet, 'logins', `${r.json?.id}.json`), paired = read(pairedFile);
    const cross = async (assertion = true) => home.auth.verb(home.base, 'fleet_account_login_finish',
      { project: 'acme-api@laptop', id: paired.id, code }, assertion ? await home.auth.fresh(home.base, 'finish login') : null);
    for (const [label, value, why] of [['busy', 'busy', 'busy'], ['changed prompt', 'idle', 'prompt']]) {
      await mode(value); r = await cross();
      is(`paired ${label} refuses`, true, r.status === 400 && r.json?.text.includes(why));
      is(`paired ${label} types nothing`, 1, (await state()).count);
    }
    await mode('prompt');
    fs.writeFileSync(pairedFile, JSON.stringify({ ...paired, expires: Date.now() - 1 })); r = await cross();
    is('paired expired record refuses', true, r.status === 400 && /expired/.test(r.json?.text));
    is('paired expired record types nothing', 1, (await state()).count);
    fs.writeFileSync(pairedFile, JSON.stringify(paired));
    r = await cross(false);
    is('home refuses missing assertion before crossing', 401, r.status);
    is('missing home assertion types nothing', 1, (await state()).count);
    const body = { tool: 'fleet_account_login_finish', args: { project: 'acme-api', id: paired.id, code } };
    r = await request(remote.base, 'POST', '/api/verb', { body });
    is('unsigned pair request refuses', 401, r.status);
    is('unsigned request types nothing', 1, (await state()).count);
    const noSig = P.signedHeaders(remotePeer, { method: 'POST', pathq: '/api/verb', body: Buffer.from(JSON.stringify(body)), onBehalf: 'phone' });
    delete noSig['x-fleet-pair-sig'];
    r = await request(remote.base, 'POST', '/api/verb', { body, headers: noSig });
    is('pair without signature refuses', 401, r.status);
    is('missing signature types nothing', 1, (await state()).count);
    await mode('idle');
    const signed = P.signedHeaders(remotePeer, { method: 'POST', pathq: '/api/verb', body: Buffer.from(JSON.stringify(body)), onBehalf: 'phone' });
    await request(remote.base, 'POST', '/api/verb', { body, headers: signed });
    r = await request(remote.base, 'POST', '/api/verb', { body, headers: signed });
    is('replayed pair signature refuses', true, r.status === 401 && /already/.test(r.json?.text));
    is('replay types nothing', 1, (await state()).count);
    await mode('prompt');
    fs.writeFileSync(path.join(remote.fleet, 'cf-acme-api.pair'), 'hide\n');
    r = await cross();
    is('hidden peer project refuses finish', 400, r.status);
    is('hidden peer project types nothing', 1, (await state()).count);
    list = await home.auth.api(home.base, 'GET', '/api/logins');
    is('hidden project has no account card', false, list.json?.items?.some(x => x.project === 'acme-api@laptop'));
    fs.unlinkSync(path.join(remote.fleet, 'cf-acme-api.pair'));
    r = await cross();
    is('home assertion finishes the remote record', [200, true], [r.status, r.json?.ok]);
    is('paired finish types exactly once', [2, true], [(await state()).count, (await state()).exact]);
    await mode('prompt');
    r = await cross();
    is('paired second use refuses', true, r.status === 400 && /used/.test(r.json?.text));
    is('paired second use types nothing', 2, (await state()).count);
    const assertion = await home.auth.fresh(home.base, 'finish login');
    await home.auth.verb(home.base, 'fleet_account_login_finish', { project: 'acme-api@laptop', id: paired.id, code }, assertion);
    r = await home.auth.verb(home.base, 'fleet_account_login_finish', { project: 'acme-api@laptop', id: paired.id, code }, assertion);
    is('home assertion cannot be reused', 401, r.status);
    for (const h of [home, remote]) {
      const audits = fs.readFileSync(path.join(h.dir, 'audit'), 'utf8').trim().split('\n').map(JSON.parse);
      is(`${h.id} audit records account finish and authority`, true, audits.some(x => x.verb === 'fleet_account_login_finish'
        && (h === home ? x.confirmed === 'passkey' && x.via === 'proxy' : x.via === 'pair' && x.origin_host === 'vm')));
    }
    is('paired pane history contains no sentinel', false, tm(remote, 'capture-pane', '-p', '-S', '-', '-t', 'api-1').includes('phone-sentinel-'));
    tm(remote, 'kill-server'); currentSocket = 'cf-personal-acme-api'; fs.unlinkSync(control);
    const personalFleet = path.join(remote.home, '.claude-personal/fleet'); fs.mkdirSync(personalFleet, { recursive: true });
    fs.writeFileSync(path.join(remote.home, '.config/ghostfleet/projects'), `acme-api\t${remote.project}\twork\nacme-api\t${remote.project}\tpersonal\n`);
    tm(remote, 'new-session', '-d', '-s', 'api-1', '-x', '120', '-y', '36', 'node',
      fileURLToPath(new URL('./account-login-stub.mjs', import.meta.url)), control, hash);
    for (let i = 0; i < 100 && !fs.existsSync(control); i++) await sleep(50);
    const personalBase = `http://127.0.0.1:${fs.readFileSync(control, 'utf8')}`;
    r = await home.auth.verb(home.base, 'fleet_account_login_start', { project: 'acme-api@laptop', session: 'api-1' });
    is('ambiguous profile start refuses without choosing a fleet', true, r.status === 400 && /fleet/.test(r.json?.text));
    is('ambiguous profile start types nothing', 0, (await request(personalBase, 'GET', '/')).json?.commands);
    r = await home.auth.verb(home.base, 'fleet_account_login_start', { project: 'acme-api@laptop', session: 'api-1', sock: currentSocket });
    const personalRecord = read(path.join(personalFleet, 'logins', `${r.json?.id}.json`));
    is('another fake profile uses its own label and fleet socket', [200, 'personal', 'cf-personal-acme-api'], [r.status, personalRecord.profile, personalRecord.sock]);
    r = await home.auth.verb(home.base, 'fleet_account_login_finish', { project: 'acme-api@laptop', id: personalRecord.id, code }, await home.auth.fresh(home.base, 'finish login'));
    const personalState = (await request(personalBase, 'GET', '/')).json;
    is('another fake profile finishes once through home', [200, 1, true], [r.status, personalState?.count, personalState?.exact]);
    is('another profile history has no code', false, tm(remote, 'capture-pane', '-p', '-S', '-', '-t', 'api-1').includes('phone-sentinel-'));
    is('sentinel absent from everything both hosts wrote', [], files(T).filter(f => {
      try { return fs.statSync(f).isFile() && fs.readFileSync(f).includes(Buffer.from(code)); }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    }).map(f => path.relative(T, f)));
  } finally { try { tm(remote, 'kill-server'); } catch {} }
}
