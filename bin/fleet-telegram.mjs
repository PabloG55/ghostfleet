#!/usr/bin/env node
// fleet-telegram — a Telegram chat connected to one fleet session, so the owner talks to a
// lead from a phone and the lead answers there.
//
// WHY THE LEAD IS THE BOT. The first version of this was a separate headless relay: a bot
// that read Telegram, asked a session, waited, and copied an answer back. It dropped them —
// two of four relayed messages in one audit got no reply — because it was a second agent
// guessing when the first one had finished. Here there is no second agent. A message is
// typed into the linked session by fleet-send, as the owner's words, and THAT turn's final
// message goes back: the reply address `telegram/<message>` rides fleet-send's queue, the
// mod's handoff and the Stop relay in hooks/fleet-event.sh exactly like an agent's question,
// and the relay writes the answer into this daemon's outbox. A busy session queues the
// message behind its turn, so the reply is the one the message started — never a stranger's.
//
// WHAT A TELEGRAM TURN MAY DO is the owner's decision, and the choice was an allowlist over
// full power: hooks/fleet-telegram-guard.sh holds such a turn to reading, searching, the web and
// the fleet's own tools, and delegation does the rest. See docs/TELEGRAM.md.
//
// THE TOKEN AND THE CHAT ID ARE NEVER STORED HERE. `config secret-cmd` names a command that
// prints them (the OS keychain, a secret manager); it is run with `token` or `chat` as its
// one argument, its stdout is the value, and the value lives in this process's memory only —
// never in a file, an argv, an environment, a log line or anything printed.
//
//   fleet-telegram link <project>/<session>   which session the chat talks to
//   fleet-telegram status                     link, guard, secrets, daemon, allowlist
//   fleet-telegram start | stop               the daemon, as a launchd/systemd unit (or a pidfile)
//   fleet-telegram run                        the daemon in the foreground (what the unit runs)
//   fleet-telegram send "<text>" [--file <path>]
//   fleet-telegram config [secret-cmd <cmd> | transcribe-cmd <cmd> | allow <pattern>… |
//                          allow --only <pattern>… | allow --reset | disallow <pattern>…]
//
// Node builtins only: ghostfleet is a zero-dependency package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects } from '../lib/projects.mjs';
import { storePhoto, storeAudio, sniffImage, ATTACH_MAX_BYTES } from '../lib/attach.mjs';
import { telegramChunks } from '../lib/telegram-format.mjs';

const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const BIN = path.dirname(SELF);
const GUARD = path.join(BIN, '..', 'hooks', 'fleet-telegram-guard.sh');
const HOME = os.homedir();
const DIR = process.env.GHOSTFLEET_TELEGRAM_DIR || path.join(HOME, '.config', 'ghostfleet', 'telegram');
const CONFIG = path.join(DIR, 'config.json');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log');
const PIDFILE = path.join(DIR, 'daemon.pid');
const OUTBOX = path.join(DIR, 'outbox');
// The API's base, overridable so the suite can point the whole loop at a local stub — this
// code never needs a real Telegram to be tested, and the suite never contacts one.
const API = (process.env.GHOSTFLEET_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
const POLL = Math.max(1, Math.min(50, Number(process.env.GHOSTFLEET_TELEGRAM_POLL) || 50));
const LABEL = `com.${(() => { try { return os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, ''); } catch { return 'user'; } })()}.ghostfleet.fleet-telegram`;
const UNIT = 'ghostfleet-telegram.service';

// ── output that can never carry a secret ─────────────────────────────────────
// Every value the secret command printed is registered here the moment it is read, and
// every line this program writes — the log, the terminal, an error it reports — goes
// through redact(). A URL with the token in its path is the shape that leaks (an error
// message quoting the request), and this catches it whatever text carried it.
const SECRETS = new Set();
const redact = (s) => { let t = String(s ?? ''); for (const v of SECRETS) if (v) t = t.split(v).join('<redacted>'); return t; };
const say = (s) => process.stdout.write(redact(s) + '\n');
const fail = (s, code = 1) => { process.stderr.write(redact(`fleet-telegram: ${s}`) + '\n'); process.exit(code); };

function ensureDir() { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); try { fs.chmodSync(DIR, 0o700); } catch {} }
// One line per event, never the words of a message: a log is a surface too. Rotated at
// 256 KB with one generation kept.
function log(msg) {
  try {
    ensureDir();
    try { if (fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + '.1'); } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${redact(msg)}\n`, { mode: 0o600 });
  } catch {}
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJson(f, v) {
  ensureDir();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const config = () => readJson(CONFIG, {});
const saveConfig = (c) => writeJson(CONFIG, c);

// ── the secrets ──────────────────────────────────────────────────────────────
// Run as `/bin/sh -c <cmd> fleet-telegram-secret <which>`, so the command sees `token` or
// `chat` as $1 and one command serves both. Stdout is the value; stderr is the command's
// own business and is not repeated, because a confused secret tool may print what it found.
function secretOf(which, cmd = String(config().secret_cmd || '')) {
  if (!cmd) throw new Error(`no secret command — set one: fleet-telegram config secret-cmd '<command printing the value for $1 = token|chat>'`);
  const r = spawnSync('/bin/sh', ['-c', cmd, 'fleet-telegram-secret', which],
                      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  const v = String(r.stdout || '').split('\n')[0].trim();
  if (v) SECRETS.add(v);
  if (r.error) throw new Error(`the secret command could not run for ${which}: ${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`the secret command exited ${r.status} for ${which}`);
  if (!v) throw new Error(`the secret command printed nothing for ${which}`);
  // A command that contains the value itself has put it in every process listing, which
  // is the one place this design exists to keep it out of.
  if (cmd.includes(v)) throw new Error(`the secret command contains the ${which} itself, so it shows in the process list — make it read the value from the keychain or a file instead`);
  return v;
}
let cached = null;
function secrets(fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;
  const token = secretOf('token');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('the token the secret command printed is not shaped like a bot token (<digits>:<letters>) — check which value it reads');
  const chat = secretOf('chat');
  if (!/^-?\d+$/.test(chat)) throw new Error('the chat id the secret command printed is not a number — it is the id of the one chat allowed to talk to this bot');
  cached = { token, chat, at: Date.now() };
  return cached;
}

// ── the Bot API ──────────────────────────────────────────────────────────────
class ApiError extends Error { constructor(m, code, extra = {}) { super(m); this.code = code; Object.assign(this, extra); } }
async function api(token, method, body = {}, { timeout = 30000, signal } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST', signal: ctl.signal,
      ...(isForm ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    let j = null; try { j = await res.json(); } catch {}
    if (!j || !j.ok) throw new ApiError(redact(`${method}: ${j?.description || `HTTP ${res.status}`}`), j?.error_code || res.status,
                                        { retryAfter: j?.parameters?.retry_after });
    return j.result;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(redact(`${method}: ${e.name === 'AbortError' ? 'timed out' : (e.cause?.code || e.message)}`), 0);
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}
async function download(token, fileId) {
  const f = await api(token, 'getFile', { file_id: fileId });
  if (!f?.file_path) throw new ApiError('getFile: no file path', 0);
  if (f.file_size && f.file_size > ATTACH_MAX_BYTES) throw new ApiError(`that file is ${Math.round(f.file_size / 1048576)} MB and the limit is ${Math.round(ATTACH_MAX_BYTES / 1048576)} MB`, 413);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: ctl.signal });
    if (!res.ok) throw new ApiError(`download: HTTP ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > ATTACH_MAX_BYTES) throw new ApiError(`that file is over the ${Math.round(ATTACH_MAX_BYTES / 1048576)} MB limit`, 413);
    return buf;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(redact(`download: ${e.name === 'AbortError' ? 'timed out' : (e.cause?.code || e.message)}`), 0);
  } finally { clearTimeout(t); }
}

// Markdown out, as Telegram HTML, chunked; a chunk Telegram cannot parse goes again plain.
// `from` resumes a reply that was cut off part-way, so a retry never repeats a chunk.
async function sendText(token, chat, text, { replyTo = 0, from = 0, onChunk } = {}) {
  const chunks = telegramChunks(text);
  for (let i = from; i < chunks.length; i++) {
    const base = { chat_id: chat, link_preview_options: { is_disabled: true },
                   ...(i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
    try {
      await api(token, 'sendMessage', { ...base, text: chunks[i].html || '…', parse_mode: 'HTML' });
    } catch (e) {
      if (e.code !== 400) throw e;
      await api(token, 'sendMessage', { ...base, text: chunks[i].plain || '…' });
    }
    if (onChunk) onChunk(i + 1);
  }
  return chunks.length;
}

// ── the linked session ───────────────────────────────────────────────────────
function resolveLink(link = config().link) {
  if (!link || !link.project || !link.session) throw new Error('not linked to a session — fleet-telegram link <project>/<session>');
  const all = projects();
  const byName = all.filter((p) => p.name === link.project);
  const t = all.find((p) => p.sock === link.project) || (byName.length === 1 ? byName[0] : null);
  if (!t) {
    if (byName.length > 1) throw new Error(`two profiles have a project called '${link.project}' — link by its socket instead (${byName.map((p) => p.sock).join(' or ')})`);
    throw new Error(`no project '${link.project}' in the projects list`);
  }
  return { ...t, session: link.session, fleetDir: path.join(t.cfg, 'fleet') };
}
// The six variables bin/ghostfleet exports when it enters a project, for every command run
// against the linked one — so fleet-send finds that fleet's dir and profile, not whichever
// this daemon happened to inherit (see invocation() in mcp/fleet-dispatch.mjs).
const envFor = (t) => ({ ...process.env, TMUX: '', CLAUDE_FLEET_SOCK: t.sock, CLAUDE_CONFIG_DIR: t.cfg,
  CLAUDE_FLEET_DIR: t.fleetDir, CLAUDE_FLEET_PROFILE: t.profile, CLAUDE_FLEET_SCOPE: t.name,
  CLAUDE_FLEET_ROOT: t.path, CLAUDE_FLEET_AGENT: t.agent || 'claude' });

// Is the guard wired where this session's hooks are read? Without it a Telegram turn would
// run with every tool the session has, which is the one thing the owner decided against —
// so a message is not delivered at all until it is (and the fix is named). The event hook
// is checked too: it is what marks the turn as Telegram's.
// The allowlist is a Claude Code PreToolUse hook. Under codex, opencode, agy or cursor it
// would not run at all, and a Telegram turn there would have every tool. So a session
// running another agent counts as unwired, and nothing reaches it until it runs claude
// again. Read on every message: fleet-agent can switch a live session, and its marker
// (`<sock>.<session>.agent`, absent for claude) is what changes. With no marker, the
// project's default agent decides, so the check fails closed.
function agentOfLink(t) {
  try {
    const a = fs.readFileSync(path.join(t.cfg, 'fleet', `${t.sock}.${t.session}.agent`), 'utf8').trim();
    if (a) return a;
  } catch {}
  return t.agent || 'claude';
}
function wiring(t) {
  const f = path.join(t.cfg, 'settings.json');
  const agent = agentOfLink(t);
  if (agent !== 'claude') {
    return { ok: false, file: f, fix: `link a session that runs claude, or switch this one back (fleet-agent)`,
             why: `the Telegram tool guard is not wired for ${t.name}/${t.session}: it runs ${agent}, and the guard is a Claude Code hook that ${agent} never calls, so a Telegram turn there would be unrestricted` };
  }
  const s = readJson(f, null);
  const cmds = (ev) => ((s?.hooks?.[ev]) || []).flatMap((x) => (x.hooks || []).map((h) => String(h.command || '')));
  const guard = cmds('PreToolUse').some((c) => c.endsWith('fleet-telegram-guard.sh'));
  const marks = cmds('UserPromptSubmit').some((c) => c.endsWith('fleet-event.sh'));
  return { ok: guard && marks, file: f, fix: 'run ./install.sh',
           why: !s ? `${f} is missing or unreadable` : !guard ? `the Telegram tool guard is not wired into ${f}` : !marks ? `the fleet event hook is not wired into ${f}` : '' };
}

function run(cmd, args, env, timeout = 60000) {
  return new Promise((done) => {
    execFile(path.join(BIN, cmd), args, { env, encoding: 'utf8', timeout, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });
}

// ── the daemon ───────────────────────────────────────────────────────────────
let stopping = false;
const inflight = new AbortController();
const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); inflight.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
let state = {};
const saveState = () => { try { writeJson(STATE, state); } catch {} };

const HELP = (t) => `This chat talks to ${t ? `${t.name}/${t.session}` : 'a fleet session (not linked yet)'}. Write to it and its answer comes back here. Photos arrive as files it can open; voice notes are transcribed when the desk has a transcriber set up.\n\n/status — what it is doing\n/help — this`;

async function onMessage(msg, sec) {
  const chat = String(msg?.chat?.id ?? '');
  if (chat !== sec.chat) { state.dropped = (state.dropped || 0) + 1; log(`dropped from ${chat || '(no chat)'}`); return; }
  const id = Number(msg.message_id) || 0;
  const reply = (text) => sendText(sec.token, sec.chat, text, { replyTo: id }).catch((e) => log(`reply failed: ${e.message}`));
  let t;
  try { t = resolveLink(); } catch (e) { log(`not delivered: ${e.message}`); return reply(`Not delivered — ${e.message}.`); }

  // A slash command is the daemon's to answer, never the session's to run: a phone message
  // must not be able to start a skill or a /command in a terminal. Any other text that
  // starts with `/` is delivered as words, behind the [telegram] tag, and runs nothing.
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  const cmd = /^\/(start|help|status)(?:@\w+)?$/i.exec(text);
  if (cmd) {
    if (cmd[1].toLowerCase() !== 'status') return reply(HELP(t));
    const r = await run('fleet-list', ['-s', t.sock], envFor(t), 15000);
    const line = r.out.split('\n').find((l) => l.split(/\s+/)[0] === t.session) || `${t.session}: no live session`;
    return reply(`${t.name}/${t.session}\n\`${line.replace(/`/g, "'")}\``);
  }

  const w = wiring(t);
  if (!w.ok) { log(`not delivered: ${w.why}`); return reply(`Not delivered — ${w.why}. At the desk: ${w.fix}.`); }

  let prompt = '';
  try {
    if (text) {
      prompt = `[telegram] ${text}`;
    } else if (msg.photo?.length || (msg.document && /^image\//.test(String(msg.document.mime_type || '')))) {
      // The largest size Telegram made that fits the store's cap; it keeps several.
      const sizes = msg.photo?.length ? [...msg.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0)) : [msg.document];
      const pick = sizes.find((s) => !s.file_size || s.file_size <= ATTACH_MAX_BYTES) || sizes[sizes.length - 1];
      const buf = await download(sec.token, pick.file_id);
      const st = storePhoto({ buf, sock: t.sock, session: t.session, fleetDir: t.fleetDir });
      if (!st.ok) { log(`photo refused: ${st.text}`); return reply(`That photo was not delivered — ${st.text}.`); }
      log(`photo: ${t.session} <- ${Math.round(st.bytes / 1024)} KB ${st.from}`);
      prompt = `[telegram] ${String(msg.caption || '').trim() || '(a photo, no caption)'}\n\nphoto: ${st.path}`;
    } else if (msg.voice || msg.audio) {
      const v = msg.voice || msg.audio;
      const buf = await download(sec.token, v.file_id);
      const words = await transcribe(buf);
      if (words) {
        log(`voice: ${t.session} <- ${Math.round(buf.length / 1024)} KB, transcribed ${words.length} chars`);
        prompt = `[telegram] (voice note, transcribed) ${words}`;
      } else {
        const st = storeAudio({ buf, sock: t.sock, session: t.session, fleetDir: t.fleetDir });
        if (!st.ok) { log(`voice refused: ${st.text}`); return reply(`That voice note was not delivered — ${st.text}.`); }
        log(`voice: ${t.session} <- ${Math.round(st.bytes / 1024)} KB ${st.from}, not transcribed`);
        prompt = `[telegram] (a voice note — no transcriber is set up at the desk, so it is an audio file: ${st.path}. If you cannot listen to it, say so and ask for it in text.)`;
      }
    } else {
      return reply(`Only text, photos and voice notes reach ${t.session}; that one was not delivered.`);
    }
  } catch (e) {
    log(`not delivered: ${e.message}`);
    return reply(`Not delivered — ${e.message}.`);
  }

  // fleet-send, as the owner: to a busy session it QUEUES, and the queued turn carries the
  // reply address, so the answer is that turn's — the busy turn's own Stop answers nobody.
  const r = await run('fleet-send', ['-s', t.sock, '--owner', '--reply-to', `telegram/m${id}`, '--reply-dir', DIR, t.session, prompt], envFor(t));
  if (r.code !== 0) {
    log(`not delivered to ${t.session}: exit ${r.code}`);
    return reply(`Not delivered to ${t.session} — ${r.out.split('\n').map((l) => l.replace(/^fleet-send:\s*/, '')).filter(Boolean).slice(0, 2).join(' — ') || `fleet-send exited ${r.code}`}`);
  }
  state.delivered = (state.delivered || 0) + 1;
  const queued = /queued #\d+/.test(r.out);
  log(`delivered ${prompt.length} chars to ${t.name}/${t.session}${queued ? ' (queued)' : ''}`);
  if (queued) reply(`${t.session} is in the middle of something — your message is queued and runs next.`);
  else api(sec.token, 'sendChatAction', { chat_id: sec.chat, action: 'typing' }).catch(() => {});
}

// A voice note in, its words out, by the owner's own command (`config transcribe-cmd`),
// run as `/bin/sh -c <cmd> fleet-telegram-transcribe <file>`. The audio sits in a private
// temp dir for as long as the command runs and no longer. '' when there is no transcriber
// or it failed — the caller then delivers the file itself.
async function transcribe(buf) {
  const cmd = String(config().transcribe_cmd || '');
  if (!cmd) return '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-telegram-'));
  const f = path.join(tmp, 'voice.oga');
  try {
    fs.writeFileSync(f, buf, { mode: 0o600 });
    const r = await new Promise((done) => execFile('/bin/sh', ['-c', cmd, 'fleet-telegram-transcribe', f],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 20 }, (err, stdout) => done({ err, stdout })));
    if (r.err) { log(`transcribe-cmd failed: ${r.err.code ?? r.err.message}`); return ''; }
    return String(r.stdout || '').replace(/\s+/g, ' ').trim();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The outbox: one JSON file per answer, written by hooks/fleet-event.sh at the Stop of a
// Telegram turn. Sent oldest first; a file is removed only once every chunk is sent, and
// records how far it got, so a retry resumes instead of repeating.
let pumping = false;
async function pump() {
  if (pumping || stopping) return;
  pumping = true;
  try {
    let names = [];
    try { names = fs.readdirSync(OUTBOX).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
    if (!names.length) return;
    let sec; try { sec = secrets(); } catch (e) { setError(e.message); return; }
    for (const n of names) {
      const f = path.join(OUTBOX, n);
      const rec = readJson(f, null);
      if (!rec) { quarantine(f, 'unreadable'); continue; }
      const who = `${String(rec.sock || '').replace(/^cf-/, '')}/${rec.session || '?'}`;
      const text = rec.event === 'asks'
        ? `${rec.session || 'The session'} is waiting on you: ${rec.text || 'it needs an answer at the desk'}`
        : (String(rec.text || '').trim() || `(${rec.session || 'the session'} ended its turn without a message — at the desk: fleet-read -s ${rec.sock} ${rec.session})`);
      const replyTo = /^m\d+$/.test(String(rec.reply_to || '')) ? Number(rec.reply_to.slice(1)) : 0;
      try {
        const n2 = await sendText(sec.token, sec.chat, text, { replyTo, from: Number(rec.sent) || 0,
          onChunk: (k) => { rec.sent = k; try { writeJson(f, rec); } catch {} } });
        fs.rmSync(f, { force: true });
        state.sent = (state.sent || 0) + 1;
        log(`sent ${rec.event || 'answered'} from ${who}: ${n2} message${n2 === 1 ? '' : 's'}, ${text.length} chars`);
      } catch (e) {
        if (e.code === 401) { cached = null; setError(e.message); return; }
        if (e.code === 429) { await nap(Math.min(60, Number(e.retryAfter) || 5) * 1000); return; }
        if (e.code >= 400 && e.code < 500) { quarantine(f, e.message); continue; }
        setError(e.message); return;               // network: keep it, try again next tick
      }
    }
  } finally { pumping = false; }
}
function quarantine(f, why) {
  try { fs.mkdirSync(path.join(OUTBOX, 'failed'), { recursive: true, mode: 0o700 }); fs.renameSync(f, path.join(OUTBOX, 'failed', path.basename(f))); } catch {}
  log(`could not send ${path.basename(f)}: ${why} — kept in outbox/failed`);
}
function setError(m) { if (state.last_error !== m) log(`error: ${m}`); state.last_error = m; state.last_error_at = Math.floor(Date.now() / 1000); saveState(); }

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const isOurs = (pid) => {
  const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && /fleet-telegram\.mjs run\b/.test(r.stdout || '');
};
function daemonPid() {
  const pid = Number(String((() => { try { return fs.readFileSync(PIDFILE, 'utf8'); } catch { return ''; } })()).trim());
  return pid > 1 && pidAlive(pid) && isOurs(pid) ? pid : 0;
}

async function daemon() {
  ensureDir();
  fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
  // One poller per bot: Telegram answers a second getUpdates with a 409, and two daemons
  // would deliver every message twice anyway. The lock is the pidfile, and a pid that is
  // not this program any more is a stale one, not a rival.
  const other = daemonPid();
  if (other && other !== process.pid) fail(`already running (pid ${other})`);
  fs.writeFileSync(PIDFILE, `${process.pid}\n`, { mode: 0o600 });
  state = readJson(STATE, {});
  Object.assign(state, { pid: process.pid, started: Math.floor(Date.now() / 1000), last_error: '' });
  saveState();
  const bye = () => { if (stopping) return; stopping = true; inflight.abort(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  process.on('uncaughtException', (e) => { log(`crashed: ${e.message}`); process.exit(1); });
  log(`started (pid ${process.pid}, polling every ${POLL}s)`);

  const tick = setInterval(() => { pump().catch((e) => log(`outbox: ${e.message}`)); }, 1000);
  let watcher = null;
  try { watcher = fs.watch(OUTBOX, () => { pump().catch(() => {}); }); } catch {}

  let backoff = 1;
  while (!stopping) {
    let sec;
    try { sec = secrets(); } catch (e) { setError(e.message); await nap(30000); continue; }
    try {
      const ups = await api(sec.token, 'getUpdates', { offset: state.offset || 0, timeout: POLL, allowed_updates: ['message'] },
                            { timeout: (POLL + 15) * 1000, signal: inflight.signal });
      state.last_poll = Math.floor(Date.now() / 1000);
      if (state.last_error) state.last_error = '';
      backoff = 1;
      for (const u of ups || []) {
        if (stopping) break;
        if (u.message) await onMessage(u.message, sec).catch((e) => log(`message ${u.update_id}: ${e.message}`));
        // Advanced after the message was handled, so a crash part-way repeats it rather
        // than losing it — the failure this whole path exists to fix is the silent one.
        state.offset = u.update_id + 1;
        saveState();
      }
      saveState();
    } catch (e) {
      if (stopping) break;
      if (e.code === 401) cached = null;
      setError(e.message);
      await nap(Math.min(60, backoff) * 1000); backoff *= 2;
    }
  }
  clearInterval(tick); try { watcher?.close(); } catch {}
  await pump().catch(() => {});
  try { if (Number(fs.readFileSync(PIDFILE, 'utf8').trim()) === process.pid) fs.rmSync(PIDFILE, { force: true }); } catch {}
  state.pid = 0; saveState();
  log('stopped');
  process.exit(0);
}

// ── the unit ─────────────────────────────────────────────────────────────────
// launchd on macOS, a systemd --user unit on Linux, and on a box with neither (WSL without
// systemd) a detached process and a pidfile. GHOSTFLEET_TELEGRAM_SERVICE picks one by name.
// The unit runs the STAGED runtime this file is in (install.sh's ~/.local/libexec), because
// macOS will not let a launchd job read a checkout under ~/Documents.
function serviceMode() {
  const forced = process.env.GHOSTFLEET_TELEGRAM_SERVICE;
  if (forced) return forced;
  const has = (b) => spawnSync('/bin/sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }).status === 0;
  if (process.platform === 'darwin' && has('launchctl')) return 'launchd';
  if (process.platform === 'linux' && has('systemctl')
      && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }).status === 0) return 'systemd';
  return 'pidfile';
}
const agentsDir = () => process.env.GHOSTFLEET_LAUNCH_AGENTS || path.join(HOME, 'Library', 'LaunchAgents');
const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
const unitPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user', UNIT);
// Only what the daemon needs to find its tools and its state — and never a secret: the
// unit file is a plain file on disk, which is exactly where the token must not be.
const unitEnv = () => Object.fromEntries(Object.entries({
  HOME, PATH: process.env.PATH || '/usr/bin:/bin',
  GHOSTFLEET_TELEGRAM_DIR: process.env.GHOSTFLEET_TELEGRAM_DIR, GHOSTFLEET_TELEGRAM_API: process.env.GHOSTFLEET_TELEGRAM_API,
}).filter(([, v]) => v));
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist() {
  const env = Object.entries(unitEnv()).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(SELF)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(DIR, 'daemon.out'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(DIR, 'daemon.out'))}</string>
</dict>
</plist>
`;
}
function systemdUnit() {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=ghostfleet Telegram channel (fleet-telegram)
After=network-online.target

[Service]
ExecStart=${q(process.execPath)} ${q(SELF)} run
${Object.entries(unitEnv()).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function preflight() {
  const t = resolveLink();
  const w = wiring(t);
  if (!w.ok) throw new Error(`${w.why} — ${w.fix}, then start again`);
  secrets(true);
  return t;
}

async function start(args) {
  const mode = serviceMode();
  if (args.includes('--dry-run')) {
    if (mode === 'launchd') return say(`${plistPath()}\n${plist()}`);
    if (mode === 'systemd') return say(`${unitPath()}\n${systemdUnit()}`);
    return say(`pidfile: ${process.execPath} ${SELF} run  (pid in ${PIDFILE})`);
  }
  try { preflight(); } catch (e) { fail(`not started — ${e.message}`); }
  ensureDir();
  if (process.platform === 'darwin' && SELF.startsWith(path.join(HOME, 'Documents') + path.sep) && mode === 'launchd')
    say(`note: this runs from ${BIN}, under ~/Documents, which macOS does not let a launchd job read — run ./install.sh and start the installed fleet-telegram`);
  if (mode === 'launchd') {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(plistPath(), plist(), { mode: 0o644 });
    const dom = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', `${dom}/${LABEL}`], { stdio: 'ignore' });
    const r = spawnSync('launchctl', ['bootstrap', dom, plistPath()], { encoding: 'utf8' });
    if (r.status !== 0) fail(`launchctl bootstrap failed: ${String(r.stderr || '').trim() || r.status}`);
    return say(`started ${LABEL} (launchd) — ${plistPath()}`);
  }
  if (mode === 'systemd') {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), systemdUnit(), { mode: 0o644 });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = spawnSync('systemctl', ['--user', 'enable', '--now', UNIT], { encoding: 'utf8' });
    if (r.status !== 0) fail(`systemctl --user enable --now ${UNIT} failed: ${String(r.stderr || '').trim() || r.status}`);
    return say(`started ${UNIT} (systemd --user) — ${unitPath()}`);
  }
  const was = daemonPid();
  if (was) return say(`already running (pid ${was})`);
  const out = fs.openSync(path.join(DIR, 'daemon.out'), 'a', 0o600);
  const child = spawn(process.execPath, [SELF, 'run'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 50 && daemonPid() !== child.pid; i++) await new Promise((r) => setTimeout(r, 100));
  if (daemonPid() !== child.pid) fail(`the daemon did not come up — see ${LOG}`);
  say(`started (pid ${child.pid}) — log: ${LOG}`);
}

async function stop() {
  let did = false;
  if (fs.existsSync(plistPath())) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
    fs.rmSync(plistPath(), { force: true }); did = true; say(`stopped ${LABEL} (launchd)`);
  }
  if (fs.existsSync(unitPath())) {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' });
    fs.rmSync(unitPath(), { force: true }); spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    did = true; say(`stopped ${UNIT} (systemd --user)`);
  }
  // By the pid it recorded, and only once ps says that pid is still this program.
  const pid = daemonPid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(pid) && isOurs(pid)) process.kill(pid, 'SIGKILL');
    did = true; say(`stopped (pid ${pid})`);
  }
  if (!did) say('not running');
}

async function status() {
  const c = config();
  const ago = (s) => (s ? `${Math.max(0, Math.floor(Date.now() / 1000) - s)}s ago` : 'never');
  let t = null;
  try { t = resolveLink(); say(`linked:      ${t.name}/${t.session}  (${t.sock}, profile ${t.profile})`); }
  catch (e) { say(`linked:      no — ${e.message}`); }
  if (t) { const w = wiring(t); say(`guard:       ${w.ok ? `wired (${w.file})` : `NOT WIRED — ${w.why}; ${w.fix}`}`); }
  let sec = null;
  if (!c.secret_cmd) say('secrets:     no secret command — fleet-telegram config secret-cmd \'<command>\'');
  else {
    try { sec = secrets(true); say('secrets:     the token and the chat id both resolve'); }
    catch (e) { say(`secrets:     ${e.message}`); }
  }
  if (sec) {
    try { const me = await api(sec.token, 'getMe', {}, { timeout: 10000 }); say(`bot:         @${me.username || me.first_name || '?'}`); }
    catch (e) { say(`bot:         unreachable — ${e.message}`); }
  }
  const st = readJson(STATE, {});
  const pid = daemonPid();
  const unit = fs.existsSync(plistPath()) ? 'launchd' : fs.existsSync(unitPath()) ? 'systemd' : 'pidfile';
  say(`daemon:      ${pid ? `running (pid ${pid}, ${unit}), last poll ${ago(st.last_poll)}` : unit !== 'pidfile' ? `installed as ${unit}, not running` : 'not running — fleet-telegram start'}`);
  if (st.last_error) say(`last error:  ${st.last_error}`);
  say(`counts:      ${st.delivered || 0} delivered, ${st.sent || 0} answers sent, ${st.dropped || 0} dropped from other chats`);
  let waiting = 0; try { waiting = fs.readdirSync(OUTBOX).filter((n) => n.endsWith('.json')).length; } catch {}
  say(`outbox:      ${waiting} waiting`);
  say(`transcribe:  ${c.transcribe_cmd ? 'set' : 'not set — voice notes arrive as audio files'}`);
  say(`allowlist:   ${allowList().join(' ')}${Array.isArray(c.allow) && c.allow.length ? '' : '  (the default)'}`);
}

function allowList() {
  const c = config();
  if (Array.isArray(c.allow) && c.allow.filter((x) => typeof x === 'string' && x).length) return c.allow.filter((x) => typeof x === 'string' && x);
  const r = spawnSync(GUARD, ['--default'], { encoding: 'utf8' });
  return String(r.stdout || '').trim().split(/\s+/).filter(Boolean);
}

// ── the CLI ──────────────────────────────────────────────────────────────────
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PATTERN = /^[A-Za-z0-9_*?\[\]-]+(?::scratch)?$/;
async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'link': {
      const m = /^([^/\s]+)\/([^/\s]+)$/.exec(rest[0] || '');
      if (!m || rest.length !== 1) fail('usage: fleet-telegram link <project>/<session>', 2);
      if (!NAME.test(m[2]) || m[2].includes('..')) fail(`'${m[2]}' is not a session name`, 2);
      let t; try { t = resolveLink({ project: m[1], session: m[2] }); } catch (e) { fail(e.message); }
      const c = config(); c.link = { project: m[1], session: m[2] }; saveConfig(c);
      say(`linked to ${t.name}/${t.session} (${t.sock})`);
      const w = wiring(t);
      if (!w.ok) say(`warning: ${w.why} — nothing is delivered until it is; ${w.fix}`);
      if (daemonPid()) say('the running daemon picks this up with the next message');
      return;
    }
    case 'status': return status();
    case 'start': return start(rest);
    case 'stop': return stop();
    case 'run': return daemon();
    case 'send': {
      let file = '', words = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--file') { file = rest[++i] || ''; if (!file) fail('--file needs a path', 2); }
        else words.push(rest[i]);
      }
      const text = words.join(' ').trim();
      if (!text && !file) fail('usage: fleet-telegram send "<text>" [--file <path>]', 2);
      let sec; try { sec = secrets(true); } catch (e) { fail(e.message); }
      try {
        if (file) {
          const buf = fs.readFileSync(file);
          if (buf.length > 50 * 1024 * 1024) fail('that file is over the 50 MB a bot may send');
          const isPhoto = ['jpg', 'png'].includes(sniffImage(buf)) && buf.length <= 10 * 1024 * 1024;
          const form = new FormData();
          form.append('chat_id', sec.chat);
          if (text) form.append('caption', text.slice(0, 1024));
          form.append(isPhoto ? 'photo' : 'document', new Blob([buf]), path.basename(file));
          await api(sec.token, isPhoto ? 'sendPhoto' : 'sendDocument', form, { timeout: 120000 });
          log(`send: a ${isPhoto ? 'photo' : 'file'} of ${Math.round(buf.length / 1024)} KB`);
          return say(`sent ${isPhoto ? 'the photo' : 'the file'}${text ? ' with its caption' : ''}`);
        }
        const n = await sendText(sec.token, sec.chat, text);
        log(`send: ${text.length} chars in ${n} message${n === 1 ? '' : 's'}`);
        return say(`sent (${n} message${n === 1 ? '' : 's'})`);
      } catch (e) { fail(`not sent — ${e.message}`); }
      return;
    }
    case 'config': {
      const [what, ...vals] = rest;
      const c = config();
      if (!what) {
        say(`secret-cmd:     ${c.secret_cmd || '(not set)'}`);
        say(`transcribe-cmd: ${c.transcribe_cmd || '(not set)'}`);
        say(`allow:          ${allowList().join(' ')}${Array.isArray(c.allow) && c.allow.length ? '' : '  (the default)'}`);
        say(`link:           ${c.link ? `${c.link.project}/${c.link.session}` : '(not linked)'}`);
        return;
      }
      if (what === 'secret-cmd' || what === 'transcribe-cmd') {
        if (vals.length !== 1) fail(`usage: fleet-telegram config ${what} '<command>'  ('' clears it)`, 2);
        const key = what === 'secret-cmd' ? 'secret_cmd' : 'transcribe_cmd';
        // Tried BEFORE it is saved: a command that holds the token itself would otherwise
        // be written to config.json, which puts the token in a file — the thing this whole
        // design keeps it out of. Any other failure (a locked keychain) is saved with a
        // warning, since it may well work once the desk is unlocked.
        if (what === 'secret-cmd' && vals[0]) {
          for (const which of ['token', 'chat']) {
            try { secretOf(which, vals[0]); }
            catch (e) { if (/contains the/.test(e.message)) fail(`not saved — ${e.message}`); }
          }
        }
        if (vals[0]) c[key] = vals[0]; else delete c[key];
        saveConfig(c); cached = null;
        if (what === 'secret-cmd' && vals[0]) {
          try { secrets(true); say('secret command set — the token and the chat id both resolve'); }
          catch (e) { say(`secret command set, but: ${e.message}`); }
        } else say(`${what} ${vals[0] ? 'set' : 'cleared'}`);
        return;
      }
      if (what === 'allow' || what === 'disallow') {
        let list = allowList();
        if (what === 'allow' && vals[0] === '--reset') { delete c.allow; saveConfig(c); return say(`allowlist: ${allowList().join(' ')}  (the default)`); }
        const only = what === 'allow' && vals[0] === '--only';
        const pats = only ? vals.slice(1) : vals;
        if (!pats.length) fail(`usage: fleet-telegram config ${what} ${what === 'allow' ? '[--only] ' : ''}<tool-pattern>…   (a glob over tool names; <pattern>:scratch allows it for files under the session's scratch dir only)`, 2);
        for (const p of pats) if (!PATTERN.test(p)) fail(`'${p}' is not a tool pattern — letters, digits, _ - and the globs * ? [ ], optionally ending :scratch`, 2);
        if (only) list = [...new Set(pats)];
        else if (what === 'allow') list = [...new Set([...list, ...pats])];
        else list = list.filter((x) => !pats.includes(x));
        if (!list.length) fail('that would leave nothing allowed at all — a Telegram turn could not even read; use `allow --only Read` for the narrowest list', 2);
        c.allow = list; saveConfig(c);
        return say(`allowlist: ${list.join(' ')}`);
      }
      return fail(`unknown config key '${what}' — secret-cmd, transcribe-cmd, allow, disallow`, 2);
    }
    case undefined: case 'help': case '-h': case '--help':
      return say(`fleet-telegram — a Telegram chat connected to one fleet session

  fleet-telegram link <project>/<session>     which session the chat talks to (usually a master)
  fleet-telegram status                       link, guard, secrets, daemon, allowlist
  fleet-telegram start | stop                 run it as a ${serviceMode()} service, or stop it
  fleet-telegram send "<text>" [--file <path>]
  fleet-telegram config secret-cmd '<cmd>'    prints the token ($1=token) or chat id ($1=chat)
  fleet-telegram config transcribe-cmd '<cmd>'  turns $1 (an audio file) into words on stdout
  fleet-telegram config allow [--only|--reset] <tool-pattern>…   tools a Telegram turn may use
  fleet-telegram config disallow <tool-pattern>…

Setup: docs/TELEGRAM.md — https://github.com/PabloG55/ghostfleet/blob/main/docs/TELEGRAM.md`);
    default: fail(`unknown command '${cmd}' — fleet-telegram help`, 2);
  }
}

main(process.argv.slice(2)).catch((e) => fail(e.message));
