#!/usr/bin/env node
// test/helpers/screen-measure.mjs — what each screen costs to open, in a real browser.
//
//     node test/helpers/screen-measure.mjs [web-dir] [--hold 300] [--idle 30] [--only home,session] [--shots dir]
//                                          [--sessions api-fix,master] [--fixture grid-degraded.json]
//
// Not a suite row: a table. It is run on a checkout before a change and on the same checkout
// after it, and the two tables are the argument (paste both in the PR). `web-dir` defaults to
// this checkout's web/, so an extracted copy of another commit is measured with the same
// instrument, which is the point of keeping the instrument out of the client.
//
// PER SCREEN, at 390 and at 1280, opened COLD (a page of its own, from about:blank, so nothing
// a screen before it read is still in memory):
//   paint   ms from the lock opening to the first frame in which the page has a box
//   data    ms until nothing on it says it is waiting (no skeleton, no "Loading…"), a read having
//           answered. Not "until no read is out": the app's own poll of the fleet is always out
//           somewhere, and in fixture mode it is a chain of twenty
//   reqs    reads made in the first ten seconds, and their bytes
//   idle    reads a minute once it has settled, counted over --idle seconds
//   hidden  the same with another tab in front of it
//   shift   how far the page moved after its first frame: the browser's own layout-shift score,
//           summed, and the furthest any one block was moved, in px
//   held    the furthest anything drawn while the screen waited was moved by the time it had
//           settled, in px, and what it was. Measured directly, rect against rect: the browser
//           names at most five nodes per shift, the largest, so a button that moved inside a row
//           that also moved goes unnamed there and its distance uncounted
//
// --sessions opens the session screen once per named session of acme-api instead of api-fix
// alone, and --fixture picks which acme-api fleet the demo serves (the settings sheet's choice):
// the session header draws different controls in each state, and a header that holds still for
// one state can move in the next. --idle 0 skips the idle and hidden counts, for a table that is
// only about moves. --first skips the returning-device visit below: a first-ever launch, with
// nothing remembered on the device.
//
// EVERY FIXTURE READ IS HELD --hold MS. On a laptop reading local files a read answers inside a
// frame, and a screen that jumps when its data lands is measured as still. The hold is put in
// from outside, before the page's code, so a client with no skeletons is held exactly as long.
import path from 'node:path';
import fs from 'node:fs';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(name); return i < 0 ? d : argv[i + 1]; };
const WEB = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : path.join(ROOT, 'web'));
const HOLD = Number(opt('--hold', 300));
const IDLE = Number(opt('--idle', 30));
const ONLY = String(opt('--only', '')).split(',').filter(Boolean);
const SHOTS = opt('--shots', '');
const SESSIONS = String(opt('--sessions', '')).split(',').filter(Boolean);
const FIXTURE = opt('--fixture', '');
const FIRST = argv.includes('--first');

const SCREENS = [
  ['home', '#/'], ['project', '#/p/acme-api'], ['session', '#/p/acme-api/s/api-fix'], ['map', '#/map'],
  ['reviews', '#/reviews'], ['queue', '#/queue'], ['search', '#/search?q=api'], ['activity', '#/activity'],
  ['automations', '#/automations'], ['settings', '#/settings'], ['stacks', '#/stack-picker'],
].flatMap(([n, x]) => n === 'session' && SESSIONS.length
  ? SESSIONS.map(s => [`session ${s}`, `#/p/acme-api/s/${encodeURIComponent(s)}`]) : [[n, x]])
 .filter(([n]) => !ONLY.length || ONLY.includes(n.split(' ')[0]));

// In the page before its own code: every read written down (when it left, when it answered,
// how many bytes), every layout shift, and a frame loop that notes the first frame with a
// page in it and the first one with nothing left waiting.
const PROBE = `(() => {
  const HOLD = ${HOLD};
  const M = window.__m = { t0: 0, paint: 0, data: 0, reads: [], out: 0, shift: 0, far: 0, shifts: [] };
  const f0 = window.fetch.bind(window);
  window.fetch = async (u, o) => {
    const url = String((u && u.url) || u);
    const row = { at: performance.now(), url, bytes: 0, hidden: document.hidden };
    M.reads.push(row); M.out++;
    try {
      if (HOLD && /fixtures\\//.test(url)) await new Promise(r => setTimeout(r, HOLD));
      const res = await f0(u, o);
      try { row.bytes = (await res.clone().arrayBuffer()).byteLength; } catch {}
      return res;
    } finally { M.out--; row.done = performance.now(); }
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!M.paint || e.startTime < M.paint) continue;
        M.shift += e.value;
        for (const s of e.sources || []) {
          const d = Math.max(Math.abs(s.currentRect.top - s.previousRect.top), Math.abs(s.currentRect.left - s.previousRect.left));
          if (d > M.far) M.far = d;
          if (d >= 2 && M.shifts.length < 12) M.shifts.push([Math.round(e.startTime - M.t0), Math.round(d), s.node && s.node.className ? String(s.node.className).slice(0, 40) : (s.node && s.node.nodeName) || '?']);
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  const waiting = () => {
    const main = document.querySelector('.app .main');
    if (!main) return true;
    if (main.querySelector('.sk:not(.sk-line), .msg.skel, [aria-busy="true"]')) return true;
    return /Loading…|Loading\\.\\.\\.|Reading the fleet…|Reading the terminal…|Reading…/.test(main.textContent);
  };
  const tick = () => {
    if (M.t0) {
      const main = document.querySelector('.app .main');
      if (!M.paint && main && main.firstElementChild && main.firstElementChild.getBoundingClientRect().height > 0) M.paint = performance.now();
      if (M.paint && !M.data && M.reads.some(r => r.at >= M.t0 && r.done) && !waiting()) M.data = performance.now();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const out = [];
let b = null, srv = null;
const until = async (fn, ...a) => {
  for (let i = 0; i < 200; i++) { const v = await b.evaluate(fn, ...a).catch(() => null); if (v) return v; await sleep(50); }
  return null;
};
const shot = async (name) => {
  if (!SHOTS) return;
  const r = await b.call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
};

try {
  srv = await serveDir(WEB);
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    b = await launch({ width: w, height: h, scale: 1, mobile: w < 600 });
    await b.call('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    // A RETURNING DEVICE, which is what a phone with the app installed is on every launch but
    // its first: every screen is opened once, unmeasured, so what a client keeps on the device
    // between launches (a block's last height, a link the server does not offer) is there.
    // Kept in localStorage only; the measured open is still a page of its own with nothing in
    // memory, and a client that keeps nothing is measured exactly as it would be without this.
    for (const [name, hash] of [...(FIRST ? [] : SCREENS.map(([, x]) => ['warm', x])), ...SCREENS]) {
      await b.call('Page.navigate', { url: 'about:blank' });
      await until(() => location.href === 'about:blank');
      await b.call('Page.navigate', { url: srv.base + '/' + hash });
      const lock = await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
      if (!lock) { out.push({ w, name, error: 'the lock never drew' }); continue; }
      if (FIXTURE) await b.evaluate((f) => localStorage.setItem('gf.fixture', f), FIXTURE);
      if (name === 'warm') {
        await b.evaluate(() => [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey/i.test(x.textContent)).click());
        await sleep(5000);
        continue;
      }
      await b.evaluate(() => {
        window.__m.t0 = performance.now();
        [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey/i.test(x.textContent)).click();
      });
      await until(() => window.__m.paint > 0);
      await sleep(Math.min(HOLD, 250));
      await shot(`${w}-${name.replace(/ /g, '-')}-loading`);
      await b.evaluate(() => {
        // Everything on the screen now, bar the shapes standing in for data and whatever is inside
        // a scroller (it moves when the scroller does, which is not the page moving).
        const main = document.querySelector('.app .main');
        const scrolls = (el) => { for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
          const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll') return true; } return false; };
        window.__held = [];
        for (const el of main ? main.querySelectorAll('*') : []) {
          if (el.closest('.sk') || !el.getClientRects().length || scrolls(el)) continue;
          const r = el.getBoundingClientRect();
          window.__held.push([el, Math.round(r.left), Math.round(r.top), (typeof el.className === 'string' && el.className) || el.tagName]);
        }
      });
      const t = Date.now();
      await until(() => window.__m.data > 0);
      await sleep(Math.max(0, 10000 - (Date.now() - t)));
      await shot(`${w}-${name.replace(/ /g, '-')}-loaded`);
      const first = await b.evaluate(() => { const M = window.__m; const r = M.reads.filter(x => x.at >= M.t0 && x.at < M.t0 + 10000);
        return { paint: Math.round(M.paint - M.t0), data: M.data ? Math.round(M.data - M.t0) : null, reqs: r.length, bytes: r.reduce((n, x) => n + x.bytes, 0),
                 shift: Math.round(M.shift * 1000) / 1000, far: Math.round(M.far), shifts: M.shifts, n: M.reads.length,
                 ...(() => { let held = 0, what = '';
                   // a ship that bobs is drawn moving, on purpose: an element with a running
                   // animation, or inside one, is not counted
                   const moving = (el) => { for (let e = el; e; e = e.parentElement) if (e.getAnimations().some(a => a.playState === 'running' && a.effect?.target === e)) return true; return false; };
                   for (const [el, x, y, cls] of window.__held || []) {
                     if (!el.isConnected || !el.getClientRects().length || moving(el)) continue;
                     const r = el.getBoundingClientRect(), d = Math.max(Math.abs(Math.round(r.left) - x), Math.abs(Math.round(r.top) - y));
                     if (d > held) { held = d; what = String(cls).slice(0, 40); }
                   }
                   return { held, heldWhat: what }; })() }; });
      if (!IDLE) {
        delete first.n;
        out.push({ w, name, ...first, idlePerMin: '-', hiddenPerMin: '-' });
        process.stderr.write(`${w} ${name} ${JSON.stringify(out[out.length - 1])}\n`);
        continue;
      }
      await sleep(IDLE * 1000);
      const idle = await b.evaluate((n) => window.__m.reads.length - n, first.n);
      // which reads those were, most asked first: the name of what to share or slow down
      const idleWhat = await b.evaluate((n) => { const c = {}; for (const r of window.__m.reads.slice(n)) { const k = r.url.replace(/^.*\/(fixtures|api)\//, '').replace(/\?.*$/, ''); c[k] = (c[k] || 0) + 1; }
        return Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} x${v}`).join(', '); }, first.n);
      // another tab in front: what the app switcher does to an installed app
      const tab = await b.newTab();
      await sleep(8000);        // reads already out when it was hidden are let finish
      const n1 = await b.evaluate(() => window.__m.reads.length);
      await sleep(IDLE * 1000);
      const hidden = await b.evaluate((n) => window.__m.reads.length - n, n1);
      await b.call('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      await sleep(300);
      delete first.n;
      out.push({ w, name, ...first, idleWhat, idlePerMin: Math.round(idle * 60 / IDLE), hiddenPerMin: Math.round(hidden * 60 / IDLE) });
      process.stderr.write(`${w} ${name} ${JSON.stringify(out[out.length - 1])}\n`);
    }
    await b.close(); b = null;
  }
} finally {
  if (b) await b.close().catch(() => {});
  if (srv) await srv.close?.();
}

const kb = (n) => (n / 1024).toFixed(1);
console.log('| screen | width | paint ms | data ms | reads in 10 s | KB in 10 s | reads/min idle | reads/min hidden | shift score | furthest move px | drawn waiting, moved px |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of out) console.log(r.error ? `| ${r.name} | ${r.w} | ${r.error} |` :
  `| ${r.name} | ${r.w} | ${r.paint} | ${r.data ?? 'never'} | ${r.reqs} | ${kb(r.bytes)} | ${r.idlePerMin} | ${r.hiddenPerMin} | ${r.shift} | ${r.far} | ${r.held}${r.held ? ` (${r.heldWhat})` : ''} |`);
if (opt('--json', '')) fs.writeFileSync(opt('--json', ''), JSON.stringify(out, null, 1));
process.exit(0);
