// server/usage-ledger.mjs — who spent how many tokens, and the cap that stops them (contract §4).
//
// Claude Code writes every API call of a session into its transcript, with the usage the API
// reported. This reads those transcripts FORWARD from a byte cursor kept per file, groups the
// calls into turns (a turn opens on a prompt a person or a lead sent), and appends one row per
// turn to GFW_DATA/usage.jsonl. The transcript says that someone typed the prompt, not who:
// the activity log does, so a turn goes to whoever sent the prompt that opened it.
//
// Counting once is the whole job, and there are two ways to count twice:
// - Claude Code writes ONE assistant line per content block, and every one of them repeats
//   the whole message's usage (measured: a message with three blocks is three lines with the
//   same message.id and identical numbers). So calls are deduplicated by message.id.
// - A scan that reads a turn still in progress would write it, and the next scan would write
//   it again with more calls in it. So the cursor only moves past CLOSED turns — closed by the
//   next prompt, or by the file going quiet — and the open one is reread next time. Each row
//   also carries the id of the prompt line that opened it, and a row whose id is already in
//   the ledger is never written again: a crash between the append and the cursor write, or a
//   transcript that got truncated and is read from 0, costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { t, locale } from '../shared/i18n/index.js';

// ── what a token costs, in dollars per million — ESTIMATE, the one place prices live ─────
// Anthropic's first-party API list prices as cached on 2026-10-06. Cache writes are the 5-minute
// rate (1.25× input); a cache read not published separately is 0.1× input. A model that is not
// here is priced by its family (the name contains opus/sonnet/haiku/fable), and the panel says
// "estimate" next to every figure: a subscription is a flat fee and this is not a bill.
export const PRICES_AS_OF = '2026-10-06';
export const PRICES = {
  'claude-fable-5-1':  { input: 10,   output: 50,   cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5':    { input: 10,   output: 50,   cacheRead: 1,    cacheWrite: 12.5 },
  'claude-opus-5-5':   { input: 4,    output: 20,   cacheRead: 0.2,  cacheWrite: 5 },
  'claude-opus-5':     { input: 5,    output: 25,   cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-opus-4-8':   { input: 5,    output: 25,   cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-opus-4-7':   { input: 5,    output: 25,   cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-opus-4-6':   { input: 5,    output: 25,   cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2,    output: 10,   cacheRead: 0.2,  cacheWrite: 2.5 },
  'claude-sonnet-5':   { input: 2,    output: 10,   cacheRead: 0.2,  cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-5-5':  { input: 0.1,  output: 0.5,  cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5':  { input: 1,    output: 5,    cacheRead: 0.1,  cacheWrite: 1.25 },
};
const FAMILY = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
export function priceOf(model) {
  const m = String(model || '').toLowerCase().replace(/^(anthropic\.|us\.anthropic\.)/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  if (PRICES[m]) return PRICES[m];
  const fam = Object.keys(FAMILY).find(f => m.includes(f));
  return fam ? PRICES[FAMILY[fam]] : PRICES[FAMILY.opus];
}
export const dollars = (r) => {
  const p = priceOf(r.model);
  return (r.input * p.input + r.output * p.output + r.cacheRead * p.cacheRead + r.cacheWrite * p.cacheWrite) / 1e6;
};

// What a cap counts. Cache READS are left out: a long session rereads its whole context on
// every call, ~80k tokens a call measured, so counting them would put a 2M daily cap at about
// 25 tool calls — and they are the cheap part (a tenth of input). Everything Claude was sent
// fresh, wrote to cache or wrote back is in.
export const capTokens = (r) => (r.input || 0) + (r.output || 0) + (r.cacheWrite || 0);

// ── reading a transcript ────────────────────────────────────────────────────────────────
const isPrompt = (j) => {
  if (j.type !== 'user' || j.isMeta || j.isSidechain) return false;
  const c = j.message?.content;
  if (typeof c === 'string') return c.trim() !== '';
  return Array.isArray(c) && c.length > 0 && !c.some(b => b?.type === 'tool_result');
};
const promptText = (j) => {
  const c = j.message?.content;
  if (typeof c === 'string') return c;
  return (c || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
};

// `text` is the transcript from byte `base` on. Returns the turns that are closed and the
// byte offset the next read starts from (the start of the turn still open, if any). A turn
// counts as closed when another prompt follows it, or when `quiet` says the file has stopped.
// A turn closed by quiet can go on afterwards (a test run that took ten minutes): the calls
// that arrive before the next prompt become a continuation of `carry` — the turn closed last —
// with an id of their own, so they are counted once and go to the same person.
export function readTurns(text, { base = 0, quiet = false, carry = null } = {}) {
  const turns = [];
  let cur = null, pos = 0, bytes = 0, next = base, last = carry;
  const open = (id, ts, prompt) => ({ id, ts, prompt, model: null, calls: new Map() });
  const close = () => {
    if (cur && cur.calls.size) {
      const t = { id: cur.id, ts: cur.ts, prompt: cur.prompt, model: cur.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const u of cur.calls.values()) {
        t.input += u.input_tokens || 0; t.output += u.output_tokens || 0;
        t.cacheRead += u.cache_read_input_tokens || 0; t.cacheWrite += u.cache_creation_input_tokens || 0;
      }
      turns.push(t);
    }
    if (cur) last = { id: cur.id.split('+')[0], ts: cur.ts, prompt: cur.prompt };
    cur = null;
  };
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;                                    // a half-written last line: next time
    const line = text.slice(pos, nl), at = base + bytes;
    pos = nl + 1; bytes += Buffer.byteLength(line) + 1;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (isPrompt(j)) {
      close();
      next = at;
      cur = open(j.uuid || `${at}`, Math.floor(Date.parse(j.timestamp) / 1000) || 0, promptText(j));
    } else if (j.type === 'assistant' && !j.isSidechain && j.message?.usage) {
      if (!cur && last) { next = at; cur = open(`${last.id}+${at}`, Math.floor(Date.parse(j.timestamp) / 1000) || last.ts, last.prompt); }
      if (!cur) continue;                                 // calls before any prompt we know of
      const id = j.message.id || j.requestId || j.uuid;
      if (j.message.model && j.message.model !== '<synthetic>') cur.model = j.message.model;
      cur.calls.set(id, j.message.usage);                 // the last line of a message wins
    }
  }
  const consumed = base + bytes;
  if (quiet) { close(); next = consumed; }
  else if (!cur) next = consumed;
  return { turns, next, carry: last };
}

// ── who asked for it ─────────────────────────────────────────────────────────────────────
// The prompt that opened the turn, matched against what perform() logged being sent to that
// session — the same head-of-text match /api/session uses to put a name on a message. The
// latest send at or before the turn wins, so "continue" sent by two people on two days goes
// to the right one. A turn nobody sent from the web (typed in the terminal, a worker's lead
// talking to it) goes to the session's owner, and failing that to nobody.
const head = (t) => String(t || '').trim().slice(0, 120);
const SENDS = new Set(['fleet_send', 'fleet_resume', 'fleet_spawn']);
export function attribute(turn, { project, session, activity, owners }) {
  const h = head(turn.prompt);
  let best = null;
  if (h) for (const r of activity) {
    if (r.project !== project || r.result !== 'ran' || !SENDS.has(r.verb) || r.subject !== session || !r.args?.prompt) continue;
    if (r.ts > turn.ts + 60) continue;
    const rh = head(r.args.prompt);
    if (!rh || !(h.startsWith(rh.slice(0, 120)) || rh.startsWith(h))) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  if (best) return { user: best.user, via: best.via || null };
  return { user: owners?.[`${project}/${session}`] || null, via: null };
}

// ── periods, in the server's local time ─────────────────────────────────────────────────
export function periodStarts(nowSec) {
  const d = new Date(nowSec * 1000);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const week = new Date(day); week.setDate(day.getDate() - ((day.getDay() + 6) % 7));   // Monday
  const month = new Date(d.getFullYear(), d.getMonth(), 1);
  return { day: day / 1000, week: week / 1000, month: month / 1000 };
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────
// sources(): [{ project, session, transcript }] — every transcript the fleet knows of.
// extraRows(): rows that are not in the file (the demo's pretend history).
// capOf(user): the cap that applies, or null.
const PROMPT_TOOLS = new Set(['fleet_send', 'fleet_resume', 'fleet_spawn', 'gfw_schedule']);
const QUIET = 300;                                        // seconds without a write: the turn is over

export function createLedger({ dir, sources = () => [], activity = () => [], owners = () => ({}),
                               users = () => [], capOf = (u) => u?.tokenCap || null, extraRows = () => [],
                               onRefuse = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  const LEDGER = path.join(dir, 'usage.jsonl'), CURSOR = path.join(dir, 'usage-cursor.json');
  let cursor = {}; try { cursor = JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch {}
  let rows = [];
  try { rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const ids = new Set(rows.map(r => r.id).filter(Boolean));

  function scan() {
    let added = 0;
    const act = activity();
    const own = owners();
    for (const s of sources()) {
      let st; try { st = fs.statSync(s.transcript); } catch { continue; }
      const c = cursor[s.transcript] || { offset: 0 };
      if (st.size < c.offset) c.offset = 0;              // rewritten or truncated: ids keep it honest
      const quiet = now() - Math.floor(st.mtimeMs / 1000) > QUIET;
      if (st.size === c.offset && !c.open) continue;
      if (st.size === c.offset && c.open && !quiet) continue;
      const fd = fs.openSync(s.transcript, 'r');
      let buf;
      try { buf = Buffer.alloc(st.size - c.offset); fs.readSync(fd, buf, 0, buf.length, c.offset); } finally { fs.closeSync(fd); }
      const { turns, next, carry } = readTurns(buf.toString('utf8'), { base: c.offset, quiet, carry: c.carry || null });
      for (const t of turns) {
        const id = `${path.basename(s.transcript, '.jsonl')}:${t.id}`;
        if (ids.has(id)) continue;
        const who = attribute(t, { project: s.project, session: s.session, activity: act, owners: own });
        const row = { ts: t.ts, user: who.user, project: s.project, session: s.session, model: t.model,
                      input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
                      id, ...(who.via ? { via: who.via } : {}) };
        fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n', { mode: 0o600 });
        rows.push(row); ids.add(id); added++;
      }
      // `carry` is the last turn closed BEFORE `next`, which is what a reread from there needs.
      cursor[s.transcript] = { offset: next, open: next < st.size, carry };
    }
    const tmp = `${CURSOR}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 }); fs.renameSync(tmp, CURSOR);
    return added;
  }
  const all = () => [...rows, ...extraRows()];

  // Spent so far, per user: { day, week, month } in cap tokens.
  function spent(userId, at = now()) {
    const p = periodStarts(at);
    const out = { day: 0, week: 0, month: 0 };
    for (const r of all()) {
      if (r.user !== userId || r.ts > at) continue;
      const n = capTokens(r);
      if (r.ts >= p.day) out.day += n;
      if (r.ts >= p.week) out.week += n;
      if (r.ts >= p.month) out.month += n;
    }
    return out;
  }

  // null when the user may go on; otherwise why not, in words for the person who clicked.
  function over(userId, at = now()) {
    const u = users().find(x => x.id === userId);
    const cap = capOf(u);
    if (!cap) return null;
    const s = spent(userId, at);
    const fmt = (n) => n.toLocaleString(locale());
    if (cap.daily && s.day >= cap.daily)
      return t('cap.daily', { used: fmt(s.day), cap: fmt(cap.daily) });
    if (cap.monthly && s.month >= cap.monthly)
      return t('cap.monthly', { used: fmt(s.month), cap: fmt(cap.monthly) });
    return null;
  }

  // The one call perform() makes. Throws (status 429) when this user may not start more work.
  function gate(userId, tool, { project, via } = {}) {
    if (!PROMPT_TOOLS.has(tool)) return;
    const why = over(userId);
    if (!why) return;
    onRefuse({ user: userId, verb: tool, project, why, via });
    throw Object.assign(new Error(why), { status: 429, capped: true });
  }

  // The admin panel: every user, their periods, their projects this month, and their cap.
  function report({ withDollars = false, at = now() } = {}) {
    const p = periodStarts(at);
    const list = users().map(u => {
      const mine = all().filter(r => r.user === u.id && r.ts <= at);
      const sum = (since) => {
        const o = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, usd: 0 };
        for (const r of mine) if (r.ts >= since) {
          o.tokens += capTokens(r); o.input += r.input; o.output += r.output; o.cacheRead += r.cacheRead;
          o.cacheWrite += r.cacheWrite; o.turns++; if (withDollars) o.usd += dollars(r);
        }
        if (!withDollars) delete o.usd;
        return o;
      };
      const byProject = {};
      for (const r of mine) if (r.ts >= p.month) {
        const b = byProject[r.project] ||= { project: r.project, tokens: 0, turns: 0, ...(withDollars ? { usd: 0 } : {}) };
        b.tokens += capTokens(r); b.turns++; if (withDollars) b.usd += dollars(r);
      }
      return { id: u.id, name: u.name, color: u.color, role: u.role || null, cap: capOf(u),
               today: sum(p.day), week: sum(p.week), month: sum(p.month),
               projects: Object.values(byProject).sort((a, b) => b.tokens - a.tokens), over: over(u.id, at) };
    });
    const unattributed = all().filter(r => !r.user && r.ts >= p.month).reduce((n, r) => n + capTokens(r), 0);
    return { at, users: list, unattributed, dollars: withDollars, pricesAsOf: PRICES_AS_OF };
  }

  return { scan, spent, over, gate, report, rows: all };
}

// ── a cap, as the admin typed it ────────────────────────────────────────────────────────
// Both empty is "no cap" (null, the contract's value), one empty is that period unlimited.
export function parseCap(b) {
  const n = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const x = Math.round(Number(v));
    if (!Number.isFinite(x) || x <= 0) throw Object.assign(new Error(t('cap.bad')), { status: 400 });
    return x;
  };
  const daily = n(b?.daily), monthly = n(b?.monthly);
  return daily || monthly ? { daily, monthly } : null;
}
