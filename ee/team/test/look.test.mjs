// The status lights: what colour each session status is drawn in, and that the motion the
// lights and boats carry is switched off for people who ask the system for less of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LIGHTS, STATUS_LIGHT, lightOf, colorOf, topLight } from '../web/src/lights.js';

const src = (p) => fs.readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8');

test('the four lights the product promises: green working, amber waiting, red error, dark asleep', () => {
  assert.equal(colorOf('working'), 'green');
  assert.equal(colorOf('need-you'), 'yellow');           // xterm 221, the amber
  for (const s of ['limit', 'interrupted', 'unknown', 'lost']) assert.equal(colorOf(s), 'red', s);
  for (const s of ['asleep', 'parked']) assert.equal(lightOf(s), 'off', s);
});

test('waiting on a person never shares a colour with an error', () => {
  const waiting = colorOf('need-you');
  for (const [s, l] of Object.entries(STATUS_LIGHT)) if (l === 'error') assert.notEqual(colorOf(s), waiting, s);
});

test('every status the app draws has its own light, not the fallback', () => {
  // ui.jsx's STATUS table is JSX-side; read its keys from the source.
  const table = src('ui.jsx').match(/export const STATUS = \{([\s\S]*?)\n\};/)[1];
  const keys = [...table.matchAll(/^\s*'?([a-z-]+)'?:\s*\{/gm)].map(m => m[1]);
  assert.ok(keys.length >= 11, `read ${keys.length} statuses from ui.jsx`);
  for (const k of keys) assert.ok(k in STATUS_LIGHT, `status '${k}' has no light in lights.js`);
});

test('a status nobody mapped looks like trouble, not calm', () => {
  assert.equal(lightOf('something-new'), 'error');
  assert.equal(lightOf(undefined), 'error');
});

test('a group shows its most urgent light', () => {
  assert.equal(topLight(['ready', 'working', 'need-you']), 'wait');
  assert.equal(topLight(['ready', 'limit', 'working']), 'error');
  assert.equal(topLight(['idle', 'working']), 'work');
  assert.equal(topLight(['parked', 'asleep']), 'off');
  assert.equal(topLight([]), 'off');
});

test('every light is styled, and every moving one stops under prefers-reduced-motion', () => {
  const css = src('styles.css');
  for (const [l, v] of Object.entries(LIGHTS)) {
    assert.ok(['green', 'yellow', 'red', 'cyan', 'grey'].includes(v.color), l);
    assert.ok(css.includes(`.fship.m-${v.motion}`) || v.motion === 'moored', `boat motion '${v.motion}' has no rule`);
  }
  for (const l of ['work', 'start', 'wait', 'error']) assert.match(css, new RegExp(`\\.led\\.l-${l} \\{ animation:`), `LED '${l}' does not move`);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(reduced, 'no prefers-reduced-motion block');
  for (const sel of ['.led', '.fship *', '.harbor *']) assert.ok(reduced[1].includes(sel), `reduced motion leaves ${sel} moving`);
  assert.match(reduced[1], /animation: none !important/);
});
