// web/ui/viewport.js — the on-screen keyboard, which is the one viewport nothing else reports.
//
// THE SOFTWARE KEYBOARD IS NOT PART OF THE LAYOUT VIEWPORT, and in an installed iPhone app it is
// worse than that. Measured on an iOS 26.5 simulator, standalone, from the home-screen icon:
// focusing a composer took innerHeight AND visualViewport.height from 844 to 431, while a page
// laid out to the full height stayed 844 tall — so the document overflowed by the keyboard,
// iOS scrolled it 413 to reveal the box, and the header went to y=-405. Reported as "the whole
// page scrolls and the status bar draws over the chat".
//   So WHILE THE KEYBOARD IS UP the app is laid out to the VISIBLE area: `html.kb` pins #app to
// visualViewport.offsetTop and sizes it to visualViewport.height (ui.css). Nothing overflows,
// there is nothing for iOS to scroll, and the column — header, list, composer — shrinks into the
// space above the keyboard the way a chat app's does.
//   TWO THINGS MADE AN EARLIER VERSION OF THIS WRONG, and both are absent. It called
// scrollTo(0,0) on every visualViewport scroll, which fights the reader and the browser for the
// same scrollbar; nothing here scrolls the window, ever. And it left its height in place when
// the keyboard went; here the class and both properties are REMOVED the moment the keyboard is
// not detected (setProperty(name, '') does not reliably remove a custom property in WebKit), and
// the closed layout is the plain one every other device gets.
//   The keyboard is "visible height well below the tallest seen at this width", not "innerHeight
// minus visual height": in standalone innerHeight shrinks WITH the keyboard, so that difference
// reads 0 with the keyboard fully up. Keyed by width, so a rotation starts over instead of
// comparing a landscape height with a portrait one. 120px is well above what a URL bar moves
// and well below the third of a screen a keyboard takes.
//   The bottom safe-area inset goes to 0 meanwhile (ui.css): it is there for the home indicator,
// the keyboard covers the home indicator, and stacking one on the other is the "too much space
// between the text box and the bottom" half of the same report.
//   A pinch zoom shrinks the visual viewport too, so the class also needs the focus in a text
// field: a zoomed page that nobody is typing into keeps its own layout.
import { setSoftKeyboardProbe } from './keys.js';

let tallest = 0, width = 0, up = false;

const typingInto = () => {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable);
};

export function syncViewport() {
  try {
    const vv = globalThis.visualViewport;
    if (!vv || typeof document === 'undefined') return;
    const h = Number(vv.height) || 0, w = Math.round(Number(vv.width) || 0);
    if (w !== width) { width = w; tallest = 0; }
    tallest = Math.max(tallest, h, Number(globalThis.innerHeight) || 0);
    up = tallest - h > 120 && typingInto();
    const root = document.documentElement;
    // A conversation that was showing its newest message keeps showing it as it shrinks: the
    // keyboard opening must not leave the reader looking at whatever was mid-screen.
    const list = document.querySelector('.chat');
    const atEnd = !!list && list.scrollHeight - list.clientHeight - list.scrollTop < 4;
    if (up) {
      root.classList.add('kb');
      root.style.setProperty('--app-top', Math.round(Number(vv.offsetTop) || 0) + 'px');
      root.style.setProperty('--app-h', Math.round(h) + 'px');
    } else {
      root.classList.remove('kb');
      root.style.removeProperty('--app-top');
      root.style.removeProperty('--app-h');
    }
    if (atEnd) list.scrollTop = list.scrollHeight;
  } catch {}
}

// visualViewport fires its OWN resize when the keyboard opens — window's does not, on iOS — and
// `scroll` too, because iOS can still pan the visual viewport and the app's top follows
// offsetTop. Focus moving in and out is the third signal: a keyboard dismissed by the done key
// fires a resize after the blur, and one raised by a tap fires it after the focus.
if (typeof document !== 'undefined') {
  syncViewport();
  try {
    globalThis.visualViewport?.addEventListener('resize', syncViewport);
    globalThis.visualViewport?.addEventListener('scroll', syncViewport);
    addEventListener('resize', syncViewport);
    addEventListener('focusout', () => setTimeout(syncViewport, 0));
  } catch {}
  // The shared ⏎ rule (keys.js) asks "is the on-screen keyboard up" of whoever measures it best.
  setSoftKeyboardProbe(() => up);
}
