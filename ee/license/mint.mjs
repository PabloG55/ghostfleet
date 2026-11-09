#!/usr/bin/env node
// Under the ghostfleet Team License; see ../LICENSE. Owner-only offline tooling.
import { generateKeyPairSync, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoTime, validPayload, verifyKey } from './index.mjs';

const repo = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const inside = (parent, target) => {
  const rel = relative(parent, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Resolve existing ancestors before mkdir, so symlinks cannot hide a Git boundary.
function safeOutput(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const target = resolve(realpathSync(ancestor), ...suffix);
  if (inside(repo, target)) throw new Error('Key output must be outside the repository tree');
  for (let dir = target; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) throw new Error('Key output must be outside any git work tree');
    if (dirname(dir) === dir) break;
  }
  return target;
}

function argumentsFor(args, names) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!names.includes(name) || result[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Invalid or missing option');
    }
    result[name] = args[i + 1];
  }
  return result;
}

function required(options, names) {
  if (names.some(name => !options[name])) throw new Error(`Required: ${names.join(' ')}`);
}

function main([command, ...args]) {
  if (command === 'keygen') {
    const options = argumentsFor(args, ['--out']);
    required(options, ['--out']);
    const out = safeOutput(options['--out']);
    if (existsSync(join(out, 'private.pem')) || existsSync(join(out, 'public.pem'))) {
      throw new Error('Refusing to overwrite an existing key pair');
    }
    mkdirSync(out, { recursive: true, mode: 0o700 });
    safeOutput(out);
    chmodSync(out, 0o700);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(join(out, 'private.pem'), privateKey, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(out, 'public.pem'), publicKey, { mode: 0o644, flag: 'wx' });
    console.log(`export const PUBLIC_KEY = ${JSON.stringify(publicKey)};`);
    console.log('Keep an offline backup of private.pem in a password manager; losing it means every existing customer key must be reissued.');
  } else if (command === 'mint') {
    const options = argumentsFor(args, ['--private', '--org', '--seats', '--expires']);
    required(options, ['--private', '--org', '--seats', '--expires']);
    if (!/^[1-9]\d*$/.test(options['--seats']) || !/^\d{4}-\d{2}-\d{2}$/.test(options['--expires'])) {
      throw new Error('Use positive integer seats and YYYY-MM-DD expiration');
    }
    const payload = { v: 1, id: randomUUID(), org: options['--org'], seats: Number(options['--seats']),
      issued: new Date().toISOString(), expires: options['--expires'] };
    if (!validPayload(payload) || isoTime(payload.expires) <= Date.now()) throw new Error('Invalid payload or expiration');
    const privateKey = createPrivateKey(readFileSync(options['--private']));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required');
    const bytes = Buffer.from(JSON.stringify(payload));
    console.log(`gft1.${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`);
  } else if (command === 'check') {
    const [key, ...rest] = args;
    const options = argumentsFor(rest, ['--public']);
    const result = verifyKey(key, options['--public'] ? { publicKey: readFileSync(options['--public']) } : {});
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else {
    throw new Error('Usage: mint.mjs keygen --out <dir> | mint --private <pem> --org <name> --seats N --expires YYYY-MM-DD | check <key> [--public <pem>]');
  }
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
