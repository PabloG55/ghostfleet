// server/piper.mjs — more Spanish voices than Kokoro's three, from Piper, downloaded on demand.
// Nothing here is needed until someone downloads a voice: the first download also installs the
// runtime (a venv with piper-tts, ~170 MB). Voices live on this machine and are shared by
// everyone; which one answers is each browser's choice (see server/voice.mjs).
//   Only the voices in CATALOG can be installed, and each file is checked against the size and
// md5 published in the catalog of rhasspy/piper-voices before it takes its final name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n/index.js';

const run = promisify(execFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'piper-worker.py');
const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const RUNTIME = 'piper-tts==1.8.0';
const IDLE_MS = 5 * 60 * 1000;
const KEEP = 300;

const dir = () => process.env.GFW_PIPER_DIR || path.join(os.homedir(), '.local', 'share', 'piper');
const cacheDir = () => process.env.GFW_PIPER_CACHE || path.join(os.homedir(), '.cache', 'ghostfleet-web', 'speech');
const python = () => path.join(dir(), 'venv', 'bin', 'python');
const model = (key) => path.join(dir(), 'voices', `${key}.onnx`);
const wavPath = (id) => path.join(cacheDir(), `${id}.wav`);

const voice = (key, name, place, quality, onnx, json) => {
  const [lang, who, q] = key.split('-');
  return { key, name, place, quality, path: `es/${lang}/${who}/${q}`, onnx, json };
};
export const CATALOG = [
  voice('es_MX-claude-high', 'Claude', 'México', 'alta', [63122309, 'cb1966e0ff20ca3aa010f6c9a0ce296a'], [4963, '36882201922fabb409f18d284af3eddd']),
  voice('es_MX-ald-medium', 'Ald', 'México', 'media', [63201294, '86374058e59b41ac3b7fe4181e1daad6'], [4878, 'aedc07cd37e61360144f04aebb05f7dd']),
  voice('es_AR-daniela-high', 'Daniela', 'Argentina', 'alta', [114199011, 'e373fb657c93877dbc438badeadff4cb'], [7248, 'b68d699a1779d98ee94c0cd9a08ba95b']),
  voice('es_ES-davefx-medium', 'Davefx', 'España', 'media', [63201294, 'dc515cd4ecc5f6f72fe14a941188fc9c'], [4817, 'dd157b5eaf6930bf949cf416d9a9307a']),
  voice('es_ES-sharvard-medium', 'Sharvard', 'España', 'media', [76733615, '77e6f9c26e92799fb04bb90b46bf1834'], [4903, 'e49cab310ce362145f7d94b347c291ff']),
  voice('es_ES-mls_10246-low', 'MLS 10246', 'España', 'baja', [63104526, 'ab8e93c9d2714fd4481fbca4e2a38891'], [4160, '8948a322c81cae2bc5fb1b9bbbc4961e']),
  voice('es_ES-mls_9972-low', 'MLS 9972', 'España', 'baja', [63104526, '587f2fc38dc3f582e771c3748465e2a2'], [4159, '97195bce39639d77af82c9c9c2110620']),
  voice('es_ES-carlfm-x_low', 'Carlfm', 'España', 'muy baja', [28130791, '4137b5aee01ea6241080fc4dbe59a8ee'], [4159, 'f4ab058cc8b5d024f1b123d06049df22']),
];
const find = (key) => CATALOG.find(v => v.key === key);
export const installed = (key) => !!find(key) && fs.existsSync(model(key)) && fs.existsSync(`${model(key)}.json`) && fs.existsSync(python());

// ── what is offered ─────────────────────────────────────────────────────────────────────
let job = null;   // the download in progress, or the last one that failed: { key, step, pct, error }
export const list = () => ({
  voices: CATALOG.map(v => ({ key: v.key, name: v.name, place: v.place, quality: v.quality, installed: installed(v.key),
                              mb: Math.round(v.onnx[0] / 1e6), sample: `${BASE}/${v.path}/samples/speaker_0.mp3` })),
  job,
});

// ── downloading ─────────────────────────────────────────────────────────────────────────
async function runtime() {
  if (fs.existsSync(python())) return;
  const venv = path.join(dir(), 'venv');
  fs.mkdirSync(dir(), { recursive: true });
  try {
    await run('uv', ['venv', '-q', '--python', '3.12', venv]);
    await run('uv', ['pip', 'install', '-q', '--python', python(), RUNTIME], { timeout: 300000 });
  } catch (e) {
    fs.rmSync(venv, { recursive: true, force: true });
    throw new Error(e.code === 'ENOENT' ? t('piper.noUv') : t('piper.installFailed', { why: String(e.stderr || e.message).slice(0, 200) }));
  }
}
async function fetchFile(url, dest, [size, md5], onBytes) {
  const part = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('piper.http', { status: res.status }));
  const hash = crypto.createHash('md5'), out = fs.createWriteStream(part);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk); got += chunk.length; onBytes?.(got);
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end(e => (e ? reject(e) : resolve())));
    if (got !== size || hash.digest('hex') !== md5) throw new Error(t('piper.corrupt'));
    fs.renameSync(part, dest);
  } catch (e) { out.destroy(); fs.rmSync(part, { force: true }); throw e; }
}
export function install(key) {
  const v = find(key);
  if (!v) return { error: t('piper.unknown') };
  if (job && !job.error) return { error: t('piper.busy', { name: job.name }) };
  if (installed(key)) return { ok: true };
  job = { key, name: v.name, step: 'runtime', pct: 0 };
  const mine = job;
  (async () => {
    await runtime();
    mine.step = 'voice';
    fs.mkdirSync(path.dirname(model(key)), { recursive: true });
    const url = `${BASE}/${v.path}/${key}.onnx`;
    await fetchFile(`${url}.json`, `${model(key)}.json`, v.json);
    await fetchFile(url, model(key), v.onnx, (n) => { mine.pct = Math.round(n / v.onnx[0] * 100); });
    if (job === mine) job = null;
  })().catch((e) => { mine.error = String(e?.message || e); });
  return { ok: true };
}
export function remove(key) {
  if (!find(key)) return { error: t('piper.unknown') };
  if (job?.key === key && !job.error) return { error: t('piper.downloading') };
  if (job?.key === key) job = null;
  fs.rmSync(model(key), { force: true });
  fs.rmSync(`${model(key)}.json`, { force: true });
  return { ok: true };
}

// ── speaking: the same queue as ghostfleet's Kokoro, for the same reasons ───────────────
const known = new Map();     // id -> { id, text, key }: the sentences a browser was told about
const queue = [];            // jobs waiting: { it, waiters }
const running = new Map();   // id -> job, the queued and the one in flight
let W = null, idleTimer = null, writes = 0;

const cached = (id) => { try { return fs.statSync(wavPath(id)).isFile(); } catch { return false; } };
export const idFor = (key, text) => crypto.createHash('sha256').update(`piper\x1f${key}\x1f${text}`).digest('hex').slice(0, 32);
export const owns = (id) => known.has(id);

function finish(j, m) {
  running.delete(j.it.id);
  if (m.ok && ++writes % 50 === 0) prune();
  for (const w of j.waiters) m.ok ? w.resolve(wavPath(j.it.id)) : w.reject(new Error(m.error || 'no se pudo generar el audio'));
}
function startWorker() {
  const proc = spawn(python(), [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, cur: null, buf: '', err: '', ready: false };
  proc.stdout.on('data', (d) => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { w.ready = true; pump(); continue; }
      const j = w.cur; w.cur = null;
      if (j && m.id === j.it.id) finish(j, m);
      pump();
    }
  });
  proc.stderr.on('data', (d) => { w.err = (w.err + d).slice(-2000); });
  const died = (why) => {
    if (W === w) W = null;
    const lost = [...(w.cur ? [w.cur] : []), ...(w.ready ? [] : queue.splice(0))];
    w.cur = null;
    for (const j of lost) finish(j, { ok: false, error: why });
    pump();
  };
  proc.on('error', (e) => died(`Piper no arrancó: ${e.message}`));
  proc.on('exit', (code, sig) => died(`Piper se cerró (${sig || code}): ${(w.err.trim().split('\n').pop() || 'sin salida').slice(0, 200)}`));
  return w;
}
function pump() {
  clearTimeout(idleTimer);
  if (!queue.length) {
    if (W && !W.cur) idleTimer = setTimeout(() => { try { W?.proc.stdin.end(); } catch {} }, IDLE_MS);
    return;
  }
  if (!W) { W = startWorker(); return; }
  if (!W.ready || W.cur) return;
  // A sentence somebody is waiting on goes ahead of the ones made in advance.
  const at = Math.max(0, queue.findIndex(j => j.waiters.length));
  const [j] = queue.splice(at, 1);
  if (cached(j.it.id)) { finish(j, { ok: true }); return pump(); }
  W.cur = j;
  fs.mkdirSync(cacheDir(), { recursive: true });
  W.proc.stdin.write(`${JSON.stringify({ id: j.it.id, text: j.it.text, model: model(j.it.key), out: wavPath(j.it.id) })}\n`);
}
function enqueue(it) {
  let j = running.get(it.id);
  if (!j) { j = { it, waiters: [] }; running.set(it.id, j); queue.push(j); pump(); }
  return j;
}
// A new reply supersedes what the last one made in advance, unless it is more of the same one.
export function prefetch(items, { append = false } = {}) {
  if (!append) for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].waiters.length) running.delete(queue.splice(i, 1)[0].it.id);
  for (const it of items) {
    known.delete(it.id); known.set(it.id, it);
    if (known.size > 600) known.delete(known.keys().next().value);
    if (!cached(it.id)) enqueue(it);
  }
}
export function audio(id) {
  if (cached(id)) return Promise.resolve(wavPath(id));
  const it = known.get(id);
  if (!it) return null;
  return new Promise((resolve, reject) => { enqueue(it).waiters.push({ resolve, reject }); pump(); });
}
function prune() {
  try {
    const files = fs.readdirSync(cacheDir()).filter(f => f.endsWith('.wav')).map(f => ({ f, t: fs.statSync(path.join(cacheDir(), f)).mtimeMs }));
    files.sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP)) fs.rmSync(path.join(cacheDir(), x.f), { force: true });
  } catch {}
}
