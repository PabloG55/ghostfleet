#!/usr/bin/env node
// browser-stall — a Chrome that stops answering is a red row, not a hung job.
//
//     node test/helpers/browser-stall.mjs        # "name <US> want <US> got" rows
//
// THE HANG THIS EXISTS FOR. Every CDP reply used to be awaited with no deadline, so a browser
// that went quiet held its caller forever, and the macOS CI leg twice sat inside a fleet-look
// group until the job's 30-minute timeout cancelled it, with a Chrome and a node still alive
// at the cancel and not one row to say where. Here the quiet is made on purpose: THIS run's
// Chrome, addressed by the pid launch() hands back and by nothing broader, is stopped with
// SIGSTOP, which keeps its socket open and its answers away — the shape of a wedged browser
// rather than a dead one, where a closed socket would have failed loudly on its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, serveDir } from '../../lib/browser.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
// The helper bounds ITSELF as well, so a regression in the very thing it tests cannot turn
// it into the hang it is here to rule out.
setTimeout(() => { is('a stalled browser is let go', 'yes', 'no: browser-stall itself ran past 120s'); done(1); }, 120000).unref();

const CALL_MS = 2000;
let b = null, r = null, srv = null, webdir = '';
try {
  try { b = await launch({ width: 400, height: 300, callMs: CALL_MS }); }
  catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { rows.push('#SKIP' + US + 'a stalled browser' + US + 'no chrome'); done(0); }
    throw e;
  }
  is('a browser that answers answers', 2, await b.evaluate(() => 1 + 1));
  process.kill(-b.pid, 'SIGSTOP');
  const t0 = Date.now();
  let err = '';
  try { await b.evaluate(() => 1 + 1); err = 'it answered'; } catch (e) { err = String((e && e.message) || e); }
  const took = Date.now() - t0;
  is('a call to a stopped browser fails instead of waiting', 'yes',
     took < CALL_MS * 3 ? 'yes' : `no: it took ${took}ms against a ${CALL_MS}ms deadline`);
  is('...and says which call and why', 'Runtime.evaluate: no answer from Chrome in 2s', err);
  await b.close();
  let alive = 'gone';
  try { process.kill(b.pid, 0); alive = 'still running'; } catch {}
  is('...and close() still ends it', 'gone', alive);

  // ── a PAGE that stops answering while its browser still does ────────────────────────
  // lib/browser.mjs `replaceStuckPage`: an evaluate nobody answered runs ONCE more on a
  // fresh page. The danger in that is a retry that makes a real failure disappear, so each
  // row below is one way it must NOT: a wrong answer, a thrown error, a page that is silent
  // twice, and a launch that never asked for it. The silence is made by the page itself
  // (an endless loop) because that is the one stall that leaves the browser answering.
  webdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-stall-'));
  fs.writeFileSync(path.join(webdir, 'index.html'), '<!doctype html><title>stall</title>');
  srv = await serveDir(webdir);
  r = await launch({ width: 400, height: 300, callMs: CALL_MS, replaceStuckPage: true });
  await r.call('Page.navigate', { url: srv.base + '/index.html' });
  for (let i = 0; i < 100 && (await r.evaluate(() => document.readyState).catch(() => '')) !== 'complete'; i++) await new Promise(x => setTimeout(x, 100));
  // Stuck once, fine the second time: the flag lives in localStorage, which the fresh page
  // shares with the one it replaced.
  const spinOnce = () => { if (!localStorage.getItem('spun')) { localStorage.setItem('spun', '1'); for (;;) {} } return 'answered'; };
  const t1 = Date.now();
  is('a page silent once is answered on a fresh page', 'answered', await r.evaluate(spinOnce).catch(e => 'threw: ' + e.message));
  is('...and that is recorded, naming the call that went unanswered', 'yes',
     r.retries.length === 1 && /^Runtime\.evaluate: no answer from Chrome in 2s/.test(r.retries[0]) ? 'yes' : 'no: ' + JSON.stringify(r.retries));
  is('...within a bound', 'yes', Date.now() - t1 < 30000 ? 'yes' : 'no: ' + (Date.now() - t1) + 'ms');
  is('...on the page it was on, not a blank one', 'http://127.0.0.1', (await r.evaluate(() => location.origin)).replace(/:\d+$/, ''));
  is('a page that answers wrongly is handed back as it is', 'wrong', await r.evaluate(() => 'wrong'));
  let thrown = '';
  try { await r.evaluate(() => { throw new Error('page said no'); }); thrown = 'it did not throw'; } catch (e) { thrown = String(e.message).replace(/ \(line \d+\)$/, ''); }
  is('a page that throws still throws', 'Error: page said no', thrown);
  is('...and neither is retried', 1, r.retries.length);
  let twice = '';
  try { await r.evaluate(() => { for (;;) {} }); twice = 'it answered'; } catch (e) { twice = String(e.message); }
  is('a page silent twice is a red row, after exactly one retry', 'Runtime.evaluate: no answer from Chrome in 2s|2', twice + '|' + r.retries.length);
  await r.close(); r = null;
  // Not asked for, not done: every other caller keeps the failure it always had.
  r = await launch({ width: 400, height: 300, callMs: CALL_MS });
  let plain = '';
  try { await r.evaluate(() => { for (;;) {} }); plain = 'it answered'; } catch (e) { plain = String(e.message); }
  is('a launch that did not ask for a retry gets none', 'Runtime.evaluate: no answer from Chrome in 2s|0', plain + '|' + (r.retries || []).length);
} catch (e) {
  is('browser-stall ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { process.kill(-b.pid, 'SIGCONT'); } catch {} try { await b.close(); } catch {} }
  if (r) { try { await r.close(); } catch {} }
  if (srv) srv.close();
  if (webdir) { try { fs.rmSync(webdir, { recursive: true, force: true }); } catch {} }
}
done(0);
