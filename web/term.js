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

// The key row's keys, as bytes. Esc, Tab and the arrows are what a phone keyboard lacks;
// | ~ / - are what it buries a page deep. Ctrl is not a byte — it latches, and changes the
// next key typed (see ctrlOf).
export const KEYS = [
  { label: 'Esc', send: '\x1b' }, { label: 'Ctrl', ctrl: true }, { label: 'Tab', send: '\t' },
  { label: '←', send: '\x1b[D', arrow: 'D' }, { label: '↑', send: '\x1b[A', arrow: 'A' },
  { label: '↓', send: '\x1b[B', arrow: 'B' }, { label: '→', send: '\x1b[C', arrow: 'C' },
  { label: '|', send: '|' }, { label: '~', send: '~' }, { label: '/', send: '/' }, { label: '-', send: '-' },
];
// What Ctrl does to one typed character: the C0 control a hardware keyboard would send.
export function ctrlOf(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return ch;
  if (ch === ' ' || ch === '@' || ch === '2') return '\x00';
  if (ch === '?') return '\x7f';
  const c = ch.toUpperCase().charCodeAt(0);
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch;
}
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
export function mount(host, { onState = () => {}, onLeave = () => {}, fontSize = 13 } = {}) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize, scrollback: 5000, cursorBlink: true, theme: THEME,
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

  let ws = null, state = 'opening', ctrl = false, ctrlNode = null, why = '';
  const set = (s, w = '') => { state = s; why = w; onState({ state, why }); };
  const send = (bytes) => { if (ws && ws.readyState === 1) ws.send(bytes); };
  const sendText = (s) => send(utf8.encode(s));
  // The application cursor mode (DECCKM) decides whether an arrow is ESC [ A or ESC O A; a
  // key-row arrow follows it, so it does what the keyboard's own arrow would.
  const arrow = (k) => (term.modes && term.modes.applicationCursorKeysMode ? `\x1bO${k}` : `\x1b[${k}`);
  const unlatch = () => { ctrl = false; if (ctrlNode) ctrlNode.classList.toggle('on', false); };
  term.onData((d) => {
    if (ctrl && d.length === 1) { sendText(ctrlOf(d)); unlatch(); return; }
    sendText(d);
  });
  // Some mouse modes report bytes above 0x7f that are not UTF-8: sent as they are.
  term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));
  const resize = () => { try { fit.fit(); } catch {} };
  term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols, rows })); });
  let ro = null;
  try { ro = new ResizeObserver(() => resize()); ro.observe(host); } catch {}
  resize();

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
    // The key row. Called from a pointerdown that has already been prevented, so the focus
    // (and with it the on-screen keyboard) stays in the terminal.
    key(k, node) {
      if (k.ctrl) { ctrl = !ctrl; ctrlNode = node; if (node) node.classList.toggle('on', ctrl); return; }
      const s = k.arrow ? arrow(k.arrow) : k.send;
      if (ctrl && s.length === 1) { sendText(ctrlOf(s)); unlatch(); return; }
      sendText(s);
    },
    get ctrl() { return ctrl; },
    close() { try { if (ws) ws.close(1000, 'closed by the owner'); } catch {} },
    dispose() { h.close(); try { ro && ro.disconnect(); } catch {} try { term.dispose(); } catch {} },
  };
  return h;
}
