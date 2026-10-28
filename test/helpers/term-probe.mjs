#!/usr/bin/env node
// test/helpers/term-probe.mjs — the web terminal's server half, against a real fleet-serve
// and the suite's own tmux server, with a synthetic passkey (serve-client.mjs).
//
//     node test/helpers/term-probe.mjs <base> <enrolment-code> <project> <sock>
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing. Every gate is
// asserted in BOTH directions, because a gate that refuses everything passes every refusal
// row: each refusal below sits next to the same request with only the missing thing put
// back, and that one has to succeed.
//
// What it cannot see is a browser — that is test/helpers/term-check.mjs. This is the half a
// `curl` would test, which is exactly the half a lock in the UI cannot defend.
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Authenticator } from './serve-client.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const CODE = process.argv[3] || '';
const PROJECT = process.argv[4] || 'demo';
const SOCK = process.argv[5] || `cf-${PROJECT}`;
const U = new URL(BASE);
const ORIGIN = U.origin;

const tmux = (...a) => { try { return execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const hasTab = (name) => { try { execFileSync('tmux', ['-L', SOCK, 'has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const capture = (name) => tmux('capture-pane', '-p', '-t', name);
async function until(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(step); }
}

// ── a WebSocket client, by hand, so the Origin can be anything ─────────────────
// The suite's node is 20 (CI pins the floor) and its global WebSocket is not one whose
// Origin a test may choose; refusing a wrong origin is a row here, so the client has to be
// able to send one.
function wsOpen(path, { origin = ORIGIN, host = U.host } = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.connect(Number(U.port), U.hostname);
    let buf = Buffer.alloc(0), head = null;
    const msgs = [], bins = [];
    const ws = { status: 0, msgs, bins, closed: false, closeCode: 0, closeWhy: '', sock: s,
      text() { return Buffer.concat(bins).toString('utf8'); },
      send(op, data) {
        const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const mask = crypto.randomBytes(4);
        const len = p.length < 126 ? Buffer.from([0x80 | p.length]) : (() => { const b = Buffer.alloc(3); b[0] = 0x80 | 126; b.writeUInt16BE(p.length, 1); return b; })();
        const m = Buffer.from(p); for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
        s.write(Buffer.concat([Buffer.from([0x80 | op]), len, mask, m]));
      },
      type(str) { this.send(2, Buffer.from(str, 'utf8')); },
      ctl(o) { this.send(1, JSON.stringify(o)); },
      close() { this.send(8, Buffer.from([0x03, 0xe8])); },
    };
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`));
    s.on('error', () => { if (!head) resolve(ws); });
    s.on('close', () => { ws.closed = true; if (!head) resolve(ws); });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!head) {
        const e = buf.indexOf('\r\n\r\n');
        if (e < 0) return;
        head = buf.subarray(0, e).toString('latin1');
        ws.status = Number(head.split(' ')[1]) || 0;
        ws.body = buf.subarray(e + 4).toString('utf8');
        buf = ws.status === 101 ? buf.subarray(e + 4) : Buffer.alloc(0);
        resolve(ws);
      }
      if (ws.status !== 101) return;
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + len) return;
        const data = buf.subarray(at, at + len); buf = buf.subarray(at + len);
        if (op === 1) { try { msgs.push(JSON.parse(data.toString('utf8'))); } catch {} }
        else if (op === 2) bins.push(Buffer.from(data));
        else if (op === 8) { ws.closeCode = data.length >= 2 ? data.readUInt16BE(0) : 0; ws.closeWhy = data.subarray(2).toString('utf8'); }
        else if (op === 9) ws.send(10, data);
      }
    });
  });
}

const a = new Authenticator({ rpId: U.hostname, origin: ORIGIN });
const reg = await a.enroll(BASE, CODE);
is('term: the probe enrolled', 200, reg.status);
const H = (assertion) => ({ headers: assertion ? { 'x-fleet-assertion': JSON.stringify(assertion) } : {} });
const open = async (assertion, body = { project: PROJECT, cols: 90, rows: 25 }) => a.api(BASE, 'POST', '/api/term/open', body, H(assertion));
const TAB = `_term-${PROJECT}`;

// ── 1. OFF BY DEFAULT, PER DEVICE ───────────────────────────────────────────────
const st0 = await a.api(BASE, 'GET', '/api/term');
is('term: a new device has the terminal off', false, st0.json && st0.json.enabled);
const offOpen = await open(await a.fresh(BASE, 'terminal'));
is('term: a disabled device is refused, with a fresh passkey in hand', 403, offOpen.status);
is('...and told the thing to do about it', 'enable', offOpen.json && offOpen.json.needs);
is('...and no tab was made for it', false, hasTab(TAB));
// Switching ON is a grant: it takes a fresh passkey. Without one, refused and still off.
const enNo = await a.api(BASE, 'POST', '/api/term/enable', { on: true });
is('term: switching it on without a fresh passkey is refused', 401, enNo.status);
is('...and it stays off', false, (await a.api(BASE, 'GET', '/api/term')).json.enabled);
const enYes = await a.api(BASE, 'POST', '/api/term/enable', { on: true }, H(await a.fresh(BASE, 'terminal on')));
is('term: switching it on with one works', 200, enYes.status);
is('...and the server says so', true, (await a.api(BASE, 'GET', '/api/term')).json.enabled);

// ── 2. A FRESH ASSERTION, EVERY OPEN ────────────────────────────────────────────
const noA = await open(null);
is('term: an open with no fresh passkey is refused', 401, noA.status);
is('...naming the passkey as what is missing', 'passkey', noA.json && noA.json.needs);
const used = await a.fresh(BASE, 'terminal');
const first = await open(used);
is('term: an open with a fresh passkey is allowed', 200, first.status);
is('...and it names the project\'s terminal tab', TAB, first.json && first.json.session);
is('...which exists on the fleet\'s own server', true, hasTab(TAB));
const replay = await open(used);
is('term: the same assertion a second time is refused (single-use challenge)', 401, replay.status);

// ── 3. THE UPGRADE: origin, ticket, single use ──────────────────────────────────
const tk = (r) => `/api/term/ws?ticket=${encodeURIComponent((r.json && r.json.ticket) || '')}`;
const r2 = await open(await a.fresh(BASE, 'terminal'));
const evil = await wsOpen(tk(r2), { origin: 'http://evil.example' });
is('term: a WebSocket from another origin is refused', 403, evil.status);
const r3 = await open(await a.fresh(BASE, 'terminal'));
const noOrigin = await wsOpen(tk(r3), { origin: '' });
is('term: a WebSocket with no Origin at all is refused', 403, noOrigin.status);
const forged = await wsOpen('/api/term/ws?ticket=not-a-ticket');
is('term: a WebSocket with no live ticket is refused', 401, forged.status);
// The good one: same everything, right origin, fresh ticket.
const r4 = await open(await a.fresh(BASE, 'terminal'));
const ws = await wsOpen(tk(r4));
is('term: the right origin with a live ticket upgrades', 101, ws.status);
const again = await wsOpen(tk(r4));
is('term: that ticket cannot be used twice', 401, again.status);
// The refused ones never became tmux clients. Only the good one did.
await until(() => ws.msgs.some(m => m.t === 'ready'));
is('term: the bridge reports ready', true, ws.msgs.some(m => m.t === 'ready'));
const clients = () => tmux('list-clients', '-t', TAB, '-F', '#{client_control_mode}').split('\n').filter(Boolean).length;
is('term: exactly one control client is on the tab', 1, clients());

// ── 4. TYPED INPUT REACHES THE PANE, AND OUTPUT COMES BACK ───────────────────────
const MARK = `web-term-${crypto.randomBytes(3).toString('hex')}`;
ws.type(`echo ${MARK}-$((6*7))\r`);
const landed = await until(() => capture(TAB).includes(`${MARK}-42`));
is('term: typed input reached the pane (capture-pane on the suite server)', true, !!landed);
is('...and the shell\'s output came back over the socket', true, !!(await until(() => ws.text().includes(`${MARK}-42`))));
// UTF-8, which crosses tmux as two bytes on two %output lines more often than not.
ws.type('echo été\r');
is('term: UTF-8 survives the round trip', true, !!(await until(() => capture(TAB).includes('été\n') || /été\s*$/m.test(capture(TAB)))));

// ── 5. RESIZE PROPAGATES ────────────────────────────────────────────────────────
const size = () => tmux('display-message', '-p', '-t', TAB, '#{window_width}x#{window_height}').trim();
is('term: the tab took the size the open asked for', '90x25', await until(() => size() === '90x25' && size()) || size());
ws.ctl({ t: 'resize', cols: 61, rows: 17 });
is('term: a resize message resizes the window', '61x17', await until(() => size() === '61x17' && size()) || size());
ws.ctl({ t: 'resize', cols: 100000, rows: -3 });
await sleep(300);
is('...and a nonsense size is ignored, not applied', '61x17', size());

// ── 6. A CLOSED SOCKET ENDS CLEANLY ─────────────────────────────────────────────
ws.close();
await until(() => ws.closed, 4000);
is('term: the browser closing gets a clean close back', 1000, ws.closeCode);
is('...and the control client leaves the tab', 0, await until(() => clients() === 0 && 0, 4000) ?? clients());
is('...while the tab itself stays, for the desk', true, hasTab(TAB));
const health = await a.api(BASE, 'GET', '/api/health');
is('...and the server is still answering', 200, health.status);

// A socket that just DROPS (no close frame) is the phone going to sleep.
const r5 = await open(await a.fresh(BASE, 'terminal'));
const drop = await wsOpen(tk(r5));
await until(() => drop.msgs.some(m => m.t === 'ready'));
drop.sock.destroy();
is('term: a dropped socket also takes its control client with it', 0, await until(() => clients() === 0 && 0, 4000) ?? clients());

// ── 7. SWITCHED OFF WHILE OPEN ───────────────────────────────────────────────────
const r6 = await open(await a.fresh(BASE, 'terminal'));
const live = await wsOpen(tk(r6));
await until(() => live.msgs.some(m => m.t === 'ready'));
const off = await a.api(BASE, 'POST', '/api/term/enable', { on: false });
is('term: switching it off needs no passkey', 200, off.status);
await until(() => live.closed, 4000);
is('...and closes the terminal that was open', 4003, live.closeCode);
const offAgain = await open(await a.fresh(BASE, 'terminal'));
is('...and the next open is refused again', 403, offAgain.status);

// ── 8. THE IDLE CLOSE (the suite sets terminal_idle low) ─────────────────────────
await a.api(BASE, 'POST', '/api/term/enable', { on: true }, H(await a.fresh(BASE, 'terminal on')));
const r7 = await open(await a.fresh(BASE, 'terminal'));
const idle = await wsOpen(tk(r7));
await until(() => idle.msgs.some(m => m.t === 'ready'));
const hello = idle.msgs.find(m => m.t === 'hello') || {};
await until(() => idle.closed, (Number(hello.idle) || 3) * 1000 + 6000);
is('term: a terminal nobody types into is closed', 4000, idle.closeCode);
is('...saying why', true, /idle/.test(idle.closeWhy));
is('...and the tab outlives it', true, hasTab(TAB));

console.log(rows.join('\n'));
console.log('#MARK' + US + MARK);
process.exit(0);
