// lib/fleet-env.mjs — the config dir and fleet dir a fleet's server and sessions run with,
// taken from the fleet's PROJECT, never from whoever happened to start it.
//
// A tmux server's global environment is whatever its FIRST client exported. A project on a
// non-default profile (`acme-api`, profile `personal`, config dir ~/.claude-personal) had
// its server started from a session of a DEFAULT-profile project that was asking it things
// and spawning workers into it, so the server's global env said CLAUDE_CONFIG_DIR=~/.claude
// and CLAUDE_FLEET_DIR=~/.claude/fleet. Its master carried a session-level CLAUDE_CONFIG_DIR
// of its own and ran on the right login, but nothing set CLAUDE_FLEET_DIR per session, so
// that came from the global env — and for four days:
//   - its hooks wrote its record, inbox and status into the DEFAULT profile's fleet dir;
//   - the phone, which resolves fleet -> project -> profile, looked in the personal one,
//     found no record and showed the session as having no messages;
//   - a `--reply-to` question from the default fleet left its request where the profile
//     says, while the master's Stop hook looked for it in the default dir, so it never
//     answered. To the asker it looked stuck.
// Nothing errored. Every reader was internally consistent; they just read two directories.
//
// Two jobs, one source of truth (lib/projects.mjs, the reader the phone and fleet-restart
// already use):
//   of <sock>    the fleet's config dir, fleet dir and profile — what a launch passes with -e
//                and exports into the tmux client that may start the server
//   heal <sock>  on a LIVE server: correct the global env if it disagrees, and say once,
//                in that fleet's inbox, which sessions are still running with the wrong
//                fleet dir. Never restarts anything: a relaunch costs a conversation its
//                on-screen history, and only the owner can say when that is acceptable.
//
//   node lib/fleet-env.mjs of <sock>     prints cfg \x1f fleet-dir \x1f profile; exit 1 when
//                                        no project owns the socket (then the caller keeps
//                                        what it had — a scratch or test socket has no
//                                        profile to be wrong about)
//   node lib/fleet-env.mjs heal <sock>   prints one line per thing it did; always exit 0
//
// Node builtins only: ghostfleet is a zero-dependency package.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects, projectForSock } from './projects.mjs';

export function envOf(sock) {
  const p = projectForSock(sock);
  if (!p) return null;
  return { cfg: p.cfg, dir: path.join(p.cfg, 'fleet'), profile: p.profile, name: p.name, root: p.path };
}

const tmux = (sock, ...a) => {
  try { return execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};

// `show-environment -g NAME` prints NAME=value, -NAME for one marked removed, and fails for
// one never set. Only the first is a value.
function globalVar(sock, name) {
  const out = tmux(sock, 'show-environment', '-g', name);
  if (out == null) return '';
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(out);
  return m ? m[1] : '';
}

// ── WHICH SESSIONS ARE STILL WRITING TO THE WRONG DIRECTORY ──────────────────
// A process's environment is fixed at exec, so correcting the server cannot reach a session
// that is already running. What the process actually uses is the question, and the answer
// is on disk: the hook writes <fleet dir>/<session id>.json on every event, naming the
// socket, the slot and the PANE it ran in (`%N@<server pid>`, qualified by the server
// because pane ids restart at %0 with every server). A record with this pane's id in a
// directory that is not the profile's is this very process writing there — positive
// evidence, not an inference from tmux state that a later launch may have overridden. A
// session that has not fired a hook yet has written nowhere, and is not named.
//   Read rather than asked of the process: macOS does not show another process's
// environment to `ps` any more, and a check that only works on one OS is a check that
// passes on the other by never looking.
function candidateDirs(expected, extra) {
  const dirs = new Set();
  for (const p of projects()) dirs.add(path.join(p.cfg, 'fleet'));
  for (const d of extra) if (d) dirs.add(d);
  dirs.delete(expected);
  return [...dirs];
}

// Every record in a directory for this socket, by slot+pane -> newest ts. One pass per
// directory, not one per session: the governor runs this every minute.
function indexDir(dir, sock) {
  const idx = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return idx; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!r || r.sock !== sock || !r.slot || !r.pane) continue;
    const k = `${r.slot}\t${r.pane}`, ts = Number(r.ts) || 0;
    if (!idx.has(k) || ts > idx.get(k)) idx.set(k, ts);
  }
  return idx;
}

export function wrongSessions(sock, expectedDir, extraDirs = []) {
  const srv = (tmux(sock, 'display-message', '-p', '#{pid}') || '').trim();
  const rows = tmux(sock, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}') || '';
  const right = indexDir(expectedDir, sock);
  const others = candidateDirs(expectedDir, extraDirs).map(d => [d, indexDir(d, sock)]);
  const out = [];
  for (const line of rows.split('\n')) {
    const [slot, paneId] = line.split('\t');
    // a tab (_term-*, _edit-*) runs a shell, not an agent, and a `+` name is an expression
    if (!slot || !paneId || /^[_+]/.test(slot)) continue;
    const k = `${slot}\t${paneId}@${srv}`;
    let wrong = null;
    for (const [d, idx] of others) {
      if (idx.has(k) && (!wrong || idx.get(k) > wrong.ts)) wrong = { dir: d, ts: idx.get(k) };
    }
    if (wrong && (!right.has(k) || wrong.ts > right.get(k))) out.push({ slot, dir: wrong.dir });
  }
  return out;
}

const tilde = (p) => { const h = process.env.HOME || ''; return h && p.startsWith(h + '/') ? '~' + p.slice(h.length) : p; };

// ── THE HEAL ──────────────────────────────────────────────────────────────────
// Correct first, then look, then say it ONCE. What has been said is kept in
// <fleet dir>/<sock>.env-heal, one wrong session per line: the governor runs this every
// minute, and a session left on the wrong dir until its owner gets round to restarting it
// must not add a row a minute. Only a session NOT already named is news. One that drops off
// the list (it was restarted) is not — `fleet-restart --all` heals after every relaunch, and
// a shrinking list re-announced at each step would be one row per session for one event.
// An empty list clears the memory, so the same mistake made again next week is said again.
export function heal(sock, { dryRun = false } = {}) {
  const want = envOf(sock);
  const said = [];
  if (!want) return said;                                  // nobody's fleet: nothing to be wrong about
  if (tmux(sock, 'list-sessions', '-F', '#{session_name}') == null) return said;   // no server
  const had = { CLAUDE_CONFIG_DIR: globalVar(sock, 'CLAUDE_CONFIG_DIR'),
                CLAUDE_FLEET_DIR: globalVar(sock, 'CLAUDE_FLEET_DIR'),
                CLAUDE_FLEET_PROFILE: globalVar(sock, 'CLAUDE_FLEET_PROFILE') };
  const should = { CLAUDE_CONFIG_DIR: want.cfg, CLAUDE_FLEET_DIR: want.dir, CLAUDE_FLEET_PROFILE: want.profile };
  // WRONG is a value that names another place. UNSET is not wrong — a session then derives
  // its fleet dir from its own -e CLAUDE_CONFIG_DIR, which is right — but it is still set,
  // silently, so the next session nobody passed -e to inherits the right one.
  // The profile NAME is corrected without a word: `work` and `default` are one profile, and
  // only the two directories decide where anything is written.
  let wasWrong = false;
  const same = (k, a, b) => k === 'CLAUDE_FLEET_PROFILE' ? a === b : !!a && path.resolve(a) === path.resolve(b);
  for (const [k, v] of Object.entries(should)) {
    if (same(k, had[k], v)) continue;
    if (had[k] && k !== 'CLAUDE_FLEET_PROFILE') { wasWrong = true; said.push(`${sock}: global ${k} was ${tilde(had[k])}, set to ${tilde(v)}`); }
    if (!dryRun) tmux(sock, 'set-environment', '-g', k, v);
  }
  const bad = wrongSessions(sock, want.dir, [had.CLAUDE_FLEET_DIR, had.CLAUDE_CONFIG_DIR && path.join(had.CLAUDE_CONFIG_DIR, 'fleet')]);
  const memo = path.join(want.dir, `${sock}.env-heal`);
  const sig = bad.map(b => `${b.slot}\t${b.dir}`).sort().join('\n');
  let prev = ''; try { prev = fs.readFileSync(memo, 'utf8').trim(); } catch {}
  if (!bad.length) {
    if (!dryRun && prev) { try { fs.unlinkSync(memo); } catch {} }
    if (wasWrong) note(sock, want, `this fleet's server had another profile's environment (${said.map(s => s.replace(/^[^:]*: global /, '')).join('; ')}). Corrected; no running session was writing to the wrong place.`, dryRun, said);
    return said;
  }
  const known = new Set(prev.split('\n').filter(Boolean));
  const fresh = bad.some(b => !known.has(`${b.slot}\t${b.dir}`));
  if (!fresh && !wasWrong) {
    if (!dryRun && sig !== prev) { try { fs.writeFileSync(memo, sig + '\n'); } catch {} }
    return said;
  }
  const names = bad.map(b => b.slot).join(', ');
  const where = [...new Set(bad.map(b => tilde(b.dir)))].join(', ');
  note(sock, want,
    `${bad.length === 1 ? 'session' : 'sessions'} ${names} ${bad.length === 1 ? 'is' : 'are'} still writing to ${where} instead of ${tilde(want.dir)}` +
    ` — the phone shows nothing from ${bad.length === 1 ? 'it' : 'them'} and a --reply-to question is never answered.` +
    `${wasWrong ? ' The server\'s environment is corrected now, but a running process keeps the one it started with.' : ''}` +
    ` Restart ${bad.length === 1 ? 'it' : 'each'} when convenient: ${bad.map(b => `fleet-restart -s ${sock} --session ${b.slot}`).join('; ')}`,
    dryRun, said);
  if (!dryRun) { try { fs.mkdirSync(want.dir, { recursive: true }); fs.writeFileSync(memo, sig + '\n'); } catch {} }
  return said;
}

function note(sock, want, msg, dryRun, said) {
  said.push(`${sock}: ${msg}`);
  if (dryRun) return;
  const row = `${Math.floor(Date.now() / 1000)}\tfleet\tenv\t${msg.replace(/[\t\n]/g, ' ')}\n`;
  try { fs.mkdirSync(want.dir, { recursive: true }); fs.appendFileSync(path.join(want.dir, `${sock}.inbox`), row); } catch {}
}

// REAL PATHS ON BOTH SIDES. import.meta.url is the resolved file and argv[1] is however the
// caller spelled it — `cd … && pwd` keeps a symlinked component, and /tmp is one on macOS —
// so a plain comparison made the CLI a silent no-op from any path through a symlink: `of`
// printed nothing, and every launch site took that as "no project owns this socket".
const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (process.argv[1] && isMain()) {
  const [cmd, sock, flag] = process.argv.slice(2);
  if (!['of', 'heal'].includes(cmd) || !sock) {
    process.stderr.write('usage: fleet-env.mjs of <socket> | heal <socket> [--dry-run]\n'); process.exit(2);
  }
  if (cmd === 'of') {
    const e = envOf(sock);
    if (!e) process.exit(1);
    process.stdout.write([e.cfg, e.dir, e.profile].join('\x1f') + '\n');
  } else {
    for (const line of heal(sock, { dryRun: flag === '--dry-run' })) process.stdout.write(line + '\n');
  }
}
