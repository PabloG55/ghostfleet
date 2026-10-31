// lib/peers.mjs — two fleet-serves paired, so one web client shows both machines.
//
// THE PROBLEM IT SOLVES. One person, two machines (a laptop and an always-on VM), each
// with its own fleet-serve, its own passkey and its own home-screen app. The tailnet only
// connects the devices; it merges nothing. So a phone had two apps and two logins.
//
// THE SHAPE, AND WHY IT IS THIS ONE. The phone keeps logging in to ONE host only: a
// passkey is bound to its relying party, WebAuthn cannot be done cross-origin, and a
// second login per machine is the thing being removed. That host — the HOME host —
// answers for the other one by PROXYING, server to server, with a credential the two
// hosts exchanged once, explicitly, at pairing. The client never talks to the other host.
//
// THE CREDENTIAL. Pairing leaves each side holding two secrets per pair:
//   out — what THIS host signs with when it calls the peer
//   in  — what the PEER signs with when it calls this host
// Two, not one, so a request cannot be reflected: a signature the laptop made for the VM
// does not verify when it is played back to the laptop. And the secret is never sent
// again after pairing — every request carries an HMAC over what it is (method, path,
// body digest, timestamp, nonce, and the end user it acts for), so there is nothing on
// the wire or in a log that would let anyone make another one. Stored beside serve.json
// at 0600, as the session table is; never in a URL, never in a log line.
//
// WHAT IT DOES NOT DO. It decides nothing about scope — fleet-serve holds the allowlist of
// what a paired host may ask for, at the point where the request is routed, because that
// is the only place the rule is enforced rather than described.
//
// Node builtins only, like everything else in ghostfleet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export const SIG_V = 'ghostfleet-pair-v1';
export const CLOCK_SKEW = 120;          // seconds a signed request may be early or late
export const PAIR_TTL = 300;            // how long `fleet-serve pair` keeps its code open
// A label is what the tab says ('laptop · work'), so it is short and printable; the KEY is
// what a project address carries (`acme-api@vm`), so it is the label folded to what can sit
// in a query string and a session's saved state without escaping. The key is chosen once,
// at pairing, and a relabel never moves it — an address that changed under a saved screen
// would open nothing.
export const LABEL_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;
export const KEY_OK = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const CLIENT_OK = /^[A-Za-z0-9._-]{1,32}$/;    // fleet-serve enroll's own rule for a client id

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
export const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

export function peersFile(config) { return path.join(path.dirname(config), 'serve-peers.json'); }
// Written by the daemon alone, on its own clock — last seen is a fact the DAEMON observes,
// and a file the CLI also rewrites (pair, unpair, relabel) is a file one of them clobbers.
export function seenFile(config) { return path.join(path.dirname(config), 'serve-peers-seen.json'); }

// ── the file ──────────────────────────────────────────────────────────────
// { self: <this host's label>, open: {code_sha256, exp} | null, peers: [ {id, key, label,
//   url, out, in, created} ] }. Re-read when its mtime moves, as serve.json is, so a
// `fleet-serve unpair` from a terminal lands on the daemon's NEXT request.
const cache = new Map();   // file -> { stamp, v }
function stampOf(f) { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } }
export function loadPeers(file, { force = false } = {}) {
  const stamp = stampOf(file);
  const hit = cache.get(file);
  if (!force && hit && hit.stamp === stamp) return hit.v;
  let raw = {};
  if (stamp) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
    catch (e) { throw new Error(`${file}: ${e.message}`); }
  }
  const v = { self: typeof raw.self === 'string' && LABEL_OK.test(raw.self) ? raw.self : '',
              open: raw.open && typeof raw.open === 'object' ? raw.open : null,
              peers: (Array.isArray(raw.peers) ? raw.peers : []).filter(p => p && typeof p.id === 'string'
                && KEY_OK.test(p.key || '') && typeof p.out === 'string' && typeof p.in === 'string' && typeof p.url === 'string') };
  cache.set(file, { stamp, v });
  return v;
}
export function savePeers(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  cache.set(file, { stamp: stampOf(file), v });
}
// THIS host's label: the one it announces at pairing and the one its own tabs carry once
// it has a peer. The short hostname until someone names it (`fleet-serve pair --as laptop`).
export function selfLabel(v) {
  if (v && v.self) return v.self;
  const h = String(os.hostname() || '').split('.')[0].replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 24);
  return LABEL_OK.test(h) ? h : 'this host';
}
export function keyFor(label, taken) {
  let base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'host';
  if (!/^[a-z0-9]/.test(base)) base = `h${base}`;
  let k = base, n = 2;
  while (taken.has(k)) k = `${base}-${n++}`;
  return k;
}
// A peer by key, by label (any case), or by pairing id — whatever a person typed.
export function findPeer(v, s) {
  const q = String(s || '');
  return v.peers.find(p => p.key === q) || v.peers.find(p => p.label.toLowerCase() === q.toLowerCase()) || v.peers.find(p => p.id === q) || null;
}

// ── plain HTTP is refused except on loopback ────────────────────────────────
// The pairing exchange carries both secrets, and every proxied request after it carries a
// transcript. WireGuard encrypts a tailnet hop, but "http://" to a name is also how the
// same config reaches a host that is NOT on the tailnet — so the rule is the scheme, not
// the network: https everywhere, http only to this machine (which is what the suite runs).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function urlProblem(u) {
  let x;
  try { x = new URL(String(u || '')); } catch { return `'${String(u || '').slice(0, 80)}' is not a URL`; }
  if (x.username || x.password) return 'a peer URL must not carry a user or password';
  if (x.search || x.hash || (x.pathname && x.pathname !== '/')) return `a peer URL is an origin only (scheme, host, port) — not '${x.pathname}${x.search}'`;
  if (x.protocol === 'https:') return '';
  if (x.protocol === 'http:' && LOOPBACK.has(x.hostname)) return '';
  if (x.protocol === 'http:') return `pairing over plain http is refused except to this machine (loopback) — use the https origin, e.g. https://<name>.ts.net`;
  return `'${x.protocol}' is not http or https`;
}
export const originOf = (u) => { const x = new URL(u); return `${x.protocol}//${x.host}`; };

// ── signing ───────────────────────────────────────────────────────────────
// Everything a request IS goes into the signature, so none of it can be changed in flight
// or replayed onto another path: a GET of one session's transcript cannot become a GET of
// another's, and a `send` cannot be re-sent. The end user it acts for is signed too —
// that header is the identity, and an identity the signature did not cover would be one
// anybody on the path could rewrite.
export function canonical({ pid, method, pathq, ts, nonce, onBehalf, body }) {
  return [SIG_V, pid, String(method).toUpperCase(), pathq, String(ts), nonce, onBehalf || '-',
          sha256(body && body.length ? body : Buffer.alloc(0))].join('\n');
}
export function sign(secret, parts) {
  return crypto.createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}
export function signedHeaders(peer, { method, pathq, body, onBehalf }) {
  const ts = now(), nonce = rand(18);
  return { 'x-fleet-pair': peer.id, 'x-fleet-pair-ts': String(ts), 'x-fleet-pair-nonce': nonce,
           'x-fleet-pair-sig': sign(peer.out, { pid: peer.id, method, pathq, ts, nonce, onBehalf, body }),
           ...(onBehalf ? { 'x-fleet-on-behalf': onBehalf } : {}) };
}
// Returns { peer, onBehalf } or { error }. `seen` is the replay table (nonce -> expiry),
// owned by the caller so it lives as long as the daemon does.
export function verifySigned(v, req, pathq, body, seen) {
  const h = (k) => { const x = req.headers[k]; return Array.isArray(x) ? x[0] : x; };
  const pid = String(h('x-fleet-pair') || '');
  const peer = v.peers.find(p => p.id === pid);
  if (!peer) return { error: 'not paired with this host — that pairing was never made here, or it has been unpaired' };
  const ts = Number(h('x-fleet-pair-ts'));
  if (!Number.isInteger(ts) || Math.abs(now() - ts) > CLOCK_SKEW)
    return { error: `the signature's timestamp is more than ${CLOCK_SKEW}s from this host's clock — check both clocks` };
  const nonce = String(h('x-fleet-pair-nonce') || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { error: 'no usable nonce on a signed request' };
  const onBehalf = h('x-fleet-on-behalf');
  if (onBehalf !== undefined && !CLIENT_OK.test(String(onBehalf))) return { error: 'the on-behalf client is not a client id' };
  const want = sign(peer.in, { pid, method: req.method, pathq, ts, nonce, onBehalf: onBehalf ? String(onBehalf) : '', body });
  const got = String(h('x-fleet-pair-sig') || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)))
    return { error: 'the pairing signature does not verify' };
  // Checked AFTER the signature, so only a request the peer really made can spend a nonce —
  // otherwise anyone could burn the peer's next nonce by guessing it, which is cheap here
  // only because nonces are random, and that is not a property to lean on twice.
  const k = `${pid}:${nonce}`;
  if (seen.has(k)) return { error: 'that signed request has already been used once' };
  seen.set(k, ts + CLOCK_SKEW * 2);
  if (seen.size > 4096) { const t = now(); for (const [x, e] of seen) if (e <= t) seen.delete(x); }
  return { peer, onBehalf: onBehalf ? String(onBehalf) : '' };
}

// ── calling a peer ────────────────────────────────────────────────────────
// `localhost` is dialled as 127.0.0.1 with the Host header kept: fleet-serve's loopback
// listener binds the v4 address, and `localhost` can resolve to ::1 first — a connection
// refused that would read as "the peer is down" when it is up.
export function request(url, { method = 'GET', pathq = '/', headers = {}, body = null, timeout = 4000 } = {}) {
  const u = new URL(pathq, url);
  const lib = u.protocol === 'https:' ? https : http;
  const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      servername: u.protocol === 'https:' && !/^[\d.]+$|:/.test(u.hostname) ? u.hostname : undefined,
      path: u.pathname + u.search, method,
      headers: { host: u.host, accept: 'application/json',
                 ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, (res) => {
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
      res.on('error', (e) => resolve({ status: 0, error: e.message }));
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error(`no answer in ${timeout}ms`), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ status: 0, error: e.code === 'ECONNREFUSED' ? 'connection refused' : e.message }));
    if (data) req.write(data);
    req.end();
  });
}
// A signed call. The body is serialised ONCE, here, and the same bytes are both hashed and
// sent — a body re-stringified after signing is a body whose digest no longer matches.
// ...and the same for the path: what is signed is the path and query AS SENT, after URL has
// had its say about encoding, not the string the caller built — the remote verifies the one
// that arrives.
export function peerRequest(peer, { method = 'GET', pathq, body = null, onBehalf = '', headers = {}, timeout } = {}) {
  const data = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const u = new URL(pathq, peer.url);
  const sent = u.pathname + u.search;
  return request(peer.url, { method, pathq: sent, timeout, body: data.length ? data : null,
    headers: { ...headers, ...signedHeaders(peer, { method, pathq: sent, body: data, onBehalf }) } });
}

// ── a project's address ───────────────────────────────────────────────────
// `acme-api@vm` is acme-api on the peer whose key is `vm`. A project name is A-Za-z0-9._-
// (bin/fleet-project refuses anything else), so an `@` cannot be part of one, and a bare
// name is always THIS host's — every address that existed before pairing keeps meaning
// what it meant.
export function splitAddr(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('@');
  if (i <= 0) return null;
  return { project: s.slice(0, i), key: s.slice(i + 1) };
}
export const joinAddr = (project, key) => `${project}@${key}`;

// ── when each peer was last heard from ──────────────────────────────────────
export function loadSeen(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
export function saveSeen(file, seen) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}
