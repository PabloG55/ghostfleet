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
  row('...the last deploy, at its commit', 'yes', yes(/last deploy .*vercel deploy at a1b2c3d4 \(master\)/.test(b)));
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
  // The writer is detached and removes the cursor after the line lands, so ask for each in turn.
  waitFor(() => !fs.existsSync(path.join(FL, 's-1.knowline')), 3000);
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
    { method: 'tools/call', params: { name: 'fleet_know', arguments: { about: 'acme-api', trusted: true } } },
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
  row('...the page says who said it', 'yes', yes(/• \[worker\] RFC 4180 quoting/.test(text(2))));
  row('...trusted: owner and lead only', 'yes yes no', `${yes(/only what owner or lead said/.test(text(8)))} ${yes(/• \[lead\] Keep the v1 export/.test(text(8)))} ${yes(/RFC 4180/.test(text(8)))}`);
});

// ══ four gaps the project page showed on a real fleet ═══════════════════════════════════
// Its own home and fleet, so the counts here are about these events and nothing else. Each
// row has its opposite beside it: the deploy that moved HEAD beside the one that did not, the
// worker that acked beside the one that did not, the contributor's PR beside the fleet's own.
await section('gaps', () => {
  const GP = path.join(DIR, 'gaps');
  const GPF = path.join(GP, '.claude', 'fleet');
  for (const d of [path.join(GP, '.config', 'ghostfleet'), GPF]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(GP, '.config', 'ghostfleet', 'projects'), `acme-api\t${GP}/acme-api\twork\n`);
  const B = Date.now() - 3600_000;
  const t = (min) => B + min * 60_000;
  const rp = 'acme/acme-api';
  const c = { fleetDir: GPF, sock: 'cf-acme-api', project: 'acme-api' };
  const put = (kind, f, min, src = {}) => K.record(kind, f, { ...c, t: t(min), rec: t(min), src }, process.env);
  const boiler = 'You are a worker in the acme-api repo (public, github.com/acme/acme-api). One task, one PR against `staging`.';
  const sess = (slot, branch) => put('session.start', { branch, repo: rp, cwd: `${GP}/${slot}` }, 1, { via: 'hook', session: `s-${slot}`, slot });
  const ask = (slot, n, text) => put('request.open', { req: `s-${slot}/${n}`, text, source: 'fleet' }, 2, { via: 'mod', session: `s-${slot}`, slot });
  // four workers: a Task heading; an ack; neither (an opener, then the task); only the opener
  put('spawn', { worker: 'w-task', branch: 'fix/csv', repo: rp, task: `${boiler} ## Task Fix the CSV export so a quoted comma stays in one cell. ## Rules Branch off staging.` }, 1, { via: 'spawn' });
  sess('w-task', 'fix/csv'); ask('w-task', 1, `${boiler} ## Context The exporter splits rows. ## Task Fix the CSV export so a quoted comma stays in one cell. ## Rules Branch off staging.`);
  put('spawn', { worker: 'w-ack', branch: 'docs/setup', repo: rp, task: `${boiler} ## Context Read the README. ## Rules Be brief.` }, 1, { via: 'spawn' });
  sess('w-ack', 'docs/setup'); ask('w-ack', 1, `${boiler} ## Context Read the README. ## Rules Be brief.`);
  put('ack', { worker: 'w-ack', branch: 'docs/setup', repo: rp, understood: 'tighten the README setup section', decisions: 'docs only' }, 3, { via: 'ack' });
  put('spawn', { worker: 'w-line', branch: 'chore/flag', repo: rp, task: `${boiler} Rename the toolbox flag to --quiet. Run only the touched groups.` }, 1, { via: 'spawn' });
  sess('w-line', 'chore/flag'); ask('w-line', 1, `${boiler} Rename the toolbox flag to --quiet. Run only the touched groups.`);
  put('spawn', { worker: 'w-bare', branch: 'spike/bare', repo: rp, task: boiler }, 1, { via: 'spawn' });
  sess('w-bare', 'spike/bare'); ask('w-bare', 1, boiler);
  put('request.open', { req: 's-w-task/2', text: 'Check the CSV header row too', source: 'user' }, 4, { via: 'mod', session: 's-w-task', slot: 'w-task' });
  const nowMs = () => Date.now() + 120_000;
  const kj = (args, home = GP) => { const r = run('node', [KNOW, ...args, '--no-sync'], { home, env: { CLAUDE_FLEET_NOW_MS: String(nowMs()) } }); return r.stdout; };
  const page = kj(['acme-api']);
  const reqs = page.split('\n').filter(l => /^ {4}"/.test(l)).join('\n');
  const branchLines = page.split('\n').filter(l => /^ {2}branch /.test(l)).join('\n');
  // 2: open requests
  row('request: the line under a Task heading, not the opener', 'yes yes', `${yes(/"Fix the CSV export so a quoted comma stays in one cell\." \(w-task/.test(reqs))} ${yes(!/You are a worker/.test(reqs))}`);
  row('...the worker\'s own ack understood line wins', 'yes', yes(/"tighten the README setup section" \(w-ack/.test(reqs)));
  row('...no ack and no heading: the first line that is not an opener', 'yes', yes(/"Rename the toolbox flag to --quiet\." \(w-line/.test(reqs)));
  row('...nothing but the opener: the branch name', 'yes', yes(/"spike\/bare" \(w-bare/.test(reqs)));
  row('...a request that is not a brief is shown as written', 'yes', yes(/"Check the CSV header row too" \(w-task/.test(reqs)));
  row('...the branch lines use the same rule', 'yes yes yes', `${yes(/branch fix\/csv \(w-task\) — no PR yet: Fix the CSV export so a quoted comma/.test(branchLines))} ${yes(/branch docs\/setup \(w-ack\) — no PR yet: tighten the README setup section/.test(branchLines))} ${yes(!/You are a worker/.test(branchLines))}`);
  // 3: a merge met first without its branch, then seen by the refresh that has it
  put('turn.end', { branch: 'main', repo: rp, status: 'done', said: 'merged', prs: [{ op: 'merge', repo: rp, number: 2201 }, { op: 'merge', repo: rp, number: 2202 }] }, 10, { via: 'hook', session: 's-lead', slot: 'master' });
  put('pr.merge', { repo: rp, number: 2201, branch: 'feat/tabs' }, 11, { via: 'fleet-merged' });
  const page2 = kj(['acme-api']);
  row('merged PR: the branch the later refresh knew is filled in', 'yes', yes(/PR #2201 merged \(feat\/tabs\)/.test(page2)));
  row('...one nobody ever knew the branch of shows none, not a ?', 'yes yes', `${yes(/PR #2202 merged,/.test(page2))} ${yes(!/\(\?\)/.test(page2))}`);
  // 4: PRs waiting
  put('pr.open', { repo: rp, number: 2301, branch: 'feature/outside', author: 'outside-dev' }, 20, { via: 'fleet-merged' });
  put('pr.open', { repo: rp, number: 2302, branch: 'fix/csv', author: 'acme' }, 21, { via: 'fleet-merged' });
  put('pr.open', { repo: rp, number: 2303, branch: 'docs/setup', author: 'acme' }, 22, { via: 'fleet-merged' });
  put('turn.end', { branch: 'docs/setup', repo: rp, status: 'done', said: 'opened' }, 23, { via: 'hook', session: 's-w-ack', slot: 'w-ack' });
  put('pr.open', { repo: rp, number: 2304, branch: 'chore/other', author: 'acme' }, 24, { via: 'fleet-merged' });
  const wj = JSON.parse(kj(['waiting', '--json']) || '{}');
  const ww = (wj.rows || []).map(r => r.what).join('\n');
  row('waiting: an outside contributor\'s open PR', 'yes', yes(/PR #2301 from outside-dev waits for review/.test(ww)));
  row('...also on the project page, under what waits on you', 'yes', yes(/waits on you: PR #2301 from outside-dev waits for review/.test(kj(['acme-api']))));
  row('...a PR whose worker is still working waits on nobody', 'no', yes(/#2302/.test(ww)));
  row('...the fleet\'s own finished PR keeps its wording', 'yes', yes(/PR #2303 \(docs\/setup\) — its worker reported done; waits for review\/merge/.test(ww)));
  row('...an owner\'s PR on a branch no session owns still waits, with its author', 'yes', yes(/PR #2304 from acme waits for review/.test(ww)));
  // the writer end: fleet-merged records who opened a PR, and the cache keeps its columns
  const FLM = path.join(DIR, 'gaps-merged'); fs.mkdirSync(FLM, { recursive: true });
  const stub = path.join(FLM, 'bin'); fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'gh'), '#!/bin/sh\ncase "$*" in *"--state merged"*) printf \'old/done\\0372000\\037MERGED\\037acme\\n\' ;; *"--state open"*) printf \'feature/outside\\0372301\\037OPEN\\037outside-dev\\nfix/own\\0372302\\037OPEN\\037acme\\n\' ;; esac\nexit 0\n', { mode: 0o755 });
  const fl2 = path.join(FLM, 'fleet'); fs.mkdirSync(fl2, { recursive: true });
  const fmEnv = { CLAUDE_FLEET_DIR: fl2, CLAUDE_FLEET_MERGED_TTL: '0', CLAUDE_FLEET_SOCK: 'cf-acme-api', PATH: `${stub}:${process.env.PATH}` };
  const fm2 = () => run(path.join(ROOT, 'bin', 'fleet-merged'), [REPO], { home: GP, env: fmEnv });
  fm2();
  const opens = lines(path.join(fl2, K.LOG)).filter(e => e.kind === 'pr.open');
  row('fleet-merged: an open PR is recorded with its author', 'outside-dev acme', opens.map(e => e.f.author).sort().reverse().join(' '));
  row('...the cache itself keeps three columns', '3', fs.readFileSync(path.join(fl2, 'prs.acme_acme-api'), 'utf8').split('\n').filter(Boolean).map(l => l.split('\x1f').length).filter((v, i, a) => a.indexOf(v) === i).join(','));
  const n0 = lines(path.join(fl2, K.LOG)).length; fm2();
  row('...and a refresh that changed nothing adds nothing', '0', lines(path.join(fl2, K.LOG)).length - n0);

  // 1: the deploy is recorded by the script, with the commit it copied
  const RT = path.join(DIR, 'gaps-rt');
  for (const d of ['bin', 'lib']) fs.mkdirSync(path.join(RT, d), { recursive: true });
  for (const f of ['fleet-know-event', 'fleet-know-event.mjs']) fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(RT, 'bin', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(RT, 'lib', f));
  fs.chmodSync(path.join(RT, 'bin', 'fleet-know-event'), 0o755);
  const sha = String(git('rev-parse', 'HEAD').stdout).trim();
  const sync = (env = {}) => run(path.join(ROOT, 'bin', 'cf-sync'), [REPO], { home: GP, env: { CLAUDE_FLEET_HOME: RT, CLAUDE_FLEET_DIR: GPF, CLAUDE_FLEET_SOCK: 'cf-acme-api', ...env } });
  const deploys = () => lines(path.join(GPF, K.LOG)).filter(e => e.kind === 'deploy');
  const sy = sync();
  const d1 = deploys();
  row('cf-sync: a successful sync records its deploy once, at the commit it copied', `0 1 ghostfleet runtime ${sha}`, `${sy.status} ${d1.length} ${(d1[0] || { f: {} }).f.target} ${(d1[0] || { f: {} }).f.commit}`);
  sync({ CLAUDE_FLEET_DEPLOY_TARGET: 'ghostfleet install' });
  row('...install.sh names its own (it passes the target through)', 'ghostfleet install', (deploys()[1] || { f: {} }).f.target);
  row('...install.sh does pass it, on both of its cf-sync calls', '2', (fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8').match(/CLAUDE_FLEET_DEPLOY_TARGET="ghostfleet install"/g) || []).length);
  const before = deploys().length;
  sync({ CLAUDE_FLEET_KNOW: 'off' });
  row('...CLAUDE_FLEET_KNOW=off writes nothing', '0', deploys().length - before);
  fs.rmSync(path.join(RT, 'bin', 'fleet-know-event'));
  const sy2 = sync();
  row('...no fleet-know-event in the runtime: nothing written, and the sync still succeeds', '0 0', `${deploys().length - before} ${sy2.status}`);
  // the turn that ran it: checked a commit out, synced, re-parked on a tag, so HEAD at the
  // Stop is the tag. The detected deploy must add no second record and name no wrong commit.
  const tagSha = 'ee11ee11ee11ee11ee11ee11ee11ee11ee11ee11';
  const cmdLine = `cd /w && git checkout -q --detach origin/staging && cf-sync && ./install.sh; git checkout -q v0.6.1`;
  const stopAt = Date.now() + 5000;
  K.record('turn.end', { branch: 'HEAD', repo: rp, status: 'done', said: 'deployed', deploys: [{ target: 'cf-sync', cmd: cmdLine, ok: true, commit: tagSha }] }, { ...c, t: stopAt, rec: stopAt, src: { via: 'hook', session: 's-lead', slot: 'master' } }, process.env);
  const g = K.rebuild(GPF, { save: false }).graph;
  const dn = Object.values(g.nodes).filter(n => n.type === 'deploy');
  row('a deploy the script recorded is not recorded again from the command', '2', dn.length);
  const lj = JSON.parse(kj(['acme-api', '--json']));
  row('...the page names the short target and the commit that shipped', 'yes no', `${yes(lj.lastDeploy && /^ghostfleet (runtime|install)$/.test(lj.lastDeploy.label) && lj.lastDeploy.commit === sha)} ${yes(JSON.stringify(lj.lastDeploy || {}).includes(tagSha))}`);
  row('...as one short line, never the command', 'yes', yes(/last deploy +.*— ghostfleet install at [0-9a-f]{8}$/m.test(kj(['acme-api']))));
  // a deploy nothing recorded for itself is still detected, named by its verb, and its commit
  // is left out when the same command moved HEAD
  const tf = (command) => K.turnFacts([JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command } }] } }), JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } })]).deploys[0] || {};
  row('detected: the verb, not the head of the line', 'npm publish|supabase db push|cf-sync', [tf('cd /w && S=/tmp/x; cp a b && npm publish --access public').target, tf('supabase db push').target, tf(cmdLine).target].join('|'));
  row('...and only a command that moved HEAD is flagged', 'yes no', `${yes(tf(cmdLine).moves)} ${yes(tf('npm publish').moves)}`);
  // ...through the real Stop hook: the commit HEAD is at is named for a deploy that left it
  // alone, and for none that moved it
  const TRD = path.join(SRC, 'dep.jsonl');
  const tuse = (id, command) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const tres = (id) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  fs.writeFileSync(TRD, [tuse('d1', 'npm publish --access public'), tres('d1'), tuse('d2', cmdLine), tres('d2')].join('\n') + '\n');
  run('bash', [path.join(ROOT, 'hooks', 'fleet-event.sh')], { home: H, env: { CLAUDE_FLEET_DIR: FL, CLAUDE_CONFIG_DIR: path.join(H, '.claude'), CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'api-dep', CLAUDE_FLEET_NOTIFIER: 'off' },
    input: JSON.stringify({ session_id: 's-dep', cwd: REPO, hook_event_name: 'Stop', transcript_path: TRD, last_assistant_message: 'deployed' }) });
  waitFor(() => lines(LOGF).some(e => e.kind === 'turn.end' && e.src && e.src.session === 's-dep'));
  const dd = ((lines(LOGF).find(e => e.kind === 'turn.end' && e.src && e.src.session === 's-dep') || { f: {} }).f.deploys) || [];
  row('hook: a deploy that left HEAD alone names it, one that moved HEAD names no commit', `${sha} none`, `${(dd[0] || {}).commit} ${(dd[1] || {}).commit || 'none'}`);
  const lbl = (target, cmd) => K.deployLabel(target, cmd);
  row('...an older event (first word + the whole command) reads as its verb', 'npm publish|cf-sync', `${lbl('cd', 'cd /w && S=1; cp a b && npm publish')}|${lbl('cf-sync', 'cd /w && S=/tmp/x; cp a b …')}`);
});

// ══ the groundwork under the memory: a log that grows, a secret in a prompt, who said it ═══
// Each section has its own home, so its counts are about its own events. In every one the
// thing that must happen stands beside the thing that must not.
const newHome = (name) => {
  const h = path.join(DIR, name), fl = path.join(h, '.claude', 'fleet');
  fs.mkdirSync(path.join(h, '.config', 'ghostfleet'), { recursive: true });
  fs.mkdirSync(fl, { recursive: true });
  fs.writeFileSync(path.join(h, '.config', 'ghostfleet', 'projects'), `acme-api\t${h}/gf-demo/acme-api\twork\nacme-web\t${h}/gf-demo/acme-web\twork\n`);
  return { h, fl, log: path.join(fl, K.LOG), snap: path.join(fl, K.SNAP) };
};
const onApi = (X, t, src = { via: 'hook', session: 's-api', slot: 'master' }) => ({ fleetDir: X.fl, project: 'acme-api', sock: 'cf-acme-api', t, rec: t, src });
const kh = (X, args, env = {}) => run('node', [KNOW, ...args], { home: X.h, env });
const kjson = (X, args) => { try { return JSON.parse(kh(X, [...args, '--json']).stdout); } catch { return {}; } };
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// A read run in a child, under that home: what the library resolves from HOME stays that home.
const probe = (X, body, env = {}) => {
  const code = `import * as K from ${JSON.stringify(path.join(ROOT, 'lib', 'know.mjs'))}; const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out));`;
  const r = run('node', ['--input-type=module', '-e', code], { home: X.h, env });
  try { return JSON.parse(r.stdout); } catch { return { failed: String(r.stderr).split('\n').find(l => /Error/.test(l)) || `status ${r.status}` }; }
};

// A regression back to quadratic has to go red without a loaded machine doing the same. So the
// bound is on CPU, which a load of 25 stretches far less than the wall clock, and on how a read
// GROWS, which no machine's speed changes: three times the events cost a linear read about three
// times the CPU and a quadratic one about nine. Measured from 10k to 30k events: before the index
// 9.3 for a page, 11.3 for waiting, 12.8 for touched and 4.9 for a rebuild; after it about 2.
// A limit on the wall clock at 10k could not do this job: the quadratic code read 10k in well
// under two seconds. Eight projects, because many small ones hide what one big one shows.
await section('scale', () => {
  const bench = path.join(ROOT, 'test', 'helpers', 'know-bench.mjs');
  const cpu = (n) => {
    const h = path.join(DIR, `bench-${n}`);
    run('node', [bench, 'gen', h, String(n), '--projects', '8'], { home: h });
    const r = run('node', [bench, 'cpu', h], { home: h });
    fs.rmSync(h, { recursive: true, force: true });
    try { return JSON.parse(r.stdout); } catch { return {}; }
  };
  const a = cpu(10000), b = cpu(30000);
  // Below 20 ms a ratio is the clock's grain, not the read's shape.
  const grows = (k) => (b[k] === undefined ? Infinity : b[k] / Math.max(a[k] || 0, 20));
  const under = (x, limit) => yes(x !== undefined && x < limit);
  row('scale: the generator built both logs and the reads ran', 'yes', yes(a.brief !== undefined && b.brief !== undefined));
  row('...at 30k events a project page costs under 200 ms of CPU', 'yes', under(b.brief, 200));
  row('...waiting, a page per project, under 1 s', 'yes', under(b.waiting, 1000));
  row('...touched, under 1 s', 'yes', under(b.touched, 1000));
  row('...three times the events: a page grows about three times, not nine', 'yes', yes(grows('brief') <= 5));
  row('...waiting, the same', 'yes', yes(grows('waiting') <= 5));
  row('...touched, the same', 'yes', yes(grows('touched') <= 5));
  row('...and the rebuild', 'yes', yes(grows('rebuild') <= 4));
  // The generator never reaches a real fleet: it refuses a directory it did not make. Refusing
  // the real home is not a row, on purpose: if that guard ever broke, the row would write there.
  const other = path.join(DIR, 'bench-not-empty');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'keep'), 'x');
  const r = run('node', [bench, 'gen', other, '10'], { home: other });
  row('...the generator refuses a directory it did not make, and writes nothing', '2 keep', `${r.status} ${fs.readdirSync(other).join(' ')}`);
});

// A sparse hole past the 512 MB a string can hold, between real lines. Holding the file as one
// string threw ERR_STRING_TOO_LONG out of every read of it. As far as newlines can tell, the hole
// is one enormous line, so it also proves a line that long is not buffered.
await section('big log', () => {
  const X = newHome('big');
  const t = Date.now() - 86400e3;
  K.record('prompt', { branch: 'main', text: 'before the hole: nightly invoice replay' }, onApi(X, t));
  fs.appendFileSync(X.log, '{"id":"ktorn","kind":"pro\nnot json at all\n{"no":"id"}\n');
  fs.truncateSync(X.log, fs.statSync(X.log).size + 600 * 1024 * 1024);
  fs.appendFileSync(X.log, '\n');
  K.record('prompt', { branch: 'main', text: 'after the hole: webhook backoff' }, onApi(X, t + 1000));
  const f1 = kh(X, ['find', 'webhook', 'backoff']), f2 = kh(X, ['find', 'invoice', 'replay']);
  row('big log: find reaches a line past the hole', '0 yes', `${f1.status} ${yes(/after the hole/.test(f1.stdout))}`);
  row('...and one before it', '0 yes', `${f2.status} ${yes(/before the hole/.test(f2.stdout))}`);
  const rb = kh(X, ['rebuild']);
  row('...rebuild folds the two events, torn and foreign lines skipped', '0 yes', `${rb.status} ${yes(/rebuilt from 2 events/.test(rb.stdout))}`);
  row('...and a project page still answers', '0', kh(X, ['acme-api']).status);
  const p = probe(X, `const d = process.env.HOME + '/.claude/fleet'; const s = K.rebuild(d, { save: false }); let n = 0; K.scanLog(d + '/' + K.LOG, 0, () => n++); return { events: s.events, n, rss: process.resourceUsage().maxRSS };`);
  // macOS and Linux both report kilobytes through node. A real read of a file this size is 600 MB.
  row('...in memory that is not the size of the file (under 250 MB)', 'yes', yes(p.rss > 0 && p.rss < 250 * 1024));
  row('...the scan sees the same two', '2 2', `${p.events} ${p.n}`);
  fs.rmSync(X.h, { recursive: true, force: true });
  // an unfinished last line waits for its newline, and a read does not move past it
  const Y = newHome('torn-tail');
  K.record('prompt', { branch: 'main', text: 'a whole line' }, onApi(Y, t));
  const whole = fs.statSync(Y.log).size;
  fs.appendFileSync(Y.log, '{"id":"khalf","v":1,"t":1,"kind":"prompt"');
  const q = probe(Y, `const r = K.readLog(process.env.HOME + '/.claude/fleet/' + K.LOG); return { n: r.events.length, end: r.end };`);
  row('...an unfinished last line waits: read up to it, not past it', `1 ${whole}`, `${q.n} ${q.end}`);
});

// The two bounded readers keep their best few as they go, so they can only be wrong in the order
// they drop things. The lines here are written out of time order to give them the chance.
await section('bounded readers', () => {
  const X = newHome('bounded');
  const t = Date.now() - 86400e3;
  const order = Array.from({ length: 200 }, (_, i) => (i * 73) % 200);
  for (const i of order) K.record('prompt', { branch: 'main', text: `the replay line ${i}` }, onApi(X, t + i * 1000));
  const r = probe(X, `
    const seen = []; let after = 0, pages = 0, more = true;
    while (more && pages < 50) { const p = K.eventsForPeer({ after, limit: 30 }); seen.push(...p.events.map(e => e.t)); more = p.more; after = p.next; pages++; }
    const v = await K.view({ sync: false });
    const f = K.find(v, 'replay');
    return { seen, pages, first: K.eventsForPeer({ after: 0, limit: 30 }).events.length, total: f.total, rows: f.rows.map(x => x.t) };`);
  const sorted = (xs) => xs.every((x, i) => !i || xs[i - 1] <= x);
  row('paging a long log: every event once, in time order', '200 yes', `${new Set(r.seen || []).size} ${yes(sorted(r.seen || []) && (r.seen || []).length === 200)}`);
  row('...a page at a time', '30 7', `${r.first} ${r.pages}`);
  row('find: counts all it matched and keeps the newest', '200 20 yes', `${r.total} ${(r.rows || []).length} ${yes((r.rows || [])[0] === t + 199000 && (r.rows || [])[19] === t + 180000)}`);
});

const R = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
// Built at runtime, so nothing here is a string a scanner would stop on, or a key anyone could use.
const SECRET_SAMPLES = {
  'private-key': [`-----BEGIN ${'RSA '}PRIVATE KEY-----\n${R('MIIE', 64)}\n${R('abcd', 64)}\n-----END RSA PRIVATE KEY-----`, `-----BEGIN ${'OPENSSH '}PRIVATE KEY-----\n${R('b3Bl', 70)}`],
  jwt: [`ey${'J'}${R('hbGci', 24)}.ey${'J'}${R('zdWIi', 40)}.${R('s1g_', 43)}`],
  'telegram-bot-token': [`${'1234'}${'56789'}:${R('Aa1_-', 35)}`],
  'github-token': [`gh${'p'}_${R('a1B2', 36)}`, `gh${'s'}_${R('c3D4', 36)}`, `github${'_pat_'}${R('e5F6_', 60)}`],
  'api-key': [`s${'k'}-${R('g7H8', 40)}`, `s${'k'}-ant-${R('i9J0-', 60)}`],
  'aws-key': [`AK${'IA'}${R('K1L2M3N4', 16)}`, `AS${'IA'}${R('O5P6Q7R8', 16)}`],
  'slack-token': [`xo${'x'}b-${R('1234-', 30)}abc`, `xo${'x'}p-${R('5678-', 30)}def`],
};
const KEPT_SAMPLES = {
  bearer: [`Authorization: Bea${'rer'} ${R('t0k3n.', 40)}`],
  credential: [`pass${'word'}=${R('hunter2', 14)}`, `to${'ken'}=${R('abc123', 18)}`, `client_sec${'ret'}=${R('def456', 18)}`, `GITHUB_TO${'KEN'}="${R('ghi789', 18)}"`, `{"api_${'key'}":"${R('jkl012', 18)}"}`, `https://example.test/cb?to${'ken'}=${R('mno345', 18)}&page=2`],
};

await section('secrets', () => {
  const X = newHome('secrets');
  const t = Date.now() - 86400e3;
  let i = 0;
  const logged = (f, kind = 'prompt') => { const ev = K.record(kind, f, onApi(X, t + (i++) * 1000)); const line = text(X.log).split('\n').filter(Boolean).find(l => l.includes(`"${ev.id}"`)); return line || ''; };
  const body = (s) => s.replace(/^.*?(?:Bearer |=["']?|":")/s, '').slice(0, 24);
  const all = { ...SECRET_SAMPLES, ...KEPT_SAMPLES };
  // A kind added to the table without a sample here goes red, so the table cannot outgrow this.
  row('secrets: every kind in the table has a sample here', 'yes', yes(K.SECRET_SHAPES.every(([k]) => all[k]) && Object.keys(all).every(k => K.SECRET_SHAPES.some(([n]) => n === k))));
  for (const [kind, samples] of Object.entries(SECRET_SAMPLES)) {
    samples.forEach((s, n) => {
      const line = logged({ branch: 'main', text: `before ${s} after` });
      row(`...${kind} (${n + 1}): replaced, the words around it kept`, 'yes yes no yes', `${yes(line.includes(`[redacted:${kind}]`))} ${yes(line.includes('before '))} ${yes(line.includes(s.slice(0, 24).replace(/\n/g, '\\n')))} ${yes(line.includes(' after') || kind === 'private-key')}`);
    });
  }
  for (const [kind, samples] of Object.entries(KEPT_SAMPLES)) {
    samples.forEach((s, n) => {
      const line = logged({ branch: 'main', text: `before ${s} after` });
      row(`...${kind} (${n + 1}): the value goes, the name of it stays`, 'yes no yes', `${yes(line.includes(`[redacted:${kind}]`))} ${yes(line.includes(body(s)))} ${yes(/Bearer|password|token|secret|TOKEN|api_key/.test(line))}`);
    });
  }
  // Text a token shape must not eat. Each of these has a near miss of a shape in it.
  const keep = {
    'a short value': 'token=abc123',
    'a reference, not a value': `pass${'word'}=$DB_PASSWORD`,
    'a placeholder': `sec${'ret'}=<your-secret-here>`,
    'prose about a secret': 'the secret: understanding the cache keys',
    'a short bearer': 'Bearer abc123',
    'a branch that ends in a shape': 'task-force-a-very-long-branch-name-goes-here',
    'a word ending in sk-': 'risk-assessment-for-the-export-endpoint-today',
    'a commit': 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'a PR link': 'https://github.com/acme/acme-api/pull/1170',
    'a short id and a colon': '123456:short',
    'a time with a long tail': `12:${R('ab', 35)}`,
  };
  for (const [what, s] of Object.entries(keep)) {
    const line = logged({ branch: 'main', text: `left ${s} right` });
    row(`...${what} stays as written`, 'yes no', `${yes(line.includes(s))} ${yes(line.includes('[redacted:'))}`);
  }
  // Every text a writer hands over, at any depth: the same path for each.
  const tok = SECRET_SAMPLES['github-token'][0];
  const deep = logged({ branch: 'main', status: 'done', said: `said ${tok}`, files: [`src/${tok}.js`], deploys: [{ target: 'vercel', cmd: `to${'ken'}=${R('abc123', 18)} vercel deploy --prod`, ok: true }], prs: [{ op: 'open', repo: 'acme/acme-api', number: 1170, title: `fix ${tok}` }] }, 'turn.end');
  row('...in a turn: its words, its files, a deploy\'s command and a PR', 'no yes', `${yes(deep.includes(tok) || deep.includes(R('abc123', 18)))} ${yes((deep.match(/\[redacted:/g) || []).length >= 4)}`);
  // Redacted before the cap: half a token cut by it would no longer match its shape and is still a leak.
  const wide = logged({ branch: 'main', text: `${R('x ', K.TEXT_CAP - 10)}${tok}` });
  row('...a token the cap would cut in half leaves nothing of itself', 'no', yes(wide.includes(`gh${'p'}_`)));
  // A line from before the table is scrubbed on its way to a paired machine, with its id.
  const Y = newHome('secrets-old');
  const old = K.makeEvent({ t, rec: t, kind: 'prompt', machine: 'laptop', profile: 'work', project: 'acme-api', src: { sock: 'cf-acme-api' }, f: { text: `old ${tok}` } });
  fs.writeFileSync(Y.log, JSON.stringify(old) + '\n');
  const out = probe(Y, 'return K.eventsForPeer({});');
  row('...a line written before the table crosses a pairing scrubbed, under its own id', 'yes no yes', `${yes(((out.events || [])[0] || {}).id === old.id)} ${yes(JSON.stringify(out).includes(tok))} ${yes(JSON.stringify(out).includes('[redacted:github-token]'))}`);
  // And it never reached the writer's other copy.
  K.snapshot(X.fl);
  row('...nor is any of it in the graph', 'no', yes(text(X.snap).includes(tok)));
});

await section('forget', async () => {
  const X = newHome('forget');
  const t = Date.now() - 86400e3;
  const ctx = (n, src) => onApi(X, t + n * 1000, src);
  K.record('prompt', { branch: 'main', text: 'an ordinary request about the export writer' }, ctx(0));
  const leak = K.record('decision', { text: 'the leaked staging detail', source: 'stated' }, ctx(1, { via: 'fleet-know', slot: 'master' }));
  K.record('turn.end', { branch: 'main', status: 'done', said: 'a turn after it about the export writer' }, ctx(2));
  fs.appendFileSync(X.log, 'a torn line a purge must leave alone\n');
  const fileMode = 0o640;
  fs.chmodSync(X.log, fileMode);
  const page0 = kh(X, ['acme-api']).stdout;
  const f0 = kh(X, ['find', 'leaked']).stdout;
  row('forget: find prints the id forget takes', 'yes', yes(f0.includes(leak.id)));
  row('...the event is on the page before it is forgotten', 'yes', yes(page0.includes('leaked staging')));
  row('...and in the snapshot that read saved', 'yes', yes(text(X.snap).includes('leaked staging')));
  const r = kh(X, ['forget', leak.id]);
  // Before anything reads it: a read would rebuild it anyway, and hide a forget that left it.
  row('...forget takes it from the snapshot at once', 'no', yes(text(X.snap).includes('leaked staging')));
  row('...forget answers, and never repeats the text', '0 yes no', `${r.status} ${yes(/forgotten: k/.test(r.stdout))} ${yes(r.stdout.includes('leaked'))}`);
  row('...and says a paired machine keeps its copy until it fetches the tombstone', 'yes', yes(/paired machine that already fetched it keeps its copy until/.test(r.stdout)));
  row('...the page has dropped it', 'no', yes(kh(X, ['acme-api']).stdout.includes('leaked staging')));
  row('...find has too', 'no', yes(kh(X, ['find', 'leaked']).stdout.includes('leaked staging')));
  // find's no-match line repeats the query, so these match words the query does not hold.
  row('...while what is around it stands', 'yes yes', `${yes(/an ordinary request/.test(kh(X, ['find', 'export', 'writer']).stdout))} ${yes(/a turn after it/.test(kh(X, ['find', 'export', 'writer']).stdout))}`);
  const rc = kh(X, ['rebuild', '--check']);
  row('...the graph is the same folded on or rebuilt', '0 yes', `${rc.status} ${yes(/matches a rebuild/.test(rc.stdout))}`);
  row('...the line itself stays, without --purge', 'yes', yes(text(X.log).includes('leaked staging')));
  let ex = probe(X, 'return K.eventsForPeer({ tombstones: true });');
  row('...not served to a paired machine, and the tombstone is', 'no yes', `${yes(JSON.stringify(ex).includes('leaked staging'))} ${yes((ex.events || []).some(e => e.kind === K.FORGET && e.f.target === leak.id))}`);
  ex = probe(X, 'return K.eventsForPeer({});');
  row('...a client that did not ask for tombstones is not sent one, nor the event', 'no no', `${yes((ex.events || []).some(e => e.kind === K.FORGET))} ${yes(JSON.stringify(ex).includes('leaked staging'))}`);
  // Written while it was being forgotten, or re-recorded after: a late line under that id stays out.
  const raw = text(X.log).split('\n').find(l => l.includes(`"id":"${leak.id}"`));
  fs.appendFileSync(X.log, raw + '\n');
  row('...the same event landing again stays forgotten', 'no', yes(kh(X, ['acme-api']).stdout.includes('leaked staging')));
  // The refusals, and what they leave behind.
  const before = text(X.log);
  const un = kh(X, ['forget', 'k0000000000000000']);
  row('forget: an id nothing holds is refused and writes nothing', '1 yes', `${un.status} ${yes(text(X.log) === before)}`);
  const off = kh(X, ['forget', leak.id, '--purge'], { CLAUDE_FLEET_KNOW: 'off' });
  row('...with the memory switched off it refuses aloud, and writes nothing', '1 yes yes', `${off.status} ${yes(/switched off/.test(off.stderr))} ${yes(text(X.log) === before)}`);
  // --purge: that one line, atomically, no backup.
  const ino0 = fs.statSync(X.log).ino;
  const ls0 = fs.readdirSync(X.fl).sort().join(' ');
  const was = text(X.log).split('\n');
  const pg = kh(X, ['forget', leak.id, '--purge']);
  const now = text(X.log).split('\n');
  row('--purge: answers, says it rewrote the lines', '0 yes', `${pg.status} ${yes(/purged: 2 lines rewritten/.test(pg.stdout))}`);
  row('...the text is gone from the log and the snapshot', 'no no', `${yes(text(X.log).includes('leaked staging'))} ${yes(text(X.snap).includes('leaked staging'))}`);
  row('...and only those lines changed: every other byte is what it was', 'yes', yes(was.length === now.length && was.every((l, n) => l === now[n] || l.includes(`"id":"${leak.id}"`))));
  row('...the torn line included', 'yes', yes(text(X.log).includes('a torn line a purge must leave alone')));
  row('...a new file renamed into place, with the mode it had', `yes ${fileMode.toString(8)}`, `${yes(fs.statSync(X.log).ino !== ino0)} ${(fs.statSync(X.log).mode & 0o777).toString(8)}`);
  row('...no temp file and no backup beside it', ls0, fs.readdirSync(X.fl).sort().join(' '));
  row('...a second purge has nothing to do', '0 yes', (() => { const a = kh(X, ['forget', leak.id, '--purge']); return `${a.status} ${yes(/already rewritten/.test(a.stdout))}`; })());
  const pc = kh(X, ['rebuild', '--check']);
  row('...and the graph still matches a rebuild', '0', pc.status);
  // A writer that keeps writing all through a purge loses nothing: the catch-up before the rename,
  // the old descriptor after it, and the writer's own look at whether it wrote to the log. The
  // last of those is a window of microseconds that lost a line in one purge of three, so a row
  // that purged once would pass on broken code most of the time. Eight rounds, the real append().
  const Y = newHome('forget-race');
  const stopFile = path.join(DIR, 'forget-race.stop');
  const writerCode = (round) => `import fs from 'node:fs'; import * as K from ${JSON.stringify(path.join(ROOT, 'lib', 'know.mjs'))};
    let n = 0;
    while (!fs.existsSync(${JSON.stringify(stopFile)})) { K.append(${JSON.stringify(Y.fl)}, { id: 'kw${round}-' + n, v: 1, t: ${t + 100000} + n, kind: 'prompt', machine: 'laptop', profile: 'work', project: 'acme-api', src: {}, f: { text: 'written during the purge ' + n } }); n++; }
    process.stdout.write(String(n));`;
  const filler = K.makeEvent({ t: t + 1, rec: t + 1, kind: 'prompt', machine: 'laptop', profile: 'work', project: 'acme-api', src: { sock: 'cf-acme-api' }, f: { text: R('filler words about the webhook backoff ', 600) } });
  fs.mkdirSync(Y.fl, { recursive: true });
  fs.appendFileSync(Y.log, Array.from({ length: 3000 }, (_, n) => JSON.stringify({ ...filler, id: `kfill${n}` })).join('\n') + '\n');
  let wrote = 0, stayed = 0, failed = 0, left = 0;
  for (let round = 0; round < 8; round++) {
    fs.rmSync(stopFile, { force: true });
    const victim = K.record('prompt', { branch: 'main', text: `the line to purge ${round}` }, onApi(Y, t + round));
    const size = fs.statSync(Y.log).size;
    let said = '';
    const writer = spawn('node', ['--input-type=module', '-e', writerCode(round)], { env: { ...base(), HOME: Y.h }, stdio: ['ignore', 'pipe', 'ignore'] });
    writer.stdout.on('data', d => { said += d; });
    const exited = new Promise(res => writer.on('exit', res));
    for (let i = 0; i < 400 && fs.statSync(Y.log).size === size; i++) await sleep(5);   // it is writing
    const purge = spawn('node', [KNOW, 'forget', victim.id, '--purge'], { env: { ...base(), HOME: Y.h }, stdio: 'ignore' });
    if (await new Promise(res => purge.on('exit', res))) failed++;
    fs.writeFileSync(stopFile, '');
    await exited;
    wrote += Number(said) || 0;
    const landed = new Set();
    K.scanLog(Y.log, 0, (e) => { if (String(e.id).startsWith(`kw${round}-`)) landed.add(e.id); });
    stayed += landed.size;
    if (text(Y.log).includes(`the line to purge ${round}`)) left++;
  }
  row('...a writer running all through eight purges loses no line', 'yes 0 yes 0', `${yes(wrote > 0)} ${failed} ${yes(stayed === wrote)} ${left}`);
  fs.rmSync(Y.h, { recursive: true, force: true });
  // The cache of a paired machine, as a fetch fills it. Its tombstones reach that file and no other.
  const Z = newHome('forget-peer');
  const pf = K.peerFiles(Z.fl, 'vm');
  const ev = (text, n) => K.makeEvent({ t: t + n, rec: t + n, kind: 'prompt', machine: 'vm', profile: 'work', project: 'acme-api', src: { sock: 'cf-acme-api', session: 's-vm' }, f: { branch: 'main', text } });
  const tomb = (target, n) => K.makeEvent({ t: t + n, rec: t + n, kind: K.FORGET, machine: 'vm', profile: 'work', project: '', src: { via: 'fleet-know' }, f: { target } });
  const kept = ev('a request that stays', 1000), gone = ev('a request the vm forgot', 2000), both = ev('never written here', 3000);
  K.ingestPeerEvents(pf, 'vm', [kept, gone], 0, t);
  row('a fetch caches the events', 'yes yes', `${yes(text(pf.log).includes('a request that stays'))} ${yes(text(pf.log).includes('a request the vm forgot'))}`);
  K.ingestPeerEvents(pf, 'vm', [tomb(gone.id, 4000)], 0, t);
  row('...its tombstone, later: the cached copy is gone from the disk', 'no yes', `${yes(text(pf.log).includes('a request the vm forgot'))} ${yes(text(pf.log).includes('a request that stays'))}`);
  K.ingestPeerEvents(pf, 'vm', [gone], 0, t);
  row('...and the overlap of the next fetch does not bring it back', 'no', yes(text(pf.log).includes('a request the vm forgot')));
  K.ingestPeerEvents(pf, 'vm', [both, tomb(both.id, 5000)], 0, t);
  // By its line, not its text: written and then purged leaves no text either, and a stub.
  const hasLine = () => lines(pf.log).some(e => e.id === both.id);
  row('...a tombstone on the same page as its target: the target is never written', 'no', yes(hasLine()));
  K.ingestPeerEvents(pf, 'vm', [both], 0, t);
  row('...nor by the overlap of the fetch after that', 'no', yes(hasLine()));
  const added = K.ingestPeerEvents(pf, 'vm', [ev(`scrub ${SECRET_SAMPLES['github-token'][0]}`, 6000)], 0, t);
  row('...a line from a machine without the table is scrubbed on arrival', '1 no yes', `${added.added} ${yes(text(pf.log).includes(SECRET_SAMPLES['github-token'][0]))} ${yes(text(pf.log).includes('[redacted:github-token]'))}`);
  // A forget of a cached copy says the machine it came from still has it.
  const lc = K.record('prompt', { text: 'local one' }, onApi(Z, t));
  const fp = kh(Z, ['forget', kept.id]);
  row('...forgetting a cached copy here says the machine it came from still holds it', '0 yes no', `${fp.status} ${yes(/vm's event: the machine it came from still holds it/.test(fp.stdout))} ${yes(/paired machine that already fetched/.test(fp.stdout))}`);
  row('...while the local log is untouched', 'yes', yes(text(Z.log).includes(lc.id)));
});

await section('authority', () => {
  // On the fixture fleet, which holds a lead's decision and a worker's ack.
  const b = know(['acme-api']).stdout;
  row('authority: a lead\'s decision says so', 'yes', yes(/• \[lead\] Keep the v1 export endpoint/.test(b)));
  row('...a worker\'s fleet-ack says so', 'yes', yes(/• \[worker\] RFC 4180 quoting/.test(b)));
  row('...what the project is says who wrote it', 'yes', yes(/what it is +The public REST API.*\[lead\]$/m.test(b)));
  const j = knowJ(['acme-api']);
  row('...and the JSON carries it', 'lead worker lead', `${(j.decisions || []).find(d => /v1 export/.test(d.text))?.authority} ${(j.decisions || []).find(d => /RFC 4180/.test(d.text))?.authority} ${j.aboutAuthority}`);
  const tr = know(['acme-api', '--trusted']).stdout;
  row('--trusted: keeps the lead\'s, drops the worker\'s', 'yes no', `${yes(tr.includes('Keep the v1 export'))} ${yes(tr.includes('RFC 4180'))}`);
  row('...says it is narrowed', 'yes', yes(/only what owner or lead said/.test(tr)));
  row('...what happened is not narrowed: the PRs and what waits stay', 'yes yes', `${yes(tr.includes('PR #1184'))} ${yes(/waits on you/.test(tr))}`);
  const X = newHome('authority');
  const t = Date.now() - 86400e3;
  let n = 0;
  const put = (kind, f, src) => K.record(kind, f, { fleetDir: X.fl, project: 'acme-api', sock: 'cf-acme-api', t: t + (n++) * 1000, src });
  const lead = { via: 'fleet-know', slot: 'master' }, worker = { via: 'fleet-know', slot: 'api-fix' };
  put('decision', { text: 'a-lead-said', source: 'stated' }, lead);
  put('decision', { text: 'b-worker-said', source: 'stated' }, worker);
  put('decision', { text: 'c-nobody-said', source: 'stated' }, {});
  put('decision', { text: 'd-owner-terminal', source: 'stated' }, { via: 'fleet-know', by: 'terminal' });
  put('decision', { text: 'e-owner-reply', source: 'reply' }, { via: 'mod', session: 's-api', slot: 'master' });
  put('decision', { text: 'f-owner-prompt', source: 'prompt' }, { via: 'mod', session: 's-api', slot: 'api-fix' });
  put('decision', { text: 'g-the-model', source: 'inferred', inferred: true }, { via: 'infer', session: 's-api', slot: 'master' });
  put('decision', { text: 'h-model-unmarked', source: 'stated' }, { via: 'infer', session: 's-api', slot: 'master' });
  put('decision', { text: 'i-forged', source: 'stated', authority: 'owner' }, worker);
  put('ack', { worker: 'master', branch: 'fix/x', repo: 'acme/acme-api', decisions: 'j-ack-from-the-lead-slot' }, { via: 'ack', slot: 'master' });
  const by = (d) => (kjson(X, ['acme-api']).decisions || []).find(x => x.text.startsWith(d))?.authority;
  // The page lists five, and these are all recent, so read them all from the graph.
  const g = K.rebuild(X.fl, { save: false }).graph;
  const auth = (s) => Object.values(g.nodes).find(x => x.type === 'decision' && String(K.attr(x, 'text')).startsWith(s))?.a.authority?.[0];
  row('derived from the source: a lead, a worker', 'lead worker', `${auth('a-')} ${auth('b-')}`);
  row('...a write that says nothing fails closed, to worker', 'worker', auth('c-'));
  row('...the owner: their own terminal, a ledger reply, their prompt', 'owner owner owner', `${auth('d-')} ${auth('e-')} ${auth('f-')}`);
  row('...the model, marked or only by its path', 'model model', `${auth('g-')} ${auth('h-')}`);
  row('...a field claiming authority is not believed', 'worker', auth('i-'));
  row('...fleet-ack is a worker\'s whatever slot ran it', 'worker', auth('j-'));
  row('...and it is not stored in the log: the fold derives it', 'no', yes(lines(X.log).some(e => e.f.authority && e.f.text !== 'i-forged')));
  const trusted = probe(X, 'const v = await K.view({ sync: false }); const b = K.brief(v, "acme-api", { authority: K.TRUSTED }); const a = K.brief(v, "acme-api"); return { t: b.decisions.map(d => d.authority), all: a.decisions.length };');
  row('the reader option: owner and lead only', 'yes', yes((trusted.t || []).length > 0 && trusted.t.every(a => a === 'owner' || a === 'lead')));
  row('...its list of two is the one the next phase imports', 'owner lead', K.TRUSTED.join(' '));
  // What the project is: the newest for a plain read, the last trusted one for a narrowed read.
  const Y = newHome('authority-about');
  let m2 = 0;
  const putY = (kind, f, src) => K.record(kind, f, { fleetDir: Y.fl, project: 'acme-api', sock: 'cf-acme-api', t: t + (m2++) * 1000, src });
  putY('project.about', { text: 'the lead wrote this line' }, lead);
  putY('project.about', { text: 'a worker wrote this one since' }, worker);
  putY('relate', { rel: 'depends-on', to: 'billing-svc' }, lead);
  putY('relate', { rel: 'depends-on', to: 'toolbox' }, worker);
  const plain = kh(Y, ['acme-api']).stdout, narrow = kh(Y, ['acme-api', '--trusted']).stdout;
  row('what it is: a plain read takes the newest and says whose', 'yes', yes(/what it is +a worker wrote this one since +\[worker\]/.test(plain)));
  row('...a narrowed read keeps the last line a lead wrote', 'yes', yes(/what it is +the lead wrote this line +\[lead\]/.test(narrow)));
  row('depends on: a worker\'s is tagged, a lead\'s reads plain', 'yes', yes(/depends on +billing-svc, toolbox \[worker\]/.test(plain)));
  row('...and a narrowed read drops the worker\'s', 'yes', yes(/depends on +billing-svc$/m.test(narrow)));
  const Z = newHome('authority-none');
  K.record('project.about', { text: 'only a worker has said' }, { fleetDir: Z.fl, project: 'acme-api', sock: 'cf-acme-api', t, src: worker });
  row('...and with no trusted line it says so, rather than the worker\'s', 'yes no', (() => { const o = kh(Z, ['acme-api', '--trusted']).stdout; return `${yes(/what it is +\(nothing from owner or lead\)/.test(o))} ${yes(o.includes('only a worker'))}`; })());
  // A request already says whose ask it is. Closed after a week it is counted, and the count
  // follows the filter too.
  const W = newHome('authority-req');
  const mk = (kind, f, tt, src = { via: 'mod', session: 's-api', slot: 'master' }) => K.record(kind, f, { fleetDir: W.fl, project: 'acme-api', sock: 'cf-acme-api', t: tt, src });
  mk('request.open', { req: 's-api/1', text: 'from the owner', source: 'user', state: 'open' }, t);
  mk('request.open', { req: 's-api/2', text: 'from a lead', source: 'fleet', state: 'open' }, t + 1);
  mk('request.open', { req: 's-api/3', text: 'a promise', source: 'promise', state: 'open' }, t + 2);
  const reqs = kjson(W, ['acme-api']).openRequests || [];
  const rq = (s) => (reqs.find(r => r.text === s) || {}).authority;
  row('a request\'s authority is the ledger\'s word for whose ask it is', 'owner lead worker', `${rq('from the owner')} ${rq('from a lead')} ${rq('a promise')}`);
  const longAgo = t - 30 * 86400e3;
  mk('decision', { text: 'old from a lead', source: 'stated' }, longAgo, lead);
  mk('decision', { text: 'old from a worker', source: 'stated' }, longAgo + 1, worker);
  row('...and the count of old decisions follows the filter', '2 1', `${kjson(W, ['acme-api']).earlier?.decisions} ${kjson(W, ['acme-api', '--trusted']).earlier?.decisions}`);
  // The owner's own terminal, for real: a pty. Beside it the same command in the three cases
  // that look like one and are not.
  const V = newHome('authority-tty');
  const q = (s) => `'${s}'`;
  const inPane = (label, prefix) => {
    const cmd = `${prefix} HOME=${q(V.h)} CLAUDE_FLEET_KNOW_MACHINE=laptop node ${q(KNOW)} decide acme-api ${q(label)}`;
    spawnSync('tmux', ['-L', 'know-authority', 'new-session', '-d', '-x', '120', '-y', '30', 'sh', '-c', cmd], { env: base(), encoding: 'utf8' });
    waitFor(() => text(V.log).includes(label));
  };
  const clean = 'env -u CLAUDECODE -u CLAUDE_FLEET_SLOT';
  inPane('tty-plain', clean);
  inPane('tty-agent', `${clean} CLAUDECODE=1`);
  inPane('tty-slot', `${clean} CLAUDE_FLEET_SLOT=master`);
  inPane('tty-worker', `${clean} CLAUDE_FLEET_SLOT=api-fix`);
  spawnSync('tmux', ['-L', 'know-authority', 'kill-server'], { env: base() });
  run('node', [KNOW, 'decide', 'acme-api', 'no-tty'], { home: V.h, env: { CLAUDECODE: '' } });
  const vg = K.rebuild(V.fl, { save: false }).graph;
  const vauth = (s) => Object.values(vg.nodes).find(x => x.type === 'decision' && K.attr(x, 'text') === s)?.a.authority?.[0];
  row('decide at a person\'s terminal, in a real pty: owner', 'owner', vauth('tty-plain'));
  row('...an agent\'s shell with a pty is not', 'worker', vauth('tty-agent'));
  row('...a fleet pane is its slot: the lead, a worker', 'lead worker', `${vauth('tty-slot')} ${vauth('tty-worker')}`);
  row('...and with no terminal at all, nothing to claim', 'worker', vauth('no-tty'));
});

await section('said', () => {
  const X = newHome('said');
  const t = Date.now() - 86400e3;
  const question = 'Which plan tier should the rate limit apply to?';
  const long = `Opened PR #1170 for the export. ${R('The writer quotes every field. ', 3000)}${question}`;
  const put = (f, n) => { K.record('turn.end', { branch: 'main', status: 'done', ...f }, onApi(X, t + n * 1000)); return lines(X.log).pop().f; };
  const a = put({ said: long }, 1);
  row('said: a long turn keeps the question at its end', 'yes', yes(a.said.endsWith(question)));
  row('...and how it opened', 'yes', yes(a.said.startsWith('Opened PR #1170')));
  row('...with a mark where it was cut', 'yes', yes(a.said.includes(' […] ')));
  row('...within the cap, head and tail about two to one', 'yes yes', `${yes(a.said.length <= K.TEXT_CAP)} ${yes(a.said.indexOf(' […] ') >= K.TEXT_CAP * 0.6)}`);
  const exact = R('abcd ', K.TEXT_CAP).slice(0, K.TEXT_CAP - 1) + 'z';
  row('...one that fits is left exactly as it was', 'yes', yes(put({ said: exact }, 2).said === exact));
  row('...one past the cap is cut, and stays within it', 'yes', yes((() => { const x = put({ said: `${exact}y` }, 3).said; return x.includes(' […] ') && x.length <= K.TEXT_CAP && x.endsWith('zy'); })()));
  row('...every other text still keeps its head', 'yes no', (() => { const x = put({ said: 'short', note: long }, 4).note; return `${yes(x.endsWith('…'))} ${yes(x.includes(question))}`; })());
  // An oversized line sheds its longest texts until it fits: the question survives that too.
  const fields = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`x${i}`, R('filler ', 1400)]));
  const shed = put({ ...fields, said: long }, 5);
  row('...a line over its cap sheds down to the two ends as well', 'yes yes', `${yes(shed.said.length <= 200)} ${yes(shed.said.endsWith('apply to?'))}`);
  // Through the real Stop hook, with a secret in it.
  const tok = SECRET_SAMPLES['github-token'][0];
  run('bash', [path.join(ROOT, 'hooks', 'fleet-event.sh')], {
    home: H,
    env: { CLAUDE_FLEET_DIR: FL, CLAUDE_CONFIG_DIR: path.join(H, '.claude'), CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'api-long', CLAUDE_FLEET_NOTIFIER: 'off' },
    input: JSON.stringify({ session_id: 's-long', cwd: REPO, hook_event_name: 'Stop', last_assistant_message: `${tok} ${long}` }),
  });
  waitFor(() => lines(LOGF).some(e => e.kind === 'turn.end' && e.src && e.src.session === 's-long'));
  const s = (lines(LOGF).find(e => e.kind === 'turn.end' && e.src && e.src.session === 's-long') || { f: {} }).f.said || '';
  row('...through the real Stop hook: the question kept, the token not', 'yes no yes', `${yes(s.endsWith(question))} ${yes(s.includes(tok))} ${yes(s.includes('[redacted:github-token]'))}`);
});

for (const r of rows) process.stdout.write(r.join('\x1f') + '\n');
