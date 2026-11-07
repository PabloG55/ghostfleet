// test/helpers/telegram-stub.mjs — a local stand-in for the Telegram Bot API, so the suite
// drives bin/fleet-telegram's whole loop without ever contacting the real one or holding a
// real token. It answers the five methods the daemon calls, serves files for getFile, and
// records every request it was sent, so a row can ask what reached "Telegram".
//
//   node telegram-stub.mjs <dir>
//
// The token it accepts is read from <dir>/token, never taken as an argument: the suite
// asserts that no process list on the machine shows it, and that includes this one.
// Writes <dir>/port once listening, and <dir>/requests.jsonl, one line per API call:
// { method, body, ok } — never the token, which only the URL carried. `ok` is false for a
// call the stub refused (a message over the limit): a row asking what REACHED the chat must
// not count a message Telegram would have bounced. The test drives it with:
//   POST /_push     { message }            queue an update for getUpdates
//   POST /_file     { file_id, b64 }       bytes that getFile + /file/ will hand out
//   GET  /_pending                         updates not yet fetched
// A request with any other token is answered 401, like the real API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dir] = process.argv.slice(2);
if (!dir) { console.error('usage: telegram-stub.mjs <dir>'); process.exit(2); }
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const reqLog = path.join(dir, 'requests.jsonl');
const updates = [];               // { update_id, message }
let nextUpdate = 1, nextMsg = 9000, waiters = [];
const files = new Map();          // file_id -> Buffer

const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const record = (method, body, ok) => fs.appendFileSync(reqLog, JSON.stringify({ method, body, ok }) + '\n');

function readBody(req) {
  return new Promise((done) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => done(Buffer.concat(parts))); });
}
// Enough multipart to see which field carried a file and how big it was.
function formFields(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || '');
  if (!m) return {};
  const b = Buffer.from('--' + (m[1] || m[2]));
  const out = {};
  let at = buf.indexOf(b);
  while (at !== -1) {
    const next = buf.indexOf(b, at + b.length);
    if (next === -1) break;
    const part = buf.slice(at + b.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString('latin1');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const file = /filename="([^"]*)"/.exec(head)?.[1];
    const val = part.slice(sep + 4);
    if (name) out[name] = file !== undefined ? { filename: file, bytes: val.length } : val.toString('utf8');
    at = next;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const raw = await readBody(req);
  if (url.pathname === '/_push') {
    const { message } = JSON.parse(raw.toString() || '{}');
    updates.push({ update_id: nextUpdate++, message });
    waiters.splice(0).forEach((w) => w());
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/_file') {
    const { file_id, b64 } = JSON.parse(raw.toString() || '{}');
    files.set(file_id, Buffer.from(b64, 'base64'));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/_pending') return json(res, 200, { ok: true, pending: updates.length });

  const fm = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
  if (fm) {
    if (fm[1] !== token) { res.writeHead(401); return res.end(); }
    const id = path.basename(fm[2]).replace(/\.[a-z0-9]+$/, '');
    const b = files.get(id);
    if (!b) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(b);
  }
  const am = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
  if (!am) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  if (am[1] !== token) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
  const method = am[2];
  const isForm = /multipart\/form-data/.test(req.headers['content-type'] || '');
  const body = isForm ? formFields(raw, req.headers['content-type']) : JSON.parse(raw.toString() || '{}');
  const tooLong = method === 'sendMessage' && String(body.text || '').length > 4096;
  record(method, body, !tooLong);
  switch (method) {
    case 'getMe': return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'stub_fleet_bot' } });
    case 'getUpdates': {
      const offset = Number(body.offset) || 0;
      for (let i = updates.length - 1; i >= 0; i--) if (updates[i].update_id < offset) updates.splice(i, 1);
      if (!updates.length) await new Promise((r) => { const t = setTimeout(r, Math.min(Number(body.timeout) || 0, 2) * 1000); waiters.push(() => { clearTimeout(t); r(); }); });
      return json(res, 200, { ok: true, result: updates.filter((u) => u.update_id >= offset) });
    }
    case 'getFile': {
      // A server error that QUOTES THE REQUEST — the shape a proxy's error page has, and
      // the way a token in a URL path ends up inside an error message. The daemon has to
      // redact it out of everything it writes; the suite asserts that nothing did.
      if (body.file_id === 'quote-url') return json(res, 502, { ok: false, error_code: 502, description: `Bad Gateway: upstream refused POST ${req.url}` });
      if (!files.has(body.file_id)) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
      return json(res, 200, { ok: true, result: { file_id: body.file_id, file_size: files.get(body.file_id).length, file_path: `photos/${body.file_id}.bin` } });
    }
    case 'sendMessage': {
      if (tooLong) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
      return json(res, 200, { ok: true, result: { message_id: nextMsg++, chat: { id: Number(body.chat_id) }, text: body.text } });
    }
    case 'sendChatAction': return json(res, 200, { ok: true, result: true });
    case 'sendPhoto': case 'sendDocument': return json(res, 200, { ok: true, result: { message_id: nextMsg++ } });
    default: return json(res, 400, { ok: false, error_code: 400, description: `Bad Request: the stub does not know ${method}` });
  }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'port'), String(server.address().port)));
