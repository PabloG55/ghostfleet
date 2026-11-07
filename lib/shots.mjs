// lib/shots.mjs — a fleet-shots run, read and decided: the one copy of what a run IS
// (manifest + verdict → a state), for the command line and for fleet-serve's Reviews routes.
//
// [experimental] behind the `shots` switch. Off, every /api/shots route answers 404 with
// `disabled: true` and the phone draws no Reviews entry — the same shape as Jarvis.
//
// WHY THE RULES LIVE HERE AND NOT IN EITHER CALLER. `fleet-shots --check` is a gate a worker
// is held to, and the phone's Reviews screen is where a human decides whether it passes. If
// the two carried their own copy of "what state is this run in" they would drift, and the
// first symptom would be a card reading `approved` over a run --check still refuses. So
// runState, the verdict's validation and the flag rule are written once, below.
//
// WHERE RUNS COME FROM: every profile's fleet dir, `<cfg>/fleet/shots/<run>/manifest.json`,
// with <cfg> from the projects files (lib/projects.mjs) — the same directories fleet-serve
// already reads statuses from. A run is named by (profile, folder) on this host, and by
// (host, profile, folder) on a paired one — see PAIRED HOSTS above `api` at the bottom.
//
// Node builtins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projects, cfgFor } from './projects.mjs';
import * as X from './experimental.mjs';

export const VERDICT = 'verdict.json';

// BACKWARD COMPATIBLE ON PURPOSE. The per-step URL used to be stored as `at` before the
// rename, and folders written then are still on disk and still worth reading.
export const stepUrl = (s) => (s && (s.url || s.at)) || '';

// ...AND IT HAS TO BE *OURS*. `manifest.json` is one of the most common filenames in
// computing, and a shots dir is not always one we own exclusively. Seen live: a browser
// update unpacked its components into a directory being served, each with a manifest.json
// of an unrelated schema — valid JSON, no `steps` — and the next request threw on
// m.steps.length and took the server down. Ours is decided by CONTENT, and "not ours" is
// a skipped row, never a throw.
export const isOurs = (m) => !!m && typeof m === 'object' && Array.isArray(m.steps);

// null when the folder holds no manifest, an unparseable one, or somebody else's.
export function readManifest(dir) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
  return isOurs(m) ? m : null;
}
export function readVerdict(dir) {
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, VERDICT), 'utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

// ── two kinds of run, one answer ────────────────────────────────────────────
// A RECORDED run (manifest.video) is reviewed as ONE thing: the flow is approved or
// rejected, and each chapter may carry a note. A run from before the recording has a still
// per step and a verdict per step. Both are on disk and both stay readable, so every
// reader of "what state is this run in" — list, the Reviews screen, --check — asks this one
// function rather than growing a second copy of the rule per kind.
//   THE FLAG RULE DIFFERS, AND ON PURPOSE. A recorded flow has ONE reviewer's verdict, and
// the owner's approve IS the decision: he watched the video with the run's flags drawn on
// it, so demanding a written reason on top made "approved" read as refused and sent him
// back to type an excuse for something he had already judged. The flags stay on the record
// (`flagged` still counts them, --check still prints each as accepted by the approve) — they
// are just not a gate. A run with no verdict is still not approved, flags or none. A
// per-step run has a verdict per step, and there a flag is still cleared only by a note.
export const isRecorded = (m) => !!(m && m.video);
export const chapterNote = (v, n) => String(((v.chapters || {})[String(n)]) || '').trim();
export function runState(m, v) {
  if (isRecorded(m)) {
    const fv = (v.flow || {}).v || '';
    const flagged = m.steps.filter(st => st.notes && st.notes.length && !chapterNote(v, st.n)).length;
    const label = fv === 'reject' ? 'rejected' : !fv ? 'unreviewed' : 'approved';
    return { total: 1, marked: fv ? 1 : 0, problem: fv === 'reject' ? 1 : 0, flagged, label,
             cls: fv === 'reject' ? 'bad' : !fv ? 'warn' : 'ok',
             text: fv === 'reject' ? 'rejected' : !fv ? 'not reviewed'
               : flagged ? `approved · ${flagged} flag${flagged === 1 ? '' : 's'} accepted` : 'approved' };
  }
  const total = m.steps.length;
  const marked = m.steps.filter(st => (v[String(st.n)] || {}).v).length;
  const problem = m.steps.filter(st => (v[String(st.n)] || {}).v === 'problem').length;
  const flagged = m.steps.filter(st => st.notes && st.notes.length &&
    !(['ok', 'skip'].includes((v[String(st.n)] || {}).v) && ((v[String(st.n)] || {}).note || '').trim())).length;
  const label = problem ? `${problem} problem` : flagged ? `${flagged} flagged`
    : marked < total ? `${total - marked} unreviewed` : 'approved';
  // ACTIONABLE, NOT MERELY RED. "2 flagged" on a run where every step was marked reads
  // as a broken screen: the reviewer did everything offered and it stayed red. When the
  // only thing left is a missing reason, say THAT — it is a different job from reviewing.
  const text = problem ? `${problem} needs changes` : marked < total ? `${total - marked} unreviewed`
    : flagged ? `${flagged} need a reason` : 'approved';
  return { total, marked, problem, flagged, label, text,
           cls: problem ? 'bad' : (marked < total || flagged) ? 'warn' : 'ok' };
}

// ── when a run happened ──────────────────────────────────────────────────────
// THE FOLDER NAME IS NOT A DATE. The default folder is an ISO stamp, so the old index
// formatted its WHEN column from the name — and a run recorded with `--out <name>` showed
// its flow's name where the date belongs, and sorted wherever that name fell alphabetically.
// Measured on one real shots dir: 3 of 26 runs were named, each one out of order and
// undated. Every manifest carries provenance.at, which is the moment the run started; the
// stamp in a default folder name is the fallback for a manifest that lacks it, and the
// manifest's mtime the last resort. Never a verdict's mtime: reviewing a run would move it.
export function runTime(name, m, dir) {
  const at = Date.parse(((m || {}).provenance || {}).at || '');
  if (Number.isFinite(at)) return at;
  const s = /^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(String(name || ''));
  if (s) { const t = Date.parse(`${s[1]}T${s[2]}:${s[3]}:${s[4]}Z`); if (Number.isFinite(t)) return t; }
  try { return fs.statSync(path.join(dir, 'manifest.json')).mtimeMs; } catch { return 0; }
}

// Every run under one shots root, newest first by runTime. Foreign manifests are skipped.
export function listRuns(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!RUN_ID.test(name)) continue;
    const dir = path.join(root, name);
    const m = readManifest(dir);
    if (!m) continue;
    const v = readVerdict(dir);
    out.push({ name, dir, m, v, state: runState(m, v), at: runTime(name, m, dir) });
  }
  return out.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

// ── a verdict, from a client ─────────────────────────────────────────────────
// What the old loopback page POSTed, validated the same way, now for the phone. Returns
// {ok, out} to write, or {ok:false, error}.
//   Recorded: {flow:{v,note}, chapters:{n:text}} — v is approve, reject or empty (un-choosing
// is a real thing), chapters checked against the manifest so a stale screen cannot write
// numbers this run does not have.
//   Stills: {state:{n:{v,note}}} with v in ok/problem/skip.
const CAP = 2000;
export function cleanVerdict(m, j) {
  j = j && typeof j === 'object' ? j : {};
  if (isRecorded(m)) {
    const fv = String((j.flow || {}).v || '');
    if (fv && !['approve', 'reject'].includes(fv)) return { ok: false, error: 'flow verdict is approve or reject' };
    const chapters = {};
    for (const [k, val] of Object.entries(j.chapters || {})) {
      if (!/^[0-9]+$/.test(k) || !m.steps.some(x => String(x.n) === k)) continue;
      const t = String(val || '').slice(0, CAP);
      if (t.trim()) chapters[k] = t;
    }
    return { ok: true, out: { flow: fv ? { v: fv, note: String((j.flow || {}).note || '').slice(0, CAP) } : null, chapters } };
  }
  const clean = {};
  for (const [k, val] of Object.entries(j.state || {})) {
    if (!/^[0-9]+$/.test(k) || !m.steps.some(x => String(x.n) === k)) continue;
    const v = String((val || {}).v || '');
    if (!['ok', 'problem', 'skip'].includes(v)) continue;
    clean[k] = { v, note: String((val || {}).note || '').slice(0, CAP) };
  }
  // A POST THAT STORED NOTHING IS NOT OK. A state whose every entry was rejected once got a
  // success and an empty file, and the screen showed `saved` off that reply. An EMPTY state
  // is different and allowed — clearing every mark is what the screen sends then.
  if (Object.keys(j.state || {}).length && !Object.keys(clean).length)
    return { ok: false, error: 'no usable verdicts in that state' };
  return { ok: true, out: clean };
}

// ── where the runs are ───────────────────────────────────────────────────────
// One shots root per profile: the projects files name the profiles, and `work` is always
// one (a fleet with no projects registered still records into ~/.claude/fleet/shots).
export function roots(list = projects()) {
  const seen = new Map();
  for (const t of [{ profile: 'work', cfg: cfgFor('work') }, ...list]) {
    const prof = (t.profile === 'default' ? 'work' : t.profile) || 'work';
    if (!seen.has(prof)) seen.set(prof, path.join(t.cfg, 'fleet', 'shots'));
  }
  return [...seen].map(([profile, root]) => ({ profile, root }));
}

// A run id is a folder name: no separator, no dot-dot. Checked by shape AND by resolving,
// because the id comes from a phone.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
export function runDir(rootsList, profile, run) {
  const r = rootsList.find(x => x.profile === String(profile || ''));
  if (!r || !RUN_ID.test(String(run || ''))) return null;
  const dir = path.resolve(r.root, String(run));
  return dir.startsWith(path.resolve(r.root) + path.sep) ? { ...r, dir } : null;
}

// Which project a run was recorded in, for the card's title. provenance.repo is the
// checkout's top level, which in a fleet is usually a linked worktree whose folder name is
// nobody's project name — so a worktree is followed to the repo it belongs to (its `.git`
// FILE names `<main>/.git/worktrees/<x>`) and that is matched against the projects files.
// File reads only: this runs per run per list, and a git spawn each would be the slow part.
function projectOf(repo, list) {
  if (!repo) return '';
  const byPath = new Map(list.map(t => [path.resolve(t.path), t.name]));
  const hit = byPath.get(path.resolve(repo));
  if (hit) return hit;
  try {
    const g = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(repo, '.git'), 'utf8'));
    const main = g && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(g[1].trim());
    if (main && byPath.has(path.resolve(main[1]))) return byPath.get(path.resolve(main[1]));
  } catch {}
  return path.basename(repo);
}

const summary = (r, profile) => {
  const p = r.m.provenance || {};
  return { id: r.name, profile, at: new Date(r.at).toISOString(), commit: p.commit || null, dirty: p.dirty ?? null,
           kind: isRecorded(r.m) ? 'recorded' : 'stills', steps: r.m.steps.length,
           flagged: r.m.steps.filter(s => s.notes && s.notes.length).length,
           state: { label: r.state.label, cls: r.state.cls, text: r.state.text } };
};

// ONE ENTRY PER BRANCH, its newest run first — because a branch is what gets reviewed and
// merged, and a flat list of every run (the old index) put six runs of one branch above the
// one run of another that was actually waiting. The older runs ride along as `earlier`.
// Groups sort by their newest run; a branch waits on you when its NEWEST run is not approved
// (an old rejected run that a newer one superseded is history, not work).
export function groups(rootsList = roots(), list = projects()) {
  const by = new Map();
  for (const { profile, root } of rootsList) {
    for (const r of listRuns(root)) {
      const p = r.m.provenance || {};
      const project = projectOf(p.repo, list);
      const branch = p.branch || '';
      const key = `${profile}\x1f${project}\x1f${branch}`;
      if (!by.has(key)) by.set(key, { key, profile, project, branch, runs: [] });
      by.get(key).runs.push(summary(r, profile));
    }
  }
  const out = [...by.values()].map(g => {
    g.runs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const [latest, ...earlier] = g.runs;
    return { key: g.key, profile: g.profile, project: g.project, branch: g.branch, latest, earlier,
             waiting: latest.state.cls !== 'ok' };
  });
  return out.sort((a, b) => Date.parse(b.latest.at) - Date.parse(a.latest.at));
}

// ── media tickets ────────────────────────────────────────────────────────────
// A <video> CANNOT SEND A BEARER TOKEN, and the app's CSP (`default-src 'self'`) refuses a
// blob: URL, so the token-in-a-header route every other read takes does not reach the one
// request that needs it most. The run read — which DID carry the token — mints a ticket
// for that one run, and the media route accepts the ticket in its query string.
//   NOT ONE-USE, unlike the terminal's: a video is fetched as many byte ranges, one per
// seek, and a ticket spent on the first range would leave every chapter tap at 0:00. So it
// is bounded the other ways — one run, one client, one listener, an hour, and dead the
// moment the client is revoked (asked of fleet-serve on every request, not remembered).
// Stored as sha256 → row, like the session tokens, and the request log prints the path
// without the query, so the ticket is in no file.
const TICKET_TTL = 3600;
const tickets = new Map();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
//   A PAIRED HOST'S RUN is ticketed HERE, by the home host, and bound to that host's key as
// well: the phone never holds anything the peer issued, and a ticket for the vm's run of a
// name cannot fetch this host's run of the same name ('' is this host).
export function mintTicket({ client, rp_id, host = '', profile, run, nowS }) {
  for (const [k, t] of tickets) if (t.exp <= nowS) tickets.delete(k);
  const k = crypto.randomBytes(32).toString('base64url');
  tickets.set(sha(k), { client, rp_id, host, profile, run, exp: nowS + TICKET_TTL });
  return { ticket: k, exp: nowS + TICKET_TTL };
}
function ticketOk(k, { host = '', profile, run, rp_id, nowS, clientLive }) {
  const t = k && tickets.get(sha(k));
  if (!t || t.exp <= nowS) return false;
  if (t.host !== host || t.profile !== profile || t.run !== run || t.rp_id !== rp_id) return false;
  if (!clientLive(t.client)) { tickets.delete(sha(k)); return false; }
  return t;
}

// Only the files a run references, by extension: the folder is ours, but a name handed
// over by a phone is not, and "serve whatever is under here" is how a review surface
// becomes a file browser for the home directory.
const MEDIA = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|mp4|webm)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4', webm: 'video/webm' };

// RANGES, OR iOS PLAYS NOTHING AND THE CHAPTERS DO NOTHING. A <video> seeks by asking for a
// byte range, and Safari will not play at all from a server that answers its probe
// (`bytes=0-1`) with a 200 and the whole file. Measured on the old loopback server: served
// whole, every seek was refused, so a chapter tap left the video at 0:00 — a list that
// looks right and does nothing.
export function serveFile(req, res, file, type) {
  let size = 0;
  try { const st = fs.statSync(file); if (!st.isFile()) throw 0; size = st.size; }
  catch { res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('not found'); }
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (req.headers.range && !(rg && (rg[1] || rg[2]))) {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }); return res.end();
  }
  if (rg) {
    // `bytes=-N` is the last N bytes; `bytes=A-` runs to the end; an end past the file is
    // clamped (RFC 9110 §14.1.2), a start past it is unsatisfiable.
    const a = rg[1] ? Number(rg[1]) : Math.max(0, size - Number(rg[2]));
    const z = rg[1] && rg[2] ? Math.min(Number(rg[2]), size - 1) : size - 1;
    if (a >= size || a > z || (!rg[1] && Number(rg[2]) === 0)) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }); return res.end();
    }
    res.writeHead(206, { ...base, 'content-length': z - a + 1, 'content-range': `bytes ${a}-${z}/${size}` });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start: a, end: z }).pipe(res);
  }
  res.writeHead(200, { ...base, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).pipe(res);
}

// The paths that authenticate by ticket rather than by bearer. fleet-serve's session gate
// lets these through to `api` below, which refuses anything without a good ticket.
export const TICKETED = new Set(['/api/shots/media']);

// ── PAIRED HOSTS: every machine's runs, reviewed from one app ────────────────
// One person runs two fleets, paired (lib/peers.mjs), each recording its own runs into its
// own shots dirs. The phone logs in to ONE of them, so the other's runs reach it only
// through this host — and the shape is the one every other paired read takes: this host
// asks the peer, signed, and answers for it. The phone never talks to the peer.
//   A RUN ON A PEER IS NAMED BY ITS HOST KEY beside profile and folder (`host=vm`), and an
// absent or empty host is this host — so a phone, a request or a ticket from before pairing
// means exactly what it meant.
//   THE PEER DOES ALL THE DECIDING about its own runs: its manifests, its path checks, its
// verdict validation, its serialize and its audit. This host only forwards, labels, mints
// the phone's media ticket, and audits that it forwarded.
//   ONE HOP: a signed request carrying a `host` is refused, so two paired hosts can never
// bounce a run read between them, and a signed request never fans out again.
//
// ctx.peers, from fleet-serve, is null when this host has no peers or the request is itself
// a paired host's:
//   self()                          this host's label
//   list()                          [{ key, label }]
//   fan(pathq, ms)                  [{ peer, r }] — every peer asked at once, signed
//   call(peer, {method, pathq, body, ms})   one signed JSON call
//   stream(peer, {method, pathq, headers, ms})  one signed call, its body unbuffered
export const PEER_LIST_TIMEOUT = 5000;     // the list's fan-out: what /api/waiting gives a peer
const PEER_CALL_TIMEOUT = 15000;           // a tap: a run read, a verdict, one byte range
const MEDIA_PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];

// What a peer's refusal becomes on THIS side. Never its 401/403 as-is: web/api.js reads a
// 401 or 403 as "this session is dead" and locks the app, and a peer refusing this host is
// about the pairing, not about the phone (fleet-serve's proxyRemote, the same rule).
function peerFail(send, res, peer, r) {
  if (!r.status) return send(res, 502, { ok: false, offline: true, host: peer.label, text: `${peer.label} did not answer (${r.error})` });
  const why = String((r.json && (r.json.text || r.json.error)) || `HTTP ${r.status}`).slice(0, 300);
  if (r.status === 404) return send(res, 404, { ok: false, host: peer.label, ...(r.json && r.json.disabled ? { disabled: true } : {}), text: `${peer.label}: ${why}` });
  return send(res, r.status === 400 ? 400 : 502, { ok: false, host: peer.label, text: `${peer.label} refused it: ${why}` });
}

// The list's answer for one peer: its groups, or why it has none. Switched off THERE is not
// missing — the owner turned Reviews off on that machine, and it contributes nothing, not
// a line about itself.
function peerGroups(peer, r) {
  if (r.status === 200 && r.json && Array.isArray(r.json.groups)) {
    const out = [];
    for (const g of r.json.groups) {
      if (!g || !g.latest || typeof g.latest.at !== 'string' || !g.latest.state) continue;
      out.push({ ...g, key: `${peer.key}\x1f${g.key}`, host: peer.label, host_key: peer.key,
                 earlier: Array.isArray(g.earlier) ? g.earlier : [] });
    }
    return { groups: out };
  }
  if (r.status === 404 && r.json && r.json.disabled) return { groups: [], off: true };
  const why = !r.status ? 'did not answer'
    : r.status === 403 ? 'does not share its reviews with this host (its fleet-serve is older)'
    : r.status === 401 ? 'no longer accepts this host\'s pairing'
    : `answered HTTP ${r.status}`;
  return { groups: [], missing: { host: peer.label, host_key: peer.key, why } };
}

// ── the routes ───────────────────────────────────────────────────────────────
// ctx, from fleet-serve: send(res, status, obj), audit(row), serialize(fn), client (the
// enrolled client, or the paired host's `<label>/<client>` — null on a ticketed route),
// rp_id, ip, now() in seconds, clientLive(id), and peers (above).
//   WHAT A PAIRED HOST MAY ASK FOR HERE is fleet-serve's PAIR_READS / PAIR_POSTS: the list,
// one run, its media and a verdict — and a signed request is refused by pairAuth before it
// arrives for anything else.
export async function api(req, res, p, url, body, ctx) {
  const { send } = ctx;
  if (!X.enabled('shots')) return send(res, 404, { ok: false, disabled: true, experimental: true, text: X.disabledWhy('shots', 'Reviews') });
  const rs = ctx.roots ? ctx.roots() : roots();
  const q = (k) => url.searchParams.get(k) || '';
  const paired = !!(ctx.client && ctx.client.pair);
  // A PAIRED HOST'S IDENTITY ON THE ROW, like a paired send's: the host from this side's own
  // record of the pairing, the client from its signature.
  const via = paired ? { via: 'pair', origin_host: ctx.client.pair.label, origin_client: ctx.client.onBehalf || 'host' } : {};
  const hostKey = String((req.method === 'POST' ? body && body.host : q('host')) || '');
  if (hostKey && paired)
    return send(res, 403, { ok: false, text: 'a paired host asks about this host\'s own runs; a request is never forwarded a second time' });
  const peer = hostKey ? ((ctx.peers && ctx.peers.list()) || []).find(x => x.key === hostKey) : null;
  if (hostKey && !peer) return send(res, 404, { ok: false, text: `'${hostKey.slice(0, 40)}' is not a host paired with this one` });

  if (p === '/api/shots' && req.method === 'GET') {
    const local = groups(rs);
    const others = !paired && ctx.peers ? ctx.peers.list() : [];
    // A MACHINE WITH NO PEERS IS UNTOUCHED: no host field, no hosts list — the payload A
    // shipped, byte for byte.
    if (!others.length) {
      const profiles = [...new Set(local.map(x => x.profile))];
      // Profiles are named on a card only where more than one has runs: a one-profile fleet
      // would read `work` on every card, which says nothing.
      return send(res, 200, { ok: true, profiles, multi: profiles.length > 1, groups: local,
                              waiting: local.filter(x => x.waiting).length });
    }
    const self = ctx.peers.self();
    let all = local.map(g => ({ ...g, host: self, host_key: '' }));
    const missing = [];
    for (const { peer: pr, r } of (await ctx.peers.fan('/api/shots', PEER_LIST_TIMEOUT)) || []) {
      const x = peerGroups(pr, r);
      all = all.concat(x.groups);
      if (x.missing) missing.push(x.missing);
    }
    all.sort((a, b) => Date.parse(b.latest.at) - Date.parse(a.latest.at));
    const profiles = [...new Set(all.map(x => x.profile))];
    return send(res, 200, { ok: true, profiles, multi: profiles.length > 1, groups: all,
                            waiting: all.filter(x => x.waiting).length,
                            hosts: [{ key: '', label: self, self: true }, ...others.map(x => ({ key: x.key, label: x.label }))],
                            missing });
  }

  if (p === '/api/shots/run' && req.method === 'GET') {
    if (peer) {
      const r = await ctx.peers.call(peer, { pathq: `/api/shots/run?${new URLSearchParams({ profile: q('profile'), run: q('run') })}`, ms: PEER_CALL_TIMEOUT });
      if (r.status !== 200 || !r.json || !r.json.run) return peerFail(send, res, peer, r);
      // The ticket is THIS host's, for the phone: the media route below checks it, then
      // asks the peer by signature. Whatever the peer put in `media` is not passed on.
      const t = mintTicket({ client: ctx.client && ctx.client.id, rp_id: ctx.rp_id, host: peer.key, profile: q('profile'), run: q('run'), nowS: ctx.now() });
      return send(res, 200, { ...r.json, run: { ...r.json.run, host: peer.label, host_key: peer.key }, media: t });
    }
    const loc = runDir(rs, q('profile'), q('run'));
    const m = loc && readManifest(loc.dir);
    if (!m) return send(res, 404, { ok: false, text: 'no such run' });
    const v = readVerdict(loc.dir), prov = m.provenance || {};
    // A paired host's read gets no ticket: its phone fetches media from ITS host, which
    // tickets it there; one minted here would be a credential nobody can use.
    const t = paired ? null : mintTicket({ client: ctx.client && ctx.client.id, rp_id: ctx.rp_id, profile: loc.profile, run: q('run'), nowS: ctx.now() });
    return send(res, 200, { ok: true, run: {
      id: q('run'), profile: loc.profile, project: projectOf(prov.repo, projects()), branch: prov.branch || '',
      at: new Date(runTime(q('run'), m, loc.dir)).toISOString(),
      provenance: { commit: prov.commit ?? null, dirty: prov.dirty ?? null, base: prov.base ?? null,
                    viewport: prov.viewport || null, at: prov.at || null, session: prov.session ?? null, slot: prov.slot ?? null },
      kind: isRecorded(m) ? 'recorded' : 'stills', video: isRecorded(m) ? m.video : null, duration: m.duration ?? null,
      problems: m.problems ?? null,
      steps: m.steps.map(s => ({ n: s.n, name: s.name || '', file: s.file || null, url: stepUrl(s), title: s.title || '',
                                 expect: s.expect || null, notes: s.notes || [], requests: s.requests || [],
                                 start: s.start ?? null, end: s.end ?? null })),
      verdict: v, state: runState(m, v) }, media: t });
  }

  if (p === '/api/shots/media' && (req.method === 'GET' || req.method === 'HEAD')) {
    const profile = q('profile'), run = q('run'), file = q('file');
    // A SIGNED REQUEST IS ITS OWN CREDENTIAL. The ticket exists because a <video> cannot
    // carry a bearer; a paired host CAN sign, and did — pairAuth verified it before this
    // line, so `paired` is never true for a request that merely claims to be one.
    const tk = paired || ticketOk(q('k'), { host: hostKey, profile, run, rp_id: ctx.rp_id, nowS: ctx.now(), clientLive: ctx.clientLive });
    if (!tk) return send(res, 401, { ok: false, text: 'no live media ticket for that run — open the run again', needs: 'ticket' });
    if (!MEDIA.test(file)) return send(res, 403, { ok: false, text: 'not a file a run serves' });
    if (peer) {
      // RANGES, END TO END. The phone's Range goes to the peer as it was asked, and the
      // peer's 206/416 and its Content-Range come back as they were answered: this host
      // computes no range of its own, so there is exactly one implementation of the rule
      // that makes iOS play (serveFile, on the machine that has the file). The body is piped
      // as it arrives, never held.
      // ...on behalf of the client the ticket was minted for: this request carries no bearer.
      const r = await ctx.peers.stream(peer, { method: req.method, ms: PEER_CALL_TIMEOUT, onBehalf: tk.client || '',
        pathq: `/api/shots/media?${new URLSearchParams({ profile, run, file })}`,
        headers: req.headers.range ? { range: String(req.headers.range) } : {} });
      if (!r.status) return send(res, 502, { ok: false, offline: true, host: peer.label, text: `${peer.label} did not answer (${r.error})` });
      if (r.status === 401 || r.status === 403) { r.res.resume(); return send(res, 502, { ok: false, host: peer.label, text: `${peer.label} refused the media (HTTP ${r.status})` }); }
      const h = {};
      for (const k of MEDIA_PASS) if (r.headers[k] !== undefined) h[k] = r.headers[k];
      res.writeHead(r.status, h);
      // A seek abandons the range it was reading: the phone closes this response, and the
      // peer's must close with it rather than stream a video nobody is reading.
      res.on('close', () => { try { r.res.destroy(); } catch {} });
      return r.res.pipe(res);
    }
    const loc = runDir(rs, profile, run);
    if (!loc) return send(res, 404, { ok: false, text: 'no such run' });
    const f = path.resolve(loc.dir, file);
    if (!f.startsWith(loc.dir + path.sep)) return send(res, 403, { ok: false, text: 'outside the run' });
    return serveFile(req, res, f, TYPES[file.split('.').pop()]);
  }

  if (p === '/api/shots/verdict') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, text: 'POST only' });
    if (peer) {
      // WRITTEN ON THE PEER, because its verdict.json is what ITS `fleet-shots --check`
      // reads. The body goes as the phone sent it, minus the host; the peer validates it
      // against its own manifest, serializes the write and audits it under this host's name
      // and the phone's. This side records that it forwarded one, and the answer.
      const { host: _h, ...out } = body;
      const r = await ctx.peers.call(peer, { method: 'POST', pathq: '/api/shots/verdict', body: out, ms: PEER_CALL_TIMEOUT });
      ctx.audit({ ts: ctx.now(), client: ctx.client && ctx.client.id, ip: ctx.ip, verb: 'shots_verdict', via: 'proxy', host: peer.label,
                  project: null, subject: `${peer.key}:${String(out.profile || '')}/${String(out.run || '')}`.slice(0, 260),
                  result: !r.status ? 'unreachable' : r.status < 400 ? 'ran' : 'refused',
                  state: (r.json && r.json.state && r.json.state.label) || null, confirmed: null,
                  ...(r.status >= 400 || !r.status ? { output: String((r.json && r.json.text) || r.error || '').slice(0, 300) } : {}) });
      if (r.status !== 200 || !r.json || !r.json.ok) return peerFail(send, res, peer, r);
      return send(res, 200, { ...r.json, host: peer.label, host_key: peer.key });
    }
    const loc = runDir(rs, body.profile, body.run);
    const m = loc && readManifest(loc.dir);
    if (!m) return send(res, 404, { ok: false, text: 'no such run' });
    const c = cleanVerdict(m, body);
    if (!c.ok) return send(res, 400, { ok: false, text: c.error });
    // SERIALIZED, so two devices saving at once write whole files in turn, and AUDITED,
    // because this file is what `fleet-shots --check` reads: a verdict can let a worker
    // call itself done. See the PR for why it takes no fresh passkey.
    return ctx.serialize(async () => {
      try { fs.writeFileSync(path.join(loc.dir, VERDICT), JSON.stringify(c.out, null, 2)); }
      catch (e) { return send(res, 500, { ok: false, text: `could not write the verdict: ${e.message}` }); }
      const st = runState(m, c.out);
      ctx.audit({ ts: ctx.now(), client: ctx.client && ctx.client.id, ip: ctx.ip, verb: 'shots_verdict', ...via,
                  project: null, subject: `${loc.profile}/${body.run}`, result: 'ran', state: st.label, confirmed: null });
      return send(res, 200, { ok: true, verdict: c.out, state: st });
    });
  }

  return send(res, 404, { ok: false, text: `no such endpoint: ${p}` });
}
