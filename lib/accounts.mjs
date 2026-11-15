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
// switch, and not while a by-hand choice holds. That is what brings the profile
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
// ── WHO A LOGIN IS: asked of its token, never read off .claude.json ─────────────────────
// .claude.json's oauthAccount is what a running Claude last WROTE, from memory, and every one
// of them rewrites it: measured, five minutes after a switch it named the account the profile
// had just left. Filed by that name, a round of /logins left one saved slot holding another
// organization's login, a second slot holding a copy of a third, and no slot holding the
// first — and every tick then copied the live tokens over whichever slot the name pointed at.
// So a login's identity is the answer to the read-only request Claude Code itself makes with
// an access token (`GET /api/oauth/profile`, Bearer; 2.1.321 validates account.uuid,
// account.email and organization.uuid in the answer). It is asked only when the tokens
// change, cached against their one-way fingerprint, and never with a refreshed token: an
// expired access token is "not checked", and a refresh is the one thing that rotates a login.
//   Each slot keeps the identity it was saved as (`id`, `org`) and the last answer its own
// copy gave (`check`). A hand /login is filed under the slot of the identity it answers as —
// or becomes a new slot — and the live tokens are written back only into the slot of their
// own identity. A slot whose copy answers as ANOTHER slot's account is a duplicate, and one
// that answers as an organization other than its own is mislabelled: both are flagged in
// `list` and taken out of rotation, because a duplicate is the shape that kills logins
// (DYING LOGINS below).
//
// ── DYING LOGINS ────────────────────────────────────────────────────────────────────
// Claude Code rotates the refresh token on a refresh and saves the new pair with a
// compare-and-swap on the old refresh token (2.1.321's "adopted_sibling"). A rotation
// retires every other copy of that login. Measured four refused refresh tokens in two days,
// one on a slot never used since it was saved. Two ways this engine made such copies, both
// reproduced in the suite with fake config dirs:
//   duplicates  `add` and the tick named a login from .claude.json, so the same login could
//               be saved under a second name, or copied over another slot. Whichever copy
//               was then used rotated the pair, and the other copy was dead from that moment.
//   one slot    with fewer than two accounts the tick returned before the write-back, so a
//               lone slot's copy stayed at the refresh token it was saved with while the live
//               login rotated past it. The next /login (to add a second account) replaced
//               the live pair, and the first swap back onto the lone slot met a retired token.
// Not ours: nothing here posts to the token endpoint or revokes anything (no refresh code in
// the repo), `remove` deletes only the saved copy, and no copy is written over a newer live
// copy of its own login. One mechanism remains on Claude Code's side: a process that refreshes
// the OLD login in the ~30s before it re-reads the store after a switch loses the CAS to the
// login swapped in, and the rotated pair it was handed is discarded. Its window is a refresh
// inside half a minute of a switch; it is named here, not fixed.
//
// ── READINGS BELONG TO THE LOGIN THAT TOOK THEM, WHEN IT TOOK THEM ──────────────────────
// A session record is rewritten whenever the mod pushes, and a push can carry figures the
// process read long before: the binary keeps each window in memory until its reset passes
// and re-reports it, so after a usage reset one idle session wrote a 96% 7d figure — its 5h
// dropped, having expired — over the 1% every live session was reading. So each session's
// figures are remembered (`sessions`), and a value counts from the first time that session
// reported it (`since`), not from its latest write: a re-report of an old value is as old as
// the value. A reading is the account's that was live at `since`, and nobody's when the value
// straddles a switch. Then, per limit:
//   two windows     the one observed later — the account is in one window per limit, and an
//                   observation after another tells the truth about it. This is what lets
//                   the account's real "97%, resets Mon" displace a "32%, resets Tue" that
//                   was another organization's, which the old "later reset wins" kept forever.
//   one window      usage only rises, so the higher figure — EXCEPT across a reset: when a
//                   session's own figure falls inside one window (it can only replace its
//                   windows with a newer observation), or when a record's OTHER window is a
//                   later one than the account's still-running stored window (the binary
//                   replaces a record's windows together, so the whole record is newer). Then
//                   the lower figure is taken and a FLOOR is set at it: nothing observed
//                   before it is believed in that window again.
//   `fleet-accounts reset` sets the same floor by hand, for an account with no session to
//   show the drop (a reset used on an account not in use is never read until it is chosen).
//
// ── MODELS, ORGANIZATIONS, AND A CHOICE BY HAND ──────────────────────────────────────
// Switching organization costs every session mid-conversation its earlier thinking ("Claude
// can't use thinking from another organization"), and an account without a model refuses
// every turn on it ("There's an issue with the selected model (<id>). It may not exist or you
// may not have access to it.", error model_not_found — the binary's own words, read by the
// StopFailure hook). So the rules above rank in tiers: the current organization with every
// model its sessions run; then another organization; then an account lacking a model a
// session runs, last of all. Planned moves stay in the first tier; only failover crosses. A
// choice by hand (`use`, or a /login) holds until that account reaches the cut-off or the
// owner picks again or runs `fleet-accounts auto` — a timed pin ran out and moved the profile
// back to the account the owner had just left. `exclude` takes an account out of rotation
// without deleting its login.
//
// Node builtins only, like the rest of lib/.
import fs from 'node:fs';
import { accountPane } from './account-logins.mjs';
import { lastModel } from './session-model.mjs';
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
// A by-hand choice (`fleet-accounts use`, or a /login) holds until its account reaches the
// cut-off, or the owner picks again or runs `fleet-accounts auto`. It used to hold two hours,
// and when those ran out the planner moved the profile straight back to the account the
// owner had just left — the choice was undone by the clock, not by a reason.
// How long an answer that was not a yes is trusted before the provider is asked again.
const RECHECK_S = 300;
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

// The model a turn was refused for, from the binary's own sentence (2.1.321): "There's an issue
// with the selected model (<id>). It may not exist or you may not have access to it.", or on a
// cloud provider "The model <id> is not available on your <provider> deployment." '' if neither.
const MODEL_SAID = /issue with the selected model \(([^()\s]{1,80})\)|The model (\S{1,80}) is not available on your/;
export function modelRefused(text) {
  const m = String(text || '').match(MODEL_SAID);
  return m ? (m[1] || m[2]).replace(/[.,;:]+$/, '') : '';
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

// ── who a login is (see WHO A LOGIN IS) ──────────────────────────────────────────────
// CLAUDE_FLEET_PROFILE_API is the suite's seam (a stub server on 127.0.0.1); nothing else
// sets it. The request is Claude Code's own: GET <base>/api/oauth/profile with the access
// token as a Bearer, 10s. A label that cannot be a real token never leaves the machine.
const PROFILE_API = () => (process.env.CLAUDE_FLEET_PROFILE_API || 'https://api.anthropic.com').replace(/\/+$/, '');
export const orgOf = (uuid) => (uuid ? crypto.createHash('sha256').update(`org|${uuid}`).digest('hex').slice(0, 16) : '');
// The answer about one login: {state: 'ok', id, org, org_name, account} — `account` is the
// oauthAccount block the answer vouches for, in .claude.json's own keys — or {state} for the
// three ways of not knowing: 'expired' (its access token is, and nothing here refreshes one),
// 'refused' (401/403), 'no_answer' (anything else).
export async function askProfile(oauth) {
  const at = oauth && oauth.accessToken;
  if (!at) return { state: 'no_answer' };
  const exp = Number(oauth.expiresAt) || 0;
  if (exp && exp < Date.now() + 60e3) return { state: 'expired' };
  if (!process.env.CLAUDE_FLEET_PROFILE_API && !/^sk-ant-/.test(at)) return { state: 'no_answer' };
  try {
    const r = await fetch(`${PROFILE_API()}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'ghostfleet-accounts' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401 || r.status === 403) return { state: 'refused' };
    if (!r.ok) return { state: 'no_answer' };
    const j = await r.json();
    const acc = j && j.account, org = j && j.organization;
    if (!acc || typeof acc.uuid !== 'string' || !acc.uuid || !org || typeof org.uuid !== 'string' || !org.uuid) return { state: 'no_answer' };
    const name = typeof org.name === 'string' ? org.name.slice(0, 80) : '';
    const account = { accountUuid: acc.uuid, emailAddress: String(acc.email_address || acc.email || ''), organizationUuid: org.uuid,
                      ...(acc.display_name ? { displayName: String(acc.display_name) } : {}), ...(name ? { organizationName: name } : {}) };
    return { state: 'ok', id: loginId(account), org: orgOf(org.uuid), org_name: name, account };
  } catch { return { state: 'no_answer' }; }
}
// What accounts.json keeps of an answer: never the address, never a token.
const checkOf = (ans, fp, now) => ({ fp, at: now, state: ans.state,
  ...(ans.state === 'ok' ? { id: ans.id, org: ans.org, org_name: ans.org_name } : {}) });
// Who the login with these tokens is, asking only when nothing already says: a slot's own
// saved copy answered for exactly these tokens, or the live login was asked about them (a
// non-answer is kept RECHECK_S), or they are what the engine itself put there ('installed':
// that slot's, unverified — taken for filing, never for writing a copy back, and no copy
// moves while the tokens do not). `asked` marks a fresh answer, for the caller to keep.
async function identify(st, oauth, now = nowS()) {
  const fp = fpOf(oauth);
  for (const a of Object.values(st.accounts)) if (a.check && a.check.fp === fp && a.check.state === 'ok') return { ...a.check };
  const l = st.live;
  if (l && l.fp === fp && l.state === 'ok') return { ...l };
  const i = st.installed, ia = i && i.fp === fp && st.accounts[i.account];
  if (ia && ia.id) return { state: 'installed', fp, id: ia.id, org: orgIdOf(ia) };
  if (l && l.fp === fp && now - (l.at || 0) < RECHECK_S) return { ...l };
  const ans = await askProfile(oauth);
  return { ...checkOf(ans, fp, now), ...(ans.account ? { account: ans.account } : {}), asked: true };
}
// The organization a slot is in, when an answer has said.
const orgIdOf = (a) => (a && ((a.org && a.org.id) || (a.check && a.check.state === 'ok' && a.check.id === a.id && a.check.org))) || '';
const orgNameOf = (a) => (a && ((a.org && a.org.name) || (a.check && a.check.state === 'ok' && a.check.id === a.id && a.check.org_name))) || '';
// A slot whose own saved copy answers as somebody else: 'duplicate' when that is another
// slot's account (two copies of one login, the shape that kills one of them), 'mismatch'
// otherwise (it holds a login of an account no slot is for). Either is out of rotation.
export function flagOf(st, n) {
  const a = st.accounts[n], c = a && a.check;
  if (!c || c.state !== 'ok' || !a.id || c.id === a.id) return '';
  return Object.entries(st.accounts).some(([m, b]) => m !== n && b.id === c.id) ? 'duplicate' : 'mismatch';
}
const flagWho = (st, n) => { const c = st.accounts[n].check; const o = Object.entries(st.accounts).find(([m, b]) => m !== n && b.id === c.id); return o ? o[0] : ''; };
// The slot for an identity: the first in order that is for it.
const slotFor = (st, id) => (id ? st.order.find(n => st.accounts[n] && st.accounts[n].id === id) || null : null);
// The oauthAccount block to keep for a verified login: .claude.json's when it names the same
// login (it carries more than the answer does), the answer's otherwise.
const accountFor = (live, ans) => (live && live.account && loginId(live.account) === ans.id ? live.account : ans.account || null);

// ── per-profile state: <profile fleet dir>/accounts.json ──────────────────────────────
// { order: [name…], active, history: [{account, from, id}], accounts: { name: { id, added_at,
//   org: {id, name}, check: {fp, at, state, id, org, org_name}, auto, excluded,
//   without: [{model, at, said}], reset_at,
//   needs_login: {at, why} | null, blocked: {at, why} | null, unblocked_at, verified_at, read_at,
//   out: {at, until, limit, why, said} | null, usage: {five_hour, seven_day} } },
//   exhausted: {since, until, notified} | null, installed: {account, fp},
//   live: {fp, at, state, id, org, org_name}, sessions: {<session id>: {five_hour, seven_day, at}},
//   pin: {account, at} | null, seen_saved }
// A history entry whose account is '' is a span on a login no account can be said to hold
// (see the tick).
export const fleetDirFor = (profile) => path.join(cfgFor(profile), 'fleet');
export const stateFile = (profile) => path.join(fleetDirFor(profile), 'accounts.json');
export function load(profile) {
  const s = readJson(stateFile(profile)) || {};
  return { order: Array.isArray(s.order) ? s.order : [], active: s.active || null, history: Array.isArray(s.history) ? s.history : [],
           accounts: s.accounts && typeof s.accounts === 'object' ? s.accounts : {}, exhausted: s.exhausted || null,
           installed: s.installed || null, live: s.live || null, sessions: s.sessions && typeof s.sessions === 'object' ? s.sessions : {},
           pin: s.pin || null, seen_saved: Number(s.seen_saved) || 0 };
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
// The same lock around work that awaits (a profile request, 10s at most each).
async function withLockA(profile, fn) {
  const dir = path.join(fleetDirFor(profile), 'accounts.lock');
  fs.mkdirSync(fleetDirFor(profile), { recursive: true });
  for (let i = 0; i < 50; i++) {
    try { fs.mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 120000) { fs.rmdirSync(dir); continue; } } catch {}
      if (i === 49) return null;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(dir); } catch {} }
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
  const h = spanAt(st, t);
  return h ? h.account : null;
}
// The history entry live at t, or null inside its grace window.
function spanAt(st, t) {
  let cur = null;
  for (const h of st.history) if (h.from <= t) cur = h; else break;
  if (!cur) return null;
  // `<=`: readings and switches are whole seconds, and the reading that triggered a switch
  // is often taken in the very second of it. Which side it fell on cannot be told, so even
  // with no grace at all that second is nobody's.
  if (cur.from > 0 && t <= cur.from + GRACE_S()) return null;
  return cur;
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
// One account is in ONE window per limit (see READINGS BELONG TO THE LOGIN in the header).
// Of two readings from different windows, the one OBSERVED later describes the account now —
// for a correctly filed account that is the later window too, and where a reading was
// another login's it is what lets the real one displace it — and on the same second, the
// later window. Within one window usage only rises, so the higher figure wins, unless the
// later observation is lower by more than RESET_DROP: then the window was reset (a reset
// granted, a limit lifted) and the lower figure is taken, with a FLOOR at its time that no
// earlier observation in that window gets past again. The slop only absorbs a second or two
// of rounding in reset times the binary reports on whole ten-minute marks; RESET_DROP is
// wider than the point or two two concurrent requests can report out of order.
const WINDOW_SLOP_S = 120;
const RESET_DROP = 5;
const FIVE_H = 5 * 3600;
function current(a, b) {
  if (!a || !b) return a || b || null;
  const ta = Number(a.at) || 0, tb = Number(b.at) || 0;
  if (a.resets && b.resets && Math.abs(a.resets - b.resets) > WINDOW_SLOP_S) return tb > ta || (tb === ta && b.resets > a.resets) ? b : a;
  if (a.floor && tb <= a.floor) return a;
  if (b.floor && ta <= b.floor) return b;
  if (tb > ta && b.pct < a.pct - RESET_DROP) return { ...b, floor: tb };
  if (ta > tb && a.pct < b.pct - RESET_DROP) return { ...a, floor: ta };
  const hi = b.pct >= a.pct ? b : a, floor = Math.max(a.floor || 0, b.floor || 0);
  const out = { ...hi, at: Math.max(ta, tb) };
  if (floor) out.floor = floor; else delete out.floor;
  return out;
}
// When each session's figures were OBSERVED, not when they were last written: a figure
// counts from the first record that showed it. A record whose windows are all as before is a
// re-report (a window gone from it has only expired — the binary drops one whose reset has
// passed), and its figures are as old as they were. Kept in st.sessions for the records that
// still exist. Returns [{session, slot, at, vals}].
function observe(st, dir) {
  const prev = st.sessions || {}, next = {}, out = [];
  for (const rec of records(dir)) {
    const u = rec.usage; if (!u || !u.limits || !u.at) continue;
    const vals = {};
    for (const k of ['five_hour', 'seven_day']) {
      const w = u.limits[k];
      if (w && typeof w.pct === 'number') vals[k] = { pct: w.pct, resets: Number(w.resets) || 0 };
    }
    const p = prev[rec.session_id];
    const same = p && Object.entries(vals).every(([k, v]) => p[k] && p[k].pct === v.pct && p[k].resets === v.resets);
    const at = same ? Number(p.at) || u.at : u.at;
    // A record rewritten at all is a turn that ran, whatever its figures say: that is the
    // proof a login works (verified_at) and that an organization let it back in (BLOCKED),
    // and a turn too small to move a percentage still proves it.
    const moved = !p || u.at > (Number(p.raw) || 0);
    next[rec.session_id] = { ...vals, at, raw: u.at };
    out.push({ session: rec.session_id, slot: rec.slot || '', sock: rec.sock || '', at, vals, raw: u.at, moved });
  }
  st.sessions = next;
  return out;
}
// Returns the accounts a reading has just unblocked.
export function collectUsage(st, dir, now = nowS()) {
  const fresh = {}, unblocked = [];
  const mine = (who, h) => who && st.accounts[who] && (!h.id || !st.accounts[who].id || h.id === st.accounts[who].id);
  for (const o of observe(st, dir)) {
    const hr = o.moved && spanAt(st, o.raw);
    if (hr && mine(hr.account, hr)) { const f = (fresh[hr.account] ||= { obs: [] }); f.lastAt = Math.max(f.lastAt || 0, o.raw); }
    let h = spanAt(st, o.at);
    if (!h || !mine(h.account, h)) continue;
    let at = o.at;
    // No 5h window in a record while the account's own 5h window runs: that record was
    // observed before the window began, or it would carry it.
    const own = ((st.accounts[h.account].usage) || {}).five_hour;
    if (!o.vals.five_hour && liveWin(own, own && own.at, now) && own.resets) {
      at = Math.min(at, own.resets - FIVE_H);
      h = spanAt(st, at);
      if (!h || !mine(h.account, h)) continue;
    }
    const who = h.account, a = st.accounts[who];
    if (a.reset_at && at <= a.reset_at) continue;            // before a `fleet-accounts reset`
    for (const [k, v] of Object.entries(o.vals)) {
      if (!liveWin(v, at, now)) continue;
      ((fresh[who] ||= { obs: [] }).obs).push({ k, w: { ...v, at, ...(a.id ? { id: a.id } : {}) } });
    }
  }
  // Folded into what the state already knew, oldest observation first: a session that ended
  // took its record with it, and a record left over from an earlier window must not displace
  // a later one the state already holds. A stored window that was another login's (tagged
  // with another id) is not this account's at all.
  for (const [name, a] of Object.entries(st.accounts)) {
    const u = a.usage || {};
    for (const k of ['five_hour', 'seven_day']) {
      const old = u[k];
      let cur = liveWin(old, old && old.at, now) && !(old.id && a.id && old.id !== a.id) ? old : null;
      for (const o of ((fresh[name] && fresh[name].obs) || []).filter(x => x.k === k).sort((x, y) => x.w.at - y.w.at)) cur = current(cur, o.w);
      if (cur) u[k] = cur; else delete u[k];
    }
    a.usage = u;
    // A reading taken on it since it was swapped in is the proof its login works.
    if (fresh[name] && fresh[name].lastAt && fresh[name].lastAt >= activeSince(st, name)) a.verified_at = now;
    if (fresh[name] && fresh[name].lastAt) a.read_at = Math.max(a.read_at || 0, fresh[name].lastAt);
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
// ── models and organizations (see MODELS, ORGANIZATIONS, AND A CHOICE BY HAND) ──────────
// A model by its family, which is what a plan gives access to: claude-fable-5-2 and
// `fable[1m]` are both fable. Anything else is kept as its own lower-case id.
export const family = (m) => { const s = String(m || '').toLowerCase().trim().replace(/\[.*$/, ''); const f = s.match(/fable|opus|sonnet|haiku/); return f ? f[0] : s; };
const lacks = (a, fam) => !!a && Array.isArray(a.without) && a.without.some(w => family(w.model) === fam);
// The sessions running now, and the model family each runs (its transcript's last model).
// Read only when some account lacks a model: nothing else needs a transcript opened.
function context(st, dir) {
  const recs = records(dir).filter(r => r.slot);
  const socks = new Set(recs.map(r => r.sock || ''));
  const label = (r) => (socks.size > 1 && r.sock ? `${String(r.sock).replace(/^cf-/, '')}/${r.slot}` : r.slot);
  const running = new Map();
  if (Object.values(st.accounts).some(a => Array.isArray(a.without) && a.without.length)) {
    for (const r of recs) {
      let m = ''; try { m = (r.transcript && lastModel(r.transcript) || {}).model || ''; } catch {}
      if (!m) continue;
      const f = family(m);
      if (!running.has(f)) running.set(f, []);
      if (!running.get(f).includes(label(r))) running.get(f).push(label(r));
    }
  }
  return { running, slots: [...new Set(recs.map(label))] };
}
// The models a running session needs that the account does not have: [[family, [slots]]].
const missing = (a, ctx) => [...((ctx && ctx.running) || new Map())].filter(([f]) => lacks(a, f));
// How far a move to `n` is from free: 0 the current organization with every model its
// sessions run; 1 another organization (or one no answer has named, while the current one is
// known); 2 an account lacking a model a running session uses — the last resort.
function tier(st, n, ctx) {
  const a = st.accounts[n];
  if (missing(a, ctx).length) return 2;
  const mine = orgIdOf(st.accounts[st.active]);
  return mine && orgIdOf(a) !== mine ? 1 : 0;
}
// In rotation: not excluded by hand, and not a slot whose saved login answers as somebody else.
const inRotation = (st, n) => !!st.accounts[n] && !st.accounts[n].excluded && !flagOf(st, n);
// Every account other than the active one that the profile could run on, best first: by
// tier, then by the rule above. A scan rather than a sort: a tie band makes "better"
// intransitive, and Array.sort is not promised to be sane on a comparator that is.
export function ranked(st, thr, now = nowS(), ctx = null) {
  const left = st.order.filter(n => n !== st.active && usable(st.accounts[n], thr, now) && inRotation(st, n)), out = [];
  while (left.length) {
    let b = 0;
    for (let i = 1; i < left.length; i++) {
      const ti = tier(st, left[i], ctx), tb = tier(st, left[b], ctx);
      if (ti < tb || (ti === tb && better(st, left[i], left[b], now))) b = i;
    }
    out.push(left.splice(b, 1)[0]);
  }
  return out;
}
const lastSwitch = (st) => { const h = st.history[st.history.length - 1]; return h ? h.from : 0; };
// A choice by hand holds while the profile is on it. A pin from before holds were open-ended
// carries `until`, and one that has passed is over.
export const pinned = (st, now = nowS()) => !!(st.pin && st.pin.account === st.active && !(st.pin.until && st.pin.until <= now));
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
// What to do about a slot whose saved login answers as somebody else.
function describeFix(st, profile, n) {
  const flag = flagOf(st, n);
  return `its saved login answers as ${flag === 'duplicate' ? `${flagWho(st, n)}'s account — two copies of one login, and using either retires the other's` : 'an account no slot is for'}; out of rotation — fleet-accounts remove ${profile} ${n}, then ${loginCmd(profile, n)}`;
}
// `detail` is the CLI's: which organization each slot is in and what its own saved login
// answered as. It never goes to the phone — /api/usage is names, figures, times and states.
const CHECKED = { expired: 'not checked: its access token has expired (checked once it is fresh again)',
                  refused: 'not checked: the provider refused its access token', no_answer: 'not checked: no answer from the provider' };
const whyUnknown = (state) => (CHECKED[state] || 'no answer from the provider').replace(/^not checked: /, '');
export function describe(profile, thr = threshold(), now = nowS(), { detail = false } = {}) {
  const st = load(profile);
  const accounts = st.order.map((n) => {
    const a = st.accounts[n] || {};
    const active = n === st.active, over = overBy(a, thr, now), out = outNow(a, now), flag = flagOf(st, n);
    let kind = active ? 'active' : 'ready', state = kind;
    if (a.needs_login) { kind = 'needs-login'; state = 'NEEDS-LOGIN'; }
    else if (a.blocked) { kind = 'blocked'; state = 'BLOCKED'; }
    else if (flag) { kind = 'blocked'; state = flag === 'duplicate' ? 'DUPLICATE' : 'MISLABELLED'; }
    else if (out) { kind = 'out'; state = `OUT until ${hhmm(a.out.until)} (hit its ${a.out.why}${a.out.said ? '' : ', no reset time given'})`; }
    else if (over) { kind = 'exhausted'; state = `exhausted until ${hhmm(over.resets)}`; }
    else if (a.excluded) { state = `${kind}, excluded (fleet-accounts include ${profile} ${n})`; }
    else if (!active && stale(a, now)) { kind = 'stale'; state = 'ready, stale (no planned move onto it)'; }
    const u = a.usage || {};
    const row = {
      name: n, active, kind, state, stale: stale(a, now),
      until: out ? out.until : over ? over.resets : 0,
      five_hour: windowOf(u.five_hour, now), seven_day: windowOf(u.seven_day, now),
      fix: a.needs_login ? `${a.needs_login.why} — run: ${loginCmd(profile, n)}`
         : a.blocked ? `${a.blocked.why} — ${blockedFix(profile, n)}`
         : flag ? describeFix(st, profile, n) : '',
    };
    if (detail) {
      const c = a.check;
      row.org = orgNameOf(a) || (flag && c && c.org_name) || '';
      row.answers = flag ? `answers as ${c.org_name || 'another organization'}` : !c ? 'not checked yet' : c.state === 'ok' ? `checked ${ago(c.at, now)}` : CHECKED[c.state] || 'not checked';
      row.excluded = !!a.excluded;
      row.without = (a.without || []).map(w => w.model);
      row.auto = !!a.auto;
    }
    return row;
  });
  const unsaved = onUnsaved(st);
  return {
    profile, active: st.active, accounts, unsaved,
    exhausted: !unsaved && st.exhausted ? { until: Number(st.exhausted.until) || 0, until_at: st.exhausted.until ? hhmm(st.exhausted.until) : '',
                                           workers: workersWord(profile) } : null,
    pin: pinned(st, now) ? { account: st.active } : null,
  };
}
// `list` asks for each slot's own saved login whose tokens no answer covers yet: that is what
// finds a slot holding somebody else's login. Read-only, like the tick's ask; an expired access
// token is not checked (nothing here refreshes one).
export async function checkSlots(profile) {
  const cfg = cfgFor(profile), st0 = load(profile), now = nowS(), got = {};
  for (const n of st0.order) {
    const a = st0.accounts[n]; if (!a) continue;
    const saved = readSaved(profile, cfg, n), o = saved && saved.claudeAiOauth;
    if (!o || !o.accessToken) continue;
    const fp = fpOf(o), c = a.check;
    if (c && c.fp === fp && (c.state === 'ok' || now - (c.at || 0) < RECHECK_S)) continue;
    got[n] = checkOf(await askProfile(o), fp, now);
  }
  if (!Object.keys(got).length) return;
  await withLockA(profile, async () => {
    const st = load(profile);
    for (const [n, c] of Object.entries(got)) {
      const a = st.accounts[n]; if (!a) continue;
      a.check = c;
      if (c.state === 'ok' && c.id === a.id && !a.org) a.org = { id: c.org, name: c.org_name };
    }
    save(profile, st);
  });
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
// The live login back into the slot of ITS OWN identity — `truth` is the answer for exactly
// these tokens — and only when it is not older than what the slot holds. Returns true when it
// wrote. Never on a guess: a copy written into the wrong slot is the duplicate that kills one
// of the two logins (DYING LOGINS), where a copy left a refresh behind is only that.
export function recapture(profile, cfg, st, name, live, truth) {
  const a = st.accounts[name];
  if (!a || !live || !live.oauth || deadWhy(live.oauth)) return false;
  const fp = fpOf(live.oauth);
  if (!truth || truth.state !== 'ok' || truth.fp !== fp || truth.id !== a.id) return false;
  const saved = readSaved(profile, cfg, name);
  const so = saved && saved.claudeAiOauth;
  if (so && (Number(live.oauth.expiresAt) || 0) < (Number(so.expiresAt) || 0)) return false;
  if (so && so.accessToken === live.oauth.accessToken && so.refreshToken === live.oauth.refreshToken) return false;
  writeSaved(profile, cfg, name, live.oauth, accountFor(live, truth) || (saved && saved.oauthAccount) || null);
  a.check = { fp, at: truth.at || nowS(), state: 'ok', id: truth.id, org: truth.org, org_name: truth.org_name };
  if (!a.org && truth.org) a.org = { id: truth.org, name: truth.org_name };
  st.installed = { account: name, fp };
  return true;
}
// The config dir holds `n`'s login now, put there by a /login by hand: it is where the profile
// is. Clears what a failed login had set (NEEDS-LOGIN, BLOCKED), makes `n` active and held
// there like `use`, and writes the live login back into its slot so a later swap back
// restores THIS login and not the broken one. The tick and `use` both come here: `use` right
// after a /login must not wait for the tick to learn what the config dir already says, and
// two copies of this would drift. The caller checked that the live login answers as n's
// identity and is not dead. What was read between the last tick that saw the login before it
// and this one is in doubt, and doubt is attributed to nobody.
function adoptHandLogin(profile, cfg, st, n, live, truth, now = nowS(), dry = false, msg = '') {
  const a = st.accounts[n];
  if (a.needs_login) a.needs_login = null;
  if (a.blocked) a.blocked = null;
  a.verified_at = 0;                                    // a new login, like a re-add
  const last = st.history[st.history.length - 1];
  const doubt = Math.max(st.seen_saved || now, last ? last.from : 0);
  if (last && last.account && doubt < now) st.history.push({ account: '', from: doubt });
  st.active = n; st.history.push({ account: n, from: now, ...(a.id ? { id: a.id } : {}) });
  if (st.history.length > 50) st.history = st.history.slice(-50);
  st.pin = { account: n, at: now };                     // the owner's choice, like `use`
  if (!dry) recapture(profile, cfg, st, n, live, truth);
  notice(profile, msg || `${profile}: now on ${n} (a /login by hand)`, { event: 'switched', from: '', to: n, cause: 'by-hand' });
}
// A /login to an account no slot is for becomes a slot of its own, `login-<n>`, and never
// lands in a slot of another identity. `fleet-accounts add <profile> <name>` while it is live
// renames it.
function newSlot(profile, cfg, st, live, truth, now, dry) {
  let i = 1; while (st.accounts[`login-${i}`]) i++;
  const n = `login-${i}`;
  st.accounts[n] = { id: truth.id, org: { id: truth.org, name: truth.org_name }, auto: true, added_at: now,
                     needs_login: null, blocked: null, verified_at: 0, out: null,
                     check: { fp: truth.fp, at: now, state: 'ok', id: truth.id, org: truth.org, org_name: truth.org_name } };
  st.order.push(n);
  if (!dry) writeSaved(profile, cfg, n, live.oauth, accountFor(live, truth));
  return n;
}
// Who a switch costs something, in words for its notice: sessions mid-conversation lose
// their earlier thinking in another organization, and a session on a model the account
// lacks has every turn refused.
function costOf(st, from, to, ctx) {
  const out = [];
  const fo = orgIdOf(st.accounts[from]), tO = orgIdOf(st.accounts[to]);
  if (from && fo && tO && fo !== tO && ctx && ctx.slots.length)
    out.push(`another organization: ${ctx.slots.join(', ')} ${ctx.slots.length === 1 ? 'loses its' : 'lose their'} earlier thinking`);
  for (const [f, slots] of missing(st.accounts[to], ctx)) out.push(`${to} cannot run ${f}: ${slots.join(', ')} ${slots.length === 1 ? 'is' : 'are'} on it`);
  return out.length ? ` — ${out.join('; ')}` : '';
}
// Swap `to` in. 'ok', or the reason it could not: 'dead' (and `to` is then marked
// NEEDS-LOGIN), 'flagged' (its saved login answers as somebody else, so it is not `to`'s to
// put in), 'unknown' (the live login is one nobody can say whose it is, and writing over it
// could lose the only working copy of a login). Only the login moves: the sessions running
// on the profile pick it up by themselves (GRACE_S). `cause` null: an inbox row and no phone
// line, for a planned move that asks nothing of the owner. `ctx.truth` is the answer for the
// live login, when there is one.
export async function swapIn(profile, cfg, st, to, why, cause = {}, ctx = null) {
  const live = readLive(cfg);
  const from = st.active, truth = ctx && ctx.truth;
  const lfp = live && live.oauth ? fpOf(live.oauth) : '';
  const known = truth && truth.fp === lfp && (truth.state === 'ok' || truth.state === 'installed');
  if (live && live.oauth && !deadWhy(live.oauth) && !known) return 'unknown';
  const fromSlot = known && slotFor(st, truth.id);
  if (fromSlot) recapture(profile, cfg, st, fromSlot, live, truth);
  const saved = readSaved(profile, cfg, to);
  if (!saved || !saved.claudeAiOauth) { markNeedsLogin(profile, st, to, 'its saved login is missing from the secret store'); return 'dead'; }
  const dead = deadWhy(saved.claudeAiOauth);
  if (dead) { markNeedsLogin(profile, st, to, dead); return 'dead'; }
  // Whose login the saved copy is, when no answer covers these tokens yet.
  const a = st.accounts[to], sfp = fpOf(saved.claudeAiOauth), now = nowS();
  if (!(a.check && a.check.fp === sfp && (a.check.state === 'ok' || now - (a.check.at || 0) < RECHECK_S))) {
    a.check = checkOf(await askProfile(saved.claudeAiOauth), sfp, now);
    if (a.check.state === 'ok' && a.check.id === a.id && !a.org) a.org = { id: a.check.org, name: a.check.org_name };
  }
  if (flagOf(st, to)) return 'flagged';
  // Already live and newer (a hand /login, or a refresh since it was saved): keep the live one.
  const liveIsTo = known && truth.id === a.id && !deadWhy(live.oauth);
  if (!(liveIsTo && (Number(live.oauth.expiresAt) || 0) >= (Number(saved.claudeAiOauth.expiresAt) || 0))) {
    writeLive(cfg, saved.claudeAiOauth, saved.oauthAccount);
    st.installed = { account: to, fp: sfp };
  } else st.installed = { account: to, fp: lfp };
  st.active = to;
  if (st.pin && st.pin.account !== to) st.pin = null;   // a by-hand choice ends when it is left
  st.history.push({ account: to, from: now, ...(a.id ? { id: a.id } : {}) });
  if (st.history.length > 50) st.history = st.history.slice(-50);
  a.verified_at = 0;
  const cost = costOf(st, from, to, ctx);
  if (from && from !== to) notice(profile, `${profile}: switched from ${from} to ${to} (${why})${cost}`, cause && { event: 'switched', from, to, ...cause });
  else notice(profile, `${profile}: now on ${to} (${why})${cost}`, cause && { event: 'switched', from: '', to, ...cause });
  return 'ok';
}
// The best account with room (see ranked), skipping NEEDS-LOGIN, BLOCKED, excluded and
// flagged — trying each until one swaps in, never above `maxTier`. Returns its name or null.
async function failover(profile, cfg, st, thr, why, cause, now = nowS(), ctx = null, maxTier = 2) {
  for (const name of ranked(st, thr, now, ctx)) {
    if (tier(st, name, ctx) > maxTier) continue;
    if (await swapIn(profile, cfg, st, name, why, cause, ctx) === 'ok') return name;
  }
  return null;
}
// The active account has room: move only to one whose week ends clearly sooner, in the same
// organization with every model running, and only once the last switch has settled and no
// by-hand choice holds. Returns its name or null.
async function preferred(profile, cfg, st, thr, now, ctx = null) {
  if (pinned(st, now) || now - lastSwitch(st) < HOLD_S) return null;
  const mine = weekEnds(st.accounts[st.active], now);
  for (const name of ranked(st, thr, now, ctx)) {
    if (tier(st, name, ctx) > 0) continue;                 // crossing is failover's alone
    const theirs = weekEnds(st.accounts[name], now);
    if (!(theirs + MARGIN_S < mine)) continue;
    if (stale(st.accounts[name], now)) continue;           // see STALE_S

    const why = `${name}'s week resets first, ${hhmm(theirs)}${mine === Infinity ? '' : ` vs ${hhmm(mine)}`}`;
    if (await swapIn(profile, cfg, st, name, why, null, ctx) === 'ok') return name;
  }
  return null;
}

// ── the sessions of one fleet ────────────────────────────────────────────────────────
function tmux(sock, args) {
  const r = spawnSync('tmux', ['-u', '-L', sock, ...args], { encoding: 'utf8', timeout: 5000 });
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
// A profile with ONE saved account still has its login identified and written back: left
// alone, that one copy fell behind the live login's rotations, and the first swap back onto it
// after a second account was added met a retired refresh token (DYING LOGINS).
export async function tick(sock, { dry = false } = {}) {
  const res = { managed: false, actions: [] };
  if (!enabled()) return res;
  const proj = projectForSock(sock);
  if (!proj) return res;
  const profile = proj.profile === 'default' ? 'work' : proj.profile;
  const st0 = load(profile);
  if (!st0.order.length) return res;
  const cfg = proj.cfg, dir = path.join(cfg, 'fleet'), thr = threshold(), act = (s) => res.actions.push(s);
  // Who the live login is: asked before the lock (an answer can take seconds, and the lock is
  // every fleet's of the profile), and only when its tokens are new to the state.
  const live0 = readLive(cfg);
  const truth0 = live0 && live0.oauth && !deadWhy(live0.oauth) ? await identify(st0, live0.oauth) : null;
  await withLockA(profile, async () => {
    const st = load(profile);
    const now = nowS();
    const live = readLive(cfg);
    const lfp = live && live.oauth ? fpOf(live.oauth) : '';
    const working = !!(live && live.oauth && !deadWhy(live.oauth));
    const truth = truth0 && truth0.fp === lfp ? truth0 : null;
    if (truth && truth.asked) st.live = checkOf(truth, truth.fp, now);
    // The tokens moved between the answer and the lock: the next tick asks about the new ones.
    if (working && !truth) { res.managed = st.order.length >= 2; save(profile, st); return; }
    // 0. A login nobody can say whose it is — the provider did not answer, or refused a token
    // Claude Code had just been given. Its readings are nobody's — credited to the active
    // account, one reading from somebody else's nearly spent window had the profile exhausted
    // and every worker parked while the account itself had room — and nothing is failed over
    // or parked onto a saved login until it is known again, since a swap would write over the
    // only copy of whatever it is. What the engine had parked is let go. The span opens at
    // the last tick that still saw a known login: what was read in between is in doubt.
    if (working && truth.state !== 'ok' && truth.state !== 'installed') {
      if (!onUnsaved(st)) {
        const last = st.history[st.history.length - 1];
        st.history.push({ account: '', from: Math.max(st.seen_saved || now, last ? last.from : 0) });
        if (st.history.length > 50) st.history = st.history.slice(-50);
        notice(profile, `${profile}: on a login it cannot identify (${whyUnknown(truth.state)}) — failover paused until it can`, null);
        act('on a login it cannot identify');
      }
      st.exhausted = null;
      res.managed = st.order.length >= 2;
      if (res.managed) collectUsage(st, dir, now);
      save(profile, st);
      if (dry) return;
      for (const s of sessionsOf(dir, sock)) {
        if (s.parked !== 'governor-accounts') continue;
        try { fs.unlinkSync(path.join(dir, `${sock}.${s.slot}.parked`)); act(`un-parked ${s.slot}`); } catch {}
      }
      return;
    }
    // 1. A login filed by its own identity (WHO A LOGIN IS): the slot that is for it — or a
    // new slot when none is — and, when that is not the account in use, a /login by hand,
    // which is where the profile now is. .claude.json is put right, and the live tokens go
    // back into that slot and no other.
    if (working && truth.state === 'ok') {
      let n = slotFor(st, truth.id), made = false;
      if (!n) { n = newSlot(profile, cfg, st, live, truth, now, dry); made = true; act(`saved ${n}`); }
      if (n !== st.active || onUnsaved(st)) {
        adoptHandLogin(profile, cfg, st, n, live, truth, now, dry, made
          ? `${profile}: a /login to an account no slot is for — saved as '${n}' and held there (fleet-accounts add ${profile} <name> while it is live names it)` : '');
        act(`adopted ${n}`);
      }
      if (!dry && loginId(live.account) !== truth.id) {
        const blk = truth.account || ((readSaved(profile, cfg, n) || {}).oauthAccount);
        if (blk && loginId(blk) === truth.id) writeAccountOnly(cfg, blk);
      }
      if (!dry && recapture(profile, cfg, st, n, live, truth)) act(`recaptured ${n}`);
      st.seen_saved = now;
    } else if (working) {
      // Exactly what the engine put there: that slot's, whatever .claude.json now says — and
      // .claude.json is put right again.
      const ia = st.accounts[st.installed.account];
      if (!dry && ia && ia.id && (!live.account || loginId(live.account) !== ia.id)) {
        const saved = readSaved(profile, cfg, st.installed.account);
        if (saved && saved.oauthAccount) writeAccountOnly(cfg, saved.oauthAccount);
      }
      st.seen_saved = now;
    }
    // 2. Claude Code blanked the live login: the account in use is the one that died.
    const cur = st.active && st.accounts[st.active];
    if (cur && !cur.needs_login && live && live.oauth && deadWhy(live.oauth) && !onUnsaved(st)) {
      markNeedsLogin(profile, st, st.active, deadWhy(live.oauth)); act(`needs-login ${st.active}`);
    }
    if (st.order.length < 2) { save(profile, st); return; }
    res.managed = true;
    const ctx = { ...context(st, dir), truth };
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
        let pane = '';
        try { pane = accountPane(sock, s.slot, dir); } catch {}
        if (LOGIN_RE.test(pane)) {
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
    // 3c. A turn refused for a model the account does not have (model_not_found, and the
    // binary's own sentence naming the model): learned once, said once, and from then on that
    // account is the last resort while a session runs that model. Spent by the account's
    // `without` entry, or by a `fleet-accounts models … --with` made after it.
    for (const r of records(dir)) {
      const f = r.failure, fat = f ? Number(f.at) || 0 : 0;
      if (!f || f.error !== 'model_not_found' || !fat) continue;
      const said = modelRefused(f.message), fam = family(said);
      const who = accountAt(st, fat), x = who && st.accounts[who];
      if (!said || !x || fat <= (x.added_at || 0) || fat <= (x.models_at || 0) || lacks(x, fam)) continue;
      (x.without ||= []).push({ model: fam, at: fat, said });
      notice(profile, `${profile}/${who} cannot run ${said} (Claude refused it: model not found or no access) — from now on the last resort while a session runs ${fam}; fleet-accounts models ${profile} ${who} --with ${fam} if that changes`, null);
      act(`without ${who} ${fam}`);
      ctx.running = context(st, dir).running;
    }
    // 4. Over the line, out, or unusable: move to the best account with room, at once — no
    // hold; a choice by hand gives way here too. Excluded by hand, or lacking a model a
    // running session uses (and not held there by hand): move when there is somewhere better
    // to go, and stay when there is not. Otherwise, to an account whose week ends clearly
    // sooner (see WHICH ACCOUNT TO BE ON).
    const a = st.active && st.accounts[st.active];
    const over = a && (overBy(a, thr) || (outNow(a, now) && { limit: outNow(a, now).limit, pct: 100, out: outNow(a, now) }));
    const gap = a && !pinned(st, now) ? missing(a, ctx) : [];
    const runs = !!a && !a.needs_login && !a.blocked && !over;
    const away = runs && (a.excluded || gap.length) ? ranked(st, thr, now, ctx).filter(n => a.excluded || tier(st, n, ctx) < 2) : [];
    if (!dry && runs && away.length) {
      const why = a.excluded ? `${st.active} is excluded by hand` : `${st.active} cannot run ${gap.map(([f]) => f).join(', ')}`;
      const to = await failover(profile, cfg, st, thr, why, null, now, ctx, a.excluded ? 2 : 1);
      if (to) act(`switched to ${to}`);
    } else if (!dry && !runs) {
      const why = !a ? 'no account was active' : a.needs_login ? `${st.active} needs /login` : a.blocked ? `${st.active} is blocked by its organization`
        : over.out ? `${st.active} hit its ${over.out.why}, until ${hhmm(over.out.until)}` : `${over.limit} at ${over.pct}%`;
      const cause = !a ? { cause: 'none-active' } : a.needs_login ? { cause: 'needs-login' } : a.blocked ? { cause: 'blocked' }
        : { cause: 'limit', ...(over.limit ? { limit: over.limit } : {}), pct: over.pct };
      const to = await failover(profile, cfg, st, thr, why, cause, now, ctx);
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
    } else if (!dry && !(runs && (a.excluded || gap.length))) {
      const to = await preferred(profile, cfg, st, thr, now, ctx);
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
export async function add(profile, name) {
  if (!NAME_RE.test(name)) throw new Error(`'${name}' is not an account name (letters, digits, - and _; up to 32)`);
  const cfg = cfgFor(profile);
  const live = readLive(cfg);
  if (!live || !live.oauth) throw new Error(`${tilde(cfg)} holds no Claude login to save — log in first: ${loginCmd(profile, name)}`);
  const dead = deadWhy(live.oauth);
  if (dead) throw new Error(`the login ${tilde(cfg)} holds does not work (${dead}) — log in again: ${loginCmd(profile, name)}`);
  // Whose login it is, asked of its token (WHO A LOGIN IS) — never .claude.json's say-so.
  const ans = await askProfile(live.oauth);
  if (ans.state !== 'ok') throw new Error(`could not check whose login ${tilde(cfg)} holds (${CHECKED[ans.state]}) — ${ans.state === 'expired' ? 'start a Claude session on the profile so it refreshes the login, then retry' : 'retry in a minute'}; a login is never filed by what .claude.json says`);
  const fp = fpOf(live.oauth), now = nowS();
  return withLock(profile, () => {
    const st = load(profile);
    let was = st.accounts[name];
    const other = Object.entries(st.accounts).find(([n, a]) => n !== name && (a.id === ans.id || (a.check && a.check.fp === fp)));
    let renamed = '';
    // A slot the engine made for a hand /login is what `add` names.
    if (other && other[1].auto && other[1].id === ans.id && !was) {
      renamed = other[0]; renameSlot(st, renamed, name); deleteSaved(profile, cfg, renamed); was = st.accounts[name];
    } else if (other) throw new Error(`that login is already saved as '${other[0]}' — /login to the account you want to add first`);
    if (was && was.id && was.id !== ans.id) throw new Error(`'${name}' is saved as another account${orgNameOf(was) ? ` (in ${orgNameOf(was)})` : ''} — fleet-accounts remove ${profile} ${name} first, or add this login under another name`);
    writeSaved(profile, cfg, name, live.oauth, accountFor(live, ans));
    // verified_at goes back to 0: this is a NEW login, and nothing that proved the one it
    // replaces says anything about it — with the old mark left in place, a re-add in the same
    // second as the last reading skipped the /login check on exactly the login it was for.
    // An `out` mark stays when it is the same login saved again: the limit is the account's,
    // and a fresh token for it is exactly as spent.
    st.accounts[name] = { ...(was || {}), id: ans.id, org: { id: ans.org, name: ans.org_name }, check: checkOf(ans, fp, now),
                          added_at: now, needs_login: null, blocked: null, verified_at: 0,
                          out: was && was.id === ans.id ? was.out || null : null };
    delete st.accounts[name].auto;
    if (!st.order.includes(name)) st.order.push(name);
    // It is what the config dir holds right now, so it is what the profile runs on.
    if (st.active !== name) { st.active = name; st.history.push({ account: name, from: st.history.length ? now : 0, id: ans.id }); }
    st.installed = { account: name, fp };
    st.live = checkOf(ans, fp, now); st.seen_saved = now;
    if (loginId(live.account) !== ans.id) writeAccountOnly(cfg, ans.account);
    if (st.exhausted && !overBy(st.accounts[name], threshold()) && !outNow(st.accounts[name])) st.exhausted = null;
    save(profile, st);
    return { st, readded: !!was && !renamed, renamed, org: ans.org_name };
  });
}
function renameSlot(st, from, to) {
  st.accounts[to] = st.accounts[from]; delete st.accounts[from];
  st.order = st.order.map(n => (n === from ? to : n));
  if (st.active === from) st.active = to;
  for (const h of st.history) if (h.account === from) h.account = to;
  if (st.pin && st.pin.account === from) st.pin.account = to;
  if (st.installed && st.installed.account === from) st.installed.account = to;
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
export async function use(profile, name) {
  const cfg = cfgFor(profile), dir = fleetDirFor(profile);
  const st0 = load(profile);
  if (!st0.accounts[name]) throw new Error(`${profile} has no account called '${name}'`);
  const live0 = readLive(cfg);
  const truth0 = live0 && live0.oauth && !deadWhy(live0.oauth) ? await identify(st0, live0.oauth) : null;
  return withLockA(profile, async () => {
    const st = load(profile), now = nowS();
    const a = st.accounts[name];
    if (!a) throw new Error(`${profile} has no account called '${name}'`);
    const live = readLive(cfg), lfp = live && live.oauth ? fpOf(live.oauth) : '';
    const t = truth0 && truth0.fp === lfp ? truth0 : null;
    if (t && t.asked) st.live = checkOf(t, t.fp, now);
    const tid = t && (t.state === 'ok' || t.state === 'installed') ? t.id : '';
    const working = !!(live && live.oauth && !deadWhy(live.oauth));
    // Flagged, but the flag is a record of a past failure and the config dir is the truth now:
    // a /login by hand that just worked is cleared by the tick on ITS schedule, and refusing
    // here in the seconds before it would point the owner at the step they have just done.
    if (a.needs_login || a.blocked) {
      if (working && a.id && tid === a.id) adoptHandLogin(profile, cfg, st, name, live, t, now);
      else {
        const where = !live || !live.oauth ? '' : !working ? ` (the login in the config dir is dead: ${deadWhy(live.oauth)})`
          : tid && tid !== a.id ? ' (the config dir is logged in as a different account)' : '';
        if (a.needs_login) throw new Error(`'${name}' needs /login first${where} — run: ${loginCmd(profile, name)}`);
        throw new Error(`'${name}' is blocked: ${a.blocked.why}${where} — ${blockedFix(profile, name)}`);
      }
    }
    if (flagOf(st, name)) throw new Error(`'${name}': ${describeFix(st, profile, name)}`);
    // The live login is kept before anything replaces it: written back into its own slot, or
    // saved as a new one when no slot is for it — the same filing the tick does.
    let made = '';
    if (working && t && t.state === 'ok') {
      const n = slotFor(st, t.id);
      if (n) recapture(profile, cfg, st, n, live, t);
      else made = newSlot(profile, cfg, st, live, t, now, false);
    }
    const elsewhere = onUnsaved(st) || !working || tid !== a.id;
    // Held either way: `use` of the account already in use is still the owner choosing it.
    st.pin = { account: name, at: now };
    // Out by Claude's word, and chosen anyway: the owner may know what the mark does not (a
    // plan upgraded, a limit lifted). The mark ends here rather than undoing the choice on the
    // next tick; a turn that fails at the limit again sets it again, and is left at once.
    const wasOut = outNow(a);
    if (wasOut) a.out = { ...a.out, until: now };
    if (st.active === name && !elsewhere) { save(profile, st); return { st, same: true, wasOut, made }; }
    const r = await swapIn(profile, cfg, st, name, 'by hand', { cause: 'by-hand' }, { ...context(st, dir), truth: t });
    if (r !== 'ok') { st.pin = null; if (wasOut) a.out = { ...a.out, until: wasOut.until }; }
    save(profile, st);
    if (r === 'dead') throw new Error(`'${name}''s saved login does not work (${st.accounts[name].needs_login.why}) — run: ${loginCmd(profile, name)}`);
    if (r === 'flagged') throw new Error(`'${name}': ${describeFix(st, profile, name)}`);
    if (r === 'unknown') throw new Error(`could not tell whose login ${tilde(cfg)} holds (${whyUnknown(t ? t.state : 'no_answer')}), so it was not replaced: it may be the only working copy of a login — retry in a minute`);
    return { st, same: false, wasOut, made };
  });
}
// `fleet-accounts reset`: the account's stored figures are dropped, and nothing observed for it
// before now is believed again — for a usage reset on an account no session is on to show it.
export function resetUsage(profile, name) {
  return withLock(profile, () => {
    const st = load(profile), a = st.accounts[name];
    if (!a) throw new Error(`${profile} has no account called '${name}'`);
    a.usage = {}; a.reset_at = nowS(); a.out = null;
    save(profile, st);
    return st;
  });
}
// `fleet-accounts models`: the models an account lacks, by family, set by hand.
export function setModels(profile, name, { without = [], with: have = [] } = {}) {
  return withLock(profile, () => {
    const st = load(profile), a = st.accounts[name], now = nowS();
    if (!a) throw new Error(`${profile} has no account called '${name}'`);
    const back = new Set(have.map(family));
    a.without = (a.without || []).filter(w => !back.has(family(w.model)));
    for (const m of without) if (!lacks(a, family(m))) a.without.push({ model: family(m), at: now, said: 'by hand' });
    if (have.length) a.models_at = now;
    if (!a.without.length) delete a.without;
    save(profile, st);
    return (a.without || []).map(w => w.model);
  });
}
// `fleet-accounts exclude|include`: out of rotation without forgetting its login.
export function setExcluded(profile, name, on) {
  return withLock(profile, () => {
    const st = load(profile), a = st.accounts[name];
    if (!a) throw new Error(`${profile} has no account called '${name}'`);
    if (on) a.excluded = true; else delete a.excluded;
    save(profile, st);
    return st;
  });
}
// `fleet-accounts auto`: a choice by hand stops holding; the planner picks from the next tick.
export function auto(profile) {
  return withLock(profile, () => {
    const st = load(profile), was = st.pin && st.pin.account;
    st.pin = null;
    save(profile, st);
    return was || '';
  });
}
// Wire StopFailure into the profile's settings.json, beside the six install.sh wires, so
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
  tick(sock, { dry: flag === '--dry-run' }).then((r) => {
    for (const a of r.actions) console.log(`accounts: ${a}`);
    process.exit(r.managed ? 0 : 3);
  }, (e) => { process.stderr.write(`accounts: ${(e && e.stack) || e}\n`); process.exit(1); });
}
