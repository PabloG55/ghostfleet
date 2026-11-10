// web/ui/modality.js — whether the hand on the controls is a pointer or the keyboard, for the
// focus ring to follow.
//
// The ring is drawn on :focus-visible, which leaves the choice to the browser, and the browser
// counts a modifier pressed on its own as the keyboard: click a button, press Shift (or the
// Cmd-Shift of a screenshot shortcut) and Chromium turns the ring on around the button. Someone
// working with the mouse saw a box appear around what they had just clicked. So a pointer's press
// (a mouse, a finger, a pen) marks the page as pointer-driven and the rings stay off, and the
// first key that is neither a modifier nor a Cmd/Ctrl shortcut gives them back: Tab, an arrow,
// Esc and every desk key count, so the keyboard never waits for a ring.
//   The rules that draw a focus state are written under :where(:root:not(.by-pointer)), which
// adds nothing to their specificity. A page that loads the skin without this module never gets
// the class and keeps the browser's own choice.
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

if (typeof document !== 'undefined') {
  const root = document.documentElement;
  addEventListener('pointerdown', () => root.classList.add('by-pointer'), true);
  addEventListener('keydown', (e) => {
    if (MODIFIERS.has(e.key) || e.metaKey || e.ctrlKey) return;
    root.classList.remove('by-pointer');
  }, true);
}
