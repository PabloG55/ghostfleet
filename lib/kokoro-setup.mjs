// lib/kokoro-setup.mjs — install Kokoro, the Mac-side voice the phone reads replies with.
//
//     fleet-jarvis voice --kokoro             is it installed, and does its Python work
//     fleet-jarvis voice --kokoro --install   set it up, or repair what is broken
//
// OPTIONAL, like whisper.cpp beside it: lib/speech.mjs finds Kokoro if it is there and the
// phone falls back to its own voice if it is not. install.sh offers this (default No, and
// never under --yes) and calls this file on a yes.
//
// IDEMPOTENT, AND THE CHECK IS THE WORK. Re-running it on a working install hashes the two
// model files, imports the venv's packages, and downloads nothing. Each piece is replaced
// only when it fails its own check, so a truncated model is fetched again without
// rebuilding a good venv, and a venv whose Python went away is rebuilt without 350 MB.
//
// NOTHING HALF-MADE EVER SITS UNDER A FINAL NAME. lib/speech.mjs decides "installed" by
// which files exist, so a download goes to `<name>.part` and is renamed only once its size
// and SHA-256 match the pins, and the venv is built as `venv.part` and renamed only once it
// imports. A run killed halfway leaves `.part` files, which the next run resumes, and a
// status that still says "not installed" — which is true.
//
// WHY A PINNED OLD PYTHON. onnxruntime ships wheels for a narrower range of Pythons than a
// current machine has (a 3.14 system Python has none), so the venv is 3.12 by uv when uv is
// here — uv fetches that Python itself if it must — and otherwise the newest 3.10–3.12 on
// PATH. No such Python is a message naming what to install, never a failed install.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { kokoroDir, files, pins, status, KOKORO_FIX, WORKER, VOICES, ESPEAK_PATH_MAX, ESPEAK_TAIL, espeakPathFits } from './speech.mjs';

// The one package the worker imports (it brings onnxruntime and numpy). Pinned, because a
// later kokoro-onnx can change what a v1.0 model file needs, and this is the version the
// model pins in lib/speech.mjs were measured working with.
export const PACKAGE = 'kokoro-onnx==0.6.1';
const PYTHONS = ['python3.12', 'python3.11', 'python3.10', 'python3'];
const tooLong = (dir) => `${dir} is too long a path for Kokoro: espeak-ng, which it speaks through, cannot find its data more than ${ESPEAK_PATH_MAX} characters deep (this would be ${path.join(path.resolve(dir), ESPEAK_TAIL).length}). Set CLAUDE_FLEET_KOKORO_DIR to a shorter directory`;

const which = (bin) => {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const run = (cmd, args, opt = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opt });
const tail = (r) => String((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);

// ── does the venv work ──────────────────────────────────────────────────────
// An import, not a file test: a venv outlives the Python it was made from, and what is left
// is a bin/python that exists and cannot start.
export function probe(python) {
  try { if (!fs.statSync(python).isFile()) return { ok: false, why: `no ${python}` }; } catch { return { ok: false, why: `no ${python}` }; }
  const r = run(python, ['-c', 'import kokoro_onnx, onnxruntime, numpy, espeakng_loader as e; print(len(e.get_data_path()))'], { timeout: 120000 });
  if (r.status !== 0) return { ok: false, why: `its Python cannot import kokoro_onnx (${tail(r) || `exit ${r.status}`})` };
  const n = Number(String(r.stdout).trim().split('\n').pop());
  if (n > ESPEAK_PATH_MAX) return { ok: false, why: `its espeak-ng data is ${n} characters deep and espeak-ng stops at ${ESPEAK_PATH_MAX} — set CLAUDE_FLEET_KOKORO_DIR to a shorter directory` };
  return { ok: true };
}

// The cheap status, plus the import. What `fleet-jarvis voice --kokoro` and install.sh ask.
export function check() {
  const s = status();
  if (!s.ready) return s;
  const p = probe(files().python);
  if (!p.ok) return { ready: false, state: 'broken', why: `Kokoro in ${s.dir} is broken: ${p.why}${/CLAUDE_FLEET_KOKORO_DIR/.test(p.why) ? '' : ` — run: ${KOKORO_FIX}`}`, how: s.how };
  return s;
}

// ── which Python can build the venv ────────────────────────────────────────
// uv first: it pins 3.12 exactly and fetches it when the machine has none. Then a python
// on PATH whose version onnxruntime has wheels for.
export function findBuilder() {
  const uv = which('uv') || [path.join(os.homedir(), '.local', 'bin', 'uv'), path.join(os.homedir(), '.cargo', 'bin', 'uv')]
    .find(f => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  if (uv) return { kind: 'uv', bin: uv };
  const seen = [];
  for (const name of PYTHONS) {
    const bin = which(name);
    // Never the macOS /usr/bin/python3: without the Command Line Tools it is a stub that
    // opens an install dialog, which is not something an installer should cause.
    if (!bin || (process.platform === 'darwin' && bin === '/usr/bin/python3')) continue;
    const r = run(bin, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 20000 });
    const v = String(r.stdout || '').trim();
    if (r.status !== 0 || !v) continue;
    seen.push(`${name} is ${v}`);
    if (/^3\.1[0-2]$/.test(v)) return { kind: 'python', bin, version: v };
  }
  return { kind: '', seen };
}
export function noPythonMessage(seen = []) {
  const brew = process.platform === 'darwin';
  return [
    `Kokoro needs Python 3.10–3.12 (onnxruntime has no wheels for newer ones), and there is none here${seen.length ? ` — ${seen.join(', ')}` : ''}.`,
    'Either of these fixes it:',
    '    curl -LsSf https://astral.sh/uv/install.sh | sh      # uv, which fetches Python 3.12 itself',
    brew ? '    brew install python@3.12'
         : '    sudo apt install python3.12 python3.12-venv            # or your distro\'s 3.10–3.12 with venv',
    `then run: ${KOKORO_FIX}`,
  ].join('\n');
}

// ── the two model files ────────────────────────────────────────────────────
export function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

// Fetch one pinned file to `dst`, or say why not. RESUMES a `.part` a previous run left
// (curl -C -), and starts over once — never more — when what arrived is complete but wrong,
// because a wrong file that downloads twice is the pin or the release talking, not the line.
async function fetchPinned(pin, dst, say) {
  const part = `${dst}.part`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let have = sizeOf(part);
    if (have > pin.size) { fs.rmSync(part, { force: true }); have = -1; }
    if (have !== pin.size) {
      say(`${have > 0 ? 'resuming' : 'downloading'} ${pin.name} (${Math.round(pin.size / 1048576)} MB)${have > 0 ? ` from ${Math.round(have / 1048576)} MB` : ''}`);
      const r = spawnSync('curl', ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20',
        ...(process.stderr.isTTY ? ['--progress-bar'] : ['-sS']), '-C', '-', '-o', part, pin.url], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.error) return { ok: false, why: `could not run curl (${r.error.code || r.error.message})` };
      have = sizeOf(part);
      // A failure part-way keeps the .part, which the next run resumes; one that is already
      // too big can only be wrong.
      if (r.status !== 0 && have !== pin.size) {
        if (have > pin.size) fs.rmSync(part, { force: true });
        if (attempt === 2) return { ok: false, why: `downloading ${pin.name} failed (curl exit ${r.status}); run it again to resume` };
        continue;
      }
    }
    if (have !== pin.size) { fs.rmSync(part, { force: true }); continue; }
    const got = await sha256(part);
    if (got === pin.sha256) { fs.renameSync(part, dst); return { ok: true }; }
    fs.rmSync(part, { force: true });
    say(`${pin.name} arrived with the wrong checksum (sha256 ${got.slice(0, 12)}…, want ${pin.sha256.slice(0, 12)}…) — discarded`);
  }
  return { ok: false, why: `${pin.name} did not match its pinned checksum twice, so it was not installed` };
}

// ── the venv ───────────────────────────────────────────────────────────────
function buildVenv(dir, b, say) {
  const tmp = path.join(dir, 'venv.part');
  fs.rmSync(tmp, { recursive: true, force: true });
  const py = path.join(tmp, 'bin', 'python');
  let r;
  if (b.kind === 'uv') {
    say('creating a Python 3.12 venv with uv');
    r = run(b.bin, ['venv', '-q', '--python', '3.12', tmp]);
    if (r.status !== 0) return { ok: false, why: `uv could not make a 3.12 venv: ${tail(r)}` };
    say(`installing ${PACKAGE} (onnxruntime, numpy) into it`);
    r = run(b.bin, ['pip', 'install', '-q', '--python', py, PACKAGE]);
  } else {
    say(`creating a venv with ${b.bin} (${b.version})`);
    r = run(b.bin, ['-m', 'venv', tmp]);
    if (r.status !== 0) return { ok: false, why: `${b.bin} could not make a venv (${tail(r)}) — on Debian/Ubuntu that is the python${b.version}-venv package` };
    say(`installing ${PACKAGE} (onnxruntime, numpy) into it`);
    r = run(py, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', PACKAGE]);
  }
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, why: `installing ${PACKAGE} failed: ${tail(r)}` }; }
  const p = probe(py);
  if (!p.ok) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, why: `the new venv is not usable: ${p.why}` }; }
  // Renamed into place only now. A venv's interpreter finds its packages relative to
  // itself (pyvenv.cfg sits beside bin/), so the move leaves it working — re-probed anyway.
  const final = path.join(dir, 'venv');
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(tmp, final);
  const q = probe(path.join(final, 'bin', 'python'));
  return q.ok ? { ok: true } : { ok: false, why: `the venv stopped working when moved into place: ${q.why}` };
}

// ── does it speak ──────────────────────────────────────────────────────────
// Through the same worker fleet-serve runs, with the same arguments: a sentence in, a WAV
// out. Exported so the suite and a person can make it say something in either language.
export function speakOnce(text, lang = 'en', out) {
  const f = files(), v = VOICES[lang] || VOICES.en;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(f.python, [WORKER, f.model, f.voices], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); try { proc.stdin.end(); proc.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => end({ ok: false, why: 'Kokoro did not answer within two minutes' }), 120000);
    proc.on('error', (e) => end({ ok: false, why: `Kokoro would not start: ${e.message}` }));
    proc.on('exit', (c) => end({ ok: false, why: `Kokoro exited (${c}): ${err.trim().split('\n').pop() || 'no output'}` }));
    proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { proc.stdin.write(JSON.stringify({ id: 'check', text, voice: v.voice, lang: v.lang, speed: 1.0, out }) + '\n'); continue; }
        if (!m.ok) return end({ ok: false, why: m.error || 'synthesis failed' });
        let head = '';
        try { const fd = fs.openSync(out, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd); head = b.toString('latin1'); } catch {}
        return end(head.startsWith('RIFF') && head.endsWith('WAVE')
          ? { ok: true, ms: Date.now() - t0, bytes: sizeOf(out) }
          : { ok: false, why: 'Kokoro answered but wrote no WAV' });
      }
    });
  });
}

// ── install ────────────────────────────────────────────────────────────────
// Resolves {ok, code, why}. code 3 is "no usable Python", which install.sh reports and
// carries on from — it is the one failure the person fixes with a package, not a retry.
export async function install({ say = (m) => console.log(`kokoro: ${m}`) } = {}) {
  const dir = kokoroDir(), f = files(dir), P = pins();
  if (!espeakPathFits(dir)) return { ok: false, code: 1, why: tooLong(dir) };
  fs.mkdirSync(dir, { recursive: true });

  // The venv's question first: it is the one that can stop the install, and it should stop
  // it BEFORE 350 MB arrive rather than after.
  const venvOk = probe(f.python).ok;
  let builder = null;
  if (!venvOk) {
    builder = findBuilder();
    if (!builder.kind) return { ok: false, code: 3, why: noPythonMessage(builder.seen) };
  }

  let changed = !venvOk;
  for (const k of ['model', 'voices']) {
    const pin = P[k], dst = f[k];
    if (sizeOf(dst) === pin.size && await sha256(dst) === pin.sha256) continue;
    // Present under the final name and wrong: leaving it is what makes a later status say
    // "installed", so it goes, and the download starts from whatever .part there is.
    if (sizeOf(dst) >= 0) { say(`${pin.name} is damaged (wrong size or checksum) — fetching it again`); fs.rmSync(dst, { force: true }); }
    const r = await fetchPinned(pin, dst, say);
    if (!r.ok) return { ok: false, code: 1, why: r.why };
    changed = true;
  }
  if (!venvOk) {
    const r = buildVenv(dir, builder, say);
    if (!r.ok) return { ok: false, code: 1, why: r.why };
  }
  if (!changed) { say(`already installed and verified in ${dir} — nothing downloaded`); return { ok: true, code: 0, already: true }; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-check-'));
  try {
    const r = await speakOnce('Kokoro is ready.', 'en', path.join(tmp, 'check.wav'));
    if (!r.ok) return { ok: false, code: 1, why: `installed, but it did not speak: ${r.why} — run: ${KOKORO_FIX}` };
    say(`ready in ${dir} — spoke a test sentence in ${(r.ms / 1000).toFixed(1)}s`);
    return { ok: true, code: 0 };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
