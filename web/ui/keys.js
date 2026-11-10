// web/ui/keys.js — the desk's keys, in a browser. One layer, with no framework in it, so the
// phone client's vanilla app.js can take it as it is and the Preact screens can wrap it
// (keyboard.jsx). What each key does on each screen is web/ui/README.md's table; the rules
// every key obeys are here:
//
//   - A TEXT BOX OWNS THE KEYBOARD. Nothing fires while an input, textarea, select or
//     contenteditable has the focus, so `q` in a message is a letter. A session's composer
//     lets through exactly the keys tmux answers before the agent at the desk
//     (deskKeyInComposer).
//   - ⌘ IS THE OPERATING SYSTEM'S. The desk binds Ctrl and never ⌘, so no key with metaKey
//     held is taken: ⌘C, ⌘V, ⌘R, ⌘L keep doing what the OS and the browser say.
//   - AN IME IS NEVER INTERRUPTED. A key that arrives mid-composition (isComposing, or the
//     keyCode 229 some browsers send in its place) is the IME's: its Enter commits the
//     characters, and sending then would ship half a word.
//   - THE ON-SCREEN KEYBOARD KEEPS ITS RETURN KEY. On a phone ⏎ in the composer is a new line
//     and `send` is a button; with a real keyboard, a mouse or a trackpad, ⏎ sends and ⇧⏎ is
//     the new line. A page cannot ask which it has, so enterSends() goes by evidence.
//   - A DIALOG OWNS THE KEYBOARD WHILE IT IS OPEN. Its own keys (Esc closes it) and nothing
//     else; the caller says when one is open.

// ── what has the focus ──────────────────────────────────────────────────────────────────
export const typingIn = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || !!t.isContentEditable);

// ── is there a real keyboard ────────────────────────────────────────────────────────────
// Two kinds of evidence, either enough: a fine pointer that hovers (a mouse or a trackpad,
// which is to say a computer), or a keydown only a physical keyboard can send. Never by
// device, model or width: an iPad with a keyboard and one without are the same device at the
// same width.
export const SOFTLESS_KEY = /^(Escape|Tab|Arrow|F\d{1,2}$|Shift$|Control$|Alt$|Meta$|CapsLock$|Home$|End$|PageUp$|PageDown$)/;

export function finePointer() {
  try { return !!matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
}

// The on-screen keyboard, from the visual viewport: it takes a third of the screen, while a
// connected keyboard leaves at most a shortcut bar and the URL bar moves the height by a few
// pixels. "Well below the tallest seen at this width", not "innerHeight minus the visual
// height", because in an installed app innerHeight shrinks WITH the keyboard and that
// difference reads 0 with the keyboard fully up. An app that already measures this (the
// phone client's syncViewport) hands its own answer to setSoftKeyboardProbe.
let vvTallest = 0, vvWidth = 0;
function measuredSoftKeyboard() {
  try {
    const vv = globalThis.visualViewport;
    if (!vv) return false;
    const h = Number(vv.height) || 0, w = Math.round(Number(vv.width) || 0);
    if (w !== vvWidth) { vvWidth = w; vvTallest = 0; }
    vvTallest = Math.max(vvTallest, h, Number(globalThis.innerHeight) || 0);
    return vvTallest - h > 120;
  } catch { return false; }
}
// Measured from the start and on every resize, not only when a key asks: the tallest height has
// to be known BEFORE the keyboard comes up, and on a phone the first key is typed after a tap
// on the composer has already brought it up. Asked only then, the keyboard's own height reads
// as the tallest, the keyboard reads as absent, and the first letter typed on a phone is taken
// for a keyboard someone attached — after which ⏎ sends instead of starting a line.
try { measuredSoftKeyboard(); globalThis.visualViewport?.addEventListener('resize', measuredSoftKeyboard); } catch {}
let softProbe = measuredSoftKeyboard;
export function setSoftKeyboardProbe(fn) { softProbe = typeof fn === 'function' ? fn : measuredSoftKeyboard; }

// Sticky for the life of the page. isTrusted TRUE, not merely "not false": only the browser's
// own input sets it, so a keydown a script built, or a test's plain object, is never taken
// for a keyboard someone attached.
let hwKeyboard = false;
export function noteKeyboard(e) {
  if (hwKeyboard || !e || e.isTrusted !== true) return;
  const field = typingIn(e.target);
  if (!field || SOFTLESS_KEY.test(e.key || '') || e.ctrlKey || e.metaKey || e.altKey || !softProbe()) hwKeyboard = true;
}
export function keyboardSeen() { return hwKeyboard; }
export function enterSends() { return finePointer() || hwKeyboard; }

// The composer's ⏎: send, or leave it to the box as a new line.
export function sendsOnEnter(e) {
  return !!e && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && enterSends();
}

// ── one key, as the desk reads it ───────────────────────────────────────────────────────
// null when the key is not the layer's at all: no key, ⌘ held, an IME mid-composition, or a
// modifier pressed on its own (the chord arrives with the next event). `lk` is the letter
// folded to lower case, so Ctrl-F and Ctrl-f are one chord; `k` keeps the case, so `q` and
// `Q` stay two keys.
export function deskKey(e) {
  const k = e && e.key;
  if (!k || e.metaKey || e.isComposing || e.keyCode === 229) return null;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'Dead' || k === 'Process') return null;
  return { k, lk: k.length === 1 ? k.toLowerCase() : k, ctrl: !!e.ctrlKey && !e.altKey, shift: !!e.shiftKey, alt: !!e.altKey };
}

// THE KEYS TMUX TAKES EVEN WHILE YOU TYPE TO THE AGENT. At the desk a session is attached and
// every key goes to the agent except the ones tmux binds with -n: ` (back), ⇧← / ⇧→ (the next
// session), Ctrl-s, Ctrl-p, Ctrl-f and Ctrl-a's prefix table. The composer is the agent's
// input here, so from inside it those same keys act, and nothing else does. With the desk's
// two costs: a literal ` cannot be typed into a message, and ⇧← / ⇧→ move between sessions
// rather than selecting text. A chord or a prefix already started takes its next key whole.
//   `held`  a chord or a prefix is waiting for its next key
//   `stack` the app has the stack, whose Ctrl-x is cut on Linux and Windows: it is the
//           stack's only while nothing in the box is selected, so cutting a selection cuts
export function deskKeyInComposer(e, { held = false, stack = false } = {}) {
  if (held) return true;
  if (!e || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return false;
  const k = e.key, lk = k && k.length === 1 ? k.toLowerCase() : k;
  const t = e.target, sel = !!t && Number.isInteger(t.selectionStart) && t.selectionStart !== t.selectionEnd;
  if (e.ctrlKey && lk === 'x') return stack && !sel;
  if (e.ctrlKey) return lk === 's' || lk === 'p' || lk === 'f' || lk === 'a';
  if (k === '`') return true;
  return !!e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight');
}

// ── Ctrl-f: the jump chord, every step of tmux's cfjump tables ─────────────────────────
// Ctrl-f <p> <s> → project p, its card s · Ctrl-f <p> ⏎|m → its master · Ctrl-f <p> s and
// Ctrl-f s <p> → its grid · Ctrl-f p → Projects. Esc, Ctrl-f or Ctrl-c cancels, and any other
// key aborts. `j` is the chord so far ({ stage: 'first' } to start); the answer is the chord
// after this key (null once it is over) and where to go, if anywhere:
//   { to: 'card', project: p, card: s } · { to: 'master', project: p } · { to: 'grid', project: p }
//   · { to: 'projects' }
// Projects and cards are counted from 1, in the fleet's own order: the desk's proj_nth and
// grid numbering, which is also what the phone client's digits count.
export function jumpStep(j, key) {
  const { k, lk, ctrl } = key;
  const digit = !ctrl && /^[1-9]$/.test(k);
  if (k === 'Escape' || (ctrl && (lk === 'f' || lk === 'c'))) return { j: null, go: null };
  if (j.stage === 'first') {
    if (digit) return { j: { stage: 'proj', proj: Number(k) }, go: null };
    if (!ctrl && lk === 's') return { j: { stage: 'grid' }, go: null };
    if (!ctrl && lk === 'p') return { j: null, go: { to: 'projects' } };
    return { j: null, go: null };
  }
  if (j.stage === 'grid') return { j: null, go: digit ? { to: 'grid', project: Number(k) } : null };
  if (digit) return { j: null, go: { to: 'card', project: j.proj, card: Number(k) } };
  if (k === 'Enter' || (!ctrl && lk === 'm')) return { j: null, go: { to: 'master', project: j.proj } };
  if (!ctrl && lk === 's') return { j: null, go: { to: 'grid', project: j.proj } };
  return { j: null, go: null };
}

// ── moving a cursor over what is on screen ─────────────────────────────────────────────
// h / l (← / →) are the previous and next item, in reading order: the desk's move(±1), which
// runs off the end of a row onto the next one. j / k (↓ / ↑) cross a row, and on a page laid
// out by CSS the only place a row exists is the boxes the browser drew, so the step is read
// from them: the nearest row below (or above) whose top clears this box's middle, and in it
// the box whose centre is nearest this one's. `rects` are DOMRect-likes in reading order and
// `from` an index into them (-1 for none: the first key lands on the first item).
// Answers the index to move to, or -1 to stay.
export function stepIndex(rects, from, dir) {
  const n = rects.length;
  if (!n) return -1;
  if (from < 0 || from >= n) return 0;
  if (dir === 'left') return from > 0 ? from - 1 : -1;
  if (dir === 'right') return from < n - 1 ? from + 1 : -1;
  const a = rects[from], mid = a.top + a.height / 2, cx = a.left + a.width / 2;
  const down = dir === 'down';
  const beyond = [];
  for (let i = 0; i < n; i++) {
    const r = rects[i];
    if (i === from || !r.width || !r.height) continue;
    if (down ? r.top > mid : r.bottom < mid) beyond.push(i);
  }
  if (!beyond.length) return -1;
  // The nearest row: every box that starts within half a box of the closest one.
  const edge = (i) => down ? rects[i].top : -rects[i].bottom;
  const near = Math.min(...beyond.map(edge));
  const row = beyond.filter(i => edge(i) - near < Math.max(4, a.height / 2));
  let best = row[0], bestD = Infinity;
  for (const i of row) {
    const d = Math.abs(rects[i].left + rects[i].width / 2 - cx);
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

export const DIRS = { ArrowLeft: 'left', h: 'left', ArrowRight: 'right', l: 'right', ArrowUp: 'up', k: 'up', ArrowDown: 'down', j: 'down' };

// ⇧← / ⇧→: the next or previous session, master first and then the cards in grid order,
// wrapping at both ends (fleet-cycle). `names` is that order; answers the name to open.
export function cycleName(names, current, d) {
  if (!names.length) return null;
  const i = names.indexOf(current);
  if (i < 0) return names[0];
  return names[(i + d + names.length) % names.length];
}
