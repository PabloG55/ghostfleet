// lib/know-recall.mjs — the owner's words, matched against the fleet's memory, for a lead's turn.
//
// THE FAILURE THIS IS FOR. A lead compacted a hundred times over kept "run the 80 items" and lost
// the reason, then recommended cancelling work it had planned itself, while `fleet-know find
// <word>` would have returned the reason in one call. Nothing made it look: a briefing is read at
// the start and after a compaction, and fleet_know is read when a lead thinks to ask. So the owner's
// own message is the question. Each one a lead receives is searched here, and the few best matches
// ride into that turn's context. It does not depend on the lead remembering anything, so it
// survives a compaction.
//
// SEARCHED THE WAY `find` SEARCHES (lib/know.mjs): the raw events, not the graph, case-insensitive
// words, every profile's log on this machine and what paired machines sent, locally, and no model
// call. Two differences, both because the query is a sentence and not a word someone chose:
//   - Not every word has to match. A sentence of twelve words matches nothing whole. Each word is
//     weighted by how rare it is in the log, so "renewals" counts for more than "read", and a line
//     has to match two of the owner's words (one, when only one is in the log at all), at least
//     one of them a rare one and at least one of them a word: a number alone ("80") is in a
//     worker's name, a PR, a count, and says nothing by itself.
//   - Only what somebody said or meant is searched: the text of a decision, a rule, a fact, a
//     brief, its why, an ack, a turn's last words, a ledger item. A session starting on a branch
//     whose name has the word in it is not a match.
// Ranked by kind as well as by words: the owner's decision before a worker's passing mention.
//
// PRIVACY IS find's, plus one rule. An excluded project's events never show. A private project's
// show marked, with the note the briefing carries, to a Claude lead. A lead on any other agent
// (codex, opencode…) gets none of them: putting them in its context IS pasting them into a prompt
// for another model vendor.
//
// BOUNDED TWICE. At most RECALL_ROWS rows, each clipped, under RECALL_CAP characters in all, cut by
// whole rows. And the hook holds the whole call to a budget from outside (hooks/fleet-event.sh), so
// a log too big to read in time costs the lead nothing but the recall.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as K from './know.mjs';

export const RECALL_CAP = 1200;
export const RECALL_ROWS = 4;
const ROW_TEXT = 220;
const MAX_TERMS = 24;
// RARE grows with the log, but slower than it: a topic is talked about in a few dozen lines
// whatever the log's size, while a word of the fleet's own vocabulary ("suite", "branch") is in a
// fixed share of every line. So the bound is the square root, with a floor for a young log.
const rareCap = (n) => Math.max(8, 2 * Math.sqrt(n));
// On a log this long, a word that has already proved common stops letting its lines through to the
// parse on its own (see `keep` below). Under it, every line that holds a word is parsed: cheap.
const ADAPT_LINES = 20000;
const scanLog = (file, visit, keep) => K.scanLog(file, 0, visit, keep);

// ── whose words these are ────────────────────────────────────────────────────
// Every delivery the fleet makes into a session (bin/fleet-send's three paths, bin/fleet-schedule's
// paste) leaves a mark first: <fleet dir>/<sock>.<session>.from/<ms>.<digest>.<kind>. The kind is
// the handoff's (brief, nudge, owner, explain), and `owner` is a sender that authenticated the
// owner's words: the phone, Telegram, a `fleet-send --owner`. A prompt whose words match a mark was
// delivered, and is the owner's only when the mark says so. A prompt with no mark was typed into
// the session. Matched by digest and not by time, because a queued delivery can arrive minutes
// after it was sent; taken when matched, so a second identical delivery has a mark of its own.
export const FROM_KINDS = ['brief', 'nudge', 'owner', 'explain'];
const KEEP_MARK_MS = 24 * 3600e3;
// A mark this fresh whose words did not match is a delivery whose text changed on the way in. The
// prompt is then not called the owner's: the cost of that is one turn with no recall, and the cost
// of the other reading is a lead told that a fleet message was the owner speaking.
const FRESH_MARK_MS = 30e3;
export const fromDir = (fleetDir, sock, session) => path.join(fleetDir, `${sock}.${session}.from`);
// The digest both sides compute. Whitespace is folded and the ends trimmed by ONE space each, which
// is exactly what bin/fleet-send's `tr -s` and two parameter expansions do, so a paste whose line
// endings or trailing newline changed on the way still matches.
export const normalized = (t) => String(t ?? '').replace(/[ \t\r\n]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
export const digest12 = (t) => crypto.createHash('sha256').update(normalized(t)).digest('hex').slice(0, 12);
// The fleet's own words, and Claude Code's: every relay, nudge and agent preamble starts with
// [fleet], an injected turn with `<`, and a slash command is not a sentence anybody meant to search.
const MACHINE = /^(\[fleet\]|<|\/)/;
const TELEGRAM = /^\[telegram\]\s*/i;
// THE QUEUED-WORK LABEL fleet-send puts in front of a send that joins a busy codex turn (bin/fleet-send
// _lbl): the fleet's one line, a blank line, then the sender's words, after a `[telegram] ` if there
// was one. Whose words those are is the mark's to say; what they ask is the part under the label.
const JOIN_LABEL = /^(\[telegram\] )?\[fleet\] This message arrived while you were still working[^\n]*\n[ \t]*\n/;
export const unlabelled = (prompt) => String(prompt ?? '').trimStart().replace(JOIN_LABEL, '$1');

export function whoSent({ prompt, fleetDir, sock, session, now = Date.now() }) {
  const s = String(prompt ?? '').trimStart();
  if (!s.trim()) return { who: 'none', why: 'no words' };
  // The mark first, the prefix after it: a delivery the fleet labelled is still whoever sent it.
  // The owner's words joining a busy codex turn arrive under `[fleet] This message arrived…`, and
  // read by the prefix alone they were the fleet's, with their owner mark left lying for the
  // next typed prompt to be mistaken by (a fresh mark that matches nothing reads as the fleet).
  const dir = sock && session ? fromDir(fleetDir, sock, session) : '';
  let names = [];
  if (dir) { try { names = fs.readdirSync(dir); } catch {} }
  const dig = names.length ? digest12(s) : '';
  let hit = null, fresh = false;
  for (const n of names) {
    const m = /^(\d+)\.([0-9a-f]{12})\.([a-z]+)$/.exec(n);
    if (!m) continue;
    const ms = Number(m[1]), age = now - ms;
    if (age > KEEP_MARK_MS) { try { fs.unlinkSync(path.join(dir, n)); } catch {} continue; }
    if (m[2] === dig) { if (!hit || ms < hit.ms) hit = { n, ms, kind: m[3] }; }
    else if (age < FRESH_MARK_MS) fresh = true;
  }
  if (hit) {
    try { fs.unlinkSync(path.join(dir, hit.n)); } catch {}
    return hit.kind === 'owner' ? { who: 'owner', why: 'delivered as the owner\'s' } : { who: 'fleet', why: `delivered by the fleet (${hit.kind})` };
  }
  if (MACHINE.test(s)) return { who: 'fleet', why: 'the fleet\'s own prefix' };
  if (TELEGRAM.test(s)) return { who: 'owner', why: 'telegram' };
  if (fresh) return { who: 'fleet', why: 'a delivery landed just now and its words did not match' };
  return { who: 'owner', why: 'typed' };
}

// ── the owner's words, as search terms ──────────────────────────────────────
// English and Spanish, because the owner writes in both, and the words a message to a lead is made
// of whatever it is about ("can you", "please", "check"). A word under three letters says nothing,
// unless it is a number of two digits or more: "the 80 renewals" is the kind of sentence this is for.
const STOP = new Set(`
a about above after again against all also am an and any are aren as at be because been before being below between both
but by can cannot could did didn do does doesn doing don done down during each else even ever every few for from
further get gets getting got had has hasn have haven having he her here hers herself him himself his how i if in into
is isn it its itself just let lets like make me more most much must my myself no nor not now of off on once only or
other our ours ourselves out over own same she should so some still such than that the their theirs them themselves
then there these they this those through to too under until up upon very was wasn we were weren what when where which
while who whom why will with would you your yours yourself yourselves yes yeah yep okay ok sure thanks thank please pls
per via etc hey hi hello go going gonna want wanted wants need needs needed think thought know knew look looks see seen tell told
say said ask asked work working thing things stuff way one two also really right well back again maybe already
check checked keep let's lets whats what's it's that's there's i'm i've i'd you're we're they're can't won't don't
el la los las un una unos unas de del al a ante bajo con contra desde en entre hacia hasta para por segun sin sobre tras
y e o u ni que qué como cómo cuando cuándo donde dónde quien quién cual cuál porque por qué es son era fue ser estar
está están estoy estamos esta este esto estos estas ese esa eso esos esas lo le les se me te nos mi mis tu tus su sus
ya no si sí muy más mas pero también tambien hay haz has hace hacer puedes puede pueden quiero quieres favor gracias
bueno vale dale ok listo entonces ahora aquí aqui ahi allí alli todo todos toda todas algo nada eso
`.split(/\s+/).filter(Boolean));
// A light stem, so "renewals" finds "renewal" and "cancelling" finds "cancelled": matching is by
// substring, as find's is, so a shorter stem can only match more. Never below four letters.
const stem = (w) => {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};
export function terms(prompt) {
  const s = String(prompt ?? '').replace(TELEGRAM, '').toLowerCase();
  const out = [];
  for (const raw of s.split(/[^\p{L}\p{N}']+/u)) {
    const w = raw.replace(/^'+|'+$/g, '');
    if (!w || STOP.has(w)) continue;
    const num = /^\d+$/.test(w);
    if (num ? w.length < 2 : w.length < 3) continue;
    const t = num ? w : stem(w.replace(/'s$/, ''));
    if (t.length < (num ? 2 : 3) || STOP.has(t) || out.some(x => x.t === t)) continue;
    out.push({ t, num });
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

// ── what in an event is searched ─────────────────────────────────────────────
// What somebody said or meant, by field; and how much a match there is worth, by kind. A decision
// or a rule is what a lead is not to contradict; a brief and its why are the reason work exists;
// a turn's last words are where a reason is most often said once and never again, and also where
// most of the noise is.
const TEXT_FIELDS = ['text', 'why', 'task', 'understood', 'decisions', 'said', 'note', 'reason', 'proof', 'quote', 'key', 'value', 'title'];
const KIND_WEIGHT = {
  decision: 3, rule: 3, purpose: 3, spawn: 2.5, fact: 2, ack: 2, 'project.about': 2,
  'request.open': 1.5, prompt: 1.5, 'need-you': 1, retire: 1, 'turn.end': 1,
};
const REQUEST_AUTHORITY = { user: 'owner', fleet: 'lead', promise: 'worker' };
const textOf = (e) => {
  const f = e.f || {};
  const parts = [];
  for (const k of TEXT_FIELDS) if (typeof f[k] === 'string' && f[k]) parts.push(f[k]);
  return parts;
};

// A term matches by substring, as find's words do, and a number only as a whole number: "80" must
// not match "1980", or a commit hash.
const matcher = ({ t, num }) => {
  if (!num) return (hay) => hay.includes(t);
  const re = new RegExp(`(^|[^0-9])${t}([^0-9]|$)`);
  return (hay) => hay.includes(t) && re.test(hay);
};

// Every log this machine holds, as find reads them: each profile's own, and each paired machine's
// cache beside it. A tombstone is scoped to its own file.
function logs(env) {
  const out = [];
  for (const d of K.allFleetDirs(env)) {
    out.push({ file: path.join(d, K.LOG), machine: '' });
    let names = [];
    try { names = fs.readdirSync(path.join(d, K.PEERS_DIR)); } catch {}
    for (const n of names) if (n.endsWith('.jsonl')) out.push({ file: path.join(d, K.PEERS_DIR, n), machine: n.slice(0, -'.jsonl'.length) });
  }
  return out;
}

// The privacy of one event NOW: what it was marked when written, made stricter by the setting its
// profile has today (as modeReader in lib/know.mjs does for a project).
function modeReader(env) {
  const dirOf = new Map();
  for (const d of K.allFleetDirs(env)) if (!dirOf.has(K.profileOf(d, env))) dirOf.set(K.profileOf(d, env), d);
  const memo = new Map();
  return (e) => {
    const sock = (e.src && e.src.sock) || '';
    const k = `${e.profile}\0${sock}`;
    if (!memo.has(k)) { const d = dirOf.get(e.profile); memo.set(k, d ? K.privacyFor(d, sock).mode : 'include'); }
    return K.stricter(e.priv || 'include', memo.get(k));
  };
}

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = flat(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// The part of a long text around the rarest word it matched, as find's snippet does around the first.
function around(s, word, n) {
  const t = flat(s);
  if (t.length <= n) return t;
  const i = word ? t.toLowerCase().indexOf(word) : -1;
  if (i < n - 30) return clip(t, n);
  const from = Math.min(i - Math.floor(n / 3), t.length - (n - 1));
  const end = from + n - 2;
  return `…${t.slice(from, end)}${end < t.length ? '…' : ''}`;
}
const actor = (e) => (e.kind === 'request.open' ? REQUEST_AUTHORITY[e.f && e.f.source] || K.authorityOf(e) : K.authorityOf(e));
// One event as one line: what it said, with the why beside it when it carries one.
function render(e, word) {
  const f = e.f || {};
  const who = e.src && e.src.slot ? e.src.slot : '';
  const w = (x) => (x ? ` — why: ${x}` : '');
  switch (e.kind) {
    case 'decision': case 'rule': return `${around(f.text, word, ROW_TEXT - 60)}${w(clip(f.why, 80))}`;
    case 'spawn': return `${f.worker || '?'} was briefed: ${around(f.task, word, ROW_TEXT - 70)}${w(clip(f.why, 90))}`;
    case 'purpose': return `${f.worker || '?'}: the work is for ${clip(f.why, ROW_TEXT - 30)}`;
    case 'ack': return `${f.worker || who || '?'} understood: ${around(f.understood || f.decisions, word, ROW_TEXT - 30)}`;
    case 'fact': return `${clip(f.key, 40)} = ${around(f.value, word, ROW_TEXT - 50)}`;
    case 'prompt': return `${who ? `to ${who}: ` : ''}${around(f.text, word, ROW_TEXT - 20)}`;
    case 'turn.end': return `${who || 'a session'} said: ${around(f.said, word, ROW_TEXT - 20)}`;
    default: {
      const k = TEXT_FIELDS.find(x => typeof f[x] === 'string' && f[x] && (!word || f[x].toLowerCase().includes(word))) || TEXT_FIELDS.find(x => typeof f[x] === 'string' && f[x]);
      return `${who ? `${who}: ` : ''}${around(f[k], word, ROW_TEXT - 20)}`;
    }
  }
}

// `agent` is the lead's agent: claude (or empty) is shown private memory marked; anything else is
// shown none. `session` and `now` keep the owner's own message, which a writer may already have
// recorded, from coming back as its own best match.
export function recall({ prompt, fleetDir, sock = '', session = '', agent = 'claude', now = Date.now(), env = process.env, cap = RECALL_CAP, rows = RECALL_ROWS } = {}) {
  const q = terms(unlabelled(prompt));
  if (!q.length) return { text: '', ids: [], why: 'no words to search' };
  const claude = !agent || agent === 'claude';
  const match = q.map(matcher);
  const said = normalized(String(prompt ?? '').replace(TELEGRAM, '')).toLowerCase();
  const modeOf = modeReader(env);
  const df = new Array(q.length).fill(0);
  const cands = [], gone = new Set(), seen = new Set();
  let N = 0;
  const files = logs(env);
  let bytes = 0;
  for (const x of files) { try { bytes += fs.statSync(x.file).size; } catch {} }
  // COMMON, decided on the way through. Parsing is the cost, and a word like "api" is in most lines
  // of a long log, so a query that holds one parsed nearly all of it: 1.3s on 200k events against
  // 0.5s for a query of rare words. A word whose raw count has passed four times the rare bound
  // for the log's estimated length is common, and its lines are parsed only when a rarer word asks
  // for them. It is then never rare, and its count is the raw one, which is the larger.
  const raw = new Array(q.length).fill(0), common = new Array(q.length).fill(false);
  let seenBytes = 0;
  for (const { file, machine } of files) {
    // A substring test on the raw line before anything is decoded. A key name is in every line, so
    // it can let through a line the parse then finds has none of the words; it can never keep out
    // one that has them, because no term holds a quote, a backslash or a space.
    const keep = (buf) => {
      N++; seenBytes += buf.length + 1;
      const s = buf.toString('utf8').toLowerCase();
      if (s.includes(`"${K.FORGET}"`)) return true;
      const est = N >= 500 ? bytes / (seenBytes / N) : 0;
      let pass = false;
      for (let i = 0; i < q.length; i++) {
        if (!s.includes(q[i].t)) continue;
        raw[i]++;
        if (common[i]) continue;
        if (est >= ADAPT_LINES && raw[i] > 4 * rareCap(est)) common[i] = true;
        else pass = true;
      }
      return pass;
    };
    scanLog(file, (e, off, len) => {
      if (e.kind === K.FORGET) { if (e.f && e.f.target) gone.add(`${file}\0${e.f.target}`); return; }
      if (K.TELEMETRY.has(e.kind) || !(e.kind in KIND_WEIGHT) || seen.has(e.id)) return;
      const parts = textOf(e);
      if (!parts.length) return;
      const hay = `${parts.join(' \u0001 ')} \u0001 ${e.src && e.src.slot ? e.src.slot : ''} ${(e.f && e.f.worker) || ''}`.toLowerCase();
      // The lead's own earlier messages are the query's echo, not the log's vocabulary: an owner who
      // has asked about the renewals ten times has not made "renewals" a common word. They are
      // still searched (a reason said once in a message long compacted away is the one wanted);
      // they only do not count towards how common a word is.
      const echo = e.kind === 'prompt' && session && e.src && e.src.session === session;
      let mask = 0;
      for (let i = 0; i < q.length; i++) if (match[i](hay)) { mask |= 1 << i; if (!echo) df[i]++; }
      if (!mask) return;
      seen.add(e.id);
      // The owner's message itself, already written down by the ledger or the hook a moment ago.
      if (parts.some(p => normalized(p).toLowerCase() === said)) return;
      if (session && e.src && e.src.session === session && e.t >= now - 120e3) return;
      const mode = modeOf(e);
      if (mode === 'exclude' || (mode === 'private' && !claude)) return;
      cands.push({ id: e.id, file, off, len, machine, t: e.t, kind: e.kind, mask, mode, own: !!(sock && e.src && e.src.sock === sock) });
    }, keep);
  }
  if (!cands.length) return { text: '', ids: [], why: 'nothing matched' };
  // How much each word says: a word in most of the log says nothing; one in a handful says a lot.
  for (let i = 0; i < q.length; i++) if (common[i]) df[i] = Math.max(df[i], raw[i]);
  const idf = df.map(d => Math.log(1 + N / (1 + d)));
  const rare = df.map((d, i) => !common[i] && d > 0 && d <= rareCap(N));
  const present = q.map((_, i) => df[i] > 0);
  const rareCount = rare.filter(Boolean).length;
  if (!rareCount) return { text: '', ids: [], why: 'only common words matched' };
  const need = Math.min(2, present.filter(Boolean).length);
  const scored = [];
  for (const c of cands) {
    if (gone.has(`${c.file}\0${c.id}`)) continue;
    let hits = 0, rareHits = 0, words = 0, s = 0, best = -1;
    for (let i = 0; i < q.length; i++) {
      if (!(c.mask & (1 << i))) continue;
      hits++; s += idf[i];
      if (rare[i]) rareHits++;
      if (!q[i].num) words++;
      if (best < 0 || idf[i] > idf[best]) best = i;
    }
    if (hits < need || !rareHits || !words) continue;
    // Two of the rarer words beat one, whatever the rest: a line naming "renewals" and "billing"
    // is about the thing, and a line with "renewals" and four common words may not be.
    scored.push({ ...c, score: s * KIND_WEIGHT[c.kind] * (c.own ? 1.5 : 1) * (rareHits >= 2 ? 1.5 : 1), word: q[best].t });
  }
  if (!scored.length) return { text: '', ids: [], why: 'no line matched enough of the words' };
  scored.sort((a, b) => b.score - a.score || b.t - a.t);
  const floor = scored[0].score * 0.35;
  const head = `[fleet] From the fleet's memory, matched to the owner's words above — recorded events, not the owner speaking now. If one bears on what you are about to do, read it before acting (fleet-know find <word> for more):`;
  const L = [head], ids = [], texts = new Set();
  let used = head.length, anyPrivate = false;
  const fds = new Map();
  try {
    for (const c of scored) {
      if (ids.length >= rows || c.score < floor) break;
      let e;
      try {
        if (!fds.has(c.file)) fds.set(c.file, fs.openSync(c.file, 'r'));
        const b = Buffer.allocUnsafe(c.len);
        fs.readSync(fds.get(c.file), b, 0, c.len, c.off);
        e = JSON.parse(b.toString('utf8'));
      } catch { continue; }
      const body = render(e, c.word);
      // One thing said once: the words a prompt and the ledger item it opened both carry are one
      // row. Keyed on the event's own text, not on the rendered line, whose prefix differs by kind.
      const key = textOf(e).map(t => normalized(t).toLowerCase()).join('\u0001');
      if (!body || texts.has(key)) continue;
      const who = actor(e);
      const where = `${e.project || '-'}${c.machine ? `@${c.machine}` : ''}`;
      const line = `- ${new Date(e.t).toISOString().slice(0, 10)} ${e.id} [${e.kind}, ${who}, ${where}] ${body}${c.mode === 'private' ? ' [private]' : ''}`;
      const note = c.mode === 'private' && !anyPrivate ? 1 + K.PRIV_NOTE.length : 0;
      if (used + 1 + line.length + note > cap) continue;
      used += 1 + line.length + note;
      if (note) anyPrivate = true;
      texts.add(key);
      L.push(line); ids.push(e.id);
    }
  } finally { for (const fd of fds.values()) { try { fs.closeSync(fd); } catch {} } }
  if (!ids.length) return { text: '', ids: [], why: 'nothing fit' };
  if (anyPrivate) L.push(K.PRIV_NOTE);
  return { text: L.join('\n'), ids, why: '' };
}
