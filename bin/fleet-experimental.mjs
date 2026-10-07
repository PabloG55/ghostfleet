#!/usr/bin/env node
// fleet-experimental — the fleet's experimental features, and their switches.
//
//   fleet-experimental [list]          every feature, on or off, and what it is
//   fleet-experimental enable <name>   turn one on
//   fleet-experimental disable <name>  turn one off
//
// The features and the rule they share are lib/experimental.mjs; the settings page
// (`,` on the Projects screen) flips the same switches through this command, and
// `fleet-jarvis enable|disable` are aliases of it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as X from '../lib/experimental.mjs';

const die = (msg, code = 1) => { process.stderr.write(`fleet-experimental: ${msg}\n`); process.exit(code); };

// Write the switch, then do what the feature needs besides (lib/experimental.mjs `apply`).
// Exported for the aliases, which must not be a second implementation.
export async function toggle(name, on) {
  const f = X.feature(name);
  if (!f) die(`no experimental feature called '${name}' (have: ${X.FEATURES.map(x => x.name).join(', ')})`, 2);
  const was = X.enabled(name);
  X.set(name, on);
  console.log(`${name} [${X.TAG}] — ${on ? 'enabled' : 'disabled'}${was === on ? ' (it already was)' : ''}`);
  if (f.apply) {
    try { await f.apply(on); } catch (e) { die(`${on ? 'enabled' : 'disabled'}, but ${String((e && e.message) || e)}`); }
  }
  if (!on) console.log(`  enable    ${X.howToEnable(name)}`);
}

function list() {
  for (const f of X.FEATURES) X.settle(f.name);
  const rows = X.list();
  const w = Math.max(...rows.map(r => r.name.length));
  console.log(`experimental features (off on a new install; ${X.howToEnable('<name>')})`);
  for (const r of rows) console.log(`  ${r.name.padEnd(w)}  ${r.on ? 'on ' : 'off'}  [${X.TAG}]  ${r.what}`);
}

async function main() {
  const [cmd = 'list', name] = process.argv.slice(2);
  switch (cmd) {
    case 'list': return list();
    case 'enable': case 'disable':
      if (!name) die(`${cmd} needs a feature name (fleet-experimental list)`, 2);
      return toggle(name, cmd === 'enable');
    case '-h': case '--help': case 'help':
      return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    default: die(`unknown command '${cmd}' (fleet-experimental --help)`, 2);
  }
}
let direct = false;
try { direct = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) main().catch((e) => die(String((e && e.stack) || e)));
