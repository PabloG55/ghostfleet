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
//   GET  /api/checkouts?project=<name>          -> { roots, checkouts }
//   GET  /api/settings?project=<name>           -> { global_nudge, sessions: { name: on|off|inherit } }
//   POST /api/verb   { tool, args }             -> { ok, text }        (Bearer token required)
//   GET  /api/auth/challenge                    -> { challenge, rp_id, user }
//   POST /api/auth/register | /api/auth/assert  -> { token, expires_at }
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
  base: 'gf.base',          // fleet-serve origin; empty string = fixtures
  fixture: 'gf.fixture',    // which grid fixture the fixture backend serves
};

// Verbs that take a second passkey assertion at the moment of action (§7).
export const DESTRUCTIVE = new Set(['fleet_spawn', 'fleet_stop', 'fleet_rename']);

// ── configuration ─────────────────────────────────────────────────────────
export function baseUrl() { try { return localStorage.getItem(LS.base) || ''; } catch { return ''; } }
export function setBaseUrl(u) { try { localStorage.setItem(LS.base, (u || '').replace(/\/+$/, '')); } catch {} }
export function mode() { return baseUrl() ? 'server' : 'fixtures'; }

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
  if (mode() === 'server') {
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
  if (mode() === 'server') return get(`/api/grid?project=${encodeURIComponent(project || '')}`);
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
  if (mode() === 'server') return get(`/api/checkouts?project=${encodeURIComponent(project || '')}`);
  return fixture('checkouts.json');
}

// The per-session auto-nudge state. Deliberately NOT bolted onto §4: that schema is
// "exactly what cardLines() consumes" and this is not one of those fields, so it gets
// its own read rather than widening the one the whole design leans on.
export async function getSettings(project) {
  if (mode() === 'server') return get(`/api/settings?project=${encodeURIComponent(project || '')}`);
  try { return await fixture(`settings-${project}.json`); }
  catch { return { global_nudge: false, sessions: {} }; }
}

// 20 messages and an explicit "load more" (§11.3). The bound is about not pulling 46 MB
// down a tunnel on cellular — it is a performance decision, not a security control, and
// the content itself is served unredacted.
export const PAGE = 20;
export async function getSession(project, session, before = null) {
  if (mode() === 'server') {
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

// ── auth (the passkey's three requests) ───────────────────────────────────
// Here rather than in passkey.js so that "only api.js talks to the network" is true
// without an exception — an exception is how a second base URL gets introduced, and
// then the app is half-pointed at the server and half at nothing.
export async function authChallenge() {
  const r = await fetch(baseUrl() + '/api/auth/challenge', { cache: 'no-store' });
  if (!r.ok) throw new Error(`challenge → HTTP ${r.status}`);
  return r.json();
}
export async function authPost(kind, body) {     // kind: 'register' | 'assert'
  const r = await fetch(`${baseUrl()}/api/auth/${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${kind} → HTTP ${r.status}`);
  const j = await r.json();
  setToken(j.token, j.expires_at);
  return j;
}

// ── writes ────────────────────────────────────────────────────────────────
// `assertion` is the fresh WebAuthn assertion for a destructive verb. It is passed
// through to the server, which is what decides whether it counts.
export async function verb(tool, args, assertion = null) {
  if (mode() === 'server') {
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
    const left = new Map(cards.map(c => [c.name, c]));
    const out = [];
    for (const n of overlay.order) { const c = left.get(n); if (c) { out.push(c); left.delete(n); } }
    for (const c of cards) if (left.has(c.name)) out.push(c);
    cards = out;
  }
  const free = (g.free_worktrees || []).filter(w => !overlay.freeGone.has(w.path));
  return { ...g, cards, free_worktrees: free };
}
function fixtureVerb(tool, a) {
  const ok = text => ({ ok: true, text });
  switch (tool) {
    case 'fleet_pause':  overlay.status.set(a.session, 'parked'); return ok(`parked '${a.session}'`);
    case 'fleet_resume': overlay.status.set(a.session, a.prompt ? 'working' : 'ready'); return ok(`resumed '${a.session}'`);
    case 'fleet_send':   overlay.status.set(a.session, 'working'); return ok(`sent to '${a.session}'`);
    case 'fleet_answer': overlay.status.set(a.session, 'working'); return ok(`answered '${a.session}'`);
    case 'fleet_stop':
      overlay.gone.add(a.session);
      // reclaim also removes the worktree — and fleet-clean's gates decide whether that
      // is SAFE, not whether it was intended. The fixture refuses the one worktree whose
      // branch is not merged, so the `f = remove anyway` step has something to refuse.
      return ok(a.reclaim ? `stopped '${a.session}' and removed its worktree` : `stopped '${a.session}'`);
    case 'fleet_rename': {
      const st = overlay.status.get(a.session);
      overlay.gone.add(a.session);
      overlay.added.push({ name: a.new_name, label: null, status: st || 'ready', folder: a.new_name,
                           branch: a.new_name, agent: 'claude', msg: '', age: 0, attached: false,
                           sched: null, limit_at: null });
      return ok(`renamed '${a.session}' → '${a.new_name}'`);
    }
    case 'fleet_spawn':
      if (a.reuse) overlay.freeGone.add(a.reuse);
      overlay.added.push({ name: a.name, label: null, status: 'starting', folder: a.name,
                           branch: a.branch || a.name, agent: a.agent || 'claude', msg: '', age: null,
                           attached: false, sched: null, limit_at: null });
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
