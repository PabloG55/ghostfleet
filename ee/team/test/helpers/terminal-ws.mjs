// A real masked WebSocket client, with cookie/Origin control for refusal tests.
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { OP, wsFrame } from '../../../../lib/web-term.mjs';

export function masked(op, data = Buffer.alloc(0)) {
  const plain = wsFrame(op, data), extra = (plain[1] & 127) === 126 ? 2 : (plain[1] & 127) === 127 ? 8 : 0;
  const head = Buffer.from(plain.subarray(0, 2 + extra)), payload = Buffer.from(plain.subarray(2 + extra));
  head[1] |= 128;
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, payload]);
}

export function connect({ port, cookie = '', ticket = '', origin = `http://127.0.0.1:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/term/ws?ticket=${encodeURIComponent(ticket)}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Cookie: cookie,
        ...(origin == null ? {} : { Origin: origin }), ...headers } });
    req.on('error', reject);
    req.on('response', res => {
      let text = ''; res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('upgrade', (res, socket, initial) => {
      const events = new EventEmitter(), messages = [];
      let buffer = Buffer.alloc(0), output = '';
      const receive = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const op = buffer[0] & 15;
          let n = buffer[1] & 127, at = 2;
          if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); at = 4; }
          if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); at = 10; }
          if (buffer.length < at + n) return;
          const data = buffer.subarray(at, at + n); buffer = buffer.subarray(at + n);
          if (op === OP.ping) socket.write(masked(OP.pong, data));
          if (op === OP.binary) output += data.toString('utf8');
          if (op === OP.text) messages.push(JSON.parse(data));
          if (op === OP.close) { messages.push({ close: data.readUInt16BE(0), why: data.subarray(2).toString() }); socket.end(); }
          events.emit('update');
        }
      };
      const wait = (predicate, timeout = 5000) => new Promise((yes, no) => {
        const done = () => {
          if (!predicate({ messages, output })) return;
          clearTimeout(timer); events.off('update', done); yes({ messages, output });
        };
        const timer = setTimeout(() => { events.off('update', done); no(new Error(`WebSocket wait timed out: ${JSON.stringify(messages)}`)); }, timeout);
        events.on('update', done); done();
      });
      socket.on('data', receive); socket.on('error', () => {});
      receive(initial);
      resolve({ status: res.statusCode, socket, messages, wait, output: () => output,
        input: bytes => socket.write(masked(OP.binary, Buffer.from(bytes))),
        resize: (cols, rows) => socket.write(masked(OP.text, JSON.stringify({ t: 'resize', cols, rows }))),
        pong: () => socket.write(masked(OP.pong)),
        close: () => socket.write(masked(OP.close)) });
    });
    req.end();
  });
}
