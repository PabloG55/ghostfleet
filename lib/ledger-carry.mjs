// lib/ledger-carry.mjs — a stopped worker's unfinished ledger items, handed to its lead.
//
//   node lib/ledger-carry.mjs <fleet dir> <sock> <worker> <lead>
//
// bin/fleet-stop runs this after the worker's session is killed (so its mod cannot write
// again) and before its status records are deleted (they are the only thing that maps its
// name to the session ids its ledgers are filed under). The rule is ledger.js's carryItems;
// this is the I/O around it. Prints one line for fleet-stop to pass on, or nothing when the
// worker owed nothing. ALWAYS exits 0: a stop that fails over a ledger leaves a live session
// nobody can retire, which is worse than an item left where it was, said out loud.
//
// Who is who, scoped by the SOCKET, as every reader here is: each fleet has a `master`, and
// worker names repeat across fleets. Every session id the worker ran under on this socket is
// carried (a record per id; fleet-stop deletes all of them), and the lead's ledger is its
// newest record's, as fleet-ledger resolves a name.
//
// When the lead's ledger cannot take them, nothing is lost and the stop goes on:
//   no record for the lead     there is no file to name. The items stay in the worker's own
//                              ledger, which a stop never deletes, and the line says how to
//                              read them (fleet-ledger --session <id> all)
//   no ledger file for it      a lead without the mod (codex, an older Claude, the ledger
//                              switched off) never reads one. Not created: items in a file
//                              nobody opens are where they already were. Same line
//   unreadable, or not JSON    written over, its history would be gone. Same line
//   kept changing              the lead's mod writes the same file between its turns; each
//                              try re-reads and re-applies (as fleet-ledger does), and after
//                              five the items stay. Same line
// The lead is written FIRST and the worker marked after it: a failure between the two leaves
// an item in both, never in neither, and carryItems skips an item the lead already holds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = await import(path.join(here, '..', 'mods', 'ghostfleet', 'hooks', 'ledger.js'));

const [dir, sock, worker, lead] = process.argv.slice(2);
if (!dir || !sock || !worker || !lead || worker === lead) process.exit(0);
const now = Number(process.env.CLAUDE_FLEET_NOW_MS) || Date.now();

const records = [];
let names = [];
try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { process.exit(0); }
for (const f of names) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r && r.session_id && (r.sock || '') === sock) records.push(r);
  } catch {}
}
const ids = slot => [...new Set(records.filter(r => r.slot === slot)
  .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).map(r => String(r.session_id)))]
  .filter(id => /^[A-Za-z0-9._-]+$/.test(id));

// null when the file is missing, unreadable or not a ledger: never written over.
const read = file => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { const l = JSON.parse(text); if (!l || !Array.isArray(l.items)) return null; } catch { return null; }
  return { text, ledger: L.parseLedger(text) };
};
// Written beside itself and renamed over, only if nobody moved it meanwhile (fleet-ledger's rule).
const put = (file, before, ledger) => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.carry.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur === before) { fs.renameSync(tmp, file); return true; }
  } catch {}
  try { fs.rmSync(tmp, { force: true }); } catch {}
  return false;
};

const owed = ids(worker).map(id => ({ id, file: L.ledgerFile(dir, id) }))
  .map(w => ({ ...w, n: ((read(w.file) || {}).ledger || L.emptyLedger()).items.filter(i => L.CARRIED.has(i.state)).length }))
  .filter(w => w.n > 0);
if (!owed.length) process.exit(0);
const total = owed.reduce((k, w) => k + w.n, 0);
const plural = n => `${n} unfinished ledger item${n === 1 ? '' : 's'}`;
let carried = 0;
const stay = why => {
  console.log(`${carried ? `carried ${carried} to '${lead}'; ` : ''}${plural(total - carried)} of '${worker}' stay in its own ledger (${why}): `
    + owed.map(w => `fleet-ledger --session ${w.id} all`).join('; '));
  process.exit(0);
};

const leadId = ids(lead)[0];
if (!leadId) stay(`no session record for '${lead}' on ${sock}`);
const leadFile = L.ledgerFile(dir, leadId);
if (!fs.existsSync(leadFile)) stay(`'${lead}' keeps no ledger`);

for (const w of owed) {
  let done = false;
  for (let k = 0; k < 5 && !done; k++) {
    const lw = read(w.file), ll = read(leadFile);
    if (!ll) stay(`'${lead}''s ledger could not be read`);
    if (!lw) break;
    const r = L.carryItems(lw.ledger, ll.ledger, { from: worker, sessionId: w.id, to: lead, nowMs: now });
    if (!r) { done = true; break; }
    if (!put(leadFile, ll.text, r.lead)) continue;
    carried += r.ids.length;
    done = true;
    // The lead holds them now; marking the worker's copies is bookkeeping, against the file
    // as it is. Should every try lose, the lead already holds them, and a later stop skips them.
    for (let j = 0; j < 5; j++) {
      const again = read(w.file);
      if (!again || put(w.file, again.text, L.markCarried(again.ledger, moved(r), { to: lead, nowMs: now }))) break;
    }
  }
}
// The worker's item id -> the lead's, for the items THIS write carried.
function moved(r) {
  return new Map(r.lead.items.filter(i => i.carried && r.ids.includes(i.id)).map(i => [i.carried.id, i.id]));
}
if (carried < total) stay(`'${lead}''s ledger kept changing under the write`);
console.log(`carried ${plural(carried)} to '${lead}' (fleet-ledger -s ${sock} ${lead} lists them)`);

