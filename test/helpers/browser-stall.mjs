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
import { launch } from '../../lib/browser.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
// The helper bounds ITSELF as well, so a regression in the very thing it tests cannot turn
// it into the hang it is here to rule out.
setTimeout(() => { is('a stalled browser is let go', 'yes', 'no: browser-stall itself ran past 45s'); done(1); }, 45000).unref();

const CALL_MS = 2000;
let b = null;
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
} catch (e) {
  is('browser-stall ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { process.kill(-b.pid, 'SIGCONT'); } catch {} try { await b.close(); } catch {} }
}
done(0);
