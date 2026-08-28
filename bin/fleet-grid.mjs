#!/usr/bin/env node
// fleet-grid.mjs — the ghostfleet card grid.
//
// Invoked by bin/ghostfleet inside a zellij pane as:
//     node fleet-grid.mjs <tmux-socket> <tmux-conf> [--plain|--json]
// stdin is the tty (for keys); the TUI is drawn to /dev/tty; the CHOSEN action
// is printed to stdout (captured by the loop). Choices:
//     attach\x1f<session>   → loop runs `tmux attach -t <session>`
//     new\x1f<cwd>          → loop creates + attaches a new session in <cwd>
//     (empty)               → quit to shell
//
// The two non-interactive modes read the same data and draw nothing: --plain prints a
// table for a human at a terminal, --json the same values untruncated as the wire format
// the phone renders from (docs/mobile.md §4). The socket is POSITIONAL in both.
//
// Data per card is joined from three sources:
//   1. tmux list-sessions on <socket>  → the sessions that exist (name, cwd, attached)
//   2. ~/.claude/fleet/*.json          → live status (working/need-you/ready/idle), matched by slot==name
//   3. tail of the transcript          → last assistant line
//
// Flicker-free: alternate screen + cursor-home redraw (never a full clear).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Everything is scoped to one Claude config dir (= one account/profile).
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || path.join(CFG, 'fleet');
const PROJECTS = path.join(CFG, 'projects');
// codex keeps its own history, in its own place, under its own env var (same name and
// default the binary uses). Nothing about it is reachable from PROJECTS above.
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const PROFILE = process.env.CLAUDE_FLEET_PROFILE || 'work';
// TWO WIRES, TWO SEPARATORS, and conflating them cost 122 red assertions.
//
// US is OUR OWN protocol: the chosen action this file prints on stdout for the bash
// control plane to parse (`attach\x1f<session>`, see the header). It never passes
// through tmux, and \x1f is right for it — bash's `read` collapses runs of IFS
// WHITESPACE, so a tab would eat an empty field and shift every later one left, which
// is the trap CLAUDE.md opens with.
//
// TF is the separator inside a tmux `-F` format, and it MUST be a tab, because tmux
// <= 3.5 runs every byte of command output through vis(3) — utf8_strvis() with
// VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH, called from server_client_print() — which turns
// \x1f into the four literal characters `\037`. The split then finds nothing to split
// on and the WHOLE record lands in the first field: the same "leftover lands on the
// last variable, and it looks like data" failure, arriving through tmux's formatter
// instead of through `read`. tmux 3.6 stopped escaping (cmd-queue.c passes parse=1
// unconditionally) — and Ubuntu 24.04's apt tmux is 3.4 while Homebrew's is 3.7b, so
// this read as "ghostfleet is broken on Linux" when it is nothing of the kind.
//
// A TAB IS THE ONLY CHOICE, not a preference. Measured on 3.4, 3.5, 3.6 and 3.7b built
// from source, for `list-sessions -F` and `display-message -p` alike: of every byte
// below 0x20 plus 0x7f, tab is the ONLY one that comes back verbatim on all four (vis
// leaves it alone because VIS_TAB is not in that flag set). And a tab cannot appear
// INSIDE these fields — tmux sanitizes a tab in a session name to the literal `\t` on
// 3.4 and rejects the name outright on 3.7b. test/run.sh pins both halves.
const US = '\x1f'; // our own wire, to bin/ghostfleet — never crosses tmux
const TF = '\t';   // the separator inside a tmux -F format — see above

const SOCK = process.argv[2] || 'cf-default';
const CONF = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const PLAIN = process.argv.includes('--plain');
// Machine-readable sibling of --plain. --plain is formatted FOR A TERMINAL: branches
// elide, the message is clipped to 44 columns, and at a narrow width adjacent columns
// touch with no separator ("people-dupespeople-dupes") — so it cannot be parsed, only
// read. The values behind it are whole; --json emits them before the formatting.
const JSON_OUT = process.argv.includes('--json');
const Z = process.env.CLAUDE_FLEET_SCOPE || SOCK.replace(/^cf-/, '');

// ── colors ────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', rev: '\x1b[7m', unrev: '\x1b[27m',
  red: '\x1b[38;5;203m', green: '\x1b[38;5;114m', cyan: '\x1b[38;5;80m',
  yellow: '\x1b[38;5;221m', grey: '\x1b[38;5;245m', white: '\x1b[38;5;231m',
};
const STATUS = {
  'need-you': { label: '● NEEDS YOU', color: C.red },
  working:    { label: '◆ working',   color: C.cyan },
  ready:      { label: '✓ ready',     color: C.green },
  parked:     { label: '⏸ parked',    color: C.grey },
  idle:       { label: '· idle',      color: C.grey },
  starting:   { label: '… starting',  color: C.yellow },
  // An agent whose adapter has no validated busy regex. NOT idle: we genuinely
  // cannot tell what that pane is doing, and rendering a confident "idle"/"ready"
  // it hasn't earned is the exact failure this whole layer exists to avoid.
  // The account is spent. NOT ready: the input box is still there and every ready
  // signal matches, so five limited workers rendered as a healthy fleet of five.
  //
  // EVERY GLYPH HERE MUST BE ONE COLUMN WIDE. vis() counts CODE POINTS, not columns, so
  // a 2-column character makes the line render wider than the arithmetic thinks and
  // shoves every card to its right out of alignment. This label was ⏳ (U+23F3) for
  // exactly one release: measured against a real terminal it is 2 columns, while ⧗ ⏸ ●
  // ◆ ✓ ↻ are all 1. The suite pins this, because the failure is silent and cosmetic
  // until you notice the whole grid has shifted.
  limit:      { label: '⧗ limit',     color: C.yellow },
  // Turn cut short, waiting on a human — a park does this, so a governor episode makes
  // them in bulk. Also NOT ready, and for the same reason: the input box looks normal.
  interrupted:{ label: '⚠ interrupted', color: C.red },
  unknown:    { label: '? unknown',   color: C.yellow },
};

// ── data ────────────────────────────────────────────────────────────────
// SAY SO WHEN A RECORD DID NOT SPLIT, once. The reason a formatter change turned into
// 122 red assertions rather than one is that nothing checked: an unsplit record is a
// perfectly plausible session called "name<sep>/path<sep>0", so every consumer went on
// working with a name that was really the whole row. Test for the SEPARATOR and for the
// COLUMN COUNT the format asks for — not for emptiness, which an unsplit record passes.
let warnedRecord = false;
function tmuxRecord(line, cols) {
  const f = line.split(TF);
  if (f.length === cols) return f;
  if (!warnedRecord) {
    warnedRecord = true;
    process.stderr.write(`fleet-grid: tmux returned a ${f.length}-field record where the ` +
      `format asks for ${cols} — this tmux rewrote the separator. tmux -V: ` +
      `${tmuxVersion() || '?'}\n`);
  }
  return null;
}
function tmuxVersion() {
  try {
    return execFileSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function tmuxList() {
  try {
    const args = ['-L', SOCK, ...(CONF ? ['-f', CONF] : []), 'list-sessions', '-F',
      `#{session_name}${TF}#{session_path}${TF}#{session_attached}`];
    const out = execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map(l => {
      const f = tmuxRecord(l, 3);
      if (!f) return null;
      const [name, cwd, attached] = f;
      return { name, cwd: cwd || '', attached: attached === '1' };
    }).filter(Boolean).filter(s => !isTab(s.name));
  } catch { return []; }
}

// A TAB IS NOT A SESSION CARD. fleet-tab's terminals/editors are real tmux sessions on
// this socket (that is what keeps the fleet from reading them as agent panes), but they
// are not work and they must not be cards: a card claims a NUMBER, so a terminal
// silently renumbered every session behind it — and the digits, ⇧←→ and `Ctrl-f <p> <s>`
// all count these cards, so 2 stopped meaning what it meant a moment ago.
//   Worse, a tab shares its origin's cwd, so the transcript lookup (which is keyed by
// cwd) handed it the ORIGIN'S last message: a terminal card showing "✓ ready" and a
// summary of work it had no part in.
//   You do not lose the tab by hiding it — C-t from the session reuses the one you
// have, and ` inside it comes back here.
function isTab(name) { return /^_(?:term|edit)-/.test(name || ''); }

// THE LEAD. Every project has exactly one session called `master` — it is the one the
// grid is drawn FROM, and the one work is dispatched from. Every filter here used to
// spell that as a bare `!== 'master'`; naming it once means "is this the lead" is a
// question with one answer, and the answer is not a string comparison scattered across a
// file — which is also why the WIRE carries `lead` per card (docs/mobile.md §4) instead
// of asking each client to compare that string for itself.
//   The distinction matters more than it looks, because the two consumers of gather()
// disagree about the lead ON PURPOSE. The TUI runs INSIDE master: a card for yourself is
// redundant, `q` already returns you there, and the header would count you among the
// workers you are deciding about. A remote client (docs/mobile.md) is inside nothing —
// it is a viewer of every session — so for the phone master is not "here", it is simply
// unreachable, which is exactly the bug this landed for: "it's not opening the main
// agent, just the sessions."
const LEAD = 'master';
function isLead(name) { return name === LEAD; }

// Does a status file belong to the fleet on `sock`? Scope by the SOCKET the session
// runs on — the only field that identifies the fleet. (`zellij` is the zellij session
// name, e.g. "work", NOT the project: when empty it used to match EVERY project, so
// one fleet's master going need-you painted "1 need you" on all of them — every
// project has a session named `master`. When it was set to "work" it matched none.)
// Legacy files predate `sock`: fail CLOSED — an ambiguous entry matches nothing, and
// status falls back to the live pane, rather than leaking across fleets. Each session
// rewrites its file on the next event, so this self-heals within a turn.
function ownedBy(o, sock, zScope) {
  if (o.sock) return o.sock === sock;
  return !!o.zellij && o.zellij === zScope;
}
function fleetBySlot() {
  // Index by slot, scoped to THIS fleet, keeping the newest entry per slot (avoids a
  // stale/duplicate file shadowing the live one).
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR).filter(f => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8'));
      if (!o.slot) continue;
      if (!ownedBy(o, SOCK, Z)) continue;
      const prev = map.get(o.slot);
      if (!prev || (o.ts || 0) > (prev.ts || 0)) map.set(o.slot, o);
    } catch {}
  }
  return map;
}

// ── card order ────────────────────────────────────────────────────────────
// The grid's order IS the fleet's numbering: the digit on each card, the 1-9
// insta-jump, `Ctrl-f <p> <s>` and ⇧←→ cycling all count cards in this order. ⇧hjkl
// rewrites it, so it has to survive in two places — a file (for this process and the
// next one) and a tmux server option (fleet-cycle runs inside `run-shell`, which
// cannot see this fleet's environment and so cannot find the file at all).
// dir/sock are parameters because the STACK screen reads other projects' fleets, and
// each one keeps its own order — defaulting to this fleet covers every other caller.
function orderFile(dir = FLEET_DIR, sock = SOCK) { return path.join(dir, `${sock}.order`); }
function readOrder(dir, sock) {
  try { return fs.readFileSync(orderFile(dir, sock), 'utf8').split('\n').map(s => s.trim()).filter(Boolean); }
  catch { return []; }
}
// Saved order first, skipping names whose session is gone; then everything the file
// has never heard of, in tmux's own order. A session created since the last reorder
// lands at the END rather than vanishing off a grid that only shows what's listed.
function applyOrder(rows, dir, sock) {
  const order = readOrder(dir, sock);
  if (!order.length) return rows;
  const left = new Map(rows.map(r => [r.name, r]));
  const out = [];
  for (const n of order) { const r = left.get(n); if (r) { out.push(r); left.delete(n); } }
  for (const r of rows) if (left.has(r.name)) out.push(r);
  return out;
}
function writeOrder(names) {
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    fs.writeFileSync(orderFile(), names.join('\n') + '\n');
  } catch {}
  // Mirror onto the tmux server for fleet-cycle. ':' is the separator because tmux
  // rejects both ':' and '.' in a session name — no name can smuggle one past.
  try {
    execFileSync('tmux', ['-L', SOCK, ...(CONF ? ['-f', CONF] : []), 'set-option', '-g', '@cf_order', names.join(':')],
      { stdio: 'ignore' });
  } catch {}
}
// Move `name` `delta` places in the order and persist it. Returns its new index.
function reorderSession(name, delta) {
  const names = cards.map(c => c.name);
  const idx = names.indexOf(name);
  if (idx < 0) return -1;
  const ni = Math.max(0, Math.min(names.length - 1, idx + delta));
  if (ni === idx) return idx;                          // already at the edge
  const [moved] = names.splice(idx, 1);
  names.splice(ni, 0, moved);
  writeOrder(names);
  return ni;
}

function mtimeSec(p) { try { return Math.floor(fs.statSync(p).mtimeMs / 1000); } catch { return 0; } }

function tailText(p, maxBytes = 65536) {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// tailText's mirror: the FIRST maxBytes of a file. Used to read a rollout's header
// without paying for the megabytes of turns behind it.
function headText(p, maxBytes = 4096) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// A CARD LINE IS ONE TRUNCATED LINE, SO IT IS STRIPPED RATHER THAN RENDERED. Reported
// from a phone: card summaries read literally `**PR #76 is up — both CI l…`. The chat
// renders markdown (web/md.js) and a card cannot: cardLines() builds a 28-column box out
// of STRINGS, and both this file and web/grid.js draw it from the same strings — which is
// the only thing keeping the phone's card and the TUI's identical. Rendering here would
// either diverge the two or put markup into a terminal, and half a bold inside an ellipsis
// is worse than plain text either way.
//   Stripped HERE, where the message is produced, rather than in either drawer: one
// implementation for the TUI, --plain and --json alike, and nothing for grid-parity to
// keep in step.
//   AND IT IS ITS OWN SIX LINES RATHER THAN AN IMPORT OF web/md.js. That was the first
// version, and the suite refused it inside a minute: `test/run.sh`'s vis35 group copies
// THIS FILE to a temp directory and runs the copy, so a relative import of a sibling
// directory resolves to nothing and the whole control plane fails to load. A grid that
// cannot start because a CLIENT file moved is a worse bug than the one being fixed. The
// chat's renderer builds a DOM tree; this flattens one line of text — same input, two
// jobs, and each is tested against what it actually has to do.
const preview = (t) => String(t == null ? '' : t)
  .replace(/```[\s\S]*?```/g, ' ')                  // a fenced block is not a summary
  .replace(/`([^`]*)`/g, '$1')                       // inline code: the text, not the ticks
  .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')       // [label](url) -> label
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')                // heading marks
  .replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/gm, '')  // bullet and numbered marks
  // Emphasis, and NOT in the middle of a word: `2*3*4` is arithmetic and `a*b*c` is a
  // glob, and eating those asterisks changes what the line says. Same rule web/md.js
  // keeps, and the same reason `_` is left alone entirely — these messages are full of
  // DATABASE_URL and fleet_send.
  .replace(/(^|[^A-Za-z0-9])\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '$1$2')
  .replace(/(^|[^A-Za-z0-9])\*([^\s*](?:[\s\S]*?\S)?)\*/g, '$1$2')
  .replace(/\s+/g, ' ').trim();
function lastAssistant(p) {
  if (!p) return '';
  const lines = tailText(p).split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.type === 'assistant') {
        const c = o.message?.content;
        if (Array.isArray(c)) {
          const t = c.filter(x => x.type === 'text').map(x => x.text).join(' ').trim();
          if (t) return preview(t);
        }
      }
      // codex rollout records. Disjoint from Claude's by `type`, so one reader handles
      // both formats without having to be told which file it was handed.
      // task_complete first because we walk BACKWARDS: it is written once, at the end of
      // a turn, and already carries the finished text — so it cannot catch a mid-turn
      // draft the way the message record it summarises can.
      if (o.type === 'event_msg' && o.payload?.type === 'task_complete') {
        const t = (o.payload.last_agent_message || '').trim();
        if (t) return preview(t);
      }
      if (o.type === 'response_item' && o.payload?.role === 'assistant') {
        const c = o.payload.content;
        if (Array.isArray(c)) {
          // codex spells its assistant text `output_text` ('text' is what the INPUT side
          // uses); accept both rather than depend on which side wrote the record.
          const t = c.filter(x => x.type === 'output_text' || x.type === 'text')
                     .map(x => x.text).join(' ').trim();
          if (t) return preview(t);
        }
      }
    } catch {}
  }
  return '';
}

// Is the session actively working right now? We read the SAME signal you do on
// screen: Claude's in-progress affordance ("esc to interrupt", shown throughout
// any generation or tool run) in the live pane. This is immune to the hook/
// transcript lag that made mtime-based guessing wrong in both directions (a long
// generation looks idle to mtime; a background-task write looks busy). A missing
// pane / capture error simply reads as not-busy.
// Claude's live spinner is "<gerund>… (<elapsed> · ↓ <n> tokens · esc to interrupt)",
// but it is COMPOSED TO FIT the pane and the elapsed counter is the first field dropped.
// In a narrow pane — the stack screen makes ~50-column panes routine — all three of
// those fields are gone and only "Flowing… (almost done thinking…)" is left, which is
// why the shape (letter, ellipsis, open paren) is what's matched rather than the timer.
// A finished turn reads "✻ Cooked for 6s": no ellipsis, so it can't collide. The letter
// before the ellipsis rules out a TRUNCATED line ("| w1 | …", "/…/path"), which is
// everywhere at narrow width — belt and braces, not a tested behaviour; see the note in
// bin/fleet-agent, which is where all of this was measured.
// Second branch: while a SUBAGENT runs, Claude swaps the one-word spinner for the
// agent's own description ("+ Adding the operator-key auth provider… (10m 15s · …)"),
// which is a phrase. It has to demand the elapsed clock, because a phrase before an
// ellipsis is also what prose looks like. Kept identical to bin/fleet-agent's
// busy_re_js — this is a FALLBACK for when that isn't reachable, not a second opinion,
// and the suite pins the two together.
// Nothing in the class is escaped: `(`, a backtick and a quote are all legal bare
// inside a character class, and escaping any of them makes this literal's .source differ
// from the adapter's by a backslash — enough to defeat the test that pins the two.
const BUSY_RE = /^\s*[^A-Za-z0-9\s]?\s*[A-Za-z]+(?:…|\.\.\.)\s?\(|^\s*[^A-Za-z0-9\s]\s*[A-Za-z]+[^(`"]*(?:…|\.\.\.) \(\d+[ms][^)]*\)\s*$/i;

// ── which agent is a session running? ────────────────────────────────────────
// A session records its agent in <sock>.<name>.agent (bin/fleet-agent writes it),
// namespaced by socket for the same reason .parked is: every project has a `master`.
// ABSENT = claude, which is what keeps every pre-existing session — and every session
// started by a path that predates agents — on exactly the old code path.
// The role of the NEWEST entry in a transcript: 'assistant' when Claude spoke last,
// 'user' when something came back to it — a tool result, a typed reply, or the output
// of a slash command. Used to tell an answered need-you from a live one.
function lastEntryRole(p) {
  if (!p) return '';
  const lines = tailText(p).split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const t = JSON.parse(lines[i]).type;
      if (t === 'assistant' || t === 'user') return t;
    } catch {}
  }
  return '';
}

// A DISPLAY LABEL for a session: what the card calls it, and nothing else. The tmux
// session name stays the identity — fleet-send addresses it, the Ctrl-f chord counts it,
// the dev-stack slot and the manifest key off its worktree — because fleet-rename exists
// to keep "worktree basename == session name" true and the rest of the fleet relies on
// that. So this is cosmetic by construction: a marker file the card reads and no other
// code path consults, which is why renaming a worker still cannot drift from its folder.
function labelOf(name) {
  try {
    const t = fs.readFileSync(path.join(FLEET_DIR, `${SOCK}.${name}.label`), 'utf8').trim();
    return t.slice(0, 40);
  } catch { return ''; }
}
function setLabel(name, text) {
  const f = path.join(FLEET_DIR, `${SOCK}.${name}.label`);
  const t = (text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    if (t) fs.writeFileSync(f, t + '\n'); else fs.unlinkSync(f);   // empty clears it
  } catch {}
}

function agentOf(name) {
  try {
    const a = fs.readFileSync(path.join(FLEET_DIR, `${SOCK}.${name}.agent`), 'utf8').trim();
    return /^[a-z0-9_-]+$/.test(a) ? a : 'claude';
  } catch { return 'claude'; }
}

// The busy pattern for an agent, from the adapter. Claude's is inlined above and
// never looked up, so the default path does not depend on fleet-agent existing at
// all. Everything else shells out ONCE per agent and is cached for the life of the
// process (a running grid already holds stale code until you back out and re-enter,
// per CLAUDE.md, so this cache doesn't introduce a new staleness class).
//
// A cached `null` means "this agent has no validated detector" → report unknown.
//
// Claude is NO LONGER pre-seeded. Seeding the cache meant the grid never asked the
// adapter for it, so the inline copy was a THIRD spelling of the same pattern that
// nothing kept in step — and it drifted: the adapter learned to see a running subagent
// and the grid, the one thing that actually draws the card, went on missing it. Worse,
// a suite that asserted on `fleet-agent field claude busy_re_js` stayed green through
// all of it. The adapter is the source now; BUSY_RE is what we fall back to when it
// can't be reached, which is the property the inline copy was there for.
const busyReCache = new Map();
// Resolve fleet-agent as OUR OWN SIBLING, not through PATH. If PATH happens not to
// include the fleet's bin dir, a PATH lookup fails, every non-claude agent loses its
// detector, and the grid quietly falls back to whatever the last hook said — a wrong
// answer with no error anywhere. The adapter ships in the same directory as this
// file, so ask for it there and only fall back to PATH.
const SIBLING_AGENT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-agent');
function busyReFor(agent) {
  if (busyReCache.has(agent)) return busyReCache.get(agent);
  let re = null;
  for (const bin of [SIBLING_AGENT_BIN, 'fleet-agent']) {
    try {
      const src = execFileSync(bin, ['field', agent, 'busy_re_js'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (src && src.trim()) { re = new RegExp(src, 'i'); }
      break;                      // it ran: an empty answer is a real "no detector"
    } catch { /* not there — try the next */ }
  }
  // Claude keeps a working detector even with no adapter on disk at all — that is what
  // the inline copy is for. Every other agent's "no answer" stays null, i.e. `unknown`,
  // because inventing a pattern for one is exactly the guess this layer refuses to make.
  if (!re && agent === 'claude') re = BUSY_RE;
  busyReCache.set(agent, re);
  return re;
}

// true = working, false = not working, null = CAN'T TELL (no detector for this agent)
function paneBusy(sock, name) {
  const re = busyReFor(agentOf(name));
  if (!re) return null;
  try {
    const txt = execFileSync('tmux', ['-L', sock, 'capture-pane', '-p', '-t', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Claude's live spinner: "✽ Working… (9m 31s · ↓ 34.4k tokens)" / "Baking… (27s · …)".
    // Match the elapsed timer "(<n>m|s ·", the "↓ N tokens" counter, or an interrupt
    // hint. The "(" is anchored to a digit (not the idle "(shift+tab to cycle)" or the
    // "(4h 28m)" reset clock), and the token counter to "↓" (not the idle "…save 788k
    // tokens" hint) — so an idle prompt never reads as busy.
    //
    // Test PER LINE, never the whole blob: \s in the regex matches newlines, so a
    // whole-pane test matches across line boundaries and false-positives on idle panes.
    return txt.split('\n').some(line => re.test(line));
  } catch { return false; }
}

// "This account is spent" — returns the reset time (e.g. "10:20pm") or null.
//
// TWO SIGNALS, AND IT NEEDS BOTH. Claude prints "You've hit your session limit ·
// resets 10:20pm" and then takes no prompt until the window rolls over — but it leaves
// the input box up, so every ready signal still matches and the card reads "✓ ready".
// Five limited workers looked like a healthy fleet of five.
//
// The text alone would be a false-positive machine. Measured on two real panes taken
// the same minute: the limited worker carries the line — and so does a session that
// merely QUOTED it, arriving with the identical "⎿ " tool-result marker, because
// reading a limited pane with capture-pane renders its output as a tool result. So the
// glyph cannot separate them either.
//   What does: the session's OWN 5h figure, painted into its status bar by Claude and
// not forgeable by anything it happens to be discussing. Really limited: 102%. Quoting
// it while healthy: 15%.
//
// Fails CLOSED. A pane under ~100 columns drops the figure entirely (Claude truncates
// its status line rather than wrapping), so the conjunction cannot be met and the
// session keeps whatever status it had — a missed limit, never a fabricated one.
// "The turn was cut short and it is waiting on you." Same shape as paneLimit: the
// pattern is anchored to the indent Claude renders its own marker at, because a session
// that merely QUOTES the sentence carries it nested deeper inside a command's output.
// Verified against the session that wrote this code, which greps for the string.
function paneInterrupted(sock, name) {
  const src = agentField(agentOf(name), 'interrupt_re_js');
  if (!src) return false;
  let re; try { re = new RegExp(src); } catch { return false; }
  try {
    const txt = execFileSync('tmux', ['-L', sock, 'capture-pane', '-p', '-t', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return txt.split('\n').some(line => re.test(line));
  } catch { return false; }
}

function paneLimit(sock, name) {
  const src = agentField(agentOf(name), 'limit_re_js');
  if (!src) return null;                     // this agent has no such signal
  let re; try { re = new RegExp(src); } catch { return null; }
  try {
    const txt = execFileSync('tmux', ['-L', sock, 'capture-pane', '-p', '-t', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!txt.split('\n').some(line => re.test(line))) return null;
    // the 5h account figure, same field the governor meters (see pct_of in fleet-governor)
    const pcts = [...txt.matchAll(/[^:0-9](\d+)%\(/g)].map(m => Number(m[1]));
    if (!pcts.length || pcts[pcts.length - 1] < 100) return null;
    const at = /resets\s+(\d{1,2}:\d{2}\s*[ap]m)/i.exec(txt);
    return at ? at[1].replace(/\s+/g, '') : 'soon';
  } catch { return null; }
}

// Single source of truth for a session's live status, shared by the grid and the
// projects screen so they never disagree.
//   • pane shows the interrupt affordance → working (generating / running a tool)
//   • hook says 'need-you'                → blocked, waiting on you
//   • otherwise has history               → ready (idle at the prompt); new → idle
//   • busy === null (no detector for this agent) → trust a pushed hook status, else
//     report 'unknown' — never 'ready'/'idle', which would be a claim we can't back
function deriveStatus(hook, transcript, busy, hookTs, tmt) {
  if (busy) return 'working';
  // need-you is LATCHED: the hook writes it once and nothing clears it until a later
  // event overwrites the file — so if the hook stops firing for a session (a broken
  // hook path, a sandbox denial), the card stays red forever while the pane sits idle.
  // A flag is stale when the session kept working AFTER it was raised: while something
  // genuinely waits on you the transcript can't advance, so tmt > hookTs means it was
  // already dealt with. (Claude writes the assistant turn before the Notification, so
  // a real question still has hookTs >= tmt.)
  // Two ways to be stale, because the CLOCK ALONE IS NOT ENOUGH. That +5s is slop for
  // Claude writing the assistant turn either side of firing the hook — and it swallowed
  // real answers: a /login answered 3 seconds after the prompt landed INSIDE the grace,
  // and since a slash command is not a model turn, no Stop hook ever came to overwrite
  // the status either. The card stayed red for as long as the session lived, on a
  // session sitting at an idle prompt.
  //   So also ask WHO SPOKE LAST. A pending question always leaves Claude speaking
  // last; a tool result, a typed reply, or a slash command's output is a `user` entry
  // and only ever lands once the thing was dealt with. That has no ordering slop to
  // tune, which is the whole reason the window was wrong.
  if (hook === 'need-you') {
    const movedOn  = tmt && hookTs && tmt > hookTs + 5;
    const answered = tmt && hookTs && tmt >= hookTs && lastEntryRole(transcript) === 'user';
    if (!movedOn && !answered) return 'need-you';
  }
  // No pane detector for this agent. A pushed hook status is still real evidence, so
  // use it when there is one; with nothing at all, say so. Falling through to the
  // transcript test below would print '✓ ready' for a pane we never actually read.
  if (busy === null) return (hook === 'working' || hook === 'ready' || hook === 'idle') ? hook : 'unknown';
  if (transcript) return 'ready';
  return 'idle';
}

// A session parked with fleet-pause has a <sock>.<name>.parked marker (cleared on
// the next UserPromptSubmit). Parked = intentionally off, distinct from idle/ready.
// The marker is namespaced by socket so same-named workers in different fleets
// can't collide; clearParked also drops the legacy bare marker during upgrade.
function parkedFile(name) { return path.join(FLEET_DIR, SOCK + '.' + name + '.parked'); }
function clearParked(name) {
  try { fs.unlinkSync(parkedFile(name)); } catch {}
  try { fs.unlinkSync(path.join(FLEET_DIR, name + '.parked')); } catch {}   // legacy bare
}
function isParked(name) {
  try { return fs.existsSync(parkedFile(name)); } catch { return false; }
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function encCwd(cwd) { return cwd.replace(/[/.]/g, '-'); }
function newestTranscript(cwd) {
  try {
    const dir = path.join(PROJECTS, encCwd(cwd));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(dir, files[0].f) : '';
  } catch { return ''; }
}

// ── codex history ────────────────────────────────────────────────────────────
// codex is the one agent with NO hooks (bin/fleet-agent: hooks=no), so nothing ever
// pushes it a status file — and its history lives in a layout newestTranscript() cannot
// reach: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl, keyed by date and
// uuid rather than by cwd. Both halves of `st?.transcript || newestTranscript(cwd)` came
// back empty, deriveStatus fell through to its last line, and every codex worker sat on
// the grid as "· idle" — which here means BRAND NEW — however long you'd been talking to
// it, with no age and no last line. The cwd it was started in is in the rollout's own
// header, so the mapping the filename doesn't carry is recoverable from the content.
//
// Day directories, newest first. The names are zero-padded, so lexicographic order IS
// chronological and no stat() is needed to sort them.
function codexDayDirs() {
  const root = path.join(CODEX_HOME, 'sessions');
  const rd = d => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  const out = [];
  for (const y of rd(root)) for (const m of rd(path.join(root, y)))
    for (const d of rd(path.join(root, y, m))) out.push(path.join(root, y, m, d));
  return out;
}

// cwd -> the newest rollout STARTED in it. Scanning reads the head of candidate files,
// so it is cached: gather() runs on a 1.2s redraw and this must not walk the whole tree
// each time. The stamp is the newest day dir and its mtime — a new rollout either lands
// in that dir (bumping its mtime) or creates a newer one, so both ways invalidate. The
// file's own growth deliberately does NOT: appending a turn cannot change WHICH file
// this is, and everything read out of it downstream is read fresh.
const rolloutCache = new Map();
function codexRolloutPath(cwd) {
  if (!cwd) return '';
  const dirs = codexDayDirs();
  const stamp = dirs.length ? `${dirs[0]}\x1f${mtimeSec(dirs[0])}` : '';
  const hit = rolloutCache.get(cwd);
  if (hit && hit.stamp === stamp) return hit.file;
  let file = '';
  outer:
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).sort().reverse(); } catch {}
    for (const n of names) {
      // The header line carries the cwd, but it also carries the model's full base
      // instructions — kilobytes of prose — so read a bounded chunk and match rather
      // than parse. cwd sits in the first ~200 bytes, well ahead of that text, and this
      // is the FIRST "cwd" in the file: turn_context repeats it later, which is why the
      // window is capped instead of scanning the whole line.
      const head = headText(path.join(dir, n), 4096);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      if (!m) continue;
      let seen = '';
      try { seen = JSON.parse(`"${m[1]}"`); } catch { continue; }
      if (seen !== cwd) continue;
      file = path.join(dir, n);
      break outer;                                   // newest-first: the first hit wins
    }
  }
  rolloutCache.set(cwd, { file, stamp });
  return file;
}

// The rollout only counts as HISTORY once a turn has actually completed in it. codex
// writes its header at startup, so a pane you have not said anything to yet ALREADY has
// a file on disk — handing that back would flip a brand-new worker straight to "✓ ready"
// (which on this grid means "has history, idle at the prompt"), the same unearned claim
// the 'unknown' status exists to avoid. And it must be THIS session's rollout that
// decides: falling back to an older one for the same cwd would print the last words of a
// conversation that pane no longer has, which is how a recycled worktree lies.
function codexTranscript(cwd) {
  const f = codexRolloutPath(cwd);
  return f && lastAssistant(f) ? f : '';
}

// `lead: true` asks for the LEAD's card as well, first, and only --json passes it.
//
// The TUI and --plain keep the fleet exactly as it was — master lives on the home screen,
// not the grid — and that is the correct answer for a reader who is sitting inside it.
// A remote client is not, so leaving master out left the phone with no way to reach the
// one session you send work to (docs/mobile.md §4).
//
// FIRST, not appended, and it is deliberately outside applyOrder(): the <sock>.order file
// is written from the TUI's own cards, so it has never held master and never will —
// merging the lead into applyOrder() would drop it at the END, behind every worker, on
// every fleet that has ever been reordered. The stack picker made this same call for the
// same reason (see sessionStatuses: `...names.filter(n => isLead(n))` first), and it
// is also just true: the lead is the card you are looking for.
//   The card ORDER the fleet numbers by is untouched — --order still excludes the lead,
// so `Ctrl-f <p> <s>` and ⇧←→ at the desk count the same sessions they always did.
function gather({ lead = false } = {}) {
  const live = tmuxList();
  const sessions = [
    ...(lead ? live.filter(s => isLead(s.name)) : []),
    ...applyOrder(live.filter(s => !isLead(s.name))),
  ];
  const fleet = fleetBySlot();
  const nowS = Math.floor(Date.now() / 1000);
  // Once, here, and not inside the map: see prNumbers() for why nine calls is the wrong
  // shape and for why this one cannot reach the network.
  const prs = prNumbers();
  return sessions.map(s => {
    const st = fleet.get(s.name);
    const agent = agentOf(s.name);
    const folder = st?.folder || (s.cwd ? path.basename(s.cwd) : s.name);
    const branch = st?.branch || (s.cwd ? gitBranch(s.cwd) : '');
    // Dispatched on the agent, not tried in turn: newestTranscript() keys purely off the
    // cwd, so on a worktree that USED to run claude it happily returns that old transcript
    // for the codex session standing there now — a wrong answer that looks like a right
    // one, since the card would show a real message with a real timestamp.
    const transcript = st?.transcript ||
      (agent === 'codex' ? codexTranscript(s.cwd || '') : newestTranscript(s.cwd || ''));
    const tmt = transcript ? mtimeSec(transcript) : 0;    // last transcript write = age display only
    const busy = paneBusy(SOCK, s.name);
    let status = deriveStatus(st?.status || '', transcript, busy, st?.ts || 0, tmt);
    if (!busy && isParked(s.name)) status = 'parked';     // intentionally off (fleet-pause)
    // Checked last and only on a session that is neither generating nor deliberately
    // off: those two already describe it better. A limited session looks exactly like a
    // ready one — same input box, same prompt — so nothing but the pane can tell.
    let limitAt = null;
    if (!busy && status !== 'parked') {
      limitAt = paneLimit(SOCK, s.name);
      if (limitAt) status = 'limit';
      // Limit wins if both are showing: it says WHY the session is stuck and when it
      // comes back, where "interrupted" only says it stopped.
      else if (paneInterrupted(SOCK, s.name)) status = 'interrupted';
    }
    const ageBase = tmt || st?.ts || 0;
    const age = ageBase ? Math.max(0, nowS - ageBase) : null;
    const mk = readSched(s.name);                 // socket-namespaced marker
    const sched = (mk && mk.at > nowS) ? mk : null;
    return { name: s.name, cwd: s.cwd || '', folder, branch, status, age, msg: lastAssistant(transcript),
             attached: s.attached, sched, agent, label: labelOf(s.name), limitAt, lead: isLead(s.name),
             // null, never 0 or '': the card tests it for truth, and a PR numbered 0 does
             // not exist while an empty string would read as "no PR" in one place and as a
             // present-but-blank field in another.
             pr: (branch && prs.get(branch)) || null };
  });
}

// The summary line, counted ONCE for all three consumers: the TUI header, --plain's
// first line, and --json's `counts`. It was inline in renderGrid, and --plain kept its
// own three-of-the-six copy; a third copy for --json is how the fleet ends up reporting
// two different numbers for the same fleet in the same second, which is precisely the
// drift the phone design forbids (docs/mobile.md §3: one producer of "what is this
// session doing"). One function means a new status can only be added in one place.
//
// LIMIT AND INTERRUPTED ARE THEIR OWN BUCKETS AND ARE NEVER FOLDED INTO READY. Both
// leave the input box up and match every ready signal, so five workers at a usage
// ceiling counted as "5 ready" is the summary lying at exactly the glance you would act
// on. The keys are the wire names (need_you, not need-you) because this object IS the
// `counts` object --json emits.
//
// Six buckets, not nine, and deliberately: these are the six the header shows. `idle`,
// `starting` and `unknown` are carried per card and counted by nobody — a consumer that
// wants them reads cards[], and must not infer them by subtracting these six from
// cards.length as though the remainder were one status.
function statusCounts(cards) {
  return {
    need_you:    cards.filter(c => c.status === 'need-you').length,
    working:     cards.filter(c => c.status === 'working').length,
    ready:       cards.filter(c => c.status === 'ready').length,
    parked:      cards.filter(c => c.status === 'parked').length,
    limit:       cards.filter(c => c.status === 'limit').length,
    interrupted: cards.filter(c => c.status === 'interrupted').length,
  };
}

// ^T / ^N on the grid: a terminal or the editor on the SELECTED card's folder, falling
// back to the project root (master's cwd) when the selection isn't a session — pressing
// it on "+ new session" should still give you a terminal, not nothing.
//
// fleet-tab creates or reuses the session; we then hand back an ordinary `attach`
// choice, so the control-plane loop opens it through the path it already has for every
// other session. No new verb in bin/ghostfleet, and the tab is attached, not merely
// created in the background where you'd have no way to reach it (it has no card).
//
// The name has to be predicted to build that choice, so it uses the SAME sanitising
// fleet-tab does. If they ever drift, this attaches to a session that isn't there —
// which is why the test asserts the predicted name against the one really created.
function tabName(kind, from) { return `_${kind}-${String(from).replace(/[.:]/g, '_')}`; }
function tabChoice(kind) {
  const card = items[sel]?.card;
  const home = tmuxList().find(s => s.name === 'master');
  const cwd  = card?.cwd || home?.cwd || process.cwd();
  const from = card?.name || 'master';
  const bin  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-tab');
  try {
    execFileSync(bin, [kind, SOCK, cwd, from], { stdio: 'ignore' });
  } catch { return ''; }               // no editor installed, no tmux — stay on the grid
  return `attach${US}${tabName(kind, from)}`;
}

function killSession(name) {
  try {
    execFileSync('tmux', ['-L', SOCK, ...(CONF ? ['-f', CONF] : []), 'kill-session', '-t', name], { stdio: 'ignore' });
  } catch {}
  clearParked(name);   // clear any park marker (namespaced + legacy)
  // Drop the agent marker too, or a later session that reuses this name inherits a
  // dead one's agent and launches the wrong CLI.
  try { fs.unlinkSync(path.join(FLEET_DIR, `${SOCK}.${name}.agent`)); } catch {}
  // drop its status file(s) so the card disappears (the conversation history in
  // ~/.claude/projects is untouched — you can re-open it later from `new`).
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR).filter(f => f.endsWith('.json')); } catch {}
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8'));
      // scope by socket: a bare slot match would delete ANOTHER fleet's same-named
      // (e.g. `master`) status file
      if (o.slot === name && ownedBy(o, SOCK, Z)) fs.unlinkSync(path.join(FLEET_DIR, f));
    } catch {}
  }
}

// ── pause / resume (cost control) ───────────────────────────────────────────
// fleet-pause interrupts the worker (Escape-retry, pane-diff verified) then writes
// the .parked marker; run it detached so the TUI never blocks on the retry loop.
function pauseSession(name) {
  try {
    const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-pause');
    spawn(bin, ['-s', SOCK, name], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}
function resumeSession(name) {
  clearParked(name);
}

// ── worker → master auto-nudge, PER SESSION ─────────────────────────────────
// Same markers as the per-project page (projects screen → ,) but namespaced with
// the session: <sock>.<session>.notify-lead[-off]. Most specific wins, so one noisy
// worker can be silenced without touching the project — and one worker can push
// while the rest of the project stays quiet. (hooks/fleet-event.sh reads these.)
function projPushOn() {                       // what "inherit" resolves to here
  if (fs.existsSync(path.join(FLEET_DIR, SOCK + '.notify-lead-off'))) return false;
  if (fs.existsSync(path.join(FLEET_DIR, SOCK + '.notify-lead'))) return true;
  return fs.existsSync(path.join(HOME, '.config', 'ghostfleet', 'notify-lead'));
}
function sessPushFiles(name) {
  return { on: path.join(FLEET_DIR, `${SOCK}.${name}.notify-lead`),
           off: path.join(FLEET_DIR, `${SOCK}.${name}.notify-lead-off`) };
}
function sessPush(name) {                     // 'on' | 'off' | 'inherit'
  const f = sessPushFiles(name);
  try { if (fs.existsSync(f.off)) return 'off'; if (fs.existsSync(f.on)) return 'on'; } catch {}
  return 'inherit';
}
function cycleSessPush(name) {                // inherit → on → off → inherit
  const f = sessPushFiles(name), cur = sessPush(name);
  try { fs.mkdirSync(FLEET_DIR, { recursive: true }); } catch {}
  try { fs.unlinkSync(f.on); } catch {}
  try { fs.unlinkSync(f.off); } catch {}
  if (cur === 'inherit') { try { fs.writeFileSync(f.on, ''); } catch {} }
  else if (cur === 'on') { try { fs.writeFileSync(f.off, ''); } catch {} }
  // 'off' → inherit: both markers already removed
}

// ── scheduling (send a message to a session at a time) ──────────────────────
function parseWhen(str) {
  const s = String(str || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^\+(\d+)\s*([hm])$/)))            // +2h, +30m
    return Math.floor(Date.now() / 1000) + (+m[1]) * (m[2] === 'h' ? 3600 : 60);
  if ((m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/))) {   // 3:50am, 15:30, 9
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(); d.setHours(h, min, 0, 0);
    let t = Math.floor(d.getTime() / 1000);
    if (t <= Math.floor(Date.now() / 1000)) t += 86400;        // already passed -> tomorrow
    return t;
  }
  return null;
}
function clockLabel(epoch) {
  const d = new Date(epoch * 1000);
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
// Markers are namespaced by socket (<sock>.<session>.sched) so the same-named
// session — above all 'master', which EVERY project has — can't collide across
// projects that share one profile's fleet dir. dir/sock default to this grid's
// own project; the projects screen passes another project's fleet dir + socket so
// it can schedule a message to that project's master.
function schedMarker(session, dir = FLEET_DIR, sock = SOCK) { return path.join(dir, `${sock}.${session}.sched`); }
function readSched(session, dir = FLEET_DIR, sock = SOCK) {
  try { return JSON.parse(fs.readFileSync(schedMarker(session, dir, sock), 'utf8')); } catch { return null; }
}
function cancelSchedule(session, dir = FLEET_DIR, sock = SOCK) {
  // kill the waiter (it's a detached process-group leader, so -pid kills its
  // sleep + caffeinate too) and drop the marker.
  const m = readSched(session, dir, sock);
  if (m && m.pid) {
    try { process.kill(-m.pid, 'SIGTERM'); } catch {}
    try { process.kill(m.pid, 'SIGTERM'); } catch {}
  }
  try { fs.unlinkSync(schedMarker(session, dir, sock)); } catch {}
}
function schedule(session, whenStr, msg, sock = SOCK, dir = FLEET_DIR, env = null) {
  const at = parseWhen(whenStr);
  if (!at) return false;
  cancelSchedule(session, dir, sock);       // replace, never stack
  let pid = 0;
  try {
    const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-schedule');
    const opts = { detached: true, stdio: 'ignore' };
    if (env) opts.env = { ...process.env, ...env };   // target profile's config/fleet dir
    const child = spawn(bin, [sock, session, String(at), msg], opts);
    pid = child.pid; child.unref();
  } catch { return false; }
  try { fs.writeFileSync(schedMarker(session, dir, sock), JSON.stringify({ at, msg, pid })); } catch {}
  return true;
}

// ── text helpers ────────────────────────────────────────────────────────
function vis(s) { return [...s].length; }
function clip(s, w) { s = String(s ?? ''); return vis(s) <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join('') + '…'; }
function padEndV(s, w) { s = clip(s, w); return s + ' '.repeat(Math.max(0, w - vis(s))); }
function twoCol(l, r, w) {
  l = clip(l, w - vis(r) - 1);
  const gap = Math.max(1, w - vis(l) - vis(r));
  return l + ' '.repeat(gap) + r;
}
function humanAge(a) {
  if (a == null) return '';
  if (a < 60) return `${a}s`;
  if (a < 3600) return `${Math.floor(a / 60)}m`;
  return `${Math.floor(a / 3600)}h${Math.floor((a % 3600) / 60)}m`;
}

// ── card rendering ────────────────────────────────────────────────────────
const CW = 30; // inner content width
function cardLines(card, selected, idx) {
  const meta = STATUS[card.status] || STATUS.starting;
  const color = meta.color;
  // 1-9 prefix = the digit that jumps straight to this card (see onKey)
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  // A labelled card is titled by the label; an unlabelled one is unchanged.
  const title = clip(`─ ${num}${card.label || card.name} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const idle = card.age == null ? '' : (card.status === 'working' ? `busy ${humanAge(card.age)}` : `${humanAge(card.age)} ago`);
  // For a limited session the reset time is the only number that matters — "55m ago"
  // says when it last spoke, which is not the question you are asking of that card.
  const right = card.sched ? `@${clockLabel(card.sched.at)}`
              : card.status === 'limit' && card.limitAt ? `↻ ${card.limitAt}`
              : idle;   // @ = scheduled send
  const l1 = `│ ${padEndV(twoCol(meta.label, right, CW - 2), CW - 2)} │`;
  // Name the agent on the card whenever it isn't the default. Without this an
  // "unknown" or a differently-behaving status is unreadable — you can't tell whether
  // the fleet is confused or the session simply isn't Claude. Claude cards are left
  // exactly as they were (no marker, no width change).
  // This line leads with the WORKTREE, because that is the thing the session is sitting
  // in and it was previously invisible: it read `branch || folder`, so the branch always
  // won and the folder only showed when there wasn't one. On a fleet where the two
  // differ — a session in `cache-keys` on branch `feat/invoice-cache-warming` —
  // the card named the branch and never said which checkout it was.
  // The branch is appended only when it ADDS something; on most worktrees it is the same
  // string twice, and the line is 28 columns.
  //   With a label on top, the session name takes the second slot instead: it is what
  // fleet-send/fleet-read address, and a card titled "PR 1184 retry work" that doesn't
  // show it tells you nothing about what to type.
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
  const l2 = `│ ${padEndV(twoCol(l2text,
                                 [agentTag, prTag].filter(Boolean).join(' '), CW - 2), CW - 2)} │`;
  const l3 = `│ ${padEndV(card.msg ? `"${card.msg}"` : (card.attached ? '(attached)' : '…'), CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  const wrap = (s, isTop) => selected
    ? `${C.bold}${color}${isTop ? C.rev : ''}${s}${C.unrev}${C.reset}`
    : `${color}${s}${C.reset}`;
  return [wrap(top, true), wrap(l1), wrap(l2), wrap(l3), wrap(bot)];
}
function newCardLines(selected) {
  const color = C.yellow;
  const top = `╭${clip('─ + new session ', CW)}${'─'.repeat(Math.max(0, CW - vis(clip('─ + new session ', CW))))}╮`;
  const mk = t => `│ ${padEndV(t, CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  const lines = [top, mk('start a Claude session'), mk('in a checkout…'), mk(''), bot];
  const wrap = (s, isTop) => selected ? `${C.bold}${color}${isTop ? C.rev : ''}${s}${C.unrev}${C.reset}` : `${C.dim}${color}${s}${C.reset}`;
  return lines.map((s, i) => wrap(s, i === 0));
}
// a worktree that exists but has no live session — ⏎ jumps straight to naming one,
// skipping the checkout picker entirely (the worktree is already identified)
function freeCardLines(w, selected, idx) {
  const color = w.removing ? C.yellow : C.grey;
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  const title = clip(`─ ${num}${path.basename(w.path)} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  // THE CARD, NOT JUST THE BANNER. The removal now outlives the keystroke, so the user can
  // move around while it runs — and the one thing this card must never say in that minute
  // is FREE, which is what it said before the state existed. Yellow because it matches the
  // banner the confirmation used, and "deleting…" because the count of files is the reason
  // it is slow and the only useful thing to say while waiting.
  const l1 = `│ ${padEndV(w.removing ? '⋯ REMOVING' : '· FREE', CW - 2)} │`;
  const l2 = `│ ${padEndV(w.branch, CW - 2)} │`;
  const l3 = `│ ${padEndV(w.removing ? 'deleting the checkout…' : (w.task ? `"${w.task}"` : '(no session yet)'), CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  const wrap = (s, isTop) => selected
    ? `${C.bold}${color}${isTop ? C.rev : ''}${s}${C.unrev}${C.reset}`
    : `${color}${s}${C.reset}`;
  return [wrap(top, true), wrap(l1), wrap(l2), wrap(l3), wrap(bot)];
}

// ── checkout discovery (for new session) ────────────────────────────────
const CFG_FILE = path.join(HOME, '.config', 'ghostfleet', 'checkouts');
const isRepo = p => { try { return fs.existsSync(path.join(p, '.git')); } catch { return false; } };
// A MAIN checkout, as opposed to a linked worktree: git gives a worktree a .git FILE
// (`gitdir: …`) and a real clone a .git DIRECTORY. No subprocess, and exact for the one
// distinction mainRepo() needs — "is this the checkout master lives in, or a leaf".
const isMainCheckout = p => { try { return fs.statSync(path.join(p, '.git')).isDirectory(); } catch { return false; } };
// e.g. "myapp-v2" -> "myapp", "api" -> "api", "api-2" -> "api"
const Zbase = Z.replace(/[-_ ]?v?\d+$/i, '') || Z;

const nameRoots = [...new Set([process.env.CLAUDE_FLEET_ROOT || '', path.join(HOME, Z), path.join(HOME, Zbase)].filter(Boolean))];
const cwdRoots = [...new Set([process.cwd(), path.dirname(process.cwd())])];
function discoverRoots() { return [...new Set([...nameRoots, ...cwdRoots])]; }

function collectRepos(roots) {
  const out = [];
  for (const root of roots) {
    if (isRepo(root)) out.push(root);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      if (isRepo(p)) out.push(p);
    }
  }
  return [...new Set(out)].sort();
}

// A project registered with `fleet-project add <repo>` (path = the repo itself, not
// a container folder) has CLAUDE_FLEET_ROOT pointing AT the repo, one level DEEPER
// than where fleet-spawn actually creates worktree siblings (the repo's own parent).
// collectRepos() then only ever finds the main repo itself, never its worktrees. Ask
// git directly for the truth instead of guessing a directory to scan — this is exact
// regardless of which registration convention was used, and it's the same source
// fleet-worktrees/fleet-spawn already trust.
function worktreesOf(repoPath) {
  try {
    let out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // A REMOVAL THAT DIED HALF WAY leaves the directory gone and the administrative entry
    // behind, and git reports exactly that: `prunable gitdir file points to non-existent
    // location` (measured). Pruning THEN, and only then, is what makes "let the child
    // finish detached" safe to choose over "refuse to exit" — the cost of a grid that dies
    // mid-removal is one entry that the next read of this list clears. `git worktree prune`
    // is idempotent and silent with nothing to do, but it is still a write, so it does not
    // run on every 1.2s poll: no prunable line, no extra process.
    if (/^prunable /m.test(out)) {
      try {
        execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
        out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {}
    }
    return out.split('\n\n').filter(Boolean).map(block => {
      const wt = /^worktree (.+)$/m.exec(block)?.[1];
      const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      return wt ? { path: wt, branch: br || '(detached)' } : null;
    }).filter(Boolean);
  } catch { return []; }
}
// The project's own main checkout — the same three steps enter_master walks in
// bin/ghostfleet (<root>/<name>, else a child repo, else the root itself), so this
// agrees with whichever checkout the master session actually opened. Both registration
// conventions land here; docs/OPERATIONS.md, "Two ways to register a project", is the
// write-up of what each one costs.
//
// TWO CAVEATS THE OLD COMMENT PAPERED OVER:
//
//   Step 2 is enter_master's `$PROJECT_ROOT/$PROJECT` only when CLAUDE_FLEET_SCOPE is
//   set. Every real caller sets it (bin/ghostfleet, fleet-serve.mjs, fleet-dispatch.mjs),
//   but the fallback is SOCKET-derived, and a non-work profile's socket carries its
//   profile: `cf-personal-scratch` gives Z = `personal-scratch`, which is not a
//   directory anybody has. So a hand-run `fleet-grid.mjs cf-personal-scratch --plain`
//   — the documented way to exercise this path without the TUI — skips step 2 entirely
//   and lands on step 3. That is exactly why step 3 has to be safe rather than lucky.
//
//   Step 3 was "whatever readdir yields first", and readdir order is not a preference.
//   A LINKED WORKTREE has a .git of its own, so on a container root it came back as the
//   project's main checkout — and then fleet-spawn, run there, correctly refused to
//   spawn a worker from inside a worktree. Prefer a real checkout (a .git DIRECTORY; a
//   worktree's is a .git file pointing elsewhere) and sort, so the answer is the same
//   one twice. A worktree is still returned when it is genuinely all there is —
//   answering nothing would break the projects that already work this way.
function mainRepo() {
  const root = process.env.CLAUDE_FLEET_ROOT || '';
  if (!root) return '';
  if (isRepo(root)) return root;
  const named = path.join(root, Z);
  if (isRepo(named)) return named;
  try {
    const kids = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => path.join(root, e.name))
      .filter(isRepo).sort();
    return kids.find(isMainCheckout) || kids[0] || root;
  } catch {}
  return root;
}
// ── the PR number for a branch, and the two things it must never do ──────
// A working session's most useful single fact is its PR number, and until now the only
// place it appeared was inside `msg` — the last assistant line, which changes every turn.
// A card built from that text would GAIN AND LOSE the number as the agent talks, and would
// show a stray issue reference as a PR. So the number comes from the same place
// fleet-merged already resolves branches to PR state.
//
// IT NEVER TOUCHES THE NETWORK ON THIS PATH. `--cached` is pure file I/O and refuses to
// fetch (see fleet-merged's header); this runs inside a repaint that happens every couple of
// seconds, and a gh call there would freeze the TUI on a slow connection. A card with no
// number is a fine card. A grid that hangs is not.
//   ONE CALL PER DRAW, not one per card: measured at 20.5 ms a call, nine cards would add
// 184 ms to every repaint and one adds 20 ms. mainRepo() is what it asks about, because that
// function already answers "which checkout is this project" for the container-directory
// layout where CLAUDE_FLEET_ROOT is not itself a repo.
//
// AND SOMETHING HAS TO FILL THE CACHE, or --cached answers nothing forever and the feature
// only works after you happen to visit the worktrees screen. So a refresh is fired into the
// BACKGROUND — detached, unref'd, never awaited — and `--warm` takes a lock, so firing one
// per repaint still causes exactly one gh call. Throttled here as well, because the honest
// cost of a no-op warm is still a process.
const MERGED_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-merged');
let prWarmedAt = 0;
// THE DEFAULT BRANCH IS NOT A PR, and this is not a hypothetical. Found on the live fleet
// the hour this was written: the lead's card sits on `main` and came back as #1, because the
// very first PR in this repo was opened FROM main INTO main. A session on the default branch
// has no PR of its own by construction — you do not open one from main to main — so any row
// keyed on it is a fork's PR or somebody's early mistake, and neither is this session's work.
//   Read from `refs/remotes/origin/HEAD`, which is a local ref: no network, and it is right
// on a repo whose default is neither of the two obvious names. Memoised because it does not
// change while the grid is open. When it is not set locally the fallback drops both common
// names rather than guessing one, since a wrong number on a lead card is the failure being
// fixed and an absent one is merely the status quo.
const defBranchCache = new Map();
function defaultBranch(repo) {
  if (defBranchCache.has(repo)) return defBranchCache.get(repo);
  let out = '';
  try {
    out = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '');
  } catch {}
  defBranchCache.set(repo, out);
  return out;
}
function prNumbers() {
  const repo = mainRepo();
  if (!repo) return new Map();
  const m = new Map();
  try {
    const out = execFileSync(MERGED_BIN, ['--prs', '--cached', repo],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    for (const line of out.split('\n')) {
      const [branch, num, state] = line.split('\x1f');
      // A number is required and is checked as DIGITS: a truncated cache line would
      // otherwise put NaN on a card, and `#NaN` is worse than no number at all.
      if (!branch || !/^\d+$/.test(num || '')) continue;
      // OPEN WINS. A branch can carry more than one PR over its life — reopened, or a
      // branch name reused — and the one a live session is working on is the open one.
      if (!m.has(branch) || state === 'OPEN') m.set(branch, num);
    }
    // Dropped from the MAP rather than checked at the call site, so "this branch's own PR"
    // has one definition and the card does not have to know the rule.
    const def = defaultBranch(repo);
    if (def) m.delete(def); else { m.delete('main'); m.delete('master'); }
  } catch { /* no gh, no cache, no repo: no numbers, and the card is unchanged */ }
  const now = Date.now();
  if (now - prWarmedAt > 60000) {
    prWarmedAt = now;
    try { spawn(MERGED_BIN, ['--warm', repo], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
  return m;
}
// what a worktree was spun up for, from the manifest fleet-spawn writes (keyed by path)
function manifestTask(wtPath) {
  try {
    for (const line of fs.readFileSync(path.join(FLEET_DIR, `${SOCK}.manifest.tsv`), 'utf8').split('\n')) {
      const [w, , , task] = line.split('\t');
      if (w === wtPath) return (task && task !== '-') ? task : '';
    }
  } catch {}
  return '';
}
// Worktrees of THIS project with no live session on them — shown as their own cards
// (see buildItems) so reusing one doesn't require going through `n`'s checkout picker
// first. Excludes the main checkout itself: that's master's slot, never a free card
// (same convention as fleet-spawn's free_worktrees, which also skips the first entry).
function freeWorktrees() {
  const repo = mainRepo();
  if (!repo) return [];
  const all = worktreesOf(repo);
  if (all.length < 2) return [];
  const liveCwds = tmuxList().map(s => s.cwd).filter(Boolean);
  return all
    .filter(w => w.path !== repo && !liveCwds.some(c => c === w.path || c.startsWith(w.path + '/')))
    // `removing` rides along with the row rather than being looked up by each renderer,
    // so the card, --json and --plain cannot disagree about which worktree is busy. A
    // worktree mid-removal stays IN this list: git still lists it until the removal
    // finishes, and dropping it here would make the card vanish and reappear — or, worse,
    // read "· FREE" while its files are being deleted.
    .map(w => ({ path: w.path, branch: w.branch, task: manifestTask(w.path), removing: isRemoving(w.path) }));
}

// ── worktrees: create · remove ────────────────────────────────────────────
// The repo's current branch — the default base a new worktree's branch is cut from,
// shown on the form so "from" is never a mystery you have to go and look up.
function currentBranch(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'HEAD';
  } catch { return 'HEAD'; }
}
// WHICH LINES OF A REFUSAL THE FORM SHOWS. This kept `.pop()` — the LAST line — and
// fleet-spawn's refusals are paragraphs that build to their point. The nested-worktree
// one is nine lines ending in "Override deliberately with CLAUDE_FLEET_ALLOW_NESTED=1",
// so the form displayed the single thing you should not do and threw away both commands
// that actually fix it, including "Really want another worker? Run it from the main
// checkout". A form that only ever offers the escape hatch teaches the escape hatch.
//
// So: drop blanks and each line's leading indent, drop the escape-hatch lines outright
// (an override is never a form's advice — it is what you reach for after reading the
// advice and disagreeing), and keep the first few of what's left. Front-loaded rather
// than tail-loaded because these messages lead with what went wrong and then say what
// to do about it; the last lines are the footnotes.
//
// Pure on purpose — no width, no colour, no HOME — so the suite can lift it out and
// feed it a real refusal. Clipping and padding belong to the renderer.
function spawnFailLines(raw, max = 6) {
  const lines = String(raw || '').split('\n')
    .map(l => l.replace(/\s+$/, '').replace(/^\s+/, ''))
    .filter(Boolean)
    .map(l => l.replace(/^fleet-spawn:\s*/, ''))
    .filter(l => !/^Override deliberately\b/i.test(l));
  return lines.length ? lines.slice(0, max) : ['fleet-spawn failed'];
}
// The rows renderNewWorktree spends on that message, ALWAYS — see the block there.
// Same number as the cap above, kept adjacent to it because the two only make sense
// together: keeping lines the form has no room to draw would be a silent truncation,
// and reserving rows nothing can fill would be dead space above the footer.
const WT_MSG_ROWS = 6;
// Create a worktree AND start a session in it, by handing the whole job to
// bin/fleet-spawn (same pattern as doRename -> fleet-rename). Not laziness: spawn
// already resolves the base ref against its upstream so a new branch doesn't start
// stale, symlinks node_modules in, records the manifest and the agent marker, and
// routes the session onto the OWNING project's socket. A second copy of all that
// here would be a second thing to keep right, and the two would drift.
//   fleet-spawn finds the repo from $PWD, so it has to RUN in the main checkout: the
// control plane's cwd is wherever ghostfleet was launched from, usually elsewhere.
function createWorktree({ name, branch, from, agent }) {
  const repo = mainRepo();
  if (!repo) return { ok: false, msg: 'no git checkout found for this project' };
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-spawn');
  // -s, not just the env var: fleet-spawn prefers $TMUX over $CLAUDE_FLEET_SOCK (a
  // --resume'd Claude can hold a stale one), and $TMUX is INHERITED — so a control plane
  // launched from inside some other fleet session handed this repo's worker to THAT
  // fleet. Seen live under vhs while recording the demo: the create succeeded, the
  // session was real, and the grid drew the new worktree as "· FREE — no session yet"
  // because it was sitting on a socket this grid never reads.
  const args = [name, '--new', '-s', SOCK];
  if (branch) args.push('--branch', branch);
  if (from) args.push('--from', from);
  if (agent) args.push('--agent', agent);
  let stdout = '';
  try {
    stdout = execFileSync(bin, args, {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      // fleet-agent has to be findable for a non-claude agent, and a tmux server born
      // outside a login shell need not carry ~/.local/bin on PATH.
      env: { ...process.env, CLAUDE_FLEET_SOCK: SOCK, PATH: `${path.dirname(bin)}:${process.env.PATH || ''}` },
    });
  } catch (e) {
    return { ok: false, msg: spawnFailLines(`${e.stderr || ''}\n${e.stdout || ''}`).join('\n') };
  }
  // spawn settles name collisions itself (name~2, …), so attach the session it says
  // it STARTED, not the one we asked for — attaching the wrong one would be silent.
  const started = /started '([^']+)'/.exec(stdout)?.[1] || name;
  return { ok: true, session: started };
}
// Remove a free worktree's checkout. The BRANCH is left alone on purpose: a worktree
// is a working copy, and deleting someone's branch because they tidied up a folder
// is not a thing you can undo. git refuses on a dirty tree — that refusal is the
// message the caller shows, and forcing past it is a different, deliberate keystroke.
// THE MESSAGE, kept as a pure function of (stderr, path) when the removal became
// asynchronous — because it is the part with the scars and the part a rewrite quietly
// loses. git names the worktree by its FULL path, which on a real checkout is long enough
// to push the actual reason off the end of the line (measured: 198 characters for a dirty
// tree under this scratch dir); the first cut of this showed half a path and nothing else.
// The card already says WHICH worktree this is, so what belongs here is why git said no,
// and that `f` is the answer to "use --force".
//   Pure so the suite can drive it with real git stderr — see the --wt-remove-msg mode at
// the bottom of this file, which exists for the same reason --plain does.
function removeFailMsg(stderr, wtPath) {
  const raw = `${stderr || ''}`.trim().split('\n').filter(Boolean).pop() || 'git worktree remove failed';
  return raw
    .replace(/^fatal:\s*/, '')
    .replaceAll(wtPath, path.basename(wtPath))
    .replaceAll(HOME, '~')
    .replace(/,?\s*use --force to delete it\.?$/, '');
}

// ── a removal in flight is FLEET STATE, not a variable in one process ────────
// `git worktree remove` on a real checkout — one with a true node_modules rather than the
// symlink fleet-spawn makes — is tens of thousands of files and takes the better part of a
// minute. It used to run synchronously here, which froze the whole TUI: the banner said
// "this can take a minute" and then no key, no poll and no redraw answered for that
// minute. Reported as "the app froze and then it deleted it".
//
// The marker is a FILE, next to .parked/.sched/.agent and namespaced by socket the same
// way, rather than a Map in this process. Three readers need this state and only one of
// them is us: this grid's own 1.2s poll, `--json`/`--plain` (which is another process
// entirely, and how the suite can see it at all), and a SECOND grid on the same fleet —
// the stack screen and the phone both read this fleet, and a worktree that looks FREE in
// one pane while it is being deleted in another is exactly the lie the card must not tell.
// It carries the pid so a marker left behind by a grid that died can be told from a live
// removal, which is the only way "still going" and "gave up half way" are distinguishable
// from the outside.
function removingFile(wtPath) { return path.join(FLEET_DIR, `${SOCK}.${path.basename(wtPath)}.removing`); }
function markRemoving(wtPath, force) {
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    fs.writeFileSync(removingFile(wtPath), JSON.stringify({ pid: process.pid, at: Math.floor(Date.now() / 1000), force: !!force }));
  } catch {}
}
function clearRemoving(wtPath) { try { fs.unlinkSync(removingFile(wtPath)); } catch {} }
// A marker whose writer is gone is not a removal, and leaving it would strand the card in
// a state nothing can clear. `kill(pid, 0)` is the liveness test the rest of the fleet uses
// (fleet-event.sh's nudge lock does the same with `kill -0`); a marker we cannot parse is
// treated the same way as a dead one, since a state nobody can read is not a state.
// A SURVIVING REMOVAL OUTLIVES ITS MARKER'S OWNER, which is the cost of letting the child
// finish: the file is written here and cleared by the callback, and if the grid leaves
// first there is no callback. isRemoving() drops a stale marker whenever something asks
// about that worktree — but once the worktree is gone nothing asks again, so the file would
// sit in the fleet dir forever. One readdir at startup closes that, and only at startup:
// buildItems() runs four times a second and this is a write.
function sweepRemovingMarkers() {
  let names = [];
  try { names = fs.readdirSync(FLEET_DIR); } catch { return; }
  const prefix = `${SOCK}.`;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.removing')) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, n), 'utf8')); } catch { m = null; }
    const pid = Number(m && m.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); continue; } catch {}      // its grid is still there
    }
    try { fs.unlinkSync(path.join(FLEET_DIR, n)); } catch {}
  }
}
function isRemoving(wtPath) {
  let m;
  try { m = JSON.parse(fs.readFileSync(removingFile(wtPath), 'utf8')); } catch { return false; }
  const pid = Number(m && m.pid);
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); return true; } catch {}
  }
  clearRemoving(wtPath);                    // stale: its grid is gone
  return false;
}

// ── remove a free worktree's checkout, asynchronously ────────────────────────
// The BRANCH is left alone on purpose: a worktree is a working copy, and deleting
// someone's branch because they tidied up a folder is not a thing you can undo. git
// refuses on a dirty tree — that refusal is the message the caller shows, and forcing past
// it is a different, deliberate keystroke.
//
// IT OUTLIVES THE SCREEN, and that took a measurement to get right. Pressing ` while a
// removal runs must not abort it half way — the user asked for the worktree to go — and the
// alternative (refusing to leave until git finishes) was rejected because ⌃C and ` have to
// answer in a TUI, and trapping someone behind a minute of git on a slow disk is worse than
// anything it protects against.
//
// `detached: true` + unref() is NOT enough, which is the part worth writing down: the grid
// runs in a tmux pane, and when the pane's process exits the pane dies and its session
// takes a SIGHUP. Measured with a ticking child three ways — detached with pipes, detached
// with no stdio at all, and detached under `nohup` — the first two stop the instant the
// pane closes and only the third keeps going. So SIGHUP is the killer and the pipes are
// irrelevant, which is lucky: stderr stays a pipe and the refusal message still arrives
// while the grid is alive to show it.
//   nohup is invoked with an argv array rather than a shell string on purpose. A worktree
// path can contain a space, and `sh -c "trap '' HUP; exec git …"` would need that path
// quoted into a shell line — a quoting bug there deletes the wrong directory. If nohup is
// somehow missing, the removal still runs (see the fallback below) and merely reverts to
// dying with the pane, which is the recoverable case rather than a broken one.
//
// AND IT IS RECOVERABLE ANYWAY, because a SIGKILL is not survivable by any of this: a
// removal cut off half way leaves the directory gone and the administrative entry behind,
// git reports that entry as `prunable`, and worktreesOf() prunes exactly then. Re-running a
// removal whose directory is already gone also succeeds silently (measured, git 2.55). So
// the worst case is one stale entry and one stale marker, both cleared by the next read.
function beginRemoveWorktree(wtPath, force, done) {
  const repo = mainRepo();
  if (!repo) return done({ ok: false, msg: 'no git checkout found for this project' });
  markRemoving(wtPath, force);
  const gitArgv = ['git', '-C', repo, 'worktree', 'remove', ...(force ? ['--force'] : []), wtPath];
  const opts = { encoding: 'utf8', detached: true };
  const finished = (err, _so, se) => {
    clearRemoving(wtPath);
    done(err ? { ok: false, msg: removeFailMsg(se, wtPath) } : { ok: true });
  };
  // THE FALLBACK HAS TO LIVE IN THE CALLBACK, not in a try/catch, and that distinction is
  // the whole reason this is written out: a missing BINARY is not a thrown error from
  // execFile, it is an ENOENT delivered asynchronously. A try/catch around it can never
  // fire, so the first cut of this would have reported "git worktree remove failed" on any
  // machine without nohup while never running git at all — a removal that silently does
  // nothing, which is worse than the freeze.
  //   err.code is the discriminator: a STRING ('ENOENT') for a spawn that never happened, a
  // NUMBER for a git that ran and exited non-zero. So only the first retries, and a missing
  // git falls through the retry and is reported.
  const start = (useNohup) => {
    const child = useNohup
      ? execFile('nohup', gitArgv, opts, (err, so, se) => {
          if (err && err.code === 'ENOENT') { start(false); return; }   // no nohup here
          finished(err, so, se);
        })
      : execFile(gitArgv[0], gitArgv.slice(1), opts, finished);
    child.unref();
    return child;
  };
  try { return start(true); }
  catch (e) { clearRemoving(wtPath); return done({ ok: false, msg: removeFailMsg(e.message, wtPath) }); }
}

function discoverCheckouts() {
  // 1) explicit config wins: ~/.config/ghostfleet/checkouts, one path per line
  try {
    const paths = fs.readFileSync(CFG_FILE, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(p => p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (paths.length) return [...new Set(paths)].sort();
  } catch {}
  // 2) prefer project-name roots (~/<session>, ~/<session sans version suffix>)
  const named = collectRepos(nameRoots);
  if (named.length) {
    // pull in each found repo's OWN worktrees too (fleet-spawn siblings live in its
    // parent, which a single-repo-style project registration never scans into)
    const withWorktrees = new Set(named);
    for (const repo of named) for (const wt of worktreesOf(repo)) withWorktrees.add(wt.path);
    return [...withWorktrees].sort();
  }
  // 3) fall back to the pane's cwd + its parent
  return collectRepos(cwdRoots);
}

// ── terminal / screen ─────────────────────────────────────────────────────
let ttyFd; try { ttyFd = fs.openSync('/dev/tty', 'w'); } catch { ttyFd = 2; }
const tty = fs.createWriteStream(null, { fd: ttyFd });
function W() { return process.stderr.columns || 80; }
function H() { return process.stderr.rows || 24; }
function out(s) { tty.write(s); }

let mode = 'grid';           // 'grid' | 'picker' | 'nameprompt' | 'agentpick' | 'rename' | 'schedule' | 'newwt'
let sel = 0;                 // selection index in grid
let cards = [];
let items = [];              // grid items: cards + {new:true}
let checkouts = [];
let pickSel = 0;
let pickFresh = false;       // picker opened via N (fresh parallel) vs n (resume)
let nameCwd = '';            // checkout chosen in the picker, awaiting a session name
let nameInput = '';          // editable, pre-filled with the checkout's basename
let agentSel = 0;            // selection on the agent screen (only shown if >1 installed)
// Resuming an already-known worktree needs no naming step — that's only for the
// explicit "+ new session" flow. Attach straight in with the worktree's own name.
function freeWtChoice(w) { return `new${US}${w.path}${US}${path.basename(w.path)}`; }
let confirmKill = null;      // session name awaiting kill confirmation
let schedFor = null;         // session name being scheduled
let schedInput = '';         // typed "<time> | <message>" buffer
let timer;                   // refresh interval (session grid / projects)
let selInit = false;         // apply --select preselect exactly once (first build)
let gSettings = false;       // per-session settings page open (auto-nudge)
let gSetSel = 0;             // selected row on the per-session settings page
let renameOld = null;        // session being renamed (from the settings page's 'r')
let renameInput = '';        // editable, pre-filled with the current name
let renameMsg = '';          // error from the last attempt, shown until you retype
let wtFields = null;         // { name, branch, from, agent } while the new-worktree form is open
let wtSel = 0;               // selected field on that form
let wtMsg = '';              // what fleet-spawn complained about last time (may be several lines)
let wtBusy = false;          // mid-create — a fetch + a session boot is not instant
let confirmWt = null;        // { path, branch, msg, force } — free worktree awaiting removal
// A removal's OUTCOME, which now arrives after the keystroke that asked for it and so has
// nowhere else to land. Deliberately NOT named wtMsg: that one belongs to the new-worktree
// FORM and is rendered as its own multi-line block, and one name for two unrelated messages
// is how a refusal ends up on the wrong screen. (It was, for one edit — the declaration
// collided and node refused to parse the file, which is the good version of that mistake.)
//   Cleared by the next key, the way the stack screen clears sMsg: a refusal has to stay on
// screen long enough to read, and the 1.2s poll must not wipe it.
let wtRmMsg = '';
let labelFor = null;         // session being labelled (from the settings page's 'l')
let labelInput = '';         // editable, pre-filled with the current label

// Rename BOTH the tmux session and its worktree folder (git worktree move), so the
// two never drift apart — a session named "x" always sitting in a folder named "x"
// is the invariant the rest of the grid (and fleet-spawn) relies on. Shells out to
// bin/fleet-rename (same pattern as pauseSession -> bin/fleet-pause below) rather
// than duplicating the git/tmux/marker-migration logic here.
function doRename(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return { ok: false, msg: 'unchanged' };
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-rename');
  try {
    execFileSync(bin, ['-s', SOCK, oldName, newName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').pop();
    return { ok: false, msg: (msg || 'rename failed').replace(/^fleet-rename: /, '').slice(0, 100) };
  }
  patchStatusFile(oldName, newName);
  return { ok: true };
}
// status file(s): patch slot/cwd/folder now instead of waiting for the next hook
// event to overwrite them (Stop/UserPromptSubmit would anyway, but not right away)
function patchStatusFile(oldName, newName) {
  try {
    for (const f of fs.readdirSync(FLEET_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(FLEET_DIR, f);
      let o; try { o = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (o.slot === oldName && ownedBy(o, SOCK, Z)) {
        const newPath = path.join(path.dirname(o.cwd || ''), newName);
        o.slot = newName; o.cwd = newPath; o.folder = newName;
        try { fs.writeFileSync(p, JSON.stringify(o)); } catch {}
      }
    }
  } catch {}
}

function buildItems() {
  cards = gather();
  const free = freeWorktrees();
  items = [...cards.map(c => ({ card: c })), ...free.map(w => ({ freeWt: w })), { newCard: true }];
  if (!selInit) {            // first build: land on the session we just came back from
    selInit = true;
    if (SELECT) { const i = items.findIndex(it => it.card && it.card.name === SELECT); if (i >= 0) sel = i; }
  }
  if (sel >= items.length) sel = items.length - 1;
  if (sel < 0) sel = 0;
}

function cols() { return Math.max(1, Math.floor(W() / (CW + 3))); }

function renderGrid() {
  // Counted by statusCounts() so the header, --plain and --json cannot disagree; limit
  // and interrupted are separate buckets there and never folded into ready.
  const { need_you: need, working: work, ready, parked, limit: limited, interrupted: cut }
    = statusCounts(cards);
  let buf = '\x1b[H';
  const header = ` ${C.bold}ghostfleet${C.reset} ${C.dim}[${PROFILE}:${Z}]${C.reset}   ` +
    `${C.red}${need} need you${C.reset} · ${C.cyan}${work} working${C.reset} · ${C.green}${ready} ready${C.reset}` +
    (cut ? ` · ${C.red}${cut} interrupted${C.reset}` : '') +
    (limited ? ` · ${C.yellow}${limited} at limit${C.reset}` : '') +
    (parked ? ` · ${C.grey}${parked} parked${C.reset}` : '');
  // Same banner as the Projects screen, with the live counts beside the ship. Falls
  // back to the one-line header on a window too small to spend the rows on.
  buf += banner([
    `${C.bold}ghostfleet${C.reset} ${C.dim}[${PROFILE}:${Z}]${C.reset}`,
    `${C.red}${need} need you${C.reset} · ${C.cyan}${work} working${C.reset} · ${C.green}${ready} ready${C.reset}` +
      (parked ? ` · ${C.grey}${parked} parked${C.reset}` : ''),
  ]) ?? (header + '\x1b[K\n');
  if (confirmKill)
    buf += `${C.red}${C.bold} kill session '${confirmKill}'?${C.reset}${C.red} y = yes · any other key = cancel${C.reset}\x1b[K\n`;
  else if (confirmWt)
    // Clip to what actually fits beside the key hint: a line that wraps pushes the
    // whole card grid down a row and reflows it under you as you read it.
    buf += confirmWt.busy
      ? `${C.yellow}${C.bold} removing worktree '${path.basename(confirmWt.path)}'…${C.reset}` +
        `${C.yellow} deleting the checkout — this can take a minute on a big one${C.reset}\x1b[K\n`
      : confirmWt.force
      ? `${C.red}${C.bold} ${clip(confirmWt.msg, Math.max(20, W() - 40))}${C.reset}` +
        `${C.red} — f = remove anyway · any key = cancel${C.reset}\x1b[K\n`
      : `${C.red}${C.bold} remove worktree '${path.basename(confirmWt.path)}' (${confirmWt.branch})?${C.reset}` +
        `${C.red} y = yes · any other key = cancel${C.reset}\x1b[K\n`;
  else if (wtRmMsg)
    buf += `${C.yellow}${C.bold} ${clip(wtRmMsg, Math.max(20, W() - 2))}${C.reset}\x1b[K\n`;
  else
    buf += (jumpStage ? jumpHint() : '') + '\x1b[K\n';
  const nc = cols();
  for (let i = 0; i < items.length; i += nc) {
    const rowItems = items.slice(i, i + nc);
    const linesPerCard = rowItems.map((it, j) => {
      const idx = i + j;
      return it.newCard ? newCardLines(idx === sel)
           : it.freeWt  ? freeCardLines(it.freeWt, idx === sel, idx)
           : cardLines(it.card, idx === sel, idx);
    });
    for (let li = 0; li < 5; li++) {
      buf += ' ' + linesPerCard.map(lc => lc[li]).join(' ') + '\x1b[K\n';
    }
    buf += '\x1b[K\n';
  }
  // `x` means two different things depending on what's selected, so the footer says
  // which one it means RIGHT NOW rather than making you find out by pressing it.
  const xVerb = items[sel]?.freeWt ? 'x remove wt' : 'x kill';
  // N EARNS ITS OWN ENTRY, next to `n`, for the same reason `p pause · P resume` has two:
  // the shift variant is not guessable from the base one. It was bound and documented on
  // the picker's own header and nowhere a person looks BEFORE pressing something —
  // reported as not being able to find it at all, after landing on what looked like a
  // duplicate of master.
  //   Measured rather than eyeballed, because CLAUDE.md is full of rows that fit at one
  // width and clip at another: this footer WRAPS, it never truncates, and nothing sizes
  // the card area against its height. At 8 cards in 24 rows it costs one more wrapped
  // line between 93 and 106 columns and none above; at 80 the banner was already being
  // pushed off by the footer as it stood, which is its own problem and not this one.
  buf += `${C.dim} ↑↓←→/hjkl move · ⇧hjkl reorder · ⏎/1-9 enter · n new · N parallel · w worktree · t stack · ` +
         `s sched · p pause · P resume · ${xVerb} · , settings · Ctrl-t term · Ctrl-n edit · Ctrl-f jump · ` +
         `Ctrl-p/Q projects · q/\` back${C.reset}\x1b[K\n`;
  buf += '\x1b[J'; // clear from cursor to end of screen
  out(buf);
}

function renderPicker() {
  let buf = '\x1b[H';
  // WHICH HALF IS SURPRISING: `n` RESUMES. Picking a checkout that already has a
  // conversation — master's own, most obviously — reopens that conversation, so the new
  // card reads as a duplicate of the session you already had rather than as a second one.
  // That is the whole of the report this line answers, so it is said on the screen where
  // the checkout is picked and not only in the release notes.
  buf += pickFresh
    ? ` ${C.bold}new PARALLEL session${C.reset} ${C.dim}— a FRESH conversation, alongside whatever is already in that checkout${C.reset}\x1b[K\n\x1b[K\n`
    : ` ${C.bold}new session${C.reset} ${C.dim}— RESUMES that checkout's conversation (press ${C.reset}N${C.dim} instead for a fresh one)${C.reset}\x1b[K\n\x1b[K\n`;
  if (checkouts.length === 0) {
    buf += `${C.yellow}  no git checkouts found automatically${C.reset}\x1b[K\n`;
    buf += `${C.dim}  looked in: ${discoverRoots().map(r => r.replace(HOME, '~')).join(', ')}${C.reset}\x1b[K\n`;
    buf += `${C.dim}  fix: put one path per line in ~/.config/ghostfleet/checkouts${C.reset}\x1b[K\n`;
  } else {
    checkouts.forEach((c, i) => {
      const mark = i === pickSel ? `${C.bold}${C.green}▸ ` : '  ';
      const end = i === pickSel ? C.reset : '';
      buf += `${mark}${c.replace(HOME, '~')}${end}\x1b[K\n`;
    });
  }
  buf += `\x1b[K\n${C.dim} ↑↓ move · ⏎ name it · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}

function renderNamePrompt() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}session name${C.reset} ${C.dim}— ${nameCwd.replace(HOME, '~')}${C.reset}\x1b[K\n\x1b[K\n`;
  buf += ` name:  ${C.bold}${nameInput}${C.reset}▏\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} a live session with the same name gets -2/-3 appended automatically${C.reset}\x1b[K\n\x1b[K\n`;
  const next = installedAgents().length > 1 ? 'pick an agent' : 'create';
  buf += `${C.dim} ⏎ ${next} · esc/\` back to the checkout list${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}

// Which coding CLIs are actually usable, from the adapter. Cached for the process:
// this only gates a UI step, and re-shelling per keystroke would be silly.
// Resolved as our own sibling first, for the same reason busyReFor does it — a PATH
// miss would silently collapse the choice to claude-only and nobody would know why.
let _agents = null;
function installedAgents() {
  if (_agents) return _agents;
  _agents = ['claude'];
  for (const bin of [SIBLING_AGENT_BIN, 'fleet-agent']) {
    try {
      const out = execFileSync(bin, ['installed'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const list = out.split('\n').map(s => s.trim()).filter(s => /^[a-z0-9_-]+$/.test(s));
      if (list.length) _agents = list;
      break;                       // it ran; its answer stands even if short
    } catch { /* not there — try the next */ }
  }
  return _agents;
}

// Only reached when more than one agent is installed, so a claude-only machine
// never sees this screen and its new-session flow is unchanged.
function renderAgentPick() {
  const agents = installedAgents();
  let buf = '\x1b[H';
  buf += ` ${C.bold}agent${C.reset} ${C.dim}— ${nameInput} in ${nameCwd.replace(HOME, '~')}${C.reset}\x1b[K\n\x1b[K\n`;
  agents.forEach((a, i) => {
    const on = i === agentSel;
    const mark = on ? `${C.bold}${C.white} ▸ ` : '   ';
    // Say what you're giving up BEFORE the choice, not after it goes wrong.
    const caps = [];
    if (a !== 'claude') {
      if (agentField(a, 'hooks') !== 'yes')  caps.push('no done/need-you nudges');
      if (agentField(a, 'resume') !== 'yes') caps.push('no resume');
      if (agentField(a, 'budget') !== 'yes') caps.push('not budget-metered');
    }
    const note = caps.length ? `  ${C.dim}(${caps.join(' · ')})${C.reset}` : '';
    buf += `${mark}${on ? C.bold + C.white : C.reset}${padEndV(a, 12)}${C.reset}${note}\x1b[K\n`;
  });
  buf += `\x1b[K\n${C.dim} ↑↓/jk move · ⏎ create · esc/\` back to the name${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
// one adapter field, cached per (agent,field) — used only to annotate the picker
const _fieldCache = new Map();
function agentField(agent, field) {
  const k = `${agent}\u0000${field}`;
  if (_fieldCache.has(k)) return _fieldCache.get(k);
  let v = '';
  for (const bin of [SIBLING_AGENT_BIN, 'fleet-agent']) {
    try { v = execFileSync(bin, ['field', agent, field], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); break; }
    catch { /* try the next */ }
  }
  _fieldCache.set(k, v);
  return v;
}

function renderSchedule() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}schedule a message${C.reset} ${C.dim}→ ${schedFor}${C.reset}\x1b[K\n`;
  const existing = readSched(schedFor);
  if (existing && existing.at > Math.floor(Date.now() / 1000))
    buf += ` ${C.yellow}currently: @${clockLabel(existing.at)} "${existing.msg}"${C.reset} ${C.dim}— a new time replaces it; empty + ⏎ cancels${C.reset}\x1b[K\n`;
  else
    buf += '\x1b[K\n';
  const parts = schedInput.split('|');
  const at = parseWhen((parts[0] || '').trim());
  const msg = (parts[1] || 'continue').trim() || 'continue';
  buf += ` send at:  ${C.bold}${schedInput}${C.reset}▏\x1b[K\n`;
  buf += at
    ? ` ${C.green}→ ${clockLabel(at)}  (${new Date(at * 1000).toLocaleString()})${C.reset}\x1b[K\n`
    : ` ${C.dim}→ enter a time${C.reset}\x1b[K\n`;
  buf += ` ${C.dim}message:${C.reset} ${msg}\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} examples: 3:50am · 15:30 · +2h   ·   customize text with  <time> | <message>${C.reset}\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} ⏎ schedule · empty + ⏎ clears a pending one · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
// settings page: per-SESSION toggle for the worker→master auto-nudge
function renderSettings() {
  const names = cards.map(c => c.name);
  gSetSel = Math.max(0, Math.min(gSetSel, Math.max(0, names.length - 1)));
  const pOn = projPushOn();
  let buf = '\x1b[H';
  buf += ` ${C.bold}settings${C.reset} ${C.dim}— worker → master auto-nudge, per session${C.reset}\x1b[K\n`;
  buf += ` ${C.dim}a session's own setting wins over the project's.  project ${C.reset}${C.bold}${Z}${C.reset}${C.dim}: ${C.reset}` +
         `${pOn ? `${C.green}on` : `${C.grey}off`}${C.reset} ${C.dim}(change on the projects screen → ,)${C.reset}\x1b[K\n\x1b[K\n`;
  if (!names.length) buf += ` ${C.dim}(no sessions yet)${C.reset}\x1b[K\n`;
  names.forEach((n, i) => {
    const st = sessPush(n), selRow = i === gSetSel;
    const badge = st === 'on'  ? `${C.green}● on     ${C.reset}`
                : st === 'off' ? `${C.red}○ off    ${C.reset}`
                :                `${C.grey}· inherit${C.reset}`;
    const detail = st === 'inherit' ? `follows project · ${pOn ? 'on' : 'off'}` : 'this session';
    buf += `${selRow ? `${C.bold}${C.white}▸ ` : '   '}${badge}  ` +
           `${(selRow ? C.bold + C.white : C.reset) + padEndV(n, 22) + C.reset} ${C.dim}${detail}${C.reset}\x1b[K\n`;
  });
  buf += `\x1b[K\n${C.dim} ↑↓/jk move · space/⏎ cycle inherit → on → off · r rename · l label · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function renderRename() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}rename${C.reset} ${C.dim}— ${renameOld}${C.reset}\x1b[K\n\x1b[K\n`;
  buf += ` new name:  ${C.bold}${renameInput}${C.reset}▏\x1b[K\n\x1b[K\n`;
  buf += (renameMsg ? `${C.red}${renameMsg}${C.reset}` : '') + '\x1b[K\n\x1b[K\n';
  buf += `${C.dim} renames the tmux session AND moves its worktree folder (git worktree move)${C.reset}\x1b[K\n`;
  buf += `${C.dim} ⏎ rename · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
// The insertable text in a stdin chunk. A PASTE (and a fast enough typist) arrives
// as one multi-character read, which a `key.length === 1` test drops on the floor
// without a sound — and a base ref is exactly the kind of thing you paste rather
// than type. Anything starting with ESC is an escape sequence (arrows, shift-tab),
// never text. '.' and ':' go for the same reason the naming screen bars them: tmux
// rejects both in a session name, and this name becomes one.
function typedText(key) {
  if (!key || key.startsWith('\x1b')) return '';
  return [...key].filter(ch => ch >= ' ' && ch !== '\x7f' && ch !== '.' && ch !== ':').join('');
}
// The fields the new-worktree form shows. `agent` only appears when there is
// actually a choice to make — the same rule the naming screen uses before it
// detours through the agent picker, so a claude-only machine sees three rows.
function wtRows() {
  const rows = [
    { key: 'name',   label: 'name',   hint: 'the session + the folder' },
    { key: 'branch', label: 'branch', hint: 'blank = same as the name' },
    { key: 'from',   label: 'from',   hint: 'base ref for a new branch' },
  ];
  if (installedAgents().length > 1) rows.push({ key: 'agent', label: 'agent', hint: '←/→ to change' });
  return rows;
}
function renderNewWorktree() {
  const repo = mainRepo();
  const rows = wtRows();
  const target = repo ? path.join(path.dirname(repo), wtFields.name || '…') : '(nowhere — no git checkout)';
  let buf = '\x1b[H';
  buf += ` ${C.bold}new worktree${C.reset} ${C.dim}— a sibling checkout of ${path.basename(repo || Z)}, on its own branch${C.reset}\x1b[K\n`;
  buf += ` ${C.cyan}${target.replace(HOME, '~')}${C.reset}\x1b[K\n\x1b[K\n`;
  rows.forEach((r, i) => {
    const on = i === wtSel;
    // branch shows what it will ACTUALLY use when left blank, rather than nothing —
    // the default is the name, and a blank line reads like "no branch".
    const val = wtFields[r.key] || '';
    const shown = (r.key === 'branch' && !val) ? `${wtFields.name || ''}${C.dim} (from the name)${C.reset}` : val;
    const cursor = (on && r.key !== 'agent') ? '▌' : '';
    buf += `${on ? ` ${C.bold}${C.white}▸ ` : '   '}${padEndV(r.label, 8)}${C.reset}` +
           `${on ? C.white : C.dim}${shown}${cursor}${C.reset}` +
           `${C.dim}${on ? `   ${r.hint}` : ''}${C.reset}\x1b[K\n`;
  });
  buf += '\x1b[K\n';
  // A CONSTANT-HEIGHT MESSAGE BLOCK. fleet-spawn's refusals are paragraphs (see
  // spawnFailLines), and a block that grew with them would walk the footer down the
  // screen and, on the next render, leave the old footer drawn below the new one —
  // this screen redraws from cursor-home and never clears. So always spend WT_MSG_ROWS
  // rows, blank when there is nothing to say. Every line is clipped to the pane, since
  // one wrapped line costs a row just the same.
  const msgRows = Math.max(1, Math.min(WT_MSG_ROWS, H() - rows.length - 8));
  const body = wtBusy ? ['creating the worktree and starting the session…']
             : wtMsg  ? wtMsg.split('\n') : [];
  for (let i = 0; i < msgRows; i++) {
    const line = body[i];
    buf += (line ? ` ${i === 0 ? (wtBusy ? C.yellow : C.red) : C.dim}${clip(line.replaceAll(HOME, '~'), W() - 2)}${C.reset}` : '')
         + '\x1b[K\n';
  }
  buf += '\x1b[K\n';
  buf += `${C.dim} ↑↓/tab field · ⏎ create + open · esc/\` cancel${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function renderLabel() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}label${C.reset} ${C.dim}— what the card calls ${labelFor}${C.reset}\x1b[K\n\x1b[K\n`;
  buf += ` label:  ${C.bold}${labelInput}${C.reset}▏\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} Display only. The session is still '${labelFor}' — that is what fleet-send${C.reset}\x1b[K\n`;
  buf += `${C.dim} addresses and what the Ctrl-f chord counts, and the card keeps showing it.${C.reset}\x1b[K\n`;
  buf += `${C.dim} Empty clears the label.${C.reset}\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} ⏎ save · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function render() {
  if (mode === 'grid') { if (gSettings) renderSettings(); else renderGrid(); }
  else if (mode === 'label') renderLabel();
  else if (mode === 'picker') renderPicker();
  else if (mode === 'nameprompt') renderNamePrompt();
  else if (mode === 'agentpick') renderAgentPick();
  else if (mode === 'rename') renderRename();
  else if (mode === 'newwt') renderNewWorktree();
  else renderSchedule();
}

// ── input ───────────────────────────────────────────────────────────────
function cleanup() {
  try { process.stdin.setRawMode(false); } catch {}
  out('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');   // disable mouse, show cursor, leave alt-screen
}
function finish(result) {
  cleanup();
  clearInterval(timer);
  process.stdout.write(result || '');
  process.exit(0);
}

// ── ^F jump chord ───────────────────────────────────────────────────────────
// The chord tmux implements as key tables (see tmux/cf.tmux.conf) is only reachable
// from INSIDE a session, so these Node screens implement the same grammar and emit
// the same action strings — one grammar, two entry points, both resolved by
// ghostfleet's take_jump:
//   ^F <p> <s>  -> jumps:<p>:<s>     ^F <p> ⏎ / m  -> jumpm:<p>   (that project's master)
//   ^F <p> s    -> jump:<p>          ^F s <p>      -> jump:<p>    (its session grid)
//   ^F p        -> projects          esc / ^C      -> cancel
// jumpKey returns the action to emit, 'handled' when it consumed the key mid-chord,
// or null when no chord is active — so plain digits, s, p and ^C behave as before.
let jumpStage = null;        // null | 'first' | 'proj' | 'grid'
let jumpProj = '';           // project digit collected at the 'first' stage
function jumpHint() {
  const k = s => `${C.reset}${C.bold}${s}${C.dim}`;
  const body = jumpStage === 'first'
    ? `project? ${k('1-9')} · ${k('s')} + digit = that project's grid · ${k('p')} = projects · ${k('esc')}`
    : jumpStage === 'grid'
      ? `session grid of project? ${k('1-9')} · ${k('esc')}`
      : `project ${k(jumpProj)}, session? ${k('1-9')} · ${k('⏎/m')} = master · ${k('s')} = grid · ${k('esc')}`;
  return ` ${C.yellow}${C.bold}jump →${C.reset} ${C.dim}${body}${C.reset}`;
}
function jumpKey(key) {
  const digit = key.length === 1 && key >= '1' && key <= '9';
  if (!jumpStage) {                                   // only ^F opens a chord
    if (key !== '\x06') return null;
    jumpStage = 'first'; jumpProj = ''; return 'handled';
  }
  if (key === '\x1b' || key === '\x03' || key === '\x06') {   // esc / ^C / ^F cancels
    jumpStage = null; jumpProj = ''; return 'handled';
  }
  if (jumpStage === 'first') {
    if (digit) { jumpProj = key; jumpStage = 'proj'; return 'handled'; }
    if (key === 's' || key === 'S') { jumpStage = 'grid'; return 'handled'; }
    if (key === 'p' || key === 'P') { jumpStage = null; return 'projects'; }
    jumpStage = null; return 'handled';               // anything else aborts the chord
  }
  if (jumpStage === 'grid') {                         // ^F s <p>
    jumpStage = null;
    return digit ? `jump:${key}` : 'handled';
  }
  const p = jumpProj;                                 // 'proj': what to open in project p
  jumpStage = null; jumpProj = '';
  if (digit) return `jumps:${p}:${key}`;
  if (key === 'm' || key === 'M' || key === '\r' || key === '\n') return `jumpm:${p}`;
  if (key === 's' || key === 'S') return `jump:${p}`;
  return 'handled';
}

function moveGrid(d) {
  const nc = cols();
  let n = sel;
  if (d === 'left') n--; else if (d === 'right') n++;
  else if (d === 'up') n -= nc; else if (d === 'down') n += nc;
  if (n >= 0 && n < items.length) sel = n;
}

// ── mouse (SGR) ─────────────────────────────────────────────────────────────
// ESC [ < btn ; x ; y (M=press | m=release). Left click = btn 0.
function parseMouse(key) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  return m ? { button: +m[1], x: +m[2], y: +m[3], press: m[4] === 'M' } : null;
}
// 1-based row of the first card line, on BOTH screens: the header (the ship when it
// fits, otherwise one line) plus the confirm/jump row under it.
//
// This was hardcoded to 3, which stopped being true the day the ship went up — the
// banner landed after clickable cards did and nothing told the hit-test. On any window
// wide enough to fly it, every click resolved a whole card-row too low: usually onto
// nothing at all (so the click looked simply dead), and on a fuller grid onto the wrong
// session. Derive it from the same predicate the renderer uses, so the two cannot
// disagree again.
function firstCardRow() { return (bannerFits() ? SHIP.length : 1) + 2; }
// index of the card under terminal cell (x,y) on a header+card-grid screen, or -1.
// Each card block is 5 lines + 1 blank (6 rows); cards CW+2 wide with a 1-col gap and
// 1 leading column.
function cardAt(x, y, nc) {
  const gy = y - firstCardRow(); if (gy < 0 || gy % 6 >= 5) return -1;
  const gx = x - 2; if (gx < 0 || gx % (CW + 3) >= CW + 2) return -1;
  const col = Math.floor(gx / (CW + 3)); if (col >= nc) return -1;
  return Math.floor(gy / 6) * nc + col;
}

function onKey(key) {
  const mev = parseMouse(key);
  if (mev) {
    if (mode === 'grid' && mev.press && mev.button === 0 && !confirmKill && !confirmWt) {
      const idx = cardAt(mev.x, mev.y, cols());
      if (idx >= 0 && idx < items.length) {
        sel = idx;
        const it = items[sel];
        if (it?.newCard) { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = false; mode = 'picker'; render(); }
        else if (it?.card) return finish(`attach${US}${it.card.name}`);
        else if (it?.freeWt) return finish(freeWtChoice(it.freeWt));
      }
    }
    return;   // swallow other mouse events (release, scroll, non-grid modes, misses)
  }
  if (mode === 'grid') {
    // The outcome of the last removal is cleared by the NEXT key, not by the poll — the
    // same rule the stack screen uses for sMsg. The poll redraws four times a second and
    // would blink a refusal off the screen before it could be read; a key is the signal
    // that it HAS been read. Set later in this same call, so the press that produces a
    // message keeps it.
    if (!confirmWt && !confirmKill) wtRmMsg = '';
    if (gSettings) {                                 // per-session auto-nudge toggles
      const names = cards.map(c => c.name);
      if (key === '\x1b' || key === '\x03' || key === 'q' || key === '\x60') gSettings = false;
      else if (key === '\x1b[A' || key === 'k') gSetSel = Math.max(0, gSetSel - 1);
      else if (key === '\x1b[B' || key === 'j') gSetSel = Math.min(Math.max(0, names.length - 1), gSetSel + 1);
      else if (key === ' ' || key === '\r' || key === '\n') { const n = names[gSetSel]; if (n) cycleSessPush(n); }
      else if (key === 'r' || key === 'R') {
        const n = names[gSetSel];
        if (n) { renameOld = n; renameInput = n; renameMsg = ''; mode = 'rename'; gSettings = false; }
      }
      else if (key === 'l' || key === 'L') {
        const n = names[gSetSel];
        if (n) { labelFor = n; labelInput = labelOf(n); mode = 'label'; gSettings = false; }
      }
      render(); return;
    }
    if (confirmKill) {
      if (key === 'y' || key === 'Y') { killSession(confirmKill); confirmKill = null; buildItems(); }
      else confirmKill = null;
      render(); return;
    }
    if (confirmWt) {
      // Forcing takes a DIFFERENT key, not a second 'y'. A second y on a prompt that
      // just refused is a reflex, and this particular one throws away real work.
      const said = confirmWt.force ? (key === 'f' || key === 'F') : (key === 'y' || key === 'Y');
      if (said) {
        // ASYNCHRONOUS, and the prompt closes immediately. This used to run
        // execFileSync, which on a checkout with a real node_modules meant the whole TUI
        // stopped for the better part of a minute — no key, no poll, no redraw, with the
        // "this can take a minute" banner frozen on screen. The card carries the state
        // now (see freeCardLines), so there is nothing left for a modal to hold on to and
        // holding one would only stop the user moving while they wait.
        const wt = confirmWt.path, force = confirmWt.force, wtBranch = confirmWt.branch;
        confirmWt = null;
        wtRmMsg = '';
        beginRemoveWorktree(wt, force, (res) => {
          // THE REFUSAL REOPENS THE PROMPT, IN FORCE MODE — it does not become a line of
          // text. git declining a dirty tree is the guard, not an obstacle, and the answer
          // to it is one keystroke (`f`), so the refusal has to arrive as the thing that
          // takes that keystroke. The first cut of this async version put the message on
          // the grid's message line saying "x then f to force", and that was a lie I only
          // found by driving it: `x` opens a FRESH prompt whose force flag is false, so `f`
          // there cancels instead of forcing. The two-step is exactly the one this screen
          // always had — y, refusal, f — it just now arrives a second after the key.
          //   Not if another prompt has opened in the meantime: a modal that replaces the
          // one you are reading would take your keystroke for a different worktree.
          if (!res.ok) {
            if (!confirmWt && !confirmKill && mode === 'grid' && !gSettings)
              confirmWt = { path: wt, branch: wtBranch, msg: res.msg, force: true };
            else
              wtRmMsg = `${path.basename(wt)}: ${res.msg} — press x on it again to force`;
          }
          buildItems();
          if (mode === 'grid' && !gSettings) render();
        });
        buildItems();
      } else confirmWt = null;
      render(); return;
    }
    {                                                // ^F jump chord (see jumpKey)
      const j = jumpKey(key);
      if (j) { if (j !== 'handled') return finish(j); render(); return; }
    }
    if (key === '\x03' || key === 'q' || key === '\x60') return finish('back');
    if (key === '\x1b[A' || key === 'k') moveGrid('up');
    else if (key === '\x1b[B' || key === 'j') moveGrid('down');
    else if (key === '\x1b[C' || key === 'l') moveGrid('right');
    else if (key === '\x1b[D' || key === 'h') moveGrid('left');
    // ⇧+hjkl: reorder — move the selected session's card. Persisted, because this
    // order IS the fleet's numbering: the digits, 1-9, `Ctrl-f <p> <s>` and ⇧←→ all
    // count these cards, and they have to keep meaning the same session.
    else if (key === 'H' || key === 'L' || key === 'K' || key === 'J') {
      const it = items[sel];
      if (it?.card) {
        const nc = cols();
        const delta = key === 'H' ? -1 : key === 'L' ? 1 : key === 'K' ? -nc : nc;
        const ni = reorderSession(it.card.name, delta);
        buildItems(); if (ni >= 0) sel = ni;      // cards lead `items`, so index == index
      }
    }
    else if (key === 'n') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = false; mode = 'picker'; }
    else if (key === 'N') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = true; mode = 'picker'; }
    // w = a brand-new WORKTREE (n/N start a session in one that already exists).
    else if (key === 'w' || key === 'W') {
      const repo = mainRepo();
      const agents = installedAgents();
      const def = process.env.CLAUDE_FLEET_AGENT || 'claude';
      wtFields = { name: '', branch: '', from: repo ? currentBranch(repo) : '',
                   agent: agents.includes(def) ? def : (agents[0] || 'claude') };
      wtSel = 0; wtBusy = false;
      wtMsg = repo ? '' : 'this project has no git checkout — nothing to branch from';
      mode = 'newwt';
    }
    else if (key === 'x' || key === 'X') {
      const it = items[sel];
      if (it?.card) confirmKill = it.card.name;
      else if (it?.freeWt) {
        // ONE REMOVAL PER WORKTREE, AND PARALLEL ACROSS DIFFERENT ONES — decided by
        // measurement rather than by folklore. Two `git worktree remove` calls at once in
        // one repo were expected to collide on a lock; on git 2.55 they do not, and neither
        // does the same worktree twice (6000-file checkouts, both reported ok, no leftover
        // administrative entries). So parallel is allowed for different worktrees, which is
        // what someone tidying up three at once actually wants and what the per-card state
        // now makes legible.
        //   The SAME worktree is still refused, and not for git's sake: a second press
        // cannot make it any more removed, it spawns a child whose only possible output is
        // a confusing message about a worktree that is already going away, and on an older
        // git than the one measured here it is the case most likely to race. Refusing costs
        // a keystroke and says why.
        if (it.freeWt.removing) wtRmMsg = `already removing '${path.basename(it.freeWt.path)}' — it will disappear when git finishes`;
        else confirmWt = { path: it.freeWt.path, branch: it.freeWt.branch, msg: '', force: false };
      }
    }
    else if (key === 's' || key === 'S') { const it = items[sel]; if (it?.card) { schedFor = it.card.name; schedInput = ''; mode = 'schedule'; } }
    else if (key === 'p') { const it = items[sel]; if (it?.card) pauseSession(it.card.name); }
    else if (key === 'P') { const it = items[sel]; if (it?.card) resumeSession(it.card.name); }
    // t = the sTack screen. s/S are schedule and n/N are new, so this is the free key
    // nearest the rest of the grid's verbs. It leaves this project's grid entirely —
    // the stack lists every project's sessions, which is the point of it.
    else if (key === 't' || key === 'T' || key === '\x18') return finish('stack');
    // ^T / ^N — the SAME keys as inside a session, so the chord doesn't change meaning
    // depending on which screen you're looking at. ^X likewise now carries the stack
    // here, matching tmux; plain `t` keeps it too, since no tab wants that letter.
    // An empty choice means the tab could not be opened (no editor, no tmux). Staying
    // on the grid is the honest outcome; finishing with '' would quit the screen.
    else if (key === '\x14') { const c = tabChoice('term'); if (c) return finish(c); render(); return; }
    else if (key === '\x0e') { const c = tabChoice('edit'); if (c) return finish(c); render(); return; }
    else if (key >= '1' && key <= '9') {              // insta-jump: digit -> that card
      const it = items[Number(key) - 1];
      if (it?.card) { sel = Number(key) - 1; return finish(`attach${US}${it.card.name}`); }
      else if (it?.freeWt) { sel = Number(key) - 1; return finish(freeWtChoice(it.freeWt)); }
    }
    else if (key === '\x10' || key === 'Q') return finish('projects');  // ^P (or Q) -> Projects
                                                     // Q works even before zellij's Ctrl-p unbind applies
    else if (key === ',') {                          // per-session auto-nudge settings
      gSettings = true;
      const it = items[sel]; const i = it?.card ? cards.findIndex(c => c.name === it.card.name) : 0;
      gSetSel = i >= 0 ? i : 0;                      // land on the session you had selected
    }
    else if (key === '\r' || key === '\n') {
      const it = items[sel];
      if (it?.newCard) { checkouts = discoverCheckouts(); pickSel = 0; mode = 'picker'; }
      else if (it?.card) return finish(`attach${US}${it.card.name}`);
      else if (it?.freeWt) return finish(freeWtChoice(it.freeWt));
    }
    render();
  } else if (mode === 'picker') {
    if (key === '\x1b' || key === '\x03' || key === 'q' || key === '\x60') { mode = 'grid'; render(); return; }
    if (key === '\x1b[A' || key === 'k') pickSel = Math.max(0, pickSel - 1);
    else if (key === '\x1b[B' || key === 'j') pickSel = Math.min(checkouts.length - 1, pickSel + 1);
    else if ((key === '\r' || key === '\n') && checkouts.length) {
      nameCwd = checkouts[pickSel]; nameInput = path.basename(nameCwd); mode = 'nameprompt';
    }
    render();
  } else if (mode === 'nameprompt') {
    if (key === '\x1b' || key === '\x03' || key === '\x60') { mode = 'picker'; render(); return; }
    if (key === '\r' || key === '\n') {
      // Only detour through the agent screen when there is actually a choice.
      if (installedAgents().length > 1) {
        // Start on the project's default (CLAUDE_FLEET_AGENT, from the projects file's
        // 4th column) rather than always on claude, so a project set up for opencode
        // doesn't make you re-pick it every single time.
        const def = process.env.CLAUDE_FLEET_AGENT || 'claude';
        const i = installedAgents().indexOf(def);
        agentSel = i >= 0 ? i : 0;
        mode = 'agentpick'; render(); return;
      }
      const name = nameInput.trim() || path.basename(nameCwd);
      return finish(`${pickFresh ? 'newfresh' : 'new'}${US}${nameCwd}${US}${name}`);
    }
    else if (key === '\x7f' || key === '\b') nameInput = nameInput.slice(0, -1);
    else if (key.length === 1 && key >= ' ' && key !== '.' && key !== ':') nameInput += key;
    render();
  } else if (mode === 'agentpick') {
    const agents = installedAgents();
    if (key === '\x1b' || key === '\x03' || key === '\x60') { mode = 'nameprompt'; render(); return; }
    if (key === '\x1b[A' || key === 'k') agentSel = Math.max(0, agentSel - 1);
    else if (key === '\x1b[B' || key === 'j') agentSel = Math.min(agents.length - 1, agentSel + 1);
    else if (key === '\r' || key === '\n') {
      const name = nameInput.trim() || path.basename(nameCwd);
      const agent = agents[agentSel] || 'claude';
      return finish(`${pickFresh ? 'newfresh' : 'new'}${US}${nameCwd}${US}${name}${US}${agent}`);
    }
    render();
  } else if (mode === 'newwt') {
    const rows = wtRows();
    const f = rows[wtSel]?.key || 'name';
    if (key === '\x1b' || key === '\x03' || key === '\x60') { mode = 'grid'; wtFields = null; wtMsg = ''; render(); return; }
    if (key === '\x1b[A' || key === '\x1b[Z') wtSel = (wtSel + rows.length - 1) % rows.length;
    else if (key === '\x1b[B' || key === '\t') wtSel = (wtSel + 1) % rows.length;
    else if (f === 'agent' && (key === '\x1b[C' || key === '\x1b[D' || key === ' ')) {
      const agents = installedAgents();
      const i = Math.max(0, agents.indexOf(wtFields.agent));
      wtFields.agent = agents[(i + (key === '\x1b[D' ? agents.length - 1 : 1)) % agents.length];
    }
    else if (key === '\r' || key === '\n') {
      const name = (wtFields.name || '').trim();
      if (!name) { wtMsg = 'a name is required'; render(); return; }
      // `git worktree add` fetches when the base has an upstream, and the session
      // then has to boot — both block this process, so SAY so before starting rather
      // than freezing on a form that looks like it ignored the keystroke.
      wtMsg = ''; wtBusy = true; render();
      const res = createWorktree({
        name,
        branch: (wtFields.branch || '').trim() || name,
        from: (wtFields.from || '').trim(),
        agent: wtFields.agent || '',
      });
      wtBusy = false;
      if (res.ok) return finish(`attach${US}${res.session}`);
      wtMsg = res.msg;
    }
    else if (key === '\x7f' || key === '\b') wtFields[f] = (wtFields[f] || '').slice(0, -1);
    else if (f !== 'agent') { const t = typedText(key); if (t) wtFields[f] += t; }
    render();
  } else if (mode === 'label') {
    if (key === '\x1b' || key === '\x03' || key === '\x60') { mode = 'grid'; gSettings = true; labelFor = null; render(); return; }
    if (key === '\r' || key === '\n') {
      setLabel(labelFor, labelInput);
      labelFor = null; labelInput = ''; mode = 'grid'; gSettings = true; buildItems();
    }
    else if (key === '\x7f' || key === '\b') labelInput = labelInput.slice(0, -1);
    else { const t = typedText(key); if (t) labelInput += t; }
    render();
  } else if (mode === 'rename') {
    if (key === '\x1b' || key === '\x03' || key === '\x60') {
      mode = 'grid'; gSettings = true; renameOld = null; renameMsg = ''; render(); return;
    }
    if (key === '\r' || key === '\n') {
      const res = doRename(renameOld, renameInput);
      if (res.ok) { renameOld = null; renameInput = ''; renameMsg = ''; mode = 'grid'; gSettings = true; buildItems(); }
      else renameMsg = res.msg;
    }
    else if (key === '\x7f' || key === '\b') renameInput = renameInput.slice(0, -1);
    else if (key.length === 1 && key >= ' ' && key !== '.' && key !== ':') renameInput += key;
    render();
  } else if (mode === 'schedule') {
    if (key === '\x1b' || key === '\x03' || key === '\x60') { mode = 'grid'; schedFor = null; render(); return; }
    else if (key === '\r' || key === '\n') {
      const parts = schedInput.split('|');
      const whenStr = (parts[0] || '').trim();
      if (whenStr === '') {                 // empty time -> cancel any pending schedule
        cancelSchedule(schedFor); mode = 'grid'; schedFor = null; buildItems();
      } else {
        const msg = (parts[1] || 'continue').trim() || 'continue';
        if (schedule(schedFor, whenStr, msg)) { mode = 'grid'; schedFor = null; buildItems(); }
        // invalid time -> stay in schedule mode so they can fix it
      }
    } else if (key === '\x7f' || key === '\b') {
      schedInput = schedInput.slice(0, -1);
    } else if (key.length === 1 && key >= ' ') {
      schedInput += key;
    }
    render();
  }
}

// ── debug: parse a time string and exit ───────────────────────────────────
{
  const wi = process.argv.indexOf('--when');
  if (wi !== -1) {
    const at = parseWhen(process.argv[wi + 1]);
    console.log(at ? `${at}  -> ${clockLabel(at)}  (${new Date(at * 1000).toLocaleString()})` : 'null (unparseable)');
    process.exit(0);
  }
}

// ── debug: print discovered checkouts and exit ────────────────────────────
if (process.argv.includes('--checkouts')) {
  console.log(`scope Z=${Z} (base=${Zbase})`);
  console.log('roots:', discoverRoots().map(r => r.replace(HOME, '~')).join(', '));
  // UNABBREVIATED, and its own line: this is the checkout `w` runs fleet-spawn in, and
  // the whole reason it is printed is that it used to answer a LINKED WORKTREE — which
  // looks entirely reasonable in a list and makes every create fail the nesting guard.
  console.log('main repo:', mainRepo());
  const cks = discoverCheckouts();
  console.log('checkouts:\n' + (cks.length ? cks.map(c => '  ' + c).join('\n') : '  (none)'));
  process.exit(0);
}

// ── the fleet's CARD ORDER, one session per line (master excluded) ────────
// The single source of that order. bin/ghostfleet resolves `Ctrl-f <p> <s>` through
// this and mirrors it onto the tmux server for fleet-cycle, so every consumer counts
// the same cards the screen shows — "session 2" cannot mean two different sessions
// depending on how you got there. Deliberately does NOT call gather(): it needs
// names, not a capture-pane round trip per session.
if (process.argv.includes('--order')) {
  const names = applyOrder(tmuxList().filter(s => !isLead(s.name))).map(s => s.name);
  if (names.length) console.log(names.join('\n'));
  process.exit(0);
}

// ── json (machine-readable) mode ──────────────────────────────────────────
// docs/mobile.md §4. The wire format the phone renders from, and the whole reason it is
// THIS file: a second implementation of "what is this session doing" would drift from
// the grid's, and the grid's is the one with the scars. Everything here comes from
// gather() and statusCounts() — the same two calls the TUI draws from — so the phone and
// the grid cannot disagree about a fleet.
//
// The fields are exactly what cardLines() consumes, and nothing else. No cwd (the card
// never shows it), no pid out of the schedule marker: a field the TUI does not render is
// a field nothing keeps honest.
//
// UNTRUNCATED, which is the point. --plain clips the branch to 26 columns and the
// message to 44 and pads both, so a consumer of that text cannot tell an elided branch
// from a real one — `feat/rate-limit-beside-fo…` is a plausible branch name. These are
// the values as computed.
//
// Checked BEFORE --plain so `--json --plain` gives the parseable one: a caller that
// passed both wants a machine to read the result, and a caller that wanted the table
// would not have asked for json.
// AND IT IS AWAITED RATHER THAN console.log'd. process.exit() DISCARDS a pending stdout
// write, and on macOS a pipe is asynchronous — so `console.log(json); process.exit(0)`
// truncates at the 64KB pipe buffer with no error on either side. Measured on this
// machine: 200 000 bytes written, 65 536 received, the JSON stopping mid-string. It is
// reachable because `msg` has no length bound (it is a whole assistant turn), and it
// fails as unparseable garbage rather than as a missing field — the reader cannot even
// tell it was truncated. --plain is not exposed to this: its message column is clipped
// to 46, so a row is ~126 bytes and you would need 500 sessions to fill the buffer.
//   The await is also what keeps the module body from falling through into the TUI,
// which is what a bare write-with-callback would do.
//
// AND IT IS THE ONE CALLER THAT ASKS FOR THE LEAD. The TUI is drawn from inside master,
// so its own card would be redundant there; a phone is inside nothing and master was
// therefore unreachable from it — reported by the person using the app as "it's not
// opening the main agent, just the sessions". gather({lead:true}) puts it first; the TUI
// and --plain still call gather() and are byte-for-byte what they were.
if (JSON_OUT) {
  const rows = gather({ lead: true });
  await new Promise(res => process.stdout.write(JSON.stringify({
    project: Z,
    profile: PROFILE,
    // COUNTED OVER THESE CARDS, lead included — `counts` is a fold over `cards` and
    // nothing else, which is the only definition that cannot drift: web/grid.js's
    // countsFrom() folds the same array in the client, and the suite asserts the two
    // agree on every fixture. Excluding the lead from one fold and not the other is how
    // the header starts lying. It also answers the question the phone exists to ask
    // (§1: "is anything blocked on me") — a lead sitting on a permission prompt is the
    // most important `need_you` on the fleet, and reporting "0 need you" over it would be
    // the summary lying at exactly the glance you would act on. The TUI's header counts
    // no lead because the TUI's cards contain none: one rule, two card lists.
    counts: statusCounts(rows),
    cards: rows.map(c => ({
      name:     c.name,           // what fleet-send / fleet-read address
      // '' means unlabelled internally; on the wire that is null, so "is this card
      // titled by a label" is one test for the client rather than two.
      label:    c.label || null,
      // The nine-value vocabulary, verbatim and uncollapsed — need-you, working, ready,
      // parked, idle, starting, unknown, limit, interrupted. `unknown` in particular is
      // NOT idle: it means the agent's adapter has no validated busy detector and we
      // genuinely cannot tell, and a client that renders it as a confident green dot
      // undoes the one thing this status layer is for.
      status:   c.status,
      folder:   c.folder,
      branch:   c.branch,
      agent:    c.agent,          // the card only draws it when != claude
      // The PR number for this session's branch, as a STRING and null when unknown.
      // A string because it is an identifier that gets printed, never arithmetic — and
      // because JSON's number type invites a client to reformat it. Unknown is null and
      // means exactly "we could not tell": no gh, no network, no PR and a cold cache all
      // land here, and the card draws as it did before this field existed.
      pr:       c.pr || null,
      msg:      c.msg,
      age:      c.age,            // seconds since the last transcript write; null = unknown
      attached: c.attached,
      // The epoch AND the prompt, but not the pid. `@10:30pm` with no way to say WHAT
      // will be sent is half a fact: in the TUI you are one keystroke from the session
      // and can go and look, and on a phone you are not, so the scheduled text is the
      // difference between a card that informs and a card that raises a question it
      // cannot answer. The pid stays out because it identifies a process on one machine
      // and means nothing to a client that isn't on it.
      //   `msg` is emitted WHOLE. It is a user-authored prompt of arbitrary length —
      // the only field here that is — and the card renders one line of it, but clipping
      // it here would be a display decision taken in the wrong layer: §11.3 settled
      // that content is served unredacted and bounded only for transport cost, and the
      // card's own `msg` already works this way. The client clips.
      //   Both paths that write a marker default the text to "continue" and cannot
      // write an empty one, so this is a non-empty string in practice; `?? null` is for
      // a marker that predates the field rather than a case the fleet can produce.
      sched:    c.sched ? { at: c.sched.at, msg: c.sched.msg ?? null } : null,
      limit_at: c.limitAt || null,   // "10:20pm" — when the usage window rolls over
      // THE ONE FIELD THE TUI'S CARD DOES NOT DRAW, and it is here because the TUI has no
      // lead card to draw it on. Without it a client can only tell the lead apart by
      // comparing the string "master" itself — in the card list, on the session screen,
      // and in front of every destructive button — and a comparison in three places is a
      // comparison that drifts. `fleet-worktrees` already calls this row LEAD.
      //   A boolean on EVERY card, never omitted on the workers: "is this the lead" must
      // be one test, and an absent key reads as false in exactly the same way a real
      // false does, right up until the day it is absent for another reason.
      lead:     c.lead,
    })),
    free_worktrees: freeWorktrees(),
  }) + '\n', res));
  process.exit(0);
}

// ── the removal refusal, formatted, without a TUI ────────────────────────────
// `fleet-grid.mjs <sock> --wt-remove-msg <worktree-path>` reads git's stderr on stdin and
// prints what the grid would put on its message line. It exists for the reason --plain
// does: the interactive path cannot be driven by the suite, and this is the part of it
// with the scars — a full path pushing the actual reason off the end of the line. The
// suite feeds it real `git worktree remove` stderr and asserts the shaped result.
if (process.argv.includes('--wt-remove-msg')) {
  const wtPath = process.argv[process.argv.indexOf('--wt-remove-msg') + 1] || '';
  // readFileSync(0) rather than stdin events, so this is a real early exit like --plain's
  // and not a callback that lets the TUI start underneath it. An empty stdin is a case
  // worth having: it is what a git that said nothing at all produces.
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  // writeSync + exit, NOT process.stdout.write(cb) + exit-in-callback. The callback form
  // schedules the exit for later, so execution falls straight through this branch into the
  // TUI bootstrap at the bottom of the file — measured: the first cut of this printed the
  // message AND opened the alt-screen. The --json path can use the callback because it is
  // written to be the last thing that happens; this one is not, so it exits synchronously.
  // One short line, so a partial write is not a concern the way it is for a 200KB payload.
  try { fs.writeSync(1, removeFailMsg(raw, wtPath) + '\n'); } catch {}
  process.exit(0);
}

// ── plain (non-interactive) mode ──────────────────────────────────────────
if (PLAIN) {
  const rows = gather();
  const { need_you: need, working: work, ready } = statusCounts(rows);
  console.log(`${need} need you · ${work} working · ${ready} ready`);
  // AGENT is in the plain table because this is the path used to verify the fleet
  // without drawing the TUI — a status you can't attribute to an agent is not
  // checkable, and "is this session even using the detector I think it is" is the
  // first question when a signal looks wrong.
  console.log(['TAB', 'CHECKOUT', 'BRANCH', 'AGENT', 'STATUS', 'LAST MSG', 'IDLE']
    .map((h, i) => h.padEnd([12, 14, 26, 9, 11, 46, 8][i])).join(''));
  for (const c of rows) {
    const idle = c.age == null ? '' : (c.status === 'working' ? `busy ${humanAge(c.age)}` : `${humanAge(c.age)} ago`);
    console.log([
      clip(c.name, 12).padEnd(12), clip(c.folder, 14).padEnd(14), clip(c.branch, 26).padEnd(26),
      clip(c.agent, 9).padEnd(9),
      clip(c.status, 11).padEnd(11), clip(c.msg, 44).padEnd(46), idle,
    ].join(''));
  }
  if (!rows.length) console.log('(no sessions)');
  // A REMOVAL IN FLIGHT IS STATE, so the path that exists to check the fleet without
  // drawing it has to show it. One line per worktree and only while it is happening —
  // this is the output people read to answer "is anything wrong", and a worktree whose
  // files are being deleted is the difference between "gone" and "going".
  for (const w of freeWorktrees()) if (w.removing) console.log(`removing: ${path.basename(w.path)}`);
  process.exit(0);
}

// A clicked notification with no attached client drops a jump request here; the
// grid picks it up and auto-attaches that session (fleet-jump writes it).
function checkJump() {
  if (mode !== 'grid') return false;
  const f = path.join(HOME, '.claude', 'fleet-jumps', SOCK);
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f); } catch { return false; }
  const [slot, ts] = raw.split('\t');
  if (slot && (Date.now() / 1000 - Number(ts || 0)) < 30 && (slot === 'master' || cards.some(c => c.name === slot))) {
    finish(`attach${US}${slot}`);
    return true;
  }
  return false;
}

// ── project-level screens (projects picker · home · folder browser) ─────────
const SCREEN = (() => { const i = process.argv.indexOf('--screen'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
// Project to preselect on the projects screen (the one we just stepped out of),
// so leaving a project returns the cursor to it instead of jumping to the top.
const SELECT = (() => { const i = process.argv.indexOf('--select'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const PROJECTS_CFG = process.env.CLAUDE_FLEET_PROJECTS || path.join(HOME, '.config', 'ghostfleet', 'projects');

function boxCard(title, rows, color, sel) {
  const t = clip(`─ ${title} `, CW);
  const top = `╭${t}${'─'.repeat(Math.max(0, CW - vis(t)))}╮`;
  const body = [0, 1, 2].map(i => `│ ${padEndV(rows[i] || '', CW - 2)} │`);
  const bot = `╰${'─'.repeat(CW)}╯`;
  const wrap = (s, isTop) => sel ? `${C.bold}${color}${isTop ? C.rev : ''}${s}${C.unrev}${C.reset}` : `${color}${s}${C.reset}`;
  return [wrap(top, true), wrap(body[0]), wrap(body[1]), wrap(body[2]), wrap(bot)];
}
// ── the Projects banner ──────────────────────────────────────────────────────
// The logo as a sprite: a ghost for a sail (two eye holes, tattered hem), a pennant
// on the mast, a hull under it. Drawn with half-blocks so each terminal row carries
// two pixel rows — at this size that vertical doubling is the whole difference
// between a recognisable ship and a smudge.
const SHIP = [
  '         ▄▄▄▄▄▄█                ',
  '         ▀▀▀▀▀ █                ',
  '          ▄▄███████▄▄▄          ',
  '       ▄██████ ███ ████▄      ▄▀',
  '     ▄██████████████████    ▄▀  ',
  '   ▄██▀▀████▀▀████▀▀███   ▄▀    ',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀      ',
  '  ▀▀▀█████████████████▀▀        ',
];
// Costs eight rows, a real bite out of a short window — and the cards are the
// point of this screen, not the logo. Below either threshold, fall back to the plain
// one-line header rather than pushing projects off the bottom.
// Costs eight rows, a real bite out of a short window — and the cards are the point
// of both screens. Below either threshold, fall back to the caller's one-liner.
// Separate from banner() because the CLICK hit-test needs the same answer: this is
// what decides whether the cards start at row 3 or row 10.
function bannerFits() {
  const shipW = Math.max(...SHIP.map(l => l.length));
  return W() >= shipW + 44 && H() >= 26;
}
function banner(beside) {
  if (!bannerFits()) return null;
  // Ship first, text immediately to its right. Pinning the ship to the far edge was
  // tried and reads as marooned on a wide terminal: the cards start at the left
  // margin, so a header that starts there too is the only one that looks attached
  // to them.
  const pad = Math.max(0, Math.floor((SHIP.length - beside.length) / 2));
  const text = [...Array(pad).fill(''), ...beside];
  let out = '';
  for (let i = 0; i < SHIP.length; i++) {
    out += ` ${C.white}${SHIP[i]}${C.reset}   ${text[i] || ''}\x1b[K\n`;
  }
  return out;
}

function readProjects() {
  try {
    return fs.readFileSync(PROJECTS_CFG, 'utf8').split('\n')
      .map(l => l.replace(/\r$/, '')).filter(l => l.trim() && !l.startsWith('#'))
      // Destructure the AGENT column too. Naming one fewer variable than the format
      // has is harmless here (JS drops the extra, unlike shell `read`, which glues it
      // onto the last variable — that exact difference bit fleet-project), but the
      // column has to be READ for the projects screen to be able to show it.
      .map(l => { const [name, p, profile, agent] = l.split('\t');
                  return { name, path: (p || '').replace(/^~/, HOME), profile: profile || 'work',
                           agent: /^[a-z0-9_-]+$/.test(agent || '') ? agent : '' }; })
      .filter(x => x.name && x.path);
  } catch { return []; }
}
function profileDir(p) { return (!p || p === 'work' || p === 'default') ? path.join(HOME, '.claude') : path.join(HOME, '.claude-' + p); }
// tmux socket for a project — work stays bare cf-<name>; other profiles are
// namespaced so same-named projects don't collide (matches bin/ghostfleet).
function sockOf(proj) { const p = proj.profile; return (!p || p === 'work' || p === 'default') ? 'cf-' + proj.name : 'cf-' + p + '-' + proj.name; }
// Per-session status for a project — the ONE implementation shared by the Projects
// screen (which aggregates it into a count per card) and the stack screen (which lists
// the sessions themselves). Two copies of this would drift, and the two screens
// disagreeing about whether a worker is busy is precisely the bug class this repo keeps
// paying for. Includes master: it's the project's lead session, and stackable.
function sessionStatuses(proj) {
  const sock = sockOf(proj);
  let names = [];
  try {
    const o = execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Tabs are filtered HERE as well as in tmuxList: the stack screen reaches other
    // projects' fleets through this path, not that one, so the grid hiding them was no
    // help — every terminal in every project turned up in the stack picker as an "idle"
    // session you could stack. Stacking a shell is never what that screen is for.
    names = o.split('\n').filter(Boolean).filter(n => !isTab(n));
  } catch { return []; }
  const dir = path.join(profileDir(proj.profile), 'fleet');
  const bySlot = new Map();
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!o.slot || !ownedBy(o, sock, proj.name)) continue;   // scope by socket, not zellij
        const prev = bySlot.get(o.slot);
        if (!prev || (o.ts || 0) > (prev.ts || 0)) bySlot.set(o.slot, o);
      } catch {}
    }
  } catch {}
  // Ring order — master first, then that project's own card order — so the stack lists
  // each project the way its grid and its ⇧←→ ring do, not the way tmux happens to sort.
  const ordered = [
    ...names.filter(n => isLead(n)),
    ...applyOrder(names.filter(n => !isLead(n)).map(name => ({ name })), dir, sock).map(r => r.name),
  ];
  return ordered.map(name => {
    const o = bySlot.get(name);
    const busy = paneBusy(sock, name);
    // intentionally off (marker is namespaced by socket — every project has a `master`)
    if (!busy && fs.existsSync(path.join(dir, sock + '.' + name + '.parked'))) return { sock, name, status: 'parked' };
    const tmt = o && o.transcript ? mtimeSec(o.transcript) : 0;
    return { sock, name, status: deriveStatus(o ? o.status : '', o ? o.transcript : '', busy, o ? (o.ts || 0) : 0, tmt) };
  });
}
// live sessions for a project (incl master, the lead you land on with ⏎) +
// how many need you / are working
function projectStatus(proj) {
  const ss = sessionStatuses(proj);
  let need = 0, working = 0, parked = 0;
  for (const s of ss) {
    if (s.status === 'parked') parked++;
    else if (s.status === 'need-you') need++;
    else if (s.status === 'working') working++;
  }
  return { need, working, parked, total: ss.length };
}

// projects picker
let pItems = [], pSel = 0;
let pSelInit = false;        // apply --select preselect exactly once (first build)
let pConfirmRemove = null;   // project name awaiting remove confirmation
let pSchedFor = null;        // { proj, sock, dir } — master being scheduled from the projects screen
let pSchedInput = '';        // typed "<time> | <message>" buffer for the above
let pQuitArmed = 0;          // ts of the first ⌃C; a second ⌃C within QUIT_WINDOW fully exits
const QUIT_WINDOW = 2000;    // ms — how long the "press ⌃C again" arming lasts
let pSettings = false;       // settings page open (per-project toggles)
let pSetSel = 0;             // selected row (project) on the settings page
let pSetCol = 0;             // selected column (which setting) on the settings page

// ── worker → master auto-nudge (notify-lead) per-project settings ───────────
// The hook (hooks/fleet-event.sh) pings a project's master when a worker finishes
// or needs help, so it drains fleet-inbox. It's gated by markers this page toggles:
//   <sock>.notify-lead-off  — authoritative OFF (wins over everything)
//   <sock>.notify-lead      — per-project ON
//   ~/.config/ghostfleet/notify-lead  — global default ON
// (An env var CLAUDE_FLEET_NOTIFY_LEAD=1 can also turn it on at launch; the OFF
// marker overrides that too. This page can't see the env, so it reports by marker.)
const GLOBAL_NOTIFY = () => path.join(HOME, '.config', 'ghostfleet', 'notify-lead');
function pushState(proj) {
  const dir = path.join(profileDir(proj.profile), 'fleet');
  const sock = sockOf(proj);
  const off = fs.existsSync(path.join(dir, sock + '.notify-lead-off'));
  const on  = fs.existsSync(path.join(dir, sock + '.notify-lead'));
  const glob = fs.existsSync(GLOBAL_NOTIFY());
  if (off)  return { on: false, source: 'off · this project' };
  if (on)   return { on: true,  source: 'on · this project' };
  if (glob) return { on: true,  source: 'on · global default' };
  return { on: false, source: 'off · default' };
}
// Toggle the effective state, always writing an EXPLICIT per-project marker so the
// project's choice is independent of (and survives changes to) the global default.
function togglePush(proj) {
  const dir = path.join(profileDir(proj.profile), 'fleet');
  const sock = sockOf(proj);
  const offP = path.join(dir, sock + '.notify-lead-off');
  const onP  = path.join(dir, sock + '.notify-lead');
  const nowOn = pushState(proj).on;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (nowOn) { try { fs.writeFileSync(offP, ''); } catch {} try { fs.unlinkSync(onP); } catch {} }
  else       { try { fs.writeFileSync(onP, '');  } catch {} try { fs.unlinkSync(offP); } catch {} }
}

// ── per-project: ignore the budget ceiling ──────────────────────────────────
// fleet-governor parks every worker at >=--pause-at% of the 5h usage window and
// resumes under --resume%. This marker tells THAT project's governor to stop
// enforcing it — read live each tick (no restart), and flipping it on RELEASES the
// workers the governor parked. Use it when you have extra usage and want the fleet
// to keep going; hand-paused workers stay paused either way.
function limitFile(proj) { return path.join(profileDir(proj.profile), 'fleet', sockOf(proj) + '.governor-off'); }
function ignoreLimit(proj) { try { return fs.existsSync(limitFile(proj)); } catch { return false; } }
function toggleIgnoreLimit(proj) {
  const f = limitFile(proj);
  if (ignoreLimit(proj)) { try { fs.unlinkSync(f); } catch {} }
  else { try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch {}
         try { fs.writeFileSync(f, ''); } catch {} }
}

// ── per-project: which CLI its master runs ──────────────────────────────────
// The 4th column of the projects file. Read here, written through `fleet-project agent`
// rather than by this file editing the list itself: removeProject and reorderProject
// above rewrite that file too, and a THIRD writer of one format is how the format drifts.
// fleet-project already owns adding and removing rows; setting a column belongs with it.
//
// THE RING IS ASKED FOR, NOT SPELLED. `fleet-agent installed` is the list of agents whose
// binary is actually on this machine, so a fourth one joins the cycle by existing and one
// that is not installed is never offered — space would otherwise set a default that
// leaves the next master dead at `exec agent-here`. '' leads the ring because an absent
// column is what every project has and what the card's agent line keys off.
// installedAgents() is the spawn picker's, defined above — reused rather than copied,
// which is the same reason the ring is asked for instead of spelled. A second cache of
// the same list is the third place a fourth agent would have to be remembered.
function agentRing() { return ['', ...installedAgents().filter(a => a !== 'claude')]; }
function cycleAgent(proj) {
  const ring = agentRing();
  const cur = proj.agent && proj.agent !== 'claude' ? proj.agent : '';
  const next = ring[(Math.max(0, ring.indexOf(cur)) + 1) % ring.length];
  for (const bin of [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-project'), 'fleet-project']) {
    try {
      execFileSync(bin, ['agent', proj.name, next || '--none'],
                   { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      proj.agent = next;              // so the row repaints before the next readProjects()
      return;
    } catch {}
  }
}

// the settings page's columns (rows are projects)
const SETCOLS = [
  { title: 'AUTO-NUDGE', onColor: C.green, toggle: togglePush,
    blurb: `${C.dim}auto-nudge: a worker that finishes or needs help pings its master to drain ${C.reset}${C.bold}fleet-inbox${C.reset}`,
    state: p => { const st = pushState(p); return { on: st.on, label: st.on ? 'on' : 'off' }; } },
  { title: 'BUDGET LIMIT', onColor: C.yellow, toggle: toggleIgnoreLimit,
    blurb: `${C.dim}budget limit: ${C.reset}${C.bold}enforced${C.reset}${C.dim} = governor parks all workers near the 5h usage ceiling · ${C.reset}${C.bold}ignored${C.reset}${C.dim} = keep running (releases its parks)${C.reset}`,
    state: p => { const ig = ignoreLimit(p); return { on: ig, label: ig ? 'ignored' : 'enforced' }; } },
  // The blurb is where the two things a picker must say get said, and this page has one
  // blurb line per column, so they go here rather than beside every row: it applies to
  // the NEXT master (CLAUDE_FLEET_AGENT is read once, when the tmux session is created),
  // and what the non-default choices cost. `fleet-agent caveat` composes that from the
  // registry's measured capability fields, so a fourth agent brings its own warning.
  { title: 'AGENT', onColor: C.cyan, toggle: cycleAgent,
    blurb: `${C.dim}agent: which CLI this project's master runs — ${C.reset}${C.bold}the NEXT one${C.reset}${C.dim}; a running master keeps what it started with. ${C.reset}${C.yellow}${agentCaveats()}${C.reset}`,
    state: p => { const a = p.agent && p.agent !== 'claude' ? p.agent : ''; return { on: !!a, label: a || 'claude' }; } },
];
// One line naming only the agents that HAVE a caveat, so a fully-capable fourth agent
// adds nothing to it and the line stays readable at 80 columns.
function agentCaveats() {
  const bits = [];
  for (const a of installedAgents()) {
    if (a === 'claude') continue;
    for (const bin of [SIBLING_AGENT_BIN, 'fleet-agent']) {
      try {
        const c = execFileSync(bin, ['caveat', a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (c) bits.push(`${a}: ${c.split(':')[0]}`);
        break;
      } catch {}
    }
  }
  return bits.length ? bits.join(' · ') : '';
}
function pBuild() {
  pItems = [...readProjects().map(p => ({ project: p })), { add: true }];
  if (!pSelInit) {           // first build: land on the just-exited project, if any
    pSelInit = true;
    if (SELECT) { const i = pItems.findIndex(it => it.project && it.project.name === SELECT); if (i >= 0) pSel = i; }
  }
  pSel = Math.max(0, Math.min(pSel, pItems.length - 1));
}
// remove a project from the list (~/.config/ghostfleet/projects) — only the
// list entry; its tmux sessions and conversation history are left untouched.
function removeProject(name) {
  let lines;
  try { lines = fs.readFileSync(PROJECTS_CFG, 'utf8').split('\n'); } catch { return; }
  const kept = lines.filter(l => {
    const t = l.replace(/\r$/, '');
    if (!t.trim() || t.startsWith('#')) return true;   // keep comments + blanks
    return t.split('\t')[0] !== name;                  // drop only the matching project
  });
  try { fs.writeFileSync(PROJECTS_CFG, kept.join('\n')); } catch {}
}
// reorder: move a project `delta` positions in the list, persisted to the config
// (~/.config/ghostfleet/projects). Comment lines are kept (floated to the top);
// blank separators are dropped. Returns the project's new index, or -1.
function reorderProject(name, delta) {
  let lines;
  try { lines = fs.readFileSync(PROJECTS_CFG, 'utf8').split('\n'); } catch { return -1; }
  const isProj = l => { const t = l.replace(/\r$/, ''); return t.trim() && !t.startsWith('#'); };
  const projs = lines.filter(isProj);
  const comments = lines.filter(l => l.replace(/\r$/, '').trim().startsWith('#'));
  const idx = projs.findIndex(l => l.replace(/\r$/, '').split('\t')[0] === name);
  if (idx < 0) return -1;
  const ni = Math.max(0, Math.min(projs.length - 1, idx + delta));
  if (ni === idx) return idx;                     // already at the edge — nothing to do
  const [moved] = projs.splice(idx, 1);
  projs.splice(ni, 0, moved);
  try { fs.writeFileSync(PROJECTS_CFG, [...comments, ...projs].join('\n') + '\n'); } catch {}
  return ni;
}
function pRender() {
  if (pSettings) return pRenderSettings();
  if (pSchedFor) return pRenderSchedule();
  let buf = '\x1b[H';
  const profTag = (PROFILE && PROFILE !== 'work') ? ` ${C.yellow}${PROFILE}${C.reset}` : '';
  buf += banner([`${C.bold}ghostfleet${C.reset}${profTag}`, `${C.dim}— projects${C.reset}`])
      ?? ` ${C.bold}ghostfleet${C.reset}${profTag} ${C.dim}— projects${C.reset}\x1b[K\n`;
  buf += pConfirmRemove
    ? `${C.red}${C.bold} remove '${pConfirmRemove}' from projects?${C.reset}${C.red} y = yes · any other key = cancel${C.reset}\x1b[K\n`
    : (jumpStage ? jumpHint() : '') + '\x1b[K\n';
  const nc = cols();
  for (let i = 0; i < pItems.length; i += nc) {
    const row = pItems.slice(i, i + nc);
    const lines = row.map((it, j) => {
      const sel = i + j === pSel;
      if (it.add) return boxCard('+ add project', ['choose a root', 'folder…', ''], C.yellow, sel);
      const st = projectStatus(it.project);
      let line, color;
      if (st.need > 0) { line = `● ${st.need} need you`; color = C.red; }
      else if (st.working > 0) { line = `◆ ${st.working} working`; color = C.cyan; }
      else if (st.parked > 0 && st.parked === st.total) { line = `⏸ ${st.parked} parked`; color = C.grey; }
      else if (st.total > 0) { line = `${st.total} session${st.total > 1 ? 's' : ''} · ready`; color = C.green; }
      else { line = 'no sessions yet'; color = C.grey; }
      // a message scheduled to this project's master shows as @<time> on the card
      const sm = readSched('master', path.join(profileDir(it.project.profile), 'fleet'), sockOf(it.project));
      if (sm && sm.at > Math.floor(Date.now() / 1000)) line += `  @${clockLabel(sm.at)}`;
      // Show the project's default agent beside its profile, but only when it HAS one
      // — the overwhelming case is claude, and printing it on every card would be noise
      // that hides the single project which actually differs.
      const who = it.project.agent ? `${it.project.profile} · ${it.project.agent}` : it.project.profile;
      return boxCard(`${i + j < 9 ? `${i + j + 1} ` : ''}${it.project.name}`, [who, it.project.path.replace(HOME, '~'), line], color, sel);
    });
    for (let li = 0; li < 5; li++) buf += ' ' + lines.map(l => l[li]).join(' ') + '\x1b[K\n';
    buf += '\x1b[K\n';
  }
  const armed = pQuitArmed && Date.now() - pQuitArmed < QUIT_WINDOW;
  const quit = armed
    ? `${C.yellow}${C.bold}press ⌃C again to quit${C.reset}${C.dim}`
    : '⌃C ⌃C quit';
  buf += `${C.dim} ↑↓←→/hjkl move · ⇧hjkl reorder · ⏎/1-9 open · Ctrl-f jump · Ctrl-s sessions · s schedule · , settings · x remove · ${quit}${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
// settings page: per-project toggle for the worker→master auto-nudge (notify-lead)
function pRenderSettings() {
  const projs = readProjects();
  pSetSel = Math.max(0, Math.min(pSetSel, Math.max(0, projs.length - 1)));
  let buf = '\x1b[H';
  buf += ` ${C.bold}settings${C.reset} ${C.dim}— per project${C.reset}\x1b[K\n`;
  const glob = fs.existsSync(GLOBAL_NOTIFY());
  buf += ` ${C.dim}${C.reset}${SETCOLS[pSetCol].blurb}\x1b[K\n`;
  buf += ` ${C.dim}nudge global default: ${C.reset}${glob ? `${C.green}on` : `${C.grey}off`}${C.reset}\x1b[K\n\x1b[K\n`;
  const head = `   ${padEndV('', 6)}  ${padEndV('PROJECT', 22)} ${padEndV('PROFILE', 10)}`;
  buf += `${C.dim}${head}${SETCOLS.map((c, ci) => (ci === pSetCol ? C.bold + C.white : C.dim) + padEndV(c.title, 16) + C.reset).join(' ')}${C.reset}\x1b[K\n`;
  if (!projs.length) buf += ` ${C.dim}(no projects yet)${C.reset}\x1b[K\n`;
  projs.forEach((p, i) => {
    const sel = i === pSetSel;
    const cur = sel ? `${C.bold}${C.white}▸ ` : '   ';
    const name = (sel ? C.bold + C.white : C.reset) + padEndV(p.name, 22) + C.reset;
    const cells = SETCOLS.map((c, ci) => {
      const st = c.state(p);
      const lit = sel && ci === pSetCol;                       // the cell space/⏎ acts on
      const txt = padEndV((st.on ? '● ' : '○ ') + st.label, 16);
      return (lit ? C.rev : '') + (st.on ? c.onColor : C.grey) + txt + C.reset;
    });
    buf += `${cur}${padEndV('', 6)}  ${name} ${C.dim}${padEndV(p.profile, 10)}${C.reset}${cells.join(' ')}\x1b[K\n`;
  });
  buf += `\x1b[K\n${C.dim} ↑↓/jk row · ←→/hl column · space/⏎ toggle · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
// schedule a message to a project's master (mirrors the grid's renderSchedule)
function pRenderSchedule() {
  const { proj, dir, sock } = pSchedFor;
  let buf = '\x1b[H';
  buf += ` ${C.bold}schedule a message${C.reset} ${C.dim}→ ${proj.name} · master${C.reset}\x1b[K\n`;
  const existing = readSched('master', dir, sock);
  if (existing && existing.at > Math.floor(Date.now() / 1000))
    buf += ` ${C.yellow}currently: @${clockLabel(existing.at)} "${existing.msg}"${C.reset} ${C.dim}— a new time replaces it; empty + ⏎ cancels${C.reset}\x1b[K\n`;
  else
    buf += '\x1b[K\n';
  const parts = pSchedInput.split('|');
  const at = parseWhen((parts[0] || '').trim());
  const msg = (parts[1] || 'continue').trim() || 'continue';
  buf += ` send at:  ${C.bold}${pSchedInput}${C.reset}▏\x1b[K\n`;
  buf += at
    ? ` ${C.green}→ ${clockLabel(at)}  (${new Date(at * 1000).toLocaleString()})${C.reset}\x1b[K\n`
    : ` ${C.dim}→ enter a time${C.reset}\x1b[K\n`;
  buf += ` ${C.dim}message:${C.reset} ${msg}\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} examples: 3:50am · 15:30 · +2h   ·   customize text with  <time> | <message>${C.reset}\x1b[K\n\x1b[K\n`;
  buf += `${C.dim} ⏎ schedule · empty + ⏎ clears a pending one · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function pMove(d) { const nc = cols(); let n = pSel; if (d === 'left') n--; else if (d === 'right') n++; else if (d === 'up') n -= nc; else if (d === 'down') n += nc; if (n >= 0 && n < pItems.length) pSel = n; }
function onKeyProjects(key) {
  const mev = parseMouse(key);
  if (mev) {
    if (mev.press && mev.button === 0 && !pConfirmRemove && !pSchedFor && !pSettings) {
      const idx = cardAt(mev.x, mev.y, cols());
      if (idx >= 0 && idx < pItems.length) {
        pSel = idx;
        const it = pItems[pSel];
        if (it?.add) return finish('addproject');
        if (it?.project) return finish(`project${US}${it.project.name}`);
      }
    }
    return;
  }
  if (pSettings) {                                   // per-project toggles (rows × columns)
    const projs = readProjects();
    if (key === '\x1b' || key === '\x03' || key === '\x60') { pSettings = false; }
    else if (key === '\x1b[A' || key === 'k') pSetSel = Math.max(0, pSetSel - 1);
    else if (key === '\x1b[B' || key === 'j') pSetSel = Math.min(Math.max(0, projs.length - 1), pSetSel + 1);
    else if (key === '\x1b[D' || key === 'h') pSetCol = Math.max(0, pSetCol - 1);
    else if (key === '\x1b[C' || key === 'l') pSetCol = Math.min(SETCOLS.length - 1, pSetCol + 1);
    else if (key === ' ' || key === '\r' || key === '\n') { const p = projs[pSetSel]; if (p) SETCOLS[pSetCol].toggle(p); }
    pRender(); return;
  }
  if (pSchedFor) {                                   // typing a scheduled message to a master
    if (key === '\x1b' || key === '\x03' || key === '\x60') { pSchedFor = null; pSchedInput = ''; }
    else if (key === '\r' || key === '\n') {
      const { proj, sock, dir } = pSchedFor;
      const parts = pSchedInput.split('|');
      const whenStr = (parts[0] || '').trim();
      if (whenStr === '') { cancelSchedule('master', dir, sock); pSchedFor = null; pSchedInput = ''; }   // clear pending
      else {
        const msg = (parts[1] || 'continue').trim() || 'continue';
        const env = { CLAUDE_CONFIG_DIR: profileDir(proj.profile), CLAUDE_FLEET_DIR: dir };
        if (schedule('master', whenStr, msg, sock, dir, env)) { pSchedFor = null; pSchedInput = ''; }
        // invalid time -> stay in schedule mode so they can fix it
      }
    } else if (key === '\x7f' || key === '\b') { pSchedInput = pSchedInput.slice(0, -1); }
    else if (key.length === 1 && key >= ' ') { pSchedInput += key; }
    pRender(); return;
  }
  if (pConfirmRemove) {
    if (key === 'y' || key === 'Y') { removeProject(pConfirmRemove); pConfirmRemove = null; pBuild(); }
    else pConfirmRemove = null;
    pRender(); return;
  }
  // Fully exiting to the shell (this is the ONLY screen whose quit does that)
  // now takes ⌃C twice, so a single stray key can't drop the whole fleet UI.
  // First ⌃C arms + shows a hint; a second within QUIT_WINDOW quits.
  {                                                  // C-f jump chord (see jumpKey)
    const j = jumpKey(key);
    if (j) { if (j !== 'handled') return finish(j); pRender(); return; }
  }
  if (key === '\x03') {
    if (pQuitArmed && Date.now() - pQuitArmed < QUIT_WINDOW) return finish('');
    pQuitArmed = Date.now(); pRender(); return;
  }
  if (pQuitArmed) pQuitArmed = 0;                    // any other key disarms a pending quit
  if (key === '\x1b[A' || key === 'k') pMove('up');
  else if (key === '\x1b[B' || key === 'j') pMove('down');
  else if (key === '\x1b[C' || key === 'l') pMove('right');
  else if (key === '\x1b[D' || key === 'h') pMove('left');
  // ⇧+hjkl: reorder — move the selected project in the list (persisted).
  else if (key === 'H' || key === 'L' || key === 'K' || key === 'J') {
    const it = pItems[pSel];
    if (it?.project) {
      const nc = cols();
      const delta = key === 'H' ? -1 : key === 'L' ? 1 : key === 'K' ? -nc : nc;
      const ni = reorderProject(it.project.name, delta);
      pBuild(); if (ni >= 0) pSel = ni;
    }
  }
  else if (key === 'x') { const it = pItems[pSel]; if (it?.project) pConfirmRemove = it.project.name; }
  else if (key === 's' || key === 'S') {
    const it = pItems[pSel];
    if (it?.project) { pSchedFor = { proj: it.project, sock: sockOf(it.project), dir: path.join(profileDir(it.project.profile), 'fleet') }; pSchedInput = ''; }
  }
  else if (key >= '1' && key <= '9') {                       // insta-jump: digit -> that project
    const it = pItems[Number(key) - 1];
    if (it?.project) { pSel = Number(key) - 1; return finish(`project${US}${it.project.name}`); }
  }
  else if (key === '\x13') {                                 // ^S -> straight to the sessions grid
    const it = pItems[pSel];
    if (it?.project) return finish(`sessions${US}${it.project.name}`);
  }
  // ^X -> the stack, from here too. The stack lists every project's sessions, so it
  // doesn't matter which card is selected — but it still has to be opened through a
  // project, because stack.tsv lives in that project's PROFILE dir.
  //   It was ^T until tabs took that key. This screen had its OWN copy of the binding,
  // which is how ^T went on opening the stack here long after the session grid and tmux
  // had both moved on — the same chord meaning two different things one screen apart.
  else if (key === '\x18') {
    const it = pItems[pSel] || pItems.find(x => x.project);
    if (it?.project) return finish(`stackfor${US}${it.project.name}`);
  }
  // ^T / ^N -> a terminal or the editor at the SELECTED PROJECT'S ROOT, without booting
  // its master first. Opened by the loop rather than here: this screen has no socket for
  // that project yet (it may never have been entered), and the server has to come up
  // with the fleet's tmux config or the tab would have none of the bindings.
  else if (key === '\x14' || key === '\x0e') {
    const it = pItems[pSel] || pItems.find(x => x.project);
    if (it?.project) return finish(`tabfor${US}${it.project.name}${US}${key === '\x14' ? 'term' : 'edit'}`);
  }
  else if (key === ',') { pSettings = true; pSetSel = 0; }   // open the settings page
  else if (key === '\r' || key === '\n') {
    const it = pItems[pSel];
    if (it?.add) return finish('addproject');
    if (it?.project) return finish(`project${US}${it.project.name}`);
  }
  pRender();
}

// add-project folder browser
let curDir = HOME, dirEntries = [], dSel = 0;
function dBuild() {
  let subs = [];
  try { subs = fs.readdirSync(curDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort(); } catch {}
  dirEntries = ['..', ...subs];
  dSel = Math.max(0, Math.min(dSel, dirEntries.length - 1));
}
function dRender() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}add project${C.reset} ${C.dim}— pick a root folder (holds your checkouts/worktrees)${C.reset}\x1b[K\n`;
  buf += ` ${C.cyan}${curDir.replace(HOME, '~')}${C.reset}\x1b[K\n\x1b[K\n`;
  const maxShow = Math.max(6, (process.stderr.rows || 24) - 9);
  let start = Math.max(0, dSel - Math.floor(maxShow / 2));
  const end = Math.min(dirEntries.length, start + maxShow);
  start = Math.max(0, end - maxShow);
  for (let i = start; i < end; i++) {
    const e = dirEntries[i], sel = i === dSel;
    buf += `${sel ? `${C.bold}${C.green}▸ ` : '  '}${e === '..' ? '../' : e + '/'}${sel ? C.reset : ''}\x1b[K\n`;
  }
  buf += `\x1b[K\n${C.dim} ↑↓ move · ⏎/→ open · ← up · s select THIS folder · esc/\` cancel${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function onKeyAdd(key) {
  if (key === '\x1b' || key === '\x03' || key === '\x60') return finish('');
  if (key === '\x1b[A' || key === 'k') dSel = Math.max(0, dSel - 1);
  else if (key === '\x1b[B' || key === 'j') dSel = Math.min(dirEntries.length - 1, dSel + 1);
  else if (key === '\x1b[D' || key === 'h') { curDir = path.dirname(curDir); dSel = 0; dBuild(); }
  else if (key === '\x1b[C' || key === 'l' || key === '\r' || key === '\n') {
    const e = dirEntries[dSel];
    curDir = e === '..' ? path.dirname(curDir) : path.join(curDir, e);
    dSel = 0; dBuild();
  } else if (key === 's' || key === 'S') return finish(`newproject${US}${curDir}`);
  dRender();
}

// ── the stack screen ────────────────────────────────────────────────────────
// Pick sessions from ANY project in this profile and see them side by side. Every
// session in the fleet is listed, whichever project owns it, because watching one
// project's worker next to another's is the whole point of the screen.
//
// Membership lives in $CLAUDE_FLEET_DIR/stack.tsv and is owned by bin/fleet-stack —
// this screen shells out to it rather than parsing the file itself, so there is one
// parser for a format whose fields are socket-scoped on purpose (every project has a
// session called `master`, so a bare name would stack the wrong one).
const STACK_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-stack');
const STACK_MIN_COLS = 30;   // must match MIN_COLS in bin/fleet-stack
function stackRun(args) {
  try {
    return execFileSync(STACK_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}
function stackMembers() {              // Set of "sock\tsession", live members only
  return new Set(stackRun(['members']).split('\n').filter(Boolean));
}
let sItems = [], sSel = 0, sMembers = new Set(), sMsg = '';
function sBuild() {
  sMembers = stackMembers();
  sItems = [];
  for (const p of readProjects()) {
    const ss = sessionStatuses(p);
    if (!ss.length) continue;
    sItems.push({ header: p.name, profile: p.profile });
    for (const s of ss) sItems.push({ proj: p.name, sock: s.sock, name: s.name, status: s.status });
  }
  // Land on a session, never on a project header — space/⏎ would have nothing to act on.
  if (sSel >= sItems.length) sSel = sItems.length - 1;
  if (sSel < 0) sSel = 0;
  if (sItems[sSel]?.header) sMoveStack(1) || sMoveStack(-1);
}
function sMoveStack(d) {               // step to the next selectable row; false if none
  for (let i = sSel + d; i >= 0 && i < sItems.length; i += d) {
    if (!sItems[i].header) { sSel = i; return true; }
  }
  return false;
}
function sRender() {
  const memberRows = sItems.filter(it => !it.header && sMembers.has(`${it.sock}\t${it.name}`));
  const n = memberRows.length;
  // The same arithmetic bin/fleet-stack applies before it builds anything, shown here
  // so the limit is visible BEFORE you press ⏎ rather than as a message after.
  const fits = Math.max(1, Math.floor((W() + 1) / (STACK_MIN_COLS + 1)));
  let buf = '\x1b[H';
  buf += ` ${C.bold}stack${C.reset} ${C.dim}— several sessions on screen at once, across projects${C.reset}\x1b[K\n`;
  buf += n === 0
    ? ` ${C.dim}nothing stacked yet — ${C.reset}space${C.dim} adds the selected session${C.reset}\x1b[K\n`
    : ` ${C.green}${n} stacked${C.reset}${C.dim} · ~${Math.floor((W() - n + 1) / n)} columns each${C.reset}` +
      (n > fits ? `  ${C.red}${C.bold}this window fits ${fits} — the rest will be left out${C.reset}` : '') + '\x1b[K\n';
  buf += sMsg ? ` ${C.yellow}${sMsg}${C.reset}\x1b[K\n` : '\x1b[K\n';
  const STC = { working: C.cyan, 'need-you': C.red, parked: C.grey, ready: C.green, idle: C.grey, unknown: C.grey };
  const maxShow = Math.max(6, H() - 7);
  let start = Math.max(0, sSel - Math.floor(maxShow / 2));
  const end = Math.min(sItems.length, start + maxShow);
  start = Math.max(0, end - maxShow);
  if (!sItems.length) buf += ` ${C.dim}(no live sessions in any project)${C.reset}\x1b[K\n`;
  for (let i = start; i < end; i++) {
    const it = sItems[i];
    if (it.header) {
      buf += `\x1b[K\n ${C.bold}${C.white}${it.header}${C.reset}${it.profile && it.profile !== 'work' ? ` ${C.yellow}${it.profile}${C.reset}` : ''}\x1b[K\n`;
      continue;
    }
    const inStack = sMembers.has(`${it.sock}\t${it.name}`);
    const sel = i === sSel;
    const box = inStack ? `${C.green}${C.bold}[✓]${C.reset}` : `${C.dim}[ ]${C.reset}`;
    const col = STC[it.status] || C.grey;
    const nm = (sel ? C.bold + C.white : C.reset) + padEndV(it.name, 24) + C.reset;
    buf += `${sel ? `${C.bold}${C.white}▸ ` : '  '}${box} ${nm} ${col}${padEndV(it.status, 10)}${C.reset}\x1b[K\n`;
  }
  buf += `\x1b[K\n${C.dim} ↑↓/jk move · space add/remove · ⏎ open the stack · c clear · esc/q/\` back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function onKeyStack(key) {
  if (key === '\x1b' || key === '\x03' || key === 'q' || key === '\x60') return finish('back');
  sMsg = '';
  if (key === '\x1b[A' || key === 'k') sMoveStack(-1);
  else if (key === '\x1b[B' || key === 'j') sMoveStack(1);
  else if (key === ' ') {
    const it = sItems[sSel];
    if (it && !it.header) { stackRun(['toggle', it.sock, it.name]); sMembers = stackMembers(); }
  } else if (key === 'c' || key === 'C') { stackRun(['clear']); sMembers = stackMembers(); }
  else if (key === '\r' || key === '\n') {
    if (sMembers.size === 0) sMsg = 'the stack is empty — press space on a session first';
    else return finish('stackopen');
  }
  sRender();
}

// ── dispatch ────────────────────────────────────────────────────────────────
out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'); // alt-screen + hide cursor + SGR mouse tracking
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.on('SIGTERM', () => finish(''));
process.on('SIGINT', () => finish(''));

if (SCREEN === 'projects') {
  pBuild(); pRender(); process.stdin.on('data', onKeyProjects);
  timer = setInterval(() => { pBuild(); pRender(); }, 2500);
} else if (SCREEN === 'addproject') {
  dBuild(); dRender(); process.stdin.on('data', onKeyAdd);
} else if (SCREEN === 'stack') {
  sBuild(); sRender(); process.stdin.on('data', onKeyStack);
  timer = setInterval(() => { sBuild(); sRender(); }, 2500);
} else {
  process.stdin.on('data', onKey);
  sweepRemovingMarkers();          // a previous grid may have left one behind (see above)
  buildItems();
  if (!checkJump()) render();
  timer = setInterval(() => { if (mode === 'grid') { buildItems(); if (checkJump()) return; render(); } }, 1200);
}
