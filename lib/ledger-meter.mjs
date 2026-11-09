// lib/ledger-meter.mjs — `fleet-meter --ledger`: what the ledgers across every profile's fleet
// dir hold, and what the judge that keeps them has cost.
//
// THE QUESTIONS IT ANSWERS. How much is owed and for how long (state distribution, and the age
// of everything still owed), whether a fix to the ledger moved those numbers, and what the
// judge costs. Before `judged` (ledger.js countJudge) the file kept only the LAST judge
// result, so "how many judge calls did a fleet make this week" had no answer short of reading
// the host's billing. A ledger written before the counter shows up as `untallied`: its spend
// is unknown, and it is never summed as zero.
//
// SAME RULES AS THE REST OF fleet-meter: COUNTS, NEVER CONTENT. A ledger holds the person's
// words, so nothing below reads an item's text except to count it; no output carries a text,
// a path, a session id, a slot or a branch. Even the fleet dirs are counted rather than
// named, since a profile's directory name is the account it belongs to.
//
// WHERE IT LOOKS. $HOME/.claude/fleet and every $HOME/.claude-*/fleet (one per profile, as
// the mod's adoptMoved looks), plus $CLAUDE_FLEET_DIR, each counted once by real path:
// a link to a fleet dir is that fleet dir. `--fleet-dir DIR` (repeatable) reads only those.
//
// TOKENS are the host's own counts, summed only over the calls that reported them
// (`reported` of `calls`). No price is applied: the judge's model is the host's choice, and
// a guessed price would be a number nobody could check.
import fs from 'node:fs';
import path from 'node:path';

const OWED = new Set(['open', 'waiting', 'not-done']);
export const AGES = [['<1h', 3600e3], ['1h-1d', 86400e3], ['1d-7d', 7 * 86400e3], ['>7d', Infinity]];

export function fleetDirs({ home = process.env.HOME || '', env = process.env.CLAUDE_FLEET_DIR || '' } = {}) {
  const out = [];
  if (env) out.push(env);
  let names = [];
  try { names = fs.readdirSync(home); } catch {}
  for (const n of names.sort()) if (n === '.claude' || n.startsWith('.claude-')) out.push(path.join(home, n, 'fleet'));
  return out;
}

export function measure(dirs, { nowMs = Date.now() } = {}) {
  const seen = new Set();
  const real = [];
  for (const d of dirs) {
    let r;
    try { r = fs.realpathSync(d); if (!fs.statSync(r).isDirectory()) continue; } catch { continue; }
    if (seen.has(r)) continue;
    seen.add(r); real.push(r);
  }
  const states = {}, sources = {}, age = Object.fromEntries(AGES.map(([k]) => [k, 0]));
  const judge = { turns: 0, calls: 0, failedCalls: 0, items: 0, reported: 0, inputTokens: 0, outputTokens: 0 };
  const rep = { ledgers: 0, unreadable: 0, empty: 0, tallied: 0, untallied: 0, items: 0, owed: 0, repeated_items: 0, repeats: 0, moved: 0 };
  const ids = new Map();
  let since = 0;
  for (const d of real) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.ledger') || f.startsWith('.')) continue;
      let l;
      try { l = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { rep.unreadable++; continue; }
      if (!l || typeof l !== 'object' || !Array.isArray(l.items)) { rep.unreadable++; continue; }
      rep.ledgers++;
      const sid = f.slice(0, -'.ledger'.length);
      ids.set(sid, (ids.get(sid) || 0) + 1);
      if (!l.items.length) rep.empty++;
      const j = l.judged;
      if (j && typeof j === 'object') {
        rep.tallied++;
        for (const k of Object.keys(judge)) judge[k] += Number(j[k]) || 0;
        const s = Number(j.since) || 0;
        if (s && (!since || s < since)) since = s;
      } else if (l.items.length) rep.untallied++;
      for (const i of l.items) {
        if (!i || typeof i !== 'object') continue;
        rep.items++;
        const st = String(i.state || 'unknown');
        states[st] = (states[st] || 0) + 1;
        if (Number(i.repeated) > 0) { rep.repeated_items++; rep.repeats += Number(i.repeated); }
        if (st === 'moved') rep.moved++;
        if (!OWED.has(st)) continue;
        rep.owed++;
        const src = String(i.source || 'unknown');
        sources[src] = (sources[src] || 0) + 1;
        const a = nowMs - (Number(i.at) || nowMs);
        age[AGES.find(([, max]) => a < max)[0]]++;
      }
    }
  }
  const order = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return {
    fleet_dirs: real.length,
    ...rep,
    in_two_dirs: [...ids.values()].filter((n) => n > 1).length,
    states: order(states),
    owed_by_source: order(sources),
    owed_by_age: age,
    judge: { ...judge, since: since ? new Date(since).toISOString().slice(0, 10) : null },
  };
}

export function render(r) {
  const n = (x) => String(x).padStart(7);
  const L = [];
  L.push(`ledger  ${r.ledgers} ledgers in ${r.fleet_dirs} fleet dir${r.fleet_dirs === 1 ? '' : 's'}  ${r.items} items  ${r.owed} owed`
    + (r.unreadable ? `  ${r.unreadable} unreadable` : '') + (r.empty ? `  ${r.empty} empty` : ''));
  L.push('\nitems by state');
  for (const [k, v] of Object.entries(r.states)) L.push(`  ${k.padEnd(12)}${n(v)}`);
  L.push('\nowed (open, waiting, not-done) by age');
  for (const [k, v] of Object.entries(r.owed_by_age)) L.push(`  ${k.padEnd(12)}${n(v)}`);
  L.push('\nowed by who asked');
  if (!Object.keys(r.owed_by_source).length) L.push('  nothing owed');
  for (const [k, v] of Object.entries(r.owed_by_source)) L.push(`  ${k.padEnd(12)}${n(v)}`);
  L.push(`\nrepeats folded: ${r.repeats} into ${r.repeated_items} item${r.repeated_items === 1 ? '' : 's'}`
    + `   moved across profiles: ${r.moved} item${r.moved === 1 ? '' : 's'}, ${r.in_two_dirs} ledger${r.in_two_dirs === 1 ? '' : 's'} in two dirs`);
  const j = r.judge;
  L.push(`\njudge  ${r.tallied} ledger${r.tallied === 1 ? '' : 's'} tallied${j.since ? ` since ${j.since}` : ''}`
    + (r.untallied ? `, ${r.untallied} untallied (written before the counter: spend unknown, not zero)` : ''));
  L.push(`  turns ${j.turns}  calls ${j.calls}  failed ${j.failedCalls}  items judged ${j.items}`);
  L.push(j.reported
    ? `  tokens  input ${j.inputTokens}  output ${j.outputTokens}  (${j.reported} of ${j.calls} calls reported usage)`
    : `  tokens  none reported${j.calls ? ` by any of ${j.calls} calls` : ''}`);
  return L.join('\n');
}
