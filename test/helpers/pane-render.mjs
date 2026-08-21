#!/usr/bin/env node
// test/helpers/pane-render.mjs — render an /api/pane body the way the phone does.
//
//     curl … /api/pane | node pane-render.mjs
//     line 1:  <cols> <US> <rows>
//     line 2+: the pane as PLAIN TEXT, markup and entities undone
//
// So the suite can assert what a phone would actually SHOW, through web/ansi.js, instead
// of grepping the wire. The difference is not cosmetic and a real capture proves it: a
// Claude Code pane writes its filenames as OSC 8 hyperlinks, so the bytes on the wire read
//
//     ⏺ Write(ESC]8;id=…;file:///…/hello.txt ESC\ hello.txt ESC]8;; ESC\)
//
// and a grep for `Write(hello.txt)` finds nothing while the pane on screen says exactly
// that. Same for the dialog's own choices: `1. ` and `Yes` are separated by a colour
// change, so `grep '1. Yes'` fails on a pane that plainly reads "1. Yes". Both of those
// were assertions of mine that went red against a real pane while the code was right —
// which is the argument for rendering here rather than pattern-matching the transport.
import { render } from '../../web/ansi.js';

const US = '\x1f';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let pane = '';
try {
  const j = JSON.parse(raw);
  pane = typeof j === 'string' ? j : String(j.pane ?? '');
} catch (e) {
  process.stderr.write(`pane-render: stdin was not an /api/pane body: ${e.message}\n`);
  process.exit(1);
}

const r = render(pane);
// The markup back to text: the same inversion pane-check.mjs uses, so "what it shows" has
// one definition in the suite.
const text = r.html
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

// process.stdout.write of a template literal, not console.log of the numbers: console.log
// sends a non-string through util.inspect, which colourises under FORCE_COLOR, and a
// coloured `cols` would fail an assertion against "100" while printing as 100 (#44).
process.stdout.write(`${r.cols}${US}${r.rows}\n${text}\n`);
