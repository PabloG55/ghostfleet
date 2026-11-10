// Back goes where the person came from. A session's back used to go to a fixed parent, its
// project page, whatever screen had opened it: a session opened from the live map came back to
// a project page the person had never been on, while the browser's back went to the map. Now the
// app's back, the browser's back and the back keys walk one history (web/ui/history.js), the
// screen gone back to is as it was left (its scroll and its state), and the back link says where
// it goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { findChrome, sleep } from '../../../lib/browser.mjs';
import { TEMPLATES } from '../shared/automations.js';

const BACK = '.sess-head .back-link';

// The demo starts with one Activity row and no automations, too few for either page to scroll,
// and a scroll check that cannot fail proves nothing. Rows and automations are made the way a
// person makes them: a label set fourteen times, a template saved eight times.
async function fill(r, cookie) {
  for (let i = 0; i < 14; i++) await r.call('POST', '/api/act', { tool: 'gfw_label', args: { project: 'acme-web', session: 'onboarding', text: `step ${i + 1}` } }, cookie);
  const tpl = Object.values(TEMPLATES).find(x => x.scope === 'personal');
  for (let i = 0; i < 8; i++) { const a = tpl.build(); a.name = `digest ${i + 1}`; await r.call('POST', '/api/automations', { automation: a }, cookie); }
}

// What a screen was: where it is, how far down, and the state the person gave it.
const LOOK = (BACK) => {
  const q = (s) => document.querySelector(s);
  return {
    hash: location.hash,
    main: Math.round(q('.main').scrollTop),
    chat: q('.chat') ? Math.round(q('.chat').scrollTop) : null,
    idle: q('.toggle-inline input')?.checked ?? null,
    quiet: q('.quiet-toggle')?.getAttribute('aria-expanded') ?? null,
    chip: q('.main .chips button.on')?.textContent ?? null,
    search: q('.side .search').value,
    listed: document.querySelectorAll('.side-list .nav').length,
    back: q(BACK)?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  };
};

async function driver(t, opts) {
  const d = await browse(t, opts);
  const { b, click, until } = d;
  const look = () => b.evaluate(LOOK, BACK);
  const nav = () => b.call('Page.getNavigationHistory', {});
  const scroll = async (sel, y) => { await b.evaluate((s, v) => { document.querySelector(s).scrollTop = v; }, sel, y); await sleep(300); };
  // the first one of `sel` the person can see, so a press lands on it where it is
  const pick = async (sel) => {
    const ok = await b.evaluate((s) => {
      const m = document.querySelector('.main').getBoundingClientRect();
      const el = [...document.querySelectorAll(s)].find(e => { const r = e.getBoundingClientRect(); return r.height && r.top >= m.top && r.bottom <= m.bottom; });
      document.querySelectorAll('#t-pick').forEach(x => x.removeAttribute('id'));
      if (el) el.id = 't-pick';
      return !!el;
    }, sel);
    assert.ok(ok, `something to press in ${sel}`);
    await click('#t-pick');
  };
  const at = (hash) => until(hash, (h) => location.hash === h, hash);
  const step = async (by) => {             // the browser's own back or forward, not the page's
    const h = await nav();
    const e = h.entries[h.currentIndex + by];
    await b.call('Page.navigateToHistoryEntry', { entryId: e.id });
  };
  // a softer `at`, for a check that records a miss rather than stopping the run on it
  const soon = async (h, ms = 4000) => { for (let i = 0; i < ms / 100; i++) { if (await b.evaluate(() => location.hash) === h) return true; await sleep(100); } return false; };
  return { ...d, look, nav, scroll, pick, at, soon, step, settle: () => sleep(700) };
}

test('back from a session goes to the screen it was opened from, as it was, by the app, the browser and the key', { timeout: 300000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const d = await driver(t, { width: 1280, height: 520 });
  const { b, r, cookie, click, press, until, go, look, nav, scroll, pick, at, soon, step, settle } = d;
  await fill(r, cookie);
  const session = (from) => until('a session', (f) => location.hash !== f && /#\/p\/[^/]+\/s\//.test(location.hash) && !!document.querySelector('.sess-head'), from);
  const chord = async () => { await press('Ctrl+f'); await press('1'); await press('1'); };
  const chipWithMost = async () => {
    await b.evaluate(() => {
      const cs = [...document.querySelectorAll('.main .chips button')].slice(1);
      const n = (c) => Number(c.querySelector('b')?.textContent || 0) || (c.textContent.includes('admin') ? 99 : 0);
      cs.sort((x, y) => n(y) - n(x))[0].id = 't-chip';
    });
    await click('#t-chip');
  };

  const ORIGINS = [
    { name: 'the live map', start: '/map', ready: '.ocean .boat', label: 'Live map',
      arrange: async () => { await click('.toggle-inline input'); await scroll('.main', 60); }, open: () => pick('.ocean .boat') },
    { name: 'home', start: '/', ready: '.fboat', label: 'Home',
      arrange: async () => { await click('.quiet-toggle'); await scroll('.main', 60); }, open: () => pick('.fboat') },
    { name: "a project's sessions", start: '/p/acme-web', ready: '.cards .card', label: 'acme-web',
      arrange: async () => { await chipWithMost(); await scroll('.main', 120); }, open: () => pick('.cards .card') },
    { name: 'activity', start: '/activity', ready: '.log-row', label: 'Activity',
      arrange: async () => { await chipWithMost(); await scroll('.main', 120); }, open: chord },
    { name: 'automations', start: '/automations', ready: '.auto-name', label: 'Automations',
      arrange: () => scroll('.main', 120), open: chord },
    { name: 'the sidebar search', start: '/map', ready: '.side .search', label: 'billing-svc',
      arrange: async () => {
        await click('.side .search');
        for (const ch of 'bill') await press(ch);
        await press('Enter');
        await at('#/p/billing-svc');
        await until('its cards', () => !!document.querySelector('.cards .card'));
      }, open: () => pick('.cards .card') },
    { name: 'another session', start: '/p/acme-web/s/stripe-billing', ready: '.chat .bubble', label: 'stripe-billing',
      arrange: () => scroll('.chat', 40), open: () => pick('.split-list .card:not(.active)') },
  ];

  const problems = [];
  const same = (where, was, now) => {
    const keys = ['hash', 'idle', 'quiet', 'chip', 'search', 'listed'];
    for (const k of keys) if (was[k] !== now[k]) problems.push(`${where}: ${k} was ${JSON.stringify(was[k])}, came back ${JSON.stringify(now[k])}`);
    for (const k of ['main', 'chat']) if (was[k] != null && Math.abs((now[k] ?? -99) - was[k]) > 2) problems.push(`${where}: ${k} scroll was ${was[k]}, came back ${now[k]}`);
  };

  for (const o of ORIGINS) {
    await go(o.start, o.ready);
    await b.call('Page.reload', {});           // every origin starts on a fresh page, not on the last one's state
    await until(o.ready, (s) => !!document.querySelector(s), o.ready);
    await settle();
    await o.arrange();
    const was = await look();
    if (['the live map', 'home', "a project's sessions", 'activity', 'automations'].includes(o.name)) assert.ok(was.main > 0, `${o.name} is scrolled before the session is opened`);
    if (o.name === 'another session') assert.ok(was.chat > 0, 'the chat is scrolled before the next session is opened');
    await o.open();
    await session(was.hash);
    await settle();
    const there = await nav();
    const sess = (await look()).hash;
    const label = (await look()).back;
    if (label !== `← ${o.label}`) problems.push(`${o.name}: the back link reads ${JSON.stringify(label)}, not "← ${o.label}"`);

    // 1. the app's back
    if (await b.evaluate((s) => !!document.querySelector(s), BACK)) {
      await click(BACK);
      await soon(was.hash);
      await settle();
      same(`${o.name}, the app's back`, was, await look());
      const h = await nav();
      if (h.entries.length !== there.entries.length) problems.push(`${o.name}, the app's back: ${h.entries.length - there.entries.length} entries added`);
      if (h.currentIndex !== there.currentIndex - 1) problems.push(`${o.name}, the app's back: ${there.currentIndex - h.currentIndex} steps back, not 1`);
      await step(1); await at(sess); await settle();
    } else problems.push(`${o.name}, the app's back: no back link on the session`);

    // 2. the browser's back
    await step(-1);
    await soon(was.hash);
    await settle();
    same(`${o.name}, the browser's back`, was, await look());

    // 3. the session's back key, `
    await step(1); await at(sess); await settle();
    await press('`');
    await soon(was.hash);
    await settle();
    same(`${o.name}, the \` key`, was, await look());
    const h = await nav();
    if (h.currentIndex !== there.currentIndex - 1) problems.push(`${o.name}, the \` key: ${there.currentIndex - h.currentIndex} steps back, not 1`);
  }
  assert.deepEqual(problems, []);
});

// Under a slow server a screen is short while it loads, and a scroll event then (the page before
// it clamping to the shorter page) was recorded as "at its end", since a page that cannot scroll
// is at its end. The page settled at its top, setting a scroll to the value it already has fires
// no event, and that record stood: left at its top, the page came back at its bottom. Seen as a
// project page 816 tall in a 520 window coming back at 296, in a full run and never alone. The
// API is held here, so the short screen is there on every run.
test('a screen entered while it was still loading comes back where it was left, not at its end', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const d = await driver(t, { width: 1280, height: 520 });
  const { b, click, press, until, go, look, scroll, pick, at, settle } = d;
  const slow = async (ms) => {
    await b.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    const off = b.onEvent((m, p) => { if (m === 'Fetch.requestPaused') setTimeout(() => b.call('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}), ms); });
    return async () => { off(); await sleep(ms + 300); await b.call('Fetch.disable', {}); };
  };
  await go('/map', '.ocean .boat');
  await settle();
  await scroll('.main', 60);
  const fast = await slow(1500);
  await click('.side .search');
  for (const ch of 'bill') await press(ch);
  await press('Enter');
  await at('#/p/billing-svc');
  await until('its cards', () => !!document.querySelector('.cards .card'));
  await fast();
  await settle();
  const was = await look();
  assert.ok(await b.evaluate(() => { const m = document.querySelector('.main'); return m.scrollHeight - m.clientHeight > 100; }), 'the page can scroll, so its end is not its top');
  await pick('.cards .card');
  await until('the session', () => !!document.querySelector('.sess-head .back-link'));
  await settle();
  await click(BACK);
  await at('#/p/billing-svc');
  await settle();
  assert.equal((await look()).main, was.main, 'the page is where it was left');
});

// Opened by a link there is no screen to go back to: back goes to the session's project, in place
// of the session's entry, so the browser's back from there does not land on the session again.
test('a session opened by a link goes back to its project, and a reload keeps where it came from', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const d = await driver(t, { width: 1280, height: 520 });
  const { b, base, click, press, until, go, look, nav, at, settle, pick } = d;
  const SESSION = '/p/acme-web/s/onboarding';
  for (const how of ['the app\'s back', 'the ` key']) {
    await b.call('Page.navigate', { url: 'about:blank' });
    await b.call('Page.navigate', { url: `${base}/#${SESSION}` });
    await until('the session', () => !!document.querySelector('.sess-head .back-link'));
    await settle();
    assert.equal((await look()).back, '← acme-web', `${how}: the link names the project`);
    const before = await nav();
    if (how === 'the ` key') await press('`'); else await click(BACK);
    await at('#/p/acme-web');
    const after = await nav();
    assert.equal(after.entries.length, before.entries.length, `${how}: the project took the session's entry, no entry added`);
    assert.equal(after.currentIndex, before.currentIndex, `${how}: in place`);
    assert.match(after.entries[after.currentIndex].url, /#\/p\/acme-web$/);
  }

  // A reload keeps the browser's history, so back still goes where the browser's would.
  await go('/map', '.ocean .boat');
  await pick('.ocean .boat');
  await until('the session', () => !!document.querySelector('.sess-head .back-link'));
  await b.call('Page.reload', {});
  await until('the session', () => !!document.querySelector('.sess-head .back-link'));
  await settle();
  assert.equal((await look()).back, '← Live map', 'reloaded, the link still names the map');
  await click(BACK);
  await at('#/map');
});

// q is back on an automation, as the phone client's q is: to the list it came from, as it was.
test('q, the link and the browser all go back from an automation to the list, as it was', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const d = await driver(t, { width: 1280, height: 520 });
  const { b, r, cookie, click, press, until, go, look, nav, scroll, pick, at, step, settle } = d;
  await fill(r, cookie);
  const LINK = '.autos-edit .back-link';
  const editor = () => until('an automation', () => !!document.querySelector('.autos-edit .back-link, .autos-edit'));
  await go('/automations', '.auto-name');
  await settle();
  await scroll('.main', 120);
  const was = await look();
  assert.ok(was.main > 0, 'the list is scrolled');
  const ways = {
    "the app's back": () => click(LINK),
    "the browser's back": () => step(-1),
    q: async () => { await b.evaluate(() => document.activeElement?.blur()); await press('q'); },
  };
  let first = true;
  for (const [how, back] of Object.entries(ways)) {
    if (first) { await pick('.auto-name'); first = false; } else await step(1);
    await editor();
    await settle();
    assert.equal(await b.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null, LINK), '← Automations', `${how}: the link names the list`);
    const there = await nav();
    await back();
    await at('#/automations');
    await settle();
    assert.equal((await look()).main, was.main, `${how}: the list is where it was`);
    assert.equal((await nav()).currentIndex, there.currentIndex - 1, `${how}: one step back`);
  }
  // opened by a link, q goes to the list in the automation's place
  await b.call('Page.navigate', { url: 'about:blank' });
  await b.call('Page.navigate', { url: `${d.base}/#/automations/new` });
  await editor();
  await settle();
  await b.evaluate(() => document.activeElement?.blur());
  await press('q');
  await at('#/automations');
});

// A phone has no list beside the session: the link is the way back, and it says where in Spanish too.
test('on a phone, in Spanish, the back link names the map and goes back to it as it was', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const d = await driver(t, { width: 390, height: 700, lang: 'es' });
  const { b, click, until, go, look, scroll, pick, at, settle } = d;
  await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await go('/map', '.ocean .boat');
  await b.call('Page.reload', {});
  await until('the boats', () => innerWidth === 390 && !!document.querySelector('.ocean .boat'));
  await settle();
  await click('.toggle-inline input');
  await scroll('.main', 200);
  const was = await look();
  assert.ok(was.main > 0 && was.idle, 'the map is scrolled and the box is ticked');
  await pick('.ocean .boat');
  await until('the session', () => !!document.querySelector('.sess-head .back-link'));
  await settle();
  // a thumb's target, and its own: a press near its bottom edge, over the title, is still the link
  const link = await b.evaluate((s) => {
    const el = document.querySelector(s); const r = el.getBoundingClientRect();
    const own = (x, y) => document.elementFromPoint(x, y)?.closest('.back-link') === el;
    return { text: el.textContent.replace(/\s+/g, ' ').trim(), seen: r.width > 0 && r.right <= innerWidth && r.top >= 0, name: el.getAttribute('aria-label'),
      big: r.height >= 40 && r.width >= 44, own: own(r.left + 4, r.top + 3) && own(r.right - 4, r.bottom - 3) };
  }, BACK);
  assert.deepEqual(link, { text: '← Mapa en vivo', seen: true, name: 'Volver a Mapa en vivo', big: true, own: true });
  await click(BACK);
  await at('#/map');
  await settle();
  const now = await look();
  assert.equal(now.idle, true, 'the box is still ticked');
  assert.ok(Math.abs(now.main - was.main) <= 2, `the map is where it was (${was.main}, came back ${now.main})`);
});
