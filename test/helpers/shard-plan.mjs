#!/usr/bin/env node
// test/helpers/shard-plan.mjs — which groups of test/run.sh a shard runs.
//
//     shard-plan.mjs pick <i> <N>           the group numbers shard i of N runs, one per line
//     shard-plan.mjs plan <N>               every shard: its estimated seconds and its groups
//     shard-plan.mjs check <N>              the plan is a partition that can actually run
//     shard-plan.mjs names                  every group's name as bash prints it, in file order
//     shard-plan.mjs cover <N> <ran>...     the groups the shards REALLY ran are the plan
//     shard-plan.mjs times <ran>...         a fresh timing table from the shards' records
//
// WHY A SHARD IS A LIST OF GROUP NUMBERS, NOT A FILTER. run.sh already knows how to run a
// subset — cf_only lifts the named groups out with the preamble and the summary — and a shard
// is the same extract with a different question asked of it. Matching by substring would let
// one group's name select another that contains it ("fleet-serve:" selects twenty), so a shard
// names groups by their position, and cf_only still checks `# needs:` and `bash -n` on the
// result exactly as it does for a filter.
//
// WHAT HAS TO STAY TOGETHER, and both are things a filter already refuses to split:
//   - a group whose text does not parse on its own. Two groups sit inside an `if` that opens
//     before one of them and closes after the other; lifted out alone either one is a syntax
//     error. Such a run of groups is one unit, found by asking bash, not by counting keywords.
//   - a `# needs:` provider and every group that needs it. Twenty groups share the daemon one
//     group starts; a shard holding a dependent without its provider would be refused.
//
// THE PACKING IS BY MEASURED TIME, because by count it is useless: one group was 6.8 minutes
// of a 36-minute run and the median is under two seconds. test/shard-times.tsv holds seconds
// per group; a group it has never seen is charged the table's median, so a new group lands
// somewhere sensible and the next refresh measures it. Longest unit first onto the lightest
// shard, ties to the lower number — deterministic, so every shard computes the same plan
// without talking to the others, and the coverage check can recompute it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE = process.env.CF_SUITE || path.join(ROOT, 'test', 'run.sh');
const TIMES = process.env.CF_TIMES || path.join(ROOT, 'test', 'shard-times.tsv');

const die = (msg, code = 2) => { process.stderr.write(msg.replace(/\n?$/, '\n')); process.exit(code); };

// A group's name the way bash will hand it to group(): inside double quotes a backslash
// escapes only $ ` " \ and is otherwise literal, which is what `\$TMUX` and `$'\\x1f'` rely on.
function dq(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') return out;
    if (c === '\\' && '$`"\\'.includes(src[i + 1])) { out += src[++i]; continue; }
    out += c;
  }
  return null;
}

// The same segmentation cf_only does in awk: a group is a `group "` line at column 0 and runs
// to the line before the next one; the summary is the epilogue marker and everything after it.
export function segment(file = SUITE) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const groups = [];
  let epi = -1;
  lines.forEach((l, i) => {
    // Below the marker a group would run in EVERY shard, as part of the epilogue.
    if (epi >= 0) { if (/^group "/.test(l)) die(`run.sh:${i + 1}: a group below the epilogue marker`, 4); return; }
    if (/^# ── epilogue/.test(l)) { epi = i; return; }
    if (/^group "/.test(l)) {
      const name = dq(l.slice('group "'.length));
      if (name === null) die(`run.sh:${i + 1}: cannot read this group's name`);
      groups.push({ n: groups.length + 1, name, start: i, needs: [] });
    } else if (/^# needs: /.test(l) && groups.length) {
      groups[groups.length - 1].needs.push(l.slice('# needs: '.length));
    }
  });
  if (epi < 0 || !groups.length) die('cannot segment run.sh: no groups, or no "# ── epilogue" marker', 4);
  groups.forEach((g, k) => { g.end = (k + 1 < groups.length ? groups[k + 1].start : epi); });
  return { lines, groups, epi };
}

const parses = (text) => spawnSync('bash', ['-n'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;

// Units: runs of groups that parse only together, then joined across every `# needs:` edge.
export function units({ lines, groups }) {
  const parent = groups.map((_, k) => k);
  const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (let k = 0; k < groups.length;) {
    let j = k;
    while (!parses(lines.slice(groups[k].start, groups[j].end).join('\n'))) {
      if (++j >= groups.length) die(`run.sh: the groups from "${groups[k].name}" to the end do not parse`, 4);
    }
    for (let m = k + 1; m <= j; m++) join(k, m);
    k = j + 1;
  }
  // The need is matched the way cf_only matches it, as a substring of the provider's name.
  groups.forEach((g, k) => {
    for (const need of g.needs) {
      const prov = groups.findIndex((p) => p.name.includes(need));
      if (prov < 0) die(`run.sh: "${g.name}" needs "${need}", which no group is called`, 4);
      groups.forEach((p, m) => { if (p.name.includes(need)) join(k, m); });
    }
  });
  const by = new Map();
  groups.forEach((g, k) => { const r = find(k); if (!by.has(r)) by.set(r, []); by.get(r).push(g); });
  return [...by.values()];
}

export function readTimes(file = TIMES) {
  const t = new Map();
  if (!fs.existsSync(file)) return t;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l || l.startsWith('#')) continue;
    const tab = l.indexOf('\t');
    const s = Number(l.slice(0, tab));
    if (tab > 0 && Number.isFinite(s)) t.set(l.slice(tab + 1), s);
  }
  return t;
}

export function plan(N, seg = segment(), times = readTimes()) {
  if (!(Number.isInteger(N) && N >= 1)) die(`a shard count is a whole number of at least 1, not "${N}"`);
  const known = [...times.values()].sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const us = units(seg).map((gs) => ({ gs, w: gs.reduce((s, g) => s + (times.has(g.name) ? times.get(g.name) : median), 0) }));
  us.sort((a, b) => b.w - a.w || a.gs[0].n - b.gs[0].n);
  const shards = Array.from({ length: N }, () => ({ w: 0, gs: [] }));
  for (const u of us) {
    let best = 0;
    for (let i = 1; i < N; i++) if (shards[i].w < shards[best].w) best = i;
    shards[best].w += u.w;
    shards[best].gs.push(...u.gs);
  }
  for (const s of shards) s.gs.sort((a, b) => a.n - b.n);
  return { shards, median, unknown: seg.groups.filter((g) => !times.has(g.name)).map((g) => g.name) };
}

// A shard's record: one `<seconds>\t<group>` line per group() call, then `<seconds>\t#end`.
function readRan(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    return { t: Number(l.slice(0, tab)), name: l.slice(tab + 1) };
  });
}

const [cmd, ...args] = process.argv.slice(2);
const shardArgs = () => {
  const i = Number(args[0]), N = Number(args[1]);
  if (!(Number.isInteger(N) && N >= 1 && Number.isInteger(i) && i >= 1 && i <= N)) die(`a shard is i/N with 1 <= i <= N, not "${args[0]}/${args[1]}"`);
  return { i, N };
};

if (cmd === 'pick') {
  const { i, N } = shardArgs();
  for (const g of plan(N).shards[i - 1].gs) console.log(g.n);
} else if (cmd === 'plan') {
  const N = Number(args[0]);
  const p = plan(N);
  p.shards.forEach((s, k) => {
    console.log(`shard ${k + 1}/${N}  ~${Math.round(s.w)}s  ${s.gs.length} groups`);
    for (const g of s.gs) console.log(`  ${String(g.n).padStart(3)}  ${g.name}`);
  });
  for (const u of units(segment()).filter((gs) => gs.length > 1))
    console.log(`\nkept together (${u.length}): ${u.map((g) => g.n).join(' ')}`);
  if (p.unknown.length) console.log(`\nnot in the timing table, charged the median ${p.median}s: ${p.unknown.join(' | ')}`);
} else if (cmd === 'names') {
  for (const g of segment().groups) console.log(g.name);
} else if (cmd === 'check') {
  // THE PARTITION, AND THAT EACH PART RUNS. Every group in exactly one shard, every shard's
  // extract passing the same gates cf_only applies before it execs — so a plan that would be
  // refused, or would parse badly, is red here rather than one red shard among four.
  const N = Number(args[0]);
  const seg = segment();
  const p = plan(N, seg);
  const seen = new Map();
  p.shards.forEach((s, k) => s.gs.forEach((g) => seen.set(g.n, [...(seen.get(g.n) || []), k + 1])));
  const bad = [];
  for (const g of seg.groups) {
    const at = seen.get(g.n) || [];
    if (at.length !== 1) bad.push(`"${g.name}" is in ${at.length ? 'shards ' + at.join(', ') : 'no shard'}`);
  }
  p.shards.forEach((s, k) => {
    const names = s.gs.map((g) => g.name);
    for (const g of s.gs) for (const need of g.needs)
      if (!names.some((nm) => nm.includes(need))) bad.push(`shard ${k + 1}: "${g.name}" needs "${need}", which is in another shard`);
    const text = [...seg.lines.slice(0, seg.groups[0].start), ...s.gs.flatMap((g) => seg.lines.slice(g.start, g.end)), ...seg.lines.slice(seg.epi)].join('\n');
    if (s.gs.length && !parses(text)) bad.push(`shard ${k + 1}: its extract does not parse`);
  });
  const ws = p.shards.map((s) => Math.round(s.w));
  if (bad.length) die(`the ${N}-shard plan does not cover the suite:\n  ${bad.join('\n  ')}`, 1);
  console.log(`${seg.groups.length} groups in ${N} shards, each exactly once; estimated seconds ${ws.join(' / ')}`);
} else if (cmd === 'cover') {
  // WHAT RAN, NOT WHAT WAS PLANNED. A shard that exits 0 having stopped half way — a bash
  // that died on a construct, an `exit` somebody left in a group — passes every check about
  // the plan. So each shard records the group() calls it made, and this compares those against
  // the plan: every group exactly once across the shards, and each in the shard meant to run it.
  //   Only column-0 groups are counted. Three group() calls sit indented inside other groups and
  //   are part of their segment; they come and go with it.
  const N = Number(args[0]);
  const files = args.slice(1);
  if (files.length !== N) die(`cover: ${N} shards but ${files.length} records — a shard that left no record is a shard that did not run`, 1);
  const seg = segment();
  const p = plan(N, seg);
  const top = new Set(seg.groups.map((g) => g.name));
  const count = new Map();
  const bad = [];
  files.forEach((f, k) => {
    const ran = readRan(f).filter((r) => top.has(r.name)).map((r) => r.name);
    for (const nm of ran) count.set(nm, (count.get(nm) || 0) + 1);
    const want = p.shards[k].gs.map((g) => g.name);
    const got = new Set(ran);
    for (const nm of want) if (!got.has(nm)) bad.push(`shard ${k + 1} did not run "${nm}"`);
    for (const nm of got) if (!want.includes(nm)) bad.push(`shard ${k + 1} ran "${nm}", which the plan gives another shard`);
    if (!readRan(f).some((r) => r.name === '#end')) bad.push(`shard ${k + 1} never reached the summary`);
  });
  for (const g of seg.groups) {
    const c = count.get(g.name) || 0;
    if (c !== 1) bad.push(`"${g.name}" ran ${c} times across the shards`);
  }
  if (bad.length) die(`the shards did not run the suite:\n  ${bad.join('\n  ')}`, 1);
  console.log(`${seg.groups.length} groups, each run exactly once across ${N} shards`);
} else if (cmd === 'times') {
  // Seconds per group from shard records: the gap to the next record. Where several records
  // name a group (two platforms), the slower one is kept — a shard is balanced for the runner
  // that would otherwise finish last.
  //   The gap is to the next COLUMN-0 group: an indented group() inside a segment is part of it.
  const top = new Set(segment().groups.map((g) => g.name));
  const t = new Map();
  for (const f of args) {
    const r = readRan(f).filter((x) => top.has(x.name) || x.name === '#end');
    for (let k = 0; k + 1 < r.length; k++) {
      if (r[k].name === '#end') continue;
      t.set(r[k].name, Math.max(t.get(r[k].name) || 0, r[k + 1].t - r[k].t));
    }
  }
  const order = [...top].filter((nm) => t.has(nm));
  console.log('# seconds<TAB>group — read by test/helpers/shard-plan.mjs. Regenerate with `shard-plan.mjs times`.');
  for (const nm of order) console.log(`${t.get(nm)}\t${nm}`);
} else {
  die('usage: shard-plan.mjs pick <i> <N> | plan <N> | check <N> | names | cover <N> <ran>... | times <ran>...');
}
