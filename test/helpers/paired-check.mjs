#!/usr/bin/env node
// paired-check — one web client, two machines: what the phone and the desk DRAW once a second
// fleet-serve is paired with the one that served the page.
//
//     node test/helpers/paired-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// `web-dir` defaults to this checkout's web/. The rows about a machine on its own must pass on a
// client that knows nothing of pairing — pairing nothing changes nothing — and the rows about the
// second machine must not.
//
// FIXTURE MODE, from this checkout's web/fixtures/paired.json, chosen with the
// `gf.fixture.paired` key ('online' | 'offline'). The server half — that the daemon really
// merges, proxies, refuses and audits — is pair-check.mjs's, against two live fleet-serves;
// this one is only about the screens, at a phone's size with touch and a desk's with a mouse.
//
// SINCE v104 THESE ARE web/ui's SCREENS, the ones the team app draws. The old client's answer to
// "which machine" was a tab per machine and a host on every card; web/ui's is a heading per
// machine in the project list (the drawer on a phone, the sidebar at a desk), the machine beside
// a remote project's name wherever the name is drawn, and the machine on every queue item. What
// each row asked of the old client, it asks of that.
//
// ANOTHER MACHINE'S ADDRESS IS `<name>@<key>` (fleet-serve mergeProjects), and the key is a slug
// of the machine's own label (lib/peers.mjs keyFor). The address is the app's, not the reader's:
// a remote project is drawn as its name and its machine, never as `acme-api@vm`, and this machine
// has projects of the same names, which is what the address is for.
import { launch, sleep, serveDir } from '../../lib/browser.mjs';
import fs from 'node:fs';
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
  // The list is there at every width — the drawer on a phone holds it while shut — so it is
  // read without opening anything; what a tap does is asked by tapping.
  const look = () => b.evaluate(() => {
    const t = (q) => ((document.querySelector(q) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const side = [...document.querySelectorAll('.side .side-list > *')];
    const groups = []; let g = null;
    for (const n of side) {
      if (n.classList.contains('side-host')) { g = { host: `${(n.querySelector('.grow') || {}).textContent || ''}:${(n.querySelector('small') || {}).textContent || ''}`, items: [] }; groups.push(g); }
      else if (n.matches('a.nav')) { if (!g) { g = { host: '', items: [] }; groups.push(g); } g.items.push(((n.querySelector('.grow') || {}).textContent || '').trim()); }
    }
    return {
      hosts: groups.filter(x => x.host).map(x => x.host),
      groups,
      names: groups.flatMap(x => x.items),
      board: [...document.querySelectorAll('.main .fleet-name')].map(n => n.textContent.replace(/\s+/g, ' ').trim()),
      h1: t('.main h1'),
      usage: t('.main .usage'),
      queue: [...document.querySelectorAll('.main .extra-card')].map(c => `${(c.querySelector('h3') || {}).textContent || ''} | ${((c.querySelector('p.muted') || {}).textContent || '').trim()}`),
      tools: [...document.querySelectorAll('.main .tool-tab')].map(n => n.textContent.trim()),
      termWhy: t('.main .term-why'),
      hostsPanel: [...document.querySelectorAll('.main .panel')].filter(p => /Paired machines/.test((p.querySelector('h2') || {}).textContent || ''))
        .map(p => [...p.querySelectorAll('.row-item')].map(r => r.textContent.replace(/\s+/g, ' ').trim()))[0] || null,
      toast: t('.toasts'),
    };
  });
  const settle = async (pred, ms = 5000) => { await until(async () => pred(await look()), ms); return look(); };
  // A real press on the element found by its text: a tap with touch, a click with a mouse.
  let touch = false;
  const press = async (sel, text) => {
    const p = await b.evaluate((s, tx) => {
      const n = [...document.querySelectorAll(s)].find(x => x.textContent.replace(/\s+/g, ' ').trim().startsWith(tx));
      if (!n) return null;
      n.scrollIntoView({ block: 'center', behavior: 'instant' });
      n.setAttribute('data-pp', '1');
      return true;
    }, sel, text) && await (async () => {
      // Measured once it has stopped moving: settings draws its sections as their reads land, so
      // a section above can push this one down between the measure and the press — which then
      // lands on a heading, and the row reads as a button that does nothing.
      const at = () => b.evaluate(() => {
        const n = document.querySelector('[data-pp]'); if (!n) return null;
        const r = n.getBoundingClientRect();
        return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      let was = await at(), now = was;
      for (let i = 0; i < 20; i++) {
        await sleep(120); now = await at();
        if (now && was && now.x === was.x && now.y === was.y) break;
        await b.evaluate(() => { document.querySelector('[data-pp]')?.scrollIntoView({ block: 'center', behavior: 'instant' }); return null; });
        was = await at();
      }
      await b.evaluate(() => { document.querySelector('[data-pp]')?.removeAttribute('data-pp'); return null; });
      return now;
    })();
    if (!p) return false;
    if (touch) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
      await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);
    return true;
  };
  // A project in the list, by machine: on a phone the drawer is opened first, as a thumb would.
  const openProject = async (host, name) => {
    if (touch) { await press('.topbar .icon-btn', ''); await until(() => b.evaluate(() => !!document.querySelector('.side.open'))); await sleep(250); }
    const ok = await b.evaluate((h, n) => {
      document.querySelectorAll('[data-pq]').forEach(x => x.removeAttribute('data-pq'));
      let under = '';
      for (const x of document.querySelectorAll('.side .side-list > *')) {
        if (x.classList.contains('side-host')) under = ((x.querySelector('.grow') || {}).textContent || '').trim();
        else if (x.matches('a.nav') && under === h && ((x.querySelector('.grow') || {}).textContent || '').trim() === n) { x.setAttribute('data-pq', '1'); return true; }
      }
      return false;
    }, host, name);
    return ok && press('[data-pq]', '');
  };
  async function fresh({ w, h, touch: tch, paired = '', hash = '' }) {
    touch = tch;
    await b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: tch });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: tch, ...(tch ? { maxTouchPoints: 5 } : {}) });
    await goto(base + '/index.html');
    await b.evaluate((pm) => { try { localStorage.clear(); sessionStorage.clear(); if (pm) localStorage.setItem('gf.fixture.paired', pm); } catch {} return null; }, paired);
    await goto(base + '/index.html');
    await until(() => b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => /^continue without a passkey/i.test(x.textContent.trim()));
      if (e) e.click();
      return !!document.querySelector('.app .side .side-list a.nav');
    }));
    // The fixture bypass lands on the first page, as a cold open does; a screen is then an address.
    if (hash) await b.evaluate((h) => { location.hash = h; return null; }, hash);
    await sleep(400);
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
      is(`${at}: one machine — no machine headings in the project list`, [], s.hosts);
      is(`${at}: ...no project is drawn by an address`, false, [...s.names, ...s.board].some(x => /@/.test(x)));
      is(`${at}: ...and none names a machine on the board`, false, s.board.some(x => / · (laptop|vm)$/.test(x)));
    });

    await step(`${at}: paired, both up`, async () => {
      await fresh({ ...size, paired: 'online' });
      s = await settle(x => x.hosts.length > 1);
      is(`${at}: paired — a heading per machine, this one first and saying so`, ['laptop:this machine', 'vm:'], s.hosts);
      is(`${at}: ...the vm's projects under its heading, by their names`, ['acme-api', 'billing-svc'], (s.groups.find(g => /^vm:/.test(g.host)) || {}).items || null);
      // Both machines have a billing-svc: that is the point of the address.
      is(`${at}: ...this machine's projects of the same names are still under this one`, true,
         ['acme-api', 'billing-svc'].every(n => ((s.groups.find(g => /^laptop:/.test(g.host)) || {}).items || []).includes(n)));
      is(`${at}: ...no project is drawn by its address`, false, [...s.names, ...s.board].some(x => /@/.test(x)));
      // (the board draws the busy fleets; a quiet one waits behind its own toggle)
      is(`${at}: ...the board says which machine a remote project is on`, true, s.board.includes('acme-api · vm'));
      is(`${at}: ...and the accounts line says whose each profile is`, true, /laptop · work/.test(s.usage) && /laptop · personal/.test(s.usage));
    });

    await step(`${at}: the queue names the machine`, async () => {
      await fresh({ ...size, paired: 'online', hash: '#/queue' });
      s = await settle(x => x.queue.some(q => /rotate|billing-svc/.test(q)) || x.queue.length > 1);
      const vm = s.queue.filter(q => /\| vm · /.test(q));
      is(`${at}: the queue is merged — the vm's master's item is here, saying the machine`, ['billing-svc · #4 | vm · waits on the person: pick now or after'], vm);
    });

    // A paired project carries its address AND its host, so a heading drawn from both said
    // `acme-api@vm · vm`. The picker's headings are the one place the two meet on one line.
    await step(`${at}: the stack picker names the machine once`, async () => {
      await fresh({ ...size, paired: 'online', hash: '#/stack-picker' });
      await until(() => b.evaluate(() => [...document.querySelectorAll('.main section h2')].some(h => / · vm$/.test(h.textContent.trim()))), 8000);
      const heads = await b.evaluate(() => [...document.querySelectorAll('.main section h2')].map(h => h.textContent.replace(/\s+/g, ' ').trim()));
      is(`${at}: the stack picker heads the vm's project with its name and the machine`, true, heads.includes('acme-api · vm'));
      is(`${at}: ...and no heading is an address`, [], heads.filter(x => /@/.test(x)));
    });

    await step(`${at}: a remote project`, async () => {
      await fresh({ ...size, paired: 'online' });
      await openProject('vm', 'billing-svc');
      s = await settle(x => /billing-svc/.test(x.h1));
      is(`${at}: the remote project's page is titled with its name and its machine`, 'billing-svc · vm', s.h1);
      is(`${at}: ...fixtures offer no shell`, [], s.tools);
      is(`${at}: ...has no obsolete refusal about the other machine`, '', s.termWhy);
      await fresh({ ...size, paired: 'online' });
      await openProject('laptop', 'billing-svc');
      s = await settle(x => /billing-svc/.test(x.h1));
      is(`${at}: this machine's project of the same name is titled with its name alone`, 'billing-svc', s.h1);
      is(`${at}: ...also has no obsolete terminal refusal`, '', s.termWhy);
    });

    // A PHOTO FOR ANOTHER MACHINE'S SESSION GOES TO THE UPLOAD, like a local one. In fixture mode
    // api.attach answers every file with its own sentence, so a tile carrying that sentence is
    // proof the photo took the upload path, and anything else is proof it did not.
    await step(`${at}: a photo for a remote session`, async () => {
      await fresh({ ...size, paired: 'online', hash: '#/p/acme-api%40vm/s/api-fix' });
      await until(() => b.evaluate(() => !!document.querySelector('.main input[type=file]')));
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      await b.evaluate((png) => {
        const pick = document.querySelector('.main input[type=file]');
        if (!pick) return null;
        const bin = atob(png); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([u8], 'shot.png', { type: 'image/png' }));
        pick.files = dt.files; pick.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      }, PNG);
      const tile = () => b.evaluate(() => ((document.querySelector('.main .att') || {}).title || ''));
      await until(async () => /fleet|fixture/.test(await tile()), 5000);
      is(`${at}: a photo for the vm's acme-api goes to the upload, as a local one does`, true, /attachments need a real fleet/.test(await tile()));
    });

    await step(`${at}: a machine that is down`, async () => {
      await fresh({ ...size, paired: 'offline' });
      s = await settle(x => x.hosts.length > 1);
      is(`${at}: offline — the vm keeps its heading and says it is not answering`, ['laptop:this machine', 'vm:not answering'], s.hosts);
      is(`${at}: ...its projects are not drawn as if it answered`, [], (s.groups.find(g => /^vm:/.test(g.host)) || {}).items || null);
      is(`${at}: ...not on the board either`, false, s.board.some(x => / · vm$/.test(x)));
      is(`${at}: ...while this machine's are`, true, ((s.groups.find(g => /^laptop:/.test(g.host)) || {}).items || []).length >= 2);
    });

    await step(`${at}: settings lists the machines, and unpairs`, async () => {
      await fresh({ ...size, paired: 'online', hash: '#/settings' });
      s = await settle(x => x.hostsPanel && x.hostsPanel.length > 1);
      is(`${at}: settings has a machines section with both`, true,
         !!s.hostsPanel && s.hostsPanel.some(r => /laptop this machine/.test(r)) && s.hostsPanel.some(r => /^vm answering/.test(r)));
      await press('.main .panel .row-item button', 'Unpair…');
      s = await look();
      is(`${at}: ...unpair asks first, and the vm is still paired while it asks`, [true, true],
         [!!s.hostsPanel && s.hostsPanel.some(r => /^vm .*Unpair\s*Cancel/.test(r)), s.hosts.includes('vm:')]);
      await press('.main .panel .row-item button', 'Unpair');
      s = await settle(x => x.hostsPanel && !x.hostsPanel.some(r => /^vm/.test(r)), 2000);
      is(`${at}: ...and the second press takes it off the machines section at once`, false, !s.hostsPanel || s.hostsPanel.some(r => /^vm/.test(r)));
      // The project list is the app's 5 s read, so it follows on that read: one period and some.
      s = await settle(x => !x.hosts.some(h => /^vm/.test(h)), 8000);
      is(`${at}: ...off the project list on the next read`, false, s.hosts.some(h => /^vm/.test(h)));
      await b.evaluate(() => { location.hash = '#/'; return null; });
      s = await settle(x => x.board.length > 0, 4000);
      is(`${at}: ...and off the board`, [true, false], [s.board.length > 0, s.board.some(x => / · vm$/.test(x))]);
    });
  }
} finally {
  try { if (b) await b.close(); } catch {}
  try { if (srv) srv.close(); } catch {}
}
done(0);
