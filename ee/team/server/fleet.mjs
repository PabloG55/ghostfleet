// server/fleet.mjs — the REAL fleet, read and driven through the installed ghostfleet.
//
// Nothing here decides what a session is doing. Reads are the same three things
// bin/fleet-serve.mjs proxies (fleet-grid.mjs --json, fleet-read --json through fleet_read,
// tmux capture-pane), and every action goes through mcp/fleet-dispatch.mjs by its MCP tool
// name — the same planner and argument checks the MCP server and the phone use. A second
// implementation of "what is this card" would drift from the grid's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GF_HOME } from './paths.mjs';
import * as attachments from './attach.mjs';
import { t as tr } from '../shared/i18n/index.js';

const need = (rel) => {
  const p = path.join(GF_HOME, rel);
  if (!fs.existsSync(p)) throw new Error(tr('fleet.noGf', { home: GF_HOME, rel }));
  return pathToFileURL(p).href;
};
const dispatch = await import(need('mcp/fleet-dispatch.mjs'));
const perm = await import(need('lib/permission-dialog.mjs'));
const GRID = path.join(GF_HOME, 'bin', 'fleet-grid.mjs');
const TMUX_CONF = path.join(GF_HOME, 'tmux', 'cf.tmux.conf');

const NINE = new Set(['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted']);

function target(name) {
  const t = dispatch.projects().find(p => p.name === name);
  if (!t) throw Object.assign(new Error(tr('err.noProject', { project: name })), { status: 404 });
  return t;
}

const gridEnv = (t) => ({
  ...process.env, TMUX: '',
  CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_FLEET_DIR: path.join(t.cfg, 'fleet'),
  CLAUDE_FLEET_PROFILE: t.profile, CLAUDE_FLEET_SCOPE: t.name,
  CLAUDE_FLEET_ROOT: t.path, CLAUDE_FLEET_SOCK: t.sock,
  CLAUDE_FLEET_AGENT: t.agent || 'claude',
});

const toText = (out) => (typeof out === 'string' ? out : String(out?.text ?? ''));

// Several browsers poll the same thing; one child process answers all of them.
function cached(ms, fn) {
  const memo = new Map();
  return (key, ...args) => {
    const hit = memo.get(key);
    if (hit && hit.until > Date.now()) return hit.p;
    const p = fn(...args).catch((e) => { memo.delete(key); throw e; });
    memo.set(key, { p, until: Date.now() + ms });
    return p;
  };
}

const digest = cached(4000, async () => {
  const out = await dispatch.callToolAsync('fleet_digest', { json: true, peek: true }, { timeout: 30000 });
  return JSON.parse(toText(out));
});

export async function projects() {
  const d = await digest('all');
  return (d.projects || []).map(p => {
    const counts = { need_you: 0, working: 0, ready: 0, parked: 0, lost: 0, total: 0 };
    for (const s of p.sessions || []) {
      counts.total++;
      if (s.status === 'need-you') counts.need_you++;
      else if (s.status in counts) counts[s.status]++;
    }
    return { name: p.name, path: p.path, profile: p.profile, counts,
             sessions: (p.sessions || []).map(s => ({ name: s.name, status: s.status, ts: s.ts, lead: !!s.lead })) };
  });
}

const gridRun = cached(1500, (t) => new Promise((resolve, reject) => {
  execFile(process.execPath, [GRID, t.sock, TMUX_CONF, '--json'],
    { encoding: 'utf8', env: gridEnv(t), cwd: t.path, timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`fleet-grid --json falló: ${(stderr || err.message).trim().split('\n')[0]}`));
      try {
        const j = JSON.parse(stdout);
        for (const c of j.cards || []) if (!NINE.has(c.status)) c.status = 'unknown';
        resolve(j);
      } catch { reject(new Error(`fleet-grid --json no devolvió JSON: ${String(stdout).slice(0, 200)}`)); }
    });
}));

export const grid = (project) => { const t = target(project); return gridRun(t.name, t); };
let fresh = 0;
const gridNow = (t) => gridRun(`${t.name}#${++fresh}`, t);

// The lead has to be there before it can be talked to. Whatever state it is in, this gets it
// to "running" the way the fleet itself would: start it (fleet-project add --start, which
// only boots a master that is not already up), reopen it after a reboot, wake it from
// hibernation, un-park it. Then wait until its card says it is up.
export async function ensureLead(project) {
  const t = target(project);
  const lead = (g) => (g.cards || []).find(c => c.lead);
  const m = lead(await gridNow(t));
  let did = null, out = null;
  if (!m) { did = 'start'; out = await act('fleet_project_add', { path: t.path, name: t.name, profile: t.profile, start: true }); }
  else if (m.lost) { did = 'reopen'; out = await act('fleet_reopen', { project: t.name, session: m.name }); }
  else if (m.asleep) { did = 'wake'; out = await act('fleet_wake', { project: t.name, session: m.name }); }
  else if (m.status === 'parked') { did = 'resume'; out = await act('fleet_resume', { project: t.name, session: m.name }); }
  if (!did) return { ok: true, started: null, lead: m.name };
  if (out && !out.ok) return { ok: false, started: did, text: out.text };
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const n = lead(await gridNow(t));
    if (n && !n.lost && !n.asleep && !['starting', 'unknown'].includes(n.status)) return { ok: true, started: did, lead: n.name };
  }
  return { ok: false, started: did, text: tr('fleet.leadSlow') };
}

export async function session(project, name, before) {
  const t = target(project);
  const out = await dispatch.callToolAsync('fleet_read',
    { project: t.name, session: name, json: true, limit: 30, ...(before ? { before: String(before) } : {}) },
    { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const text = toText(out);
  try { return JSON.parse(text); } catch { throw new Error(`fleet-read --json: ${text.trim().slice(0, 200)}`); }
}

export async function queue(project, name) {
  const t = target(project);
  const out = await dispatch.callToolAsync('fleet_queue', { project: t.name, session: name }, { timeout: 10000 });
  const q = [];
  for (const line of toText(out).split('\n')) {
    const [at, b64, kind] = line.split('\t');
    if (!b64 || !/^\d+$/.test(at) || kind === 'nudge') continue;
    q.push({ at: Number(at), text: Buffer.from(b64, 'base64').toString('utf8') });
  }
  return q;
}

// capture-pane READS. It never attaches and never resizes: either would change the pane the
// desk is looking at and can blind the status detectors that read it.
export function pane(project, name) {
  const t = target(project);
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', t.sock, 'capture-pane', '-p', '-e', '-t', name],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`tmux capture-pane: ${(stderr || err.message).trim().split('\n')[0]}`));
        let prompt = null;
        try { prompt = perm.promptSummary(stdout); } catch {}
        resolve({ pane: String(stdout), prompt });
      });
  });
}

// Writes run one at a time: two spawns racing for the same free worktree is a bug that
// costs a checkout to discover.
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn));

export function act(tool, args) {
  return serialize(async () => {
    // human:true — the request comes from a person who read the dialog in the browser,
    // which is the one thing fleet-answer lets approve a permission prompt.
    const out = await dispatch.callToolAsync(tool, args,
      { timeout: 15 * 60 * 1000, human: true, status: tool === 'fleet_send' });
    const text = toText(out);
    const undelivered = tool === 'fleet_send' && typeof out === 'object' && !out.isError && out.code !== 0;
    const refused = undelivered || (typeof out === 'object' && out.isError === true);
    const changed = tool === 'fleet_answer' && /^fleet-answer: the prompt changed/m.test(text);
    const queued = !refused && tool === 'fleet_send'
      ? (/queued #\d+ behind a question/.test(text) ? 'question' : /queued #\d+/.test(text) ? 'turn' : undefined)
      : undefined;
    return { ok: !refused && !changed, text, changed, queued };
  });
}

// ── labels and schedules: the grid's own markers, written the way the grid writes them ──
// fleet-grid.mjs owns these formats (setLabel / schedule / cancelSchedule) and no command
// does yet, which is why fleet-serve refuses them. This mirrors those three functions
// byte for byte; the right home is a ghostfleet command + MCP tool (see README).
const fleetDir = (t) => path.join(t.cfg, 'fleet');
// The session is part of a file name here, and a `/` in it would walk out of the fleet dir.
// index.mjs already refuses such names; this is the line that writes the file, so it checks too.
const marker = (t, s, ext) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._~-]{0,47}$/.test(String(s))) throw Object.assign(new Error(tr('err.badSession', { session: String(s).slice(0, 60) })), { status: 400 });
  return path.join(fleetDir(t), `${t.sock}.${s}.${ext}`);
};
const labelFile = (t, s) => marker(t, s, 'label');
const schedFile = (t, s) => marker(t, s, 'sched');
const readSched = (t, s) => { try { return JSON.parse(fs.readFileSync(schedFile(t, s), 'utf8')); } catch { return null; } };

export function setLabel(project, session, text) {
  const t = target(project);
  const f = labelFile(t, session);                        // first: it refuses a bad name
  const v = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  fs.mkdirSync(fleetDir(t), { recursive: true });
  if (v) fs.writeFileSync(f, v + '\n');
  else { try { fs.unlinkSync(f); } catch {} }
  return { ok: true, text: v ? tr('fleet.label', { label: v }) : tr('fleet.labelOff') };
}

export function cancelSchedule(project, session) {
  const t = target(project);
  const f = schedFile(t, session);                        // first: it refuses a bad name
  const m = readSched(t, session);
  if (m && m.pid) { try { process.kill(-m.pid, 'SIGTERM'); } catch {} try { process.kill(m.pid, 'SIGTERM'); } catch {} }
  try { fs.unlinkSync(f); } catch {}
  return { ok: true, text: m ? tr('fleet.unsched') : tr('fleet.noSched') };
}

export function schedule(project, session, at, msg) {
  const t = target(project);
  const f = schedFile(t, session);                        // before anything is spawned
  cancelSchedule(project, session);                       // replace, never stack
  const bin = path.join(GF_HOME, 'bin', 'fleet-schedule');
  const child = spawn(bin, [t.sock, session, String(at), msg], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, TMUX: '', CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_FLEET_DIR: fleetDir(t) },
  });
  child.unref();
  fs.mkdirSync(fleetDir(t), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at, msg, pid: child.pid }));
  return { ok: true, text: tr('fleet.sched', { when: { at } }) };
}

export function attach(project, session, name, buf) {
  const t = target(project);
  marker(t, session, 'attach');                           // first: it refuses a bad name
  return attachments.save(path.join(fleetDir(t), 'attach', `${t.sock}.${session}`), name, buf);
}

// ── usage: how much of each Claude account's 5-hour and weekly limit is gone ────────────
// Claude Code reports both to the status line, and ghostfleet's status hook keeps the last
// reading of every session in <cfg>/fleet/<session_id>.json (usage.limits.five_hour /
// seven_day: pct, resets). One config dir per profile — but not one account forever: a
// profile that was logged in to another account last week still has that account's files.
// lib/accounts.mjs untangles that with its own state (off here); without it, the NEWEST
// reading is the account in use now, and a session that is running keeps it fresh.
const liveWin = (w, at, now) => w && typeof w.pct === 'number' && (w.resets ? w.resets > now : (at || 0) > now - 600);
const current = (a, b) => (!a || !b) ? (a || b || null) : (b.at >= a.at ? b : a);
function readUsage(cfg, profile, now) {
  const dir = path.join(cfg, 'fleet');
  const out = { profile: profile === 'default' ? 'work' : profile, five_hour: null, seven_day: null, at: 0 };
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.') || n === 'accounts.json') continue;
    let u; try { u = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).usage; } catch { continue; }
    if (!u?.limits || !u.at) continue;
    for (const k of ['five_hour', 'seven_day']) {
      const w = u.limits[k];
      if (liveWin(w, u.at, now)) out[k] = current(out[k], { pct: Math.round(w.pct), resets: Number(w.resets) || 0, at: u.at });
    }
    out.at = Math.max(out.at, u.at);
  }
  return out;
}
let usageCache = { at: 0, v: null };
export function usage() {
  const now = Math.floor(Date.now() / 1000);
  if (usageCache.v && now - usageCache.at < 10) return usageCache.v;
  const byCfg = new Map();
  for (const t of dispatch.projects()) if (!byCfg.has(t.cfg)) byCfg.set(t.cfg, t.profile);
  const profiles = [...byCfg].map(([cfg, profile]) => readUsage(cfg, profile, now)).filter(p => p.five_hour || p.seven_day);
  usageCache = { at: now, v: { ok: true, at: now, profiles } };
  return usageCache.v;
}

export const mode = 'real';

// ── transcripts: every conversation each session has had, for the usage ledger ──────────
// The status hook writes one record per Claude session id into <cfg>/fleet/<id>.json, with the
// fleet socket, the slot (session name) and the transcript path. Scoped by socket like every
// read here: each project has a `master`, and a record from another fleet is not this one's.
// Old records stay, so a session reopened under a new id keeps its earlier transcripts counted.
export function transcripts() {
  const out = new Map();
  for (const t of dispatch.projects()) {
    const dir = path.join(t.cfg, 'fleet');
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]+\.json$/i.test(n)) continue;
      let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      if (r.sock !== t.sock || !r.slot || !r.transcript || out.has(r.transcript)) continue;
      out.set(r.transcript, { project: t.name, session: r.slot, transcript: r.transcript });
    }
  }
  return [...out.values()];
}
