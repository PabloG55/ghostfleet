#!/usr/bin/env node
// prepush-check — drive .githooks/pre-push against a throwaway repo and report what it did.
//
// WHY DRIVEN AND NOT READ. The hook's job is to exit non-zero, and every way it can be
// broken leaves it exiting ZERO: a missing import, a regex that matches nothing, a range
// that resolves empty, `process.exit` on the wrong branch. All of those look identical to
// "there was nothing to find", which is the one answer this hook must never fake. So it is
// run, against a real remote, with real commits, and the assertion is the exit status.
//
// WITH A CANARY, NOT A REAL NAME. Driving this needs a token the hook's list contains, and
// writing a real one here would put it back in the tree the hook exists to protect —
// name-sweep.mjs section 3 makes the same choice for the same reason. So the throwaway
// repo gets a COPY of name-sweep.mjs with one extra digest injected, and the tests push a
// name that is not a name. That also proves the hook reads the list it is given rather
// than a copy baked into itself.
//
// EVERY CASE BELOW WAS A REAL LEAK IN THIS REPO on 2026-09-18: 37 public branches, 650
// occurrences, and two of the shapes (a name in a FILE NAME, a name in a COMMIT MESSAGE)
// are invisible to the suite's own tracked-file sweep.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const US = '\x1f';
const rows = [];
const is = (n, w, g) => rows.push(`${n}${US}${w}${US}${g}`);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CANARY = ['zz', 'notaname', 'zz'].join('');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-prepush-'));
const src = path.join(dir, 'src'), rem = path.join(dir, 'rem');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });

try {
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(rem, { recursive: true });
  execFileSync('git', ['-C', rem, 'init', '-q', '--bare']);
  execFileSync('git', ['-C', src, 'init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email','t@t'],['user.name','t'],['core.hooksPath','.githooks']]) g(src, 'config', k, v);
  g(src, 'remote', 'add', 'origin', rem);

  // the hook, verbatim, and a COPY of the sweep with the canary added to its list
  fs.mkdirSync(path.join(src, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(src, 'test/helpers'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.githooks/pre-push'), path.join(src, '.githooks/pre-push'));
  fs.chmodSync(path.join(src, '.githooks/pre-push'), 0o755);
  const sweepSrc = path.join(ROOT, 'test/helpers/name-sweep.mjs');
  const { digest } = await import(pathToFileURL(sweepSrc).href);
  let sweep = fs.readFileSync(sweepSrc, 'utf8');
  const anchor = 'export const DENY = new Set([';
  is('the sweep copy could be seeded', 'true', String(sweep.includes(anchor)));
  sweep = sweep.replace(anchor, `${anchor}\n  '${digest(CANARY)}',   // injected by prepush-check`);
  fs.writeFileSync(path.join(src, 'test/helpers/name-sweep.mjs'), sweep);

  fs.writeFileSync(path.join(src, 'README.md'), 'nothing withheld here\n');
  g(src, 'add', '-A'); g(src, 'commit', '-q', '-m', 'clean baseline');

  // returns the hook's exit status for a push of `ref`
  const push = (ref) => {
    try { g(src, 'push', 'origin', ref); return 0; }
    catch (e) { return e.status ?? 1; }
  };
  const why = (ref) => { try { g(src, 'push', 'origin', ref); return ''; }
                         catch (e) { return String(e.stderr || '').replace(/\s+/g, ' '); } };

  // ── THE DIRECTION THAT MATTERS LEAST IS ASSERTED FIRST. A hook that refuses
  // everything would pass every case below; this is the row that rules it out.
  is('a clean push is allowed', '0', String(push('main')));

  const branch = (name, build) => {
    g(src, 'checkout', '-q', '-b', name, 'main');
    build();
    g(src, 'add', '-A');
    try { g(src, 'commit', '-q', '-m', 'work'); } catch {}
  };

  branch('c-content', () => fs.writeFileSync(path.join(src,'notes.md'), `the ${CANARY} dashboard\n`));
  is('a name in file CONTENT is refused', '1', String(push('c-content')));

  // THE SUITE'S OWN BLIND SPOT: name-sweep reads `ls-files` CONTENTS, never the names.
  // Nine committed paths in this repo carried one until they were renamed by hand.
  branch('c-path', () => { fs.mkdirSync(path.join(src,'web/fixtures'), {recursive:true});
                           fs.writeFileSync(path.join(src,`web/fixtures/grid-${CANARY}.json`), '{}\n'); });
  is('a name in a FILE NAME is refused', '1', String(push('c-path')));
  is('...and it says the name was the problem', 'true',
     String(/in the FILE NAME/.test(why('c-path'))));

  branch('c-msg', () => fs.writeFileSync(path.join(src,'f.txt'), 'x\n'));
  g(src, 'commit', '-q', '--amend', '-m', `seen while working on ${CANARY}`);
  is('a name in a COMMIT MESSAGE is refused', '1', String(push('c-msg')));

  branch(`feat/${CANARY}-thing`, () => fs.writeFileSync(path.join(src,'g.txt'), 'y\n'));
  is('a name in the REF NAME is refused', '1', String(push(`feat/${CANARY}-thing`)));

  // REMOVING IT LATER DOES NOT UNPUBLISH IT: the blob still travels with the push.
  branch('c-gone', () => fs.writeFileSync(path.join(src,'tmp.md'), `the ${CANARY} thing\n`));
  g(src, 'rm', '-q', path.join(src,'tmp.md')); g(src, 'commit', '-q', '-m', 'remove it again');
  is('added-then-deleted in one push is refused', '1', String(push('c-gone')));

  // NO MATCHER, NO PUSH. A hook that cannot find its list must refuse, not wave it through.
  fs.rmSync(path.join(src, 'test/helpers/name-sweep.mjs'));
  branch('c-nosweep', () => fs.writeFileSync(path.join(src,'h.txt'), 'harmless\n'));
  is('a missing sweep refuses rather than passing', '1', String(push('c-nosweep')));
} catch (e) {
  is('prepush-check ran', 'yes', `no: ${String(e && e.message || e)}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(rows.join('\n') + '\n');
