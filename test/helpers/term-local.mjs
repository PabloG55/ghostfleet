#!/usr/bin/env node
// test/helpers/term-local.mjs — the web terminal's WebSocket, judged by the listener it
// arrives on.
//
//     node test/helpers/term-local.mjs <fleet-serve.mjs> <port> <tailnet-host> <tailnet-origin> <project>
//
// Run with the daemon's own HOME and GHOSTFLEET_SERVE_CONFIG, against the two-listener
// daemon test/run.sh builds for serve-local.mjs: ::1 standing in for the tailnet bind, and
// 127.0.0.1 answering to `localhost:<port>`. One "name <US> want <US> got" row per check.
//
// Two rules, each beside its mirror, because a gate that refuses everything passes every
// refusal row:
//   ORIGIN  the upgrade takes the localhost origin only on the 127.0.0.1 listener and the
//           tailnet origin only on the tailnet one. Its mirror is the same upgrade with the
//           listener's own origin, which gets PAST the origin gate. A bogus ticket then
//           answers 401, and that is the gate's verdict, not the ticket's.
//   TICKET  a ticket minted by /api/term/open on one listener does not upgrade on the other.
//           Its mirror is a fresh ticket from the same listener, which upgrades (101).
// The refusals are asserted by their REASON as well as their status. Every one of these is
// a 401 or 403 on a broken daemon too, for some other reason, and the status alone would
// pass.
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Authenticator } from './serve-client.mjs';

const [serveJs, port, tailHost, tailOrigin, project] = process.argv.slice(2);
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });
const enrolCode = (id) => (execFileSync(process.execPath, [serveJs, 'enroll', id], { encoding: 'utf8' })
  .match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];

const TAIL = { base: `http://[::1]:${port}`, addr: '::1', host: tailHost, origin: tailOrigin };
const LOCAL = { base: `http://127.0.0.1:${port}`, addr: '127.0.0.1', host: `localhost:${port}`, origin: `http://localhost:${port}` };

// The upgrade's answer: status line and body, then hang up. A 101 is closed at once; the
// bridge sees the socket go and ends itself.
function upgrade(L, ticket, origin) {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), L.addr);
    let buf = '';
    const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(5000, () => done({ status: 0, body: 'timeout' }));
    s.on('error', (e) => done({ status: 0, body: e.code || e.message }));
    s.on('connect', () => s.write(`GET /api/term/ws?ticket=${encodeURIComponent(ticket)} HTTP/1.1\r\nHost: ${L.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      const e = buf.indexOf('\r\n\r\n');
      if (e < 0) return;
      const status = Number(buf.split(' ')[1]) || 0;
      if (status === 101) return done({ status, body: '' });
      const want = Number((/content-length:\s*(\d+)/i.exec(buf) || [])[1] || 0);
      if (buf.length - e - 4 >= want) done({ status, body: buf.slice(e + 4).trim() });
    });
    s.on('close', () => done({ status: Number(buf.split(' ')[1]) || 0, body: buf.slice(buf.indexOf('\r\n\r\n') + 4).trim() }));
  });
}

// One enrolled device per listener, its terminal switched on (a grant: a fresh passkey).
async function device(L, id, rpId) {
  const a = new Authenticator({ rpId, origin: L.origin, host: L.host });
  const r = await a.enroll(L.base, enrolCode(id));
  is(`term ${id}: enrolled on its own listener`, 200, r.status);
  const on = await a.api(L.base, 'POST', '/api/term/enable', { on: true },
    { headers: { 'x-fleet-assertion': JSON.stringify(await a.fresh(L.base, 'terminal on')) } });
  is(`term ${id}: the terminal is switched on`, 200, on.status);
  return a;
}
const mac = await device(LOCAL, 'mac', 'localhost');
const phone = await device(TAIL, 'phone', tailHost);
async function ticket(a, L) {
  const r = await a.api(L.base, 'POST', '/api/term/open', { project, cols: 80, rows: 24 },
    { headers: { 'x-fleet-assertion': JSON.stringify(await a.fresh(L.base, 'terminal')) } });
  return (r.json && r.json.ticket) || `(open said ${r.status}: ${(r.json && r.json.text) || ''})`;
}

// ── ORIGIN: the other listener's is as foreign as any site's ────────────────────
const u1 = await upgrade(LOCAL, 'not-a-ticket', TAIL.origin);
is('term: the tailnet origin is refused on the localhost listener', 403, u1.status);
is('...by the origin gate', 'yes', /origin '.*' is not configured for this listener/.test(u1.body) ? 'yes' : u1.body);
const u2 = await upgrade(LOCAL, 'not-a-ticket', LOCAL.origin);
is('...while the localhost origin gets past it there', 'yes', u2.status === 401 && /no live terminal ticket/.test(u2.body) ? 'yes' : `${u2.status} ${u2.body}`);
const u3 = await upgrade(TAIL, 'not-a-ticket', LOCAL.origin);
is('term: the localhost origin is refused on the tailnet listener', 403, u3.status);
is('...by the origin gate', 'yes', /origin '.*' is not configured for this listener/.test(u3.body) ? 'yes' : u3.body);
const u4 = await upgrade(TAIL, 'not-a-ticket', TAIL.origin);
is('...while the tailnet origin gets past it there', 'yes', u4.status === 401 && /no live terminal ticket/.test(u4.body) ? 'yes' : `${u4.status} ${u4.body}`);

// ── TICKET: good on the listener that minted it, and nowhere else ───────────────
// Each crossing upgrade carries the RIGHT origin and Host for the socket it is sent to, so
// the only thing wrong with it is where the ticket came from.
const t1 = await ticket(phone, TAIL);
const x1 = await upgrade(LOCAL, t1, LOCAL.origin);
is('term: a ticket minted on the tailnet does not upgrade at localhost', 403, x1.status);
is('...because it was minted on the other listener', 'yes', /minted on the other listener/.test(x1.body) ? 'yes' : x1.body);
const t2 = await ticket(mac, LOCAL);
const x2 = await upgrade(TAIL, t2, TAIL.origin);
is('term: a ticket minted at localhost does not upgrade on the tailnet', 403, x2.status);
is('...because it was minted on the other listener', 'yes', /minted on the other listener/.test(x2.body) ? 'yes' : x2.body);
// Spent by the refusal, as #89 spends every ticket it looks at: taking it back to its own
// listener does not revive it.
is('...and a ticket refused there is spent, not handed back', 401, (await upgrade(TAIL, t1, TAIL.origin)).status);
const y1 = await upgrade(LOCAL, await ticket(mac, LOCAL), LOCAL.origin);
is('term: a localhost ticket upgrades at localhost', 101, y1.status);
const y2 = await upgrade(TAIL, await ticket(phone, TAIL), TAIL.origin);
is('term: a tailnet ticket upgrades on the tailnet', 101, y2.status);

console.log(rows.join('\n'));
