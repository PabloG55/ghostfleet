// lib/browser.mjs — a headless Chrome, and the smallest client that can drive one.
//
// Lifted OUT of test/helpers/viewport-check.mjs rather than copied beside it. That file
// has driven a real browser for 502 assertions since #48, including a hand-rolled
// WebSocket written because the global one arrived in node 22 and this package targets
// node >= 18 (CI pins 20 on purpose, to keep testing the floor).
//
// HONESTLY: there are still two copies today. viewport-check.mjs keeps its own, because
// converging a helper that carries 502 assertions in the same change that introduces a
// new command would put both at risk at once and leave no clean thing to bisect against.
// This module is the copy `bin/fleet-look.mjs` uses; folding viewport-check onto it is
// the next step, and the suite is what will prove that move when it happens. The comment
// says two rather than one so the next reader is not told a tidier story than the tree.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── is there a Chrome ─────────────────────────────────────────────────────
export function findChrome() {
  const named = process.env.CHROME || process.env.CHROME_PATH;
  // AN EXPLICIT CHROME THAT IS NOT THERE IS AN ERROR, not a hint. The first version put
  // $CHROME at the head of a candidate list and fell through when it did not exist, so
  // setting it to a wrong path silently ran a DIFFERENT browser — the caller believes it
  // is measuring the build it named and is measuring another one. Found by writing the
  // test for "no chrome": the case could not be simulated, because there was no way to
  // turn Chrome off. That it was untestable was the symptom.
  if (named && !(() => { try { return fs.statSync(named).isFile(); } catch { return false; } })()) return null;
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
// ── a browser, with its own profile and its own debugging port ────────────
// Port 0 and a fresh profile, for the reason the suite already documents about ports:
// two workers photographing at once must not land on each other, and a shared profile is
// the same trap wearing a different name.
//
// It THROWS rather than exiting. A library that calls process.exit decides its caller's
// error handling for it — the suite wants a skip-with-a-reason, fleet-look wants a
// message on stderr, and only the caller knows which.
export async function launch({ width = 1280, height = 800, scale = 2, mobile = false } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('no chrome: not found in the usual places (set CHROME=<path>)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-browser-'));
  let chromeErr = '';
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (d) => { chromeErr += String(d); });
  chrome.on('error', (e) => { chromeErr += String((e && e.message) || e); });
  const close = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  // Chrome writes the port it chose into the profile; polling for that file is the only
  // way to learn it when you asked for 0. Thirty seconds, not ten — a runner starting
  // Chrome under load is slower than a laptop starting it idle.
  let devtools = '';
  for (let i = 0; i < 600 && !devtools; i++) {
    try {
      const [port, pathPart] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (port && pathPart) devtools = `ws://127.0.0.1:${port.trim()}${pathPart.trim()}`;
    } catch {}
    if (!devtools) await sleep(50);
  }
  if (!devtools) { close(); throw new Error('no chrome: did not start in 30s ' + chromeErr.split('\n')[0].slice(0, 120)); }

  let ws;
  try { ws = await connect(devtools); }
  catch (e) { close(); throw new Error('no chrome: ' + String((e && e.message) || e)); }
  const { targetId } = await ws.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await ws.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p = {}) => ws.send(m, p, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });

  const evaluate = async (fn, ...args) => {
    const src = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    const r = await call('Runtime.evaluate', { expression: src, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate threw');
    return r.result && r.result.value;
  };
  return { call, evaluate, close, chromePath,
           viewport: (w, h) => call('Emulation.setDeviceMetricsOverride',
             { width: w, height: h, deviceScaleFactor: scale, mobile }) };
}

// ── a static server on a port the OS picks ────────────────────────────────
// The same port-0 discipline: a fixed one measures whatever else is listening.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
export async function serveDir(root, indexFile = 'index.html') {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const p = path.join(root, rel === '/' ? indexFile : rel.replace(/^\/+/, ''));
    if (!path.resolve(p).startsWith(path.resolve(root))) { res.writeHead(403); return res.end(); }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { try { server.close(); } catch {} } };
}
