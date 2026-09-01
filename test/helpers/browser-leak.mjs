#!/usr/bin/env node
// test/helpers/browser-leak.mjs — does close() reach the processes it did not spawn?
//
//     node test/helpers/browser-leak.mjs [module]     prints "procs=<n> dir=<yes|no>"
//
// WHY THIS IS NOT A PLAIN PROCESS COUNT AFTER A SCREENSHOT. That was the first version of
// the row this feeds, and it passed with the bug fully restored. A headless Chrome is ten
// processes — one browser and nine renderer/GPU/utility helpers, all carrying
// --user-data-dir — and killing the one we spawned leaves the other nine to notice by
// themselves. On an idle machine they notice in single-digit milliseconds, so any check
// that sleeps first reads zero and goes green. The leak that put 266 orphans and a load
// average of 30 on one machine is those nine failing to be scheduled in time, over and over,
// on a machine already busy because of the last time it happened.
//
// SO THE SCHEDULING DELAY IS MADE EXPLICIT INSTEAD OF WAITED FOR. Every helper is SIGSTOPped
// before close() is called. A stopped process is one that will not be scheduled to notice
// its parent died — which is what load does, in degree rather than in kind — and SIGKILL
// still reaches it, so a close() that signals the process GROUP cleans up and a close() that
// signals one pid does not. Measured, twice each: nine survivors on the old close, zero on
// the new one, with no run-to-run variation in either.
//
// It takes about four seconds against the fixed module, and that is the fix working: with
// its children stopped, Chrome cannot complete the graceful shutdown Browser.close asked
// for, so the wait runs to its timeout and the group kill behind it does the job. A fast
// answer here would mean the ask was never really tried.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = process.argv[2] || path.join(HERE, '..', '..', 'lib', 'browser.mjs');
const pidsFor = (p) => {
  try { return execFileSync('pgrep', ['-f', '--', '--user-data-dir=' + p], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean); } catch { return []; }
};

let prof = null, helpers = [];
try {
  const { launch } = await import(path.isAbsolute(mod) ? mod : path.resolve(mod));
  // The profile is whichever gf-browser-* appeared while we were launching. Compared as a
  // set against a before-snapshot rather than picked by mtime: another suite run may be
  // creating its own at the same moment, and "the newest" would sometimes be that one.
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('gf-browser-')));
  const b = await launch({ width: 200, height: 200 });
  const mine = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('gf-browser-') && !before.has(d));
  if (mine.length !== 1) { console.log(`inconclusive=${mine.length} profiles appeared`); process.exit(0); }
  prof = path.join(os.tmpdir(), mine[0]);

  // The top-level browser is the one whose parent is this process; everything else is a
  // helper. Derived rather than assumed: the count and the order both vary by platform and
  // by Chrome build, and a fixture that hard-codes "the first pid" measures the wrong one.
  const all = pidsFor(prof);
  const top = all.filter((p) => {
    try { return execFileSync('ps', ['-o', 'ppid=', '-p', p], { encoding: 'utf8' }).trim() === String(process.pid); }
    catch { return false; }
  });
  helpers = all.filter((p) => !top.includes(p));
  if (!helpers.length) { console.log('inconclusive=no helper processes to stop'); process.exit(0); }
  for (const h of helpers) { try { process.kill(Number(h), 'SIGSTOP'); } catch {} }

  await b.close();
  console.log(`procs=${pidsFor(prof).length} dir=${fs.existsSync(prof) ? 'yes' : 'no'}`);
} catch (e) {
  console.log(`inconclusive=${String((e && e.message) || e).split('\n')[0].slice(0, 80)}`);
} finally {
  // Resume before killing: a stopped process cannot act on SIGTERM, and leaving one stopped
  // is a worse leak than the one being measured — it never exits and nothing lists it as
  // running. Then kill and remove BY THE EXACT PATH this run created, never by a glob:
  // another suite run owns directories with the same prefix, and a glob would take its
  // browser out from under it.
  for (const h of helpers) { try { process.kill(Number(h), 'SIGCONT'); } catch {} }
  if (prof) {
    try { execFileSync('pkill', ['-f', '--', '--user-data-dir=' + prof]); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
}
process.exit(0);
