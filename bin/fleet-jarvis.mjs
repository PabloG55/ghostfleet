#!/usr/bin/env node
// fleet-jarvis — make, inspect and look after Jarvis, the master of masters (docs/jarvis.md).
//
//   fleet-jarvis init [--profile P] [--path DIR] [--if-needed]
//                                 create Jarvis's home (a tiny git repo OUTSIDE every
//                                 checkout), register it as a project, write the marker
//   fleet-jarvis status [--json]  where it lives, whether it is running, what waits on a yes
//   fleet-jarvis pending          the proposals waiting for the owner's yes
//   fleet-jarvis grant|deny <id>  answer one from a terminal (the phone's tap does the same)
//   fleet-jarvis hear <file.wav>  transcribe one utterance with the local whisper.cpp
//   fleet-jarvis voice [--install [--model NAME]]
//                                 is voice ready; --install fetches whisper.cpp and a model
//   fleet-jarvis voice --kokoro [--install]
//                                 the Mac's speaking voice; --install sets up Kokoro (~350 MB)
//   fleet-jarvis restart [--if-due] [--dry-run]
//                                 the daily fresh start, carrying HANDOFF.md forward
//   fleet-jarvis said [--from SRC]    (the event hook) record what the owner said, stdin
//   fleet-jarvis gate-bash            (hooks/jarvis-guard.sh) judge a Bash command, stdin
//
// WHY A PROJECT AND NOT A NEW KIND OF THING. A registered project already gets a socket, a
// master, the hooks, the MCP tools, a governor, a card on the Projects screen and a chat on
// the phone — every one of which Jarvis needs and none of which is worth a second
// implementation. What makes it Jarvis is the marker this writes, the contract in its
// CLAUDE.md, and the handful of places that read the marker (lib/jarvis.mjs lists them).
//
// NOTHING ABOUT THE OWNER'S JARVIS LIVES IN THIS REPO. Its home is created under
// ~/.local/share/ghostfleet/jarvis on the machine that runs it; this repo ships only the
// template of its contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects } from '../mcp/fleet-dispatch.mjs';
import { scanStatus } from '../lib/fleet-scan.mjs';
import * as J from '../lib/jarvis.mjs';
import * as speech from '../lib/speech.mjs';
import * as K from '../lib/kokoro-setup.mjs';

const BIN = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BIN, '..');
const HOME = os.homedir();
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(n);
const die = (msg, code = 1) => { process.stderr.write(`fleet-jarvis: ${msg}\n`); process.exit(code); };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
// A TIMEOUT ON EVERY ONE: fleet-serve calls jarvisState() on the phone's poll, and a wedged
// tmux server must cost that request two seconds, not the daemon its event loop.
const tmux = (sock, ...a) => spawnSync('tmux', ['-L', sock, ...a], { encoding: 'utf8', timeout: 2000 });
const running = (m) => !!m && tmux(m.sock, 'has-session', '-t', '=master').status === 0;
const sockFor = (name, prof) => (prof === 'work' || prof === 'default') ? `cf-${name}` : `cf-${prof}-${name}`;
const cfgFor = (prof) => (prof === 'work' || prof === 'default') ? path.join(HOME, '.claude') : path.join(HOME, `.claude-${prof}`);
const stampFile = () => path.join(J.cfgHome(), 'jarvis.restarted');

// The words whisper is primed with: the names it will hear and would otherwise mangle
// ("acme api" came back as "Acme Appy" unprimed, measured on the turbo model).
export function vocabulary() {
  const names = [...new Set(projects().map(p => p.name))].slice(0, 40);
  return `Jarvis, ghostfleet, worktree, master, pull request, ${names.join(', ')}.`;
}

// ── init ────────────────────────────────────────────────────────────────────
const CONTRACT_TAG = '<!-- ghostfleet:jarvis-contract';
function init() {
  const prof = flag('--profile') || 'work';
  if (!/^[A-Za-z0-9_-]+$/.test(prof)) die(`'${prof}' is not a profile name`);
  const name = flag('--name') || 'jarvis';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) die(`'${name}' is not a usable project name`);
  const dir = path.resolve(flag('--path') || J.defaultRepo());
  const quiet = has('--if-needed');
  const did = [];

  // THE ONE CONFLICT THAT STOPS IT: a project already called this, somewhere else. Taking
  // the name over would hand the owner's existing project a Jarvis contract.
  const clash = projects().find(p => p.name === name && path.resolve(p.path) !== dir);
  if (clash) die(`a project called '${name}' already exists at ${clash.path} (${clash.profile}). Pick another: fleet-jarvis init --name <n>`);
  const old = J.readMarker();
  if (old && (old.name !== name || old.profile !== prof) && has('--profile'))
    process.stderr.write(`fleet-jarvis: moving Jarvis from ${old.profile}/${old.name} to ${prof}/${name}\n`);

  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); did.push(`created ${dir}`); }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    spawnSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    did.push('git init');
  }
  // THE CONTRACT, refreshed while it is still ours. The tag comment is how a later init
  // tells the generated file from one the owner has taken over: delete the tag and it is
  // his, and init never touches it again.
  const contract = fs.readFileSync(path.join(ROOT, 'lib', 'jarvis-contract.md'), 'utf8');
  const cm = path.join(dir, 'CLAUDE.md');
  let cur = null; try { cur = fs.readFileSync(cm, 'utf8'); } catch {}
  if (cur === null || (cur.startsWith(CONTRACT_TAG) && cur !== contract)) {
    fs.writeFileSync(cm, contract); did.push(cur === null ? 'wrote the contract (CLAUDE.md)' : 'refreshed the contract');
  }
  // THE BASH GUARD, in Jarvis's OWN project settings. Global settings would run it for every
  // Bash call of every session on the machine to answer a question that is only ever asked
  // about one; project settings scope it to the one session it is for.
  // THE RUNTIME'S COPY when there is one, never the checkout init happened to run from: a
  // guard path inside ~/Documents is refused by macOS for a process started from launchd, a
  // worktree gets removed, an npx cache gets cleaned — and a guard that cannot run fails
  // OPEN. install.sh stages the runtime at CLAUDE_FLEET_HOME (~/.local/libexec/ghostfleet).
  const rtGuard = path.join(process.env.CLAUDE_FLEET_HOME || path.join(HOME, '.local', 'libexec', 'ghostfleet'), 'hooks', 'jarvis-guard.sh');
  const guard = fs.existsSync(rtGuard) ? rtGuard : path.join(ROOT, 'hooks', 'jarvis-guard.sh');
  const sdir = path.join(dir, '.claude'); fs.mkdirSync(sdir, { recursive: true });
  const sf = path.join(sdir, 'settings.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
  const want = { matcher: 'Bash', hooks: [{ type: 'command', command: guard }] };
  const pre = ((st.hooks || {}).PreToolUse || []).filter(e => !JSON.stringify(e).includes('jarvis-guard.sh'));
  const next = { ...st, hooks: { ...(st.hooks || {}), PreToolUse: [...pre, want] } };
  if (JSON.stringify(next) !== JSON.stringify(st)) {
    fs.writeFileSync(sf, JSON.stringify(next, null, 2) + '\n'); did.push('wired the confirm-list guard (.claude/settings.json)');
  }
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'HANDOFF.md\n');
  // A first commit, so the checkout has a HEAD like every other project's. The owner's
  // configured identity or none: a machine with no git identity still gets a working Jarvis.
  if (spawnSync('git', ['-C', dir, 'rev-parse', '-q', '--verify', 'HEAD'], { stdio: 'ignore' }).status !== 0) {
    spawnSync('git', ['-C', dir, 'add', 'CLAUDE.md', '.gitignore', '.claude/settings.json'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', "Jarvis's home"], { stdio: 'ignore' });
  }

  if (!projects().some(p => p.name === name && p.profile === prof)) {
    const r = spawnSync(path.join(BIN, 'fleet-project'), ['add', dir, '--name', name, '--profile', prof], { encoding: 'utf8' });
    if (r.status !== 0) die(`could not register the project: ${(r.stderr || r.stdout || '').trim()}`);
    did.push(`registered project '${name}' on the ${prof} profile`);
  }
  const m = { name, profile: prof, sock: sockFor(name, prof), cfg: cfgFor(prof), path: dir,
              batch: old ? old.batch || '' : '', restart_hour: old ? old.restart_hour : '' };
  if (!old || ['name', 'profile', 'sock', 'cfg', 'path'].some(k => old[k] !== m[k])) { J.writeMarker(m); did.push(`wrote the marker (${J.markerPath()})`); }

  if (quiet && !did.length) return;
  console.log(`Jarvis — ${prof}/${name} at ${dir}`);
  for (const d of did) console.log(`  ✓ ${d}`);
  if (!did.length) console.log('  already set up');
  console.log('');
  console.log('  Talk to it at the desk:   ghostfleet jarvis');
  console.log('  On the phone:             the Jarvis bar at the top of Projects');
  const v = J.voiceStatus();
  console.log(`  Voice:                    ${v.ready ? `ready (${v.model})` : v.why}`);
}

// ── status ──────────────────────────────────────────────────────────────────
export function jarvisState() {
  const m = J.readMarker();
  if (!m) return { present: false, why: 'no Jarvis on this machine yet — run: ghostfleet jarvis' };
  const rec = scanStatus([m.dir]).find(r => r.sock === m.sock && r.slot === 'master');
  let last = 0; try { last = Number(fs.readFileSync(stampFile(), 'utf8').trim()) || 0; } catch {}
  // Is the confirm-list's Bash guard actually runnable? A missing one fails open, silently.
  let guard = '';
  try {
    const st = JSON.parse(fs.readFileSync(path.join(m.path, '.claude', 'settings.json'), 'utf8'));
    guard = ((st.hooks || {}).PreToolUse || []).flatMap(e => (e.hooks || []).map(h => h.command)).find(c => /jarvis-guard\.sh$/.test(c || '')) || '';
  } catch {}
  let guardOk = false; try { fs.accessSync(guard, fs.constants.X_OK); guardOk = true; } catch {}
  return { present: true, project: m.name, profile: m.profile, session: 'master', path: m.path, guard: guardOk ? 'ok' : (guard ? `not runnable: ${guard}` : 'not wired'),
           running: running(m), status: rec ? rec.status : null,
           voice: J.voiceStatus(), speak: speech.status(), pending: J.pending(),
           restart: { hour: m.restart_hour, last }, batch: m.batch };
}
async function status() {
  const s = jarvisState();
  if (has('--json')) { console.log(JSON.stringify(s)); return; }
  if (!s.present) { console.log(s.why); return; }
  console.log(`Jarvis — ${s.profile}/${s.project} at ${s.path}`);
  console.log(`  session   ${s.running ? `running${s.status ? ` (${s.status})` : ''}` : 'not running — ghostfleet jarvis starts it'}`);
  console.log(`  voice     ${s.voice.ready ? `ready (${s.voice.model})` : s.voice.why}`);
  console.log(`  speaks    ${speakLine(await K.check())}`);
  console.log(`  guard     ${s.guard === 'ok' ? 'the confirm-list guard is wired' : `WARNING — ${s.guard}; Bash is NOT gated. Re-run: fleet-jarvis init`}`);
  console.log(`  wakes     on a need-you anywhere, at once${s.batch ? `; finished work batched every ${Math.round(s.batch / 60)} min` : '; nothing else — finished work waits until he speaks'}`);
  console.log(`  restart   daily at ${String(s.restart.hour).padStart(2, '0')}:00 when idle${s.restart.last ? ` · last ${new Date(s.restart.last * 1000).toLocaleString()}` : ''}`);
  console.log(`  pending   ${s.pending.length ? s.pending.map(p => `${p.id} ${p.summary}${p.granted ? ' (yes — waiting for Jarvis to act)' : ''}`).join('\n            ') : 'nothing waits on a yes'}`);
}

// ── the daily fresh start ───────────────────────────────────────────────────
// A LONG CONTEXT IS THE KNOWN FAILURE of a session that never ends, and Jarvis is the one
// session built never to end. So once a day, while it is idle, it is replaced by a new
// conversation — and what it was carrying goes forward as a file, built from the record
// rather than asked of the model: a summary Jarvis writes costs a turn and can be wrong about
// itself, while these are the rows that actually happened.
function buildHandoff(m) {
  const L = [`# Handoff — ${new Date().toLocaleString()}`, '',
    'You were restarted fresh this morning (the daily restart). This is what the previous',
    'conversation left behind. Read it, then carry on; nothing here needs doing unprompted.', ''];
  const pend = J.pending();
  L.push('## Waiting on his yes');
  L.push(pend.length ? pend.map(p => `- ${p.id}: ${p.summary}${p.granted ? ' — he said yes; make the call' : ''}`).join('\n') : '- nothing');
  L.push('', '## The last things he said');
  const said = J.readSaid().slice(-6);
  L.push(said.length ? said.map(x => `- ${new Date(x.ts).toLocaleString()}: ${x.text}`).join('\n') : '- nothing recorded');
  L.push('', '## What you last told him');
  const r = spawnSync(path.join(BIN, 'fleet-read'), ['-s', m.sock, 'master', '3'],
    { encoding: 'utf8', env: { ...process.env, TMUX: '', CLAUDE_CONFIG_DIR: m.cfg, CLAUDE_FLEET_DIR: m.dir, CLAUDE_FLEET_SOCK: m.sock } });
  const told = String(r.stdout || '').trim();
  L.push(told ? told.split('\n').map(l => `> ${l}`).join('\n').slice(0, 2400) : '- (no transcript to read)');
  L.push('', '## The fleets at the restart');
  const d = spawnSync(path.join(BIN, 'fleet-digest'), ['--peek'], { encoding: 'utf8' });
  L.push('```', String(d.stdout || '').split('\n').slice(0, 30).join('\n').trim() || '(no digest)', '```', '');
  return L.join('\n');
}
function restart() {
  const m = J.readMarker();
  if (!m) die('no Jarvis on this machine (fleet-jarvis init)');
  const now = Math.floor(Date.now() / 1000);
  let last = 0; try { last = Number(fs.readFileSync(stampFile(), 'utf8').trim()) || 0; } catch {}
  if (has('--if-due')) {
    // FIRST SIGHT IS A BASELINE, NOT A RESTART — the same rule as the push watcher's. A
    // Jarvis created at 3:55 must not be torn down at 4:00 by a timer that had never seen it.
    if (!last) { fs.writeFileSync(stampFile(), `${now}\n`); return; }
    const d = new Date(); d.setHours(m.restart_hour, 0, 0, 0);
    const due = Math.floor(d.getTime() / 1000);
    if (now < due || last >= due) return;                       // not yet today, or done today
  }
  if (!running(m)) { if (!has('--dry-run')) fs.writeFileSync(stampFile(), `${now}\n`); console.log('fleet-jarvis: not running — nothing to restart (the next start is fresh anyway)'); return; }
  // ONLY WHEN IDLE, and idle for a while. A restart mid-turn throws away the turn; one while
  // he is waiting on an answer throws away the answer. Deferred, not skipped: --if-due asks
  // again on the governor's next tick.
  const rec = scanStatus([m.dir]).find(r => r.sock === m.sock && r.slot === 'master');
  const quietFor = rec ? now - rec.ts : Infinity;
  if (!has('--force') && rec && (!['ready', 'idle'].includes(rec.status) || quietFor < 600)) {
    console.log(`fleet-jarvis: not idle (${rec.status}, last event ${quietFor}s ago) — deferred`);
    process.exitCode = 3; return;
  }
  const handoff = buildHandoff(m);
  if (has('--dry-run')) { process.stdout.write(handoff); return; }
  fs.writeFileSync(path.join(m.path, 'HANDOFF.md'), handoff);
  // RENAME, START, THEN KILL — never kill first. Jarvis's fleet usually holds one session,
  // and killing the last session of a tmux server kills the server: its bindings, and the
  // governor that is running this very command, which exits when its fleet disappears.
  const old = `_jarvis-old-${now}`;
  tmux(m.sock, 'rename-session', '-t', '=master', old);
  const r = tmux(m.sock, '-f', path.join(ROOT, 'tmux', 'cf.tmux.conf'), 'new-session', '-d', '-s', 'master', '-c', m.path,
    '-e', `CLAUDE_CONFIG_DIR=${m.cfg}`, '-e', `CLAUDE_FLEET_SOCK=${m.sock}`, '-e', 'CLAUDE_FLEET_AGENT=',
    '-e', 'CLAUDE_FLEET_FRESH=1', `exec ${path.join(BIN, 'agent-here')} master`);
  if (r.status !== 0) {
    tmux(m.sock, 'rename-session', '-t', `=${old}`, 'master');   // put it back rather than leave none
    die(`could not start a fresh master: ${(r.stderr || '').trim()}`);
  }
  tmux(m.sock, 'kill-session', '-t', `=${old}`);
  fs.writeFileSync(stampFile(), `${now}\n`);
  try { fs.appendFileSync(path.join(m.dir, `${m.sock}.inbox`), `${now}\tmaster\trestarted\tdaily fresh start — HANDOFF.md carried forward\n`); } catch {}
  console.log(`fleet-jarvis: restarted fresh; HANDOFF.md written to ${m.path}`);
}

// ── voice ───────────────────────────────────────────────────────────────────
const MODELS = { 'large-v3-turbo-q5_0': 574, 'base.en': 148, 'small.en': 488 };
// THE MAC'S TWO HALVES OF A CONVERSATION, under one command: hearing is whisper.cpp (the
// default, and what every existing "run: fleet-jarvis voice --install" means), speaking is
// Kokoro, selected with --kokoro. Two downloads, two separate yeses — install.sh asks for
// each on its own, so neither flag ever brings the other along. Plain `voice` reports both
// and exits on hearing alone, which is what install.sh has always tested it for.
export const speakLine = (k) => k.ready ? `Kokoro, installed (${k.dir})`
  : k.state === 'missing' ? `the phone's own voice — Kokoro is not installed (optional, ~350 MB): ${speech.KOKORO_FIX}`
  : k.state === 'off' ? k.why : `BROKEN — ${k.why}`;
async function voice() {
  if (has('--kokoro')) return kokoro();
  let v = J.voiceStatus();
  if (!has('--install')) {
    console.log(v.ready ? `voice ready — ${v.bin} with ${v.model}` : `${v.why}\n  ${v.how}`);
    console.log(`speaks with ${speakLine(speech.status())}`);
    process.exitCode = v.ready ? 0 : 1; return;
  }
  // AN OPTIONAL STEP THAT CAN FAIL AND MUST SAY SO — but never takes the install down with
  // it: install.sh calls this with `|| true`. Text keeps working without any of it.
  if (!J.whisperBin()) {
    const brew = spawnSync('/bin/sh', ['-c', 'command -v brew'], { encoding: 'utf8' }).stdout.trim();
    if (!brew) die('whisper.cpp is not installed and there is no Homebrew to install it with. Build it from https://github.com/ggml-org/whisper.cpp and put whisper-cli on PATH, then run this again.');
    console.log('fleet-jarvis: brew install whisper-cpp');
    if (spawnSync(brew, ['install', 'whisper-cpp'], { stdio: 'inherit' }).status !== 0) die('brew install whisper-cpp failed');
  }
  if (!J.whisperModel()) {
    const name = flag('--model') || 'large-v3-turbo-q5_0';
    if (!MODELS[name]) die(`unknown model '${name}' (have: ${Object.keys(MODELS).join(', ')})`);
    fs.mkdirSync(J.MODEL_DIR(), { recursive: true });
    const dst = path.join(J.MODEL_DIR(), `ggml-${name}.bin`), tmp = `${dst}.part`;
    console.log(`fleet-jarvis: downloading ggml-${name}.bin (~${MODELS[name]} MB) into ${J.MODEL_DIR()}`);
    const r = spawnSync('curl', ['-fL', '--progress-bar', '-o', tmp, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`], { stdio: 'inherit' });
    if (r.status !== 0) { try { fs.unlinkSync(tmp); } catch {} die('the model download failed'); }
    fs.renameSync(tmp, dst);
  }
  v = J.voiceStatus();
  console.log(v.ready ? `voice ready — ${v.bin} with ${v.model}` : v.why);
  process.exitCode = v.ready ? 0 : 1;
}

async function kokoro() {
  if (!has('--install')) {
    const k = await K.check();
    console.log(k.ready ? `Kokoro ready — ${k.dir}` : `${k.why}${k.state === 'missing' ? `\n  ${k.how}` : ''}`);
    process.exitCode = k.ready ? 0 : 1; return;
  }
  // AN OPTIONAL STEP THAT CAN FAIL AND MUST SAY SO, like whisper's above — install.sh calls
  // it with `||` and carries on, because the phone's own voice still reads every reply.
  const r = await K.install();
  if (!r.ok) { process.stderr.write(`fleet-jarvis: ${r.why}\n`); process.exitCode = r.code || 1; return; }
  process.exitCode = 0;
}

// ── dispatch ────────────────────────────────────────────────────────────────
async function main() {
  switch (cmd) {
    case 'init': return init();
    case 'status': return await status();
    case 'pending': {
      const p = J.pending();
      if (has('--json')) return console.log(JSON.stringify(p));
      return console.log(p.length ? p.map(x => `${x.id}  ${x.summary}${x.granted ? '  (yes given)' : ''}`).join('\n') : 'nothing waits on a yes');
    }
    case 'grant': case 'deny': {
      const id = argv[1]; if (!id) die(`${cmd} needs a proposal id (fleet-jarvis pending)`);
      const r = J.answer(id, cmd === 'grant', 'desk');
      if (!r.ok) die(r.text);
      return console.log(`${cmd === 'grant' ? 'yes' : 'no'} to ${r.id}: ${r.summary}`);
    }
    // The hook's call. A prompt bin/fleet-send delivered is the fleet talking, whatever it
    // says, and is not recorded as him (lib/jarvis.mjs consumeDelivery).
    case 'said': { const t = readStdin(); if (!J.consumeDelivery(t)) J.recordSaid(t, flag('--from') || 'owner'); return; }
    case 'gate-bash': {
      const c = readStdin();
      const spec = J.bashSpec(c);
      if (spec.action === 'ok') return;
      if (spec.action === 'refuse') { process.stderr.write(`jarvis: ${spec.why}\n`); process.exit(2); }
      const g = J.gate(spec);
      if (g.ok) return;
      process.stderr.write(`jarvis: ${g.text}\n`); process.exit(2);
    }
    case 'hear': {
      const f = argv[1]; if (!f) die('hear needs a WAV file');
      let buf; try { buf = fs.readFileSync(f); } catch (e) { die(e.message); }
      const r = J.transcribe(buf, { prompt: vocabulary() });
      if (r.error) die(r.error);
      return console.log(r.text);
    }
    case 'voice': return await voice();
    case 'restart': return restart();
    case '-h': case '--help': case 'help':
      return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    default: die(`unknown command '${cmd}' (fleet-jarvis --help)`, 2);
  }
}
let direct = false;
try { direct = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) main().catch((e) => die(String((e && e.stack) || e)));
