#!/usr/bin/env node
// server/index.mjs — ghostfleet team: the fleet, for a small team, from a browser.
//
// THIS ENDPOINT IS REMOTE CODE EXECUTION BY DESIGN, exactly like fleet-serve: a send injects
// a prompt into an agent that runs commands, a spawn creates checkouts. So it binds to
// loopback (or a tailnet address) and nothing else, every request is a logged-in person,
// every write is in the activity log with that person's name, and the destructive verbs
// need an explicit confirmation. Zero dependencies, node builtins only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ATTACH_MAX_BYTES } from './attach.mjs';
import { createEngine, askAI } from './automations.mjs';
import { describeTrigger } from '../shared/automations.js';
import { can, denial, visibleProjects, isAdmin, migrate, TOOL_ACTION, automationProjects } from './access.mjs';
import { createUsers, dataDir, slug, hashPw, pwOk, publicUser, selfUser } from './users.mjs';
import { createAdmin } from './admin.mjs';
import { createAiAccount, profilesOf } from './ai-account.mjs';
import { GF_HOME } from './paths.mjs';
import { inRequest, asUser } from './i18n.mjs';
import { t, msg, render, normLang, locale } from '../shared/i18n/index.js';
import { createUsage } from './usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MODE = argv.includes('--demo') || process.env.GFW_MODE === 'demo' ? 'demo' : 'real';
const PORT = Number(flag('port', process.env.GFW_PORT || 8790));
const BIND = flag('bind', process.env.GFW_BIND || '127.0.0.1');
const DIST = path.join(ROOT, 'web', 'dist');
const DATA = dataDir(MODE);
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

// ── bind: loopback or the tailnet, never a LAN or the internet ──────────────────────────
function bindable(addr) {
  if (addr === 'localhost' || addr === '::1' || /^127\./.test(addr)) return true;
  const m = /^100\.(\d+)\./.exec(addr);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;   // 100.64.0.0/10
  return /^fd7a:115c:a1e0:/i.test(addr);
}
if (!bindable(BIND)) {
  console.error(`ghostfleet team: refusing to listen on '${BIND}'. Only loopback (127.0.0.1) or a Tailscale IP (100.64.0.0/10):\nanyone who reaches this port can run code on this machine.`);
  process.exit(2);
}

// ── Host: binding to loopback is not enough ─────────────────────────────────────────────
// A page on evil.example can point its own name at 127.0.0.1 (DNS rebinding) and then talk
// to this port as same-origin: X-GFW and SameSite do not help, because to the browser it IS
// that origin. What it cannot fake is the Host it sends, so only the names this server is
// reached by are answered. The port is not compared: `pnpm dev` arrives through vite's proxy
// with vite's port, and a rebinding page differs in the NAME. GFW_HOSTS adds more names
// (a MagicDNS name, comma-separated).
const hostName = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
const HOSTS = new Set(['127.0.0.1', 'localhost', '::1', hostName(BIND),
  ...String(process.env.GFW_HOSTS || '').split(',').map(hostName).filter(Boolean)]);

const fleet = MODE === 'demo' ? await import('./demo.mjs') : await import('./fleet.mjs');
const voice = await import('./voice.mjs');
const piper = await import('./piper.mjs');
const router = await import('./router.mjs');
const { createTasks } = await import('./tasks.mjs');

// ── small persistence helpers ───────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const file = (n) => path.join(DATA, n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => { const f = file(n), tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f); };
const appendLine = (n, row) => fs.appendFileSync(file(n), JSON.stringify(row) + '\n', { mode: 0o600 });
function readLines(n, limit) {
  let lines = [];
  try { lines = fs.readFileSync(file(n), 'utf8').trim().split('\n').filter(Boolean); } catch {}
  return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── people: users.mjs keeps the file, access.mjs decides what each one may do ─────────────
// There is no account creation from the web: the first admin comes from admin-cli.mjs on the
// server's console (§1), and every account after that from the Administration panel.
const store = createUsers(DATA);
const userById = (id) => store.find(String(id || ''));

// ── login sessions: a cookie, stored only as its hash, idle-expiring ─────────────────────
const IDLE = 12 * 3600;
let logins = readJson('logins.json', {});
let loginsDirty = false;
setInterval(() => { if (loginsDirty) { loginsDirty = false; writeJson('logins.json', logins); } }, 5000).unref();
function mintLogin(user) {
  const tok = crypto.randomBytes(32).toString('base64url');
  logins[sha256(tok)] = { user: user.id, exp: now() + IDLE, renewed: now() };
  writeJson('logins.json', logins);
  return tok;
}
function whoIs(req, res) {
  const m = /(?:^|;\s*)gfw=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const k = sha256(m[1]), s = logins[k];
  if (!s || s.exp <= now()) { if (s) { delete logins[k]; loginsDirty = true; } return null; }
  const u = userById(s.user);
  // A disabled account's open logins end on its next request, wherever they are (§2).
  if (!u || u.disabled) { delete logins[k]; loginsDirty = true; return null; }
  s.exp = now() + IDLE; loginsDirty = true;
  if (now() - (s.renewed || 0) >= 60) {
    res.setHeader('Set-Cookie', cookie(m[1], IDLE));
    s.renewed = now();
  }
  return { user: u, key: k };
}
function dropLogins(userId, keep) {
  for (const [k, s] of Object.entries(logins)) if (s.user === userId && k !== keep) delete logins[k];
  writeJson('logins.json', logins);
}
const cookie = (tok, maxAge) => `gfw=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// Count failures before yielding for the response delay, so parallel guesses cannot all
// enter an empty window. Names share slug() with login; addresses come from the socket.
const LOGIN_WINDOW = 15 * 60;
const failuresByName = new Map(), failuresByIp = new Map();
const dummyLogin = { salt: 'ghostfleet-login-dummy', hash: '0'.repeat(128) };
function loginFailures(map, key) {
  const row = map.get(key);
  if (row && row.until > now()) return row.n;
  map.delete(key); return 0;
}
function failedLogin(map, key) {
  for (const [k, row] of map) if (row.until <= now()) map.delete(k);
  const row = map.get(key) || { n: 0, until: now() + LOGIN_WINDOW };
  row.n++; map.set(key, row);
}

// ── who works on what, who is looking at what, and what everyone did ─────────────────────
let state = readJson('state.json', { owners: {} });
const saveState = () => writeJson('state.json', state);
const key = (p, s) => `${p}/${s}`;
const presence = new Map();       // key -> Map(userId -> {at, typing})
function seen(p, s, userId, typing) {
  const k = key(p, s);
  if (!presence.has(k)) presence.set(k, new Map());
  presence.get(k).set(userId, { at: Date.now(), typing: !!typing });
}
function here(p, s) {
  const m = presence.get(key(p, s));
  if (!m) return [];
  const out = [];
  for (const [id, v] of m) if (Date.now() - v.at < 12000) out.push({ user: id, typing: v.typing && Date.now() - v.at < 6000 });
  return out;
}
// The demo opens with the work already split between the people, which is the point it shows.
function seedDemoOwners() {
  const [a, b] = [store.list[0]?.id, store.list[1]?.id || store.list[0]?.id];
  state.owners = {
    'acme-web/master': a, 'acme-web/onboarding': a, 'acme-web/stripe-billing': b,
    'acme-web/revenue-dashboard': b, 'toolbox/kpi-report': a,
  };
  saveState();
}
const audit = (row) => appendLine('activity.jsonl', { ts: now(), ...row });
const activity = (limit = 200) => readLines('activity.jsonl', limit);

// ── the verbs, by MCP tool name — the allowlist IS the enforcement ───────────────────────
const TOOLS = {
  fleet_send:            { fields: ['project', 'session', 'prompt', 'anyway'] },
  fleet_answer:          { fields: ['project', 'session', 'text', 'no_enter', 'expect'] },
  fleet_interrupt:       { fields: ['project', 'session'] },
  fleet_pause:           { fields: ['project', 'session'] },
  fleet_resume:          { fields: ['project', 'session', 'prompt'] },
  fleet_wake:            { fields: ['project', 'session'] },
  fleet_reopen:          { fields: ['project', 'session'] },
  fleet_unqueue:         { fields: ['project', 'session', 'prompt'] },
  fleet_spawn:           { fields: ['project', 'name', 'branch', 'from', 'prompt', 'model', 'reuse', 'force_new'] },
  fleet_rename:          { fields: ['project', 'session', 'new_name'], confirm: true },
  fleet_stop:            { fields: ['project', 'session', 'reclaim', 'force'], confirm: true },
  fleet_worktree_remove: { fields: ['project', 'path', 'force'], confirm: true },
  // ghostfleet team's own, until ghostfleet has a command that owns these markers.
  gfw_label:             { fields: ['project', 'session', 'text'], local: true },
  gfw_schedule:          { fields: ['project', 'session', 'at', 'msg'], local: true },
  gfw_unschedule:        { fields: ['project', 'session'], local: true },
};
const BOOLS = new Set(['anyway', 'no_enter', 'force_new', 'reclaim', 'force']);
// The gfw_* verbs do not go through ghostfleet's checks: their session becomes part of a FILE
// name (fleet.mjs labelFile/schedFile). fleet-serve's NAME_OK without the `/`, so a name
// cannot climb out of the fleet dir ("x/../../.bashrc").
const SESSION_OK = /^[A-Za-z0-9][A-Za-z0-9 ._~-]{0,47}$/;
function buildArgs(tool, raw) {
  const v = TOOLS[tool];
  if (!v) throw httpErr(400, t('err.unknownTool', { tool }));
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, val] of Object.entries(a)) {
    if (!v.fields.includes(k)) throw httpErr(400, t('err.badField', { tool, field: k }));
    if (val === undefined || val === null || val === '') continue;
    out[k] = BOOLS.has(k) ? val === true : String(val);
  }
  if (!out.project) throw httpErr(400, t('err.noProjectArg'));
  if (v.local && !out.session) throw httpErr(400, t('err.noSessionArg'));
  if (v.local && !SESSION_OK.test(out.session)) throw httpErr(400, t('err.badSession', { session: out.session.slice(0, 60) }));
  return { args: out, v };
}

// ── http plumbing ───────────────────────────────────────────────────────────────────────
function httpErr(status, text) { return Object.assign(new Error(text), { status }); }
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 256 * 1024) throw httpErr(413, t('err.bodyTooBig')); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpErr(400, t('err.bodyNotJson')); }
}
async function rawBody(req, cap, what = t('err.theAudio')) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > cap) throw httpErr(413, t('err.tooBig', { what, mb: Math.round(cap / 1048576) })); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function localAct(tool, a) {
  if (tool === 'gfw_label') return fleet.setLabel(a.project, a.session, a.text || '');
  if (tool === 'gfw_unschedule') return fleet.cancelSchedule(a.project, a.session);
  const at = Number(a.at);
  if (!Number.isInteger(at) || at < now() + 20 || at > now() + 14 * 86400) throw httpErr(400, t('err.schedWhen'));
  const text = String(a.msg || t('sched.default')).trim().slice(0, 4000) || t('sched.default');
  return fleet.schedule(a.project, a.session, at, text);
}
// One verb, by whoever asked: a person's click or an automation (`via`, its name). The same
// allowlist, checks, owners and activity row either way — an automation is not a back door.
//   This is where a verb is executed, so this is where access is decided: a prompt that tries
// to reach another project — from the voice dispatcher, the assistant, an automation or a
// crafted request — is refused here whatever route it came by.
async function perform(userId, tool, rawArgs, { confirm = false, owner, via } = {}) {
  const { args, v } = buildArgs(tool, rawArgs);
  const no = denial(userById(userId), args.project, TOOL_ACTION[tool]);
  if (no) throw httpErr(no.status, no.text);
  if (tool === 'fleet_spawn' && owner && owner !== userId && !can(userById(owner), args.project, 'read'))
    throw httpErr(400, t('err.ownerNoAccess', { project: args.project }));
  if (v.confirm && confirm !== true) throw httpErr(428, t('err.needsConfirm', { tool }));
  usage.gate(userId, tool, { project: args.project, via });     // over their token cap: 429
  // An answer names the prompt it answers: the page drew a pane polled a moment ago, and a
  // "1" + Enter landing after the prompt is gone becomes a MESSAGE in the composer.
  if (tool === 'fleet_answer' && !args.expect)
    return { ok: false, changed: true, text: t('err.promptGone') };
  const r = v.local ? await localAct(tool, args) : await fleet.act(tool, args);
  const subject = args.session || args.name || args.path || '-';
  if (r.ok && tool === 'fleet_spawn') { state.owners[key(args.project, args.name)] = String(owner || userId); saveState(); }
  if (r.ok && tool === 'fleet_rename') {
    const from = key(args.project, args.session), to = key(args.project, args.new_name);
    if (state.owners[from]) { state.owners[to] = state.owners[from]; delete state.owners[from]; saveState(); }
  }
  if (r.ok && tool === 'fleet_stop') { delete state.owners[key(args.project, args.session)]; saveState(); }
  audit({ user: userId, verb: tool, project: args.project, subject, ...(via ? { via } : {}),
          args: Object.fromEntries(Object.entries(args).map(([k, val]) => [k, typeof val === 'string' ? val.slice(0, 500) : val])),
          result: r.changed ? 'changed' : r.ok ? 'ran' : 'refused', output: String(r.text || '').slice(0, 500) });
  return r;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
                '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
                '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
function serveStatic(res, pathname) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(t('err.noBuild'));
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw httpErr(400, t('err.badPath')); }
  let f = path.join(DIST, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!f.startsWith(DIST + path.sep) ||!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream',
                       'Cache-Control': f.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
                       'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);   // a stream error is an uncaught throw
}
const q = (url, k) => url.searchParams.get(k) || '';

// ── routes ──────────────────────────────────────────────────────────────────────────────
async function route(req, res, url) {
  const p = url.pathname;
  const ip = req.socket.remoteAddress;

  // A cross-site page cannot set a custom header without a CORS preflight, which this server
  // never answers — so a POST that carries it came from this app. SameSite=Strict covers the rest.
  if (req.method !== 'GET' && req.headers['x-gfw'] !== '1') throw httpErr(403, t('err.noXGFW'));

  if (p === '/api/health') {
    const w = whoIs(req, res);
    // `setup`: no account exists yet, and the page can only say who has to run admin-cli.
    return send(res, 200, { ok: true, mode: MODE, setup: store.list.length === 0, user: selfUser(w?.user), admin: isAdmin(w?.user) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req);
    const name = slug(b.name);
    if (loginFailures(failuresByName, name) >= 5 || loginFailures(failuresByIp, ip) >= 20)
      throw httpErr(429, t('err.loginLimited'));
    const u = userById(name);
    const valid = pwOk(u || dummyLogin, b.password || '');
    if (!u || u.disabled || !valid) {
      failedLogin(failuresByName, name); failedLogin(failuresByIp, ip);
      audit({ user: slug(b.name) || '?', verb: 'login', ip, result: 'refused', ...(u?.disabled ? { output: msg('act.accountDisabled') } : {}) });
      await new Promise(r => setTimeout(r, 600));
      throw httpErr(401, t('err.badLogin'));
    }
    if (MODE === 'demo' && !Object.keys(state.owners).length) seedDemoOwners();
    // A language picked on the login screen is this person's from now on.
    if (normLang(b.lang) && b.lang !== u.lang) { u.lang = b.lang; store.save(); }
    audit({ user: u.id, verb: 'login', ip, result: 'ran' });
    return send(res, 200, { ok: true, user: selfUser(u) }, { 'Set-Cookie': cookie(mintLogin(u), IDLE) });
  }

  const w = whoIs(req, res);
  if (!w) throw httpErr(401, t('err.login'));
  const me = w.user;
  asUser(me);
  if (me.mustChange && !['/api/me', '/api/password', '/api/logout'].includes(p))
    throw httpErr(403, t('err.mustChange'));
  if (p === '/api/me' && req.method === 'GET') return send(res, 200, { ok: true, user: selfUser(me) });
  // Every project-named route below asks here first; 404 when it does not exist for `me`.
  const guard = (project, action) => { const no = denial(me, project, action); if (no) throw httpErr(no.status, no.text); };
  const mine = async () => visibleProjects(me, await fleet.projects());

  if (p === '/api/logout' && req.method === 'POST') {
    delete logins[w.key]; writeJson('logins.json', logins);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (p === '/api/users' && req.method === 'GET') return send(res, 200, { users: store.list.filter(u => !u.disabled).map(publicUser) });
  if (p === '/api/password' && req.method === 'POST') {
    const b = await body(req);
    if (!pwOk(me, b.old || '')) throw httpErr(401, t('err.oldPw'));
    if (String(b.new || '').length < 12) throw httpErr(400, t('err.shortPw'));
    if (b.new === b.old) throw httpErr(400, t('err.samePw'));
    Object.assign(me, hashPw(b.new), { mustChange: false }); store.save();
    dropLogins(me.id, w.key);
    audit({ user: me.id, verb: 'password', subject: me.name, result: 'ran' });
    return send(res, 200, { ok: true, user: selfUser(me) });
  }
  if (p === '/api/lang' && req.method === 'POST') {
    const b = await body(req);
    if (!normLang(b.lang)) throw httpErr(400, t('err.badLang'));
    me.lang = b.lang; store.save();
    return send(res, 200, { ok: true, user: selfUser(me) });
  }
  if (await admin(me, req, res, url, { body, send })) return;

  if (p === '/api/projects') {
    const list = await mine();
    for (const pr of list) for (const s of pr.sessions) s.owner = state.owners[key(pr.name, s.name)] || null;
    return send(res, 200, { projects: list });
  }
  if (p === '/api/grid') {
    const project = q(url, 'project');
    guard(project, 'read');
    const g = await fleet.grid(project);
    for (const c of g.cards || []) { c.owner = state.owners[key(project, c.name)] || null; c.here = here(project, c.name); }
    return send(res, 200, g);
  }
  if (p === '/api/session') {
    const project = q(url, 'project'), s = q(url, 'session');
    guard(project, 'read');
    const [msgs, queued] = await Promise.all([fleet.session(project, s, q(url, 'before')), fleet.queue(project, s).catch(() => [])]);
    // The transcript says a person typed it, not which one; the activity log does.
    const sent = activity(3000).filter(r => r.project === project && r.result === 'ran' && r.args?.prompt
      && ((r.verb === 'fleet_spawn' && r.subject === s) || (['fleet_send', 'fleet_resume'].includes(r.verb) && r.subject === s)));
    const head = (t) => String(t || '').trim().slice(0, 200);
    for (const m of msgs.messages || []) {
      if (m.role !== 'user') continue;
      const hit = sent.find(r => head(r.args.prompt) && head(m.text).startsWith(head(r.args.prompt).slice(0, 120)));
      if (hit) m.by = hit.user;
    }
    return send(res, 200, { ...msgs, queued, owner: state.owners[key(project, s)] || null, here: here(project, s) });
  }
  if (p === '/api/pane') {
    const project = q(url, 'project'), s = q(url, 'session');
    guard(project, 'read');
    seen(project, s, me.id, false);
    return send(res, 200, { ...(await fleet.pane(project, s)), here: here(project, s) });
  }
  if (p === '/api/presence' && req.method === 'POST') {
    const b = await body(req);
    guard(String(b.project || ''), 'read');
    if (b.session) seen(String(b.project), String(b.session), me.id, b.typing);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/assign' && req.method === 'POST') {
    const b = await body(req);
    guard(String(b.project || ''), 'assign');
    const k = key(b.project, b.session);
    if (b.owner && !can(userById(b.owner), String(b.project), 'read')) throw httpErr(400, t('err.personNoAccess', { who: b.owner, project: b.project }));
    if (b.owner) state.owners[k] = b.owner; else delete state.owners[k];
    saveState();
    audit({ user: me.id, verb: 'assign', project: b.project, subject: b.session, args: { owner: b.owner || null }, result: 'ran' });
    return send(res, 200, { ok: true });
  }
  // A row about a project is seen by whoever can read the project; one about none (a login, an
  // account change) only by an admin and by the person it is about.
  if (p === '/api/activity') {
    const rows = activity(Number(q(url, 'limit')) || 200)
      .filter(r => (r.project ? can(me, r.project, 'read') : isAdmin(me) || r.user === me.id))
      .map(r => (r.output && typeof r.output === 'object' ? { ...r, output: render(r.output) } : r));
    return send(res, 200, { rows });
  }

  if (p === '/api/usage') {
    if (!isAdmin(me) && !Object.keys(me.projects || {}).some(p => can(me, p, 'prompt')))
      throw httpErr(404, t('err.noPath', { path: p }));
    return send(res, 200, fleet.usage());
  }
  if (p.startsWith('/api/admin/usage')) return send(res, 200, await usage.route(req, p, me, body));
  if (p === '/api/voice') return send(res, 200, voice.status());
  if (p === '/api/voices') return send(res, 200, voice.voices());
  if ((p === '/api/voices/install' || p === '/api/voices/delete') && req.method === 'POST') {
    if (!isAdmin(me)) throw httpErr(404, t('err.noPath', { path: p }));
    const b = await body(req);
    const del = p.endsWith('delete');
    const r = del ? piper.remove(String(b.key || '')) : piper.install(String(b.key || ''));
    if (r.error) throw httpErr(400, r.error);
    audit({ user: me.id, verb: del ? 'voice_delete' : 'voice_install', subject: String(b.key), result: 'ran' });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lead' && req.method === 'POST') {
    const b = await body(req);
    guard(String(b.project || ''), 'prompt');
    const r = await fleet.ensureLead(String(b.project || ''));
    if (r.started) audit({ user: me.id, verb: `lead_${r.started}`, project: b.project, subject: 'master', result: r.ok ? 'ran' : 'refused', output: r.text || '' });
    return send(res, r.ok ? 200 : 502, r);
  }
  // What was said to the assistant: split into tasks and given a place. Sent by the page, one by
  // one, like any other send; tasks.mjs follows them from there.
  if (p === '/api/route' && req.method === 'POST') {
    const b = await body(req);
    const text = String(b.text || '').trim();
    if (!text) throw httpErr(400, t('err.nothingToSend'));
    let notes = '';
    try { notes = fs.readFileSync(file('router-notes.md'), 'utf8').slice(0, 4000).trim(); } catch {}
    const r = await router.route({ text, feed: Array.isArray(b.feed) ? b.feed : [], open: tasks.open(me.id), page: b.page, user: me, projects: await fleet.projects(), notes });
    if (r.action === 'tasks') r.tasks = r.tasks.map(t => (t.pending && t.project ? tasks.settle(me.id, t.pending, t) : tasks.add(me.id, { ...t, voice: b.voice })) || t);
    for (const t of r.tasks || [{ ...r }])
      audit({ user: me.id, verb: 'route', project: t.project, subject: t.session || (t.project ? 'master' : ''), result: t.project ? r.action : 'ask',
              output: `${t.title ? `${t.title} · ` : ''}${t.why || r.why || ''}`.slice(0, 200), args: { text: text.slice(0, 300) } });
    return send(res, 200, r);
  }
  if (p === '/api/tasks') return send(res, 200, { tasks: tasks.open(me.id).filter(t => !t.project || can(me, t.project, 'read')) });
  if (p === '/api/tasks/sent' && req.method === 'POST') {
    const b = await body(req);
    return send(res, 200, { ok: !!tasks.sent(me.id, String(b.id), b) });
  }
  if (p === '/api/tasks/place' && req.method === 'POST') {
    const b = await body(req);
    guard(String(b.project || ''), 'read');
    const task = tasks.settle(me.id, String(b.id), { project: String(b.project || '') });
    if (!task) throw httpErr(404, t('err.taskGone'));
    return send(res, 200, task);
  }
  if (p === '/api/tasks/done' && req.method === 'POST') {
    const b = await body(req);
    tasks.done(me.id, b.id ? String(b.id) : '');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/hear' && req.method === 'POST') {
    const wav = await rawBody(req, 8 * 1048576);
    let words = [];
    try { words = (await mine()).flatMap(pr => [pr.name, ...pr.sessions.map(x => x.name)]); } catch {}
    const t0 = Date.now();
    const r = await voice.hear(wav, [...new Set(words)]);
    console.log(new Date().toISOString().slice(11, 19), `hear: ${Math.round(wav.length / 1024)} KB in ${Date.now() - t0} ms`);
    if (r.error) return send(res, 502, { ok: false, text: r.error });
    return send(res, 200, { ok: true, text: r.text, ms: Date.now() - t0 });
  }
  // A file for a session: the raw bytes in the body, where it goes in the query. It is saved
  // and its path handed back; the message that names it is an ordinary fleet_send.
  if (p === '/api/attach' && req.method === 'POST') {
    const project = q(url, 'project'), session = q(url, 'session'), name = q(url, 'name');
    if (!project) throw httpErr(400, t('err.noProjectArg'));
    guard(project, 'prompt');
    if (!SESSION_OK.test(session)) throw httpErr(400, t('err.badSession', { session: session.slice(0, 60) }));
    const buf = await rawBody(req, ATTACH_MAX_BYTES, t('err.theFile'));
    const r = fleet.attach(project, session, name, buf);
    audit({ user: me.id, verb: 'attach', project, subject: session, result: 'ran', output: `${r.name} (${Math.round(r.size / 1024)} KB)` });
    return send(res, 200, r);
  }
  if (p === '/api/speak' && req.method === 'POST') {
    const b = await body(req);
    const r = voice.plan(b.text, b.more === true, b.voice);
    return r.error ? send(res, 503, { ok: false, text: r.error }) : send(res, 200, { ok: true, ...r });
  }
  if (p.startsWith('/api/speak/') && req.method === 'GET') {
    const r = await voice.audio(p.slice('/api/speak/'.length));
    if (r.error) return send(res, r.status || 500, { ok: false, text: r.error });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=3600', 'Content-Length': r.wav.length });
    return res.end(r.wav);
  }

  if (p === '/api/act' && req.method === 'POST') {
    const b = await body(req);
    const r = await perform(me.id, String(b.tool || ''), b.args, { confirm: b.confirm === true, owner: b.owner });
    return send(res, r.changed ? 409 : r.ok ? 200 : 400, r);
  }

  if (p === '/api/automations' && req.method === 'GET') return send(res, 200, await autos.view(me));
  if (p === '/api/automations' && req.method === 'POST') {
    const b = await body(req);
    for (const n of automationProjects(b.automation)) guard(n, 'read');
    const a = autos.upsert(me, b.automation);
    audit({ user: me.id, verb: 'auto_save', subject: a.name, result: 'ran', output: `${describeTrigger(a.trigger)} · ${t('act.steps', { n: a.steps.length })}${a.enabled ? '' : ` · ${t('act.off')}`}` });
    return send(res, 200, { ok: true, automation: a });
  }
  if (p === '/api/automations/delete' && req.method === 'POST') {
    const b = await body(req);
    const a = autos.remove(me, String(b.id || ''));
    audit({ user: me.id, verb: 'auto_delete', subject: a.name, result: 'ran' });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/automations/run' && req.method === 'POST') {
    const b = await body(req);
    const r = await autos.runNow(me, String(b.id || ''));
    return send(res, 200, { ok: r.ok, text: r.text || (r.ok ? t('auto.ran') : t('auto.failed')), steps: r.steps || [] });
  }
  if (p === '/api/automations/ai' && req.method === 'POST') {
    const b = await body(req);
    const messages = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && m.text).map(m => ({ role: m.role === 'ai' ? 'ai' : 'user', text: String(m.text) }));
    if (!messages.length) throw httpErr(400, t('err.aiEmpty'));
    let projects = [];
    try { projects = await mine(); } catch {}
    const nowText = new Date().toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const r = await askAI({ messages, draft: b.draft || null, projects, nowText });
    return send(res, r.ok ? 200 : 502, r);
  }
  if (p === '/api/admin/ai') {
    if (!isAdmin(me)) throw httpErr(404, t('err.noPath', { path: p }));
    return send(res, 200, req.method === 'POST' ? await aiAccount.act(me, await body(req)) : await aiAccount.view());
  }
  if (p === '/api/demo/reset' && req.method === 'POST' && MODE === 'demo' && isAdmin(me)) {
    fleet.reset(); seedDemoOwners();
    return send(res, 200, { ok: true });
  }
  throw httpErr(404, t('err.noPath', { path: p }));
}

const usage = createUsage({ dir: DATA, mode: MODE, fleet, activity, owners: () => state.owners, users: () => store.list, saveUsers: () => store.save(),
                           settings: () => readJson('settings.json', {}), audit });
// Automations run as the person who made them, through perform() like any click.
const canRead = (userId, project) => can(userById(userId), project, 'read');
const tasks = createTasks({ fleet, readJson, writeJson, canRead });
tasks.start();
const autos = createEngine({ fleet, readJson, writeJson, appendLine, readLines, perform, users: () => store.list, can,
  telegram: MODE === 'real' ? (text) => fleet.act('fleet_telegram_send', { text }) : null });
autos.start();
const admin = createAdmin({ store, fleet, audit, dropLogins, httpErr });
const cfgFor = MODE === 'demo' ? null : (await import(pathToFileURL(path.join(GF_HOME, 'lib', 'projects.mjs')).href)).cfgFor;
const aiAccount = createAiAccount({ dir: DATA, demo: MODE === 'demo', profiles: profilesOf(fleet, cfgFor), readJson, writeJson, audit });

// Installations from before roles (§2), once: it needs the projects that exist now, so it waits
// for the fleet to answer rather than migrate everyone onto an empty list.
async function migrateRoles() {
  if (!store.list.some(u => !u.role)) return;
  let names;
  try { names = (await fleet.projects()).map(p => p.name); }
  catch (e) { console.log(`roles: could not read the projects (${e.message}); retrying in 30 s`); return setTimeout(migrateRoles, 30000).unref(); }
  if (migrate(store.list, names)) {
    store.save();
    audit({ user: store.list[0].id, verb: 'migrate_roles', subject: `${store.list.length} cuenta(s)`, result: 'ran', output: `admin: ${store.list[0].name}; member en ${names.length} proyecto(s)` });
    console.log(`roles: ${store.list[0].name} is now admin; everyone else, member of ${names.length} project(s)`);
  }
}
await migrateRoles();

const server = http.createServer((req, res) => inRequest(req, async () => {
  if (!req.headers.host) return send(res, 400, { ok: false, text: t('err.missingHost') });
  if (!HOSTS.has(hostName(req.headers.host)))
    return send(res, 403, { ok: false, text: t('err.host', { host: req.headers.host, hosts: [...HOSTS].join(', ') }) });
  // Everything a request can throw stays in this try: the handler is async, so an escape
  // is an unhandled rejection, and that ends the process — one `GET /%E0%A4%A` used to
  // take the fleet's web down for everyone (decodeURIComponent in serveStatic).
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    await route(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { ok: false, text: e.message || t('err.internal') });
    if (!e.status) console.error(e);
  }
}));
server.listen(PORT, BIND, () => {
  const origin = `http://${BIND.includes(':') ? `[${BIND}]` : BIND}:${PORT}`;
  console.log(`ghostfleet team · ${MODE === 'demo' ? 'DEMO mode (sample data)' : 'REAL mode (your fleet)'}`);
  console.log(`  ${origin}`);
  console.log(`  data: ${DATA}`);
  if (!store.list.length) console.log(`  no accounts yet: node server/admin-cli.mjs create-admin <name>${MODE === 'demo' ? ' --demo' : ''}`);
});
