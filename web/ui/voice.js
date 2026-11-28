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

// WHAT THE SERVER SAID, KEPT ONLY WHEN IT SAID IT. A read that failed — the phone waking on a
// network that was not up yet, a request lost at the moment of opening — was cached as "no
// voice" for the life of the page, so one dropped request took the machine's voice away until
// a reload, and the person heard the device's voice and saw its dictation with nothing to say
// why. A failed read now answers "not ready" without remembering it, and a "not ready" that WAS
// said is asked again after RECHECK_MS: it is the answer most likely to change, the moment
// somebody runs the install it names.
let status = null, statusAt = 0;
const NONE = { hear: { ready: false, why: null }, speak: { ready: false, why: null } };
const RECHECK_MS = 30000;
export async function voiceStatus(force = false) {
  const whole = !!(status?.hear?.ready && status?.speak?.ready);
  if (status && !force && (whole || Date.now() - statusAt < RECHECK_MS)) return status;
  let got = null;
  try { got = B.voice ? await B.voice() : null; } catch { got = null; }
  if (got) { status = got; statusAt = Date.now(); return got; }
  return status || NONE;
}
//   What a reply is READ with, without waiting: a remembered answer is used as it is and the
// re-ask runs behind it, for the next reply. Waiting on it put a network round trip between the
// play button and the first word of every read once the answer was 30 s old (forever, if the
// request was lost), where the old answer, kept for the life of the page, had cost nothing.
// Only a page's first read waits, as it always did. Speak mode's listen still asks fresh:
// whether the sheet opens is the decision the re-ask exists for.
function voiceNow() {
  if (!status) return voiceStatus();
  voiceStatus().catch(() => {});
  return status;
}
// Somebody to tell when the serving machine turns out not to hear — the sheet in voicesetup.jsx
// registers itself here, so this file says it and the shell decides how it looks.
let onMissing = null;
export function whenVoiceMissing(f) { onMissing = f; }
export const voiceMissing = (vs, opts) => { if (!onMissing) return false; onMissing(vs, opts); return true; };
// The person picked the device's dictation in that sheet: for the rest of the page it is used
// without asking again, as it was before the sheet existed — the sheet says it once.
let dictation = false;
export const chooseDictation = () => { dictation = true; };
export const dictationChosen = () => dictation;

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
//   A 503 that says `needs: 'voice'` is the machine telling us it cannot hear at all (the status
// said it could, then the binary or the model went away): the status is asked again next time,
// and the sheet says so. The error is then marked `shown`, so nobody toasts it a second time.
const transcribe = async (blob) => {
  if (!B.hear) throw new Error(t('voice.noHear'));
  try {
    const j = await B.hear(blob);
    return String(j?.text || '').trim();
  } catch (e) {
    if (e?.needs === 'voice') {
      status = null;
      if (voiceMissing({ hear: { ready: false, why: e.message, fix: e.fix || null }, speak: null })) e.shown = true;
    }
    throw e;
  }
};
const failed = (e) => (e?.shown ? '' : t('voice.transcribeFailed', { why: e.message }));
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
    catch (e) { onError?.(failed(e)); onText?.(''); }
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
    catch (e) { onError?.(failed(e)); onText?.(''); }
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

// The device voice's speed, set by the person under `gf.rate` (the key the phone's own screen used
// before it moved onto web/ui): anything outside what a voice can do is the old fixed 1.05.
export function savedRate() {
  let r = NaN;
  try { r = Number(localStorage.getItem('gf.rate')); } catch {}
  return Number.isFinite(r) && r >= 0.5 && r <= 2 ? r : 1.05;
}

let playing = null, unlockOnly = false;
//   cancel() only when there is something to cancel, and never just the unlock word. WebKit drops a speak() that follows a cancel()
// too closely, and every speak here starts with this — so an idle cancel was a way to lose the
// first chunk of a reply. And the unlock below was always followed by one: speak mode's tap said
// the silent word and cancelled it in the same breath, before it could unlock anything.
export function stopSpeaking() {
  const s = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (s && !unlockOnly && (s.speaking || s.pending)) s.cancel();
  if (playing) { const j = playing; playing = null; j.cancelled = true; try { j.audio?.pause(); } catch {} j.stop?.(); }
}

// ── ONE AUDIO ELEMENT, UNLOCKED INSIDE THE TAP ──────────────────────────────────────────
// iOS plays an <audio> without a gesture only if that same element has played inside one. The
// machine's voice used to make a new Audio() for every sentence, from a network callback long
// after the tap, so on an iPhone every play() was refused — and the refusal was taken as "this
// sentence is done". The whole reply went by as a run of audio fetches with no sound and no
// fallback: the fetches were the only trace, back to back with no time between them to play
// anything. Now there is one element for the page, played silently in the tap that starts
// listening or reading (unlockSpeech), and every sentence goes through it by changing its src.
let player = null, silent = '';
export function unlockAudio() {
  if (typeof Audio === 'undefined') return;
  try {
    player ||= new Audio();
    if (playing?.audio === player) return;      // mid-sentence: silence would cut it off
    silent ||= URL.createObjectURL(wav16k([new Float32Array(800)], 16000));
    player.src = silent;
    const p = player.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}
// iOS lets speech start only from a gesture; a silent word said inside the tap unlocks the voice
// for the timers and network callbacks that speak later — the device's voice AND the machine's.
export function unlockSpeech() {
  try {
    const u = new SpeechSynthesisUtterance(' '); u.volume = 0;
    u.onend = u.onerror = () => { unlockOnly = false; };
    window.speechSynthesis?.speak(u); unlockOnly = true;
  } catch {}
  unlockAudio();
}
// One sentence through the shared element: 'ended' once it has played, 'refused' when it never
// started — play() rejected, the element errored before a sound, or nothing began in STALL_MS.
// 'refused' is the device voice's cue; a sentence that started and then failed is just skipped.
const STALL_MS = 15000;
function playOnce(url, job) {
  return new Promise((resolve) => {
    const a = player ||= new Audio();
    let started = false, settled = false, timer = null;
    const end = (how) => {
      if (settled) return;
      settled = true; clearTimeout(timer); job.stop = null;
      a.onended = a.onerror = a.onplaying = null;
      resolve(how);
    };
    const began = () => { started = true; clearTimeout(timer); };
    job.audio = a; job.stop = () => end('cancelled');
    a.onplaying = began;
    a.onended = () => end('ended');
    a.onerror = () => end(started ? 'ended' : 'refused');
    timer = setTimeout(() => { if (!started) end('refused'); }, STALL_MS);
    a.src = url;
    let p;
    try { p = a.play(); } catch { end('refused'); return; }
    if (p && p.then) p.then(began, () => end('refused'));
  });
}
function utter(text, onEnd) {
  const s = window.speechSynthesis;
  if (!s) { onEnd?.(); return; }
  unlockOnly = false;
  const u = new SpeechSynthesisUtterance(text);
  const all = s.getVoices();
  const v = lang() === 'es'
    ? all.find(x => /^es(-|_)(419|MX|US|EC|CO|AR)/i.test(x.lang)) || all.find(x => /^es/i.test(x.lang))
    : all.find(x => /^en(-|_)(US|GB)/i.test(x.lang)) || all.find(x => /^en/i.test(x.lang));
  if (v) u.voice = v;
  u.lang = v?.lang || speechLang(); u.rate = savedRate();
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
  const st = await voiceNow();
  if (job.cancelled) return;
  let i = 0, rest = [];
  if (st.speak?.ready) {
    try {
      let next = B.speak(chunks[0], voice);
      chunk: for (; i < chunks.length; i++) {
        const r = await next;
        if (job.cancelled) return;
        next = i + 1 < chunks.length ? B.speak(chunks[i + 1], voice) : null;
        next?.catch(() => {});                 // a failure is read where it is awaited
        for (let k = 0; k < r.sentences.length; k++) {
          if (job.cancelled) return;
          // A URL the page can play: the team's is the route itself (its cookie rides along), the
          // phone's is the sentence fetched with its bearer token and handed back as a blob URL.
          const url = await B.speakAudio(r.sentences[k].id);
          if (job.cancelled) return;
          // THE DEVICE WOULD NOT PLAY IT, so the device's voice reads it — from this sentence
          // on, never the machine's again for this reply: a refusal is the device's answer about
          // the element, and asking it again per sentence is a silent reply in instalments.
          if (await playOnce(url, job) === 'refused') {
            if (job.cancelled) return;
            rest = r.sentences.slice(k).map(x => x.text).filter(Boolean);
            if (!rest.length) rest = [chunks[i]];   // a server that sends no text: the chunk, whole
            i++;
            break chunk;
          }
        }
      }
    } catch { /* the rest goes to the device's own voice, from the chunk that failed */ }
  }
  if (job.cancelled) return;
  const left = [...rest, ...chunks.slice(i)];
  if (left.length) await speakBrowser(left, job);
  if (!job.cancelled) { playing = null; onEnd?.(); }
}
