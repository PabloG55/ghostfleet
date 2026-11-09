#!/usr/bin/env node
// audio-check — the app leaves the owner's music alone until they ask it to speak.
//
//     node test/helpers/audio-check.mjs        # "name <US> want <US> got" rows
//
// THE BUG THIS EXISTS FOR. Opening the installed app paused whatever the phone was playing.
// unlockAudio() ran from a capture listener on EVERY first touchend/click anywhere, and it
// did three things that each claim the iOS audio session: set navigator.audioSession.type
// to 'playback' (non-mixable, so iOS interrupts other apps' audio), created and resumed an
// AudioContext and played a one-sample buffer on it, and spoke a silent utterance. The
// first tap on the Projects screen, which is the first thing anyone does, was enough.
//
// SO THE AUDIO APIS ARE STUBBED AND EVERY CALL IS RECORDED, before app.js runs, and the
// rows ask what was touched — not what was heard, which a headless browser cannot tell us
// and which is the thing a real phone with music playing has to answer. The taps are
// trusted input from the DevTools protocol, not dispatchEvent, because a document
// listener in the capture phase is exactly what a synthetic event on one element would
// still reach and a real finger would too — the question is whether the APP reacts.
//
// BOTH DIRECTIONS. A client that never unlocked anything would pass every "a plain tap
// touches nothing" row, and it would be a speaker button that plays to nobody on iOS. So
// the speaker tap is asserted to unlock, inside that tap, and the session is asserted to
// be handed back when the voice ends — the half that lets the music resume.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

// Installed before ANY page script, on every navigation. Each stub records its call into
// window.__audio and otherwise behaves enough like the real thing for app.js to carry on:
// a context that reports 'running' once resumed, and an utterance that ends on its own so
// the speech path reaches its finish.
const STUBS = `(() => {
  const log = window.__audio = [];
  class Ctx {
    constructor() { log.push('new AudioContext'); this.state = 'suspended'; this.currentTime = 0;
                    this.sampleRate = 48000; this.destination = {}; }
    resume() { log.push('resume'); this.state = 'running'; return Promise.resolve(); }
    suspend() { log.push('suspend'); this.state = 'suspended'; return Promise.resolve(); }
    close() { log.push('close'); this.state = 'closed'; return Promise.resolve(); }
    createBuffer() { return { duration: 0 }; }
    createBufferSource() { log.push('createBufferSource');
      return { connect() {}, start() { log.push('start'); }, stop() {}, onended: null }; }
    decodeAudioData(ab, ok, bad) { bad && bad(new Error('stub')); }
  }
  window.AudioContext = Ctx; window.webkitAudioContext = Ctx;
  let type = 'auto';
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: {
    get type() { return type; },
    set type(v) { log.push('audioSession.type=' + v); type = v; },
  } });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  const synth = {
    speak(u) { log.push('speak:' + JSON.stringify(u.text));
               if (u.text.trim()) setTimeout(() => { u.onend && u.onend(); }, 50); },
    cancel() {}, getVoices() { return []; }, addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  // Every click the page receives, counted before the app sees it: a tap is waited for by
  // its click ARRIVING, and a tap that delivers two is a broken tap (see tapAt).
  window.__clicks = 0;
  window.addEventListener('click', () => { window.__clicks++; }, { capture: true });
})();`;

let b = null, srv = null;
try {
  srv = await serveDir(path.join(ROOT, 'web'));
  try {
    b = await launch({ width: 390, height: 844, scale: 2, mobile: true });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the audio session', 'no chrome to tap in'); done(0); }
    throw e;
  }
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });
  // FIXTURES CANNOT HEAR, and say so — which makes `talk` refuse before it opens anything.
  // The one field that refusal reads is turned on in the page's own fetch, so the talk rows
  // exercise the real talkStart() rather than its refusal; nothing on disk changes. In the
  // page and not over the DevTools Fetch domain: the service worker makes that request, and
  // a page target's interception never sees it.
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (u, o) => {
      const r = await real(u, o);
      if (!/fixtures\\/jarvis\\.json/.test(String(u))) return r;
      const j = await r.json(); j.voice = { ready: true };
      return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  })();` });
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(800); };
  async function until(cond, ms = 15000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(100); v = await cond(); }
    return v;
  }
  const log = () => b.evaluate(() => (window.__audio || ['no stubs']).slice());
  const clear = () => b.evaluate(() => { window.__audio.length = 0; return null; });
  // A REAL TAP, AND ONE OF THEM. The touch pair alone is the whole tap: on a mobile page
  // Chrome turns it into touchstart, touchend, mousedown, mouseup, click — the order a phone
  // delivers them, all trusted, so the old listener's touchend AND click both arrive.
  //   It used to be followed by a mousePressed/mouseReleased pair as well, which is a
  // SECOND click at the same point, hit-tested against whatever the first one had drawn.
  // On an idle machine that was the same card twice and harmless; on a loaded runner the
  // project tap had already drawn the grid, so the second click opened the session card
  // under the finger — the grid was skipped, never seen, and both session rows went red
  // on a client that was fine. Measured: 1 run in 16 with 16 running at once.
  //   Returns once the click has ARRIVED (the gesture is turned into one asynchronously),
  // so a "touches no audio" row read straight after it is about a tap that happened.
  const clicks = () => b.evaluate(() => window.__clicks || 0);
  const tapAt = async ({ x, y }) => {
    const n0 = await clicks();
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return !!(await until(async () => (await clicks()) > n0 || null, 5000));
  };
  // What the screen is, for a row that has to say why it is red, and for tapUntil to know
  // whether a tap moved anything.
  const screen = () => b.evaluate(() => {
    const s = document.querySelector('#app > .hdr .scope');
    return { scope: s ? s.textContent.trim() : null,
             cards: document.querySelectorAll('#app .card').length,
             speakers: document.querySelectorAll('#app button.speak').length };
  });
  const said = (v) => `scope ${JSON.stringify(v.scope)}, ${v.cards} cards, ${v.speakers} speakers`;
  const where = (sel) => b.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);

  await goto(srv.base + '/index.html');
  await b.evaluate(() => { try { localStorage.clear(); } catch {} return null; });
  await goto(srv.base + '/index.html');
  is('the stubs are in place before the app runs', [], await log());

  // ── the first thing anyone does: tap ──────────────────────────────────────
  // The passkey screen's way past, found by its words: a plain tap on a plain button.
  const skip = await until(() => b.evaluate(() => {
    const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }), 8000);
  is('there is a first screen to tap', true, !!skip);
  if (skip) await tapAt(skip);
  is('a tap on the first screen touches no audio', [], await log());
  await until(() => b.evaluate(() => !!document.querySelector('#app .card')));
  // The header is chrome with nothing behind it: a tap on it is the purest "plain tap".
  const hdr = await where('#app > .hdr');
  // ...and it is the tap to count, since nothing behind it redraws: 1 is a tap. 2 is the
  // double delivery tapAt describes, whose second click lands on whatever the first drew;
  // 0 is a tap that never arrived, which would make every "touches no audio" row vacuous.
  const c0 = await clicks();
  if (hdr) await tapAt(hdr);
  is('a tap is one click', 1, (await clicks()) - c0);
  is('a tap on the Projects header touches no audio', [], await log());

  // Into a session, by tapping — two more plain taps, a project then a session card.
  // EACH SCREEN IS WAITED FOR AS AN END STATE, never for a fixed beat: on a loaded macOS
  // runner the grid was not drawn half a second after the project tap, the card query found
  // nothing, and the row went red on a client that was fine. The grid is known by its
  // header scope (`project:…`, as grip-check asks) AND a card on it, because a card alone
  // can still be the Projects card on its way out.
  const onGrid = () => b.evaluate(() =>
    /:/.test((document.querySelector('#app > .hdr .scope') || {}).textContent || '')
    && !!document.querySelector('#app .card'));
  // A TAP CAN ALSO BE LOST, not just late: a screen that re-renders between the press and
  // the release (a poll landing mid-tap) replaces the node and no click fires. So a tap
  // that has not arrived is tapped again — but ONLY while the screen it was aimed at is
  // still the one showing. A screen that has moved on is waited for, never tapped again: a
  // second tap there lands on the NEXT screen's card and skips the one the row asks about,
  // which is the same failure the double click in tapAt was. One deadline for the whole
  // step, and a miss says what was on screen when it ran out.
  async function tapUntil(sel, arrived, ms = 15000) {
    const t0 = Date.now();
    let taps = 0, from = null, last = 0;
    while (Date.now() - t0 < ms) {
      const v = await arrived();
      if (v) return { v };
      const here = await screen();
      if (!taps || (here.scope === from && Date.now() - last > 5000)) {
        const at = await where(sel);
        if (at) { from = here.scope; last = Date.now(); taps++; await tapAt(at); continue; }
      }
      await sleep(100);
    }
    return { why: `no: ${taps} tap(s) on ${sel} in ${ms / 1000}s, and then ${said(await screen())}` };
  }
  is('there is a project card to open', true, !!(await until(() => where('#app .card'))));
  const grid = await tapUntil('#app .card', onGrid);
  is('there is a session card to open', true, grid.v ? true : grid.why);
  const spk = grid.v ? await tapUntil('#app .card', () => where('#app button.speak')) : { why: 'no: never reached the grid' };
  is('opening a project and a session touches no audio', [], await log());
  is('the session has a speaker on a bubble', true, spk.v ? true : spk.why);
  // Scrolling and tapping around in a transcript is the other thing a reader does.
  const bub = await where('#app .turn .bub, #app .turn');
  if (bub) await tapAt(bub);
  is('a tap on a message touches no audio', [], await log());

  // ── the speaker DOES unlock, and inside its own tap ───────────────────────
  if (spk.v) {
    await clear();
    // Synchronously within the click handler: what the log holds the instant the event
    // is delivered, before any timer or fetch the speech path goes on to start.
    const inTap = await b.evaluate(() => new Promise(res => {
      const s = document.querySelector('#app button.speak');
      s.addEventListener('click', () => res(window.__audio.slice()), { once: true });
      s.click();
    }));
    is('the speaker tap creates the audio context inside the tap', true, inTap.includes('new AudioContext'));
    is('...and resumes it inside the tap',                           true, inTap.includes('resume'));
    is('...and primes the device voice inside the tap',              true, inTap.some(x => x.startsWith('speak:')));
    is('...and takes the playback session for the voice',           true, inTap.includes('audioSession.type=playback'));
    // The stub utterance ends after 50ms; the speech path falls back to it in fixture mode.
    const after = await until(async () => { const l = await log(); return l.includes('close') ? l : null; }, 8000) || await log();
    is('when the voice ends the context is closed',                  true, after.includes('close'));
    is('...and the session is handed back as mixable',              'audioSession.type=auto',
       after.filter(x => x.startsWith('audioSession.type=')).pop() || '(never set)');
    await clear();
    const bub2 = await where('#app .turn .bub, #app .turn');
    if (bub2) await tapAt(bub2);
    is('a tap after the voice ended touches no audio again', [], await log());
  }

  // ── talk holds the most exclusive session there is, and gives it back ─────
  // getUserMedia is refused (the stub below), which is one of the ways a conversation ends
  // on its own — through talkStop(), the same exit the `stop` button takes.
  const talk = await where('#app .composer button.talk');
  if (!talk) {
    skipGroup('talk releases the audio session', 'no talk button in the fixture session');
  } else {
    await b.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
      window.__audio.length = 0; return null;
    });
    await tapAt(talk);
    const t = await until(async () => { const l = await log(); return l.filter(x => x.startsWith('audioSession.type=')).length >= 3 ? l : null; }, 8000) || await log();
    const types = t.filter(x => x.startsWith('audioSession.type='));
    is('the talk tap takes play-and-record', true, types.includes('audioSession.type=play-and-record'));
    is('...and when talk stops the session is handed back as mixable', 'audioSession.type=auto', types.pop() || '(never set)');
    is('...with every context it opened closed', t.filter(x => x === 'new AudioContext').length, t.filter(x => x === 'close').length);
  }
} catch (e) {
  is('audio-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
}
done(0);
