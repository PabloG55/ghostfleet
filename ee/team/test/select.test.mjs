// The app's pickers are its own (web/ui/select.jsx): no native <select> is left to open the
// engine's list, and the one that replaced them answers the keys a native one does — pressed in
// a real browser against the demo, with what they choose read back from the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rig } from './helpers/demo-rig.mjs';
import { findChrome, launch, sleep } from '../../../lib/browser.mjs';

const TEAM = new URL('..', import.meta.url).pathname;
const files = (dir, re) => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => re.test(f));

// The source of the screens, the team's and the shared ones it imports, and the bundle the
// server sends. Lowercase only: <Select> is the component that replaced it. A <select> written in JSX is a call with 'select' as the tag once it is built,
// and one written as markup is the literal. The bundle has to exist; the test command builds
// it first, and a sweep that skips when there is nothing to sweep proves nothing.
test('no native <select> is left in the team app, its shared screens, or the built bundle', () => {
  const src = [...files(path.join(TEAM, 'web/src'), /\.(jsx?|html)$/), ...files(path.join(TEAM, '../../web/ui'), /\.(jsx?|html)$/)];
  assert.ok(src.length > 20, `read ${src.length} source files`);
  const inSource = src.filter(f => /<select\b/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(TEAM, f));
  assert.deepEqual(inSource, [], 'a native <select> in the source');
  const dist = path.join(TEAM, 'web/dist');
  assert.ok(fs.existsSync(dist), 'no web/dist: build first (pnpm build)');
  const built = files(dist, /\.(js|html)$/);
  assert.ok(built.length > 0, 'web/dist has no scripts');
  const inBundle = built.filter(f => /<select\b|\(\s*["'`]select["'`]\s*,/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(TEAM, f));
  assert.deepEqual(inBundle, [], 'a native <select> in the built bundle');
});

// ── the keys, in a browser ─────────────────────────────────────────────────────────────────
const KEYS = {
  ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], Home: ['Home', 36], End: ['End', 35],
  Enter: ['Enter', 13, '\r'], ' ': ['Space', 32, ' '], Escape: ['Escape', 27], Tab: ['Tab', 9],
};
function keyOf(k) {
  if (KEYS[k]) { const [code, vk, text] = KEYS[k]; return { key: k, code, vk, text }; }
  return { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
}

test('the select answers the keyboard, and what it chooses is saved', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine to press the keys in'); return; }
  const r = await rig(t);
  const cookie = await r.login('admin');
  await r.call('POST', '/api/lang', { lang: 'en' }, cookie);
  const base = `http://127.0.0.1:${r.port}`;
  const b = await launch({ width: 1280, height: 800, scale: 1 });
  t.after(() => b.close());
  const [name, value] = cookie.split('=');
  await b.call('Network.setCookie', { name, value, url: base });

  const press = async (k) => {
    const { key, code, vk, text } = keyOf(k);
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(60);
  };
  const until = async (what, fn, ...args) => {
    for (let i = 0; i < 150; i++) { const v = await b.evaluate(fn, ...args); if (v) return v; await sleep(100); }
    throw new Error(`waited 15s for ${what}`);
  };
  const go = async (hash, sel) => {
    await b.call('Page.navigate', { url: `${base}/#${hash}` });
    await until(sel, (s) => !!document.querySelector(s), sel);
  };
  // What the picker that has the focus says about itself: open or not, the option the keys are
  // on, the value its button shows (its label, without the owner's avatar initials), whether the focus is still on it, and whether its open
  // list fits inside the window.
  const state = () => b.evaluate(() => {
    const el = document.activeElement;
    const box = el?.getAttribute('role') === 'combobox' ? el : null;
    const list = document.querySelector('[role=listbox]');
    const on = box && document.getElementById(box.getAttribute('aria-activedescendant') || '');
    const rect = list?.getBoundingClientRect();
    return {
      focused: !!box,
      open: box?.getAttribute('aria-expanded') === 'true',
      listed: !!list,
      on: on ? on.querySelector('.select-v').textContent.trim() : null,
      shows: box ? box.querySelector('.select-v').textContent.trim() : null,
      fits: rect ? rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth : null,
      hash: location.hash,
    };
  });
  const focus = (sel) => b.evaluate((s) => { document.querySelector(s).focus(); return document.activeElement === document.querySelector(s); }, sel);
  const me = async () => (await r.call('GET', '/api/me', undefined, cookie)).body.user.lang;

  // ── the language, in Settings ──
  await go('/settings', '[role=combobox]');
  const LANG = '.page [role=combobox]';
  assert.equal(await focus(LANG), true, 'the language picker takes the focus');
  let s = await state();
  assert.deepEqual([s.open, s.shows], [false, 'English'], 'closed, on English');

  await press('ArrowDown'); s = await state();
  assert.deepEqual([s.open, s.listed, s.on, s.fits], [true, true, 'English', true], '↓ opens on the chosen option, inside the window');
  await press('ArrowDown'); assert.equal((await state()).on, 'Español', '↓ moves down');
  await press('ArrowUp'); assert.equal((await state()).on, 'English', '↑ moves up');
  await press('End'); assert.equal((await state()).on, 'Español', 'End goes to the last');
  await press('Home'); assert.equal((await state()).on, 'English', 'Home goes to the first');
  await press('ArrowDown');
  await press('Escape'); s = await state();
  assert.deepEqual([s.open, s.listed, s.focused, s.shows], [false, false, true, 'English'], 'Esc closes without choosing, and the focus is back on the picker');

  await press(' '); assert.equal((await state()).open, true, 'Space opens');
  await press('Escape');
  await press('Enter'); assert.equal((await state()).open, true, 'Enter opens');
  await press('e'); await press('s'); assert.equal((await state()).on, 'Español', 'typing "es" jumps to the option that starts so');
  await press('Escape');
  await press('e'); s = await state();
  assert.deepEqual([s.open, s.on], [true, 'Español'], 'a letter opens the list on the next option that starts with it');
  await press('Tab'); s = await state();
  assert.deepEqual([s.open, s.listed, s.focused], [false, false, false], 'Tab closes the list and leaves the picker');
  assert.equal(await me(), 'en', 'nothing walked past or closed was saved');
  assert.equal(s.hash, '#/settings', 'the letters typed into the picker were not the desk\'s keys');

  assert.equal(await focus(LANG), true);
  await press('ArrowDown'); await press('ArrowDown'); await press('Enter');
  for (let i = 0; i < 50 && await me() !== 'es'; i++) await sleep(100);
  assert.equal(await me(), 'es', 'Enter chose Español, and the server saved it');
  await until('the page in Spanish', () => /Ajustes/.test(document.querySelector('h1')?.textContent || ''));
  assert.equal(await b.evaluate((sel) => document.querySelector(sel).querySelector('.select-v').textContent.trim(), LANG), 'Español', 'the picker shows what was chosen');

  // ── a session's owner ──
  const OWNER = '[role=combobox].owner-pick';
  await go('/p/acme-web/s/onboarding', OWNER);
  const owner = async () => (await r.call('GET', '/api/session?project=acme-web&session=onboarding', undefined, cookie)).body.owner;
  assert.notEqual(await owner(), 'viewer', 'the session starts with someone else as its owner, or none');
  assert.equal(await focus(OWNER), true, 'the owner picker takes the focus');
  await press('End'); s = await state();
  assert.deepEqual([s.open, s.on, s.fits], [true, 'scratch', true], 'End opens on the last person');
  await press('Home'); assert.equal((await state()).on, 'Sin responsable', 'Home goes to "no owner" (the page is in Spanish now)');
  await press('v'); assert.equal((await state()).on, 'viewer', 'a letter jumps to the person it starts');
  await press('Enter'); s = await state();
  assert.deepEqual([s.open, s.focused], [false, true], 'Enter chooses and closes, the focus stays');
  for (let i = 0; i < 50 && await owner() !== 'viewer'; i++) await sleep(100);
  assert.equal(await owner(), 'viewer', 'the server has the new owner');
  await until('the button showing the new owner', (sel) => document.querySelector(sel)?.querySelector('.select-v').textContent.trim() === 'viewer', OWNER);

  // ── Esc in a list in a dialog closes the list, and only the list ──
  await go('/p/acme-web', '.page-head .btn.primary');
  await b.evaluate(() => document.querySelector('.page-head .btn.primary').click());
  await until('the new-session dialog', () => !!document.querySelector('[aria-modal="true"] [role=combobox]'));
  assert.equal(await focus('[aria-modal="true"] [role=combobox]'), true);
  await press('ArrowDown'); assert.equal((await state()).open, true, 'the owner list opens in the dialog');
  await press('Escape'); s = await state();
  const dialog = () => b.evaluate(() => !!document.querySelector('[aria-modal="true"]'));
  assert.deepEqual([s.open, s.focused, await dialog()], [false, true, true], 'Esc closed the list and left the dialog open');
  await press('Escape');
  assert.equal(await dialog(), false, 'a second Esc closes the dialog');
});
