// lib/know.mjs — the fleet's memory: what every project is, where it stands, and why.
//
// A lead's knowledge of the fleet is whatever is in its context, and a context drifts and
// resets. Ghostfleet already SEES every spawn, prompt, turn end, PR, merge and ledger item,
// but kept each as a per-purpose file (the inbox, the ledger, the manifest, the PR cache),
// so "where does acme-api stand" was answered by reading five files and remembering the
// rest. This is the one place that keeps it, in three layers (docs/MEMORY.md):
//
//   RAW EVENTS  <fleet-dir>/know.jsonl, one per profile, APPEND-ONLY. The source of truth.
//               Written by bin/fleet-know-event from the places that already see things —
//               never reconstructed afterwards from their files.
//   THE GRAPH   <fleet-dir>/know.graph.json, DERIVED from the log by fold() below and
//               rebuildable from scratch at any time. A bug in derivation is fixed by
//               fixing fold() and rebuilding, never by editing the data.
//   INFERRED    facts a small model read off a finished turn ("decided X because Y"),
//               written as ordinary events marked `inferred`, linked to their turn. Off by
//               default (fleet-experimental), never for a private project.
//
// ── WHY THE GRAPH IS MARKS, NOT STATE ──────────────────────────────────────
// Every profile has its own log and a paired machine has its own too, and a question like
// "is PR #12 still open" can be answered by events from more than one of them (one profile
// saw it open, another saw it merge). So the snapshot never stores "open: true". An edge
// stores the MARKS it was given — [valid-time, open|close|at, recorded-time, event id] —
// and whether it holds at a moment is computed from them when asked. Two snapshots then
// merge by taking the union of their marks, which is what lets one view span every profile
// and every machine without re-reading anybody's log, and it is also what makes the time
// on every edge real: nothing is deleted, an edge is only closed, and `--at` before the
// close still sees it open. A node's attributes are last-writer-wins on valid time, with
// the event id breaking a tie, so the same union is safe there too.
//   Every step of fold() is idempotent, so an event that reached the log twice (two writers
// that saw the same thing) changes nothing the second time. That is what the id is for: a
// hash of the content, the time and the source, so the same observation made twice is the
// same id, and two different ones never collide no matter how many writers there are.
//
// Node builtins only, like everything else in ghostfleet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projects, cfgFor } from './projects.mjs';

export const LOG = 'know.jsonl';
export const SNAP = 'know.graph.json';
export const PEERS_DIR = 'know-peers';
export const SNAP_V = 3;
export const MODES = ['include', 'private', 'exclude'];
// The cap on one event's text fields. A line is written with one write(2) on an O_APPEND
// descriptor, so concurrent writers cannot interleave inside it — but only while it stays a
// size the kernel writes in one go, and a pasted log in a prompt is not that size.
export const TEXT_CAP = 1500;
export const LINE_CAP = 16 * 1024;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const home = () => os.homedir();
const clip = (s, n = TEXT_CAP) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ── where things live ─────────────────────────────────────────────────────
export function fleetDirOf(env = process.env) {
  return env.CLAUDE_FLEET_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), 'fleet');
}
// The profile is the config dir's name, which is how bin/ghostfleet names it: ~/.claude is
// `work`, ~/.claude-<p> is <p>. A fleet dir anywhere else (a scratch fleet) is named by
// CLAUDE_FLEET_PROFILE when its launcher set one, else by its parent folder.
export function profileOf(fleetDir, env = process.env) {
  const cfg = path.basename(path.dirname(path.resolve(fleetDir)));
  if (cfg === '.claude') return 'work';
  const m = /^\.claude-([A-Za-z0-9_-]+)$/.exec(cfg);
  if (m) return m[1];
  return env.CLAUDE_FLEET_PROFILE || cfg || 'work';
}
// Every profile's fleet dir on this machine that holds a log: ~/.claude/fleet, each
// ~/.claude-*/fleet, and CLAUDE_FLEET_DIR when it is somewhere else (a scratch fleet).
export function allFleetDirs(env = process.env) {
  const out = [];
  const add = (d) => { if (!d) return; let r = d; try { r = fs.realpathSync(d); } catch { return; } if (!out.includes(r)) out.push(r); };
  add(path.join(home(), '.claude', 'fleet'));
  try {
    for (const n of fs.readdirSync(home()).sort()) if (/^\.claude-[A-Za-z0-9_-]+$/.test(n)) add(path.join(home(), n, 'fleet'));
  } catch {}
  if (env.CLAUDE_FLEET_DIR) add(env.CLAUDE_FLEET_DIR);
  return out;
}
// The machine an event happened on: the pairing's own name for this host when there is a
// pairing (what a peer shows it as), else the short hostname. CLAUDE_FLEET_KNOW_MACHINE
// pins it, for a fixture.
export function machineName(env = process.env) {
  if (env.CLAUDE_FLEET_KNOW_MACHINE) return env.CLAUDE_FLEET_KNOW_MACHINE;
  const cfg = env.GHOSTFLEET_SERVE_CONFIG || path.join(home(), '.config', 'ghostfleet', 'serve.json');
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(cfg), 'serve-peers.json'), 'utf8'));
    if (v && typeof v.self === 'string' && v.self) return v.self;
  } catch {}
  return String(os.hostname() || 'here').split('.')[0] || 'here';
}

// ── the privacy switch ────────────────────────────────────────────────────
//   include   recorded, readable, and a turn of it may be read by the inferred-fact pass
//   private   recorded and readable by this machine's own leads, but never handed to a
//             model vendor by ghostfleet (no inferred pass), never served to a paired host,
//             and marked in every answer so a lead does not paste it into another vendor's
//             prompt
//   exclude   not recorded at all
// Stored the way fleet-project stores every per-project setting — one value in a marker
// beside the fleet's other markers — and the profile's default beside them:
//   <fleet-dir>/<sock>.know    this project      (fleet-project set <name> know <mode>)
//   <fleet-dir>/know.privacy   every project of this profile
// Most specific wins; neither set is `include`.
export const projectModeFile = (fleetDir, sock) => path.join(fleetDir, `${sock}.know`);
export const profileModeFile = (fleetDir) => path.join(fleetDir, 'know.privacy');
function readMode(f) {
  try { const v = fs.readFileSync(f, 'utf8').trim(); return MODES.includes(v) ? v : ''; } catch { return ''; }
}
export function privacyFor(fleetDir, sock) {
  const p = sock ? readMode(projectModeFile(fleetDir, sock)) : '';
  if (p) return { mode: p, from: 'project' };
  const q = readMode(profileModeFile(fleetDir));
  if (q) return { mode: q, from: 'profile' };
  return { mode: 'include', from: 'default' };
}
export function setPrivacy(file, mode) {
  if (mode === 'default') { fs.rmSync(file, { force: true }); return; }
  if (!MODES.includes(mode)) throw new Error(`privacy is one of ${MODES.join(', ')} or default, not '${mode}'`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, mode + '\n');
  fs.renameSync(tmp, file);
}
const RANK = { include: 0, private: 1, exclude: 2 };
export const stricter = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);

// ── which project, which repo ─────────────────────────────────────────────
const git = (cwd, args) => {
  if (!cwd) return '';
  const r = spawnSync('git', ['-C', cwd, '--no-optional-locks', ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
};
const real = (p) => { try { return fs.realpathSync(p); } catch { return p ? path.resolve(p) : ''; } };
const slugOf = (u) => (u ? String(u).replace(/^git@[^:]+:/, '').replace(/^[a-z+]+:\/\/[^/]+\//, '').replace(/\.git$/, '') : '');
// ONE git call for what a writer needs of a folder: the checkout's root, the repo it belongs
// to (the common dir every worktree of it shares), and origin's URL — read out of that repo's
// own config file rather than asked of git a second time. A git call measured ~19ms, and the
// hook's writer was making two per Stop. Every writer derives the slug this one way, so a
// repo seen from a hook and from fleet-spawn is the same node.
export function repoInfo(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']);
  if (!out) return { root: '', common: '', slug: '' };
  const [root = '', common = ''] = out.split('\n');
  let url = '';
  try {
    let inOrigin = false;
    for (const line of fs.readFileSync(path.join(common, 'config'), 'utf8').split('\n')) {
      const sec = /^\s*\[\s*remote\s+"([^"]*)"\s*\]/.exec(line);
      if (sec) { inOrigin = sec[1] === 'origin'; continue; }
      if (/^\s*\[/.test(line)) { inOrigin = false; continue; }
      const m = inOrigin && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (m) { url = m[1]; break; }
    }
  } catch {}
  return { root, common, slug: slugOf(url) };
}
export const repoSlug = (cwd) => repoInfo(cwd).slug;
// The checkout a worktree belongs to: its common dir's parent. A worktree is a sibling of
// the repo, not inside the project's path, so matching the cwd alone would miss every
// worker and name each after its own folder.
export function mainCheckout(cwd, info) {
  const c = (info || repoInfo(cwd)).common;
  if (!c) return '';
  return path.basename(c) === '.git' ? path.dirname(c) : c;
}
// The project a session or a command belongs to, in the order the facts are most direct:
// the fleet socket names its project outright; else a project whose path holds the cwd,
// or holds the checkout a worktree belongs to; else the checkout's own folder name.
export function resolveProject({ sock = '', cwd = '' } = {}) {
  const all = projects();
  if (sock) { const p = all.find(x => x.sock === sock); if (p) return { name: p.name, sock: p.sock, path: p.path, profile: p.profile, known: true }; }
  const under = (dir) => {
    if (!dir) return null;
    const d = real(dir);
    let best = null;
    for (const p of all) {
      const pp = real(p.path);
      if (pp && (d === pp || d.startsWith(pp + path.sep)) && (!best || pp.length > real(best.path).length)) best = p;
    }
    return best;
  };
  const main = cwd ? mainCheckout(cwd) : '';
  const p = under(cwd) || under(main);
  if (p) return { name: p.name, sock: p.sock, path: p.path, profile: p.profile, known: true };
  const name = path.basename(main || cwd || '') || 'unknown';
  return { name, sock: '', path: main || cwd || '', profile: '', known: false };
}

// ── an event ──────────────────────────────────────────────────────────────
// Keys sorted at every level, so the same content always hashes the same.
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
// The id is content + time + source, and nothing else: NOT the recorded time, so two writers
// that saw the same thing a few milliseconds apart produce one id and fold to one fact.
export function eventId(ev) {
  const { id, rec, ...body } = ev;
  return 'k' + sha(canon(body)).slice(0, 16);
}
// `rec` is when it was RECORDED (the second time axis, --known-at); it is not part of the id.
export function makeEvent({ t = Date.now(), rec, kind, machine, profile, project, src = {}, f = {}, priv }) {
  const ev = { v: 1, t: Math.round(Number(t) || Date.now()), kind, machine, profile, project, src, f };
  if (priv === 'private') ev.priv = 'private';
  return { id: eventId(ev), ...ev, rec: Math.round(Number(rec) || Date.now()) };
}

// Appends one event, unless the project is excluded. Returns the event, or null when nothing
// was written (excluded, or the write failed — a writer never fails its caller).
//   `ctx` = { fleetDir, sock, cwd, project? } names where it happened; the privacy decision is
// made HERE, once, for every writer, so no path can forget it.
export function record(kind, f, ctx = {}, env = process.env) {
  if (/^(0|off|no|false)$/i.test(env.CLAUDE_FLEET_KNOW || '')) return null;
  const fleetDir = ctx.fleetDir || fleetDirOf(env);
  const proj = ctx.project ? { name: ctx.project, sock: ctx.sock || '' } : resolveProject({ sock: ctx.sock, cwd: ctx.cwd });
  const sock = ctx.sock || proj.sock || '';
  const { mode } = privacyFor(fleetDir, sock);
  if (mode === 'exclude') return null;
  const ev = makeEvent({
    t: ctx.t, rec: ctx.rec, kind, machine: machineName(env), profile: profileOf(fleetDir, env),
    project: proj.name, src: { ...(ctx.src || {}), ...(sock ? { sock } : {}) }, f: trimFields(f), priv: mode,
  });
  return append(fleetDir, ev, { create: !!ctx.create }) ? ev : null;
}
function trimFields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') out[k] = clip(v);
    else if (Array.isArray(v)) out[k] = v.slice(0, 200).map(x => (typeof x === 'string' ? clip(x, 400) : x));
    else out[k] = v;
  }
  return out;
}
// INTO A FLEET DIR THAT EXISTS. Every writer runs inside a fleet — the hook has just written
// the session's status there, spawn its manifest — so a missing dir means the fleet is gone,
// and a detached hook writer landing after it was removed must not bring it back as a folder
// holding one log line. Only a deliberate write (`fleet-know describe` on a profile that has
// never run a session) passes `create`.
export function append(fleetDir, ev, { create = false } = {}) {
  let line = JSON.stringify(ev);
  if (line.length > LINE_CAP) {
    // Shed the longest text until it fits, rather than refusing the fact.
    const f = { ...ev.f };
    for (const k of Object.keys(f).sort((a, b) => JSON.stringify(f[b]).length - JSON.stringify(f[a]).length)) {
      f[k] = typeof f[k] === 'string' ? clip(f[k], 200) : Array.isArray(f[k]) ? f[k].slice(0, 20) : f[k];
      line = JSON.stringify({ ...ev, f });
      if (line.length <= LINE_CAP) break;
    }
    if (line.length > LINE_CAP) return false;
  }
  try {
    if (create) fs.mkdirSync(fleetDir, { recursive: true });
    else if (!fs.statSync(fleetDir).isDirectory()) return false;
    const fd = fs.openSync(path.join(fleetDir, LOG), 'a');
    try { fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

// ── context a writer is handed only part of ──────────────────────────────
// The mod and the ledger CLI know a session id and nothing else; the session's own record
// (<fleet-dir>/<sid>.json, the hook's) says which socket, slot, folder and branch it is.
export function sessionRecord(fleetDir, sid) {
  if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(fleetDir, `${sid}.json`), 'utf8')); } catch { return null; }
}
export function ctxFromSession(fleetDir, sid, via) {
  const r = sessionRecord(fleetDir, sid) || {};
  return { fleetDir, sock: r.sock || '', cwd: r.cwd || '', src: { via, session: sid, ...(r.slot ? { slot: r.slot } : {}) }, branch: r.branch || '' };
}

// What one ledger write changed: an item that was not there (opened), and an item whose state
// moved (opened again, waiting, or closed one of the ledger's ways). The diff is made where
// the write is made — each of the four places that write a ledger — so nothing has to watch
// the files. `changes` comes from ledgerChanges() in mods/ghostfleet/hooks/ledger.js, the one
// spelling of it, which the mod can import and lib/ can too.
export function noteLedger(fleetDir, sid, changes, via = 'ledger', env = process.env) {
  if (!Array.isArray(changes) || !changes.length) return 0;
  const c = ctxFromSession(fleetDir, sid, via);
  let n = 0;
  for (const ch of changes.slice(0, 50)) {
    if (!ch || !ch.id) continue;
    const req = `${sid}/${ch.id}`;
    const t = Number(ch.t) || Date.now();
    const f = ch.op === 'open'
      ? { req, text: ch.text, source: ch.source, state: ch.state }
      : { req, text: ch.text, state: ch.state, proof: ch.proof, reason: ch.reason, by: ch.by };
    if (record(ch.op === 'open' ? 'request.open' : 'request.state', f, { ...c, t }, env)) n++;
  }
  return n;
}

// ── what a finished turn did, read off its transcript ────────────────────
// From line `from` to the end: the files it edited (for `touched`), the PRs it opened or
// merged, and the deploys it ran — each only when its tool result was not an error, since a
// refused `gh pr merge` merged nothing. A transcript line that does not parse is skipped.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Commands that put something where users get it. Deliberately specific: `vercel env ls` is
// not a deploy, `vercel --prod` is. A --dry-run / --help never counts.
export const DEPLOY_RE = /(?:^|[\s;&|(])((?:npx\s+)?vercel(?:\s+deploy)?(?=\s[^\n]*--prod)|vercel\s+deploy|supabase\s+(?:db\s+push|functions\s+deploy)|fly(?:ctl)?\s+deploy|eas\s+(?:submit|update)|wrangler\s+(?:pages\s+)?(?:deploy|publish)|firebase\s+deploy|netlify\s+deploy|(?:npm|pnpm)\s+publish|yarn\s+npm\s+publish|gh\s+release\s+create|terraform\s+apply|helm\s+(?:upgrade|install)|kubectl\s+apply|docker\s+push|git\s+push\s+heroku|cf-sync)\b/;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)/;
const resultText = (r) => {
  if (!r) return '';
  const c = r.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
};
export function turnFacts(lines, { repoRoot = '', repo = '' } = {}) {
  const uses = new Map(), results = new Map();
  for (const l of lines) {
    if (!l || l[0] !== '{') continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const c = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.id) uses.set(b.id, { name: b.name, input: b.input || {} });
      else if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { error: !!b.is_error, text: resultText(b) });
    }
  }
  const files = [], prs = [], deploys = [];
  // git names the root by its REAL path and the transcript names a file the way the session's
  // cwd spelled it, so a checkout reached through a symlink (/tmp is /private/tmp on a Mac)
  // never matched, and every file stayed absolute. Tried as spelled first; failing that, the
  // longest prefix of the path that exists is resolved — the file may have been deleted since.
  const roots = [...new Set([repoRoot, repoRoot && real(repoRoot)].filter(Boolean))];
  const under = (a) => { for (const r of roots) if (a === r || a.startsWith(r + '/')) return a.slice(r.length + 1) || '.'; return null; };
  const rel = (p) => {
    const a = String(p || '');
    if (!a || !roots.length) return a;
    let hit = under(a);
    for (let d = a, tail = ''; hit === null && path.isAbsolute(a) && d !== path.dirname(d); tail = path.join(path.basename(d), tail), d = path.dirname(d)) {
      let r; try { r = fs.realpathSync(d); } catch { continue; }
      hit = under(tail ? path.join(r, tail) : r);
      break;
    }
    return hit === null ? a : hit;
  };
  for (const [id, u] of uses) {
    const r = results.get(id);
    if (!r || r.error) continue;
    if (EDIT_TOOLS.has(u.name)) {
      const p = rel(u.input.file_path || u.input.notebook_path);
      if (p && !files.includes(p)) files.push(p);
    } else if (u.name === 'Bash' && typeof u.input.command === 'string') {
      const cmd = u.input.command;
      if (/(?:^|[\s;&|(])gh\s+pr\s+create\b/.test(cmd)) {
        const m = PR_URL.exec(r.text);
        if (m) prs.push({ op: 'open', repo: m[1], number: Number(m[2]), url: m[0] });
      }
      const mm = /(?:^|[\s;&|(])gh\s+pr\s+merge\s+(\S+)/.exec(cmd);
      if (mm && !/--help\b/.test(cmd)) {
        const u2 = PR_URL.exec(mm[1]) || PR_URL.exec(r.text);
        const R = /(?:^|\s)(?:-R|--repo)[\s=]+(\S+)/.exec(cmd);
        const number = u2 ? Number(u2[2]) : Number(String(mm[1]).replace(/^#/, '')) || 0;
        const rp = u2 ? u2[1] : R ? R[1].replace(/^https:\/\/github\.com\//, '') : repo;
        if (number && rp) prs.push({ op: 'merge', repo: rp, number });
      }
      const d = DEPLOY_RE.exec(cmd);
      if (d && !/--dry-run\b|--help\b/.test(cmd)) deploys.push({ target: d[1].replace(/^npx\s+/, '').split(/\s+/)[0], cmd: clip(cmd, 200), ok: true });
    }
  }
  return { files, prs, deploys };
}
// The lines of a transcript after the last one this writer read, and where it got to. The
// cursor is <fleet-dir>/<sid>.knowline; without one (a session older than this, or a first
// turn) only the turn chain's lines are read — never a whole long history at once.
export function transcriptSince(file, cursorFile, chainFile) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { lines: [], end: 0 }; }
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let from = NaN;
  try { from = Number(fs.readFileSync(cursorFile, 'utf8').trim()); } catch {}
  if (!Number.isFinite(from)) { try { from = Number(String(fs.readFileSync(chainFile, 'utf8')).split('\n')[0].trim()); } catch {} }
  if (!Number.isFinite(from) || from < 0 || from > lines.length) from = Math.max(0, lines.length - 2000);
  return { lines: lines.slice(from), end: lines.length };
}

// ── reading a log ─────────────────────────────────────────────────────────
// From a byte offset, so a snapshot can take only what it has not folded yet. A torn or
// foreign line is skipped, never fatal: a log is read by everything and written by many.
export function readLog(file, from = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { events: [], end: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (from > size) from = 0;
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');            // an unfinished last line waits for next time
    const whole = cut < 0 ? '' : text.slice(0, cut);
    const events = [];
    for (const l of whole.split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (e && e.id && e.kind && typeof e.t === 'number') events.push(e); } catch {}
    }
    return { events, end: from + Buffer.byteLength(whole) + (cut < 0 ? 0 : 1) };
  } finally { fs.closeSync(fd); }
}

// ── the graph ─────────────────────────────────────────────────────────────
export const emptyGraph = () => ({ v: SNAP_V, nodes: {}, edges: {} });
const nodeOf = (g, id, type) => (g.nodes[id] ||= { type, a: {} });
// Last writer wins on VALID time; the event id breaks a tie, so the answer never depends on
// the order two logs were read in.
//
// A few attributes are asked "as at" a time — a session's status and last sighting, a
// request's state — and for those the node keeps every value it took, as [value, valid t,
// event id, recorded t] in `h`, so `--at` reads what the attribute WAS rather than what it
// became. Only short values: a turn's text is in the log, and copying it here would make the
// snapshot a second log.
const HIST = new Set(['status', 'need', 'state', 'branch', 'last', 'about']);
function setA(g, id, type, k, v, ev) {
  if (v === undefined || v === null || v === '') return;
  const n = nodeOf(g, id, type);
  const cur = n.a[k];
  // `<=` on the id: ONE event that writes a key twice means its second value. A PR first seen
  // already merged is opened and merged by the same event, and with `<` it stayed open.
  if (!cur || cur[1] < ev.t || (cur[1] === ev.t && cur[2] <= ev.id)) n.a[k] = [v, ev.t, ev.id];
  if (HIST.has(k)) {
    const h = ((n.h ||= {})[k] ||= []);
    const i = h.findIndex(x => x[2] === ev.id);
    if (i >= 0) h[i] = [v, ev.t, ev.id, ev.rec || ev.t]; else h.push([v, ev.t, ev.id, ev.rec || ev.t]);
  }
}
// The earliest writer wins, for "when was this first seen".
function setFirst(g, id, type, k, v, ev) {
  const n = nodeOf(g, id, type);
  const cur = n.a[k];
  if (!cur || cur[1] > ev.t || (cur[1] === ev.t && cur[2] > ev.id)) n.a[k] = [v, ev.t, ev.id];
}
export const attr = (n, k) => (n && n.a[k] ? n.a[k][0] : undefined);
export const attrAt = (n, k) => (n && n.a[k] ? n.a[k][1] : undefined);
// An attribute as it stood at `at`, as known at `known`. Now (both Infinity) is the plain
// attribute; a key without history answers only if its one value is not from the future.
export function val(n, k, at = Infinity, known = Infinity) {
  if (!n) return undefined;
  if (at === Infinity && known === Infinity) return attr(n, k);
  const h = n.h && n.h[k];
  if (!h) { const c = n.a[k]; return c && c[1] <= at ? c[0] : undefined; }
  let best = null;
  for (const x of h) if (x[1] <= at && x[3] <= known && (!best || x[1] > best[1] || (x[1] === best[1] && x[2] > best[2]))) best = x;
  return best ? best[0] : undefined;
}
const edgeKey = (type, from, to) => `${type}|${from}|${to}`;
function addMark(g, type, from, to, op, ev) {
  const e = (g.edges[edgeKey(type, from, to)] ||= { type, from, to, m: [] });
  if (!e.m.some(x => x[3] === ev.id && x[1] === op)) e.m.push([ev.t, op, ev.rec || ev.t, ev.id]);
  return e;
}
// Whether an edge holds at `at` (valid time), as it was known at `known` (recorded time).
// Marks are taken in valid-time order; at one instant a close outranks an open, so an edge
// opened and closed in the same millisecond does not read as still open.
export function holds(e, at = Infinity, known = Infinity) {
  if (!e) return false;
  const ms = e.m.filter(x => x[0] <= at && x[2] <= known && x[1] !== 'at')
    .sort((a, b) => a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] === 'open' ? -1 : 1) || (a[3] < b[3] ? -1 : 1));
  let on = false;
  for (const x of ms) on = x[1] === 'open';
  return on;
}
// [valid-from, valid-until] pairs (Infinity for still open), for the same filters.
export function intervals(e, known = Infinity) {
  const ms = (e ? e.m : []).filter(x => x[2] <= known && x[1] !== 'at')
    .sort((a, b) => a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] === 'open' ? -1 : 1));
  const out = [];
  let from = null;
  for (const x of ms) {
    if (x[1] === 'open' && from === null) from = x[0];
    else if (x[1] === 'close' && from !== null) { out.push([from, x[0]]); from = null; }
  }
  if (from !== null) out.push([from, Infinity]);
  return out;
}
function open(g, type, from, to, ev) { const e = g.edges[edgeKey(type, from, to)]; if (!holds(e, ev.t)) addMark(g, type, from, to, 'open', ev); }
function close(g, type, from, to, ev) { const e = g.edges[edgeKey(type, from, to)]; if (e && holds(e, ev.t)) addMark(g, type, from, to, 'close', ev); }
const at = (g, type, from, to, ev) => addMark(g, type, from, to, 'at', ev);

// Node ids. A project is per machine and profile (two profiles can each have an acme-api);
// a repo, a branch, a PR and a commit are the same thing wherever they are seen, which is
// what lets a merge seen on one profile close a PR another profile saw open.
export const projectId = (ev) => `project:${ev.machine}:${ev.profile}:${ev.project}`;
const repoKey = (ev) => ev.f.repo || `path:${ev.machine}:${ev.project}`;
export const branchId = (repo, b) => `branch:${repo}#${b}`;
export const prId = (repo, n) => `pr:${repo}#${n}`;
const sessionId = (s) => `session:${s}`;
const OPEN_STATES = new Set(['open', 'waiting']);
const prNum = (s) => { const m = /(?:\/pull\/|#)(\d+)\b/.exec(String(s || '')); return m ? Number(m[1]) : 0; };

// THE FOLD. One event at a time, in log order; every step idempotent (see the header).
export function fold(g, ev) {
  if (!ev || !ev.kind) return g;
  const f = ev.f || {};
  const P = projectId(ev);
  setA(g, P, 'project', 'name', ev.project, ev);
  setA(g, P, 'project', 'machine', ev.machine, ev);
  setA(g, P, 'project', 'profile', ev.profile, ev);
  setA(g, P, 'project', 'last', ev.t, ev);
  setFirst(g, P, 'project', 'first', ev.t, ev);
  // The LATEST event's mark: a project switched back to include reads include again. What was
  // recorded while it was private keeps its own mark (decisions and requests carry theirs).
  setA(g, P, 'project', 'priv', ev.priv || 'include', ev);
  if (ev.src && ev.src.sock) setA(g, P, 'project', 'sock', ev.src.sock, ev);
  const R = f.repo ? `repo:${f.repo}` : '';
  if (R) { setA(g, R, 'repo', 'slug', f.repo, ev); open(g, 'has-repo', P, R, ev); }
  const S = ev.src && ev.src.session ? sessionId(ev.src.session) : '';
  const touchSession = () => {
    if (!S) return;
    for (const k of ['slot', 'sock', 'agent']) setA(g, S, 'session', k, ev.src[k], ev);
    setA(g, S, 'session', 'cwd', f.cwd, ev);
    setA(g, S, 'session', 'last', ev.t, ev);
    setFirst(g, S, 'session', 'started', ev.t, ev);
    setA(g, S, 'session', 'project', P, ev);
    if (!attr(g.nodes[S], 'ended')) open(g, 'in-project', S, P, ev);
  };
  // A session works on ONE branch at a time: a sighting on another branch closes the last.
  const onBranch = (b) => {
    if (!S || !b || b === 'HEAD') return;
    const B = branchId(repoKey(ev), b);
    setA(g, B, 'branch', 'name', b, ev);
    setA(g, B, 'branch', 'project', P, ev);
    const prev = attr(g.nodes[S], 'branch');
    const prevB = prev ? branchId(attr(g.nodes[S], 'repo') || repoKey(ev), prev) : '';
    if (prevB && prevB !== B) close(g, 'works-on', S, prevB, ev);
    setA(g, S, 'session', 'branch', b, ev);
    setA(g, S, 'session', 'repo', repoKey(ev), ev);
    open(g, 'works-on', S, B, ev);
  };
  const endSession = () => {
    if (!S) return;
    setA(g, S, 'session', 'ended', ev.t, ev);
    for (const e of Object.values(g.edges)) if (e.from === S && (e.type === 'works-on' || e.type === 'in-project')) close(g, e.type, e.from, e.to, ev);
  };
  const prOpen = (repo, n, x = {}) => {
    if (!repo || !n) return;
    const PR = prId(repo, n);
    setA(g, PR, 'pr', 'number', n, ev); setA(g, PR, 'pr', 'repo', repo, ev);
    setA(g, PR, 'pr', 'url', x.url || `https://github.com/${repo}/pull/${n}`, ev);
    setA(g, PR, 'pr', 'title', x.title, ev);
    setA(g, PR, 'pr', 'project', P, ev);
    setFirst(g, PR, 'pr', 'opened', ev.t, ev);
    if (!attr(g.nodes[PR], 'state') || attrAt(g.nodes[PR], 'state') <= ev.t) setA(g, PR, 'pr', 'state', 'open', ev);
    if (x.branch) { const B = branchId(repo, x.branch); setA(g, B, 'branch', 'name', x.branch, ev); setA(g, B, 'branch', 'project', P, ev); setA(g, PR, 'pr', 'branch', x.branch, ev); open(g, 'has-pr', B, PR, ev); }
    open(g, 'pr-in', PR, P, ev);
  };
  const prEnd = (repo, n, state, x = {}) => {
    if (!repo || !n) return;
    const PR = prId(repo, n);
    const seen = !!g.nodes[PR];
    if (!seen) prOpen(repo, n, x);              // never seen open: an empty interval, honestly
    setA(g, PR, 'pr', 'state', state, ev);
    // FIRST sighting: a merge seen again by a later refresh (or by another profile) is the
    // same merge, and its time is when it was first seen, not the last time anybody looked.
    setFirst(g, PR, 'pr', state === 'merged' ? 'merged' : 'closed', ev.t, ev);
    if (x.commit) setA(g, PR, 'pr', 'commit', x.commit, ev);
    const b = x.branch || attr(g.nodes[PR], 'branch');
    if (b) close(g, 'has-pr', branchId(repo, b), PR, ev);
    close(g, 'pr-in', PR, P, ev);
  };
  switch (ev.kind) {
    case 'session.start': touchSession(); onBranch(f.branch); break;
    case 'prompt':
      touchSession(); onBranch(f.branch);
      setA(g, S, 'session', 'prompt', f.text, ev);
      setA(g, S, 'session', 'status', 'working', ev);
      break;
    case 'need-you':
      touchSession();
      setA(g, S, 'session', 'status', 'need-you', ev);
      setA(g, S, 'session', 'need', f.note || 'needs you', ev);
      break;
    case 'turn.end': {
      touchSession(); onBranch(f.branch);
      setA(g, S, 'session', 'status', f.status || 'done', ev);
      setA(g, S, 'session', 'said', f.said, ev);
      const repo = repoKey(ev);
      for (const file of f.files || []) {
        const F = `file:${repo}:${file}`;
        setA(g, F, 'file', 'path', file, ev); setA(g, F, 'file', 'repo', repo, ev);
        at(g, 'touched', S, F, ev);
      }
      for (const p of f.prs || []) {
        if (p.op === 'merge') prEnd(p.repo || f.repo, p.number, 'merged', { branch: p.branch, url: p.url });
        else prOpen(p.repo || f.repo, p.number, { branch: p.branch || f.branch, url: p.url });
      }
      for (const d of f.deploys || []) foldDeploy(g, ev, P, { ...d, repo: f.repo, branch: f.branch });
      break;
    }
    case 'session.end': touchSession(); endSession(); break;
    case 'spawn': {
      const B = branchId(repoKey(ev), f.branch || '?');
      setA(g, B, 'branch', 'name', f.branch, ev); setA(g, B, 'branch', 'project', P, ev);
      for (const k of ['worker', 'worktree', 'task', 'kind', 'parent', 'base', 'agent']) setA(g, B, 'branch', k, f[k], ev);
      setFirst(g, B, 'branch', 'spawned', ev.t, ev);
      open(g, 'branch-in', B, P, ev);
      break;
    }
    case 'ack': {
      const B = branchId(repoKey(ev), f.branch || '?');
      setA(g, B, 'branch', 'understood', f.understood, ev);
      setA(g, B, 'branch', 'decisions', f.decisions, ev);
      if (f.decisions) foldDecision(g, ev, P, { text: f.decisions, why: `what ${f.worker || 'the worker'} said it is building from (fleet-ack)`, source: 'ack', branch: B });
      break;
    }
    case 'retire': {
      const B = branchId(repoKey(ev), f.branch || '?');
      setA(g, B, 'branch', 'retired', ev.t, ev);
      close(g, 'branch-in', B, P, ev);
      // The worker's session, found by the name and socket it ran under.
      for (const [id, n] of Object.entries(g.nodes)) {
        if (n.type !== 'session' || attr(n, 'ended') || attr(n, 'slot') !== f.worker || (ev.src.sock && attr(n, 'sock') !== ev.src.sock)) continue;
        setA(g, id, 'session', 'ended', ev.t, ev);
        for (const e of Object.values(g.edges)) if (e.from === id && (e.type === 'works-on' || e.type === 'in-project')) close(g, e.type, e.from, e.to, ev);
      }
      break;
    }
    case 'pr.open': prOpen(f.repo, f.number, f); break;
    case 'pr.merge': prEnd(f.repo, f.number, 'merged', f); break;
    case 'pr.close': prEnd(f.repo, f.number, 'closed', f); break;
    case 'deploy': foldDeploy(g, ev, P, f); break;
    case 'request.open': {
      const Q = `request:${f.req}`;
      touchSession();
      setA(g, Q, 'request', 'text', f.text, ev); setA(g, Q, 'request', 'source', f.source, ev);
      setA(g, Q, 'request', 'priv', ev.priv || 'include', ev);
      setA(g, Q, 'request', 'project', P, ev); setA(g, Q, 'request', 'session', S, ev);
      setFirst(g, Q, 'request', 'opened', ev.t, ev);
      setA(g, Q, 'request', 'state', 'open', ev);
      open(g, 'request-in', Q, P, ev);
      if (S) open(g, 'asked-of', Q, S, ev);
      break;
    }
    case 'request.state': {
      const Q = `request:${f.req}`;
      if (!g.nodes[Q]) { setA(g, Q, 'request', 'text', f.text, ev); setA(g, Q, 'request', 'project', P, ev); setFirst(g, Q, 'request', 'opened', ev.t, ev); }
      setA(g, Q, 'request', 'state', f.state, ev);
      if (f.proof) setA(g, Q, 'request', 'proof', f.proof, ev);
      // The ledger's own vocabulary: open and waiting (on the person) are still open; every
      // other state — done, dropped, stale, expired, carried, moved — is how an item leaves.
      if (!OPEN_STATES.has(f.state)) {
        setA(g, Q, 'request', 'closed', ev.t, ev);
        close(g, 'request-in', Q, P, ev);
        const n = prNum(f.proof);
        if (n && (f.repo || /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.test(f.proof || ''))) {
          const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(f.proof || '');
          const repo = m ? m[1] : f.repo;
          at(g, 'closed-by', Q, prId(repo, n), ev);
          if (!g.nodes[prId(repo, n)]) { setA(g, prId(repo, n), 'pr', 'number', n, ev); setA(g, prId(repo, n), 'pr', 'repo', repo, ev); }
        }
      } else open(g, 'request-in', Q, P, ev);
      break;
    }
    case 'decision': foldDecision(g, ev, P, { ...f, source: f.source || (f.inferred ? 'inferred' : 'stated') }); break;
    case 'project.about': setA(g, P, 'project', 'about', f.text, ev); break;
    case 'relate': {
      const o = splitName(f.to);
      const other = `project:${o.machine || ev.machine}:${o.profile || ev.profile}:${o.name}`;
      setA(g, other, 'project', 'name', o.name, ev);
      (f.off ? close : open)(g, f.rel || 'depends-on', P, other, ev);
      break;
    }
    default: break;                     // a kind this version does not know is kept in the log, not lost
  }
  return g;
}
function foldDeploy(g, ev, P, d) {
  const D = `deploy:${ev.id}:${d.target || d.cmd || ''}`.slice(0, 120);
  for (const k of ['target', 'cmd', 'commit', 'branch']) setA(g, D, 'deploy', k, d[k], ev);
  setA(g, D, 'deploy', 'ok', d.ok === false ? 'no' : 'yes', ev);
  setA(g, D, 'deploy', 'project', P, ev);
  setA(g, D, 'deploy', 'at', ev.t, ev);
  if (ev.src.session) setA(g, D, 'deploy', 'session', `session:${ev.src.session}`, ev);
  at(g, 'deploy-in', D, P, ev);
  if (d.commit) { const C = `commit:${d.repo || repoKey(ev)}@${d.commit}`; setA(g, C, 'commit', 'sha', d.commit, ev); at(g, 'deploy-of', D, C, ev); }
}
function foldDecision(g, ev, P, d) {
  const D = `decision:${ev.id}`;
  setA(g, D, 'decision', 'text', d.text, ev);
  setA(g, D, 'decision', 'why', d.why, ev);
  setA(g, D, 'decision', 'source', d.source, ev);
  setA(g, D, 'decision', 'project', P, ev);
  setA(g, D, 'decision', 'priv', ev.priv || 'include', ev);
  if (d.inferred) setA(g, D, 'decision', 'inferred', 'yes', ev);
  if (ev.src.session) setA(g, D, 'decision', 'session', `session:${ev.src.session}`, ev);
  if (d.turn) setA(g, D, 'decision', 'turn', d.turn, ev);
  open(g, 'about', D, P, ev);
  if (d.inferred && ev.src.session) at(g, 'from-turn', D, `session:${ev.src.session}`, ev);
  if (d.branch) at(g, 'for-branch', D, d.branch, ev);
}

// Canonical form: everything sorted, so a rebuild and an incremental update of the same log
// serialise to the same bytes — which is the test that derivation has no hidden state.
export function canonical(g) {
  const nodes = {}, edges = {};
  for (const k of Object.keys(g.nodes).sort()) {
    const n = g.nodes[k], a = {};
    for (const x of Object.keys(n.a).sort()) a[x] = n.a[x];
    nodes[k] = { type: n.type, a };
    if (n.h) {
      const h = {};
      for (const x of Object.keys(n.h).sort()) h[x] = [...n.h[x]].sort((p, q) => p[1] - q[1] || (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0));
      nodes[k].h = h;
    }
  }
  for (const k of Object.keys(g.edges).sort()) {
    const e = g.edges[k];
    edges[k] = { type: e.type, from: e.from, to: e.to, m: [...e.m].sort((x, y) => x[0] - y[0] || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : x[1] < y[1] ? -1 : 1)) };
  }
  return { v: SNAP_V, nodes, edges };
}
// The union of two graphs (see the header): marks unioned by event id, attributes by
// last-writer-wins. Commutative, so the order profiles and peers are read in cannot matter.
export function merge(a, b) {
  const g = { v: SNAP_V, nodes: {}, edges: {} };
  for (const src of [a, b]) {
    for (const [id, n] of Object.entries(src.nodes || {})) {
      const t = (g.nodes[id] ||= { type: n.type, a: {} });
      for (const [k, v] of Object.entries(n.a)) {
        const c = t.a[k];
        if (!c || c[1] < v[1] || (c[1] === v[1] && c[2] < v[2])) t.a[k] = v;
      }
      for (const [k, list] of Object.entries(n.h || {})) {
        const th = ((t.h ||= {})[k] ||= []);
        const ids = new Set(th.map(x => x[2]));
        for (const x of list) if (!ids.has(x[2])) { th.push(x); ids.add(x[2]); }
      }
    }
    for (const [id, e] of Object.entries(src.edges || {})) {
      const t = (g.edges[id] ||= { type: e.type, from: e.from, to: e.to, m: [] });
      for (const x of e.m) if (!t.m.some(y => y[3] === x[3] && y[1] === x[1])) t.m.push(x);
    }
  }
  return g;
}
// THE FOLD IS IN TIME ORDER, never in the order the lines are in the file. Lines land in the
// order their writers FINISHED, and the hook's writers are detached: a Stop that reads its
// transcript can append after the prompt that followed it, and the mod's ledger writes are
// fired together, so a close can land before its open. Folded as they came, a retire closed
// nothing for a session it had not met yet and a request read as open forever — measured on
// the fixture fleet with its log reversed: the worker live, its request open, its merged PR
// open. So events fold sorted by (valid time, id), and the graph is a function of the SET of
// events alone; see snapshot() for what that costs a read.
export const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function derive(events) { const g = emptyGraph(); for (const e of [...events].sort(byTime)) fold(g, e); return canonical(g); }

// ── the snapshot beside each log ──────────────────────────────────────────
// It carries how far into the log it has read (`bytes`), so a read folds only what is new,
// and the last event it folded (`hw`), so it knows when a new line is OLDER than that. Such a
// line cannot be folded on top (the fold is in time order) and costs one rebuild — a carried
// ledger item, which keeps the time it was asked, is the usual one. The newest SETTLE_MS of
// events are not folded into the saved graph at all but kept beside it (`hot`) and folded
// into each answer: writers that race each other land milliseconds apart, and holding the
// newest back is what keeps every such race from costing a rebuild. A log SHORTER than
// `bytes` is a log that was replaced, and gets a rebuild — never a guess.
export const SETTLE_MS = 10_000;
const after = (e, hw) => !hw || e.t > hw[0] || (e.t === hw[0] && e.id > hw[1]);
export function loadSnapshot(fleetDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(fleetDir, SNAP), 'utf8'));
    if (s && s.v === SNAP_V && s.graph && typeof s.bytes === 'number' && Array.isArray(s.hot)) return s;
  } catch {}
  return null;
}
// Fold what has settled (sorted) into the working graph `g`; return the new high-water mark
// and what is still too new to keep.
function settle(g, hw, sorted, cut) {
  const hot = [];
  for (const e of sorted) { if (e.t > cut) hot.push(e); else { fold(g, e); hw = [e.t, e.id]; } }
  return { hw, hot };
}
// The answer: the settled graph with the hot events folded in. `g` is a working copy that the
// saved snapshot does not share (canonical() copies what fold() mutates in place).
function answer(s, g) {
  if (!s.hot.length) return s;
  for (const e of s.hot) fold(g, e);
  return { ...s, graph: canonical(g) };
}
function saveSnapshot(fleetDir, s) {
  const f = path.join(fleetDir, SNAP);
  const tmp = `${path.dirname(f)}/.${path.basename(f)}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function rebuild(fleetDir, { save = true, now = Date.now() } = {}) {
  const { events, end } = readLog(path.join(fleetDir, LOG), 0);
  const g = emptyGraph();
  const { hw, hot } = settle(g, null, events.sort(byTime), now - SETTLE_MS);
  const s = { v: SNAP_V, bytes: end, events: events.length, built: now, hw, hot, graph: canonical(g) };
  if (save && end) saveSnapshot(fleetDir, s);
  return answer(s, g);
}
export function snapshot(fleetDir, { save = true, now = Date.now() } = {}) {
  const log = path.join(fleetDir, LOG);
  let size = 0; try { size = fs.statSync(log).size; } catch { return { v: SNAP_V, bytes: 0, events: 0, hot: [], graph: emptyGraph() }; }
  const s = loadSnapshot(fleetDir);
  if (!s || s.bytes > size) return rebuild(fleetDir, { save, now });
  const cut = now - SETTLE_MS;
  const { events, end } = s.bytes === size ? { events: [], end: size } : readLog(log, s.bytes);
  // A line older than what was folded: it has to go in BEFORE what is there, so fold again.
  if (events.some(e => e.t <= cut && !after(e, s.hw))) return rebuild(fleetDir, { save, now });
  // Nothing new settles: answer from the snapshot as saved (its graph is ours to fold into).
  if (!events.length && !s.hot.some(e => e.t <= cut)) return answer(s, s.graph);
  const g = s.graph;
  const { hw, hot } = settle(g, s.hw, [...s.hot, ...events].sort(byTime), cut);
  const n = { v: SNAP_V, bytes: end, events: s.events + events.length, built: now, hw, hot, graph: canonical(g) };
  if (save) saveSnapshot(fleetDir, n);
  return answer(n, g);
}

// ── paired machines ───────────────────────────────────────────────────────
// A paired host's events are FETCHED through the pairing (fleet-serve's /api/know/events,
// one of the reads a paired host may make), tagged with the name THIS host gave it when the
// two were paired — never with what the answer says it is — and kept beside the local log
// as a cache. An offline peer is its last fetched state, marked stale, never an error.
export const STALE_MS = 15 * 60_000;
// A read fetches a peer at most this often, and an offline one is not asked again for a
// minute: a brief that waited out a dead peer's timeout on every call would make the memory
// slower to ask than the files it replaces.
export const SYNC_EVERY = 2 * 60_000;
const RETRY_DEAD = 60_000;
const serveConfig = (env = process.env) => env.GHOSTFLEET_SERVE_CONFIG || path.join(home(), '.config', 'ghostfleet', 'serve.json');
export async function pairedPeers(env = process.env) {
  try {
    const P = await import('./peers.mjs');
    return P.loadPeers(P.peersFile(serveConfig(env))).peers;
  } catch { return []; }
}
const peerFiles = (dir, key) => ({ log: path.join(dir, PEERS_DIR, `${key}.jsonl`), meta: path.join(dir, PEERS_DIR, `${key}.meta.json`) });
export function peerMeta(dir, key) { try { return JSON.parse(fs.readFileSync(peerFiles(dir, key).meta, 'utf8')); } catch { return null; } }
export async function syncPeers({ fleetDir = fleetDirOf(), timeout = 4000, env = process.env, only = '', minAge = 0 } = {}) {
  const peers = (await pairedPeers(env)).filter(p => !only || p.key === only);
  if (!peers.length) return [];
  const P = await import('./peers.mjs');
  const out = [];
  for (const peer of peers) {
    const files = peerFiles(fleetDir, peer.key);
    const meta = peerMeta(fleetDir, peer.key) || { after: 0 };
    if (minAge && (Date.now() - (meta.fetched_at || 0) < minAge || Date.now() - (meta.tried_at || 0) < RETRY_DEAD)) { out.push({ ...meta, skipped: true }); continue; }
    // From a minute before the last event seen (a clock a little behind, or two events in one
    // millisecond on a page boundary, costs a re-fetch, never a gap), a page at a time.
    let r, from = Math.max(0, (meta.after || 0) - 60_000);
    const got = [];
    for (let page = 0; page < 20; page++) {
      try { r = await P.peerRequest(peer, { method: 'GET', pathq: `/api/know/events?after=${from}`, timeout }); }
      catch (e) { r = { status: 0, error: e.message }; }
      if (!(r.status === 200 && r.json && Array.isArray(r.json.events))) break;
      got.push(...r.json.events);
      if (!r.json.more || !(r.json.next > from)) break;
      from = r.json.next - 1;
    }
    if (got.length && r.status !== 200) r = { status: 200, json: { events: [] } };   // a later page failed: keep what came
    const now = Date.now();
    if (r.status === 200 && r.json && Array.isArray(r.json.events)) {
      r.json.events = got;
      const have = new Set(readLog(files.log).events.map(e => e.id));
      fs.mkdirSync(path.dirname(files.log), { recursive: true });
      let added = 0, after = meta.after || 0;
      const lines = [];
      for (const e of r.json.events) {
        if (!e || !e.id || !e.kind || typeof e.t !== 'number' || e.priv === 'private') continue;
        after = Math.max(after, e.t);
        if (have.has(e.id)) continue;
        have.add(e.id);
        lines.push(JSON.stringify({ ...e, machine: peer.key }));
        added++;
      }
      if (lines.length) fs.appendFileSync(files.log, lines.join('\n') + '\n');
      const m = { key: peer.key, label: peer.label, ok: true, fetched_at: now, tried_at: now, after, added };
      fs.writeFileSync(files.meta, JSON.stringify(m));
      out.push(m);
    } else {
      const why = r.status ? `answered ${r.status}${r.json && r.json.text ? `: ${r.json.text}` : ''}` : (r.error || 'no answer');
      const m = { key: peer.key, label: peer.label, ...meta, ok: false, tried_at: now, why };
      try { fs.mkdirSync(path.dirname(files.meta), { recursive: true }); fs.writeFileSync(files.meta, JSON.stringify(m)); } catch {}
      out.push(m);
    }
  }
  return out;
}
// What a paired host may have of this machine's log: every profile's events after `after`,
// minus anything private or excluded NOW (the stricter of the mark and the setting), and
// never a peer's own events passed on — a paired request does not fan out again.
export function eventsForPeer({ after = 0, limit = 5000, env = process.env } = {}) {
  const events = [];
  for (const dir of allFleetDirs(env)) {
    const modes = new Map();
    for (const e of readLog(path.join(dir, LOG)).events) {
      if (e.t <= after) continue;
      const sock = e.src && e.src.sock;
      if (!modes.has(sock)) modes.set(sock, privacyFor(dir, sock).mode);
      if (stricter(e.priv || 'include', modes.get(sock)) !== 'include') continue;
      events.push(e);
    }
  }
  events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const page = events.slice(0, limit);
  return { events: page, more: events.length > page.length, next: page.length ? page[page.length - 1].t : after };
}

// ── the view: every profile, every peer, merged ───────────────────────────
// `hidden` holds the projects whose CURRENT setting is exclude: their old events stay in the
// log (append-only), but an answer does not show them. `privateNow` is the set marked private
// by the setting today, on top of whatever was marked private when it was written.
export async function view({ env = process.env, sync = true, timeout = 1500 } = {}) {
  const dirs = allFleetDirs(env);
  let g = emptyGraph();
  const sources = [];
  for (const d of dirs) {
    const s = snapshot(d);
    if (!s.events) continue;
    g = merge(g, s.graph);
    sources.push({ kind: 'profile', profile: profileOf(d, env), dir: d, events: s.events });
  }
  const peers = await pairedPeers(env);
  if (peers.length && sync) { try { await syncPeers({ fleetDir: fleetDirOf(env), timeout, env, minAge: SYNC_EVERY }); } catch {} }
  const peerState = [];
  for (const peer of peers) {
    let best = null, evs = [];
    for (const d of dirs) {
      const m = peerMeta(d, peer.key);
      if (m && (!best || (m.fetched_at || 0) > (best.fetched_at || 0))) best = m;
      evs = evs.concat(readLog(peerFiles(d, peer.key).log).events);
    }
    const seen = new Set();
    evs = evs.filter(e => (seen.has(e.id) ? false : seen.add(e.id))).map(e => ({ ...e, machine: peer.key }));
    if (evs.length) g = merge(g, derive(evs));
    const fetched = best && best.fetched_at ? best.fetched_at : 0;
    const stale = !best || !best.ok || Date.now() - fetched > STALE_MS;
    peerState.push({ key: peer.key, label: peer.label, events: evs.length, fetched_at: fetched, stale, why: best && !best.ok ? best.why : (fetched ? '' : 'never fetched') });
  }
  const settings = new Map();
  for (const d of dirs) settings.set(profileOf(d, env), d);
  const modeOf = (n) => {
    const d = settings.get(attr(n, 'profile'));
    const sock = attr(n, 'sock');
    const now = d ? privacyFor(d, sock).mode : 'include';
    return stricter(attr(n, 'priv') || 'include', now);
  };
  return { g: canonical(g), sources, peers: peerState, modeOf, dirs, rawEvents: () => rawEvents(dirs, peers) };
}
function rawEvents(dirs, peers) {
  const out = [], seen = new Set();
  const take = (e) => { if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } };
  for (const d of dirs) {
    for (const e of readLog(path.join(d, LOG)).events) take(e);
    for (const p of peers) for (const e of readLog(peerFiles(d, p.key).log).events) take({ ...e, machine: p.key });
  }
  return out;
}

// ── time ──────────────────────────────────────────────────────────────────
// `--at` takes an ISO time or date, epoch seconds or milliseconds, or "<n><m|h|d> ago".
export function parseAt(s, now = Date.now()) {
  if (s === undefined || s === null || s === '' || s === 'now') return Infinity;
  const t = String(s).trim();
  let m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)\s*(?:ago)?$/i.exec(t);
  if (m) return now - Number(m[1]) * { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2].toLowerCase()];
  if (/^\d{12,}$/.test(t)) return Number(t);
  if (/^\d{9,11}$/.test(t)) return Number(t) * 1000;
  const d = Date.parse(t);
  if (!Number.isNaN(d)) return d;
  throw new Error(`--at: cannot read '${s}' as a time (ISO, epoch, or "2h ago")`);
}
export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const day = (t) => new Date(t).toISOString().slice(0, 10);

// ── queries ───────────────────────────────────────────────────────────────
// Every answer is built against ONE instant (`at`, default now) and, optionally, against what
// was known at `known` (recorded time) — the two axes every mark carries.
const edgesOf = (g, pred) => Object.values(g.edges).filter(pred);
export function projectsIn(v) {
  return Object.entries(v.g.nodes).filter(([, n]) => n.type === 'project' && attr(n, 'first') !== undefined)
    .map(([id, n]) => ({ id, name: attr(n, 'name'), machine: attr(n, 'machine'), profile: attr(n, 'profile'), last: attr(n, 'last') || 0, mode: v.modeOf(n) }))
    .filter(p => p.mode !== 'exclude')
    .sort((a, b) => b.last - a.last);
}
// `acme-api`, `acme-api@vm`, or `acme-api/personal` (or both) — a name alone picks the most
// recently active, and says so when more than one matched.
export function splitName(q) {
  // name, then @machine and /profile in either order. A project name is A-Za-z0-9._-
  // (bin/fleet-project refuses anything else), so neither mark can be part of one.
  const m = /^([^@/]+)((?:[@/][^@/]+)*)$/.exec(String(q || ''));
  if (!m) return { name: String(q || ''), machine: '', profile: '' };
  let machine = '', profile = '';
  for (const [, mark, val] of m[2].matchAll(/([@/])([^@/]+)/g)) { if (mark === '@') machine = val; else profile = val; }
  return { name: m[1], machine, profile };
}
export function findProject(v, q) {
  const { name, machine, profile } = splitName(q);
  const all = projectsIn(v).filter(p => p.name === name && (!machine || p.machine === machine) && (!profile || p.profile === profile));
  return { hit: all[0] || null, others: all.slice(1) };
}

const DECAY_MS = 7 * 86400e3;   // closed longer ago than this is summarised, not listed
const LIST = 5;
export function brief(v, q, { at = Infinity, known = Infinity, now = Date.now() } = {}) {
  const { hit, others } = findProject(v, q);
  if (!hit) return null;
  const g = v.g, P = hit.id, pn = g.nodes[P];
  const when = Number.isFinite(at) ? at : now;
  const into = (type, to) => edgesOf(g, e => e.type === type && e.to === to);
  const repos = edgesOf(g, e => e.type === 'has-repo' && e.from === P && holds(e, at, known)).map(e => attr(g.nodes[e.to], 'slug'));
  const sessions = into('in-project', P).filter(e => holds(e, at, known)).map(e => ({ id: e.from, n: g.nodes[e.from] }))
    .filter(s => s.n).map(s => {
      const branchE = edgesOf(g, e => e.type === 'works-on' && e.from === s.id && holds(e, at, known))[0];
      return { slot: attr(s.n, 'slot') || s.id.slice(8, 16), status: val(s.n, 'status', at, known) || 'idle', last: val(s.n, 'last', at, known) || 0,
               branch: branchE ? attr(g.nodes[branchE.to], 'name') : val(s.n, 'branch', at, known), need: val(s.n, 'need', at, known), said: Number.isFinite(at) ? undefined : attr(s.n, 'said') };
    }).filter(s => s.last && s.last <= when).sort((a, b) => b.last - a.last);
  const live = sessions.filter(s => when - s.last < 2 * 86400e3);
  const quiet = sessions.length - live.length;
  const prs = Object.entries(g.nodes).filter(([, n]) => n.type === 'pr' && attr(n, 'project') === P)
    .map(([id, n]) => {
      const inP = into('pr-in', P).find(e => e.from === id);
      const openNow = inP ? holds(inP, at, known) : false;
      return { id, n, number: attr(n, 'number'), branch: attr(n, 'branch'), url: attr(n, 'url'), openNow,
               state: openNow ? 'open' : (attr(n, 'merged') && attr(n, 'merged') <= when ? 'merged' : attr(n, 'closed') && attr(n, 'closed') <= when ? 'closed' : (attr(n, 'opened') > when ? 'future' : attr(n, 'state'))),
               endedAt: attr(n, 'merged') || attr(n, 'closed') || 0, opened: attr(n, 'opened') || 0 };
    }).filter(p => p.opened <= when && p.state !== 'future');
  const openPrs = prs.filter(p => p.openNow).sort((a, b) => b.opened - a.opened);
  const branches = Object.entries(g.nodes).filter(([, n]) => n.type === 'branch' && attr(n, 'project') === P && attr(n, 'spawned') && attr(n, 'spawned') <= when && !(attr(n, 'retired') && attr(n, 'retired') <= when))
    .map(([id, n]) => {
      // The PR as a reader needs it, not the graph node behind it: that carries every
      // attribute's history, and a brief is what an MCP answer pastes into a lead's context.
      const p = openPrs.find(x => x.branch === attr(n, 'name'));
      return { id, name: attr(n, 'name'), worker: attr(n, 'worker'), task: attr(n, 'task'), pr: p ? { number: p.number, url: p.url, opened: p.opened } : undefined };
    });
  const deploys = into('deploy-in', P).map(e => ({ id: e.from, n: g.nodes[e.from], t: e.m.length ? Math.max(...e.m.filter(x => x[2] <= known).map(x => x[0])) : 0 }))
    .filter(d => d.n && d.t && d.t <= when).sort((a, b) => b.t - a.t);
  const reqs = Object.entries(g.nodes).filter(([, n]) => n.type === 'request' && attr(n, 'project') === P && (attr(n, 'opened') || 0) <= when)
    .map(([id, n]) => { const e = into('request-in', P).find(x => x.from === id); return { id, n, open: e ? holds(e, at, known) : false, state: val(n, 'state', at, known), text: attr(n, 'text'), opened: attr(n, 'opened') || 0, closed: attr(n, 'closed') || 0, session: g.nodes[attr(n, 'session')], priv: attr(n, 'priv') === 'private' }; });
  const openReqs = reqs.filter(r => r.open).sort((a, b) => b.opened - a.opened);
  const decisions = into('about', P).filter(e => holds(e, at, known)).map(e => ({ n: g.nodes[e.from], id: e.from }))
    .filter(d => d.n).map(d => ({ text: attr(d.n, 'text'), why: attr(d.n, 'why'), source: attr(d.n, 'source'), inferred: attr(d.n, 'inferred') === 'yes', t: attrAt(d.n, 'text'), by: attr(g.nodes[attr(d.n, 'session')], 'slot'), priv: attr(d.n, 'priv') === 'private' }))
    .sort((a, b) => b.t - a.t);
  const deps = edgesOf(g, e => e.type === 'depends-on' && e.from === P && holds(e, at, known)).map(e => attr(g.nodes[e.to], 'name'));
  const usedBy = edgesOf(g, e => e.type === 'depends-on' && e.to === P && holds(e, at, known)).map(e => attr(g.nodes[e.from], 'name'));
  const waiting = [
    ...live.filter(s => s.status === 'need-you').map(s => ({ what: `${s.slot} needs you: ${s.need || 'a question on its pane'}` })),
    ...openPrs.filter(p => sessions.some(s => s.branch === p.branch && s.status === 'done')).map(p => ({ what: `PR #${p.number} (${p.branch}) — its worker reported done; waits for review/merge` })),
    ...openReqs.filter(r => r.state === 'waiting').map(r => ({ what: `request waiting on you: "${clip(r.text, 120)}"` })),
  ];
  // DECAY: what closed more than a week before `at` is counted, not listed.
  const old = (t) => t && when - t > DECAY_MS;
  const earlier = {
    requests: reqs.filter(r => !r.open && old(r.closed)).length,
    prs: prs.filter(p => !p.openNow && old(p.endedAt)).length,
    deploys: deploys.filter(d => old(d.t)).length,
    decisions: decisions.filter(d => old(d.t)).length,
  };
  const since = Math.min(...[...reqs.map(r => r.opened), ...prs.map(p => p.opened), ...decisions.map(d => d.t)].filter(Boolean), when);
  return {
    project: hit.name, machine: hit.machine, profile: hit.profile, mode: hit.mode, others: others.map(o => `${o.name}@${o.machine}/${o.profile}`),
    at: Number.isFinite(at) ? at : null, about: attr(pn, 'about'), repos, deps, usedBy,
    sessions: live, quiet, branches, openPrs: openPrs.map(p => ({ number: p.number, branch: p.branch, url: p.url, opened: p.opened })),
    recentPrs: prs.filter(p => !p.openNow && !old(p.endedAt)).sort((a, b) => b.endedAt - a.endedAt).slice(0, LIST).map(p => ({ number: p.number, branch: p.branch, state: p.state, at: p.endedAt })),
    lastDeploy: deploys[0] ? { target: attr(deploys[0].n, 'target'), cmd: attr(deploys[0].n, 'cmd'), commit: attr(deploys[0].n, 'commit'), ok: attr(deploys[0].n, 'ok') !== 'no', at: deploys[0].t, by: attr(g.nodes[attr(deploys[0].n, 'session')], 'slot') } : null,
    openRequests: openReqs.map(r => ({ text: r.text, state: r.state, opened: r.opened, by: attr(r.session, 'slot'), priv: r.priv })),
    waiting, decisions: decisions.filter(d => !old(d.t)).slice(0, LIST),
    earlier: { ...earlier, since: since < when ? since : null },
    peers: v.peers,
  };
}

const PRIV_NOTE = '[private] — readable here; do not paste it into a prompt for another model vendor';
export function renderBrief(b, now = Date.now()) {
  if (!b) return '';
  const L = [];
  const tag = b.mode === 'private' ? '  [private]' : '';
  // as-at times count back from the instant asked about, not from the wall clock
  if (b.at) now = b.at;
  L.push(`${b.project}${b.machine ? `@${b.machine}` : ''} · ${b.profile} profile${b.repos.length ? ` · ${b.repos.join(', ')}` : ''}${tag}`);
  if (b.at) L.push(`as at ${new Date(b.at).toISOString().replace('.000Z', 'Z')}`);
  if (b.mode === 'private') L.push(PRIV_NOTE);
  if (b.others.length) L.push(`(also: ${b.others.join(', ')} — name one with @machine or /profile)`);
  L.push(`  what it is   ${b.about || `(not described yet — fleet-know describe ${b.project} "<one line>")`}`);
  if (b.deps.length || b.usedBy.length) L.push(`  depends on   ${b.deps.join(', ') || '-'}${b.usedBy.length ? ` · used by ${b.usedBy.join(', ')}` : ''}`);
  L.push('WHERE IT STANDS');
  if (b.sessions.length) for (const s of b.sessions.slice(0, 8)) L.push(`  ${s.slot.padEnd(14)} ${String(s.status).padEnd(9)} ${s.branch ? `on ${s.branch}` : ''}  (${ago(s.last, now)})`);
  else L.push('  no live sessions');
  if (b.quiet) L.push(`  + ${b.quiet} quiet for 2 days or more`);
  for (const br of b.branches.slice(0, LIST)) L.push(`  branch ${br.name}${br.worker ? ` (${br.worker})` : ''}${br.pr ? ` → PR #${br.pr.number} open` : ' — no PR yet'}${br.task && br.task !== '-' ? `: ${clip(br.task, 90)}` : ''}`);
  for (const p of b.openPrs.filter(p => !b.branches.some(br => br.pr && br.pr.number === p.number)).slice(0, LIST)) L.push(`  PR #${p.number} open (${p.branch || '?'}), ${ago(p.opened, now)}`);
  for (const p of b.recentPrs) L.push(`  PR #${p.number} ${p.state} (${p.branch || '?'}), ${ago(p.at, now)}`);
  L.push(`  last deploy  ${b.lastDeploy ? `${ago(b.lastDeploy.at, now)} — ${b.lastDeploy.cmd || b.lastDeploy.target}${b.lastDeploy.commit ? ` at ${String(b.lastDeploy.commit).slice(0, 8)}` : ''}${b.lastDeploy.by ? ` (${b.lastDeploy.by})` : ''}${b.lastDeploy.ok ? '' : ' — FAILED'}` : 'none seen'}`);
  L.push('OPEN');
  if (b.waiting.length) for (const w of b.waiting.slice(0, LIST)) L.push(`  waits on you: ${w.what}`);
  if (b.openRequests.length) {
    L.push(`  ${b.openRequests.length} open request${b.openRequests.length === 1 ? '' : 's'}:`);
    for (const r of b.openRequests.slice(0, LIST)) L.push(`    "${clip(r.text, 110)}"${r.by ? ` (${r.by}, ${ago(r.opened, now)})` : ''}${r.state && r.state !== 'open' ? ` [${r.state}]` : ''}${r.priv && b.mode !== 'private' ? ' [private]' : ''}`);
    if (b.openRequests.length > LIST) L.push(`    + ${b.openRequests.length - LIST} more`);
  }
  if (!b.waiting.length && !b.openRequests.length) L.push('  nothing open');
  L.push('DECISIONS');
  if (b.decisions.length) for (const d of b.decisions) L.push(`  • ${clip(d.text, 160)}${d.why ? ` — ${clip(d.why, 120)}` : ''}  [${d.inferred ? 'inferred' : d.source || 'stated'}${d.by ? `, ${d.by}` : ''}, ${day(d.t)}]${d.priv && b.mode !== 'private' ? ' [private]' : ''}`);
  else L.push('  none recorded');
  const e = b.earlier;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (e.requests || e.prs || e.deploys || e.decisions) L.push(`EARLIER  ${[e.requests && n(e.requests, 'closed request', 'closed requests'), e.prs && n(e.prs, 'merged/closed PR', 'merged/closed PRs'), e.deploys && n(e.deploys, 'deploy', 'deploys'), e.decisions && n(e.decisions, 'decision', 'decisions')].filter(Boolean).join(', ')}${e.since ? ` since ${day(e.since)}` : ''} (fleet-know find <text> searches them)`);
  for (const p of b.peers.filter(p => p.stale)) L.push(`(${p.label || p.key}: stale — last fetched ${p.fetched_at ? ago(p.fetched_at, now) : 'never'}${p.why ? `, ${p.why}` : ''})`);
  return L.join('\n');
}

// What waits on the owner, everywhere.
export function waiting(v, { at = Infinity, known = Infinity, now = Date.now() } = {}) {
  const rows = [];
  for (const p of projectsIn(v)) {
    const b = brief(v, `${p.name}@${p.machine}/${p.profile}`, { at, known, now });
    if (b) for (const w of b.waiting) rows.push({ project: p.name, machine: p.machine, profile: p.profile, mode: b.mode, what: w.what });
  }
  return { rows, peers: v.peers };
}
export function renderWaiting(w, now = Date.now()) {
  const L = [];
  if (!w.rows.length) L.push('nothing waits on you');
  for (const r of w.rows) L.push(`${`${r.project}@${r.machine}`.padEnd(22)} ${r.what}${r.mode === 'private' ? '  [private]' : ''}`);
  if (w.rows.some(r => r.mode === 'private')) L.push(PRIV_NOTE);
  for (const p of w.peers.filter(p => p.stale)) L.push(`(${p.label || p.key}: stale — last fetched ${p.fetched_at ? ago(p.fetched_at, now) : 'never'}${p.why ? `, ${p.why}` : ''})`);
  return L.join('\n');
}

// Which sessions touched a file, and which PRs that work went into: the session's branch at
// the moment of the touch, and that branch's PRs.
export function touched(v, q, { at = Infinity, known = Infinity } = {}) {
  const g = v.g, want = String(q || '').replace(/^\.\//, '');
  const files = Object.entries(g.nodes).filter(([, n]) => n.type === 'file' && (attr(n, 'path') === want || String(attr(n, 'path')).endsWith('/' + want) || (want.includes('/') && String(attr(n, 'path')).includes(want))));
  const rows = [];
  for (const [fid, fn] of files) {
    for (const e of edgesOf(g, x => x.type === 'touched' && x.to === fid)) {
      const s = g.nodes[e.from];
      if (!s) continue;
      const P = attr(s, 'project'), pn = g.nodes[P];
      const mode = pn ? v.modeOf(pn) : 'include';
      if (mode === 'exclude') continue;
      for (const m of e.m.filter(x => x[0] <= at && x[2] <= known)) {
        const br = edgesOf(g, x => x.type === 'works-on' && x.from === e.from && holds(x, m[0], known)).map(x => x.to)[0];
        const prs = br ? edgesOf(g, x => x.type === 'has-pr' && x.from === br).map(x => g.nodes[x.to]).filter(n => n && !(Number.isFinite(at) && attr(n, 'opened') > at)).map(n => ({ number: attr(n, 'number'), state: val(n, 'state', at, known) || 'open', url: attr(n, 'url') })) : [];
        rows.push({ path: attr(fn, 'path'), t: m[0], slot: attr(s, 'slot'), session: e.from.slice(8), project: attr(pn, 'name'), machine: attr(pn, 'machine'), mode, branch: br ? attr(g.nodes[br], 'name') : attr(s, 'branch'), prs });
      }
    }
  }
  rows.sort((a, b) => b.t - a.t);
  return { query: want, rows };
}
export function renderTouched(r, now = Date.now()) {
  if (!r.rows.length) return `nothing recorded touching ${r.query}`;
  const L = r.rows.slice(0, 30).map(x => `${ago(x.t, now).padEnd(8)} ${`${x.project}@${x.machine}`.padEnd(22)} ${String(x.slot || x.session.slice(0, 8)).padEnd(14)} ${x.path}${x.branch ? `  on ${x.branch}` : ''}${x.prs.length ? `  → ${x.prs.map(p => `PR #${p.number} ${p.state}`).join(', ')}` : ''}${x.mode === 'private' ? '  [private]' : ''}`);
  if (r.rows.length > 30) L.push(`+ ${r.rows.length - 30} older`);
  if (r.rows.some(x => x.mode === 'private')) L.push(PRIV_NOTE);
  return L.join('\n');
}

// FIND SEARCHES THE RAW EVENTS, not only the graph. Measured elsewhere: raw text beat an
// extracted graph on recall (74% vs 68.5%), because an extraction keeps what its author
// thought would be asked, and a prompt, a turn's last words or a refused deploy keep
// everything. Every word must appear (case-insensitive) in the event's text.
export function find(v, q, { at = Infinity, limit = 20 } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { query: q, rows: [], total: 0 };
  const modes = new Map();
  for (const [, n] of Object.entries(v.g.nodes)) if (n.type === 'project') modes.set(`${attr(n, 'machine')}:${attr(n, 'profile')}:${attr(n, 'name')}`, v.modeOf(n));
  const hits = [];
  for (const e of v.rawEvents()) {
    if (e.t > at) continue;
    const mode = stricter(e.priv || 'include', modes.get(`${e.machine}:${e.profile}:${e.project}`) || 'include');
    if (mode === 'exclude') continue;
    const hay = `${e.kind} ${e.project} ${Object.values(e.f || {}).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')} ${e.src && e.src.slot ? e.src.slot : ''}`.toLowerCase();
    if (words.every(w => hay.includes(w))) hits.push({ e, mode });
  }
  hits.sort((a, b) => b.e.t - a.e.t);
  return { query: q, total: hits.length, rows: hits.slice(0, limit).map(({ e, mode }) => ({ t: e.t, project: e.project, machine: e.machine, profile: e.profile, kind: e.kind, slot: e.src && e.src.slot, id: e.id, mode, text: snippet(e, words) })) };
}
function snippet(e, words) {
  const f = e.f || {};
  const fields = ['text', 'said', 'note', 'task', 'decisions', 'understood', 'proof', 'why', 'cmd', 'title'].filter(k => typeof f[k] === 'string');
  for (const k of fields) {
    const s = f[k], i = s.toLowerCase().indexOf(words[0]);
    if (i >= 0) return `${k}: ${i > 40 ? '…' : ''}${s.slice(Math.max(0, i - 40), i + 120)}${s.length > i + 120 ? '…' : ''}`;
  }
  const j = JSON.stringify(f);
  const i = j.toLowerCase().indexOf(words[0]);
  return i >= 0 ? j.slice(Math.max(0, i - 40), i + 120) : j.slice(0, 120);
}
export function renderFind(r, now = Date.now()) {
  if (!r.rows.length) return `no event mentions "${r.query}"`;
  const L = r.rows.map(x => `${ago(x.t, now).padEnd(8)} ${`${x.project}@${x.machine}`.padEnd(22)} ${x.kind.padEnd(13)} ${x.slot ? `${x.slot}: ` : ''}${x.text}${x.mode === 'private' ? '  [private]' : ''}`);
  if (r.total > r.rows.length) L.push(`+ ${r.total - r.rows.length} more (narrow it with another word)`);
  if (r.rows.some(x => x.mode === 'private')) L.push(PRIV_NOTE);
  return L.join('\n');
}
export function overview(v, { now = Date.now() } = {}) {
  const ps = projectsIn(v);
  const L = ps.length ? ps.map(p => `${p.name.padEnd(16)} ${`${p.machine}/${p.profile}`.padEnd(20)} last seen ${ago(p.last, now)}${p.mode === 'private' ? '  [private]' : ''}`) : ['nothing recorded yet — events land as sessions run (docs/MEMORY.md)'];
  for (const p of v.peers) L.push(`peer ${p.label || p.key}: ${p.events} events${p.stale ? ` — stale (${p.fetched_at ? `last fetched ${ago(p.fetched_at, now)}` : 'never fetched'}${p.why ? `, ${p.why}` : ''})` : ''}`);
  if (ps.some(p => p.mode === 'private')) L.push(PRIV_NOTE);
  return L.join('\n');
}
