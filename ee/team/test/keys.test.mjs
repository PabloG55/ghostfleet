// The desk's keyboard rules (web/ui/keys.js), which the team app and the phone client both run.
// Each rule is asked in both directions: the key it takes AND the one it must leave alone,
// because a rule that never fires passes every "it does not misfire" check.
// The keys as pressed, screen by screen, are proven in a real browser against the demo; this is
// the part that can be asked without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typingIn, deskKey, deskKeyInComposer, jumpStep, stepIndex, cycleName, sendsOnEnter, noteKeyboard, keyboardSeen, setSoftKeyboardProbe }
  from '../../../web/ui/keys.js';

const key = (k, o = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...o });
const box = (o = {}) => ({ tagName: 'TEXTAREA', selectionStart: 2, selectionEnd: 2, ...o });

test('a text box owns the keyboard; a page does not', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(typingIn({ tagName: tag }), true, tag);
  assert.equal(typingIn({ tagName: 'DIV', isContentEditable: true }), true);
  for (const tag of ['BODY', 'A', 'BUTTON', 'ARTICLE']) assert.equal(typingIn({ tagName: tag }), false, tag);
  assert.equal(typingIn(null), false);
});

test('⌘, a lone modifier and an IME mid-word are not the desk\'s keys', () => {
  assert.equal(deskKey(key('f', { metaKey: true })), null);
  assert.equal(deskKey(key('p', { metaKey: true, ctrlKey: true })), null);
  for (const k of ['Shift', 'Control', 'Alt', 'Meta']) assert.equal(deskKey(key(k)), null, k);
  assert.equal(deskKey(key('Enter', { isComposing: true })), null);
  assert.equal(deskKey(key('Enter', { keyCode: 229 })), null);
  // ...and the ones that are: Ctrl folds the letter, plain keeps its case.
  assert.deepEqual(deskKey(key('F', { ctrlKey: true, shiftKey: true })), { k: 'F', lk: 'f', ctrl: true, shift: true, alt: false });
  assert.equal(deskKey(key('Q')).k, 'Q');
  assert.equal(deskKey(key('f', { ctrlKey: true, altKey: true })).ctrl, false, 'Ctrl-Alt is AltGr on a European layout, a character');
});

test('from inside the composer only tmux\'s -n keys act', () => {
  const t = box();
  for (const [k, o] of [['`', {}], ['ArrowLeft', { shiftKey: true }], ['ArrowRight', { shiftKey: true }],
                        ['s', { ctrlKey: true }], ['p', { ctrlKey: true }], ['f', { ctrlKey: true }], ['a', { ctrlKey: true }]]) {
    assert.equal(deskKeyInComposer({ ...key(k, o), target: t }), true, `${k} ${JSON.stringify(o)}`);
  }
  for (const [k, o] of [['q', {}], ['1', {}], ['ArrowLeft', {}], ['Enter', {}], ['c', { ctrlKey: true }], ['v', { ctrlKey: true }],
                        ['f', { metaKey: true }], ['`', { altKey: true }], ['ArrowRight', { shiftKey: true, metaKey: true }]]) {
    assert.equal(deskKeyInComposer({ ...key(k, o), target: t }), false, `${k} ${JSON.stringify(o)}`);
  }
  // A chord already started takes its next key whole, whatever it is.
  assert.equal(deskKeyInComposer({ ...key('q'), target: t }, { held: true }), true);
  // Ctrl-x is the stack's only where there is a stack, and only with nothing selected to cut.
  assert.equal(deskKeyInComposer({ ...key('x', { ctrlKey: true }), target: t }), false);
  assert.equal(deskKeyInComposer({ ...key('x', { ctrlKey: true }), target: t }, { stack: true }), true);
  assert.equal(deskKeyInComposer({ ...key('x', { ctrlKey: true }), target: box({ selectionStart: 0, selectionEnd: 3 }) }, { stack: true }), false);
});

test('Ctrl-f walks tmux\'s cfjump tables', () => {
  const k = (s, ctrl = false) => ({ k: s, lk: s.length === 1 ? s.toLowerCase() : s, ctrl });
  const first = { stage: 'first' };
  assert.deepEqual(jumpStep(first, k('3')), { j: { stage: 'proj', proj: 3 }, go: null });
  assert.deepEqual(jumpStep(first, k('s')), { j: { stage: 'grid' }, go: null });
  assert.deepEqual(jumpStep(first, k('p')), { j: null, go: { to: 'projects' } });
  assert.deepEqual(jumpStep(first, k('x')), { j: null, go: null }, 'any other key aborts');
  assert.deepEqual(jumpStep(first, k('0')), { j: null, go: null }, '0 is not a project');
  const proj = { stage: 'proj', proj: 2 };
  assert.deepEqual(jumpStep(proj, k('4')).go, { to: 'card', project: 2, card: 4 });
  assert.deepEqual(jumpStep(proj, k('Enter')).go, { to: 'master', project: 2 });
  assert.deepEqual(jumpStep(proj, k('m')).go, { to: 'master', project: 2 });
  assert.deepEqual(jumpStep(proj, k('s')).go, { to: 'grid', project: 2 });
  assert.deepEqual(jumpStep({ stage: 'grid' }, k('5')).go, { to: 'grid', project: 5 });
  assert.deepEqual(jumpStep({ stage: 'grid' }, k('m')).go, null);
  for (const stage of [first, proj, { stage: 'grid' }]) {
    for (const c of [k('Escape'), k('f', true), k('c', true)]) assert.deepEqual(jumpStep(stage, c), { j: null, go: null }, `${stage.stage} ${c.k}`);
  }
  // A Ctrl'd digit is not a digit.
  assert.deepEqual(jumpStep(first, k('3', true)), { j: null, go: null });
});

test('⏎ sends with a keyboard, and never mid-composition', () => {
  // No fine pointer in node (no matchMedia) and no keyboard seen yet: the phone's new line.
  assert.equal(keyboardSeen(), false);
  assert.equal(sendsOnEnter(key('Enter')), false);
  // A test harness's plain object is never a keyboard someone attached; only isTrusted is.
  noteKeyboard({ ...key('Escape'), target: box() });
  assert.equal(keyboardSeen(), false);
  // A letter typed into a field WHILE the on-screen keyboard is up proves nothing either.
  setSoftKeyboardProbe(() => true);
  noteKeyboard({ ...key('a'), target: box(), isTrusted: true });
  assert.equal(keyboardSeen(), false);
  // ...and a key no on-screen keyboard has proves a real one.
  noteKeyboard({ ...key('ArrowLeft'), target: box(), isTrusted: true });
  assert.equal(keyboardSeen(), true);
  setSoftKeyboardProbe(null);
  assert.equal(sendsOnEnter(key('Enter')), true);
  assert.equal(sendsOnEnter(key('Enter', { shiftKey: true })), false, '⇧⏎ is the new line');
  assert.equal(sendsOnEnter(key('Enter', { isComposing: true })), false);
  assert.equal(sendsOnEnter(key('Enter', { keyCode: 229 })), false);
  assert.equal(sendsOnEnter(key('a')), false);
});

test('the cursor steps over the boxes the browser drew', () => {
  const r = (left, top, w = 100, h = 60) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
  // Two rows of three, then one wider box alone.
  const rects = [r(0, 0), r(110, 0), r(220, 0), r(0, 70), r(110, 70), r(220, 70), r(60, 140, 200)];
  assert.equal(stepIndex(rects, -1, 'down'), 0, 'the first key lands on the first item');
  assert.equal(stepIndex(rects, 1, 'right'), 2);
  assert.equal(stepIndex(rects, 2, 'right'), 3, 'off the end of a row onto the next, as the desk does');
  assert.equal(stepIndex(rects, 0, 'left'), -1);
  assert.equal(stepIndex(rects, 6, 'right'), -1);
  assert.equal(stepIndex(rects, 1, 'down'), 4, 'straight down');
  assert.equal(stepIndex(rects, 4, 'up'), 1);
  assert.equal(stepIndex(rects, 5, 'down'), 6, 'the nearest box in the next row');
  assert.equal(stepIndex(rects, 6, 'up'), 4, 'back up to the one under its centre');
  assert.equal(stepIndex(rects, 6, 'down'), -1);
  assert.equal(stepIndex([], 0, 'down'), -1);
});

test('⇧← / ⇧→ go round the sessions and wrap', () => {
  const names = ['master', 'api-2', 'web-1'];
  assert.equal(cycleName(names, 'master', 1), 'api-2');
  assert.equal(cycleName(names, 'web-1', 1), 'master');
  assert.equal(cycleName(names, 'master', -1), 'web-1');
  assert.equal(cycleName(names, 'gone', 1), 'master');
  assert.equal(cycleName([], 'master', 1), null);
});
