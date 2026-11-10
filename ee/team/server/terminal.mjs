// Team owns authentication and tickets; the normal client owns the terminal transport.
import crypto from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { can } from './access.mjs';
import { wsAccept, wsFrame, FrameReader, OP, ControlClient, STATE_FORMAT, parseState, repaint } from '../../../lib/web-term.mjs';

const fail = (status, text) => Object.assign(new Error(text), { status });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const size = (n, low, high, fallback) => Number.isInteger(n) && n >= low && n <= high ? n : fallback;
export const TERM_IDLE_MS = 30 * 60 * 1000;
export const TERM_TICKET_MS = 30 * 1000;

export function createTerminal({ fleet, demo = false, authenticate, allowedHost, audit,
  clock = () => Date.now(), idleMs = TERM_IDLE_MS, ticketMs = TERM_TICKET_MS, tickMs = 1000 }) {
  const tickets = new Map(), live = new Map();
  const authorize = (user, project) => {
    if (!user) throw fail(401, 'Log in again.');
    if (user.mustChange) throw fail(403, 'Change your temporary password first.');
    if (!can(user, project, 'prompt')) throw fail(404, 'No such project.');
  };
  const prune = () => { for (const [key, t] of tickets) if (t.exp <= clock()) tickets.delete(key); };
  const sweep = setInterval(prune, Math.max(1, Math.min(ticketMs, 30000)));
  sweep.unref();

  async function open(user, loginKey, body) {
    const { project, kind } = body || {};
    authorize(user, project);
    if (kind !== 'term' && kind !== 'edit') throw fail(400, "kind must be 'term' or 'edit'.");
    const tab = await fleet.openTerminal(project, kind);
    // The backend may yield while fleet-tab starts. A grant can disappear in that time.
    authorize(user, project);
    const ticket = crypto.randomBytes(32).toString('base64url');
    prune();
    tickets.set(sha(ticket), { ...tab, user: user.id, loginKey, project, kind, exp: clock() + ticketMs,
      cols: size(body.cols, 2, 500, 80), rows: size(body.rows, 1, 300, 24) });
    return { ok: true, project, kind, session: tab.session, ticket, ttl: ticketMs / 1000, idle: idleMs / 1000 };
  }

  async function upgrade(req, sock, head = Buffer.alloc(0)) {
    sock.on('error', () => {});
    const refuse = (status, text) => {
      const body = `${text}\n`;
      sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
        `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method !== 'GET' || url.pathname !== '/api/term/ws') throw fail(404, 'No WebSocket here.');
      if (!allowedHost(req.headers.host)) throw fail(403, 'Unexpected Host.');
      // Forwarded headers are client-controlled; the listener and its checked Host define
      // the origin, including the port. A proxy must preserve Host and terminate TLS here.
      const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== origin) throw fail(403, 'Origin must equal the app origin.');
      if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
          !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '')) throw fail(400, 'Invalid WebSocket upgrade.');
      const raw = url.searchParams.get('ticket') || '', key = sha(raw), t = tickets.get(key);
      tickets.delete(key);                 // spent even if authentication below refuses it
      if (!t || t.exp <= clock()) throw fail(401, 'No live terminal ticket. Open again.');
      const w = authenticate(req);
      if (!w || w.user.id !== t.user || w.key !== t.loginKey) throw fail(401, 'Ticket belongs to another login.');
      authorize(w.user, t.project);
      await fleet.checkTerminal(t);
      // checkTerminal may have waited for tmux; do not upgrade an expired or revoked login.
      const fresh = authenticate(req);
      if (!fresh || fresh.key !== t.loginKey || fresh.user.id !== t.user) throw fail(401, 'Log in again.');
      authorize(fresh.user, t.project);
      if (t.exp <= clock()) throw fail(401, 'Terminal ticket expired. Open again.');
      if (sock.destroyed) return;
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
      sock.setNoDelay(true);
      bridge(req, sock, t, head);
    } catch (e) { refuse(e.status || 502, e.status ? e.message : 'Could not attach the terminal.'); }
  }

  function bridge(req, sock, t, head) {
    const key = JSON.stringify([t.user, t.project, t.kind]);
    live.get(key)?.end(4001, 'Another connection took over this terminal.', 'takeover');
    const born = clock();
    let lastIO = born, lastPong = performance.now(), closed = false, ready = false, cc = null;
    const reader = new FrameReader(1 << 20);
    const write = (op, bytes) => {
      if (closed || sock.destroyed) return;
      if (op === OP.binary && bytes.length) lastIO = clock();
      if (!sock.write(wsFrame(op, bytes)) && cc && !cc.exited) {
        cc.proc.stdout.pause();
        sock.once('drain', () => { if (!closed) cc.proc.stdout.resume(); });
      }
    };
    const ctl = o => write(OP.text, JSON.stringify(o));
    const row = (verb, reason) => audit({ user: t.user, verb, project: t.project, kind: t.kind,
      subject: t.session, duration: Math.max(0, clock() - born) / 1000, ...(reason ? { reason } : {}), result: 'ran' });
    const b = { end(code, why, reason = 'connection') {
      if (closed) return;
      // Persist before publishing the close, so a completed attachment has both rows.
      row('terminal_close', reason);
      ctl({ t: 'closed', code, why });
      // 1006 is a local observation and must never appear on the wire.
      if (code !== 1006) {
        const words = Buffer.from(why).subarray(0, 120), payload = Buffer.alloc(2 + words.length);
        payload.writeUInt16BE(code); words.copy(payload, 2); write(OP.close, payload);
      }
      closed = true;
      clearInterval(tick);
      live.delete(key);
      cc?.close();
      sock.end();
      const backstop = setTimeout(() => sock.destroy(), 2000); backstop.unref();
    } };
    live.set(key, b);
    row('terminal_open');
    const tick = setInterval(() => {
      if (clock() - lastIO >= idleMs) return b.end(4000, 'Idle for 30 minutes. The tab is still open on the desk.', 'idle');
      const w = authenticate(req);
      if (!w || w.key !== t.loginKey || w.user.id !== t.user || w.user.mustChange || !can(w.user, t.project, 'prompt'))
        return b.end(4003, 'Your access changed. Log in or check project access.', 'access');
      // Transport liveness is monotonic: a wall-clock correction must not drop a browser.
      if (performance.now() - lastPong > 65000) return b.end(1001, 'The browser stopped answering.', 'heartbeat');
      write(OP.ping, Buffer.alloc(0));
    }, tickMs);
    tick.unref();
    const receive = chunk => {
      for (const m of reader.push(chunk)) {
        if (closed) return;
        if (m.error) return b.end(m.code, m.error, 'protocol');
        if (m.op === OP.close) return b.end(1000, 'Closed by the browser.', 'browser');
        if (m.op === OP.ping) { write(OP.pong, m.data); continue; }
        if (m.op === OP.pong) { lastPong = performance.now(); continue; }
        if (m.op === OP.binary) {
          if (m.data.length) lastIO = clock();
          if (ready) { if (demo) write(OP.binary, m.data); else cc.send(m.data); }
          continue;
        }
        let o;
        try { o = JSON.parse(m.data.toString('utf8')); } catch { continue; }
        if (o?.t === 'resize') {
          const cols = size(o.cols, 2, 500, 0), rows = size(o.rows, 1, 300, 0);
          if (cols && rows && !demo) cc.resize(cols, rows).catch(() => {});
        }
      }
    };
    sock.on('data', receive);
    sock.on('end', () => b.end(1006, 'The connection dropped.'));
    sock.on('close', () => b.end(1006, 'The connection dropped.'));
    sock.on('error', () => b.end(1006, 'The connection failed.'));
    ctl({ t: 'hello', project: t.project, kind: t.kind, session: t.session, idle: idleMs / 1000 });
    if (demo) {
      write(OP.binary, Buffer.from(t.kind === 'edit'
        ? 'Demo editor — keys are echoed; no files are changed.\r\n// acme-web/scratch.js\r\nexport const project = "acme-web";\r\n'
        : 'Demo terminal — keys are echoed; no commands are run.\r\n'));
      ready = true; ctl({ t: 'ready' });
    } else {
      cc = new ControlClient({ sockArgs: ['-u', '-L', t.sock], session: t.session,
        onOutput: bytes => write(OP.binary, bytes), onExit: () => b.end(1000, 'The shell exited.', 'shell') });
      (async () => {
        await cc.resize(t.cols, t.rows);
        const st = parseState((await cc.command(`display-message -p "${STATE_FORMAT}"`))[0]);
        if (!st) throw new Error('No pane state');
        const visible = await cc.command(`capture-pane -p -e -t ${st.pane}`);
        const normal = st.alt ? await cc.command(`capture-pane -p -e -a -q -t ${st.pane}`) : null;
        if (closed) return;
        cc.follow(st.pane); write(OP.binary, repaint(st, visible, normal));
        ready = true; ctl({ t: 'ready', pane: st.pane });
      })().catch(() => b.end(1011, 'Could not attach the terminal. Open again.', 'attach'));
    }
    if (head.length) receive(head);
  }

  return { open, upgrade, close() {
    clearInterval(sweep); tickets.clear();
    for (const b of live.values()) b.end(1001, 'The server is stopping.', 'shutdown');
  } };
}
