// lib/accounts.mjs — several Claude logins for ONE profile, and moving the profile
// between them when the one in use runs low. [experimental] `fleet-experimental enable
// accounts`; with it off nothing here runs and nothing it reads or writes exists.
//
// ── WHAT AN ACCOUNT IS ─────────────────────────────────────────────────────────────
// A profile is one config dir (~/.claude, ~/.claude-<p>) and stays one. Its conversations,
// settings, plugins, folder trust and fleet dir never move. What changes is the LOGIN that
// config dir holds — exactly what `/login` to another account does by hand — so an
// account here is a SAVED LOGIN, and switching is putting a different saved login where
// Claude Code reads its own — and nothing more. No session is restarted: a running Claude
// re-reads that login on its own (see GRACE_S), exactly as it does after a /login by hand.
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
//               /login to sign in again". Read only from sessions that have done something
//               since the login was swapped in and the grace window ran out (or were
//               launched on it since), until a usage reading proves the login works.
// The account is marked NEEDS-LOGIN, said once (inbox + phone), and skipped until the
// owner logs in again and re-runs `fleet-accounts add`. Never retried in a loop.
//   One of those words is not about the login at all: oauth_org_not_allowed ("Your
// organization has disabled Claude subscription access for Claude Code") is a setting of
// the account's ORGANIZATION, and a /login gives back the same refusal. That account is
// marked BLOCKED instead — skipped the same way, with the org's admin named as the one who
// can lift it — and cleared by a reading taken on it afterwards (the admin turned access
// back on and a turn went through) or by the owner re-adding it.
//
// ── WHICH ACCOUNT TO BE ON: SPEND WHAT EXPIRES FIRST ───────────────────────────────────
// Allowance left in a 7d window when it resets is lost. So among the accounts with room on
// BOTH windows (under the threshold), the profile belongs on the one whose 7d window resets
// soonest; resets within MARGIN_S of each other are a tie, and the one with more 7d room
// wins it; then the order they were added in. An account with no 7d reading counts as
// resetting last — nothing says its allowance is about to go. The active account is left
// when it is over the threshold or unusable (to the best of the rest), and otherwise only
// for an account whose week ends more than MARGIN_S sooner, at least HOLD_S after the last
// switch, and not while a by-hand choice is pinned (PIN_S). That is what brings the profile
// BACK: an account pushed off by its 5h limit is the best again the moment that window
// resets, and the profile returns to it.
//   Readings come only from real requests on the login in use; nothing is ever sent on an
// inactive account to refresh its figures — so an old one is NOT trusted for a planned move.
// It was, on the theory that an account with no room answers the first request with its real
// figure and the rule above moves on. It does not: a turn refused at the limit carries no
// usage headers, so it never becomes a reading. Measured: an account read three days earlier
// at 0% with its week "ending first" had in fact hit its weekly limit, and the planner moved
// the profile onto it three times, two hours apart — each time every turn failed, the owner
// moved it back by hand, and the pin ran out. Two rules close that:
//   STALE_S   a planned move ("its week resets first") is made only to an account whose 7d
//             figure was read in the last STALE_S — that figure, not its newest reading of
//             any kind. An older one is still a FAILOVER when the account in use cannot
//             run, because a stale account beats stopping, and `list` marks it `stale`.
//   OUT       a turn that fails with Claude's own usage-limit message IS a reading: "You've
//             hit your weekly limit · resets Oct 29 at 1am (America/New_York)", which the
//             StopFailure hook keeps beside `rate_limit` in the record. The account is out
//             until that reset (when the text gives none, until its stored 7d reset or 24h,
//             whichever is later), is never chosen before it, and — when it is the one in use
//             — is left at once, through the failover path: no hold, no pin.
//
// Node builtins only, like the rest of lib/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projects, projectForSock, cfgFor, budgetIgnored } from './projects.mjs';
import { cfgDir as switchDir } from './experimental.mjs';

export const DEFAULT_THRESHOLD = 97;
// A reading taken this soon after a switch could still be the OLD account's, because a
// switch restarts nothing and each running Claude moves onto the new login by itself. On
// macOS the binary caches its Keychain read for 30s (`UOt=30000` beside the reader, in
// 2.1.295); on Linux it reads .credentials.json on every access. Past that, a request that
// began on the old token still reports the old account's figures when its headers come back,
// and the mod pushes the latest figures again at the turn's end — so the window is the
// cache plus a minute for a request already under way. Such readings are attributed to
// nobody rather than to the wrong account: one wrong 97% on a fresh account would cascade the
// profile through every fallback, where dropping a minute and a half of readings on a login
// that was just chosen for having room costs nothing.
export const GRACE_S = () => { const v = Number(process.env.CLAUDE_FLEET_ACCOUNTS_GRACE); return Number.isFinite(v) && v >= 0 ? v : 90; };
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']);
const ORG_BLOCKED = 'oauth_org_not_allowed';
// Two 7d resets closer than this expire at practically the same time: it is one 5h window,
// the smallest unit the allowance is spent in, so which of the two goes first is not worth a
// switch — and a margin this wide is what keeps two accounts on the same weekly cadence, a
// few minutes apart, from trading places every time one of them is read.
export const MARGIN_S = 5 * 3600;
// After any switch, the planner stays put this long unless the account in use is over the
// threshold or unusable: long enough for the new login to be read, so the next choice is
// made on a figure and not on the absence of one, and a stale reading cannot bounce it.
export const HOLD_S = 15 * 60;
// A by-hand choice (`fleet-accounts use`, or a /login to a saved account) holds this long
// against the planner, so it is not undone on the next tick — and no longer, so a choice
// made for a reason that has passed does not keep the profile off its best account all week.
export const PIN_S = 2 * 3600;
// A 7d reading older than this does not justify a planned move onto its account (see WHICH
// ACCOUNT TO BE ON). Long enough that an account read this morning still counts this
// afternoon; short enough that "Fri 16:00" read three days ago does not.
export const STALE_S = 6 * 3600;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// The binary's own strings (see the header). `·` is U+00B7, as the binary writes it.
export const LOGIN_RE = /(?:Not logged in|OAuth token revoked|Login expired|Invalid API key) · Please run \/login|Please run \/login to sign in again|Authentication required · Sign in again to continue|OAuth refresh token is no longer valid/;

// ── a usage-limit failure, read off Claude's own message ─────────────────────────────
// StopFailure says `rate_limit` for a usage limit AND for a plain 429 that ran out of
// retries, so the word alone marks nothing: only the binary's sentence does. 2.1.295 composes
// it as `You've hit your ${name}${" · resets " + when}` with name from {five_hour: "session
// limit", seven_day: "weekly limit", seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet
// limit", ...} — and "fast limit", which is fast mode's own and not the account's. `when` is
// HR(resetsAt, true): within 24h a time, "10:20pm"; past it "Oct 29 at 1am", with ", 2027"
// after the day when the year differs; always followed by " (<IANA zone>)". Node's ICU writes
// the same instant "Oct 29, 1am", so both joiners are read.
const LIMIT_SAID = /You[’']ve hit your ([^·\n]{1,60}?)(?=\s*·|\s*$)|You[’']re out of usage credits|Your org is out of usage/;
const RESET_SAID = /resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2})(?:,\s+(\d{4}))?(?:\s+at|,)\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s+\(([^)\s]{1,64})\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The wall clock in `tz` at epoch second t, as a UTC epoch of the same digits.
function wallAt(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
}
// Epoch second of a wall-clock time in `tz` (local when tz is empty). Two passes settle the
// offset across a DST edge.
function zoned(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo, d, h, mi).getTime() / 1000;
  const want = Date.UTC(y, mo, d, h, mi) / 1000;
  let t = want;
  for (let i = 0; i < 2; i++) t -= wallAt(t, tz) - want;
  return t;
}
// What a failure's text says: { name, limit: '5h'|'7d'|'', resets: epoch | 0 } — or null when
// it is not a usage limit. `ref` is when it was said; a bare time is the next one after it,
// a date with no year the one in ref's year (or the next, across New Year). Reads a pane as
// well as a message: lines are joined first, because at 30 columns "You've hit your weekly"
// and "limit · resets Oct 29 at 1am" are two of them.
export function limitHit(text, ref = nowS()) {
  const flat = String(text || '').split('\n').map(l => l.replace(/^\s*[⎿⏺●]\s*/, '').trim()).filter(Boolean).join(' ');
  const m = flat.match(LIMIT_SAID);
  if (!m) return null;
  const name = (m[1] || 'usage credits').trim();
  if (/\bfast\b/i.test(name)) return null;
  const limit = /session/i.test(name) ? '5h' : /weekly|opus|sonnet|fable/i.test(name) ? '7d' : '';
  const r = flat.slice(m.index).match(RESET_SAID);
  let resets = 0;
  if (r) {
    let tz = r[7] || '';
    try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = null; }
    const h = (+r[4] % 12) + (r[6].toLowerCase() === 'pm' ? 12 : 0), mi = +(r[5] || 0);
    if (tz !== null && +r[4] >= 1 && +r[4] <= 12 && mi < 60) {
      const now = tz ? new Date(wallAt(ref, tz) * 1000) : new Date(ref * 1000);
      const [Y, M, D] = tz ? [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()] : [now.getFullYear(), now.getMonth(), now.getDate()];
      if (!r[1]) {
        resets = zoned(Y, M, D, h, mi, tz);
        if (resets < ref - 300) resets = zoned(Y, M, D + 1, h, mi, tz);
      } else if (MONTHS.includes(r[1].toLowerCase())) {
        const mo = MONTHS.indexOf(r[1].toLowerCase());
        resets = zoned(r[3] ? +r[3] : Y, mo, +r[2], h, mi, tz);
        if (!r[3] && resets < ref - 2 * 86400) resets = zoned(Y + 1, mo, +r[2], h, mi, tz);
      }
    }
  }
  return { name, limit, resets: Number.isFinite(resets) ? Math.round(resets) : 0 };
}

// The clock, with a seam: CLAUDE_FLEET_ACCOUNTS_CLOCK=<epoch seconds> stands in for now, so
// the suite can step through a 5h window, a hold and a pin without waiting on any of them.
// Rows in this area that leaned on the wall clock have gone red on a slow runner three times;
// the failover group steps it one second per command, so no two steps share a second by luck.
export const nowS = () => { const c = Number(process.env.CLAUDE_FLEET_ACCOUNTS_CLOCK); return Number.isFinite(c) && c > 0 ? Math.floor(c) : Math.floor(Date.now() / 1000); };
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
export function deadWhy(oauth, at = nowS() * 1000) {
  if (!oauth || typeof oauth !== 'object') return 'there is no login';
  if (!oauth.refreshToken) return oauth.accessToken ? 'it has no refresh token' : 'Claude Code cleared it (its refresh token was refused)';
  const rx = Number(oauth.refreshTokenExpiresAt) || 0;
  if (rx && rx < at) return 'its refresh token has expired';
  return '';
}

// ── per-profile state: <profile fleet dir>/accounts.json ──────────────────────────────
// { order: [name…], active, history: [{account, from}], accounts: { name: { id, added_at,
//   needs_login: {at, why} | null, blocked: {at, why} | null, unblocked_at, verified_at, read_at,
//   out: {at, until, limit, why, said} | null, usage: {five_hour, seven_day} } },
//   exhausted: {since, until, notified} | null,
//   pin: {account, until} | null, seen_saved }
// A history entry whose account is '' is a span on a login no account holds (see the tick).
export const fleetDirFor = (profile) => path.join(cfgFor(profile), 'fleet');
export const stateFile = (profile) => path.join(fleetDirFor(profile), 'accounts.json');
export function load(profile) {
  const s = readJson(stateFile(profile)) || {};
  return { order: Array.isArray(s.order) ? s.order : [], active: s.active || null, history: Array.isArray(s.history) ? s.history : [],
           accounts: s.accounts && typeof s.accounts === 'object' ? s.accounts : {}, exhausted: s.exhausted || null,
           installed: s.installed || null, pin: s.pin || null, seen_saved: Number(s.seen_saved) || 0 };
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
// No `fields`, no phone line: for what the owner did by hand and needs no push about.
// `msg` may be a function of the socket, for a notice whose truth differs by fleet (whether
// its workers were parked); the log then carries what it says to the first live fleet.
function notice(profile, msg, fields) {
  const dir = fleetDirFor(profile), at = nowS(), socks = liveSocks(profile);
  const say = (s) => (typeof msg === 'function' ? msg(s) : msg);
  for (const s of socks) { try { fs.appendFileSync(path.join(dir, `${s}.inbox`), `${at}\tfleet\taccount\t${say(s).replace(/[\t\n]/g, ' ')}\n`); } catch {} }
  if (fields) { try { fs.appendFileSync(path.join(dir, 'accounts.notify'), JSON.stringify({ at, profile, ...fields }) + '\n'); } catch {} }
  log(profile, say(socks[0] || ''));
}
// What "all exhausted" does to a profile's workers, as one word: 'paused' when every live
// fleet enforces its budget limit, 'running' when every one ignores it, 'mixed' between.
// An ignored budget is the owner saying keep going until Claude itself refuses, so the
// engine parks nothing there (step 6) and no notice may say it did.
export const WORKERS = { paused: 'workers paused', running: 'workers keep running (budget ignored)',
                         mixed: 'workers paused, except where the budget is ignored' };
function workersWord(profile) {
  const dir = fleetDirFor(profile), socks = liveSocks(profile);
  const kept = socks.filter(s => budgetIgnored(dir, s)).length;
  return !kept ? 'paused' : kept === socks.length ? 'running' : 'mixed';
}
function log(profile, msg) {
  try { fs.appendFileSync(path.join(fleetDirFor(profile), 'accounts.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
export const loginCmd = (profile, name) =>
  `CLAUDE_CONFIG_DIR=${tilde(cfgFor(profile))} claude, /login as ${name}, then fleet-accounts add ${profile} ${name}`;

// ── usage, per account ────────────────────────────────────────────────────────────
// A record's figures belong to the account that was ACTIVE when they were written (its
// usage.at, against history) — and to nobody when that is in doubt: inside GRACE_S of a
// switch, while a session may still be on the login it replaced, and through a span on a
// login no account holds (its history entry names nobody). The doubtful direction is
// dropped rather than guessed, because a wrong high reading moves the whole profile.
//   Which login a session was LAUNCHED on says nothing here. A switch used to relaunch
// every idle session so that it could, and the relaunch cost more than it bought: a
// session resumed from its transcript redraws only from its last /compact, so a session
// that had compacted half a minute before a switch lost everything above that from its
// screen and its scrollback. The clock and the grace window are the whole rule now.
export function accountAt(st, t) {
  let cur = null;
  for (const h of st.history) if (h.from <= t) cur = h; else break;
  if (!cur) return null;
  // `<=`: readings and switches are whole seconds, and the reading that triggered a switch
  // is often taken in the very second of it. Which side it fell on cannot be told, so even
  // with no grace at all that second is nobody's.
  if (cur.from > 0 && t <= cur.from + GRACE_S()) return null;
  return cur.account;
}
// <sock>.<slot>.account, written by claude-here at launch: the login a process STARTED on.
// It gates no reading (see above); it only lets the pane check below trust a session that
// was started after the login went in.
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
// A window's reading that still means something: not reset yet (or, with no reset time,
// read in the last ten minutes — the governor's mod_budget rule).
const liveWin = (w, at, now) => w && typeof w.pct === 'number' && (w.resets ? w.resets > now : (at || 0) > now - 600);
// One account is in ONE window per limit, and it is the one that resets latest: a reading
// with an earlier reset is from a window the account has left (or was never in — a login
// that was not this account, read while it sat in the config dir), and its figure says
// nothing about the current one. Comparing figures across windows let a stale 99% out-vote
// a fresh 12% until the stale window ran out, with every worker parked meanwhile. Within
// one window usage only rises, so there the higher figure wins. The reset times the binary
// reports have come in on whole ten-minute marks, identical across every session of a
// window; the slop only absorbs a second or two of rounding without ever merging two of
// those marks into one window.
const WINDOW_SLOP_S = 120;
// Of two readings of one limit, the one that describes the account now; `b` on a tie, so
// the newer of two equal figures is kept.
function current(a, b) {
  if (!a || !b) return a || b || null;
  if (a.resets && b.resets && Math.abs(a.resets - b.resets) > WINDOW_SLOP_S) return a.resets > b.resets ? a : b;
  return b.pct >= a.pct ? b : a;
}
// Returns the accounts a reading has just unblocked.
export function collectUsage(st, dir, now = nowS()) {
  const fresh = {}, unblocked = [];
  for (const rec of records(dir)) {
    const u = rec.usage; if (!u || !u.limits || !u.at) continue;
    const who = accountAt(st, u.at);
    if (!who || !st.accounts[who]) continue;
    for (const k of ['five_hour', 'seven_day']) {
      const w = u.limits[k];
      if (!liveWin(w, u.at, now)) continue;
      (fresh[who] ||= {})[k] = current(fresh[who][k], { pct: w.pct, resets: Number(w.resets) || 0, at: u.at });
      fresh[who].lastAt = Math.max(fresh[who].lastAt || 0, u.at);
    }
  }
  // Merged into what the state already knew, by the same rule: a session that ended took its
  // record with it, and a record left over from an earlier window must not displace a later
  // one the state already holds.
  for (const [name, a] of Object.entries(st.accounts)) {
    const u = a.usage || {};
    for (const k of ['five_hour', 'seven_day']) {
      const old = u[k], nw = fresh[name] && fresh[name][k];
      const keep = liveWin(old, old && old.at, now) ? old : null;
      u[k] = current(keep, nw);
      if (!u[k]) delete u[k];
    }
    a.usage = u;
    // A reading taken on it since it was swapped in is the proof its login works.
    if (fresh[name] && fresh[name].lastAt >= activeSince(st, name)) a.verified_at = now;
    if (fresh[name]) a.read_at = Math.max(a.read_at || 0, fresh[name].lastAt);
    // ...and one taken after it was blocked is the proof its organization let it back in.
    if (a.blocked && (a.read_at || 0) > a.blocked.at) { a.blocked = null; a.unblocked_at = a.read_at; unblocked.push(name); }
  }
  return unblocked;
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
// Out of usage by Claude's own word (see OUT in the header): the mark, while it holds.
export const outNow = (a, now = nowS()) => (a && a.out && a.out.until > now ? a.out : null);
// Can the profile run on it: a login that works, let in by its organization, under the line,
// and not refused at its limit.
const usable = (a, thr, now = nowS()) => !!a && !a.needs_login && !a.blocked && !overBy(a, thr, now) && !outNow(a, now);
// Too old to plan on (see STALE_S): judged by when its 7d figure was read, because that is
// the figure a planned move is made on (weekEnds, weekLeft). Not by the account's newest
// reading of any kind: a session record keeps only the windows the binary reported (the
// mod's usageRecord), so one can bring a fresh 5h figure and no 7d one — and the
// newest-of-anything rule then let a 5h read three hours ago vouch for a 7d read four days
// ago, which is the move STALE_S exists to stop.
// No 7d reading at all is stale too, and there is nothing to plan on then anyway.
export const stale = (a, now = nowS()) => {
  const w = ((a && a.usage) || {}).seven_day;
  return now - (Number(w && w.at) || 0) >= STALE_S;
};
// When its 7d window resets, Infinity when no live reading says (see WHICH ACCOUNT TO BE ON).
function weekEnds(a, now = nowS()) {
  const w = ((a && a.usage) || {}).seven_day;
  return liveWin(w, w && w.at, now) && w.resets ? w.resets : Infinity;
}
const weekLeft = (a, now = nowS()) => { const w = ((a && a.usage) || {}).seven_day; return liveWin(w, w && w.at, now) ? 100 - w.pct : 100; };
// Is x the better account to spend than y: its week ends more than MARGIN_S sooner; inside
// the margin, more 7d room; then the order they were added in. Two unknown weeks are a tie
// (Infinity - Infinity is NaN, which no comparison passes).
function better(st, x, y, now) {
  const ex = weekEnds(st.accounts[x], now), ey = weekEnds(st.accounts[y], now);
  if (Math.abs(ex - ey) > MARGIN_S) return ex < ey;
  const rx = weekLeft(st.accounts[x], now), ry = weekLeft(st.accounts[y], now);
  if (rx !== ry) return rx > ry;
  return st.order.indexOf(x) < st.order.indexOf(y);
}
// Every account other than the active one that the profile could run on, best first. A
// scan rather than a sort: a tie band makes "better" intransitive, and Array.sort is not
// promised to be sane on a comparator that is.
export function ranked(st, thr, now = nowS()) {
  const left = st.order.filter(n => n !== st.active && usable(st.accounts[n], thr, now)), out = [];
  while (left.length) {
    let b = 0;
    for (let i = 1; i < left.length; i++) if (better(st, left[i], left[b], now)) b = i;
    out.push(left.splice(b, 1)[0]);
  }
  return out;
}
const lastSwitch = (st) => { const h = st.history[st.history.length - 1]; return h ? h.from : 0; };
export const pinned = (st, now = nowS()) => !!(st.pin && st.pin.account === st.active && st.pin.until > now);
// When an over-the-line account has room again: the latest reset among its windows over it.
function freeAt(a, thr, now = nowS()) {
  let t = 0;
  for (const k of ['five_hour', 'seven_day']) {
    const w = (a.usage || {})[k];
    if (liveWin(w, w && w.at, now) && w.pct >= thr) t = Math.max(t, w.resets || now + 600);
  }
  const o = outNow(a, now);
  return o ? Math.max(t, o.until) : t;
}
// The profile is on a login no account holds: the last history entry names nobody.
export function onUnsaved(st) {
  const h = st.history[st.history.length - 1];
  return !!h && h.account === '';
}
function activeSince(st, name) {
  let t = 0;
  for (const h of st.history) if (h.account === name) t = h.from;
  return t;
}
// How long ago a reading was taken: `3h ago`. Coarse on purpose — it answers "is this
// figure still worth trusting", which minutes past the hour do not change.
export function ago(t, now = nowS()) {
  const d = Math.max(0, now - (Number(t) || 0));
  if (!t) return 'never';
  return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 172800 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`;
}
export function hhmm(t) {
  if (!t) return 'soon';
  const d = new Date(t * 1000), today = new Date(nowS() * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

// ── what `fleet-accounts list` says about a profile, as data ─────────────────────────
// The CLI lays it out in columns and fleet-serve hands it to the phone (/api/usage), so an
// account cannot read `stale` at the desk and `ready` in a pocket: there is one place that
// decides which word it gets. Names, figures, times and states only — every field below is
// picked by name, so whatever else a state file holds (a login id today, anything tomorrow)
// stays where it is, and nothing here reads a login.
//   A window: the floored figure, when it resets and how long ago it was read, both in the
// words `list` prints, and for a line too short for those, `left` — how long until it resets,
// `2h10m` — and `day`, the reset's weekday, or its time when that is today.
export function left(t, now = nowS()) {
  const d = (Number(t) || 0) - now;
  if (!t) return 'soon';
  if (d <= 0) return 'now';
  const m = Math.floor(d / 60) % 60, h = Math.floor(d / 3600) % 24, days = Math.floor(d / 86400);
  return days ? `${days}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}m` : `${Math.max(1, m)}m`;
}
function windowOf(w, now) {
  if (!w || typeof w.pct !== 'number') return null;
  const at = hhmm(w.resets);
  return { pct: Math.floor(w.pct), resets: Number(w.resets) || 0, at: Number(w.at) || 0,
           resets_at: at, read: ago(w.at, now), left: left(w.resets, now), day: at.includes(' ') ? at.split(' ')[0] : at };
}
export function describe(profile, thr = threshold(), now = nowS()) {
  const st = load(profile);
  const accounts = st.order.map((n) => {
    const a = st.accounts[n] || {};
    const active = n === st.active, over = overBy(a, thr, now), out = outNow(a, now);
    let kind = active ? 'active' : 'ready', state = kind;
    if (a.needs_login) { kind = 'needs-login'; state = 'NEEDS-LOGIN'; }
    else if (a.blocked) { kind = 'blocked'; state = 'BLOCKED'; }
    else if (out) { kind = 'out'; state = `OUT until ${hhmm(a.out.until)} (hit its ${a.out.why}${a.out.said ? '' : ', no reset time given'})`; }
    else if (over) { kind = 'exhausted'; state = `exhausted until ${hhmm(over.resets)}`; }
    else if (!active && stale(a, now)) { kind = 'stale'; state = 'ready, stale (no planned move onto it)'; }
    const u = a.usage || {};
    return {
      name: n, active, kind, state, stale: stale(a, now),
      until: out ? out.until : over ? over.resets : 0,
      five_hour: windowOf(u.five_hour, now), seven_day: windowOf(u.seven_day, now),
      fix: a.needs_login ? `${a.needs_login.why} — run: ${loginCmd(profile, n)}`
         : a.blocked ? `${a.blocked.why} — ${blockedFix(profile, n)}` : '',
    };
  });
  const unsaved = onUnsaved(st);
  return {
    profile, active: st.active, accounts, unsaved,
    exhausted: !unsaved && st.exhausted ? { until: Number(st.exhausted.until) || 0, until_at: st.exhausted.until ? hhmm(st.exhausted.until) : '',
                                           workers: workersWord(profile) } : null,
    pin: pinned(st, now) ? { account: st.active, until: st.pin.until, until_at: hhmm(st.pin.until) } : null,
  };
}

// ── marking, capturing, switching ─────────────────────────────────────────────────
function markNeedsLogin(profile, st, name, why) {
  const a = st.accounts[name];
  if (!a || a.needs_login || a.blocked) return false;
  a.needs_login = { at: nowS(), why };
  notice(profile, `${profile}/${name} needs /login (${why}) — run: ${loginCmd(profile, name)}`,
         { event: 'needs-login', account: name });
  return true;
}
// Not the login: the account's organization has turned Claude Code off for it, and only an
// admin of that organization can turn it back on. A /login would get the same refusal, so
// the owner is not told to do one.
export const BLOCKED_WHY = 'its organization has disabled Claude subscription access for Claude Code';
export const blockedFix = (profile, name) =>
  `only an admin of that organization can turn it back on; once they have, ${loginCmd(profile, name)} (or a turn on it that goes through clears this by itself)`;
function markBlocked(profile, st, name) {
  const a = st.accounts[name];
  if (!a || a.blocked) return false;
  a.blocked = { at: nowS(), why: BLOCKED_WHY };
  a.needs_login = null;
  notice(profile, `${profile}/${name} is BLOCKED: ${BLOCKED_WHY} — ${blockedFix(profile, name)}`,
         { event: 'blocked', account: name });
  return true;
}
// A turn on `name` failed at its limit at `fat`, and Claude said `hit` (limitHit). Out until
// the reset it gave — or, when it gave none that reads, until the stored 7d reset or a day
// after the failure, whichever is later: a guess that errs toward not going back too soon,
// which is the whole complaint. Said once in the inbox; the switch away is what reaches the
// phone. Returns true when it marked.
function markOut(profile, st, name, fat, hit, now = nowS()) {
  const a = st.accounts[name];
  if (!a || (a.out && fat <= a.out.at)) return false;
  const we = weekEnds(a, now);
  const until = hit.resets || Math.max(fat + 86400, we === Infinity ? 0 : we);
  const was = outNow(a, now);
  a.out = { at: fat, until, limit: hit.limit, why: hit.name, said: !!hit.resets };
  if (until <= now || (was && was.until === until)) return false;
  notice(profile, `${profile}/${name} hit its ${hit.name}${hit.resets ? '' : ' (no reset time it could read)'} — out until ${hhmm(until)}, not chosen before then`, null);
  return true;
}
// Whose turn failed at `t`. accountAt, and one case more: inside the grace window after a
// switch, a usage limit can only be the old login's when the old one was out of room. A
// switch away from an account WITH room — a planned move, or the owner's — leaves nothing on
// it to run out, so a limit there is the new account's. Without this, the first failed turn
// on a spent account is attributed to nobody, the worker that had it sits idle, and nothing
// else ever fails to say so.
function failedOn(st, t, thr, now) {
  const who = accountAt(st, t);
  if (who !== null) return who;
  let i = -1;
  for (let k = 0; k < st.history.length; k++) if (st.history[k].from <= t) i = k; else break;
  if (i < 1 || !st.history[i].account || !st.history[i - 1].account) return null;
  const prev = st.accounts[st.history[i - 1].account];
  return prev && usable(prev, thr, now) ? st.history[i].account : null;
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
// its saved copy is dead). Only the login moves: the sessions running on the profile pick it
// up by themselves (GRACE_S). `cause` null: an inbox row and no phone line, for a planned
// move that asks nothing of the owner.
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
  if (st.pin && st.pin.account !== to) st.pin = null;   // a by-hand choice ends when it is left
  st.history.push({ account: to, from: nowS() });
  if (st.history.length > 50) st.history = st.history.slice(-50);
  st.accounts[to].verified_at = 0;
  if (from && from !== to) notice(profile, `${profile}: switched from ${from} to ${to} (${why})`, cause && { event: 'switched', from, to, ...cause });
  else notice(profile, `${profile}: now on ${to} (${why})`, cause && { event: 'switched', from: '', to, ...cause });
  return 'ok';
}
// The best account with room (see ranked), skipping NEEDS-LOGIN and BLOCKED — trying each
// until one swaps in. Returns its name or null.
function failover(profile, cfg, st, thr, why, cause, now = nowS()) {
  for (const name of ranked(st, thr, now)) {
    if (swapIn(profile, cfg, st, name, why, cause) === 'ok') return name;
  }
  return null;
}
// The active account has room: move only to one whose week ends clearly sooner, and only
// once the last switch has settled and no by-hand choice is pinned. Returns its name or null.
function preferred(profile, cfg, st, thr, now) {
  if (pinned(st, now) || now - lastSwitch(st) < HOLD_S) return null;
  const mine = weekEnds(st.accounts[st.active], now);
  for (const name of ranked(st, thr, now)) {
    const theirs = weekEnds(st.accounts[name], now);
    if (!(theirs + MARGIN_S < mine)) continue;
    if (stale(st.accounts[name], now)) continue;           // see STALE_S

    const why = `${name}'s week resets first, ${hhmm(theirs)}${mine === Infinity ? '' : ` vs ${hhmm(mine)}`}`;
    if (swapIn(profile, cfg, st, name, why, null) === 'ok') return name;
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
      return { slot, rec, parked, marker: launchMarker(dir, sock, slot) };
    });
}
const bin = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', n);
// THE TAG AT THE FRONT IS HOW THE TURN IS JUDGED. Every worker this engine parked gets one of
// these, idle ones too, and a worker with nothing to pick up answers it with a turn that used
// to be filed as a DONE and woke its lead. hooks/fleet-event.sh reads the tag (RESUME_TAG) and
// files that turn as RESUMED unless it made a commit, a push, a PR or closed a ledger item.
// "no need to reply" is the other half: the mod's ledger (isNudge) records no item for a
// message that says so, and an item the worker closed would read as an answer to a real ask.
export const RESUME_TAG = '[fleet] resume:';
export const RESUME_PROMPT = `${RESUME_TAG} Every Claude account on this profile had run out, so ghostfleet paused you; it has now moved the profile to an account with room. Continue what you were working on. Automated resume, not a new task: if nothing was in progress there is nothing to do, and no need to reply to it.`;
export const IGNORED_PROMPT = `${RESUME_TAG} Every Claude account on this profile had run out, so ghostfleet paused you; this project's budget limit is now set to ignored, so you run until Claude itself refuses. Carry on with your task. Automated resume, not a new task: if nothing was in progress there is nothing to do, and no need to reply to it.`;

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
    // 0. A /login by hand to a login NO account holds. Its readings are not the active
    // account's — credited to it, one reading from somebody else's nearly spent window had
    // the profile exhausted and every worker parked while the account itself had room — and
    // the owner has taken the profile over: nothing is failed over or parked onto a saved
    // login until the config dir holds one again, and what the engine had parked is
    // let go. The span opens at the last tick that still saw a saved login, not at this one:
    // what was read in between is in doubt, and doubt is attributed to nobody.
    const known = (id) => !!id && Object.values(st.accounts).some(a => a.id === id);
    if (live && live.oauth && liveId && !known(liveId)) {
      if (!onUnsaved(st)) {
        const last = st.history[st.history.length - 1];
        st.history.push({ account: '', from: Math.max(st.seen_saved || now, last ? last.from : 0) });
        if (st.history.length > 50) st.history = st.history.slice(-50);
        notice(profile, `${profile}: on a login that is not saved (fleet-accounts add to manage it) — failover paused`, null);
        act('on an unsaved login');
      }
      st.exhausted = null;
      collectUsage(st, dir, now);
      save(profile, st);
      if (dry) return;
      for (const s of sessionsOf(dir, sock)) {
        if (s.parked !== 'governor-accounts') continue;
        try { fs.unlinkSync(path.join(dir, `${sock}.${s.slot}.parked`)); act(`un-parked ${s.slot}`); } catch {}
      }
      return;
    }
    if (known(liveId)) st.seen_saved = now;
    // 1. A /login by hand to another saved account is where the profile now is — or back to
    // the active one after a span on an unsaved login, which reopens its attribution.
    const byHand = Object.entries(st.accounts).find(([n, a]) => a.id && a.id === liveId && (n !== st.active || onUnsaved(st)) && !deadWhy(live.oauth));
    if (byHand) {
      const [n] = byHand;
      if (st.accounts[n].needs_login) st.accounts[n].needs_login = null;
      if (st.accounts[n].blocked) st.accounts[n].blocked = null;
      st.accounts[n].verified_at = 0;                     // a new login, like a re-add
      st.active = n; st.history.push({ account: n, from: now });
      st.pin = { account: n, until: now + PIN_S };        // the owner's choice, like `use`
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
    for (const n of collectUsage(st, dir, now)) {
      notice(profile, `${profile}/${n}: no longer blocked — a turn on it went through`, null);
      act(`unblocked ${n}`);
    }
    const since = st.active ? activeSince(st, st.active) : 0;
    // 3. A turn refused for auth, or a pane asking for /login, since it was swapped in. An
    // organization's refusal is BLOCKED, not NEEDS-LOGIN, and once a reading has cleared it
    // (or the account was re-added) that failure is spent — the record of the one failed
    // turn stays on disk, and would block the account again on the very next tick. Not
    // "older than the last reading": the record that carries the failure can carry a reading
    // stamped in the same second, and that would have kept the mark from ever being set.
    if (cur && !cur.needs_login && !cur.blocked) {
      for (const r of records(dir)) {
        const f = r.failure, fat = f ? Number(f.at) || 0 : 0;
        if (!f || !AUTH_ERRORS.has(f.error) || fat < since || accountAt(st, fat) !== st.active) continue;
        if (f.error === ORG_BLOCKED) {
          if (fat <= (cur.unblocked_at || 0) || fat <= (cur.added_at || 0)) continue;
          markBlocked(profile, st, st.active); act(`blocked ${st.active}`); break;
        }
        markNeedsLogin(profile, st, st.active, `a turn failed with ${f.error}`); act(`needs-login ${st.active}`); break;
      }
    }
    // A pane is read only once it can be about this login: the session was launched on it,
    // or has done something since every running process had moved onto it. Before that, a
    // "Please run /login" on screen may be the login it replaced, still drawn.
    if (cur && !cur.needs_login && !cur.blocked && !(cur.verified_at && cur.verified_at >= since)) {
      for (const s of sessionsOf(dir, sock)) {
        const launched = s.marker && s.marker.name === st.active && s.marker.at >= since;
        const moved = s.rec && (Number(s.rec.ts) || 0) >= since + GRACE_S();
        if (!launched && !moved) continue;
        if (LOGIN_RE.test(tmux(sock, ['capture-pane', '-p', '-t', s.slot]))) {
          markNeedsLogin(profile, st, st.active, `${s.slot} is asking for /login`); act(`needs-login ${st.active}`); break;
        }
      }
    }
    // 3b. A turn refused at its usage limit, on whichever account it was on (see OUT). A
    // failure stays in its record until that session's next event, so one already read is
    // spent by `out.at`, and one from before the account was (re-)added says nothing about it.
    for (const r of records(dir)) {
      const f = r.failure, fat = f ? Number(f.at) || 0 : 0;
      if (!f || f.error !== 'rate_limit' || !fat) continue;
      const hit = limitHit(f.message, fat);
      if (!hit) continue;
      const who = failedOn(st, fat, thr, now), x = who && st.accounts[who];
      if (!x || fat <= (x.added_at || 0) || (x.out && fat <= x.out.at)) continue;
      if (markOut(profile, st, who, fat, hit, now)) act(`out ${who}`);
    }
    // 4. Over the line, out, or unusable: move to the best account with room, at once — no
    // hold, no pin. Otherwise, to an account whose week ends clearly sooner (see WHICH
    // ACCOUNT TO BE ON).
    const a = st.active && st.accounts[st.active];
    const over = a && (overBy(a, thr) || (outNow(a, now) && { limit: outNow(a, now).limit, pct: 100, out: outNow(a, now) }));
    if (!dry && (!a || a.needs_login || a.blocked || over)) {
      const why = !a ? 'no account was active' : a.needs_login ? `${st.active} needs /login` : a.blocked ? `${st.active} is blocked by its organization`
        : over.out ? `${st.active} hit its ${over.out.why}, until ${hhmm(over.out.until)}` : `${over.limit} at ${over.pct}%`;
      const cause = !a ? { cause: 'none-active' } : a.needs_login ? { cause: 'needs-login' } : a.blocked ? { cause: 'blocked' }
        : { cause: 'limit', ...(over.limit ? { limit: over.limit } : {}), pct: over.pct };
      const to = failover(profile, cfg, st, thr, why, cause, now);
      if (to) { act(`switched to ${to}`); }
      else {
        // 5. Nothing left. Said once; parked every tick (a worker spawned since is parked too).
        const until = Object.values(st.accounts).filter(x => !x.needs_login && !x.blocked).map(x => freeAt(x, thr)).filter(Boolean);
        const earliest = until.length ? Math.min(...until) : 0;
        const nl = st.order.filter(n => st.accounts[n] && st.accounts[n].needs_login);
        const bl = st.order.filter(n => st.accounts[n] && st.accounts[n].blocked);
        const cant = [nl.length ? `needs /login: ${nl.join(', ')}` : '', bl.length ? `blocked by its organization: ${bl.join(', ')}` : ''].filter(Boolean).join('; ');
        if (!st.exhausted || st.exhausted.until !== earliest) {
          // Per fleet: one whose budget limit is ignored keeps its workers running (step 6).
          const msg = (s) => (earliest
            ? `all ${profile} accounts exhausted until ${hhmm(earliest)}${cant ? ` (${cant})` : ''}`
            : `no ${profile} account can run: ${cant}`)
            + (s && budgetIgnored(dir, s) ? ' — budget ignored here, so workers keep running until Claude refuses them'
               : earliest ? ' — workers paused, resuming then' : ' — workers paused');
          if (!st.exhausted) notice(profile, msg, { event: 'exhausted', until: earliest, needs_login: nl, workers: workersWord(profile) });
          st.exhausted = { since: (st.exhausted && st.exhausted.since) || now, until: earliest };
        }
        act('exhausted');
      }
    } else if (!dry) {
      const to = preferred(profile, cfg, st, thr, now);
      if (to) act(`switched to ${to}`);
    }
    if (st.exhausted && !dry) {
      const ok = st.active && usable(st.accounts[st.active], thr, now);
      if (ok) {
        notice(profile, `${profile}: resumed on ${st.active}`, { event: 'resumed', to: st.active });
        st.exhausted = null; act('resumed');
      }
    }
    save(profile, st);
    if (dry) return;
    // 6. This fleet's sessions: park while exhausted, and bring back what we parked once
    // there is an account with room. Nothing else: a switch restarts no session (see the
    // header), so a session that is merely on the old login is left exactly as it is.
    // A fleet whose budget limit is IGNORED is never parked for this — the owner asked it to
    // run until Claude itself refuses, and a profile at 97% of its week still has real work
    // in it. Read live, like the governor's ceiling: flipping it to ignored brings back what
    // was parked here on the next tick. A refusal is handled where it lands, by 3b (the
    // account is OUT until its reset) and the pane's limit status, which this does not touch.
    const ignored = budgetIgnored(dir, sock);
    for (const s of sessionsOf(dir, sock)) {
      if (st.exhausted && !ignored) {
        if (s.slot === 'master' || s.parked) continue;
        const pr = spawnSync(bin('fleet-pause'), ['-s', sock, s.slot],
          { encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_FLEET_DIR: dir } });
        if (pr.status === 0) {
          fs.writeFileSync(path.join(dir, `${sock}.${s.slot}.parked`), `governor-accounts ${now}\n`);
          act(`parked ${s.slot}`);
        }
        continue;
      }
      if (s.parked !== 'governor-accounts') continue;          // a hand pause is the owner's
      // Un-parked as fleet-resume does it: the marker cleared, then the prompt typed into the
      // process that is already there. A park was an Escape — the turn ended, the process,
      // its conversation and whatever it left running in the background did not — so there
      // is nothing to wait for and nothing to start again. --anyway: this continues the task
      // the park interrupted, and fleet-send's "a new task is a new session" gate is for new
      // tasks. The marker goes first and stays gone if the send fails: a worker left idle is
      // what turning the feature off leaves too, and a send retried every minute is not.
      try { fs.unlinkSync(path.join(dir, `${sock}.${s.slot}.parked`)); } catch { continue; }
      const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_FLEET_DIR: dir };
      // Not as the governor's own pane: a governor started from inside a session inherits
      // that session's TMUX and slot, and fleet-send would log that session as the sender.
      for (const k of ['TMUX', 'TMUX_PANE', 'CLAUDE_FLEET_SLOT']) delete env[k];
      const r = spawnSync(bin('fleet-send'), ['-s', sock, '--anyway', s.slot, st.exhausted ? IGNORED_PROMPT : RESUME_PROMPT], { encoding: 'utf8', timeout: 60000, env });
      act(r.status === 0 ? `resumed ${s.slot}` : `un-parked ${s.slot}, but the resume prompt did not send`);
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
    // An `out` mark stays when it is the same login saved again: the limit is the account's,
    // and a fresh token for it is exactly as spent.
    st.accounts[name] = { ...(was || {}), id, added_at: nowS(), needs_login: null, blocked: null, verified_at: 0,
                          out: was && was.id === id ? was.out || null : null };
    if (!st.order.includes(name)) st.order.push(name);
    // It is what the config dir holds right now, so it is what the profile runs on.
    if (st.active !== name) { st.active = name; st.history.push({ account: name, from: st.history.length ? nowS() : 0 }); }
    st.installed = { account: name, fp: fpOf(live.oauth) };
    if (st.exhausted && !overBy(st.accounts[name], threshold()) && !outNow(st.accounts[name])) st.exhausted = null;
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
    if (a.blocked) throw new Error(`'${name}' is blocked: ${a.blocked.why} — ${blockedFix(profile, name)}`);
    // Marked active is not the same as live: after a /login by hand to a login no account
    // holds, `use` of the active account is how the owner puts it back.
    const live = readLive(cfg), lid = live ? loginId(live.account) : '';
    const elsewhere = onUnsaved(st) || (lid && lid !== a.id && !(st.installed && live.oauth && fpOf(live.oauth) === st.installed.fp));
    // Pinned either way: `use` of the account already in use is still the owner choosing it.
    st.pin = { account: name, until: nowS() + PIN_S };
    // Out by Claude's word, and chosen anyway: the owner may know what the mark does not (a
    // plan upgraded, a limit lifted). The mark ends here rather than undoing the choice on the
    // next tick; a turn that fails at the limit again sets it again, and is left at once.
    const wasOut = outNow(a);
    if (wasOut) a.out = { ...a.out, until: nowS() };
    if (st.active === name && !elsewhere) { save(profile, st); return { st, same: true, wasOut }; }
    const r = swapIn(profile, cfg, st, name, 'by hand', { cause: 'by-hand' });
    if (r !== 'ok') { st.pin = null; if (wasOut) a.out = { ...a.out, until: wasOut.until }; }
    save(profile, st);
    if (r !== 'ok') throw new Error(`'${name}''s saved login does not work (${st.accounts[name].needs_login.why}) — run: ${loginCmd(profile, name)}`);
    return { st, same: false, wasOut };
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
