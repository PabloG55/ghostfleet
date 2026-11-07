// A fixture fleet for the memory (lib/know.mjs), in web/fixtures' vocabulary: the work profile
// holds acme-api, acme-web, toolbox and billing-svc, the personal one holds scratch; the
// sessions are master, api-fix and docs-pass; this machine is `laptop`.
//
//   node test/helpers/know-fixture.mjs <home>     builds <home> and prints T0 (ms)
//
// Events go through record() — the writer every path uses — with their times pinned, so a
// brief built from it is the same bytes on every run. toolbox is `exclude` and scratch is
// `private` BEFORE anything is written, which is the point: what lands is what the switch let
// through, not what a test removed afterwards.
import fs from 'node:fs';
import path from 'node:path';

const home = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: know-fixture.mjs <home>'); process.exit(2); }
process.env.HOME = home;
process.env.CLAUDE_FLEET_KNOW_MACHINE = 'laptop';
delete process.env.CLAUDE_FLEET_DIR;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_FLEET_PROFILE;
delete process.env.CLAUDE_FLEET_KNOW;

const cfg = path.join(home, '.config', 'ghostfleet');
const work = path.join(home, '.claude', 'fleet');
const personal = path.join(home, '.claude-personal', 'fleet');
for (const d of [cfg, work, personal]) fs.mkdirSync(d, { recursive: true });
const gf = path.join(home, 'gf-demo');
fs.writeFileSync(path.join(cfg, 'projects'), ['acme-api', 'acme-web', 'toolbox', 'billing-svc']
  .map(n => `${n}\t${gf}/${n}\twork\n`).join(''));
fs.writeFileSync(path.join(cfg, 'projects.personal'), `scratch\t${gf}/scratch\tpersonal\n`);
fs.writeFileSync(path.join(work, 'cf-toolbox.know'), 'exclude\n');
fs.writeFileSync(path.join(personal, 'cf-personal-scratch.know'), 'private\n');

const K = await import(new URL('../../lib/know.mjs', import.meta.url));
const T0 = Date.UTC(2026, 2, 5, 12, 0, 0);            // 2026-03-05T12:00:00Z
const m = (n) => T0 + n * 60_000;                      // n minutes after T0
const W = (sock, project) => ({ fleetDir: work, sock, project });
const api = W('cf-acme-api', 'acme-api');
const repo = 'acme/acme-api';
const put = (kind, f, c, t, src = {}) => K.record(kind, f, { ...c, t, rec: t, src }, process.env);

// acme-api: what it is, a lead, two workers, a merged PR, an open one, a deploy, decisions
put('project.about', { text: 'The public REST API behind acme-web: Node and Postgres.' }, api, m(-20000));
put('relate', { rel: 'depends-on', to: 'billing-svc' }, api, m(-20000));
put('session.start', { branch: 'main', repo, cwd: `${gf}/acme-api` }, api, m(0), { via: 'hook', session: 's-master', slot: 'master' });
// an old request, closed eleven days ago: the brief counts it, it does not list it
put('request.open', { req: 's-master/1', text: 'Rotate the staging database password', source: 'user' }, api, m(-16000), { via: 'mod', session: 's-master', slot: 'master' });
put('request.state', { req: 's-master/1', state: 'done', text: 'Rotate the staging database password', proof: 'rotated; vault updated' }, api, m(-15900), { via: 'mod', session: 's-master', slot: 'master' });
put('spawn', { worker: 'api-fix', branch: 'fix/csv-export', repo, worktree: `${gf}/acme-api-1`, task: 'Fix the CSV export: a quoted comma splits one row into two', parent: 'master', base: 'main' }, api, m(1), { via: 'spawn' });
put('session.start', { branch: 'fix/csv-export', repo, cwd: `${gf}/acme-api-1` }, api, m(2), { via: 'hook', session: 's-apifix', slot: 'api-fix' });
put('prompt', { branch: 'fix/csv-export', repo, text: 'Fix the CSV export: a quoted comma splits one row into two' }, api, m(2), { via: 'hook', session: 's-apifix', slot: 'api-fix' });
put('ack', { worker: 'api-fix', branch: 'fix/csv-export', repo, understood: 'a quote-aware CSV writer, column order kept', decisions: 'RFC 4180 quoting; no new dependency' }, api, m(3), { via: 'ack' });
put('request.open', { req: 's-apifix/1', text: 'Fix the CSV export', source: 'fleet' }, api, m(3), { via: 'mod', session: 's-apifix', slot: 'api-fix' });
put('turn.end', { branch: 'fix/csv-export', repo, status: 'done', said: 'Opened PR #1170. The writer now quotes fields that hold a comma, a quote or a newline (the tokenizer the parser already used).', files: ['src/export/csv.js', 'test/export.test.js'], prs: [{ op: 'open', repo, number: 1170, url: 'https://github.com/acme/acme-api/pull/1170', branch: 'fix/csv-export' }] }, api, m(40), { via: 'hook', session: 's-apifix', slot: 'api-fix' });
put('request.state', { req: 's-apifix/1', state: 'done', text: 'Fix the CSV export', proof: 'https://github.com/acme/acme-api/pull/1170' }, api, m(41), { via: 'fleet-ledger', session: 's-apifix', slot: 'api-fix' });
put('pr.merge', { repo, number: 1170, branch: 'fix/csv-export' }, api, m(60), { via: 'fleet-merged' });
put('retire', { worker: 'api-fix', branch: 'fix/csv-export', repo, reason: 'reclaim, PR MERGED 1170' }, api, m(62), { via: 'retire' });
// The graph keeps a session's LATEST prompt, so this one — replaced at m110 — survives in the
// raw log alone: what `find` has to reach for the test that it reads more than the graph.
put('prompt', { branch: 'main', repo, text: 'Ship 1170 once the nightly invoice replay passes' }, api, m(64), { via: 'hook', session: 's-master', slot: 'master' });
put('turn.end', { branch: 'main', repo, status: 'done', said: 'Merged #1170 and deployed it.', files: ['CHANGELOG.md'], deploys: [{ target: 'vercel', cmd: 'vercel deploy --prod', commit: 'a1b2c3d4e5f6', ok: true }] }, api, m(70), { via: 'hook', session: 's-master', slot: 'master' });
put('decision', { text: 'Keep the v1 export endpoint until acme-web moves to v2', why: 'acme-web still calls /v1/export', source: 'stated' }, api, m(72), { via: 'fleet-know', slot: 'master' });
// a second worker: an open PR, a finished turn, so it waits on review; a need-you after
put('spawn', { worker: 'docs-pass', branch: 'docs/setup-pass', repo, worktree: `${gf}/acme-api-2`, task: 'Tighten the README setup section', parent: 'master', base: 'main' }, api, m(80), { via: 'spawn' });
put('session.start', { branch: 'docs/setup-pass', repo, cwd: `${gf}/acme-api-2` }, api, m(81), { via: 'hook', session: 's-docs', slot: 'docs-pass' });
put('turn.end', { branch: 'docs/setup-pass', repo, status: 'done', said: 'Opened PR #1184 for the setup section.', files: ['README.md'], prs: [{ op: 'open', repo, number: 1184, url: 'https://github.com/acme/acme-api/pull/1184', branch: 'docs/setup-pass' }] }, api, m(95), { via: 'hook', session: 's-docs', slot: 'docs-pass' });
put('request.open', { req: 's-master/2', text: 'Which plan tier should the rate limit apply to?', source: 'fleet' }, api, m(100), { via: 'mod', session: 's-master', slot: 'master' });
put('request.state', { req: 's-master/2', state: 'waiting', text: 'Which plan tier should the rate limit apply to?' }, api, m(101), { via: 'mod', session: 's-master', slot: 'master' });
put('prompt', { branch: 'main', repo, text: 'Add a rate limit to the export endpoint, per API key' }, api, m(110), { via: 'hook', session: 's-master', slot: 'master' });
put('need-you', { branch: 'main', repo, note: 'Claude needs your permission to use Bash' }, api, m(111), { via: 'hook', session: 's-master', slot: 'master' });

// acme-web: one turn, which touched a file acme-api's worker touched too
const web = W('cf-acme-web', 'acme-web');
put('relate', { rel: 'depends-on', to: 'acme-api' }, web, m(-20000));
put('turn.end', { branch: 'main', repo: 'acme/acme-web', status: 'done', said: 'Moved the export button to the v1 endpoint.', files: ['src/export/csv.js'] }, web, m(50), { via: 'hook', session: 's-web', slot: 'master' });

// toolbox: EXCLUDED — these calls must write nothing
put('prompt', { branch: 'main', text: 'toolbox prompt that must not be recorded' }, W('cf-toolbox', 'toolbox'), m(5), { via: 'hook', session: 's-tool', slot: 'master' });

// scratch, on the personal profile: PRIVATE
const scr = { fleetDir: personal, sock: 'cf-personal-scratch', project: 'scratch' };
put('prompt', { branch: 'main', text: 'Try the streaming parser idea on the sample file' }, scr, m(20), { via: 'hook', session: 's-scr', slot: 'master' });
put('decision', { text: 'Parse in chunks of 64 KiB', why: 'the sample file is 2 GB', source: 'stated' }, scr, m(25), { via: 'fleet-know', slot: 'master' });

process.stdout.write(`${T0}\n`);
