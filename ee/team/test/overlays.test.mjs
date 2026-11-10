// Every overlay in the team app is the app's own, and closes the way the others do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browse } from './helpers/browse.mjs';
import { findChrome, sleep } from '../../../lib/browser.mjs';

const TEAM = new URL('..', import.meta.url).pathname;
const files = (dir, re) => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => re.test(f));

// The browser's confirm(), alert() and prompt() are grey system boxes titled with the server's
// address, and a headless screenshot never shows them. Deleting the AI key asked with one. A
// call is the bare name, or window.'s, followed by "(": setConfirm( and <Confirm are not it.
test('no native confirm, alert or prompt in the team app or its shared screens', () => {
  const src = [...files(path.join(TEAM, 'web/src'), /\.jsx?$/), ...files(path.join(TEAM, '../../web/ui'), /\.jsx?$/)];
  assert.ok(src.length > 20, `read ${src.length} source files`);
  const hits = [];
  for (const f of src) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*.*?(\*\/|$)/g, '').replace(/\/\/.*$/, '');
      if (/(^|[^\w.$]|window\.)(confirm|alert|prompt)\s*\(/.test(code)) hits.push(`${path.relative(TEAM, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'a native dialog');
});

// More, on a session's page, closed only when the mouse left it: on a touch screen it stayed
// open until one of its actions was picked, and Esc did nothing.
test('More closes on Esc, a press outside it, and its button', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const { b, press, click, go } = await browse(t);
  const BTN = '.menu-wrap > .btn';
  await go('/p/acme-web/s/onboarding', '.owner-pick');
  const st = () => b.evaluate((s) => ({
    open: !!document.querySelector('.menu-wrap .menu'),
    onBtn: document.activeElement === document.querySelector(s),
  }), BTN);
  const shut = async (what) => { for (let i = 0; i < 30 && (await st()).open; i++) await sleep(50); assert.equal((await st()).open, false, what); };

  await click(BTN); assert.equal((await st()).open, true, 'a click opens it');
  await press('Escape'); await shut('Esc closes it');
  assert.equal((await st()).onBtn, true, 'and puts the focus back on More');
  await click(BTN); assert.equal((await st()).open, true);
  await click('.sess-head h1');
  await shut('a press outside closes it');
  await click(BTN); assert.equal((await st()).open, true);
  await click(BTN); await shut('More again closes it');
});

// A toast came up in the bottom-right corner on top of the Assistant button, the next thing
// most people click, and hid it for as long as it showed. The task chip had its own
// fixed height that was not lifted with the button over a composer, so on a session page
// the button sat on the chip. All three stack now, from one height.
test('a toast stacks above the Assistant button and the task chip, and the chip above the button', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const { b, click, until, go } = await browse(t);
  // the demo makes no task, so the chip is the app's own markup put beside the button
  const chip = () => b.evaluate(() => {
    if (document.querySelector('.tk-chip.floating')) return;
    const c = document.createElement('button'); c.className = 'tk-chip floating'; c.textContent = 'Tasks 1';
    document.querySelector('.app').append(c);
  });
  const overlaps = () => b.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const hit = (a, z) => a.left < z.right && z.left < a.right && a.top < z.bottom && z.top < a.bottom;
    const btn = document.querySelector('.as-launch'), tk = document.querySelector('.tk-chip.floating');
    const toasts = [...document.querySelectorAll('.toast')];
    const out = [];
    if (!btn || !toasts.length) return [`button ${!!btn}, toasts ${toasts.length}`];
    for (const el of toasts) {
      if (hit(box(el), box(btn))) out.push(`toast "${el.textContent}" on the button`);
      if (tk && hit(box(el), box(tk))) out.push(`toast "${el.textContent}" on the chip`);
    }
    if (tk && hit(box(tk), box(btn))) out.push('chip on the button');
    return out;
  });
  // More, Schedule a message, In 30 min: the session page's own way to a toast
  const schedule = async () => {
    await click('.menu-wrap > .btn');
    await click('.menu-wrap .menu > button:nth-child(2)');
    await click('.modal .quick .btn');
    await until('a toast', () => !!document.querySelector('.toast'));
  };
  const gone = () => until('the toasts to go', () => !document.querySelector('.toast'));

  // the report: a toast on a page with no composer
  await go('/settings', '.panel');
  await b.evaluate(() => { [...document.querySelectorAll('.panel .btn')].pop().id = 't-reset'; });
  await click('#t-reset');
  await until('a toast', () => !!document.querySelector('.toast'));
  assert.deepEqual(await overlaps(), [], 'settings, 1280 wide');
  await gone();

  // a session page lifts the button over its composer; the chip and the toast go above it
  await go('/p/acme-web/s/stripe-billing', '.composer');
  await chip();
  await schedule();
  assert.deepEqual(await overlaps(), [], 'a session page, 1280 wide');
  await gone();

  // the same address again is not a navigation, so the phone round reloads to start clean
  await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await b.call('Page.reload', {});
  await until('the composer', () => innerWidth === 390 && !!document.querySelector('.composer') && !document.querySelector('.tk-chip.floating'));
  await chip();
  await schedule();
  assert.deepEqual(await overlaps(), [], 'a session page, 390 wide');
});
