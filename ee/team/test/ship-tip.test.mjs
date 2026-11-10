// A ship says who it is. Every ship that stands for a session (the home board's, the live map's)
// said so in a native title only: drawn by the OS a second late, unstyled, never on a touch
// screen and never in a screenshot, and it did not say which agent the ship was. These drive the
// real pointer, keyboard and finger through the DevTools protocol and read the card that answers
// (web/ui/shiptip.jsx): what it says, when it opens and closes, that it never covers its ship or
// takes its click, and that a held finger shows it on a phone without opening the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { sleep } from '../../../lib/browser.mjs';

const MODEL = 'model-from-the-grid';   // put on one card by the test: the card shows it when the data has it
// The four kinds the owner was looking at, and the word each screen says their state with.
const HOME = [
  ['lead', 'acme-web', 'master', 'lead', 'Open'],
  ['worker', 'acme-web', 'onboarding', 'onboarding', 'Working'],
  ['need-you', 'acme-web', 'stripe-billing', 'stripe-billing', 'Needs you'],
  ['off', 'billing-svc', 'master', 'lead', 'Idle'],
];
const MAP = [
  ['lead', 'acme-web', 'master', 'lead', 'Ready'],
  ['worker', 'acme-web', 'onboarding', 'onboarding', 'Working'],
  ['need-you', 'acme-web', 'stripe-billing', 'stripe-billing', 'Needs you'],
  ['off', 'billing-svc', 'master', 'lead', 'Paused'],
];
const homeShip = (p, n) => `a.fboat[href="#/p/${p}/s/${n}"]`;
const mapShip = (p, n) => `.boat[data-boat="${p}/${n}"]`;

// What the page knows: the card (what it says, row by row, and where it is), the ship, and when
// each card first appeared after the pointer reached a ship, timed inside the page so a slow
// DevTools round trip does not count against it.
function look(sel) {
  const tip = document.querySelector('[role=tooltip]');
  const ship = sel ? document.querySelector(sel) : null;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const rows = tip ? [...tip.querySelectorAll('dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling]) : [];
  const words = (dd) => { const c = dd.cloneNode(true); c.querySelectorAll('.avatar').forEach(a => a.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); };
  return {
    open: !!tip,
    id: tip?.id || null,
    who: tip?.querySelector('.tip-who')?.textContent.replace(/\s+/g, ' ').trim() || null,
    state: tip?.querySelector('.tip-state')?.textContent.trim() || null,
    led: !!tip?.querySelector('.tip-state .led, .tip-state [class*=led]'),
    rows: rows.map(([k, dd]) => [k, words(dd), !!dd.querySelector('.avatar')]),
    tipBox: box(tip), shipBox: box(ship),
    vw: document.documentElement.clientWidth, vh: innerHeight,
    label: ship?.getAttribute('aria-label') || null,
    describedby: ship?.getAttribute('aria-describedby') || null,
    titled: document.querySelectorAll('.fboat[title], .fboat [title], .boat[title], .boat [title]').length,
    ships: document.querySelectorAll('.fboat, .boat').length,
    hash: location.hash,
  };
}
function record() {
  if (window.__tips) return;
  const rec = window.__tips = { enter: 0, ship: null, seen: [] };
  addEventListener('pointerover', (e) => {
    const s = e.target.closest?.('.fboat, .boat');
    if (s && s !== rec.ship) { rec.ship = s; rec.enter = performance.now(); }
    if (!s) rec.ship = null;
  }, true);
  let last = null;
  new MutationObserver(() => {
    const who = document.querySelector('[role=tooltip] .tip-who')?.textContent.replace(/\s+/g, ' ').trim() || null;
    if (who !== last) { last = who; rec.seen.push({ who, at: performance.now(), after: performance.now() - rec.enter }); }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

async function setup(t, size) {
  const [width, height] = size === 'desk' ? [1440, 900] : [390, 844];
  const B = await browse(t, { width, height });
  const { b } = B;
  if (size === 'phone') {
    await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await b.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // The demo's grid has no model and every card has a last message. One card gets a model and
  // another loses its label and message, so the card is seen to show a model when there is one
  // and to leave a row out when there is nothing to put in it.
  await b.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/grid*', requestStage: 'Response' }] });
  const off = b.onEvent(async (m, p) => {
    if (m !== 'Fetch.requestPaused') return;
    try {
      const raw = await b.call('Fetch.getResponseBody', { requestId: p.requestId });
      const g = JSON.parse(raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString() : raw.body);
      for (const c of g.cards || []) {
        if (c.name === 'onboarding') c.model = MODEL;
        if (c.name === 'stripe-billing') { c.msg = ''; c.label = null; }
      }
      await b.call('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(g)).toString('base64') });
    } catch { await b.call('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); }
  });
  t.after(() => off());
  const owners = (await B.r.call('GET', '/api/projects', undefined, B.cookie)).body.projects;
  const users = (await B.r.call('GET', '/api/users', undefined, B.cookie)).body.users;
  const ownerOf = (p, n) => users.find(u => u.id === owners.find(x => x.name === p)?.sessions.find(s => s.name === n)?.owner)?.name || null;
  return { ...B, ownerOf };
}

function checker(size) {
  const problems = [];
  const want = (ok, msg) => { if (!ok) problems.push(`${size}: ${msg}`); return ok; };
  return { problems, want };
}
const soon = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const overlaps = (a, c) => a && c && a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
const inside = (a, vw, vh) => a && a.l >= 0 && a.t >= 0 && a.r <= vw && a.b <= vh;

// The card for one ship says who, where, what state with its LED, which agent, who owns it and
// when it moved; it is the ship's description; it covers neither the ship nor anything off screen.
function says(want, where, L, [kind, project, name, who, word], owner) {
  if (!want(L.open, `${where}: hovering the ${kind} ship (${project}/${name}) shows no card`)) return;
  want(L.who === `${who} ${project}`, `${where}: the ${kind} ship's card is headed ${JSON.stringify(L.who)}, not "${who} ${project}"`);
  want(L.state === word && L.led, `${where}: the ${kind} ship's card says its state as ${JSON.stringify(L.state)}${L.led ? '' : ' with no LED'}, not "${word}"`);
  const row = Object.fromEntries(L.rows.map(([k, v, badge]) => [k, { v, badge }]));
  want(/^claude\b/.test(row.Agent?.v || ''), `${where}: the ${kind} ship's card does not say which agent it is (${JSON.stringify(L.rows)})`);
  if (owner) want(row.Owner?.v === owner && row.Owner.badge, `${where}: the ${kind} ship's card gives its owner as ${JSON.stringify(row.Owner)}, not ${owner} beside the badge`);
  want(/ago$|^now$/.test(row.Moved?.v || ''), `${where}: the ${kind} ship's card does not say when it last moved (${JSON.stringify(row.Moved)})`);
  want(L.rows.every(([, v, badge]) => v || badge), `${where}: the ${kind} ship's card has an empty row: ${JSON.stringify(L.rows)}`);
  want(L.describedby && L.describedby === L.id, `${where}: the ${kind} ship is described by ${JSON.stringify(L.describedby)}, not its card ${JSON.stringify(L.id)}`);
  want((L.label || '').startsWith(`${who}, ${project}`) && L.label.includes(word), `${where}: the ${kind} ship is named ${JSON.stringify(L.label)}`);
  want(!overlaps(L.tipBox, L.shipBox), `${where}: the ${kind} ship's card covers the ship (${JSON.stringify(L.tipBox)} over ${JSON.stringify(L.shipBox)})`);
  want(inside(L.tipBox, L.vw, L.vh), `${where}: the ${kind} ship's card runs off the ${L.vw}×${L.vh} screen at ${JSON.stringify(L.tipBox)}`);
}

test('desk 1440×900: hover, keyboard and Esc on every kind of ship, and the click still opens the session', { timeout: 300000 }, async (t) => {
  const { b, press, click, go, ownerOf } = await setup(t, 'desk');
  const { problems, want } = checker('desk');
  const L = (sel) => b.evaluate(look, sel);
  const centre = async (sel) => { const s = (await L(sel)).shipBox; return s && { x: (s.l + s.r) / 2, y: (s.t + s.b) / 2 }; };
  const move = (x, y) => b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const away = () => move(4, 880);                                    // the sidebar's foot: no ship there
  const hover = async (sel) => { const c = await centre(sel); if (c) await move(c.x, c.y); return c; };
  const cardFor = (who, project) => soon(async () => { const l = await L(null); return l.who === `${who} ${project}` && l.rows.length ? l : null; });

  for (const [screen, route, ready, kinds, shipOf] of [['home', '/', '.fboat', HOME, homeShip], ['map', '/map', '.ocean .boat', MAP, mapShip]]) {
    await go(route, ready);
    await b.evaluate(record);
    await away();
    await sleep(500);
    const L0 = await L(null);
    want(L0.ships >= 4 && L0.titled === 0, `${screen}: ${L0.titled} native titles on or inside the ${L0.ships} ships`);

    // each kind, from nowhere: the card waits a moment, then says who
    for (const k of kinds) {
      const [kind, project, name, who] = k;
      await away();
      await sleep(700);                                              // past the moment a closed card swaps without the wait
      want(!(await L(null)).open, `${screen}: the card stays open after the pointer left for 700 ms`);
      if (!want(await hover(shipOf(project, name)), `${screen}: there is no ${kind} ship ${project}/${name}`)) continue;
      await cardFor(who, project);
      await soon(async () => (await L(null)).rows.some(r => r[0] === 'Agent'), 3000);
      says(want, screen, await L(shipOf(project, name)), k, ownerOf(project, name));
      const at = await b.evaluate((w) => window.__tips.seen.findLast(s => s.who === w), `${who} ${project}`);
      want(at && at.after >= 120 && at.after <= 700, `${screen}: the ${kind} ship's card appeared ${at ? Math.round(at.after) : '—'} ms into the hover, not about 150`);
    }

    // one ship to the next: the card swaps at once
    await hover(shipOf('acme-web', 'onboarding'));
    await cardFor('onboarding', 'acme-web');
    await hover(shipOf('acme-web', 'stripe-billing'));
    await cardFor('stripe-billing', 'acme-web');
    const swap = await b.evaluate(() => window.__tips.seen.findLast(s => s.who === 'stripe-billing acme-web'));
    want(swap && swap.after < 80, `${screen}: moving to the next ship swapped the card ${swap ? Math.round(swap.after) : '—'} ms later, not at once`);

    // the model, when the grid has one; no row for what the grid does not have
    await hover(shipOf('acme-web', 'onboarding'));
    const ob = await soon(async () => { const l = await L(null); return l.rows.some(r => r[0] === 'Agent' && r[1].includes(MODEL)) ? l : null; }, 3000);
    want(ob, `${screen}: the card does not show the model the grid gives (${JSON.stringify((await L(null)).rows)})`);
    await hover(shipOf('acme-web', 'stripe-billing'));
    const sb = await cardFor('stripe-billing', 'acme-web');
    want(sb && !sb.rows.some(r => r[0] === 'Said' || r[0] === 'Label'), `${screen}: a ship with no message or label has rows for them: ${JSON.stringify(sb?.rows)}`);
    if (screen === 'home') {
      await hover(homeShip('billing-svc', 'precios-2027'));
      const lb = await soon(async () => { const l = await L(null); return l.rows.some(r => r[0] === 'Label') ? l : null; }, 3000);
      want(lb?.rows.some(r => r[0] === 'Label' && r[1] === 'urgente cliente'), `home: the labelled ship's card does not give its label: ${JSON.stringify(lb?.rows || (await L(null)).rows)}`);
    }

    // the pointer can cross onto the card to read it; leaving both closes it
    await hover(shipOf('acme-web', 'onboarding'));
    const c = await cardFor('onboarding', 'acme-web');
    if (c) {
      await move((c.tipBox.l + c.tipBox.r) / 2, (c.tipBox.t + c.tipBox.b) / 2);
      await sleep(450);
      want((await L(null)).open, `${screen}: the card closed while the pointer was on it`);
      await away();
      want(await soon(async () => !(await L(null)).open, 1500), `${screen}: the card stays open after the pointer left the ship and the card`);
    }

    // Esc closes it, and it stays closed while the pointer stays
    await hover(shipOf('acme-web', 'onboarding'));
    await cardFor('onboarding', 'acme-web');
    await press('Escape');
    want(await soon(async () => !(await L(null)).open, 1000), `${screen}: Esc does not close the card`);
    await sleep(400);
    want(!(await L(null)).open, `${screen}: the card came back after Esc with the pointer still on the ship`);
    want(!(await L(shipOf('acme-web', 'onboarding'))).describedby, `${screen}: the ship is still described by a closed card`);

    // the keyboard: Tab onto a ship shows its card, the next Tab swaps it, Esc closes it, and the
    // focus leaving closes it
    // acme-web has four ships on both screens: focus the first, and Tab walks the other three
    await away();
    await b.evaluate((s) => document.querySelector(s)?.focus(), screen === 'home' ? 'a.fboat[href^="#/p/acme-web/"]' : '.boat[data-boat^="acme-web/"]');
    await press('Tab');
    const f1 = await soon(async () => { const l = await L(null); const on = await b.evaluate(() => document.activeElement?.matches('.fboat, .boat')); return on && l.open ? l : null; }, 2000);
    if (want(f1, `${screen}: Tab onto a ship shows no card`)) {
      const focused = await b.evaluate(() => document.activeElement.getAttribute('aria-describedby'));
      want(focused === f1.id, `${screen}: the focused ship is described by ${JSON.stringify(focused)}, not the card ${JSON.stringify(f1.id)}`);
    }
    await press('Tab');
    const f2 = await soon(async () => { const l = await L(null); return l.open && l.who !== f1?.who ? l : null; }, 1000);
    want(f2, `${screen}: Tab to the next ship did not swap the card (still ${JSON.stringify((await L(null)).who)})`);
    await press('Escape');
    want(await soon(async () => !(await L(null)).open, 1000), `${screen}: Esc does not close a card the keyboard opened`);
    want(await b.evaluate(() => document.activeElement?.matches('.fboat, .boat')), `${screen}: Esc took the focus off the ship`);
    await press('Tab');
    if (await soon(async () => (await L(null)).open, 1000)) {
      await b.evaluate(() => document.activeElement.blur());
      want(await soon(async () => !(await L(null)).open, 1000), `${screen}: the card stays open after the focus left its ship`);
    } else want(false, `${screen}: Tab after Esc showed no card on the next ship`);

    // a click on a ship whose card is open opens the session, and the card goes with the screen
    await hover(shipOf('acme-web', 'onboarding'));
    await cardFor('onboarding', 'acme-web');
    await click(shipOf('acme-web', 'onboarding'));
    want(await soon(() => b.evaluate(() => location.hash === '#/p/acme-web/s/onboarding'), 3000), `${screen}: the click on a ship with its card open went to ${await b.evaluate(() => location.hash)}`);
    want(!(await L(null)).open, `${screen}: the card stayed on screen after the session opened`);
  }
  assert.deepEqual(problems, []);
});

test('phone 390×844: a held finger shows the card and opens nothing; a tap still opens the session', { timeout: 300000 }, async (t) => {
  const { b, go, ownerOf } = await setup(t, 'phone');
  const { problems, want } = checker('phone');
  const L = (sel) => b.evaluate(look, sel);
  const touch = async (sel, ms) => {
    await b.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
    await sleep(500);
    const s = (await L(sel)).shipBox;
    if (!s) return false;
    const pt = { x: (s.l + s.r) / 2, y: (s.t + s.b) / 2 };
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(ms);
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  };
  const tapAt = async (x, y) => {
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(60);
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const unrail = async () => { if (await b.evaluate(() => !!document.querySelector('.rail'))) await b.evaluate(() => document.querySelector('.rail-head .x')?.click()); };

  for (const [screen, route, ready, kinds, shipOf] of [['home', '/', '.fboat', HOME, homeShip], ['map', '/map', '.ocean .boat', MAP, mapShip]]) {
    await go(route, ready);
    await unrail();
    await b.evaluate(record);
    await sleep(500);
    const L0 = await L(null);
    want(L0.ships >= 4 && L0.titled === 0, `${screen}: ${L0.titled} native titles on or inside the ${L0.ships} ships`);
    for (const k of [kinds[0], kinds[3]]) {                     // the big lead and a ship near the bottom
      const [kind, project, name, who] = k;
      const before = await b.evaluate(() => location.hash);
      if (!want(await touch(shipOf(project, name), 700), `${screen}: there is no ${kind} ship ${project}/${name}`)) continue;
      await sleep(600);
      const l = await soon(async () => { const x = await L(shipOf(project, name)); return x.open && x.rows.some(r => r[0] === 'Agent') ? x : null; }, 3000) || await L(shipOf(project, name));
      want(l.hash === before, `${screen}: holding the ${kind} ship opened ${l.hash}`);
      says(want, screen, l, k, ownerOf(project, name));
      // a tap elsewhere (the demo bar's words, which do nothing) puts it away
      const bar = await b.evaluate(() => { const r = document.querySelector('.demo-bar')?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (want(bar, `${screen}: no demo bar to tap away on`)) await tapAt(bar.x, bar.y);
      want(await soon(async () => !(await L(null)).open, 1500), `${screen}: a tap away from the ${kind} ship's card left it open`);
    }
    // a plain tap opens the session, as it always did
    await touch(shipOf('acme-web', 'onboarding'), 60);
    want(await soon(() => b.evaluate(() => location.hash === '#/p/acme-web/s/onboarding'), 3000), `${screen}: a tap on a ship went to ${await b.evaluate(() => location.hash)}, not its session`);
    want(!(await L(null)).open, `${screen}: a tap on a ship showed its card`);
  }
  assert.deepEqual(problems, []);
});
