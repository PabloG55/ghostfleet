#!/usr/bin/env node
// flow-review-check — drive the recorded-run review page and print what it did.
//
// WHY DRIVEN: every part of this page that can be wrong looks right in the markup. A chapter
// list whose clicks land at 0:00 (a server that answers a byte range with the whole file)
// draws perfectly; so does a key handler that approves the flow while you type a note; so
// does a two-column layout that overflows a phone sideways. Each is one keystroke or one
// resize away, and none of them is findable by reading.
//
// THE REAL PAGE, OVER file://, which is how a run folder is opened now that the loopback
// server is retired (reviews in the app are reviews-check's). `fleet-shots page` writes it
// with this checkout's generator, so a test with its own renderer cannot pass against code
// nobody ships. Seeking over file:// is the browser's own; byte ranges on the served path
// are asserted against fleet-serve by reviews-api-check. The video is synthetic (ffmpeg's test pattern) because
// the page's job is to play whatever the recorder wrote; the recorder itself is exercised
// by "fleet-shots walks a flow".
//
// Emits `name\x1f want\x1f got` rows, or one `#SKIP` row naming what is missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, findChrome, sleep } from '../../lib/browser.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(`${name}${US}${want}${US}${got}`);
const skip = (why) => { console.log(`#SKIP${US}${US}${why}`); process.exit(0); };

if (!findChrome()) skip('no chrome to click in');
let enc = '';
try { enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch { skip('ffmpeg is not installed, so there is no video to play'); }
const x264 = /\blibx264\b/.test(enc);
if (!x264 && !/\blibvpx-vp9\b/.test(enc)) skip('ffmpeg is here, but its h264 and vp9 encoders are not available');

// A ROOT THIS FILE OWNS, so the run is the only thing in it and the cleanup takes it all.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-flowrev-'));
const dir = path.join(root, 'run1');
fs.mkdirSync(dir);
const video = x264 ? 'flow.mp4' : 'flow.webm';
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', 'testsrc=size=390x844:rate=25:duration=9', '-pix_fmt', 'yuv420p',
  ...(x264 ? ['-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart'] : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime']),
  path.join(dir, video)], { stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  provenance: { commit: '0'.repeat(40), branch: 'api-fix', dirty: false, base: 'http://127.0.0.1:1',
                viewport: { width: 390, height: 844 }, at: '2026-01-01T00:00:00.000Z' },
  video, duration: 9, problems: 1,
  steps: [
    { n: 1, name: 'the sign-in screen', start: 0, end: 3.2, file: null, url: 'http://127.0.0.1:1/login', notes: [], requests: [] },
    { n: 2, name: 'after signing in', start: 3.2, end: 6.1, file: null, url: 'http://127.0.0.1:1/login',
      notes: ['POST http://127.0.0.1:1/api/v1/signin answered 404'], requests: [] },
    { n: 3, name: 'a clean screen', start: 6.1, end: 9, file: null, url: 'http://127.0.0.1:1/clean', notes: [], requests: [] },
  ],
}));

const bin = new URL('../../bin/fleet-shots.mjs', import.meta.url).pathname;
execFileSync(process.execPath, [bin, 'page', dir], { stdio: 'ignore' });
const url = 'file://' + path.join(dir, 'index.html');

const verdict = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')); } catch { return {}; } };
// THE CHANNEL OVER file:// IS THE PASTE: the page builds the text, `fleet-shots verdict` stores
// it. So every verdict row below goes through both halves, exactly as a reviewer's would.
const paste = () => b.evaluate(() => (document.getElementById('verdicttext') || {}).value || '');
const record = async () => { const t = await paste(); try { execFileSync(process.execPath, [bin, 'verdict', dir], { input: t, stdio: ['pipe', 'ignore', 'ignore'] }); } catch {} return t; };
const check = () => { try { execFileSync(process.execPath, [bin, '--check', dir], { stdio: 'ignore' }); return 0; } catch (e) { return e.status ?? 9; } };
const KEYS = { ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'], ' ': [32, 'Space'], a: [65, 'KeyA'], r: [82, 'KeyR'] };

let b = null;
try {
  b = await launch({ width: 1440, height: 900, scale: 1 });
  const key = async (k) => {
    const [code, name] = KEYS[k];
    const text = k.length === 1 ? k : undefined;
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: name, windowsVirtualKeyCode: code, text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code });
    await sleep(250);
  };
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await b.evaluate(fn); if (v) return v; await sleep(100); } return v; };
  const at = () => b.evaluate(() => ({ t: document.getElementById('v').currentTime, n: (document.querySelector('.ch.here') || {}).dataset?.n }));
  const near = (t, want) => Math.abs(t - want) < 0.35;

  await b.call('Page.navigate', { url });
  const loaded = await until(() => document.getElementById('v') && document.getElementById('v').readyState >= 1 && document.getElementById('v').duration);
  is('the video loads, at its real length', 'yes', loaded && Math.abs(loaded - 9) < 0.5 ? 'yes' : `no: duration ${loaded}`);
  is('the page wears the phone client\'s background', 'rgb(11, 13, 16)', await b.evaluate(() => getComputedStyle(document.body).backgroundColor));
  is('three chapters are listed', '3', String(await b.evaluate(() => document.querySelectorAll('.ch').length)));

  // THE SEEKS. Each must land where its chapter starts AND the list must say so.
  await key('ArrowRight'); await until(() => !document.getElementById('v').seeking);
  let p = await at();
  is('→ moves to chapter 2', '2', String(p.n));
  is('...and the video is at its start', 'yes', near(p.t, 3.2) ? 'yes' : `no: ${p.t.toFixed(2)}s`);
  await key('ArrowRight'); await until(() => !document.getElementById('v').seeking);
  p = await at();
  is('→ again moves to chapter 3, at 6.1s', '3:yes', `${p.n}:${near(p.t, 6.1) ? 'yes' : p.t.toFixed(2)}`);
  await key('ArrowLeft'); await until(() => !document.getElementById('v').seeking);
  p = await at();
  is('← steps back to chapter 2', '2:yes', `${p.n}:${near(p.t, 3.2) ? 'yes' : p.t.toFixed(2)}`);
  await b.evaluate(() => document.querySelectorAll('.ch .top')[0].click());
  await until(() => !document.getElementById('v').seeking);
  p = await at();
  is('a click on a chapter seeks to it', '1:yes', `${p.n}:${near(p.t, 0) ? 'yes' : p.t.toFixed(2)}`);

  // PLAY AND PAUSE, and the clock moves while it plays.
  await key(' ');
  const t1 = (await at()).t; await sleep(900); const t2 = (await at()).t;
  is('space plays', 'yes', (await b.evaluate(() => !document.getElementById('v').paused)) && t2 > t1 + 0.3 ? 'yes' : `no: ${t1.toFixed(2)}→${t2.toFixed(2)}`);
  await key(' ');
  is('...and space pauses', 'yes', (await b.evaluate(() => document.getElementById('v').paused)) ? 'yes' : 'no');

  // THE VERDICT. `a` over a flagged chapter with no reason is recorded, the gate says it
  // will still refuse, and the cursor is taken to where the reason goes.
  await key('a'); await sleep(300);
  is('a approves the flow, into the text to paste', 'yes', /^- \[approve\] flow/m.test(await record()) ? 'yes' : 'no');
  is('...which fleet-shots verdict stores', 'approve', String((verdict().flow || {}).v));
  is('...but the gate says a flagged chapter needs a reason', 'yes', (await b.evaluate(() => /still refuses/.test(document.getElementById('gate').textContent))) ? 'yes' : 'no');
  is('...and the note box of that chapter has the cursor', '2', String(await b.evaluate(() => document.activeElement?.closest?.('.ch')?.dataset.n)));
  is('...so --check refuses', '1', String(check()));
  // TYPING IS NOT A KEY: `r` inside the note must not reject the flow.
  await b.call('Input.insertText', { text: 'r' });
  await key('r');
  await sleep(300);
  await record();
  is('typing r into a note does not reject', 'approve', String((verdict().flow || {}).v));
  await b.evaluate(() => { const t = document.activeElement; t.value = 'the 404 is the fixture'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  await record();
  is('the chapter note lands in verdict.json', 'the 404 is the fixture', String((verdict().chapters || {})['2'] || ''));
  is('...and now --check passes', '0', String(check()));
  await b.evaluate(() => document.activeElement.blur());
  await key('r'); await sleep(300);
  await record();
  is('r rejects the flow', 'reject:1', `${(verdict().flow || {}).v}:${check()}`);
  // A RELOAD KEEPS THE REVIEW, not a blank one (over file:// it is this browser's own copy).
  await b.call('Page.reload'); await until(() => document.getElementById('state'));
  await sleep(300);
  is('a reload shows the stored verdict', 'rejected', String(await b.evaluate(() => document.getElementById('state').textContent)));

  // THE LAYOUT: beside at a desk width, stacked on a phone, never sideways.
  const lay = () => b.evaluate(() => {
    const v = document.querySelector('.player').getBoundingClientRect(), c = document.querySelector('.chapters').getBoundingClientRect();
    return { beside: v.right <= c.left + 1 && c.top < v.bottom, stacked: c.top >= v.bottom - 1,
             wide: document.documentElement.scrollWidth, w: innerWidth };
  });
  let l = await lay();
  is('at 1440 the video is beside the chapters', 'yes', l.beside ? 'yes' : JSON.stringify(l));
  await b.viewport(390, 844); await sleep(400);
  l = await lay();
  is('at 390 the chapters stack under the video', 'yes', l.stacked ? 'yes' : JSON.stringify(l));
  is('...and nothing scrolls sideways', 'yes', l.wide <= l.w ? 'yes' : `no: ${l.wide} > ${l.w}`);
} catch (e) {
  is('flow-review-check ran', 'yes', `no: ${String(e.message || e).slice(0, 200)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(rows.join('\n'));
