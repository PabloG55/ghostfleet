// lib/projects.mjs — which project, profile and account a fleet socket belongs to, read
// from the same ~/.config/ghostfleet/projects[.<profile>] files bin/ghostfleet reads.
//
// ONE READER, LIFTED OUT OF mcp/fleet-dispatch.mjs rather than written again. The MCP
// tools and the phone already resolved a project this way; the grid and fleet-restart
// did not, and took the account from whoever ran them instead. A fleet session exports
// CLAUDE_FLEET_DIR for ITS OWN profile, so a restart run from a work-profile pane against
// a fleet on another profile relaunched that fleet's sessions under the work account:
// one stopped at a "trust this folder?" it had never been asked there, one whose
// conversation lived only under the other account said "no conversation found" and
// exited. A grid run under that env reads the same wrong directory and draws a fleet
// whose six sessions were recoverable as "nothing running yet". The socket names its
// fleet; this says whose fleet that is.
//
//   node lib/projects.mjs sock <socket>   prints name \x1f profile \x1f config-dir \x1f path \x1f socket,
//                                         exit 1 when no project owns that socket
//   node lib/projects.mjs name <project>  the same, by project name; exit 3 when two profiles
//                                         both have a project of that name, since either
//                                         answer would be a guess
//
// Node builtins only: ghostfleet is a zero-dependency package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A profile's config dir: `work` (or `default`) is ~/.claude, any other is ~/.claude-<p>.
// The one spelling in node; bin/ghostfleet and bin/fleet-project carry the shell one.
export function cfgFor(profile, HOME = os.homedir()) {
  return (!profile || profile === 'work' || profile === 'default') ? path.join(HOME, '.claude') : path.join(HOME, '.claude-' + profile);
}

export function projects() {
  const HOME = os.homedir();
  const dir = path.join(HOME, '.config', 'ghostfleet');
  const files = [path.join(dir, 'projects')];
  // only real profile lists: 'projects.bak.1785…' is a backup, not a profile
  try { for (const f of fs.readdirSync(dir)) if (/^projects\.[A-Za-z0-9_-]+$/.test(f)) files.push(path.join(dir, f)); } catch {}
  const out = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const t = line.replace(/\r$/, '');
      if (!t.trim() || t.startsWith('#')) continue;
      const [name, p, prof0, agent0] = t.split('\t');
      if (!name || !p) continue;
      const prof = prof0 || 'work';
      const isWork = prof === 'work' || prof === 'default';
      // 4th column = that project's default agent. Carried so a cross-fleet spawn uses
      // the TARGET's default rather than inheriting whatever the caller happens to run.
      const agent = /^[a-z0-9_-]+$/.test((agent0 || '').trim()) ? agent0.trim() : '';
      out.push({ name, path: p.replace(/^~/, HOME), profile: prof, agent,
                 sock: isWork ? `cf-${name}` : `cf-${prof}-${name}`,
                 cfg: cfgFor(prof, HOME) });
    }
  }
  return out;
}

// The project that owns a socket, or null. By socket only: a project NAME is not unique
// across profiles, and the socket is the one thing every caller here already has.
export function projectForSock(sock) {
  if (!sock) return null;
  return projects().find(p => p.sock === String(sock)) || null;
}

// A project's budget limit, "enforced" or "ignored": ignored is a marker file in its fleet
// dir, <sock>.governor-off, written by the grid's settings screen. Read live by everything
// that parks for budget — fleet-governor's own ceiling (the same test, in shell) and the
// accounts engine's all-exhausted park — so the setting means one thing everywhere.
export const budgetFile = (fleetDir, sock) => path.join(fleetDir, `${sock}.governor-off`);
export function budgetIgnored(fleetDir, sock) { try { return fs.existsSync(budgetFile(fleetDir, sock)); } catch { return false; } }

// ── what a paired machine may have of a project (fleet-serve, PAIRED HOSTS) ──────────────
//   share   a paired machine sees the project and acts on it — everything the pairing covers.
//           The default, so a machine where nothing was set behaves exactly as it always did
//   hide    no paired machine sees it or acts on it. It is absent from every paired read (no
//           row, session, pane, conversation, run, memory event or queue item, and no name),
//           and a paired send, wake, park, photo or verdict aimed at it is answered the way
//           a project this machine never had is answered
// Only a request a paired machine SIGNED is filtered: this machine's own phone, web client,
// leads and commands see every project, whatever the setting says. Stored the way
// fleet-project stores every per-project setting — one value in a marker beside the fleet's
// other markers — with the profile's default beside them, as the memory's privacy is:
//   <fleet-dir>/<sock>.pair      this project               (fleet-project set <name> pair …)
//   <fleet-dir>/pair.default     every project of a profile (fleet-project set --profile <p> pair …)
// Most specific wins; neither set is `share`.
//   A VALUE THIS VERSION DOES NOT KNOW READS AS `hide`. The value is a word rather than a
// switch so that naming machines later (`share:<peer-key>,…`) is a new word in the same file
// and not a migration — and a reader from before that word must fail CLOSED on it, or the
// first project anybody shared with one machine would be shared with all of them. `peer`
// rides into pairSees for the same reason: it is the machine asking, and no value names one yet.
export const PAIR_MODES = ['share', 'hide'];
export const pairFile = (fleetDir, sock) => path.join(fleetDir, `${sock}.pair`);
export const pairDefaultFile = (fleetDir) => path.join(fleetDir, 'pair.default');
export const fleetDirFor = (t) => path.join(t.cfg, 'fleet');
function readPair(f) {
  let v;
  try { v = fs.readFileSync(f, 'utf8').split('\n')[0].trim(); } catch { return null; }
  return PAIR_MODES.includes(v) ? { mode: v } : { mode: 'hide', unknown: v };
}
export function pairFor(fleetDir, sock) {
  const p = sock ? readPair(pairFile(fleetDir, sock)) : null;
  if (p) return { ...p, from: 'project' };
  const q = readPair(pairDefaultFile(fleetDir));
  if (q) return { ...q, from: 'profile' };
  return { mode: 'share', from: 'default' };
}
export const pairSees = (t, peer = null) => pairFor(fleetDirFor(t), t.sock).mode === 'share';
// WHAT ONE PAIRED REQUEST MAY HAVE, decided once for it. `sees` takes a project from the list;
// the two `…Hidden` questions are for things that only carry a name or a profile: a memory
// event with no socket, a review run whose repo is no registered project's.
//   A NAME IS HIDDEN WHEN ANY PROJECT OF THAT NAME IS: names are not unique across profiles,
// and a thing that carries only a name cannot say which one it meant, so it fails closed.
export function pairScope(list = projects(), peer = null) {
  const hidden = new Set(), names = new Set();
  for (const t of list) if (!pairSees(t, peer)) { hidden.add(t.sock); names.add(t.name); }
  const profiles = new Map();
  return {
    peer,
    sees: (t) => !!t && !hidden.has(t.sock),
    nameHidden: (name) => names.has(String(name || '')),
    // Something of a profile that no registered project owns follows the profile's default.
    profileHidden: (profile) => {
      const p = (!profile || profile === 'default') ? 'work' : profile;
      if (!profiles.has(p)) profiles.set(p, pairFor(path.join(cfgFor(p), 'fleet'), '').mode !== 'share');
      return profiles.get(p);
    },
  };
}

// Real paths on both sides: argv[1] keeps a symlinked component (`cd … && pwd`, /tmp on
// macOS) and import.meta.url does not, and a mismatch made this CLI print nothing — which
// every caller reads as "no project owns this socket" (lib/fleet-env.mjs has the same guard).
const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
// `fleet-project pair`: per project, its profile, the setting, where the value came from and
// whether a paired machine sees it — answered by the same pairFor the daemon asks, so the
// command cannot say `share` about a project the daemon hides. Read only: nothing here writes.
export function pairRows(list = projects()) {
  return list.map(t => {
    const r = pairFor(fleetDirFor(t), t.sock);
    return { project: t.name, profile: t.profile, mode: r.mode, from: r.from, ...(r.unknown !== undefined ? { unknown: r.unknown } : {}), peer_sees: r.mode === 'share' };
  });
}
export function pairTable(rows) {
  if (!rows.length) return 'no projects (fleet-project list)';
  const note = (r) => (r.unknown !== undefined ? `   ('${r.unknown}' is not share or hide, so it reads as hide)` : '');
  const w = Math.max(7, ...rows.map(r => r.project.length)), pw = Math.max(7, ...rows.map(r => r.profile.length));
  return [`${'PROJECT'.padEnd(w)}  ${'PROFILE'.padEnd(pw)}  PAIR   FROM     A PAIRED MACHINE SEES IT`,
    ...rows.map(r => `${r.project.padEnd(w)}  ${r.profile.padEnd(pw)}  ${r.mode.padEnd(5)}  ${r.from.padEnd(7)}  ${r.peer_sees ? 'yes' : 'no'}${note(r)}`)].join('\n');
}

if (process.argv[1] && isMain()) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'pair') {
    const rows = pairRows();
    process.stdout.write((arg === '--json' ? JSON.stringify({ rows }) : pairTable(rows)) + '\n');
    process.exit(0);
  }
  if (cmd === 'pair-of') {
    // One project's line for `fleet-project get` and `set`: `<mode>\x1f<from>`, by socket.
    const t = projectForSock(arg);
    if (!t) process.exit(1);
    const r = pairFor(fleetDirFor(t), t.sock);
    process.stdout.write([r.mode, r.unknown !== undefined ? `${r.from}: '${r.unknown}' is not share or hide, so it reads as hide` : r.from].join('\x1f') + '\n');
    process.exit(0);
  }
  if (!['sock', 'name'].includes(cmd) || !arg) { process.stderr.write('usage: projects.mjs sock <socket> | name <project> | pair [--json] | pair-of <socket>\n'); process.exit(2); }
  let t = null;
  if (cmd === 'sock') t = projectForSock(arg);
  else {
    const hits = projects().filter(p => p.name === arg);
    if (hits.length > 1) process.exit(3);
    t = hits[0] || null;
  }
  if (!t) process.exit(1);
  process.stdout.write([t.name, t.profile, t.cfg, t.path, t.sock].join('\x1f') + '\n');
}
