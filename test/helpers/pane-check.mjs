#!/usr/bin/env node
// test/helpers/pane-check.mjs — the pane renderer, against real captured panes.
//
//     node test/helpers/pane-check.mjs        # one "name <US> want <US> got" row per check
//
// web/ansi.js is the only ANSI parser in the repo and the session screen's default view
// depends on it, so what it gets wrong is what a phone shows instead of a terminal. Every
// check here runs against BYTES CAPTURED FROM A REAL PANE — test/fixtures/claude-*-sgr.txt
// are `tmux capture-pane -p -e` of a live Claude Code session mid-turn and of a live
// permission dialog. A hand-written escape sequence would only prove the parser handles
// what I thought to write, which is the failure mode CLAUDE.md keeps warning about: a test
// that can only pass proves nothing.
//
// The assertions run in both directions on purpose, and the two that matter most are both
// negatives — a rule that never fires looks identical to one that works:
//
//   - bold must NOT become font-weight (it changes glyph advance and the grid comes
//     apart) but it must still CHANGE SOMETHING, or "we handled bold" is a no-op
//   - non-ASCII must be boxed, and ASCII must NOT be — boxing everything would pass a
//     naive "is it boxed" check while tripling the markup for nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
// JSON.stringify + process.stdout.write, NEVER console.log(value) — and that is a rule
// this repo has paid for twice (#44). console.log runs a non-string through util.inspect,
// which paints a bare number yellow when FORCE_COLOR is set, so a helper that answered `1`
// actually answered $'\033[33m1\033[39m' and its red line read "expected: 1 / got: 1" —
// two values that look identical and are not. run.sh unsets the variable now, but a helper
// that is only correct because the harness scrubbed its environment is one `export` away
// from lying, so the guard lives here too. Verified both ways for this file: forced colour
// and not produce byte-identical output.
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const A = await import(new URL('../../web/ansi.js', import.meta.url).href);
const G = await import(new URL('../../web/grid.js', import.meta.url).href);
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
const fx = (f) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', f), 'utf8');
const E = '\x1b';

// ── 1. the real panes ─────────────────────────────────────────────────────
// Both were captured with `capture-pane -p -e` from a pane whose tmux geometry was read
// at the same moment, so the renderer's own row/column count is checkable against what
// tmux said rather than against what the file happens to contain.
const WORKING = fx('claude-working-pane-sgr.txt');     // a session mid-turn, 269x65
const DIALOG = fx('claude-permission-dialog-sgr.txt'); // a live permission prompt, 100x30

const w = A.render(WORKING), d = A.render(DIALOG);
is('the working capture still has escapes', true, /\x1b\[/.test(WORKING));
is('the dialog capture still has escapes', true, /\x1b\[/.test(DIALOG));
is('the working pane measures 269 columns', 269, w.cols);
is('...and 65 rows', 65, w.rows);
is('the dialog pane measures 100 columns', 100, d.cols);
is('...and 30 rows', 30, d.rows);
// The rendered markup has exactly as many rows as the pane, because a <pre> renders one
// row per newline and a miscount is a blank row at the end or a missing one.
is('the markup has one row per pane row', 65, w.html.split('\n').length);
is('...and so does the dialog', 30, d.html.split('\n').length);

// ── 2. no escape survives as text ─────────────────────────────────────────
// The failure this catches is the visible one: an escape the parser did not recognise
// printed as `[38;5;246m` in the middle of a sentence.
for (const [name, r] of [['working', w], ['dialog', d]]) {
  is(`no raw ESC reaches the ${name} markup`, false, r.html.includes('\x1b'));
  is(`no stray SGR text in the ${name} markup`, false, /\[\d+(;\d+)*m/.test(r.html));
}

// ── 3. bold, and the geometry it must not touch ───────────────────────────
// THE RULE, checked as a negative across every real capture: #40 measured the same
// 32-character line at 366px (weight 400) and 517px (weight 700), because the bold face
// has no box-drawing glyphs and ─ ╭ ╮ ╰ ╯ come from a wider fallback while │ does not.
// A pane is hundreds of columns of exactly those characters.
is('the working pane sets no font-weight', false, /font-weight/.test(w.html));
is('the dialog sets no font-weight', false, /font-weight/.test(d.html));
is('...nor `bold` anywhere in the markup', false, /bold/i.test(w.html + d.html));
// The other direction. Both captures really do contain SGR 1 — assert that, so this pair
// cannot pass by the fixtures having no bold in them — and assert bold changes the colour.
is('the working capture really contains SGR 1', true, WORKING.includes(`${E}[1m`));
is('the dialog capture really contains SGR 1', true, DIALOG.includes(`${E}[1m`));
{
  const plain = A.render('X\n').html;
  const bold = A.render(`${E}[1mX${E}[0m\n`).html;
  is('bold changes something', true, plain !== bold);
  is('...and what it changes is the colour', true, /^<span style="color:#[0-9a-f]{6}">X<\/span>$/.test(bold));
  // An indexed colour has a real bright twin: 31 is xterm 1, and bold makes it xterm 9.
  const red = A.render(`${E}[31mX${E}[0m\n`).html;
  const boldRed = A.render(`${E}[31m${E}[1mX${E}[0m\n`).html;
  is('bold on an indexed colour brightens it', true, red !== boldRed);
  is('...to the palette bright twin', true, boldRed.includes('#ff8787'));
  // ...and dim goes the other way, or "we handled 2m" would be satisfied by ignoring it.
  is('dim changes the colour too', true, A.render(`${E}[2mX${E}[0m\n`).html !== plain);
}

// ── 4. one cell per cell ──────────────────────────────────────────────────
// grid.js's cells() is the split and app.css is the box; this asserts the renderer USES
// them, in both directions, because boxing everything would satisfy a naive check while
// tripling the markup, and boxing nothing is the bug.
is('the pane boxes at 1ch', true, /\.pane \.c \{[^}]*width: 1ch/.test(CSS));
is('...and a two-column cell at 2ch', true, /\.pane \.c\.w \{[^}]*width: 2ch/.test(CSS));
is('a box-drawing glyph is boxed', '<i class="c">─</i>', A.render('─').html);
is('...and ASCII is not', 'abc', A.render('abc').html);
is('a wide glyph gets the 2ch box', '<i class="c w">日</i>', A.render('日').html);
is('...and a narrow non-ASCII does not', '<i class="c">⧗</i>', A.render('⧗').html);
// The two glyphs that started all of this. Measured at 1.274 and 1.046 advances, so they
// are narrow in tmux's grid and must land in a ONE-cell box, not a two-cell one.
is('the limit glyph is one cell', '<i class="c">⧗</i>', A.render('⧗').html);
is('the pause glyph is one cell', '<i class="c">⏸</i>', A.render('⏸').html);
{
  // Across a whole real pane: every non-ASCII code point boxed, nothing ASCII boxed, and
  // no character lost. Counted from the source, so it cannot drift with the fixture.
  // Both escape families stripped, because this pane has both — see the OSC 8 check
  // below, which is why the first version of this assertion failed against the real
  // capture while the renderer was right.
  const text = WORKING.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
                      .replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, '');
  const nonAscii = [...text].filter(c => c.codePointAt(0) >= 0x80 && !G.isZeroWidth(c.codePointAt(0))).length;
  const boxes = (w.html.match(/<i class="c( w)?">/g) || []).length;
  is('every non-ASCII cell in a real pane is boxed', nonAscii, boxes);
  // Nothing dropped: strip the markup back out and the text must be what tmux gave us.
  const back = w.html.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  is('the renderer loses no character', text.replace(/\n$/, ''), back);
}

// ── 5. the state carries across a newline ─────────────────────────────────
// Observable in the real capture: a `[1m` sentence ends on one row and its `[0m` is the
// first thing on the next. A line-oriented renderer that resets per row — the obvious way
// to write this — drops the emphasis from the last row of every such paragraph, silently.
{
  const r = A.render(`${E}[1mone\ntwo${E}[0m\nthree\n`);
  const [l1, l2, l3] = r.html.split('\n');
  is('a run open at a newline stays open', true, /<span style="color:#[0-9a-f]{6}">one<\/span>/.test(l1));
  is('...on the NEXT row as well', true, /<span style="color:#[0-9a-f]{6}">two<\/span>/.test(l2));
  is('...and the reset on that row ends it', 'three', l3);
  // The span itself is closed at the newline even though the state is not: a background
  // that crosses a line break paints to the container edge instead of to the text.
  is('no span contains a newline', false, /<span[^>]*>[^<]*\n/.test(r.html));
}
// The real capture has exactly this shape in it, so the fixture is the proof and not the
// synthetic case above: `flipping it.` closes a bold run whose [0m is on the next row.
is('the real capture has a bold run crossing a row', true,
   /\x1b\[1m[^\x1b]*\n\x1b\[0m/.test(WORKING));

// ── 6. a worker can print anything, including markup ──────────────────────
// This text goes through innerHTML. An agent working on a web app prints tags all day.
{
  const r = A.render('<script>alert(1)</script> & "q" \'p\'\n');
  is('a tag is escaped', false, /<script/.test(r.html));
  is('...as an entity', true, r.html.includes('&lt;script&gt;'));
  is('an ampersand is escaped', true, r.html.includes('&amp;'));
  is('a quote is escaped', true, r.html.includes('&quot;'));
  is('...and an apostrophe', true, r.html.includes('&#39;'));
  // The only attribute this file emits is a style it computed itself, so nothing from the
  // pane can reach one. Asserted as a property of the output over a real pane: every
  // style attribute is CSS declarations and nothing else.
  const attrs = [...(w.html + d.html).matchAll(/style="([^"]*)"/g)].map(m => m[1]);
  is('there are style attributes to check', true, attrs.length > 10);
  is('every style attribute is only declarations', '',
     attrs.filter(a => !/^([a-z-]+:[^;]+)(;[a-z-]+:[^;]+)*$/.test(a)).join(' | '));
}
// A pane that prints an escape-looking string as TEXT must not be parsed as one: the ESC
// byte is what makes it a sequence, and a bare `[31m` in prose is prose.
is('a bare CSI-looking string is text', '[31mnot a colour', A.render('[31mnot a colour').html);

// ── 6b. the OSC 8 hyperlink the real pane actually contains ───────────────
// Found by this suite rather than designed for: the working capture's status line ends
// `PR ESC]8;id=…;https://github.com/…/pull/1165 ESC\ #1165 ESC]8;; ESC\`, which is Claude
// Code emitting a terminal hyperlink. The URL is a PARAMETER of the escape and the `#1165`
// between the two halves is the text — so dropping the sequence must keep the label and
// lose the address, or the status line grows a 60-character URL that is not on screen at
// the desk. (The first cut of the "loses no character" check above stripped only CSI and
// so expected the URL to survive; the renderer was right and the check was wrong.)
is('the capture really has an OSC 8 link', true, /\x1b\]8;id=/.test(WORKING));
is('the link label survives', true, w.html.includes('#1165'));
is('...and the URL does not print', false, w.html.includes('github.com'));

// ── 7. the escapes that are not colours ───────────────────────────────────
// tmux hands over a grid it has already laid out, so cursor movement and erasure are
// answers to questions that have been asked. Dropped — but their surrounding text is not,
// and a parser that mis-measures a sequence's length eats the character after it.
is('cursor moves are dropped, text is kept', 'abcd', A.render(`a${E}[2Kb${E}[Hc${E}[Jd`).html);
is('an OSC title is dropped whole', 'kept', A.render(`${E}]0;a title\x07kept`).html);
is('...terminated by ST as well', 'kept', A.render(`${E}]0;a title${E}\\kept`).html);
is('a two-byte escape is dropped', 'ab', A.render(`a${E}(Bb`).html);
is('an unterminated CSI eats no text', 'a', A.render(`a${E}[38;5;`).html);
// 58 sets the UNDERLINE colour and carries the same extended payload as 38/48. Not
// consuming its arguments would leave `5;9` to be read as SGR 5 then SGR 9, and the 31
// after it would be the third parameter of nothing — so the run comes out the wrong
// colour, from a sequence that has nothing to do with colour.
is('58 consumes its own arguments', true, A.render(`${E}[58;5;9;31mX${E}[0m`).html.includes('#ff5f5f'));
is('...and 48 still sets a background', true, A.render(`${E}[48;5;237mX${E}[0m`).html.includes('background:'));

// ── 8. reverse video, which the ❯ prompt and a selected row are drawn with ─
{
  const r = A.render(`${E}[7mX${E}[27m`).html;
  is('reverse with defaults swaps them', true, /color:#0b0d10/.test(r) && /background:#c9d1d9/.test(r));
  is('...and 27 turns it off', 'Y', A.render(`${E}[7m${E}[27mY`).html);
  // The two defaults have to be app.css's, or reverse paints the page's background as a
  // foreground it does not have. Checked against the stylesheet, not against memory.
  const hex = (v) => '#' + v.map(n => n.toString(16).padStart(2, '0')).join('');
  is('the default fg matches the stylesheet', true, CSS.includes(`--fg: ${hex(A.DEFAULT_FG)}`));
  is('the default bg matches the stylesheet', true, CSS.includes(`--bg: ${hex(A.DEFAULT_BG)}`));
}

// ── 9. the dialog is legible, which is the whole point ────────────────────
// The payoff docs/mobile.md §7 names: `answer keys` was on this screen already and close
// to useless, because you could not see what you were answering. So the question the pane
// view has to answer is whether a real dialog SURVIVES the render as readable text with
// its numbered choices — checked on the markup, after all the escaping and boxing.
{
  const text = d.html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  is('the dialog question survives', true, text.includes('Do you want to create hello.txt?'));
  is('choice 1 survives', true, /1\. Yes/.test(text));
  is('choice 3 survives', true, /3\. No/.test(text));
  is('the cancel hint survives', true, text.includes('Esc to cancel'));
  is('the tool header survives', true, text.includes('Write(hello.txt)'));
  // ...and the ⏺/❯ glyphs that tell a tool call from prose are boxed rather than dropped.
  is('the selection caret is rendered', true, d.html.includes('<i class="c">❯</i>'));
  is('the bullet glyph is rendered', true, d.html.includes('<i class="c">⏺</i>'));
}
// The working pane's commands, which is the sentence that started this: "i can't see the
// commands that is running". A tool line and a shell command, both present.
{
  const text = w.html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  is('a tool line survives the render', true, /Ran \d+ shell command/.test(text));
  is('a shell command survives the render', true, text.includes("git log -S 'match\") === \"fuzzy\"'"));
  is('a tool-result marker survives', true, w.html.includes('<i class="c">⎿</i>'));
}

// ── 10. degenerate input ──────────────────────────────────────────────────
is('empty text renders nothing', '', A.render('').html);
is('...and counts no rows', 0, A.render('').rows);
is('null renders nothing', '', A.render(null).html);
is('a lone newline is one row', 1, A.render('\n').rows);
is('ESC[m is a full reset', 'b', A.render(`${E}[31ma${E}[mb`).html.split('</span>')[1]);

process.stdout.write(rows.join('\n') + '\n');
