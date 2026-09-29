// lib/jarvis.mjs — what makes one fleet's master into Jarvis, the master of masters.
//
// Jarvis is an ordinary ghostfleet project (bin/fleet-jarvis init makes it: a tiny git repo
// outside any checkout, registered like any other) whose master has a contract of its own.
// Everything that treats that one session differently lives here, so the hook, the MCP
// dispatch, the phone's daemon and the CLI all ask the SAME questions of the SAME files:
//
//   which fleet is Jarvis       the marker, ~/.config/ghostfleet/jarvis
//   what did the owner say      the ledger, ~/.config/ghostfleet/jarvis.said
//   what is waiting for a yes   the proposals, ~/.config/ghostfleet/jarvis.confirm.json
//   can it hear                 whisper.cpp and a model, found or not
//
// THE CONFIRM-LIST IS ENFORCED HERE AND NOT ONLY IN THE PROMPT. A contract that says "ask
// before you merge" is a sentence a model can misread, forget under a long context, or talk
// itself past ("he clearly wanted this"). So the actions on the list are REFUSED at the tool
// until a yes exists that the model did not write:
//
//   1. Jarvis calls a listed tool. gate() refuses it and records a PROPOSAL — the exact call,
//      keyed on its arguments, and one line saying what it would do.
//   2. The owner says yes. Either he taps it on the phone (fleet-serve grants the proposal,
//      behind a fresh passkey), or he says/types it into Jarvis's session — which the event
//      hook sees as a UserPromptSubmit and appends to the ledger. A [fleet] line, a relayed
//      answer or a worker's reply is not the owner and never lands there.
//   3. Jarvis makes the same call again. gate() finds the proposal, finds a yes that came
//      AFTER it, consumes both, and lets exactly that call through.
//
// One yes buys one action. A yes that predates the question is not an answer to it — "merge
// it, I'm sure" in the original request is an instruction, and the confirm-list exists
// because instructions get misread. A proposal that sits unanswered expires.
//
// WHAT THIS DOES NOT CLAIM. Every file here is writable by any process running as the user,
// Jarvis's shell included, so this is a guard against the model acting on a misreading, not
// against a model working to defeat it. The Bash guard (hooks/jarvis-guard.sh) refuses the
// obvious ways of writing a yes for itself — typing into its own pane, touching these files,
// running the grant verb — and that is as far as a same-user check can honestly go.
//
// Node builtins only: this is on the import path of the MCP server and the daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';

const home = () => os.homedir();
export const cfgHome = () => path.join(home(), '.config', 'ghostfleet');
export const markerPath = () => path.join(cfgHome(), 'jarvis');
const saidPath = () => path.join(cfgHome(), 'jarvis.said');
const statePath = () => path.join(cfgHome(), 'jarvis.confirm.json');
export const defaultRepo = () => path.join(home(), '.local', 'share', 'ghostfleet', 'jarvis');

// How long a question stays answerable, and how long a yes stays usable. Ten minutes is a
// conversation; an hour-old "yes" is a word somebody said about something else.
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

// ── the marker ─────────────────────────────────────────────────────────────
// key=value lines rather than JSON so bin/ and hooks/ can read one field with grep+cut and
// no parser — the event hook runs on every event of every session and must stay cheap.
export function readMarker() {
  let txt = '';
  try { txt = fs.readFileSync(markerPath(), 'utf8'); } catch { return null; }
  const m = {};
  for (const line of txt.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!m.name || !m.sock || !m.cfg || !m.path) return null;
  m.profile = m.profile || 'work';
  m.dir = path.join(m.cfg, 'fleet');
  m.batch = Number(m.batch) > 0 ? Number(m.batch) : 0;
  m.restart_hour = /^\d{1,2}$/.test(m.restart_hour || '') ? Number(m.restart_hour) : 4;
  return m;
}
export function writeMarker(m) {
  fs.mkdirSync(cfgHome(), { recursive: true });
  const keys = ['name', 'profile', 'sock', 'cfg', 'path', 'batch', 'restart_hour'];
  const body = keys.filter(k => m[k] !== undefined && m[k] !== '').map(k => `${k}=${m[k]}`).join('\n') + '\n';
  atomicWrite(markerPath(), body);
}
// `me` is mcp/fleet-dispatch.mjs's self(): {sock, sess} from the LIVE $TMUX, which a stale
// environment cannot fake. Only the master is Jarvis; a worker Jarvis spawned is a worker.
export function isJarvisSelf(me, m = readMarker()) {
  return !!(me && m && me.sock === m.sock && me.sess === 'master');
}

function atomicWrite(file, body) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── the owner's ledger ─────────────────────────────────────────────────────
// Written by the event hook, for Jarvis's master only, on every UserPromptSubmit that is not
// the machine talking. ms timestamps: a proposal and the answer to it are compared with a
// strict `>`, and seconds would make "asked" and "answered" the same instant often enough
// to matter.
export function isMachinePrompt(text) {
  const t = String(text || '').trimStart();
  // [fleet] is every nudge, relay and reply-to preamble this repo sends; <…> is Claude
  // Code's own injected turns (<task-notification>, <local-command-…>).
  return !t || t.startsWith('[fleet]') || t.startsWith('<');
}
export function recordSaid(text, src = 'owner', now = Date.now()) {
  if (isMachinePrompt(text)) return false;
  const row = JSON.stringify({ ts: now, src, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 400) });
  fs.mkdirSync(cfgHome(), { recursive: true });
  fs.appendFileSync(saidPath(), row + '\n', { mode: 0o600 });
  // Bounded: the ledger answers "did he just say yes", and a year of it answers nothing.
  try {
    const lines = fs.readFileSync(saidPath(), 'utf8').split('\n').filter(Boolean);
    if (lines.length > 400) atomicWrite(saidPath(), lines.slice(-200).join('\n') + '\n');
  } catch {}
  return true;
}
// WHAT THE FLEET TYPED, SO IT IS NOT MISTAKEN FOR HIM. Text starting "[fleet]" was the first
// filter and it is not enough: a plain `fleet-send master "ok"` — from a worker, from another
// lead, from Jarvis's own MCP call — pastes exactly those two letters, and "ok" is a yes. So
// bin/fleet-send writes a line here for every prompt it delivers into Jarvis's master (the
// moment it pastes, which is also when a queued one finally goes in), and the ledger skips a
// prompt that one of those accounts for. What is left is what a human actually typed at the
// desk. The phone's own words are recorded by fleet-serve, which knows the client that sent
// them, and are delivered by fleet-send — so they are never counted twice.
//   Matched by digest where it can be, and CONSERVATIVELY where it cannot: a delivery in
// the last half minute that the digest does not match still counts as "the fleet typed
// this". The cost of that is a genuine desk yes, typed in the same seconds as a delivery,
// being ignored and asked for again; the other way round is a worker approving a merge.
const deliveredPath = () => path.join(cfgHome(), 'jarvis.delivered');
const digest12 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 12);
export function consumeDelivery(text, nowSec = Math.floor(Date.now() / 1000)) {
  let lines = [];
  try { lines = fs.readFileSync(deliveredPath(), 'utf8').split('\n').filter(Boolean); } catch { return false; }
  const rows = lines.map(l => { const [t, d] = l.split('\t'); return { t: Number(t) || 0, d: d || '' }; });
  const fresh = rows.filter(r => nowSec - r.t <= 30);
  if (!fresh.length) { if (rows.length) try { fs.writeFileSync(deliveredPath(), ''); } catch {} return false; }
  const want = new Set([digest12(text), digest12(String(text).trim())]);
  const hit = fresh.find(r => want.has(r.d)) || fresh[0];
  const keep = rows.filter(r => r !== hit && nowSec - r.t <= 30);
  try { fs.writeFileSync(deliveredPath(), keep.map(r => `${r.t}\t${r.d}`).join('\n') + (keep.length ? '\n' : '')); } catch {}
  return true;
}
export function readSaid() {
  let lines = [];
  try { lines = fs.readFileSync(saidPath(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (Number.isFinite(o.ts)) out.push(o); } catch {} }
  return out.sort((a, b) => a.ts - b.ts);
}

// A yes, said plainly. Conservative on purpose: "yes but not the second one" contains a
// negation and is not a yes to anything; "sure, after lunch" is long enough to be a
// sentence about something else. A spoken turn arrives prefixed "(spoken)" (see the phone
// client) and the prefix is not part of the answer.
const AFFIRM = /^(?:yes|yeah|yep|yup|yes please|sure|ok|okay|do it|go|go ahead|go for it|confirm|confirmed|approve|approved|allow|allow it|ship it|y)\b[\s.!,]*(?:please|do it|go ahead|thanks|thank you)?[\s.!]*$/i;
const NEGATION = /\b(no|not|don'?t|wait|stop|cancel|hold|never|later)\b/i;
// A SPOKEN yes needs two words. A microphone left open hears a door, a cough or a breath,
// and whisper's commonest transcription of a short noise is exactly "Okay." or "Yes." — so a
// single spoken word is what noise sounds like, and it approves nothing. "yes, do it" and
// "go ahead" do. Typed, one word is deliberate and is enough.
export function isAffirmative(text) {
  const raw = String(text || '');
  const spoken = /^\(spoken\)\s*/i.test(raw);
  const t = raw.replace(/^\(spoken\)\s*/i, '').trim();
  if (!(t.length > 0 && t.length <= 60 && AFFIRM.test(t) && !NEGATION.test(t))) return false;
  return !spoken || t.split(/[\s,.!]+/).filter(Boolean).length >= 2;
}

// ── proposals ──────────────────────────────────────────────────────────────
// ONE WRITER AT A TIME. The proposals are read, changed and written back by three separate
// processes — the MCP server, the Bash guard's gate-bash, and fleet-serve's tap — and Claude
// Code runs tool calls in parallel. Unlocked, two spawns could both read "none yet, this one
// is free", or two retries both spend the same yes. A lock file, taken exclusively, with the
// same stale-lock rule fleet-serve's audit log uses: a lock nobody released for five seconds
// belongs to a process that died.
function withStateLock(fn) {
  const lock = statePath() + '.lock';
  fs.mkdirSync(cfgHome(), { recursive: true });
  for (let i = 0; i < 300; i++) {
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
      const until = Date.now() + 10; while (Date.now() < until);
      continue;
    }
    try { return fn(); } finally { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch {} }
  }
  return fn();
}
function loadState() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch {}
  if (!s || typeof s !== 'object') s = {};
  s.proposals = Array.isArray(s.proposals) ? s.proposals : [];
  s.consumed = Array.isArray(s.consumed) ? s.consumed : [];
  s.spawn = s.spawn && typeof s.spawn === 'object' ? s.spawn : { after: 0, n: 0 };
  return s;
}
function saveState(s, now) {
  // Answered and expired proposals are kept for an hour so /api/jarvis can say what just
  // happened, and then dropped.
  s.proposals = s.proposals.filter(p => now - p.ts < 60 * 60 * 1000).slice(-50);
  s.consumed = s.consumed.filter(ts => now - ts < 60 * 60 * 1000);
  fs.mkdirSync(cfgHome(), { recursive: true });
  atomicWrite(statePath(), JSON.stringify(s, null, 1) + '\n');
}
const openProp = (p, now) => !p.used && !p.denied && now - p.ts <= CONFIRM_TTL_MS;
export function pending(now = Date.now()) {
  return loadState().proposals.filter(p => openProp(p, now))
    .map(({ id, tool, summary, ts, granted }) => ({ id, tool, summary, ts, granted: granted ? granted.by : null }));
}
function newId() {
  const A = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(crypto.randomBytes(4)).map(b => A[b % A.length]).join('');
}

// THE GATE. `key` identifies the exact call; `summary` is the one line the owner hears;
// `spawnLike` means the FIRST of these per owner request is free — "spawn more than one
// worker per request" is what the list names, so one is ordinary work and two is a question.
export function gate(spec, now = Date.now()) { return withStateLock(() => gateLocked(spec, now)); }
function gateLocked({ key, tool, summary, spawnLike = false }, now) {
  const s = loadState();
  const said = readSaid();
  let p = s.proposals.find(x => x.key === key && openProp(x, now));
  // A REQUEST is the last thing he asked for — and "yes" is an answer, not a request, so it
  // does not reset the one free worker. Checked only when this exact call is not already a
  // question waiting on him: a spawn he said yes to is answered by the proposal, below.
  if (spawnLike && !p) {
    const asks = said.filter(x => !isAffirmative(x.text));
    const lastOwner = asks.length ? asks[asks.length - 1].ts : 0;
    if (s.spawn.after !== lastOwner) s.spawn = { after: lastOwner, n: 0 };
    if (s.spawn.n === 0) { s.spawn.n = 1; saveState(s, now); return { ok: true, why: 'the first worker for this request needs no yes' }; }
  }
  if (p) {
    let by = p.granted ? p.granted.by : '';
    if (!by) {
      // The newest yes after the question, still fresh and not already spent — and only if
      // no OTHER question was asked between this one and that yes: a yes answers the last
      // thing he was asked, not everything outstanding.
      const yes = said.filter(x => x.ts > p.ts && now - x.ts <= CONFIRM_TTL_MS
                                   && isAffirmative(x.text) && !s.consumed.includes(x.ts)).pop();
      const later = yes && s.proposals.some(o => o !== p && openProp(o, now) && !o.granted && o.ts > p.ts && o.ts < yes.ts);
      if (yes && !later) { by = yes.src || 'owner'; s.consumed.push(yes.ts); p.granted = { by, ts: yes.ts }; }
    }
    if (by) {
      p.used = true; p.usedAt = now;
      if (spawnLike) s.spawn.n++;
      saveState(s, now);
      return { ok: true, id: p.id, by };
    }
    saveState(s, now);
    return { ok: false, id: p.id, text: refusal(tool, p, true) };
  }
  p = { id: newId(), key, tool, summary, ts: now, granted: null, used: false, denied: false };
  s.proposals.push(p);
  saveState(s, now);
  return { ok: false, id: p.id, text: refusal(tool, p, false) };
}
function refusal(tool, p, again) {
  return `${tool} is on Jarvis's confirm-list and needs the owner's explicit yes first — refused, nothing ran. ` +
    (again ? `Still waiting on proposal ${p.id} ("${p.summary}"): no yes has arrived since you asked. `
           : `Recorded as proposal ${p.id}. `) +
    `Ask him in ONE short line — "${p.summary}?" — and end your turn. After he says yes (spoken or typed) or taps yes on the phone, make exactly this call again. One yes buys one action; it expires in ${CONFIRM_TTL_MS / 60000} minutes.`;
}
export function answer(id, yes, by = 'phone', now = Date.now()) { return withStateLock(() => answerLocked(id, yes, by, now)); }
function answerLocked(id, yes, by, now) {
  const s = loadState();
  const p = s.proposals.find(x => x.id === id && openProp(x, now));
  if (!p) return { ok: false, text: `no open proposal '${id}' — it was answered, used or expired` };
  if (yes) p.granted = { by, ts: now }; else p.denied = true;
  saveState(s, now);
  return { ok: true, id, summary: p.summary, tool: p.tool };
}

// ── what is on the list ────────────────────────────────────────────────────
// For an MCP call: null = not listed, run it. The summary is written for a person hearing it
// read aloud, so it names the project and the session rather than the argument names.
export function mcpConfirmSpec(tool, a = {}, m = null) {
  const where = (x) => `${a.project ? a.project + '/' : ''}${x}`;
  const key = `${tool}:${JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]]))}`;
  // JARVIS'S OWN INPUT BOX IS NOT A TARGET, whatever he says: a prompt pasted there is how a
  // yes would be forged, and a keystroke there answers its own permission prompt. Refused
  // outright, with no proposal to answer — the same rule the Bash guard applies to
  // `fleet-send master`.
  const own = String(a.session) === 'master' && (!a.project || (m && (a.project === m.name || a.project === m.sock)));
  if ((tool === 'fleet_send' || tool === 'fleet_answer') && own)
    return { refuse: true, tool, summary: 'type into your own session', text: `${tool}: refused — that is your own session. Jarvis never types into itself; a yes has to come from the owner.` };
  switch (tool) {
    case 'fleet_stop':
      return { key, tool, summary: `stop ${where(a.session)}${a.reclaim ? ' and remove its worktree' : ''}${a.force ? ', FORCED — that deletes uncommitted work' : ''}` };
    case 'fleet_worktree_remove':
      return { key, tool, summary: `remove the worktree ${path.basename(String(a.path || ''))}${a.project ? ' in ' + a.project : ''}${a.force ? ', FORCED — that deletes uncommitted work' : ''}` };
    case 'fleet_project_remove':
      return { key, tool, summary: `unregister the project ${a.name}` };
    case 'fleet_answer':
      return { key, tool, summary: `answer ${where(a.session)}'s prompt with "${String(a.text).slice(0, 40)}"` };
    case 'fleet_spawn':
      return { key, tool, spawnLike: true, summary: `start another worker, ${a.name}${a.project ? ' in ' + a.project : ''}` };
    // A companion is a second session — a worker by any other name, as far as the budget
    // and the "one per request" rule are concerned.
    case 'fleet_companion':
      return { key, tool, spawnLike: true, summary: `start a companion session${a.session ? ' beside ' + where(a.session) : ''}` };
    default: return null;
  }
}

// For a Bash command Jarvis is about to run. Three answers: `refuse` (never, whatever he
// says — these are the ways a yes could be forged), `confirm` (on the list), `ok`.
const BASH_LIST = [
  [/\bgh\s+pr\s+merge\b/, 'merge a pull request'],
  // The API's own merge endpoint is a merge too, and the one a model reaches for when the
  // porcelain is refused.
  [/\bgh\s+api\b.*\/merge\b/, 'merge a pull request'],
  // Only global flags may sit between git and push: `git log --grep push` is a read.
  [/\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*push\b/, 'push to a remote'],
  [/\bgit\s+worktree\s+remove\b/, 'remove a git worktree'],
  [/\bfleet-stop\b/, 'stop a session'],
  [/\bfleet-clean\b.*--go\b/, 'remove worktrees'],
  [/\bfleet-project\s+(?:rm|remove)\b/, 'unregister a project'],
  [/\bfleet-answer\b/, "answer a session's prompt"],
];
// tmux's verbs for putting keystrokes into a pane, and their short aliases.
const TMUX_TYPE = /\btmux\b.*\b(?:send-keys|send|paste-buffer|pasteb)\b/;
// EACH COMMAND OF A LINE, NOT THE LINE. `cd ~ && tmux send-keys -t master yes` is two
// commands, and a check that stops at the first separator reads only the harmless one.
export function bashSegments(cmd) {
  return String(cmd || '').split(/&&|\|\||;|\||\n/).map(x => x.trim()).filter(Boolean);
}
export function bashSpec(cmd, m = readMarker()) {
  const c = String(cmd || '').trim();
  const segs = bashSegments(c);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jsock = m ? new RegExp(`-[Ls]\\s*${esc(m.sock)}\\b`) : null;
  for (const seg of segs) {
    // The confirmation state and the marker are off limits entirely: a yes written there by
    // anything but the owner is a forgery, and deleting the marker switches every gate off.
    if (/\.config\/ghostfleet\b/.test(seg) || /\bjarvis\.(?:said|confirm|delivered)\b/.test(seg))
      return { action: 'refuse', why: "refused: that touches ghostfleet's own config, where the owner's confirmations live. Use the fleet_* tools to read the fleet." };
    if (/\bfleet-jarvis\s+(?:grant|deny|said|answer)\b/.test(seg))
      return { action: 'refuse', why: 'refused: only the owner answers a proposal. Ask him, and end your turn.' };
    if (jsock && jsock.test(seg))
      return { action: 'refuse', why: "refused: that addresses Jarvis's own fleet — a yes has to come from the owner, not from its own pane." };
    if (/\bfleet-send\b/.test(seg) && !/\s-s\s/.test(seg) && /\bmaster\b/.test(seg))
      return { action: 'refuse', why: 'refused: that would type into your own session. A yes has to come from the owner.' };
    if (TMUX_TYPE.test(seg) && !/\s-L\s*\S/.test(seg))
      return { action: 'refuse', why: 'refused: that would type into your own session. A yes has to come from the owner.' };
  }
  for (const seg of segs) {
    if (/\bfleet-spawn\b/.test(seg) || /\bfleet-companion\b/.test(seg))
      return { action: 'confirm', key: `bash:${c}`, tool: 'fleet-spawn', spawnLike: true, summary: `start another worker (${seg.slice(0, 80)})` };
    if (TMUX_TYPE.test(seg))
      return { action: 'confirm', key: `bash:${c}`, tool: 'Bash', summary: `type into another session's pane: ${seg.slice(0, 80)}` };
    for (const [re, what] of BASH_LIST) if (re.test(seg))
      return { action: 'confirm', key: `bash:${c}`, tool: 'Bash', summary: `${what}: ${seg.slice(0, 90)}` };
  }
  return { action: 'ok' };
}

// ── hearing ────────────────────────────────────────────────────────────────
// whisper.cpp on this machine, and nothing else: the audio never leaves it. Found, not
// configured — Homebrew's formula installs `whisper-cli`, and a daemon started by launchd
// does not have /opt/homebrew/bin on its PATH, so the usual places are asked by name.
export const MODEL_DIR = () => path.join(home(), '.local', 'share', 'whisper');
function which(bin) {
  try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}
const isExec = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
export function whisperBin() {
  if (process.env.CLAUDE_FLEET_WHISPER_BIN) return isExec(process.env.CLAUDE_FLEET_WHISPER_BIN) ? process.env.CLAUDE_FLEET_WHISPER_BIN : '';
  for (const b of ['whisper-cli', 'whisper-cpp']) { const w = which(b); if (w) return w; }
  for (const f of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', path.join(MODEL_DIR(), 'whisper-cli')])
    if (isExec(f)) return f;
  return '';
}
// The best model present, by a fixed preference: turbo is fast enough on Apple silicon to be
// the one worth having; the English-only small and base models are the lighter downloads.
const PREFER = ['large-v3-turbo', 'small.en', 'base.en', 'small', 'base', 'medium', 'large'];
export function whisperModel() {
  if (process.env.CLAUDE_FLEET_WHISPER_MODEL) { try { return fs.statSync(process.env.CLAUDE_FLEET_WHISPER_MODEL).isFile() ? process.env.CLAUDE_FLEET_WHISPER_MODEL : ''; } catch { return ''; } }
  let names = [];
  try { names = fs.readdirSync(MODEL_DIR()).filter(n => /^ggml-.*\.bin$/.test(n)); } catch { return ''; }
  names.sort((a, b) => {
    const r = (n) => { const i = PREFER.findIndex(p => n.includes(p)); return i < 0 ? PREFER.length : i; };
    return r(a) - r(b) || a.localeCompare(b);
  });
  return names.length ? path.join(MODEL_DIR(), names[0]) : '';
}
export const VOICE_HOWTO = 'fleet-jarvis voice --install   (whisper.cpp from Homebrew and one model, ~550 MB; audio is transcribed on this Mac and never leaves it)';
// CACHED FOR A MINUTE, because /api/jarvis asks on every poll of the phone and whisperBin()
// spawns a shell per candidate — a daemon must not fork twice a second to learn that nothing
// was installed in the last five. The environment is part of the key, so a test (or a daemon
// started with an explicit binary) is never answered from another configuration's cache.
let voiceCache = { at: 0, key: '', v: null };
export function voiceStatus() {
  const k = `${process.env.CLAUDE_FLEET_WHISPER_BIN || ''}|${process.env.CLAUDE_FLEET_WHISPER_MODEL || ''}|${home()}`;
  if (voiceCache.v && voiceCache.key === k && Date.now() - voiceCache.at < 60000) return voiceCache.v;
  const v = voiceStatusNow();
  voiceCache = { at: Date.now(), key: k, v };
  return v;
}
function voiceStatusNow() {
  const bin = whisperBin(), model = whisperModel();
  // `why` is short because a phone shows it in a toast; `how` is the whole instruction.
  if (!bin) return { ready: false, why: 'no whisper.cpp on the Mac — run: fleet-jarvis voice --install', how: VOICE_HOWTO };
  if (!model) return { ready: false, why: `whisper.cpp has no model in ${MODEL_DIR()} — run: fleet-jarvis voice --install`, how: VOICE_HOWTO };
  return { ready: true, bin, model: path.basename(model) };
}
export function isWav(buf) {
  return Buffer.isBuffer(buf) && buf.length > 44 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE';
}
// Returns {text} or {error}. The audio is written to a private temp dir that is removed
// before this returns, whatever happens — nothing spoken is kept. ASYNC, because the caller
// that matters is fleet-serve: a second of execFileSync there is a second in which the
// daemon cannot answer anything, /api/health included.
function prepare(wav, prompt, lang) {
  const v = voiceStatus();
  if (!v.ready) return { error: v.why };
  if (!isWav(wav)) return { error: 'that is not a WAV file (RIFF/WAVE) — the client sends 16 kHz mono PCM' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-hear-'));
  fs.chmodSync(dir, 0o700);
  const inp = path.join(dir, 'in.wav'), out = path.join(dir, 'out');
  fs.writeFileSync(inp, wav, { mode: 0o600 });
  const args = ['-m', whisperModel(), '-f', inp, '-nt', '-np', '-otxt', '-of', out, '-l', lang];
  if (prompt) args.push('--prompt', prompt.slice(0, 400));
  return { bin: v.bin, args, dir, out };
}
function finish(p, err) {
  try {
    if (err) return { error: `whisper failed: ${String(err.stderr || err.message || '').split('\n').filter(Boolean).pop() || 'no output'}`.slice(0, 240) };
    let text = '';
    try { text = fs.readFileSync(p.out + '.txt', 'utf8'); } catch { return { error: 'whisper wrote no transcript' }; }
    // whisper's own words for "nothing was said" are not something to send to Jarvis.
    text = text.replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((?:silence|music|noise)\)/gi, ' ').replace(/\s+/g, ' ').trim();
    return { text };
  } finally { try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch {} }
}
const LANG = () => process.env.CLAUDE_FLEET_WHISPER_LANG || 'en';
export function transcribe(wav, { prompt = '', lang = LANG(), timeout = 60000 } = {}) {
  const p = prepare(wav, prompt, lang);
  if (p.error) return p;
  let err = null;
  try { execFileSync(p.bin, p.args, { stdio: ['ignore', 'ignore', 'pipe'], timeout }); } catch (e) { err = e; }
  return finish(p, err);
}
export function transcribeAsync(wav, { prompt = '', lang = LANG(), timeout = 60000 } = {}) {
  let p;
  try { p = prepare(wav, prompt, lang); } catch (e) { return Promise.resolve({ error: e.message }); }
  if (p.error) return Promise.resolve(p);
  return new Promise((resolve) => {
    execFile(p.bin, p.args, { timeout, encoding: 'utf8' }, (err, _o, stderr) => resolve(finish(p, err ? Object.assign(err, { stderr }) : null)));
  });
}
