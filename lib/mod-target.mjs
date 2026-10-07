#!/usr/bin/env node
// lib/mod-target.mjs — can this fleet session take a prompt from its mod?
//
//   node lib/mod-target.mjs <fleet dir> <socket> <session>
//     prints "<session_id>\t<state>\t<now ms>" and exits 0 when it can, 1 when it cannot.
//   node lib/mod-target.mjs --handoff <spool dir> <id> [<reply sock> <reply sess> <reply dir>]
//     writes the prompt on stdin as <spool dir>/<id>.json, atomically (the mod lists the
//     directory every half second and must never read half an entry).
//
// bin/fleet-send asks this before it pastes. "Can" is three things at once, and each one
// missing means the paste, exactly as before the mod existed:
//   - a status record for that socket and slot whose mod state is to be believed
//     (lib/mod-status.mjs: the writing process alive, its heartbeat fresh);
//   - a mod that DELIVERS, not just one that reports. A phase-one mod writes a perfectly
//     fresh record and never reads a handoff, so a send to it would wait out its revoke
//     window for nothing. mods/ghostfleet/hooks/deliver.js leaves `<id>.handoff/.ready`
//     naming its process, and only a .ready naming the SAME pid as the record counts —
//     a file left by an earlier process of a resumed conversation proves nothing;
//   - node itself, which the caller handles: no node, no answer, the paste.
//
// Several records can name one slot (a resumed conversation, a stale file a crash left);
// the believable one with the freshest heartbeat wins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modState } from './mod-status.mjs';

export function modTarget(dir, sock, slot, nowMs = Date.now(), alive) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!rec || rec.sock !== sock || rec.slot !== slot || !rec.session_id) continue;
    const state = alive ? modState(rec, nowMs, alive) : modState(rec, nowMs);
    if (!state) continue;
    let ready = '';
    try { ready = fs.readFileSync(path.join(dir, `${rec.session_id}.handoff`, '.ready'), 'utf8').trim(); } catch {}
    if (!ready || Number(ready) !== Number(rec.mod.pid)) continue;
    if (!best || Number(rec.mod.hb) > Number(best.rec.mod.hb)) best = { rec, state };
  }
  return best ? { sessionId: best.rec.session_id, state: best.state } : null;
}

// The entry the mod's DELIVERY section claims (mods/ghostfleet/hooks/handoff.js). Written
// beside and renamed in; the dot keeps the half-written file out of the mod's listing.
export function writeHandoff(spool, id, text, reply) {
  if (!/^[0-9]+[0-9A-Za-z._-]*$/.test(id) || !text) return false;
  const entry = { id, text, ...(reply ? { reply } : {}) };
  const tmp = path.join(spool, `.${id}.tmp`);
  try {
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, path.join(spool, `${id}.json`));
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args[0] === '--handoff') {
    const [, spool, id, sock, sess, dir] = args;
    const reply = sock && sess && dir ? { sock, sess, dir } : null;
    const text = fs.readFileSync(0, 'utf8');
    process.exit(spool && id && writeHandoff(spool, id, text, reply) ? 0 : 1);
  }
  const [dir, sock, slot] = args;
  const t = dir && sock && slot ? modTarget(dir, sock, slot) : null;
  if (!t) process.exit(1);
  process.stdout.write(`${t.sessionId}\t${t.state}\t${Date.now()}\n`);
}
