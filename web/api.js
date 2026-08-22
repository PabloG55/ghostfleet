// web/api.js — the only file that knows where the fleet lives.
//
// The client is built against FIXTURES, so it can be finished and reviewed before
// fleet-serve exists (docs/mobile.md §3). Pointing it at the real daemon is meant to be
// a URL change and nothing else, which only stays true if every request in the app goes
// through this file. Nothing else in web/ may call fetch().
//
// ── the contract fleet-serve has to meet ──────────────────────────────────
//   GET  /api/projects                          -> { home, projects: [ … ] }
//   GET  /api/grid?project=<name>               -> docs/mobile.md §4, verbatim
//   GET  /api/session?project=&session=&limit=20[&before=<ts>]
//                                               -> { session, total, messages: [ {ts,role,text} ], note? }
//   GET  /api/pane?project=&session=[&scrollback=N]
//                                               -> { session, rows?, cols?, at, pane: "<SGR text>" }
//   GET  /api/checkouts?project=<name>          -> { roots, checkouts }
//   GET  /api/settings?project=<name>           -> { global_nudge, sessions: { name: on|off|inherit } }
//   POST /api/verb   { tool, args }             -> { ok, text }        (Bearer token required)
//   GET  /api/auth/challenge                    -> { challenge, rp_id, user, enrolling }
//   POST /api/auth/register { code, … }         -> { token, expires_at }
//   POST /api/auth/assert                       -> { token, expires_at }
//
// `code` on register is the one-time code `fleet-serve enroll <client-id>` printed, and it
// is NOT optional: the server refuses a registration that no window and no code
// authorised, because the endpoint is remote code execution and trust-on-first-use loses
// to whoever wins the race to be first. The contract used to omit it and the client never
// sent one, so every enrolment was a 403 and the phone could not get in at all.
//
// `tool` is the MCP tool name, unchanged — fleet_list, fleet_send, fleet_read,
// fleet_spawn, fleet_worktrees, fleet_inbox, fleet_answer, fleet_pause, fleet_resume,
// fleet_stop, fleet_rename, fleet_project_add, fleet_projects — so the server dispatches
// through the handlers it already has (§2) instead of growing a second verb vocabulary.
// Seven more are things the GRID does by writing a marker file or calling a sibling
// script, which have no MCP tool today: fleet_schedule, fleet_label, fleet_nudge,
// fleet_budget, fleet_order, fleet_project_order, fleet_project_remove, and
// fleet_worktree_remove for the `x` on a FREE card. They are named the same way, listed
// in web/README.md, and they are the only additions this client asks for.
//
// ── and the one rule about that contract ──────────────────────────────────
// The DESTRUCTIVE list below is a UI affordance — it decides which taps ask for a
// fingerprint. It is not the enforcement. §7: enforcement is server-side on the tool
// name, because a client-side restriction is a suggestion, and `curl` does not run this
// file. Anything added here has to be added there too, and the server is the half that
// matters.

import { setHome } from './grid.js';

const LS = {
  base: 'gf.base',          // absent = ask this page's own origin; see pref()
  fixture: 'gf.fixture',    // which grid fixture the fixture backend serves
};

// Verbs that take a second passkey assertion at the moment of action (§7).
export const DESTRUCTIVE = new Set(['fleet_spawn', 'fleet_stop', 'fleet_rename']);

// ── which backend, and how we know ────────────────────────────────────────
// `gf.base` was one string with two meanings — a URL, or '' for fixtures — and nothing
// ever set it. So the client that fleet-serve ITSELF serves defaulted to fixtures: a
// phone opening the daemon's own URL over the tailnet was shown four projects that do
// not exist on this machine, offered a local-only passkey with no enrolment prompt, and
// never made one request — which is why `fleet-serve clients` said "(no clients
// enrolled)" and nothing anywhere said why. Both halves did what they were told; nobody
// wired the default.
//
// Three states now, and the third is the one that was missing:
//
//   absent / ''    ask the origin this page came from whether a fleet is behind it
//   'fixtures'     fixtures because someone chose them — the escape hatch for demoing
//                  the client while the daemon is the thing serving it
//   a URL          that origin, wherever the page itself came from
//
// "Unset" and "chosen" HAVE to be different values. While they were the same one, the
// only safe reading of unset was the wrong one. A URL cannot collide with the sentinel:
// every base has a scheme.
const FORCED_FIXTURES = 'fixtures';

// WHERE THE PROBE ASKS — a route the server really has, and that is the whole care in
// this constant. Every path under /api/ answers 401 today because the token gate runs
// before the routing table, so a probe at an invented path (/api/cards, say) looks like
// it works — right until the gate moves and the invented path starts 404ing, which this
// file reads as "no server" and answers with fixtures. That is this same bug, one
// release later. test/helpers/pwa-check.mjs asserts the path against fleet-serve's own
// routing table, and asserts it is NOT in that server's OPEN set, because a 401 is the
// signal being relied on.
export const PROBE_PATH = '/api/health';
const PROBE_TIMEOUT = 4000;

// ── configuration ─────────────────────────────────────────────────────────
// pref() is what is STORED; resolution() is what we are actually talking to. They are
// only the same thing once an explicit setting exists.
export function pref() {
  let v = '';
  try { v = (localStorage.getItem(LS.base) || '').trim(); } catch {}
  if (!v) return { kind: 'auto' };
  if (v === FORCED_FIXTURES) return { kind: 'fixtures' };
  return { kind: 'server', base: v.replace(/\/+$/, '') };
}
let resolved = null;      // { mode, base, source, detail } — decided once per load
let resolving = null;     // the in-flight probe, so ten callers make one request
function store(v) {
  try { if (v) localStorage.setItem(LS.base, v); else localStorage.removeItem(LS.base); } catch {}
  resolved = null; resolving = null;        // a different backend is a different answer
}
export function setBaseUrl(u) { store(String(u || '').trim().replace(/\/+$/, '')); }
export function useFixtures() { store(FORCED_FIXTURES); }
export function useAutoDetect() { store(''); }

// The origin to ask. file:// gives 'null' for location.origin and has no API behind it,
// so it is not asked at all rather than probed and reported as a failure.
function pageOrigin() {
  if (typeof location === 'undefined' || !location) return '';
  if (!/^https?:$/.test(location.protocol || '')) return '';
  return String(location.origin || '').replace(/\/+$/, '');
}

// THE SIGNAL. A 401 is proof of success, and a stronger one than a 200: it says the
// endpoint exists AND that auth is enforced there (§5). A 200 is the weaker case — at
// first run nothing is enrolled, so there is no authenticated call to make, and
// demanding one would put the client back in fixtures on the very machine it is served
// from. So: any structured answer from the API means the API is there.
//
// The other side of it is what must NOT count. A static server (`python3 -m
// http.server`, how this client gets reviewed) 404s. One with an SPA fallback answers
// 200 text/html, which is the trap — a body arrives, the status is fine, and only the
// content type says it is a page and not an answer. And some *other* JSON service on
// that port is not this one, so the body has to look like fleet-serve's envelope.
export function probeVerdict(r) {
  if (!r || !r.status) return 'fixtures';                                  // never answered
  if (r.status === 404) return 'fixtures';                                 // a server, but not this one
  if (!/^application\/json\b/i.test(r.contentType || '')) return 'fixtures';
  const b = r.body;
  if (!b || typeof b !== 'object') return 'fixtures';
  return ('ok' in b || 'needs' in b || 'error' in b || 'version' in b) ? 'server' : 'fixtures';
}

async function probeFetch(url) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => { if (ctl) ctl.abort(); }, PROBE_TIMEOUT);
  try {
    const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' },
                                 signal: ctl ? ctl.signal : undefined });
    const contentType = r.headers.get('content-type') || '';
    let body = null;
    if (/json/i.test(contentType)) { try { body = await r.json(); } catch {} }
    return { status: r.status, contentType, body };
  } finally { clearTimeout(t); }
}

const fixturesBecause = (detail) => ({ mode: 'fixtures', base: '', source: 'probe', detail });
async function detect(origin) {
  if (!origin) return fixturesBecause('fixtures — this page has no http(s) origin to ask');
  let r;
  try { r = await probeFetch(origin + PROBE_PATH); }
  catch (e) { return fixturesBecause(`fixtures — nothing answered ${origin}${PROBE_PATH} (${String((e && e.message) || e)})`); }
  if (probeVerdict(r) === 'server')
    return { mode: 'server', base: origin, source: 'probe',
             detail: r.status === 401
               ? `${origin} — served this app, and its API asked for a passkey (401), which is the server enforcing §5`
               : `${origin} — served this app, and its API answered (${r.status})` };
  return fixturesBecause(`fixtures — ${origin} serves this app but no fleet is behind it `
    + `(${PROBE_PATH} → ${r.status} ${(r.contentType || 'no content-type').split(';')[0]})`);
}

// Synchronous, for the renderer: an explicit setting is known without asking anybody,
// and only the auto case has to wait. 'probing' is a real third mode rather than an
// optimistic 'fixtures' — guessing fixtures for a few hundred milliseconds is how the
// screens end up drawing sample data on a real fleet, which is the bug.
export function resolution() {
  if (resolved) return resolved;
  const p = pref();
  if (p.kind === 'fixtures') return { mode: 'fixtures', base: '', source: 'setting', detail: 'fixtures — chosen in settings' };
  if (p.kind === 'server') return { mode: 'server', base: p.base, source: 'setting', detail: `${p.base} — set in settings` };
  const o = pageOrigin();
  return { mode: 'probing', base: '', source: 'probe',
           detail: o ? `looking for a fleet at ${o}…` : 'looking for a fleet…' };
}
export function mode() { return resolution().mode; }
export function baseUrl() { return resolution().base; }
// The short form for the header, so every screen can say which fleet it is showing.
export function modeLabel() {
  const r = resolution();
  if (r.mode === 'server') return r.base.replace(/^https?:\/\//, '');
  return r.mode === 'probing' ? 'looking for a fleet…' : 'fixtures';
}
// Awaited by every call below, so no request can be made before it is known where
// requests go. Memoised: the probe happens once per load.
export async function ready() {
  if (resolved) return resolved;
  if (pref().kind !== 'auto') { resolved = resolution(); return resolved; }
  if (!resolving) resolving = detect(pageOrigin()).then(r => { resolved = r; resolving = null; return r; });
  return resolving;
}
// For "the daemon started after I opened this page", and for the suite.
export function reprobe() { resolved = null; resolving = null; return ready(); }

// The fixture backend's whole routing table. `project` is the payload's own project
// field, so tapping a project on the Projects screen lands on that project's fixture —
// and the two superkey fixtures are two states of one fleet, chosen in settings.
export const FIXTURES = [
  { file: 'grid-superkey.json', project: 'superkey',   title: 'superkey — a busy fleet' },
  { file: 'grid-degraded.json', project: 'superkey',   title: 'superkey — unknown · limit · interrupted · parked' },
  { file: 'grid-free.json',     project: 'ghostfleet', title: 'ghostfleet — free worktrees' },
  { file: 'grid-empty.json',    project: 'dotfiles',   title: 'dotfiles — nothing running' },
];
export function fixtureName() {
  try { return localStorage.getItem(LS.fixture) || FIXTURES[0].file; } catch { return FIXTURES[0].file; }
}
export function setFixtureName(f) { try { localStorage.setItem(LS.fixture, f); } catch {} }

// ── the session token (§5) ────────────────────────────────────────────────
// Deliberately NOT in localStorage. A token that outlives the tab outlives the lock,
// and the whole point of the passkey is that a phone in someone else's hand is not the
// same as a phone plus its owner. Held in a module variable: a reload re-asserts.
let token = null, tokenExp = 0;
export function setToken(t, expiresAt) { token = t || null; tokenExp = expiresAt || 0; }
export function haveToken() { return !!token && Date.now() / 1000 < tokenExp; }
export function clearToken() { token = null; tokenExp = 0; }

// ── the audit trail (§7) ──────────────────────────────────────────────────
// Every mutating call is recorded. On a server the row is the server's, surfaced as a
// fleet-inbox entry; here it is what makes the fixture mode honest — you can see
// exactly what the app would have asked the fleet to do.
const audit = [];
export function auditLog() { return audit.slice().reverse(); }
function record(tool, args, result) {
  audit.push({ at: Date.now() / 1000, tool, args, result });
  if (audit.length > 200) audit.shift();
}

// ── plumbing ──────────────────────────────────────────────────────────────
export class AuthError extends Error {}
export class OfflineError extends Error {}

async function get(pathAndQuery) {
  const url = baseUrl() + pathAndQuery;
  let r;
  try {
    r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  } catch (e) { throw new OfflineError(String(e && e.message || e)); }
  if (r.status === 401 || r.status === 403) { clearToken(); throw new AuthError('the server rejected the session token'); }
  if (!r.ok) throw new Error(`${pathAndQuery} → HTTP ${r.status}`);
  return r.json();
}

// The fixture backend. Same shapes, same pagination, no server: the screens cannot tell
// which one answered them, which is the property that makes this worth doing.
async function fixture(file) {
  const r = await fetch(`./fixtures/${file}`, { cache: 'no-store' });
  if (!r.ok) throw new OfflineError(`fixture ${file} is not available`);
  return r.json();
}

// ── reads ─────────────────────────────────────────────────────────────────
export async function getProjects() {
  if ((await ready()).mode === 'server') {
    const j = await get('/api/projects');
    setHome(j.home || '');
    return j;
  }
  const j = await fixture('projects.json');
  setHome(j.home || '');
  // In fixture mode the per-project rollup is DERIVED from the grid fixture that
  // project opens, not read from projects.json. Two reasons: the numbers cannot drift
  // out of step with the cards you land on, and switching to the degraded fixture in
  // settings correctly turns superkey's card red — the projects screen's whole job is
  // to say which project needs you, so a hardcoded 0 there would be the one lie this
  // screen must not tell. On a server the daemon computes it from sessionStatuses,
  // which is where the `sessions` field in the fixture comes from.
  const projects = [];
  for (const p of j.projects || []) projects.push({ ...p, sessions: await rollup(p.name) });
  return { ...j, projects };
}
async function rollup(project) {
  let g; try { g = await getGrid(project); } catch { return { need: 0, working: 0, parked: 0, total: 0 }; }
  const cards = g.cards || [];
  return {
    need: cards.filter(c => c.status === 'need-you').length,
    working: cards.filter(c => c.status === 'working').length,
    parked: cards.filter(c => c.status === 'parked').length,
    total: cards.length,
  };
}

// §4's payload, whichever end it came from. `overlay` replays the verbs performed in
// fixture mode so a pause you just asked for is visible on the card — on a server the
// fleet itself is the one that changes and there is nothing to replay.
export async function getGrid(project) {
  if ((await ready()).mode === 'server') return get(`/api/grid?project=${encodeURIComponent(project || '')}`);
  const chosen = FIXTURES.find(f => f.file === fixtureName());
  // The fixture picked in settings wins when it belongs to the project you opened;
  // otherwise the first fixture for that project. A project with no fixture gets the
  // empty one rather than the wrong fleet's cards, which would be a lie with a name on
  // it — the same reason fleet-read refuses to fall back to another session's transcript.
  const use = (chosen && chosen.project === project) ? chosen
            : FIXTURES.find(f => f.project === project)
            || FIXTURES.find(f => f.file === 'grid-empty.json');
  const g = await fixture(use.file);
  // The project you opened is the project the header names, even when the payload came
  // from the shared empty fixture. A screen headed by another fleet's name is exactly
  // the confusion §4 is trying to prevent.
  return applyOverlay(project ? { ...g, project } : g);
}

// The checkouts the `n` (new session) picker offers. The phone has no filesystem of its
// own, so this is a read the daemon has to answer — it is the TUI's discoverCheckouts()
// over CLAUDE_FLEET_ROOT / ~/.config/ghostfleet/checkouts, not something the client can
// guess.
export async function getCheckouts(project) {
  if ((await ready()).mode === 'server') return get(`/api/checkouts?project=${encodeURIComponent(project || '')}`);
  return fixture('checkouts.json');
}

// The per-session auto-nudge state. Deliberately NOT bolted onto §4: that schema is
// "exactly what cardLines() consumes" and this is not one of those fields, so it gets
// its own read rather than widening the one the whole design leans on.
export async function getSettings(project) {
  if ((await ready()).mode === 'server') return get(`/api/settings?project=${encodeURIComponent(project || '')}`);
  try { return await fixture(`settings-${project}.json`); }
  catch { return { global_nudge: false, sessions: {} }; }
}

// 20 messages and an explicit "load more" (§11.3). The bound is about not pulling 46 MB
// down a tunnel on cellular — it is a performance decision, not a security control, and
// the content itself is served unredacted.
export const PAGE = 20;
export async function getSession(project, session, before = null) {
  if ((await ready()).mode === 'server') {
    const q = `/api/session?project=${encodeURIComponent(project || '')}&session=${encodeURIComponent(session)}` +
              `&limit=${PAGE}` + (before ? `&before=${encodeURIComponent(before)}` : '');
    return get(q);
  }
  // Fixture mode paginates locally over the whole file, so the client walks the same
  // cursor path it will walk against the server.
  let all;
  try { all = await fixture(`session-${project}-${session}.json`); }
  catch {
    // fleet-read's own answer for a session that exists but has not taken a turn. Not
    // an empty screen: "no messages" and "no transcript yet" are different facts.
    return { session, total: 0, messages: [], next_before: null,
             note: `no transcript for '${session}' yet — it hasn't taken a turn.` };
  }
  const msgs = all.messages || [];
  const upTo = before == null ? msgs.length : msgs.findIndex(m => String(m.ts) === String(before));
  const end = upTo < 0 ? msgs.length : upTo;
  const start = Math.max(0, end - PAGE);
  return { ...all, messages: msgs.slice(start, end), next_before: start > 0 ? String(msgs[start].ts) : null };
}

// The session's real pane — `capture-pane -p -e`, escapes and all.
//
// Why this exists next to getSession() rather than instead of it: getSession cannot show
// a command. It goes through `fleet-read --json`, whose payload is {ts, role, text} —
// assistant and user prose — so tool calls, the commands inside them and their results
// are absent from the wire, not merely unrendered. The first person to use this app said
// both halves of that out loud ("it doesn't look like a normal chat and I can't see the
// commands that is running"), and the fix is the one CLAUDE.md already prescribes for
// every other question about a session: read the pane, because THE PANE IS THE TRUTH.
//
// The list stays reachable. It reads better for scrolling back through prose, it is
// paginated over the whole transcript rather than bounded by what is on screen, and the
// pane cannot replace either of those.
export async function getPane(project, session, scrollback = 0) {
  if ((await ready()).mode === 'server') {
    return get(`/api/pane?project=${encodeURIComponent(project || '')}&session=${encodeURIComponent(session)}`
             + (scrollback ? `&scrollback=${scrollback}` : ''));
  }
  // Fixture mode carries a REAL capture — one of a working session mid-turn, one of a
  // live permission dialog — because the thing being checked is a renderer, and a
  // hand-written escape sequence would only prove it can parse what I thought to write.
  try { return await fixture(`pane-${project}-${session}.json`); }
  catch {
    return { session, pane: '', rows: 0, cols: 0,
             note: `no pane captured for '${session}' in fixture mode.` };
  }
}

// ── auth (the passkey's three requests) ───────────────────────────────────
// Here rather than in passkey.js so that "only api.js talks to the network" is true
// without an exception — an exception is how a second base URL gets introduced, and
// then the app is half-pointed at the server and half at nothing.
//
// AND THE SERVER'S OWN WORDS WHEN IT REFUSES. `${kind} → HTTP 403` is what a phone was
// given for twenty minutes: /api/auth/register refuses in two ways, both of them the only
// thing that says what to do next — "no enrolment is open. On the Mac: fleet-serve enroll
// <client-id>" and "wrong or missing enrolment code" — and this file was throwing the
// sentence away and reporting the number. A button that does nothing is what that looks
// like from the phone.
async function authFetch(kind, path, init) {
  let r;
  try { r = await fetch(baseUrl() + path, init); }
  catch (e) { throw new OfflineError(String((e && e.message) || e)); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.text || j.error)) || `${kind} → HTTP ${r.status}`);
  return j;
}
export async function authChallenge() {
  await ready();
  return authFetch('challenge', '/api/auth/challenge', { cache: 'no-store' });
}
export async function authPost(kind, body) {     // kind: 'register' | 'assert'
  await ready();
  const j = await authFetch(kind, `/api/auth/${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  setToken(j.token, j.expires_at);
  return j;
}

// ── writes ────────────────────────────────────────────────────────────────
// `assertion` is the fresh WebAuthn assertion for a destructive verb. It is passed
// through to the server, which is what decides whether it counts.
export async function verb(tool, args, assertion = null) {
  if ((await ready()).mode === 'server') {
    if (!haveToken()) throw new AuthError('no live session token');
    let r;
    try {
      r = await fetch(baseUrl() + '/api/verb', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(assertion ? { 'X-Fleet-Assertion': JSON.stringify(assertion) } : {}),
        },
        body: JSON.stringify({ tool, args }),
      });
    } catch (e) { throw new OfflineError(String(e && e.message || e)); }
    if (r.status === 401 || r.status === 403) { clearToken(); throw new AuthError('the server refused the verb'); }
    const j = await r.json().catch(() => ({ ok: false, text: `HTTP ${r.status}` }));
    record(tool, args, j.ok ? 'ok' : `refused: ${j.text || r.status}`);
    if (!j.ok) throw new Error(j.text || `${tool} failed`);
    return j;
  }
  const res = fixtureVerb(tool, args);
  record(tool, args, res.ok ? 'ok (fixture — recorded, not executed)' : `refused: ${res.text}`);
  if (!res.ok) throw new Error(res.text);
  return res;
}

// ── the fixture backend's idea of a verb ──────────────────────────────────
// Kept as an OVERLAY rather than by editing the fixture in memory, so reloading always
// lands back on the shipped fixture and no test can pass because a previous tap left
// something behind.
const overlay = { status: new Map(), gone: new Set(), sched: new Map(), label: new Map(), added: [], freeGone: new Set(), order: [] };
function applyOverlay(g) {
  let cards = (g.cards || [])
    .filter(c => !overlay.gone.has(c.name))
    .map(c => ({
      ...c,
      status: overlay.status.get(c.name) || c.status,
      sched: overlay.sched.has(c.name) ? overlay.sched.get(c.name) : c.sched,
      label: overlay.label.has(c.name) ? overlay.label.get(c.name) : c.label,
    }));
  for (const c of overlay.added) if (!cards.some(x => x.name === c.name)) cards.push(c);
  // applyOrder(), same rule as the TUI: the names the order file knows, in its order,
  // then anything it has not heard of — a new session appears at the end rather than
  // vanishing because it is not in the list.
  if (overlay.order.length) {
    // The LEAD is pinned first and is not in the order, exactly as gather({lead:true})
    // has it: <sock>.order is written from the TUI's cards, which never include master.
    // Ordering it like a worker here would let the fixture show a layout the real emitter
    // cannot produce.
    const lead = cards.filter(c => c.lead);
    const left = new Map(cards.filter(c => !c.lead).map(c => [c.name, c]));
    const out = [];
    for (const n of overlay.order) { const c = left.get(n); if (c) { out.push(c); left.delete(n); } }
    for (const c of cards) if (left.has(c.name)) out.push(c);
    cards = [...lead, ...out];
  }
  const free = (g.free_worktrees || []).filter(w => !overlay.freeGone.has(w.path));
  return { ...g, cards, free_worktrees: free };
}
function fixtureVerb(tool, a) {
  const ok = text => ({ ok: true, text });
  switch (tool) {
    case 'fleet_pause':
      // The lead is not a worker and the planner refuses it (mcp/fleet-dispatch.mjs); the
      // governor excludes it too. Resume is NOT refused — the recovery direction stays
      // open on both backends.
      if (a.session === 'master')
        return { ok: false, text: "fleet_pause: refusing to park 'master' — it is the fleet's lead, and a fleet whose lead is off dispatches nothing" };
      overlay.status.set(a.session, 'parked'); return ok(`parked '${a.session}'`);
    case 'fleet_resume': overlay.status.set(a.session, a.prompt ? 'working' : 'ready'); return ok(`resumed '${a.session}'`);
    case 'fleet_send':   overlay.status.set(a.session, 'working'); return ok(`sent to '${a.session}'`);
    case 'fleet_answer': overlay.status.set(a.session, 'working'); return ok(`answered '${a.session}'`);
    case 'fleet_stop':
      // The planner refuses the lead before it reaches a command (mcp/fleet-dispatch.mjs),
      // so fixture mode has to refuse it too — this backend stands in for the SERVER, and
      // a demo that cheerfully stops master teaches the opposite of what the daemon does.
      // It compares the NAME because that is what the server compares; the `lead` flag on
      // the card is for the client's own rendering, and nothing here renders.
      if (a.session === 'master')
        return { ok: false, text: "fleet_stop: refusing to stop 'master' — it is the fleet's lead, not a worker" };
      overlay.gone.add(a.session);
      // reclaim also removes the worktree — and fleet-clean's gates decide whether that
      // is SAFE, not whether it was intended. The fixture refuses the one worktree whose
      // branch is not merged, so the `f = remove anyway` step has something to refuse.
      return ok(a.reclaim ? `stopped '${a.session}' and removed its worktree` : `stopped '${a.session}'`);
    case 'fleet_rename': {
      if (a.session === 'master')
        return { ok: false, text: "fleet_rename: refusing to rename 'master' — it is the fleet's lead, not a worker" };
      const st = overlay.status.get(a.session);
      overlay.gone.add(a.session);
      overlay.added.push({ name: a.new_name, label: null, status: st || 'ready', folder: a.new_name,
                           branch: a.new_name, agent: 'claude', msg: '', age: 0, attached: false,
                           sched: null, limit_at: null, lead: false });
      return ok(`renamed '${a.session}' → '${a.new_name}'`);
    }
    case 'fleet_spawn':
      if (a.reuse) overlay.freeGone.add(a.reuse);
      // `lead: false` spelled out, not left off: §4 carries the flag on EVERY card, and a
      // spawned one is the last place you want "is this the lead" to depend on a key that
      // happens to be absent.
      overlay.added.push({ name: a.name, label: null, status: 'starting', folder: a.name,
                           branch: a.branch || a.name, agent: a.agent || 'claude', msg: '', age: null,
                           attached: false, sched: null, limit_at: null, lead: false });
      return ok(`spawned '${a.name}'`);
    case 'fleet_worktree_remove':
      // The refusal path, so the confirmation that follows it is real: only a merged or
      // fully-pushed worktree comes away without --force.
      if (!a.force && !/stack-view/.test(a.path))
        return { ok: false, text: `worktree '${a.path.split('/').pop()}' has unpushed commits on ${a.branch}` };
      overlay.freeGone.add(a.path);
      return ok(`removed worktree '${a.path.split('/').pop()}'`);
    case 'fleet_schedule':
      overlay.sched.set(a.session, a.at ? { at: a.at, msg: a.prompt || 'continue' } : null);
      return ok(a.at ? `scheduled '${a.session}'` : `cleared the schedule on '${a.session}'`);
    case 'fleet_label':
      overlay.label.set(a.session, a.label || null);
      return ok(a.label ? `labelled '${a.session}'` : `cleared the label on '${a.session}'`);
    case 'fleet_order':  overlay.order = (a.order || []).slice(); return ok('card order saved');
    case 'fleet_project_order':  return ok('project order saved');
    case 'fleet_project_remove': return ok(`removed '${a.name}' from the projects list (its sessions and history are untouched)`);
    case 'fleet_project_add':    return ok(`registered '${a.name || a.path}'`);
    case 'fleet_nudge':  return ok(`auto-nudge for '${a.session}' → ${a.state}`);
    case 'fleet_budget': return ok(`budget limit for '${a.project}' → ${a.state}`);
    default: return { ok: false, text: `fixture mode has no handler for ${tool}` };
  }
}
export function resetOverlay() {
  overlay.status.clear(); overlay.gone.clear(); overlay.sched.clear();
  overlay.label.clear(); overlay.freeGone.clear(); overlay.added.length = 0; overlay.order.length = 0;
}
