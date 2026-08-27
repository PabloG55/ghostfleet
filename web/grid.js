// web/grid.js — the grid's cards, as strings. No DOM, no fetch, no globals.
//
// This is a MIRROR of bin/fleet-grid.mjs, not a second design: the same STATUS table,
// the same CW, the same clip/padEndV/twoCol arithmetic, the same five lines out of
// cardLines(). The phone is `nc = 1` (docs/mobile.md §6) and nothing else changes, so
// everything here is deliberately a transcription rather than an improvement.
//
// The suite lifts the real cardLines() out of fleet-grid.mjs and compares its
// ANSI-stripped output with this file's, card for card, line for line — see
// test/helpers/grid-parity.mjs. That is the only thing keeping the two from drifting,
// because a drift here is silent: a card that renders is a card that looks right.
//
// Why strings and not CSS boxes: the TUI's card IS its geometry — 32 columns, the title
// eating into the top rule, the status/age pair pushed apart by twoCol. Rebuilding that
// with flexbox would be a redesign with the same silhouette, and the first narrow
// viewport would show the difference. Drawing the same characters cannot disagree.

// ── colors ────────────────────────────────────────────────────────────────
// The xterm-256 indices fleet-grid.mjs uses, resolved to their exact RGB so the
// palette is the same one and not an approximation of it: 203/114/80/221/245/231.
export const COLORS = {
  red: '#ff5f5f',     // 203
  green: '#87d787',   // 114
  cyan: '#5fd7d7',    // 80
  yellow: '#ffd75f',  // 221
  grey: '#8a8a8a',    // 245
  white: '#ffffff',   // 231
};

// ── the nine statuses ─────────────────────────────────────────────────────
// Verbatim from fleet-grid.mjs's STATUS table, glyphs included. The glyphs are one
// column wide in the terminal for arithmetic reasons that HTML does not have — kept
// anyway, because they are the fleet's visual identity and a ⏳ that measured two
// columns was already rejected once for ⧗.
//
// NOT COLLAPSIBLE, and the two ways collapsing happens are named in the comments:
// `unknown` is not `idle` (we cannot tell, and a green dot it has not earned is the
// failure the status layer exists to prevent), and `limit` is not `ready` (five workers
// at a usage ceiling rendered as "5 ready" is the summary lying at a glance).
export const STATUS = {
  'need-you':   { label: '● NEEDS YOU',   color: 'red' },
  working:      { label: '◆ working',     color: 'cyan' },
  ready:        { label: '✓ ready',       color: 'green' },
  parked:       { label: '⏸ parked',      color: 'grey' },
  idle:         { label: '· idle',        color: 'grey' },
  starting:     { label: '… starting',    color: 'yellow' },
  limit:        { label: '⧗ limit',       color: 'yellow' },
  interrupted:  { label: '⚠ interrupted', color: 'red' },
  unknown:      { label: '? unknown',     color: 'yellow' },
};
// The vocabulary, in the order §4 lists it. Exported so the settings screen and the
// tests enumerate the same nine and cannot quietly test eight.
export const STATUSES = ['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted'];

// ── text helpers ──────────────────────────────────────────────────────────
// vis() counts CODE POINTS, exactly as the TUI does. Keeping the same (slightly wrong,
// deliberately documented) ruler is the point: a different one would produce different
// truncation and the two grids would disagree on where a branch name ends.
export function vis(s) { return [...s].length; }
export function clip(s, w) { s = String(s ?? ''); return vis(s) <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join('') + '…'; }
export function padEndV(s, w) { s = clip(s, w); return s + ' '.repeat(Math.max(0, w - vis(s))); }
export function twoCol(l, r, w) {
  l = clip(l, w - vis(r) - 1);
  const gap = Math.max(1, w - vis(l) - vis(r));
  return l + ' '.repeat(gap) + r;
}
export function humanAge(a) {
  if (a == null) return '';
  if (a < 60) return `${a}s`;
  if (a < 3600) return `${Math.floor(a / 60)}m`;
  return `${Math.floor(a / 3600)}h${Math.floor((a % 3600) / 60)}m`;
}
export function clockLabel(epoch) {
  const d = new Date(epoch * 1000);
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
// path.basename, for a free worktree's folder. No node:path in a browser, and a
// trailing slash must not yield '' — a card titled by nothing is a card you cannot
// identify.
export function basename(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

// ── the card ──────────────────────────────────────────────────────────────
export const CW = 30;        // inner content width — the same 30 the TUI uses
export const CARD_COLS = CW + 2;

// §4 is snake_case (`limit_at`); the TUI's own card object is camelCase (`limitAt`).
// Named rather than inlined because reading the wrong one yields `undefined`, which is
// falsy, which silently drops the `↻ 10:20pm` and shows "55m ago" in its place — a
// limited card that looks merely stale, which is the exact lie §4.3 is about.
function limitAtOf(card) { return card.limit_at ?? card.limitAt ?? null; }

// The five lines of a session card, minus the ANSI. `color` is a key of COLORS; the
// whole card is drawn in it, as in the TUI, and `selected` reverses the title line.
export function cardLines(card, selected = false, idx = -1) {
  const meta = STATUS[card.status] || STATUS.starting;
  // 1-9 prefix = the digit that jumps straight to this card in the TUI; on the phone
  // it is the card's position, which is what ⇧hjkl (drag) rewrites.
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  const title = clip(`─ ${num}${card.label || card.name} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const idle = card.age == null ? '' : (card.status === 'working' ? `busy ${humanAge(card.age)}` : `${humanAge(card.age)} ago`);
  // For a limited session the reset time is the only number that matters — "55m ago"
  // says when it last spoke, which is not the question you are asking of that card.
  const right = card.sched ? `@${clockLabel(card.sched.at)}`
              : card.status === 'limit' && limitAtOf(card) ? `↻ ${limitAtOf(card)}`
              : idle;   // @ = scheduled send
  const l1 = `│ ${padEndV(twoCol(meta.label, right, CW - 2), CW - 2)} │`;
  // Leads with the WORKTREE — the thing the session is sitting in. The branch is
  // appended only when it ADDS something; on most worktrees it is the same string
  // twice. With a label on top, the session name takes the second slot instead: it is
  // what fleet-send/fleet-read address.
  const l2text = card.label
    ? `${card.name} · ${card.folder}`
    : (card.branch && card.branch !== card.folder ? `${card.folder} · ${card.branch}` : (card.folder || card.branch));
  // ── the right-hand slot of l2: the agent, the PR number, or both ─────────
  // WHERE THE PR NUMBER GOES, and why not the other two places it could have gone.
  //
  //   NOT THE TITLE. It is the most prominent line, but it is also the one with no spare
  //   room by construction: the filler dashes it would sit in are whatever a long session
  //   name did not use, so the number would appear on short names and vanish on long ones.
  //   It already carries the 1-9 jump digit too, and a card reading `1 api-fix … #1184` puts
  //   two unrelated numbers on one line, one of which is a keystroke.
  //   NOT l1. `twoCol` there clips the LEFT, and the left is the status label — the single
  //   most important word on the card. '⚠ interrupted' (13) plus '#12345 busy 12m' (15) plus
  //   a gap is 29 in a 28-column line, so the thing that would give way is the status.
  //   So: l2's right slot, which is empty on every card running the default agent.
  //
  // PRECEDENCE WHEN BOTH ARE PRESENT: show both. They are 5-8 characters each, neither is
  // derivable from anything else on the grid, and dropping either loses a whole fact. What
  // gives way is the left side — `worktree · branch` — and that is the right thing to lose,
  // because the PR number is a shorter name for the same identity the branch is there to
  // carry. A card that says `#1184` has told you which branch it is.
  //
  // THE NUMBER IS RIGHTMOST, always, so it lands in the same column whether or not an agent
  // shares the slot. Scanning nine cards for a PR number is the thing this exists for, and
  // a number that moves left by six characters on the one codex card is a number you have
  // to hunt for.
  //
  // MEASURED, because a label measured at full width going blind in a narrow one is this
  // repo's most repeated bug. Every line stays exactly CW+2 in all of it — `#12345` alone,
  // with `opencode` beside it, and against a 44-character branch — because twoCol clips the
  // LEFT and the number is on the right, so the number is the one thing that cannot be
  // truncated. twoCol's own floor is below anything reachable here: with `#12345` it holds
  // down to a 8-column slot and with `opencode #12345` down to 17, against the 28 this uses.
  const agentTag = card.agent && card.agent !== 'claude' ? card.agent : '';
  const prTag = card.pr ? `#${card.pr}` : '';
  const l2 = `│ ${padEndV(twoCol(l2text, [agentTag, prTag].filter(Boolean).join(' '), CW - 2), CW - 2)} │`;
  const l3 = `│ ${padEndV(card.msg ? `"${card.msg}"` : (card.attached ? '(attached)' : '…'), CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  return { lines: [top, l1, l2, l3, bot], color: meta.color, selected, kind: 'card', status: card.status };
}

export function newCardLines(selected = false) {
  const t = clip('─ + new session ', CW);
  const top = `╭${t}${'─'.repeat(Math.max(0, CW - vis(t)))}╮`;
  const mk = s => `│ ${padEndV(s, CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  return { lines: [top, mk('start a Claude session'), mk('in a checkout…'), mk(''), bot],
           color: 'yellow', selected, kind: 'new', dim: !selected };
}

// A worktree that exists with no live session on it. ⏎ (tap) goes straight to naming
// one — the worktree is already identified, so the checkout picker is skipped.
export function freeCardLines(w, selected = false, idx = -1) {
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  const title = clip(`─ ${num}${basename(w.path)} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const mk = s => `│ ${padEndV(s, CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  return { lines: [top, mk('· FREE'), mk(w.branch), mk(w.task ? `"${w.task}"` : '(no session yet)'), bot],
           color: 'grey', selected, kind: 'free' };
}

// The projects screen's card (boxCard): a title and three free-text rows.
export function boxCard(title, rows, color, selected = false, kind = 'project') {
  const t = clip(`─ ${title} `, CW);
  const top = `╭${t}${'─'.repeat(Math.max(0, CW - vis(t)))}╮`;
  const body = [0, 1, 2].map(i => `│ ${padEndV(rows[i] || '', CW - 2)} │`);
  const bot = `╰${'─'.repeat(CW)}╯`;
  return { lines: [top, ...body, bot], color, selected, kind };
}

// ── the counts line ───────────────────────────────────────────────────────
// Computed from the CARDS, the way renderGrid does, so the summary cannot disagree
// with the cards under it — that is the one place it must not. §4 also ships a
// `counts` object; the suite asserts the two agree on every fixture rather than
// trusting one of them.
export function countsFrom(cards) {
  const n = s => cards.filter(c => c.status === s).length;
  return { need_you: n('need-you'), working: n('working'), ready: n('ready'),
           parked: n('parked'), limit: n('limit'), interrupted: n('interrupted') };
}
// The clauses for interrupted / at limit / parked are appended ONLY when non-zero, in
// that order — same as the TUI, where a zero-filled header was noise on every fleet.
export function countsSegments(counts) {
  const c = counts || {};
  const seg = [
    { text: `${c.need_you || 0} need you`, color: 'red' },
    { text: ' · ' },
    { text: `${c.working || 0} working`, color: 'cyan' },
    { text: ' · ' },
    { text: `${c.ready || 0} ready`, color: 'green' },
  ];
  if (c.interrupted) seg.push({ text: ' · ' }, { text: `${c.interrupted} interrupted`, color: 'red' });
  if (c.limit) seg.push({ text: ' · ' }, { text: `${c.limit} at limit`, color: 'yellow' });
  if (c.parked) seg.push({ text: ' · ' }, { text: `${c.parked} parked`, color: 'grey' });
  return seg;
}
export function countsLine(counts) { return countsSegments(counts).map(s => s.text).join(''); }

// ── the projects card ─────────────────────────────────────────────────────
// pRender's rules, in order: need > working > all-parked > any sessions > none. The
// order is the whole content of the card — a project with one blocked worker and four
// happy ones is a project that needs you, and nothing else about it matters yet.
export function projectCard(p, idx = -1, selected = false) {
  const st = p.sessions || { need: 0, working: 0, parked: 0, total: 0 };
  let line, color;
  if (st.need > 0) { line = `● ${st.need} need you`; color = 'red'; }
  else if (st.working > 0) { line = `◆ ${st.working} working`; color = 'cyan'; }
  else if (st.parked > 0 && st.parked === st.total) { line = `⏸ ${st.parked} parked`; color = 'grey'; }
  else if (st.total > 0) { line = `${st.total} session${st.total > 1 ? 's' : ''} · ready`; color = 'green'; }
  else { line = 'no sessions yet'; color = 'grey'; }
  // a message scheduled to this project's master shows as @<time> on the card
  if (p.sched && p.sched.at) line += `  @${clockLabel(p.sched.at)}`;
  // The project's default agent appears beside its profile only when it HAS one: the
  // overwhelming case is claude, and printing it everywhere would hide the one project
  // that actually differs.
  //   ...and 'claude' is not one of those, which is the same test the SESSION card two
  // functions up already makes. The daemon normalises the empty 4th column to the word
  // 'claude' before it goes on the wire, so a bare truthiness check printed "work · claude"
  // on every card on a real fleet — hiding the one project that actually differs, which is
  // the exact thing this line exists to show. The fixtures say null and never caught it.
  const who = p.agent && p.agent !== 'claude' ? `${p.profile} · ${p.agent}` : p.profile;
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  return boxCard(`${num}${p.name}`, [who, homeTilde(p.path), line], color, selected, 'project');
}
export function addProjectCard(selected = false) {
  return boxCard('+ add project', ['choose a root', 'folder…', ''], 'yellow', selected, 'addproject');
}
// The TUI shortens $HOME to ~ everywhere it prints a path. The phone has no idea what
// $HOME is, so the server sends `home` and this applies the same shortening — without
// it a card's path line is 40 columns of /Users/… and clips before it says anything.
let HOME = '';
export function setHome(h) { HOME = h || ''; }
export function homeTilde(p) {
  const s = String(p || '');
  return HOME && s.startsWith(HOME) ? '~' + s.slice(HOME.length) : s;
}

// ── "when" (the schedule form) ────────────────────────────────────────────
// The TUI's parseWhen, mirrored so the form can show the same live preview the TUI
// does — `+2h`, `15:30`, `3:50am`, `9`. `nowS` is a parameter only so a test can pin
// the clock; the app always passes the real one.
export function parseWhen(str, nowS = Math.floor(Date.now() / 1000)) {
  const s = String(str || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^\+(\d+)\s*([hm])$/)))            // +2h, +30m
    return nowS + (+m[1]) * (m[2] === 'h' ? 3600 : 60);
  if ((m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/))) {   // 3:50am, 15:30, 9
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(nowS * 1000); d.setHours(h, min, 0, 0);
    let t = Math.floor(d.getTime() / 1000);
    if (t <= nowS) t += 86400;                        // already passed -> tomorrow
    return t;
  }
  return null;
}

// ── the cell grid ─────────────────────────────────────────────────────────
// A terminal gives every character exactly one cell, and the whole card — 32 columns,
// twoCol's gap, the right-hand │ — is built on that. HTML does not, and no font choice
// fixes it. Measured in Chrome against the cell width ('0'), in every monospace stack
// available on this machine:
//
//     ─ │ ╭ ╮ ╰ ╯ ● ◆ ✓ · … ⚠ ↻   1.000
//     ⏸                            1.046
//     ⧗                            1.274      ← the limit glyph
//     ⏳                           1.661      ← rejected from the TUI for measuring 2
//
// So `⧗ limit` pushed its line 27% of a column wide and the card's right border came
// away from the box — on the one card whose status happened to be `limit`. The TUI pins
// its glyphs to one COLUMN and cannot hit this; the phone has to pin them to one CELL
// itself.
//
// cells() splits a line into runs of ASCII (one advance each, in any monospace face) and
// single non-ASCII code points, which app.js renders in a 1ch box. Grouping consecutive
// non-ASCII characters into one wider box would be fewer elements and wrong: it only
// works while every glyph in the run measures 1, which is the assumption that broke.
//
// ...EXCEPT that "one cell" is not universal either, and the pane view is what made that
// matter. A card is built from a glyph set the TUI curated — ⏳ was rejected from it for
// measuring 2 — but a PANE is arbitrary terminal output, and tmux lays ✅ or 日 into TWO
// grid columns. Pinning those to 1ch does not merely draw them small: every character
// after them on that line slides one column left, which in a box-drawn permission dialog
// is the border coming away from the box. So a token carries `wide`, and the renderer
// gives it a 2ch box. Cards are unaffected in practice (no card glyph is wide) and that
// is the point — one answer to "how many cells is this character", used by both.
const WIDE = [
  [0x1100, 0x115f],                                   // Hangul Jamo
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff],                 // CJK radicals, kana, CJK compat
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3],                                   // Hangul syllables
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],                 // fullwidth forms
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],             // the emoji planes
  [0x20000, 0x3fffd],
];
export function isWide(cp) {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true;
  return false;
}
// Combining marks and variation selectors take no cell of their own — they belong to the
// character before them, and are emitted in ITS box, because a zero-width box of their
// own would leave them combining with nothing.
export function isZeroWidth(cp) {
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)
      || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || (cp >= 0x1ab0 && cp <= 0x1aff);
}
export function cells(line) {
  const out = [];
  let run = '';
  for (const ch of String(line)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { run += ch; continue; }
    // A mark joins whatever it modifies rather than opening a box of its own: the box
    // already emitted if the base character was non-ASCII, otherwise the ASCII run it
    // sits inside. Either way it claims no cell — a 1ch box for a mark would widen the
    // line by a column and leave the mark combining with nothing.
    const prev = out[out.length - 1];
    if (isZeroWidth(cp)) {
      if (!run && prev && prev.cell) prev.text += ch; else run += ch;
      continue;
    }
    if (run) { out.push({ text: run }); run = ''; }
    out.push(isWide(cp) ? { text: ch, cell: true, wide: true } : { text: ch, cell: true });
  }
  if (run) out.push({ text: run });
  return out;
}
// How many terminal columns a string occupies — the pane's own arithmetic, from the same
// table, so "this pane is 269 columns" and the boxes drawn for it cannot disagree.
export function cellWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}
