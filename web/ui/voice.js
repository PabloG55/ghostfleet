// Voice, both ways. Local first (whisper.cpp to hear, Kokoro to speak, on the machine running
// the server), the browser's own as the fallback. The rest of the app only sees listen()/speak().
//   WHICH SERVER is the adapter's business (web/ui/adapter.jsx): `voice()`, `hear(wav)`,
// `speak(text, voice)` and `speakAudio(id)`, plus `vad()` when the app ships the speech detector.
// agent.js hands the adapter over in bind(); until then every call answers "not ready" and the
// browser's own voice does the work, so nothing here assumes which app it is running in.
import { t, lang, worded } from './i18n.js';
import { speakable, speechChunks, EN as SAY_EN } from './speakable.js';

let B = {};
export function voiceBackend(adapter) { B = adapter || {}; status = null; }

let status = null;
export async function voiceStatus(force = false) {
  if (status && !force) return status;
  try { status = B.voice ? await B.voice() : null; } catch { status = null; }
  status ||= { hear: { ready: false }, speak: { ready: false } };
  return status;
}

// ── hearing, locally: record until the speaker stops, ship a 16 kHz mono WAV ─────────────
function wav16k(chunks, rate) {
  let n = 0; for (const c of chunks) n += c.length;
  const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / 16000, len = Math.floor(all.length / ratio);
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    // average the source samples this output sample covers: a cheap low-pass before decimating
    const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += all[j];
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// How long a pause has to be before "I'm done" — the person picks. A pause to think is not the
// end of a sentence; 1.2 s cut people off mid-thought. 'manual' waits for "I'm done".
export const PAUSES = worded({
  normal: { ms: 2500 },
  larga:  { ms: 4500 },
  manual: { ms: 0 },
}, 'pause');
const AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const transcribe = async (blob) => {
  if (!B.hear) throw new Error(t('voice.noHear'));
  const j = await B.hear(blob);
  return String(j?.text || '').trim();
};
const rmsOf = (d) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
const micDenied = () => t('voice.micDenied');

// ── when has the person finished? Silero VAD, a model of human speech ───────────────────
// Loudness cannot tell a breath, a keyboard or a fan from a word, so the old meter both cut
// people off and waited on noise. Silero (via @ricky0123/vad-web, the same detector Handy
// uses) scores every 32 ms frame for speech. Its files are served from VAD_DIR, copied there
// by scripts/copy-vad.mjs; one detector is kept for the page, and the microphone is released
// between turns. If it cannot load, the loudness meter below is the fallback.
export const VAD_DIR = '/vad-0.0.31/';
let vad = null, vadLoad = null, vadBroken = false, turn = null;
export function warmVad() {
  if (vad || vadBroken) return Promise.resolve(vad);
  // The detector is the app's to ship (the team app bundles it; an app without it has no `vad`),
  // so web/ui itself depends on nothing it would have to install.
  vadLoad ||= (B.vad ? B.vad() : Promise.reject(new Error('this app ships no speech detector'))).then(({ MicVAD }) => MicVAD.new({
    model: 'v5', baseAssetPath: VAD_DIR, onnxWASMBasePath: VAD_DIR, startOnLoad: false,
    ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; },
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: AUDIO }),
    resumeStream: () => navigator.mediaDevices.getUserMedia({ audio: AUDIO }),
    positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35,
    preSpeechPadMs: 600, minSpeechMs: 250, redemptionMs: PAUSES.normal.ms,
    submitUserSpeechOnPause: true,                 // "I'm done" hands over what was said so far
    onFrameProcessed: (p, f) => turn?.frame(p, f),
    onSpeechStart: () => turn?.start(),
    onSpeechEnd: (a) => turn?.end(a),
    onVADMisfire: () => turn?.misfire(),
  })).then(v => (vad = v), (e) => { vadBroken = true; console.warn('VAD did not load, using the loudness meter:', e); return null; })
    .finally(() => { vadLoad = null; });
  return vadLoad;
}

// Returns a handle {stop, cancel}. Callbacks: onLevel(0..1), onState('listening'|'hearing'),
// onSpeaking(bool) while words are coming in, onText(text) with the transcript, onError(msg).
// pauseMs: silence that ends the turn; 0 = only stop() ends it.
export function listenLocal(opts) {
  let h = null, cancelled = false;
  const pending = { stop: () => { if (h) h.stop(); else pending.stopAsked = true; }, cancel: () => { cancelled = true; h?.cancel(); } };
  warmVad().then((v) => {
    if (cancelled) return;
    h = v ? listenVad(v, opts) : listenLoudness(opts);
    if (pending.stopAsked) h.stop();
  });
  return pending;
}

function listenVad(v, { onLevel, onState, onSpeaking, onText, onError, pauseMs = PAUSES.normal.ms, maxMs = 180000 }) {
  let done = false, spoke = false;
  const t0 = performance.now();
  const end = async (audio) => {
    if (done) return; done = true;
    turn = null;
    clearInterval(watch);
    try { await v.pause(); } catch {}
    onSpeaking?.(false);
    if (!audio || audio.length < 16000 * 0.25) { onText?.(''); return; }
    onState?.('hearing');
    try { onText?.(await transcribe(wav16k([audio], 16000))); }
    catch (e) { onError?.(t('voice.transcribeFailed', { why: e.message })); onText?.(''); }
  };
  let got = null;
  const me = turn = {
    frame: (p, f) => { if (turn === me) onLevel?.(Math.min(1, rmsOf(f) * 12)); },
    start: () => { spoke = true; onSpeaking?.(true); },
    misfire: () => onSpeaking?.(false),        // a cough or a click: keep listening
    end: (audio) => {
      got = audio;
      if (pauseMs) end(audio);                 // manual mode only ends from stop()
    },
  };
  // Manual mode: a long pause must not end the turn, so the detector's own end is pushed far out.
  v.setOptions({ redemptionMs: pauseMs || 10 * 60e3 });
  const watch = setInterval(() => {
    const t = performance.now() - t0;
    if (!spoke && t > 15000) cancel();         // nobody said anything
    else if (t > maxMs) stop();
  }, 500);
  // pause() with submitUserSpeechOnPause emits onSpeechEnd (into `got`) before it resolves.
  const stop = async () => {
    if (done) return;
    if (turn === me) { try { await v.pause(); } catch {} }
    end(got);
  };
  const cancel = () => { got = null; spoke = false; end(null); };
  v.start().then(() => { if (!done) onState?.('listening'); }, () => { onError?.(micDenied()); cancel(); });
  return { stop, cancel };
}

// The fallback: a loudness meter. The room's noise is learned while nobody is talking, and
// capped, so starting to speak right away no longer makes every later word count as noise.
function listenLoudness({ onLevel, onState, onSpeaking, onText, onError, pauseMs = PAUSES.normal.ms, maxMs = 180000 }) {
  let stream, ctx, node, src, done = false, spoke = false, quietSince = 0;
  const chunks = [];
  const t0 = performance.now();
  const finish = async (send) => {
    if (done) return; done = true;
    try { node?.disconnect(); src?.disconnect(); } catch {}
    try { stream?.getTracks().forEach(x => x.stop()); } catch {}
    const rate = ctx?.sampleRate || 48000;
    try { await ctx?.close(); } catch {}
    onSpeaking?.(false);
    if (!send || !spoke || !chunks.length) { onText?.(''); return; }
    onState?.('hearing');
    try { onText?.(await transcribe(wav16k(chunks, rate))); }
    catch (e) { onError?.(t('voice.transcribeFailed', { why: e.message })); onText?.(''); }
  };
  (async () => {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }); }
    catch { done = true; onError?.(micDenied()); onText?.(''); return; }
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    let floor = 0.008;
    node.onaudioprocess = (e) => {
      if (done) return;
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      const rms = rmsOf(d);
      const now = performance.now();
      const loud = rms > Math.max(0.015, floor * 2.5);
      if (!loud) floor = Math.min(0.03, floor * 0.95 + rms * 0.05);
      onLevel?.(Math.min(1, rms * 12));
      if (loud) { if (!spoke) onSpeaking?.(true); spoke = true; quietSince = 0; } else if (spoke && !quietSince) quietSince = now;
      if (pauseMs && spoke && quietSince && now - quietSince > pauseMs) finish(true);
      else if (now - t0 > maxMs) finish(true);
      else if (!spoke && now - t0 > 15000) finish(false);            // nobody said anything
    };
    src.connect(node); node.connect(ctx.destination);
    onState?.('listening');
  })();
  return { stop: () => finish(true), cancel: () => finish(false) };
}

// ── hearing, in the browser: Chrome/Edge/Safari's recogniser ────────────────────────────
const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const browserCanHear = !!Recognition;
// The recogniser and the browser's voice follow the page's language.
const speechLang = () => (lang() === 'es' ? 'es-ES' : 'en-US');
// continuous: with `false` Chrome ends at the first breath. It keeps going, and the pause the
// person chose ends it (no new words for pauseMs), or stop() does.
export function listenBrowser({ onInterim, onState, onText, onError, pauseMs = PAUSES.normal.ms, lang: speech = speechLang() }) {
  const r = new Recognition();
  r.lang = speech; r.interimResults = true; r.continuous = true;
  let final = '', quiet = null;
  const hush = () => { clearTimeout(quiet); if (pauseMs) quiet = setTimeout(() => { try { r.stop(); } catch {} }, pauseMs); };
  r.onresult = (e) => {
    let live = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript; else live += e.results[i][0].transcript;
    }
    onInterim?.((final + ' ' + live).trim());
    hush();
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed') onError?.(t('voice.micDeniedShort'));
    else if (e.error === 'network') onError?.(t('voice.needsNet'));
    else if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(t('voice.dictation', { why: e.error }));
  };
  r.onend = () => { clearTimeout(quiet); onText?.(final.trim()); };
  try { r.start(); onState?.('listening'); } catch { onText?.(''); }
  return { stop: () => { try { r.stop(); } catch {} }, cancel: () => { try { r.abort(); } catch {} } };
}

// ── speaking ─────────────────────────────────────────────────────────────────────────────
export const plainText = (md) => String(md || '')
  .replace(/```[\s\S]*?```/g, ` ${t('voice.code')} `)
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/[*_#>|]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

let playing = null;
export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  if (playing) { playing.cancelled = true; try { playing.audio?.pause(); } catch {} playing = null; }
}
function utter(text, onEnd) {
  const s = window.speechSynthesis;
  if (!s) { onEnd?.(); return; }
  const u = new SpeechSynthesisUtterance(text);
  const all = s.getVoices();
  const v = lang() === 'es'
    ? all.find(x => /^es(-|_)(419|MX|US|EC|CO|AR)/i.test(x.lang)) || all.find(x => /^es/i.test(x.lang))
    : all.find(x => /^en(-|_)(US|GB)/i.test(x.lang)) || all.find(x => /^en/i.test(x.lang));
  if (v) u.voice = v;
  u.lang = v?.lang || speechLang(); u.rate = 1.05;
  u.onend = () => onEnd?.(); u.onerror = () => onEnd?.();
  s.speak(u);
}
// The device's own voice, one utterance per chunk: one long utterance is what WebKit's
// speechSynthesis is known to drop partway.
async function speakBrowser(chunks, job) {
  for (const c of chunks) {
    if (job.cancelled) return;
    await new Promise((resolve) => utter(c, resolve));
  }
}
// A voice sample from the internet: one file, played through the same stop as everything else.
export function playSample(url, onEnd) {
  stopSpeaking();
  const job = { cancelled: false, audio: new Audio(url) };
  playing = job;
  const done = () => { if (!job.cancelled) { playing = null; onEnd?.(); } };
  job.audio.onended = done; job.audio.onerror = done;
  job.audio.play().catch(done);
}
// What a reply sounds like is speakable.js's business: addresses named rather than spelled, and the
// whole reply read, a chunk per request — the next chunk is planned while this one plays, so there
// is no gap between them and the Mac never synthesises minutes that a stop throws away.
const sayWords = () => Object.fromEntries(Object.keys(SAY_EN).map(k => [k, t(`say.${k}`)]));
export async function speak(md, onEnd, voice = '') {
  stopSpeaking();
  const chunks = speechChunks(speakable(md, sayWords()));
  if (!chunks.length) { onEnd?.(); return; }
  const job = { cancelled: false, audio: null };
  playing = job;
  const st = await voiceStatus();
  if (job.cancelled) return;
  let i = 0;
  if (st.speak?.ready) {
    try {
      let next = B.speak(chunks[0], voice);
      for (; i < chunks.length; i++) {
        const r = await next;
        if (job.cancelled) return;
        next = i + 1 < chunks.length ? B.speak(chunks[i + 1], voice) : null;
        next?.catch(() => {});                 // a failure is read where it is awaited
        for (const s of r.sentences) {
          if (job.cancelled) return;
          // A URL the page can play: the team's is the route itself (its cookie rides along), the
          // phone's is the sentence fetched with its bearer token and handed back as a blob URL.
          const url = await B.speakAudio(s.id);
          if (job.cancelled) return;
          await new Promise((resolve) => {
            const a = new Audio(url);
            job.audio = a;
            a.onended = resolve; a.onerror = resolve;
            a.play().catch(resolve);
          });
        }
      }
    } catch { /* the rest goes to the device's own voice, from the chunk that failed */ }
  }
  if (i < chunks.length) await speakBrowser(chunks.slice(i), job);
  if (!job.cancelled) { playing = null; onEnd?.(); }
}
