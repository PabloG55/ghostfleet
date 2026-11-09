#!/usr/bin/env node
// lib/handoff-sweep.mjs — the failed handoffs nobody read, filed where a lead reads.
//
//   node lib/handoff-sweep.mjs <fleet dir> <socket>
//     files a `failed` inbox row for each, removes the receipt, prints how many it filed.
//
// The mod answers every handoff with a receipt (mods/ghostfleet/hooks/handoff.js), and a
// failure there is only as loud as whoever reads it. fleet-send reads it, says it, exits 1
// and removes it, so a failed receipt still on disk is one no sender read: fleet-send gave
// up waiting before it landed, or the failure came later ("its turn never started"). A
// prompt that opened with a slash command was refused that way across three fleets, and
// the lead saw a worker that had "never started". fleet-inbox runs this first, so the row
// is there on the next look.
//   Which receipts: a `.done` holding an error or a drop, older than UNREAD_MS (younger, a
// sender may still be waiting on it), and every `.failed`, which is a failure the mod kept
// past its hour. Only those of sessions on <socket>, named by the receipt itself or, from
// an older mod, by the session's status record.
//   Which inbox: the one the worker's events go to (hooks/fleet-event.sh): a live parent
// named in <sock>.<slot>.parent, else master's.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entryId, failureOf, UNREAD_MS } from '../mods/ghostfleet/hooks/handoff.js';

const NAME = /^[A-Za-z0-9._~-]+$/;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

const liveSession = (sock, name) =>
  spawnSync('tmux', ['-L', sock, 'has-session', '-t', `=${name}`], { stdio: 'ignore' }).status === 0;

export function leadInbox(dir, sock, slot, alive = liveSession) {
  let parent = '';
  try { parent = fs.readFileSync(path.join(dir, `${sock}.${slot}.parent`), 'utf8').split('\n')[0].trim(); } catch {}
  if (parent && parent !== 'master' && NAME.test(parent) && alive(sock, parent))
    return path.join(dir, `${sock}.${parent}.inbox`);
  return path.join(dir, `${sock}.inbox`);
}

export function sweep(dir, sock, nowMs = Date.now(), alive = liveSession) {
  let filed = 0;
  let spools = [];
  try { spools = fs.readdirSync(dir).filter(n => n.endsWith('.handoff')); } catch { return 0; }
  for (const sp of spools) {
    const sid = sp.slice(0, -'.handoff'.length);
    let rec;
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sp)); } catch { continue; }
    for (const n of names) {
      const done = entryId(n, '.done');
      const id = done || entryId(n, '.failed');
      if (!id) continue;
      const file = path.join(dir, sp, n);
      const r = readJson(file);
      const why = failureOf(r);
      if (!why) continue;
      const at = Number(r.at) || Number(id.match(/^[0-9]+/)[0]);
      if (done && nowMs - at < UNREAD_MS) continue;
      let { sock: s, slot } = r;
      if (!s || !slot) {
        if (rec === undefined) rec = readJson(path.join(dir, `${sid}.json`));
        s = rec?.sock; slot = rec?.slot;
      }
      if (s !== sock || !slot || !NAME.test(String(slot))) continue;
      const when = new Date(at).toTimeString().slice(0, 5);
      const what = r.head ? `"${clean(r.head)}"` : 'a prompt';
      const detail = clean(`${what} was not delivered at ${when}, and no sender read why — ${clean(why)}`).slice(0, 300);
      try {
        fs.appendFileSync(leadInbox(dir, sock, slot, alive), `${Math.floor(nowMs / 1000)}\t${slot}\tfailed\t${detail}\n`);
        fs.unlinkSync(file);
        filed++;
      } catch {}
    }
  }
  return filed;
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [dir, sock] = process.argv.slice(2);
  if (!dir || !sock) { process.stderr.write('usage: handoff-sweep.mjs <fleet dir> <socket>\n'); process.exit(2); }
  process.stdout.write(`${sweep(dir, sock)}\n`);
}
