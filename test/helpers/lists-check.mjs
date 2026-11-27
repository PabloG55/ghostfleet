#!/usr/bin/env node
// test/helpers/lists-check.mjs — every list of one project's sessions puts the lead first, and the
// session page's sidebar scrolls instead of squeezing its cards. web/ui's screens in fixture mode,
// in a real browser.
//
//     node test/helpers/lists-check.mjs [web-dir]       one "name <US> want <US> got" row per check
//     LISTS_SHOTS=<dir> node test/helpers/lists-check.mjs   ...and a screenshot of each surface there
//
// `web-dir` defaults to this checkout's web/; a copy of staging's is how each row was watched red.
//
// THE FLEET IT DRAWS IS THE DEMO'S acme-api, MADE HARDER IN TWO WAYS, in a copy of web/ that this
// file writes (the checkout's fixtures are never touched):
//   - THE WIRE PUTS THE LEAD THIRD. fleet-grid.mjs sends master first, so a list that only took
//     the wire's order looked right without deciding anything. Third, with working sessions ahead
//     of it and the lead itself only ready, a list that leads with it is a list that chose to.
//   - TWENTY-SIX SESSIONS, the count the sidebar was reported squeezed at: every card a sliver
//     with its state and its age, and no name.
// The surfaces are the project page at a desk's width and a phone's (a phone's list of a project
// is the same page), the session page's sidebar, and the stack picker's group for the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const SHOTS = process.env.LISTS_SHOTS || '';
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const T = fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR || os.tmpdir(), 'lists-check.'));
const COPY = path.join(T, 'web');
fs.cpSync(WEB, COPY, { recursive: true });
const FX = path.join(COPY, 'fixtures', 'grid-acme-api.json');
const g = JSON.parse(fs.readFileSync(FX, 'utf8'));
const lead = g.cards.find(c => c.lead), rest = g.cards.filter(c => !c.lead);
const extra = [];
for (let i = 0; rest.length + 1 + extra.length < 26; i++) {
  const c = rest[i % rest.length];
  extra.push({ ...c, name: `${c.name}-${Math.floor(i / rest.length) + 2}`, pr: null, parent: null });
}
const others = [...rest, ...extra];
const wire = [others[0], others[1], lead, ...others.slice(2)];
const counts = {};
for (const c of wire) counts[c.status] = (counts[c.status] || 0) + 1;
fs.writeFileSync(FX, JSON.stringify({ ...g, counts: { ...g.counts, ...counts, total: wire.length }, cards: wire }, null, 2));

// Today's grouping (web/ui/project.jsx GROUPS), for every card but the lead: the order and the
// groups the other sessions must keep. Written out rather than imported, so a change to the page's
// groups is a change this file has to be told about.
const GROUPS = [['need', s => s === 'need-you'], ['work', s => s === 'working' || s === 'starting'],
                ['ready', s => s === 'ready' || s === 'interrupted' || s === 'limit'], ['rest', () => true]];
const want = [];
{
  const taken = new Set();
  for (const [id, has] of GROUPS) {
    const list = others.filter(c => !taken.has(c.name) && has(c.status)).map(c => c.name);
    list.forEach(n => taken.add(n));
    if (list.length) want.push(`${id}: ${list.join(' ')}`);
  }
}

let b = null, srv = null;
const errors = [];
const until = async (fn, ...a) => {
  for (let i = 0; i < 150; i++) { const v = await b.evaluate(fn, ...a).catch(() => null); if (v) return v; await sleep(100); }
  return null;
};
const size = (w, h) => b.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
const shot = async (name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
const go = async (hash, sel) => {
  await b.evaluate((h) => { location.hash = h; }, hash);
  return until((s) => !!document.querySelector(s), sel);
};

try {
  srv = await serveDir(COPY);
  b = await launch({ width: 1280, height: 900, scale: 2, mobile: false });
  b.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').split('\n')[0]);
  });
  await b.call('Page.navigate', { url: srv.base + '/' });
  await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey/i.test(x.textContent)));
  await b.evaluate(() => [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey/i.test(x.textContent))?.click());
  is('past the lock is the app', true, !!(await until(() => !!document.querySelector('.app'))));

  // ── the project page, at a desk and on a phone ─────────────────────────────────────────
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await size(w, h);
    await go('#/settings', '.main');
    await sleep(200);
    const drawn = await go('#/p/acme-api', '.main .group .cards .card');
    await until((n) => document.querySelectorAll('.main .group .cards .card').length >= n, wire.length);
    await sleep(300);
    const page = await b.evaluate(() => {
      const nameOf = (card) => (card.querySelector('h3')?.childNodes[0]?.textContent || '').trim();
      const cards = [...document.querySelectorAll('.main .group .cards .card')];
      const firstHead = document.querySelector('.main .group h2');
      const m = cards.find(c => nameOf(c) === 'master');
      return {
        first: cards[0] ? nameOf(cards[0]) : '(no card)',
        masters: cards.filter(c => nameOf(c) === 'master').length,
        aboveHeads: !!(m && firstHead && (firstHead.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING)),
        pill: m?.querySelector('.card-top .pill')?.textContent.trim() || '',
        groups: [...document.querySelectorAll('.main section.group')].filter(s => s.querySelector('h2') && s.querySelector('.cards'))
          .map(s => `${(s.className.match(/\bg-(\w+)/) || [])[1] || '?'}: ${[...s.querySelectorAll('.cards .card')].map(nameOf).filter(n => n !== 'master').join(' ')}`),
        sideways: document.documentElement.scrollWidth - innerWidth,
      };
    });
    is(`${w} the project page draws its cards`, true, !!drawn);
    is(`${w} the project page's first card is the lead, though sessions of its own are working`, 'master', page.first);
    is(`${w} ...above every group heading`, true, page.aboveHeads);
    is(`${w} ...once: no group lists it again`, 1, page.masters);
    is(`${w} ...wearing its own state`, 'Ready', page.pill);
    is(`${w} ...and every other session keeps its group and its place`, want.join(' | '), page.groups.join(' | '));
    is(`${w} ...and the page does not scroll sideways`, 0, Math.max(0, page.sideways));
    await shot(`project-${w}`);
  }

  // ── the session page's sidebar, at a desk ──────────────────────────────────────────────
  await size(1280, 800);
  await go('#/settings', '.main');
  await sleep(200);
  await go('#/p/acme-api/s/docs-pass', '.split-list .card');
  await until((n) => document.querySelectorAll('.split-list .card').length >= n && !!document.querySelector('.composer'), wire.length);
  await sleep(400);
  const side = () => b.evaluate(() => {
    const nameOf = (card) => (card.querySelector('h3')?.childNodes[0]?.textContent || '').trim();
    const list = document.querySelector('.split-list');
    const cards = [...document.querySelectorAll('.split-list .card')];
    const squeezed = [], named = [];
    for (const c of cards) {
      // A card that clips its own content was given less height than it has: what the sidebar did
      // to every card when it shrank them to fit instead of scrolling.
      if (c.scrollHeight > c.clientHeight + 1) squeezed.push(`${nameOf(c)}: ${c.clientHeight} of ${c.scrollHeight} px`);
      const r = c.getBoundingClientRect(), n = c.querySelector('h3')?.getBoundingClientRect();
      if (n && n.height > 0 && n.top >= r.top - 1 && n.bottom <= r.bottom + 1) named.push(nameOf(c));
    }
    const comp = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      names: cards.map(nameOf), squeezed, named: named.length,
      overflow: list ? list.scrollHeight - list.clientHeight : 0, top: list ? Math.round(list.scrollTop) : 0,
      composer: comp ? [Math.round(comp.top), Math.round(comp.bottom)] : null, inner: innerHeight,
      sideways: document.documentElement.scrollWidth - innerWidth,
      pageScrolled: (document.scrollingElement?.scrollTop || 0) + (document.querySelector('.main')?.scrollTop || 0),
    };
  });
  const s0 = await side();
  is('the sidebar lists every session', wire.length, s0.names.length);
  is("the sidebar's first card is the lead, though the wire sent it third", 'master', s0.names[0]);
  is('...and the others keep the order the wire sent them in', others.map(c => c.name).join(' '), s0.names.slice(1).join(' '));
  is(`every card in the sidebar keeps its full height (${wire.length} sessions)`, '', s0.squeezed.slice(0, 3).join(', ') + (s0.squeezed.length > 3 ? ` and ${s0.squeezed.length - 3} more` : ''));
  is('...so every card shows its name', wire.length, s0.named);
  is('...and the list is taller than the sidebar, so it scrolls', true, s0.overflow > 40 ? true : `${s0.overflow} px past its box`);
  is('the composer is on the screen beside a long list', true, !!s0.composer && s0.composer[1] <= s0.inner ? true : `${s0.composer} of ${s0.inner}`);
  is('...and the page does not scroll sideways', 0, Math.max(0, s0.sideways));
  // Scrolled partway, as a person would to reach a card further down.
  await b.evaluate(() => { const l = document.querySelector('.split-list'); l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) / 2); });
  await sleep(250);
  const s1 = await side();
  is('the sidebar scrolls inside itself', true, s1.top > 0 ? true : `scrollTop ${s1.top}`);
  is('...and the composer does not move when it does', JSON.stringify(s0.composer), JSON.stringify(s1.composer));
  is('...nor does the page', 0, s1.pageScrolled);
  await shot('sidebar-1280x800-scrolled');

  // ── the stack picker's group for the project ───────────────────────────────────────────
  await go('#/stack-picker', '.stack-group .stack-name');
  await until(() => [...document.querySelectorAll('.stack-group')].some(d => /acme-api/.test(d.querySelector('summary h2')?.textContent || '')));
  const stack = await b.evaluate(() => {
    const grp = [...document.querySelectorAll('.stack-group')].find(d => /^acme-api$/.test(d.querySelector('summary h2')?.textContent.trim() || ''));
    return grp ? [...grp.querySelectorAll('.stack-name')].map(x => x.textContent.trim()) : [];
  });
  is("the stack picker's acme-api group lists the lead first", 'master', stack[0] || '(no group)');
  is('...and the others in the wire\'s order', others.filter(c => !c.lost).map(c => c.name).join(' '), stack.slice(1).join(' '));

  is('no page error, anywhere on the way', '', errors.join(' | '));
} catch (e) {
  if (/no chrome/.test(String(e?.message))) is('lists-check ran to the end', 'yes', `no chrome: ${e.message}`);
  else is('lists-check ran to the end', 'yes', String(e?.stack || e).split('\n').slice(0, 2).join(' '));
} finally {
  try { await b?.close(); } catch {}
  try { srv?.close(); } catch {}
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(rows.join('\n'));
process.exit(0);
