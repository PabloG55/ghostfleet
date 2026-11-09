// lib/context-meter.mjs — `fleet-meter --context`: where a fleet's model spend goes by the
// SIZE OF THE CONTEXT each call carried, and what started the turns that spent it.
//
// THE QUESTION IT ANSWERS is whether the context ceiling (lib/context-window.sh) worked. A
// call's cost is mostly its context re-read from the prompt cache, so the ceiling is meant
// to move spend out of the big buckets; run this over the weeks before and after
// (--since / --until) and the shift is either in the bucket table or it is not. Measured on
// one busy fleet before the ceiling: 54% of spend at 500k+ and 30% at 700k+.
//
// SAME RULES AS THE REST OF fleet-meter: COUNTS AND DIGESTS, NEVER CONTENT. Nothing below
// prints a message body, a path, a project directory or a branch. The only text read is a
// prompt's opening, to say what STARTED a turn, and that is a LABEL: it comes out under
// `labelled`, with each pattern's source and digest, so a reader who distrusts the rule can
// keep the half that does not depend on it — the bucket table is pure arithmetic on `usage`.
//
// WHAT IS A CALL. Claude Code writes one record per content block and repeats the message's
// `usage` on each, so a call is a distinct message id, counted once. ACROSS THE CORPUS, not
// per file: a forked session copies its parent's history, ids included, and counting the
// copy would bill one call twice. Subagent transcripts (<session>/subagents/*.jsonl) are
// real spend and are read; their calls fill the buckets and are reported as their own row,
// since the turn that started them is the parent's and is not joined here.
//
// THE PRICE is list price per million tokens, from the model table cached 2026-10-06, with
// cache writes at the standard 1.25x (5m) and 2x (1h) of input. It only has to be right
// RELATIVE to itself — the report is shares — and --json carries the raw token counts per
// bucket, so a reader with other prices can re-weight. A model not in the table is counted
// and reported as unpriced, never priced as something else.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const SALT = 'ghostfleet-meter-v1:';
const digest = (s) => crypto.createHash('sha256').update(SALT + String(s)).digest('hex').slice(0, 12);

// [prefix, input, output, cacheRead] in USD per million tokens. Longest prefix wins, so
// claude-fable-5-1 is not read as claude-fable-5.
const PRICES = [
  ['claude-fable-5-1', 10, 50, 0.25], ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1.0],
  ['claude-opus-5-5', 4, 20, 0.2], ['claude-opus-5', 5, 25, 0.5], ['claude-opus-4', 5, 25, 0.5],
  ['claude-sonnet-5-5', 2, 10, 0.2], ['claude-sonnet-5', 2, 10, 0.2], ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01], ['claude-haiku-4', 1, 5, 0.1],
].sort((a, b) => b[0].length - a[0].length);
// Haiku 5.5 is priced by prompt size: above 100k tokens it is 5x. Exactly the axis this
// report is about, so it is applied rather than averaged away.
const TIERED = { 'claude-haiku-5-5': { over: 100_000, mult: 5 } };

export function priceOf(model) {
  const m = String(model || '').toLowerCase();
  return PRICES.find(([p]) => m.startsWith(p)) || null;
}

// What one call cost, in USD. null when the model is not priced.
export function costOf(model, u, ctx) {
  const p = priceOf(model);
  if (!p) return null;
  let [, inp, out, read] = p;
  const t = TIERED[p[0]];
  if (t && ctx > t.over) { inp *= t.mult; out *= t.mult; read *= t.mult; }
  const cc = u.cache_creation || {};
  const w1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  const w5m = cc.ephemeral_5m_input_tokens !== undefined
    ? Number(cc.ephemeral_5m_input_tokens) || 0
    : Math.max(0, (Number(u.cache_creation_input_tokens) || 0) - w1h);
  return ((Number(u.input_tokens) || 0) * inp + w5m * inp * 1.25 + w1h * inp * 2
    + (Number(u.cache_read_input_tokens) || 0) * read + (Number(u.output_tokens) || 0) * out) / 1e6;
}

// The context a call carried: everything it sent, cached or not.
export const contextOf = (u) => (Number(u.input_tokens) || 0)
  + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);

export const BUCKETS = [
  ['<200k', 200_000], ['200-300k', 300_000], ['300-500k', 500_000], ['500-700k', 700_000], ['>=700k', Infinity],
];
export const bucketOf = (ctx) => BUCKETS.find(([, hi]) => ctx < hi)[0];

// ── what started a turn (LABELLED) ──────────────────────────────────────────
// Ordered: the first that matches names the trigger. Read against the prompt with the
// harness's own <system-reminder> blocks removed and the plugin wrapper unwrapped — the
// ledger gate arrives as "The ghostfleet plugin sent a message: [ghostfleet ledger] …".
// `person` is what is left, which is the honest direction to err in: a machine prompt this
// list does not know yet is counted as a person, and shows up as one.
export const TRIGGERS = [
  ['ledger-gate',       /^\[ghostfleet ledger\]/],
  ['fleet-nudge',       /^\[fleet\]/],
  ['task-notification', /^<task-notification>/],
  // Not a prompt anyone sent: an interrupt marker, the output of a `!` command, the summary
  // a compaction leaves. Rarely followed by a call, so rarely a turn at all.
  ['harness',           /^(?:\[Request interrupted|<(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>)/],
  ['other-plugin',      /^The [\w .-]+ plugin sent a message:/],
];
const PLUGIN_WRAP = /^The ghostfleet plugin sent a message:\s*/;
const stripReminders = (t) => String(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');

const promptText = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
};

export function triggerOf(record) {
  if (record.isCompactSummary === true) return 'harness';
  const t = stripReminders(promptText(record.message)).trimStart().replace(PLUGIN_WRAP, '');
  for (const [name, re] of TRIGGERS) if (re.test(t)) return name;
  return 'person';
}

const isToolResult = (m) => Array.isArray(m?.content) && m.content.some((b) => b && b.type === 'tool_result');

// ── reading ─────────────────────────────────────────────────────────────────
export function corpusFiles(root) {
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(root, d);
    let fl = []; try { if (!fs.statSync(p).isDirectory()) continue; fl = fs.readdirSync(p); } catch { continue; }
    for (const f of fl) {
      if (f.endsWith('.jsonl')) { out.push({ file: path.join(p, f), sub: false }); continue; }
      const sub = path.join(p, f, 'subagents');
      try { for (const s of fs.readdirSync(sub)) if (s.endsWith('.jsonl')) out.push({ file: path.join(sub, s), sub: true }); } catch {}
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

const emptyBucket = () => ({ calls: 0, usd: 0, context_tokens: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 });

export async function measure(root, { since = null, until = null } = {}) {
  const seen = new Set();
  const buckets = Object.fromEntries(BUCKETS.map(([b]) => [b, emptyBucket()]));
  const byTrigger = {};
  const trig = (k) => (byTrigger[k] ??= { turns: 0, calls: 0, usd: 0 });
  const compactions = {};
  const sizes = [];
  let files = 0, subFiles = 0, bad = 0, unpriced = 0, unpricedTokens = 0, duplicates = 0;
  const unpricedModels = new Set();
  const inRange = (ts) => (!since || (ts && ts >= since)) && (!until || (ts && ts < until));

  for (const { file, sub } of corpusFiles(root)) {
    files++; if (sub) subFiles++;
    let turn = null;            // { trigger, counted }
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { bad++; continue; }
      // A compaction leaves a boundary record carrying what started it and the size it cut
      // from. Both are counts and an enum, so they are reported: a ceiling that works shows
      // up here as compactions from ~250k instead of ~965k.
      if (r.type === 'system' && r.subtype === 'compact_boundary' && inRange(r.timestamp)) {
        const md = r.compactMetadata || {};
        const k = /^[a-z_-]{1,24}$/.test(String(md.trigger || '')) ? md.trigger : 'other';
        const c = (compactions[k] ??= { count: 0, pre_tokens: [] });
        c.count++; if (Number.isFinite(Number(md.preTokens))) c.pre_tokens.push(Number(md.preTokens));
        continue;
      }
      if (r.type === 'user') {
        if (sub || r.isSidechain === true || r.isMeta === true || isToolResult(r.message)) continue;
        turn = { trigger: triggerOf(r), counted: false };
        continue;
      }
      if (r.type !== 'assistant') continue;
      const u = r.message?.usage, mid = r.message?.id;
      if (!u || !mid || r.message?.model === '<synthetic>') continue;
      const key = `${mid}\x1f${r.requestId || ''}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      if (!inRange(r.timestamp)) continue;
      const ctx = contextOf(u);
      const usd = costOf(r.message.model, u, ctx);
      const b = buckets[bucketOf(ctx)];
      b.calls++; b.context_tokens += ctx;
      b.input += Number(u.input_tokens) || 0; b.cache_read += Number(u.cache_read_input_tokens) || 0;
      b.cache_write += Number(u.cache_creation_input_tokens) || 0; b.output += Number(u.output_tokens) || 0;
      sizes.push(ctx);
      if (usd === null) { unpriced++; unpricedTokens += ctx; unpricedModels.add(digest(r.message.model)); }
      else b.usd += usd;
      const who = (sub || r.isSidechain === true) ? 'subagent' : turn ? turn.trigger : 'no-prompt';
      const t = trig(who);
      if (who !== 'subagent' && turn && !turn.counted) { t.turns++; turn.counted = true; }
      t.calls++; if (usd !== null) t.usd += usd;
    }
  }

  const total = Object.values(buckets).reduce((a, b) => a + b.usd, 0);
  const calls = Object.values(buckets).reduce((a, b) => a + b.calls, 0);
  const r3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : null);
  sizes.sort((a, b) => a - b);
  const pct = (q) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] : 0);
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {
    corpus: { files, subagent_files: subFiles, unparsable_lines: bad, duplicate_records_skipped: duplicates,
              since, until },
    observed: {
      calls, usd: r3(total),
      context_per_call: { mean: calls ? Math.round(sizes.reduce((a, b) => a + b, 0) / calls) : 0,
                          median: pct(0.5), p90: pct(0.9), max: sizes.length ? sizes[sizes.length - 1] : 0 },
      buckets: Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, {
        ...b, usd: r3(b.usd), share_of_spend: total ? r3(b.usd / total) : 0, share_of_calls: calls ? r3(b.calls / calls) : 0 }])),
      compactions: Object.fromEntries(Object.entries(compactions).map(([k, c]) => [k, {
        count: c.count, pre_tokens_median: median(c.pre_tokens), pre_tokens_max: c.pre_tokens.length ? Math.max(...c.pre_tokens) : null }])),
      unpriced: { calls: unpriced, context_tokens: unpricedTokens, models: [...unpricedModels].sort() },
      prices: { source: 'list prices per MTok, model table cached 2026-10-06; cache write 1.25x (5m) / 2x (1h) of input',
                table: PRICES.map(([p, i, o, rd]) => ({ model_prefix: p, input: i, output: o, cache_read: rd })) },
    },
    labelled: {
      // Turns and spend by what started them. `subagent` and `no-prompt` are not triggers a
      // rule chose — they are where a call sat — and are kept so the spend column adds up.
      by_trigger: Object.fromEntries(Object.entries(byTrigger).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, {
        turns: v.turns, calls: v.calls, usd: r3(v.usd), share_of_spend: total ? r3(v.usd / total) : 0 }])),
      rules: Object.fromEntries(TRIGGERS.map(([k, re]) => [k, { source: re.source, digest: digest(re.source) }])),
    },
  };
}

export function render(rep) {
  const o = rep.observed, l = rep.labelled, c = rep.corpus;
  const pc = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
  const k = (n) => `${Math.round(n / 1000)}k`;
  const lines = [];
  lines.push(`context  ${c.files} transcripts (${c.subagent_files} subagent)  ${o.calls} calls  $${o.usd} at list price`
    + (c.since || c.until ? `  window ${c.since || '…'} → ${c.until || 'now'}` : ''));
  lines.push(`         context per call: mean ${k(o.context_per_call.mean)}  median ${k(o.context_per_call.median)}  p90 ${k(o.context_per_call.p90)}  max ${k(o.context_per_call.max)}`);
  lines.push('\nspend by context size  — observed, arithmetic on usage');
  lines.push(`  ${'bucket'.padEnd(10)}${'spend'.padStart(7)}${'calls'.padStart(7)}${'calls n'.padStart(9)}${'usd'.padStart(12)}`);
  for (const [b, v] of Object.entries(o.buckets))
    lines.push(`  ${b.padEnd(10)}${pc(v.share_of_spend)}${pc(v.share_of_calls)}${String(v.calls).padStart(9)}${('$' + v.usd).padStart(12)}`);
  if (o.unpriced.calls) lines.push(`  unpriced: ${o.unpriced.calls} calls on ${o.unpriced.models.length} model(s) not in the price table — in the call counts, not in spend`);
  const comp = Object.entries(o.compactions);
  lines.push('\ncompactions  — observed');
  if (!comp.length) lines.push('  none in this window');
  for (const [t, v] of comp) lines.push(`  ${t.padEnd(10)}${String(v.count).padStart(6)}   from median ${v.pre_tokens_median === null ? '-' : k(v.pre_tokens_median)}  max ${v.pre_tokens_max === null ? '-' : k(v.pre_tokens_max)}`);
  lines.push('\nturns by what started them  — labelled; see labelled.rules');
  lines.push(`  ${'trigger'.padEnd(19)}${'turns'.padStart(7)}${'calls'.padStart(8)}${'spend'.padStart(8)}`);
  for (const [t, v] of Object.entries(l.by_trigger))
    lines.push(`  ${t.padEnd(19)}${String(v.turns).padStart(7)}${String(v.calls).padStart(8)}${pc(v.share_of_spend).padStart(8)}`);
  return lines.join('\n');
}
