// Under the ghostfleet Team License; see ../../LICENSE.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyKey, seatCheck, canAdd } from '../index.mjs';
import { PUBLIC_KEY } from '../public-key.mjs';

const now = '2030-06-01T12:00:00.000Z';
const payload = { v: 1, id: 'acme-api-subscription', org: 'acme-api', seats: 5,
  issued: '2030-01-01', expires: '2031-01-01' };
let temp, privateKey, publicKey, otherPrivate, key, expired;
const cli = fileURLToPath(new URL('../mint.mjs', import.meta.url));
const repo = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const mint = (value, signer = privateKey) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return `gft1.${bytes.toString('base64url')}.${sign(null, bytes, signer).toString('base64url')}`;
};
const runWithEnv = (env, ...args) => spawnSync(process.execPath, [cli, ...args],
  { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
const run = (...args) => runWithEnv({}, ...args);
const verify = (value, options = {}) => verifyKey(value, { publicKey, now, ...options });
const seats = (users, value = key) => ({ users, key: value, publicKey, now });
const result = (allowed, capacity, reason = null) => ({ allowed, free: 2, seats: capacity, reason });

before(() => {
  // These disposable test keys live outside both the checkout and the home directory.
  temp = mkdtempSync(join(tmpdir(), 'ghostfleet-license-'));
  ({ privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }));
  otherPrivate = generateKeyPairSync('ed25519').privateKey;
  writeFileSync(join(temp, 'private.pem'), privateKey, { mode: 0o600 });
  writeFileSync(join(temp, 'public.pem'), publicKey);
  key = mint(payload);
  expired = mint({ ...payload, expires: '2030-05-01' });
});
after(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

test('valid Ed25519 key returns the signed subscription', () => {
  assert.deepEqual(verify(key), { ok: true, org: 'acme-api', seats: 5,
    expires: '2031-01-01', id: 'acme-api-subscription' });
});
test('one changed payload byte fails signature verification', () => {
  const parts = key.split('.');
  parts[1] = Buffer.from(JSON.stringify(payload).replace('"seats":5', '"seats":6')).toString('base64url');
  assert.deepEqual(verify(parts.join('.')), { ok: false, reason: 'bad-signature' });
});
test('another signing pair fails signature verification', () => {
  assert.deepEqual(verify(mint(payload, otherPrivate)), { ok: false, reason: 'bad-signature' });
});
test('expired key is rejected', () => {
  assert.deepEqual(verify(expired), { ok: false, reason: 'expired' });
});
test('expired key reports expiration even when issued after expiry', () => {
  assert.deepEqual(verify(mint({ ...payload, issued: '2030-06-01', expires: '2030-05-01' })),
    { ok: false, reason: 'expired' });
});
test('expiration boundary is exclusive UTC midnight', () => {
  assert.deepEqual(verify(key, { now: '2031-01-01' }), { ok: false, reason: 'expired' });
});
test('key is valid immediately before expiration', () => {
  assert.deepEqual(verify(key, { now: new Date('2030-12-31T23:59:59.999Z') }),
    { ok: true, org: 'acme-api', seats: 5, expires: '2031-01-01', id: 'acme-api-subscription' });
});
test('empty shipped public key fails closed even on malformed keys', () => {
  assert.deepEqual([PUBLIC_KEY, verifyKey(key), verifyKey('garbage'), verify(key, { publicKey: '' })],
    ['', { ok: false, reason: 'no-public-key' }, { ok: false, reason: 'no-public-key' },
      { ok: false, reason: 'no-public-key' }]);
});
test('signed unknown payload version is rejected', () => {
  assert.deepEqual(verify(mint({ ...payload, v: 2 })), { ok: false, reason: 'unknown-version' });
});

for (const [name, value] of [
  ['missing', undefined], ['null', null], ['object', {}], ['symbol', Symbol('key')],
  ['wrong prefix', 'gft2.e30.AA'], ['bad alphabet', 'gft1.@@.AA'],
  ['padding', 'gft1.e30=.AA'], ['noncanonical encoding', 'gft1.e31.AA'],
  ['invalid JSON', 'gft1.YQ.AA'], ['invalid UTF-8', 'gft1._w.AA'],
]) {
  test(`malformed key never throws: ${name}`, () => {
    assert.deepEqual(verify(value), { ok: false, reason: 'malformed' });
  });
}
for (const [name, changes] of [
  ['zero seats', { seats: 0 }], ['fractional seats', { seats: 2.5 }],
  ['string seats', { seats: '5' }], ['unsafe seats', { seats: Number.MAX_SAFE_INTEGER + 1 }],
  ['blank org', { org: ' ' }], ['missing id', { id: undefined }],
  ['impossible date', { expires: '2030-02-30' }], ['invalid date', { issued: 'yesterday' }],
  ['extra field', { extra: true }],
]) {
  test(`signed malformed payload is rejected: ${name}`, () => {
    assert.deepEqual(verify(mint({ ...payload, ...changes })), { ok: false, reason: 'malformed' });
  });
}
test('invalid verifier configuration never throws', () => {
  assert.deepEqual([verify(key, { publicKey: 'invalid' }), verifyKey(key, null), verify(key, { now: NaN })],
    [{ ok: false, reason: 'bad-signature' }, { ok: false, reason: 'malformed' }, { ok: false, reason: 'malformed' }]);
});

test('two accounts are free without a key', () => {
  assert.deepEqual(seatCheck({ users: 2 }), result(true, 2));
});
test('three accounts without a key fail closed', () => {
  assert.deepEqual(seatCheck({ users: 3 }), result(false, 2, 'no-public-key'));
});
test('three accounts fit a five-seat key', () => {
  assert.deepEqual(seatCheck(seats(3)), result(true, 5));
});
test('six accounts exceed a five-seat key', () => {
  assert.deepEqual(seatCheck(seats(6)), result(false, 5, 'seat-limit'));
});
test('expired subscription keeps existing accounts allowed with banner reason', () => {
  assert.deepEqual(seatCheck(seats(6, expired)), result(true, 2, 'expired'));
});
test('expired subscription refuses another account beyond two', () => {
  assert.deepEqual(canAdd(seats(3, expired)), result(false, 2, 'expired'));
});
test('expired subscription still allows the second free account', () => {
  assert.deepEqual(canAdd(seats(1, expired)), result(true, 2, 'expired'));
});
test('expired subscription refuses the third account', () => {
  assert.deepEqual(canAdd(seats(2, expired)), result(false, 2, 'expired'));
});
test('adding the fifth licensed account is allowed', () => {
  assert.deepEqual(canAdd(seats(4)), result(true, 5));
});
test('adding the sixth licensed account is refused', () => {
  assert.deepEqual(canAdd(seats(5)), result(false, 5, 'seat-limit'));
});
test('adding the second free account needs no key', () => {
  assert.deepEqual(canAdd({ users: 1 }), result(true, 2));
});
test('adding the third free account needs a key', () => {
  assert.deepEqual(canAdd({ users: 2 }), result(false, 2, 'no-public-key'));
});
test('forged expiration cannot grant the existing-account exception', () => {
  assert.deepEqual(seatCheck(seats(3, mint({ ...payload, expires: '2030-05-01' }, otherPrivate))),
    result(false, 2, 'bad-signature'));
});
test('a one-seat key cannot take away the two free seats', () => {
  assert.deepEqual(seatCheck(seats(2, mint({ ...payload, seats: 1 }))), result(true, 2));
});
for (const users of [-1, 1.5, '2', NaN, undefined]) {
  test(`invalid account count is refused: ${String(users)}`, () => {
    assert.deepEqual(seatCheck({ users }), result(false, 2, 'malformed'));
  });
}

test('CLI mints with the supplied private key and requested claims', () => {
  const minted = run('mint', '--private', join(temp, 'private.pem'), '--org', 'toolbox',
    '--seats', '5', '--expires', '2099-01-01');
  const checked = verify(minted.stdout.trim());
  assert.deepEqual([minted.status, minted.stderr, checked.ok, checked.org, checked.seats,
    checked.expires, typeof checked.id], [0, '', true, 'toolbox', 5, '2099-01-01', 'string']);
});
test('CLI check accepts an explicit public PEM', () => {
  const checked = run('check', key, '--public', join(temp, 'public.pem'));
  assert.deepEqual([checked.status, JSON.parse(checked.stdout)], [0, verify(key)]);
});
test('CLI check uses the empty shipped public key by default', () => {
  const checked = run('check', key);
  assert.deepEqual([checked.status, JSON.parse(checked.stdout)], [1, { ok: false, reason: 'no-public-key' }]);
});
test('CLI check refuses a forged key', () => {
  const checked = run('check', mint(payload, otherPrivate), '--public', join(temp, 'public.pem'));
  assert.deepEqual([checked.status, JSON.parse(checked.stdout)], [1, { ok: false, reason: 'bad-signature' }]);
});
for (const [name, args] of [
  ['absent private option', ['--org', 'acme-api', '--seats', '5', '--expires', '2099-01-01']],
  ['missing private file', ['--private', 'absent.pem', '--org', 'acme-api', '--seats', '5', '--expires', '2099-01-01']],
  ['zero seats', ['--seats', '0']], ['fractional seats', ['--seats', '2.5']],
  ['past expiration', ['--expires', '2000-01-01']], ['impossible expiration', ['--expires', '2099-02-30']],
]) {
  test(`CLI mints nothing: ${name}`, () => {
    const base = ['--private', join(temp, 'private.pem'), '--org', 'acme-api', '--seats', '5', '--expires', '2099-01-01'];
    const options = name.includes('private') ? args : base.map((value, i) => base[i - 1] === args[0] ? args[1] : value);
    const attempted = run('mint', ...options);
    assert.deepEqual([attempted.status, attempted.stdout, attempted.stderr.length > 0], [1, '', true]);
  });
}
test('CLI keygen produces a disposable pair, secure mode and pasteable public line', () => {
  const out = join(temp, 'keygen');
  const generated = run('keygen', '--out', out);
  const publicPem = readFileSync(join(out, 'public.pem'), 'utf8');
  const privatePem = readFileSync(join(out, 'private.pem'), 'utf8');
  const signed = mint(payload, privatePem);
  assert.deepEqual([generated.status, generated.stderr, statSync(join(out, 'private.pem')).mode & 0o777,
    generated.stdout.trim().split('\n')[0], verify(signed, { publicKey: publicPem }).ok],
  [0, '', 0o600, `export const PUBLIC_KEY = ${JSON.stringify(publicPem)};`, true]);
});
test('CLI keygen refuses to overwrite an existing pair', () => {
  const out = join(temp, 'existing');
  symlinkSync(temp, out, 'dir');
  const attempted = run('keygen', '--out', out);
  assert.deepEqual([attempted.status, attempted.stdout, readFileSync(join(temp, 'private.pem'), 'utf8') === privateKey],
    [1, '', true]);
});
for (const [name, target] of [['repository', () => join(repo, '.scratch.tmp', 'refused-keys')],
  ['symlink to repository', () => {
    const link = join(temp, 'repo-link');
    symlinkSync(repo, link, 'dir');
    return join(link, '.scratch.tmp', 'refused-linked-keys');
  }]]) {
  test(`CLI keygen refuses output inside ${name}`, () => {
    const out = target();
    const attempted = run('keygen', '--out', out);
    const message = 'outside the repository tree';
    assert.deepEqual([attempted.status, attempted.stdout, existsSync(out), attempted.stderr.includes(message)],
      [1, '', false, true]);
  });
}

for (const existing of [false, true]) {
  test(`CLI keygen allows temp HOME with secure directory and private modes: existing=${existing}`, () => {
    const home = join(temp, existing ? 'existing-home' : 'new-home');
    mkdirSync(home);
    const out = join(home, 'x');
    if (existing) mkdirSync(out, { mode: 0o755 });
    const generated = runWithEnv({ HOME: home }, 'keygen', '--out', out);
    const privatePem = join(out, 'private.pem');
    const publicPem = join(out, 'public.pem');
    assert.deepEqual([generated.status, generated.stderr,
      existsSync(out) ? statSync(out).mode & 0o777 : null,
      existsSync(privatePem) ? statSync(privatePem).mode & 0o777 : null,
      existsSync(publicPem)], [0, '', 0o700, 0o600, true]);
  });
}

test('CLI keygen explains offline backup and customer key reissue risk', () => {
  const generated = run('keygen', '--out', join(temp, 'backup-notice'));
  const notice = generated.stdout.trim().split('\n').slice(1);
  assert.deepEqual([generated.status, notice.length,
    /offline backup.*private\.pem.*password manager.*every existing customer key.*reissued/i.test(notice[0] ?? '')],
    [0, 1, true]);
});

for (const marker of ['directory', 'file', 'symlink']) {
  test(`CLI keygen refuses a different git work tree: ${marker}`, () => {
    const root = join(temp, `git-${marker}`);
    mkdirSync(root);
    // Both a checkout's directory and a linked worktree's file identify a Git boundary.
    if (marker === 'file') writeFileSync(join(root, '.git'), 'gitdir: ../git-metadata\n');
    else mkdirSync(join(root, '.git'));
    let target = root;
    if (marker === 'symlink') {
      target = join(temp, 'other-repo-link');
      symlinkSync(root, target, 'dir');
    }
    const out = join(target, 'nested', 'keys');
    const attempted = run('keygen', '--out', out);
    assert.deepEqual([attempted.status, attempted.stdout, existsSync(out),
      attempted.stderr.includes('outside any git work tree')], [1, '', false, true]);
  });
}
