#!/usr/bin/env node
// test/helpers/csp-images.mjs — a picture attached to the composer shows its preview, and a sentence
// the machine speaks loads as the phone holds it, on the page fleet-serve serves, under the policy
// fleet-serve sends; and that policy lets in nothing more.
//
//     node test/helpers/csp-images.mjs <base>       one "name <US> want <US> got" row per check
//     CSP_SHOTS=<dir> node test/helpers/csp-images.mjs <base>   ...and the composer at 390 and 1280
//
// `base` is a running fleet-serve that serves this checkout's web/ (test/run.sh starts one).
//
// WHY AGAINST THE DAEMON AND NOT A STATIC SERVER. Every other browser check of the client serves
// web/ from lib/browser.mjs serveDir, which sends no Content-Security-Policy at all — so a preview
// the real page refuses drew perfectly there, and the bug lived on the phone and the desk with
// every row green. The policy is a header, and only the server that sends it can be asked.
//   The page runs on DEMO DATA here (gf.base = 'fixtures', the client's own escape hatch for a page
// the daemon serves), so it needs no passkey and no fleet; the header is still the daemon's. Demo
// data refuses the upload itself (there is no disk to put a file on), so the chip says it was not
// uploaded — the preview is drawn from the picked File before and whether or not an upload lands,
// which is exactly the part under test.
//   THE OTHER HALF IS WHAT STAYS OUT. Each probe below is refused by the policy, and the row says so
// only when the browser reported a violation of it — a load that failed for another reason (a
// closed port) is not a refusal, and would otherwise pass a policy that allowed everything.
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from '../../lib/browser.mjs';

const BASE = String(process.argv[2] || '').replace(/\/$/, '');
const SHOTS = process.env.CSP_SHOTS || '';
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// Before any of the page's own code: demo data on the daemon's page, and a record of every
// violation the policy reports.
const INIT = `(() => {
  try { localStorage.setItem('gf.base', 'fixtures'); } catch {}
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' ' + String(e.blockedURI || '').split(':')[0]));
})();`;

let b = null;
const errors = [];
const until = async (fn, ...a) => {
  for (let i = 0; i < 150; i++) { const v = await b.evaluate(fn, ...a).catch(() => null); if (v) return v; await sleep(100); }
  return null;
};
const size = (w, h) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
const save = (name, data) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64')); };

try {
  if (!BASE) throw new Error('usage: csp-images.mjs <base>');
  b = await launch({ width: 1280, height: 800, scale: 2, mobile: false });
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').split('\n')[0]);
  });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await b.call('Page.navigate', { url: BASE + '/' });
  await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
  await b.evaluate(() => [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey/i.test(x.textContent))?.click());
  is("the daemon's page runs, on demo data", true, !!(await until(() => !!document.querySelector('.app'))));

  // ── a picture attached to the composer, at a phone's width and a desk's ─────────────────
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    await size(w, h);
    await b.evaluate(() => { location.hash = '#/settings'; });
    await sleep(300);
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/docs-pass'; });
    const box = await until(() => !!document.querySelector('form.composer'));
    is(`${w} the session's composer is drawn`, true, !!box);
    // The session keeps a picked file across leaving it, so the last width's chip is still here:
    // taken off first, or this width's rows would pass on a picture another width attached.
    await b.evaluate(() => { for (const x of document.querySelectorAll('form.composer .att-x')) x.click(); });
    is(`${w} ...with no picture attached yet`, true, !!(await until(() => !document.querySelector('form.composer .att'))));
    await b.evaluate(() => { window.__csp.length = 0; });
    // A real PNG, made by the page, dropped on the composer the way a person drops one: the same
    // addFiles a paste and the file picker go through.
    await b.evaluate(() => new Promise((done) => {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const x = c.getContext('2d'), gr = x.createLinearGradient(0, 0, 96, 96);
      gr.addColorStop(0, '#5fd7d7'); gr.addColorStop(1, '#1d3b4f');
      x.fillStyle = gr; x.fillRect(0, 0, 96, 96);
      x.fillStyle = '#f2c94c'; x.beginPath(); x.arc(64, 34, 16, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#0d1014'; x.beginPath(); x.moveTo(0, 96); x.lineTo(40, 48); x.lineTo(70, 80); x.lineTo(96, 60); x.lineTo(96, 96); x.fill();
      c.toBlob((blob) => {
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
        document.querySelector('form.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        done(true);
      }, 'image/png');
    }));
    await until(() => { const i = document.querySelector('form.composer .att img'); return !!i && i.complete; });
    await sleep(200);
    const got = await b.evaluate(() => {
      const i = document.querySelector('form.composer .att img');
      return { chips: document.querySelectorAll('form.composer .att').length,
               src: i ? i.src.split(':')[0] : '(no preview)', w: i ? i.naturalWidth : 0, csp: window.__csp.join(', ') };
    });
    is(`${w} one chip, for the picture just dropped`, 1, got.chips);
    is(`${w} the chip's preview is the picture itself, from a blob: URL`, 'blob', got.src);
    is(`${w} ...and it shows: the browser decoded it`, 96, got.w);
    is(`${w} ...and the page's policy refused nothing on the way`, '', got.csp);
    if (SHOTS) {
      save(`composer-image-${w}`, (await b.call('Page.captureScreenshot', { format: 'png' })).data);
      const r = await b.evaluate(() => { const q = document.querySelector('form.composer').getBoundingClientRect(); return { x: q.left, y: q.top, width: q.width, height: q.height }; });
      save(`composer-image-${w}-closeup`, (await b.call('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data);
    }
  }

  // ── and nothing wider than that ─────────────────────────────────────────────────────────
  const probe = (kind) => b.evaluate((k) => new Promise((done) => {
    window.__csp.length = 0;
    const pick = () => window.__csp.join(', ');
    let el;
    if (k === 'script') {
      el = document.createElement('script');
      el.src = URL.createObjectURL(new Blob(['window.__ranFromBlob = 1;'], { type: 'text/javascript' }));
    } else {
      el = new Image();
      if (k === 'data') { const c = document.createElement('canvas'); c.width = c.height = 4; el.src = c.toDataURL('image/png'); }
      else el.src = 'http://127.0.0.1:9/elsewhere.png';
    }
    const end = (how) => setTimeout(() => done({ how, csp: pick(), ran: !!window.__ranFromBlob }), 150);
    el.onload = () => end('loaded'); el.onerror = () => end('failed');
    if (k === 'script') document.head.appendChild(el);
    setTimeout(() => end('timed out'), 4000);
  }), kind);
  const verdict = (p, directive) => p.how === 'loaded' || p.ran ? `loaded (${p.csp || 'no violation'})`
    : new RegExp(`^${directive}\\b`).test(p.csp) ? 'refused by the policy' : `${p.how}, with no violation reported (${p.csp})`;
  is('a data: image is still refused', 'refused by the policy', verdict(await probe('data'), 'img-src'));
  is("an image from another origin is still refused", 'refused by the policy', verdict(await probe('elsewhere'), 'img-src'));
  is("a blob: script is still refused: script is 'self' alone", 'refused by the policy', verdict(await probe('script'), 'script-src(-elem)?'));

  // ── a sentence the machine speaks, as the phone client holds it ─────────────────────────
  // web/src/adapter.js fetches each sentence with the bearer token and gives the <audio> a blob:
  // URL; voice.js unlocks its one element with a silent blob: clip. A real 16-bit mono WAV, made
  // here the way those are, so a refusal is the policy's and never a file the browser could not
  // decode. Loading is asked, not playing: a headless browser's autoplay rule is not the policy.
  const sound = (kind) => b.evaluate((k) => new Promise((done) => {
    window.__csp.length = 0;
    const n = 1600, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    const a = new Audio(); a.preload = 'auto';
    let over = false;
    const end = (how) => { if (over) return; over = true; setTimeout(() => done({ how, csp: window.__csp.join(', ') }), 150); };
    a.onloadedmetadata = () => end('loaded'); a.onerror = () => end('failed');
    if (k === 'blob') a.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    else if (k === 'data') a.src = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...new Uint8Array(buf)));
    else a.src = 'http://127.0.0.1:9/elsewhere.wav';
    a.load();
    setTimeout(() => end('timed out'), 4000);
  }), kind);
  const heard = await sound('blob');
  is("a sentence's audio as the phone holds it, a blob: WAV, loads", 'loaded', heard.how);
  is('...and the policy refused nothing on the way', '', heard.csp);
  is('a data: sound is still refused', 'refused by the policy', verdict(await sound('data'), 'media-src'));
  is('a sound from another origin is still refused', 'refused by the policy', verdict(await sound('elsewhere'), 'media-src'));

  is('no page error, anywhere on the way', '', errors.join(' | '));
} catch (e) {
  if (/no chrome/.test(String(e?.message))) is('csp-images ran to the end', 'yes', `no chrome: ${e.message}`);
  else is('csp-images ran to the end', 'yes', String(e?.stack || e).split('\n').slice(0, 2).join(' '));
} finally {
  try { await b?.close(); } catch {}
}
console.log(rows.join('\n'));
process.exit(0);
