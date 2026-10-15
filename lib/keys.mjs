// lib/keys.mjs — one stdin read is not one key.
//
// Every screen in fleet-grid.mjs was written as if a 'data' chunk held exactly one
// keypress or one mouse report, and compared the whole chunk: `key === 'q'`, or a mouse
// regex anchored at both ends. That holds only while the event loop is idle. A grid
// refresh is synchronous tmux work — measured at 600-1500ms per pass on a 21-session
// fleet, against a 1200ms interval, so the loop is blocked about half the time — and
// whatever the terminal sends during a block is read back as ONE chunk. A click is a
// press and a release ~100ms apart, so a click that lands in a block arrives as
// "\e[<0;10;11M\e[<0;10;11m", matches nothing, and is swallowed as junk: the owner's
// "sometimes I have to click multiple times". The same goes for an arrow and ⏎ typed
// together, or a report the terminal wrote in two pieces.
//
// So input is split into events BEFORE any handler sees it:
//   - a CSI sequence (arrows, SGR mouse reports, ⇧-tab …) is one event
//   - an SS3 sequence (application-mode arrows, ESC O A) is one event
//   - every control character (⏎, DEL, ^C, ^F, a lone ESC) is one event
//   - a run of printable text stays ONE event. A paste arrives as a run and the text
//     boxes take it whole; and on the grid, where every letter is a command, a pasted
//     run is ignored rather than replayed as keystrokes — a paste holding `x` and then
//     `y` must not become "remove that worktree? yes".
// An escape sequence cut off at the end of a read is held until the next one. A lone
// ESC looks exactly like the start of a sequence, so it is held too, and dispatched as
// the Esc key only if nothing follows it within `wait` ms. A cut-off `ESC [ …` gets the
// longer `partialWait`: nobody types that by hand, so the only cost of waiting is on a
// terminal that never finishes its sequence — while flushing it early splits a click
// into a fragment and a run of text and loses it, which is the bug this file exists for.

// ESC [ params intermediates final  |  ESC O letter  |  ESC  |  one control char  |  text
const TOKEN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1bO[A-Za-z]|\x1b|[\x00-\x1f\x7f]|[^\x00-\x1f\x7f]+/g;
// An escape sequence that has not reached its final byte yet: it ends the buffer.
const PARTIAL = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*|O)?$/;

// Split `buf` into whole events. `rest` is an incomplete escape sequence at the very end
// (a lone ESC included) for the caller to prepend to the next read — or to flush as-is
// once it is clear nothing more is coming.
export function splitKeys(buf) {
  let s = String(buf ?? ''), rest = '';
  const m = PARTIAL.exec(s);
  if (m) { rest = m[0]; s = s.slice(0, m.index); }
  return { keys: s.match(TOKEN) || [], rest };
}

// A 'data' listener that feeds `handler` one event at a time.
//
// The flush of a held tail goes through setImmediate, not straight from the timer. After
// a stall the timer has long expired, and node runs expired timers BEFORE it polls for
// I/O — so a timer that dispatched directly would fire while the second half of the
// sequence sat unread in the tty buffer, and hand the screen a bare ESC followed by
// "[<0;10;11M" as text. setImmediate runs after the poll phase: by then any pending
// bytes have been read and appended, and the tail is no longer a tail.
export function keyReader(handler, { wait = 40, partialWait = 500 } = {}) {
  let held = '', timer = null, gen = 0;
  // `gen` retires a flush that was already queued when more input arrived: that input
  // took the held tail with it.
  const flush = (g) => {
    if (g !== gen || !held) return;
    const k = held; held = '';
    handler(k);
  };
  return function onData(chunk) {
    if (timer) { clearTimeout(timer); timer = null; }
    gen++;
    const { keys, rest } = splitKeys(held + String(chunk));
    held = rest;
    for (const k of keys) handler(k);
    if (held) {
      const g = gen;
      timer = setTimeout(() => { timer = null; setImmediate(() => flush(g)); }, held === '\x1b' ? wait : partialWait);
    }
  };
}
