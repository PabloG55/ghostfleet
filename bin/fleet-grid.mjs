#!/usr/bin/env node
// fleet-grid.mjs — the claude-fleet card grid.
//
// Invoked by bin/claude-fleet inside a zellij pane as:
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
  idle:       { label: '· idle',      color: C.grey },
  starting:   { label: '… starting',  color: C.yellow },
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

function fleetBySlot() {
  // Index by slot, scoped to this zellij session, keeping the newest entry per
  // slot (avoids a stale/duplicate file shadowing the live one, and stops a
  // same-named checkout in another project from leaking in).
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR).filter(f => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8'));
      if (!o.slot) continue;
      if (o.zellij && o.zellij !== Z) continue;
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
  const sessions = tmuxList();
  const fleet = fleetBySlot();
  const nowS = Math.floor(Date.now() / 1000);
  return sessions.map(s => {
    const st = fleet.get(s.name);
    const folder = st?.folder || (s.cwd ? path.basename(s.cwd) : s.name);
    const branch = st?.branch || (s.cwd ? gitBranch(s.cwd) : '');
    const transcript = st?.transcript || newestTranscript(s.cwd || '');
    const tmt = transcript ? mtimeSec(transcript) : 0;    // last transcript write = live activity
    const hook = st?.status || '';
    // Live signal beats stale hook events: a transcript written in the last ~10s
    // means the session is actively streaming right now.
    let status;
    if (tmt && nowS - tmt < 10) status = 'working';        // streaming now
    else if (hook === 'working') status = 'working';       // mid-turn per hooks
    else if (hook === 'need-you') status = 'need-you';     // blocked, waiting on you
    else if (transcript) status = 'ready';                 // has history, awaiting you
    else status = 'idle';                                  // brand new, nothing yet
    const ageBase = tmt || st?.ts || 0;
    const age = ageBase ? Math.max(0, nowS - ageBase) : null;
    let sched = null;
    try {
      const mk = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, s.name + '.sched'), 'utf8'));
      if (mk && mk.at > nowS) sched = mk;
    } catch {}
    return { name: s.name, folder, branch, status, age, msg: lastAssistant(transcript), attached: s.attached, sched };
  });
}

function killSession(name) {
  try {
    execFileSync('tmux', ['-L', SOCK, ...(CONF ? ['-f', CONF] : []), 'kill-session', '-t', name], { stdio: 'ignore' });
  } catch {}
  // drop its status file(s) so the card disappears (the conversation history in
  // ~/.claude/projects is untouched — you can re-open it later from `new`).
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR).filter(f => f.endsWith('.json')); } catch {}
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8'));
      if (o.slot === name && (!o.zellij || o.zellij === Z)) fs.unlinkSync(path.join(FLEET_DIR, f));
    } catch {}
  }
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
function schedMarker(session) { return path.join(FLEET_DIR, session + '.sched'); }
function readSched(session) {
  try { return JSON.parse(fs.readFileSync(schedMarker(session), 'utf8')); } catch { return null; }
}
function cancelSchedule(session) {
  // kill the waiter (it's a detached process-group leader, so -pid kills its
  // sleep + caffeinate too) and drop the marker.
  const m = readSched(session);
  if (m && m.pid) {
    try { process.kill(-m.pid, 'SIGTERM'); } catch {}
    try { process.kill(m.pid, 'SIGTERM'); } catch {}
  }
  try { fs.unlinkSync(schedMarker(session)); } catch {}
}
function schedule(session, whenStr, msg) {
  const at = parseWhen(whenStr);
  if (!at) return false;
  cancelSchedule(session);            // replace, never stack
  let pid = 0;
  try {
    const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-schedule');
    const child = spawn(bin, [SOCK, session, String(at), msg], { detached: true, stdio: 'ignore' });
    pid = child.pid; child.unref();
  } catch { return false; }
  try { fs.writeFileSync(schedMarker(session), JSON.stringify({ at, msg, pid })); } catch {}
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
function cardLines(card, selected) {
  const meta = STATUS[card.status] || STATUS.starting;
  const color = meta.color;
  const title = clip(`─ ${card.name} `, CW);
  const top = `╭${title}${'─'.repeat(Math.max(0, CW - vis(title)))}╮`;
  const idle = card.age == null ? '' : (card.status === 'working' ? `busy ${humanAge(card.age)}` : `${humanAge(card.age)} ago`);
  const right = card.sched ? `@${clockLabel(card.sched.at)}` : idle;   // @ = scheduled send
  const l1 = `│ ${padEndV(twoCol(meta.label, right, CW - 2), CW - 2)} │`;
  const l2 = `│ ${padEndV(card.branch || card.folder, CW - 2)} │`;
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

// ── checkout discovery (for new session) ────────────────────────────────
const CFG_FILE = path.join(HOME, '.config', 'claude-fleet', 'checkouts');
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

function discoverCheckouts() {
  // 1) explicit config wins: ~/.config/claude-fleet/checkouts, one path per line
  try {
    const paths = fs.readFileSync(CFG_FILE, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(p => p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (paths.length) return [...new Set(paths)].sort();
  } catch {}
  // 2) prefer project-name roots (~/<session>, ~/<session sans version suffix>)
  const named = collectRepos(nameRoots);
  if (named.length) return named;
  // 3) fall back to the pane's cwd + its parent
  return collectRepos(cwdRoots);
}

// ── terminal / screen ─────────────────────────────────────────────────────
let ttyFd; try { ttyFd = fs.openSync('/dev/tty', 'w'); } catch { ttyFd = 2; }
const tty = fs.createWriteStream(null, { fd: ttyFd });
function W() { return process.stderr.columns || 80; }
function H() { return process.stderr.rows || 24; }
function out(s) { tty.write(s); }

let mode = 'grid';           // 'grid' | 'picker'
let sel = 0;                 // selection index in grid
let cards = [];
let items = [];              // grid items: cards + {new:true}
let checkouts = [];
let pickSel = 0;
let pickFresh = false;       // picker opened via N (fresh parallel) vs n (resume)
let confirmKill = null;      // session name awaiting kill confirmation
let schedFor = null;         // session name being scheduled
let schedInput = '';         // typed "<time> | <message>" buffer
let timer;                   // refresh interval (session grid / projects)

function buildItems() {
  cards = gather();
  items = [...cards.map(c => ({ card: c })), { newCard: true }];
  if (sel >= items.length) sel = items.length - 1;
  if (sel < 0) sel = 0;
}

function cols() { return Math.max(1, Math.floor(W() / (CW + 3))); }

function renderGrid() {
  const need = cards.filter(c => c.status === 'need-you').length;
  const work = cards.filter(c => c.status === 'working').length;
  const ready = cards.filter(c => c.status === 'ready').length;
  let buf = '\x1b[H';
  const header = ` ${C.bold}claude-fleet${C.reset} ${C.dim}[${PROFILE}:${Z}]${C.reset}   ` +
    `${C.red}${need} need you${C.reset} · ${C.cyan}${work} working${C.reset} · ${C.green}${ready} ready${C.reset}`;
  buf += header + '\x1b[K\n';
  if (confirmKill)
    buf += `${C.red}${C.bold} kill session '${confirmKill}'?${C.reset}${C.red} y = yes · any other key = cancel${C.reset}\x1b[K\n`;
  else
    buf += '\x1b[K\n';
  const nc = cols();
  for (let i = 0; i < items.length; i += nc) {
    const rowItems = items.slice(i, i + nc);
    const linesPerCard = rowItems.map((it, j) => {
      const idx = i + j;
      return it.newCard ? newCardLines(idx === sel) : cardLines(it.card, idx === sel);
    });
    for (let li = 0; li < 5; li++) {
      buf += ' ' + linesPerCard.map(lc => lc[li]).join(' ') + '\x1b[K\n';
    }
    buf += '\x1b[K\n';
  }
  buf += `${C.dim} ↑↓←→/hjkl move · ⏎ enter · n new · N parallel · s sched · x kill · q quit${C.reset}\x1b[K\n`;
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
    buf += `${C.dim}  fix: put one path per line in ~/.config/claude-fleet/checkouts${C.reset}\x1b[K\n`;
  } else {
    checkouts.forEach((c, i) => {
      const mark = i === pickSel ? `${C.bold}${C.green}▸ ` : '  ';
      const end = i === pickSel ? C.reset : '';
      buf += `${mark}${c.replace(HOME, '~')}${end}\x1b[K\n`;
    });
  }
  buf += `\x1b[K\n${C.dim} ↑↓ move · ⏎ create · esc back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
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
  buf += `${C.dim} ⏎ schedule · empty + ⏎ clears a pending one · esc back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function render() {
  if (mode === 'grid') renderGrid();
  else if (mode === 'picker') renderPicker();
  else renderSchedule();
}

// ── input ───────────────────────────────────────────────────────────────
function cleanup() {
  try { process.stdin.setRawMode(false); } catch {}
  out('\x1b[?25h\x1b[?1049l');
}
function finish(result) {
  cleanup();
  clearInterval(timer);
  process.stdout.write(result || '');
  process.exit(0);
}

function moveGrid(d) {
  const nc = cols();
  let n = sel;
  if (d === 'left') n--; else if (d === 'right') n++;
  else if (d === 'up') n -= nc; else if (d === 'down') n += nc;
  if (n >= 0 && n < items.length) sel = n;
}

function onKey(key) {
  if (mode === 'grid') {
    if (confirmKill) {
      if (key === 'y' || key === 'Y') { killSession(confirmKill); confirmKill = null; buildItems(); }
      else confirmKill = null;
      render(); return;
    }
    if (key === '\x03' || key === 'q') return finish('back');
    if (key === '\x1b[A' || key === 'k') moveGrid('up');
    else if (key === '\x1b[B' || key === 'j') moveGrid('down');
    else if (key === '\x1b[C' || key === 'l') moveGrid('right');
    else if (key === '\x1b[D' || key === 'h') moveGrid('left');
    else if (key === 'n') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = false; mode = 'picker'; }
    else if (key === 'N') { checkouts = discoverCheckouts(); pickSel = 0; pickFresh = true; mode = 'picker'; }
    else if (key === 'x' || key === 'X') { const it = items[sel]; if (it?.card) confirmKill = it.card.name; }
    else if (key === 's' || key === 'S') { const it = items[sel]; if (it?.card) { schedFor = it.card.name; schedInput = ''; mode = 'schedule'; } }
    else if (key === '\r' || key === '\n') {
      const it = items[sel];
      if (it?.newCard) { checkouts = discoverCheckouts(); pickSel = 0; mode = 'picker'; }
      else if (it?.card) return finish(`attach${US}${it.card.name}`);
    }
    render();
  } else if (mode === 'picker') {
    if (key === '\x1b' || key === '\x03' || key === 'q') { mode = 'grid'; render(); return; }
    if (key === '\x1b[A' || key === 'k') pickSel = Math.max(0, pickSel - 1);
    else if (key === '\x1b[B' || key === 'j') pickSel = Math.min(checkouts.length - 1, pickSel + 1);
    else if ((key === '\r' || key === '\n') && checkouts.length) return finish(`${pickFresh ? 'newfresh' : 'new'}${US}${checkouts[pickSel]}`);
    render();
  } else if (mode === 'schedule') {
    if (key === '\x1b' || key === '\x03') { mode = 'grid'; schedFor = null; render(); return; }
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
  console.log(['TAB', 'CHECKOUT', 'BRANCH', 'STATUS', 'LAST MSG', 'IDLE']
    .map((h, i) => h.padEnd([12, 14, 26, 11, 46, 8][i])).join(''));
  for (const c of rows) {
    const idle = c.age == null ? '' : (c.status === 'working' ? `busy ${humanAge(c.age)}` : `${humanAge(c.age)} ago`);
    console.log([
      clip(c.name, 12).padEnd(12), clip(c.folder, 14).padEnd(14), clip(c.branch, 26).padEnd(26),
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
  if (slot && (Date.now() / 1000 - Number(ts || 0)) < 30 && cards.some(c => c.name === slot)) {
    finish(`attach${US}${slot}`);
    return true;
  }
  return false;
}

// ── project-level screens (projects picker · home · folder browser) ─────────
const SCREEN = (() => { const i = process.argv.indexOf('--screen'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const PROJECTS_CFG = path.join(HOME, '.config', 'claude-fleet', 'projects');

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
function sessCount(name) {
  try {
    const o = execFileSync('tmux', ['-L', 'cf-' + name, 'list-sessions', '-F', 'x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return o.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

// projects picker
let pItems = [], pSel = 0;
function pBuild() { pItems = [...readProjects().map(p => ({ project: p })), { add: true }]; pSel = Math.max(0, Math.min(pSel, pItems.length - 1)); }
function pRender() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}claude-fleet${C.reset} ${C.dim}— projects${C.reset}\x1b[K\n\x1b[K\n`;
  const nc = cols();
  for (let i = 0; i < pItems.length; i += nc) {
    const row = pItems.slice(i, i + nc);
    const lines = row.map((it, j) => {
      const sel = i + j === pSel;
      if (it.add) return boxCard('+ add project', ['choose a root', 'folder…', ''], C.yellow, sel);
      const n = sessCount(it.project.name);
      return boxCard(it.project.name, [it.project.profile, it.project.path.replace(HOME, '~'), n ? `${n} session${n > 1 ? 's' : ''}` : 'no sessions yet'], n ? C.green : C.grey, sel);
    });
    for (let li = 0; li < 5; li++) buf += ' ' + lines.map(l => l[li]).join(' ') + '\x1b[K\n';
    buf += '\x1b[K\n';
  }
  buf += `${C.dim} ↑↓←→/hjkl move · ⏎ open · q quit${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function pMove(d) { const nc = cols(); let n = pSel; if (d === 'left') n--; else if (d === 'right') n++; else if (d === 'up') n -= nc; else if (d === 'down') n += nc; if (n >= 0 && n < pItems.length) pSel = n; }
function onKeyProjects(key) {
  if (key === '\x03' || key === 'q') return finish('');
  if (key === '\x1b[A' || key === 'k') pMove('up');
  else if (key === '\x1b[B' || key === 'j') pMove('down');
  else if (key === '\x1b[C' || key === 'l') pMove('right');
  else if (key === '\x1b[D' || key === 'h') pMove('left');
  else if (key === '\r' || key === '\n') {
    const it = pItems[pSel];
    if (it?.add) return finish('addproject');
    if (it?.project) return finish(`project${US}${it.project.name}`);
  }
  pRender();
}

// project home
let hSel = 0;
const HOME_ITEMS = ['master', 'grid'];
function hRender() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}${Z}${C.reset} ${C.dim}— project home${C.reset}\x1b[K\n\x1b[K\n`;
  const cards2 = [
    boxCard('Master Claude', ['the lead — spawns &', 'coordinates workers', ''], C.cyan, hSel === 0),
    boxCard('All sessions', ['see & enter the', 'fleet grid', ''], C.green, hSel === 1),
  ];
  for (let li = 0; li < 5; li++) buf += ' ' + cards2.map(c => c[li]).join(' ') + '\x1b[K\n';
  buf += `\x1b[K\n${C.dim} ←→/hl move · ⏎ enter · q back${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function onKeyHome(key) {
  if (key === '\x03' || key === 'q' || key === '\x1b') return finish('back');
  if (key === '\x1b[D' || key === 'h' || key === '\x1b[A' || key === 'k') hSel = 0;
  else if (key === '\x1b[C' || key === 'l' || key === '\x1b[B' || key === 'j') hSel = 1;
  else if (key === '\r' || key === '\n') return finish(HOME_ITEMS[hSel]);
  hRender();
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
  buf += `\x1b[K\n${C.dim} ↑↓ move · ⏎/→ open · ← up · s select THIS folder · esc cancel${C.reset}\x1b[K\n\x1b[J`;
  out(buf);
}
function onKeyAdd(key) {
  if (key === '\x1b' || key === '\x03') return finish('');
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
out('\x1b[?1049h\x1b[?25l'); // alt-screen + hide cursor
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.on('SIGTERM', () => finish(''));
process.on('SIGINT', () => finish(''));

if (SCREEN === 'projects') {
  pBuild(); pRender(); process.stdin.on('data', onKeyProjects);
  timer = setInterval(() => { pBuild(); pRender(); }, 2500);
} else if (SCREEN === 'home') {
  hRender(); process.stdin.on('data', onKeyHome);
} else if (SCREEN === 'addproject') {
  dBuild(); dRender(); process.stdin.on('data', onKeyAdd);
} else {
  process.stdin.on('data', onKey);
  buildItems();
  if (!checkJump()) render();
  timer = setInterval(() => { if (mode === 'grid') { buildItems(); if (checkJump()) return; render(); } }, 1200);
}
