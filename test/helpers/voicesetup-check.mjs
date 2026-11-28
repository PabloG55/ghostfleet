#!/usr/bin/env node
// test/helpers/voicesetup-check.mjs — "Voice isn't set up on <machine>": the sheet speak mode
// opens when the machine serving the app cannot hear, in a real browser at a phone's width and
// at a desk's.
//
//     node test/helpers/voicesetup-check.mjs            rows for test/run.sh
//     SHOTS=<dir> node test/helpers/voicesetup-check.mjs   ...and a PNG of each, for a look
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// WHAT IT PINS, against web/fixtures/jarvis.json in the fixture backend (web/api.js), whose
// machine has no whisper.cpp and no Kokoro — the case the sheet exists for:
//   - turning speak mode on opens a SHEET on a phone (anchored to the bottom, full width) and a
//     DIALOG at a desk (centred), over the session, moving nothing in it;
//   - it names the machine, says why it cannot hear, and shows the command that fixes each half
//     as a line of its own;
//   - nothing listens until the person chooses: the device's dictation is a button on it, and
//     closing it turns speak mode back off rather than leaving it on and deaf.
// Watched red against the client before the sheet (no sheet opens, so every row after the first
// fails on it), and with `sheet` taken off its Modal (the phone row fails on its anchor alone).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const SHOTS = process.env.SHOTS || '';
const done = (code) => { process.stdout.write(rows.join('\n') + (rows.length ? '\n' : '')); process.exit(code); };

// A recogniser this file controls, so "nothing listened" is a count and not a hope.
const STUBS = `(() => {
  window.__rec = { starts: 0 };
  window.SpeechRecognition = window.webkitSpeechRecognition = function () {
    const r = this; r.start = () => { window.__rec.starts++; }; r.stop = () => { setTimeout(() => r.onend && r.onend(), 10); }; r.abort = () => {};
  };
})();`;

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    b = await launch({ width: 1280, height: 800, scale: 1, mobile: false });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { process.stdout.write('no chrome\n'); process.exit(0); }
    throw e;
  }
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') console.error('page threw:', ((p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text)) || '').split('\n')[0]);
  });
  const base = srv.base;
  async function until(cond, ms = 6000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }
  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
  const sheet = () => b.evaluate(() => {
    const m = document.querySelector('.scrim > .modal');
    if (!m || !m.querySelector('.voice-setup')) return null;
    const r = m.getBoundingClientRect();
    return {
      sheet: m.classList.contains('sheet'), title: ((m.querySelector('header h2') || {}).textContent || '').trim(),
      left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top),
      vw: innerWidth, vh: innerHeight,
      text: m.textContent,
      cmds: [...m.querySelectorAll('.vs-cmd code')].map(x => x.textContent.trim()),
      buttons: [...m.querySelectorAll('.voice-setup footer button')].map(x => x.textContent.trim()),
    };
  });
  const composer = () => b.evaluate(() => { const c = document.querySelector('.session > .composer'); if (!c) return null; const r = c.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; });
  const speakLabel = () => b.evaluate(() => document.querySelector('.speak-btn')?.getAttribute('aria-label') || '');

  async function fresh(size) {
    await b.call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.scale, mobile: size.touch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: size.touch, ...(size.touch ? { maxTouchPoints: 5 } : {}) });
    await b.call('Page.navigate', { url: base + '/index.html' });
    await sleep(400);
    await b.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return null; });
    await b.call('Page.navigate', { url: base + '/index.html' });
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => /^continue without a passkey/i.test(x.textContent.trim()));
      if (e) e.click();
      return !!document.querySelector('.app .main');
    }), 10000);
    await sleep(300);
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/types'; return null; });
    await until(() => b.evaluate(() => !!document.querySelector('.speak-btn')), 8000);
    await sleep(400);
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }

  const sizes = [['phone', { w: 390, h: 844, touch: true, scale: 2 }], ['desk', { w: 1280, h: 800, touch: false, scale: 1 }]];
  for (const [at, size] of sizes) {
    await step(`${at} · the sheet`, async () => {
      await fresh(size);
      const before = await composer();
      await b.evaluate(() => { document.querySelector('.speak-btn').click(); return null; });
      // ...and once its slide-up (ui.css sheet-up, 0.22 s) has finished, or the anchor is mid-flight.
      const s = (await until(sheet, 4000)) && (await sleep(450), await sheet());
      is(`${at} · speak mode on a machine that cannot hear opens the voice sheet`, true, !!s);
      is(`${at} · ...titled with the machine it is about`, 'Voice isn’t set up on laptop', (s && s.title) || '');
      is(`${at} · ...saying why it cannot hear`, true, /no whisper\.cpp on this machine/.test((s && s.text) || ''));
      is(`${at} · ...and its reason without the command glued on`, false, /no whisper\.cpp on this machine — run:/.test((s && s.text) || ''));
      is(`${at} · ...with the command for each half as a line of its own`, ['fleet-jarvis voice --install', 'fleet-jarvis voice --kokoro --install'], (s && s.cmds) || []);
      is(`${at} · ...saying replies are read with the device's voice meanwhile`, true, /read with this device’s own voice/.test((s && s.text) || ''));
      is(`${at} · ...offering the device's dictation as a choice`, ['Close', 'Use this device’s dictation'], (s && s.buttons) || []);
      is(`${at} · ...while nothing listens`, 0, await b.evaluate(() => window.__rec.starts));
      if (at === 'phone') {
        is('phone · it is a sheet: full width, anchored to the bottom', true, !!s && s.sheet && s.left === 0 && s.right === s.vw && Math.abs(s.bottom - s.vh) <= 1);
      } else {
        is('desk · it is a dialog: centred, not full width, not on the bottom edge', true, !!s && s.left > 40 && s.vw - s.right > 40 && s.vh - s.bottom > 20);
      }
      is(`${at} · ...and it moves nothing in the session under it`, JSON.stringify(before), JSON.stringify(await composer()));
      await shot(`${at}-voice-setup`);
    });
    await step(`${at} · closing it`, async () => {
      await b.evaluate(() => { [...document.querySelectorAll('.voice-setup footer button')].find(x => x.textContent.trim() === 'Close')?.click(); return null; });
      is(`${at} · Close takes the sheet away`, true, !!(await until(async () => !(await sheet()), 3000)));
      is(`${at} · ...and turns speak mode back off, rather than on and deaf`, 'Speak mode', await until(async () => ((await speakLabel()) === 'Speak mode' ? 'Speak mode' : null), 3000));
      is(`${at} · ...having listened to nothing`, 0, await b.evaluate(() => window.__rec.starts));
    });
    await step(`${at} · choosing dictation`, async () => {
      await b.evaluate(() => { document.querySelector('.speak-btn').click(); return null; });
      await until(sheet, 4000);
      await b.evaluate(() => { [...document.querySelectorAll('.voice-setup footer button')].find(x => /dictation/.test(x.textContent))?.click(); return null; });
      is(`${at} · choosing the device's dictation listens with it`, true, !!(await until(() => b.evaluate(() => window.__rec.starts >= 1), 3000)));
      is(`${at} · ...with speak mode on`, 'Turn speak mode off', await speakLabel());
      await b.evaluate(() => { document.querySelector('.speak-btn').click(); return null; });
      await sleep(200);
      await b.evaluate(() => { document.querySelector('.speak-btn').click(); return null; });
      await sleep(500);
      is(`${at} · ...and, chosen once, it is not asked again on this page`, false, !!(await sheet()));
      await b.evaluate(() => { document.querySelector('.speak-btn').click(); return null; });
    });
  }
} catch (e) {
  is('voicesetup-check ran to the end', 'yes', String((e && e.stack) || e).split('\n')[0].slice(0, 200));
} finally {
  try { if (b) await b.close(); } catch {}
  try { if (srv) await srv.close(); } catch {}
}
done(0);
