#!/usr/bin/env node
// test/helpers/push-probe.mjs — a fake push service, so the suite can prove a real push.
//
//     node push-probe.mjs --port N --sub FILE --out FILE [--status 201]
//
// It stands in for web.push.apple.com: it mints a subscription (P-256 key pair + a
// 16-byte auth secret), writes it to --sub for the test to POST at fleet-serve, answers
// every POST with --status, and appends one JSON line per push to --out — headers,
// status answered, and THE DECRYPTED PAYLOAD.
//
// WHY IT DECRYPTS RATHER THAN COUNTING REQUESTS. Everything that can go wrong with Web
// Push fails silently and identically: a wrong HKDF salt, a DER signature where the
// service wants raw r||s, a missing 0x02 record delimiter — the request is accepted, the
// phone shows nothing, and there is no error anywhere to grep. A test that asserts "a
// POST arrived" would pass for every one of those. So this decrypts the body per RFC 8291
// and verifies the VAPID JWT per RFC 8292, and the assertions are about the plaintext.
//
// THE DECRYPTION IS WRITTEN FROM THE RFC, NOT SHARED WITH THE SENDER, deliberately —
// the same reason serve-client.mjs has its own CBOR writer while fleet-serve.mjs has the
// reader. Two implementations of one format cancel each other's mistakes out only if they
// are the same code.
//
// Node builtins only, like everything else here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(flag('--port', 0));
const SUB_FILE = flag('--sub');
const OUT = flag('--out');
const STATUS = Number(flag('--status', 201));
if (!PORT || !SUB_FILE || !OUT) {
  console.error('usage: push-probe.mjs --port N --sub FILE --out FILE [--status 201]');
  process.exit(2);
}

// ── the subscription this fake service hands out ─────────────────────────────
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const subscription = {
  endpoint: `http://127.0.0.1:${PORT}/push/fake-endpoint`,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
};

// ── RFC 8291 / RFC 8188, read back ───────────────────────────────────────────
function decrypt(body) {
  if (body.length < 86) throw new Error(`body is ${body.length} bytes, too short for a header`);
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  if (idlen !== 65) throw new Error(`key id length is ${idlen}, want 65`);
  const as = body.subarray(21, 21 + 65);
  if (as[0] !== 4) throw new Error('sender key is not an uncompressed P-256 point');
  const ct = body.subarray(21 + 65);
  const shared = ua.computeSecret(as);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), as]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  // RFC 8188: the record ends with a padding delimiter — 0x02 on the last one. A sender
  // that omits it decrypts to JSON with a trailing byte, i.e. a parse error in the worker.
  const delim = plain[plain.length - 1];
  return { rs, delim, text: plain.subarray(0, plain.length - 1).toString('utf8') };
}

// ── RFC 8292: is the Authorization header a real ES256 JWT for THIS origin? ───
function checkVapid(header) {
  const out = { present: !!header, alg: '', aud: '', sub: '', sig: 'absent', exp: 0 };
  if (!header) return out;
  const t = /(?:^|[ ,])t=([A-Za-z0-9._-]+)/.exec(header);
  const k = /(?:^|[ ,])k=([A-Za-z0-9_-]+)/.exec(header);
  if (!/^vapid\s/i.test(header) || !t || !k) { out.sig = 'malformed'; return out; }
  const [h, p, sg] = t[1].split('.');
  let head = {}, claims = {};
  try { head = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); }
  catch { out.sig = 'unparsable'; return out; }
  out.alg = head.alg || ''; out.aud = claims.aud || ''; out.sub = claims.sub || ''; out.exp = claims.exp || 0;
  // The public key travels in k= as 0x04||x||y, which is what a JWK needs split back out.
  const raw = Buffer.from(k[1], 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) { out.sig = 'k= is not a P-256 point'; return out; }
  const jwk = { kty: 'EC', crv: 'P-256',
                x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') };
  try {
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`),
      { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(sg, 'base64url'));
    out.sig = ok ? 'verified' : 'BAD';
  } catch (e) { out.sig = `unverifiable: ${e.message}`; }
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const row = {
      at: Date.now() / 1000,
      method: req.method,
      path: req.url,
      answered: STATUS,
      content_encoding: req.headers['content-encoding'] || '',
      ttl: req.headers.ttl || '',
      urgency: req.headers.urgency || '',
      vapid: checkVapid(req.headers.authorization || ''),
      bytes: body.length,
    };
    try {
      const d = decrypt(body);
      row.record_size = d.rs;
      row.delimiter = d.delim;
      row.payload = JSON.parse(d.text);
      row.payload_text = d.text;
    } catch (e) { row.decrypt_error = e.message; }
    try { fs.appendFileSync(OUT, JSON.stringify(row) + '\n'); } catch {}
    res.writeHead(STATUS, { 'content-type': 'text/plain' }).end('');
  });
});
server.listen(PORT, '127.0.0.1', () => {
  // The subscription file is the READY SIGNAL as well as the payload: the test waits for
  // it rather than sleeping, so a slow start cannot look like a push that never came.
  fs.writeFileSync(SUB_FILE, JSON.stringify(subscription, null, 2) + '\n');
  console.log(`push-probe: listening on ${subscription.endpoint} answering ${STATUS}`);
});
