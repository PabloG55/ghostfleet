// lib/fleet-scan.mjs — the fleet's state, read off disk, for every profile at once.
//
// TWO READERS OF THE SAME FILES USED TO LIVE IN TWO PLACES. bin/fleet-serve.mjs's push
// watcher scanned every profile's fleet dir for the status files hooks/fleet-event.sh
// writes, and the digest needed exactly that scan again. A second copy would drift on the
// one rule that matters — newest record per (sock, slot) — which the push watcher learned
// by measuring a phone that buzzed every thirty seconds for a worker that was doing
// nothing (two status files for one session, the stale one shadowing the live one on
// alternate scans). One reader, so the digest and the bell cannot disagree about what
// the fleet is.
//
// FOUR FIELDS, AND ONLY FOUR, are read out of a status file: sock, slot, status, ts. A
// status file also carries a cwd, a transcript path and (on need-you) the note the agent
// showed, and NONE of that reaches a push payload — fleet-serve builds its payload from
// literal keys, but the cheapest way to keep a field out of a payload is for the scan
// never to have carried it. The digest gets its detail from the inbox rows instead, which
// are the hook's own summary and are already bounded.
//
// Node builtins only: ghostfleet is a zero-dependency package and this is on the import
// path of two bins.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { modState } from './mod-status.mjs';

// The fleet dir of every registered project, once each. Several projects share a
// profile, and a profile is one directory.
export function fleetDirs(projects) {
  const seen = new Map();
  for (const t of projects) seen.set(path.join(t.cfg, 'fleet'), true);
  return [...seen.keys()];
}

// The hook's status files, newest per (sock, slot). A record with no sock or no slot is
// not a fleet session (an agent run by hand outside any fleet) and is skipped; one that
// cannot be parsed on this tick is skipped too, because the hook writes atomically and a
// torn read is a writer mid-rename, not a session.
export function scanStatus(dirs) {
  const newest = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || !j.sock || !j.slot) continue;
      // The mod's own word when it is still being written (lib/mod-status.mjs), the hook's
      // status otherwise: still one field out, so the push payload and the digest learn
      // the exact state without learning anything else about the record.
      const row = { sock: String(j.sock), slot: String(j.slot), status: String(modState(j) || j.status || ''), ts: Number(j.ts) || 0 };
      const key = `${row.sock}/${row.slot}`;
      const prev = newest.get(key);
      if (!prev || row.ts > prev.ts) newest.set(key, row);
    }
  }
  return [...newest.values()];
}

// Each fleet's MASTER, newest record per socket, as { dir, sock, sessionId, ts }: what a
// reader of the master's ledger (<dir>/<sessionId>.ledger, mods/ghostfleet/hooks/ledger.js)
// needs to find the file. A fifth field, `session_id`, and only here: scanStatus above keeps
// to its four because its rows feed a push payload, and this one's never reach one. Newest
// per socket for the same reason scanStatus keeps the newest per slot: a master that was
// restarted leaves its old record beside the new one, and the old session's ledger is not
// what the fleet is holding now.
export function masterRecords(dirs) {
  const newest = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || j.slot !== 'master' || !j.sock || !j.session_id) continue;
      // The id names a file: one that could step out of the directory names nothing.
      const sessionId = String(j.session_id);
      if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith('.')) continue;
      const row = { dir, sock: String(j.sock), sessionId, ts: Number(j.ts) || 0 };
      const prev = newest.get(row.sock);
      if (!prev || row.ts > prev.ts) newest.set(row.sock, row);
    }
  }
  return [...newest.values()];
}

// The per-session markers beside the status files: <sock>.<slot>.parked / .asleep /
// .exited. Each answers a question the status word cannot — parked is a session whose
// last hook status is stale by design (Escape fires no Stop), asleep is one with no
// process at all, exited is one whose pane is held open by agent-here so the card stays.
// Returned as a map slot -> Set of kinds, for one socket.
export function markersFor(dir, sock) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const pre = `${sock}.`;
  for (const n of names) {
    if (!n.startsWith(pre)) continue;
    const m = /\.(parked|asleep|exited)$/.exec(n);
    if (!m) continue;
    const slot = n.slice(pre.length, -m[0].length);
    if (!slot) continue;
    if (!out.has(slot)) out.set(slot, new Set());
    out.get(slot).add(m[1]);
  }
  return out;
}

// Nested leads: <sock>.<child>.parent names the sub-lead a child reports to (written by
// bin/fleet-spawn). Returned as a map child -> parent, for one socket; whether that parent
// is still on the fleet is the caller's question, since only it knows who is live.
export function parentsFor(dir, sock) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const pre = `${sock}.`;
  for (const n of names) {
    if (!n.startsWith(pre) || !n.endsWith('.parent')) continue;
    const child = n.slice(pre.length, -'.parent'.length);
    if (!child) continue;
    let p = '';
    try { p = fs.readFileSync(path.join(dir, n), 'utf8').split('\n')[0].trim(); } catch {}
    if (p && p !== child) out.set(child, p);
  }
  return out;
}

// The inbox rows of one fleet newer than `since`: <ts>\t<session>\t<event>\t<detail>.
// With `owner`, a SUB-LEAD's inbox instead (<sock>.<owner>.inbox), where its children's
// rows go rather than into the fleet's.
// A tab-separated file read by splitting on the tab, never with a whitespace IFS — the
// detail is optional and a collapsed empty column would shift it into the event.
export function inboxSince(dir, sock, since, owner = '') {
  let txt = '';
  try { txt = fs.readFileSync(path.join(dir, owner ? `${sock}.${owner}.inbox` : `${sock}.inbox`), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const [ts, session, event, detail = ''] = line.split('\t');
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= since) continue;
    if (!session || !event) continue;
    out.push({ ts: t, session, event, detail });
  }
  return out;
}

// ── LOST: a session the machine killed, not one a person stopped ──────────────
// A kernel panic, a power cut or a tmux server that died takes every AWAKE session with it
// and leaves no marker behind. A session that was asleep comes back as an asleep card, since
// its marker is a file. An awake one used to vanish from the grid, the phone and the digest,
// even though its status record and its whole conversation were still on disk. Measured
// after one reboot: about thirty sessions across fleets gone from every screen, and the
// owner noticed one only by remembering its name. `fleet-restart --reopen` could already
// bring each one back on its own conversation. Nothing offered it.
//
// LOST IS DECIDED BY ELIMINATION, AND EVERY RULE BELOW IS A WAY THE ANSWER WAS ALREADY
// KNOWN. Every way a person ends a session leaves evidence, and that evidence wins:
//   - stopped (fleet-stop, x on the grid): the records are deleted, so nothing is left here
//   - renamed (fleet-rename): the record is rewritten to the new slot, which is live
//   - renamed by hand (a raw tmux rename): the record's pane is still on this server
//   - asleep or exited: those markers are the card, and a better one
//   - the worktree was reclaimed: its cwd is gone, and a reopen needs that cwd anyway
//   - no transcript: nothing to resume, and a card offering ⏎ would be lying
//   - a tab (`_` prefix): it was never an agent
// What is left is a record whose newest entry is recent, with nobody under its name.
//
// SEVEN DAYS, measured from the newest record, so a week-old crash does not come back as a
// wall of cards. The owner dismisses the recent ones with x on the grid or a long press on
// the phone.
//
// `live` is a Set of session names on that socket, and `panes` a Set of `<pane_id>@<pid>`
// strings (the shape the hook writes). Pass null for `live` when tmux could not be asked:
// with no liveness, nothing is lost, because "could not check" must never read as "gone".
export const LOST_DAYS = 7;

// ── WHEN THE LIVE SERVER ON A SOCKET STARTED, in epoch seconds (0 = no server, or unknown) ──
// The pane rule below reads a live thing as evidence: "its pane is still on this server",
// matched as `<pane_id>@<server pid>`. Pane ids restart at %0 with every server and a pid is
// reused across a reboot, so a server started AFTER a crash can carry exactly the `%0@<pid>`
// an old record names — and the dead session would hide behind a coincidence. The server's
// own start time tells them apart: a record written by a pane on THIS server cannot be older
// than the server. Not the machine's boot time: a session renamed by hand on a server that
// is still running is live whatever the boot says, and a CI runner that booted minutes ago
// read every hours-old fixture record as pre-boot and called a renamed live session lost.
export function serverStart(sock, conf = '') {
  try {
    const out = execFileSync('tmux', ['-L', sock, ...(conf ? ['-f', conf] : []), 'display-message', '-p', '#{start_time}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}
const encProject = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
export function transcriptOf(rec, cfg) {
  if (rec.transcript) return String(rec.transcript);
  if (rec.cwd && rec.session_id && cfg) return path.join(cfg, 'projects', encProject(rec.cwd), `${rec.session_id}.jsonl`);
  return '';
}
export function lostSessions({ dir, sock, live, panes = new Set(), cfg = '', now = Math.floor(Date.now() / 1000), days = LOST_DAYS, started = 0 }) {
  if (!live) return [];
  const newest = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    // STRICT on the socket: a record without one predates scoping, and `master` is in
    // every fleet. Guessing which fleet it belongs to is how one project shows another's card.
    if (!j || typeof j !== 'object' || j.sock !== sock || !j.slot) continue;
    const prev = newest.get(j.slot);
    if (!prev || (Number(j.ts) || 0) > (Number(prev.ts) || 0)) newest.set(j.slot, j);
  }
  const marks = markersFor(dir, sock);
  const out = [];
  for (const [slot, j] of newest) {
    if (slot.startsWith('_')) continue;
    if (live.has(slot)) continue;
    const k = marks.get(slot);
    if (k && (k.has('asleep') || k.has('exited'))) continue;
    const ts = Number(j.ts) || 0;
    // a record older than the server holding its pane id was written on a server that died
    if (j.pane && panes.has(String(j.pane)) && !(started && ts && ts < started)) continue;
    if (!ts || now - ts > days * 86400) continue;
    if (!j.session_id) continue;
    try { if (!j.cwd || !fs.statSync(j.cwd).isDirectory()) continue; } catch { continue; }
    const tr = transcriptOf(j, cfg);
    try { if (!tr || !fs.statSync(tr).isFile()) continue; } catch { continue; }
    out.push({ name: slot, cwd: String(j.cwd), at: ts, id: String(j.session_id), transcript: tr, status: String(j.status || '') });
  }
  return out.sort((a, b) => b.at - a.at);
}
