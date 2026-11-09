// lib/know-backfill.mjs — fleet-know backfill: the history this machine already has on record, put
// into the memory at the time it happened (docs/MEMORY.md). A command the owner runs. Nothing in the
// install runs it, and no model is asked anything.
//
// VALID THEN, KNOWN NOW. Each event's `t` is the source's own time and its `rec` is this run, so
// `--at` before a backfilled merge says it had not merged and `--known-at` before this run says
// nobody knew. A source with no time of its own gets no event, never today's: a manifest row has no
// time in it, so it borrows the spawn's line in <sock>.brief.tsv, then the branch's first reflog
// line, then the first line of a transcript from that folder, and past those it is counted as
// skipped. Measured on one machine: 256 of 318 manifest rows named a temp folder, and of the 59 under
// a registered project, 41 had a reflog line.
//
// ONCE, AND NEVER BESIDE WHAT THE LIVE HOOKS SAW. An event's id is its content and time, so a second
// run could not add the same line anyway, but a live writer saw the same merge at a different time and
// its id differs. So the log is read first, into one key per fact (`keysIn`): a PR's merge is a key
// whoever wrote it. A run adds what no line says yet and nothing else.
//
// A PROFILE THAT DOES NOT RECORD IS NOT READ. Its folder is not opened unless --profile names it,
// because the owner turned recording on per profile, and history is the same data.
//
// WHAT IT DECLINES TO KNOW. A ledger item still `open` from weeks ago is not a live ask: nobody will
// close it, since the session that could is gone, and it would sit on the project's page forever. So
// one older than the week the ledger itself lists gets an `expired` state at the end of that week,
// with a reason saying the backfill wrote it. Only for what the backfill itself opened: an item a live
// hook recorded is still the live hook's to close.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './know.mjs';
import { projects, cfgFor } from './projects.mjs';

const PR_LIMIT = 2000;          // per repo: one `gh pr list` call pages through them
const COMMIT_LIMIT = 20000;     // per project, newest first
const STILL_OPEN_MS = 7 * 86400e3;
const SOURCES = ['prs', 'ledgers', 'spawns', 'commits'];
const NO_TIME = 'no time on record';

const real = (p) => { try { return fs.realpathSync(p); } catch { return p ? path.resolve(p) : ''; } };
const run = (cmd, args, { cwd, env, timeout = 120000 } = {}) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const gitOut = (cwd, args, env) => {
  const r = run('git', ['-C', cwd, '--no-optional-locks', ...args], { env });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
};
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const timeOf = (x) => { const t = Date.parse(x); return Number.isNaN(t) ? 0 : t; };

// One key per fact, in the words of whoever wrote the line. Read before anything else, and kept
// current through the run, so two projects that share a repo cannot both file the same merge.
function keysIn(log) {
  const keys = new Set(), live = new Set();
  K.scanLog(log, 0, (e) => {
    const f = e.f || {};
    switch (e.kind) {
      case 'pr.open': keys.add(`pr.open|${f.repo}#${f.number}`); break;
      case 'pr.merge': keys.add(`pr.merge|${f.repo}#${f.number}`); break;
      case 'turn.end':
        for (const p of f.prs || []) keys.add(`pr.${p.op === 'merge' ? 'merge' : 'open'}|${p.repo || f.repo}#${p.number}`);
        break;
      case 'request.open':
        keys.add(`req.open|${f.req}`);
        if (!(e.src && e.src.via === 'backfill')) live.add(f.req);
        break;
      case 'request.state': keys.add(`req.state|${f.req}|${f.state}`); break;
      case 'spawn': keys.add(`spawn|${e.project}|${f.branch}`); break;
      case 'retire': keys.add(`retire|${e.project}|${f.branch}`); break;
      case 'commit': keys.add(`commit|${f.sha}`); break;
      case 'decision': if (f.req) keys.add(`answer|${f.req}|${e.t}`); break;
      default: break;
    }
  });
  return { keys, live };
}

// What a run is holding as it goes: the events it would write, and every count and reason it prints.
function makeRun(dir, { since, now, env }) {
  const { keys, live } = keysIn(path.join(dir, K.LOG));
  const r = { dir, profile: K.profileOf(dir, env), events: [], counts: Object.fromEntries(SOURCES.map(s => [s, 0])), projects: {}, answers: 0, already: 0, beforeSince: 0, skipped: {} };
  r.live = live;
  r.skip = (why, n = 1) => { r.skipped[why] = (r.skipped[why] || 0) + n; };
  r.has = (key) => keys.has(key);
  r.add = (source, p, kind, f, t, key) => {
    if (!t) { r.skip(`${source}: ${NO_TIME}`); return null; }
    if (t < since) { r.beforeSince++; return null; }
    if (keys.has(key)) { r.already++; return null; }
    const ev = K.eventFor(kind, f, { fleetDir: dir, project: p.name, sock: p.sock, t, rec: now, src: { via: 'backfill', from: source } }, env);
    if (!ev) return null;     // the one privacy decision: excluded projects were skipped before this, and a setting changing mid-run lands here
    keys.add(key);
    r.events.push(ev);
    r.counts[source]++;
    if (kind === 'decision') r.answers++;
    const c = (r.projects[p.name] ||= Object.fromEntries(SOURCES.map(s => [s, 0])));
    c[source]++;
    return ev;
  };
  return r;
}

// Merged PRs: the one source only `gh` can answer, and asked directly, because bin/fleet-merged records
// what it sees and a dry run writes nothing. Its cache holds no times anyway. Returns the branches
// that merged, which is how a spawned worker's end is known.
function fromPrs(r, p, slug, merged, env) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) { r.skip('prs: a project with no GitHub origin'); return; }
  const q = run('gh', ['pr', 'list', '--repo', slug, '--state', 'merged', '--limit', String(PR_LIMIT), '--json', 'number,title,headRefName,author,mergedAt,createdAt,mergeCommit'], { env, timeout: 180000 });
  if (q.error || q.status !== 0) { r.skip(q.error && q.error.code === 'ENOENT' ? 'prs: gh is not installed' : 'prs: gh could not list a repo'); return; }
  let list;
  try { list = JSON.parse(q.stdout || '[]'); } catch { r.skip('prs: gh answered something that is not JSON'); return; }
  if (list.length >= PR_LIMIT) r.skip(`prs: a repo with more than ${PR_LIMIT} merged PRs, the oldest not read`);
  for (const x of list) {
    const base = { repo: slug, number: x.number, title: x.title, author: x.author && x.author.login, branch: x.headRefName };
    const mergedAt = timeOf(x.mergedAt);
    if (x.headRefName && mergedAt && !(merged.get(x.headRefName) > mergedAt)) merged.set(x.headRefName, mergedAt);
    r.add('prs', p, 'pr.open', base, timeOf(x.createdAt), `pr.open|${slug}#${x.number}`);
    r.add('prs', p, 'pr.merge', { ...base, commit: x.mergeCommit && x.mergeCommit.oid }, mergedAt, `pr.merge|${slug}#${x.number}`);
  }
}

// The default branch's first-parent line: what landed there, in the order it landed, which is the one
// history a project with no PRs and no deploy script still has.
function fromCommits(r, p, slug, env) {
  const head = gitOut(p.path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env);
  const out = gitOut(p.path, ['log', '--first-parent', `--max-count=${COMMIT_LIMIT}`, '--format=%H%x1f%ct%x1f%s', head || 'HEAD'], env);
  if (!out) { r.skip('commits: a project whose path is not a repo with commits'); return; }
  const branch = head ? head.replace(/^origin\//, '') : '';
  const lines = out.split('\n');
  if (lines.length >= COMMIT_LIMIT) r.skip(`commits: a project with more than ${COMMIT_LIMIT} commits, the oldest not read`);
  for (const line of lines) {
    const [sha, ct, subject = ''] = line.split('\x1f');
    if (!sha) continue;
    const m = /\(#(\d+)\)\s*$/.exec(subject) || /^Merge pull request #(\d+)\b/.exec(subject);
    r.add('commits', p, 'commit', { sha, subject, pr: m ? Number(m[1]) : undefined, repo: slug || undefined, branch: branch || undefined }, Number(ct) * 1000, `commit|${sha}`);
  }
}

// A session's folder, off the top of its transcript. The session record goes when the session does;
// the transcript stays.
function transcriptIndex(cfg) {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(cfg, 'projects')); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(cfg, 'projects', d)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.set(f.slice(0, -6), path.join(cfg, 'projects', d, f));
  }
  return out;
}
function topOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(64 * 1024), n = fs.readSync(fd, b, 0, b.length, 0);
      const s = b.toString('utf8', 0, n);
      const cwd = /"cwd":"([^"]+)"/.exec(s), ts = /"timestamp":"([^"]+)"/.exec(s);
      return { cwd: cwd ? cwd[1] : '', t: ts ? timeOf(ts[1]) : 0 };
    } finally { fs.closeSync(fd); }
  } catch { return { cwd: '', t: 0 }; }
}

// Which project a ledger belongs to. The session's own socket says outright; a worktree the manifests
// name says even after the folder is gone; and a folder inside a project says last. Anything else is
// reported, not guessed: a ledger filed under the wrong project is worse than one not filed.
function ledgerOwner(dir, sid, mine, worktrees, transcripts) {
  const rec = K.sessionRecord(dir, sid);
  if (rec && rec.sock) { const p = mine.find(x => x.sock === rec.sock); if (p) return p; }
  const file = transcripts.get(sid);
  const cwd = (file && topOf(file).cwd) || (rec && rec.cwd) || '';
  if (!cwd) return null;
  const w = worktrees.get(real(cwd));
  if (w) return w;
  const q = K.resolveProject({ cwd });
  return q.known ? mine.find(x => x.name === q.name) || null : null;
}

function fromLedgers(r, L, dir, mine, worktrees, transcripts, now) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.ledger')); } catch { return; }
  for (const name of names) {
    const sid = name.slice(0, -'.ledger'.length);
    let ledger;
    try { ledger = L.parseLedger(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { r.skip('ledgers: a file that does not parse'); continue; }
    const items = (ledger && ledger.items) || [];
    if (!items.length) continue;
    const p = ledgerOwner(dir, sid, mine, worktrees, transcripts);
    if (!p) { r.skip('ledgers: a session with no project on the list', 1); r.skip('ledgers: items in those sessions', items.length); continue; }
    if (K.privacyFor(dir, p.sock).mode === 'exclude') { r.skip('ledgers: a session in an excluded project'); continue; }
    for (const i of items) {
      const req = `${sid}/${i.id}`, at = Number(i.at) || 0;
      // No src.session: a session's sighting opens it in the project, and these sessions ended long
      // ago with nothing left to say so. The request names its session in `req`, as a live one does.
      r.add('ledgers', p, 'request.open', { req, text: i.text, source: i.source, state: 'open' }, at, `req.open|${req}`);
      const state = i.state || 'open';
      if (state !== 'open') {
        const when = Number(state === 'waiting' ? i.progress && i.progress.at : i.closedAt || i.expiredAt) || at;
        // One millisecond on from its opening at the least. Two writes at one instant are settled by
        // the id, so a state written in the same breath could come out `open` by a coin toss.
        r.add('ledgers', p, 'request.state', { req, text: i.text, state, proof: i.proof, reason: i.reason, by: i.closedBy }, when && Math.max(when, at + 1), `req.state|${req}|${state}`);
      }
      if ((state === 'open' || state === 'waiting') && at && now - at > STILL_OPEN_MS && !r.live.has(req)) {
        r.add('ledgers', p, 'request.state', { req, text: i.text, state: 'expired', reason: 'backfill: still open in its ledger a week on, with no session left to close it', by: 'backfill' }, at + STILL_OPEN_MS, `req.state|${req}|expired`);
      }
    }
    for (const a of L.ownerAnswers(ledger)) {
      const req = `${sid}/${a.id}`;
      r.add('ledgers', p, 'decision', K.answerFields(req, a), a.t, `answer|${req}|${a.t}`);
    }
    const unasked = L.unaskedReplies(ledger);
    if (unasked) r.skip('ledgers: a reply of the owner\'s whose question is not on record', unasked);
  }
}

// The manifests name their worktree, which is the only thing that does once the folder is gone.
function manifestRows(dir, mine) {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.manifest.tsv')); } catch { return rows; }
  for (const name of names) {
    const sock = name.slice(0, -'.manifest.tsv'.length);
    const p = mine.find(x => x.sock === sock) || null;
    const briefs = readLines(path.join(dir, `${sock}.brief.tsv`)).map(l => l.split('\t'));
    for (const line of readLines(path.join(dir, name))) {
      const [wt = '', worker = '', branch = '', task = '', , , kind = ''] = line.split('\t');
      rows.push({ p, sock, wt, worker, branch, task, kind, briefs });
    }
  }
  return rows;
}
// When a worker started. Each of these is a real time for this worktree or branch, and none is a guess.
function spawnedAt(row, cfg) {
  let t = 0;
  for (const b of row.briefs) if (b[1] === row.wt && b[2] === row.worker) t = Math.max(t, Number(b[0]) * 1000 || 0);
  if (t) return t;
  if (row.p && row.branch) {
    const first = readLines(path.join(row.p.path, '.git', 'logs', 'refs', 'heads', row.branch))[0];
    const m = first && / (\d{9,}) [-+]\d{4}\t/.exec(first);
    if (m) return Number(m[1]) * 1000;
  }
  return firstSeen(row.wt, cfg).first;
}
function firstSeen(wt, cfg) {
  const folder = path.join(cfg, 'projects', String(wt).replace(/[/.]/g, '-'));
  let first = 0, last = 0, files = [];
  try { files = fs.readdirSync(folder).filter(f => f.endsWith('.jsonl')); } catch { return { first, last }; }
  for (const f of files) {
    const file = path.join(folder, f);
    const { t } = topOf(file);
    if (t && (!first || t < first)) first = t;
    try { last = Math.max(last, fs.statSync(file).mtimeMs); } catch {}
  }
  return { first, last: Math.round(last) };
}
function fromManifests(r, rows, merged, dir, cfg) {
  for (const row of rows) {
    if (!row.p) { r.skip('spawns: a manifest row from a fleet not on the project list'); continue; }
    if (!row.branch) { r.skip('spawns: a manifest row with no branch'); continue; }
    if (K.privacyFor(dir, row.p.sock).mode === 'exclude') { r.skip('spawns: a row in an excluded project'); continue; }
    const repo = K.repoInfo(row.p.path).slug || undefined;
    const started = spawnedAt(row, cfg);
    r.add('spawns', row.p, 'spawn', { worker: row.worker, branch: row.branch, repo, worktree: row.wt, task: row.task, kind: row.kind }, started, `spawn|${row.p.name}|${row.branch}`);
    // A folder still there may be a worker still running, and ending it from here would mark a live
    // session ended. Only a folder that is gone says the worker finished; when, is its PR's merge,
    // else the last write to its transcript, else nothing better than when it started.
    if (fs.existsSync(row.wt)) continue;
    const end = merged.get(row.branch) || firstSeen(row.wt, cfg).last || started;
    // No end to give it: the row was counted once already, when its spawn had no time. And an end with
    // no start on record would finish a worker nothing says began.
    if (!end || (!started && !r.has(`spawn|${row.p.name}|${row.branch}`))) continue;
    r.add('spawns', row.p, 'retire', { worker: row.worker, branch: row.branch, repo, reason: merged.has(row.branch) ? 'backfill: its PR merged and its worktree is gone' : 'backfill: its worktree is gone' }, end && Math.max(end, started + 1), `retire|${row.p.name}|${row.branch}`);
  }
}

// A named profile is read whether or not it records. Unnamed, only the ones whose log exists are, and
// the rest are listed by name and left unopened.
function profilesToRead(profile, env) {
  if (profile !== undefined) {
    const cfg = cfgFor(profile);
    if (!fs.existsSync(cfg)) return { error: `no profile '${profile}' on this machine` };
    return { read: [path.join(cfg, 'fleet')], left: [] };
  }
  const read = [], left = [];
  for (const d of K.allFleetDirs(env)) {
    if (fs.existsSync(path.join(d, K.LOG))) read.push(d);
    else left.push({ profile: K.profileOf(d, env), why: 'no know.jsonl, so it does not record: --profile names it' });
  }
  return { read, left };
}

export async function backfill({ profile, since = -Infinity, dryRun = false, now = Date.now(), env = process.env } = {}) {
  if (/^(0|off|no|false)$/i.test(env.CLAUDE_FLEET_KNOW || '')) return { error: 'the memory is off here (CLAUDE_FLEET_KNOW)' };
  const chosen = profilesToRead(profile, env);
  if (chosen.error) return chosen;
  const L = await import('../mods/ghostfleet/hooks/ledger.js');
  const all = projects();
  const out = { dryRun, since: Number.isFinite(since) ? since : null, profiles: [], left: chosen.left };
  for (const dir of chosen.read) {
    const r = makeRun(dir, { since, now, env });
    const mine = all.filter(p => real(path.join(p.cfg, 'fleet')) === real(dir));
    const usable = mine.filter(p => {
      if (K.privacyFor(dir, p.sock).mode !== 'exclude') return true;
      r.skip('projects: excluded from the memory');
      return false;
    });
    const cfg = path.dirname(dir);
    const rows = manifestRows(dir, mine);
    const worktrees = new Map();
    for (const row of rows) if (row.p && row.wt) worktrees.set(real(row.wt), row.p);
    const merged = new Map(), seenRepo = new Set(), seenPath = new Set();
    for (const p of usable) {
      const slug = K.repoInfo(p.path).slug;
      if (!seenRepo.has(slug || p.path)) { seenRepo.add(slug || p.path); fromPrs(r, p, slug, merged, env); }
      if (!seenPath.has(real(p.path))) { seenPath.add(real(p.path)); fromCommits(r, p, slug, env); }
    }
    fromLedgers(r, L, dir, mine, worktrees, transcriptIndex(cfg), now);
    fromManifests(r, rows, merged, dir, cfg);
    r.events.sort((a, b) => a.t - b.t);
    const row = { profile: r.profile, dir, added: r.events.length, counts: r.counts, projects: r.projects, answers: r.answers, already: r.already, beforeSince: r.beforeSince, skipped: r.skipped };
    if (!dryRun && r.events.length) {
      fs.mkdirSync(dir, { recursive: true });
      row.wrote = K.appendMany(dir, r.events);
      // Every line is older than the snapshot's high-water, so the next read would rebuild anyway.
      // Doing it here puts that wait on the command that caused it, and not on a session's start.
      const t0 = Date.now();
      K.rebuild(dir);
      row.rebuildMs = Date.now() - t0;
    }
    out.profiles.push(row);
  }
  return out;
}

export function renderBackfill(r) {
  const L = [];
  const verb = r.dryRun ? 'would add' : 'added';
  if (!r.profiles.length) L.push('no profile here records yet, so nothing was read');
  for (const p of r.profiles) {
    L.push(`${p.profile}: ${verb} ${p.added} event${p.added === 1 ? '' : 's'}${r.dryRun ? ' (a dry run: nothing written)' : p.rebuildMs !== undefined ? `, graph rebuilt in ${p.rebuildMs} ms` : ''}`);
    L.push(`  by source:  ${SOURCES.map(s => `${s} ${p.counts[s]}`).join('  ')}`);
    const names = Object.keys(p.projects).sort();
    if (names.length) {
      L.push('  by project:');
      const w = Math.max(...names.map(n => n.length));
      for (const n of names) L.push(`    ${n.padEnd(w)}  ${SOURCES.map(s => `${s} ${p.projects[n][s]}`).join('  ')}`);
    }
    if (p.answers) L.push(`  of those, the owner's answers, as the owner's decisions: ${p.answers}`);
    if (p.already) L.push(`  already on record, so not added: ${p.already}`);
    if (p.beforeSince) L.push(`  before --since: ${p.beforeSince}`);
    const why = Object.entries(p.skipped);
    if (why.length) {
      L.push('  skipped:');
      for (const [k, n] of why.sort()) L.push(`    ${n}  ${k}`);
    }
  }
  for (const x of r.left || []) L.push(`skipped profile ${x.profile}: ${x.why}`);
  return L.join('\n');
}
