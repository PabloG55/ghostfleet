// The fleet's memory (docs/MEMORY.md), checked end to end: every path that writes an event,
// the graph derived from them, the reader, the privacy switch, the MCP tool and what the Stop
// hook pays. Prints one row per check — `name \x1f want \x1f got` — which test/run.sh's
// group replays as `is` rows, the way pair-check.mjs does.
//
//   node test/helpers/know-check.mjs <scratch dir>
//
// Everything lives under the scratch dir: a fixture HOME for the reader (know-fixture.mjs),
// and a second one with a real git repo for the writers, under the suite's own TMUX_TMPDIR.
// Every check stands beside its opposite (an owner's prompt that lands beside a notice that
// does not, an edit that succeeded beside one that failed, include beside exclude), because a
// row that can only pass proves nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(DIR).isDirectory()) { console.error('usage: know-check.mjs <scratch dir>'); process.exit(2); }
const KNOW = path.join(ROOT, 'bin', 'fleet-know.mjs');
const WRITER = path.join(ROOT, 'bin', 'fleet-know-event');

const rows = [];
const row = (name, want, got) => rows.push([name, String(want), String(got).replace(/[\n\r\x1f]+/g, ' ')]);
const yes = (b) => (b ? 'yes' : 'no');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; sleep(40); } return pred(); };

// The suite's environment minus every fleet variable, so nothing here can reach a real fleet
// dir, profile or socket; the run's own TMUX_TMPDIR is kept, which is the namespace it owns.
function base() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_FLEET_|GHOSTFLEET_)/.test(k) && k !== 'CLAUDE_FLEET_EXPERIMENTAL_DIR') continue;
    if (['CLAUDE_CONFIG_DIR', 'CLAUDE_JOB_DIR', 'TMUX', 'TMUX_PANE'].includes(k)) continue;
    e[k] = v;
  }
  e.CLAUDE_FLEET_KNOW_MACHINE = 'laptop';
  return e;
}
const run = (cmd, args, { home, env = {}, cwd, input } = {}) =>
  spawnSync(cmd, args, { cwd, input, encoding: 'utf8', timeout: 30000, env: { ...base(), HOME: home, ...env } });
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const section = async (name, fn) => { try { await fn(); } catch (e) { row(`${name}: ran to the end`, 'yes', `threw: ${e && e.message}`); } };

// ══ the reader, on the fixture fleet ══════════════════════════════════════════
const FX = path.join(DIR, 'fx');
const WORK = path.join(FX, '.claude', 'fleet');
const PERSONAL = path.join(FX, '.claude-personal', 'fleet');
const fx = run('node', [path.join(ROOT, 'test', 'helpers', 'know-fixture.mjs'), FX], { home: FX });
const T0 = Number(String(fx.stdout).trim());
row('the fixture fleet builds', 'yes', yes(fx.status === 0 && T0 > 0));
const m = (n) => T0 + n * 60_000;
const iso = (t) => new Date(t).toISOString();
const know = (args, { now = m(120), env = {} } = {}) => run('node', [KNOW, ...args], { home: FX, env: { CLAUDE_FLEET_NOW_MS: String(now), ...env } });
const knowJ = (args, o) => { const r = know([...args, '--json'], o); try { return JSON.parse(r.stdout); } catch { return {}; } };
process.env.HOME = FX;                         // for the in-process reads of lib/know.mjs below
process.env.CLAUDE_FLEET_KNOW_MACHINE = 'laptop';
const K = await import(path.join(ROOT, 'lib', 'know.mjs'));

await section('brief', () => {
  const r = know(['acme-api']);
  const b = r.stdout;
  row('brief: answers', '0', r.status);
  row('brief: says what the project is', 'yes', yes(/what it is +The public REST API behind acme-web/.test(b)));
  row('...what it depends on and what uses it', 'yes', yes(/depends on +billing-svc · used by acme-web/.test(b)));
  row('...the live sessions, the one that needs you first', 'yes', yes(/WHERE IT STANDS\n {2}master +need-you/.test(b)));
  row('...the open branch with its PR', 'yes', yes(/branch docs\/setup-pass \(docs-pass\) → PR #1184 open/.test(b)));
  row('...the PR that merged', 'yes', yes(/PR #1170 merged \(fix\/csv-export\)/.test(b)));
  row('...the last deploy, at its commit', 'yes', yes(/last deploy .*vercel deploy --prod at a1b2c3d4 \(master\)/.test(b)));
  row('...three things waiting on the owner', '3', (b.match(/^ {2}waits on you:/gm) || []).length);
  row('...a decision, with where it came from', 'yes', yes(/Keep the v1 export endpoint until acme-web moves to v2 — acme-web still calls \/v1\/export +\[stated, 2026-03-05\]/.test(b)));
  row('...and the worker\'s, from its ack', 'yes', yes(/RFC 4180 quoting; no new dependency .*\[ack, 2026-03-05\]/.test(b)));
  // DECAY: closed eleven days before the instant asked about — counted, never listed
  row('...an old closed request is counted, not listed', 'counted, listed 0',
    `${/^EARLIER +1 closed request since/m.test(b) ? 'counted' : 'not counted'}, listed ${(b.match(/Rotate the staging/g) || []).length}`);
  row('...on one page', 'yes', yes(b.split('\n').length <= 40));
  const j = knowJ(['acme-api']);
  row('...and as JSON, the same project', 'acme-api laptop work', `${j.project} ${j.machine} ${j.profile}`);
  row('...whose branch carries its PR, not the graph node behind it', '1184 no-history',
    `${j.branches && j.branches[0] && j.branches[0].pr && j.branches[0].pr.number} ${JSON.stringify(j.branches || []).includes('"h":') ? 'history' : 'no-history'}`);
  row('an excluded project has no brief', '1', know(['toolbox']).status);
  const s = know(['scratch']);
  row('a private project still has one, for this machine', '0', s.status);
  row('...marked private', 'yes', yes(/private/.test(s.stdout.split('\n')[0])));
  row('...and its JSON tells a lead not to pass it on', 'yes', yes(/do not paste them into a prompt/.test(knowJ(['scratch']).note || '')));
  const w = know(['waiting']).stdout;
  row('waiting: the need-you, the PR on review and the waiting request', 'yes yes yes',
    `${yes(/master needs you/.test(w))} ${yes(/PR #1184/.test(w))} ${yes(/Which plan tier/.test(w))}`);
  row('...and nothing that is not waiting', 'no', yes(/#1170/.test(w)));
  const o = know([]).stdout;
  row('the overview lists what is recorded, private marked, excluded absent', 'yes yes no',
    `${yes(/acme-api/.test(o) && /acme-web/.test(o))} ${yes(/scratch.*private/.test(o))} ${yes(/toolbox/.test(o))}`);
});

await section('--at', () => {
  const j30 = knowJ(['acme-api', '--at', iso(m(30))]);
  const fix = (j30.sessions || []).find(x => x.slot === 'api-fix');
  row('--at before the merge: the worker is live and working', 'working', fix ? fix.status : 'absent');
  const br = (j30.branches || []).find(x => x.name === 'fix/csv-export');
  row('...on its branch, with no PR yet', 'none', br ? (br.pr ? `#${br.pr.number}` : 'none') : 'no branch');
  row('...its request open', 'yes', yes((j30.openRequests || []).some(x => /Fix the CSV export/.test(x.text))));
  row('...and the decision it acked', 'yes', yes((j30.decisions || []).some(d => /RFC 4180/.test(d.text))));
  row('...and nothing from after it', 'no', yes(JSON.stringify(j30).includes('1184')));
  const j45 = knowJ(['acme-api', '--at', iso(m(45))]);
  row('--at between the open and the merge: PR #1170 is open', 'yes', yes((j45.openPrs || []).some(p => p.number === 1170)));
  const jn = knowJ(['acme-api']);
  row('...and now it is merged, and the worker retired', 'merged absent',
    `${((jn.recentPrs || []).find(p => p.number === 1170) || {}).state} ${(jn.sessions || []).some(x => x.slot === 'api-fix') ? 'live' : 'absent'}`);
  // the edge itself: closed by the merge, never deleted
  const g = K.snapshot(WORK).graph;
  const e = Object.values(g.edges).find(x => x.type === 'has-pr' && x.to === K.prId('acme/acme-api', 1170));
  row('the branch→PR edge is closed by the merge, not deleted', 'open,close', e ? e.m.map(x => x[1]).join(',') : 'no edge');
  row('...it holds before the merge', 'true', e && K.holds(e, m(45)));
  row('...not after', 'false', e && K.holds(e, m(61)));
  row('...and as KNOWN before the merge was recorded, it still holds', 'true', e && K.holds(e, m(120), m(50)));
  const jk = knowJ(['acme-api', '--known-at', iso(m(50))]);
  row('--known-at before the merge: the brief still has it open', 'yes', yes((jk.openPrs || []).some(p => p.number === 1170)));
  const t45 = know(['touched', 'src/export/csv.js', '--at', iso(m(45))]).stdout;
  const tn = know(['touched', 'src/export/csv.js']).stdout;
  row('touched: both projects\' sessions that edited the file', 'yes yes', `${yes(/api-fix/.test(tn))} ${yes(/acme-web/.test(tn))}`);
  row('...the PR the work went into, open then and merged now', 'open merged',
    `${/PR #1170 open/.test(t45) ? 'open' : '?'} ${/PR #1170 merged/.test(tn) ? 'merged' : '?'}`);
  row('...and a file nobody touched names nobody', 'no', yes(/api-fix|acme-web/.test(know(['touched', 'src/nothing.js']).stdout)));
});

await section('find', () => {
  const f = know(['find', 'invoice', 'replay']).stdout;
  row('find reaches what only the raw log holds', 'yes', yes(/nightly invoice replay/.test(f)));
  row('...which the graph does not hold', 'no', yes(fs.readFileSync(path.join(WORK, K.SNAP), 'utf8').includes('invoice replay')));
  row('...a word nobody wrote finds nothing', '0', (knowJ(['find', 'zebra-quartz']).rows || ['?']).length);
  row('...and private text it finds is marked', 'yes', yes(/private/.test(know(['find', 'streaming', 'parser']).stdout)));
  row('...while an excluded project\'s text is not found at all', '0', (knowJ(['find', 'toolbox', 'prompt']).rows || ['?']).length);
});

await section('rebuild', () => {
  row('rebuild --check: the snapshot matches the log', '0', know(['rebuild', '--check']).status);
  // folded in three reads, as a live fleet folds it, against one fold of the whole log
  const inc = path.join(DIR, 'inc');
  fs.mkdirSync(inc, { recursive: true });
  const all = fs.readFileSync(path.join(WORK, K.LOG), 'utf8').split('\n').filter(Boolean);
  // One line held back and appended LAST, after everything newer than it has been folded: a
  // request's OPEN, landing behind its own close — the mod fires its ledger writes together,
  // and a carried item keeps the time it was asked. Folded on top, the close had found no edge
  // to close and the open then opens one for good; folded in its place, it is open between
  // the two and closed now.
  const late = all.findIndex(l => /"request\.open"/.test(l) && /s-apifix\/1/.test(l));
  const rest = all.filter((_, i) => i !== late);
  const third = Math.ceil(rest.length / 3);
  for (let i = 0; i < rest.length; i += third) {
    fs.appendFileSync(path.join(inc, K.LOG), rest.slice(i, i + third).join('\n') + '\n');
    K.snapshot(inc);
  }
  const edge = (g) => g.edges[`request-in|request:s-apifix/1|${K.projectId({ machine: 'laptop', profile: 'work', project: 'acme-api' })}`];
  row('a request whose close landed before its open has no edge yet', 'absent', edge(K.snapshot(inc).graph) ? 'present' : 'absent');
  fs.appendFileSync(path.join(inc, K.LOG), all[late] + '\n');
  const ig = K.snapshot(inc).graph;
  row('...and when the open lands, behind newer lines, it folds into its place: open then, closed now', 'true false',
    `${K.holds(edge(ig), m(10))} ${K.holds(edge(ig))}`);
  const a = JSON.stringify(ig);
  const b = JSON.stringify(K.rebuild(inc, { save: false }).graph);
  row('a snapshot folded in three reads and a late line is the same as one rebuild', 'same', a === b ? 'same' : `differs (${a.length} vs ${b.length} bytes)`);
  // and out of order — a paired peer's events arrive whenever they are fetched
  const shuf = path.join(DIR, 'shuf');
  fs.mkdirSync(shuf, { recursive: true });
  fs.writeFileSync(path.join(shuf, K.LOG), [...all].reverse().join('\n') + '\n');
  row('...and the same when the log is in another order', 'same', JSON.stringify(K.rebuild(shuf, { save: false }).graph) === b ? 'same' : 'differs');
  const sf = path.join(WORK, K.SNAP);
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  delete s.graph.nodes[K.prId('acme/acme-api', 1170)];
  fs.writeFileSync(sf, JSON.stringify(s));
  row('a damaged snapshot is caught by --check', '1', know(['rebuild', '--check']).status);
  know(['rebuild']);
  row('...and rebuild repairs it', '0', know(['rebuild', '--check']).status);
  row('...so the brief has the merge again', 'yes', yes(/PR #1170 merged/.test(know(['acme-api']).stdout)));
});

await section('privacy', async () => {
  const w = lines(path.join(WORK, K.LOG)), p = lines(path.join(PERSONAL, K.LOG));
  row('exclude: toolbox wrote nothing', '0', w.filter(e => e.project === 'toolbox').length);
  row('...while acme-api beside it did', 'yes', yes(w.filter(e => e.project === 'acme-api').length > 10));
  row('private: scratch is recorded, every event marked', '2 private', `${p.length} ${[...new Set(p.map(e => e.priv))].join(',')}`);
  const n0 = lines(path.join(WORK, K.LOG)).length;
  const spawnTb = () => run(WRITER, ['spawn', `fleet=${WORK}`, 'sock=cf-toolbox', 'worker=tb-1', 'branch=feat/tb'], { home: FX });
  spawnTb();
  row('the writer refuses an excluded project at the command line too', '0', lines(path.join(WORK, K.LOG)).length - n0);
  know(['privacy', 'toolbox', 'include']);
  spawnTb();
  row('...and records it once it is include', '1', lines(path.join(WORK, K.LOG)).length - n0);
  know(['privacy', 'toolbox', 'exclude']);
  row('...and back to exclude, its events leave every answer', '1', know(['toolbox']).status);
  // the gate the mod asks before it calls a model, answered by the writer's own code
  fs.writeFileSync(path.join(PERSONAL, 's-scr.json'), JSON.stringify({ session_id: 's-scr', sock: 'cf-personal-scratch', slot: 'master', ts: 1 }));
  fs.writeFileSync(path.join(WORK, 's-master.json'), JSON.stringify({ session_id: 's-master', sock: 'cf-acme-api', slot: 'master', ts: 1 }));
  fs.writeFileSync(path.join(WORK, 's-tool.json'), JSON.stringify({ session_id: 's-tool', sock: 'cf-toolbox', slot: 'master', ts: 1 }));
  const asks = (sid, dir) => String(run(WRITER, ['privacy', `session=${sid}`, `fleet=${dir}`], { home: FX }).stdout).trim();
  row('the privacy the mod asks: scratch, acme-api, toolbox', 'private include exclude',
    `${asks('s-scr', PERSONAL)} ${asks('s-master', WORK)} ${asks('s-tool', WORK)}`);
  // the inferred pass, on a stub that counts: only `include` with the switch on reaches it
  const { inferFacts } = await import(path.join(ROOT, 'mods', 'ghostfleet', 'hooks', 'know-shape.js'));
  let calls = 0;
  const call = async () => { calls++; return { isAnswered: true, text: '[{"text":"Quote every field that holds a comma"}]' }; };
  const cases = [[true, 'include', 1], [true, 'private', 0], [true, 'exclude', 0], [true, '', 0], [false, 'include', 0]];
  const got = [];
  for (const [enabled, mode] of cases) { calls = 0; await inferFacts({ enabled, mode, turn: 'We settled on quoting.', call }); got.push(calls); }
  row('the inferred pass calls the model for include+on only (include, private, exclude, unknown, off)', cases.map(c => c[2]).join(' '), got.join(' '));
  // and a fact handed to the writer for a project that is not include is refused there too
  const facts = JSON.stringify([{ text: 'Use a ring buffer for the chunks', why: 'bounded memory' }]);
  const p0 = lines(path.join(PERSONAL, K.LOG)).length, w0 = lines(path.join(WORK, K.LOG)).length;
  run(WRITER, ['infer', 'session=s-scr', `fleet=${PERSONAL}`, 'turn=t-scr'], { home: FX, input: facts });
  run(WRITER, ['infer', 'session=s-master', `fleet=${WORK}`, 'turn=t-api'], { home: FX, input: facts });
  const last = lines(path.join(WORK, K.LOG)).pop() || {};
  row('the writer refuses an inferred fact for a private project, records one for include', '0 1',
    `${lines(path.join(PERSONAL, K.LOG)).length - p0} ${lines(path.join(WORK, K.LOG)).length - w0}`);
  row('...marked inferred and linked to its turn', 'decision true t-api', `${last.kind} ${last.f && last.f.inferred} ${last.f && last.f.turn}`);
});

// ══ the writers, each from its own path, in a second HOME with a real repo ═══════════
const SRC = path.join(DIR, 'src');
const H = path.join(SRC, 'home');
const REPO = path.join(SRC, 'repo');
const LINK = path.join(SRC, 'link');               // -> REPO, made below
// The work profile's own fleet dir, not a free-standing one: the repo is registered as acme-api
// on that profile, and fleet-spawn and fleet-stop write where the project's profile lives.
const FL = path.join(H, '.claude', 'fleet');
const SB = path.join(SRC, 'bin');
for (const d of [path.join(H, '.config', 'ghostfleet'), path.join(H, '.claude'), FL, SB, path.join(REPO, 'src', 'export')]) fs.mkdirSync(d, { recursive: true });
const git = (...a) => run('git', ['-C', REPO, ...a], { home: H });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(REPO, 'src', 'export', 'csv.js'), 'export const csv = 1;\n');
git('add', '-A'); git('commit', '-qm', 'init');
git('remote', 'add', 'origin', 'git@github.com:acme/acme-api.git');
fs.symlinkSync(REPO, LINK);
fs.writeFileSync(path.join(H, '.config', 'ghostfleet', 'projects'), `acme-api\t${REPO}\twork\n`);
const LOGF = path.join(FL, K.LOG);
const evs = (kind, via) => lines(LOGF).filter(e => e.kind === kind && (!via || (e.src && e.src.via === via)));

await section('hook', () => {
  const env = { CLAUDE_FLEET_DIR: FL, CLAUDE_CONFIG_DIR: path.join(H, '.claude'), CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'api-fix', CLAUDE_FLEET_NOTIFIER: 'off' };
  const hook = (p) => run('bash', [path.join(ROOT, 'hooks', 'fleet-event.sh')], { home: H, env, input: JSON.stringify({ session_id: 's-1', cwd: REPO, ...p }) });
  hook({ hook_event_name: 'SessionStart', source: 'startup' });
  waitFor(() => evs('session.start').length >= 1);
  const ss = evs('session.start');
  row('hook: SessionStart lands once', '1', ss.length);
  row('...with its provenance: who wrote it, the session, its slot, the repo', 'hook s-1 api-fix acme/acme-api',
    ss[0] ? `${ss[0].src.via} ${ss[0].src.session} ${ss[0].src.slot} ${ss[0].f.repo}` : 'none');
  hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>a background job finished</task-notification>' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the CSV export: a quoted comma splits one row' });
  waitFor(() => evs('prompt').length >= 1); sleep(600);
  const pr = evs('prompt');
  row('hook: the owner\'s prompt lands, the fleet\'s own notice does not', '1 Fix the CSV export', `${pr.length} ${pr[0] ? pr[0].f.text.slice(0, 18) : ''}`);
  const TR = path.join(SRC, 't.jsonl');
  const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, err) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(err ? { is_error: true } : {}) }] } });
  fs.writeFileSync(TR, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the CSV export' } }),
    use('u1', 'Edit', { file_path: path.join(REPO, 'src', 'export', 'csv.js'), old_string: '1', new_string: '2' }), res('u1', 'ok'),
    use('u2', 'Edit', { file_path: path.join(REPO, 'src', 'never.js'), old_string: 'a', new_string: 'b' }), res('u2', 'File does not exist', true),
    use('u3', 'Bash', { command: 'git push -u origin fix/csv && gh pr create --fill' }), res('u3', 'https://github.com/acme/acme-api/pull/1170'),
    // the checkout named through a symlink, the way a session that cd'd into /tmp names it on
    // a Mac — and a file deleted since, so nothing of the path resolves but a prefix of it
    use('u4', 'Write', { file_path: path.join(LINK, 'src', 'gone.js'), content: 'x' }), res('u4', 'ok'),
  ].join('\n') + '\n');
  const stop = () => hook({ hook_event_name: 'Stop', transcript_path: TR, last_assistant_message: 'Opened PR #1170.' });
  stop();
  waitFor(() => evs('turn.end').length >= 1);
  const t1 = evs('turn.end')[0] || { f: {} };
  row('hook: a Stop lands its turn — the edits that worked, not the one that failed, and the PR', 'src/export/csv.js,src/gone.js #1170',
    `${(t1.f.files || []).join(',')} #${(t1.f.prs || []).map(p => p.number).join(',')}`);
  stop();
  waitFor(() => evs('turn.end').length >= 2);
  const ts = evs('turn.end');
  row('...and a second Stop over the same transcript counts them once', '2 turns, 2 files, 1 PR',
    `${ts.length} turns, ${ts.flatMap(t => t.f.files || []).length} files, ${ts.flatMap(t => t.f.prs || []).length} PR`);
  hook({ hook_event_name: 'SessionEnd', reason: 'exit' });
  waitFor(() => evs('session.end').length >= 1, 5000);
  row('hook: SessionEnd lands once, and the cursor goes with it', '1 gone',
    `${evs('session.end').length} ${fs.existsSync(path.join(FL, 's-1.knowline')) ? 'kept' : 'gone'}`);
  const off = run('bash', [path.join(ROOT, 'hooks', 'fleet-event.sh')], { home: H, env: { ...env, CLAUDE_FLEET_KNOW: 'off' }, input: JSON.stringify({ session_id: 's-2', cwd: REPO, hook_event_name: 'SessionStart' }) });
  sleep(1200);
  row('CLAUDE_FLEET_KNOW=off: the hook records nothing', '0', `${lines(LOGF).filter(e => e.src && e.src.session === 's-2').length}${off.status ? ` (hook exit ${off.status})` : ''}`);
});

let WT = '';
await section('spawn, ack, stop', () => {
  const AG = path.join(SRC, 'agent');
  fs.mkdirSync(AG, { recursive: true });
  fs.writeFileSync(path.join(AG, 'agent-here'), '#!/usr/bin/env bash\nsleep 60\n', { mode: 0o755 });
  // The repo is registered as acme-api, so fleet-spawn routes the worker to that project's
  // socket whatever the ambient one says — the path a real spawn takes. A server of the run's
  // own TMUX_TMPDIR, killed at the end of the section.
  const env = { CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_DIR: FL, CLAUDE_FLEET_SLOTS: path.join(SRC, 'slots'), PATH: `${AG}:${ROOT}/bin:${process.env.PATH}` };
  try {
    const sp = run(path.join(ROOT, 'bin', 'fleet-spawn'), ['w1', '--new'], { cwd: REPO, home: H, env });
    const s = evs('spawn');
    row('spawn: lands once', '1', `${s.length}${sp.status ? ` (spawn exit ${sp.status}: ${String(sp.stderr).split('\n').slice(-2).join(' ')})` : ''}`);
    const f = (s[0] || {}).f || {};
    WT = f.worktree || '';
    row('...with its provenance: the writer, the worker, its branch, the worktree it made', 'spawn w1 w1 worktree',
      `${(s[0] || { src: {} }).src.via} ${f.worker} ${f.branch} ${WT && fs.existsSync(WT) ? 'worktree' : 'no-worktree'}`);
    const ack = run(path.join(ROOT, 'bin', 'fleet-ack'), ['a quote-aware CSV writer', '--from', 'RFC 4180 quoting'], { cwd: WT || REPO, home: H, env });
    const a = evs('ack');
    row('ack: lands once, with what the worker builds from', '1 w1 RFC 4180 quoting', `${a.length} ${(a[0] || { f: {} }).f.worker} ${(a[0] || { f: {} }).f.decisions}${ack.status ? ` (ack exit ${ack.status})` : ''}`);
    run(path.join(ROOT, 'bin', 'fleet-stop'), ['-s', 'cf-acme-api', 'w1'], { home: H, env });
    const r = evs('retire');
    // literals, not the spawn event's fields: with spawn's writer broken this row still asks
    // only what fleet-stop wrote
    row('stop: lands a retire once, for the worker and its branch', '1 w1 w1 stop',
      `${r.length} ${(r[0] || { f: {} }).f.worker} ${(r[0] || { f: {} }).f.branch} ${(r[0] || { f: {} }).f.reason}`);
  } finally {
    run('tmux', ['-L', 'cf-acme-api', 'kill-server'], { home: H });
  }
});

await section('fleet-merged', () => {
  const cache = path.join(FL, 'prs.acme_acme-api');
  fs.writeFileSync(cache, 'fix/csv-export\x1f1170\x1fOPEN\n');
  fs.writeFileSync(path.join(SB, 'gh'), '#!/bin/sh\ncase "$*" in *"--state merged"*) printf \'fix/csv-export\\0371170\\037MERGED\\ndocs/typo\\0371171\\037MERGED\\n\' ;; esac\nexit 0\n', { mode: 0o755 });
  const fm = () => run(path.join(ROOT, 'bin', 'fleet-merged'), [REPO], { home: H, env: { CLAUDE_FLEET_DIR: FL, CLAUDE_FLEET_MERGED_TTL: '0', PATH: `${SB}:${process.env.PATH}` } });
  fm();
  const mg = evs('pr.merge', 'fleet-merged').filter(e => e.f.number === 1170);
  row('fleet-merged: a merge between two refreshes lands once', '1 1170 acme/acme-api', `${mg.length} ${(mg[0] || { f: {} }).f.number} ${(mg[0] || { f: {} }).f.repo}`);
  const n0 = lines(LOGF).length;
  fm();
  row('...and a refresh that changed nothing adds nothing', '0', lines(LOGF).length - n0);
  // #1171 was opened and merged between two refreshes, so its first sighting is the merge —
  // one event that opens the PR node and merges it, which once left it reading open
  const n71 = K.rebuild(FL, { save: false }).graph.nodes[K.prId('acme/acme-api', 1171)];
  row('...a PR first seen already merged reads merged, now and --at', 'merged merged', `${K.attr(n71, 'state')} ${K.val(n71, 'state', Date.now() + 60_000)}`);
});

await section('ledger', async () => {
  const L = await import(path.join(ROOT, 'mods', 'ghostfleet', 'hooks', 'ledger.js'));
  const rec = (sid, slot) => fs.writeFileSync(path.join(FL, `${sid}.json`), JSON.stringify({ session_id: sid, sock: 'cf-acme-api', slot, ts: 10 }));
  rec('s-led', 'docs-pass');                     // the hook section's sessions are api-fix
  fs.writeFileSync(L.ledgerFile(FL, 's-led'), JSON.stringify(L.addItem(L.emptyLedger(), { text: 'Fix the CSV export', at: Date.now(), source: 'user' })));
  const fl = (...a) => run(path.join(ROOT, 'bin', 'fleet-ledger'), ['-s', 'cf-acme-api', 'docs-pass', ...a], { home: H, env: { CLAUDE_FLEET_DIR: FL } });
  fl('close', '1', 'https://github.com/acme/acme-api/pull/1170');
  const c = evs('request.state', 'fleet-ledger');
  row('fleet-ledger: a close lands once, with its proof and session', '1 done s-led https://github.com/acme/acme-api/pull/1170',
    `${c.length} ${(c[0] || { f: {} }).f.state} ${(c[0] || { src: {} }).src.session} ${(c[0] || { f: {} }).f.proof}`);
  const n = lines(LOGF).length;
  fl();
  row('...and a read writes nothing', '0', lines(LOGF).length - n);
  // the mod's path: what applyLedger hands the writer after each write
  run(WRITER, ['ledger', 'session=s-led', `fleet=${FL}`, 'via=mod'], { home: H, input: JSON.stringify([{ op: 'open', id: '2', text: 'Add a rate limit', source: 'user', state: 'open', t: Date.now() }]) });
  row('the mod\'s ledger call lands once', '1 s-led/2', `${evs('request.open', 'mod').length} ${(evs('request.open', 'mod')[0] || { f: {} }).f.req}`);
  const reg = fs.readFileSync(path.join(ROOT, 'mods', 'ghostfleet', 'hooks', 'register.js'), 'utf8');
  row('...and applyLedger makes it after the rename', 'yes', yes(/moved\.exitCode !== 0\) return null\n\s*knowLedger\(\$, dir, file, ledgerChanges\(cur, next\)\)/.test(reg)));
  // the carry at a worker's stop, and the close when the carried work merges
  rec('s-w2', 'w2'); rec('s-m', 'master');
  fs.writeFileSync(L.ledgerFile(FL, 's-w2'), JSON.stringify(L.addItem(L.emptyLedger(), { text: 'Write the migration note', at: Date.now(), source: 'user' })));
  fs.writeFileSync(L.ledgerFile(FL, 's-m'), JSON.stringify(L.emptyLedger()));
  run('node', [path.join(ROOT, 'lib', 'ledger-carry.mjs'), FL, 'cf-acme-api', 'w2', 'master', 'feat/notes', 'OPEN 1190'], { home: H });
  const cr = evs('request.open', 'ledger-carry');
  row('ledger-carry: the carried item lands once, in the lead\'s ledger', '1 s-m', `${cr.length} ${(cr[0] || { src: {} }).src.session}`);
  fs.writeFileSync(path.join(SB, 'merged-stub'), '#!/bin/sh\nprintf \'feat/notes\\0371190\\037MERGED\\n\'\n', { mode: 0o755 });
  run('node', [path.join(ROOT, 'lib', 'ledger-landed.mjs'), FL, 'cf-acme-api', 'master', path.join(SB, 'merged-stub'), 'acme/acme-api'], { home: H });
  const ld = evs('request.state', 'ledger-landed');
  row('ledger-landed: its close lands once when the PR merges', '1 done', `${ld.length} ${(ld[0] || { f: {} }).f.state}`);
});

// ══ what the Stop hook pays: the writer runs, and the hook does not wait for it ═══════════
// The property, not a number: a copy of the hook beside a writer that sleeps three seconds.
// If the hook waited (no `&`, or the writer holding the hook's stdout open), the Stop would
// take the three seconds; detached, it takes what the hook always took.
await section('budget', () => {
  const T = path.join(DIR, 'hb');
  fs.mkdirSync(path.join(T, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(T, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'hooks', 'fleet-event.sh'), path.join(T, 'hooks', 'fleet-event.sh'));
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(T, 'lib'));
  for (const b of fs.readdirSync(path.join(ROOT, 'bin'))) if (b !== 'fleet-know-event') fs.symlinkSync(path.join(ROOT, 'bin', b), path.join(T, 'bin', b));
  const mark = path.join(T, 'WRITER_STARTED');
  fs.writeFileSync(path.join(T, 'bin', 'fleet-know-event'), `#!/bin/sh\n: > '${mark}'\nsleep 3\n`, { mode: 0o755 });
  const env = { CLAUDE_FLEET_DIR: FL, CLAUDE_CONFIG_DIR: path.join(H, '.claude'), CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'api-fix', CLAUDE_FLEET_NOTIFIER: 'off' };
  const stop = (extra = {}) => {
    const a = Date.now();
    run('bash', [path.join(T, 'hooks', 'fleet-event.sh')], { home: H, env: { ...env, ...extra }, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's-hb', cwd: REPO, last_assistant_message: 'done' }) });
    return Date.now() - a;
  };
  const ms = stop();
  row('a Stop whose writer takes 3s still returns well inside it', 'yes', ms < 2000 ? 'yes' : `no: ${ms}ms`);
  row('...because the writer was started, detached', 'yes', yes(waitFor(() => fs.existsSync(mark), 3000)));
  fs.rmSync(mark, { force: true });
  stop({ CLAUDE_FLEET_KNOW: 'off' });
  sleep(800);
  row('...and with CLAUDE_FLEET_KNOW=off it is not started at all', 'no', yes(fs.existsSync(mark)));
});

// ══ the MCP tool, through the real server ════════════════════════════════════════
await section('mcp', async () => {
  const calls = [
    { method: 'tools/list', params: {} },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { about: 'acme-api' } } },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { waiting: true } } },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { find: 'invoice replay' } } },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { touched: 'src/export/csv.js', at: iso(m(45)) } } },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { about: 'acme-api', json: true } } },
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { about: '-rf' } } },
  ];
  const ch = spawn('node', [path.join(ROOT, 'mcp', 'fleet-mcp.mjs')], {
    env: { ...base(), HOME: FX, CLAUDE_FLEET_SOCK: 'cfmcpknow', CLAUDE_FLEET_NOW_MS: String(m(120)) }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const got = new Map();
  let buf = '';
  ch.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); if (o.id != null) got.set(o.id, o); } catch {} }
  });
  ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) + '\n');
  calls.forEach((c, i) => ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c }) + '\n'));
  const end = Date.now() + 25000;
  while (got.size < calls.length + 1 && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  ch.kill();
  const text = (i) => { const r = (got.get(i) || {}).result || {}; return ((r.content || [])[0] || {}).text || ''; };
  const err = (i) => !!((got.get(i) || {}).result || {}).isError;
  const tools = (((got.get(1) || {}).result || {}).tools || []);
  const t = tools.find(x => x.name === 'fleet_know');
  row('MCP: fleet_know is listed, needing no argument', 'yes', yes(t && !(t.inputSchema.required || []).length));
  row('...about: answers with the brief', 'yes yes no', `${yes(/WHERE IT STANDS/.test(text(2)))} ${yes(/PR #1184 open/.test(text(2)))} ${yes(err(2))}`);
  row('...waiting: what waits on the owner', 'yes', yes(/master needs you/.test(text(3))));
  row('...find: the raw log', 'yes', yes(/nightly invoice replay/.test(text(4))));
  row('...touched, at a past time', 'yes', yes(/PR #1170 open/.test(text(5))));
  row('...json: data', 'acme-api', (() => { try { return JSON.parse(text(6)).project; } catch (e) { return `not json: ${text(6).slice(0, 60)}`; } })());
  row('...and a flag where a name goes is refused, not run', 'yes', yes(err(7)));
});

for (const r of rows) process.stdout.write(r.join('\x1f') + '\n');
