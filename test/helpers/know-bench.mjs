// A synthetic memory log, and a stopwatch for what reads it (lib/know.mjs, docs/MEMORY.md).
//
//   node test/helpers/know-bench.mjs gen  <home> <events> [--seed n] [--now ms] [--projects n]
//   node test/helpers/know-bench.mjs time <home> [--root <checkout>] [--runs n]
//   node test/helpers/know-bench.mjs cpu  <home> [--root <checkout>]
//
// `gen` builds a fleet under <home>, which must be a scratch directory: it refuses the real
// HOME and any directory it did not make itself, so it can never reach a live log. `time`
// prints the wall clock of the real command, cold-started the way a lead runs it. `cpu` prints
// the CPU the reads spend, in-process, which is what the suite's bound asks: a machine at a
// load of 25 stretches the wall clock of a read and barely moves its CPU, so a regression back
// to quadratic goes red and a busy runner does not.
//
// The mix follows what a fleet writes rather than a uniform spray, because what made reads
// slow was the SHAPE: a project per dozen sessions, about sixty events to a session, a long
// lead session beside short workers that end, each worker with a branch, requests, turns that
// edit files, and sometimes a PR, a deploy or a decision. Lines land in nearly but not exactly
// time order, the way detached writers finish, with the odd carried item much later than the
// time it keeps. Names are web/fixtures' vocabulary with a number on the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const [verb, homeArg, ...rest] = process.argv.slice(2);
const die = (m) => { process.stderr.write(`know-bench: ${m}\n`); process.exit(2); };
const flag = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
if (!verb || !homeArg) die('usage: know-bench.mjs gen <home> <events> | time <home> | cpu <home>');
const home = path.resolve(homeArg);
const MARK = path.join(home, '.know-bench');

// The passwd entry, not os.homedir(): that one honours $HOME, so the guard would refuse the
// scratch directory it was given and wave through the real one under a changed $HOME.
function realHome() {
  try { return fs.realpathSync(os.userInfo().homedir); } catch { return ''; }
}
function claimHome() {
  fs.mkdirSync(home, { recursive: true });
  if (fs.realpathSync(home) === realHome()) die('refusing the real HOME');
  if (fs.readdirSync(home).length && !fs.existsSync(MARK)) die(`refusing ${home}: not empty, and not a directory this helper made`);
  fs.writeFileSync(MARK, '');
}
// A clean environment: no fleet variable of the session running this can steer a read to a
// real fleet dir, and no paired host is asked anything.
function cleanEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_FLEET_|GHOSTFLEET_|CLAUDE_CONFIG_DIR$|TMUX)/.test(k)) e[k] = v;
  return { ...e, HOME: home, CLAUDE_FLEET_KNOW_MACHINE: 'laptop' };
}

// ── gen ───────────────────────────────────────────────────────────────────
const BASES = ['acme-api', 'acme-web', 'toolbox', 'billing-svc', 'scratch'];
const WORKERS = ['api-fix', 'docs-pass', 'rate-limit', 'csv-export', 'cache-keys', 'search-index', 'list-pages', 'cli-flags', 'health', 'docs-sweep'];
const WORDS = 'the export writer quotes every field that holds a comma and the parser keeps one row per record so a retry after the webhook backoff reads the same rate limit per key while the cache keys stay stable across the settings page and the search index lists pages by plan tier'.split(' ');
const FILES = ['src/export/csv.js', 'src/api/rate-limit.js', 'src/cache/keys.js', 'src/search/index.js', 'README.md', 'CHANGELOG.md', 'test/export.test.js', 'test/api.test.js', 'lib/settings.js', 'docs/setup.md'];

async function gen(target) {
  claimHome();
  const K = await import(path.join(ROOT, 'lib', 'know.mjs'));
  let seed = (Number(flag('seed', 7)) >>> 0) || 7;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32; };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const words = (n) => { const o = []; for (let i = 0; i < n; i++) o.push(pick(WORDS)); return o.join(' '); };
  const now = Number(flag('now', Date.now()));
  const END = now - 60_000;                  // nothing "hot": every event has settled
  const SPAN = 60 * 86400e3;

  const dirs = { work: path.join(home, '.claude', 'fleet'), personal: path.join(home, '.claude-personal', 'fleet') };
  const cfg = path.join(home, '.config', 'ghostfleet');
  for (const d of [cfg, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
  const logs = Object.fromEntries(Object.entries(dirs).map(([p, d]) => [p, fs.openSync(path.join(d, K.LOG), 'w')]));

  // --projects concentrates the same events: one project's page is what grows, so a few busy
  // projects are the hard case for a brief and many thin ones the hard case for `waiting`.
  const nProjects = Number(flag('projects', 0)) || Math.max(8, Math.round(target / 1500));
  const projects = [];
  for (let i = 0; i < nProjects; i++) {
    const base = BASES[i % BASES.length];
    const name = i < BASES.length ? base : `${base}-${i}`;
    const profile = i % 7 === 6 ? 'personal' : 'work';
    projects.push({ name, profile, sock: `cf-${name}`, repo: `acme/${name}`, seq: 0, pr: 1000 + i * 1000 });
  }
  fs.writeFileSync(path.join(cfg, 'projects'), projects.filter(p => p.profile === 'work').map(p => `${p.name}\t${home}/gf-demo/${p.name}\twork\n`).join(''));
  fs.writeFileSync(path.join(cfg, 'projects.personal'), projects.filter(p => p.profile === 'personal').map(p => `${p.name}\t${home}/gf-demo/${p.name}\tpersonal\n`).join(''));
  const priv = projects.find(p => p.profile === 'work' && p.name.startsWith('scratch'));
  if (priv) fs.writeFileSync(path.join(dirs.work, `${priv.sock}.know`), 'private\n');

  // Lines are written from a buffer that is flushed up to the start of the newest session, so
  // the file is in nearly time order without the generator having to hold the whole log.
  let buf = [], made = 0;
  const flush = (upto) => {
    buf.sort((a, b) => a.at - b.at);
    const hold = [], out = { work: [], personal: [] };
    for (const x of buf) (x.at < upto ? out[x.profile] : hold).push(x.at < upto ? x.line : x);
    buf = hold;
    for (const p of Object.keys(out)) if (out[p].length) fs.writeSync(logs[p], out[p].join('\n') + '\n');
  };
  const put = (p, kind, f, t, src) => {
    const priv_ = priv && p === priv ? 'private' : undefined;
    const ev = K.makeEvent({ t, rec: t + int(5, 400), kind, machine: 'laptop', profile: p.profile, project: p.name, src: { ...src, sock: p.sock }, f, priv: priv_ });
    // Mostly the instant it happened, a few seconds out for a slow writer, and one line in a
    // couple of hundred much later: a carried ledger item, which keeps the time it was asked.
    const late = rnd() < 0.005 ? int(60_000, 3_600_000) : rnd() < 0.2 ? int(100, 5_000) : 0;
    buf.push({ at: t + late, profile: p.profile, line: JSON.stringify(ev) });
    made++;
  };

  // One long lead per project, and what it knows of itself.
  const leads = new Map();
  for (const p of projects) {
    const session = `s-${p.name}-master`;
    const src = { via: 'hook', session, slot: 'master' };
    leads.set(p, { session, src });
    const t = END - SPAN - int(0, 3600e3);
    put(p, 'session.start', { branch: 'main', repo: p.repo, cwd: `${home}/gf-demo/${p.name}` }, t, src);
    put(p, 'project.about', { text: `The ${p.name} service: ${words(10)}.` }, t + 1000, { via: 'fleet-know', slot: 'master' });
    if (rnd() < 0.5) put(p, 'relate', { rel: 'depends-on', to: pick(projects).name }, t + 2000, { via: 'fleet-know', slot: 'master' });
  }
  const nSessions = Math.ceil(target / 60);
  let sessionNo = 0;
  while (made < target) {
    const n = sessionNo++;
    const p = projects[n % projects.length];
    const t0 = END - SPAN + (SPAN * n) / nSessions;
    if (n % 200 === 0) flush(t0 - 3600e3);
    let t = t0;
    const tick = () => (t = Math.min(END, t + int(5_000, 120_000)));
    const isLead = n % 13 === 0;
    const { session: leadSession, src: leadSrc } = leads.get(p);
    if (isLead) {
      // the lead's own turn: it is the one session that keeps going for the whole log
      put(p, 'prompt', { branch: 'main', repo: p.repo, text: words(int(20, 120)) }, tick(), leadSrc);
      for (let i = int(10, 30); i > 0; i--) put(p, 'turn.end', { branch: 'main', repo: p.repo, status: 'done', said: words(int(20, 200)), files: rnd() < 0.3 ? [pick(FILES)] : [] }, tick(), leadSrc);
      if (rnd() < 0.3) put(p, 'decision', { text: words(int(8, 20)), why: words(int(5, 12)), source: 'stated' }, tick(), { via: 'fleet-know', slot: 'master' });
      if (rnd() < 0.2) put(p, 'deploy', { target: 'ghostfleet runtime', commit: (n * 2654435761 >>> 0).toString(16).padStart(8, '0') + 'abcdef', ok: true }, tick(), { via: 'deploy', slot: 'master' });
      continue;
    }
    const worker = `${pick(WORKERS)}-${n}`;
    const session = `s-${n}`;
    const branch = `fix/${worker}`;
    const src = { via: 'hook', session, slot: worker };
    const mod = { via: 'mod', session, slot: worker };
    const task = `You are a worker in the ${p.name} repo. One task, one PR against staging. ## Task ${words(int(30, 180))}. ## Rules Run the touched groups.`;
    put(p, 'spawn', { worker, branch, repo: p.repo, worktree: `${home}/gf-demo/${p.name}-${n}`, task, parent: 'master', base: 'staging' }, tick(), { via: 'spawn' });
    put(p, 'session.start', { branch, repo: p.repo, cwd: `${home}/gf-demo/${p.name}-${n}` }, tick(), src);
    put(p, 'prompt', { branch, repo: p.repo, text: task }, tick(), src);
    put(p, 'request.open', { req: `${session}/1`, text: task, source: 'fleet', state: 'open' }, tick(), mod);
    if (rnd() < 0.6) put(p, 'ack', { worker, branch, repo: p.repo, understood: words(int(8, 20)), decisions: words(int(6, 14)) }, tick(), { via: 'ack' });
    const turns = int(16, 26);
    const pr = rnd() < 0.7 ? ++p.pr : 0;
    let opened = false;
    for (let i = 0; i < turns; i++) {
      put(p, 'prompt', { branch, repo: p.repo, text: words(int(5, 60)) }, tick(), src);
      const open = pr && !opened && i > turns / 2;
      if (open) opened = true;
      put(p, 'turn.end', {
        branch, repo: p.repo, status: rnd() < 0.05 ? 'failed' : 'done', said: words(int(20, 220)),
        files: Array.from({ length: int(0, 5) }, () => pick(FILES)),
        ...(open ? { prs: [{ op: 'open', repo: p.repo, number: pr, url: `https://github.com/${p.repo}/pull/${pr}`, branch }] } : {}),
      }, tick(), src);
      if (rnd() < 0.08) put(p, 'need-you', { branch, repo: p.repo, note: 'Claude needs your permission to use Bash' }, tick(), src);
      if (rnd() < 0.1) {
        const q = `${session}/${i + 2}`;
        put(p, 'request.open', { req: q, text: `${words(int(5, 30))}?`, source: 'user', state: 'open' }, tick(), mod);
        if (rnd() < 0.85) put(p, 'request.state', { req: q, state: rnd() < 0.8 ? 'done' : 'dropped', text: words(6), proof: `checked ${pick(FILES)}` }, tick(), mod);
        else put(p, 'request.state', { req: q, state: 'waiting', text: words(6) }, tick(), mod);
      }
    }
    if (rnd() < 0.12) put(p, 'decision', { text: words(int(8, 20)), why: words(int(5, 12)), inferred: true, source: 'inferred', turn: `t-${n}` }, tick(), { via: 'infer', session, slot: worker });
    if (rnd() < 0.1) put(p, 'deploy', { target: 'vercel deploy', cmd: 'vercel deploy --prod', commit: (n * 40503 >>> 0).toString(16).padStart(8, '0') + 'fedcba', ok: true }, tick(), { via: 'hook', session, slot: worker });
    // The recent end of the log stays open, which is what `waiting` has to walk.
    const stillOpen = END - t < 2 * 86400e3 && rnd() < 0.5;
    if (!stillOpen) {
      if (pr && opened) put(p, 'pr.merge', { repo: p.repo, number: pr, branch }, tick(), { via: 'fleet-merged' });
      put(p, 'request.state', { req: `${session}/1`, state: 'done', text: task.slice(0, 80), ...(pr && opened ? { proof: `https://github.com/${p.repo}/pull/${pr}` } : { proof: 'checked by hand' }) }, tick(), mod);
      put(p, 'session.end', { reason: 'exit' }, tick(), src);
      put(p, 'retire', { worker, branch, repo: p.repo, reason: 'reclaim' }, tick(), { via: 'retire' });
    }
    if (rnd() < 0.05) put(p, 'request.open', { req: `${leadSession}/${n}`, text: `${words(int(5, 30))}?`, source: 'user', state: 'open' }, tick(), { via: 'mod', session: leadSession, slot: 'master' });
  }
  flush(Infinity);
  for (const fd of Object.values(logs)) fs.closeSync(fd);
  const sizes = Object.values(dirs).map(d => fs.statSync(path.join(d, K.LOG)).size);
  process.stdout.write(JSON.stringify({ events: made, projects: projects.length, sessions: sessionNo, bytes: sizes.reduce((a, b) => a + b, 0), busiest: projects[0].name }) + '\n');
}

// ── time ──────────────────────────────────────────────────────────────────
async function timeIt() {
  if (!fs.existsSync(MARK)) die(`${home} was not made by gen`);
  const root = path.resolve(flag('root', ROOT));
  const runs = Number(flag('runs', 5));
  const know = (...args) => { const a = process.hrtime.bigint(); const r = spawnSync('node', [path.join(root, 'bin', 'fleet-know.mjs'), ...args], { env: cleanEnv(), encoding: 'utf8', maxBuffer: 1 << 28 }); return { ms: Number(process.hrtime.bigint() - a) / 1e6, status: r.status, err: r.stderr }; };
  const median = (args) => {
    const ms = [];
    for (let i = 0; i < runs; i++) { const r = know(...args); if (r.status) return `exit ${r.status}: ${String(r.err).split('\n')[0]}`; ms.push(r.ms); }
    return Math.round(ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)]);
  };
  const out = {};
  // rebuild first: it times the fold, and leaves the snapshot this checkout's reads expect.
  out.rebuild = median(['rebuild']);
  out.brief = median(['acme-api', '--no-sync']);
  out.waiting = median(['waiting', '--no-sync']);
  out.find = median(['find', 'webhook', 'backoff', '--no-sync']);
  out.touched = median(['touched', 'src/export/csv.js', '--no-sync']);
  // A fleet at work has always written something since the last read, so this is the read a lead
  // usually gets: a line has settled past the snapshot, and it folds and saves before answering.
  const K = await import(path.join(root, 'lib', 'know.mjs'));
  const log = path.join(home, '.claude', 'fleet', K.LOG);
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t = Date.now() - K.SETTLE_MS - 1000;
    fs.appendFileSync(log, JSON.stringify(K.makeEvent({ t, rec: t, kind: 'turn.end', machine: 'laptop', profile: 'work', project: 'acme-api', src: { via: 'hook', session: 's-bench', slot: 'master' }, f: { status: 'done', said: `a turn at ${t}` } })) + '\n');
    ms.push(know('acme-api', '--no-sync').ms);
  }
  out.afterAppend = Math.round(ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)]);
  process.stdout.write(JSON.stringify(out) + '\n');
}

// ── cpu ───────────────────────────────────────────────────────────────────
// What the suite bounds. HOME is this process's own, so the caller sets it (and clears the
// fleet variables): a read in here answers from that HOME and nowhere else.
async function cpu() {
  if (!fs.existsSync(MARK)) die(`${home} was not made by gen`);
  if (path.resolve(process.env.HOME || '') !== home) die('set HOME to <home>, so nothing here can read a live log');
  const root = path.resolve(flag('root', ROOT));
  const K = await import(path.join(root, 'lib', 'know.mjs'));
  const spent = async (fn) => { const a = process.cpuUsage(); await fn(); const c = process.cpuUsage(a); return Math.round((c.user + c.system) / 1000); };
  const out = {};
  out.rebuild = await spent(() => { for (const d of K.allFleetDirs()) K.rebuild(d); });
  let v;
  out.view = await spent(async () => { v = await K.view({ sync: false }); });
  out.brief = await spent(() => K.brief(v, 'acme-api'));
  out.waiting = await spent(() => K.waiting(v));
  out.touched = await spent(() => K.touched(v, 'src/export/csv.js'));
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (verb === 'gen') await gen(Number(rest[0]) || die('gen <home> <events>'));
else if (verb === 'time') await timeIt();
else if (verb === 'cpu') await cpu();
else die(`unknown verb ${verb}`);
