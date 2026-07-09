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
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || path.join(HOME, '.claude', 'fleet');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const US = '\x1f'; // unit separator — non-whitespace field delimiter

const SOCK = process.argv[2] || 'cf-default';
const CONF = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const PLAIN = process.argv.includes('--plain');
const Z = SOCK.replace(/^cf-/, '');

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
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(FLEET_DIR).filter(f => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, f), 'utf8'));
      if (o.slot) map.set(o.slot, o);
    } catch {}
  }
  return map;
}

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
  return sessions.map(s => {
    const st = fleet.get(s.name);
    const folder = st?.folder || (s.cwd ? path.basename(s.cwd) : s.name);
    const branch = st?.branch || (s.cwd ? gitBranch(s.cwd) : '');
    const status = st?.status || 'starting';
    const ts = st?.ts || 0;
    const transcript = st?.transcript || newestTranscript(s.cwd || '');
    const age = ts ? Math.max(0, Math.floor(Date.now() / 1000) - ts) : null;
    return { name: s.name, folder, branch, status, age, msg: lastAssistant(transcript), attached: s.attached };
  });
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
  const l1 = `│ ${padEndV(twoCol(meta.label, idle, CW - 2), CW - 2)} │`;
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
function discoverCheckouts() {
  const roots = [path.join(HOME, Z)];
  const out = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      if (fs.existsSync(path.join(p, '.git'))) out.push(p);
    }
    if (fs.existsSync(path.join(root, '.git'))) out.push(root);
  }
  return [...new Set(out)].sort();
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
  const header = ` ${C.bold}claude-fleet${C.reset} ${C.dim}[${Z}]${C.reset}   ` +
    `${C.red}${need} need you${C.reset} · ${C.cyan}${work} working${C.reset} · ${C.green}${ready} ready${C.reset}`;
  buf += header + '\x1b[K\n\x1b[K\n';
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
  buf += `${C.dim} ↑↓←→/hjkl move · ⏎ enter session · n new · q quit${C.reset}\x1b[K\n`;
  buf += '\x1b[J'; // clear from cursor to end of screen
  out(buf);
}

function renderPicker() {
  let buf = '\x1b[H';
  buf += ` ${C.bold}new session${C.reset} ${C.dim}— pick a checkout under ~/${Z}${C.reset}\x1b[K\n\x1b[K\n`;
  if (checkouts.length === 0) {
    buf += `${C.yellow}  no git checkouts found under ~/${Z}${C.reset}\x1b[K\n`;
    buf += `${C.dim}  create ~/.config/claude-fleet or add checkouts there, then retry${C.reset}\x1b[K\n`;
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

function render() { mode === 'grid' ? renderGrid() : renderPicker(); }

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
    if (key === '\x03' || key === 'q') return finish('');
    if (key === '\x1b[A' || key === 'k') moveGrid('up');
    else if (key === '\x1b[B' || key === 'j') moveGrid('down');
    else if (key === '\x1b[C' || key === 'l') moveGrid('right');
    else if (key === '\x1b[D' || key === 'h') moveGrid('left');
    else if (key === 'n') { checkouts = discoverCheckouts(); pickSel = 0; mode = 'picker'; }
    else if (key === '\r' || key === '\n') {
      const it = items[sel];
      if (it?.newCard) { checkouts = discoverCheckouts(); pickSel = 0; mode = 'picker'; }
      else if (it?.card) return finish(`attach${US}${it.card.name}`);
    }
    render();
  } else { // picker
    if (key === '\x1b' || key === '\x03' || key === 'q') { mode = 'grid'; render(); return; }
    if (key === '\x1b[A' || key === 'k') pickSel = Math.max(0, pickSel - 1);
    else if (key === '\x1b[B' || key === 'j') pickSel = Math.min(checkouts.length - 1, pickSel + 1);
    else if ((key === '\r' || key === '\n') && checkouts.length) return finish(`new${US}${checkouts[pickSel]}`);
    render();
  }
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

// ── interactive loop ──────────────────────────────────────────────────────
out('\x1b[?1049h\x1b[?25l'); // alt-screen + hide cursor
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', onKey);
process.on('SIGTERM', () => finish(''));
process.on('SIGINT', () => finish(''));

buildItems();
render();
const timer = setInterval(() => { if (mode === 'grid') { buildItems(); render(); } }, 1200);
