// lib/experimental.mjs — the fleet's EXPERIMENTAL features, and the one switch each has.
//
// A feature here is off on a new install and can be turned on and off again:
//
//     fleet-experimental list | enable <name> | disable <name>
//     the settings page (`,` on the Projects screen), its Experimental section
//
// ONE ENTRY PER FEATURE, and a third feature is one more entry below — never a copy of the
// switch. Each entry says only what is particular to it: where its switch file lives, how
// to tell an install that has ALREADY USED it, and (optionally) what turning it on or off
// has to do besides flipping the file. Everything else — the file format, the default, the
// writing-down — is the same rule for all of them and lives once, here.
//
// THE RULE. The switch is a file holding `on` or `off`. With no file yet the answer is
// derived, not defaulted: an install that has already used the feature is ON, so making a
// feature experimental changes nothing for somebody who uses it; anywhere else it is OFF.
// settle() writes that answer down the first time anything asks deliberately (install.sh,
// fleet-experimental, the feature's own command), so from then on the file IS the answer
// and evidence of use that appears later does not quietly switch a feature on.
//
// Node builtins only: the MCP server and the phone's daemon import this through
// lib/jarvis.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = () => os.homedir();
// CLAUDE_FLEET_EXPERIMENTAL_DIR moves the switch files (and nothing else), so a scratch run —
// the suite above all — never writes the owner's own ~/.config/ghostfleet. Jarvis's switch
// lives beside Jarvis's marker instead, and moves with CLAUDE_FLEET_JARVIS_DIR, because the
// shell readers that gate on it look for it there.
export const cfgDir = () => process.env.CLAUDE_FLEET_EXPERIMENTAL_DIR || path.join(home(), '.config', 'ghostfleet');
export const jarvisDir = () => process.env.CLAUDE_FLEET_JARVIS_DIR || path.join(home(), '.config', 'ghostfleet');
const fleetDir = () => process.env.CLAUDE_FLEET_DIR || path.join(home(), '.claude', 'fleet');

export const TAG = 'experimental';

export const FEATURES = [
  { name: 'jarvis', what: 'Jarvis — one session above every fleet, typed or talked to (docs/jarvis.md)',
    file: () => path.join(jarvisDir(), 'jarvis.enabled'),
    used: () => fs.existsSync(path.join(jarvisDir(), 'jarvis')),
    // Turning Jarvis off stops its session and keeps its conversation; on resumes it.
    apply: async (on) => (await import('../bin/fleet-jarvis.mjs')).applySwitch(on) },
  { name: 'shots', what: 'fleet-shots — a flow recorded as video plus requests, for a human to approve',
    file: () => path.join(cfgDir(), 'shots.enabled'),
    used: () => fs.existsSync(path.join(fleetDir(), 'shots')) },
];
export const feature = (name) => FEATURES.find(f => f.name === name) || null;
export const howToEnable = (name) => `fleet-experimental enable ${name}`;
export const disabledWhy = (name, label = name) => `${label} is experimental and disabled — enable with: ${howToEnable(name)}`;

const need = (name) => { const f = feature(name); if (!f) throw new Error(`no experimental feature called '${name}' (have: ${FEATURES.map(x => x.name).join(', ')})`); return f; };
const readSetting = (f) => { try { return fs.readFileSync(f.file(), 'utf8').trim(); } catch { return ''; } };

export function enabled(name) {
  const f = need(name);
  const v = readSetting(f);
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !!f.used();
}
export function set(name, on) {
  const f = need(name);
  const file = f.file();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, on ? 'on\n' : 'off\n');
  fs.renameSync(tmp, file);
}
// What the switch now says, and whether this call is the one that wrote it down.
export function settle(name) {
  const f = need(name);
  const v = readSetting(f);
  if (v === 'on' || v === 'off') return { on: v === 'on', wrote: false };
  const on = enabled(name);
  try { set(name, on); } catch { return { on, wrote: false }; }
  return { on, wrote: true };
}
export const list = () => FEATURES.map(f => ({ name: f.name, what: f.what, on: enabled(f.name), file: f.file() }));
