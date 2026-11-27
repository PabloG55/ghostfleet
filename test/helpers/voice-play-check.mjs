#!/usr/bin/env node
// test/helpers/voice-play-check.mjs — web/ui/voice.js's two halves of speaking, and what it believes
// about the machine, run in node against a device this file controls.
//
//     node test/helpers/voice-play-check.mjs     rows for test/run.sh
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE FAILURE THESE PIN, seen from a phone served by a Linux machine: Kokoro made every sentence
// (the server logged each synthesis and each 200), and the phone played none of them and said
// nothing instead. Every sentence was a fresh Audio() played from a network callback, which iOS
// refuses outside a tap, and the refusal resolved as "that sentence is done" — so the reply went
// by in silence and the device's own voice, the fallback, was never reached. So:
//   - every sentence plays through ONE element, the one the tap unlocked;
//   - a refused play hands the rest of the reply, from that sentence, to speechSynthesis;
//   - the silent unlock word survives the stop that follows it in the same tap;
//   - a failed status read is not remembered as "this machine has no voice".
// Each was watched red against origin/staging's voice.js, where unlockSpeech is not exported
// (the rows that need it say so), a refusal reads nothing aloud, and a failed read sticks.
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// ── the device ─────────────────────────────────────────────────────────────────────────
const dev = { mode: 'ok', made: 0, plays: [], said: [], cancels: 0, speaking: false };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
globalThis.speechSynthesis = {
  get speaking() { return dev.speaking; }, pending: false, getVoices: () => [],
  speak(u) { dev.said.push(u.text); dev.speaking = true; setTimeout(() => { dev.speaking = false; u.onend && u.onend(); }, 1); },
  cancel() { dev.cancels++; dev.speaking = false; },
};
// 'ok' plays each src to its end; 'refuse' rejects play() the way iOS does outside a gesture;
// 'error' fails to load it, firing error and rejecting, before a sound.
globalThis.Audio = class {
  constructor(src = '') { dev.made++; this.src = src; }
  play() {
    dev.plays.push(this.src);
    if (dev.mode === 'refuse' && this.src !== dev.silent) {
      return Promise.reject(Object.assign(new Error('play() can only be initiated by a user gesture'), { name: 'NotAllowedError' }));
    }
    if (dev.mode === 'error' && this.src !== dev.silent) {
      setTimeout(() => this.onerror && this.onerror(), 0);
      return Promise.reject(Object.assign(new Error('no supported source'), { name: 'NotSupportedError' }));
    }
    setTimeout(() => { this.onplaying && this.onplaying(); setTimeout(() => this.onended && this.onended(), 2); }, 0);
    return Promise.resolve();
  }
  pause() {}
};
const realCreate = URL.createObjectURL;
URL.createObjectURL = (b) => { const u = realCreate ? realCreate.call(URL, b) : 'blob:silent'; dev.silent = u; return u; };

const V = await import(new URL('../../web/ui/voice.js', import.meta.url).href);
const reset = (mode) => { Object.assign(dev, { mode, plays: [], said: [], cancels: 0, speaking: false }); };
const machine = (over = {}) => ({
  voice: async () => ({ hear: { ready: true }, speak: { ready: true } }),
  speak: async (text) => ({ sentences: text.split(/(?<=\.)\s+/).map((x, i) => ({ id: `s${i}`, text: x })) }),
  speakAudio: async (id) => `blob:sentence-${id}`,
  ...over,
});
const speakAll = (md) => new Promise((resolve) => { V.speak(md, resolve); setTimeout(resolve, 4000); });
const REPLY = 'The build passed. Two tests were slow.';
const has = (f) => typeof V[f] === 'function';

// 1. the machine's voice, on a device that plays it
reset('ok');
V.voiceBackend(machine());
const made0 = dev.made;
if (has('unlockSpeech')) V.unlockSpeech();
const madeByTap = dev.made - made0;
await speakAll(REPLY);
is('the tap makes the one audio element the reply will use', 1, has('unlockSpeech') ? madeByTap : 'no unlockSpeech in voice.js');
is('...every sentence plays through it, no new element per sentence', 0, dev.made - made0 - madeByTap);
is('...each sentence, in order', ['blob:sentence-s0', 'blob:sentence-s1'], dev.plays.filter(p => /sentence/.test(p)));
is('...and the device\'s voice is not used beside it', [], dev.said.filter(x => x.trim()));
is('the tap unlocks the element by playing it, inside the tap', true, has('unlockSpeech') ? dev.plays[0] === dev.silent : 'no unlockSpeech in voice.js');

// 2. the device refuses the element: the reply is read by speechSynthesis instead
reset('refuse');
V.voiceBackend(machine());
await speakAll(REPLY);
is('a refused play hands the reply to the device\'s own voice', ['The build passed.', 'Two tests were slow.'], dev.said.filter(x => x.trim()));
is('...and stops asking the element for the rest of it', 1, dev.plays.filter(p => /sentence/.test(p)).length);

// 3. the element fails before a sound: the same
reset('error');
V.voiceBackend(machine());
await speakAll(REPLY);
is('an element that errors before a sound is read by the device instead', ['The build passed.', 'Two tests were slow.'], dev.said.filter(x => x.trim()));

// 4. a refusal partway: what played is not read twice
reset('ok');
let n = 0;
V.voiceBackend(machine({ speakAudio: async (id) => { n++; if (n === 2) dev.mode = 'refuse'; return `blob:sentence-${id}`; } }));
await speakAll(REPLY);
is('a refusal partway reads aloud only what had not played', ['Two tests were slow.'], dev.said.filter(x => x.trim()));

// 5. the silent unlock word survives the stop that follows it in the same tap
reset('ok');
if (has('unlockSpeech')) { V.unlockSpeech(); V.stopSpeaking(); }
is('speak mode\'s tap says the unlock word and stops: the word is not cancelled', 0, has('unlockSpeech') ? dev.cancels : 'no unlockSpeech in voice.js');
await new Promise(r => setTimeout(r, 5));
reset('ok');
dev.speaking = true; V.stopSpeaking();
is('...while a voice that is really speaking is', 1, dev.cancels);
reset('ok');
V.stopSpeaking();
is('...and an idle stop cancels nothing', 0, dev.cancels);

// 6. what it believes about the machine
let asks = 0;
V.voiceBackend(machine({ voice: async () => { asks++; if (asks === 1) throw new Error('offline'); return { hear: { ready: true }, speak: { ready: true } }; } }));
const first = await V.voiceStatus();
const second = await V.voiceStatus();
is('a status read that failed answers "not ready"', false, !!first.hear?.ready);
is('...and is not remembered: the next read asks again and hears it', true, !!second.hear?.ready);
asks = 0;
V.voiceBackend(machine({ voice: async () => { asks++; return asks === 1 ? { hear: { ready: false, why: 'no whisper.cpp on this machine' }, speak: { ready: true } } : { hear: { ready: true }, speak: { ready: true } }; } }));
await V.voiceStatus(); await V.voiceStatus();
is('a "not ready" the machine said is kept a while, not asked on every call', 1, asks);
const now = Date.now; Date.now = () => now() + 31000;
const later = await V.voiceStatus();
Date.now = now;
is('...and asked again after it: the answer most likely to change, once the install is run', true, !!later.hear?.ready);

process.stdout.write(rows.join('\n') + '\n');
process.exit(0);
