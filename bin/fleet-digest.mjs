#!/usr/bin/env node
// fleet-digest — one rollup across every fleet on every profile, from files.
//
//     fleet-digest [--json] [--peek] [--since EPOCH]
//
// WHY THIS EXISTS. A lead can see its own fleet and nothing else (bin/fleet-list is one
// socket), so "how is everything doing" meant attaching to each project in turn — and a
// master of masters that asked with fleet-list would spend one Claude turn per project to
// learn that nothing had happened. That is the polling the inbox was built to remove, one
// level up. This reads what the hooks already wrote — the status files, the inboxes and
// the asleep/parked/exited markers, under every profile's config dir — and prints one
// summary. No agent is asked anything; no Claude token is spent; the whole cost is a
// directory listing per profile and a `tmux list-sessions` per project.
//
// WHAT IT CLASSIFIES, AND FROM WHAT. A session's state is decided in this order, most
// definite first, because each earlier source is one the later ones cannot see:
//
//   asleep    the .asleep marker: no process at all, and no status file left to read
//   exited    the .exited marker: agent-here is holding the pane so the card stays
//   parked    the .parked marker: the hook's last status is stale BY DESIGN, since an
//             Escape interrupt fires no Stop
//   <status>  the newest status file for (sock, slot): need-you, working, ready, idle
//   unknown   a live session with no record — an agent run by hand, or one whose
//             record is under a different profile's dir
//
// NEWEST PER (sock, slot) is the rule bin/fleet-serve.mjs's push watcher learned by
// measuring a phone that buzzed every thirty seconds for a worker doing nothing: two
// status files for one session, the stale one shadowing the live one. lib/fleet-scan.mjs
// holds the one reader both share.
//
// A SESSION THAT IS GONE IS NOT REPORTED. A status file outlives its session when a
// worker is killed without a SessionEnd, and on a real fleet those outnumber the live
// ones. So liveness is asked of tmux, per socket, and a record with no live session and
// no marker is dropped. Where tmux cannot be asked at all the files are trusted instead,
// and the digest SAYS SO in its own output rather than silently reporting everything as
// gone — the failure that looks like an empty fleet.
//
// "SINCE LAST LOOK" IS A STAMP, AND ONLY A LOOK ADVANCES IT. A plain run is somebody (or
// Jarvis) reading the digest and moves ~/.config/ghostfleet/digest.last; --peek is the
// phone polling it every few seconds, and must not — the same reason /api/inbox reads
// with --all: a glance from a pocket must not consume what the reader has not seen.
//
// OPEN PRs are included only when they are already known: fleet-merged --cached is pure
// file I/O over the cache the grid keeps warm, and never a network call. A digest that
// blocked on gh would be a digest that hangs on a train.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects, checkoutOf, BIN, self } from '../mcp/fleet-dispatch.mjs';
import { fleetDirs, scanStatus, markersFor, inboxSince } from '../lib/fleet-scan.mjs';

const HOME = os.homedir();
// ONE STAMP PER READER. "Since last look" is a question about a particular looker: a lead
// that runs the digest must not make Jarvis's next one say "nothing happened". The reader is
// the fleet session calling (from the live $TMUX), else the terminal's plain digest.last.
const READER = (() => { try { const me = self(); return me ? `.${me.sock}.${me.sess}`.replace(/[^A-Za-z0-9._-]/g, '_') : ''; } catch { return ''; } })();
const STAMP = path.join(HOME, '.config', 'ghostfleet', `digest.last${READER}`);
const US = '\x1f';
const now = () => Math.floor(Date.now() / 1000);

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const PEEK = argv.includes('--peek');
const sinceArg = (() => { const i = argv.indexOf('--since'); return i >= 0 ? Number(argv[i + 1]) : null; })();
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('fleet-digest [--json] [--peek] [--since EPOCH] — every fleet, every profile, from files');
  process.exit(0);
}

function readStamp() {
  try { const n = Number(fs.readFileSync(STAMP, 'utf8').trim()); return Number.isFinite(n) ? n : 0; } catch { return 0; }
}
function writeStamp(t) {
  try { fs.mkdirSync(path.dirname(STAMP), { recursive: true }); fs.writeFileSync(STAMP, `${t}\n`); } catch {}
}

// Liveness, per socket. `null` means "could not ask" (no tmux on this machine), which
// the caller has to treat differently from "asked, and nobody is there".
function haveTmux() {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
}
function liveSessions(sock) {
  try {
    return new Set(execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .split('\n').filter(n => n && !/^_(?:term|edit)-/.test(n)));
  } catch { return new Set(); }        // no server on that socket: nothing live
}

// Open PRs the cache already knows. fleet-merged --prs --cached prints
// branch<US>number<US>state and never reaches gh.
function openPrs(t) {
  let out = '';
  try {
    out = execFileSync(path.join(BIN, 'fleet-merged'), ['--prs', '--cached', checkoutOf(t)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch { return []; }
  return out.split('\n').filter(Boolean).map(l => {
    const [branch, number, state] = l.split(US);
    return { branch, number: Number(number) || null, state: state || '' };
  }).filter(p => p.branch && p.state === 'OPEN');
}

const KINDS = ['need-you', 'working', 'ready', 'idle', 'parked', 'asleep', 'exited', 'unknown'];

export function buildDigest({ since, tmuxOk }) {
  const all = projects();
  const rows = scanStatus(fleetDirs(all));
  const bySock = new Map();
  for (const r of rows) {
    if (!bySock.has(r.sock)) bySock.set(r.sock, new Map());
    bySock.get(r.sock).set(r.slot, r);
  }
  const out = [];
  for (const t of all) {
    const dir = path.join(t.cfg, 'fleet');
    const marks = markersFor(dir, t.sock);
    const live = tmuxOk ? liveSessions(t.sock) : null;
    const recs = bySock.get(t.sock) || new Map();
    // Every name that is either live, marked, or (with no way to ask) recorded.
    const names = new Set();
    if (live) for (const n of live) names.add(n);
    for (const [slot, kinds] of marks) if (kinds.has('asleep') || (live ? live.has(slot) : true)) names.add(slot);
    if (!live) for (const slot of recs.keys()) names.add(slot);
    const sessions = [];
    for (const name of [...names].sort((a, b) => (a === 'master' ? -1 : b === 'master' ? 1 : a.localeCompare(b)))) {
      const k = marks.get(name) || new Set();
      const rec = recs.get(name);
      let status;
      if (k.has('asleep') && !(live && live.has(name))) status = 'asleep';
      else if (k.has('exited')) status = 'exited';
      else if (k.has('parked')) status = 'parked';
      else status = rec && KINDS.includes(rec.status) ? rec.status : (rec && rec.status ? rec.status : 'unknown');
      sessions.push({ name, status, ts: rec ? rec.ts : 0, lead: name === 'master' });
    }
    const events = inboxSince(dir, t.sock, since);
    // The detail on a need-you is the note the hook wrote to the inbox, newest first.
    for (const s of sessions) {
      if (s.status !== 'need-you') continue;
      const last = [...inboxSince(dir, t.sock, 0)].reverse().find(e => e.event === 'need-you' && e.session === s.name);
      if (last) s.detail = last.detail;
    }
    out.push({ name: t.name, profile: t.profile, sock: t.sock, path: t.path, sessions, events, prs: openPrs(t) });
  }
  const totals = {};
  for (const k of KINDS) totals[k.replace('-', '_')] = 0;
  for (const p of out) for (const s of p.sessions) totals[s.status.replace('-', '_')] = (totals[s.status.replace('-', '_')] || 0) + 1;
  totals.since = out.reduce((n, p) => n + p.events.length, 0);
  totals.done_since = out.reduce((n, p) => n + p.events.filter(e => e.event === 'done').length, 0);
  totals.answered_since = out.reduce((n, p) => n + p.events.filter(e => e.event === 'answered').length, 0);
  totals.open_prs = out.reduce((n, p) => n + p.prs.length, 0);
  return { at: now(), since, liveness: tmuxOk ? 'tmux' : 'files (tmux not found — liveness was not checked)', projects: out, totals };
}

const hhmm = (t) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ago = (t) => {
  if (!t) return '';
  const s = now() - t;
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const pad = (s, n) => String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length);

function renderText(d) {
  const L = [];
  const profs = [...new Set(d.projects.map(p => p.profile))];
  L.push(`digest — ${d.projects.length} project${d.projects.length === 1 ? '' : 's'} on ${profs.length} profile${profs.length === 1 ? '' : 's'} (${profs.join(', ')}), since ${d.since ? `${hhmm(d.since)} (${ago(d.since)} ago)` : 'the last day'}`);
  if (!/^tmux$/.test(d.liveness)) L.push(`  liveness: ${d.liveness}`);
  const rowsOf = (status) => d.projects.flatMap(p => p.sessions.filter(s => s.status === status).map(s => ({ p, s })));
  const line = ({ p, s }) => `  ${pad(`${p.name}/${s.name}`, 30)} ${pad(s.status, 9)} ${s.detail ? s.detail : ''}${s.ts ? `  (${ago(s.ts)})` : ''}`.replace(/\s+$/, '');
  const need = rowsOf('need-you');
  L.push('');
  L.push(`NEED YOU (${need.length})${need.length ? '' : ' — nobody is blocked on you'}`);
  for (const r of need) L.push(line(r));
  for (const st of ['working', 'ready', 'idle', 'parked', 'asleep', 'exited', 'unknown']) {
    const rs = rowsOf(st);
    if (!rs.length) continue;
    L.push('');
    L.push(`${st.toUpperCase()} (${rs.length})`);
    for (const r of rs) L.push(line(r));
  }
  const ev = d.projects.flatMap(p => p.events.map(e => ({ p, e }))).sort((a, b) => a.e.ts - b.e.ts);
  L.push('');
  L.push(`SINCE LAST LOOK (${ev.length})${ev.length ? '' : ' — nothing happened'}`);
  for (const { p, e } of ev.slice(-60)) {
    // A relayed answer already names its sender as <project>/<session>; a worker row is
    // a bare name, so the project is put in front of it. Never both.
    const who = e.session.includes('/') ? e.session : `${p.name}/${e.session}`;
    L.push(`  ${hhmm(e.ts)}  ${pad(who, 30)} ${pad(e.event, 9)} ${e.detail}`.replace(/\s+$/, ''));
  }
  if (ev.length > 60) L.push(`  … and ${ev.length - 60} earlier`);
  const prs = d.projects.flatMap(p => p.prs.map(pr => `${p.name} #${pr.number} ${pr.branch}`));
  if (prs.length) { L.push(''); L.push(`OPEN PRs (${prs.length}): ${prs.join(' · ')}`); }
  const quiet = d.projects.filter(p => !p.sessions.length).map(p => p.name);
  if (quiet.length) { L.push(''); L.push(`quiet (nothing live): ${quiet.join(', ')}`); }
  return L.join('\n') + '\n';
}

function main() {
  const tmuxOk = haveTmux();
  const stamp = readStamp();
  const since = sinceArg !== null && Number.isFinite(sinceArg) ? sinceArg : (stamp || now() - 86400);
  const d = buildDigest({ since, tmuxOk });
  if (!PEEK) writeStamp(d.at);
  process.stdout.write(JSON_OUT ? JSON.stringify(d) + '\n' : renderText(d));
}

let direct = false;
try { direct = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) main();
