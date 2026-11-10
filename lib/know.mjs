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
//               never reconstructed afterwards from their files. One deliberate exception:
//               `fleet-know forget <id> --purge` rewrites that one line, for a real leak.
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
import { projects, cfgFor, pairScope, pairFor } from './projects.mjs';

export const LOG = 'know.jsonl';
export const SNAP = 'know.graph.json';
export const PEERS_DIR = 'know-peers';
export const SNAP_V = 6;
export const MODES = ['include', 'private', 'exclude'];
// A tombstone: `fleet-know forget`. It names an event by id and carries nothing else — no
// project, no text — so it can cross a pairing whatever the project's privacy says now.
export const FORGET = 'forget';
// What the memory records about ITSELF: a read, a briefing, a compaction. In the log, because a
// later evaluation reads them there; out of the graph, find, the activity times and every peer,
// because they are not something that happened to a project. A read landed in `last` would make
// a project anybody asked about look busy, and each read would then make the next one's page
// different from the one before it.
export const TELEMETRY = new Set(['know.read', 'know.brief', 'session.compact']);
// Standing rules belong to the machine they were said on. Each profile opts in to another's
// (rule.share), and a pairing is not an opt-in, so none of these leaves this machine in either
// direction. They also have no project of their own: `profile` and `all` are about no one
// project, and an older peer's overview throws on a nameless one (see eventsForPeer).
export const RULE_KINDS = new Set(['rule', 'rule.accept', 'rule.close', 'rule.share']);
const STAYS_HERE = (e) => TELEMETRY.has(e.kind) || RULE_KINDS.has(e.kind) || (e.kind === 'fact' && e.f && e.f.scope === 'machine');
// What a project-less event carries where the project's name goes. record() would otherwise ask
// git which project it is in, which is the slow part of a write, for an answer nothing reads.
export const NO_PROJECT = '-';
// The cap on one event's text fields. A line is written with one write(2) on an O_APPEND
// descriptor, so concurrent writers cannot interleave inside it — but only while it stays a
// size the kernel writes in one go, and a pasted log in a prompt is not that size.
export const TEXT_CAP = 1500;
export const LINE_CAP = 16 * 1024;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const home = () => os.homedir();
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n = TEXT_CAP) => { const t = flat(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// Both ends of a long text, the head twice the tail. A turn's last message says what it did at
// the top and asks its question at the bottom, and keeping only the top lost exactly the line
// that says the session is waiting on somebody.
const ELIDED = ' […] ';
export function clipEnds(s, n = TEXT_CAP) {
  const t = flat(s);
  if (t.length <= n) return t;
  const room = n - ELIDED.length, tail = Math.floor(room / 3);
  return t.slice(0, room - tail) + ELIDED + t.slice(-tail);
}

// ── keeping secrets out ───────────────────────────────────────────────────
// A prompt and a turn's text are stored as written, and the log crosses pairings, so a token
// pasted into a prompt would be copied to every paired machine and stay there. One table: a
// kind is added here and nowhere else. Each row is [kind, pattern, how many leading groups to
// keep], so `Bearer` and the name of a key=value pair stay readable and only the value goes.
//   Every pattern starts on a literal, deliberately. A leading `[A-Za-z0-9_-]*` is quadratic on
// a long run with no separator, a pasted base64 blob, and this runs inside the Stop hook's
// writer. Order matters where shapes nest: `Bearer <jwt>` is the jwt row, and the credential
// row leaves a value an earlier row already replaced alone.
export const SECRET_SHAPES = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g],
  // No \b in front: the usual place for one is a URL, `…/bot123456:AAA…/sendMessage`.
  ['telegram-bot-token', /(?<!\d)\d{6,}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  ['github-token', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['api-key', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g],
  ['aws-key', /(?<![A-Z0-9])A(?:KIA|SIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
  ['slack-token', /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['bearer', /(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, 1],
  // password=…, GITHUB_TOKEN="…", client_secret=…, "token":"…". A colon only with a quote: in
  // prose, "the secret: understanding" is not a credential. A value that is a reference
  // ($TOKEN, <token>, {token}) is not one either.
  ['credential', /((?:password|passwd|token|secret|api[_-]?key)[A-Za-z0-9_-]{0,64}(?:["']?\s*=\s*["']?|["']\s*:\s*["']))(?!\[redacted:|[$<{])[^\s"'&;,)]{8,}/gi, 1],
];
export function redact(text) {
  let out = String(text);
  for (const [kind, re, keep = 0] of SECRET_SHAPES) {
    out = out.replace(re, (...m) => `${keep ? m[1] : ''}[redacted:${kind}]`);
  }
  return out;
}
export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

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
  const ev = eventFor(kind, f, ctx, env);
  return ev && append(ctx.fleetDir || fleetDirOf(env), ev, { create: !!ctx.create }) ? ev : null;
}
// The event a record() would write, written nowhere: the half a dry run can call, and a batch.
export function eventFor(kind, f, ctx = {}, env = process.env) {
  if (/^(0|off|no|false)$/i.test(env.CLAUDE_FLEET_KNOW || '')) return null;
  const fleetDir = ctx.fleetDir || fleetDirOf(env);
  const proj = ctx.project ? { name: ctx.project, sock: ctx.sock || '' } : resolveProject({ sock: ctx.sock, cwd: ctx.cwd });
  const sock = ctx.sock || proj.sock || '';
  const { mode } = privacyFor(fleetDir, sock);
  if (mode === 'exclude') return null;
  return makeEvent({
    t: ctx.t, rec: ctx.rec, kind, machine: machineName(env), profile: profileOf(fleetDir, env),
    project: proj.name, src: { ...(ctx.src || {}), ...(sock ? { sock } : {}) }, f: trimFields(f), priv: mode,
  });
}
// Redacted BEFORE it is clipped: a token cut in half by the cap no longer matches its shape, and
// half a token is still a leak. Every string at every depth, because a deploy's command line
// (`TOKEN=… vercel deploy`) rides inside an array of objects.
function trimFields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') out[k] = k === 'said' ? clipEnds(redact(v)) : clip(redact(v));
    else if (Array.isArray(v)) out[k] = v.slice(0, 200).map(x => (typeof x === 'string' ? clip(redact(x), 400) : redactDeep(x)));
    else out[k] = redactDeep(v);
  }
  return out;
}
// One write, then a look at whether it landed in the file that is still the log. A purge renames
// a new file into place, so a writer that opened the old one just before that can write to a file
// nobody reads again: measured, a line lost in three purges of ten under a writer in a tight loop,
// with the purge's own catch-up in place. A write BEFORE the rename the purge carries across; one
// AFTER it is seen here and written again. Both is a duplicate line, and the same id twice is one
// event. A session's mod loaded before this has no such look, so its line can still be lost, if
// its open and its write straddle the rename.
function appendLine(file, data) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.appendFileSync(fd, data);
    let ino = 0;
    try { ino = fs.statSync(file).ino; } catch {}
    if (ino !== fs.fstatSync(fd).ino) fs.appendFileSync(file, data);
  } finally { fs.closeSync(fd); }
}
// INTO A FLEET DIR THAT EXISTS. Every writer runs inside a fleet — the hook has just written
// the session's status there, spawn its manifest — so a missing dir means the fleet is gone,
// and a detached hook writer landing after it was removed must not bring it back as a folder
// holding one log line. Only a deliberate write (`fleet-know describe` on a profile that has
// never run a session) passes `create`.
// The line for an event, or '' when it cannot be made to fit. Sheds the longest text until it does,
// rather than refusing the fact.
function lineOf(ev) {
  let line = JSON.stringify(ev);
  if (line.length <= LINE_CAP) return line;
  const f = { ...ev.f };
  for (const k of Object.keys(f).sort((a, b) => JSON.stringify(f[b]).length - JSON.stringify(f[a]).length)) {
    f[k] = typeof f[k] === 'string' ? (k === 'said' ? clipEnds(f[k], 200) : clip(f[k], 200)) : Array.isArray(f[k]) ? f[k].slice(0, 20) : f[k];
    line = JSON.stringify({ ...ev, f });
    if (line.length <= LINE_CAP) return line;
  }
  return '';
}
export function append(fleetDir, ev, { create = false } = {}) {
  const line = lineOf(ev);
  if (!line) return false;
  try {
    if (create) fs.mkdirSync(fleetDir, { recursive: true });
    else if (!fs.statSync(fleetDir).isDirectory()) return false;
    appendLine(path.join(fleetDir, LOG), line + '\n');
    return true;
  } catch { return false; }
}
// Many events at once (fleet-know backfill). Whole lines to each write, of the size one write(2) is
// known to land in one go, so a live writer can land between two of them and never inside one. An
// open, a stat and a close per event was the slow part of tens of thousands of them.
const BATCH_BYTES = 60 * 1024;
export function appendMany(fleetDir, events) {
  const file = path.join(fleetDir, LOG);
  let buf = '', n = 0, pending = 0;
  const flush = () => { if (buf) { appendLine(file, buf); n += pending; } buf = ''; pending = 0; };
  for (const ev of events) {
    const line = lineOf(ev);
    if (!line) continue;
    if (buf.length + line.length + 1 > BATCH_BYTES) flush();
    buf += line + '\n';
    pending++;
  }
  flush();
  return n;
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
    if (ch.op === 'answer') { if (record('decision', answerFields(req, ch), { ...c, t }, env)) n++; continue; }
    const f = ch.op === 'open'
      ? { req, text: ch.text, source: ch.source, state: ch.state }
      : { req, text: ch.text, state: ch.state, proof: ch.proof, reason: ch.reason, by: ch.by };
    if (record(ch.op === 'open' ? 'request.open' : 'request.state', f, { ...c, t }, env)) n++;
  }
  return n;
}

// THE OWNER'S ANSWER, AS A DECISION: their words, the question they were answering, and which
// request that was (ownerAnswers in mods/ghostfleet/hooks/ledger.js says which answers these are).
// `source: reply` is what makes it the owner's (authorityOf), and nothing but this function writes
// it. The option a bare number picked is spelled out, since a briefing clips the line and "2" is
// the part of it that means nothing alone. `req` and the time are how a backfill knows it is here.
const pickedOption = (question, answer) => {
  const n = /^\D*(\d+)\D*$/.exec(answer);
  const m = n && new RegExp(`(?:^|\\s)\\(?${n[1]}[.)]\\s+(.+?)(?=\\s\\(?\\d+[.)]\\s|$)`).exec(question);
  return m ? m[1] : '';
};
export function answerFields(req, { answer, question, how = 'reply' }) {
  const a = clip(answer, 300), q = clip(question, 400), picked = pickedOption(q, a);
  return { text: `The owner already answered "${clip(a, 120)}"${picked ? ` (${clip(picked, 80)})` : ''} to: ${clip(q, 240)}`, source: 'reply', req, question: q, answer: a, how };
}

// ── what a finished turn did, read off its transcript ────────────────────
// From line `from` to the end: the files it edited (for `touched`), the PRs it opened or
// merged, and the deploys it ran — each only when its tool result was not an error, since a
// refused `gh pr merge` merged nothing. A transcript line that does not parse is skipped.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Commands that put something where users get it. Deliberately specific: `vercel env ls` is
// not a deploy, `vercel --prod` is. A --dry-run / --help never counts.
export const DEPLOY_RE = /(?:^|[\s;&|(])((?:npx\s+)?vercel(?:\s+deploy)?(?=\s[^\n]*--prod)|vercel\s+deploy|supabase\s+(?:db\s+push|functions\s+deploy)|fly(?:ctl)?\s+deploy|eas\s+(?:submit|update)|wrangler\s+(?:pages\s+)?(?:deploy|publish)|firebase\s+deploy|netlify\s+deploy|(?:npm|pnpm)\s+publish|yarn\s+npm\s+publish|gh\s+release\s+create|terraform\s+apply|helm\s+(?:upgrade|install)|kubectl\s+apply|docker\s+push|git\s+push\s+heroku|cf-sync)\b/;
// What a detected deploy is CALLED: the verb that matched, not the command line around it.
// A deploy is often one step of a long Bash call (`cd … && S=…; cp … && cf-sync`), and the
// head of that line is not what was deployed. A bare `vercel` only matched because --prod
// followed, so it is named for what that does.
export const deployVerb = (m) => { const v = String(m || '').replace(/^npx\s+/, '').replace(/\s+/g, ' ').trim(); return v === 'vercel' ? 'vercel deploy' : v; };
// The label for a recorded deploy. Events written before targets were short carry the first
// word only and the command beside it, so the verb is re-read from the command when there is
// one; a script's own record ("ghostfleet runtime") has no command and is used as it is.
export function deployLabel(target, cmd) {
  const m = cmd ? DEPLOY_RE.exec(String(cmd)) : null;
  return clip(m ? deployVerb(m[1]) : (target || ''), 40);
}
// A command that moves HEAD around the deploy: the commit HEAD is at when the turn STOPS is
// then not the one that shipped (check the commit out, sync it, re-park on a tag).
const MOVES_HEAD_RE = /(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?(?:checkout|switch|reset|rebase|pull|cherry-pick)\b/;
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
      if (d && !/--dry-run\b|--help\b/.test(cmd)) deploys.push({ target: deployVerb(d[1]), cmd: clip(cmd, 200), ok: true, ...(MOVES_HEAD_RE.test(cmd) ? { moves: true } : {}) });
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
// A LINE AT A TIME, so what a read holds is bounded by what it keeps and not by the size of the
// file. It used to take the file as one string, and a string has a ceiling (512 MB, and the
// throw was uncaught): a big enough log killed `find` and `rebuild` outright, with the log
// perfectly good. Two things no line of ours is: a torn or foreign line is skipped, never
// fatal, because a log is read by everything and written by many; and a "line" past MAX_LINE
// is not buffered at all, because a file of NULs is one line as far as newlines can tell.
const READ_CHUNK = 1 << 20;
const MAX_LINE = 1 << 20;
const isEvent = (e) => e && e.id && e.kind && typeof e.t === 'number';
// visit(event, byte offset, byte length) for every whole line from `from`; returns the offset
// after the last whole line, so an unfinished last line waits for next time.
function scanFd(fd, from, visit) {
  const size = fs.fstatSync(fd).size;
  if (from > size) from = 0;
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  let pos = from, end = from, held = [], heldLen = 0, oversize = false;
  const take = (line, off) => {
    if (line.length < 2 || line[0] !== 0x7b) return;       // `{`, before paying to decode it
    let e; try { e = JSON.parse(line.toString('utf8')); } catch { return; }
    if (isEvent(e)) visit(e, off, line.length);
  };
  while (pos < size) {
    const n = fs.readSync(fd, chunk, 0, Math.min(READ_CHUNK, size - pos), pos);
    if (!n) break;
    const buf = n === READ_CHUNK ? chunk : chunk.subarray(0, n);
    let at = 0, nl;
    while ((nl = buf.indexOf(10, at)) >= 0) {
      if (!oversize) {
        if (heldLen) { held.push(buf.subarray(at, nl)); take(Buffer.concat(held), end); }
        else take(buf.subarray(at, nl), end);
      }
      end = pos + nl + 1;
      held = []; heldLen = 0; oversize = false;
      at = nl + 1;
    }
    if (at < n && !oversize) {
      heldLen += n - at;
      if (heldLen > MAX_LINE) { held = []; heldLen = 0; oversize = true; }
      else held.push(Buffer.from(buf.subarray(at)));
    }
    pos += n;
  }
  return end;
}
export function scanLog(file, from = 0, visit = () => {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try { return scanFd(fd, from, visit); } finally { fs.closeSync(fd); }
}
export function readLog(file, from = 0) {
  const events = [];
  const end = scanLog(file, from, (e) => events.push(e));
  return { events, end };
}
// Lines by offset, for a fold that visits them in time order. A log is nearly in time order
// already, so a small window that starts a little behind answers almost every line without a
// read of its own. The rare line far from the last only costs one more window.
function lineReader(fd) {
  const win = Buffer.allocUnsafe(1 << 18);
  let lo = 0, hi = 0;
  return (off, len) => {
    // Half a window or more could still end past a window that starts behind it: read it alone.
    if (len >= win.length >> 1) { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b.toString('utf8'); }
    if (off < lo || off + len > hi) {
      lo = Math.max(0, off - (win.length >> 3));
      hi = lo + fs.readSync(fd, win, 0, win.length, lo);
    }
    return win.toString('utf8', off - lo, off - lo + len);
  };
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
const HIST = new Set(['status', 'need', 'state', 'branch', 'last', 'about', 'value', 'authority']);
function setA(g, id, type, k, v, ev) {
  if (v === undefined || v === null || v === '') return;
  const n = nodeOf(g, id, type);
  const cur = n.a[k];
  // `<=` on the id: ONE event that writes a key twice means its second value. A PR first seen
  // already merged is opened and merged by the same event, and with `<` it stayed open.
  if (!cur || cur[1] < ev.t || (cur[1] === ev.t && cur[2] <= ev.id)) n.a[k] = [v, ev.t, ev.id];
  // Not a project's `last`: EVERY event writes it, so a project kept one history row per event
  // it ever saw, which nothing reads, and the row search below made that quadratic in the
  // project's size and the snapshot a second copy of the log's timestamps.
  if (HIST.has(k) && !(k === 'last' && type === 'project')) {
    const h = ((n.h ||= {})[k] ||= []);
    const row = [v, ev.t, ev.id, ev.rec || ev.t];
    // The same event writing the key again is within its own instant at the tail: the fold is
    // in time order, so the walk ends at once, however long the history is.
    let i = h.length - 1;
    while (i >= 0 && h[i][1] >= ev.t && h[i][2] !== ev.id) i--;
    if (i >= 0 && h[i][2] === ev.id) h[i] = row; else h.push(row);
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
// What the fold looks up instead of walking the whole graph. A session's end closes its own
// edges, a retire finds its worker's session, and a detected deploy looks for the script's
// record of it, and each of those used to scan every edge or node for a handful: one event's
// work grew with the graph, so a log's fold grew with its square. Built the first time it is
// asked of a graph (one restored from a snapshot, or one being folded from nothing), and kept
// up from then on. It belongs to that one graph object and is never saved.
const foldIndexes = new WeakMap();
const holdsSession = (type) => type === 'works-on' || type === 'in-project';
const addTo = (m, k, x) => { const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); };
function foldIndex(g) {
  let x = foldIndexes.get(g);
  if (x) return x;
  x = { held: new Map(), bySlot: new Map(), scripts: new Map() };
  for (const e of Object.values(g.edges)) if (holdsSession(e.type)) addTo(x.held, e.from, e);
  for (const [id, n] of Object.entries(g.nodes)) {
    if (n.type === 'session' && attr(n, 'slot')) addTo(x.bySlot, attr(n, 'slot'), id);
    else if (n.type === 'deploy' && attr(n, 'by') === 'script') addTo(x.scripts, attr(n, 'project'), n);
  }
  foldIndexes.set(g, x);
  return x;
}
function addMark(g, type, from, to, op, ev) {
  const key = edgeKey(type, from, to);
  let e = g.edges[key];
  if (!e) {
    e = g.edges[key] = { type, from, to, m: [] };
    if (holdsSession(type)) { const x = foldIndexes.get(g); if (x) addTo(x.held, from, e); }
  }
  // As in setA: the same event's mark is at the tail, and a long-lived session's edge to a file
  // it keeps touching carries a mark per touch.
  for (let i = e.m.length - 1; i >= 0 && e.m[i][0] >= ev.t; i--) if (e.m[i][3] === ev.id && e.m[i][1] === op) return e;
  e.m.push([ev.t, op, ev.rec || ev.t, ev.id]);
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

// ── who said it ───────────────────────────────────────────────────────────
// `stated` used to mean anyone who ran `decide`, and a worker's fleet-ack line read the same as
// the owner's word. A briefing built on that would hand a worker's guess back as a decision.
// So every decision and fact carries where it came from, derived here and nowhere else:
//   owner   the owner's own words: a source that says so (their prompt, a ledger reply), or a
//           write from their own terminal, which is the one place no agent is running
//   lead    a session in the lead's slot
//   worker  any other session, and fleet-ack, whoever ran it
//   model   the inferred pass
// A write that says nothing about itself is a worker's. It fails closed, so a writer that loses
// its context can only understate what it knows, never promote it.
export const AUTHORITIES = ['owner', 'lead', 'worker', 'model'];
export const TRUSTED = ['owner', 'lead'];
const LEAD_SLOT = 'master';
const OWNER_SOURCES = new Set(['prompt', 'ledger', 'reply']);
// The ledger already knows whose ask an item is: the owner's words, a lead's brief, or the
// session's own promise (mods/ghostfleet/hooks/ledger.js).
const REQUEST_AUTHORITY = { user: 'owner', fleet: 'lead', promise: 'worker' };
export function authorityOf(ev, source = ev.f && ev.f.source) {
  const src = ev.src || {};
  if (source === 'inferred' || (ev.f && ev.f.inferred) || src.via === 'infer') return 'model';
  if (ev.kind === 'ack' || source === 'ack' || src.via === 'ack') return 'worker';
  if (OWNER_SOURCES.has(source) || src.by === 'terminal') return 'owner';
  return src.slot === LEAD_SLOT ? 'lead' : 'worker';
}
// Who may close what somebody said: anyone at or above them. A worker closing the owner's
// decision is the failure this exists for: it would take the owner's word off the page on the
// strength of a guess, and the page would then be wrong with nothing on it to say so. Enforced in
// the fold, so a hand-written line changes nothing; the command says so first.
const AUTHORITY_RANK = { model: 0, worker: 1, lead: 2, owner: 3 };
export const outranks = (by, target) => (AUTHORITY_RANK[by] ?? -1) >= (AUTHORITY_RANK[target] ?? 99);
// A rule, a fact and an acceptance are taken from who wrote them. No source field is read: the
// words `source: prompt` in a worker's rule must not make it the owner's.
export const writerAuthority = (ev) => authorityOf(ev, '');

// ── standing rules ────────────────────────────────────────────────────────
// A rule's life is one edge, so `--at` and `--known-at` read it the way they read everything else
// and a closed rule is simply one that no longer holds. Marks rather than `open()`/`close()`,
// because the rule's anchor belongs to no project and these never touch one.
export const SCOPE_RANK = { project: 0, profile: 1, all: 2 };
export const scopeKind = (s) => (String(s || '').startsWith('project:') ? 'project' : s);
const validScope = (s) => s === 'profile' || s === 'all' || /^project:[^\s]+$/.test(String(s || ''));
const ruleAnchor = (profile) => `rules:${profile}`;
const ruleEdge = (R, profile) => edgeKey('rule-holds', R, ruleAnchor(profile));
const ruleOn = (g, R, profile) => holds(g.edges[ruleEdge(R, profile)]);
function closeRule(g, id, by, ev, reason) {
  const R = `rule:${id}`, n = g.nodes[R];
  // Same log only (a snapshot folds one file): a rule named from another profile is not found,
  // and an unfound target changes nothing.
  if (!n || attr(n, 'profile') !== ev.profile || attr(n, 'closed') || !outranks(by, attr(n, 'authority'))) return;
  addMark(g, 'rule-holds', R, ruleAnchor(ev.profile), 'close', ev);
  setA(g, R, 'rule', 'closed', ev.t, ev);
  setA(g, R, 'rule', 'reason', reason, ev);
}
function openRule(g, R, ev, by) {
  addMark(g, 'rule-holds', R, ruleAnchor(ev.profile), 'open', ev);
  // Only when somebody trusted stands behind it does a replacement take effect: a proposal to
  // replace the owner's rule must not retire it before anybody said yes.
  const sup = attr(g.nodes[R], 'supersedes');
  if (sup) closeRule(g, sup, by, ev, `superseded by ${R.slice(5)}`);
}
function foldRule(g, ev) {
  const f = ev.f || {}, by = writerAuthority(ev), trusted = TRUSTED.includes(by);
  switch (ev.kind) {
    case 'rule': {
      if (!validScope(f.scope) || !f.text) return;
      const R = `rule:${ev.id}`;
      for (const k of ['text', 'why', 'scope', 'quote', 'supersedes']) setA(g, R, 'rule', k, f[k], ev);
      setA(g, R, 'rule', 'profile', ev.profile, ev);
      setA(g, R, 'rule', 'authority', by, ev);
      setA(g, R, 'rule', 'priv', ev.priv || 'include', ev);
      if (ev.src && ev.src.slot) setA(g, R, 'rule', 'by', ev.src.slot, ev);
      if (trusted) openRule(g, R, ev, by);
      else setA(g, R, 'rule', 'proposed', 'yes', ev);
      break;
    }
    case 'rule.accept': {
      const R = `rule:${f.target}`, n = g.nodes[R];
      if (!trusted || !n || attr(n, 'profile') !== ev.profile || attr(n, 'closed') || ruleOn(g, R, ev.profile)) return;
      // It now stands on the acceptor's word, so the worker who proposed it cannot close it.
      setA(g, R, 'rule', 'authority', by, ev);
      setA(g, R, 'rule', 'accepted', ev.t, ev);
      setA(g, R, 'rule', 'acceptedBy', ev.src && ev.src.slot, ev);
      openRule(g, R, ev, by);
      break;
    }
    case 'rule.close': closeRule(g, f.target, by, ev, f.reason); break;
    case 'rule.share': {
      if (!trusted || !f.from || f.from === ev.profile) return;
      setA(g, ruleAnchor(ev.profile), 'rule-anchor', 'profile', ev.profile, ev);
      setA(g, ruleAnchor(f.from), 'rule-anchor', 'profile', f.from, ev);
      (f.off ? close : open)(g, 'rule-share', ruleAnchor(ev.profile), ruleAnchor(f.from), ev);
      break;
    }
    default: break;
  }
}

// ── a fact with a key ─────────────────────────────────────────────────────
// One node per key, so a new value is the old one closing: `val()` reads either as it stood. A
// machine-level fact (what a pairing is doing) has no project and stays on this machine.
export const FACT_KEY = /^[A-Za-z0-9._:-]+$/;
export const factId = (P, key) => `fact:${P}|${key}`;
export const machineFactId = (machine, key) => `fact:machine:${machine}|${key}`;
const machineAnchor = (machine) => `machine:${machine}`;
export const OBSERVED = 'observed';
function foldFact(g, ev, F, anchor, by) {
  const f = ev.f || {};
  const n = g.nodes[F];
  // The fact stands until somebody at or above whoever said it says otherwise. What the fleet
  // observed for itself (OBSERVED) is not anybody's word, and it replaces its own last sighting.
  if (n && by !== OBSERVED && holds(g.edges[edgeKey('fact-holds', F, anchor)], ev.t) && !outranks(by, attr(n, 'authority'))) return;
  setA(g, F, 'fact', 'key', f.key, ev);
  setA(g, F, 'fact', 'authority', by, ev);
  setA(g, F, 'fact', 'priv', ev.priv || 'include', ev);
  if (ev.src && ev.src.slot) setA(g, F, 'fact', 'by', ev.src.slot, ev);
  if (f.off) { close(g, 'fact-holds', F, anchor, ev); return; }
  setA(g, F, 'fact', 'value', f.value, ev);
  setA(g, F, 'fact', 'note', f.note, ev);
  open(g, 'fact-holds', F, anchor, ev);
}

// THE FOLD. One event at a time, in log order; every step idempotent (see the header).
export function fold(g, ev) {
  if (!ev || !ev.kind || ev.kind === FORGET || TELEMETRY.has(ev.kind)) return g;   // a tombstone changes what is folded, and is not itself a fact; nor is what the memory notes about itself
  // Before anything writes to the project below: a rule is about no one project, and is not
  // activity on the project it happened to be said from.
  if (RULE_KINDS.has(ev.kind)) { foldRule(g, ev); return g; }
  if (ev.kind === 'fact' && ev.f && ev.f.scope === 'machine') {
    // Only the pairing sync speaks for the machine. A line claiming the scope would otherwise read
    // as what the fleet saw for itself, which outranks nobody's word and is overtaken by nobody's.
    if (ev.f.key && ev.src && ev.src.via === 'pairing') foldFact(g, ev, machineFactId(ev.machine, ev.f.key), machineAnchor(ev.machine), OBSERVED);
    return g;
  }
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
    const wasSlot = attr(g.nodes[S], 'slot');
    for (const k of ['slot', 'sock', 'agent']) setA(g, S, 'session', k, ev.src[k], ev);
    if (ev.src.slot && ev.src.slot !== wasSlot) { const x = foldIndexes.get(g); if (x) addTo(x.bySlot, ev.src.slot, S); }
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
    for (const e of foldIndex(g).held.get(S) || []) close(g, e.type, e.from, e.to, ev);
  };
  const prOpen = (repo, n, x = {}) => {
    if (!repo || !n) return;
    const PR = prId(repo, n);
    setA(g, PR, 'pr', 'number', n, ev); setA(g, PR, 'pr', 'repo', repo, ev);
    setA(g, PR, 'pr', 'url', x.url || `https://github.com/${repo}/pull/${n}`, ev);
    setA(g, PR, 'pr', 'title', x.title, ev);
    setA(g, PR, 'pr', 'author', x.author, ev);
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
    // A close read off a transcript (`gh pr merge 133`) names a number and nothing else, so
    // the PR can be first met WITHOUT its head branch; the refresh that sees the same event
    // from the PR list does carry it. It used to be dropped here because the PR was already
    // known — and the project page then printed it as `PR #133 merged (?)`.
    if (x.branch && !attr(g.nodes[PR], 'branch')) { const B = branchId(repo, x.branch); setA(g, B, 'branch', 'name', x.branch, ev); setA(g, B, 'branch', 'project', P, ev); setA(g, PR, 'pr', 'branch', x.branch, ev); open(g, 'has-pr', B, PR, ev); }
    if (x.author && !attr(g.nodes[PR], 'author')) setA(g, PR, 'pr', 'author', x.author, ev);
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
      for (const d of f.deploys || []) foldDeploy(g, ev, P, { ...d, detected: true, repo: f.repo, branch: f.branch });
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
      // The worker's session, found by the name and socket it ran under. The index lists every
      // session that ever went by this slot, so it is checked against the one it goes by now.
      const x = foldIndex(g);
      for (const id of new Set(x.bySlot.get(f.worker) || [])) {
        const n = g.nodes[id];
        if (attr(n, 'ended') || attr(n, 'slot') !== f.worker || (ev.src.sock && attr(n, 'sock') !== ev.src.sock)) continue;
        setA(g, id, 'session', 'ended', ev.t, ev);
        for (const e of x.held.get(id) || []) close(g, e.type, e.from, e.to, ev);
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
      setA(g, Q, 'request', 'authority', REQUEST_AUTHORITY[f.source] || authorityOf(ev), ev);
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
    case 'fact': if (f.key) foldFact(g, ev, factId(P, f.key), P, writerAuthority(ev)); break;
    case 'project.about': {
      const by = authorityOf(ev);
      setA(g, P, 'project', 'about', f.text, ev);
      setA(g, P, 'project', 'aboutBy', by, ev);
      // Kept apart, so a reader who only takes the owner's and the lead's word gets the last line
      // either of them wrote, rather than nothing because a worker described it since.
      if (TRUSTED.includes(by)) { setA(g, P, 'project', 'aboutTrusted', f.text, ev); setA(g, P, 'project', 'aboutTrustedBy', by, ev); }
      break;
    }
    case 'relate': {
      const o = splitName(f.to);
      const other = `project:${o.machine || ev.machine}:${o.profile || ev.profile}:${o.name}`;
      setA(g, other, 'project', 'name', o.name, ev);
      setA(g, P, 'project', `relBy:${other}`, authorityOf(ev), ev);
      (f.off ? close : open)(g, f.rel || 'depends-on', P, other, ev);
      break;
    }
    default: break;                     // a kind this version does not know is kept in the log, not lost
  }
  return g;
}
// A deploy script that records its own deploy (cf-sync, install.sh: `fleet-know-event deploy`)
// knows what it shipped; the same run, read back off the transcript at the turn's Stop, only
// knows a command matched and where HEAD happened to be by then. Both land, and the second
// is the one to drop: a detected deploy of one of those scripts is not added when the
// script's own record of the same project is already there from the minutes before it.
const SCRIPT_DEPLOYED = /\b(?:cf-sync|install\.sh)\b/;
const SCRIPT_WINDOW_MS = 30 * 60e3;
function foldDeploy(g, ev, P, d) {
  if (d.detected && SCRIPT_DEPLOYED.test(d.cmd || d.target || '')
      && (foldIndex(g).scripts.get(P) || []).some(n => attr(n, 'at') <= ev.t && ev.t - attr(n, 'at') <= SCRIPT_WINDOW_MS)) return;
  const D = `deploy:${ev.id}:${d.target || d.cmd || ''}`.slice(0, 120);
  for (const k of ['target', 'cmd', 'commit', 'branch']) setA(g, D, 'deploy', k, d[k], ev);
  setA(g, D, 'deploy', 'ok', d.ok === false ? 'no' : 'yes', ev);
  setA(g, D, 'deploy', 'project', P, ev);
  setA(g, D, 'deploy', 'at', ev.t, ev);
  if (!d.detected) {
    setA(g, D, 'deploy', 'by', 'script', ev);
    const x = foldIndexes.get(g);
    if (x) addTo(x.scripts, P, g.nodes[D]);
  }
  if (ev.src.slot) setA(g, D, 'deploy', 'slot', ev.src.slot, ev);
  if (ev.src.session) setA(g, D, 'deploy', 'session', `session:${ev.src.session}`, ev);
  at(g, 'deploy-in', D, P, ev);
  if (d.commit) { const C = `commit:${d.repo || repoKey(ev)}@${d.commit}`; setA(g, C, 'commit', 'sha', d.commit, ev); at(g, 'deploy-of', D, C, ev); }
}
function foldDecision(g, ev, P, d) {
  const D = `decision:${ev.id}`;
  setA(g, D, 'decision', 'text', d.text, ev);
  setA(g, D, 'decision', 'why', d.why, ev);
  setA(g, D, 'decision', 'source', d.source, ev);
  setA(g, D, 'decision', 'authority', authorityOf(ev, d.source), ev);
  setA(g, D, 'decision', 'project', P, ev);
  setA(g, D, 'decision', 'priv', ev.priv || 'include', ev);
  if (d.inferred) setA(g, D, 'decision', 'inferred', 'yes', ev);
  if (ev.src.session) setA(g, D, 'decision', 'session', `session:${ev.src.session}`, ev);
  if (ev.src.slot) setA(g, D, 'decision', 'by', ev.src.slot, ev);
  if (d.turn) setA(g, D, 'decision', 'turn', d.turn, ev);
  open(g, 'about', D, P, ev);
  if (d.inferred && ev.src.session) at(g, 'from-turn', D, `session:${ev.src.session}`, ev);
  if (d.branch) at(g, 'for-branch', D, d.branch, ev);
  // The old one stops holding from now, and stays readable with --at. Refused rather than guessed
  // when it is about another project, or is somebody's word this writer does not outrank.
  if (d.supersedes) {
    const T = `decision:${d.supersedes}`, old = g.nodes[T];
    if (old && attr(old, 'project') === P && outranks(authorityOf(ev, d.source), attr(old, 'authority'))) {
      close(g, 'about', T, P, ev);
      setA(g, T, 'decision', 'supersededBy', ev.id, ev);
    }
  }
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
function mergeInto(g, src) {
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
    const t = g.edges[id];
    if (!t) { g.edges[id] = { type: e.type, from: e.from, to: e.to, m: [...e.m] }; continue; }
    for (const x of e.m) if (!t.m.some(y => y[3] === x[3] && y[1] === x[1])) t.m.push(x);
  }
  return g;
}
export function merge(a, b) { return mergeInto(mergeInto(emptyGraph(), a), b); }
// THE FOLD IS IN TIME ORDER, never in the order the lines are in the file. Lines land in the
// order their writers FINISHED, and the hook's writers are detached: a Stop that reads its
// transcript can append after the prompt that followed it, and the mod's ledger writes are
// fired together, so a close can land before its open. Folded as they came, a retire closed
// nothing for a session it had not met yet and a request read as open forever — measured on
// the fixture fleet with its log reversed: the worker live, its request open, its merged PR
// open. So events fold sorted by (valid time, id), and the graph is a function of the SET of
// events alone; see snapshot() for what that costs a read.
export const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// A tombstone covers its target wherever in the file either of them landed, so what is folded is
// the set minus what was forgotten, and not a function of which came first.
const forgottenIn = (events) => new Set(events.filter(e => e.kind === FORGET && e.f && e.f.target).map(e => e.f.target));
export function derive(events) {
  const g = emptyGraph(), gone = forgottenIn(events);
  for (const e of [...events].sort(byTime)) if (!gone.has(e.id)) fold(g, e);
  return canonical(g);
}

// ── the snapshot beside each log ──────────────────────────────────────────
// It carries how far into the log it has read (`bytes`), so a read folds only what is new,
// and the last event it folded (`hw`), so it knows when a new line is OLDER than that. Such a
// line cannot be folded on top (the fold is in time order) and costs one rebuild — a carried
// ledger item, which keeps the time it was asked, is the usual one. The newest SETTLE_MS of
// events are not folded into the saved graph at all but kept beside it (`hot`) and folded
// into each answer: writers that race each other land milliseconds apart, and holding the
// newest back is what keeps every such race from costing a rebuild. A log SHORTER than
// `bytes` is a log that was replaced, and gets a rebuild — never a guess. So is a log that is
// a different file (`ino`): a purge replaces it, and a reader that was part way through when
// that happened can save a snapshot still holding the text the purge removed.
//   `gone` is what the log's tombstones forgot. A new tombstone costs a rebuild, because its
// target may already be folded in, and a late line naming a forgotten id is dropped.
export const SETTLE_MS = 10_000;
// A snapshot this far behind is not worth catching up on by holding the gap in memory.
const MAX_DELTA = 32 * 1024 * 1024;
const TELEMETRY_SLACK = 64 * 1024;
const after = (e, hw) => !hw || e.t > hw[0] || (e.t === hw[0] && e.id > hw[1]);
const filesOf = (fleetDir) => ({ log: path.join(fleetDir, LOG), snap: path.join(fleetDir, SNAP) });
function loadSnap(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.v === SNAP_V && s.graph && typeof s.bytes === 'number' && Array.isArray(s.hot) && Array.isArray(s.gone)) return s;
  } catch {}
  return null;
}
export const loadSnapshot = (fleetDir) => loadSnap(filesOf(fleetDir).snap);
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
function saveSnap(f, s) {
  const tmp = `${path.dirname(f)}/.${path.basename(f)}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
// TWO PASSES OVER ONE DESCRIPTOR, because the fold is in time order and the file is not. The
// first keeps only where each line is and when it happened; the second reads them back in time
// order, a line at a time. What stays in memory is the graph and a few numbers per event, never
// the text of the log. One descriptor, so a purge that replaces the file part way through
// cannot hand the second pass offsets from a different file.
function rebuildFile({ log, snap }, { save = true, now = Date.now(), machine = '' } = {}) {
  const g = emptyGraph(), gone = new Set(), hot = [];
  const cut = now - SETTLE_MS;
  let hw = null, end = 0, ino = 0, kept = 0, fd = null;
  try { fd = fs.openSync(log, 'r'); } catch {}
  if (fd !== null) {
    try {
      ino = fs.fstatSync(fd).ino;
      const ts = [], ids = [], offs = [], lens = [];
      end = scanFd(fd, 0, (e, off, len) => {
        if (e.kind === FORGET) { if (e.f && e.f.target) gone.add(e.f.target); return; }
        if (TELEMETRY.has(e.kind)) return;
        ts.push(e.t); ids.push(e.id); offs.push(off); lens.push(len);
      });
      const order = Array.from(ts.keys()).sort((a, b) => ts[a] - ts[b] || (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
      const line = lineReader(fd);
      for (const i of order) {
        if (gone.has(ids[i])) continue;
        const e = JSON.parse(line(offs[i], lens[i]));
        if (machine) e.machine = machine;
        kept++;
        if (e.t > cut) hot.push(e); else { fold(g, e); hw = [e.t, e.id]; }
      }
    } finally { fs.closeSync(fd); }
  }
  const s = { v: SNAP_V, bytes: end, events: kept, built: now, ino, gone: [...gone], hw, hot, graph: canonical(g) };
  if (save && end) saveSnap(snap, s);
  return answer(s, g);
}
function snapshotFile(files, { save = true, now = Date.now(), machine = '' } = {}) {
  let st;
  try { st = fs.statSync(files.log); } catch { return { v: SNAP_V, bytes: 0, events: 0, gone: [], hot: [], graph: emptyGraph() }; }
  const s = loadSnap(files.snap);
  const again = () => rebuildFile(files, { save, now, machine });
  if (!s || s.bytes > st.size || s.ino !== st.ino || st.size - s.bytes > MAX_DELTA) return again();
  const cut = now - SETTLE_MS;
  const gone = new Set(s.gone), events = [];
  let end = st.size, forgot = false;
  if (s.bytes !== st.size) {
    end = scanLog(files.log, s.bytes, (e) => {
      if (e.kind === FORGET) { if (e.f && e.f.target && !gone.has(e.f.target)) forgot = true; return; }
      if (TELEMETRY.has(e.kind)) return;
      if (!gone.has(e.id)) events.push(machine ? { ...e, machine } : e);
    });
  }
  // A line older than what was folded: it has to go in BEFORE what is there, so fold again.
  if (forgot || events.some(e => e.t <= cut && !after(e, s.hw))) return again();
  // Nothing new settles: answer from the snapshot as saved (its graph is ours to fold into). A
  // read writes a line of its own, so a log nobody else writes to would otherwise be rescanned
  // from the same place by every read, further each time. The saved mark moves past them once
  // there is enough to be worth writing a whole snapshot for.
  if (!events.length && !s.hot.some(e => e.t <= cut)) {
    if (save && end - s.bytes > TELEMETRY_SLACK) saveSnap(files.snap, { ...s, bytes: end });
    return answer(s, s.graph);
  }
  const g = s.graph;
  const { hw, hot } = settle(g, s.hw, [...s.hot, ...events].sort(byTime), cut);
  const n = { v: SNAP_V, bytes: end, events: s.events + events.length, built: now, ino: s.ino, gone: s.gone, hw, hot, graph: canonical(g) };
  if (save) saveSnap(files.snap, n);
  return answer(n, g);
}
export const rebuild = (fleetDir, opts) => rebuildFile(filesOf(fleetDir), opts);
export const snapshot = (fleetDir, opts) => snapshotFile(filesOf(fleetDir), opts);
// Compared a node and an edge at a time: one JSON string of a whole graph can pass the ceiling
// a string has, and then the check that says "these match" is the thing that dies.
export function sameGraph(a, b) {
  for (const k of ['nodes', 'edges']) {
    const x = Object.keys(a[k]), y = Object.keys(b[k]);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] || JSON.stringify(a[k][x[i]]) !== JSON.stringify(b[k][y[i]])) return false;
  }
  return true;
}

// ── forgetting ────────────────────────────────────────────────────────────
// `fleet-know forget <id>` appends a tombstone; the event drops out of the graph, out of `find`
// and out of what a paired machine can fetch. The line itself stays, so this is the undoable
// everyday form. `--purge` also rewrites the line, for a real leak: same id, same time, nothing
// else, in a temp file renamed over the log, with no backup, since a backup is the leak again.
//
// A TOMBSTONE IS SCOPED TO THE FILE IT IS IN, and lives in the file holding its target. A
// paired machine's tombstones land in that machine's cache (know-peers/<key>.jsonl) and can
// only ever erase what came from it: if they applied everywhere, a peer could erase this
// machine's own memory by naming an id.
const logsOf = (env) => {
  const out = [];
  for (const dir of allFleetDirs(env)) {
    out.push({ dir, peer: '', ...filesOf(dir) });
    let names = [];
    try { names = fs.readdirSync(path.join(dir, PEERS_DIR)); } catch {}
    for (const n of names) if (n.endsWith('.jsonl')) { const peer = n.slice(0, -'.jsonl'.length); out.push({ dir, peer, ...peerFiles(dir, peer) }); }
  }
  return out;
};
const stubOf = (e, now) => ({ id: e.id, v: e.v, t: e.t, kind: e.kind, machine: e.machine, profile: e.profile, project: e.project, rec: e.rec, src: {}, f: {}, purged: now });
// Every other byte of the file is kept as it was, torn and foreign lines included. A writer that
// lands while this copies is picked up by the catch-up, and one that had the old file open across
// the rename is picked up from the old descriptor after it. One that writes after that last look
// sees the file is no longer the log, and writes again (appendLine).
//
// THE CATCH-UP IS BOUNDED, because its only other way out is the file holding still between two
// looks, and a fleet that never pauses gives it no such moment. Correctness does not need the fixed
// point: whatever a pass did not reach is what the old descriptor hands over after the rename.
const PURGE_PASSES = 8;
function purgeLines(file, ids, now = Date.now()) {
  const src = fs.openSync(file, 'r');
  const mode = fs.fstatSync(src).mode & 0o777;
  const tmp = `${path.dirname(file)}/.${path.basename(file)}.${process.pid}.tmp`;
  let dst = null;
  const buf = Buffer.allocUnsafe(1 << 20);
  const copy = (from, to, out) => {
    let pos = from;
    while (pos < to) {
      const n = fs.readSync(src, buf, 0, Math.min(buf.length, to - pos), pos);
      if (!n) break;
      fs.writeSync(out, buf, 0, n);
      pos += n;
    }
    return pos;
  };
  // After the rename, out is shared with live appenders. A raw chunk can end halfway
  // through JSON; a writer landing between chunks then tears both events. Keep each
  // line in one write, as appendLine and appendMany do on the other side of this race.
  const copyLate = (from, to, out) => {
    let held = Buffer.alloc(0);
    while (from < to) {
      const n = fs.readSync(src, buf, 0, Math.min(buf.length, to - from), from);
      if (!n) break;
      const chunk = held.length ? Buffer.concat([held, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at = 0, nl;
      while ((nl = chunk.indexOf(10, at)) >= 0) {
        fs.writeSync(out, chunk, at, nl + 1 - at);
        at = nl + 1;
      }
      held = Buffer.from(chunk.subarray(at));
      from += n;
    }
    if (held.length) fs.writeSync(out, held);
  };
  let replaced = 0;
  try {
    dst = fs.openSync(tmp, 'wx', mode);
    fs.fchmodSync(dst, mode);
    let pos = 0, seen = -1;
    for (let pass = 0; pass < PURGE_PASSES; pass++) {
      const size = fs.fstatSync(src).size;
      if (size === seen) break;
      seen = size;
      const hits = [];
      const end = scanFd(src, pos, (e, off, len) => { if (ids.has(e.id) && !e.purged) hits.push([e, off, len]); });
      for (const [e, off, len] of hits) {
        copy(pos, off, dst);
        fs.writeSync(dst, JSON.stringify(stubOf(e, now)));
        pos = off + len;
        replaced++;
      }
      pos = copy(pos, end, dst);
    }
    pos = copy(pos, seen, dst);      // an unfinished last line stays as it was
    fs.fsyncSync(dst);
    fs.closeSync(dst); dst = null;
    fs.renameSync(tmp, file);
    const late = fs.fstatSync(src).size;
    if (late > pos) { const out = fs.openSync(file, 'a'); try { copyLate(pos, late, out); } finally { fs.closeSync(out); } }
    return replaced;
  } catch (e) {
    if (dst !== null) { try { fs.closeSync(dst); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  } finally { fs.closeSync(src); }
}
export function forget(id, { purge = false, env = process.env, now = Date.now() } = {}) {
  if (/^(0|off|no|false)$/i.test(env.CLAUDE_FLEET_KNOW || '')) return { ok: false, why: 'the memory is switched off here (CLAUDE_FLEET_KNOW), and off means no writer writes: unset it for this one command' };
  const held = [];
  for (const L of logsOf(env)) {
    let hit = null, tomb = false;
    scanLog(L.log, 0, (e) => {
      if (e.kind === FORGET) { if (e.f && e.f.target === id) tomb = true; } else if (e.id === id && (!hit || !e.purged)) hit = e;
    });
    if (hit) held.push({ ...L, hit, tomb });
  }
  if (!held.length) return { ok: false, why: `no event ${id} in any log on this machine (fleet-know find <text> prints each event's id)` };
  for (const L of held) {
    if (!L.tomb) {
      const ev = makeEvent({ t: now, rec: now, kind: FORGET, machine: L.peer || machineName(env), profile: profileOf(L.dir, env), project: '', src: { via: 'fleet-know' }, f: { target: id } });
      appendLine(L.log, JSON.stringify(ev) + '\n');
    }
    // The snapshot holds the text too, so it goes first, and is rebuilt without the event rather
    // than left for the next read: a purge is for what must not stay on the disk.
    fs.rmSync(L.snap, { force: true });
    L.purged = purge && !L.hit.purged ? purgeLines(L.log, new Set([id]), now) : 0;
    rebuildFile(L, { now, machine: L.peer });
  }
  return {
    ok: true, id, purge,
    kind: held[0].hit.kind, project: held[0].hit.project, t: held[0].hit.t,
    files: held.map(L => ({ log: L.log, peer: L.peer, already: L.tomb, purged: L.purged })),
  };
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
export const peerFiles = (dir, key) => ({ log: path.join(dir, PEERS_DIR, `${key}.jsonl`), meta: path.join(dir, PEERS_DIR, `${key}.meta.json`), snap: path.join(dir, PEERS_DIR, `${key}.graph.json`) });
export function peerMeta(dir, key) { try { return JSON.parse(fs.readFileSync(peerFiles(dir, key).meta, 'utf8')); } catch { return null; } }
// What a fetch brings, into the cache. A tombstone is read first, because one page can carry a
// tombstone and its target together, and a target must not be written to be erased a line later.
export function ingestPeerEvents(files, key, events, since = 0, now = Date.now()) {
  const have = new Set(), gone = new Set(), told = new Set();
  scanLog(files.log, 0, (e) => { have.add(e.id); if (e.kind === FORGET && e.f && e.f.target) gone.add(e.f.target); });
  for (const e of events) if (e && e.kind === FORGET && e.f && e.f.target && !gone.has(e.f.target)) { gone.add(e.f.target); told.add(e.f.target); }
  fs.mkdirSync(path.dirname(files.log), { recursive: true });
  let added = 0, after = since;
  const lines = [];
  for (const e of events) {
    if (!isEvent(e) || e.priv === 'private') continue;
    after = Math.max(after, e.t);
    // Refused on arrival as well as never sent: a machine that is paired does not get to put a
    // standing rule in front of this one's leads.
    if (STAYS_HERE(e)) continue;
    if (have.has(e.id) || gone.has(e.id)) continue;
    have.add(e.id);
    // Scrubbed on arrival too: the other side may be running a version without the table.
    lines.push(JSON.stringify({ ...e, machine: key, f: redactDeep(e.f) }));
    added++;
  }
  if (lines.length) appendLine(files.log, lines.join('\n') + '\n');
  // The owner of an event said to forget it. A cache has no history to keep, so the copy goes from
  // the disk here whether or not the other side purged its own.
  if (told.size) {
    fs.rmSync(files.snap, { force: true });
    try { purgeLines(files.log, told, now); } catch {}
  }
  return { added, after };
}
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
      try { r = await P.peerRequest(peer, { method: 'GET', pathq: `/api/know/events?after=${from}&tombstones=1`, timeout }); }
      catch (e) { r = { status: 0, error: e.message }; }
      if (!(r.status === 200 && r.json && Array.isArray(r.json.events))) break;
      got.push(...r.json.events);
      if (!r.json.more || !(r.json.next > from)) break;
      from = r.json.next - 1;
    }
    if (got.length && r.status !== 200) r = { status: 200, json: { events: [] } };   // a later page failed: keep what came
    const now = Date.now();
    if (r.status === 200 && r.json && Array.isArray(r.json.events)) {
      const { added, after } = ingestPeerEvents(files, peer.key, got, meta.after || 0, now);
      const pairing = notePairing(fleetDir, peer.key, meta, 'paired', '', now, env);
      const m = { key: peer.key, label: peer.label, ok: true, fetched_at: now, tried_at: now, after, added, pairing };
      fs.writeFileSync(files.meta, JSON.stringify(m));
      out.push(m);
    } else {
      const why = r.status ? `answered ${r.status}${r.json && r.json.text ? `: ${r.json.text}` : ''}` : (r.error || 'no answer');
      // The other side saying no is news about the pairing. No answer is not: a machine that is
      // asleep is still paired, and a laptop's lid must not close the fact every night.
      const pairing = r.status === 401 || r.status === 403 ? notePairing(fleetDir, peer.key, meta, 'refused', `answered ${r.status}`, now, env) : meta.pairing;
      const m = { key: peer.key, label: peer.label, ...meta, ok: false, tried_at: now, why, ...(pairing ? { pairing } : {}) };
      try { fs.mkdirSync(path.dirname(files.meta), { recursive: true }); fs.writeFileSync(files.meta, JSON.stringify(m)); } catch {}
      out.push(m);
    }
  }
  return out;
}
// A fact only when the state MOVES. Every poll writing a line would make the log a heartbeat, and
// the page's "since when" would be the last poll instead of the moment it changed. The state it
// compares against is the peer's meta file, the same one that holds the cursor.
export const pairingKey = (key) => `peer.${key}.pairing`;
function notePairing(fleetDir, key, meta, state, note, now, env) {
  if (meta.pairing !== state) {
    record('fact', { key: pairingKey(key), value: state, note, scope: 'machine' }, { fleetDir, project: NO_PROJECT, t: now, rec: now, src: { via: 'pairing' } }, env);
  }
  return state;
}
// What a paired host may have of this machine's log: every profile's events after `after`,
// minus anything private or excluded NOW (the stricter of the mark and the setting), and
// never a peer's own events passed on — a paired request does not fan out again.
//   A tombstone crosses whatever the project's setting says: it has no project and no text, and
// a target the peer never had costs it nothing. Only to a client that asks for them, because one
// from before tombstones folds an unknown kind into a project with no name, and its overview
// then throws on that name. A scan keeps at most two pages, however long the log is.
//   AND THE PAIRING'S OWN SETTING (lib/projects.mjs, pairScope): an event crosses only when its
// project is `include` here AND `share`. The two answer different questions and neither stands
// in for the other — privacy is whether a model vendor may read a turn and whether anything is
// recorded at all; `pair` is whether another machine is told. `scope` is the asking machine's
// (fleet-serve passes it); left out, it is computed here, so a caller that forgets to pass one
// gets the filter rather than the whole log. Only `false` — this machine asking itself — skips it.
//   Which project an event is about, for that question: the registered project its socket names
// (that project's own marker, wherever its log is); else hidden when a hidden project has its
// name, or when the log's own fleet dir says so for its socket (a project since removed from the
// list) or for the whole profile. A depends-on whose other end is a
// hidden project of this machine stays here too, since the event carries that project's name.
export function eventsForPeer({ after = 0, limit = 5000, tombstones = false, scope, env = process.env } = {}) {
  let events = [];
  const gone = new Set();
  const hold = (e) => {
    events.push(e);
    if (events.length > limit * 2) { events.sort(byTime); events.length = limit + 1; }
  };
  const list = scope === false ? [] : projects();
  const sc = scope === false ? null : (scope || pairScope(list));
  const bySock = new Map(list.map(t => [t.sock, t]));
  const self = sc ? machineName(env) : '';
  const hiddenHere = (e, dir, pairs) => {
    if (!sc) return false;
    const sock = (e.src && e.src.sock) || '';
    const t = sock && bySock.get(sock);
    if (t) { if (!sc.sees(t)) return true; }
    else {
      if (sc.nameHidden(e.project)) return true;
      if (!pairs.has(sock)) pairs.set(sock, pairFor(dir, sock).mode !== 'share');
      if (pairs.get(sock)) return true;
    }
    if (e.kind !== 'relate' || !e.f || !e.f.to) return false;
    const o = splitName(e.f.to);
    if (o.machine && o.machine !== self) return false;
    const prof = o.profile || e.profile;
    const other = list.find(x => x.name === o.name && (x.profile === prof || (x.profile === 'default' && prof === 'work')));
    return other ? !sc.sees(other) : sc.nameHidden(o.name);
  };
  for (const dir of allFleetDirs(env)) {
    const modes = new Map(), pairs = new Map();
    scanLog(path.join(dir, LOG), 0, (e) => {
      if (e.kind === FORGET) {
        if (e.f && e.f.target) gone.add(e.f.target);
        if (tombstones && e.t > after) hold(e);
        return;
      }
      if (e.t <= after || STAYS_HERE(e)) return;
      const sock = e.src && e.src.sock;
      if (!modes.has(sock)) modes.set(sock, privacyFor(dir, sock).mode);
      if (stricter(e.priv || 'include', modes.get(sock)) !== 'include') return;
      if (hiddenHere(e, dir, pairs)) return;
      hold(e);
    });
  }
  events.sort(byTime);
  const page = events.slice(0, limit);
  // The cursor is the page's as READ: a page of nothing but forgotten events still moves on.
  return {
    // Redacted on the way out as well, for a line written before the table existed.
    events: page.filter(e => !gone.has(e.id)).map(e => ({ ...e, f: redactDeep(e.f) })),
    more: events.length > page.length,
    next: page.length ? page[page.length - 1].t : after,
  };
}

// ── the view: every profile, every peer, merged ───────────────────────────
// `hidden` holds the projects whose CURRENT setting is exclude: their old events stay in the
// log (append-only), but an answer does not show them. `privateNow` is the set marked private
// by the setting today, on top of whatever was marked private when it was written.
export async function view({ env = process.env, sync = true, timeout = 1500 } = {}) {
  const dirs = allFleetDirs(env);
  // The first graph is adopted rather than copied, and a lone source is already canonical, so one
  // busy profile does not pay to rebuild its whole graph on every read.
  let g = null, merged = 0;
  const add = (graph) => { g = g ? mergeInto(g, graph) : graph; merged++; };
  const sources = [], raw = [];
  for (const d of dirs) {
    const s = snapshot(d);
    raw.push({ log: path.join(d, LOG), machine: '', gone: new Set(s.gone) });
    if (!s.events) continue;
    add(s.graph);
    sources.push({ kind: 'profile', profile: profileOf(d, env), dir: d, events: s.events });
  }
  const peers = await pairedPeers(env);
  if (peers.length && sync) { try { await syncPeers({ fleetDir: fleetDirOf(env), timeout, env, minAge: SYNC_EVERY }); } catch {} }
  const peerState = [];
  for (const peer of peers) {
    let best = null, events = 0;
    for (const d of dirs) {
      const m = peerMeta(d, peer.key);
      if (m && (!best || (m.fetched_at || 0) > (best.fetched_at || 0))) best = m;
      // A cache is a log like any other, with a snapshot like any other: without one, a read
      // folded everything this machine had ever fetched from that peer, every time it was asked.
      const pf = peerFiles(d, peer.key);
      const s = snapshotFile(pf, { machine: peer.key });
      raw.push({ log: pf.log, machine: peer.key, gone: new Set(s.gone) });
      if (s.events) { add(s.graph); events = Math.max(events, s.events); }
    }
    const fetched = best && best.fetched_at ? best.fetched_at : 0;
    const stale = !best || !best.ok || Date.now() - fetched > STALE_MS;
    peerState.push({ key: peer.key, label: peer.label, events, fetched_at: fetched, stale, why: best && !best.ok ? best.why : (fetched ? '' : 'never fetched') });
  }
  const modeOf = modeReader(dirs, env);
  return { g: !g ? emptyGraph() : merged > 1 ? canonical(g) : g, sources, peers: peerState, modeOf, dirs, scanRaw: (visit) => scanRaw(raw, visit) };
}
// What --known-at reads: the graph of what had been recorded by then, folded from those lines alone.
// A mark and an attribute with a history can each answer that for themselves, but a first-wins
// attribute (`merged`, `opened`, `spawned`) holds one value, and every read that leans on one told
// the reader about things nobody had written down yet. It went unseen while a line's recorded time
// was its valid time to the second, and a backfill puts months between them. The price is a fold, on
// a flag somebody reaches for rarely.
export function asKnown(v, known) {
  if (!Number.isFinite(known)) return v;
  const seen = (e) => (e.rec || e.t) <= known;
  const events = [];
  v.scanRaw((e) => { if (seen(e)) events.push(e); });
  events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const g = emptyGraph();
  for (const e of events) fold(g, e);
  return { ...v, g: canonical(g), scanRaw: (visit) => v.scanRaw((e) => { if (seen(e)) visit(e); }) };
}
function modeReader(dirs, env) {
  const settings = new Map();
  for (const d of dirs) settings.set(profileOf(d, env), d);
  // Two file reads a call, once per project per read before this: `waiting` asks every project
  // about every project.
  const modes = new Map();
  const modeNow = (d, sock) => {
    const k = `${d}\0${sock}`;
    if (!modes.has(k)) modes.set(k, privacyFor(d, sock).mode);
    return modes.get(k);
  };
  return (n) => {
    const d = settings.get(attr(n, 'profile'));
    const now = d ? modeNow(d, attr(n, 'sock')) : 'include';
    return stricter(attr(n, 'priv') || 'include', now);
  };
}
// THE ONE VIEW THAT ASKS NOBODY: this profile's own snapshot and those it named, with no peer
// sync and nothing saved. A session start waits on it, so it must not wait on another machine, or
// spend its budget writing a whole snapshot; a read that does either belongs to view().
export function localView(fleetDir, env = process.env) {
  const own = snapshot(fleetDir, { save: false });
  let g = own.graph, events = own.events;
  const dirs = [fleetDir];
  for (const p of sharesOf(g, profileOf(fleetDir, env))) {
    const d = path.join(cfgFor(p), 'fleet');
    let s; try { s = snapshot(d, { save: false }); } catch { continue; }
    if (!s.events) continue;
    g = merge(g, s.graph);
    dirs.push(d);
  }
  return { g, sources: [], peers: [], modeOf: modeReader(dirs, env), dirs, events, scanRaw: () => {} };
}
// Every raw event, a line at a time. Never as one array: `find` keeps what matches and nothing
// else. A tombstone is scoped to its file, so each file is filtered by its own.
function scanRaw(files, visit) {
  for (const { log, machine, gone } of files) {
    scanLog(log, 0, (e) => {
      if (e.kind === FORGET || TELEMETRY.has(e.kind) || gone.has(e.id)) return;
      visit(machine ? { ...e, machine } : e);
    });
  }
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
//
// THE READ INDEX. Every question used to walk every edge and node for the few it wanted, and did
// so per PR and per request, so a brief grew with the square of the log and `waiting`, a brief
// per project, grew past that: 95 seconds at 90k events. Built once per graph on the first
// question, in the graph's own key order, so what a lookup returns is what the filter it replaced
// returned, in the same order. A graph is not folded into after view() has handed it out.
const readIndexes = new WeakMap();
function readIndex(g) {
  let x = readIndexes.get(g);
  if (x) return x;
  x = { from: new Map(), into: new Map(), type: new Map(), inProject: new Map() };
  for (const e of Object.values(g.edges)) {
    addTo(x.from, `${e.type}|${e.from}`, e);
    addTo(x.into, `${e.type}|${e.to}`, e);
  }
  for (const entry of Object.entries(g.nodes)) {
    const [, n] = entry, P = attr(n, 'project');
    addTo(x.type, n.type, entry);
    if (P !== undefined) addTo(x.inProject, `${n.type}|${P}`, entry);
  }
  readIndexes.set(g, x);
  return x;
}
const NONE = [];
const edgesFrom = (g, type, from) => readIndex(g).from.get(`${type}|${from}`) || NONE;
const edgesInto = (g, type, to) => readIndex(g).into.get(`${type}|${to}`) || NONE;
const nodesOfType = (g, type) => readIndex(g).type.get(type) || NONE;
const nodesIn = (g, type, P) => readIndex(g).inProject.get(`${type}|${P}`) || NONE;
const projectLists = new WeakMap();
export function projectsIn(v) {
  let list = projectLists.get(v);
  if (list) return list;
  list = nodesOfType(v.g, 'project').filter(([, n]) => attr(n, 'first') !== undefined)
    .map(([id, n]) => ({ id, name: attr(n, 'name'), machine: attr(n, 'machine'), profile: attr(n, 'profile'), last: attr(n, 'last') || 0, mode: v.modeOf(n) }))
    .filter(p => p.mode !== 'exclude')
    .sort((a, b) => b.last - a.last);
  projectLists.set(v, list);
  return list;
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

// What a request or a branch is ABOUT, from the text it was opened with. A brief a lead hands
// a worker opens with the same boilerplate every time ("You are a worker in the … repo. One
// task, one PR against …"), so the first words say nothing about which task this is. The text
// is stored flattened to one line, so headings arrive as ` ## Task ` inside it. In order: the
// line under a Task/Goal heading; else the first sentence that is not a generic opener, in a
// section that is not background; else nothing, and the caller names the branch instead.
const GENERIC_OPENER = /^(?:you are\b|you're\b|you will\b|this is\b|one task\b|your (?:job|task) is to follow|hi\b|hello\b|hey\b|welcome\b|read\b.*\bfirst\b)/i;
const BACKGROUND_HEAD = /^(?:context|background|rules?|tests?|constraints?|notes?|how to|setup|environment|reminders?)\b/i;
const TASK_HEAD = /^(?:the )?(?:task|goal|ask|objective|your task|what to do|request)\b[:\s]*/i;
export function taskLine(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sections = flat.split(/\s(?=#{1,6}\s)/).map(x => x.replace(/^#{1,6}\s+/, '').trim()).filter(Boolean);
  const sentences = (t) => t.split(/(?<=[.!?:])\s+(?=[A-Z`"'(\d])/).map(x => x.trim()).filter(Boolean);
  const generic = (x) => GENERIC_OPENER.test(x) || /\bone task,? one pr\b/i.test(x) || /^[`'"]?[\w./-]+[`'"]?:?$/.test(x);
  for (const sec of sections) {
    const m = TASK_HEAD.exec(sec);
    if (m && sections.length > 1) { const rest = sentences(sec.slice(m[0].length)).find(x => !generic(x)); if (rest) return clip(rest, 140); }
  }
  for (const sec of sections) {
    if (sections.length > 1 && BACKGROUND_HEAD.test(sec)) continue;
    const hit = sentences(sec).find(x => !generic(x));
    if (hit) return clip(hit, 140);
  }
  return '';
}

// The line a request is shown by. Only a brief-shaped request (one that opens with the
// generic opener) is replaced: the worker's own `fleet-ack` "understood" line first, since it
// is what the worker says it is doing; then the task found in the text; then the branch.
function requestLabel(g, n, at, known) {
  const text = attr(n, 'text') || '';
  if (!GENERIC_OPENER.test(text.trim())) return '';
  const S = g.nodes[attr(n, 'session')];
  const br = S ? attr(S, 'branch') : '';
  const B = br ? g.nodes[branchId(attr(S, 'repo') || '', br)] : null;
  return val(B, 'understood', at, known) || taskLine(text) || (br && br !== 'HEAD' ? br : '');
}

const DECAY_MS = 7 * 86400e3;   // closed longer ago than this is summarised, not listed
const LIST = 5;
const DECISIONS_SHOWN = 8;
const RULES_SHOWN = 8;
const shortId = (nodeId) => String(nodeId).slice(String(nodeId).indexOf(':') + 1);

// The decisions about a project that hold at `at`, newest first. The page and the briefing both
// read this, so "still holds" has one spelling. A close only hides what closed: the node, and what
// `--at` reads, are untouched.
export function decisionsHolding(g, P, { at = Infinity, known = Infinity } = {}) {
  return edgesInto(g, 'about', P).filter(e => holds(e, at, known)).map(e => ({ n: g.nodes[e.from], id: e.from }))
    .filter(d => d.n).map(d => ({ id: shortId(d.id), text: attr(d.n, 'text'), why: attr(d.n, 'why'), source: attr(d.n, 'source'), authority: attr(d.n, 'authority') || 'worker', inferred: attr(d.n, 'inferred') === 'yes', t: attrAt(d.n, 'text'), by: attr(g.nodes[attr(d.n, 'session')], 'slot'), priv: attr(d.n, 'priv') === 'private' }))
    .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
}
// The keyed facts that hold on a project, or on this machine, as they stood at `at`. What a key
// used to say comes back only if it was still saying it then.
function factRow(n, at, known) {
  // The history row in force, rather than the attribute, so a reader can name the event that set
  // it. A note belongs to the value it came with: setA keeps the last one it was given, so the
  // `answered 403` of a pairing that has since come back would otherwise go on being printed
  // beside `paired`, which is the very thing a fact that closes itself is for.
  let cur = null;
  for (const x of (n.h && n.h.value) || []) if (x[1] <= at && x[3] <= known && (!cur || x[1] > cur[1] || (x[1] === cur[1] && x[2] > cur[2]))) cur = x;
  if (!cur) return null;
  const note = n.a.note && n.a.note[2] === cur[2] ? n.a.note[0] : '';
  return { key: attr(n, 'key'), value: cur[0], note, authority: val(n, 'authority', at, known) || 'worker', id: cur[2], t: cur[1], by: attr(n, 'by'), priv: attr(n, 'priv') === 'private' };
}
// With `machine`, a fact that what the fleet has since seen for itself has overtaken drops out:
// somebody's `peer.vm.pairing = paired`, written before that machine started refusing, is not
// current just because nobody came back to close it.
export function factsHolding(g, P, { at = Infinity, known = Infinity, machine = '' } = {}) {
  const rows = edgesInto(g, 'fact-holds', P).filter(e => holds(e, at, known)).map(e => g.nodes[e.from]).filter(Boolean)
    .map(n => factRow(n, at, known)).filter(Boolean).sort((a, b) => b.t - a.t);
  if (!machine) return rows;
  const seen = machineFacts(g, machine, { at, known });
  return rows.filter(x => !seen.some(o => o.key === x.key && o.t >= x.t));
}
export function machineFacts(g, machine, opts = {}) { return factsHolding(g, machineAnchor(machine), opts); }
// One key, the way a reader asks for it: the project's own and this machine's, whichever said so
// last. `closed` says a key once held and no longer does, without saying what it held.
export function factFor(v, q, key, { at = Infinity, known = Infinity } = {}) {
  const { hit } = findProject(v, q);
  const machine = hit ? hit.machine : machineName();
  const tries = [...(hit ? [[factId(hit.id, key), hit.id, false]] : []), [machineFactId(machine, key), machineAnchor(machine), true]];
  const project = hit ? hit.name : '';
  let closed = 0, best = null;
  for (const [id, anchor, onMachine] of tries) {
    const n = v.g.nodes[id], e = v.g.edges[edgeKey('fact-holds', id, anchor)];
    if (!n || !e) continue;
    const row = holds(e, at, known) ? factRow(n, at, known) : null;
    if (row && (!best || row.t >= best.t)) best = { recorded: true, project, machine: onMachine, ...row };
    if (!row) for (const m of e.m) if (m[1] === 'close' && m[0] <= at && m[2] <= known && m[0] > closed) closed = m[0];
  }
  return best || { recorded: false, project, key, closed: closed || null, known: !!hit };
}
export const renderFact = (r, q, now = Date.now()) => (r.recorded
  ? `${r.key} = ${r.value}  [${r.authority}${r.by ? `, ${r.by}` : ''}, ${ago(r.t, now)}]${r.note ? ` — ${r.note}` : ''}  ${r.id || ''}`.trimEnd()
  : `not recorded: ${q} has no current fact '${r.key}'${r.closed ? ` (closed ${day(r.closed)}; --at reads what it was)` : ''}`);

// The profiles this one opted in to reading (rule.share, in ITS log).
export function sharesOf(g, profile, { at = Infinity, known = Infinity } = {}) {
  return edgesFrom(g, 'rule-share', ruleAnchor(profile)).filter(e => holds(e, at, known)).map(e => e.to.slice('rules:'.length));
}
// WHICH RULES APPLY. A profile's own, plus an `all` rule from a profile it opted in to: `profile`
// says "every project in this profile" and `project:` names one, so neither can mean a project
// elsewhere. Sorted most specific first, because that is the order they win in. There is no model
// here, so nothing can tell that two rules contradict each other; the output says the order
// instead of settling it, and `--supersedes` is how the owner settles it.
export const RULE_PRECEDENCE = 'most specific wins: project: beats profile beats all';
export function rulesFor(v, { profile = '', project = '', at = Infinity, known = Infinity } = {}) {
  const g = v.g, shared = new Set(sharesOf(g, profile, { at, known }));
  const live = [], proposed = [];
  for (const [id, n] of nodesOfType(g, 'rule')) {
    const from = attr(n, 'profile'), scope = attr(n, 'scope');
    if (from !== profile && !(shared.has(from) && scope === 'all')) continue;
    if (project && scopeKind(scope) === 'project' && scope !== `project:${project}`) continue;
    const row = () => ({ id: shortId(id), text: attr(n, 'text'), why: attr(n, 'why'), quote: attr(n, 'quote'), scope, authority: val(n, 'authority', at, known) || 'worker', by: attr(n, 'by'), t: attrAt(n, 'text'), from, shared: from !== profile, priv: attr(n, 'priv') === 'private' });
    const e = g.edges[edgeKey('rule-holds', id, ruleAnchor(from))];
    if (holds(e, at, known)) { live.push(row()); continue; }
    // Never in force as at then, and nobody had closed it: still somebody's proposal. Another
    // profile's proposal is that profile's to accept, so it does not cross.
    const ended = e && e.m.some(x => x[0] <= at && x[2] <= known);
    if (attr(n, 'proposed') === 'yes' && !ended && attrAt(n, 'text') <= at && from === profile) proposed.push(row());
  }
  const authorityFirst = (a, b) => (a.authority === b.authority ? 0 : a.authority === 'owner' ? -1 : b.authority === 'owner' ? 1 : 0);
  const newest = (a, b) => b.t - a.t || (a.id < b.id ? 1 : -1);
  live.sort((a, b) => SCOPE_RANK[scopeKind(a.scope)] - SCOPE_RANK[scopeKind(b.scope)] || authorityFirst(a, b) || newest(a, b));
  proposed.sort(newest);
  return { profile, project, shares: [...shared], live, proposed, precedence: RULE_PRECEDENCE };
}
// Whether anything a briefing names was ever on record here, closed since or not.
export function anythingEverHeld(g, profile, P = '') {
  const anchor = ruleAnchor(profile);
  if (edgesInto(g, 'rule-holds', anchor).length || edgesFrom(g, 'rule-share', anchor).length) return true;
  return !!P && ['about', 'fact-holds', 'request-in', 'pr-in'].some(t => edgesInto(g, t, P).length > 0);
}
const ruleLine = (r) => `${r.id}  [${r.authority} ${r.scope}${r.shared ? `, from ${r.from}` : ''}] ${clip(r.text, 200)}${r.why ? ` — ${clip(r.why, 120)}` : ''}${r.quote ? `  (“${clip(r.quote, 80)}”)` : ''}${r.priv ? ' [private]' : ''}`;
export function renderRules(r) {
  const L = [`rules for ${r.project || `every project in ${r.profile}`} (${r.profile} profile) — ${r.precedence}`];
  if (r.shares.length) L.push(`also reading the \`all\` rules of: ${r.shares.join(', ')} (fleet-know rule share-from <profile> --off stops it)`);
  if (r.live.length) for (const x of r.live) L.push(`  ${ruleLine(x)}`);
  else L.push('  not recorded: no rule applies');
  if (r.proposed.length) {
    L.push(`PROPOSED — not rules until an owner or lead runs fleet-know rule accept <id>`);
    for (const x of r.proposed) L.push(`  ${x.id}  [${x.authority}${x.by ? `, ${x.by}` : ''} → ${x.scope}] ${clip(x.text, 200)}`);
  }
  if (r.live.some(x => x.priv)) L.push(PRIV_NOTE);
  return L.join('\n');
}
// `authority` (an array, K.TRUSTED for the owner's and the lead's word) narrows the page to what
// those said: decisions, what the project is and what it depends on. The rest of the page is what
// happened, not what somebody claims, and stands.
// `workers: false` leaves a worker's or a model's decisions off the DECISIONS list and counts them
// instead (`decisionsHidden`): every worker's fleet-ack is one, and they crowd out what the owner
// decided. It is a read-time filter on the page; the events stay as they were. A library caller
// that says nothing gets everything, as before.
export function brief(v, q, { at = Infinity, known = Infinity, now = Date.now(), authority = null, workers = true } = {}) {
  const { hit, others } = findProject(v, q);
  if (!hit) return null;
  const g = v.g, P = hit.id, pn = g.nodes[P];
  const when = Number.isFinite(at) ? at : now;
  const allowed = authority ? new Set(authority) : null;
  const takes = (a) => !allowed || allowed.has(a);
  const into = (type, to) => edgesInto(g, type, to);
  const repos = edgesFrom(g, 'has-repo', P).filter(e => holds(e, at, known)).map(e => attr(g.nodes[e.to], 'slug'));
  const sessions = into('in-project', P).filter(e => holds(e, at, known)).map(e => ({ id: e.from, n: g.nodes[e.from] }))
    .filter(s => s.n).map(s => {
      const branchE = edgesFrom(g, 'works-on', s.id).find(e => holds(e, at, known));
      return { slot: attr(s.n, 'slot') || s.id.slice(8, 16), status: val(s.n, 'status', at, known) || 'idle', last: val(s.n, 'last', at, known) || 0,
               branch: branchE ? attr(g.nodes[branchE.to], 'name') : val(s.n, 'branch', at, known), need: val(s.n, 'need', at, known), said: Number.isFinite(at) ? undefined : attr(s.n, 'said') };
    }).filter(s => s.last && s.last <= when).sort((a, b) => b.last - a.last);
  const live = sessions.filter(s => when - s.last < 2 * 86400e3);
  const quiet = sessions.length - live.length;
  const prs = nodesIn(g, 'pr', P)
    .map(([id, n]) => {
      const inP = g.edges[edgeKey('pr-in', id, P)];
      const openNow = inP ? holds(inP, at, known) : false;
      return { id, n, number: attr(n, 'number'), branch: attr(n, 'branch'), url: attr(n, 'url'), author: attr(n, 'author'), repo: attr(n, 'repo'), openNow,
               state: openNow ? 'open' : (attr(n, 'merged') && attr(n, 'merged') <= when ? 'merged' : attr(n, 'closed') && attr(n, 'closed') <= when ? 'closed' : (attr(n, 'opened') > when ? 'future' : attr(n, 'state'))),
               endedAt: attr(n, 'merged') || attr(n, 'closed') || 0, opened: attr(n, 'opened') || 0 };
    }).filter(p => p.opened <= when && p.state !== 'future');
  const openPrs = prs.filter(p => p.openNow).sort((a, b) => b.opened - a.opened);
  const openOnBranch = new Map();
  for (const p of openPrs) if (!openOnBranch.has(p.branch)) openOnBranch.set(p.branch, p);
  const branches = nodesIn(g, 'branch', P).filter(([, n]) => attr(n, 'spawned') && attr(n, 'spawned') <= when && !(attr(n, 'retired') && attr(n, 'retired') <= when))
    .map(([id, n]) => {
      // The PR as a reader needs it, not the graph node behind it: that carries every
      // attribute's history, and a brief is what an MCP answer pastes into a lead's context.
      const p = openOnBranch.get(attr(n, 'name'));
      return { id, name: attr(n, 'name'), worker: attr(n, 'worker'), task: val(n, 'understood', at, known) || taskLine(attr(n, 'task')), pr: p ? { number: p.number, url: p.url, opened: p.opened } : undefined };
    });
  const deploys = into('deploy-in', P).map(e => ({ id: e.from, n: g.nodes[e.from], t: e.m.length ? Math.max(...e.m.filter(x => x[2] <= known).map(x => x[0])) : 0 }))
    .filter(d => d.n && d.t && d.t <= when).sort((a, b) => b.t - a.t);
  const reqs = nodesIn(g, 'request', P).filter(([, n]) => (attr(n, 'opened') || 0) <= when)
    .map(([id, n]) => { const e = g.edges[edgeKey('request-in', id, P)]; return { id, n, open: e ? holds(e, at, known) : false, state: val(n, 'state', at, known), text: attr(n, 'text'), label: requestLabel(g, n, at, known), opened: attr(n, 'opened') || 0, closed: attr(n, 'closed') || 0, session: g.nodes[attr(n, 'session')], priv: attr(n, 'priv') === 'private', authority: attr(n, 'authority') || 'worker' }; });
  const openReqs = reqs.filter(r => r.open).sort((a, b) => b.opened - a.opened);
  const decisions = decisionsHolding(g, P, { at, known }).filter(d => takes(d.authority));
  const facts = factsHolding(g, P, { at, known, machine: hit.machine }).filter(x => takes(x.authority));
  // What the fleet saw for itself about this machine stands under --trusted, like the rest of
  // what happened: it is nobody's claim.
  const observed = machineFacts(g, hit.machine, { at, known });
  // A paired machine's project is not under this machine's rules, even in a profile of the same
  // name: rules never cross a pairing, and its own arrive with nothing.
  const fromPeer = (v.peers || []).some(p => p.key === hit.machine);
  const rules = fromPeer ? { live: [], proposed: [], precedence: RULE_PRECEDENCE } : rulesFor(v, { profile: hit.profile, project: hit.name, at, known });
  // Who said each relation: the side that wrote it holds the mark.
  const depRows = edgesFrom(g, 'depends-on', P).filter(e => holds(e, at, known)).map(e => ({ name: attr(g.nodes[e.to], 'name'), authority: attr(pn, `relBy:${e.to}`) || 'worker' })).filter(r => takes(r.authority));
  const usedRows = edgesInto(g, 'depends-on', P).filter(e => holds(e, at, known)).map(e => ({ name: attr(g.nodes[e.from], 'name'), authority: attr(g.nodes[e.from], `relBy:${P}`) || 'worker' })).filter(r => takes(r.authority));
  const deps = depRows.map(r => r.name), usedBy = usedRows.map(r => r.name);
  const aboutBy = attr(pn, 'aboutBy') || 'worker';
  const [about, aboutAuthority] = attr(pn, 'about') === undefined ? [] : takes(aboutBy) ? [attr(pn, 'about'), aboutBy]
    : takes(attr(pn, 'aboutTrustedBy')) ? [attr(pn, 'aboutTrusted'), attr(pn, 'aboutTrustedBy')] : [];
  // An open PR that did not come out of this fleet: its head branch is no session's and no
  // spawn manifest's, or its author is not the repo's owner. Nothing on the fleet's side ever
  // reports such a PR done, so without this it was listed under the PRs and waited on no one.
  const ownedBranch = new Set([
    ...nodesIn(g, 'session', P).map(([, n]) => attr(n, 'branch')),
    ...nodesIn(g, 'branch', P).filter(([, n]) => attr(n, 'spawned')).map(([, n]) => attr(n, 'name')),
  ].filter(Boolean));
  const doneBranches = new Set(sessions.filter(s => s.status === 'done').map(s => s.branch));
  const workerDone = (p) => doneBranches.has(p.branch);
  const outsidePrs = openPrs.filter(p => !workerDone(p)).filter(p => {
    const owner = String(p.repo || '').split('/')[0].toLowerCase();
    return (p.author && owner && p.author.toLowerCase() !== owner) || !(p.branch && ownedBranch.has(p.branch));
  });
  // `live: true` is a session's state this minute, and `ref` is how a briefing names the row.
  const waiting = [
    ...live.filter(s => s.status === 'need-you').map(s => ({ what: `${s.slot} needs you: ${s.need || 'a question on its pane'}`, live: true })),
    ...openPrs.filter(workerDone).map(p => ({ what: `PR #${p.number} (${p.branch}) — its worker reported done; waits for review/merge`, ref: `pr#${p.number}` })),
    ...outsidePrs.map(p => ({ what: p.author ? `PR #${p.number} from ${p.author} waits for review` : `PR #${p.number} (${p.branch || 'no branch'}) has no fleet worker behind it; waits for review`, ref: `pr#${p.number}` })),
    ...openReqs.filter(r => r.state === 'waiting').map(r => ({ what: `request waiting on you: "${clip(r.text, 120)}"`, ref: shortId(r.id), priv: r.priv })),
  ];
  // DECAY: what closed more than a week before `at` is counted, not listed. So is a worker's or a
  // model's decision, whether or not it closed: that is a guess somebody made, and it earns its
  // place on the page by being recent. What the owner or a lead said stands until it is closed.
  const old = (t) => t && when - t > DECAY_MS;
  const standing = decisions.filter(d => TRUSTED.includes(d.authority));
  const recent = decisions.filter(d => !TRUSTED.includes(d.authority) && !old(d.t));
  const hideWorkers = !workers && !allowed;
  const listed = hideWorkers ? standing : [...standing, ...recent];
  const decisionsHidden = hideWorkers ? decisions.length - standing.length : 0;
  const factsListed = facts.filter(x => TRUSTED.includes(x.authority) || !old(x.t));
  const earlier = {
    requests: reqs.filter(r => !r.open && old(r.closed)).length,
    prs: prs.filter(p => !p.openNow && old(p.endedAt)).length,
    deploys: deploys.filter(d => old(d.t)).length,
    decisions: hideWorkers ? 0 : decisions.length - listed.length,
    facts: facts.length - factsListed.length,
  };
  // A loop, not Math.min(...all): an argument list that long is a RangeError on a big project.
  let since = when;
  for (const list of [reqs.map(r => r.opened), prs.map(p => p.opened), decisions.map(d => d.t)]) for (const t of list) if (t && t < since) since = t;
  return {
    project: hit.name, machine: hit.machine, profile: hit.profile, mode: hit.mode, others: others.map(o => `${o.name}@${o.machine}/${o.profile}`),
    at: Number.isFinite(at) ? at : null, about, aboutAuthority, authorityFilter: authority || null, repos, deps, usedBy,
    depAuthority: Object.fromEntries(depRows.map(r => [r.name, r.authority])), usedByAuthority: Object.fromEntries(usedRows.map(r => [r.name, r.authority])),
    sessions: live, quiet, branches, openPrs: openPrs.map(p => ({ number: p.number, branch: p.branch, author: p.author, url: p.url, opened: p.opened })),
    recentPrs: prs.filter(p => !p.openNow && !old(p.endedAt)).sort((a, b) => b.endedAt - a.endedAt).slice(0, LIST).map(p => ({ number: p.number, branch: p.branch, state: p.state, at: p.endedAt })),
    lastDeploy: deploys[0] ? { target: attr(deploys[0].n, 'target'), cmd: attr(deploys[0].n, 'cmd'), label: deployLabel(attr(deploys[0].n, 'target'), attr(deploys[0].n, 'cmd')), commit: attr(deploys[0].n, 'commit'), ok: attr(deploys[0].n, 'ok') !== 'no', at: deploys[0].t, by: attr(g.nodes[attr(deploys[0].n, 'session')], 'slot') || attr(deploys[0].n, 'slot') } : null,
    openRequests: openReqs.map(r => ({ text: r.text, label: r.label, state: r.state, opened: r.opened, by: attr(r.session, 'slot'), priv: r.priv, authority: r.authority })),
    waiting, decisions: listed.slice(0, DECISIONS_SHOWN), decisionsMore: Math.max(0, listed.length - DECISIONS_SHOWN), decisionsHidden,
    rules: rules.live.slice(0, RULES_SHOWN), rulesMore: Math.max(0, rules.live.length - RULES_SHOWN), rulesProposed: allowed ? 0 : rules.proposed.length, rulePrecedence: rules.precedence,
    facts: factsListed, observed,
    earlier: { ...earlier, since: since < when ? since : null },
    peers: v.peers,
  };
}

export const PRIV_NOTE = '[private] — readable here; do not paste it into a prompt for another model vendor';
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
  if (b.authorityFilter) L.push(`only what ${b.authorityFilter.join(' or ')} said`);
  L.push(`  what it is   ${b.about ? `${b.about}  [${b.aboutAuthority}]` : b.authorityFilter ? `(nothing from ${b.authorityFilter.join(' or ')})` : `(not described yet — fleet-know describe ${b.project} "<one line>")`}`);
  // A relation is tagged only when it is below the word a reader would take as read, so the
  // ordinary line stays one a person can scan.
  const rel = (names, by) => names.map(n => (by[n] && !TRUSTED.includes(by[n]) ? `${n} [${by[n]}]` : n)).join(', ');
  if (b.deps.length || b.usedBy.length) L.push(`  depends on   ${rel(b.deps, b.depAuthority) || '-'}${b.usedBy.length ? ` · used by ${rel(b.usedBy, b.usedByAuthority)}` : ''}`);
  L.push('WHERE IT STANDS');
  if (b.sessions.length) for (const s of b.sessions.slice(0, 8)) L.push(`  ${s.slot.padEnd(14)} ${String(s.status).padEnd(9)} ${s.branch ? `on ${s.branch}` : ''}  (${ago(s.last, now)})`);
  else L.push('  no live sessions');
  if (b.quiet) L.push(`  + ${b.quiet} quiet for 2 days or more`);
  for (const br of b.branches.slice(0, LIST)) L.push(`  branch ${br.name}${br.worker ? ` (${br.worker})` : ''}${br.pr ? ` → PR #${br.pr.number} open` : ' — no PR yet'}${br.task && br.task !== '-' ? `: ${clip(br.task, 90)}` : ''}`);
  for (const p of b.openPrs.filter(p => !b.branches.some(br => br.pr && br.pr.number === p.number)).slice(0, LIST)) L.push(`  PR #${p.number} open${p.branch ? ` (${p.branch})` : ''}, ${ago(p.opened, now)}`);
  for (const p of b.recentPrs) L.push(`  PR #${p.number} ${p.state}${p.branch ? ` (${p.branch})` : ''}, ${ago(p.at, now)}`);
  L.push(`  last deploy  ${b.lastDeploy ? `${ago(b.lastDeploy.at, now)} — ${b.lastDeploy.label || b.lastDeploy.target}${b.lastDeploy.commit ? ` at ${String(b.lastDeploy.commit).slice(0, 8)}` : ''}${b.lastDeploy.by ? ` (${b.lastDeploy.by})` : ''}${b.lastDeploy.ok ? '' : ' — FAILED'}` : 'none seen'}`);
  L.push('OPEN');
  if (b.waiting.length) for (const w of b.waiting.slice(0, LIST)) L.push(`  waits on you: ${w.what}`);
  if (b.openRequests.length) {
    L.push(`  ${b.openRequests.length} open request${b.openRequests.length === 1 ? '' : 's'}:`);
    for (const r of b.openRequests.slice(0, LIST)) L.push(`    "${clip(r.label || r.text, 110)}"${r.by ? ` (${r.by}, ${ago(r.opened, now)})` : ''}${r.state && r.state !== 'open' ? ` [${r.state}]` : ''}${r.priv && b.mode !== 'private' ? ' [private]' : ''}`);
    if (b.openRequests.length > LIST) L.push(`    + ${b.openRequests.length - LIST} more`);
  }
  if (!b.waiting.length && !b.openRequests.length) L.push('  nothing open');
  if (b.rules.length || b.rulesProposed) {
    L.push(`RULES  ${b.rulePrecedence}`);
    for (const r of b.rules) L.push(`  ${ruleLine(r)}`);
    if (b.rulesMore) L.push(`  + ${b.rulesMore} more (fleet-know rule list ${b.project})`);
    if (b.rulesProposed) L.push(`  ${b.rulesProposed} proposed, not in force (fleet-know rule list ${b.project})`);
  }
  L.push('DECISIONS');
  if (b.decisions.length) for (const d of b.decisions) L.push(`  • [${d.authority}] ${clip(d.text, 160)}${d.why ? ` — ${clip(d.why, 120)}` : ''}  [${d.inferred ? 'inferred' : d.source || 'stated'}${d.by ? `, ${d.by}` : ''}, ${day(d.t)}]${d.priv && b.mode !== 'private' ? ' [private]' : ''}  ${d.id}`);
  else L.push('  none recorded');
  if (b.decisionsMore) L.push(`  + ${b.decisionsMore} more still hold (fleet-know find <text> searches them)`);
  if (b.decisionsHidden) L.push(`  +${b.decisionsHidden} from workers: --all`);
  if (b.facts.length || b.observed.length) {
    L.push('FACTS');
    for (const x of b.facts) L.push(`  ${x.key} = ${clip(x.value, 160)}  [${x.authority}${x.by ? `, ${x.by}` : ''}, ${day(x.t)}]${x.priv && b.mode !== 'private' ? ' [private]' : ''}  ${x.id || ''}`.trimEnd());
    for (const x of b.observed) L.push(`  ${x.key} = ${clip(x.value, 160)}  [${OBSERVED}, ${day(x.t)}]${x.note ? ` — ${clip(x.note, 80)}` : ''}`);
  }
  const e = b.earlier;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (e.requests || e.prs || e.deploys || e.decisions || e.facts) L.push(`EARLIER  ${[e.requests && n(e.requests, 'closed request', 'closed requests'), e.prs && n(e.prs, 'merged/closed PR', 'merged/closed PRs'), e.deploys && n(e.deploys, 'deploy', 'deploys'), e.decisions && n(e.decisions, 'decision', 'decisions'), e.facts && n(e.facts, 'worker fact', 'worker facts')].filter(Boolean).join(', ')}${e.since ? ` since ${day(e.since)}` : ''} (fleet-know find <text> searches them)`);
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
  const files = nodesOfType(g, 'file').filter(([, n]) => (attr(n, 'path') === want || String(attr(n, 'path')).endsWith('/' + want) || (want.includes('/') && String(attr(n, 'path')).includes(want))));
  const rows = [];
  for (const [fid, fn] of files) {
    for (const e of edgesInto(g, 'touched', fid)) {
      const s = g.nodes[e.from];
      if (!s) continue;
      const P = attr(s, 'project'), pn = g.nodes[P];
      const mode = pn ? v.modeOf(pn) : 'include';
      if (mode === 'exclude') continue;
      for (const m of e.m.filter(x => x[0] <= at && x[2] <= known)) {
        const br = (edgesFrom(g, 'works-on', e.from).find(x => holds(x, m[0], known)) || {}).to;
        const prs = br ? edgesFrom(g, 'has-pr', br).map(x => g.nodes[x.to]).filter(n => n && !(Number.isFinite(at) && attr(n, 'opened') > at)).map(n => ({ number: attr(n, 'number'), state: val(n, 'state', at, known) || 'open', url: attr(n, 'url') })) : [];
        rows.push({ path: attr(fn, 'path'), t: m[0], slot: attr(s, 'slot'), session: e.from.slice(8), project: attr(pn, 'name'), machine: attr(pn, 'machine'), mode, branch: br ? attr(g.nodes[br], 'name') : attr(s, 'branch'), prs });
      }
    }
  }
  rows.sort((a, b) => b.t - a.t);
  return { query: want, rows };
}
export function renderTouched(r, now = Date.now()) {
  if (!r.rows.length) return `not recorded: nothing touching ${r.query}`;
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
  for (const [, n] of nodesOfType(v.g, 'project')) modes.set(`${attr(n, 'machine')}:${attr(n, 'profile')}:${attr(n, 'name')}`, v.modeOf(n));
  // The newest `limit`, out of however many match: a word that is in every line of a very large
  // log must not hold every line of it. The same event in two files counts once.
  const newest = (a, b) => b.e.t - a.e.t;
  const hits = [], seen = new Set();
  let total = 0;
  v.scanRaw((e) => {
    if (e.t > at) return;
    const mode = stricter(e.priv || 'include', modes.get(`${e.machine}:${e.profile}:${e.project}`) || 'include');
    if (mode === 'exclude') return;
    const hay = `${e.kind} ${e.project} ${Object.values(e.f || {}).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')} ${e.src && e.src.slot ? e.src.slot : ''}`.toLowerCase();
    if (!words.every(w => hay.includes(w)) || seen.has(e.id)) return;
    seen.add(e.id);
    total++;
    hits.push({ e, mode });
    if (hits.length > limit * 2 + 64) { hits.sort(newest); hits.length = limit; }
  });
  hits.sort(newest);
  return { query: q, total, rows: hits.slice(0, limit).map(({ e, mode }) => ({ t: e.t, project: e.project, machine: e.machine, profile: e.profile, kind: e.kind, slot: e.src && e.src.slot, id: e.id, mode, text: snippet(e, words) })) };
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
  if (!r.rows.length) return `not recorded: no event mentions "${r.query}"`;
  const L = r.rows.map(x => `${ago(x.t, now).padEnd(8)} ${`${x.project}@${x.machine}`.padEnd(22)} ${x.kind.padEnd(13)} ${x.slot ? `${x.slot}: ` : ''}${x.text}${x.mode === 'private' ? '  [private]' : ''}  ${x.id}`);
  if (r.total > r.rows.length) L.push(`+ ${r.total - r.rows.length} more (narrow it with another word)`);
  if (r.rows.some(x => x.mode === 'private')) L.push(PRIV_NOTE);
  return L.join('\n');
}

// ── what happened to a project, in order ─────────────────────────────────
// THE GRAPH WHERE THE GRAPH DECIDES, the raw log for what it does not hold. A fact a worker tried
// to overwrite, a detected deploy of a script that recorded its own and a merge two writers saw are
// each settled by the fold, and a walk over raw lines would print all of them. Commits are the one
// thing read from the log: a node per commit would put tens of thousands of them into a snapshot
// every read has to parse, for one verb that asks.
//   `known` reads the recorded-time axis off the marks, as a page does. One line per row, so a
// reader can grep it; the rows are the newest `limit`, and what that leaves out is counted.
export const HISTORY_SHOWN = 200;
export function history(v, q, { since = -Infinity, until = Infinity, limit = HISTORY_SHOWN } = {}) {
  const { hit, others } = findProject(v, q);
  if (!hit) return null;
  const g = v.g, P = hit.id, rows = [];
  const put = (t, kind, text, x = {}) => { if (t >= since && t <= until) rows.push({ t, kind, text, ...x }); };
  // A lead is the master by definition; a worker's name is the part that says which one.
  const tag = (by, slot) => `[${by}${slot && slot !== 'master' ? ` ${slot}` : ''}]`;
  const prsMerged = new Set();
  for (const [id, n] of nodesIn(g, 'pr', P)) {
    const at = attr(n, 'merged');
    if (!at) continue;
    prsMerged.add(attr(n, 'number'));
    const title = attr(n, 'title'), branch = attr(n, 'branch'), author = attr(n, 'author');
    put(at, 'pr', `PR #${attr(n, 'number')} merged${title ? `: ${clip(title, 110)}` : ''}${branch ? ` (${branch})` : ''}${author ? ` by ${author}` : ''}`, { number: attr(n, 'number') });
  }
  for (const [id, n] of nodesIn(g, 'deploy', P)) {
    const by = attr(n, 'slot') || attr(g.nodes[attr(n, 'session')], 'slot'), commit = attr(n, 'commit');
    put(attr(n, 'at'), 'deploy', `deploy ${deployLabel(attr(n, 'target'), attr(n, 'cmd'))}${commit ? ` at ${String(commit).slice(0, 8)}` : ''}${by ? ` (${by})` : ''}${attr(n, 'ok') === 'no' ? ' FAILED' : ''}`);
  }
  for (const [id, n] of nodesIn(g, 'decision', P)) {
    const by = attr(n, 'by');
    const stands = holds(g.edges[edgeKey('about', id, P)]);
    put(attrAt(n, 'text'), 'decision', `${tag(attr(n, 'authority') || 'worker', by)} decision: ${clip(attr(n, 'text'), 300)}${stands ? '' : ' (no longer holds)'}`, { id: shortId(id), authority: attr(n, 'authority') || 'worker', priv: attr(n, 'priv') === 'private' });
  }
  for (const [id, n] of nodesOfType(g, 'rule')) {
    const scope = attr(n, 'scope');
    if (attr(n, 'profile') !== hit.profile || (scopeKind(scope) === 'project' && scope !== `project:${hit.name}`)) continue;
    const priv = attr(n, 'priv') === 'private', by = attr(n, 'authority') || 'worker', text = clip(attr(n, 'text'), 300);
    const first = n.h && n.h.authority && n.h.authority[0];
    put(attrAt(n, 'text'), 'rule', `${tag(first ? first[0] : by, attr(n, 'by'))} ${attr(n, 'proposed') === 'yes' ? 'proposed a rule' : 'rule'} (${scope}): ${text}`, { id: shortId(id), authority: first ? first[0] : by, priv });
    if (attr(n, 'accepted')) put(attr(n, 'accepted'), 'rule', `${tag(by, attr(n, 'acceptedBy'))} accepted the rule (${scope}): ${text}`, { id: shortId(id), authority: by, priv });
    if (attr(n, 'closed')) put(attr(n, 'closed'), 'rule', `rule closed (${scope}): ${text}${attr(n, 'reason') ? ` — ${clip(attr(n, 'reason'), 100)}` : ''}`, { id: shortId(id), priv });
  }
  for (const e of edgesInto(g, 'fact-holds', P)) {
    const n = g.nodes[e.from];
    if (!n) continue;
    const key = attr(n, 'key'), priv = attr(n, 'priv') === 'private';
    let was;
    for (const x of [...((n.h && n.h.value) || [])].sort((a, b) => a[1] - b[1])) {
      put(x[1], 'fact', `${tag(val(n, 'authority', x[1]) || 'worker')} ${key} = ${clip(x[0], 160)}${was !== undefined ? ` (was ${clip(was, 60)})` : ''}`, { key, priv });
      was = x[0];
    }
    for (const m of e.m) if (m[1] === 'close') put(m[0], 'fact', `${key} no longer holds`, { key, priv });
  }
  for (const [id, n] of nodesIn(g, 'branch', P)) {
    const started = attr(n, 'spawned'), ended = attr(n, 'retired'), worker = attr(n, 'worker') || attr(n, 'name');
    if (!started) continue;
    const task = attr(n, 'understood') || taskLine(attr(n, 'task'));
    put(started, 'worker', `worker ${worker} started on ${attr(n, 'name')}${task ? `: ${clip(task, 110)}` : ''}`, { worker });
    if (ended) put(ended, 'worker', `worker ${worker} finished (${attr(n, 'name')})`, { worker });
  }
  // A commit that names a PR already listed says the same thing twice.
  const shas = new Set();
  v.scanRaw((e) => {
    if (e.kind !== 'commit' || e.project !== hit.name || e.machine !== hit.machine || e.profile !== hit.profile) return;
    const f = e.f || {};
    if (shas.has(f.sha) || (f.pr && prsMerged.has(f.pr))) return;
    shas.add(f.sha);
    put(e.t, 'commit', `commit ${String(f.sha || '').slice(0, 8)} ${clip(f.subject, 140)}`, { sha: f.sha, priv: e.priv === 'private' });
  });
  rows.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const earlier = Math.max(0, rows.length - limit);
  return {
    project: hit.name, machine: hit.machine, profile: hit.profile, mode: hit.mode, others: others.map(o => `${o.name}@${o.machine}/${o.profile}`),
    since: Number.isFinite(since) ? since : null, until: Number.isFinite(until) ? until : null,
    earlier, earliest: earlier ? rows[0].t : null, before: earlier ? rows[earlier - 1].t : null,
    rows: rows.slice(earlier), peers: v.peers,
  };
}
const isoOf = (t) => new Date(t).toISOString();
export function renderHistory(r) {
  if (!r) return '';
  const L = [`${r.project}${r.machine ? `@${r.machine}` : ''} · ${r.profile} profile · history, newest last, times in UTC${r.mode === 'private' ? '  [private]' : ''}`];
  if (r.mode === 'private' || r.rows.some(x => x.priv)) L.push(PRIV_NOTE);
  if (r.others.length) L.push(`(also: ${r.others.join(', ')} — name one with @machine or /profile)`);
  // The next page back, ready to paste: keeping the newest means a wider --since alone would only
  // ever print the same rows again.
  if (r.earlier) L.push(`+${r.earlier} earlier: --since ${day(r.earliest)} --until ${isoOf(r.before)}`);
  if (!r.rows.length) L.push(r.since !== null || r.until !== null ? 'nothing recorded in that range' : 'nothing recorded yet');
  let shown = '';
  for (const x of r.rows) {
    const d = day(x.t);
    if (d !== shown) { L.push(d); shown = d; }
    L.push(`  ${isoOf(x.t).slice(11, 16)}  ${x.text}${x.priv && r.mode !== 'private' ? ' [private]' : ''}`);
  }
  for (const p of (r.peers || []).filter(p => p.stale)) L.push(`(${p.label || p.key}: stale — last fetched ${p.fetched_at ? ago(p.fetched_at) : 'never'}${p.why ? `, ${p.why}` : ''})`);
  return L.join('\n');
}

// ── what was asked of the memory ──────────────────────────────────────────
// A zero-hit question is the most useful line the memory can log: somebody needed it and it was
// not there. Written straight to the log with no project to resolve and no peer to ask, so it
// costs a read one short append, and it never fails the read that made it.
export function noteRead(verb, query, hits, { via = 'cli', env = process.env } = {}) {
  try {
    const fleetDir = fleetDirOf(env), sock = env.CLAUDE_FLEET_SOCK || '';
    const slot = env.CLAUDE_FLEET_SLOT || '';
    return record('know.read', { verb, query, hits: Number(hits) || 0 }, { fleetDir, sock, project: NO_PROJECT, src: { via, ...(slot ? { slot } : {}) } }, env);
  } catch { return null; }
}
// Zero hits first, then the most asked. The same question asked twice is one row with a count.
export function readsReport({ since = 0, env = process.env } = {}) {
  const rows = new Map();
  for (const d of allFleetDirs(env)) {
    scanLog(path.join(d, LOG), 0, (e) => {
      if (e.kind !== 'know.read' || e.t < since) return;
      const f = e.f || {}, k = `${f.verb}\0${f.query || ''}`;
      const r = rows.get(k) || { verb: f.verb, query: f.query || '', count: 0, zero: 0, hits: 0, last: 0, via: new Set(), who: new Set() };
      r.count++;
      if (!f.hits) r.zero++;
      if (e.t >= r.last) { r.last = e.t; r.hits = f.hits || 0; }
      r.via.add((e.src && e.src.via) || '?');
      if (e.src && e.src.slot) r.who.add(`${(e.src.sock || '').replace(/^cf-/, '')}/${e.src.slot}`);
      rows.set(k, r);
    });
  }
  const plain = [...rows.values()].map(r => ({ ...r, via: [...r.via].sort(), who: [...r.who].sort() }));
  const byUse = (a, b) => b.count - a.count || b.last - a.last;
  return { since: since || null, missing: plain.filter(r => !r.hits).sort(byUse), answered: plain.filter(r => r.hits).sort(byUse) };
}
export function renderReads(r, now = Date.now()) {
  const L = [];
  const one = (x) => `  ${String(x.count).padStart(3)}×  ${x.verb.padEnd(9)} ${x.query ? `"${clip(x.query, 80)}"` : '-'}  ${x.hits ? `${x.hits} hit${x.hits === 1 ? '' : 's'}, ` : ''}last ${ago(x.last, now)}${x.who.length ? `  (${x.who.slice(0, 3).join(', ')})` : ''}`;
  L.push(`ZERO HITS — what the memory is missing${r.since ? ` (since ${day(r.since)})` : ''}`);
  if (r.missing.length) for (const x of r.missing.slice(0, 40)) L.push(one(x));
  else L.push('  none');
  L.push('ANSWERED');
  if (r.answered.length) for (const x of r.answered.slice(0, 40)) L.push(one(x));
  else L.push('  none');
  return L.join('\n');
}

export function overview(v, { now = Date.now() } = {}) {
  const ps = projectsIn(v);
  const L = ps.length ? ps.map(p => `${p.name.padEnd(16)} ${`${p.machine}/${p.profile}`.padEnd(20)} last seen ${ago(p.last, now)}${p.mode === 'private' ? '  [private]' : ''}`) : ['nothing recorded yet — events land as sessions run (docs/MEMORY.md)'];
  for (const p of v.peers) L.push(`peer ${p.label || p.key}: ${p.events} events${p.stale ? ` — stale (${p.fetched_at ? `last fetched ${ago(p.fetched_at, now)}` : 'never fetched'}${p.why ? `, ${p.why}` : ''})` : ''}`);
  if (ps.some(p => p.mode === 'private')) L.push(PRIV_NOTE);
  return L.join('\n');
}
