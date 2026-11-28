// node test/helpers/handoff-shift.mjs <in.jsonl> <out.jsonl> <epoch-ms>
//
// The same transcript, its clock moved so its first record is at <epoch-ms> and the rest keep
// their spacing. A captured conversation happened when it was captured; a test that hands one
// to a session as "what happened since you left" needs it to have happened after the leaving,
// and lib/handoff.mjs's delta is exactly a comparison of those clocks. Every top-level
// `timestamp` moves (Claude Code's records and codex's rollout lines both carry one there);
// nothing else is touched.
import fs from 'node:fs';

const [src, out, ms] = process.argv.slice(2);
const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const first = lines.map(r => Date.parse(r.timestamp)).find(Number.isFinite);
const d = Number(ms) - first;
for (const r of lines) if (typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)))
  r.timestamp = new Date(Date.parse(r.timestamp) + d).toISOString();
fs.writeFileSync(out, lines.map(r => JSON.stringify(r)).join('\n') + '\n');
