// lib/speech.mjs — the phone's voice, synthesised on this machine with Kokoro.
//
// The phone used to read replies with the browser's speechSynthesis, which on iOS means
// the device's own voices: passable English, and Spanish that a Spanish speaker notices.
// Kokoro is an 82M-parameter TTS model run by onnxruntime, so this machine can do far
// better in both languages and the audio never leaves it.
//
// OPTIONAL, AND FOUND RATHER THAN CONFIGURED. Nothing here is a dependency: a machine
// without Kokoro answers 503 from /api/speak and the phone falls back to speechSynthesis,
// which is exactly what it did before this file existed. docs/mobile.md has the setup.
//
//   where                  $CLAUDE_FLEET_KOKORO_DIR, else ~/.local/share/kokoro
//   what it must hold      kokoro-v1.0.onnx, voices-v1.0.bin, venv/bin/python
//   switched off           CLAUDE_FLEET_KOKORO=off
//
// THE UNIT IS THE SENTENCE, for two reasons that are the same reason. Language is chosen
// per sentence, because the owner writes in English and Spanish inside one message and a
// single voice for the whole reply reads half of it in the wrong accent. And latency is
// per sentence: the phone plays the first one while the rest are still being made, so the
// wait before speech starts is one sentence's synthesis, not the whole reply's.
//
// Node builtins only: this is on the import path of the daemon.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'kokoro-worker.py');

export const kokoroDir = () => process.env.CLAUDE_FLEET_KOKORO_DIR || path.join(os.homedir(), '.local', 'share', 'kokoro');
const cacheDir = () => process.env.CLAUDE_FLEET_SPEECH_CACHE || path.join(os.homedir(), '.cache', 'ghostfleet', 'speech');
const files = (d = kokoroDir()) => ({
  model: path.join(d, 'kokoro-v1.0.onnx'),
  voices: path.join(d, 'voices-v1.0.bin'),
  // The venv's own interpreter, never the system one: onnxruntime ships wheels for a
  // narrower range of Pythons than a current macOS has, which is why the setup pins 3.12.
  python: process.env.CLAUDE_FLEET_KOKORO_PYTHON || path.join(d, 'venv', 'bin', 'python'),
});
// One voice per language, from Kokoro's own set. `lang` is the espeak code Kokoro
// phonemises with — the half that makes "Listo" sound like a word and not an acronym.
export const VOICES = {
  en: { voice: process.env.CLAUDE_FLEET_KOKORO_VOICE_EN || 'af_heart', lang: 'en-us' },
  es: { voice: process.env.CLAUDE_FLEET_KOKORO_VOICE_ES || 'ef_dora', lang: 'es' },
};
const SPEED = 1.05;

// ── can it speak ────────────────────────────────────────────────────────────
// A worker that died at startup is remembered for a minute, so a broken venv costs one
// failed spawn per minute rather than one per sentence — and the reason is what the 503
// says, so the phone's fallback is explained rather than silent.
let broken = { at: 0, why: '' };
export function status() {
  if (/^(off|0|no|false)$/i.test(process.env.CLAUDE_FLEET_KOKORO || '')) return { ready: false, why: 'Kokoro is switched off (CLAUDE_FLEET_KOKORO=off)' };
  const d = kokoroDir(), f = files(d);
  const missing = ['model', 'voices', 'python'].filter(k => { try { return !fs.statSync(f[k]).isFile(); } catch { return true; } });
  if (missing.length) return { ready: false, why: `no Kokoro in ${d} (missing ${missing.map(k => path.basename(f[k])).join(', ')}) — see docs/mobile.md` };
  if (broken.why && Date.now() - broken.at < 60000) return { ready: false, why: broken.why };
  return { ready: true, dir: d };
}

// ── what is said, and in which language ─────────────────────────────────────
// Split on sentence ends and on line breaks. A line break is a sentence end in a chat
// reply — a list item has no full stop, and reading two of them as one run-on sentence is
// how a bulleted reply comes out as a single breathless clause.
const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Sr|Sra|approx|p\.ej)\.)$/i;
export function sentences(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    let buf = '';
    for (const piece of line.split(/(?<=[.!?…])\s+/)) {
      buf = buf ? `${buf} ${piece}` : piece;
      if (!ABBREV.test(buf)) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
  }
  // A long sentence is split at a comma or semicolon near the middle: one 600-character
  // sentence is several seconds of synthesis before anything plays.
  const res = [];
  for (let s of out.map(x => x.trim()).filter(x => /[\p{L}\p{N}]/u.test(x))) {
    while (s.length > 260) {
      const cut = Math.max(s.lastIndexOf(', ', 220), s.lastIndexOf('; ', 220));
      if (cut < 80) break;
      res.push(s.slice(0, cut + 1)); s = s.slice(cut + 2);
    }
    res.push(s);
  }
  return res;
}
// Function words, not content words: they are what every sentence has, and the two lists
// barely overlap. The ones both languages share — "no", "a", "me", "he", "son" — are on
// neither list, because a word that votes for both decides nothing.
const ES = new Set(('el la los las de del que y en un una unos unas por para con es está están esta este '
  + 'esto eso ese estos estas son ser fue era hay pero como más muy ya también porque cuando donde lo le les '
  + 'su sus mi mis tu tus nos se sí si al sin sobre entre hasta desde todo todos nada algo bien gracias hola '
  + 'listo hecho ahora hoy mañana ayer tengo tienes tiene puedo puedes quiero voy vamos hacer hace dice así '
  + 'aquí cosa cosas otra otro mismo cada después antes siempre nunca qué cómo dónde cuál quién estoy estás').split(' '));
const EN = new Set(('the and to of you your is are was were be been it its on for with have has had this '
  + 'that these those what which who will would can could should do does did not but or if then than there '
  + 'their they we our i my an in at by from as so just all some any about into out up done here now today '
  + 'tomorrow yes okay please thanks need want get got make made run build test tests file branch merged '
  + 'it\'s i\'m don\'t that\'s there\'s').split(' '));
export function langOf(text, prev = 'en') {
  const t = String(text || '').toLowerCase();
  let es = 0, en = 0;
  // Written Spanish carries its own marks; English has none of these.
  es += 2 * (t.match(/[ñ¿¡]/g) || []).length + (t.match(/[áéíóú]/g) || []).length;
  for (const w of t.match(/[\p{L}']+/gu) || []) { if (ES.has(w)) es++; else if (EN.has(w)) en++; }
  // A tie — "OK.", "acme-api", "#42 merged" with one word each way — keeps the language
  // the reply was already in, so a fragment does not switch voices mid-paragraph.
  return es > en ? 'es' : en > es ? 'en' : prev;
}
// The cache key is everything that changes the audio: the text, the voice, the speed. A
// changed voice must not replay last week's file.
export function idFor(text, v) { return crypto.createHash('sha256').update(`${v.voice}\x1f${v.lang}\x1f${SPEED}\x1f${text}`).digest('hex').slice(0, 32); }
export function plan(text) {
  let prev = langOf(text);
  return sentences(text).map(s => {
    const lang = prev = langOf(s, prev);
    const v = VOICES[lang];
    return { id: idFor(s, v), text: s, lang, voice: v.voice, code: v.lang };
  });
}

// ── the worker, the queue and the cache ─────────────────────────────────────
// Ids the phone has been told about, so GET /api/speak/<id> can make a file it has not
// made yet. Bounded: a long-running daemon must not hold every sentence ever spoken.
const known = new Map();
function remember(it) { known.delete(it.id); known.set(it.id, it); if (known.size > 600) known.delete(known.keys().next().value); }
const wavPath = (id) => path.join(cacheDir(), `${id}.wav`);
export const validId = (id) => /^[0-9a-f]{32}$/.test(String(id || ''));
export function cached(id) { try { return fs.statSync(wavPath(id)).isFile() ? wavPath(id) : ''; } catch { return ''; } }

let W = null;            // { proc, ready: Promise, cur: job|null, buf }
let idleTimer = null;
const queue = [];        // jobs waiting: { it, prio, waiters: [{resolve, reject}] }
const running = new Map();   // id -> job, the queued and the one in flight
const IDLE_MS = 10 * 60 * 1000;
let writes = 0;

function startWorker() {
  const f = files();
  const proc = spawn(f.python, [WORKER, f.model, f.voices], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, cur: null, buf: '', err: '' };
  w.ready = new Promise((resolve, reject) => { w.onReady = resolve; w.onFail = reject; });
  proc.stdout.on('data', (d) => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { w.isReady = true; w.onReady(); continue; }
      const job = w.cur; w.cur = null;
      if (job && m.id === job.it.id) finish(job, m);
      pump();
    }
  });
  proc.stderr.on('data', (d) => { w.err = (w.err + d).slice(-2000); });
  const died = (why) => {
    if (W === w) W = null;
    // Before ready, the venv or the model is what is wrong: remember it and say it.
    w.onFail(new Error(why));
    if (w.cur) { const job = w.cur; w.cur = null; finish(job, { ok: false, error: why }); }
    pump();
  };
  proc.on('error', (e) => died(`Kokoro would not start: ${e.message}`));
  proc.on('exit', (code, sig) => died(`Kokoro exited (${sig || code}): ${(w.err.trim().split('\n').pop() || 'no output').slice(0, 200)}`));
  w.ready.catch((e) => { broken = { at: Date.now(), why: e.message }; });
  return w;
}
function finish(job, m) {
  running.delete(job.it.id);
  if (m.ok) {
    if (++writes % 50 === 0) prune();
    for (const x of job.waiters) x.resolve({ path: wavPath(job.it.id), ms: m.ms, cached: false });
  } else {
    for (const x of job.waiters) x.reject(new Error(m.error || 'synthesis failed'));
  }
  job.done = true;
  if (job.log) job.log(job, m);
}
function pump() {
  clearTimeout(idleTimer);
  if (!queue.length) {
    if (W && !W.cur) idleTimer = setTimeout(() => { try { W && W.proc.stdin.end(); } catch {} }, IDLE_MS);
    return;
  }
  if (!W) {
    const w = W = startWorker();
    // Started and failed before saying ready: everything queued fails with the reason.
    w.ready.then(() => pump(), () => { for (const job of queue.splice(0)) finish(job, { ok: false, error: broken.why || 'Kokoro would not start' }); });
    return;
  }
  if (!W.isReady || W.cur) return;
  // The highest priority first, then oldest: a sentence the phone is WAITING on goes ahead
  // of ones fetched in advance.
  queue.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
  const job = queue.shift();
  if (cached(job.it.id)) { finish(job, { ok: true, ms: 0, cached: true }); return pump(); }
  W.cur = job;
  try { fs.mkdirSync(cacheDir(), { recursive: true }); } catch {}
  W.proc.stdin.write(JSON.stringify({ id: job.it.id, text: job.it.text, voice: job.it.voice, lang: job.it.code, speed: SPEED, out: wavPath(job.it.id) }) + '\n');
}
let seq = 0;
function enqueue(it, prio, log) {
  let job = running.get(it.id);
  if (job) { job.prio = Math.max(job.prio, prio); return job; }
  job = { it, prio, seq: ++seq, waiters: [], log };
  running.set(it.id, job); queue.push(job);
  pump();
  return job;
}

// A NEW REQUEST SUPERSEDES WHAT THE LAST ONE FETCHED IN ADVANCE. Tap play on one message,
// then on another, and the first one's remaining sentences are no longer wanted; leaving
// them queued would make the second wait behind audio nobody will hear. Only advance work
// goes: a sentence somebody is waiting on keeps its place.
export function prefetch(items, log) {
  const want = new Set(items.map(i => i.id));
  for (let i = queue.length - 1; i >= 0; i--) {
    const j = queue[i];
    if (j.prio === 0 && !j.waiters.length && !want.has(j.it.id)) { queue.splice(i, 1); running.delete(j.it.id); }
  }
  for (const it of items) { remember(it); if (!cached(it.id)) enqueue(it, 0, log); }
}
// The audio for one sentence: the cached file, or made now at the front of the queue.
export function audio(id, log) {
  const hit = cached(id);
  if (hit) { const it = known.get(id); if (log && it) log({ it }, { ok: true, ms: 0, cached: true }); return Promise.resolve({ path: hit, ms: 0, cached: true }); }
  const it = known.get(id);
  if (!it) return null;
  if (!status().ready) return Promise.reject(new Error(status().why));
  return new Promise((resolve, reject) => {
    const job = enqueue(it, 1, log);
    job.prio = 1;
    job.waiters.push({ resolve, reject });
    pump();
  });
}
// The cache is bounded by count, oldest first: a sentence replayed this week is worth
// keeping, one from a month ago is not, and the files are small enough that the count is
// the only limit that matters.
function prune(keep = Number(process.env.CLAUDE_FLEET_SPEECH_KEEP) || 500) {
  try {
    const d = cacheDir();
    const fs_ = fs.readdirSync(d).filter(f => f.endsWith('.wav')).map(f => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs }));
    if (fs_.length <= keep) return;
    fs_.sort((a, b) => b.t - a.t);
    for (const x of fs_.slice(keep)) fs.rmSync(path.join(d, x.f), { force: true });
  } catch {}
}
