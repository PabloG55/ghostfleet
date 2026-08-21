// test/helpers/serve-client.mjs — a synthetic WebAuthn authenticator, so the suite can
// drive bin/fleet-serve's auth end to end without a phone.
//
// It exists because the property that has to be tested is the SERVER's: §5 is emphatic
// that a lock which only gates the UI is decoration, and the only way to show the API
// itself refuses a request without a live token is to make the requests. So this holds a
// P-256 key pair, builds real clientDataJSON / authenticatorData / attestation objects,
// and signs them — a passkey in every respect except the secure enclave.
//
// It speaks web/api.js's contract, not a convenience of its own: GET /api/auth/challenge,
// POST /api/auth/register with {id, attestation, client_data}, POST /api/auth/assert with
// {id, purpose, client_data, authenticator_data, signature}, and POST /api/verb with
// {tool, args} plus X-Fleet-Assertion. If the real client would not send it this way,
// neither does this.
//
// Node builtins only, like everything else here. That includes a 40-line CBOR *writer*
// for the attestation object; the reader lives in fleet-serve.mjs and the two are
// deliberately not the same code, so a mistake in one does not cancel out in the other.
import crypto from 'node:crypto';
import http from 'node:http';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

// ── CBOR writer: uints, negints, byte strings, text strings, maps ────────────
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (typeof v === 'number') return v < 0 ? head(1, -1 - v) : head(0, v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor writer: unsupported ${typeof v}`);
}

export function request(base, method, path, { body, headers = {} } = {}) {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } },
      (res) => {
        const parts = [];
        res.on('data', d => parts.push(d));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export class Authenticator {
  constructor({ rpId, origin, credIdBytes = 16 } = {}) {
    this.rpId = rpId; this.origin = origin;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.pub = publicKey; this.priv = privateKey;
    this.credId = crypto.randomBytes(credIdBytes);
    this.counter = 0;
    this.token = null; this.clientId = null; this._base = null;
  }
  get credentialId() { return b64u(this.credId); }
  cose() {
    const j = this.pub.export({ format: 'jwk' });
    return new Map([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]]);
  }
  clientData(type, challenge, extra = {}) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false, ...extra }), 'utf8');
  }
  authData({ attested = false, flags = null } = {}) {
    this.counter++;
    const f = flags === null ? (attested ? 0x45 : 0x05) : flags;   // UP|UV(|AT)
    const head4 = Buffer.alloc(5); head4[0] = f; head4.writeUInt32BE(this.counter, 1);
    const base = Buffer.concat([sha(Buffer.from(this.rpId, 'utf8')), head4]);
    if (!attested) return base;
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length, 0);
    return Buffer.concat([base, Buffer.alloc(16), len, this.credId, cbor(this.cose())]);
  }
  sign(authData, clientData) {
    return crypto.createSign('sha256').update(Buffer.concat([authData, sha(clientData)])).sign(this.priv);
  }

  // The raw ceremony outputs, for a FAKE navigator.credentials (test/helpers/pwa-enrol.mjs).
  // The methods below post the bodies themselves; these two hand back what a platform
  // authenticator hands a browser, so the real web/passkey.js can do the encoding and the
  // posting — which is the half that was broken (it never sent the enrolment code) and so
  // is the half that has to be exercised rather than reimplemented here.
  createResult(challengeB64u) {
    const cd = this.clientData('webauthn.create', challengeB64u);
    const ad = this.authData({ attested: true });
    return { rawId: this.credId, clientDataJSON: cd,
             attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]])) };
  }
  getResult(challengeB64u) {
    const cd = this.clientData('webauthn.get', challengeB64u);
    const ad = this.authData();
    return { rawId: this.credId, clientDataJSON: cd, authenticatorData: ad, signature: this.sign(ad, cd) };
  }

  // Register: the code opens the window, the passkey is what gets enrolled, and the
  // response carries the first token. Mirrors web/passkey.js register() exactly —
  // {id, attestation, client_data} — plus the `code` this server requires (see the
  // register handler for why the contract's code-free version is a hole).
  async enroll(base, code) {
    this._base = base;
    const ch = await request(base, 'GET', '/api/auth/challenge');
    if (ch.status !== 200) return ch;
    const cd = this.clientData('webauthn.create', ch.json.challenge);
    const ad = this.authData({ attested: true });
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
    const r = await request(base, 'POST', '/api/auth/register', { body: {
      code, id: this.credentialId, client_data: b64u(cd), attestation: b64u(att) } });
    if (r.status === 200) { this.token = r.json.token; this.clientId = r.json.client_id; }
    return r;
  }

  // One assertion, as web/passkey.js builds it. `where` picks what it is for: 'assert'
  // posts it to mint a token; 'header' returns it for X-Fleet-Assertion on a verb.
  async signChallenge({ purpose = 'open', tamper = {} } = {}) {
    const ch = await request(this._base, 'GET', '/api/auth/challenge');
    const challenge = tamper.challenge ?? ch.json?.challenge;
    const cd = this.clientData('webauthn.get', challenge);
    const ad = this.authData({ flags: tamper.flags });
    return { id: tamper.id ?? this.credentialId, purpose,
             client_data: b64u(cd), authenticator_data: b64u(ad),
             signature: b64u(tamper.signature ?? this.sign(ad, cd)) };
  }
  async assert(base, { purpose = 'open', tamper = {} } = {}) {
    this._base = base;
    const a = await this.signChallenge({ purpose, tamper });
    const r = await request(base, 'POST', '/api/auth/assert', { body: a });
    if (r.status === 200) this.token = r.json.token;
    return r;
  }
  async fresh(base, purpose) { this._base = base; return this.signChallenge({ purpose }); }

  headers({ auth = true } = {}) { return auth && this.token ? { authorization: `Bearer ${this.token}` } : {}; }
  api(base, method, path, body) { this._base = base; return request(base, method, path, { body, headers: this.headers() }); }
  // POST /api/verb, with the fresh assertion in the header for a destructive tool.
  async verb(base, tool, args, assertion = null) {
    this._base = base;
    return request(base, 'POST', '/api/verb', {
      body: { tool, args },
      headers: { ...this.headers(), ...(assertion ? { 'x-fleet-assertion': JSON.stringify(assertion) } : {}) },
    });
  }
}
