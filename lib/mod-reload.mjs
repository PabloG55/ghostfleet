#!/usr/bin/env node
// lib/mod-reload.mjs — `fleet-mod reload`: bring every live Claude session onto the mod.
//
//   fleet-mod reload                    the plan, per session. Changes nothing (the default)
//   fleet-mod reload --apply            carry it out, then re-read every record and say ✓/✗
//   fleet-mod reload --only <sock>[/<session>]   one fleet, or one session in it
//   fleet-mod reload --reload-only      never restart; an old Claude is listed instead
//   fleet-mod reload --count            how many live Claude sessions are not on the current mod
//
// WHY THIS EXISTS. `fleet-mod install` puts the mod into every profile, but a running Claude
// keeps the plugins it loaded at start, so only sessions started AFTER the install run it.
// The rest still get fleet prompts pasted into their input box and still have their state
// guessed from the pane. Two ways onto it, measured:
//
//   reload   `/reload-plugins` in the session. On 2.1.292 the mod loads with no turn: the
//            debug log says `session.start: raised for ghostfleet (loaded later)` and the
//            record carries `source: "mod"` about two seconds after the command.
//   restart  a process older than MIN_VERSION cannot load it at all, whatever is on disk:
//            a running process keeps the version it started with. On 2.1.284 the reload
//            reads the plugin as enabled and then refuses its hooks ("hooks modules are not
//            turned on for installed plugins in this process"), with no error in /plugin.
//            So it is relaunched onto the current binary by fleet-restart's by-id path,
//            which reopens THAT conversation and never guesses with --continue.
//
// WHAT IT TOUCHES. Only an idle session whose input box is empty. A turn running, a
// permission dialog, a question waiting on a person, something half-typed, a pane with no
// input box drawn: each is listed with the reason and left exactly as it was. The session
// running this command is never touched (a restart would kill the turn running it).
//
// WHAT COUNTS AS DONE. Not the keystroke and not the relaunch: a status record for that
// session saying `source: "mod"`, written by a live process AFTER the action. Each one gets
// up to WAIT_S seconds to appear, then is marked ✗ with what the pane said.
//
// ON THE MOD IS NOT ON THE CURRENT MOD. The mod is read in place from the runtime and a
// deploy is a cf-sync with no version bump, so a session that loaded it last month still
// writes `source: "mod"` and `v: 0.1.0`, and this listed it "already on mod" and moved on:
// the sessions most in need of a fix were the ones it never reloaded. So each record now
// says which code its process loaded (`mod.code`, shape.js codeId), and a session whose
// code is not the runtime's, or that says none (a mod from before it could), is `stale`:
// reloaded like any other, and done only when its record carries the runtime's code.
//
// ONE AT A TIME, NEVER A BROADCAST. Each session is acted on and read back before the next
// is touched, so a reload that goes wrong goes wrong once, and its ✗ is in front of whoever
// ran this before any other session has followed it. A stale session whose mod reports its
// code has the delivery that runs a handed-over `/reload-plugins` exactly once, so it is
// sent through fleet-send, which waits for that delivery's receipt; one that reports none
// predates that delivery, which ran a handed-over reload again after the reload it caused,
// so `/reload-plugins` is typed into its pane, as for a session not on the mod at all.
//
// The running version is the process's own note (<profile>/sessions/<pid>.json, proven to be
// about THIS process by its start time), falling back to the newest `version` in its
// transcript. The binary on disk says nothing: an update replaces it under running processes.
//
// Node builtins only, like the rest of lib/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modState } from './mod-status.mjs';
import { permissionDialog } from './permission-dialog.mjs';
import { codeId, isCodeFile } from '../mods/ghostfleet/hooks/shape.js';

export const MIN_VERSION = process.env.FLEET_MOD_MIN || '2.1.287';
const WAIT_S = Number(process.env.FLEET_MOD_RELOAD_WAIT) || 15;
const PLUGIN = 'ghostfleet@ghostfleet';
const HOME = os.homedir();
const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const BIN = path.join(HERE, '..', 'bin');

// The code a session would load now: the mod beside this file, which in the runtime is the
// marketplace every profile reads in place (bin/fleet-mod says why). '' when it cannot be
// read, and then no session is called stale: a staleness nobody can measure is not one.
export function runtimeCode(dir = path.join(HERE, '..', 'mods', 'ghostfleet', 'hooks')) {
  try {
    const files = fs.readdirSync(dir).filter(isCodeFile).filter(n => fs.statSync(path.join(dir, n)).isFile())
      .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
    return files.length ? codeId(files) : '';
  } catch { return ''; }
}

// Three numbers, field by field. Unparseable is "unknown", which the caller handles.
export function verGe(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// ── THE DECISION, ONE FUNCTION, ASKED BY THE WALK AND BY THE SUITE ──────────────────────
// Order is the order of "why not": a reason that holds whatever else is true comes first,
// so a busy session that is also old reads "busy" (wait for it) rather than "needs a
// restart" (which would not happen anyway).
export function decide(s) {
  if (s.agent !== 'claude') return { action: 'skip', why: `not claude (${s.agent})` };
  if (!s.pid) return { action: 'skip', why: 'no Claude process in the pane' };
  if (s.onMod && !s.stale) return { action: 'on-mod', why: '' };
  if (s.self) return { action: 'skip', why: 'the session running this command' };
  if (s.installed === false) return { action: 'skip', why: 'mod not installed in this profile: fleet-mod install' };
  if (s.state === 'working') return { action: 'skip', why: 'busy' };
  if (s.state === 'need-you') return { action: 'skip', why: 'needs you' };
  if (s.state === 'shell') return { action: 'skip', why: 'busy: a background command is running' };
  if (s.composer === 'draft') return { action: 'skip', why: 'something is typed in its input box' };
  if (s.composer !== 'empty') return { action: 'skip', why: 'no input box on screen' };
  // A stale mod is already running in a process new enough for mods: a reload, whatever the
  // version says (the process note can lag a relaunch).
  if (s.stale) return { action: 'reload', why: 'stale' };
  // An unknown version is tried with the reload: it is turn-free and harmless, and a ✗
  // afterwards says so, where a restart on a guess would not be.
  if (!s.version || verGe(s.version, s.min || MIN_VERSION)) return { action: 'reload', why: '' };
  if (s.reloadOnly) return { action: 'skip', why: `Claude ${s.version} needs a restart (--reload-only)` };
  if (!s.sid) return { action: 'skip', why: 'no conversation id — restart by hand' };
  return { action: 'restart', why: '' };
}

// ── small, bounded process calls; none of them throws ──────────────────────────────────
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, ...opts });
  } catch (e) { return opts.keepFail ? String(e.stdout || '') : ''; }
}
const tmux = (sock, ...a) => run('tmux', ['-u', '-L', sock, ...a]);
const short = p => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p || '');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function sockets(only) {
  const dir = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.startsWith('cf-') && (!only || n === only)).filter(n => {
    try { return fs.statSync(path.join(dir, n)).isSocket(); } catch { return false; }
  }).sort();
}

// Tab at the tmux boundary (CLAUDE.md: tmux <= 3.5 escapes \x1f in -F output).
function sessionsOf(sock) {
  return tmux(sock, 'list-sessions', '-F', '#{session_name}\t#{pane_pid}').split('\n').filter(Boolean).map(l => {
    const [name, pid] = l.split('\t');
    return { name, panePid: Number(pid) || 0 };
  }).filter(s => s.name && !s.name.startsWith('_'));
}

// The session's own value, else the server's global one (where fleets keep the profile).
function envOf(sock, slot, key) {
  for (const a of [['-t', slot], ['-g']]) {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(tmux(sock, 'show-environment', ...a, key));
    if (m) return m[1];
  }
  return '';
}

let PS = null;
function children(pid) {
  if (!PS) {
    PS = new Map();
    for (const l of run('ps', ['-axo', 'pid=,ppid=']).split('\n')) {
      const [c, p] = l.trim().split(/\s+/).map(Number);
      if (!c) continue;
      if (!PS.has(p)) PS.set(p, []);
      PS.get(p).push(c);
    }
  }
  return PS.get(pid) || [];
}
function descendants(pid) {
  const out = [], q = [[pid, 0]];
  while (q.length) {
    const [p, d] = q.shift();
    out.push(p);
    if (d < 4) for (const c of children(p)) q.push([c, d + 1]);
  }
  return out;
}

// Claude's note about a process, believed only when its start time is this process's
// (a pid is reused; the note of a dead process with the same pid is someone else's).
function processNote(panePid, cfgs) {
  for (const p of descendants(panePid)) {
    for (const cfg of cfgs) {
      const n = readJson(path.join(cfg, 'sessions', `${p}.json`));
      if (!n || Number(n.pid) !== p || !n.sessionId) continue;
      const started = run('ps', ['-o', 'lstart=', '-p', String(p)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
        .trim().replace(/\s+/g, ' ');
      if (n.procStart && String(n.procStart).replace(/\s+/g, ' ') !== started) continue;
      return { pid: p, note: n, cfg };
    }
  }
  return null;
}

// The newest `version` a transcript carries: what the process that last wrote it ran.
function transcriptVersion(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const all = [...buf.toString('utf8').matchAll(/"version":"(\d+\.\d+\.\d+)"/g)];
    return all.length ? all[all.length - 1][1] : '';
  } catch { return ''; }
}

function recordsFor(dir, sock, slot) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    const r = readJson(path.join(dir, n));
    if (r && r.sock === sock && r.slot === slot) out.push(r);
  }
  return out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
}

// On the mod = a record for this session that a live process is still writing as the mod.
// With a pid to compare, that process must be the one in the pane; with a code, it must be
// running that code.
function modRecord(recs, pid, sinceMs = 0, code = '') {
  return recs.find(r => modState(r) && (!pid || Number(r.mod.pid) === pid)
    && (Number(r.mod.hb) || 0) >= sinceMs && (!code || r.mod.code === code)) || null;
}

// Stale: on the mod, and running code that is not the runtime's (or saying none). Nothing is
// stale when the runtime's own code cannot be read.
export const staleOf = (m, code) => Boolean(m && code && (m.mod && m.mod.code) !== code);

// Installed and enabled at user scope, read from the two files `claude plugin` keeps for the
// profile (fleet-mod install is what writes them, through it). Read, not asked: asking is a
// `claude` process per profile, and the answer is these two files anyway. No registry at all
// is "cannot tell", not "not installed": the reload is still worth trying, and a ✗ says why.
const INSTALLED = new Map();
function installedIn(cfg) {
  if (!INSTALLED.has(cfg)) {
    const reg = readJson(path.join(cfg, 'plugins', 'installed_plugins.json'));
    const set = readJson(path.join(cfg, 'settings.json'));
    let v = null;
    if (reg && reg.plugins) {
      const user = (reg.plugins[PLUGIN] || []).some(e => e && e.scope === 'user');
      v = user && !(set && set.enabledPlugins && set.enabledPlugins[PLUGIN] === false);
    }
    INSTALLED.set(cfg, v);
  }
  return INSTALLED.get(cfg);
}

function composerOf(sock, slot, env) {
  return run(path.join(BIN, 'fleet-hibernate'), ['--composer', sock, slot], { env }).trim() || 'none';
}

function profiles() {
  const out = [path.join(HOME, '.claude')];
  try {
    for (const n of fs.readdirSync(HOME)) if (n.startsWith('.claude-')) out.push(path.join(HOME, n));
  } catch {}
  return out.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// ── THE PLAN ──────────────────────────────────────────────────────────────────────────
export function plan({ only = '', reloadOnly = false, count = false, code = runtimeCode() } = {}) {
  const [onlySock, onlySlot] = only.split('/');
  const t = process.env.TMUX || '';
  const selfSock = path.basename(t.split(',')[0] || '');
  const selfSlot = process.env.CLAUDE_FLEET_SLOT || '';
  const allCfgs = profiles();
  const rows = [];
  for (const sock of sockets(onlySock)) {
    for (const { name: slot, panePid } of sessionsOf(sock)) {
      if (onlySlot && slot !== onlySlot) continue;
      const cfg = envOf(sock, slot, 'CLAUDE_CONFIG_DIR') || path.join(HOME, '.claude');
      const dir = envOf(sock, slot, 'CLAUDE_FLEET_DIR') || path.join(cfg, 'fleet');
      let agent = 'claude';
      try { agent = fs.readFileSync(path.join(dir, `${sock}.${slot}.agent`), 'utf8').trim() || 'claude'; } catch {}
      const row = { sock, slot, cfg, dir, agent, pid: 0, version: '', state: '', sid: '' };
      const recs = recordsFor(dir, sock, slot);
      if (agent === 'claude') {
        const pn = processNote(panePid, [cfg, ...allCfgs.filter(c => c !== cfg)]);
        if (pn) {
          row.pid = pn.pid; row.sid = pn.note.sessionId;
          row.version = pn.note.version || '';
        }
        const rec = recs.find(r => r.session_id === row.sid) || recs[0];
        if (!row.version && rec && rec.transcript) row.version = transcriptVersion(rec.transcript);
        const m = row.pid ? modRecord(recs, row.pid) : null;
        row.onMod = Boolean(m);
        row.code = (m && m.mod && m.mod.code) || '';
        row.stale = staleOf(m, code);
        row.self = sock === selfSock && slot === selfSlot;
        if (!count && row.pid) {
          if (m) {
            row.state = modState(m);
            // Stale is acted on, and so asked what an action needs to know: its input box.
            if (row.stale) row.composer = composerOf(sock, slot, { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_FLEET_DIR: dir });
          } else {
            // Claude's own word first ("busy" while a turn runs), then the hook's need-you,
            // then a dialog on the pane, which neither of those might have caught yet.
            // A hook `working` beside Claude's own `idle` is a Stop that never came (Escape fires
            // none); without Claude's word the hook's stands, and a stale `working` then skips.
            const hook = (rec && rec.status) || '';
            // Anything else Claude says about itself is not idle either: `shell` is a background
            // command whose end will wake the session into a turn of its own.
            if (pn.note.status === 'busy') row.state = 'working';
            else if (hook === 'need-you') row.state = 'need-you';
            else if (pn.note.status && pn.note.status !== 'idle') row.state = pn.note.status;
            else if (pn.note.status === 'idle') row.state = hook && hook !== 'working' ? hook : 'idle';
            else row.state = hook || 'unknown';
            if (permissionDialog(tmux(sock, 'capture-pane', '-p', '-t', slot))) row.state = 'need-you';
            const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_FLEET_DIR: dir };
            row.composer = composerOf(sock, slot, env);
            row.installed = installedIn(cfg);
          }
        }
      }
      Object.assign(row, count ? {} : decide({ ...row, reloadOnly, min: MIN_VERSION }));
      rows.push(row);
    }
  }
  return rows;
}

// ── THE TABLE ─────────────────────────────────────────────────────────────────────────
const label = r => (r.action === 'skip' ? `skip: ${r.why}${r.stale ? ' (stale mod)' : ''}`
  : r.action === 'on-mod' ? 'already on mod' : r.stale ? `${r.action}: stale mod` : r.action);
export function table(rows, result = false) {
  const head = ['SESSION', 'PROFILE', 'VERSION', 'STATE', result ? 'RESULT' : 'ACTION'];
  const body = rows.map(r => [`${r.sock}/${r.slot}`, short(r.cfg), r.version || '?', r.state || '-',
    result ? r.result : label(r)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => [...b[i]].length)));
  return [head, ...body].map(c => c.map((x, i) => (i === c.length - 1 ? x : x + ' '.repeat(w[i] - [...x].length))).join('  ')).join('\n');
}

// ── CARRYING IT OUT ───────────────────────────────────────────────────────────────────
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function act(r) {
  r.t0 = Date.now();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: r.cfg, CLAUDE_FLEET_DIR: r.dir };
  if (r.action === 'reload' && r.stale && r.code) {
    // Through the mod's own delivery, which runs it once and receipts it (bin/fleet-send
    // waits for that receipt and prints what it said). The record read back below is the
    // proof; fleet-send's line is only the reason given when that proof never comes.
    if (composerOf(r.sock, r.slot, env) !== 'empty') { r.result = '✗ not touched: its input box changed since the plan'; return; }
    const sendEnv = { ...env };
    delete sendEnv.TMUX;
    r.sent = run('/bin/sh', ['-c', 'exec "$0" "$@" 2>&1', path.join(BIN, 'fleet-send'), '-s', r.sock, r.slot, '/reload-plugins'],
      { env: sendEnv, keepFail: true, timeout: 60000 }).trim().split('\n').pop() || '';
  } else if (r.action === 'reload') {
    // Asked again right before typing: a person can start typing between the plan and now.
    if (composerOf(r.sock, r.slot, env) !== 'empty') { r.result = '✗ not touched: its input box changed since the plan'; return; }
    tmux(r.sock, 'send-keys', '-t', r.slot, '-l', '/reload-plugins');
    sleep(700);
    tmux(r.sock, 'send-keys', '-t', r.slot, 'Enter');
  } else if (r.action === 'restart') {
    const out = run(path.join(BIN, 'fleet-restart'),
      ['-s', r.sock, '--session', r.slot, '--no-continue', '--yes'], { env, keepFail: true, timeout: restartTimeoutMs(env) });
    const bad = restartResult(out);
    if (bad) r.result = bad;
  }
}

// LONGER THAN A RESTART CAN TAKE, or this is what loses the session. fleet-restart kills first and
// then outwaits the old process, so a timeout that lands inside its wait kills it between the two:
// the old session gone, the new one never started. Its own bounds plus a minute for the rest.
export function restartTimeoutMs(env = process.env) {
  const secs = (k, d) => (/^\d+$/.test(env[k] || '') ? Number(env[k]) : d);
  return (secs('CLAUDE_FLEET_RESTART_WAIT', 120) + secs('CLAUDE_FLEET_RESTART_TERM_WAIT', 10)
        + secs('CLAUDE_FLEET_RESTART_CONFIRM', 60) + 60) * 1000;
}
// The ✗ for what fleet-restart printed, or '' when it came back. It decides for itself whether
// the conversation can be established and whether the session survived; its reason is the one
// to show.
export function restartResult(out) {
  const skipped = /NOT restarted[^\n]*\n\s*\S+ \([^)]*\) — ([^\n]+)/.exec(out);
  if (skipped) return `✗ not restarted: ${skipped[1]}`;
  const failed = /^Failed:\n\s*\S+ — ([^\n]+)/m.exec(out);
  if (failed) return `✗ ${failed[1]}`;
  return /(?:^|\s)1 relaunched/.test(out) ? '' : '✗ fleet-restart did not relaunch it';
}

// What the pane said about the reload, for the ✗: "Reloaded: 3 plugins · … · 1 error".
function reloadLine(r) {
  const lines = tmux(r.sock, 'capture-pane', '-p', '-S', '-40', '-t', r.slot).split('\n');
  const i = lines.map(l => l.includes('Reloaded:')).lastIndexOf(true);
  if (i < 0) return '';
  return (lines[i] + ' ' + (lines[i + 1] || '')).replace(/^\s*⎿\s*/, '').replace(/\s+/g, ' ').trim();
}

// One session's action read back: the record that proves it, or the ✗ after WAIT_S. A stale
// one is proven only by the runtime's code, which is what it was reloaded to load.
function settle(r, code) {
  for (;;) {
    // The restarted process is a new pid, so any live writer counts there; a reload
    // keeps the pid, and it must be that process writing.
    const m = modRecord(recordsFor(r.dir, r.sock, r.slot), r.action === 'reload' ? r.pid : 0, r.t0, r.stale ? code : '');
    if (m) {
      r.result = r.stale ? '✓ on the current mod' : '✓ on mod'; r.state = modState(m);
      // A restart is a new process on a new binary: say which.
      const n = readJson(path.join(r.cfg, 'sessions', `${Number(m.mod.pid)}.json`));
      if (n && n.version) r.version = n.version;
      return;
    }
    if (Date.now() - r.t0 > WAIT_S * 1000) {
      const said = r.action === 'reload' && !r.sent ? reloadLine(r) : '';
      const what = r.stale ? 'record with the current mod' : 'mod record';
      r.result = `✗ no ${what} after ${WAIT_S}s${r.sent ? ` (fleet-send: ${r.sent.replace(/^fleet-send: /, '')})` : said ? ` (pane: ${said})` : ''}`;
      return;
    }
    sleep(500);
  }
}

export function apply(rows, code = runtimeCode()) {
  for (const r of rows.filter(x => x.action === 'reload' || x.action === 'restart')) {
    act(r);
    if (!r.result) settle(r, code);
  }
  for (const r of rows) if (!r.result) r.result = r.action === 'on-mod' ? '✓ on mod (already)' : `– ${label(r)}`;
  return rows;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let applyIt = false, only = '', reloadOnly = false, count = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') applyIt = true;
    else if (a === '--dry-run') applyIt = false;
    else if (a === '--reload-only') reloadOnly = true;
    else if (a === '--count') count = true;
    else if (a === '--only' && args[i + 1]) only = args[++i];
    else { process.stderr.write(`fleet-mod reload: unknown argument: ${a}\n`); process.exit(2); }
  }
  const rows = plan({ only, reloadOnly, count });
  if (count) {
    process.stdout.write(`${rows.filter(r => r.agent === 'claude' && r.pid && (!r.onMod || r.stale)).length}\n`);
    process.exit(0);
  }
  if (!rows.length) { console.log('fleet-mod reload: no live fleet sessions found'); process.exit(0); }
  console.log(table(rows));
  const n = rows.filter(r => r.action === 'reload' || r.action === 'restart').length;
  if (!applyIt) {
    console.log(`\nfleet-mod reload: dry run, nothing was touched. ${n} to act on: fleet-mod reload --apply`);
    process.exit(0);
  }
  if (!n) { console.log('\nfleet-mod reload: nothing to act on'); process.exit(0); }
  console.log(`\nfleet-mod reload: acting on ${n}, one at a time, reading each record back before the next (up to ${WAIT_S}s each)…\n`);
  apply(rows);
  console.log(table(rows, true));
  process.exit(rows.some(r => r.result && r.result.startsWith('✗')) ? 1 : 0);
}
