#!/usr/bin/env node
// test/helpers/barge-check.mjs — conversation mode's barge-in, in a real browser.
//
//     node test/helpers/barge-check.mjs     # one "name <US> want <US> got" row per check
//
// "I sent it and forgot something — I want to add it, not hear everything you have to say."
// While an answer is read aloud the mic stays open, and the owner talking over it stops the
// whole voice queue and starts a new turn, sent as a FOLLOW-UP. The danger is the other
// direction: the mic hears the app's own voice, and an app that barges in on itself cuts
// every answer short and sends its own words back as a prompt.
//
// SO THE FAKE MIC HEARS THE APP. What the page plays into its AudioContext's destination is
// tapped and mixed back into the "microphone" at 0.41 of its level — the WORST single frame
// measured with echo cancellation off on a laptop's speaker (test/fixtures/barge-echo.json),
// held for the whole reply instead of for one frame. The owner is an oscillator mixed in on
// top, switched on and off by this file. Everything else is the real client, unmodified,
// talking to a fake fleet-serve on loopback: /api/jarvis/hear answers a scripted transcript,
// /api/verb records each fleet_send, and /api/speak serves speech-shaped WAVs, so the Mac's
// voice path (plan, chunk, fetch, play) runs as it does on the phone.
//
// What it cannot be is acoustic: no speaker, no room, no phone. Those are unchecked, and
// the PR says which.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });
const ECHO_SIM = 0.41;

// ── the fake fleet-serve ────────────────────────────────────────────────────
const fx = (f) => JSON.parse(fs.readFileSync(path.join(WEB, 'fixtures', f), 'utf8'));
const st = {
  messages: [], queue: [], prompts: [], heard: 0, speakGets: [], planned: 0,
  hears: ['how is the acme-api deploy going', 'tell me about billing-svc', 'and also check the toolbox build'],
};
let ts = 1787300000;
const say = (role, text) => st.messages.push({ role, text, ts: String(++ts) });
// Six sentences of about two seconds each: a reply long enough to talk over.
const REPLY = (n) => Array.from({ length: 6 }, (_, i) =>
  `Reply ${n} sentence ${i + 1}: the acme-api rollout is on step ${i + 2} and the checks are green.`).join(' ');
// Speech-shaped audio: a voiced buzz under a syllable envelope at ~4 Hz that DIPS but never
// reaches silence inside a sentence, with a breath of silence at the end, at an RMS in the
// range the measured Kokoro reply had. Never silent on purpose: an envelope that touched zero
// four times a second reset the 250 ms hold by itself, and the "never barges in on its own
// voice" rows then passed with the echo gate switched off — measured, not assumed.
function wav(secs) {
  const rate = 24000, n = Math.floor(rate * secs), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate, syl = (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4 * t))) * (t < secs - 0.25 ? 1 : 0);
    const v = 0.22 * syl * (Math.sin(2 * Math.PI * 160 * t) + 0.5 * Math.sin(2 * Math.PI * 320 * t));
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const sentences = new Map();   // id -> text
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (res, code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = [];
  req.on('data', d => body.push(d));
  req.on('end', () => {
    const p = u.pathname;
    let b = {}; try { b = JSON.parse(Buffer.concat(body).toString('utf8') || '{}'); } catch {}
    if (!p.startsWith('/api/')) {
      const f = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
      if (!path.resolve(f).startsWith(WEB)) { res.writeHead(403); return res.end(); }
      return fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(buf);
      });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, version: 'barge-check' });
    if (p === '/api/projects') return json(res, 200, { ...fx('projects.json'), jarvis_enabled: true, speak: { ready: true, state: 'installed' } });
    if (p === '/api/jarvis') return json(res, 200, { ...fx('jarvis.json'), pending: [], voice: { ready: true }, speak: { ready: true, state: 'installed' } });
    if (p === '/api/grid') {
      const g = fx('grid-jarvis.json');
      return json(res, 200, { ...g, cards: g.cards.map(c => c.name === 'master' ? { ...c, status: 'ready' } : c) });
    }
    if (p === '/api/session') return json(res, 200, { session: 'master', total: st.messages.length,
      messages: st.messages.slice(-20), next_before: null, queue: st.queue.map((text, at) => ({ at, text })) });
    if (p === '/api/settings') return json(res, 200, { global_nudge: false, sessions: {} });
    if (p === '/api/checkouts') return json(res, 200, { checkouts: [] });
    if (p === '/api/jarvis/hear') return json(res, 200, { ok: true, text: st.hears[st.heard++] || 'nothing more', ms: 5 });
    if (p === '/api/verb' && b.tool === 'fleet_send') {
      const prompt = String(b.args && b.args.prompt || '');
      st.prompts.push(prompt);
      // THE FOLLOW-UP ARRIVES MID-TURN: the session has started on something else, so
      // fleet-send queues it, which is what the real verb says with `queued: 'turn'`.
      if (st.midTurn) { st.queue.push(prompt); return json(res, 200, { ok: true, queued: 'turn' }); }
      say('user', prompt);
      const n = st.prompts.length;
      setTimeout(() => say('assistant', REPLY(n)), 400);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/speak' && req.method === 'POST') {
      st.planned++;
      const parts = String(b.text || '').match(/[^.!?]+[.!?]*/g) || [];
      return json(res, 200, { ok: true, sentences: parts.map(t => t.trim()).filter(Boolean).map(text => {
        const id = (sentences.size + 1).toString(16).padStart(32, '0'); sentences.set(id, text);
        return { id, lang: 'en', voice: 'af_heart', text };
      }) });
    }
    if (p.startsWith('/api/speak/')) {
      const id = p.slice('/api/speak/'.length), text = sentences.get(id) || '';
      st.speakGets.push(text);
      const w = wav(Math.min(2.2, 0.3 + text.length * 0.025));
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': w.length }); return res.end(w);
    }
    return json(res, 404, { ok: false, text: 'not in the fake' });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── the page's fake microphone, which hears the page ──────────────────────
const INIT = `(() => {
  try { sessionStorage.setItem('gf.session:' + location.origin, JSON.stringify({ t: 'barge-check-token', exp: Date.now() / 1000 + 3600 })); } catch {}
  const AC = window.AudioContext;
  const mic = new AC();
  const mix = mic.createGain();
  const owner = mic.createGain(); owner.gain.value = 0; owner.connect(mix);
  const o1 = mic.createOscillator(); o1.frequency.value = 190; o1.connect(owner); o1.start();
  const o2 = mic.createOscillator(); o2.frequency.value = 410; o2.connect(owner); o2.start();
  const echoIn = mic.createGain(); echoIn.gain.value = ${ECHO_SIM}; echoIn.connect(mix);
  const echoMeter = mic.createAnalyser(); echoMeter.fftSize = 2048; echoIn.connect(echoMeter);
  window.__mic = { ctx: mic, owner, echoMeter, opens: 0 };
  // Every node the page connects to an AudioContext's destination is also fed, through a
  // stream, into the fake mic: the echo, at the level a speaker that loud would give.
  const conn = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    const r = conn.call(this, dst, ...rest);
    try {
      if (dst && dst === this.context.destination && this.context !== mic) {
        const c = this.context;
        if (!c.__tap) { c.__tap = c.createMediaStreamDestination(); conn.call(mic.createMediaStreamSource(c.__tap.stream), echoIn); }
        conn.call(this, c.__tap);
      }
    } catch {}
    return r;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    window.__mic.opens++;
    const d = mic.createMediaStreamDestination(); conn.call(mix, d); window.__mic.last = d.stream; return d.stream;
  };
})();`;

let b = null;
try {
  try {
    b = await launch({ width: 390, height: 844, scale: 2, mobile: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('barge-in', 'no chrome to listen in'); done(0); }
    throw e;
  }
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await b.call('Page.navigate', { url: base + '/#jarvis' });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(100); } return v; };
  const band = () => b.evaluate(() => { const p = document.querySelector('.talkband .ph'); return p ? p.className.replace('ph ', '') + ': ' + p.textContent : ''; });
  const owner = (v) => b.evaluate((x) => { window.__mic.owner.gain.value = x; return null; }, v);
  const echoLevel = () => b.evaluate(() => { const a = window.__mic.echoMeter, d = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); });
  const speak = async (ms) => { await owner(0.25); await sleep(ms); await owner(0); };

  const talk = await until(() => b.evaluate(() => !!document.querySelector('button.talk')));
  is('the Jarvis screen has its talk button', true, !!talk);
  await b.evaluate(() => { document.querySelector('button.talk').click(); return null; });
  is('talk opens the microphone and listens', true, /^listening/.test(await until(async () => (/^listening/.test(await band()) ? band() : ''), 5000)));

  // ── 1. the answer is read to the end over its own echo ────────────────────
  await speak(1200);
  const spoke1 = await until(async () => (/^speaking/.test(await band()) ? band() : ''), 15000);
  is('the first question is sent and its answer read', true, /^speaking/.test(spoke1));
  // The track the app holds, live: the old client STOPPED it for the answer, which is what
// made barge-in impossible.
  await sleep(300);
  is('...and the mic stays open while it is', 'live', await b.evaluate(() => window.__mic.last ? window.__mic.last.getAudioTracks()[0].readyState : 'none'));
  // Sampled across the answer rather than once: a single read can land in the gap between
  // two sentences.
  let echoHeard = 0;
  for (let i = 0; i < 20; i++) { echoHeard = Math.max(echoHeard, await echoLevel()); await sleep(100); }
  if (process.env.BARGE_DEBUG) console.error('debug echo max', echoHeard);
  is('the fake mic does hear the answer (the echo is real in this test)', true, echoHeard > 0.01);
  const back = await until(async () => (/^listening/.test(await band()) ? band() : ''), 30000);
  is('own playback alone never barges in: the whole answer is read', 6, st.speakGets.filter(t => /^Reply 1 /.test(t)).length);
  is('...and then it listens again, for the next turn', true, /^listening/.test(back));
  is('...having sent nothing of its own', 1, st.prompts.length);
  is('...nor transcribed anything', 1, st.heard);

  // ── 2. the owner talks over the second answer ─────────────────────────────
  await speak(1200);
  await until(async () => /^speaking/.test(await band()), 15000);
  await until(() => st.speakGets.filter(t => /^Reply 2 /.test(t)).length >= 2, 10000);
  const before = st.speakGets.length;
  st.midTurn = true;
  await owner(0.25);
  const cut = await until(async () => (/^listening/.test(await band()) ? band() : ''), 2000);
  is('the owner talking over the answer stops it and listens', true, /^listening/.test(cut));
  await sleep(400);
  is('...the answer\'s audio stops', true, (await echoLevel()) < 0.005);
  await sleep(700); await owner(0);
  const after = st.speakGets.filter(t => /^Reply 2 /.test(t)).length;
  is('...and the rest of its queue is never fetched', true, after < 6 && st.speakGets.length <= before + 1);
  const sent = await until(() => st.prompts.length >= 3, 12000);
  is('what the owner said is sent as a follow-up', '(spoken) and also check the toolbox build', sent ? st.prompts[2] : st.prompts.join(' | '));
  is('...both earlier prompts still stand', true, st.messages.some(m => m.text === st.prompts[0]) && st.messages.some(m => m.text === st.prompts[1]));
  is('...and the answer that was cut is still in the transcript', true, st.messages.some(m => /^Reply 2 /.test(m.text)));
  const shown = await until(() => b.evaluate(() => /and also check the toolbox build[\s\S]*queued/.test(document.body.innerText)), 6000);
  is('...and it is shown queued behind the running turn, not dropped', true, !!shown);

  // ── 3. a tap on the band cuts in too ─────────────────────────────────────
  // The queued follow-up starts its turn: the session takes it and answers.
  st.midTurn = false;
  const fu = st.queue.shift();
  say('user', fu); setTimeout(() => say('assistant', REPLY(3)), 400);
  await until(async () => /^speaking/.test(await band()), 20000);
  await until(() => st.speakGets.filter(t => /^Reply 3 /.test(t)).length >= 1, 8000);
  await sleep(600);
  await b.evaluate(() => { document.querySelector('.talkband').click(); return null; });
  const tapped = await until(async () => (/^listening/.test(await band()) ? band() : ''), 1500);
  is('a tap on the band while it speaks stops it and listens', true, /^listening/.test(tapped));
  await sleep(400);
  is('...and the audio stops', true, (await echoLevel()) < 0.005);
  is('...and a tap sends nothing by itself', 3, st.prompts.length);
  await b.evaluate(() => { document.querySelector('button.talk').click(); return null; });
} catch (e) {
  is('barge-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  try { server.close(); } catch {}
}
done(0);
