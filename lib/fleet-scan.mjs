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
import { codexHome, rolloutById } from './codex-rollout.mjs';

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
      // A resume turn's verdict (hooks/fleet-event.sh, RESUME_TAG): `resume` while it runs,
      // `resumed` once a Stop found it produced nothing. Only those two words, and only for
      // the push to read; pushPayload copies its fields by name, so it never travels.
      if (j.turn === 'resume' || j.turn === 'resumed') row.turn = j.turn;
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
// to its four (and a resume turn's one-word verdict) because its rows feed a push payload, and this one's never reach one. Newest
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
//   - no conversation: nothing to resume, and a card offering ⏎ would be lying
//   - a tab (`_` prefix): it was never an agent
// What is left is a record that died recently, with nobody under its name.
//
// SEVEN DAYS, measured from when the session DIED, so a week-old crash does not come back as
// a wall of cards. Its last write is not its death: an idle session writes nothing, and one
// that sat idle for ten days and was alive at a shutdown was already past a window counted
// from its record the moment it died, so it vanished with no card. What says when it was
// last alive is the governor's stamp (writeAlive below); a record no stamp names falls back
// to its own last write, which is all there was before. The owner dismisses the recent
// ones with x on the grid or a long press on the phone.
//
// EVERY PROFILE'S DIRECTORY, STRICT ON THE SOCKET. A session whose process ran with another
// profile's fleet dir (lib/fleet-env.mjs has how) wrote its records there, where this
// fleet's readers never looked, so its card could not show anywhere. The socket inside the
// record already says which fleet it belongs to, so `dirs` lists the other places to look
// and a record is taken from any of them only under its own socket.
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
    const out = execFileSync('tmux', ['-u', '-L', sock, ...(conf ? ['-f', conf] : []), 'display-message', '-p', '#{start_time}'],
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

// ── WHICH CONVERSATION A RECORD IS, AND WHOSE ─────────────────────────────────
// { agent, file } of the conversation a reopen would resume, or null when there is none.
// transcriptOf alone builds CLAUDE's path, <cfg>/projects/<cwd>/<id>.jsonl, and codex keeps
// no file there: its conversation is a rollout under the codex home, named with the thread
// id (lib/codex-rollout.mjs rolloutById, the lookup fleet-restart and slot-claim already
// use). A codex record that did not carry its rollout's path (one rewritten as a claude
// record by a hook that predates the bridge's own fields, or one whose path was the
// fleet-side copy) therefore read as "no transcript", and every lost codex session went
// without a card. Measured: 4 of 13 lost records.
//   The record's agent decides when it has one. When it has none and Claude's file is not
// there, a rollout named with the id is codex's conversation and nobody else's, so that is
// asked too, but only for an id codex could have minted: codex's thread ids are UUIDv7 and
// Claude's session ids v4, so a Claude session that never took a turn (no transcript, the
// common case) never walks codex's folders on every tick.
const ROLLOUT = /(^|\/)rollout-[^/]*\.jsonl$/;
const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const byId = new Map();          // `${home}\t${id}` -> { file, at }: the grid asks every tick
const MISS_TTL = 60;             // a miss is asked again after this; a hit is re-checked by stat
function rolloutFor(id, home, now) {
  const k = `${home}\t${id}`;
  const c = byId.get(k);
  if (c && (c.file ? isFile(c.file) : now - c.at < MISS_TTL)) return c.file;
  const file = rolloutById(id, home);
  byId.set(k, { file, at: now });
  return file;
}
export function conversationOf(rec, cfg, home = codexHome(), now = Math.floor(Date.now() / 1000)) {
  const id = String(rec?.session_id || '');
  if (!id) return null;
  const tr = rec.transcript ? String(rec.transcript) : '';
  if (rec.agent === 'codex' || ROLLOUT.test(tr) || tr.endsWith('.codex.jsonl')) {
    if (ROLLOUT.test(tr) && isFile(tr)) return { agent: 'codex', file: tr };
    const f = rolloutFor(id, home, now);
    return f ? { agent: 'codex', file: f } : null;
  }
  const own = transcriptOf(rec, cfg);
  if (isFile(own)) return { agent: String(rec.agent || 'claude'), file: own };
  if (!rec.agent && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(id)) {
    const f = rolloutFor(id, home, now);
    if (f) return { agent: 'codex', file: f };
  }
  return null;
}

// ── WHO WAS ALIVE WHEN A SERVER DIED ──────────────────────────────────────────
// A shutdown leaves no trace of which sessions were running: the hook writes on events, and
// an idle session has none. So the one process that lives exactly as long as a fleet, its
// governor, writes down on every tick which panes this server holds (lib/fleet-env.mjs heal,
// from the tmux reads it already makes, so this costs no process at all) into
// <fleet dir>/alive/<sock>.<server start>.<server pid>.json:
//   { sock, pid, start, seen, panes: { "<pane_id>@<pid>": "<session name>" } }
// ONE FILE PER SERVER, never one per fleet: the next server's governor would overwrite the
// only evidence of who the previous one held, a minute after the reboot it is evidence for.
// Each is kept until its `seen` is past the lost window, then removed by the writer.
//   A stamp speaks for a record only when the record was written on that server
// (ts >= start). Pane ids restart at %0 and a pid is reused across a reboot, so a newer
// server can list exactly the `%0@<pid>` an old record names; without the start time a
// session that died a month ago would be "seen" alive this morning.
export const ALIVE = 'alive';
const SAFE = /^[A-Za-z0-9._-]+$/;
export function writeAlive(dir, { sock, pid, start, panes, now = Math.floor(Date.now() / 1000), days = LOST_DAYS }) {
  if (!dir || !SAFE.test(String(sock || '')) || !(Number(pid) > 0) || !(Number(start) > 0)) return false;
  const d = path.join(dir, ALIVE);
  const name = `${sock}.${Number(start)}.${Number(pid)}.json`;
  const tmp = path.join(d, `.${name}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ sock, pid: Number(pid), start: Number(start), seen: now, panes: Object.fromEntries(panes) }) + '\n');
    fs.renameSync(tmp, path.join(d, name));
  } catch { try { fs.unlinkSync(tmp); } catch {} return false; }
  // Pruned by mtime, which is `seen`: a stamp past the window can no longer make a card.
  let names = [];
  try { names = fs.readdirSync(d); } catch {}
  for (const n of names) {
    if (!n.startsWith(`${sock}.`) || !n.endsWith('.json') || n === name) continue;
    try { if (now - fs.statSync(path.join(d, n)).mtimeMs / 1000 > (days + 1) * 86400) fs.unlinkSync(path.join(d, n)); } catch {}
  }
  return true;
}
export function aliveStamps(dirs, sock) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, ALIVE)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(`${sock}.`) || !n.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, ALIVE, n), 'utf8')); } catch { continue; }
      if (!j || j.sock !== sock || !(Number(j.seen) > 0) || !j.panes || typeof j.panes !== 'object') continue;
      out.push({ start: Number(j.start) || 0, seen: Number(j.seen), panes: new Map(Object.entries(j.panes)) });
    }
  }
  return out;
}

// The fleet dir of every profile, for a reader that has to find a fleet's records wherever
// a session with another profile's environment put them. From the projects files, so it is
// the same set the push watcher scans; the caller's own dir goes first.
export function profileDirs(own, list) {
  const seen = new Set(own ? [own] : []);
  for (const d of fleetDirs(list || [])) seen.add(d);
  return [...seen];
}

export function lostSessions({ dir, dirs = [], sock, live, panes = new Set(), cfg = '', now = Math.floor(Date.now() / 1000), days = LOST_DAYS, started = 0, home = codexHome() }) {
  if (!live) return [];
  const where = [...new Set([dir, ...dirs].filter(Boolean))];
  const newest = new Map();
  for (const d of where) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch { continue; }
      // STRICT on the socket: a record without one predates scoping, and `master` is in
      // every fleet. Guessing which fleet it belongs to is how one project shows another's card.
      if (!j || typeof j !== 'object' || j.sock !== sock || !j.slot) continue;
      const prev = newest.get(j.slot);
      if (!prev || (Number(j.ts) || 0) > (Number(prev.ts) || 0)) newest.set(j.slot, j);
    }
  }
  // A marker in any of those places hides the card: it is named for this socket too.
  const marks = new Map();
  for (const d of where) for (const [slot, k] of markersFor(d, sock)) {
    if (!marks.has(slot)) marks.set(slot, new Set());
    for (const x of k) marks.get(slot).add(x);
  }
  const stamps = aliveStamps(where, sock);
  const out = [];
  for (const [slot, j] of newest) {
    if (slot.startsWith('_')) continue;
    if (live.has(slot)) continue;
    const k = marks.get(slot);
    if (k && (k.has('asleep') || k.has('exited'))) continue;
    const ts = Number(j.ts) || 0;
    if (!ts) continue;
    // a record older than the server holding its pane id was written on a server that died
    if (j.pane && panes.has(String(j.pane)) && !(started && ts < started)) continue;
    // When it was last seen alive: the newest stamp, of a server this record was written on,
    // that held its pane. The window counts from the later of that and its own last write.
    let seen = 0;
    if (j.pane) for (const s of stamps) if (s.panes.has(String(j.pane)) && ts >= s.start && s.seen > seen) seen = s.seen;
    const at = Math.max(ts, seen);
    if (now - at > days * 86400) continue;
    if (!j.session_id) continue;
    try { if (!j.cwd || !fs.statSync(j.cwd).isDirectory()) continue; } catch { continue; }
    const conv = conversationOf(j, cfg, home, now);
    if (!conv) continue;
    out.push({ name: slot, cwd: String(j.cwd), at, wrote: ts, id: String(j.session_id), transcript: conv.file,
               agent: conv.agent, status: String(j.status || '') });
  }
  return out.sort((a, b) => b.at - a.at);
}
