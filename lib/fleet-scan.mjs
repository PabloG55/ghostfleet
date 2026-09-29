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
      const row = { sock: String(j.sock), slot: String(j.slot), status: String(j.status || ''), ts: Number(j.ts) || 0 };
      const key = `${row.sock}/${row.slot}`;
      const prev = newest.get(key);
      if (!prev || row.ts > prev.ts) newest.set(key, row);
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
