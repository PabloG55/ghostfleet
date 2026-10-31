#!/usr/bin/env node
// paired-check — one web client, two machines: what the phone and the desk DRAW once a second
// fleet-serve is paired with the one that served the page.
//
//     node test/helpers/paired-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. Pointed at a `git archive` of staging — which
// has no idea a project can live on another machine — every row about the host goes red,
// which is how each was watched before it was trusted. The rows about a machine on its own
// pass there too, and must: pairing nothing changes nothing.
//
// FIXTURE MODE, from this checkout's web/fixtures/paired.json, chosen with the
// `gf.fixture.paired` key ('online' | 'offline'). The server half — that the daemon really
// merges, proxies, refuses and audits — is pair-check.mjs's, against two live fleet-serves;
// this one is only about the screens, at a phone's size with touch and a desk's with a mouse.
import { launch, sleep, serveDir } from '../../lib/browser.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

let b = null, srv = null;
try {
  srv = await serveDir(WEB);
  try {
    b = await launch({ width: 1600, height: 900, scale: 1, mobile: false,
      args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  } catch (e) {
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the paired client', 'no chrome to look in'); done(0); }
    throw e;
  }
  await b.call('Network.enable');
  await b.call('Network.setBypassServiceWorker', { bypass: true });
  const base = srv.base;
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(600); };
  async function until(cond, ms = 8000) {
    const t0 = Date.now();
    let v = await cond();
    while (!v && Date.now() - t0 < ms) { await sleep(80); v = await cond(); }
    return v;
  }
  const look = () => b.evaluate(() => {
    const t = (q) => ((document.querySelector(q) || {}).textContent || '').trim();
    const list = document.querySelector('#side .cards') || document.querySelector('#app .cards');
    const cards = list ? [...list.querySelectorAll('.card')] : [];
    const meta = (c) => [...c.querySelectorAll('.c-where')].map(n => n.textContent.trim())[0] || '';
    return {
      duo: document.documentElement.classList.contains('duo'),
      main: t('#app > .hdr .scope'),
      // the list beside it at a desk — Projects, or a project's grid once one is open
      side: t('#side > .hdr .scope'),
      // no-break spaces read as spaces: the row is about the words, not how they are kept together
      tabs: [...document.querySelectorAll('.seg.tabs button')].map(n => n.textContent.replace(/\u00a0/g, ' ').trim()),
      tabKeys: [...document.querySelectorAll('.seg.tabs button.k')].map(n => n.textContent.trim()),
      projects: cards.filter(c => c.classList.contains('k-project')).map(c => `${(c.querySelector('.c-name') || {}).textContent.trim()} | ${meta(c)}`),
      nums: cards.filter(c => c.classList.contains('k-project')).map(c => ((c.querySelector('.c-num') || {}).textContent || '').trim()).join(','),
      hosts: cards.filter(c => c.classList.contains('k-host')).map(c => `${(c.querySelector('.c-name') || {}).textContent.trim()} | ${((c.querySelector('.chip.st') || {}).textContent || '').trim()}`),
      usage: t('.usage, .u-line, .accounts'),
      queue: t('.queue-row'),
      held: [...document.querySelectorAll('.card.k-waiting')].map(c => `${(c.querySelector('.c-name') || {}).textContent.trim()} | ${meta(c)}`),
      sheet: t('#sheet h2'),
      sheetRows: [...document.querySelectorAll('#sheet .rows button')].map(n => n.textContent.trim()),
      sheetWhy: t('#sheet .term-why'),
      sheetText: t('#sheet'),
      toast: t('#app .toast') || t('#side .toast'),
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };
  const slid = () => until(() => b.evaluate(() => !document.documentElement.dataset.nav), 3000).then(() => sleep(150));
  const centre = (q) => b.evaluate((sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, q);
  // The element a tap should land on, found by its text, tagged so `centre` can find it.
  const mark = (sel, text) => b.evaluate((s, tx) => {
    document.querySelectorAll('[data-pq]').forEach(n => n.removeAttribute('data-pq'));
    const n = [...document.querySelectorAll(s)].find(x => x.textContent.trim().startsWith(tx));
    if (!n) return false;
    n.setAttribute('data-pq', '1');
    return true;
  }, sel, text);
  let touch = false;
  const tap = async (sel, text) => {
    if (!(await mark(sel, text))) return false;
    const p = await centre('[data-pq]');
    if (!p) return false;
    await slid();
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await sleep(250);
    return true;
  };
  async function fresh({ w, h, touch: tch, paired = '' }) {
    touch = tch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: tch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: tch, ...(tch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate((pm) => { try { localStorage.clear(); sessionStorage.clear(); if (pm) localStorage.setItem('gf.fixture.paired', pm); } catch {} return null; }, paired);
    await goto(base + '/index.html');
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await until(() => b.evaluate(() => !!document.querySelector('.card .c-name')));
    await sleep(500);
  }
  async function step(name, fn) {
    try { await fn(); } catch (e) { is(`${name}: ran to the end`, 'yes', String((e && e.message) || e).slice(0, 160)); }
  }
  const sizes = [['phone', { w: 390, h: 844, touch: true }], ['desk', { w: 1600, h: 900, touch: false }]];
  let s;

  for (const [at, size] of sizes) {
    await step(`${at}: one machine`, async () => {
      await fresh({ ...size });
      s = await look();
      is(`${at}: one machine — the tabs are the profiles, as before`, ['all', 'work', 'personal'], s.tabs.map(x => x.replace(/ ●\d+$/, '')));
      is(`${at}: ...and no card names a machine`, false, s.projects.some(x => /laptop|vm/.test(x)));
      is(`${at}: ...and there is no offline card`, [], s.hosts);
    });

    await step(`${at}: paired, both up`, async () => {
      await fresh({ ...size, paired: 'online' });
      s = await look();
      is(`${at}: paired — every tab carries its machine`, ['all', 'laptop · work', 'laptop · personal', 'vm · work'], s.tabs.map(x => x.replace(/ ●\d+$/, '')));
      is(`${at}: ...and a short machine name is not drawn as a key letter`, [], s.tabKeys);
      is(`${at}: ...every project row says which machine it is on`, true,
         s.projects.length === 7 && s.projects.every(x => / \| (laptop|vm) · /.test(x)));
      is(`${at}: ...the vm's projects by their names, the machine on the line beneath`,
         ['acme-api | vm · work', 'billing-svc | vm · work · codex'], s.projects.filter(x => / \| vm · /.test(x)));
      is(`${at}: ...this machine's cards keep their numbers`, '1,2,3,4,5,6,7', s.nums);
      is(`${at}: ...the queue is merged — the vm's master's item is counted here`, 'queue · 1', s.queue.replace(/\s*›$/, ''));
      is(`${at}: ...and the accounts line says whose each profile is`, true, /laptop · work/.test(s.usage) && /laptop · personal/.test(s.usage));
      await tap('.seg.tabs button', 'vm\u00a0·\u00a0work');
      s = await settle(x => x.projects.length === 2);
      is(`${at}: the vm tab shows the vm's projects and nothing else`, ['acme-api | vm · work', 'billing-svc | vm · work · codex'], s.projects);
    });

    await step(`${at}: the queue names the machine`, async () => {
      await fresh({ ...size, paired: 'online' });
      await tap('.queue-row', 'queue');
      s = await settle(x => x.held.length > 0);
      is(`${at}: the queue row says the machine`, ['billing-svc | vm · master · #4'], s.held);
    });

    await step(`${at}: a remote project has no terminal`, async () => {
      await fresh({ ...size, paired: 'online' });
      // BY INDEX, not by name: this machine has a billing-svc too, which is the point of the
      // address — the vm's is the seventh card (index 6), after this machine's five and acme-api@vm.
      await tap('.card.k-project[data-idx="6"] .c-name', 'billing-svc');
      // A grid is the one column on a phone and the LEFT pane at a desk.
      const hdr = at === 'desk' ? '#side' : '#app', head = (x) => (at === 'desk' ? x.side : x.main);
      s = await settle(x => /billing-svc/.test(head(x)));
      const onVm = /^\[vm · [a-z]*:billing-svc\]/.test(head(s));
      is(`${at}: the remote grid's header names the machine and the project`, true, onVm);
      await tap(`${hdr} > .hdr button.more`, '');
      s = await settle(x => x.sheet);
      // ...on the vm's grid: a ⋯ with no terminal row anywhere else proves nothing
      is(`${at}: ...its ⋯ has no terminal row`, [true, true, false], [onVm, s.sheetRows.length > 0, s.sheetRows.includes('terminal')]);
      // ...nor the editor, which is the terminal's other tab and goes the same way (#99)
      is(`${at}: ...nor an editor row`, false, s.sheetRows.includes('editor'));
      is(`${at}: ...and says why in one line`, true, /no terminal or editor for another machine/.test(s.sheetWhy) && !/\n/.test(s.sheetWhy));
      // ...while this machine's project still has one, so the absence is about the machine
      await fresh({ ...size, paired: 'online' });
      await tap('.card.k-project[data-idx="0"] .c-name', 'acme-api');
      s = await settle(x => /acme-api/.test(head(x)));
      await tap(`${hdr} > .hdr button.more`, '');
      s = await settle(x => x.sheet);
      is(`${at}: this machine's project keeps its terminal`, [true, ''], [s.sheetRows.includes('terminal'), s.sheetWhy]);
      is(`${at}: ...and its editor, beside it`, [true, s.sheetRows.indexOf('terminal') + 1], [s.sheetRows.includes('editor'), s.sheetRows.indexOf('editor')]);
    });

    await step(`${at}: a machine that is down`, async () => {
      await fresh({ ...size, paired: 'offline' });
      s = await look();
      is(`${at}: offline — the vm is a card that says so, not a gap`, ['vm | offline · last seen 3h0m ago'], s.hosts);
      is(`${at}: ...its projects are not drawn as if it answered`, false, s.projects.some(x => / \| vm · /.test(x)));
      is(`${at}: ...and this machine's tabs still say whose they are`, ['all', 'laptop · work', 'laptop · personal'], s.tabs.map(x => x.replace(/ ●\d+$/, '')));
      await tap('.card.k-host .c-name', 'vm');
      s = await settle(x => x.toast);
      is(`${at}: ...a tap on it says it is offline and since when`, true, /vm is offline · last seen 3h0m ago/.test(s.toast));
    });

    await step(`${at}: settings lists the machines, and unpairs`, async () => {
      await fresh({ ...size, paired: 'online' });
      const hadVm = (await look()).tabs.some(t => /^vm/.test(t));
      await tap('#side > .hdr button.more, #app > .hdr button.more', '');
      await settle(x => x.sheet);
      await tap('#sheet .rows button', 'settings');
      s = await settle(x => /machines/.test(x.sheetText));
      is(`${at}: settings has a machines section with both`, true, /laptop · this machine/.test(s.sheetText) && /vm · online/.test(s.sheetText));
      await tap('#sheet .hosts button', 'unpair');
      s = await look();
      is(`${at}: ...unpair asks for a second tap`, true, s.sheetRows.some(x => /unpair vm\? tap again/.test(x)) || /unpair vm\? tap again/.test(s.sheetText));
      await tap('#sheet .hosts button', 'unpair vm?');
      s = await settle(x => !x.tabs.some(t => /^vm/.test(t)));
      is(`${at}: ...and the second one takes the vm off every screen`, [true, false, false], [hadVm, s.tabs.some(t => /^vm/.test(t)), s.projects.some(x => / \| vm · /.test(x))]);
    });
  }
} finally {
  try { if (b) await b.close(); } catch {}
  try { if (srv) srv.close(); } catch {}
}
done(0);
