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

// Real paths on both sides: argv[1] keeps a symlinked component (`cd … && pwd`, /tmp on
// macOS) and import.meta.url does not, and a mismatch made this CLI print nothing — which
// every caller reads as "no project owns this socket" (lib/fleet-env.mjs has the same guard).
const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (process.argv[1] && isMain()) {
  const [cmd, arg] = process.argv.slice(2);
  if (!['sock', 'name'].includes(cmd) || !arg) { process.stderr.write('usage: projects.mjs sock <socket> | name <project>\n'); process.exit(2); }
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
