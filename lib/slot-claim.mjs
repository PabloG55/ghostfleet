// lib/slot-claim.mjs — which conversation a fleet slot resumes, and which it must never take.
//
//   node lib/slot-claim.mjs pick     --dir D --sock S --slot X [--agent claude|codex] [--keep-live]
//   node lib/slot-claim.mjs fallback --dir D --sock S --slot X --cwd C [--agent claude|codex]
//   node lib/slot-claim.mjs held     --id ID [--transcript F] [--agent claude|codex]
//
// pick prints `id<US>transcript<US>how` for the slot's OWN conversation, fallback the newest
// conversation in the folder that nobody else owns, held the pid of a live process that has
// the conversation open. Each exits 1 when it has no answer. --grace N (default 3) is how
// long a holder is given to go away before it counts: every relaunch kills the old pane
// first, and a resume checked in the same breath would see its own predecessor still dying.
//
// ONE CONVERSATION, ONE SLOT, AND IT WAS NEVER WRITTEN DOWN ANYWHERE. A fleet's lead ended up
// running a worker's conversation for four days, and the lead's own was running nowhere.
// Measured on the fleet it happened to, every card of which shares ONE folder:
//   - a plugin reload reached every pane at once and wrote a line into every transcript,
//     the worker's seven seconds after the lead's;
//   - the machine went down, and opening the project rebuilt `master` with a bare
//     `exec agent-here master` — no id, since nothing recorded one for that path;
//   - claude-here's slot lookup ran only under zellij, so on tmux it fell to "the newest
//     real conversation in this folder", which was the worker's by seven seconds;
//   - the hook then filed that conversation under the pane it now ran in, so its record moved
//     from the worker's name to `master`, the worker's card had nothing left under its name,
//     and the fleet dir held TWO records for `master`;
//   - every reader of those settles a slot by the newest `ts`, which was the intruder's.
// Days later the same fallback launched the lead with `--resume` of a THIRD conversation —
// the folder's newest again, which was live at that moment in its own card. Two writers on
// one transcript, with nothing anywhere refusing it.
//
// So three rules, asked of THIS file by every launcher so there is one spelling of them:
//   1. a slot resumes a conversation its own record names, before anything in the folder;
//   2. two records claiming one slot go first to a DELIBERATE PLACEMENT: `fleet-open <id>
//      --into <slot>` (or --as) writes <sock>.<slot>.owner, because a person who puts a
//      conversation into a slot on purpose has decided what that slot is, whatever its
//      history says. Next by NAME HISTORY, not by recency: Claude
//      writes the session's --name into its transcript as `customTitle`, and the first one
//      is the slot the conversation was born in. The intruder above was born under the
//      worker's name and had carried the lead's only since the crash. When the history
//      cannot tell them apart (codex writes no title) the newest is taken — and either way
//      the choice is written to <fleet-dir>/slot-claim.log and stderr, because a silent
//      newest-wins is how this stayed unnoticed for days;
//   3. never a conversation a live process has open, and never one another slot's record
//      claims — not by pick, not by the folder fallback, not by an explicit id.
//
// Node builtins only, like the rest of lib/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { codexHome, findRollouts, rolloutById, rolloutOpen } from './codex-rollout.mjs';

const US = '\x1f';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A BUFFER FOR THE WHOLE PROCESS TABLE. execFileSync's default is 1 MB, and `ps -axo
// pid=,command=` is every argv on the machine — 730 KB on a dev Mac with two thousand
// processes, and past 1 MB once a few more browsers or suites start. Over the cap it throws
// ENOBUFS, this returns '', and holders() reports that NOBODY holds anything: the guard that
// keeps one conversation out of two panes switched itself off exactly when the machine was
// busiest, in silence. Reproduced by padding the table with a few long-argv sleeps.
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch { return ''; } };
// The project folder a transcript lives in. Two spellings exist in this repo — every
// non-alphanumeric to `-` (lib/fleet-scan.mjs, fleet-hibernate) and only `/` and `.`
// (claude-here) — and they differ exactly when the path holds anything else, a `_` most often:
// a macOS runner's $TMPDIR is /var/folders/<xx>/<a_b…>/T/, and a fallback that read the other
// spelling found no transcript there and started fresh. So both are asked, and a launcher
// that already knows its folder passes it (--projects-dir) rather than having it re-derived.
const encProjects = (cwd) => [...new Set([String(cwd).replace(/[^A-Za-z0-9]/g, '-'), String(cwd).replace(/[/.]/g, '-')])];

// The name claude-here passes as --name, and so the title a slot's transcript carries.
export const slotTitle = (sock, slot) => `${String(sock).replace(/^cf-/, '')}/${slot}`;

export function cfgDirs(env = process.env) {
  const out = [];
  const add = (d) => { if (d && !out.includes(d)) out.push(d); };
  add(env.CLAUDE_CONFIG_DIR);
  const home = env.HOME || os.homedir();
  add(path.join(home, '.claude'));
  try { for (const n of fs.readdirSync(home)) if (n.startsWith('.claude-')) add(path.join(home, n)); } catch {}
  return out;
}

// Read a file forward in chunks until `re` matches; transcripts run to 100MB+ and both
// answers asked here (a first title, a first real turn) are near the top.
function firstMatch(file, re, limit = 8 << 20) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(256 << 10);
    let pos = 0, carry = '';
    while (pos < limit) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.toString('utf8', 0, n);
      const m = re.exec(text);
      if (m) return m;
      carry = text.slice(-4096);
    }
    return null;
  } finally { fs.closeSync(fd); }
}
export function firstTitle(file) {
  const m = firstMatch(file, /"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}
const hasTurns = (file) => !!firstMatch(file, /"type"\s*:\s*"(user|assistant)"/);

function readRecords(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (j && typeof j === 'object' && j.session_id) out.push(j);
    } catch {}
  }
  return out;
}

// ── WHO HAS A CONVERSATION OPEN ──────────────────────────────────────────────
// Claude leaves a note per process, <config>/sessions/<pid>.json, naming its sessionId; a
// pid outlives a reboot as a number, so the note counts only while its process is alive and
// started when the note says. The argv is the second witness, for a process that has not
// written its note yet: `--resume <id>` / `--session-id <id>` / `codex resume <id>`. A codex
// process holds its rollout open, which lib/codex-rollout.mjs can ask the kernel about.
// This process's own ancestry is never a holder: the launcher asking is not a rival.
function ancestry() {
  const parent = new Map();
  for (const line of sh('ps', ['-axo', 'pid=,ppid=']).split('\n')) {
    const [p, pp] = line.trim().split(/\s+/);
    if (p) parent.set(p, pp);
  }
  const mine = new Set();
  let p = String(process.pid);
  for (let i = 0; p && p !== '0' && i < 64 && !mine.has(p); i++) { mine.add(p); p = parent.get(p); }
  return mine;
}
export function holders({ cfgs = cfgDirs() } = {}) {
  const held = new Map();                       // id -> pid
  const mine = ancestry();
  for (const cfg of cfgs) {
    const d = path.join(cfg, 'sessions');
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch { continue; }
      const pid = String(j?.pid ?? n.replace(/\.json$/, ''));
      if (!j?.sessionId || mine.has(pid) || !alive(pid)) continue;
      if (j.procStart) {
        const ps = sh('env', ['LC_ALL=C', 'TZ=UTC', 'ps', '-o', 'lstart=', '-p', pid]).replace(/\s+/g, ' ').trim();
        if (ps && ps !== String(j.procStart).replace(/\s+/g, ' ').trim()) continue;
      }
      held.set(String(j.sessionId), pid);
    }
  }
  for (const line of sh('ps', ['-axo', 'pid=,command=']).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || mine.has(m[1])) continue;
    // The AGENT's argv only: codex-here's own watcher runs as `node …/codex-rollout.mjs watch
    // --resume <id>` and is started before this is asked, so a bare flag match refused codex
    // its own conversation on every switch back to it.
    const a = /(?:^|[\s/])(?:claude|codex)(?=\s)(?:\s+\S+)*?\s(?:--resume|--session-id|-r)[= ]+([0-9a-f]{8}-[0-9a-f-]{27})(?:\s|$)/.exec(m[2])
           || /(?:^|[\s/])codex\s+resume\s+([0-9a-f]{8}-[0-9a-f-]{27})(?:\s|$)/.exec(m[2]);
    if (a && !held.has(a[1])) held.set(a[1], m[1]);
  }
  return held;
}
// The pid holding `id`, after giving a dying predecessor `graceMs` to go.
export function heldBy(id, { transcript = '', agent = 'claude', cfgs, graceMs = 3000 } = {}) {
  const until = Date.now() + graceMs;
  for (;;) {
    let pid = holders({ cfgs }).get(String(id)) || '';
    if (!pid && agent === 'codex' && transcript && rolloutOpen(transcript)) pid = '?';
    if (!pid || Date.now() >= until) return pid;
    sleep(250);
  }
}

// ── LOUD ─────────────────────────────────────────────────────────────────────
function say(dir, line) {
  process.stderr.write(`slot-claim: ${line}\n`);
  try {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    fs.appendFileSync(path.join(dir, 'slot-claim.log'), `${stamp} ${line}\n`);
  } catch {}
}
const short = (id) => String(id).split('-')[0];

const transcriptFor = (rec, agent, cfgs) => {
  if (rec.transcript && fs.existsSync(rec.transcript)) return String(rec.transcript);
  if (agent === 'codex') return rolloutById(rec.session_id, codexHome()) || '';
  for (const cfg of cfgs) for (const enc of encProjects(rec.cwd || '')) {
    const f = path.join(cfg, 'projects', enc, `${rec.session_id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return '';
};

// ── PICK: this slot's own conversation ───────────────────────────────────────
export function pick({ dir, sock, slot, agent = 'claude', cfgs = cfgDirs(), keepLive = false, graceMs = 3000 }) {
  if (!dir || !sock || !slot) return null;
  const want = slotTitle(sock, slot);
  const seen = new Set();
  let cands = [];
  for (const r of readRecords(dir)) {
    if (r.sock !== sock || r.slot !== slot || seen.has(r.session_id)) continue;
    if ((r.agent || 'claude') !== agent) continue;
    seen.add(r.session_id);
    const tr = transcriptFor(r, agent, cfgs);
    if (!tr) continue;
    cands.push({ id: String(r.session_id), tr, ts: Number(r.ts) || 0, pane: String(r.pane || ''),
                 born: agent === 'claude' ? firstTitle(tr) : '' });
  }
  if (!keepLive && cands.length) {
    const kept = [];
    for (const c of cands) {
      const pid = heldBy(c.id, { transcript: c.tr, agent, cfgs, graceMs });
      if (pid) say(dir, `${sock}/${slot}: skipping ${short(c.id)} — it is open in live process ${pid}, and a conversation is never resumed into a second pane`);
      else kept.push(c);
    }
    cands = kept;
  }
  if (!cands.length) return null;
  if (cands.length === 1) return { id: cands[0].id, transcript: cands[0].tr, how: 'record' };
  // Placed here on purpose, then born here, then the newest. The sort is the decision; the
  // log line is the receipt.
  const owner = placedIn(dir, sock, slot);
  const placed = (c) => Number(c.id === owner);
  cands.sort((a, b) => (placed(b) - placed(a)) || (Number(b.born === want) - Number(a.born === want)) || (b.ts - a.ts));
  const top = cands[0];
  const how = placed(top) ? 'record+placed'
    : cands.filter(c => c.born === want).length === 1 ? 'record+born' : 'record+newest';
  const list = cands.map(c => `${short(c.id)} (${c.id === owner ? 'placed here by fleet-open, ' : ''}born ${c.born ? `as ${c.born}` : 'unnamed'}, ts ${c.ts}${c.pane ? `, pane ${c.pane}` : ''})`).join(', ');
  say(dir, `${sock}/${slot}: ${cands.length} records claim this slot: ${list} — resuming ${short(top.id)}, ${
    how === 'record+placed' ? 'the one deliberately placed here'
    : how === 'record+born' ? `the one whose name history began as ${want}`
    : 'the newest, because neither a placement nor name history could tell them apart'}`);
  return { id: top.id, transcript: top.tr, how };
}

// <sock>.<slot>.owner: `id<TAB>epoch`, written by fleet-open when it puts a conversation in.
export function placedIn(dir, sock, slot) {
  try { return fs.readFileSync(path.join(dir, `${sock}.${slot}.owner`), 'utf8').split(/[\t\n]/)[0].trim(); } catch { return ''; }
}

// ── FALLBACK: the newest conversation in the folder that nobody else owns ─────
// What claude-here's "newest in this cwd" and codex's `resume --last` were, minus the two
// ways that went wrong: a conversation another slot's record claims (asleep, lost, or a
// live card), and one a live process has open.
export function fallback({ dir, sock, slot, cwd, agent = 'claude', cfgs = cfgDirs(), graceMs = 0, projectsDir = '' }) {
  if (!cwd) return null;
  const claimed = new Map();
  for (const r of readRecords(dir)) {
    if (!r.sock || !r.slot) continue;
    if (r.sock === sock && r.slot === slot) continue;
    claimed.set(String(r.session_id), `${r.sock}/${r.slot}`);
  }
  let files = [];
  if (agent === 'codex') {
    // A year back: the rollouts are filed by the day they STARTED, one folder per day.
    files = findRollouts({ home: codexHome(), cwd, since: Math.floor(Date.now() / 1000) - 365 * 86400 })
      .sort((a, b) => b.started - a.started).map(r => ({ id: r.id, f: r.file }));
  } else {
    const dirs = projectsDir ? [projectsDir]
      : cfgs.flatMap(cfg => encProjects(cwd).map(enc => path.join(cfg, 'projects', enc)));
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(d, n);
        let mt = 0; try { mt = fs.statSync(f).mtimeMs; } catch { continue; }
        files.push({ id: n.slice(0, -6), f, mt });
      }
      break;                                   // the first folder that exists: this profile's
    }
    files.sort((a, b) => b.mt - a.mt);
  }
  const live = holders({ cfgs });
  const passed = [];                           // one line for all of them, not one per card
  const tell = (r) => {
    if (passed.length) say(dir, `${sock || '?'}/${slot || '?'}: passed over ${passed.length} newer conversation(s) in ${cwd} — ${passed.join(', ')} — ${r}`);
    return r;
  };
  for (const { id, f } of files) {
    if (claimed.has(id)) { passed.push(`${short(id)} (${claimed.get(id)} owns it)`); continue; }
    const pid = live.get(id) || (agent === 'codex' && rolloutOpen(f) ? '?' : '');
    if (pid && !(graceMs && !heldBy(id, { transcript: f, agent, cfgs, graceMs }))) {
      passed.push(`${short(id)} (open in live process ${pid})`); continue;
    }
    if (agent === 'claude' && !hasTurns(f)) continue;
    const r = { id, transcript: f, how: 'folder' };
    r.toString = () => `resuming ${short(id)}`;
    return tell(r);
  }
  // `passed` says whether there was anything to steal: a launcher may fall back to its agent's
  // own "newest here" only when there was not (CLI: exit 3 when something was passed over).
  return passed.length ? tell({ passed: true, toString: () => 'nothing left to resume, starting fresh' }) : null;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const dir = a.dir || process.env.CLAUDE_FLEET_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'fleet');
  const agent = a.agent === 'codex' ? 'codex' : 'claude';
  const graceMs = Math.round((a.grace === undefined ? 3 : Number(a.grace) || 0) * 1000);
  const out = (r) => { if (!r) process.exit(1); process.stdout.write(`${r.id}${US}${r.transcript}${US}${r.how}\n`); process.exit(0); };
  if (cmd === 'pick') out(pick({ dir, sock: a.sock, slot: a.slot, agent, keepLive: !!a['keep-live'], graceMs }));
  else if (cmd === 'fallback') {
    const r = fallback({ dir, sock: a.sock || '', slot: a.slot || '', cwd: a.cwd, agent,
                         projectsDir: typeof a['projects-dir'] === 'string' ? a['projects-dir'] : '' });
    if (r && r.passed) process.exit(3);
    out(r);
  }
  else if (cmd === 'held') {
    const tr = a.transcript || (agent === 'codex' ? rolloutById(a.id, codexHome()) : '');
    const pid = a.id ? heldBy(a.id, { transcript: tr, agent, graceMs }) : '';
    if (pid) { process.stdout.write(`${pid}\n`); process.exit(0); }
    process.exit(1);
  } else { process.stderr.write('slot-claim: pick | fallback | held\n'); process.exit(2); }
}
