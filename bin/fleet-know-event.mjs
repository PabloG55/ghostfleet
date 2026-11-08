#!/usr/bin/env node
// fleet-know-event — the one writer of the fleet's memory (docs/MEMORY.md).
//
// Every path that sees something calls this with what it saw, as key=value arguments, and it
// appends ONE event to the profile's log (<fleet-dir>/know.jsonl) through record() in
// lib/know.mjs — where the privacy decision is made, once, for every caller:
//
//   fleet-know-event hook    event=<E> slot= sock= branch= status= turn=  < hook payload
//   fleet-know-event spawn   worker= branch= worktree= task= kind= parent= base= agent=
//   fleet-know-event ack     worker= branch= understood= decisions=
//   fleet-know-event retire  worker= branch= reason=
//   fleet-know-event prs     repo=<owner/name> new=<cache file>     < the cache as it was
//   fleet-know-event ledger  session=<sid> via=<who>               < [changes] (ledgerChanges)
//   fleet-know-event infer   session=<sid> turn=<id>               < [{text, why}]
//   fleet-know-event deploy  target= cmd= commit= ok=yes|no
//   fleet-know-event privacy session=<sid> | sock=<sock>          prints include|private|exclude
//
// Common keys: fleet=<dir> (default: this profile's), sock=, cwd=, session=, slot=, t=<ms>.
//
// IT NEVER FAILS ITS CALLER. The hook runs it detached and every other caller ignores its
// status, so a broken memory can cost a fact and never a turn, a spawn or a merge. Exit 0
// always, except `privacy`, whose answer IS its output.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from '../lib/know.mjs';

const [verb, ...rest] = process.argv.slice(2);
const a = {};
for (const x of rest) { const i = x.indexOf('='); if (i > 0) a[x.slice(0, i)] = x.slice(i + 1); }
const fleetDir = a.fleet || K.fleetDirOf();
const sock = a.sock || process.env.CLAUDE_FLEET_SOCK || '';
const now = Number(a.t) || Date.now();
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const git = (cwd, args) => {
  if (!cwd) return '';
  const r = spawnSync('git', ['-C', cwd, '--no-optional-locks', ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
};
// The repo is part of a branch's and a PR's identity (lib/know.mjs, node ids), so every event
// that names a branch carries it, from the folder it happened in.
// (`repo` present but empty means "looked: not a repo", which the hook's cache answers.)
const withRepo = (f, cwd) => ('repo' in f || !cwd ? f : { ...f, repo: K.repoSlug(cwd) });
const ctx = (extra = {}) => ({ fleetDir, sock, cwd: a.cwd || '', t: now, src: { via: verb, ...(a.session ? { session: a.session } : {}), ...(a.slot ? { slot: a.slot } : {}) }, ...extra });
const put = (kind, f, c = ctx()) => K.record(kind, withRepo(f, c.cwd), c);

// The fleet's own words to a session are not something anybody asked (lib/ledger.js isNudge
// is the same rule): a wake-up that says it needs no reply, a background job's notice, a
// slash command, the harness's local-command echo.
const machinePrompt = (t) => {
  const s = String(t || '').trimStart();
  return !s || s.startsWith('<task-notification>') || s.startsWith('<local-command') || s.startsWith('<command-')
    || s.startsWith('/') || (/^\[fleet\]/.test(s) && /\bno need to reply\b/i.test(s));
};

// Two Stops of one session can overlap (the hook does not wait for this), and both would
// read the same transcript lines. A directory is the lock; one older than a minute is a
// writer that died, and is taken over.
function withLock(name, fn) {
  const d = path.join(fleetDir, `.${name}.knowlock`);
  for (let k = 0; k < 40; k++) {
    try { fs.mkdirSync(d); try { return fn(); } finally { fs.rmSync(d, { recursive: true, force: true }); } }
    catch (e) {
      if (e.code !== 'EEXIST') return fn();
      try { if (Date.now() - fs.statSync(d).mtimeMs > 60_000) { fs.rmSync(d, { recursive: true, force: true }); continue; } } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return null;
}

function hook() {
  const p = json(readStdin(), {}) || {};
  const event = a.event || p.hook_event_name || '';
  const session = p.session_id || a.session || '';
  if (!session) return;
  const cwd = p.cwd || a.cwd || '';
  const c = ctx({ cwd, src: { via: 'hook', session, ...(a.slot ? { slot: a.slot } : {}), agent: a.agent || 'claude' } });
  // The folder's repo, once per session (and again only if the session moved): every hook
  // event needs it, and asking git each time was most of this writer's cost after node's own
  // start. It goes with the cursor at SessionEnd.
  const repoFile = path.join(fleetDir, `${session}.knowrepo`);
  let info = json((() => { try { return fs.readFileSync(repoFile, 'utf8'); } catch { return ''; } })(), null);
  if (!info || info.cwd !== cwd) {
    info = { cwd, ...K.repoInfo(cwd) };
    try { if (fs.statSync(fleetDir).isDirectory()) fs.writeFileSync(repoFile, JSON.stringify(info)); } catch {}
  }
  const base = { branch: a.branch, cwd, repo: info.slug || undefined };
  switch (event) {
    case 'SessionStart': put('session.start', { ...base, source: p.source }, c); break;
    case 'UserPromptSubmit':
      if (!machinePrompt(p.prompt)) put('prompt', { ...base, text: p.prompt }, c);
      break;
    case 'Notification':
      if (a.status === 'need-you') put('need-you', { ...base, note: p.message }, c);
      break;
    case 'StopFailure':
      put('turn.end', { ...base, status: 'failed', error: p.error || p.error_type, said: p.last_assistant_message }, c);
      break;
    case 'Stop': {
      const cursor = path.join(fleetDir, `${session}.knowline`);
      withLock(session, () => {
        let facts = { files: [], prs: [], deploys: [] };
        const tr = p.transcript_path || '';
        let end = null;
        if (tr) {
          const r = K.transcriptSince(tr, cursor, path.join(fleetDir, `${session}.chain`));
          facts = K.turnFacts(r.lines, { repoRoot: info.root, repo: info.slug });
          end = r.end;
          // HEAD at the Stop is where the turn LEFT it. A command that moved HEAD (check a commit
          // out, sync it, re-park on a tag) shipped something else, and naming the tag is wrong
          // in a way that looks right; no commit is better than that one.
          if (facts.deploys.length) { const head = git(cwd, ['rev-parse', 'HEAD']); for (const d of facts.deploys) { if (!d.moves) d.commit = head; delete d.moves; } }
          for (const pr of facts.prs) if (pr.op === 'open' && !pr.branch) pr.branch = a.branch;
        }
        put('turn.end', { ...base, status: a.turn || 'done', said: p.last_assistant_message, files: facts.files, prs: facts.prs, deploys: facts.deploys }, c);
        if (end !== null) { try { fs.writeFileSync(cursor, `${end}\n`); } catch {} }
      });
      break;
    }
    case 'SessionEnd':
      put('session.end', { reason: p.reason }, c);
      for (const x of ['knowline', 'knowrepo']) { try { fs.rmSync(path.join(fleetDir, `${session}.${x}`), { force: true }); } catch {} }
      break;
    default: break;
  }
}

// The PR cache fleet-merged keeps (prs.<owner_repo>: branch \x1f number \x1f state per line),
// as it was and as it is now. What changed between the two is what happened to the PRs:
// opened, merged, closed. The FIRST cache a repo ever gets records only its open PRs — the
// 300 merged ones in it are history, not news, and their merge times are not known.
function prs() {
  const rows = (t) => String(t || '').split('\n').map(l => l.split('\x1f')).filter(c => c.length >= 3 && Number(c[1]))
    .map(([branch, number, state]) => ({ branch, number: Number(number), state: String(state).toUpperCase() }));
  const old = rows(readStdin());
  let cur = [];
  try { cur = rows(fs.readFileSync(a.new, 'utf8')); } catch { return; }
  const repo = a.repo;
  if (!repo || !cur.length) return;
  const was = new Map(old.map(r => [r.number, r]));
  const first = !old.length;
  const c = ctx({ src: { via: 'fleet-merged' } });
  // Who opened each open PR (fleet-merged's sidecar: number \x1f login per line), and which of
  // those the memory has been told already. A PR that was open before authors were recorded
  // is told again once, with its author: the fold keeps the first-seen time and the state.
  const author = new Map(String(a.authors ? (() => { try { return fs.readFileSync(a.authors, 'utf8'); } catch { return ''; } })() : '')
    .split('\n').map(l => l.split('\x1f')).filter(x => x.length === 2 && Number(x[0])).map(([n, who]) => [Number(n), who]));
  const sentFile = a.authors ? `${a.authors}.told` : '';
  const told = new Set(sentFile ? (() => { try { return fs.readFileSync(sentFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } })() : []);
  const toldNow = [];
  for (const r of cur) {
    const o = was.get(r.number);
    const who = r.state === 'OPEN' ? author.get(r.number) : '';
    const line = who ? `${r.number}\x1f${who}` : '';
    if (r.state === 'OPEN' && (!o || o.state !== 'OPEN' || (line && !told.has(line)))) { put('pr.open', { repo, number: r.number, branch: r.branch, author: who || undefined }, c); if (line) toldNow.push(line); }
    else if (!first && r.state === 'MERGED' && (!o || o.state !== 'MERGED')) put('pr.merge', { repo, number: r.number, branch: r.branch }, c);
    else if (!first && r.state === 'CLOSED' && (!o || o.state !== 'CLOSED')) put('pr.close', { repo, number: r.number, branch: r.branch }, c);
  }
  if (sentFile && toldNow.length) { try { fs.appendFileSync(sentFile, toldNow.join('\n') + '\n'); } catch {} }
  // An open PR that is in neither list now was closed without merging (fleet-merged asks
  // for open and merged only).
  const now2 = new Set(cur.map(r => r.number));
  if (!first) for (const o of old) if (o.state === 'OPEN' && !now2.has(o.number)) put('pr.close', { repo, number: o.number, branch: o.branch }, c);
}

function privacy() {
  let s = sock;
  if (a.session) { const r = K.sessionRecord(fleetDir, a.session); if (r && r.sock) s = r.sock; }
  if (!s && a.cwd) s = K.resolveProject({ cwd: a.cwd }).sock;
  process.stdout.write(K.privacyFor(fleetDir, s).mode + '\n');
}

try {
  switch (verb) {
    case 'hook': hook(); break;
    case 'spawn':
      put('spawn', { worker: a.worker, branch: a.branch, worktree: a.worktree, task: a.task, kind: a.kind, parent: a.parent, base: a.base, agent: a.agent }, ctx({ cwd: a.cwd || a.worktree || '' }));
      break;
    case 'ack':
      put('ack', { worker: a.worker, branch: a.branch, understood: a.understood, decisions: a.decisions }, ctx({ cwd: a.cwd || a.worktree || '' }));
      break;
    case 'retire':
      put('retire', { worker: a.worker, branch: a.branch, reason: a.reason, worktree: a.worktree }, ctx({ cwd: a.cwd || a.worktree || '' }));
      break;
    case 'prs': prs(); break;
    case 'ledger': {
      const ch = json(readStdin(), []);
      if (a.session) K.noteLedger(fleetDir, a.session, ch, a.via || 'ledger');
      break;
    }
    case 'infer': {
      // Belt and braces: the mod asks `privacy` before it calls a model at all, and a fact
      // arriving for a project that is not `include` now is refused here too.
      const c = K.ctxFromSession(fleetDir, a.session, 'infer');
      if (K.privacyFor(fleetDir, c.sock).mode !== 'include') break;
      const facts = json(readStdin(), []);
      for (const x of (Array.isArray(facts) ? facts : []).slice(0, 5)) {
        if (x && typeof x.text === 'string' && x.text.trim()) put('decision', { text: x.text, why: x.why, inferred: true, turn: a.turn, source: 'inferred' }, { ...c, t: now });
      }
      break;
    }
    case 'deploy':
      put('deploy', { target: a.target, cmd: a.cmd, commit: a.commit || git(a.cwd, ['rev-parse', 'HEAD']), ok: a.ok !== 'no' && a.ok !== '0' && a.ok !== 'false' }, ctx());
      break;
    case 'privacy': privacy(); break;
    default:
      process.stderr.write('usage: fleet-know-event hook|spawn|ack|retire|prs|ledger|infer|deploy|privacy key=value…  (see the header)\n');
      process.exit(2);
  }
} catch (e) {
  if (process.env.CLAUDE_FLEET_KNOW_DEBUG) process.stderr.write(`fleet-know-event: ${e.stack || e}\n`);
}
process.exit(0);
