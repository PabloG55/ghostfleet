// lib/ledger-landed.mjs — a lead's carried ledger items whose worker's PR has since merged,
// closed with that merge as their proof.
//
//   node lib/ledger-landed.mjs <fleet dir> <sock> <lead> <fleet-merged> <repo dir>
//
// bin/fleet-inbox runs this on every look, beside its "finished & reclaimable" footer: the
// inbox is where a lead already reads merges, and fleet-merged's answer there is cached (ten
// minutes) and shared, so this costs no model call and, most looks, no network either. The
// rule is ledger.js's closeLanded; this is the I/O around it.
//
// Cheap first: the lead's ledger is read before anything else, and only one that holds an
// open carried item with a branch or PR on it asks fleet-merged at all. Every other case (no
// record for the lead, no ledger, nothing carried, fleet-merged silent) prints nothing and
// changes nothing. ALWAYS exits 0: this is a footer, and an inbox must never fail over it.
// Written as fleet-ledger and ledger-carry write: beside itself, renamed over the file only
// when nobody moved it meanwhile, five tries.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = await import(path.join(here, '..', 'mods', 'ghostfleet', 'hooks', 'ledger.js'));

const [dir, sock, lead, merged, repo] = process.argv.slice(2);
if (!dir || !sock || !lead || !merged || !repo) process.exit(0);
const now = Number(process.env.CLAUDE_FLEET_NOW_MS) || Date.now();

// The lead's newest record on THIS socket, as fleet-ledger resolves a name.
let leadId = '', ts = -1;
let names = [];
try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { process.exit(0); }
for (const f of names) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r && r.session_id && (r.sock || '') === sock && r.slot === lead && (Number(r.ts) || 0) > ts
        && /^[A-Za-z0-9._-]+$/.test(String(r.session_id))) { leadId = String(r.session_id); ts = Number(r.ts) || 0; }
  } catch {}
}
if (!leadId) process.exit(0);
const file = L.ledgerFile(dir, leadId);
const read = () => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { const l = JSON.parse(text); if (!l || !Array.isArray(l.items)) return null; } catch { return null; }
  return { text, ledger: L.parseLedger(text) };
};
const first = read();
if (!first || !first.ledger.items.some(i => i.carried && (i.carried.branch || i.carried.pr) && (i.state === 'open' || i.state === 'waiting'))) process.exit(0);

let out = '';
try { out = execFileSync(merged, ['--prs', repo], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { process.exit(0); }
const prs = out.split('\n').map(l => l.split('\x1f')).filter(c => c.length >= 3)
  .map(([branch, number, state]) => ({ branch, number: Number(number) || 0, state }));
if (!prs.length) process.exit(0);

for (let k = 0; k < 5; k++) {
  const cur = read();
  if (!cur) break;
  const next = L.closeLanded(cur.ledger, prs, { nowMs: now });
  if (!next) break;
  const tmp = path.join(dir, `.${path.basename(file)}.landed.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(next));
    let again = null;
    try { again = fs.readFileSync(file, 'utf8'); } catch {}
    if (again === cur.text) {
      fs.renameSync(tmp, file);
      const shut = next.items.filter(i => i.closedBy === 'fleet' && i.closedAt === now && i.carried
        && cur.ledger.items.some(j => j.id === i.id && j.state !== 'done'));
      if (shut.length) console.log(`ledger: closed ${shut.length} carried item${shut.length === 1 ? '' : 's'} of '${lead}' whose PR merged: `
        + shut.map(i => `${i.id} (${i.proof}, from ${i.carried.from})`).join(', '));
      break;
    }
  } catch {}
  try { fs.rmSync(tmp, { force: true }); } catch {}
}
process.exit(0);
