// The focus ring is the keyboard's. A click never leaves a box around what it clicked, not even
// once a key is pressed after it, and a tap on a phone does not flash one either; Tab, Esc and
// the arrows still show where the focus is.
//   Chromium's own :focus-visible turns the ring on for a modifier pressed alone, so Shift after
// a click (and the Cmd-Shift of a screenshot) drew the cyan ring around the button just clicked.
// web/ui/modality.js keeps it off until a key that moves or acts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { findChrome } from '../../../lib/browser.mjs';

// What the focused element draws: a ring (the box-shadow or outline the skin puts on focus), or
// for a select's button the cyan border it takes instead, and whether a tap would flash a box.
const drawn = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { on: 'body', ring: false };
  const cs = getComputedStyle(el);
  const cyan = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim();
  const asRgb = (c) => { const d = document.createElement('i'); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; };
  const ring = cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px')
    || (el.classList.contains('select') && el.getAttribute('aria-expanded') !== 'true' && cs.borderTopColor === asRgb(cyan));
  return { on: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`, ring, tap: cs.webkitTapHighlightColor };
};

test('a click leaves no focus ring, and the keyboard brings it back', { timeout: 120000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome on this machine'); return; }
  const { b, press, click, until, go } = await browse(t);
  const look = () => b.evaluate(drawn);

  // the report: Voice options, clicked, then a key that is only a modifier
  await go('/', '.home-agent');
  const VOICE = '.home-agent [aria-haspopup=dialog], .home-agent .voice-opts summary';
  await click(VOICE);
  let s = await look();
  assert.equal(s.ring, false, `no ring on ${s.on} right after the click`);
  await press('Shift'); s = await look();
  assert.equal(s.ring, false, `no ring on ${s.on} when Shift is pressed after the click`);
  assert.equal(s.tap, 'rgba(0, 0, 0, 0)', 'a tap does not flash a box over it either');
  await press('Escape'); s = await look();
  assert.equal(s.ring, true, `Esc is the keyboard: the ring is back on ${s.on}`);

  // a choice made with the mouse puts the focus back on the picker, and that is not the keyboard
  await go('/p/acme-web/s/onboarding', '.owner-pick');
  await click('.owner-pick');
  await until('the owner list', () => !!document.querySelector('[role=listbox]'));
  await click('[role=option]:nth-child(2)');
  await press('Shift'); s = await look();
  assert.equal(s.on, 'button.select', 'the focus went back to the owner picker');
  assert.equal(s.ring, false, 'and it is not ringed or lit for a choice made with the mouse');
  await press('Tab'); s = await look();
  assert.equal(s.ring, true, `Tab moves the focus and shows it, on ${s.on}`);

  // More, the session page's menu, clicked then Shift
  await click('.menu-wrap > .btn');
  await press('Shift'); s = await look();
  assert.equal(s.ring, false, `no ring on ${s.on} after More is clicked`);
});
