// lib/ports.mjs — what this profile's sessions left listening, running or booted, and how
// each one was tied to its session.
//
// An agent starts a dev server, a container or a simulator and its conversation ends; the
// thing it started does not. `fleet-stop` takes the pane down and with it whatever is still
// that pane's child, but a server started with nohup or setsid has been re-parented to init
// by then, a container belongs to the docker daemon and a booted simulator to launchd, and
// all three outlive a stop, a sleep and a reclaim. Nothing said which localhost was whose,
// so the leftovers of an overloaded day were found and killed by hand, one `lsof` at a time.
//
// THREE KINDS, read with one call each and every one of them optional:
//   listen     TCP listening sockets: `lsof -nP -iTCP -sTCP:LISTEN` on macOS, `ss -ltnpH` on
//              Linux (lsof there when ss is missing). Only the user's own processes, which is
//              all either tool shows without root and all a fleet could have started.
//   container  `docker ps` + one `docker inspect` of what it listed, when docker is on PATH.
//   simulator  `xcrun simctl list devices booted -j`, macOS only, and only when the process
//              table already holds a `launchd_sim` — every booted device runs one — so a Mac
//              with nothing booted never starts xcrun at all.
//
// HOW AN ITEM IS TIED, in this order, and the item says which one answered:
//   parent  a process above it is a pane's own process. The one tie that cannot be wrong:
//           the pane started it. `chain` is the walk, listener first, pane last.
//   cwd     its working directory is inside a session's checkout — the longest session root
//           that holds it. Two sessions in one folder tie nobody: either answer is a guess.
//           Neither does a checkout NESTED under the root (a clone inside a project
//           registered at a container directory): the nearest `.git` above the directory
//           has to be the root's own, or it is somebody else's checkout that happens to sit
//           below it.
//   label   a container's `com.docker.compose.project.working_dir`, read as a cwd.
//   mount   a container's bind mounts, each read as a cwd; tied only when they agree.
//   argv    a simulator, when a process under one session's pane names its UDID (an
//           `xcodebuild -destination id=…`, a `simctl launch --console`). A booted device
//           has no parent and no cwd of its own, so this is the only evidence there is.
// Anything else is NOT TIED to a session, at the level of the project whose folder it is
// in, or the machine. Never a nearest guess: a wrong tie is the one answer that would send
// a person to stop the wrong thing.
//
// A STOPPED SESSION has no record, no marker and no manifest row left (bin/fleet-stop
// removes all three), so the one thing still saying the work was there is its linked
// worktree, read from the project's own `.git/worktrees/*/gitdir` without running git. A
// listener inside one that no session holds is `stopped`; inside the primary checkout with
// no session it is only the project's, because that is also where the owner works by hand.
//
// WHOSE FLEETS: this profile's only, decided the way bin/fleet-hibernate's sock_owner
// decides it (#195) — the projects files, never the socket's name. A socket another
// profile's project claims is that profile's; a socket no project claims is this
// profile's only for the sessions whose record this fleet dir holds. Another profile's
// sessions are never listed by name from here: what is tied to one is only COUNTED
// (`other`), with nothing about it, and that profile's own scan is the one that lists it.
//
// COST. This spawns about a dozen processes (one ps, one or two lsof, one tmux per live
// fleet, docker and xcrun only when they have something to say) and is NEVER on a poll
// path: fleet-serve answers polls every 2.5 s on a machine whose new-process rate was cut
// from 330-440 a second to ~69 (#192). It runs on demand (fleet-ports, a desktop Refresh)
// and on the governor's tick, at most once per PORTS_EVERY per profile, which the governor
// checks with a builtin read of `ports/at` and no process at all. The result is a cache,
// <fleet dir>/ports/scan.json — a subfolder because every `*.json` directly in the fleet
// dir is read as a session record by half a dozen tools — and the session screen READS it.
//
//   node lib/ports.mjs cli [--json] [--cached] [-s SOCK NAME] [--dir D]   bin/fleet-ports
//   node lib/ports.mjs cli stop <:PORT|PID|container|simulator> [--kill] [--json]   one item:
//                                                         stop() below says what it refuses
//   node lib/ports.mjs refresh [--max-age N] [--dir D]    scan unless the cache is younger
//                                                         than N s (default 240); prints
//                                                         nothing, always exit 0
//
// Node builtins only: ghostfleet is a zero-dependency package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects, cfgFor } from './projects.mjs';
import { markersFor, lostSessions } from './fleet-scan.mjs';

export const PORTS_EVERY = 300;          // seconds between the governor's scans, per profile
export const VERSION = 1;
// The states a session can be in while something of it is still up, and that are worth a
// line at the top of its Details: nobody is working there, and something is listening.
export const IDLE_STATES = ['done', 'asleep', 'parked', 'lost', 'exited', 'stopped'];

export const portsDir = (dir) => path.join(dir, 'ports');
export const cachePath = (dir) => path.join(portsDir(dir), 'scan.json');
export const stampPath = (dir) => path.join(portsDir(dir), 'at');
const lockPath = (dir) => path.join(portsDir(dir), 'scan.lock');

export function fleetDirDefault(env = process.env) {
  return env.CLAUDE_FLEET_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'fleet');
}
const real = (p) => { try { return fs.realpathSync(p); } catch { return p ? path.resolve(p) : ''; } };
const under = (p, root) => !!p && !!root && (p === root || p.startsWith(root.endsWith('/') ? root : root + '/'));

// ── running things, counted ────────────────────────────────────────────────
// Every spawn goes through here, so a scan can say how many it cost (`spawned` in the cache).
// A binary that is not on PATH is looked for in PATH first, in-process, and never spawned:
// a missing docker costs nothing rather than a failed exec.
function onPath(cmd, env = process.env) {
  for (const d of String(env.PATH || '').split(':')) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}
function runner(env = process.env) {
  let spawned = 0;
  const run = (cmd, args, { timeout = 8000, extraEnv } = {}) => {
    if (!onPath(cmd, env)) return { missing: true, out: '', err: '', status: null };
    spawned++;
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 << 20,
      env: extraEnv ? { ...env, ...extraEnv } : env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status,
             timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
  };
  run.spawned = () => spawned;
  run.has = (cmd) => onPath(cmd, env);
  return run;
}

// ── the process table, once ────────────────────────────────────────────────
// pid, ppid, start and the whole command line of every process, in one `ps`. LC_ALL=C pins
// lstart to `Mon Nov 16 10:00:00 2026` (five words, the day space-padded) on both systems;
// -ww stops macOS cutting the command at the terminal's width, which is where a simulator's
// UDID sits. The start is carried so that a later stop can tell this pid from its reuse.
export function parsePs(text) {
  const procs = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    procs.set(pid, { pid, ppid: Number(m[2]), start: m[3].replace(/\s+/g, ' '), cmd: m[4] });
  }
  return procs;
}
// A macOS app's binary has spaces in its path (`…/Google Chrome.app/Contents/MacOS/Google
// Chrome --type=…`), so its name runs to the first flag rather than the first space.
const progName = (cmd) => {
  const m = /\.app\/Contents\/MacOS\/(.+?)(?=\s+-|$)/.exec(String(cmd || ''));
  return m ? m[1] : path.basename(String(cmd || '').split(/\s+/)[0] || '');
};
// AN AGENT'S OWN SOCKETS ARE NOT LEFTOVERS. Every Claude session listens on a few localhost
// ports of its own (measured on a live machine: 12 of 14 session-tied listeners were the
// agent itself), and each one closes with the agent — so listing them put a line on every
// session that answered nothing anyone asked. Counted (`agents`), never listed. The agent
// is its program's name, or a script of the npm package run by a runtime.
const AGENTS = /^(claude|claude\.exe|codex|opencode|agy|cursor-agent)$/;
export function isAgent(cmd) {
  const w = String(cmd || '').split(/\s+/);
  if (AGENTS.test(path.basename(w[0] || ''))) return true;
  return /^(node|bun|deno)$/.test(path.basename(w[0] || '')) && /@anthropic-ai\/claude-code|@openai\/codex|(^|\/)opencode(-ai)?\//.test(w[1] || '');
}

// ── who is listening ───────────────────────────────────────────────────────
// lsof -F: `p<pid>` opens a process, then an `f<fd>` and an `n<addr>:<port>` per socket.
// `*:5173`, `127.0.0.1:5173`, `[::1]:5173` — the port is after the LAST colon.
export function parseLsofListen(text) {
  const out = [];
  let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0;
    else if (line[0] === 'n' && pid) {
      const n = line.slice(1), i = n.lastIndexOf(':');
      const port = Number(n.slice(i + 1));
      if (i > 0 && port > 0) out.push({ pid, addr: n.slice(0, i).replace(/^\[|\]$/g, ''), port });
    }
  }
  return out;
}
// ss -ltnpH: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))`. A
// socket of another user's process has no users:() for us, and is not this fleet's.
export function parseSs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^LISTEN$/i.test(f[0])) continue;
    const local = f[3], i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    if (!(i > 0 && port > 0)) continue;
    const addr = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const seen = new Set();
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (!seen.has(pid)) { seen.add(pid); out.push({ pid, addr, port }); }
    }
  }
  return out;
}
export function parseLsofCwd(text) {
  const out = new Map();
  let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0;
    else if (line[0] === 'n' && pid && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

function listeners(run, platform) {
  let raw = [], source = 'missing';
  if (platform === 'linux' && run.has('ss')) {
    const r = run('ss', ['-ltnpH']);
    if (r.status === 0) { raw = parseSs(r.out); source = 'ss'; } else source = 'ss failed';
  }
  if (source !== 'ss' && run.has('lsof')) {
    // exit 1 is lsof's "found nothing", which is an answer, not a failure
    const r = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 15000 });
    if (r.status === 0 || (r.status === 1 && !r.err.trim())) { raw = parseLsofListen(r.out); source = 'lsof'; }
    else source = r.timedOut ? 'lsof timed out' : 'lsof failed';
  }
  // One row per (pid, port): a server on 127.0.0.1 and ::1 is one thing listening twice.
  const by = new Map();
  for (const x of raw) {
    const k = `${x.pid}:${x.port}`;
    if (!by.has(k)) by.set(k, { pid: x.pid, port: x.port, addrs: [] });
    if (!by.get(k).addrs.includes(x.addr)) by.get(k).addrs.push(x.addr);
  }
  return { source, rows: [...by.values()].sort((a, b) => a.port - b.port || a.pid - b.pid) };
}
function cwds(run, platform, pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (platform === 'linux') {
    for (const pid of pids) { try { out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {} }
    if (out.size || !run.has('lsof')) return out;
  }
  const r = run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { timeout: 15000 });
  for (const [pid, d] of parseLsofCwd(r.out)) out.set(pid, d);
  return out;
}

// ── the fleets' panes ──────────────────────────────────────────────────────
// Every `cf-*` server under this user's tmux dir — the same walk fleet-hibernate makes, by
// the rule tmux itself uses for -L (TMUX_TMPDIR, else /tmp, then tmux-<uid>).
export function tmuxSocketDir(env = process.env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`);
}
function liveSocks(env) {
  const d = tmuxSocketDir(env);
  let names = [];
  try { names = fs.readdirSync(d); } catch { return []; }
  return names.filter(n => /^cf-[A-Za-z0-9._-]+$/.test(n)).filter(n => {
    try { return fs.statSync(path.join(d, n)).isSocket(); } catch { return false; }
  });
}
// TAB at the tmux boundary (CLAUDE.md: tmux <= 3.5 escapes \x1f) and -u on the read (a
// daemon started with no locale gets every tab back as `_`). `@cf_tab_from` is the tab's
// origin, read in the same call: a session option is a format variable.
const PANE_FMT = ['#{pane_pid}', '#{session_name}', '#{session_path}', '#{pane_id}', '#{pid}', '#{start_time}', '#{@cf_tab_from}'].join('\t');
function panesOf(run, sock) {
  const r = run('tmux', ['-u', '-L', sock, 'list-panes', '-a', '-F', PANE_FMT], { timeout: 5000 });
  if (r.missing) return null;
  // No server is an answer (nothing is live); anything else is "could not ask", which must
  // never read as gone (lib/fleet-scan.mjs lostSessions).
  if (r.status !== 0) return /no server running|error connecting|server exited|No such file/i.test(r.err) ? [] : null;
  const rows = [];
  for (const line of r.out.split('\n')) {
    const f = line.split('\t');
    if (f.length < 7 || !f[0]) continue;
    rows.push({ pid: Number(f[0]), name: f[1], path: f[2], paneId: f[3], server: Number(f[4]) || 0, started: Number(f[5]) || 0, tabFrom: f[6] });
  }
  return rows;
}
const isTab = (n) => /^_(?:term|edit)-/.test(n || '');

// ── this fleet dir's own records and inboxes ──────────────────────────────
// Newest record per (sock, slot): its status, cwd and time. Read here rather than through
// fleet-scan's scanStatus, which keeps to four fields because its rows feed a push payload.
function readRecords(dir) {
  const newest = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return newest; }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object' || !j.sock || !j.slot) continue;
    const k = `${j.sock}\t${j.slot}`, ts = Number(j.ts) || 0;
    const prev = newest.get(k);
    if (!prev || ts > prev.ts) newest.set(k, { ts, status: String(j.status || ''), cwd: String(j.cwd || '') });
  }
  return newest;
}
// The newest event each session filed in its fleet's inboxes (the lead's, and a sub-lead's
// <sock>.<owner>.inbox): `done` there, with the session not working since, is a worker that
// said it finished. Only the tail is read; a lead's inbox runs to thousands of rows.
function lastEvents(dir, sock) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!(n === `${sock}.inbox` || (n.startsWith(`${sock}.`) && n.endsWith('.inbox')))) continue;
    let txt = '';
    try {
      const fd = fs.openSync(path.join(dir, n), 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 65536);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        txt = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    for (const line of txt.split('\n')) {
      const [ts, who, ev] = line.split('\t');
      const t = Number(ts);
      if (!t || !who || !ev || who.includes('/')) continue;
      const prev = out.get(who);
      if (!prev || t >= prev.ts) out.set(who, { ts: t, ev });
    }
  }
  return out;
}
// The linked worktrees of a project, from git's own files: <repo>/.git/worktrees/*/gitdir
// holds `<worktree>/.git`. A project registered at a plain folder of clones is each clone.
function worktreesOf(projectPath) {
  const repos = [];
  const isRepo = (d) => { try { return fs.statSync(path.join(d, '.git')).isDirectory(); } catch { return false; } };
  if (isRepo(projectPath)) repos.push(projectPath);
  else {
    let kids = [];
    try { kids = fs.readdirSync(projectPath, { withFileTypes: true }); } catch {}
    for (const k of kids) if (k.isDirectory() && isRepo(path.join(projectPath, k.name))) repos.push(path.join(projectPath, k.name));
  }
  const out = [];
  for (const r of repos) {
    out.push({ path: real(r), primary: true });
    let wts = [];
    try { wts = fs.readdirSync(path.join(r, '.git', 'worktrees')); } catch {}
    for (const w of wts) {
      let g = '';
      try { g = fs.readFileSync(path.join(r, '.git', 'worktrees', w, 'gitdir'), 'utf8').trim(); } catch { continue; }
      const wt = g.replace(/\/\.git\/?$/, '');
      if (wt && fs.existsSync(wt)) out.push({ path: real(wt), primary: false });
    }
  }
  return out;
}
// The checkout a directory is in: the nearest ancestor-or-self holding a `.git`, looked for
// no higher than `stop`. '' when there is none between them.
function checkoutOf(p, stop) {
  let d = p;
  for (let i = 0; i < 64 && d && under(d, stop); i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}

// ── one scan ───────────────────────────────────────────────────────────────
// `forStop` keeps, in memory only, the pid and port of what this scan does NOT list: another
// profile's items and agents' own sockets. stop() needs them to refuse one BY ITS KIND rather
// than answer "nothing matches", which would read as "it is gone" to someone about to look for
// it by hand. Never written to the cache, never printed beyond the refusal's kind.
export function scan({ dir = fleetDirDefault(), env = process.env, platform = process.platform, list = null, now = Math.floor(Date.now() / 1000), forStop = false } = {}) {
  const t0 = Date.now();
  const run = runner(env);
  const own = real(dir);
  const plist = list || projects();

  // Whose socket is it: own | other | none (sock_owner's three answers). ANY claimant that
  // is not this dir makes it another's — a socket two profiles claim is not this one's.
  const claim = new Map();
  for (const t of plist) {
    const d = real(path.join(t.cfg, 'fleet'));
    if (!claim.has(t.sock)) claim.set(t.sock, { dirs: new Set(), project: t });
    claim.get(t.sock).dirs.add(d);
  }
  const ownerOf = (sock) => {
    const c = claim.get(sock);
    if (!c) return 'none';
    for (const d of c.dirs) if (d !== own) return 'other';
    return 'own';
  };
  const projectOf = (sock) => claim.get(sock)?.project?.name || sock.replace(/^cf-/, '');
  const records = readRecords(dir);
  const hasRecord = (sock, slot) => records.has(`${sock}\t${slot}`);

  const procs = parsePs(run('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='],
    { extraEnv: { LC_ALL: 'C' } }).out);

  // ── the fleets ──
  const socks = new Set(liveSocks(env));
  for (const s of claim.keys()) if (ownerOf(s) === 'own') socks.add(s);   // a dead fleet's records are its lost sessions
  const paneOf = new Map();            // pane pid -> { sock, session|null, mine }
  const roots = [];                    // { root, sock, session|null, mine, state }
  const sessions = new Map();          // `${sock}\t${name}` -> this profile's sessions, with their state
  let other = 0;
  for (const sock of [...socks].sort()) {
    const owner = ownerOf(sock);
    const rows = fs.existsSync(path.join(tmuxSocketDir(env), sock)) ? panesOf(run, sock) : [];
    // A session of a socket no project claims is this profile's only when its record is here.
    const mineOf = (name) => owner === 'own' || (owner === 'none' && hasRecord(sock, name));
    const live = rows ? new Set() : null;
    const panes = new Set();
    let started = 0;
    for (const r of rows || []) {
      started = r.started || started;
      if (r.paneId && r.server) panes.add(`${r.paneId}@${r.server}`);
      const name = isTab(r.name) ? (r.tabFrom || '') : r.name;
      // A placeholder (`_hold-…`) or any other `_` session is the fleet's, not a session's.
      const session = name && !name.startsWith('_') ? name : null;
      const mine = session ? mineOf(session) : owner !== 'other';
      paneOf.set(r.pid, { sock, session, mine });
      if (!session) continue;
      if (!isTab(r.name)) live.add(session);
      const k = `${sock}\t${session}`;
      if (mine && !sessions.has(k)) sessions.set(k, { sock, project: projectOf(sock), session, root: real(r.path), live: true });
      if (!isTab(r.name)) roots.push({ root: real(r.path), sock, session, mine });
    }
    if (owner === 'other') continue;
    // The ones with no pane: asleep (the marker keeps its cwd), and lost (lib/fleet-scan.mjs,
    // the reader the grid draws its lost cards from).
    const marks = markersFor(dir, sock);
    for (const [slot, kinds] of marks) {
      if (!kinds.has('asleep') || slot.startsWith('_') || !mineOf(slot)) continue;
      const k = `${sock}\t${slot}`;
      let cwd = '';
      try { cwd = fs.readFileSync(path.join(dir, `${sock}.${slot}.asleep`), 'utf8').split('\n')[0].split('\t')[2] || ''; } catch {}
      if (!sessions.has(k)) sessions.set(k, { sock, project: projectOf(sock), session: slot, root: cwd ? real(cwd) : '', live: false });
      if (cwd && !(live && live.has(slot))) roots.push({ root: real(cwd), sock, session: slot, mine: true });
    }
    let lost = [];
    try { lost = lostSessions({ dir, sock, live, panes, started, now, cfg: path.dirname(dir) }); } catch {}
    for (const l of lost) {
      if (!mineOf(l.name)) continue;
      const k = `${sock}\t${l.name}`;
      if (!sessions.has(k)) sessions.set(k, { sock, project: projectOf(sock), session: l.name, root: real(l.cwd), live: false, lost: true });
      roots.push({ root: real(l.cwd), sock, session: l.name, mine: true });
    }
    // Each session's state, from the same markers and records the grid reads.
    const events = lastEvents(dir, sock);
    for (const s of sessions.values()) {
      if (s.sock !== sock) continue;
      const k = marks.get(s.session) || new Set();
      const rec = records.get(`${sock}\t${s.session}`);
      s.status = rec?.status || '';
      const ev = events.get(s.session);
      s.state = s.lost ? 'lost'
        : k.has('asleep') ? 'asleep'
        : k.has('exited') ? 'exited'
        : k.has('parked') ? 'parked'
        // Only the event's word, not its time against the record's: a record is rewritten by
        // events that are not turns, and a later turn leaves `working` or a newer row anyway.
        : (ev && ev.ev === 'done' && s.status !== 'working') ? 'done'
        : 'live';
      delete s.lost;
    }
  }
  // The worktrees of this profile's projects, for a listener no session holds.
  const worktrees = [];
  for (const [sock, c] of claim) {
    if (ownerOf(sock) !== 'own') continue;
    for (const w of worktreesOf(c.project.path)) worktrees.push({ ...w, sock, project: c.project.name });
  }
  const ownProjects = [...claim].filter(([s]) => ownerOf(s) === 'own').map(([sock, c]) => ({ sock, name: c.project.name, root: real(c.project.path) }));

  // ── a path to a tie ──
  const byPath = (p, how) => {
    if (!p) return null;
    p = real(p);
    let best = [], len = -1;
    for (const r of roots) {
      if (!r.root || !under(p, r.root)) continue;
      if (r.root.length > len) { best = [r]; len = r.root.length; }
      else if (r.root.length === len && !best.some(b => b.sock === r.sock && b.session === r.session)) best.push(r);
    }
    // a checkout of its own below the root is not the root's
    if (best.length) { const co = checkoutOf(p, best[0].root); if (co && co !== best[0].root) { best = []; len = -1; } }
    const wt = worktrees.filter(w => under(p, w.path)).sort((a, b) => b.path.length - a.path.length)[0];
    // A worktree with any session at or below it is held, whichever folder of it that is in.
    if (wt && wt.path.length > len && !roots.some(r => under(r.root, wt.path))) {
      if (!wt.primary) return { level: 'project', sock: wt.sock, project: wt.project, how, path: p, state: 'stopped', worktree: wt.path };
      best = [];
    }
    if (best.length === 1) {
      const b = best[0];
      return b.mine ? { level: 'session', sock: b.sock, session: b.session, project: projectOf(b.sock), how, path: p } : { level: 'other' };
    }
    if (best.length > 1) {
      if (best.every(b => !b.mine)) return { level: 'other' };
      const pj = best.find(b => b.mine);
      return { level: 'project', sock: pj.sock, project: projectOf(pj.sock), how, path: p, note: `${best.length} sessions share this folder` };
    }
    const pr = ownProjects.filter(x => under(p, x.root)).sort((a, b) => b.root.length - a.root.length)[0];
    return pr ? { level: 'project', sock: pr.sock, project: pr.name, how, path: p } : null;
  };
  const byParent = (pid) => {
    const chain = [];
    for (let p = pid, n = 0; p > 1 && n < 64; n++) {
      chain.push(p);
      const hit = paneOf.get(p);
      if (hit) {
        if (!hit.mine) return { level: 'other' };
        if (!hit.session) return { level: 'project', sock: hit.sock, project: projectOf(hit.sock), how: 'parent', chain, note: 'a pane of the fleet that is not a session' };
        return { level: 'session', sock: hit.sock, session: hit.session, project: projectOf(hit.sock), how: 'parent', chain };
      }
      const q = procs.get(p);
      if (!q) break;
      p = q.ppid;
    }
    return null;
  };

  // ── listeners ──
  const L = listeners(run, platform);
  const cwd = cwds(run, platform, [...new Set(L.rows.map(r => r.pid))]);
  const items = [];
  const listen = [];
  let agents = 0;
  const agentRows = [];
  for (const r of L.rows) {
    const pr = procs.get(r.pid);
    if (isAgent(pr?.cmd)) { agents++; if (forStop) agentRows.push({ kind: 'listen', port: r.port, pid: r.pid }); continue; }
    const c = cwd.get(r.pid) || '';
    const tie = byParent(r.pid) || byPath(c, 'cwd') || { level: 'machine' };
    listen.push({ kind: 'listen', port: r.port, addrs: r.addrs, pid: r.pid, start: pr?.start || '', name: progName(pr?.cmd), cmd: pr?.cmd || '', cwd: c, tie });
  }

  // ── containers ──
  let docker = 'missing';
  if (run.has('docker')) {
    const ps = run('docker', ['ps', '-q', '--no-trunc'], { timeout: 6000 });
    if (ps.status !== 0) docker = ps.timedOut ? 'timed out' : /cannot connect|daemon running|error during connect|connection refused/i.test(ps.err) ? 'not running' : 'failed';
    else {
      docker = 'ok';
      const ids = ps.out.split('\n').map(s => s.trim()).filter(Boolean);
      let info = [];
      if (ids.length) {
        const ins = run('docker', ['inspect', ...ids], { timeout: 8000 });
        try { info = JSON.parse(ins.out); } catch { info = []; docker = 'inspect failed'; }
      }
      for (const c of Array.isArray(info) ? info : []) {
        const labels = c?.Config?.Labels || {};
        const wd = labels['com.docker.compose.project.working_dir'] || '';
        const mounts = (c?.Mounts || []).filter(m => m && m.Type === 'bind' && m.Source).map(m => String(m.Source));
        const ports = [];
        for (const [to, binds] of Object.entries(c?.NetworkSettings?.Ports || {})) {
          for (const b of binds || []) if (Number(b?.HostPort) > 0 && !ports.some(x => x.host === Number(b.HostPort) && x.to === to)) ports.push({ host: Number(b.HostPort), to });
        }
        let tie = null;
        if (wd) { const t = byPath(wd, 'label'); if (t && t.level === 'session') tie = t; }
        if (!tie && mounts.length) {
          const ties = mounts.map(m => byPath(m, 'mount')).filter(t => t && t.level === 'session');
          const keys = new Set(ties.map(t => `${t.sock}\t${t.session}`));
          if (keys.size === 1) tie = ties[0];
          else if (keys.size > 1) tie = { level: 'project', sock: ties[0].sock, project: ties[0].project, how: 'mount', note: 'its mounts are in more than one session' };
        }
        if (!tie && wd) tie = byPath(wd, 'label');
        if (!tie) for (const m of mounts) { const t = byPath(m, 'mount'); if (t) { tie = t; break; } }
        items.push({ kind: 'container', id: String(c?.Id || '').slice(0, 12), name: String(c?.Name || '').replace(/^\//, ''),
                     image: String(c?.Config?.Image || ''), ports: ports.sort((a, b) => a.host - b.host), started: String(c?.State?.StartedAt || ''),
                     label: wd, mounts, tie: tie || { level: 'machine' } });
      }
    }
  }
  // Docker's own process is what listens on a container's published port (com.docker.backend
  // on a Mac, docker-proxy on Linux). That row IS the container, so it is folded into it
  // rather than listed beside it as a port nobody started.
  const published = new Set(items.filter(i => i.kind === 'container').flatMap(i => i.ports.map(p => p.host)));
  for (const l of listen) {
    if (published.has(l.port) && /docker|vpnkit/i.test(l.cmd) && l.tie.level === 'machine') continue;
    items.push(l);
  }

  // ── simulators ──
  let simctl = platform === 'darwin' ? 'none booted' : 'not macOS';
  if (platform === 'darwin' && [...procs.values()].some(p => progName(p.cmd) === 'launchd_sim')) {
    const r = run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeout: 12000 });
    if (r.missing) simctl = 'missing';
    else {
      let j = null;
      try { j = JSON.parse(r.out); } catch {}
      simctl = j ? 'ok' : 'failed';
      for (const [rt, devs] of Object.entries(j?.devices || {})) {
        for (const d of devs || []) {
          if (!d || d.state !== 'Booted' || !d.udid) continue;
          // Every process whose command names the device, tied through its parents. One
          // session among them ties it; two, or none, do not.
          const ties = [];
          for (const p of procs.values()) {
            if (!p.cmd.includes(d.udid) || progName(p.cmd) === 'launchd_sim') continue;
            const t = byParent(p.pid);
            if (t) ties.push({ ...t, how: 'argv', pid: p.pid });
          }
          const mine = ties.filter(t => t.level === 'session');
          const keys = new Set(mine.map(t => `${t.sock}\t${t.session}`));
          let tie = { level: 'machine' };
          if (keys.size === 1 && ties.every(t => t.level === 'session')) tie = mine[0];
          else if (ties.some(t => t.level === 'other') && !mine.length) tie = { level: 'other' };
          else if (keys.size > 1) tie = { level: 'machine', note: 'named by more than one session' };
          items.push({ kind: 'simulator', udid: d.udid, name: String(d.name || ''),
                       runtime: rt.replace(/^.*SimRuntime\./, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1'), tie });
        }
      }
    }
  }

  // ANOTHER PROFILE'S ITEMS ARE COUNTED, NOT KEPT: no name, no pid, no folder.
  const kept = [], others = [];
  for (const it of items) {
    if (it.tie.level !== 'other') { kept.push(it); continue; }
    other++;
    if (forStop) others.push({ kind: it.kind, port: it.port, pid: it.pid, id: it.id, name: it.name, udid: it.udid });
  }
  const res = {
    v: VERSION, at: now, took_ms: Date.now() - t0, spawned: run.spawned(), dir: own, platform,
    sources: { listen: L.source, docker, simctl },
    sessions: [...sessions.values()].sort((a, b) => (a.sock + a.session).localeCompare(b.sock + b.session)),
    items: kept, other, agents,
  };
  if (forStop) Object.defineProperties(res, { others: { value: others }, agentRows: { value: agentRows } });   // not enumerable: never serialised
  return res;
}

// ── the cache ──────────────────────────────────────────────────────────────
export function readCache(dir) {
  try { const j = JSON.parse(fs.readFileSync(cachePath(dir), 'utf8')); return j && j.v === VERSION ? j : null; } catch { return null; }
}
export function stampAge(dir, now = Math.floor(Date.now() / 1000)) {
  try { const at = Number(fs.readFileSync(stampPath(dir), 'utf8').trim()); return at > 0 ? now - at : Infinity; } catch { return Infinity; }
}
function writeAtomic(f, text) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}
// One scan at a time per profile: every fleet of a profile has its own governor, and the
// first one that finds the cache stale is the one that scans. A lock older than two minutes
// is a scan that died, not one in flight.
export function refresh({ dir = fleetDirDefault(), maxAge = PORTS_EVERY - 60, env = process.env, list = null } = {}) {
  if (stampAge(dir) < maxAge) return null;
  try { fs.mkdirSync(portsDir(dir), { recursive: true }); } catch { return null; }
  const lock = lockPath(dir);
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 120000) return null; fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx'); }
    catch { return null; }
  }
  try {
    if (stampAge(dir) < maxAge) return null;      // another governor finished while this one waited
    const res = scan({ dir, env, list });
    writeAtomic(cachePath(dir), JSON.stringify(res) + '\n');
    writeAtomic(stampPath(dir), `${res.at}\n`);
    return res;
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

// ── one session's view: what its Details sheet and `fleet-ports -s` show ────
export function sessionView(cache, sock, session) {
  if (!cache) return { at: null, state: null, items: [] };
  const s = (cache.sessions || []).find(x => x.sock === sock && x.session === session) || null;
  const items = (cache.items || []).filter(i => i.tie.level === 'session' && i.tie.sock === sock && i.tie.session === session);
  return { at: cache.at, sources: cache.sources, state: s ? s.state : null, status: s ? s.status : null, items };
}
// "asleep — still listening on :5173", or '' when the session is working or holds nothing.
export function flagLine(state, items) {
  if (!IDLE_STATES.includes(state) || !items.length) return '';
  const ports = [...new Set(items.flatMap(i => i.kind === 'listen' ? [i.port] : i.kind === 'container' ? i.ports.map(p => p.host) : []))].sort((a, b) => a - b);
  const nc = items.filter(i => i.kind === 'container').length, ns = items.filter(i => i.kind === 'simulator').length;
  const bits = [];
  if (ports.length) bits.push(`still listening on ${ports.map(p => ':' + p).join(', ')}`);
  const run = [nc ? `${nc} container${nc > 1 ? 's' : ''}` : '', ns ? `${ns} simulator${ns > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  if (run) bits.push(`${ports.length ? '' : 'still '}running ${run}`);
  return `${state} — ${bits.join(', ')}`;
}

// ── stopping one thing ─────────────────────────────────────────────────────
// ONE ITEM, BY WHAT THE SCAN CAPTURED, AND NOTHING BY PATTERN. A listener is its pid; a
// container its id (`docker stop`); a simulator its UDID (`xcrun simctl shutdown`). There is
// no pkill, no killall and no "everything on this port" anywhere here: a pattern is a guess
// about which processes are meant, and this file exists because guessing is what went wrong.
//
// WHAT IS NEVER STOPPED, each refused by its kind (`code`) and before anything is sent:
//   work     the work profile's fleets, whoever runs this — its sessions belong to another
//            account's day, and their leftovers are that day's to judge.
//   other    another profile's: counted by the scan, never listed, never stopped from here.
//   agent    an agent's own socket — it closes with the agent; stopping it kills the session.
//   machine  not tied to a session or project of this profile: nothing here can say it is ours.
// Allowed: tied to a session, or to a project of this profile (a worktree no session holds,
// a folder two sessions share).
//
// THE PID IS RE-READ IMMEDIATELY BEFORE THE SIGNAL. A pid outlives nothing: once its process
// exits, the number is handed to the next one. So the start time and the whole command line
// the scan saw are compared with a fresh `ps` of that one pid in the instant before the kill,
// and a difference in either refuses (`changed`): the number now names some other process. A
// caller that showed a person an item (the web client's Details) sends the identity it showed,
// and that is compared too, so what is stopped is what was confirmed — not what is on that
// port now.
//
// TERM, THEN REPORT; KILL ONLY AS A SECOND CONFIRMATION. A TERM waits up to 3 s for the process
// to go, and says which it did. KILL is accepted only for a pid this tool sent TERM to in the
// last ten minutes and that is still that same process (ports/stops.json) — so it can never be
// the first thing a process receives from here. A container has no KILL here: `docker stop`
// escalates on its own after its grace period. Nothing is ever restarted.
export const KILL_WINDOW = 600;
const stopsPath = (dir) => path.join(portsDir(dir), 'stops.json');
export const isWorkDir = (dir) => real(dir) === real(path.join(cfgFor('work'), 'fleet'));
const STOPPABLE = new Set(['session', 'project']);

// The one process, now: its state, start and command, in the scan's own format. A zombie is
// gone: it holds no socket, and only its parent's wait() is left of it.
export function identityOf(pid, env = process.env) {
  const r = spawnSync('ps', ['-ww', '-o', 'stat=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
    { encoding: 'utf8', env: { ...env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^\s*(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
    if (m) return { pid: Number(pid), zombie: m[1].startsWith('Z'), start: m[2].replace(/\s+/g, ' '), cmd: m[3] };
  }
  return null;
}
const sameProcess = (a, b) => !!a && !!b && a.start === b.start && a.cmd === b.cmd;

// What a person typed, as a want: `:5173` a port, a bare number a pid, anything else a
// container's id or name, or a simulator's UDID or name.
export function wantOf(spec) {
  const s = String(spec || '').trim();
  if (/^:\d+$/.test(s)) return { kind: 'listen', port: Number(s.slice(1)) };
  if (/^\d+$/.test(s)) return { kind: 'listen', pid: Number(s) };
  return s ? { text: s } : null;
}
const label = (it) => it.kind === 'listen' ? `:${it.port} ${it.name || '?'} (pid ${it.pid})`
  : it.kind === 'container' ? `container ${it.name || it.id}` : `simulator ${it.name}`;
const brief = (it) => it && ({ kind: it.kind, port: it.port, pid: it.pid, start: it.start, cmd: it.cmd, name: it.name, id: it.id, udid: it.udid, tie: it.tie });

function matches(it, w) {
  if (w.text) {
    const q = w.text.toLowerCase();
    if (it.kind === 'container') return q.length >= 4 && (it.id.startsWith(q) || it.name.toLowerCase() === q);
    if (it.kind === 'simulator') return it.udid.toLowerCase() === q || it.name.toLowerCase() === q;
    return false;
  }
  if (w.kind && w.kind !== it.kind) return false;
  if (it.kind === 'listen') return (w.port == null || w.port === it.port) && (w.pid == null || w.pid === it.pid) && (w.port != null || w.pid != null);
  if (it.kind === 'container') return !!w.id && it.id.startsWith(String(w.id).slice(0, 12));
  if (it.kind === 'simulator') return !!w.udid && it.udid === w.udid;
  return false;
}
function readStops(dir, now) {
  try { return JSON.parse(fs.readFileSync(stopsPath(dir), 'utf8')).filter(r => now - r.at < KILL_WINDOW); } catch { return []; }
}
const refuse = (code, text, item = null) => ({ ok: false, result: 'refused', code, text, item: brief(item) });

// stop({ dir, want, kill }) -> { ok, result: stopped | still-running | refused | failed, code, text, item }
//   want: { kind, port, pid, id, udid } or { text }, plus what was shown — { start, cmd } for a
//   listener, { sock, session } for the session whose Details it was shown in.
// `ident` is the pre-signal re-read, injectable so the suite can prove a pid reused between the
// scan and the signal is refused (it cannot make the kernel reuse one on cue).
export function stop({ dir = fleetDirDefault(), want, kill = false, env = process.env, list = null, platform = process.platform, waitMs = 3000, now = Math.floor(Date.now() / 1000), ident = identityOf } = {}) {
  if (!want) return refuse('usage', 'name what to stop: :PORT, a pid, a container id or name, or a simulator UDID or name');
  if (isWorkDir(dir)) return refuse('work', 'refusing — this is the work profile\'s fleet, and its sessions\' leftovers are never stopped from here');
  const res = scan({ dir, env, list, platform, forStop: true });
  const what = want.text || (want.port != null ? `:${want.port}` : want.pid != null ? `pid ${want.pid}` : want.id || want.udid || '?');
  if (res.agentRows.some(a => matches({ ...a, name: '' }, want))) return refuse('agent', `refusing — ${what} is an agent's own socket, and closes with it; stop the session instead (fleet-stop)`);
  if (res.others.some(o => matches({ ...o, id: o.id || '', name: o.name || '', udid: o.udid || '' }, want)))
    return refuse('other', `refusing — ${what} belongs to another profile's fleet; stop it from that profile (fleet-ports stop, run as that profile)`);
  // One process listening on two ports (a dev server and its reload socket) is one thing to stop:
  // its rows collapse to the first, since the signal goes to the pid either way.
  const hits = res.items.filter(it => matches(it, want))
    .filter((it, i, all) => it.kind !== 'listen' || all.findIndex(o => o.kind === 'listen' && o.pid === it.pid) === i);
  if (!hits.length) return refuse('gone', `nothing this profile's fleets hold matches ${what} — it may have stopped already (fleet-ports to look again)`);
  if (hits.length > 1) return refuse('ambiguous', `${what} names ${hits.length} things: ${hits.map(label).join(', ')} — name one by its pid, id or UDID`);
  const it = hits[0];
  if (!STOPPABLE.has(it.tie.level)) return refuse('machine', `refusing — ${label(it)} is not tied to a session or project of this profile's fleets, so nothing here can say it is yours to stop`, it);
  if (want.session && (it.tie.level !== 'session' || it.tie.sock !== want.sock || it.tie.session !== want.session))
    return refuse('moved', `refusing — ${label(it)} is no longer tied to ${want.session}; look again before stopping it`, it);
  if (it.kind === 'listen' && (want.start || want.cmd) && !sameProcess(it, { start: want.start ?? it.start, cmd: want.cmd ?? it.cmd }))
    return refuse('changed', `refusing — pid ${it.pid} is no longer the process that was shown (its ${want.start && want.start !== it.start ? 'start time' : 'command'} changed: the pid was reused). Nothing was sent.`, it);
  if (kill && it.kind !== 'listen') return refuse('kill-kind', `${label(it)} has no KILL here — ${it.kind === 'container' ? 'docker stop escalates on its own after its grace period' : 'a simulator is shut down, not killed'}`, it);

  const after = (out) => {
    // The cache, without what just went: the next Details or `fleet-ports --cached` shows it gone
    // without a second scan.
    try {
      const keep = out.result === 'stopped' ? res.items.filter(x => x !== it) : res.items;
      fs.mkdirSync(portsDir(dir), { recursive: true });
      writeAtomic(cachePath(dir), JSON.stringify({ ...res, items: keep }) + '\n');
      writeAtomic(stampPath(dir), `${res.at}\n`);
    } catch {}
    return { ...out, item: brief(it) };
  };
  const run = runner(env);
  if (it.kind === 'container') {
    const r = run('docker', ['stop', it.id], { timeout: 30000 });
    return after(r.status === 0 ? { ok: true, result: 'stopped', text: `stopped ${label(it)} (docker stop ${it.id})` }
      : { ok: false, result: 'failed', code: 'docker', text: `docker stop ${it.id} failed: ${(r.err || '').trim().slice(0, 200) || 'exit ' + r.status}` });
  }
  if (it.kind === 'simulator') {
    const r = run('xcrun', ['simctl', 'shutdown', it.udid], { timeout: 30000 });
    return after(r.status === 0 ? { ok: true, result: 'stopped', text: `shut down ${label(it)} (simctl shutdown ${it.udid})` }
      : { ok: false, result: 'failed', code: 'simctl', text: `simctl shutdown ${it.udid} failed: ${(r.err || '').trim().slice(0, 200) || 'exit ' + r.status}` });
  }

  const stops = readStops(dir, now);
  if (kill && !stops.some(r => r.pid === it.pid && sameProcess(r, it)))
    return refuse('kill-needs-term', `refusing — KILL is a second confirmation: send TERM first (fleet-ports stop :${it.port}), and KILL only if that leaves it running`, it);
  // the instant before the signal: is this pid still the process the scan found?
  const live = ident(it.pid, env);
  if (!live || live.zombie) return after({ ok: true, result: 'stopped', text: `${label(it)} had already exited` });
  if (!sameProcess(live, it))
    return refuse('changed', `refusing — pid ${it.pid} is no longer the process that was scanned (its ${live.start !== it.start ? 'start time' : 'command'} changed: the pid was reused). Nothing was sent.`, it);
  const sig = kill ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(it.pid, sig); }
  catch (e) { return after(e.code === 'ESRCH' ? { ok: true, result: 'stopped', text: `${label(it)} had already exited` } : { ok: false, result: 'failed', code: 'signal', text: `${sig} to pid ${it.pid} failed: ${e.code || e.message}` }); }
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < waitMs) {
    const now2 = identityOf(it.pid, env);
    if (!now2 || now2.zombie || !sameProcess(now2, it)) { gone = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!kill) {
    try {
      fs.mkdirSync(portsDir(dir), { recursive: true });
      writeAtomic(stopsPath(dir), JSON.stringify([...stops.filter(r => r.pid !== it.pid), { pid: it.pid, start: it.start, cmd: it.cmd, at: now, signal: 'TERM' }]) + '\n');
    } catch {}
  }
  if (gone) return after({ ok: true, result: 'stopped', text: `stopped ${label(it)} — sent ${sig.slice(3)}, it exited in ${secs} s` });
  return after({ ok: true, result: 'still-running', text: kill ? `sent KILL to ${label(it)} and it is still there after ${secs} s — look at it by hand (ps -p ${it.pid})`
    : `sent TERM to ${label(it)}; it is still running after ${secs} s. To force it: fleet-ports stop --kill ${it.pid}` });
}

// ── fleet-ports, the terminal's view ───────────────────────────────────────
const HOME = os.homedir();
const tilde = (p) => (p && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p || '');
function ago(s) {
  if (s < 5) return 'just now';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
export function howText(it) {
  const t = it.tie;
  if (t.how === 'parent') return `parent: ${(t.chain || []).join(' ← ')} (pane)`;
  if (t.how === 'cwd') return `cwd ${tilde(t.path)}`;
  if (t.how === 'label') return `compose working_dir ${tilde(t.path)}`;
  if (t.how === 'mount') return `bind mount ${tilde(t.path)}`;
  if (t.how === 'argv') return `named by pid ${t.pid} (${(t.chain || []).join(' ← ')}, pane)`;
  return '';
}
function itemLine(it) {
  if (it.kind === 'listen') return `:${String(it.port).padEnd(6)} ${String(it.name || '?').slice(0, 18).padEnd(18)} pid ${String(it.pid).padEnd(7)} ${howText(it)}`;
  if (it.kind === 'container') return `container ${it.name || it.id} (${it.image})${it.ports.length ? ' ' + it.ports.map(p => `:${p.host}→${p.to}`).join(' ') : ''}  ${howText(it)}`;
  return `simulator ${it.name} (${it.runtime})  ${howText(it)}`;
}
export function render(cache, { only = null, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!cache) return 'fleet-ports: nothing scanned yet';
  const out = [];
  const src = cache.sources || {};
  out.push(`fleet-ports — ${tilde(cache.dir)}, scanned ${ago(Math.max(0, now - cache.at))} (listeners: ${src.listen} · docker: ${src.docker} · simulators: ${src.simctl})`);
  const sessions = (cache.sessions || []).filter(s => !only || (s.sock === only.sock && s.session === only.session));
  if (only && !sessions.length) out.push('', `${only.session} on ${only.sock}: no such session of this profile's fleets`);
  const byProject = new Map();
  for (const s of sessions) { if (!byProject.has(s.sock)) byProject.set(s.sock, []); byProject.get(s.sock).push(s); }
  for (const it of cache.items) if (!only && it.tie.level === 'project' && !byProject.has(it.tie.sock)) byProject.set(it.tie.sock, []);
  for (const [sock, list] of byProject) {
    const proj = list[0]?.project || cache.items.find(i => i.tie.sock === sock)?.tie.project || sock;
    const rows = [];
    for (const s of list) {
      const v = sessionView(cache, s.sock, s.session);
      if (!v.items.length && (only === null)) continue;
      rows.push(`  ${s.session.padEnd(16)} ${flagLine(s.state, v.items) || (s.state === 'live' ? (s.status || 'live') : s.state)}`);
      for (const it of v.items) rows.push(`      ${itemLine(it)}`);
      if (!v.items.length) rows.push('      nothing listening, no container, no simulator');
    }
    if (!only) {
      const stopped = cache.items.filter(i => i.tie.level === 'project' && i.tie.sock === sock && i.tie.state === 'stopped');
      const loose = cache.items.filter(i => i.tie.level === 'project' && i.tie.sock === sock && i.tie.state !== 'stopped');
      const wts = new Map();
      for (const it of stopped) { if (!wts.has(it.tie.worktree)) wts.set(it.tie.worktree, []); wts.get(it.tie.worktree).push(it); }
      for (const [wt, its] of wts) {
        rows.push(`  ${'(no session)'.padEnd(16)} ${flagLine('stopped', its)} — ${tilde(wt)}, no session holds it`);
        for (const it of its) rows.push(`      ${itemLine(it)}`);
      }
      if (loose.length) {
        rows.push(`  not tied to a session`);
        for (const it of loose) rows.push(`      ${itemLine(it)}${it.tie.note ? ` — ${it.tie.note}` : ''}`);
      }
    }
    if (rows.length) out.push('', `${proj}  (${sock})`, ...rows);
  }
  if (!only) {
    const machine = cache.items.filter(i => i.tie.level === 'machine');
    if (machine.length) {
      out.push('', 'not tied to any session (this machine)');
      for (const it of machine) out.push(`  ${it.kind === 'listen' ? `:${String(it.port).padEnd(6)} ${String(it.name || '?').slice(0, 18).padEnd(18)} pid ${it.pid}${it.cwd ? '  ' + tilde(it.cwd) : ''}` : itemLine(it)}${it.tie.note ? ` — ${it.tie.note}` : ''}`);
    }
    if (cache.agents) out.push('', `${cache.agents} ${cache.agents === 1 ? 'port is' : 'ports are'} an agent's own, and close${cache.agents === 1 ? 's' : ''} with it — not listed.`);
    if (cache.other) out.push('', `${cache.other} more ${cache.other === 1 ? 'belongs' : 'belong'} to another profile's fleets — run fleet-ports from that profile to see ${cache.other === 1 ? 'it' : 'them'}.`);
  }
  return out.join('\n');
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (process.argv[1] && isMain()) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  let dir = fleetDirDefault(), json = false, cached = false, only = null, maxAge = PORTS_EVERY - 60, write = true;
  // fleet-ports stop <:PORT | PID | container | simulator> [--kill] [--json]. `--want JSON` is
  // fleet-serve's: the item exactly as Details showed it, so the confirmed one is the one stopped.
  // Exit 0 stopped, 1 still running, 3 refused, 4 failed, 2 usage.
  if (argv[0] === 'stop' && cmd === 'cli') {
    argv.shift();
    let want = null, kill = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--dir') dir = argv[++i] || dir;
      else if (a === '--json') json = true;
      else if (a === '--kill') kill = true;
      else if (a === '--want') { try { want = JSON.parse(argv[++i] || ''); } catch { want = null; } }
      else if (a.startsWith('-') && !/^-?\d+$/.test(a)) { process.stderr.write(`fleet-ports stop: unknown argument '${a}'\n`); process.exit(2); }
      else if (!want) want = wantOf(a);
      else { process.stderr.write(`fleet-ports stop: one thing at a time ('${a}')\n`); process.exit(2); }
    }
    if (!want) { process.stderr.write('usage: fleet-ports stop <:PORT | PID | container id or name | simulator UDID or name> [--kill] [--json]\n'); process.exit(2); }
    const r = stop({ dir, want, kill });
    if (json) process.stdout.write(JSON.stringify(r) + '\n');
    else (r.ok ? process.stdout : process.stderr).write(`fleet-ports: ${r.text}\n`);
    process.exit(r.result === 'stopped' ? 0 : r.result === 'still-running' ? 1 : r.result === 'refused' ? (r.code === 'usage' ? 2 : 3) : 4);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dir = argv[++i] || dir;
    else if (a === '--json') json = true;
    else if (a === '--cached') cached = true;
    else if (a === '--no-write') write = false;          // a look that leaves the cache as it was
    else if (a === '--max-age') maxAge = Number(argv[++i]);
    else if (a === '-s') { only = { sock: argv[i + 1] || '', session: argv[i + 2] || '' }; i += 2; }
    else if (a === '-h' || a === '--help') { process.stdout.write('usage: fleet-ports [--json] [--cached | --no-write] [-s SOCKET NAME]\n       fleet-ports stop <:PORT | PID | container | simulator> [--kill] [--json]\n'); process.exit(0); }
    else { process.stderr.write(`fleet-ports: unknown argument '${a}'\n`); process.exit(2); }
  }
  if (cmd === 'refresh') {
    try { refresh({ dir, maxAge: Number.isFinite(maxAge) ? maxAge : PORTS_EVERY - 60 }); } catch {}
    process.exit(0);
  }
  if (cmd !== 'cli') { process.stderr.write('usage: ports.mjs cli [--json] [--cached] [-s SOCKET NAME] | refresh [--max-age N]\n'); process.exit(2); }
  if (only) {
    if (!only.sock || !only.session) { process.stderr.write('fleet-ports: -s takes a socket and a session name\n'); process.exit(2); }
    // ANOTHER PROFILE'S SESSION IS REFUSED BY NAME, with the run that would answer: its ties
    // are decided by that profile's records, which this run does not read (fleet-hibernate's
    // refuse_foreign, #195).
    const own = real(dir);
    const theirs = projects().filter(t => t.sock === only.sock).map(t => real(path.join(t.cfg, 'fleet'))).find(d => d !== own);
    if (theirs) {
      process.stderr.write(`fleet-ports: refusing — ${only.sock} is another profile's fleet. Its records are in ${theirs}, and this run reads ${dir}. Run it as: CLAUDE_FLEET_DIR=${theirs} fleet-ports -s ${only.sock} ${only.session}\n`);
      process.exit(2);
    }
  }
  let cache = cached ? readCache(dir) : null;
  if (!cache) {
    cache = scan({ dir });
    if (write) {
      try { fs.mkdirSync(portsDir(dir), { recursive: true }); writeAtomic(cachePath(dir), JSON.stringify(cache) + '\n'); writeAtomic(stampPath(dir), `${cache.at}\n`); } catch {}
    }
  }
  if (json) {
    const body = only ? { ...sessionView(cache, only.sock, only.session), sock: only.sock, session: only.session } : cache;
    if (only) body.flag = flagLine(body.state, body.items);
    process.stdout.write(JSON.stringify(body) + '\n');
  } else process.stdout.write(render(cache, { only }) + '\n');
}
