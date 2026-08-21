#!/usr/bin/env node
// bin/fleet-serve.mjs — the fleet's HTTP endpoint, so a phone can run it (docs/mobile.md).
//
// THE ONE CONSTRAINT EVERYTHING HERE FOLLOWS FROM (§1 of that document): this endpoint
// is REMOTE CODE EXECUTION BY DESIGN. `spawn` runs shell commands and creates checkouts;
// `send` injects prompts into agents running --dangerously-skip-permissions. Anyone who
// reaches it runs code as the user, and the transcripts it serves hold DATABASE_URLs,
// Clerk keys and real customer data. So this is not a service with a login page bolted
// on — it is a service that must never be publicly routable, whose every mutating call
// is authenticated, confirmed and recorded. Each control below says which question it
// answers, because they are different questions and that is why all of them are here:
//
//   the tailnet (outside this file) — can this device reach the port at all
//   assertBindable()               — could a bug in that layer expose us anyway
//   the enrolled passkey           — which device is this, and can it be revoked
//   the session token it mints      — is its owner still present, right now
//   X-Fleet-Assertion              — did a human authorise THIS destructive action
//   the audit log + inbox row      — and can we say afterwards that they did
//
// A change that weakens any of them is a redesign, not a tweak.
//
// WHAT IT DOES NOT DO. It computes nothing about the fleet. Reads proxy
// fleet-grid.mjs --json / --checkouts, fleet-read --json, and the projects list; actions
// dispatch through mcp/fleet-dispatch.mjs by their MCP TOOL NAME, unchanged — the same
// planner and the same argument validation the MCP server uses, so a client that drops a
// key is refused here for the same reason and with the same words. A second
// implementation of "what is this session doing" would drift from the grid's, and the
// grid's is the one with the scars.
//
// The endpoint shapes are web/README.md's, which is the contract the PWA was built to.
// Where this server is stricter than that document, it says so at the line that is
// stricter — there are two such places, /api/auth/register and the passkey set.
//
// Zero dependencies, node builtins only — that is what ghostfleet is.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callToolAsync, projects, BIN } from '../mcp/fleet-dispatch.mjs';

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRID = path.join(BIN, 'fleet-grid.mjs');
const TMUX_CONF = path.join(REPO, 'tmux', 'cf.tmux.conf');
const WEB = path.join(REPO, 'web');                       // the PWA, when it lands
const CFG_HOME = path.join(HOME, '.config', 'ghostfleet');
const CONFIG = process.env.GHOSTFLEET_SERVE_CONFIG || path.join(CFG_HOME, 'serve.json');
const AUDIT = process.env.GHOSTFLEET_SERVE_AUDIT || path.join(CFG_HOME, 'serve-audit.jsonl');
const VERSION = '1.0.0';

const now = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
// The enrolment code is printed with a hyphen so it can be read off a terminal and typed
// into a phone, and it is compared with the hyphen (and any case, and any stray space)
// removed. Normalising in ONE place is the point: the first cut hashed the printed form
// on one side and the stripped form on the other, so every correct code was refused —
// which from the phone is indistinguishable from a wrong one.
const normCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
// Equal-length is a precondition of timingSafeEqual, and every secret compared here is a
// fixed-width hex digest, so a length mismatch is a bug rather than a wrong password.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── config ──────────────────────────────────────────────────────────────────
// One file, 0600, holding the bind address, the enrolled clients (bearer tokens as
// digests only — the plaintext is shown once, at enrolment, and never stored) and each
// client's passkey public keys. Re-read when its mtime moves, which is what makes
// `fleet-serve revoke <id>` take effect on the NEXT REQUEST of a running daemon instead
// of at the next restart. §12: a phone is lost more often than a laptop, so revocation
// has to be one action — and an action that needs a restart to land is two.
const DEFAULTS = {
  bind: '', port: 8787, rp_id: '', origins: [], tls: null,
  session_ttl: 900,          // §5: the assertion mints a SHORT-lived token (~15 min)
  confirm_ttl: 120,          // a destructive action confirmed now, not twenty minutes ago
  enroll_ttl: 900,
  rate: { window: 60, read: 240, write: 30, auth: 10 },
  clients: [],
};
let cfg = null, cfgStamp = '';

function stampOf(f) { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } }
function loadConfig({ force = false } = {}) {
  const stamp = stampOf(CONFIG);
  if (!force && cfg && stamp === cfgStamp) return cfg;
  let raw = {};
  if (stamp) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
    catch (e) { throw new Error(`${CONFIG}: ${e.message}`); }
  }
  cfg = { ...DEFAULTS, ...raw, rate: { ...DEFAULTS.rate, ...(raw.rate || {}) } };
  cfg.clients = Array.isArray(cfg.clients) ? cfg.clients : [];
  cfgStamp = stamp;
  return cfg;
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  try { fs.chmodSync(CONFIG, 0o600); } catch {}
  cfg = c; cfgStamp = stampOf(CONFIG);     // our own write must not look like someone else's
}

// ── the bind address: refuse anything that is not the tailnet or this machine ──
// §5, and the sharp end of §1. `0.0.0.0` on a laptop in a café publishes an RCE endpoint
// to the café, and the failure is SILENT — it serves perfectly, to everyone. So the bind
// address is explicit configuration with no default, and a value that resolves to a
// wildcard, a LAN address or a public one is refused BEFORE the socket opens, naming
// which it was.
//
// LAN is refused deliberately, and it is the case people will argue about: 192.168.1.5
// is not "public", but the network it is on is a coffee shop's. The two transports
// docs/mobile.md sanctions both land inside this rule — Tailscale gives a 100.64/10
// address, and Cloudflare Tunnel's cloudflared connects to loopback — so nothing that is
// supposed to work needs the hole.
const CGNAT = { net: [100, 64, 0, 0], bits: 10 };          // Tailscale's IPv4 range
const TS6 = 'fd7a:115c:a1e0';                              // ...and its IPv6 prefix, /48
function v4parts(a) { const p = a.split('.').map(Number); return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null; }
function inNet(p, { net: n, bits }) {
  const to = (x) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (to(p) & mask) === (to(n) & mask);
}
export function classifyAddr(addr) {
  const a = String(addr == null ? '' : addr).trim().replace(/^\[|\]$/g, '');
  if (!a) return { kind: 'empty', why: 'no bind address configured' };
  if (a === '*' || a === '0' || a === '0.0.0.0' || a === '::' || a === '::0')
    return { kind: 'wildcard', why: `'${a}' is a wildcard — it listens on every interface, including whatever network you are on` };
  const zoneless = a.replace(/%.*$/, '');
  if (net.isIPv4(zoneless)) {
    const p = v4parts(zoneless);
    if (p[0] === 127) return { kind: 'loopback' };
    if (inNet(p, CGNAT)) return { kind: 'tailnet' };
    if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168))
      return { kind: 'lan', why: `${a} is a private LAN address — reachable by everything else on that network, which away from home is somebody else's` };
    if (p[0] === 169 && p[1] === 254) return { kind: 'linklocal', why: `${a} is link-local` };
    if (p[0] >= 224) return { kind: 'multicast', why: `${a} is not a unicast address` };
    return { kind: 'public', why: `${a} is a public address — this endpoint is remote code execution and must never be publicly routable` };
  }
  if (net.isIPv6(zoneless)) {
    const low = zoneless.toLowerCase();
    if (low === '::1') return { kind: 'loopback' };
    const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // v4-mapped: judge it as v4
    if (m) return classifyAddr(m[1]);
    if (low.startsWith(TS6)) return { kind: 'tailnet' };
    if (/^fe[89ab]/.test(low)) return { kind: 'linklocal', why: `${a} is link-local` };
    if (/^f[cd]/.test(low)) return { kind: 'lan', why: `${a} is a private (ULA) address outside Tailscale's ${TS6}::/48 range` };
    if (low.startsWith('ff')) return { kind: 'multicast', why: `${a} is not a unicast address` };
    return { kind: 'public', why: `${a} is a public address — this endpoint is remote code execution and must never be publicly routable` };
  }
  return { kind: 'name', why: `'${a}' is not an IP literal` };
}
const BINDABLE = new Set(['loopback', 'tailnet']);

// Every address this machine actually has, so a refusal can name the candidates rather
// than leaving someone to guess (and so a tailnet address configured while tailscaled is
// down fails with THAT, not with a bare EADDRNOTAVAIL).
function localAddrs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifs)) for (const a of list || [])
    out.push({ iface: name, address: a.address.replace(/%.*$/, ''), family: a.family, kind: classifyAddr(a.address).kind });
  return out;
}

// A hostname is allowed in the config (MagicDNS names are the natural thing to write),
// but it is only as good as what it resolves to — so resolve it and judge EVERY answer.
// One public A record among them is enough to refuse: that is the address a bug would
// pick.
async function resolveBind(addr) {
  const c = classifyAddr(addr);
  if (c.kind !== 'name') return { addrs: [{ address: String(addr).trim().replace(/^\[|\]$/g, ''), ...c }] };
  let res;
  try { res = await dns.promises.lookup(addr, { all: true, verbatim: true }); }
  catch (e) { return { error: `cannot resolve bind '${addr}': ${e.code || e.message}` }; }
  if (!res.length) return { error: `bind '${addr}' resolved to nothing` };
  return { addrs: res.map(r => ({ address: r.address, ...classifyAddr(r.address) })) };
}

// The preflight. Returns {ok} or {ok:false, why:[…]}, and is deliberately callable
// without a tailnet present — the wildcard refusal is the half that must work on a
// machine where Tailscale has never been installed, because that is the machine where
// somebody reaches for 0.0.0.0 to "just make it work".
export async function assertBindable(bind, { requireLocal = true } = {}) {
  const why = [];
  const r = await resolveBind(bind);
  if (r.error) return { ok: false, why: [r.error] };
  for (const a of r.addrs) {
    if (!BINDABLE.has(a.kind)) {
      why.push(a.why || `${a.address} is a ${a.kind} address`);
      continue;
    }
    if (requireLocal) {
      const mine = localAddrs().some(l => l.address.toLowerCase() === a.address.toLowerCase());
      if (!mine) why.push(`${a.address} is not on any interface of this machine` +
        (a.kind === 'tailnet' ? ' — is tailscaled running and signed in? (`tailscale ip -4`)' : ''));
    }
  }
  return why.length ? { ok: false, why, addrs: r.addrs } : { ok: true, addrs: r.addrs };
}

// §11.1: "Funnel stays off — that is the single setting that would undo §5, and it should
// be asserted, not remembered." Funnel is the Tailscale feature that publishes a service
// to the open internet; with it on, every layer above becomes decoration. So: assert it,
// and be honest when we cannot. A missing CLI is reported as UNVERIFIED rather than
// silently treated as a pass — this machine has no Tailscale yet, and a check that
// quietly succeeds because the tool is absent is the worst of the three outcomes.
function funnelState() {
  let out;
  try {
    out = execFileSync('tailscale', ['serve', 'status', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    if (e.code === 'ENOENT') return { checked: false, why: 'tailscale CLI not installed' };
    return { checked: false, why: `tailscale serve status failed: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}` };
  }
  let j;
  try { j = JSON.parse(out || '{}'); } catch { return { checked: false, why: 'tailscale serve status returned no JSON' }; }
  const af = j?.AllowFunnel || {};
  const on = Object.entries(af).filter(([, v]) => v).map(([k]) => k);
  return { checked: true, on };
}

// ── audit: append-only, hash-chained, and surfaced where somebody reads it ────
// §12: "an unread log is a compliance gesture." So every mutating request writes twice —
// a JSONL row here, and a row in the TARGET fleet's inbox, which is the feed a lead
// already drains with fleet-inbox and which the grid already shows.
//
// The chain is what makes "append-only" more than a filename: each row carries the
// digest of the line before it, so a deletion or an edit in the middle breaks the chain
// at that point and `fleet-serve audit --verify` says where. It cannot stop a root user
// rewriting the file, and does not pretend to; it makes doing so detectable.
//
// THERE IS MORE THAN ONE WRITER, and the first cut of this forgot it. The daemon appends
// on every mutating request; `fleet-serve revoke` and `enroll` append from a separate
// process. Caching the tail digest in memory made the daemon chain its next row onto the
// row it last wrote ITSELF, skipping the CLI's — so an ordinary `revoke` broke the chain
// and the log started accusing the user of tampering. Measured: 15 rows, verify red, no
// tampering at all. A control that cries wolf is worse than no control, so the tail is
// read from disk inside a lock on every append, and the lock is what stops two writers
// computing the same `prev` and both using it.
function auditTail() {
  let fd;
  try { fd = fs.openSync(AUDIT, 'r'); } catch { return 'genesis'; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return 'genesis';
    const want = Math.min(size, 65536);            // the last line, not the whole log
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    // A partial first line is possible when we started mid-file; it is never the LAST
    // one, which is all we need.
    return lines.length ? sha256(lines[lines.length - 1]) : 'genesis';
  } finally { try { fs.closeSync(fd); } catch {} }
}
function withAuditLock(fn) {
  const lock = `${AUDIT}.lock`;
  for (let i = 0; i < 20; i++) {
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') break;
      // A lock nobody released belongs to a writer that died; five seconds is far longer
      // than an append takes and far shorter than anyone would wait for one.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
      const until = Date.now() + 10; while (Date.now() < until);   // sync: so is the write
      continue;
    }
    try { return fn(); } finally { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch {} }
  }
  return fn();      // never lose a row to a stuck lock: an unchained row is still evidence
}
function auditAppend(row) {
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  return withAuditLock(() => {
    const line = JSON.stringify({ ...row, prev: auditTail() });
    fs.appendFileSync(AUDIT, line + '\n', { mode: 0o600 });
    return line;
  });
}
export function auditVerify(file = AUDIT) {
  let lines = [];
  // A log with no rows yet is intact, not broken. Reporting ENOENT as a broken chain
  // would cry wolf on every fresh install, and an alarm that is always on is an alarm
  // nobody reads — which is the same failure §12 is about.
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (e) { return e.code === 'ENOENT' ? { ok: true, n: 0 } : { ok: false, at: 0, n: 0, why: e.message }; }
  let prev = 'genesis';
  for (let i = 0; i < lines.length; i++) {
    let o; try { o = JSON.parse(lines[i]); } catch { return { ok: false, at: i + 1, why: 'not JSON' }; }
    if (o.prev !== prev) return { ok: false, at: i + 1, n: lines.length, why: `chain broken: row ${i + 1} follows ${o.prev}, previous row hashes to ${prev}` };
    prev = sha256(lines[i]);
  }
  return { ok: true, n: lines.length };
}

// The inbox is TSV: <ts>\t<session>\t<event>\t<detail>, read by fleet-inbox with
// IFS=$'\t'. Tab is IFS-whitespace, so an EMPTY field there collapses and shifts every
// later column left (CLAUDE.md's oldest trap) — hence the '-' fallbacks below. And the
// row goes to the TARGET's fleet dir and socket, not ours: another profile is another
// directory, and a row written to the wrong one is invisible with nothing to grep.
function inboxRow(t, session, detail) {
  if (!t) return;
  const dir = path.join(t.cfg, 'fleet');
  const clean = (s, n) => (String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim() || '-').slice(0, n);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${t.sock}.inbox`),
      `${now()}\t${clean(session, 40)}\tmobile\t${clean(detail, 300)}\n`);
  } catch (e) { log('audit: could not write inbox row:', e.message); }
}

// ── WebAuthn, by hand ───────────────────────────────────────────────────────
// §5 wants a passkey rather than a password: a password typed twenty times a day
// converges on something short, autofills from a manager on the very unlocked phone that
// is the threat, and is replayable. A passkey is bound to the secure enclave and cannot
// be copied off the device.
//
// There is no library, because there are no libraries here — ghostfleet has zero
// dependencies and that is the reason the client is a PWA at all (§6). So: a subset CBOR
// reader for the two structures WebAuthn actually hands us, COSE -> JWK (node has
// imported JWK since v15, which spares a DER writer), and the assertion check itself.
//
// WHAT IS DELIBERATELY NOT VERIFIED: the attestation STATEMENT. We are our own relying
// party with one user, and platform authenticators return `none` attestation by default;
// verifying a cert chain would tell us which vendor made the enclave, which is not a
// question anything here asks. What IS verified on every assertion is the part that
// matters: our challenge, our origin, our rpId, the user-presence flag, a non-regressing
// signature counter, and the signature itself.
function cborRead(b, r) {
  const ib = b[r.i++], mt = ib >> 5, ai = ib & 31;
  let len;
  if (ai < 24) len = ai;
  else if (ai === 24) len = b[r.i++];
  else if (ai === 25) { len = b.readUInt16BE(r.i); r.i += 2; }
  else if (ai === 26) { len = b.readUInt32BE(r.i); r.i += 4; }
  else if (ai === 27) { len = Number(b.readBigUInt64BE(r.i)); r.i += 8; }
  else throw new Error('cbor: indefinite lengths are not used by WebAuthn');
  switch (mt) {
    case 0: return len;
    case 1: return -1 - len;
    case 2: { const s = b.subarray(r.i, r.i + len); r.i += len; return s; }
    case 3: { const s = b.toString('utf8', r.i, r.i + len); r.i += len; return s; }
    case 4: { const a = []; for (let k = 0; k < len; k++) a.push(cborRead(b, r)); return a; }
    case 5: { const m = new Map(); for (let k = 0; k < len; k++) { const key = cborRead(b, r); m.set(key, cborRead(b, r)); } return m; }
    case 6: return cborRead(b, r);                       // tag: the value follows
    case 7:
      if (len === 20) return false;
      if (len === 21) return true;
      if (len === 22) return null;
      throw new Error('cbor: unsupported simple/float value');
    default: throw new Error('cbor: bad major type');
  }
}
export function cborDecode(buf) { const r = { i: 0 }; const value = cborRead(buf, r); return { value, end: r.i }; }

// authData: rpIdHash(32) flags(1) signCount(4) [aaguid(16) credIdLen(2) credId COSEKey]
export function parseAuthData(b) {
  if (b.length < 37) throw new Error('authenticatorData too short');
  const out = { rpIdHash: b.subarray(0, 32), flags: b[32], signCount: b.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04); out.at = !!(out.flags & 0x40);
  if (out.at) {
    if (b.length < 55) throw new Error('attested credential data truncated');
    const idLen = b.readUInt16BE(53);
    out.credId = b.subarray(55, 55 + idLen);
    const { value } = cborDecode(b.subarray(55 + idLen));
    out.cose = value;
  }
  return out;
}
export function coseToJwk(cose) {
  const g = (k) => cose.get(k);
  const kty = g(1), alg = g(3);
  if (kty === 2) {
    if (g(-1) !== 1) throw new Error(`unsupported EC curve ${g(-1)} (only P-256)`);
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64u(g(-2)), y: b64u(g(-3)) }, alg: alg ?? -7 };
  }
  if (kty === 3) return { jwk: { kty: 'RSA', n: b64u(g(-1)), e: b64u(g(-2)) }, alg: alg ?? -257 };
  throw new Error(`unsupported key type ${kty}`);
}
const ALG_OK = new Set([-7, -257]);
function verifySig(jwk, alg, data, sig) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const v = crypto.createVerify('sha256');
  v.update(data);
  return v.verify(alg === -257 ? { key, padding: crypto.constants.RSA_PKCS1_PADDING } : key, sig);
}

// The clientData checks that are the same for a registration and an assertion.
//
// The challenge is looked up FROM the assertion rather than passed alongside it: the
// client (web/passkey.js) fetches a challenge, hands the raw bytes to
// navigator.credentials, and posts back what the authenticator signed — there is no
// challenge id in that round trip, and inventing one would have been a contract change
// for nothing. What matters is unchanged: the challenge has to be one WE issued, still
// live, and NOT YET USED. takeChallenge consumes it, because a replayed assertion is
// exactly what somebody with a copy of the traffic would send.
function checkClientData(raw, c, expectType) {
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { return { error: 'clientDataJSON is not JSON' }; }
  if (cd.type !== expectType) return { error: `clientData type is '${cd.type}', expected '${expectType}'` };
  const origins = c.origins || [];
  if (!origins.includes(cd.origin)) return { error: `origin '${cd.origin}' is not in this server's origins (${origins.join(', ') || 'none configured'})` };
  if (cd.crossOrigin === true) return { error: 'cross-origin assertion refused' };
  if (typeof cd.challenge !== 'string') return { error: 'no challenge in clientDataJSON' };
  const ch = takeChallenge(cd.challenge);
  if (!ch) return { error: 'that challenge is not one this server issued, or it has expired or already been used' };
  return { ch };
}

// ── live state: challenges, sessions, force gates, rate limits ────────────────
// All in memory, all short-lived, and all gone on restart — which is the correct
// behaviour: a restarted daemon should ask for Face ID again, not honour a token minted
// by the process that died.
const challenges = new Map();   // challenge string -> { exp }
const sessions = new Map();     // sha(token) -> { client, exp, born, purpose }
const declined = new Map();     // "<key>" -> exp: a removal the gates refused, once
const buckets = new Map();      // "<name>:<key>" -> { n, resetAt }

function sweep() {
  const t = now();
  for (const [k, v] of challenges) if (v.exp <= t) challenges.delete(k);
  for (const [k, v] of sessions) if (v.exp <= t) sessions.delete(k);
  for (const [k, v] of declined) if (v <= t) declined.delete(k);
  for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
}

// Fixed-window counters. §5 asks for rate limiting "because a token that leaks should be
// slow to exploit", and the three windows are sized for what each one protects: `auth` is
// the one an attacker with a stolen bearer token grinds against, `write` bounds how much
// damage a live session can do per minute, `read` is generous because the phone polls.
function rateOk(name, key, res) {
  const c = loadConfig(), limit = c.rate[name] ?? 60, win = c.rate.window || 60;
  const k = `${name}:${key}`, t = now();
  let b = buckets.get(k);
  if (!b || b.resetAt <= t) { b = { n: 0, resetAt: t + win }; buckets.set(k, b); }
  b.n++;
  if (b.n > limit) {
    res.setHeader('Retry-After', String(b.resetAt - t));
    return false;
  }
  return true;
}

const CHALLENGE_TTL = 120;
function newChallenge() {
  const challenge = rand(32);
  challenges.set(challenge, { exp: now() + CHALLENGE_TTL });
  // A challenge is cheap and unauthenticated to ask for, so cap the table rather than
  // let anyone who can reach the port grow it without limit.
  if (challenges.size > 512) for (const k of challenges.keys()) { challenges.delete(k); if (challenges.size <= 256) break; }
  return challenge;
}
function takeChallenge(ch) {
  const c = challenges.get(ch);
  if (!c || c.exp <= now()) return null;
  challenges.delete(ch);                                  // single use, always
  return c;
}

// ONE TOKEN, and a passkey assertion is the only thing that mints it.
//
// docs/mobile.md §5 describes two — a bearer token identifying the enrolled client, and
// a short-lived session token the assertion mints — and web/api.js sends one
// `Authorization: Bearer`. They are reconciled rather than reduced: this token is the
// session token, it is bound to one enrolled credential, it expires in ~15 minutes, and
// nothing hands one out without a verified signature. So the property §5 actually
// insists on holds exactly — "the API rejects any request without a live one", and
// `curl` cannot walk past the lock because there is no long-lived secret to walk past
// with. The device identity §5 wants revocable is the enrolled CREDENTIAL, and
// `fleet-serve revoke <id>` is the one action that drops it and every token it minted.
function mintSession(clientId, purpose = 'open') {
  const c = loadConfig(), tok = rand(32), ttl = c.session_ttl || 900;
  sessions.set(sha256(tok), { client: clientId, born: now(), exp: now() + ttl, purpose });
  return { token: tok, ttl, expires_at: now() + ttl };
}
function liveSession(tok) {
  if (!tok) return null;
  const s = sessions.get(sha256(tok));
  if (!s || s.exp <= now()) return null;
  const cl = clientById(s.client);
  // Revoked between two requests: the token dies with the client, which is what makes
  // revocation land on a RUNNING daemon instead of at the next restart.
  if (!cl || cl.revoked) return null;
  return { ...s, cl };
}
function clientById(id) { return loadConfig().clients.find(c => c.id === id) || null; }
// Their client identifies itself by credential id alone (localStorage holds `gf.cred`,
// which passkey.js is careful to say is not a secret) — so this resolves a client from
// the key that is about to sign, and the SIGNATURE is what authenticates it.
function clientByCredential(credId) {
  if (!credId) return null;
  for (const c of loadConfig().clients) {
    if (c.revoked) continue;
    if ((c.creds || []).some(x => x.id === credId)) return c;
  }
  return null;
}

// ── the verbs ───────────────────────────────────────────────────────────────
// §7: full parity, including spawn and stop --reclaim. A read-only phase was proposed
// and rejected — an app that reports a worker has been blocked on "Allow `pnpm test`?"
// since 9pm and cannot answer it has only described the problem more conveniently. So
// capability is fixed at parity and the controls are identity, confirmation and audit.
//
// KEYED ON THE MCP TOOL NAME, unchanged, because that is what web/api.js posts and what
// mcp/fleet-dispatch.mjs plans. One vocabulary end to end; no translation layer to drift.
//
// AND THIS TABLE IS THE ENFORCEMENT. web/api.js has a DESTRUCTIVE set of its own, and its
// own comment says what it is: a UI affordance deciding which taps ask for a fingerprint.
// `curl` does not run that file. So every rule below is checked here, on the tool name,
// and `fields` is an allowlist so a misspelt argument is refused BY NAME instead of
// silently dropped — the failure #38 exists for, where one dropped key reached a worker
// as the seven-character word "undefined".
//
// TWO TOOLS ARE HELD STRICTER THAN THE CLIENT ASKS. web/README.md says the passkey covers
// "spawn, stop, rename and removing a worktree" while api.js's set names only the first
// three, so fleet_worktree_remove would arrive unsigned — and that is the one verb §12
// calls load-bearing, the one that deletes a checkout. fleet_project_add is here for the
// same reason: with start:true it boots a master, which is running code. Being stricter
// than the document cannot be a weakening of it, but it does mean those two taps need
// api.js's DESTRUCTIVE set widened or they will be refused, naming why.
const TOOLS_ALLOWED = {
  fleet_list:            { fields: ['project'] },
  fleet_read:            { fields: ['project', 'session', 'n'] },
  fleet_worktrees:       { fields: ['project'] },
  fleet_inbox:           { fields: ['project', 'all'] },
  fleet_projects:        { fields: [], noProject: true },
  fleet_send:            { fields: ['project', 'session', 'prompt'],           write: true, subject: 'session' },
  fleet_answer:          { fields: ['project', 'session', 'text', 'no_enter'], write: true, subject: 'session' },
  fleet_pause:           { fields: ['project', 'session'],                     write: true, subject: 'session' },
  fleet_resume:          { fields: ['project', 'session', 'prompt'],           write: true, subject: 'session' },
  fleet_spawn:           { fields: ['project', 'name', 'branch', 'from', 'prompt', 'model', 'reuse', 'force_new'],
                           write: true, passkey: true, subject: 'name' },
  fleet_stop:            { fields: ['project', 'session', 'reclaim', 'force'], write: true, passkey: true, subject: 'session' },
  fleet_rename:          { fields: ['project', 'session', 'new_name'],         write: true, passkey: true, subject: 'session' },
  fleet_worktree_remove: { fields: ['project', 'path', 'branch', 'force'],     write: true, passkey: true, subject: 'path' },
  fleet_project_add:     { fields: ['path', 'name', 'profile', 'start'],       write: true, passkey: true, noProject: true, subject: 'name' },
  fleet_project_remove:  { fields: ['name'],                                   write: true, noProject: true, subject: 'name' },
};
// `branch` is accepted on fleet_worktree_remove and thrown away: web/api.js sends it so
// its fixture backend can name the branch in a refusal. Silently ignoring an argument is
// how a real one gets lost, so it is declared here and dropped deliberately.
const IGNORED = new Set(['fleet_worktree_remove.branch']);

// The eight verbs web/README.md asks for that have no MCP tool. Two of them now do
// (fleet_worktree_remove, fleet_project_remove — both had an existing owner: fleet-clean
// and `fleet-project rm`). The rest are things the GRID does by writing a marker file
// from inside the TUI, and there is no command that owns those formats:
//
//   fleet_schedule       <sock>.<session>.sched + bin/fleet-schedule — which writes the
//                        UN-namespaced <session>.sched, a different path from the one the
//                        grid reads, so wiring it up as-is would set a schedule no card
//                        ever shows
//   fleet_label          <sock>.<session>.label
//   fleet_nudge          <sock>[.<session>].notify-lead[-off]
//   fleet_budget         the per-project budget-ceiling marker
//   fleet_order          <sock>.order plus the @cf_order tmux option
//   fleet_project_order  the projects list's own order
//
// I agree with the lean in the handoff — they should be real MCP tools, so agents get
// them too and they inherit #38's validation — and NOT by fleet-serve writing those
// markers itself, which would be a second writer of a format that lives inside
// fleet-grid.mjs, drifting silently the first time the grid changes one. The shape is:
// extract the writes into a command that owns them, then add the tools on top. That is a
// change to fleet-grid.mjs, which is another PR's live file this week, so it is its own
// piece of work rather than a rider on this one.
//
// Until then they are refused BY NAME with that reason, so the buttons behind them fail
// loudly. A 404 or a generic "unknown tool" would look like a typo in the client.
const NOT_YET = {
  fleet_schedule: 'the schedule marker is written by the grid; bin/fleet-schedule writes a different, un-namespaced path',
  fleet_label: 'the card label is a marker file only fleet-grid.mjs writes',
  fleet_nudge: 'the notify-lead markers are written by the grid\'s settings screen',
  fleet_budget: 'the budget-ceiling marker is written by the grid\'s settings screen',
  fleet_order: 'the card order is <sock>.order plus a tmux option, both written by the grid',
  fleet_project_order: 'the projects order is written by the Projects screen',
};

const BOOLS = new Set(['all', 'no_enter', 'force_new', 'reclaim', 'force', 'start']);

// Turn a request body into the arguments the shared planner takes, refusing anything the
// tool does not declare. Returns {args, t, v} or {error}.
function buildArgs(tool, rawArgs) {
  const v = TOOLS_ALLOWED[tool];
  if (!v) {
    if (NOT_YET[tool])
      return { error: `${tool} is not an MCP tool yet — ${NOT_YET[tool]}. Adding it means giving those markers a command that owns them; it is deliberately not done by writing them from here.`, status: 501 };
    return { error: `unknown tool '${tool}' (this server serves: ${Object.keys(TOOLS_ALLOWED).join(', ')})` };
  }
  const a = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = {};
  for (const k of Object.keys(a)) {
    if (!v.fields.includes(k)) return { error: `${tool}: unknown argument '${k}' (accepts: ${v.fields.join(', ') || 'none'})` };
  }
  for (const f of v.fields) {
    if (f === 'project' || a[f] === undefined) continue;
    if (IGNORED.has(`${tool}.${f}`)) continue;
    if (BOOLS.has(f)) { if (typeof a[f] !== 'boolean') return { error: `${tool}: '${f}' must be true or false` }; args[f] = a[f]; continue; }
    if (f === 'n') {
      const n = Number(a.n);
      if (!Number.isInteger(n) || n < 1 || n > 500) return { error: `${tool}: 'n' must be an integer 1-500` };
      args.n = n; continue;
    }
    if (typeof a[f] !== 'string') return { error: `${tool}: '${f}' must be a string` };
    args[f] = a[f];
  }
  // §1 again: a fleet-scoped tool with no project would fall back to whatever fleet this
  // daemon's environment happens to name — which is nobody's intent and, for stop, is
  // somebody else's worktree. There is no "own fleet" here, so say so and refuse.
  let t = null;
  if (!v.noProject) {
    if (typeof a.project !== 'string' || !a.project)
      return { error: `${tool}: 'project' is required — fleet-serve is not inside a fleet, so there is no default one` };
    const rp = resolveProject(a.project);
    if (rp.error) return { error: `${tool}: ${rp.error}` };
    t = rp.t;
    args.project = t.name;
  }
  return { args, t, v };
}

// ── running a verb ──────────────────────────────────────────────────────────
// Mutations run one at a time. A fleet is a thing you drive concurrently, and two
// simultaneous spawns racing on the same free worktree (or two stops on the same session)
// is a class of bug that costs a checkout to discover. Reads stay parallel.
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn));

// A removal the gates refused is what unlocks the force step, and nothing else is. Keyed
// off the commands' OWN refusal lines — fleet-stop prints "kept <path>", fleet-clean
// prints "keep <base> — <why>". If either line ever changes shape the force stops being
// offered, which is the safe direction for a detector to fail in: it declines to delete
// rather than deleting without the second step.
const REFUSED_RE = /^\s*(?:fleet-stop: kept |keep )/m;
const forceKey = (tool, args) => `${tool}:${args.project || '-'}:${args.session || args.path || '-'}`;

async function runVerb({ tool, rawArgs, client, ip, session, assertion }) {
  const built = buildArgs(tool, rawArgs);
  if (built.error) return { status: built.status || 400, json: { ok: false, text: built.error } };
  const { args, t, v } = built;

  // §7: a biometric prompt at the moment of action, so a phone in someone else's hand is
  // not the same as a phone plus its owner. Enforced here, on the tool name.
  let forcing = null;
  if (v.passkey) {
    if (!assertion)
      return { status: 401, json: { ok: false, text: `${tool} needs a fresh passkey assertion in X-Fleet-Assertion (§7: at the moment of action, not at the last unlock)`, needs: 'passkey' } };
    if (assertion.error) return { status: 401, json: { ok: false, text: assertion.error, needs: 'passkey' } };
    // ...and `f = remove anyway` is its OWN step, after a refusal it is answering. The
    // fresh assertion above is separate too: challenges are single-use, so the retry
    // cannot reuse the one the first attempt spent.
    if (args.force) {
      const k = forceKey(tool, args);
      if (!declined.has(k) || declined.get(k) <= now())
        return { status: 409, json: { ok: false, text: 'nothing to force: run it without force first and read why it declined. The grid only offers "f = remove anyway" on the refusal it is answering' } };
      forcing = k;
    }
  }
  if (forcing) declined.delete(forcing);   // one refusal buys exactly one force

  const subject = args[v.subject] || args.project || t?.name || '-';
  const summary = `${tool.replace(/^fleet_/, '')} ${Object.entries(args).filter(([k]) => k !== 'project')
    .map(([k, val]) => k === 'prompt' || k === 'text' ? `${k}=${String(val).slice(0, 60)}` : `${k}=${val}`).join(' ')}`.trim();

  const out = await callToolAsync(tool, args, { timeout: 15 * 60 * 1000 });
  const text = typeof out === 'string' ? out : String(out.text);
  const refused = typeof out !== 'string' && out.isError === true;

  if (v.write) {
    auditAppend({ ts: now(), client: client.id, ip, verb: tool, project: args.project || null, subject,
                  args: Object.fromEntries(Object.entries(args).map(([k, val]) =>
                    [k, typeof val === 'string' ? val.slice(0, 500) : val])),
                  // §7 again: the log says what the fingerprint was FOR, not merely that
                  // one happened. `purpose` is the client's own word for the tap.
                  confirmed: v.passkey ? `passkey:${assertion?.purpose || 'unnamed'}` : null,
                  result: refused ? 'refused' : 'ran',
                  output: text.slice(0, 500) });
    inboxRow(t, subject, `${summary}${refused ? ' — REFUSED' : ''} · from ${client.id}@${ip}`);
  }

  if (!args.force && (tool === 'fleet_stop' ? args.reclaim : tool === 'fleet_worktree_remove')) {
    const k = forceKey(tool, args);
    if (REFUSED_RE.test(text)) declined.set(k, now() + 600);
    else declined.delete(k);
  }
  // {ok, text} — the shape web/api.js reads, and it throws on !ok with `text` as the
  // message, so a refusal has to arrive as text rather than as a status code alone.
  return { status: refused ? 400 : 200, json: { ok: !refused, text } };
}

// ── reads: proxy, never reimplement (§3, one producer) ───────────────────────
// The grid already computes every field the phone needs, and it is the implementation
// with the scars — the narrow-pane spinner, `unknown` not being `idle`, `limit` not being
// folded into `ready`. So the phone renders from `fleet-grid.mjs --json` and this function
// does not interpret a single value it passes on.
const gridEnv = (t) => ({
  ...process.env, TMUX: '',
  CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_FLEET_DIR: path.join(t.cfg, 'fleet'),
  CLAUDE_FLEET_PROFILE: t.profile, CLAUDE_FLEET_SCOPE: t.name,
  CLAUDE_FLEET_ROOT: t.path, CLAUDE_FLEET_SOCK: t.sock,
  CLAUDE_FLEET_AGENT: t.agent || 'claude',
});

// NEVER launch the interactive grid headlessly — it blocks on the tty and hangs, and an
// unknown flag falls straight through to interactive mode. bin/ghostfleet already had to
// learn this for --order (it greps the grid for the flag before using it); same idiom
// here, so a runtime whose fleet-grid.mjs predates --json gets a 503 that names the flag
// instead of a request that never returns.
let gridSrc = null;
function gridHasFlag(flag) {
  if (gridSrc === null) { try { gridSrc = fs.readFileSync(GRID, 'utf8'); } catch { gridSrc = ''; } }
  return gridSrc.includes(`'${flag}'`);
}
const gridSupportsJson = () => gridHasFlag('--json');
const NINE = new Set(['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted']);

function gridJson(t) {
  return new Promise((resolve) => {
    execFile(process.execPath, [GRID, t.sock, TMUX_CONF, '--json'],
      // 64 MB. TWO fields in §4 are emitted WHOLE and are user-authored: `msg`, the last
      // assistant line, and since #41 `sched.msg`, the text a scheduled send will deliver.
      // Neither has a bound, and the cards multiply them. Measured on the live fleets:
      // superkey 17.5 KB across six sessions, getmycoi 13.3 KB — so this is three orders
      // of magnitude of headroom rather than a guess, and the overflow path below reports
      // itself instead of parsing a payload that was cut off mid-string.
      { encoding: 'utf8', env: gridEnv(t), timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve({ error: 'fleet-grid --json produced more output than this server will buffer — the payload was cut off, so it is refused rather than parsed short' });
        if (err && !stdout) return resolve({ error: `fleet-grid --json failed: ${(stderr || err.message).trim().split('\n')[0]}` });
        let j;
        try { j = JSON.parse(stdout); } catch { return resolve({ error: `fleet-grid --json did not print JSON: ${String(stdout).trim().slice(0, 200)}` }); }
        // Pass the payload through untouched — §4's rules 1-3 exist because collapsing a
        // status client-side is how the summary line starts lying. What we DO add is a
        // complaint when a value is outside the nine: a status this server does not
        // recognise is either their bug or a spec change, and it should be visible rather
        // than rendered as a confident dot it has not earned.
        const bad = [...new Set((j.cards || []).map(c => c && c.status).filter(s => !NINE.has(s)))];
        resolve({ json: bad.length ? { ...j, schema_warnings: [`status values outside the nine: ${bad.join(', ')}`] } : j });
      });
  });
}

// §11.3: pagination is a PERFORMANCE bound, not a security control, and the document is
// explicit that it must not be described as one. Content is served unredacted — the
// secret filter was considered and dropped, because under this transport there is no
// adversary it defends against and masking `sk_live_…` corrupts any session that is
// legitimately about key handling. What pagination is for: the largest transcript
// measured here is 46 MB, and that down a WireGuard tunnel on cellular is slow and
// expensive. So: a bounded page, 20 by default, with an explicit "load more".
//
// Through `fleet-read --json`, not by reading the transcript here. Finding a session's
// transcript on a given fleet is the part with the scars — a status file scoped by
// socket, a fallback rebuilt from session_id and the pane's cwd, and a deliberate refusal
// to take "the newest .jsonl in that directory" because several sessions can share a
// checkout and newest-wins prints a DIFFERENT session's conversation. One reader.
async function sessionMessages(t, session, limit, before) {
  const args = { project: t.name, session, json: true, limit, before };
  // 32 MB, not the 1 MB default: a page is 20 messages and a message is a whole assistant
  // turn, which is routinely tens of KB and occasionally far more. Overflow is not a
  // truncated page here — the dispatch refuses it by name — but the cap has to sit above
  // what a real conversation produces or an ordinary read starts failing.
  const out = await callToolAsync('fleet_read', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const text = typeof out === 'string' ? out : String(out.text);
  try { return { json: JSON.parse(text) }; }
  catch {
    // A runtime whose fleet-read predates --json prints its usage line here rather than
    // JSON. Say which flag is missing instead of handing the phone a parse error.
    return { error: /unknown option --json/.test(text)
      ? `this runtime's bin/fleet-read has no --json flag — it carries the per-message timestamp and role /api/session needs`
      : `fleet-read --json did not return JSON: ${text.trim().slice(0, 200)}` };
  }
}

// The checkouts the `n` (new session) picker offers. The phone has no filesystem of its
// own, so the daemon has to answer it — and the answer is the TUI's own
// discoverCheckouts(), reached through the flag it already has. Its output is three
// fixed lines; parsing them is still proxying, where a reimplementation of the
// config-then-name-roots-then-cwd search order would be a second answer to "which
// checkouts exist" that could disagree with the picker you are about to use.
function checkouts(t) {
  return new Promise((resolve) => {
    if (!gridHasFlag('--checkouts')) return resolve({ error: 'this fleet-grid.mjs has no --checkouts flag' });
    execFile(process.execPath, [GRID, t.sock, TMUX_CONF, '--checkouts'],
      { encoding: 'utf8', env: gridEnv(t), timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ error: `fleet-grid --checkouts failed: ${(stderr || err.message).trim().split('\n')[0]}` });
        const lines = String(stdout).split('\n');
        const rootLine = lines.find(l => l.startsWith('roots:')) || '';
        const roots = rootLine.slice(6).split(',').map(x => x.trim()).filter(x => x && x !== '(none)');
        const i = lines.findIndex(l => l.startsWith('checkouts:'));
        const cks = i < 0 ? [] : lines.slice(i + 1).map(l => l.trim()).filter(l => l && l !== '(none)');
        resolve({ json: { roots, checkouts: cks } });
      });
  });
}

// The per-session auto-nudge state, as the three markers the grid reads. Deliberately
// NOT bolted onto §4 — that schema is "exactly what cardLines() consumes" and this is not
// one of those fields, so widening it would put pressure on the one contract the whole
// design leans on.
//   This reads which marker EXISTS; it does not re-derive the precedence, which is
// fleet-grid.mjs's (most specific wins, then per-project, then the global default). The
// tri-state the client asked for is exactly the file question: `on`, `off`, `inherit`.
function nudgeSettings(t, sessionNames) {
  const dir = path.join(t.cfg, 'fleet');
  const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch { return false; } };
  const sessions = {};
  for (const n of sessionNames)
    sessions[n] = has(`${t.sock}.${n}.notify-lead`) ? 'on'
                : has(`${t.sock}.${n}.notify-lead-off`) ? 'off' : 'inherit';
  const projectOff = has(`${t.sock}.notify-lead-off`);
  const projectOn = has(`${t.sock}.notify-lead`);
  let globalDefault = false;
  try { globalDefault = fs.existsSync(path.join(CFG_HOME, 'notify-lead')); } catch {}
  return { global_nudge: projectOff ? false : (projectOn || globalDefault), sessions };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj) + '\n');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': body.length, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
async function readBody(req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > cap) { reject(new Error(`body larger than ${cap} bytes`)); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch (e) { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

// Which Host headers we answer to. A browser pointed at a name that resolves to our
// address can otherwise be used to reach us from a page we did not serve (DNS
// rebinding), and for an endpoint that spawns processes that is worth two lines.
// The EFFECTIVE bind/port, which --bind/--port can move off what the config says. The
// first cut built this set from the config's port only, so `--port N` started a daemon
// that then 403'd every single request as an unexpected Host — a server that looked up
// and answered nothing.
let listening = null;
function allowedHosts(c) {
  const h = new Set();
  for (const o of c.origins || []) { try { h.add(new URL(o).host); } catch {} }
  const port = listening?.port ?? c.port;
  for (const a of [c.bind, listening?.bind]) {
    const b = String(a || '').replace(/^\[|\]$/g, '');
    if (!b) continue;
    const lit = net.isIPv6(b) ? `[${b}]` : b;
    h.add(lit); h.add(`${lit}:${port}`);
  }
  if (c.rp_id) { h.add(c.rp_id); h.add(`${c.rp_id}:${port}`); }
  return h;
}

// web/api.js sends `Authorization: Bearer <token>` on everything and nothing else, so
// these three are the only paths reachable without one — they are how a token is
// obtained. Every other /api/* path requires a live, assertion-minted token.
const OPEN = new Set(['/api/auth/challenge', '/api/auth/register', '/api/auth/assert']);

function serveStatic(req, res, pathname) {
  // The app shell is unauthenticated on purpose: the passkey prompt lives inside it, so
  // it has to load before there is anything to authenticate with. Everything the shell
  // can actually DO is behind /api, which is where §5's enforcement belongs.
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); }
  catch { res.writeHead(400).end('bad path\n'); return; }
  // Decoded FIRST, on purpose. `new URL` collapses ../ in the path it parses, so the
  // check below would never fire on the obvious spelling and would be dead code you
  // could not tell from a working guard — but %2e%2e%2f survives that parse, and a proxy
  // in front of us can forward it untouched. Decode, resolve, then insist on the prefix.
  if (rel.includes('\0')) { res.writeHead(400).end('bad path\n'); return; }
  const full = path.resolve(WEB, rel);
  if (full !== WEB && !full.startsWith(WEB + path.sep)) { res.writeHead(403).end('no'); return; }
  let st;
  try { st = fs.statSync(full); } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(webPresent
      ? 'not found\n'
      : `fleet-serve ${VERSION} is up, but there is no client in ${WEB}. The API is at /api.\n` +
        `If this is the staged runtime, cf-sync has to copy web/ into it — check that its dir list includes it.\n`);
    return;
  }
  if (st.isDirectory()) { res.writeHead(404).end('not found\n'); return; }
  // An ES module served as text/plain is REFUSED by the browser, with a console error and
  // a blank page — and a blank page looks like the server is fine. MIME above has the
  // .js and .webmanifest types the client needs; anything not in it falls back to
  // octet-stream rather than to a guess.
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream',
    'content-length': st.size, 'cache-control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

// The assertion check, shared by "let me in" (/api/auth/assert) and "authorise this
// action" (the X-Fleet-Assertion header on a destructive verb). One implementation, so
// the second factor cannot end up weaker than the first — which is the shape this kind of
// bug takes.
function verifyAssertion(body, c) {
  for (const k of ['id', 'client_data', 'authenticator_data', 'signature'])
    if (typeof body[k] !== 'string' || !body[k]) return { error: `assertion is missing '${k}'` };
  const cl = clientByCredential(body.id);
  if (!cl) return { error: 'that credential is not enrolled here (or its client is revoked)' };
  const cred = (cl.creds || []).find(x => x.id === body.id);
  if (!ALG_OK.has(cred.alg)) return { error: `credential algorithm ${cred.alg} is not supported` };
  const clientData = Buffer.from(body.client_data, 'base64url');
  const cd = checkClientData(clientData, c, 'webauthn.get');
  if (cd.error) return { error: cd.error };
  let ad;
  try { ad = parseAuthData(Buffer.from(body.authenticator_data, 'base64url')); } catch (e) { return { error: e.message }; }
  if (!sameSecret(ad.rpIdHash.toString('hex'), sha256(c.rp_id))) return { error: `authenticator signed for a different rpId than '${c.rp_id}'` };
  if (!ad.up) return { error: 'user-presence flag is not set — the authenticator was not touched' };
  const data = Buffer.concat([Buffer.from(body.authenticator_data, 'base64url'),
                              crypto.createHash('sha256').update(clientData).digest()]);
  let ok = false;
  try { ok = verifySig(cred.jwk, cred.alg, data, Buffer.from(body.signature, 'base64url')); } catch (e) { return { error: `signature check failed: ${e.message}` }; }
  if (!ok) return { error: 'signature does not verify' };
  // A counter that goes backwards means two authenticators are answering for one
  // credential, i.e. a clone. Authenticators that do not implement counters leave it at
  // zero, and WebAuthn says to skip the check then rather than lock the user out.
  if (ad.signCount > 0 || cred.counter > 0) {
    if (ad.signCount <= cred.counter) return { error: `signature counter did not advance (${ad.signCount} <= ${cred.counter}) — possible cloned credential` };
    cred.counter = ad.signCount;
    try { saveConfig(c); } catch (e) { log('warn: could not persist signature counter:', e.message); }
  }
  return { client: cl, purpose: typeof body.purpose === 'string' ? body.purpose.slice(0, 40) : '' };
}

// Resolving a project is the one place SCOPE and ROOT come from, so it is also the place
// to refuse when they cannot be resolved. A registered project whose root has been moved
// or deleted still appears in the list; shelling out with it would hand fleet-grid.mjs a
// CLAUDE_FLEET_ROOT that resolves to nothing, and its free-worktree list is computed by
// pairing that root against the sessions on the socket — a mismatched pair cannot see the
// sessions, so OCCUPIED worktrees come back as free. On the phone that is a "reuse this
// free worktree" card naming a checkout with a live agent in it, and fleet_spawn --reuse
// behind it. Nothing about that response is malformed, which is exactly why it has to be
// refused here instead of returned.
function resolveProject(name) {
  if (!name) return { error: "'project' is required" };
  const t = projects().find(x => x.name === name || x.sock === name);
  if (!t) return { error: `unknown project '${name}'` };
  if (!t.path) return { error: `project '${t.name}' has no root in the projects file` };
  try { if (!fs.statSync(t.path).isDirectory()) throw new Error('not a directory'); }
  catch { return { error: `project '${t.name}' has root ${t.path}, which is not a directory on this machine — refusing to run against it rather than inherit a root that resolves to nothing` }; }
  return { t };
}
const proj = (name) => resolveProject(name).t || null;

async function api(req, res, url, ip) {
  let c;
  try { c = loadConfig(); } catch (e) { return send(res, 500, { ok: false, text: `config unreadable: ${e.message}` }); }
  const p = url.pathname;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  // Every POST is checked against the configured origins as well. A browser sends Origin
  // on a cross-site request; refusing an unrecognised one closes CSRF from any page that
  // is not ours, and costs a client of ours nothing.
  if (req.method === 'POST' && req.headers.origin && !(c.origins || []).includes(req.headers.origin))
    return send(res, 403, { ok: false, text: `origin '${req.headers.origin}' is not configured` });

  if (!rateOk(OPEN.has(p) ? 'auth' : (req.method === 'POST' ? 'write' : 'read'), ip, res))
    return send(res, 429, { ok: false, text: 'rate limited' });

  if (!OPEN.has(p)) {
    // THE POINT OF §5, and the only place it can be made: a lock that gates the UI is
    // decoration. There is no long-lived secret that opens this — the token below exists
    // only because a passkey signed a challenge minutes ago, and it expires.
    const s = liveSession(bearer);
    if (!s) return send(res, 401, { ok: false, text: 'no live session — assert a passkey at /api/auth (a token is only ever minted by one, and it expires)', needs: 'passkey' });
    req.client = s.cl; req.session = s;
    if (!rateOk(req.method === 'POST' ? 'write' : 'read', `id:${s.cl.id}`, res))
      return send(res, 429, { ok: false, text: 'rate limited' });
  }

  const body = req.method === 'POST' ? await readBody(req) : {};

  // ── auth: the passkey's three requests ────────────────────────────────────
  if (p === '/api/auth/challenge') {
    // GET, and unauthenticated: it is what a cold open asks for before it has anything.
    // Single-use and short-lived, so handing them out freely costs nothing.
    const first = (c.clients || []).find(x => !x.revoked && (x.creds || []).length);
    return send(res, 200, { challenge: newChallenge(), rp_id: c.rp_id, ttl: CHALLENGE_TTL,
      user: { id: (c.enroll && c.enroll.exp > now() ? c.enroll.id : first?.id) || 'ghostfleet',
              name: (c.enroll && c.enroll.exp > now() ? c.enroll.id : first?.id) || 'ghostfleet' },
      allow: (c.clients || []).filter(x => !x.revoked).flatMap(x => (x.creds || []).map(y => ({ type: 'public-key', id: y.id }))),
      enrolling: !!(c.enroll && c.enroll.exp > now()) });
  }

  if (p === '/api/auth/register') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, text: 'POST only' });
    // THE ONE PLACE I AM STRICTER THAN THE CONTRACT, deliberately. As written,
    // /api/auth/register takes an attestation and nothing else — so anyone who reaches
    // the port enrols their own passkey and is inside, on an endpoint whose own §1 says
    // it is remote code execution. Trust-on-first-use does not save it either: an
    // attacker who can reach the port can also win the race to be first.
    //   So registration needs a window somebody opened from the terminal
    // (`fleet-serve enroll <id>`) AND the one-time code it printed. That is one extra
    // field in the register body; there is no code-free path, because a window with no
    // code is a 15-minute hole and the hole is the whole thing being defended.
    const pend = c.enroll;
    if (!pend || pend.exp <= now())
      return send(res, 403, { ok: false, text: 'no enrolment is open. On the Mac: fleet-serve enroll <client-id> — it prints a one-time code' });
    if (typeof body.code !== 'string' || !sameSecret(sha256(normCode(body.code)), pend.code_sha256))
      return send(res, 403, { ok: false, text: 'wrong or missing enrolment code — send it as `code` in the register body (fleet-serve enroll printed it)' });
    for (const k of ['id', 'attestation', 'client_data'])
      if (typeof body[k] !== 'string' || !body[k]) return send(res, 400, { ok: false, text: `registration is missing '${k}'` });
    const clientData = Buffer.from(body.client_data, 'base64url');
    const cd = checkClientData(clientData, c, 'webauthn.create');
    if (cd.error) return send(res, 400, { ok: false, text: cd.error });
    let ad, key;
    try {
      const { value } = cborDecode(Buffer.from(body.attestation, 'base64url'));
      const authData = value.get('authData');
      if (!Buffer.isBuffer(authData)) return send(res, 400, { ok: false, text: 'attestationObject has no authData' });
      ad = parseAuthData(authData);
      if (!ad.at || !ad.cose) return send(res, 400, { ok: false, text: 'no attested credential data' });
      key = coseToJwk(ad.cose);
    } catch (e) { return send(res, 400, { ok: false, text: `attestation could not be parsed: ${e.message}` }); }
    if (!sameSecret(ad.rpIdHash.toString('hex'), sha256(c.rp_id))) return send(res, 400, { ok: false, text: `credential was created for a different rpId than '${c.rp_id}'` });
    if (!ad.up) return send(res, 400, { ok: false, text: 'user-presence flag is not set' });
    if (!ALG_OK.has(key.alg)) return send(res, 400, { ok: false, text: `algorithm ${key.alg} is not supported (ES256 or RS256)` });
    if (b64u(ad.credId) !== body.id) return send(res, 400, { ok: false, text: "the credential id does not match the authenticator's own" });

    const cred = { id: b64u(ad.credId), jwk: key.jwk, alg: key.alg, counter: ad.signCount, created: now() };
    let cl = c.clients.find(x => x.id === pend.id);
    if (cl) {
      if ((cl.creds || []).some(x => x.id === cred.id)) return send(res, 409, { ok: false, text: 'that passkey is already enrolled' });
      cl.creds = [...(cl.creds || []), cred];
      cl.revoked = false;
    } else {
      cl = { id: pend.id, created: now(), revoked: false, creds: [cred] };
      c.clients.push(cl);
    }
    c.enroll = null;
    saveConfig(c);
    auditAppend({ ts: now(), client: cl.id, ip, verb: 'enroll', subject: cred.id.slice(0, 12), result: 'ran',
                  output: `passkey enrolled (${(cl.creds || []).length} on this client)` });
    log(`enrolled '${cl.id}' passkey ${cred.id.slice(0, 12)}… from ${ip}`);
    const sess = mintSession(cl.id, 'register');
    return send(res, 200, { ok: true, client_id: cl.id, token: sess.token, expires_at: sess.expires_at });
  }

  if (p === '/api/auth/assert') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, text: 'POST only' });
    const v = verifyAssertion(body, c);
    if (v.error) { log(`auth FAILED from ${ip}: ${v.error}`); return send(res, 401, { ok: false, text: v.error }); }
    const sess = mintSession(v.client.id, v.purpose || 'open');
    log(`session for '${v.client.id}' from ${ip} (${sess.ttl}s, ${v.purpose || 'open'})`);
    return send(res, 200, { ok: true, token: sess.token, expires_at: sess.expires_at, client_id: v.client.id });
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  if (p === '/api/projects' && req.method === 'GET') {
    // `home` is what the client abbreviates paths against (grid.js's homeTilde), so the
    // phone shows ~/superkey the way the TUI does.
    //
    // The per-project rollup comes from the grid's CARDS, counted here — never from
    // summing `counts`. §4's counts object carries six keys while a card can hold nine
    // statuses, so `idle`, `starting` and `unknown` are counted by nobody: a sum is not
    // the number of sessions, and the remainder is not one status. Getting that wrong on
    // the Projects screen would be the summary line lying at a glance, which is the one
    // place docs/mobile.md says it must not.
    const rollup = url.searchParams.get('rollup') !== '0' && gridSupportsJson();
    const all = projects();
    const counted = await Promise.all(all.map(async (t) => {
      let live = 0;
      try { live = execFileSync('tmux', ['-L', t.sock, 'list-sessions', '-F', '#{session_name}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length; } catch {}
      const row = { name: t.name, profile: t.profile, path: t.path, agent: t.agent || 'claude', sock: t.sock, live };
      if (!rollup) return row;
      const g = await gridJson(t);
      if (g.error) return { ...row, sessions: null };
      const cards = g.json.cards || [];
      return { ...row, sessions: {
        need: cards.filter(x => x.status === 'need-you').length,
        working: cards.filter(x => x.status === 'working').length,
        parked: cards.filter(x => x.status === 'parked').length,
        total: cards.length } };
    }));
    return send(res, 200, { home: HOME, projects: counted });
  }

  if (p === '/api/grid' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    if (!gridSupportsJson())
      return send(res, 503, { ok: false, text: `this fleet-grid.mjs has no --json flag (${GRID}). It is §4 of docs/mobile.md; the grid is never launched without it, because an unknown flag falls through to the interactive TUI and blocks on the tty.` });
    const r = await gridJson(t);
    // §4, verbatim — no wrapper. The client reads .cards/.counts/.project off the top
    // level and decides success from the HTTP status, so an envelope here would be a
    // second shape for the same payload.
    return r.error ? send(res, 502, { ok: false, text: r.error }) : send(res, 200, r.json);
  }

  if (p === '/api/session' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    const session = url.searchParams.get('session') || '';
    if (!session) return send(res, 400, { ok: false, text: 'session is required' });
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      return send(res, 400, { ok: false, text: 'limit must be an integer 1-500' });
    const r = await sessionMessages(t, session, limit, url.searchParams.get('before'));
    return r.error ? send(res, 502, { ok: false, text: r.error }) : send(res, 200, r.json);
  }

  if (p === '/api/checkouts' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    const r = await checkouts(t);
    return r.error ? send(res, 502, { ok: false, text: r.error }) : send(res, 200, r.json);
  }

  if (p === '/api/settings' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    let names = [];
    try { names = execFileSync('tmux', ['-L', t.sock, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch {}
    return send(res, 200, nudgeSettings(t, names));
  }

  if (p === '/api/inbox' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    // --all, always. The default mode CONSUMES the "new since last look" marker, and a
    // glance from the phone must not decide that the lead at the desk has already seen a
    // worker's need-you.
    const out = await callToolAsync('fleet_inbox', { project: t.name, all: true }, { timeout: 30000 });
    return send(res, 200, { ok: true, project: t.name, text: typeof out === 'string' ? out : String(out.text) });
  }

  if (p === '/api/worktrees' && req.method === 'GET') {
    const rp = resolveProject(url.searchParams.get('project') || '');
    if (rp.error) return send(res, 400, { ok: false, text: rp.error });
    const t = rp.t;
    const out = await callToolAsync('fleet_worktrees', { project: t.name }, { timeout: 60000 });
    return send(res, 200, { ok: true, project: t.name, text: typeof out === 'string' ? out : String(out.text) });
  }

  if (p === '/api/audit' && req.method === 'GET') {
    // §12: "the audit log is only useful if something reads it." It reaches the grid as
    // an inbox row; it reaches the phone here.
    let lines = [];
    try { lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean); } catch {}
    const lim = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 50) || 50));
    return send(res, 200, { ok: true, chain: auditVerify(), total: lines.length,
      rows: lines.slice(-lim).map(l => { try { return JSON.parse(l); } catch { return { unparseable: l }; } }) });
  }

  if (p === '/api/health' && req.method === 'GET') {
    const f = funnelState();
    return send(res, 200, { ok: true, version: VERSION, bind: c.bind, port: listening?.port ?? c.port,
      client: req.client.id, session_expires_in: req.session.exp - now(),
      grid_json: gridSupportsJson(), web: webPresent ? WEB : null, awake: awakeHeld,
      funnel: f.checked ? (f.on.length ? { on: f.on } : 'off') : `unverified (${f.why})`,
      audit: auditVerify() });
  }

  if (p === '/api/verbs' && req.method === 'GET')
    // For the client's benefit only — what it draws is a suggestion, and every flag here
    // is enforced in runVerb().
    return send(res, 200, { ok: true,
      tools: Object.fromEntries(Object.entries(TOOLS_ALLOWED).map(([k, v]) =>
        [k, { fields: v.fields, mutating: !!v.write, passkey: !!v.passkey, needs_project: !v.noProject }])),
      not_yet: NOT_YET });

  // ── writes ────────────────────────────────────────────────────────────────
  if (p === '/api/verb') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, text: 'POST only' });
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const v = TOOLS_ALLOWED[tool];
    if (!v) {
      const b = buildArgs(tool, body.args);
      return send(res, b.status || 400, { ok: false, text: b.error });
    }
    // The destructive verbs' fresh assertion travels in a header (web/api.js), verified
    // here against a challenge we issued and have not seen before.
    let assertion = null;
    const hdr = req.headers['x-fleet-assertion'];
    if (hdr) {
      let parsed;
      try { parsed = JSON.parse(Array.isArray(hdr) ? hdr[0] : hdr); }
      catch { assertion = { error: 'X-Fleet-Assertion is not JSON' }; }
      if (parsed) {
        const r = verifyAssertion(parsed, c);
        // An assertion signed by a DIFFERENT enrolled client is not this session's
        // confirmation: the token and the fingerprint have to be the same person.
        assertion = r.error ? { error: r.error }
                  : r.client.id !== req.client.id ? { error: 'that assertion belongs to another enrolled client' }
                  : { purpose: r.purpose };
      }
    }
    const go = () => runVerb({ tool, rawArgs: body.args, client: req.client, ip, session: req.session, assertion });
    const r = v.write ? await serialize(go) : await go();
    return send(res, r.status, r.json);
  }

  return send(res, 404, { ok: false, text: `no such endpoint: ${p}` });
}

let awakeHeld = false;
// Resolved ONCE, at startup, and reported there. bin/fleet-serve.mjs runs from wherever
// it was staged, so WEB is the runtime's web/ when the runtime is what is running — but
// cf-sync mirrors a hardcoded dir list, and web/ was not on it, so a staged runtime had
// no client at all while the repo looked perfect. That is CLAUDE.md's repo-vs-runtime
// trap, and a 404 per request is the worst way to learn it: it looks like the client's
// bug. One line at boot instead.
let webPresent = false;

function requestHandler(req, res) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const t0 = Date.now();
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  // Self-contained client, no third-party anything: the strictest policy that still works
  // is the correct one for a page that can spawn processes.
  res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.on('finish', () => {
    if (req.url !== '/healthz') log(`${ip} ${req.method} ${(req.url || '').split('?')[0]} -> ${res.statusCode} ${Date.now() - t0}ms${req.client ? ` [${req.client.id}]` : ''}`);
  });

  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { ok: false, error: 'bad request line' }); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n'); return; }

  let c;
  try { c = loadConfig(); } catch (e) { log('config:', e.message); return send(res, 500, { ok: false, error: `config unreadable: ${e.message}` }); }
  const hosts = allowedHosts(c);
  if (req.headers.host && hosts.size && !hosts.has(req.headers.host))
    return send(res, 403, { ok: false, error: `unexpected Host '${req.headers.host}' — this server answers to ${[...hosts].join(', ')}` });

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  api(req, res, url, ip).catch((e) => {
    log('error:', e.stack || e.message);
    if (!res.headersSent) send(res, e.message?.startsWith('body') ? 400 : 500, { ok: false, error: e.message || 'internal error' });
  });
}

// ── availability (§8) ───────────────────────────────────────────────────────
// The measurement that nearly sinks the whole design: this machine is set to sleep after
// one minute idle ON AC AS WELL AS BATTERY, and the fleet survives today only because
// `ttyskeepawake` holds it up while tmux ttys are active. That is incidental, not
// designed — quiet ttys and the machine sleeps, and the phone sees nothing with no
// explanation. So hold an inhibitor for as long as we run.
//
// Through bin/fleet-awake rather than calling caffeinate here: it already carries the
// platform guard (caffeinate on macOS, systemd-inhibit on Linux, a deliberate no-op on
// WSL and anything else) and the de-duplication, and CLAUDE.md is explicit that
// macOS-only calls need one. It watches a pid, and the pid it is given is ours.
function awakeMode() {
  const env = (process.env.CLAUDE_FLEET_AWAKE || '').trim();
  if (env) return env;
  try { return fs.readFileSync(path.join(CFG_HOME, 'awake'), 'utf8').trim(); } catch { return 'on'; }
}
function armAwake() {
  const mode = awakeMode() || 'on';
  if (/^(0|off|no|false)$/i.test(mode)) { awakeHeld = 'off (CLAUDE_FLEET_AWAKE)'; log('awake: not holding —', mode); return; }
  const bin = path.join(BIN, 'fleet-awake');
  if (!fs.existsSync(bin)) { awakeHeld = 'unavailable (no fleet-awake)'; return; }
  const args = /^(display|screen)$/i.test(mode) ? ['--display', String(process.pid)] : [String(process.pid)];
  try {
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
    awakeHeld = `armed (fleet-awake ${args.join(' ')})`;
  } catch (e) { awakeHeld = `failed (${e.message})`; return; }
  // Proof, not assertion: ask the OS what it is actually holding. A guard that never
  // fires looks identical to one that works, and on a platform with no inhibitor this is
  // the line that says so out loud instead of leaving a silent no-op behind.
  //
  // And it must be OUR hold. The first cut printed the first line `fleet-awake --status`
  // returned, which on this machine was an inhibitor some unrelated shell had been
  // holding for hours — a status line that reads "holding" no matter what we did, which
  // is the precise failure this check exists to catch. Match on our own pid or say no.
  setTimeout(() => {
    execFile(bin, ['--status'], { encoding: 'utf8', timeout: 5000 }, (_e, out) => {
      const lines = String(out || '').trim().split('\n');
      const ours = lines.find(l => l.includes(`for pid ${process.pid} `));
      awakeHeld = ours || `NOT held for pid ${process.pid} — ${lines[0] || '(no answer)'}`;
      log('awake:', awakeHeld);
    });
  }, 1500).unref?.();
}
// The other half of §8, which fleet-serve cannot fix and must not try to: `sudo pmset -c
// sleep 0` is a precondition the user runs. Reported, never attempted.
function pmsetWarning() {
  if (process.platform !== 'darwin') return null;
  let out;
  try { out = execFileSync('pmset', ['-g', 'custom'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
  catch { return null; }
  const ac = out.split(/AC Power:/)[1] || '';
  const m = ac.match(/\bsleep\s+(\d+)/);
  if (!m || m[1] === '0') return null;
  return `the Mac is set to sleep after ${m[1]} min idle on AC (pmset -g custom). A slept machine freezes every worker mid-turn and the phone sees nothing. Run:  sudo pmset -c sleep 0`;
}

// ── starting up ─────────────────────────────────────────────────────────────
async function serve(argv) {
  const c = loadConfig();
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const bind = flag('--bind') || c.bind;
  const port = Number(flag('--port') || c.port || 8787);

  // fs.writeSync, not console.error. Every refusal here is MULTI-LINE — the bind refusal
  // lists each address this machine has — and console.error to a pipe is asynchronous, so
  // process.exit() on the next line discards whatever had not drained. The reason it
  // refused is the entire value of refusing, and a truncated one is worse than none. This
  // is also the one exit that has to work from inside a listen-error callback, where
  // returning a code is not available.
  const die = (lines) => {
    try { fs.writeSync(2, [].concat(lines).map(l => `fleet-serve: ${l}\n`).join('')); }
    catch { for (const l of [].concat(lines)) console.error(`fleet-serve: ${l}`); }
    process.exit(1);
  };

  // FAIL CLOSED, AND SAY WHY. There is no default bind address on purpose: a default is
  // how a service ends up on 0.0.0.0 without anyone deciding it should be.
  if (!bind) die([
    'no bind address configured, and there is no default — this endpoint is remote code',
    "execution (docs/mobile.md §1), so it binds where you say and nowhere else.",
    `  fleet-serve init --bind 127.0.0.1          # loopback, for local work or a tunnel`,
    `  fleet-serve init --bind "$(command -v tailscale >/dev/null && tailscale ip -4 || echo 100.x.y.z)" --rp-id <name>.ts.net`,
    `  config: ${CONFIG}`,
  ]);
  const b = await assertBindable(bind);
  if (!b.ok) die([
    `refusing to bind '${bind}':`,
    ...b.why.map(w => `  - ${w}`),
    'only loopback and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) are allowed — the two',
    'transports docs/mobile.md §5 sanctions both land inside that, and a wildcard or a LAN',
    'address would publish an RCE endpoint to whatever network this machine is on.',
    'addresses this machine has:',
    ...localAddrs().map(a => `  - ${a.address}  (${a.iface}, ${a.kind})`),
  ]);
  const kind = b.addrs[0].kind;

  // §11.1: Funnel is the one setting that would undo all of §5, so it is asserted rather
  // than remembered — and reported as UNVERIFIED, not as a pass, when the CLI is absent.
  const f = funnelState();
  if (f.checked && f.on.length) die([
    `Tailscale Funnel is ON for ${f.on.join(', ')} — that publishes to the public internet,`,
    'which is the single setting docs/mobile.md §5 rules out. Turn it off and start again:',
    '  tailscale funnel off',
  ]);
  if (!c.rp_id || !(c.origins || []).length) die([
    'rp_id and origins must be configured — a WebAuthn assertion is checked against them,',
    'and an unset origin would accept an assertion made for any site.',
    `  fleet-serve init --bind ${bind} --port ${port} [--rp-id <host>]`,
  ]);

  const server = c.tls
    ? https.createServer({ cert: fs.readFileSync(c.tls.cert), key: fs.readFileSync(c.tls.key) }, requestHandler)
    : http.createServer(requestHandler);
  server.headersTimeout = 20000;
  server.requestTimeout = 20 * 60 * 1000;      // a spawn can legitimately take minutes
  server.keepAliveTimeout = 65000;
  server.maxConnections = 64;
  server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });

  await new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRNOTAVAIL') die([`${bind} is not an address on this machine right now.`,
        kind === 'tailnet' ? '  is tailscaled up and signed in?  tailscale status' : '']);
      if (e.code === 'EADDRINUSE') die([`port ${port} is already in use on ${bind} — another fleet-serve?`]);
      die([`listen failed: ${e.message}`]);
    });
    server.listen(port, bind, resolve);
  });

  listening = { bind, port };
  log(`fleet-serve ${VERSION} listening on ${net.isIPv6(bind) ? `[${bind}]` : bind}:${port} (${kind}${c.tls ? ', tls' : ''})`);
  log(`  config ${CONFIG} · audit ${AUDIT} · rp_id ${c.rp_id} · origins ${c.origins.join(' ')}`);
  if (!f.checked) log(`  funnel: UNVERIFIED — ${f.why}. Assert it by hand: tailscale funnel status`);
  else log('  funnel: off (asserted)');
  webPresent = (() => { try { return fs.statSync(WEB).isDirectory(); } catch { return false; } })();
  log(webPresent ? `  client: ${WEB}` :
    `  client: NONE at ${WEB} — the API works, but there is no PWA to open. If this is the staged runtime, cf-sync's dir list has to include web/.`);
  if (kind === 'loopback') log('  loopback only: reachable from this machine (and from a tunnel process on it), nothing else');
  // An overridden port leaves the configured origins naming the old one, and WebAuthn is
  // checked against those — so the passkey would be refused with a confusing message
  // rather than an obvious one. Say it here instead.
  if (port !== c.port || bind !== c.bind)
    log(`  WARNING: --bind/--port override the config (${c.bind}:${c.port}); origins still say ${c.origins.join(' ')}, and a passkey is checked against those. Re-run \`fleet-serve init\` to make this permanent.`);
  if (kind === 'tailnet' && !c.tls) log('  WARNING: no TLS. WireGuard encrypts the hop, but a browser will refuse WebAuthn on a non-localhost http:// origin. Get a cert: tailscale cert <name>.ts.net');
  const pm = pmsetWarning();
  if (pm) log(`  WARNING: ${pm}`);
  if (!c.clients.length) log('  no clients enrolled yet — run: fleet-serve enroll phone');
  const ch0 = auditVerify();
  if (!ch0.ok && ch0.n) log(`  WARNING: audit chain broken at row ${ch0.at} (${ch0.why})`);
  armAwake();
  setInterval(sweep, 30000).unref();
  // SHUTTING DOWN IS THE SAME TRUNCATION BUG AS process.exit() AFTER A console.log, one
  // layer out: a socket write is asynchronous, so tearing the process down while a
  // response is still draining cuts it at the pipe buffer with no error on either side —
  // and from the phone that is a malformed body, not a failed request. So: stop accepting,
  // let the in-flight ones finish, drop the idle keep-alives that would otherwise hold
  // close() open forever, and only cut things off after a grace long enough for a real
  // response — saying so when it comes to that, rather than exiting silently.
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
    if (stopping) { log(`${sig} again — exiting now`); process.exit(1); }
    stopping = true;
    log(`${sig} — draining, then stopping`);
    server.close(() => { log('stopped'); process.exit(0); });
    server.closeIdleConnections?.();
    setTimeout(() => { log('grace expired with a request still open — cutting it off'); process.exit(0); }, 15000).unref();
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';    // no 0/O/1/I/L/U: it gets typed on a phone
const enrolCode = () => Array.from(crypto.randomBytes(10)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('').replace(/(.{5})(.{5})/, '$1-$2');

const USAGE = `fleet-serve — the fleet's HTTP endpoint, for the phone (docs/mobile.md)

  fleet-serve [--bind ADDR] [--port N]     run the daemon
  fleet-serve init --bind ADDR [--port N] [--rp-id HOST] [--origin URL]
  fleet-serve enroll <client-id> [--add]   open a one-time enrolment for a passkey
  fleet-serve clients                      who is enrolled, and who is revoked
  fleet-serve revoke <client-id>           kill a client's token and its live sessions
  fleet-serve audit [-n N] [--verify]      the append-only log of every mutation
  fleet-serve check                        preflight: bind, funnel, config — no listen
  fleet-serve check-bind <addr>            classify one address and exit

Bind refusal is not configurable: loopback and the tailnet only. See §1 and §5.
Config: ${CONFIG}`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : (argv.includes('-h') || argv.includes('--help') ? 'help' : 'serve');
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

  if (cmd === 'help') { console.log(USAGE); return; }

  if (cmd === 'check-bind') {
    // An EMPTY address is a thing to classify, not a usage error: `"bind": ""` in the
    // config is a real state, and this is where you ask what would happen. Only a
    // MISSING argument is the usage error.
    const addr = argv[1];
    if (addr === undefined) { console.error('fleet-serve: check-bind needs an address (use "" to ask about an unset one)'); process.exitCode = 2; return; }
    const r = await assertBindable(addr, { requireLocal: !argv.includes('--any') });
    const c0 = classifyAddr(addr);
    console.log(`${addr}  ->  ${(r.addrs || [{ kind: c0.kind }]).map(a => `${a.address || addr} (${a.kind})`).join(', ')}`);
    if (r.ok) { console.log('bindable: yes'); return; }
    console.log('bindable: no');
    for (const w of r.why) console.log(`  - ${w}`);
    process.exitCode = 1; return;
  }

  // process.exit() DISCARDS a pending stdout write: a pipe is asynchronous on macOS, so
  // a `console.log` big enough to fill the 64KB buffer is truncated mid-write with no
  // error on either side (measured next door: 200,000 bytes written, 65,536 arriving,
  // JSON stopping mid-string). Set the code and RETURN — node exits when the writes have
  // drained. Used by every path below that prints before it fails.
  if (cmd === 'check') {
    const c = loadConfig();
    const b = c.bind ? await assertBindable(c.bind) : { ok: false, why: ['no bind address configured'] };
    const f = funnelState();
    const chain = auditVerify();
    const pm = pmsetWarning();
    console.log(`config     ${CONFIG}${stampOf(CONFIG) ? '' : '  (missing)'}`);
    console.log(`bind       ${c.bind || '(unset)'}:${c.port}  ->  ${b.ok ? 'ok' : 'REFUSED'}`);
    if (!b.ok) for (const w of b.why) console.log(`             - ${w}`);
    console.log(`rp_id      ${c.rp_id || '(unset)'}`);
    console.log(`origins    ${(c.origins || []).join(' ') || '(unset)'}`);
    console.log(`tls        ${c.tls ? `${c.tls.cert}` : 'none'}`);
    console.log(`clients    ${c.clients.length ? c.clients.map(x => `${x.id}${x.revoked ? ' (revoked)' : ''}/${(x.creds || []).length} passkeys`).join(', ') : '(none enrolled)'}`);
    console.log(`grid --json ${gridSupportsJson() ? 'present' : 'MISSING — /api/grid will 503'}`);
    console.log(`client     ${(() => { try { return fs.statSync(WEB).isDirectory() ? WEB : `${WEB} is not a directory`; } catch { return `NONE at ${WEB}`; } })()}`);
    console.log(`funnel     ${f.checked ? (f.on.length ? `ON for ${f.on.join(', ')} — REFUSED` : 'off (asserted)') : `unverified (${f.why})`}`);
    console.log(`audit      ${chain.ok ? `ok, ${chain.n} rows` : `BROKEN at row ${chain.at}: ${chain.why}`}`);
    console.log(`awake      ${awakeMode()}`);
    if (pm) console.log(`sleep      WARNING: ${pm}`);
    const bad = !b.ok || !c.rp_id || !(c.origins || []).length || (f.checked && f.on.length) || (!chain.ok && chain.n);
    process.exitCode = bad ? 1 : 0; return;
  }

  if (cmd === 'init') {
    const bind = flag('--bind');
    if (!bind) { console.error('fleet-serve: init needs --bind (there is deliberately no default)'); process.exitCode = 2; return; }
    const r = await assertBindable(bind);
    if (!r.ok) { for (const w of r.why) console.error(`fleet-serve: ${w}`); process.exitCode = 1; return; }
    const port = Number(flag('--port') || 8787);
    const kind = r.addrs[0].kind;
    const rp = flag('--rp-id') || (kind === 'loopback' ? 'localhost' : null);
    if (!rp) { console.error('fleet-serve: --rp-id is required for a non-loopback bind (the MagicDNS name the phone will open)'); process.exitCode = 2; return; }
    const scheme = kind === 'loopback' && !flag('--origin') ? 'http' : 'https';
    const origin = flag('--origin') || `${scheme}://${rp}${(scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : ':' + port}`;
    const c = loadConfig();
    saveConfig({ ...c, bind, port, rp_id: rp, origins: [origin] });
    console.log(`fleet-serve: wrote ${CONFIG}`);
    console.log(`  bind ${bind}:${port} (${kind}) · rp_id ${rp} · origin ${origin}`);
    console.log(`  next: fleet-serve enroll phone`);
    return;
  }

  if (cmd === 'enroll') {
    const id = argv[1];
    if (!id || !/^[A-Za-z0-9._-]{1,32}$/.test(id)) { console.error('fleet-serve: enroll needs a client id (A-Za-z0-9._-)'); process.exitCode = 2; return; }
    const c = loadConfig();
    const existing = c.clients.find(x => x.id === id);
    if (existing && !argv.includes('--add')) {
      console.error(`fleet-serve: '${id}' is already enrolled (${(existing.creds || []).length} passkeys).`);
      console.error(`  add another passkey to it:  fleet-serve enroll ${id} --add`);
      console.error(`  or revoke it and start over: fleet-serve revoke ${id}`);
      process.exitCode = 1; return;
    }
    if (!existing && argv.includes('--add')) { console.error(`fleet-serve: no client '${id}' to add a passkey to`); process.exitCode = 1; return; }
    const code = enrolCode();
    c.enroll = { id, code_sha256: sha256(normCode(code)), exp: now() + (c.enroll_ttl || 900) };
    saveConfig(c);
    console.log(`enrolment open for '${id}' — ${Math.round((c.enroll_ttl || 900) / 60)} minutes, one use.`);
    console.log(`\n    code:  ${code}\n`);
    console.log(`Open ${(c.origins || ['(no origin configured)'])[0]} on the phone and enter it.`);
    console.log(existing ? 'It adds a passkey to that client.'
                         : 'It enrols the passkey; from then on the phone signs in with it.');
    console.log('A running daemon picks this up on its next request; no restart needed.');
    return;
  }

  if (cmd === 'clients') {
    const c = loadConfig();
    if (!c.clients.length) { console.log('(no clients enrolled)'); return; }
    console.log(`${'CLIENT'.padEnd(18)} ${'STATE'.padEnd(9)} ${'PASSKEYS'.padEnd(9)} CREATED`);
    for (const x of c.clients)
      console.log(`${x.id.padEnd(18)} ${(x.revoked ? 'revoked' : 'active').padEnd(9)} ${String((x.creds || []).length).padEnd(9)} ${new Date((x.created || 0) * 1000).toISOString().slice(0, 16).replace('T', ' ')}`);
    if (c.enroll && c.enroll.exp > now()) console.log(`\nenrolment open for '${c.enroll.id}' (${c.enroll.exp - now()}s left)`);
    return;
  }

  // §12: "revocation has to be one action and it has to be testable." This is the one
  // action. It kills the bearer token by dropping its digest, so nothing can present it
  // again, and it leaves the row behind marked revoked rather than deleting it — the
  // record of which device this was is the thing you want afterwards. A daemon already
  // running notices on its next request (the config's mtime moved), and liveSession()
  // re-checks the client every time, so its live sessions die with it too.
  if (cmd === 'revoke') {
    const id = argv[1];
    const c = loadConfig();
    const x = c.clients.find(y => y.id === id);
    if (!x) { console.error(`fleet-serve: no client '${id}' (see: fleet-serve clients)`); process.exitCode = 1; return; }
    // Drop the CREDENTIALS: with one token, minted only by an assertion, the enrolled
    // passkey is the device identity, so removing it is what stops a lost phone getting
    // another token. The row stays, marked revoked — the record of which device this was
    // is the thing you want afterwards.
    x.revoked = true; x.creds = []; x.revoked_at = now();
    saveConfig(c);
    auditAppend({ ts: now(), client: id, ip: 'cli', verb: 'revoke', subject: id, result: 'ran', output: 'token and passkeys removed' });
    console.log(`fleet-serve: revoked '${id}' — bearer token and passkeys dropped; its live sessions die on the daemon's next request.`);
    return;
  }

  if (cmd === 'audit') {
    if (argv.includes('--verify')) {
      const r = auditVerify();
      console.log(r.ok ? `audit: chain intact, ${r.n} rows` : `audit: BROKEN at row ${r.at}${r.n ? `/${r.n}` : ''} — ${r.why}`);
      process.exitCode = r.ok ? 0 : 1; return;
    }
    let lines = [];
    try { lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean); } catch { console.log('(no audit log yet)'); return; }
    const n = Number(flag('-n') || 20);
    for (const l of lines.slice(-Math.max(1, n))) {
      let o; try { o = JSON.parse(l); } catch { console.log(`?? ${l}`); continue; }
      console.log(`${new Date((o.ts || 0) * 1000).toISOString().slice(0, 19).replace('T', ' ')}  ${String(o.client || '-').padEnd(12)} ${String(o.verb || '-').padEnd(12)} ${String(o.subject || '-').padEnd(16)} ${o.result || '-'}${o.confirmed ? ' ' + o.confirmed : ''}`);
    }
    return;
  }

  if (cmd === 'serve') return serve(argv);
  console.error(`fleet-serve: unknown command '${cmd}'\n`);
  console.error(USAGE);
  process.exitCode = 2;
}

// Importable for the test suite (classifyAddr / assertBindable / cborDecode) without
// starting a server: only a direct run gets a main().
let direct = false;
try { direct = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) main().catch((e) => { console.error(`fleet-serve: ${e.stack || e.message}`); process.exitCode = 1; });
