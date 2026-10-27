#!/usr/bin/env node
// test/helpers/sgr-at.mjs — what does the terminal draw at a piece of text?
//
//     tmux capture-pane -e -p -t d | node sgr-at.mjs '<needle>' [offset]
//     -> e.g. `bold+rev`, `dim`, `plain` for the character `offset` (default 0) into
//        the first occurrence of <needle>; `absent` when the needle is not on screen
//
// So a suite row can ask "is this card dimmed" or "are these letters reversed" about the
// SCREEN, not about the bytes. The bytes are not stable: tmux re-serialises every colour
// change on capture, and 3.4 and 3.7b do not write the same sequence for the same cell
// (one folds bold into `1;7m`, another repeats it after a `0;`), so a grep for an escape
// sequence pins the tmux version rather than the grid. Tracking the attributes cell by
// cell is the same answer on every version, because it is what the terminal itself does.
const [needle = '', off = '0'] = process.argv.slice(2);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

const at = [];            // per character of `text`: its attribute set
let text = '', bold = false, dim = false, rev = false;
const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|([^\x1b]+)/g;
let m;
while ((m = re.exec(raw))) {
  if (m[2] != null) {
    for (const ch of m[2]) { text += ch; for (let i = 0; i < ch.length; i++) at.push({ bold, dim, rev }); }
    continue;
  }
  if (m[1] == null) continue;                   // a non-colour CSI: draws nothing
  const ps = m[1] === '' ? [0] : m[1].split(';').map(Number);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === 0) { bold = dim = rev = false; }
    else if (p === 1) bold = true;
    else if (p === 2) dim = true;
    else if (p === 22) bold = dim = false;
    else if (p === 7) rev = true;
    else if (p === 27) rev = false;
    else if (p === 38 || p === 48) i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0;
  }
}
const i = text.indexOf(needle);
if (!needle || i < 0) { console.log('absent'); process.exit(0); }
const a = at[i + [...needle].slice(0, Number(off)).join('').length];
if (!a) { console.log('absent'); process.exit(0); }
console.log([a.bold && 'bold', a.dim && 'dim', a.rev && 'rev'].filter(Boolean).join('+') || 'plain');
