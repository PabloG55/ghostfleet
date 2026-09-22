#!/usr/bin/env node
// stepper-check — drive the review page's stepper and print what it did.
//
// WHY DRIVEN AND NOT ASSERTED ON THE MARKUP: the stepper is behaviour, and its first two
// bugs were both invisible in the source. A `\n` inside the outer template literal emitted a
// real newline into a single-quoted JS string, so the whole script was a syntax error while
// the page still LOOKED right — the action bar is static markup and drew perfectly. Then the
// checkbox-era toggle survived into it, so pressing approve on an already-approved step
// unset the verdict and refused to advance: the button appeared dead on exactly the second
// press. Neither is findable by reading; both are one click away.
//
// Emits one `name\x1f want\x1f got` row per check, the same wire test/run.sh already reads
// from viewport-check, so a failure names itself instead of arriving as an exit code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../../lib/browser.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(`${name}${US}${want}${US}${got}`);

// A run with one clean step and one the RUN flagged, which is the whole matrix: a flagged
// step is the only place the reason requirement applies, and a clean one proves the
// requirement is not applied everywhere.
// A ROOT THIS FILE OWNS, with the run INSIDE it — not the run in $TMPDIR and `serve`
// pointed at $TMPDIR's parent listing.
//
// It used to be the latter, and `--dir` was therefore the whole shared temp directory:
// every run this machine had ever made, plus anything else that happens to live there.
// `serve` lists a directory by looking for a `manifest.json` in it, and `manifest.json` is
// one of the most common filenames in computing. Measured: a browser update unpacked its
// components into that directory, each one carrying a manifest.json of an unrelated schema
// — and the server died on its first request, so this helper drove a browser at a refused
// connection and reported six rows about a stepper that had never loaded.
//   bin/fleet-shots.mjs no longer crashes on a foreign manifest, and that is the real fix.
// This is the other half: a test that shares a directory with the rest of the machine is
// a test whose result depends on what else is on the machine, and no amount of hardening
// in the thing under test makes that a controlled experiment. 6,092 entries were in that
// directory when this was written.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-stepper-'));
const dir = path.join(root, 'run');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  provenance: { commit: '0'.repeat(40), branch: 'b', dirty: false, base: 'http://x',
                slot: 1, viewport: { width: 800, height: 600 }, at: '2026-01-01T00:00:00.000Z' },
  steps: [
    { n: 1, name: 'a clean step', file: null, url: 'http://x/a', title: 'A',
      expect: { text: 'hi', found: true, how: 'exact' }, notes: [], requests: [] },
    { n: 2, name: 'a flagged step', file: null, url: 'http://x/b', title: 'B',
      expect: null, notes: ['POST http://x/api answered 404'], requests: [] },
  ], problems: 1,
}));

// SERVED, NOT RENDERED IN-PROCESS. The page generator is not exported, and duplicating it
// here is how a test comes to pass against a renderer nobody ships. So this asks the real
// `serve` for the real page — the artifact a human actually gets.
const bin = new URL('../../bin/fleet-shots.mjs', import.meta.url).pathname;
const net = await import('node:net');
const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const { spawn } = await import('node:child_process');
// STDERR IS KEPT, NOT DISCARDED. It was `['ignore','ignore','ignore']`, and when the
// server died on its first request the only trace was six rows saying the stepper had no
// state — a crash reported as a UI that does not work. The server's own stack trace names
// the cause in one line and was being thrown away at the moment it was written.
const srv = spawn(process.execPath, [bin, 'serve', '--dir', root, '--port', String(port)],
  { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
let srvExit = null;
srv.on('exit', (code, signal) => { srvExit = signal ? `signal ${signal}` : `code ${code}`; });
const base = `http://127.0.0.1:${port}`;
const runName = path.basename(dir);

let b = null;
try {
  // WAIT FOR IT TO ANSWER, AND REFUSE TO CARRY ON IF IT NEVER DOES. This loop used to run
  // out and fall through, so a server that never came up produced a browser pointed at a
  // refused connection and six rows about a stepper with no state — every one of them
  // describing the page, none of them true, and the actual cause (the server exited 1 on
  // its first request) thrown away with its stderr.
  //   A precondition that fails is ONE row naming the precondition, not a screenful about
  // the thing it was a precondition for.
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (srvExit !== null) break;                    // it died; stop waiting for it
    try { const r = await fetch(base + '/'); if (r.ok) { up = true; break; } } catch {}
    await sleep(100);
  }
  if (!up) {
    const why = srvExit !== null ? `exited ${srvExit}` : 'never answered in 8s';
    // The server's own first error line, which is the thing worth reading.
    const line = (srvErr.split('\n').find(l => /Error|error:/.test(l)) || '').trim().slice(0, 120);
    is('the review server came up', 'yes', `no: ${why}${line ? ` — ${line}` : ''}`);
    throw new Error(`review server ${why}`);
  }
  is('the review server came up', 'yes', 'yes');
  b = await launch({ width: 1000, height: 700, scale: 1 });
  await b.call('Page.navigate', { url: `${base}/r/${encodeURIComponent(runName)}/` });
  for (let i = 0; i < 80; i++) { if (await b.evaluate(() => document.readyState) === 'complete') break; await sleep(100); }
  await sleep(300);

  const look = () => b.evaluate(() => {
    const i = [...document.querySelectorAll('.step')].findIndex(e => e.classList.contains('here'));
    const el = document.querySelectorAll('.step')[i];
    const n = el && el.querySelector('.needs');
    return {
      pos: (document.getElementById('pos') || {}).textContent || '',
      idx: i,
      needs: !!(n && !n.hidden),
      railOk: [...document.querySelectorAll('#rail button')].map(x => (x.className.match(/v-\w+/) || [''])[0]).join(','),
      backOff: !!(document.getElementById('prev') || {}).disabled,
    };
  });
  const click = (sel) => b.evaluate((q) => { const e = document.querySelector(q); if (e) e.click(); return !!e; }, sel);

  // THE SCRIPT RAN AT ALL. If it threw, `pos` is empty and every row below is meaningless,
  // so this is asserted first and by itself.
  const a0 = await look();
  is('the stepper script ran', '1 / 2', a0.pos);
  is('...and back is off on the first step', 'true', String(a0.backOff));

  // A CLEAN STEP: approve moves on.
  await click('.acts .v.approve'); await sleep(200);
  const a1 = await look();
  is('approve advances a clean step', '2 / 2', a1.pos);
  is('...and the rail records it', 'v-ok,', a1.railOk);

  // A FLAGGED STEP: approve must HOLD and ask for a reason. This is the row the whole
  // requirement rests on — the rule existed before and enforced itself silently, so a
  // reviewer marked everything and only learned at the index that nothing had cleared.
  await click('.acts .v.approve'); await sleep(250);
  const a2 = await look();
  is('a flagged step does not advance', '2 / 2', a2.pos);
  is('...and it says a reason is wanted', 'true', String(a2.needs));

  // A REASON RELEASES IT.
  await b.evaluate(() => {
    const t = document.querySelectorAll('.step')[1].querySelector('textarea');
    t.value = 'known benign'; t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  is('...and a reason withdraws the demand', 'false', String((await look()).needs));
  // AND THEN IT ADVANCES — the bug here was a toggle: the second press unset the verdict.
  await click('.acts .v.approve'); await sleep(250);
  is('approve is not a toggle', 'summary', (await look()).pos);

  // CHANGES HOLDS, ALWAYS. Asserted on the clean step, so it cannot pass because of the
  // flag rule above.
  await b.evaluate(() => { document.querySelectorAll('#rail button')[0].click(); });
  await sleep(200);
  await click('.acts .v.changes'); await sleep(250);
  const a3 = await look();
  is('changes never advances', '1 / 2', a3.pos);
  is('...and marks the rail', 'v-problem,v-ok', a3.railOk);

  // GOING BACK KEEPS THE VERDICTS, which is the point of being able to go back at all.
  await click('#next'); await sleep(150);
  await click('#prev'); await sleep(200);
  const a4 = await look();
  is('back returns to the step', '1 / 2', a4.pos);
  is('...with the verdicts intact', 'v-problem,v-ok', a4.railOk);

  // THE GATE DOES NOT LAUNDER. Everything is marked; the flag carries a reason; the
  // `changes` on step 1 must still refuse.
  await b.evaluate(() => { document.getElementById('next').click(); document.getElementById('next').click(); });
  await sleep(300);
  const gate = await b.evaluate(() => (document.getElementById('gate') || {}).textContent || '');
  is('the summary refuses a rejected step', '1', String(/REFUSE/.test(gate) ? 1 : 0));
} catch (e) {
  is('stepper-check ran', 'yes', `no: ${String(e && e.message || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  try { srv.kill('SIGKILL'); } catch {}
  // The ROOT, not just the run inside it — or every invocation leaves an empty directory
  // in $TMPDIR forever, which is the same accumulation that made this bug findable.
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(rows.join('\n') + '\n');
