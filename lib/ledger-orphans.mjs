// lib/ledger-orphans.mjs — what a worker that died without a fleet-stop still owed, handed to
// its lead.
//
//   node lib/ledger-orphans.mjs <fleet dir> <sock> [--dry-run]
//
// WHY. fleet-stop carries a stopped worker's open, waiting and not-done ledger items to its
// lead (lib/ledger-carry.mjs). A worker that is never stopped carries nothing: its pane was
// killed, its tmux server died, the machine rebooted, and the items sat in a ledger nobody
// would open again. Measured on one machine's fleets with this file's own rule (--dry-run): 2
// dead workers holding 5 owed items, neither visible to the lead the person talks to.
//
// WHERE. bin/fleet-inbox runs this on every look, before the ledger-landed footer, because
// that is the one place a lead reliably reads (a worker's DONE sends it there): no model call,
// no network, and on most looks nothing to do but read the records. When a worker is dead the
// carry itself is ledger-carry.mjs, run as fleet-stop runs it, so there is one rule for what is
// carried and how, and its line is printed as it says it.
//
// DEAD IS DECIDED BY ELIMINATION, as lib/fleet-scan.mjs's lostSessions decides "lost": every
// way a session can still be somebody's is a reason to leave it alone.
//   - a live session under the slot's name on this socket (a parked one is live: fleet-pause
//     leaves it running)
//   - an asleep, exited or parked marker: an asleep session comes back on its own conversation
//   - the newest record's pane is still on this server, written since the server started (a
//     session renamed by hand in tmux)
//   - the newest record for the slot is under DEAD_AFTER_S old: a session being spawned,
//     restarted or woken has no tmux session for a moment, and a day is the audit's own bar
//   - `master` (nobody above it) and a tab (`_` prefix, never an agent)
// When tmux cannot be asked at all, nothing is dead: "could not check" must never read as
// "gone". A fleet whose server is down is never looked at by this anyway: the lead that runs
// the inbox lives on that server.
//   A "lost" card (a session the machine killed, offered for reopening on the grid for seven
// days) is dead by this rule once its record is a day old. Its items go to the lead, and the
// card stays: a reopen resumes the worker with those items `carried`, and the lead's copy
// closes when the worker's branch merges (ledger.js closeLanded, run by the same inbox look).
//
// WHO GETS THEM. The slot's lead: its <sock>.<slot>.parent tag when that lead is still on the
// fleet (live or asleep), else `master`. A sub-lead that died too would be a ledger nobody
// reads, which is the problem being fixed.
//
// THE BRANCH rides on each item when the newest record names one AND its cwd is still a linked
// worktree: a main checkout's branch is the integration branch, and a release PR whose head it
// is would read as this worker's work having merged. No PR is looked up here; the branch alone
// is what lets the lead's copy close on the merge.
//
// AT MOST ONCE: ledger-carry marks each item `carried` in the worker's file and skips one the
// lead already holds, so a second look finds nothing owed and carries nothing.
//
// ALWAYS exits 0, and prints nothing unless it carried something (or, with --dry-run, would).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = await import(path.join(here, '..', 'mods', 'ghostfleet', 'hooks', 'ledger.js'));
const { markersFor, parentsFor, serverStart } = await import(path.join(here, 'fleet-scan.mjs'));

export const DEAD_AFTER_S = 86400;

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const [dir, sock] = argv.filter(a => a !== '--dry-run');
if (!dir || !sock || !/^[A-Za-z0-9._-]+$/.test(sock)) process.exit(0);
const now = Math.floor((Number(process.env.CLAUDE_FLEET_NOW_MS) || Date.now()) / 1000);
const NAME = /^[A-Za-z0-9._~-]+$/;

const tmux = (...a) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
let live, panes;
try {
  live = new Set(tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean));
  panes = new Set(tmux('list-panes', '-a', '-F', '#{pane_id}@#{pid}').split('\n').filter(Boolean));
} catch { process.exit(0); }
const started = serverStart(sock);

const bySlot = new Map();
let names = [];
try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')); } catch { process.exit(0); }
for (const f of names) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  // STRICT on the socket, as every reader here is: each fleet has a `master`.
  if (!r || typeof r !== 'object' || r.sock !== sock || !r.slot || !r.session_id) continue;
  if (!bySlot.has(r.slot)) bySlot.set(r.slot, []);
  bySlot.get(r.slot).push(r);
}
const marks = markersFor(dir, sock);
const parents = parentsFor(dir, sock);
const onFleet = slot => live.has(slot) || (marks.get(slot) || new Set()).has('asleep');
const owes = id => {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id))) return 0;
  try { return L.parseLedger(fs.readFileSync(L.ledgerFile(dir, id), 'utf8')).items.filter(i => L.CARRIED.has(i.state)).length; } catch { return 0; }
};
const linkedBranch = rec => {
  const b = String(rec.branch || '');
  if (!b || !rec.cwd) return '';
  try {
    const g = a => execFileSync('git', ['-C', String(rec.cwd), 'rev-parse', a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    return g('--absolute-git-dir') !== path.resolve(String(rec.cwd), g('--git-common-dir')) ? b : '';
  } catch { return ''; }
};
const age = s => (s >= 86400 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 3600)}h`);

const carry = path.join(here, 'ledger-carry.mjs');
for (const [slot, recs] of bySlot) {
  if (slot === 'master' || slot.startsWith('_') || !NAME.test(slot)) continue;
  if (live.has(slot)) continue;
  const k = marks.get(slot);
  if (k && (k.has('asleep') || k.has('exited') || k.has('parked'))) continue;
  const newest = recs.reduce((a, b) => ((Number(b.ts) || 0) > (Number(a.ts) || 0) ? b : a));
  const ts = Number(newest.ts) || 0;
  if (newest.pane && panes.has(String(newest.pane)) && !(started && ts && ts < started)) continue;
  if (!ts || now - ts < DEAD_AFTER_S) continue;
  const n = recs.reduce((t, r) => t + owes(r.session_id), 0);
  if (!n) continue;
  let lead = parents.get(slot) || '';
  if (!NAME.test(lead) || !onFleet(lead)) lead = 'master';
  const branch = linkedBranch(newest);
  const why = `'${slot}' is gone (no session on ${sock}, last seen ${age(now - ts)} ago)`;
  if (dry) { console.log(`ledger: ${why}: would carry ${n} unfinished item${n === 1 ? '' : 's'} to '${lead}'`); continue; }
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--no-warnings', carry, dir, sock, slot, lead, branch, ''],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
  } catch {}
  if (out) console.log(`ledger: ${why}: ${out}`);
}
process.exit(0);
