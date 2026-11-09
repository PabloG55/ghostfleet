// lib/web-term.mjs — the two wire formats behind the web client's terminal: a WebSocket
// (RFC 6455, server side) and a tmux control-mode client. bin/fleet-serve.mjs decides WHO
// may open a terminal and on WHAT; this file only moves bytes, and knows nothing about
// passkeys, projects or tickets.
//
// WHY CONTROL MODE AND NOT A PTY. A terminal in a browser needs a byte stream in and out of
// a tmux pane. The obvious way is `tmux attach` under a pseudo-terminal, and node has no
// pty without a native module — which would be the first dependency fleet-serve ever took,
// on the one process that is remote code execution by design. `tmux -C attach` is a tmux
// CLIENT that speaks lines on plain pipes instead: the pane's output arrives as
// `%output %<pane> <bytes>`, keys go in as `send-keys -H`, and the client's size is set
// with `refresh-client -C`. It is the protocol iTerm2's tmux integration is built on, so
// it is old and boring, which is what is wanted here. And because it IS a tmux client of
// the fleet's own server, the same session is on the desk's grid at the same time — the
// web terminal is a second view of a fleet tab, never a shell of its own.
//
// Node builtins only, like everything fleet-serve loads.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// ── WebSocket, server side ────────────────────────────────────────────────────
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const wsAccept = (key) => crypto.createHash('sha1').update(String(key) + GUID).digest('base64');

// One frame, server to client: never masked (RFC 6455 §5.1 forbids it), always FIN.
export function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const n = p.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, p]);
}
export const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

// Client frames in, whole MESSAGES out. Fragments are reassembled, control frames are
// handed over between the fragments of a message (the RFC allows them there), and anything
// the RFC says to fail the connection for comes back as { error, code } — the caller closes
// with that code. A frame from a client MUST be masked: an unmasked one is what a
// non-browser that skipped the spec sends, and accepting it is how a proxy's cache gets
// poisoned (§10.3), so it is refused rather than tolerated.
export class FrameReader {
  constructor(maxMessage = 1 << 20) { this.buf = Buffer.alloc(0); this.frag = null; this.max = maxMessage; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = !!(b[0] & 0x80), rsv = b[0] & 0x70, op = b[0] & 0x0f;
      const masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, at = 2;
      if (rsv) return [...out, { error: 'reserved bits set (no extension was negotiated)', code: 1002 }];
      if (!masked) return [...out, { error: 'client frames must be masked', code: 1002 }];
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) return [...out, { error: 'message too big', code: 1009 }];
        len = Number(big); at = 10;
      }
      if (op >= 8 && (len > 125 || !fin)) return [...out, { error: 'bad control frame', code: 1002 }];
      if (len > this.max) return [...out, { error: 'message too big', code: 1009 }];
      if (b.length < at + 4 + len) break;
      const mask = b.subarray(at, at + 4);
      const data = Buffer.from(b.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(at + 4 + len);
      if (op >= 8) { out.push({ op, data }); continue; }
      if (op === OP.cont) {
        if (!this.frag) return [...out, { error: 'continuation with nothing to continue', code: 1002 }];
        this.frag.parts.push(data); this.frag.n += data.length;
        if (this.frag.n > this.max) return [...out, { error: 'message too big', code: 1009 }];
        if (fin) { out.push({ op: this.frag.op, data: Buffer.concat(this.frag.parts) }); this.frag = null; }
        continue;
      }
      if (op !== OP.text && op !== OP.binary) return [...out, { error: `unknown opcode ${op}`, code: 1002 }];
      if (this.frag) return [...out, { error: 'a new message began inside a fragmented one', code: 1002 }];
      if (fin) out.push({ op, data });
      else this.frag = { op, parts: [data], n: data.length };
    }
    return out;
  }
}

// ── tmux control mode ─────────────────────────────────────────────────────────
// `%output` escapes every byte below a space, and the backslash, as \ooo octal; everything
// else is the pane's own bytes, UTF-8 included, and a multi-byte character can be split
// across two %output lines (measured: `é` arrived as `\303` on one line and `\251` on the
// next). So this works on BYTES — the stdout is read as latin1, one char per byte, and the
// result goes to the browser as a Buffer for xterm.js to decode. Decoding per line would
// turn every split character into two replacement glyphs.
export function unescapeOutput(s) {
  return Buffer.from(String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), 'latin1');
}

// The bytes a browser typed, as `send-keys -H` commands. Hex because it is the one spelling
// of an arbitrary byte that tmux's command parser takes without quoting: a literal string
// would have to survive the parser's own quote and escape rules, and a newline inside one
// would end the command. -H sends each byte as a literal key (tmux >= 3.1: KEYC_LITERAL),
// so an ESC is an ESC, a mouse report is a mouse report and UTF-8 arrives intact — measured
// with `é`. Chunked, so a large paste is many short commands rather than one line tmux may
// refuse for its length.
export const SEND_CHUNK = 256;
export function sendKeysCommands(target, bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const out = [];
  for (let i = 0; i < b.length; i += SEND_CHUNK) {
    const hex = [...b.subarray(i, i + SEND_CHUNK)].map(x => x.toString(16).padStart(2, '0')).join(' ');
    out.push(`send-keys -t ${target} -H ${hex}`);
  }
  return out;
}

// The screen as it is NOW, for a browser that has just attached. Control mode streams
// output from the moment of attach and never replays what was already drawn, so without
// this a terminal opened on a running shell is blank until something prints — and one
// opened on nvim is blank until nvim redraws, which it may never do on its own.
//   Built from `capture-pane -e` (the visible screen, and with -a the normal screen kept
// behind an alternate one) plus the modes tmux reports for the pane. The modes matter as
// much as the text: an nvim that turned the mouse on before this browser arrived has to
// get its clicks, and those are only sent by a terminal that was told mouse reporting is on.
export const STATE_FORMAT = '#{pane_id} #{alternate_on} #{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag} ' +
  '#{keypad_flag} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_any_flag} #{mouse_sgr_flag} #{mouse_utf8_flag} ' +
  '#{insert_flag} #{wrap_flag} #{origin_flag} #{scroll_region_upper} #{scroll_region_lower} #{pane_height}';
export function parseState(line) {
  const f = String(line || '').trim().split(' ');
  if (f.length < 18 || !/^%\d+$/.test(f[0])) return null;
  const n = (i) => Number(f[i]) || 0;
  return { pane: f[0], alt: f[1] === '1', cx: n(2), cy: n(3), cursor: f[4] !== '0', kcursor: f[5] === '1',
           keypad: f[6] === '1', mstd: f[7] === '1', mbtn: f[8] === '1', many: f[9] === '1', msgr: f[10] === '1',
           mutf8: f[11] === '1', insert: f[12] === '1', wrap: f[13] !== '0', origin: f[14] === '1',
           top: n(15), bottom: n(16), height: n(17) };
}
export function repaint(st, visible, normal = null) {
  const paint = (lines) => lines.map((l, i) => `\x1b[${i + 1};1H\x1b[0m${l}`).join('') + '\x1b[0m';
  let s = '\x1bc';                                   // RIS: whatever this terminal held before is not the pane
  if (st.alt) s += paint(normal || []) + '\x1b[?1049h\x1b[H\x1b[2J';
  s += paint(visible);
  if (st.top > 0 || (st.height && st.bottom < st.height - 1)) s += `\x1b[${st.top + 1};${st.bottom + 1}r`;
  if (st.origin) s += '\x1b[?6h';
  if (!st.wrap) s += '\x1b[?7l';
  if (st.insert) s += '\x1b[4h';
  if (st.kcursor) s += '\x1b[?1h';
  if (st.keypad) s += '\x1b=';
  if (st.mstd) s += '\x1b[?1000h';
  if (st.mbtn) s += '\x1b[?1002h';
  if (st.many) s += '\x1b[?1003h';
  if (st.mutf8) s += '\x1b[?1005h';
  if (st.msgr) s += '\x1b[?1006h';
  s += `\x1b[${st.cy + 1};${st.cx + 1}H`;
  if (!st.cursor) s += '\x1b[?25l';
  return Buffer.from(s, 'utf8');
}

// A control-mode client of ONE session on ONE fleet server. `sockArgs` is ['-L', name] or
// ['-S', path] — the socket is always explicit, because every project has a session called
// `master` and a bare `tmux` would answer for whichever server it found first.
//   Events: onOutput(Buffer) for the pane this client is following, onExit(reason) once.
export class ControlClient {
  constructor({ sockArgs, session, env = process.env, onOutput = () => {}, onExit = () => {} }) {
    this.onOutput = onOutput; this.onExit = onExit;
    this.pane = '';                     // the pane id this terminal follows, once known
    this.pending = [];                  // our commands, in order, awaiting their %end
    this.block = null;                  // the %begin block being read
    this.held = [];                     // %output that arrived before the pane id was known
    this.exited = false; this.partial = '';
    // TMUX is dropped from the environment: a fleet-serve started from inside tmux would
    // otherwise be refused ("sessions should be nested with care") with nothing on screen
    // to say so. `=` is the exact-match prefix, which attach-session honours: the tab's
    // name starts with `_` and so cannot be target syntax anyway, and this keeps that true
    // of whatever name a caller passes.
    const e = { ...env }; delete e.TMUX;
    this.proc = spawn('tmux', [...sockArgs, '-C', 'attach-session', '-t', `=${session}`],
      { stdio: ['pipe', 'pipe', 'pipe'], env: e });
    this.pid = this.proc.pid;
    this.proc.stdout.on('data', (d) => this._data(d.toString('latin1')));
    // stderr is tmux's own complaint ("can't find session"), never the pane's bytes — the
    // pane's output only ever arrives on stdout as %output. Kept as a short reason for the
    // caller, which decides what to log.
    let why = '';
    this.proc.stderr.on('data', (d) => { if (why.length < 200) why += d.toString('utf8'); });
    this.proc.on('error', (e2) => this._exit(`could not run tmux: ${e2.message}`));
    this.proc.on('close', (code) => this._exit(why.trim().split('\n')[0] || `tmux exited ${code}`));
    this.proc.stdin.on('error', () => {});
  }
  _exit(reason) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.splice(0)) p.reject(new Error(reason));
    this.onExit(reason);
  }
  _data(s) {
    const lines = (this.partial + s).split('\n');
    this.partial = lines.pop();
    for (const line of lines) this._line(line);
  }
  _line(line) {
    if (this.block) {
      // The block ends on %end/%error carrying the SAME time and number as its %begin. A
      // pane line that merely starts with "%end" cannot end it early.
      if ((line.startsWith('%end ') || line.startsWith('%error ')) && line.slice(line.indexOf(' ') + 1) === this.block.tag) {
        const b = this.block; this.block = null;
        if (!b.ours) return;
        const p = this.pending.shift();
        if (p) (line.startsWith('%end ') ? p.resolve(b.lines) : p.reject(new Error(b.lines.join(' ').slice(0, 200) || 'tmux refused the command')));
        return;
      }
      this.block.lines.push(line);
      return;
    }
    if (line.startsWith('%begin ')) {
      const tag = line.slice(7);
      // The third field is the flags; 1 means the command came from THIS client. tmux also
      // opens a block for the attach itself, which nobody here is waiting on.
      this.block = { tag, lines: [], ours: (Number(tag.split(' ')[2]) & 1) === 1 };
      return;
    }
    if (line.startsWith('%output ')) {
      const sp = line.indexOf(' ', 8);
      if (sp < 0) return;
      const pane = line.slice(8, sp), data = line.slice(sp + 1);
      if (!this.pane) { this.held.push([pane, data]); return; }
      if (pane === this.pane) this.onOutput(unescapeOutput(data));
      return;
    }
    if (line.startsWith('%exit')) this._exit(line.slice(6).trim() || 'the session ended');
  }
  // One command, answered in order. Control mode answers commands strictly in the order
  // they were written, which is what lets a queue stand in for request ids.
  command(cmd) {
    if (this.exited) return Promise.reject(new Error('tmux has gone'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      try { this.proc.stdin.write(cmd.replace(/\n/g, ' ') + '\n'); }
      catch (e) { reject(e); }
    });
  }
  follow(pane) {
    this.pane = pane;
    // Output that raced the pane id: delivered only when it is this pane's, and BEFORE the
    // repaint the caller sends next, which overwrites the screen anyway.
    for (const [p, d] of this.held.splice(0)) if (p === pane) this.onOutput(unescapeOutput(d));
  }
  send(bytes) { if (this.pane) for (const c of sendKeysCommands(this.pane, bytes)) this.command(c).catch(() => {}); }
  resize(cols, rows) { return this.command(`refresh-client -C ${cols}x${rows}`); }
  close() {
    if (this.exited) return;
    // detach-client first, so tmux takes the client off the session cleanly; the kill is the
    // backstop for a tmux that is not reading its stdin any more. By THIS pid only.
    try { this.proc.stdin.write('detach-client\n'); this.proc.stdin.end(); } catch {}
    const t = setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch {} }, 1500);
    t.unref?.();
  }
}
