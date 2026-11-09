#!/usr/bin/env node
// server/admin-cli.mjs — the operator's console for an instance (§1). The first admin of a
// company is created here, never from the web: whoever reaches the port must not be able to
// make themselves admin. Writes the same users.json the server reads (and re-reads on change).
//
//   node server/admin-cli.mjs create-admin <name> [--demo]
//   node server/admin-cli.mjs reset-password <name> [--demo]
//   node server/admin-cli.mjs list [--demo]
import { createUsers, dataDir, slug, hashPw, tempPassword } from './users.mjs';

const argv = process.argv.slice(2);
const mode = argv.includes('--demo') || process.env.GFW_MODE === 'demo' ? 'demo' : 'real';
const [cmd, ...rest] = argv.filter(a => a !== '--demo');
const name = rest.join(' ').trim();
const dir = dataDir(mode);
const store = createUsers(dir);

function usage(code = 2) {
  console.error('usage: node server/admin-cli.mjs create-admin <name> | reset-password <name> | list   [--demo]');
  process.exit(code);
}

try {
  if (cmd === 'create-admin') {
    if (!name) usage();
    const pw = tempPassword();
    const u = store.add(name, pw, { role: 'admin' });
    u.mustChange = true; store.save();
    console.log(`admin created: ${u.name} (signs in as "${u.id}")`);
    console.log(`temporary password: ${pw}`);
    console.log(`they will be asked to change it on first sign-in · data: ${dir}`);
  } else if (cmd === 'reset-password') {
    if (!name) usage();
    const u = store.find(slug(name));
    if (!u) throw new Error(`no such user: ${name}`);
    const pw = tempPassword();
    Object.assign(u, hashPw(pw), { mustChange: true }); store.save();
    console.log(`temporary password for ${u.name}: ${pw}`);
  } else if (cmd === 'list') {
    for (const u of store.list)
      console.log(`${u.id}\t${u.role || '(no role)'}${u.disabled ? '\tdisabled' : ''}\t${Object.entries(u.projects || {}).map(([p, r]) => `${p}:${r}`).join(' ')}`);
  } else usage(cmd ? 2 : 0);
} catch (e) {
  console.error(`admin-cli: ${e.message}`);
  process.exit(1);
}
