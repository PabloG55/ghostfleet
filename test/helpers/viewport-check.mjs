#!/usr/bin/env node
// test/helpers/viewport-check.mjs — the page does not scroll sideways. Measured, in a
// real engine, at a real phone width.
//
//     node test/helpers/viewport-check.mjs        # "name <US> want <US> got" rows
//
// docs/mobile.md has said since #48 that ONE region scrolls and the page never moves
// sideways — wide content scrolls inside its own overflow-x box. It was a rule somebody
// had to keep. Reported from an iPhone on v11, in photographs: the send button rendering
// "senc" with its last character past the edge, the ⋯ half off the right, and — with the
// actions sheet open — every element displaced about 40px left, the back chevron gone and
// the labels reading "ne fleet.s lead" and "esc back". One page, scrolled.
//
// A STYLESHEET CANNOT BE CHECKED BY READING IT. Whether a flex row fits is the product of
// font metrics, padding, the shrink rules and the actual strings, and the only thing that
// knows the answer is a layout engine. So this one drives a real headless Chrome over the
// DevTools protocol — against a real static server — and asks the only question that
// matters:
//
//     document.documentElement.scrollWidth <= clientWidth
//
// on every screen, at 390x844 and at 320x568. The narrow case is not hypothetical padding:
// it is an SE-sized phone, and it is where a row that merely fits becomes a row that does
// not.
//
// AND IT PROVES ITSELF FIRST. The last section loads a page that is deliberately 900px
// wide inside a 390px viewport and asserts that this same measurement REPORTS it. Without
// that, "no overflow anywhere" is a sentence a broken probe says just as fluently as a
// working one — and this whole file is one measurement repeated, so if the measurement is
// blind every row in it is decoration.
//
// Skipped, not failed, where there is no Chrome: it prints one row saying so and
// test/run.sh turns that into a skip. The suite's promise is that it needs no
// dependencies, and this is the one check that cannot keep it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
// A GROUP THAT CANNOT RUN SAYS SO. test/run.sh turns this line into a `skip` with the
// reason attached — the same precedent as skipping the whole file where there is no
// Chrome. A skipped group that says why beats a green one that proved nothing, and beats
// a weakened assertion that proves less than its name claims.
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };

// ── is there a Chrome ─────────────────────────────────────────────────────
function findChrome() {
  const named = process.env.CHROME || process.env.CHROME_PATH;
  const tries = [named,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
  for (const t of tries) { try { if (fs.statSync(t).isFile()) return t; } catch {} }
  return null;
}
const CHROME = findChrome();
if (!CHROME) { is('a browser to measure in', 'found', 'no chrome'); done(0); }

// ── a static server for web/, on a port the OS picks ──────────────────────
// Port 0 and read back what was assigned, because the suite is explicitly allowed to run
// twice at once (CLAUDE.md) and a fixed port is the same trap as a fixed tmux socket:
// the second run does not fail, it measures the first one's server.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const OVERFLOWING = `<!doctype html><meta name=viewport content="width=device-width">
<style>html,body{margin:0}#w{width:900px;height:50px;background:#333}</style><div id=w>wide</div>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // The control case: a page that really is wider than the phone. Served from here rather
  // than written to web/, so nothing ships it and nothing precaches it.
  if (u.pathname === '/__overflowing') { res.setHeader('content-type', 'text/html'); res.end(OVERFLOWING); return; }
  const f = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, ''));
  if (!f.startsWith(WEB)) { res.statusCode = 403; res.end('no'); return; }
  fs.readFile(f, (e, b) => {
    if (e) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.end(b);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── a browser, with its own profile and its own debugging port ────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-viewport-'));
// stderr is KEPT, because the one thing worse than a browser that will not start is a
// browser that will not start and will not say why: this went red on both CI legs with
// nothing but "the browser started: false" to go on.
let chromeErr = '';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => { chromeErr += String(d); });
chrome.on('error', (e) => { chromeErr += String((e && e.message) || e); });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// Chrome writes the port it chose into the profile; polling for the file is the only way
// to learn it when you asked for 0.
// Thirty seconds, not ten. A CI runner starting Chrome under load is slower than a laptop
// starting it idle, and the first version's ten was a laptop number.
let devtools = '';
for (let i = 0; i < 600 && !devtools; i++) {
  try {
    const [port, pathPart] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
    if (port && pathPart) devtools = `ws://127.0.0.1:${port.trim()}${pathPart.trim()}`;
  } catch {}
  if (!devtools) await sleep(50);
}
// A browser that will not start is an ENVIRONMENT, not a regression — the same class as
// having no Chrome at all — so it skips rather than reddening a suite about something
// else. The reason travels with it, which is the part that was missing.
if (!devtools) {
  is('a browser to measure in', 'found', 'no chrome: did not start in 30s ' + chromeErr.split('\n')[0].slice(0, 120));
  cleanup(); done(0);
}

// ── the smallest CDP client that can drive a page ─────────────────────────
// WITH ITS OWN WEBSOCKET, on a raw socket, and that is not showing off. The first version
// used the global `WebSocket` and both CI legs went red on the line that constructs it:
// that global arrived in node 22 and this package targets node >= 18, which the workflow
// deliberately holds it to by pinning 20. A test helper that needs a newer runtime than
// the thing it tests is a test that does not run where it matters, and raising CI's node
// to suit it would have stopped CI testing the floor at all.
//   Only what CDP needs: a text frame out (masked, as a client must), a text frame in
// (never masked, possibly split across reads or across continuation frames), and a pong so
// a keepalive ping does not look like a hang.
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', reject);
    let buf = Buffer.alloc(0), open = false, frag = Buffer.alloc(0);
    const onText = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error('handshake refused: ' + head.split('\r\n')[0])); return; }
        buf = buf.slice(end + 4); open = true;
        resolve(api);
      }
      // Frames, for as long as a whole one is in the buffer.
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + len) return;                       // the rest is still in flight
        const payload = buf.slice(at, at + len);
        buf = buf.slice(at + len);
        if (opcode === 0x9) { sock.write(frame(payload, 0xa)); continue; }   // ping -> pong
        if (opcode === 0x8) { try { sock.end(); } catch {} return; }         // close
        if (opcode === 0x1 || opcode === 0x0) {
          frag = Buffer.concat([frag, payload]);
          if (fin) { const text = frag.toString('utf8'); frag = Buffer.alloc(0); for (const f of onText) f(text); }
        }
      }
    });
    // A client frame is always masked; the mask is four random bytes XORed over the body.
    function frame(payload, opcode = 0x1) {
      const mask = crypto.randomBytes(4);
      const body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      const n = body.length;
      const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n])
        : n < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 0xfe]), u16(n)])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0xff]), u64(n)]);
      return Buffer.concat([head, mask, body]);
    }
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
    const api = {
      onMessage: (f) => onText.push(f),
      send: (text) => sock.write(frame(Buffer.from(text, 'utf8'))),
      close: () => { try { sock.end(); } catch {} },
    };
  });
}

async function connect(wsUrl) {
  const ws = await wsConnect(wsUrl);
  let id = 0; const waits = new Map();
  ws.onMessage(data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    waits.set(i, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => ws.close() };
}
// A browser that will not be driven is an environment, not a regression: say so and let
// run.sh skip, the same as having no Chrome at all.
let browserWs;
try { browserWs = await connect(devtools); }
catch (e) { is('a browser to measure in', 'found', 'no chrome: ' + String((e && e.message) || e)); cleanup(); done(0); }
const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await browserWs.send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p = {}) => browserWs.send(m, p, sessionId);
await call('Page.enable');
await call('Runtime.enable');
// FOCUS EMULATION, because a headless browser is not a focused one. Element.focus() only
// takes when the page is CONSIDERED focused, and a headless window on the macOS runner is
// never activated while the Linux one is — so document.activeElement never became the
// textarea there and every keyboard assertion downstream of it collapsed, on one leg and
// not the other. Located by the measurement that makes it unmistakable: this file passes on
// macOS LOCALLY and failed on macOS in CI. Identical code reading as broken on a platform
// and being nothing of the kind is the same shape as CLAUDE.md's tmux 3.4-against-3.7b
// split, and this is the switch that exists for it.
//   Whether it was ACCEPTED is recorded, because a refused switch has to skip the keyboard
// group with a reason rather than assert something weaker in its place.
let focusEmulated = false;
try { await call('Emulation.setFocusEmulationEnabled', { enabled: true }); focusEmulated = true; }
catch (e) { focusEmulated = String((e && e.message) || e).slice(0, 80); }
try { await call('Page.bringToFront'); } catch {}

const evaluate = async (fn, ...args) => {
  const r = await call('Runtime.evaluate', {
    expression: `(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};
const viewport = (w, h) => call('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: 2, mobile: true });
const goto = async (u) => { await call('Page.navigate', { url: u }); await sleep(900); };

// ── the measurement, and it is the only one ───────────────────────────────
const OVERFLOW = () => {
  const d = document.documentElement;
  const over = d.scrollWidth - d.clientWidth;
  // ...and WHICH element, because "the page is 40px too wide" is not something anyone can
  // act on. Anything whose box ends past the viewport, named.
  const past = [...document.querySelectorAll('#app *, #sheet *')]
    .map(n => ({ n, r: n.getBoundingClientRect() }))
    .filter(({ n, r }) => r.width > 0 && r.right > d.clientWidth + 0.5 &&
      // A scroll container is ALLOWED to hold something wider than itself — that is the
      // rule, not a breach of it. Only report a node whose own nearest scroller is the page.
      // A SCROLLER is allowed to hold something wider than itself — that is the rule.
      // `clip` is NOT on this list and must not be: the app clips at the body as a
      // backstop, and counting that as permission would make this probe blind to
      // everything inside the app, which is everything it is for. Measured: with clip
      // treated as a scroller, a grid track ten pixels too wide reported clean.
      !(function scrolls(el) {
        for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
          const o = getComputedStyle(e).overflowX;
          if (o === 'auto' || o === 'scroll') return true;
        }
        return false;
      })(n))
    .slice(0, 4)
    .map(({ n, r }) => `${n.tagName.toLowerCase()}.${String(n.className || '').split(' ')[0]}@${Math.round(r.right)}`);
  // The regions that lay content out horizontally and must never need more room than they
  // have. Not the pane, which is a terminal and scrolls sideways on purpose.
  // NOT `.sheet`: it is `overflow: auto`, so content wider than it scrolls INSIDE it,
  // which is the rule rather than a breach of it. Everything below lays out horizontally
  // and has nowhere to put the excess.
  const boxes = ['.cards', '.chat', '.composer', '.sbar', '.verbs', '.seg', '.srow', '.sheet .row']
    .flatMap(sel => [...document.querySelectorAll(sel)]
      .filter(n => n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 1)
      .map(n => `${sel} needs ${Math.round(n.scrollWidth)} in ${Math.round(n.clientWidth)}`))
    .slice(0, 4);
  return { over, past, boxes };
};

const clickText = (t) => evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(t));
  if (!b) return false; b.click(); return true;
}, t);
const escSheet = () => evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /esc\s+back/.test(x.textContent));
  if (b) b.click(); return null;
});
const tapCard = (re) => evaluate((re) => {
  const c = [...document.querySelectorAll('#app .card')]
    .find(n => new RegExp(re).test(n.textContent.replace(/\s+/g, ' ')));
  if (!c) return false;
  for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: 5, clientY: 5 }));
  return true;
}, re);

async function walk(w, h) {
  await viewport(w, h);
  await goto(BASE);
  await evaluate(() => { try { localStorage.clear(); } catch {} return null; });
  await goto(BASE);
  await sleep(700);
  // THE TEXT LADDER, because one size is not a sweep. iOS Dynamic Type does not stop at
  // the ordinary sizes: the accessibility ones take body text to about 53px, which is where
  // the reporter has it, and it is why the original screenshots looked like arbitrary
  // clipping. Every screen is walked at every rung — the ceiling is 53 because that is
  // iOS's largest (AX5), chosen rather than assumed.
  const LADDER = [16, 24, 30, 38, 44, 53];
  const at = async (label) => {
    for (const fs of LADDER) {
      await evaluate((fs) => { document.body.style.fontSize = fs + 'px'; return null; }, fs);
      await sleep(90);
      const m = await evaluate(OVERFLOW);
      is(`${w}px/${fs} ${label}: the page does not scroll sideways`, 0, m.over);
      is(`${w}px/${fs} ${label}: ...and every row fits its own box`, '', m.boxes.join(','));
    }
    await evaluate(() => { document.body.style.fontSize = ''; return null; });
    await sleep(60);
    const { over, past, boxes } = await evaluate(OVERFLOW);
    is(`${w}px ${label}: the page does not scroll sideways`, 0, over);
    is(`${w}px ${label}: ...and nothing sits past the right edge`, '', past.join(','));
    // AND NO REGION HOLDS MORE THAN IT CAN SHOW. The two above go quiet the moment
    // something clips — which is what the backstop is for and exactly why they are not
    // enough on their own. A card list whose track is wider than its box is a real
    // overflow that clip merely hides, so it is asked directly.
    is(`${w}px ${label}: ...and the card list fits its own box`, '', boxes.join(','));
  };
  await at('lock');
  await clickText('continue without a passkey'); await sleep(800);
  await at('projects');
  // THE SHEETS, none of which the first version of this file ever opened — and the
  // settings one is where the worst of it was: #78's voice <select>, the per-project rows
  // and a resolved origin printed as prose, which is one unbreakable 480px word.
  await clickText(', settings'); await sleep(500);
  await at('projects/settings sheet');
  await escSheet(); await sleep(250);
  await tapCard('add project'); await sleep(500);
  await at('projects/add sheet');
  await escSheet(); await sleep(250);
  await tapCard('─ 1 acme-api '); await sleep(1100);
  await at('grid');
  await clickText('s schedule'); await sleep(500);
  await at('grid/schedule sheet');
  await escSheet(); await sleep(250);
  await tapCard('─ 2 api-fix '); await sleep(1500);
  await at('session/chat');
  // The two controls the photographs showed cut in half.
  const edges = await evaluate(() => {
    const d = document.documentElement;
    const go = [...document.querySelectorAll('.composer button')].pop();
    const dots = [...document.querySelectorAll('.sbar button')].find(b => b.textContent.trim() === '⋯');
    const r = (n) => (n ? Math.round(n.getBoundingClientRect().right) : null);
    return { vw: d.clientWidth, go: r(go), dots: r(dots), goText: go ? go.textContent.trim() : '' };
  });
  is(`${w}px the send button is inside the viewport`, true, edges.go != null && edges.go <= edges.vw);
  is(`${w}px ...and it is the whole word`, 'send', edges.goText);
  is(`${w}px the ⋯ button is inside the viewport`, true, edges.dots != null && edges.dots <= edges.vw);
  // A DRAFT THE HEIGHT OF A PARAGRAPH. render() rebuilds this box on every poll, so the
  // height has to be re-applied on render and not only on a keystroke.
  const grew = await evaluate(() => {
    const t = document.querySelector('.composer textarea');
    if (!t) return null;
    const one = Math.round(t.getBoundingClientRect().height);
    t.value = 'one line of a message\nand a second line of it\nand a third line as well';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return { one, many: Math.round(t.getBoundingClientRect().height) };
  });
  is(`${w}px the composer grows with the text`, true, !!grew && grew.many > grew.one + 8);
  await at('session/chat with a draft');
  await clickText('⋯'); await sleep(500);
  await at('session/actions sheet');
  await evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /esc\s+back/.test(x.textContent)); if (b) b.click(); return null; });
  await sleep(400);
  // ...AND IT IS STILL THAT TALL AFTER A RENDER, which is the half that was broken. The
  // grow ran on `input` and nowhere else, and render() rebuilds this element from the
  // stored draft with rows="1" on every poll — so a three-line message came back as one
  // line and a sliver of the second. Opening and closing the sheet is a render, which is
  // why it is measured here rather than beside the typing.
  const kept = await evaluate(() => {
    const t = document.querySelector('.composer textarea');
    return t ? { h: Math.round(t.getBoundingClientRect().height), lines: (t.value.match(/\n/g) || []).length + 1 } : null;
  });
  is(`${w}px ...and is still that tall after a re-render`, true,
     !!kept && kept.lines === 3 && !!grew && kept.h >= grew.many - 2);
  await clickText('pane'); await sleep(1200);
  await at('session/pane');
}

// ── the case the photographs are of ───────────────────────────────────────
// A phone with the text turned up. iOS Dynamic Type scales `-apple-system` text, and every
// control in the session bar was sized in `em` — so the row grew with somebody's reading
// preference until it no longer fit, and what fell off the end was the ⋯.
//   MEASURED, not imagined: at 320px with the body at 30px, `.who` and the mode chip had
// both already shrunk to zero and the row still needed 406px, of which `chat|pane` was 231.
// This is the row that was red before the fix, and the reason the chrome is sized in px.
async function bigText() {
  await viewport(320, 568);
  await goto(BASE);
  await evaluate(() => { try { localStorage.clear(); } catch {} return null; });
  await goto(BASE); await sleep(700);
  await clickText('continue without a passkey'); await sleep(800);
  await tapCard('─ 1 acme-api '); await sleep(1100);
  await tapCard('─ 2 api-fix '); await sleep(1500);
  await evaluate(() => { document.body.style.fontSize = '30px'; return null; });
  await sleep(400);
  const m = await evaluate(() => {
    const d = document.documentElement;
    const sbar = document.querySelector('.sbar');
    const go = [...document.querySelectorAll('.composer button')].pop();
    const dots = [...document.querySelectorAll('.sbar button')].find(b => b.textContent.trim() === '⋯');
    const r = (n) => (n ? Math.round(n.getBoundingClientRect().right) : null);
    return { vw: d.clientWidth, needs: sbar ? sbar.scrollWidth : null, go: r(go), dots: r(dots) };
  });
  is('320px, text at 30px: the header row still fits', true, m.needs != null && m.needs <= m.vw);
  is('...and the ⋯ is still on the screen', true, m.dots != null && m.dots <= m.vw);
  is('...and so is the send button', true, m.go != null && m.go <= m.vw);
  const { over, past } = await evaluate(OVERFLOW);
  is('...and the page still does not scroll sideways', 0, over);
  is('...with nothing past the right edge', '', past.join(','));
}

// ── the keyboard, which is what was actually being reported ───────────────
// "the scroll happens when I click on the text box to type, then the send gets bigger or I
// don't know". Every assertion in this file until now was for the keyboard-CLOSED case: it
// touched the composer only to measure it, never to focus it.
//
// THE SOFTWARE KEYBOARD IS NOT PART OF THE DYNAMIC VIEWPORT. On iOS the layout viewport
// does not change when the keyboard opens and `100dvh` does not shrink — only the VISUAL
// viewport does. So the shell column stayed full height, the keyboard covered its bottom,
// and Safari's only remaining move was to scroll the page to bring the focused composer
// into view. That page scroll is the thing being felt, and a page that scrolls at all will
// scroll sideways too the moment anything is marginally wide.
//
// WHAT THIS CAN AND CANNOT PROVE, stated rather than implied. It cannot open a software
// keyboard: no desktop engine has one. What it CAN do is reproduce the exact SHAPE iOS
// presents — layout viewport unchanged, visual viewport short by a keyboard's height, the
// composer focused — and assert that the app reacts to it: the column takes the visual
// viewport's height, the bottom safe-area inset collapses, and the page does not scroll in
// either axis. That is a test of our reaction, which is the part that was missing. Safari's
// own behaviour on the day remains Safari's.
// ── where the settings sheet stops fitting, stated rather than assumed ────
// `.sheet` is `overflow: auto`, so content wider than it scrolls INSIDE it and the page
// never moves — which is the rule, and why the sheet is not in the must-fit list. But a
// sheet you have to pan sideways to reach Save in is a bad sheet, so the size at which
// that starts is a number worth pinning rather than discovering.
//   MEASURED at 320px: it fits through 30px and needs 328 of 320 at 38. So 30 is the
// ceiling — chosen, not assumed — and above it the only promise is the one that matters,
// that the sheet takes the overflow itself instead of handing it to the page.
//   THIS NUMBER MOVES, AND THAT IS THE POINT OF ASSERTING IT. It was 38 until #82 gave the
// voice list more to say; the row went red on the rebase, which is how anyone found out
// that the sheet had got wider. Nothing is visually cut at 38 — every box is inside the
// sheet — it is scrollable by eight pixels, which is a finger's worth of pan on a screen
// that should not need one. Re-measure and restate it when the sheet gains content; do not
// delete the row to make it quiet.
async function sheetCeiling() {
  await viewport(320, 568);
  await goto(BASE);
  await evaluate(() => { try { localStorage.clear(); } catch {} return null; });
  await goto(BASE); await sleep(700);
  await clickText('continue without a passkey'); await sleep(800);
  await clickText(', settings'); await sleep(600);
  const at = async (fs) => {
    await evaluate((fs) => { document.body.style.fontSize = fs + 'px'; return null; }, fs);
    await sleep(120);
    return evaluate(() => {
      const sh = document.querySelector('.sheet');
      const d = document.documentElement;
      return { need: sh ? Math.round(sh.scrollWidth) : null, box: sh ? Math.round(sh.clientWidth) : null,
               scrolls: sh ? getComputedStyle(sh).overflowX : '', page: d.scrollWidth - d.clientWidth };
    });
  };
  for (const fs of [16, 24, 30]) {
    const m = await at(fs);
    is(`320px/${fs} the settings sheet fits without panning`, true, m.need != null && m.need <= m.box + 1);
  }
  // ...and past the ceiling, the promise that is left.
  const big = await at(38);
  is('320px/38 the settings sheet is past its ceiling, as documented', true, big.need > big.box + 1);
  is('...and takes the overflow itself', 'auto', big.scrolls);
  is('...rather than handing it to the page', 0, big.page);
  await evaluate(() => { document.body.style.fontSize = ''; return null; });
}

async function keyboard(w, h, { indicator = true } = {}) {
  await viewport(w, h);
  await goto(BASE);
  await evaluate(() => { try { localStorage.clear(); } catch {} return null; });
  await goto(BASE); await sleep(700);
  await clickText('continue without a passkey'); await sleep(800);
  await tapCard('─ 1 acme-api '); await sleep(1100);
  await tapCard('─ 2 api-fix '); await sleep(1500);
  const before = await evaluate(() => {
    const app = document.getElementById('app');
    return { appH: Math.round(app.getBoundingClientRect().height), innerH: innerHeight };
  });
  is(`${w}px keyboard closed: the column is the whole viewport`, true,
     Math.abs(before.appH - before.innerH) <= 2);
  // The keyboard, as iOS shapes it.
  const KB = 336;
  await evaluate((kb) => {
    const fake = { height: innerHeight - kb, width: innerWidth, offsetTop: 0, offsetLeft: 0,
                   pageTop: 0, pageLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
    const ta = document.querySelector('.composer textarea');
    if (ta) ta.focus();
    dispatchEvent(new Event('resize'));
    return null;
  }, KB);
  await sleep(350);
  const open = await evaluate(() => {
    const d = document.documentElement, app = document.getElementById('app');
    const ta = document.querySelector('.composer textarea');
    return {
      appH: Math.round(app.getBoundingClientRect().height),
      vvh: d.style.getPropertyValue('--vvh'),
      kbInset: d.style.getPropertyValue('--kb-inset'),
      kbClass: d.classList.contains('kb'),
      focused: !!ta && document.activeElement === ta,
      taBottom: ta ? Math.round(ta.getBoundingClientRect().bottom) : null,
      visible: (typeof visualViewport !== 'undefined' && visualViewport) ? Math.round(visualViewport.height) : null,
      overX: d.scrollWidth - d.clientWidth,
      scrollX: Math.round(scrollX || 0), scrollY: Math.round(scrollY || 0),
    };
  });
  // THE GUARD STAYS AN ASSERTION. Without it, "the poll is paused while the composer has
  // focus" would either fail for a reason nobody could see, or — worse — pass vacuously on
  // a page where nothing was ever focused. It is the row that turns this into a five-minute
  // diagnosis. If the browser genuinely will not give the page focus, the whole group skips
  // with that reason rather than asserting anything weaker.
  if (!open.focused) {
    skipGroup(`${w}px the keyboard group`,
      'focus does not stick in this browser; Emulation.setFocusEmulationEnabled: ' +
      (focusEmulated === true ? 'accepted but ineffective' : String(focusEmulated)));
    return;
  }
  is(`${w}px keyboard: the composer really has focus`, true, open.focused);
  // THE FIX. The column follows the visual viewport, so there is nothing below the fold for
  // the browser to go looking for.
  is(`${w}px keyboard: the column shrinks to what is visible`, true,
     open.visible != null && Math.abs(open.appH - open.visible) <= 2);
  is(`${w}px ...and it is driven by visualViewport, not dvh`, true, /^\d+px$/.test(open.vvh));
  // The bottom inset is for the home indicator and the keyboard covers the home indicator:
  // "you are leaving too much space between the text box and the bottom".
  is(`${w}px ...and the bottom safe-area inset collapses`, '0px', open.kbInset);
  is(`${w}px ...and the app says a keyboard is up`, true, open.kbClass);
  // The composer ends inside the visible area rather than under the keyboard, which is the
  // whole reason the page was being scrolled.
  is(`${w}px ...and the composer sits above the keyboard`, true,
     open.taBottom != null && open.visible != null && open.taBottom <= open.visible);
  // ...and neither axis moved.
  is(`${w}px keyboard: the page has not scrolled sideways`, 0, open.overX);
  is(`${w}px ...nor down`, 0, open.scrollY);
  is(`${w}px ...nor across`, 0, open.scrollX);
  const m = await evaluate(OVERFLOW);
  is(`${w}px keyboard: every row still fits its own box`, '', m.boxes.join(','));

  if (!indicator) return;
  // ── the thinking indicator, under a focused composer ────────────────────
  // #80 puts a three-dot bubble at the END of the transcript while a session is working,
  // and it comes and goes on the 5s poll with no minimum duration — a repeated height
  // change at the bottom of the very scroller this file and #72's scroll memory are both
  // about. Nobody had tested that combination, so it is tested here: a reader parked mid
  // conversation, the composer focused, the visual viewport shrunk, and the indicator
  // arriving AND leaving.
  //   The first half of the answer is that it cannot happen while you are typing at all —
  // #65's pollPaused() holds the poll for exactly as long as the composer has focus, so
  // the list is not rebuilt and the indicator does not move. That is asserted rather than
  // assumed, because it is the reason the rest is safe.
  const park = 300;
  await evaluate((top) => { const c = document.querySelector('#app > .chat'); if (c) c.scrollTop = top; return null; }, park);
  await sleep(250);
  const parked = await evaluate(() => {
    const c = document.querySelector('#app > .chat');
    return { top: Math.round(c.scrollTop), thinking: !!document.querySelector('.chat .thinking') };
  });
  is(`${w}px indicator: the reader is parked mid-conversation`, park, parked.top);
  is(`${w}px ...with the session working, so the dots are there`, true, parked.thinking);
  // Flip the fixture the client really reads, then give the poll longer than its interval.
  await evaluate(() => { try { localStorage.setItem('gf.fixture', 'grid-degraded.json'); } catch {} return null; });
  await sleep(6200);
  const held = await evaluate(() => {
    const c = document.querySelector('#app > .chat');
    const ta = document.querySelector('.composer textarea');
    return { top: Math.round(c.scrollTop), thinking: !!document.querySelector('.chat .thinking'),
             focused: document.activeElement === ta };
  });
  is(`${w}px ...the poll is paused while the composer has focus`, true, held.focused && held.thinking);
  is(`${w}px ...so nothing moved under the reader`, park, held.top);
  // Blur, and let it actually happen: the indicator LEAVES, the list is rebuilt, and #72's
  // scroll memory has to put the reader back where they were.
  await evaluate(() => { const ta = document.querySelector('.composer textarea'); if (ta) ta.blur(); return null; });
  await sleep(6200);
  const gone = await evaluate(() => {
    const c = document.querySelector('#app > .chat');
    return { top: Math.round(c.scrollTop), thinking: !!document.querySelector('.chat .thinking') };
  });
  is(`${w}px ...the indicator leaves once the poll resumes`, false, gone.thinking);
  is(`${w}px ...and the reader is still parked`, park, gone.top);
  // ...and back again, which is the other direction and the one a flicker would break.
  await evaluate(() => { try { localStorage.setItem('gf.fixture', 'grid-acme-api.json'); } catch {} return null; });
  await sleep(6200);
  const back = await evaluate(() => {
    const c = document.querySelector('#app > .chat');
    return { top: Math.round(c.scrollTop), thinking: !!document.querySelector('.chat .thinking') };
  });
  is(`${w}px ...the indicator comes back`, true, back.thinking);
  is(`${w}px ...and the reader is STILL parked`, park, back.top);
  await evaluate(() => { try { localStorage.setItem('gf.fixture', 'grid-acme-api.json'); } catch {} return null; });
}

try {
  await walk(390, 844);
  await walk(320, 568);
  // #78 unpinned rotation, and a landscape tablet is where the card grid switches to more
  // than one track — a different layout, and so a different chance to overflow.
  await walk(1024, 768);
  await bigText();
  await sheetCeiling();
  await keyboard(390, 844);
  await keyboard(320, 568, { indicator: false });

  // ── and the probe can see an overflow when there IS one ─────────────────
  // 900px of content in a 390px viewport. If this row is ever green, every row above it
  // means nothing: they are all this same measurement, and a blind one reports 0 forever.
  await viewport(390, 844);
  await goto(BASE + '/__overflowing');
  const control = await evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  is('a page that IS too wide is reported as too wide', true, control > 400);
  is('...by the same number the checks above read', 510, control);
} catch (e) {
  is('the walk completed', '', String((e && e.message) || e));
}
cleanup();
done(0);
