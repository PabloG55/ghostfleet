#!/usr/bin/env node
// Finds a tmux READ that does not pass -u, in the files named on the command line.
//
//     node tmux-read-sweep.mjs <file…>     prints each offender as file:line: text
//     node tmux-read-sweep.mjs --count <file…>     prints how many conforming reads it saw
//
// WHY -u. A tmux client that is not inside tmux and has no UTF-8 in LC_ALL, LC_CTYPE or
// LANG gets what it prints pushed through utf8_sanitize(): a tab, and every byte of a
// non-ASCII character, comes back as `_`. So every `-F` record stops splitting and every
// path with an accent stops matching. -u is the one per-call switch that wins over all
// three variables, LC_ALL=C included. The full story is on the group that runs this.
//
// A READ IS A VERB WHOSE OUTPUT GOES THROUGH THAT PATH. capture-pane is not one: its bytes
// take another route and arrive intact without -u (measured on 3.4 and 3.7b). And a verb
// that only acts prints nothing worth protecting. -u is left off attach on purpose, where
// it would force UTF-8 onto the person's real terminal.
//
// LINE BY LINE, on purpose, like the rest of this suite's sweeps: it asks a question about
// the spelling of a call, so it can be fooled by a call split across lines, or by a command
// held in a plain variable. What it is for is the next ordinary `tmux -L "$SOCK" list-sessions`,
// and the next batch built in an array, which is how all of these were written.
import fs from 'node:fs';

const VERBS = 'list-sessions|list-panes|list-windows|list-clients|display-message|show-environment|show-options';
const READ = new RegExp(`^["']?(?:${VERBS})(?![\\w-])`);
// "${args[@]}" or "$@": the command is not on this line, so the client has to be ready for a read
const ARRAY = /^"?\$(?:\{\w+\[[@*]\]\}|@)"?$/;
// ${conf[@]+"${conf[@]}"} and ${CONF:+-f "$CONF"} are flags that may not be there, not a command
const MAYBE_FLAGS = /^\$\{\w+(?:\[[@*]\])?:?\+/;
const TOKEN = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+(?:"[^"]*"[^\s"']*)*/g;
// The launcher's TM() is the one that attaches, so it alone keeps no -u, and a read through it
// says `TM -u <verb>` on the line. A call to it is a client with no -u of its own.
const CLIENT = /\b(tmux)\s+|(?:^|[\s"(])(TM)\s+/g;

// ONE CLIENT AT A TIME, read rather than matched, because a batch does not look like a read. A
// list of sessions is cheap to fetch as one client running many commands, and to the regexes
// this replaced, `tmux -L "$SOCK" "${args[@]}"` with no -u came back clean, as did a read chained
// behind a set-option. So: a client's flags in whatever order, then the first word of each
// command in its chain. tmux's separator is \; or a quoted ;, so a bare ; ends the client and
// what follows it is the shell's.
function clients(line) {
  const found = [];
  const starts = [...line.matchAll(CLIENT)];
  starts.forEach((m, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : line.length;
    const t = line.slice(m.index + m[0].length, end).match(TOKEN) || [];
    let u = false, sock = false, i = 0;
    for (; i < t.length; i++) {
      if (t[i] === '-u') u = true;
      else if (t[i] === '-L' || t[i] === '-S') { sock = true; i++; }
      else if (t[i] === '-f') i++;
      else if (MAYBE_FLAGS.test(t[i])) { while (i < t.length && !t[i].endsWith('}')) i++; }
      else break;
    }
    if (m[1] && !sock) return;
    let read = false, first = true;
    for (; i < t.length; i++) {
      const w = t[i];
      if (/^(?:\|\|?|&&)$/.test(w)) break;
      if (first && (READ.test(w) || ARRAY.test(w))) read = true;
      first = false;
      if (w === "';'" || w === '";"' || w.endsWith('\\;')) { first = true; continue; }
      if (/^["']/.test(w)) continue;
      if (w.endsWith(';') || (w.match(/\)/g) || []).length > (w.match(/\(/g) || []).length) break;
    }
    if (read) found.push({ u });
  });
  return found;
}

// ['-L', sock, 'list-panes', …], which also covers the array handed to a helper and a chain in it
const FLAG_OK = `(?:'-u',\\s*'-[LS]',|'-[LS]',\\s*[^,\\]]+,\\s*'-u',)`;
const NODE = new RegExp(`\\[\\s*'-[LS]',.*'(?:${VERBS})'`);
const NODE_OK = new RegExp(`\\[\\s*${FLAG_OK}.*'(?:${VERBS})'`);
// const tmux = (sock, ...a) => spawnSync('tmux', ['-L', sock, ...a]): a helper reads for
// whoever calls it, so the argument list it builds is where the flag has to be
const HELPER = /\[\s*'-[LS]',[^\]]*\.\.\.\w+\s*\]/;
const HELPER_OK = new RegExp(`\\[\\s*${FLAG_OK}[^\\]]*\\.\\.\\.\\w+\\s*\\]`);
// The same in shell: T() { tmux -S "$SOCK" "$@"; }. What it is called with is not on this
// line, and the first cut of this sweep read past three of these, one of them a tab read.
const SH_HELPER = /\w+\(\)\s*\{\s*tmux\s+(?!-u\b)[^;}]*"\$@"/;
const COMMENT = /^\s*(#|\/\/|\*)/;

export function offenders(text) {
  const bad = []; let good = 0;
  text.split('\n').forEach((line, i) => {
    if (COMMENT.test(line) || /\bTM\(\)\s*\{/.test(line)) return;
    let isBad = false;
    // one line can hold more than one call, so each is asked on its own
    for (const c of clients(line)) { if (c.u) good++; else isBad = true; }
    for (const part of line.split(/(?=\[\s*'-[uLS]',)/)) {
      if (NODE_OK.test(part)) good++; else if (NODE.test(part)) isBad = true;
      if (HELPER_OK.test(part)) good++; else if (HELPER.test(part)) isBad = true;
    }
    if (SH_HELPER.test(line)) isBad = true;
    if (isBad) bad.push({ n: i + 1, line: line.trim() });
  });
  return { bad, good };
}

const argv = process.argv.slice(2);
const count = argv[0] === '--count';
const files = count ? argv.slice(1) : argv;
let total = 0;
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const { bad, good } = offenders(text);
  total += good;
  if (!count) for (const b of bad) process.stdout.write(`${f}:${b.n}: ${b.line.slice(0, 120)}\n`);
}
if (count) process.stdout.write(`${total}\n`);
