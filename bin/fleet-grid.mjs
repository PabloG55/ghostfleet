#!/usr/bin/env node
// fleet-grid.mjs — the ghostfleet card grid.
//
// Invoked by bin/ghostfleet inside a zellij pane as:
//     node fleet-grid.mjs <tmux-socket> <tmux-conf> [--plain]
// stdin is the tty (for keys); the TUI is drawn to /dev/tty; the CHOSEN action
// is printed to stdout (captured by the loop). Choices:
//     attach\x1f<session>   → loop runs `tmux attach -t <session>`
//     new\x1f<cwd>          → loop creates + attaches a new session in <cwd>
//     (empty)               → quit to shell
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
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Everything is scoped to one Claude config dir (= one account/profile).
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || path.join(CFG, 'fleet');
const PROJECTS = path.join(CFG, 'projects');
const PROFILE = process.env.CLAUDE_FLEET_PROFILE || 'work';
const US = '\x1f'; // unit separator — non-whitespace field delimiter

const SOCK = process.argv[2] || 'cf-default';
const CONF = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const PLAIN = process.argv.includes('--plain');
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
  unknown:    { label: '? unknown',   color: C.yellow },
};

// ── data ────────────────────────────────────────────────────────────────
function tmuxList() {
  try {
    const args = ['-L', SOCK, ...(CONF ? ['-f', CONF] : []), 'list-sessions', '-F',
      `#{session_name}${US}#{session_path}${US}#{session_attached}`];
    const out = execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map(l => {
      const [name, cwd, attached] = l.split(US);
      return { name, cwd: cwd || '', attached: attached === '1' };
    });
  } catch { return []; }
}

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
          if (t) return t.replace(/\s+/g, ' ');
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
// Claude's live spinner is always "<gerund>… (<elapsed> · ↓ <n> tokens)". Anchor the
// elapsed timer to the ellipsis so a bare "(30s)" / "(4h 11m)" in content or the status
// bar never counts; also accept the "↓ N tokens" counter and an explicit interrupt hint.
const BUSY_RE = /(?:…|\.\.\.)\s*\(\d+[ms]|↓\s*[\d.,]+\s*[km]?\s*tokens|esc to interrupt/i;

// ── which agent is a session running? ────────────────────────────────────────
// A session records its agent in <sock>.<name>.agent (bin/fleet-agent writes it),
// namespaced by socket for the same reason .parked is: every project has a `master`.
// ABSENT = claude, which is what keeps every pre-existing session — and every session
// started by a path that predates agents — on exactly the old code path.
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
const busyReCache = new Map([['claude', BUSY_RE]]);
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
  if (hook === 'need-you') {
    const stale = tmt && hookTs && tmt > hookTs + 5;
    if (!stale) return 'need-you';
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

function gather() {
  const sessions = tmuxList().filter(s => s.name !== 'master');   // master lives on the home screen, not the grid
  const fleet = fleetBySlot();
  const nowS = Math.floor(Date.now() / 1000);
  return sessions.map(s => {
    const st = fleet.get(s.name);
    const folder = st?.folder || (s.cwd ? path.basename(s.cwd) : s.name);
    const branch = st?.branch || (s.cwd ? gitBranch(s.cwd) : '');
    const transcript = st?.transcript || newestTranscript(s.cwd || '');
    const tmt = transcript ? mtimeSec(transcript) : 0;    // last transcript write = age display only
    const busy = paneBusy(SOCK, s.name);
    let status = deriveStatus(st?.status || '', transcript, busy, st?.ts || 0, tmt);
    if (!busy && isParked(s.name)) status = 'parked';     // intentionally off (fleet-pause)
    const ageBase = tmt || st?.ts || 0;
    const age = ageBase ? Math.max(0, nowS - ageBase) : null;
    const mk = readSched(s.name);                 // socket-namespaced marker
    const sched = (mk && mk.at > nowS) ? mk : null;
    return { name: s.name, folder, branch, status, age, msg: lastAssistant(transcript), attached: s.attached, sched,
             agent: agentOf(s.name) };
  });
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
  const title = clip(`─ ${num}${card.name} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const idle = card.age == null ? '' : (card.status === 'working' ? `busy ${humanAge(card.age)}` : `${humanAge(card.age)} ago`);
  const right = card.sched ? `@${clockLabel(card.sched.at)}` : idle;   // @ = scheduled send
  const l1 = `│ ${padEndV(twoCol(meta.label, right, CW - 2), CW - 2)} │`;
  // Name the agent on the card whenever it isn't the default. Without this an
  // "unknown" or a differently-behaving status is unreadable — you can't tell whether
  // the fleet is confused or the session simply isn't Claude. Claude cards are left
  // exactly as they were (no marker, no width change).
  const l2 = `│ ${padEndV(twoCol(card.branch || card.folder,
                                 card.agent && card.agent !== 'claude' ? card.agent : '', CW - 2), CW - 2)} │`;
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
  const color = C.grey;
  const num = idx >= 0 && idx < 9 ? `${idx + 1} ` : '';
  const title = clip(`─ ${num}${path.basename(w.path)} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const l1 = `│ ${padEndV('· FREE', CW - 2)} │`;
  const l2 = `│ ${padEndV(w.branch, CW - 2)} │`;
  const l3 = `│ ${padEndV(w.task ? `"${w.task}"` : '(no session yet)', CW - 2)} │`;
  const bot = `╰${'─'.repeat(CW)}╯`;
  const wrap = (s, isTop) => selected
    ? `${C.bold}${color}${isTop ? C.rev : ''}${s}${C.unrev}${C.reset}`
    : `${color}${s}${C.reset}`;
  return [wrap(top, true), wrap(l1), wrap(l2), wrap(l3), wrap(bot)];
}

// ── checkout discovery (for new session) ────────────────────────────────
const CFG_FILE = path.join(HOME, '.config', 'ghostfleet', 'checkouts');
const isRepo = p => { try { return fs.existsSync(path.join(p, '.git')); } catch { return false; } };
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
    const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n\n').filter(Boolean).map(block => {
      const wt = /^worktree (.+)$/m.exec(block)?.[1];
      const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      return wt ? { path: wt, branch: br || '(detached)' } : null;
    }).filter(Boolean);
  } catch { return []; }
}
// The project's own main checkout — mirrors enter_master's convention in bin/ghostfleet
// (PROJECT_ROOT/PROJECT, else the first child repo, else PROJECT_ROOT itself) so this
// agrees with whichever checkout the master session actually opened.
function mainRepo() {
  const root = process.env.CLAUDE_FLEET_ROOT || '';
  if (!root) return '';
  if (isRepo(root)) return root;
  const named = path.join(root, Z);
  if (isRepo(named)) return named;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && isRepo(path.join(root, e.name))) return path.join(root, e.name);
    }
  } catch {}
  return root;
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
    .map(w => ({ path: w.path, branch: w.branch, task: manifestTask(w.path) }));
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

let mode = 'grid';           // 'grid' | 'picker' | 'nameprompt' | 'agentpick' | 'rename' | 'schedule'
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
  const need = cards.filter(c => c.status === 'need-you').length;
  const work = cards.filter(c => c.status === 'working').length;
  const ready = cards.filter(c => c.status === 'ready').length;
  const parked = cards.filter(c => c.status === 'parked').length;
  let buf = '\x1b[H';
  const header = ` ${C.bold}ghostfleet${C.reset} ${C.dim}[${PROFILE}:${Z}]${C.reset}   ` +
    `${C.red}${need} need you${C.reset} · ${C.cyan}${work} working${C.reset} · ${C.green}${ready} ready${C.reset}` +
    (parked ? ` · ${C.grey}${parked} parked${C.reset}` : '');
  buf += header + '\x1b[K\n';
  if (confirmKill)
    buf += `${C.red}${C.bold} kill session '${confirmKill}'?${C.reset}${C.red} y = yes · any other key = cancel${C.reset}\x1b[K\n`;
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
  buf += `${C.dim} ↑↓←→/hjkl move · ⏎/1-9 enter · n new · s sched · p pause · P resume · x kill · , settings · ^F jump · ^P/Q projects · q/\` back${C.reset}\x1b[K\n`;
  buf += '\x1b[J'; // clear from cursor to end of screen
  out(buf);
}

function renderPicker() {
  let buf = '\x1b[H';
  buf += pickFresh
    ? ` ${C.bold}new PARALLEL session${C.reset} ${C.dim}— fresh conversation in a checkout under ~/${Z}${C.reset}\x1b[K\n\x1b[K\n`
    : ` ${C.bold}new session${C.reset} ${C.dim}— pick a checkout under ~/${Z}${C.reset}\x1b[K\n\x1b[K\n`;
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
  const k = `${agent} ${field}`;
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
  buf += `\x1b[K\n${C.dim} ↑↓/jk move · space/⏎ cycle inherit → on → off · r rename · esc/\` back${C.reset}\x1b[K\n\x1b[J`;
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
function render() {
  if (mode === 'grid') { if (gSettings) renderSettings(); else renderGrid(); }
  else if (mode === 'picker') renderPicker();
  else if (mode === 'nameprompt') renderNamePrompt();
  else if (mode === 'agentpick') renderAgentPick();
  else if (mode === 'rename') renderRename();
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
// index of the card under terminal cell (x,y) on a header+card-grid screen, or -1.
// layout (grid + projects): rows 1-2 = header; cards from row 3, each block 5 lines
// + 1 blank (6 rows); cards CW+2 wide with a 1-col gap and 1 leading column.
function cardAt(x, y, nc) {
  const gy = y - 3; if (gy < 0 || gy % 6 >= 5) return -1;
  const gx = x - 2; if (gx < 0 || gx % (CW + 3) >= CW + 2) return -1;
  const col = Math.floor(gx / (CW + 3)); if (col >= nc) return -1;
  return Math.floor(gy / 6) * nc + col;
}

function onKey(key) {
  const mev = parseMouse(key);
  if (mev) {
    if (mode === 'grid' && mev.press && mev.button === 0 && !confirmKill) {
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
      render(); return;
    }
    if (confirmKill) {
      if (key === 'y' || key === 'Y') { killSession(confirmKill); confirmKill = null; buildItems(); }
      else confirmKill = null;
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
    else if (key === 'n') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = false; mode = 'picker'; }
    else if (key === 'N') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = true; mode = 'picker'; }
    else if (key === 'x' || key === 'X') { const it = items[sel]; if (it?.card) confirmKill = it.card.name; }
    else if (key === 's' || key === 'S') { const it = items[sel]; if (it?.card) { schedFor = it.card.name; schedInput = ''; mode = 'schedule'; } }
    else if (key === 'p') { const it = items[sel]; if (it?.card) pauseSession(it.card.name); }
    else if (key === 'P') { const it = items[sel]; if (it?.card) resumeSession(it.card.name); }
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
      if (installedAgents().length > 1) { agentSel = 0; mode = 'agentpick'; render(); return; }
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
  const cks = discoverCheckouts();
  console.log('checkouts:\n' + (cks.length ? cks.map(c => '  ' + c).join('\n') : '  (none)'));
  process.exit(0);
}

// ── plain (non-interactive) mode ──────────────────────────────────────────
if (PLAIN) {
  const rows = gather();
  const need = rows.filter(c => c.status === 'need-you').length;
  const work = rows.filter(c => c.status === 'working').length;
  const ready = rows.filter(c => c.status === 'ready').length;
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
function readProjects() {
  try {
    return fs.readFileSync(PROJECTS_CFG, 'utf8').split('\n')
      .map(l => l.replace(/\r$/, '')).filter(l => l.trim() && !l.startsWith('#'))
      .map(l => { const [name, p, profile] = l.split('\t'); return { name, path: (p || '').replace(/^~/, HOME), profile: profile || 'work' }; })
      .filter(x => x.name && x.path);
  } catch { return []; }
}
function profileDir(p) { return (!p || p === 'work' || p === 'default') ? path.join(HOME, '.claude') : path.join(HOME, '.claude-' + p); }
// tmux socket for a project — work stays bare cf-<name>; other profiles are
// namespaced so same-named projects don't collide (matches bin/ghostfleet).
function sockOf(proj) { const p = proj.profile; return (!p || p === 'work' || p === 'default') ? 'cf-' + proj.name : 'cf-' + p + '-' + proj.name; }
// live sessions for a project (incl master, the lead you land on with ⏎) +
// how many need you / are working
function projectStatus(proj) {
  const sock = sockOf(proj);
  let names = [];
  try {
    const o = execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    names = o.split('\n').filter(Boolean);
  } catch { return { need: 0, working: 0, total: 0 }; }
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
  let need = 0, working = 0, parked = 0, total = 0;
  for (const name of names) {
    total++;                            // master included — it's the project's lead session (⏎ lands there)
    const o = bySlot.get(name);
    const busy = paneBusy(sock, name);
    if (!busy && fs.existsSync(path.join(dir, sock + '.' + name + '.parked'))) { parked++; continue; }  // intentionally off (namespaced)
    const tmt = o && o.transcript ? mtimeSec(o.transcript) : 0;
    const s = deriveStatus(o ? o.status : '', o ? o.transcript : '', busy, o ? (o.ts || 0) : 0, tmt);
    if (s === 'need-you') need++;
    else if (s === 'working') working++;
  }
  return { need, working, parked, total };
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

// the settings page's columns (rows are projects)
const SETCOLS = [
  { title: 'AUTO-NUDGE', onColor: C.green, toggle: togglePush,
    blurb: `${C.dim}auto-nudge: a worker that finishes or needs help pings its master to drain ${C.reset}${C.bold}fleet-inbox${C.reset}`,
    state: p => { const st = pushState(p); return { on: st.on, label: st.on ? 'on' : 'off' }; } },
  { title: 'BUDGET LIMIT', onColor: C.yellow, toggle: toggleIgnoreLimit,
    blurb: `${C.dim}budget limit: ${C.reset}${C.bold}enforced${C.reset}${C.dim} = governor parks all workers near the 5h usage ceiling · ${C.reset}${C.bold}ignored${C.reset}${C.dim} = keep running (releases its parks)${C.reset}`,
    state: p => { const ig = ignoreLimit(p); return { on: ig, label: ig ? 'ignored' : 'enforced' }; } },
];
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
  buf += ` ${C.bold}ghostfleet${C.reset}${profTag} ${C.dim}— projects${C.reset}\x1b[K\n`;
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
      return boxCard(`${i + j < 9 ? `${i + j + 1} ` : ''}${it.project.name}`, [it.project.profile, it.project.path.replace(HOME, '~'), line], color, sel);
    });
    for (let li = 0; li < 5; li++) buf += ' ' + lines.map(l => l[li]).join(' ') + '\x1b[K\n';
    buf += '\x1b[K\n';
  }
  const armed = pQuitArmed && Date.now() - pQuitArmed < QUIT_WINDOW;
  const quit = armed
    ? `${C.yellow}${C.bold}press ⌃C again to quit${C.reset}${C.dim}`
    : '⌃C ⌃C quit';
  buf += `${C.dim} ↑↓←→/hjkl move · ⇧hjkl reorder · ⏎/1-9 open · ^F jump · ^S sessions · s schedule · , settings · x remove · ${quit}${C.reset}\x1b[K\n\x1b[J`;
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
} else {
  process.stdin.on('data', onKey);
  buildItems();
  if (!checkJump()) render();
  timer = setInterval(() => { if (mode === 'grid') { buildItems(); if (checkJump()) return; render(); } }, 1200);
}
