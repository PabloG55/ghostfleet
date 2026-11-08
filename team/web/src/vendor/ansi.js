// web/ansi.js — the session's real pane, as HTML.
//
// The phone used to render a session as a tidy message list, and the first person to use
// it said the thing that made this file necessary: "it doesn't look like a normal chat
// and I can't see the commands that is running." Both halves were true and they had one
// cause. /api/session goes through `fleet-read --json`, which emits {ts, role, text} —
// assistant and user PROSE. Tool calls, the commands inside them and their results are
// not in that payload at all, so no amount of client work could have shown them: the
// data was never there. Pressing ⏎ on a card at the desk attaches to the tmux pane and
// you get the Claude Code TUI — ⏺ bullets, ⎿ tool results, the spinner, the permission
// dialog. "Exactly as the computer version" IS that pane, and CLAUDE.md already says why
// it has to be captured rather than rebuilt: THE PANE IS THE TRUTH. Every status
// detector in this repo reads it for the same reason — a reconstruction drifts.
//
// So: /api/pane returns `capture-pane -p -e`, escapes and all, and this file turns the
// escapes into HTML. It is the only ANSI parser in the repo and it is deliberately one
// file, pure, and stringly: render() takes text and returns HTML, touching no DOM. That
// is not stylistic. The pane is repainted every couple of seconds, so one innerHTML
// assignment beats rebuilding thousands of nodes — and a pure string function can be
// tested in node with no DOM at all, which is how the escaping below is proven against
// a pane that prints `<script>`.
//
// ── the two rules this file exists to keep ────────────────────────────────
//
// 1. BOLD IS NEVER font-weight. Learned the expensive way in #40 and written into
//    app.css: the bold face has no box-drawing glyphs, so ─ ╭ ╮ ╰ ╯ fall back to a
//    wider font while │ and the letters do not. Measured in Chrome at 19px, the same
//    32-character line went 366px at weight 400 and 517px at weight 700. A pane is
//    ~269 columns of box rules and dialog borders; at that width the drift is not a
//    ragged edge, it is a different picture. SGR 1 therefore does what a terminal has
//    always done underneath the name — it BRIGHTENS the foreground (brighten(), below).
//    Same for dim: darker, not lighter-weight.
//
// 2. ONE CELL PER CELL. grid.js's cells() splits a line into ASCII runs and single
//    non-ASCII code points; app.css boxes each of the latter at exactly 1ch (2ch when
//    tmux gave it two columns). ⧗ measures 1.274 advances and ⏸ 1.046 in every
//    monospace face on this machine, and in a character grid a glyph that is not
//    exactly one cell shifts everything after it on the line. On a card that cost a
//    right border; in a permission dialog it is the border walking out of the box.
//
// What this file does NOT do: cursor movement, scroll regions, line wrapping, or any
// other terminal emulation. capture-pane hands over a grid that tmux has already laid
// out — the work is done, and re-doing it here would be a second answer to "what does
// this pane look like" competing with the one that has the scars. Non-SGR escapes are
// consumed and dropped rather than interpreted, which is the honest treatment: they say
// where a cursor went, and there is no cursor here.
import { cells, cellWidth } from './grid.js';

// ── the palette ───────────────────────────────────────────────────────────
// xterm-256, because that is what the pane emits: measured over a real capture of a
// working session, every colour was either a 30-37/39 basic or a 38;5;N index (246 for
// the dim tool lines, 231 for the ⏺ bullets, 153 and 37 for filenames and rules). The
// 24-bit form is handled too because a differently-configured agent can emit it, not
// because anything here was seen to.
//
// The low 16 are the only judgement call in the file — they are whatever the terminal
// was configured to be, and the pane does not say. These are a standard dark set,
// picked to sit on app.css's #0b0d10 background, so the phone reads like the terminal
// the grid lives in rather than like a web page that happens to have colours.
const BASE16 = [
  [0x0b, 0x0d, 0x10], [0xff, 0x5f, 0x5f], [0x87, 0xd7, 0x87], [0xd7, 0xaf, 0x5f],
  [0x5f, 0xaf, 0xd7], [0xaf, 0x87, 0xd7], [0x5f, 0xd7, 0xd7], [0xc9, 0xd1, 0xd9],
  [0x5c, 0x63, 0x70], [0xff, 0x87, 0x87], [0xaf, 0xff, 0xaf], [0xff, 0xd7, 0x5f],
  [0x87, 0xd7, 0xff], [0xd7, 0xaf, 0xff], [0x87, 0xff, 0xff], [0xff, 0xff, 0xff],
];
const PALETTE = (() => {
  const p = BASE16.slice();
  const L = [0, 95, 135, 175, 215, 255];                     // xterm's own cube levels
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
    p.push([L[r], L[g], L[b]]);
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; p.push([v, v, v]); }
  return p;                                                   // 16 + 216 + 24 = 256
})();
// The page's own two, so `reverse` and `conceal` have something concrete to swap in.
// Kept in step with app.css's --fg/--bg by an assertion, not by memory.
export const DEFAULT_FG = [0xc9, 0xd1, 0xd9];
export const DEFAULT_BG = [0x0b, 0x0d, 0x10];

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// SGR 1, without touching the geometry. A terminal's "bold" has always been two things
// at once — a heavier face where one exists, and the bright half of the palette — and
// only the second is safe in a character grid, so the second is what this is. An indexed
// colour has a real bright twin (0-7 → 8-15); anything else is lifted toward white,
// which is the same gesture without a table to look it up in.
function brighten(spec, rgb) {
  if (spec && spec.i !== undefined && spec.i < 8) return PALETTE[spec.i + 8];
  if (spec && spec.i !== undefined && spec.i >= 8 && spec.i < 16) return PALETTE[spec.i];
  return mix(rgb, [255, 255, 255], 0.32);
}
// SGR 2, likewise: toward the background, which is what "faint" means on a terminal.
const faint = (rgb) => mix(rgb, DEFAULT_BG, 0.42);

// ── state ─────────────────────────────────────────────────────────────────
// `fg`/`bg` are null for "the default", {i} for a palette index, {rgb} for 24-bit. The
// distinction is kept rather than resolved on the spot precisely so that brighten() can
// use the bright twin of an INDEX, and so that "default" survives a reverse.
const fresh = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false,
                       under: false, strike: false, reverse: false, conceal: false });

function rgbOf(spec, dflt) {
  if (!spec) return dflt;
  if (spec.rgb) return spec.rgb;
  return PALETTE[spec.i] || dflt;
}

// The CSS one run of identical attributes needs — and nothing when it needs none, which
// is most of a pane and is why this returns '' rather than a full declaration every time.
function styleOf(s) {
  let fgSpec = s.fg, bgSpec = s.bg;
  if (s.reverse) {
    // Reverse with defaults is the case that has to work: the ❯ prompt line and a
    // selected menu row are drawn that way, and swapping two nulls would be a no-op.
    const t = fgSpec; fgSpec = bgSpec || { rgb: DEFAULT_BG }; bgSpec = t || { rgb: DEFAULT_FG };
  }
  if (s.conceal) fgSpec = bgSpec || { rgb: DEFAULT_BG };
  let fg = rgbOf(fgSpec, DEFAULT_FG);
  if (s.bold) fg = brighten(fgSpec, fg);
  if (s.dim) fg = faint(fg);

  const out = [];
  // Emitted only when it differs from what the page already paints, so an unstyled pane
  // produces no spans at all.
  const fgHex = hex(fg);
  if (fgHex !== hex(DEFAULT_FG)) out.push('color:' + fgHex);
  if (bgSpec) out.push('background:' + hex(rgbOf(bgSpec, DEFAULT_BG)));
  if (s.italic) out.push('font-style:italic');
  const deco = [];
  if (s.under) deco.push('underline');
  if (s.strike) deco.push('line-through');
  if (deco.length) out.push('text-decoration:' + deco.join(' '));
  return out.join(';');
}

// ── SGR ───────────────────────────────────────────────────────────────────
// The extended-colour forms. `38;5;N` and `38;2;R;G;B` are what tmux emits; the
// colon-delimited T.416 spelling (`38:5:N`) is accepted because some agents use it and
// the cost of tolerating it is four lines. Returns how many parameters were consumed, so
// an unrecognised trailer cannot make the NEXT parameter be read as a colour — the
// failure that turns one stray sequence into a whole line of wrong colours.
function extended(parts, i) {
  const mode = Number(parts[i + 1]);
  if (mode === 5) return { spec: { i: Math.max(0, Math.min(255, Number(parts[i + 2]) || 0)) }, used: 3 };
  if (mode === 2) return { spec: { rgb: [Number(parts[i + 2]) || 0, Number(parts[i + 3]) || 0, Number(parts[i + 4]) || 0] }, used: 5 };
  return { spec: null, used: 2 };
}
function subSpec(tok) {                       // '38:5:246' / '48:2:1:2:3' / '38:2::1:2:3'
  const parts = tok.split(':').map(x => (x === '' ? NaN : Number(x)));
  if (parts[1] === 5) return { i: Math.max(0, Math.min(255, parts[2] || 0)) };
  if (parts[1] === 2) { const t = parts.slice(-3).map(x => x || 0); return { rgb: t }; }
  return null;
}

function applySGR(params, s) {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (tok.includes(':')) {                  // a self-contained colon-form parameter
      const base = Number(tok.split(':')[0]);
      if (base === 38) s.fg = subSpec(tok);
      else if (base === 48) s.bg = subSpec(tok);
      else if (base === 4) s.under = true;    // 4:0 is "off", but 4:0 is also vanishingly rare
      continue;
    }
    const n = tok === '' ? 0 : Number(tok);
    if (!Number.isFinite(n)) continue;
    if (n === 0) { Object.assign(s, fresh()); continue; }
    if (n === 1) { s.bold = true; continue; }
    if (n === 2) { s.dim = true; continue; }
    if (n === 3) { s.italic = true; continue; }
    if (n === 4 || n === 21) { s.under = true; continue; }   // 21 is double-underline here
    if (n === 7) { s.reverse = true; continue; }
    if (n === 8) { s.conceal = true; continue; }
    if (n === 9) { s.strike = true; continue; }
    if (n === 22) { s.bold = false; s.dim = false; continue; }
    if (n === 23) { s.italic = false; continue; }
    if (n === 24) { s.under = false; continue; }
    if (n === 27) { s.reverse = false; continue; }
    if (n === 28) { s.conceal = false; continue; }
    if (n === 29) { s.strike = false; continue; }
    if (n >= 30 && n <= 37) { s.fg = { i: n - 30 }; continue; }
    if (n === 38) { const e = extended(parts, i); s.fg = e.spec; i += e.used - 1; continue; }
    if (n === 39) { s.fg = null; continue; }
    if (n >= 40 && n <= 47) { s.bg = { i: n - 40 }; continue; }
    if (n === 48) { const e = extended(parts, i); s.bg = e.spec; i += e.used - 1; continue; }
    if (n === 49) { s.bg = null; continue; }
    // 58/59 set the UNDERLINE colour and carry the same extended payload. Consumed and
    // dropped: not rendering it is cosmetic, but failing to consume its arguments would
    // leave `5;246` to be read as blink-then-nothing, and the run after it wrong.
    if (n === 58) { const e = extended(parts, i); i += e.used - 1; continue; }
    if (n >= 90 && n <= 97) { s.fg = { i: n - 90 + 8 }; continue; }
    if (n >= 100 && n <= 107) { s.bg = { i: n - 100 + 8 }; continue; }
    // 5/6 blink, 25 blink off, 53/55 overline, everything else: ignored on purpose. A
    // blinking pane in a pocket is noise, not information.
  }
}

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// A worker can print anything, including `<script>`, and this string goes through
// innerHTML. Escaped here, once, on the only path text takes into the output — style
// attributes are built from numbers this file computed and never from pane text, so
// there is no second place for content to reach markup.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESCAPE[c]);

// One cell per cell (rule 2 at the top). `class="c"` is app.css's 1ch box and `c w` its
// 2ch one; ASCII needs neither, because ASCII is one advance in any monospace face.
function cellHtml(text) {
  let out = '';
  for (const tok of cells(text)) {
    if (!tok.cell) { out += esc(tok.text); continue; }
    out += `<i class="c${tok.wide ? ' w' : ''}">${esc(tok.text)}</i>`;
  }
  return out;
}

// ── render ────────────────────────────────────────────────────────────────
// Returns the HTML, plus the geometry the client needs to size and label the view.
//
// THE ATTRIBUTE STATE CARRIES ACROSS A NEWLINE, and that is not a detail — it is
// observable in a real capture. From a working session, verbatim:
//
//     …I removed the comparison rather than flipping it.\n\x1b[0m
//
// The `\x1b[1m` that opened that sentence is on the line before, and the reset that
// closes it is the first thing on the next one. Resetting per line — the obvious way to
// write a line-oriented renderer — would drop the bold from the last line of every
// paragraph Claude emphasises, and there is nothing on screen to suggest why. So the
// state lives outside the loop; only the SPAN is closed at a newline, because a span
// carrying a background across a line break paints that background to the edge of the
// container instead of to the end of the text.
export function render(text) {
  const src = String(text == null ? '' : text);
  const s = fresh();
  let out = '';
  let open = '';                 // the style currently inside a <span>, '' when none
  let row = '';                  // the current row's text, for the width measurement
  let rows = 1, cols = 0;
  const closeSpan = () => { if (open) { out += '</span>'; open = ''; } };

  for (let i = 0; i < src.length;) {
    const ch = src[i];

    if (ch === '\x1b') {
      const next = src[i + 1];
      if (next === '[') {
        // CSI: parameter bytes 0x30-0x3f and intermediates 0x20-0x2f, then a final byte.
        let j = i + 2;
        while (j < src.length) { const c = src.charCodeAt(j); if (c >= 0x20 && c <= 0x3f) j++; else break; }
        const final = src[j];
        if (final === 'm') applySGR(src.slice(i + 2, j), s);
        // Every other final byte is cursor movement, erasure or a mode change. tmux has
        // already applied all of that to the grid it just handed us.
        i = j >= src.length ? src.length : j + 1;
        continue;
      }
      if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        // OSC and friends run to a BEL or a String Terminator. A title-setting OSC in a
        // pane is common (it is how the tab name is set) and its payload is arbitrary
        // text — dropped whole, or it would print as prose.
        let j = i + 2;
        while (j < src.length && src[j] !== '\x07' && !(src[j] === '\x1b' && src[j + 1] === '\\')) j++;
        i = j >= src.length ? src.length : (src[j] === '\x07' ? j + 1 : j + 2);
        continue;
      }
      // Everything else is a two- or three-byte escape with no payload. THREE when the
       // byte after ESC is an intermediate (0x20-0x2f), because an nF sequence is
       // ESC + intermediate + final: `ESC ( B` selects the ASCII charset and is three
       // bytes, so consuming two left its `B` to print as a stray capital letter in the
       // middle of the pane. Caught by pane-check.mjs, which is why that assertion is
       // written as the text either side of the escape rather than as "it was dropped".
      if (next >= ' ' && next <= '/') {
        let j = i + 1;
        while (j < src.length && src[j] >= ' ' && src[j] <= '/') j++;
        i = j >= src.length ? src.length : j + 1;
        continue;
      }
      i += 2;                    // ESC = , ESC > , ESC 7 … two bytes
      continue;
    }

    if (ch === '\n') {
      closeSpan();
      out += '\n';
      cols = Math.max(cols, cellWidth(row));
      row = ''; rows++;
      i++;
      continue;
    }
    if (ch === '\r') { i++; continue; }

    // A run of ordinary characters, up to the next escape or newline, styled once.
    let j = i;
    while (j < src.length && src[j] !== '\x1b' && src[j] !== '\n' && src[j] !== '\r') j++;
    const chunk = src.slice(i, j);
    const want = styleOf(s);
    if (want !== open) { closeSpan(); if (want) { out += `<span style="${want}">`; open = want; } }
    out += cellHtml(chunk);
    row += chunk;
    i = j;
  }
  closeSpan();
  cols = Math.max(cols, cellWidth(row));
  // capture-pane ends its last row with a newline, so the final empty row is an artefact
  // of the terminator rather than a row of the pane.
  // capture-pane terminates its last row with a newline. Both the row count and the
  // markup drop it: left in, the <pre> grows a phantom blank row at the bottom, which on
  // a scrolled-to-the-end pane reads as the agent having printed an empty line.
  if (src.endsWith('\n')) { rows--; out = out.replace(/\n$/, ''); }
  return { html: out, rows: src ? Math.max(rows, 0) : 0, cols };
}
