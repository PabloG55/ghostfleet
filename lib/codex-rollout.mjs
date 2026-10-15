#!/usr/bin/env node
// lib/codex-rollout.mjs — which codex conversation a fleet pane is in, written down where
// the fleet looks for every other agent's: <fleet-dir>/<id>.json.
//
//   node lib/codex-rollout.mjs watch --pid <pid> --sock <sock> --cwd <dir> --since <epoch>
//                                    [--slot <name>] [--resume <id>] [--fleet-dir <dir>]
//        what bin/codex-here starts beside codex: polls until <pid> exits, keeping the
//        record current — including when codex starts a NEW conversation in the same pane
//   node lib/codex-rollout.mjs resolve --pid <pid>
//        "<id>\x1f<rollout>" of the conversation that process is writing, or nothing
//   node lib/codex-rollout.mjs find --cwd <dir> --since <epoch>
//        the rollouts of conversations started in <dir> since <epoch>, newest first
//   node lib/codex-rollout.mjs open <rollout>
//        exit 0 when some process has that rollout open: the conversation is live somewhere
//
// ── WHY CODEX NEEDED THIS AND CLAUDE DID NOT ──────────────────────────────────
// Claude's hooks hand the fleet a session_id and a transcript path on every event
// (hooks/fleet-event.sh). Codex has no hooks, so a codex session left NO record: after a
// kernel panic took every fleet, a codex conversation that was intact on disk — its rollout
// ending in task_complete — looked lost, because nothing in the fleet said which of the
// rollouts under ~/.codex/sessions was that pane's. The launcher could only guess with
// `codex resume --last`, which is the newest conversation in the folder, i.e. --continue.
//
// ── WHAT A ROLLOUT IS, MEASURED ON codex-cli 0.160.1 ──────────────────────────
//   - ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl, created at the FIRST
//     user message, not at launch: a TUI that never took a turn has no rollout at all.
//   - line 1 is {type:"session_meta", payload:{id, cwd, timestamp, …}}; payload.timestamp
//     is when the conversation was created (the TUI's start), not when the file was.
//   - WRITTEN AS IT GOES. 0.146.0 persisted only on a clean exit; 0.160.1 does not wait:
//     a server killed between turns, and another killed MID-TURN, both left the user's
//     message on disk, and `codex resume <id>` brought the conversation back.
//   - `codex resume <id>` APPENDS to the same file under the same id. So a conversation
//     is one file for its whole life, and the id is a stable key, as claude's is.
//   - THE PROCESS HOLDS IT OPEN between writes (lsof shows it on the codex pid). That is
//     the strongest evidence there is: not "a rollout in this folder started about then",
//     which two parallel sessions in one checkout share, but "the file this process is
//     writing". Folder + start time is the fallback for a machine with neither lsof nor
//     /proc, and it refuses a rollout another record already claims.
//
// Node builtins only, like everything on the bins' import path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// The first line only. It carries the model's base instructions, so it runs to tens of KB;
// read in chunks up to the newline rather than the whole file (rollouts reach many MB).
export function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    let acc = '', pos = 0;
    while (acc.length < 4 * 1024 * 1024) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const s = buf.toString('utf8', 0, n);
      const nl = s.indexOf('\n');
      if (nl >= 0) { acc += s.slice(0, nl); break; }
      acc += s;
    }
    const j = JSON.parse(acc);
    if (j?.type !== 'session_meta' || !j.payload?.id) return null;
    const t = Date.parse(j.payload.timestamp || j.timestamp || '');
    return { id: String(j.payload.id), cwd: String(j.payload.cwd || ''), started: Number.isFinite(t) ? Math.floor(t / 1000) : 0 };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Where a conversation is in its turn, from the newest turn event in the tail: a
// task_started with no task_complete (or turn_aborted) after it is a turn still running.
export function rolloutStatus(file) {
  let txt = '';
  try {
    const st = fs.statSync(file); const len = Math.min(st.size, 262144);
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); txt = b.toString('utf8');
  } catch { return ''; }
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"event_msg"')) continue;
    let t = '';
    try { const j = JSON.parse(lines[i]); if (j.type === 'event_msg') t = j.payload?.type || ''; } catch { continue; }
    if (t === 'task_started') return 'working';
    if (t === 'task_complete' || t === 'turn_aborted') return 'ready';
  }
  return 'idle';
}

// The date folders a conversation started since `since` can be in. Named in LOCAL time
// (the file name's clock is local; payload.timestamp is UTC), so one day either side.
function dayDirs(home, since) {
  const out = [];
  const end = Date.now() + 86400e3;
  for (let t = (since - 86400) * 1000; t <= end; t += 86400e3) {
    const d = new Date(t);
    const p = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function findRollouts({ home = codexHome(), cwd, since = 0, slack = 5 }) {
  const want = real(cwd);
  const out = [];
  for (const dir of dayDirs(home, since)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      const file = path.join(dir, n);
      const m = readMeta(file);
      if (!m || real(m.cwd) !== want || m.started < since - slack) continue;
      out.push({ ...m, file });
    }
  }
  return out.sort((a, b) => b.started - a.started);
}

// By id, for a resumed conversation: its file carries the id in its name. Newest folder first.
export function rolloutById(id, home = codexHome()) {
  if (!/^[0-9A-Za-z-]+$/.test(String(id || ''))) return '';
  const root = path.join(home, 'sessions');
  const ls = (p) => { try { return fs.readdirSync(p).sort().reverse(); } catch { return []; } };
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    const hit = ls(dir).find(n => n.endsWith(`-${id}.jsonl`) && n.startsWith('rollout-'));
    if (hit) return path.join(dir, hit);
  }
  return '';
}

// A pid and every process under it. codex is exec'd by codex-here, but a build that is a
// wrapper (the npm one is node around a native binary) writes from a child.
function tree(pid) {
  let rows = [];
  try { rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); } catch { return [String(pid)]; }
  const kids = new Map();
  for (const r of rows) { const [p, pp] = r.trim().split(/\s+/); if (p && pp) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); } }
  const out = [String(pid)];
  for (let i = 0; i < out.length && out.length < 256; i++) out.push(...(kids.get(out[i]) || []));
  return out;
}

const ROLLOUT_RE = /\/rollout-[^/]*\.jsonl$/;
// null = could not look (no lsof, no /proc): the caller falls back. [] = looked, none open.
export function openRollouts(pid) {
  const pids = tree(pid);
  if (fs.existsSync('/proc/self/fd')) {
    const out = [];
    for (const p of pids) {
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { continue; }
      for (const f of fds) { try { const t = fs.readlinkSync(`/proc/${p}/fd/${f}`); if (ROLLOUT_RE.test(t)) out.push(t); } catch {} }
    }
    return [...new Set(out)];
  }
  const bin = lsofBin();
  if (!bin) return null;
  // THE OUTPUT, WHATEVER THE EXIT STATUS. lsof exits 1 when ANY pid it was given has
  // nothing to list — and the tree includes this watcher's own short-lived subshell, a
  // child of the codex pid. Reading only a zero exit threw away the line naming the rollout
  // and recorded nothing, while the same call on one pid worked: measured, not guessed.
  const r = spawnSync(bin, ['-n', '-P', '-F', 'n', '-a', '-p', pids.join(','), '-d', '0-9999'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return [...new Set(String(r.stdout || '').split('\n').filter(l => l.startsWith('n') && ROLLOUT_RE.test(l)).map(l => l.slice(1)))];
}

// macOS keeps lsof in /usr/sbin, which a pane's PATH does not always carry. Missed there,
// every "is this rollout open" answered no — silently, which is the one wrong answer here.
let lsofCache;
function lsofBin() {
  if (lsofCache !== undefined) return lsofCache;
  for (const c of ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof']) if (fs.existsSync(c)) return (lsofCache = c);
  try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); return (lsofCache = 'lsof'); } catch (e) { return (lsofCache = e?.code === 'ENOENT' ? '' : 'lsof'); }
}

// Is anybody writing this rollout right now? Answers "the conversation is open in some pane",
// which is what keeps a reopen from resuming one conversation into two panes.
export function rolloutOpen(file) {
  if (!file) return false;
  if (fs.existsSync('/proc/self/fd')) {
    const want = real(file);
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return false; }
    for (const p of pids) {
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { continue; }
      for (const f of fds) { try { if (fs.readlinkSync(`/proc/${p}/fd/${f}`) === want) return true; } catch {} }
    }
    return false;
  }
  const bin = lsofBin();
  if (!bin) return false;
  const r = spawnSync(bin, ['-t', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return /\d/.test(String(r.stdout || ''));
}

// The conversation a codex process is in. The newest-started of the rollouts it holds,
// because a /new keeps the old file open for a moment while the new one begins.
export function resolvePid(pid) {
  const open = openRollouts(pid);
  if (!open || !open.length) return null;
  const metas = open.map(f => ({ ...readMeta(f), file: f })).filter(m => m.id);
  metas.sort((a, b) => b.started - a.started);
  return metas[0] || null;
}

// ── THE RECORD ────────────────────────────────────────────────────────────────
// The same shape hooks/fleet-event.sh writes for claude, so every reader that already finds
// a claude conversation — lostSessions, fleet-restart --reopen, fleet-read, the phone — finds
// a codex one by the same fields. `transcript` is the rollout; `agent` says which reader
// applies. Atomic, like the hook's.
export function writeRecord(dir, rec) {
  const file = path.join(dir, `${rec.session_id}.json`);
  const tmp = path.join(dir, `.${rec.session_id}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch {} return false; }
}

function claimedElsewhere(dir, id, sock, slot) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    return !!j.sock && !!j.slot && (j.sock !== sock || j.slot !== slot);
  } catch { return false; }
}

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// One look: which conversation is this pane in now, and does its record say so?
export function tick(o, state = {}) {
  let hit = null;
  const open = resolvePid(o.pid);
  if (open) hit = open;
  else if (openRollouts(o.pid) === null) {
    // Nothing to ask the process with. A resume names its id; otherwise the newest rollout
    // started in this folder since launch that no other session's record claims.
    const byId = o.resume ? rolloutById(o.resume, o.home) : '';
    if (byId) hit = { ...readMeta(byId), file: byId };
    else hit = findRollouts({ home: o.home, cwd: o.cwd, since: o.since })
      .find(r => !claimedElsewhere(o.dir, r.id, o.sock, o.slot)) || null;
  }
  if (!hit?.id) return state;
  // The slot is the pane's name NOW (a rename does not reach this process's argv), asked of
  // tmux by pane id, the way the hook asks.
  let slot = o.slot;
  if (o.paneId) {
    const n = sh('tmux', ['-L', o.sock, 'display-message', '-p', '-t', o.paneId, '#{session_name}']);
    if (n && !n.startsWith('_') && !n.startsWith('+')) slot = n;
  }
  let mt = 0; try { mt = Math.floor(fs.statSync(hit.file).mtimeMs / 1000); } catch {}
  const status = rolloutStatus(hit.file);
  const key = `${hit.id}|${slot}|${status}|${mt}`;
  if (key === state.key) return state;
  const cwd = hit.cwd || o.cwd;
  const rec = {
    session_id: hit.id, agent: 'codex', zellij: '', sock: o.sock, slot, pane: o.pane || '',
    cwd, folder: path.basename(cwd), branch: sh('git', ['-C', cwd, '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD']),
    status, transcript: hit.file, ts: Math.floor(Date.now() / 1000),
  };
  if (!o.dryRun) writeRecord(o.dir, rec);
  return { key, rec };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
    else (o._ ||= []).push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const home = a.home || codexHome();
  if (cmd === 'resolve') {
    const r = a.pid ? resolvePid(a.pid) : null;
    if (r) process.stdout.write(`${r.id}\x1f${r.file}\n`);
    process.exit(r ? 0 : 1);
  }
  if (cmd === 'find') {
    for (const r of findRollouts({ home, cwd: a.cwd || process.cwd(), since: Number(a.since) || 0 })) process.stdout.write(`${r.id}\x1f${r.file}\x1f${r.started}\n`);
    return;
  }
  if (cmd === 'open') process.exit(rolloutOpen((a._ || [])[0]) ? 0 : 1);
  if (cmd === 'watch') {
    const dir = a['fleet-dir'] || process.env.CLAUDE_FLEET_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'fleet');
    const o = {
      pid: Number(a.pid), sock: String(a.sock || ''), slot: String(a.slot || ''), cwd: String(a.cwd || process.cwd()),
      since: Number(a.since) || Math.floor(Date.now() / 1000), resume: a.resume === true ? '' : String(a.resume || ''),
      dir, home, paneId: String(a['pane-id'] || ''), pane: String(a.pane || ''),
    };
    if (!o.pid || !o.sock) process.exit(2);
    const every = Math.max(200, Number(process.env.CLAUDE_FLEET_CODEX_POLL_MS) || 3000);
    let state = {};
    // Until the process is gone. A crash takes this with it (same process group, same
    // SIGHUP), which is right: the record must say what the pane was in WHEN it died.
    while (alive(o.pid)) {
      try { state = tick(o, state); } catch (e) { if (process.env.CLAUDE_FLEET_CODEX_DEBUG) process.stderr.write(`tick: ${e.stack}\n`); }
      if (process.env.CLAUDE_FLEET_CODEX_DEBUG) process.stderr.write(`tick pid=${o.pid} open=${JSON.stringify(openRollouts(o.pid))} rec=${state.rec?.session_id || '-'}\n`);
      await new Promise(r => setTimeout(r, every));
    }
    return;
  }
  process.stderr.write('usage: codex-rollout.mjs watch|resolve|find|open …\n');
  process.exit(2);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
