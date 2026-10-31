// web/term.js — the terminal screen's engine: xterm.js on one side, fleet-serve's
// WebSocket on the other, and the fleet tab (bin/fleet-tab's `_term-<project>`) behind it.
//
// Loaded on demand (app.js imports it when a terminal opens), because xterm.js is most of
// the client's bytes and most launches never open a shell.
//
// WHAT xterm.js IS HERE: a VIEW of a tmux pane, not the pane's terminal. tmux is the
// terminal the shell is running in — it parsed every byte before we saw it, and it ANSWERS
// the shell's questions itself (where is the cursor, what are you, what colour is the
// background). Control mode then hands us the same bytes raw, questions included, and
// xterm.js would answer them a second time: the answer goes back as input, and nvim reads
// `\e[0n` or an OSC 11 colour report as keys it never asked for. So the queries are
// swallowed below and only tmux answers — measured on attach: nvim sends DSR and OSC 11 the
// moment its client size changes.
import { Terminal } from './xterm.js';
import { FitAddon } from './xterm-fit.js';
import * as api from './api.js';

// The key row's keys, as bytes, in its two bands. Esc, Tab, Enter and the arrows are what a
// phone keyboard lacks or hides behind a mode switch; : and | ~ / - are what it buries a page
// deep. ␣ is LazyVim's leader, which is Space: on an iPhone keyboard the space bar is there,
// but it is also what dictation and the trackpad gesture live on, and a key that SAYS leader
// is the one a person driving LazyVim looks for. Ctrl and Alt are not bytes — they latch,
// and change the next key typed (see modded).
export const KEY_ROWS = [
  [{ label: 'Esc', send: '\x1b' }, { label: 'Ctrl', latch: 'ctrl', aria: 'Control' }, { label: 'Alt', latch: 'alt', aria: 'Alt' },
   { label: 'Tab', send: '\t' }, { label: '␣ leader', send: ' ', aria: 'Space, the leader key', wide: true },
   { label: ':', send: ':' }, { label: '⏎', send: '\r', aria: 'Enter' }],
  [{ label: '←', send: '\x1b[D', arrow: 'D' }, { label: '↑', send: '\x1b[A', arrow: 'A' },
   { label: '↓', send: '\x1b[B', arrow: 'B' }, { label: '→', send: '\x1b[C', arrow: 'C' },
   { label: '|', send: '|' }, { label: '~', send: '~' }, { label: '/', send: '/' }, { label: '-', send: '-' }],
];
export const KEYS = KEY_ROWS.flat();
// What Ctrl does to one typed character: the C0 control a hardware keyboard would send.
export function ctrlOf(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return ch;
  if (ch === ' ' || ch === '@' || ch === '2') return '\x00';
  if (ch === '?') return '\x7f';
  const c = ch.toUpperCase().charCodeAt(0);
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch;
}
// The latched modifiers applied to what one key sends, as a hardware keyboard would send it:
// Ctrl turns one character into its C0 control, Alt is ESC before it (xterm's metaSendsEscape,
// which is how zsh's M-b and nvim's <M-…> are read), and a modified ARROW is the xterm form
// with its parameter (1;3 Alt, 1;5 Ctrl) rather than an escape glued to the plain arrow.
export function modded(s, { ctrl = false, alt = false } = {}, arrowKey = '') {
  if (arrowKey && (ctrl || alt)) return `\x1b[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${arrowKey}`;
  if (ctrl && s.length === 1) s = ctrlOf(s);
  return alt ? '\x1b' + s : s;
}
// THE FONT, WHICH IS THE COLUMN COUNT. A phone cannot show a desk's 13px terminal: measured
// on the editor tab at 390pt, LazyVim got 37 columns and drew its explorer's right half off
// the screen. FONT_MIN and FONT_MAX bound the pinch and A−/A+; the caller picks the default
// and remembers the choice (app.js termFont).
export const FONT_MIN = 6, FONT_MAX = 24;
const clampFont = (px) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(Number(px) || 0)));
// THE ONE KEY THAT LEAVES (desktop). While the terminal has focus every key goes to the
// shell — the desk's Ctrl-s, Ctrl-p, Ctrl-f, ` and the Ctrl-a prefix included, since inside
// a terminal those belong to the shell and nvim, not to the fleet. ⇧Esc is the way out
// because a terminal cannot tell it from Esc: xterm sends ESC for both, so taking it costs
// the shell nothing it could otherwise have been sent. (Clicking anywhere outside the
// terminal leaves it too.)
export const isLeaveKey = (e) => !!e && e.type === 'keydown' && e.key === 'Escape' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;

const THEME = { background: '#0b0d10', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#3a4150' };
const utf8 = new TextEncoder();

// mount(host, opts) -> handle. host is an empty element the caller owns and keeps in the
// document for as long as the terminal is open (app.js keeps the same node across renders).
//   opts.onState({ state, why }) — 'opening' | 'open' | 'closed'
//   opts.onLeave() — the leave key was pressed
//   opts.fontSize — the starting size; opts.onFont(px) — a pinch or A−/A+ changed it
//   opts.onFocus(up) — the terminal took or lost the focus (on a phone: the keyboard)
//   opts.onCopy(text) — a long-press selection was copied to this device's clipboard
export function mount(host, { onState = () => {}, onLeave = () => {}, fontSize = 13, onFont = () => {},
                              onFocus = () => {}, onCopy = () => {} } = {}) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: clampFont(fontSize), scrollback: 5000, cursorBlink: true, theme: THEME,
    // Option is Meta at a Mac keyboard, so zsh's M-b/M-f and nvim's <M-…> maps work; the
    // characters Option would otherwise type are not what a shell is driven with.
    macOptionIsMeta: true,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  for (const id of [{ final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' },
                    { final: 'n' }, { prefix: '?', final: 'n' },
                    { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
                    { prefix: '>', final: 'q' }])
    term.parser.registerCsiHandler(id, () => true);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  // Colour QUERIES only (`?`); a shell that SETS a colour still gets it.
  for (const n of [4, 10, 11, 12]) term.parser.registerOscHandler(n, (d) => String(d).includes('?'));
  term.open(host);
  term.attachCustomKeyEventHandler((e) => {
    if (isLeaveKey(e)) { e.preventDefault(); onLeave(); return false; }
    return true;
  });
  if (term.textarea) {
    term.textarea.addEventListener('focus', () => onFocus(true));
    term.textarea.addEventListener('blur', () => onFocus(false));
  }

  let ws = null, state = 'opening', why = '';
  const mods = { ctrl: false, alt: false }, modNode = { ctrl: null, alt: null };
  const set = (s, w = '') => { state = s; why = w; onState({ state, why }); };
  const send = (bytes) => { if (ws && ws.readyState === 1) ws.send(bytes); };
  const sendText = (s) => send(utf8.encode(s));
  // The application cursor mode (DECCKM) decides whether an arrow is ESC [ A or ESC O A; a
  // key-row arrow follows it, so it does what the keyboard's own arrow would.
  const arrow = (k) => (term.modes && term.modes.applicationCursorKeysMode ? `\x1bO${k}` : `\x1b[${k}`);
  const latched = () => mods.ctrl || mods.alt;
  const unlatch = () => {
    for (const m of ['ctrl', 'alt']) { mods[m] = false; if (modNode[m]) modNode[m].classList.toggle('on', false); }
  };
  term.onData((d) => {
    if (latched() && d.length === 1) { sendText(modded(d, mods)); unlatch(); return; }
    sendText(d);
  });
  // Some mouse modes report bytes above 0x7f that are not UTF-8: sent as they are.
  term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));
  const resize = () => { try { fit.fit(); } catch {} };
  term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols, rows })); });
  let ro = null;
  try { ro = new ResizeObserver(() => resize()); ro.observe(host); } catch {}
  resize();
  const setFont = (px) => {
    const f = clampFont(px);
    if (f === term.options.fontSize) return f;
    term.options.fontSize = f;
    resize();                     // new cols and rows, and onResize tells the pane (#89's path)
    onFont(f);
    return f;
  };
  const untouch = touchAsMouse(term, host, { setFont, onCopy });

  const h = {
    term,
    get state() { return state; },
    get why() { return why; },
    size() { resize(); return { cols: term.cols, rows: term.rows }; },
    connect(ticket) {
      set('opening');
      ws = api.termSocket(ticket);
      ws.onopen = () => { resize(); ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string') { term.write(new Uint8Array(m.data)); return; }
        let o = null; try { o = JSON.parse(m.data); } catch {}
        if (o && o.t === 'ready') set('open');
        if (o && o.t === 'closed') why = o.why || why;
      };
      ws.onclose = (ev) => { ws = null; set('closed', why || ev.reason || (ev.code === 1006 ? 'the connection dropped' : `closed (${ev.code})`)); };
    },
    focus() { try { term.focus(); } catch {} },
    blur() { try { term.blur(); } catch {} },
    get focused() { return !!term.textarea && document.activeElement === term.textarea; },
    // THE KEYBOARD BUTTON. On a phone the on-screen keyboard is up exactly while xterm's
    // textarea has the focus, so raising it is focusing that and hiding it is blurring it.
    // Called from a click (iOS raises the keyboard only for a focus inside a user gesture),
    // on a button whose pointerdown was prevented so the tap itself moved no focus.
    keyboard(up = !h.focused) { if (up) h.focus(); else h.blur(); return h.focused; },
    get fontSize() { return term.options.fontSize; },
    setFont,
    zoom(d) { return setFont(term.options.fontSize + d); },
    // The key row. Called from a pointerdown that has already been prevented, so the focus
    // (and with it the on-screen keyboard) stays in the terminal.
    key(k, node) {
      if (k.latch) { mods[k.latch] = !mods[k.latch]; modNode[k.latch] = node; if (node) node.classList.toggle('on', mods[k.latch]); return; }
      const s = k.arrow ? arrow(k.arrow) : k.send;
      if (latched()) { sendText(modded(s, mods, k.arrow || '')); unlatch(); return; }
      sendText(s);
    },
    get ctrl() { return mods.ctrl; },
    get alt() { return mods.alt; },
    close() { try { if (ws) ws.close(1000, 'closed by the owner'); } catch {} },
    dispose() { h.close(); try { untouch(); } catch {} try { ro && ro.disconnect(); } catch {} try { term.dispose(); } catch {} },
  };
  return h;
}

// ── a finger as a mouse ──────────────────────────────────────────────────────────
// "tapping a file does not open it, a finger drag does not scroll". A phone's touches reach
// xterm as whatever the browser makes of them — a native pan of an element that has nothing
// to pan in the alternate screen, a tap that may or may not grow a compatibility mouse event,
// and iOS's own double-tap and long-press — so an app that asked for the mouse (nvim and
// LazyVim with mouse=a) heard almost none of it. Here the touches are taken whole and turned
// into the mouse events a desk would have produced, handed to xterm itself:
//   a tap          a click at that cell (two quick taps are two clicks, which nvim counts
//                  as a double click: it is what opens an explorer entry)
//   a vertical drag  the wheel, a pixel at a time, so it scrolls nvim, less, the shell's
//                  scrollback — whatever the desk's wheel scrolls in that mode
//   a long press   the button held: dragging from there is a mouse drag, which nvim makes a
//                  visual selection of (and the editor tab's copy-on-select, #74, copies on
//                  release); with no app holding the mouse it is xterm's own selection, which
//                  is copied to this device's clipboard
//   two fingers    a pinch, which is the font size — and so the column count
// HANDED TO XTERM, NOT ENCODED HERE. xterm already knows which mouse protocol the app asked
// for and in which encoding (SGR, or the old byte form), and whether there is one at all; a
// synthetic MouseEvent goes through the same path a real one does, so nothing here has to
// keep a second copy of that state in step with the first.
// TOUCH EVENTS ONLY, so a mouse — the desk's, or a trackpad on an iPad — never comes here.
// And prevented on touchstart, which is what stops the browser's own pan, zoom, callout and
// compatibility mouse events from arriving as well and clicking twice.
// THE FOCUS IS THE KEYBOARD'S BUTTON'S ALONE. xterm focuses its textarea on every mousedown,
// which on a phone raises the keyboard over half the screen at every tap on a file. So for
// the synthetic events the textarea's focus() is a no-op: a tap clicks, and the keyboard
// stays exactly as it was.
const LONG_MS = 450, SLOP = 10, TWICE_MS = 400;
function touchAsMouse(term, host, { setFont, onCopy }) {
  const el = term.element;
  if (!el) return () => {};
  const quiet = (fn) => {
    const ta = term.textarea;
    if (!ta || document.activeElement === ta) return fn();
    ta.focus = () => {};
    try { return fn(); } finally { delete ta.focus; }
  };
  const under = (x, y) => { const n = document.elementFromPoint(x, y); return n && el.contains(n) ? n : el; };
  const mouse = (type, x, y, buttons, detail = 1) => quiet(() => under(x, y).dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
    button: 0, buttons, detail })));
  const wheel = (x, y, dy) => under(x, y).dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, deltaY: dy, deltaMode: 0 }));
  const gap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  let g = null;                            // the gesture in hand
  let last = { at: 0, x: 0, y: 0, n: 0 };  // the previous tap, for the click count
  const endSelect = (x, y) => {
    mouse('mouseup', x, y, 0);
    // An app that holds the mouse made the selection itself (nvim's visual mode), and copies
    // it itself; only xterm's own selection is ours to copy.
    if (term.modes.mouseTrackingMode === 'none' && term.hasSelection()) {
      const text = term.getSelection();
      try { navigator.clipboard.writeText(text).then(() => onCopy(text), () => {}); } catch {}
    }
  };
  const start = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const t = ev.touches;
    if (t.length >= 2) {
      if (g && g.timer) clearTimeout(g.timer);
      if (g && g.mode === 'select') endSelect(g.x, g.y);
      g = { mode: 'pinch', d0: gap(t) || 1, f0: term.options.fontSize };
      return;
    }
    if (g) return;                         // a second finger lifted and put back: ignored
    const p = t[0];
    g = { mode: 'pending', x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY, y1: p.clientY, timer: 0 };
    g.timer = setTimeout(() => {
      if (!g || g.mode !== 'pending') return;
      g.mode = 'select';
      mouse('mousedown', g.x0, g.y0, 1);
      if (g.x !== g.x0 || g.y !== g.y0) mouse('mousemove', g.x, g.y, 1);
    }, LONG_MS);
  };
  const move = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (!g) return;
    const t = ev.touches;
    if (g.mode === 'pinch') {
      if (t.length >= 2) setFont(g.f0 * gap(t) / g.d0);
      return;
    }
    const p = t[0];
    if (!p) return;
    g.x = p.clientX; g.y = p.clientY;
    if (g.mode === 'pending' && Math.hypot(g.x - g.x0, g.y - g.y0) > SLOP) {
      clearTimeout(g.timer);
      // Mostly sideways is nothing yet: the brief is a vertical drag, and a sideways one that
      // scrolled would scroll the reader off the line they were following.
      g.mode = Math.abs(g.y - g.y0) >= Math.abs(g.x - g.x0) ? 'scroll' : 'aside';
    }
    if (g.mode === 'scroll') { const dy = g.y1 - g.y; g.y1 = g.y; if (dy) wheel(g.x, g.y, dy); }
    else if (g.mode === 'select') mouse('mousemove', g.x, g.y, 1);
  };
  const end = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (!g || ev.touches.length) return;   // fingers still down: the gesture is not over
    clearTimeout(g.timer);
    if (g.mode === 'select') endSelect(g.x, g.y);
    else if (g.mode === 'pending' && ev.type === 'touchend') {
      const now = Date.now();
      const n = now - last.at < TWICE_MS && Math.hypot(g.x0 - last.x, g.y0 - last.y) < 2 * SLOP ? last.n + 1 : 1;
      last = { at: now, x: g.x0, y: g.y0, n };
      mouse('mousedown', g.x0, g.y0, 1, n);
      mouse('mouseup', g.x0, g.y0, 0, n);
    }
    g = null;
  };
  const opt = { capture: true, passive: false };
  host.addEventListener('touchstart', start, opt);
  host.addEventListener('touchmove', move, opt);
  host.addEventListener('touchend', end, opt);
  host.addEventListener('touchcancel', end, opt);
  return () => {
    for (const [n, f] of [['touchstart', start], ['touchmove', move], ['touchend', end], ['touchcancel', end]])
      host.removeEventListener(n, f, opt);
  };
}
