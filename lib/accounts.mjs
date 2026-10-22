// lib/accounts.mjs — several Claude logins for ONE profile, and moving the profile
// between them when the one in use runs low. [experimental] `fleet-experimental enable
// accounts`; with it off nothing here runs and nothing it reads or writes exists.
//
// ── WHAT AN ACCOUNT IS ─────────────────────────────────────────────────────────────
// A profile is one config dir (~/.claude, ~/.claude-<p>) and stays one. Its conversations,
// settings, plugins, folder trust and fleet dir never move. What changes is the LOGIN that
// config dir holds — exactly what `/login` to another account does by hand — so an
// account here is a SAVED LOGIN, and switching is putting a different saved login where
// Claude Code reads its own, then relaunching the profile's sessions (each at its turn's
// end) onto it.
//
// ── WHERE CLAUDE CODE KEEPS THE LOGIN (read off the 2.1.295 binary, not guessed) ────────
//   macOS   a generic-password Keychain item, service `Claude Code-credentials-<h>` where
//           h = sha256(CLAUDE_CONFIG_DIR, NFC).hex[0..8] — the suffix is there whenever the
//           variable is SET, and every fleet session is launched with it set, ~/.claude
//           included — and account $USER (or `claude-code-user` when $USER has characters
//           outside [A-Za-z0-9._-]). Written with `security -i` and the value hex-encoded
//           on STDIN (`add-generic-password -U -a … -s … -X <hex>`), argv only past 4032
//           characters. The value is JSON; the login is its `claudeAiOauth` object
//           {accessToken, refreshToken, expiresAt (ms), refreshTokenExpiresAt, scopes,
//           subscriptionType, rateLimitTier, clientId}. Other keys (MCP servers' own OAuth)
//           belong to the config dir, not the account, and are left as they are.
//   Linux   <config dir>/.credentials.json, same JSON.
//   both    <config dir>/.claude.json `oauthAccount` — who the login is (accountUuid,
//           organizationUuid, email…). <config dir>/.config.json instead when that exists,
//           which is the binary's own legacy rule.
//
// ── WHERE A SAVED ACCOUNT IS KEPT ───────────────────────────────────────────────────
// Only in the OS secret store: on macOS a Keychain item of ghostfleet's own (service
// `ghostfleet-claude-login`, account `<profile>.<name>`), on Linux a 0600 file beside
// .credentials.json (.credentials.ghostfleet-<name>.json). The profile's accounts.json
// holds names, order, readings and a one-way id of each login — never a token. Nothing
// here prints, logs or records a token.
//
// ── TOKENS MOVE WHILE AN ACCOUNT IS IN USE ──────────────────────────────────────────
// Claude Code refreshes its OAuth token and writes the new one back over the live login,
// and a refresh can rotate the refresh token, which kills the copy saved before it. So the
// live login is copied back into its account's slot (recapture) on every tick and at the
// moment of switching away — and only ever when it IS that account (same id) and is not
// older than the copy (expiresAt). A saved copy is never written over a newer live login
// of the same account.
//
// ── A LOGIN THAT NO LONGER WORKS ────────────────────────────────────────────────────
// Three signals, all from the binary's own behaviour, each enough:
//   the store   on invalid_grant Claude Code blanks refreshToken/accessToken in the live
//               login ("OAuth dead-token disk clear"). A saved copy with an empty refresh
//               token, or a refreshTokenExpiresAt in the past, is dead before it is tried.
//   the hook    a turn that fails on auth fires StopFailure with error
//               authentication_failed / oauth_org_not_allowed / account_on_hold;
//               hooks/fleet-event.sh puts it in the record as `failure`.
//   the pane    the binary's own lines: "Not logged in · Please run /login", "OAuth token
//               revoked · Please run /login", "Login expired · Please run /login",
//               "Authentication required · Sign in again to continue", "…Please run
//               /login to sign in again". Read only from sessions launched on the account
//               since it was swapped in, until a usage reading proves the login works.
// The account is marked NEEDS-LOGIN, said once (inbox + phone), and skipped until the
// owner logs in again and re-runs `fleet-accounts add`. Never retried in a loop.
//
// Node builtins only, like the rest of lib/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects, projectForSock, cfgFor } from './projects.mjs';
import { modState } from './mod-status.mjs';
import { cfgDir as switchDir } from './experimental.mjs';

export const DEFAULT_THRESHOLD = 97;
// A reading taken this soon after a switch could still be the OLD account's: the binary
// caches its Keychain read for 30s, and a request already in flight finishes on the token it
// started with. Such readings are attributed to nobody rather than to the wrong account —
// one wrong 97% on a fresh account would cascade the profile through every fallback.
export const GRACE_S = () => { const v = Number(process.env.CLAUDE_FLEET_ACCOUNTS_GRACE); return Number.isFinite(v) && v >= 0 ? v : 90; };
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']);
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// The binary's own strings (see the header). `·` is U+00B7, as the binary writes it.
export const LOGIN_RE = /(?:Not logged in|OAuth token revoked|Login expired|Invalid API key) · Please run \/login|Please run \/login to sign in again|Authentication required · Sign in again to continue|OAuth refresh token is no longer valid/;

const nowS = () => Math.floor(Date.now() / 1000);
const HOME = () => os.homedir();
const tilde = (p) => (p.startsWith(HOME() + '/') ? '~' + p.slice(HOME().length) : p);

// ── the switch and the threshold ───────────────────────────────────────────────────
// Read the switch file directly rather than through experimental.enabled(): the governor
// asks every tick, and the answer must not drift from the one `fleet-experimental` gives.
export function enabled() {
  try { return fs.readFileSync(path.join(switchDir(), 'accounts.enabled'), 'utf8').trim() === 'on'; } catch { return false; }
}
const thresholdFile = () => path.join(switchDir(), 'accounts.threshold');
export function threshold() {
  try { const v = Number(fs.readFileSync(thresholdFile(), 'utf8').trim()); if (v >= 1 && v <= 100) return v; } catch {}
  return DEFAULT_THRESHOLD;
}
export function setThreshold(v) {
  fs.mkdirSync(path.dirname(thresholdFile()), { recursive: true });
  atomicWrite(thresholdFile(), `${v}\n`);
}

function atomicWrite(file, data, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ── the login store ────────────────────────────────────────────────────────────────
// CLAUDE_FLEET_LOGIN_STORE=keychain|file picks the backend (default: keychain on macOS,
// file elsewhere) and CLAUDE_FLEET_SECURITY names the `security` binary — the suite points
// both at fakes under its own HOME, so no run of it ever reaches a real Keychain.
const backend = () => process.env.CLAUDE_FLEET_LOGIN_STORE || (process.platform === 'darwin' ? 'keychain' : 'file');
const security = () => process.env.CLAUDE_FLEET_SECURITY || 'security';
function kcUser() {
  let u = process.env.USER;
  try { if (!u) u = os.userInfo().username; } catch { u = 'claude-code-user'; }
  return /^[a-zA-Z0-9._-]+$/.test(u || '') ? u : 'claude-code-user';
}
export function liveService(cfg) {
  return 'Claude Code-credentials-' + crypto.createHash('sha256').update(cfg.normalize('NFC')).digest('hex').slice(0, 8);
}
const SAVED_SERVICE = 'ghostfleet-claude-login';
function kcRead(service, account) {
  const r = spawnSync(security(), ['find-generic-password', '-a', account, '-w', '-s', service], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return null;
  // `-w` prints the value as text, or as bare hex when any byte of it is not printable.
  const out = r.stdout.trim();
  return /^(?:[0-9a-fA-F]{2})+$/.test(out) && !/^[{\[]/.test(out) ? Buffer.from(out, 'hex').toString('utf8') : out;
}
function kcWrite(service, account, value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  // The binary's own rule and limit: stdin under 4032 characters, argv above it. A saved
  // login is a few hundred bytes and never reaches argv; a live one can, when the config dir
  // also holds MCP servers' tokens — and then this does what Claude Code itself does.
  const r = line.length <= 4032
    ? spawnSync(security(), ['-i'], { input: line, encoding: 'utf8', timeout: 10000 })
    : spawnSync(security(), ['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(r.error ? `could not run ${security()} (${r.error.code})` : `the Keychain refused the write (security exited ${r.status})`);
}
function kcDelete(service, account) {
  spawnSync(security(), ['delete-generic-password', '-a', account, '-s', service], { encoding: 'utf8', timeout: 10000 });
}
const credFile = (cfg) => path.join(cfg, '.credentials.json');
const savedFile = (cfg, name) => path.join(cfg, `.credentials.ghostfleet-${name}.json`);
function globalConfigFile(cfg) {
  const legacy = path.join(cfg, '.config.json');
  return fs.existsSync(legacy) ? legacy : path.join(cfg, '.claude.json');
}

// The config dir's live login: { blob (the whole credentials JSON), oauth, account } or null.
export function readLive(cfg) {
  let raw = null;
  if (backend() === 'keychain') raw = kcRead(liveService(cfg), kcUser());
  else { try { raw = fs.readFileSync(credFile(cfg), 'utf8'); } catch {} }
  let blob = null; try { blob = raw ? JSON.parse(raw) : null; } catch {}
  const gc = readJson(globalConfigFile(cfg)) || {};
  if (!blob || typeof blob !== 'object') return null;
  return { blob, oauth: blob.claudeAiOauth || null, account: gc.oauthAccount || null };
}
// Puts `oauth` and `account` in as the live login, keeping every other key the live
// credentials hold (they are the config dir's, not the account's).
export function writeLive(cfg, oauth, account) {
  const cur = readLive(cfg);
  const blob = { ...((cur && cur.blob) || {}), claudeAiOauth: oauth };
  const json = JSON.stringify(blob);
  if (backend() === 'keychain') kcWrite(liveService(cfg), kcUser(), json);
  else atomicWrite(credFile(cfg), json, 0o600);
  const gf = globalConfigFile(cfg);
  const gc = readJson(gf) || {};
  if (account) gc.oauthAccount = account; else delete gc.oauthAccount;
  atomicWrite(gf, JSON.stringify(gc, null, 2));
}
export function readSaved(profile, cfg, name) {
  let raw = null;
  if (backend() === 'keychain') raw = kcRead(SAVED_SERVICE, `${profile}.${name}`);
  else { try { raw = fs.readFileSync(savedFile(cfg, name), 'utf8'); } catch {} }
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function writeSaved(profile, cfg, name, oauth, account) {
  const json = JSON.stringify({ v: 1, claudeAiOauth: oauth, oauthAccount: account || null });
  if (backend() === 'keychain') kcWrite(SAVED_SERVICE, `${profile}.${name}`, json);
  else atomicWrite(savedFile(cfg, name), json, 0o600);
}
function deleteSaved(profile, cfg, name) {
  if (backend() === 'keychain') kcDelete(SAVED_SERVICE, `${profile}.${name}`);
  else { try { fs.unlinkSync(savedFile(cfg, name)); } catch {} }
}

// Who a login is, as a one-way id: the same person in another organisation is another
// login (another plan, another limit). Kept in accounts.json; no token goes into it.
export function loginId(account) {
  if (!account || !account.accountUuid) return '';
  return crypto.createHash('sha256').update(`${account.accountUuid}|${account.organizationUuid || ''}`).digest('hex').slice(0, 16);
}
// A one-way fingerprint of the tokens themselves, so the state can say "the live login is
// exactly what ghostfleet put there" without holding a token. It answers the case the
// oauthAccount block cannot: a Claude process rewriting .claude.json from its memory would
// name the PREVIOUS account over a login that is the new one.
const fpOf = (o) => o ? crypto.createHash('sha256').update(`${o.accessToken || ''}|${o.refreshToken || ''}`).digest('hex').slice(0, 16) : '';
function writeAccountOnly(cfg, account) {
  const gf = globalConfigFile(cfg);
  const gc = readJson(gf) || {};
  gc.oauthAccount = account;
  atomicWrite(gf, JSON.stringify(gc, null, 2));
}
// Dead before it is tried: Claude Code blanked it, or its refresh token has expired.
export function deadWhy(oauth, at = Date.now()) {
  if (!oauth || typeof oauth !== 'object') return 'there is no login';
  if (!oauth.refreshToken) return oauth.accessToken ? 'it has no refresh token' : 'Claude Code cleared it (its refresh token was refused)';
  const rx = Number(oauth.refreshTokenExpiresAt) || 0;
  if (rx && rx < at) return 'its refresh token has expired';
  return '';
}

// ── per-profile state: <profile fleet dir>/accounts.json ──────────────────────────────
// { order: [name…], active, history: [{account, from}], accounts: { name: { id, added_at,
//   needs_login: {at, why} | null, verified_at, usage: {five_hour, seven_day} } },
//   exhausted: {since, until, notified} | null }
export const fleetDirFor = (profile) => path.join(cfgFor(profile), 'fleet');
export const stateFile = (profile) => path.join(fleetDirFor(profile), 'accounts.json');
export function load(profile) {
  const s = readJson(stateFile(profile)) || {};
  return { order: Array.isArray(s.order) ? s.order : [], active: s.active || null, history: Array.isArray(s.history) ? s.history : [],
           accounts: s.accounts && typeof s.accounts === 'object' ? s.accounts : {}, exhausted: s.exhausted || null,
           installed: s.installed || null };
}
export function save(profile, st) {
  fs.mkdirSync(fleetDirFor(profile), { recursive: true });
  atomicWrite(stateFile(profile), JSON.stringify(st, null, 2) + '\n');
}
export function profiles() {
  const out = new Set();
  for (const p of projects()) out.add(p.profile === 'default' ? 'work' : p.profile);
  out.add('work');
  return [...out].filter(p => fs.existsSync(stateFile(p)));
}

// One writer at a time per profile: every fleet's governor ticks, and two of them deciding
// the same switch would swap the login twice. mkdir is atomic; a lock older than two
// minutes belongs to a process that died holding it.
function withLock(profile, fn) {
  const dir = path.join(fleetDirFor(profile), 'accounts.lock');
  fs.mkdirSync(fleetDirFor(profile), { recursive: true });
  for (let i = 0; i < 50; i++) {
    try { fs.mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 120000) { fs.rmdirSync(dir); continue; } } catch {}
      if (i === 49) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(dir); } catch {} }
}

// ── notices: the inbox of every live fleet on the profile, and one line for the phone ──
const sockDir = () => path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid ? process.getuid() : 0}`);
function liveSocks(profile) {
  return projects().filter(p => (p.profile === 'default' ? 'work' : p.profile) === profile)
    .map(p => p.sock).filter(s => { try { return fs.statSync(path.join(sockDir(), s)).isSocket(); } catch { return false; } });
}
// `event` is one word (switched / exhausted / needs-login / resumed); the phone's text is
// composed from these fields by web/sw.js, never from prose carried in the payload.
function notice(profile, msg, fields) {
  const dir = fleetDirFor(profile), at = nowS();
  const row = `${at}\tfleet\taccount\t${msg.replace(/[\t\n]/g, ' ')}\n`;
  for (const s of liveSocks(profile)) { try { fs.appendFileSync(path.join(dir, `${s}.inbox`), row); } catch {} }
  try { fs.appendFileSync(path.join(dir, 'accounts.notify'), JSON.stringify({ at, profile, ...fields }) + '\n'); } catch {}
  log(profile, msg);
}
function log(profile, msg) {
  try { fs.appendFileSync(path.join(fleetDirFor(profile), 'accounts.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
export const loginCmd = (profile, name) =>
  `CLAUDE_CONFIG_DIR=${tilde(cfgFor(profile))} claude, /login as ${name}, then fleet-accounts add ${profile} ${name}`;

// ── usage, per account ────────────────────────────────────────────────────────────
// A record's figures belong to the account that was ACTIVE when they were written (its
// usage.at, against history) — and to nobody when that is in doubt: inside GRACE_S of a
// switch, or when the session was launched under a different account than the one active
// then (its <sock>.<slot>.account marker, written at launch). The doubtful direction is
// dropped rather than guessed, because a wrong high reading moves the whole profile.
export function accountAt(st, t) {
  let cur = null;
  for (const h of st.history) if (h.from <= t) cur = h; else break;
  if (!cur) return null;
  if (cur.from > 0 && t < cur.from + GRACE_S()) return null;
  return cur.account;
}
function launchMarker(dir, sock, slot) {
  try {
    const [name, at] = fs.readFileSync(path.join(dir, `${sock}.${slot}.account`), 'utf8').trim().split('\t');
    return { name, at: Number(at) || 0 };
  } catch { return null; }
}
export function records(dir) {
  const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.') || n === 'accounts.json') continue;
    const j = readJson(path.join(dir, n));
    if (j && typeof j === 'object' && j.session_id) out.push(j);
  }
  return out;
}
export function attribute(st, dir, rec, t) {
  const who = accountAt(st, t);
  if (!who) return null;
  if (rec.sock && rec.slot) {
    const m = launchMarker(dir, rec.sock, rec.slot);
    // `>=`: markers and readings are whole seconds, and the old process's last reading can
    // land in the very second the new one was launched. Dropping that second costs nothing.
    if (m && (m.name !== who || m.at >= t)) return null;
  }
  return who;
}
// A window's reading that still means something: not reset yet (or, with no reset time,
// read in the last ten minutes — the governor's mod_budget rule).
const liveWin = (w, at, now) => w && typeof w.pct === 'number' && (w.resets ? w.resets > now : (at || 0) > now - 600);
export function collectUsage(st, dir, now = nowS()) {
  const fresh = {};
  for (const rec of records(dir)) {
    const u = rec.usage; if (!u || !u.limits || !u.at) continue;
    const who = attribute(st, dir, rec, u.at);
    if (!who || !st.accounts[who]) continue;
    for (const k of ['five_hour', 'seven_day']) {
      const w = u.limits[k];
      if (!liveWin(w, u.at, now)) continue;
      const cur = (fresh[who] ||= {})[k];
      if (!cur || w.pct > cur.pct) fresh[who][k] = { pct: w.pct, resets: Number(w.resets) || 0, at: u.at };
      fresh[who].lastAt = Math.max(fresh[who].lastAt || 0, u.at);
    }
  }
  // Merged into what the state already knew: within one window usage only rises, and a
  // session that ended took its record with it.
  for (const [name, a] of Object.entries(st.accounts)) {
    const u = a.usage || {};
    for (const k of ['five_hour', 'seven_day']) {
      const old = u[k], nw = fresh[name] && fresh[name][k];
      const keep = liveWin(old, old && old.at, now) ? old : null;
      u[k] = nw && (!keep || nw.pct >= keep.pct || nw.resets !== keep.resets) ? nw : keep;
      if (!u[k]) delete u[k];
    }
    a.usage = u;
    // A reading taken on it since it was swapped in is the proof its login works.
    if (fresh[name] && fresh[name].lastAt >= activeSince(st, name)) a.verified_at = now;
  }
  return st;
}
// Which window has it over the line, or null.
export function overBy(a, thr, now = nowS()) {
  const u = (a && a.usage) || {};
  let worst = null;
  for (const [k, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = u[k];
    if (liveWin(w, w && w.at, now) && w.pct >= thr && (!worst || w.pct > worst.pct)) worst = { limit: label, pct: Math.floor(w.pct), resets: w.resets || 0 };
  }
  return worst;
}
// When an over-the-line account has room again: the latest reset among its windows over it.
function freeAt(a, thr, now = nowS()) {
  let t = 0;
  for (const k of ['five_hour', 'seven_day']) {
    const w = (a.usage || {})[k];
    if (liveWin(w, w && w.at, now) && w.pct >= thr) t = Math.max(t, w.resets || now + 600);
  }
  return t;
}
function activeSince(st, name) {
  let t = 0;
  for (const h of st.history) if (h.account === name) t = h.from;
  return t;
}
export function hhmm(t) {
  if (!t) return 'soon';
  const d = new Date(t * 1000), today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

// ── marking, capturing, switching ─────────────────────────────────────────────────
function markNeedsLogin(profile, st, name, why) {
  const a = st.accounts[name];
  if (!a || a.needs_login) return false;
  a.needs_login = { at: nowS(), why };
  notice(profile, `${profile}/${name} needs /login (${why}) — run: ${loginCmd(profile, name)}`,
         { event: 'needs-login', account: name });
  return true;
}
// The live login back into its account's slot — only when it IS that account and is not
// older than what the slot holds. Returns true when it wrote.
export function recapture(profile, cfg, st, name, live = readLive(cfg)) {
  const a = st.accounts[name];
  if (!a || !live || !live.oauth || deadWhy(live.oauth)) return false;
  if (loginId(live.account) !== a.id) return false;
  const saved = readSaved(profile, cfg, name);
  const so = saved && saved.claudeAiOauth;
  if (so && (Number(live.oauth.expiresAt) || 0) < (Number(so.expiresAt) || 0)) return false;
  if (so && so.accessToken === live.oauth.accessToken && so.refreshToken === live.oauth.refreshToken) return false;
  writeSaved(profile, cfg, name, live.oauth, live.account);
  st.installed = { account: name, fp: fpOf(live.oauth) };
  return true;
}
// Swap `to` in. 'ok', or the reason it could not (and `to` is then marked NEEDS-LOGIN when
// its saved copy is dead). The caller relaunches sessions; this only moves the login.
export function swapIn(profile, cfg, st, to, why, cause = {}) {
  const live = readLive(cfg);
  const from = st.active;
  if (from && st.accounts[from]) recapture(profile, cfg, st, from, live);
  const saved = readSaved(profile, cfg, to);
  if (!saved || !saved.claudeAiOauth) { markNeedsLogin(profile, st, to, 'its saved login is missing from the secret store'); return 'dead'; }
  const dead = deadWhy(saved.claudeAiOauth);
  if (dead) { markNeedsLogin(profile, st, to, dead); return 'dead'; }
  // Already live and newer (a hand /login, or a refresh since it was saved): keep the live one.
  const liveIsTo = live && loginId(live.account) === st.accounts[to].id && !deadWhy(live.oauth);
  if (!(liveIsTo && (Number(live.oauth.expiresAt) || 0) >= (Number(saved.claudeAiOauth.expiresAt) || 0))) {
    writeLive(cfg, saved.claudeAiOauth, saved.oauthAccount);
    st.installed = { account: to, fp: fpOf(saved.claudeAiOauth) };
  } else st.installed = { account: to, fp: fpOf(live.oauth) };
  st.active = to;
  st.history.push({ account: to, from: nowS() });
  if (st.history.length > 50) st.history = st.history.slice(-50);
  st.accounts[to].verified_at = 0;
  if (from && from !== to) notice(profile, `${profile}: switched from ${from} to ${to} (${why})`, { event: 'switched', from, to, ...cause });
  else notice(profile, `${profile}: now on ${to} (${why})`, { event: 'switched', from: '', to, ...cause });
  return 'ok';
}
// The next account with room, in order, skipping NEEDS-LOGIN — trying each until one swaps
// in. Returns its name or null.
function failover(profile, cfg, st, thr, why, cause) {
  for (const name of st.order) {
    if (name === st.active) continue;
    const a = st.accounts[name];
    if (!a || a.needs_login || overBy(a, thr)) continue;
    if (swapIn(profile, cfg, st, name, why, cause) === 'ok') return name;
  }
  return null;
}

// ── the sessions of one fleet ────────────────────────────────────────────────────────
function tmux(sock, args) {
  const r = spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout : '';
}
const agentOf = (dir, sock, slot) => { try { return fs.readFileSync(path.join(dir, `${sock}.${slot}.agent`), 'utf8').trim() || 'claude'; } catch { return 'claude'; } };
function sessionsOf(dir, sock) {
  const newest = new Map();
  for (const r of records(dir)) {
    if (r.sock !== sock || !r.slot) continue;
    const p = newest.get(r.slot);
    if (!p || (Number(r.ts) || 0) > (Number(p.ts) || 0)) newest.set(r.slot, r);
  }
  return tmux(sock, ['list-sessions', '-F', '#{session_name}']).split('\n').filter(s => s && !s.startsWith('_') && !s.startsWith('+'))
    .filter(s => agentOf(dir, sock, s) === 'claude')
    .map(slot => {
      const rec = newest.get(slot) || null;
      let parked = '';
      try { parked = fs.readFileSync(path.join(dir, `${sock}.${slot}.parked`), 'utf8').split(/\s/)[0] || 'parked'; } catch {}
      return { slot, rec, status: rec ? String(modState(rec) || rec.status || '') : '', parked, marker: launchMarker(dir, sock, slot) };
    });
}
const bin = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', n);
function relaunch(dir, sock, slot, name, cont) {
  // The marker goes down before the launch (the new process must not take a reading the old
  // marker would credit elsewhere) and comes BACK if the launch is refused: a marker naming
  // the new login over a process still on the old one is the misattribution it exists to stop.
  const mf = path.join(dir, `${sock}.${slot}.account`);
  let before = null; try { before = fs.readFileSync(mf, 'utf8'); } catch {}
  fs.writeFileSync(mf, `${name}\t${nowS()}\n`);
  const args = ['-s', sock, '--session', slot, '--yes', ...(cont ? ['--continue', cont] : ['--no-continue'])];
  // Not as the governor's own pane: fleet-restart leaves "the session running this command"
  // for last and never restarts it, and a governor started from inside a session inherits
  // that session's TMUX and slot.
  const env = { ...process.env };
  for (const k of ['TMUX', 'TMUX_PANE', 'CLAUDE_FLEET_SLOT']) delete env[k];
  const r = spawnSync(bin('fleet-restart'), args, { encoding: 'utf8', timeout: 60000, env });
  const ok = r.status === 0 && /\b1 relaunched/.test(r.stdout || '');
  if (!ok) { try { if (before === null) fs.unlinkSync(mf); else fs.writeFileSync(mf, before); } catch {} }
  return ok;
}
const RESUME_PROMPT = 'Every Claude account on this profile had run out, so ghostfleet paused you; it has now moved the profile to an account with room and relaunched you on the same conversation. Continue what you were working on.';

// ── THE TICK: one fleet's governor, once a minute ─────────────────────────────────────
// Returns { managed, actions: [..] }. managed=false means this profile has fewer than two
// accounts (or the feature is off) and the governor's own budget ceiling applies as before.
export function tick(sock, { dry = false } = {}) {
  const res = { managed: false, actions: [] };
  if (!enabled()) return res;
  const proj = projectForSock(sock);
  if (!proj) return res;
  const profile = proj.profile === 'default' ? 'work' : proj.profile;
  if (load(profile).order.length < 2) return res;
  res.managed = true;
  const cfg = proj.cfg, dir = path.join(cfg, 'fleet'), thr = threshold(), act = (s) => res.actions.push(s);
  withLock(profile, () => {
    const st = load(profile);
    const now = nowS();
    const live = readLive(cfg);
    let liveId = live ? loginId(live.account) : '';
    // Exactly what was put there: it is that account, whatever .claude.json now says — and
    // .claude.json is put right again.
    const inst = st.installed && st.accounts[st.installed.account];
    if (inst && live && live.oauth && fpOf(live.oauth) === st.installed.fp && liveId !== inst.id) {
      const saved = readSaved(profile, cfg, st.installed.account);
      if (saved && saved.oauthAccount && !dry) { writeAccountOnly(cfg, saved.oauthAccount); live.account = saved.oauthAccount; }
      liveId = inst.id;
    }
    // 1. A /login by hand to another saved account is where the profile now is.
    const byHand = Object.entries(st.accounts).find(([n, a]) => a.id && a.id === liveId && n !== st.active && !deadWhy(live.oauth));
    if (byHand) {
      const [n] = byHand;
      if (st.accounts[n].needs_login) st.accounts[n].needs_login = null;
      st.accounts[n].verified_at = 0;                     // a new login, like a re-add
      st.active = n; st.history.push({ account: n, from: now });
      notice(profile, `${profile}: now on ${n} (a /login by hand)`, { event: 'switched', from: '', to: n, cause: 'by-hand' });
      act(`adopted ${n}`);
    }
    // 2. The active login: copy it back if it moved; dead if Claude Code blanked it.
    const cur = st.active && st.accounts[st.active];
    if (cur && !cur.needs_login && live && liveId === cur.id) {
      const dead = deadWhy(live.oauth);
      if (dead) { markNeedsLogin(profile, st, st.active, dead); act(`needs-login ${st.active}`); }
      else if (!dry && recapture(profile, cfg, st, st.active, live)) act(`recaptured ${st.active}`);
    }
    collectUsage(st, dir, now);
    const since = st.active ? activeSince(st, st.active) : 0;
    // 3. A turn refused for auth, or a pane asking for /login, since it was swapped in.
    if (cur && !cur.needs_login) {
      for (const r of records(dir)) {
        const f = r.failure;
        if (f && AUTH_ERRORS.has(f.error) && (Number(f.at) || 0) >= since && attribute(st, dir, r, Number(f.at) || 0) === st.active) {
          markNeedsLogin(profile, st, st.active, `a turn failed with ${f.error}`); act(`needs-login ${st.active}`); break;
        }
      }
    }
    if (cur && !cur.needs_login && !(cur.verified_at && cur.verified_at >= since)) {
      for (const s of sessionsOf(dir, sock)) {
        if (!s.marker || s.marker.name !== st.active || s.marker.at < since) continue;
        if (LOGIN_RE.test(tmux(sock, ['capture-pane', '-p', '-t', s.slot]))) {
          markNeedsLogin(profile, st, st.active, `${s.slot} is asking for /login`); act(`needs-login ${st.active}`); break;
        }
      }
    }
    // 4. Over the line, or unusable: move to the next account with room.
    const a = st.active && st.accounts[st.active];
    const over = a && overBy(a, thr);
    if (!dry && (!a || a.needs_login || over)) {
      const why = !a ? 'no account was active' : a.needs_login ? `${st.active} needs /login` : `${over.limit} at ${over.pct}%`;
      const cause = !a ? { cause: 'none-active' } : a.needs_login ? { cause: 'needs-login' } : { cause: 'limit', limit: over.limit, pct: over.pct };
      const to = failover(profile, cfg, st, thr, why, cause);
      if (to) { act(`switched to ${to}`); }
      else {
        // 5. Nothing left. Said once; parked every tick (a worker spawned since is parked too).
        const until = Object.values(st.accounts).filter(x => !x.needs_login).map(x => freeAt(x, thr)).filter(Boolean);
        const earliest = until.length ? Math.min(...until) : 0;
        const nl = st.order.filter(n => st.accounts[n] && st.accounts[n].needs_login);
        if (!st.exhausted || st.exhausted.until !== earliest) {
          const msg = earliest
            ? `all ${profile} accounts exhausted until ${hhmm(earliest)}${nl.length ? ` (needs /login: ${nl.join(', ')})` : ''} — workers paused, resuming then`
            : `no ${profile} account can run: needs /login: ${nl.join(', ')} — workers paused`;
          if (!st.exhausted) notice(profile, msg, { event: 'exhausted', until: earliest, needs_login: nl });
          st.exhausted = { since: (st.exhausted && st.exhausted.since) || now, until: earliest };
        }
        act('exhausted');
      }
    }
    if (st.exhausted && !dry) {
      const ok = st.active && st.accounts[st.active] && !st.accounts[st.active].needs_login && !overBy(st.accounts[st.active], thr);
      if (ok) {
        notice(profile, `${profile}: resumed on ${st.active}`, { event: 'resumed', to: st.active });
        st.exhausted = null; act('resumed');
      }
    }
    save(profile, st);
    if (dry) return;
    // 6. This fleet's sessions: park while exhausted; otherwise move each idle Claude
    // session that was launched under another account, and bring back what we parked.
    for (const s of sessionsOf(dir, sock)) {
      if (st.exhausted) {
        if (s.slot === 'master' || s.parked) continue;
        const pr = spawnSync(bin('fleet-pause'), ['-s', sock, s.slot],
          { encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_FLEET_DIR: dir } });
        if (pr.status === 0) {
          fs.writeFileSync(path.join(dir, `${sock}.${s.slot}.parked`), `governor-accounts ${now}\n`);
          act(`parked ${s.slot}`);
        }
        continue;
      }
      if (s.parked === 'governor-accounts') {
        if (relaunch(dir, sock, s.slot, st.active, RESUME_PROMPT)) act(`resumed ${s.slot}`);
        continue;
      }
      if (s.parked) continue;                                  // a hand pause is the owner's
      if (s.marker && s.marker.name === st.active) continue;   // already on it
      if (!['ready', 'idle', 'interrupted'].includes(s.status)) continue;   // never mid-turn
      // One try per session per account: a session fleet-restart refuses stays where it is
      // (it still reads the new login within the binary's 30s cache) instead of being asked
      // again every minute.
      const tryf = path.join(dir, `${sock}.${s.slot}.account-try`);
      let tried = ''; try { tried = fs.readFileSync(tryf, 'utf8').trim(); } catch {}
      if (tried === `${st.active}\t${activeSince(st, st.active)}`) continue;
      fs.writeFileSync(tryf, `${st.active}\t${activeSince(st, st.active)}\n`);
      act(relaunch(dir, sock, s.slot, st.active, '') ? `relaunched ${s.slot}` : `relaunch refused ${s.slot}`);
    }
  });
  return res;
}

// Turning the feature off: un-park every worker it parked, in every profile that has accounts.
// They come back idle (the park interrupted their turn); `fleet-send` gives them work again.
export function releaseParked() {
  const out = [];
  for (const p of profiles()) {
    const dir = fleetDirFor(p);
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (!n.endsWith('.parked')) continue;
      let first = ''; try { first = fs.readFileSync(path.join(dir, n), 'utf8').split(/\s/)[0]; } catch {}
      if (first !== 'governor-accounts') continue;
      try { fs.unlinkSync(path.join(dir, n)); out.push(n.replace(/\.parked$/, '')); } catch {}
    }
    const st = load(p);
    if (st.exhausted) { st.exhausted = null; save(p, st); }
  }
  for (const w of out) console.log(`  un-parked ${w} (it was parked by accounts)`);
  return out;
}

// ── the CLI's verbs (bin/fleet-accounts.mjs) ──────────────────────────────────────────
export function add(profile, name) {
  if (!NAME_RE.test(name)) throw new Error(`'${name}' is not an account name (letters, digits, - and _; up to 32)`);
  const cfg = cfgFor(profile);
  const live = readLive(cfg);
  if (!live || !live.oauth) throw new Error(`${tilde(cfg)} holds no Claude login to save — log in first: ${loginCmd(profile, name)}`);
  const dead = deadWhy(live.oauth);
  if (dead) throw new Error(`the login ${tilde(cfg)} holds does not work (${dead}) — log in again: ${loginCmd(profile, name)}`);
  const id = loginId(live.account);
  if (!id) throw new Error(`${tilde(cfg)}'s .claude.json does not say whose login it holds (no oauthAccount) — run /login again, then retry`);
  return withLock(profile, () => {
    const st = load(profile);
    const other = Object.entries(st.accounts).find(([n, a]) => a.id === id && n !== name);
    if (other) throw new Error(`that login is already saved as '${other[0]}' — /login to the account you want to add first`);
    writeSaved(profile, cfg, name, live.oauth, live.account);
    const was = st.accounts[name];
    // verified_at goes back to 0: this is a NEW login, and nothing that proved the one it
    // replaces says anything about it — with the old mark left in place, a re-add in the same
    // second as the last reading skipped the /login check on exactly the login it was for.
    st.accounts[name] = { ...(was || {}), id, added_at: nowS(), needs_login: null, verified_at: 0 };
    if (!st.order.includes(name)) st.order.push(name);
    // It is what the config dir holds right now, so it is what the profile runs on.
    if (st.active !== name) { st.active = name; st.history.push({ account: name, from: st.history.length ? nowS() : 0 }); }
    st.installed = { account: name, fp: fpOf(live.oauth) };
    if (st.exhausted && !overBy(st.accounts[name], threshold())) st.exhausted = null;
    save(profile, st);
    return { st, readded: !!was };
  });
}
export function remove(profile, name) {
  const cfg = cfgFor(profile);
  return withLock(profile, () => {
    const st = load(profile);
    if (!st.accounts[name]) throw new Error(`${profile} has no account called '${name}'`);
    if (st.active === name && st.order.length > 1) throw new Error(`'${name}' is the login ${profile} is using now — switch first: fleet-accounts use ${profile} <another>`);
    deleteSaved(profile, cfg, name);
    delete st.accounts[name];
    st.order = st.order.filter(n => n !== name);
    if (st.active === name) st.active = null;
    save(profile, st);
    return st;
  });
}
export function use(profile, name) {
  const cfg = cfgFor(profile);
  return withLock(profile, () => {
    const st = load(profile);
    const a = st.accounts[name];
    if (!a) throw new Error(`${profile} has no account called '${name}'`);
    if (a.needs_login) throw new Error(`'${name}' needs /login first — run: ${loginCmd(profile, name)}`);
    if (st.active === name) return { st, same: true };
    const r = swapIn(profile, cfg, st, name, 'by hand', { cause: 'by-hand' });
    save(profile, st);
    if (r !== 'ok') throw new Error(`'${name}''s saved login does not work (${st.accounts[name].needs_login.why}) — run: ${loginCmd(profile, name)}`);
    return { st, same: false };
  });
}
// Wire StopFailure into the profile's settings.json, beside the five install.sh wires, so
// an auth failure reaches the record. Idempotent; a backup is kept like install.sh keeps one.
export function wireStopFailure(cfg, hook) {
  const f = path.join(cfg, 'settings.json');
  const s = readJson(f) || {};
  const have = ((s.hooks || {}).StopFailure || []).some(e => (e.hooks || []).some(h => h.command === hook));
  if (have) return false;
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak.${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
  s.hooks = s.hooks || {};
  s.hooks.StopFailure = [...(s.hooks.StopFailure || []), { matcher: '', hooks: [{ type: 'command', command: hook }] }];
  fs.mkdirSync(cfg, { recursive: true });
  atomicWrite(f, JSON.stringify(s, null, 2) + '\n');
  return true;
}

// `node lib/accounts.mjs tick <socket>` — the governor's entry point. Prints one line per
// action, nothing when there was nothing to do; exit 3 when the profile is not managed, so
// the governor knows to run its own budget ceiling instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, sock, flag] = process.argv.slice(2);
  if (cmd !== 'tick' || !sock) { process.stderr.write('usage: accounts.mjs tick <socket> [--dry-run]\n'); process.exit(2); }
  const r = tick(sock, { dry: flag === '--dry-run' });
  for (const a of r.actions) console.log(`accounts: ${a}`);
  process.exit(r.managed ? 0 : 3);
}
