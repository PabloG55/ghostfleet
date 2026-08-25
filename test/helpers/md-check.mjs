#!/usr/bin/env node
// test/helpers/md-check.mjs — the markdown a bubble renders, and the text it must not lose.
//
//     node test/helpers/md-check.mjs         # one "name <US> want <US> got" row per check
//
// "the messages are not in nice .md format, they have the ****" — turn() set the bubble
// with textContent, so every assistant turn on the phone was its own source. web/md.js is
// the renderer; parse() is pure and returns blocks, which is what lets this file test it
// in node with no DOM at all, the same split grid.js has.
//
// THE SURVIVAL SECTION IS FIRST, AND THAT IS THE POINT. A renderer is trivially "correct"
// about markup: `return ''` has no asterisks in it, and so does a parser that drops every
// run it does not understand. Every case here therefore asserts the WORDS are still there
// before it asserts the marks are gone, and the words chosen are the ones this app's
// messages are actually made of — identifiers, counts, PR numbers. It is the same trap the
// speech filter has, and it caught a vacuous row here yesterday.
//
// The third section is the one that is easy not to think of: the things that LOOK like
// markup and must be left alone. `DATABASE_URL` is not italic, `2*3*4` is not emphasis,
// and nothing inside a code span or a fence is anything but text.

import fs from 'node:fs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const md = await import(new URL('../../web/md.js', import.meta.url).href);
const text = (src) => md.plain(md.parse(src));
const kinds = (src) => md.parse(src).map(b => b.t + (b.t === 'list' && b.ordered ? ':ol' : '')).join(',');

// A real assistant turn, with every part of the subset in it at once.
const TURN = [
  '## What changed',
  '',
  'Rebased onto **main** and pushed. The helper only retried on `5xx`; the spec wants',
  '429 with `Retry-After` honoured too. See [the design](https://x.test/docs/mobile.md).',
  '',
  '- **bold** item, and `fleet_send` with DATABASE_URL kept whole',
  '- a *stressed* word, and 2*3*4 which is not emphasis',
  '',
  '1. first',
  '2. second',
  '',
  '```bash',
  "git log --oneline -5 | grep -E 'a long pattern' --color=never",
  '```',
  '',
  'Suite green: 1885 passed / 0 failed.',
].join('\n');

// ── 1. the text survives ──────────────────────────────────────────────────
{
  const out = text(TURN);
  for (const w of ['What changed', 'Rebased onto', 'main', '5xx', 'Retry-After', 'the design',
                   'bold item', 'fleet_send', 'DATABASE_URL', 'stressed', '2*3*4',
                   'first', 'second', 'git log --oneline -5', '--color=never', '1885 passed', '0 failed']) {
    is(`the turn keeps "${w}"`, true, out.includes(w));
  }
  // ...and keeps them in order, so a renderer that emitted the right words in the wrong
  // places would not pass either.
  is('...in the order they were written', true,
     out.indexOf('What changed') < out.indexOf('Rebased') && out.indexOf('first') < out.indexOf('1885 passed'));
}

// ── 2. the markup is gone ─────────────────────────────────────────────────
{
  const out = text(TURN);
  is('no bold marks are left', '', (out.match(/\*\*/g) || []).join(''));
  is('no backticks are left', '', (out.match(/`/g) || []).join(''));
  is('no heading marks are left', '', (out.match(/^#{1,6}\s/gm) || []).join(''));
  is('no bullet marks are left', '', (out.match(/^[-*+]\s/gm) || []).join(''));
  is('no numbered-list marks are left', '', (out.match(/^\d+[.)]\s/gm) || []).join(''));
  is('no link brackets are left', '', (out.match(/\]\(https/g) || []).join(''));
  is('the URL itself is not read out as text', false, out.includes('x.test/docs'));
}

// ── 3. the blocks are the blocks ──────────────────────────────────────────
is('the turn parses into its blocks', 'heading,para,list,list:ol,code,para', kinds(TURN));
is('a bare line is one paragraph', 'para', kinds('just a sentence.'));
// NULL-SAFE, all through this section. A parser that returned nothing would throw here,
// the helper would die, and every survival row above it would be lost with it — a crash
// prints no rows at all, which is why run.sh puts a floor under the count. The floor
// catches it either way; being null-safe makes it say WHICH promise broke.
is('a heading knows its level', 3, (md.parse('### three')[0] || {}).level);
is('a fence keeps its language', 'bash', (md.parse('```bash\nx\n```')[0] || {}).lang);
is('an unterminated fence still ends', 'code', kinds('```\nnever closed'));
is('a list gathers its items', 3, ((md.parse('- a\n- b\n- c')[0] || {}).items || []).length);
is('...and an ordered one is ordered', true, (md.parse('1. a\n2. b')[0] || {}).ordered);
is('...and a bulleted one is not', false, (md.parse('- a\n- b')[0] || {}).ordered);
// Soft line breaks inside a paragraph are kept: an agent lays its turn out in lines and
// the bubble has always been pre-wrap, so joining them would reflow somebody's work.
is('a paragraph keeps its own line breaks', 'one\ntwo', text('one\ntwo'));

// ── 4. what only LOOKS like markup ────────────────────────────────────────
// The whole reason `_` is not emphasis here, and the reason `*` needs a word boundary.
for (const [what, src, keep] of [
  ['an env var',        'Set DATABASE_URL before you run it.',        'DATABASE_URL'],
  ['a snake_case name', 'fleet_send takes a prompt.',                 'fleet_send'],
  ['a key prefix',      'It holds sk_live_ and sk_test_ keys.',       'sk_live_ and sk_test_'],
  ['a wire field',      'The cursor is next_before.',                 'next_before'],
  ['arithmetic',        'That is 2*3*4 in total.',                    '2*3*4'],
  ['a glob',            'find . -name a*b*c -print',                  'a*b*c'],
  ['intraword stars',   'PR**#1171** was the one.',                   'PR**#1171**'],
  ['unpaired stars',    'trailing ** stars **',                       '** stars **'],
]) is(`${what} is left alone ("${keep}")`, true, text(src).includes(keep));
// Nothing inside code is markup, at either scale.
is('a code span keeps its own asterisks', 'a *span* here', text('a `*span*` here'));
is('a fence keeps its markdown as text', '**not bold**', text('```\n**not bold**\n```'));
is('...and a fence is one block, not its lines', 'code', kinds('```\n- not a bullet\n# not a heading\n```'));

// ── 5. a link is the one attribute this renderer writes ───────────────────
// So it is the one place a transcript could reach something other than text.
is('https is a link', 'https://x.test/a', md.safeHref('https://x.test/a'));
is('http is a link', 'http://x.test/a', md.safeHref('http://x.test/a'));
is('javascript: is not', null, md.safeHref('javascript:alert(1)'));
is('data: is not', null, md.safeHref('data:text/html,<script>x</script>'));
is('a relative path is not', null, md.safeHref('/local/path'));
is('a protocol-relative one is not', null, md.safeHref('//evil.test/x'));
is('an empty one is not', null, md.safeHref(''));
// ...and a link this file refuses is still something somebody wrote, so it stays as words
// rather than vanishing — the survival rule, applied to the case where rendering is denied.
is('a refused link survives as its own text', true,
   text('[bad](javascript:alert(1)) here').includes('[bad](javascript:alert(1))'));
is('...and a good one becomes a link node', 'link',
   (md.inline('[x](https://x.test/a)')[0] || {}).t);
is('...carrying the href it was given', 'https://x.test/a',
   (md.inline('[x](https://x.test/a)')[0] || {}).href);

// ── 6. inline shapes ──────────────────────────────────────────────────────
const tags = (s) => md.inline(s).map(n => n.t).join(',');
is('bold is bold', 'bold', tags('**x**'));
is('italic is italic', 'em', tags('*x*'));
is('code is code', 'code', tags('`x`'));
is('...and bold wins over italic on **', 'bold', tags('**x**'));
is('a run of prose is one text node', 'text', tags('just words'));
is('mixed inline keeps its order', 'text,bold,text,code,text', tags('a **b** c `d` e'));
is('empty in, nothing out', 0, md.inline('').length);
is('null in, nothing out', 0, md.parse(null).length);

// ── 7. the renderer and the read-aloud stay independent ───────────────────
// They are complementary — rendered for the eye, stripped for the ear — and neither may be
// built on the other's output. If speakable() ever spoke md.js's plain text it would
// inherit its decisions, and a rendering fix would silently change what the phone SAYS.
const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
// COMMENTS STRIPPED FIRST. This file's subject explains at length why it does not use
// innerHTML, so a naive grep for the word finds the explanation and calls the code guilty
// — pwa-check has the mirror of this scar, where an assertion matched api.js's comment
// about not storing the token and passed while proving nothing. Only real code counts.
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const MD_SRC = code(read('web/md.js'));
const APP_SRC = read('web/app.js');
is('md.js imports nothing at all', '', (MD_SRC.match(/^import .*/gm) || []).join(';'));
is('...and never assigns innerHTML', '', (MD_SRC.match(/innerHTML/g) || []).join(''));
is('...and reaches the document only through create* calls that cannot carry markup', '',
   (MD_SRC.match(/doc\.[a-zA-Z]+/g) || [])
     .filter(c => !/createTextNode|createElement|createDocumentFragment/.test(c)).join(','));
// The read-aloud filter is markdown-aware too, and it must go on doing its own stripping
// from the SOURCE. One built on the other's output would mean a rendering change silently
// altering what the phone says out loud.
const SPEAKABLE = (APP_SRC.match(/export function speakable[\s\S]*?\n\}/) || [''])[0];
is('speakable() exists to be checked', true, SPEAKABLE.length > 100);
is('...and does not call the renderer', '', (SPEAKABLE.match(/\bmd\.[a-z]+/gi) || []).join(','));
is('...and still names fenced code itself', true, /code block/.test(SPEAKABLE));
is('...and app.js renders bubbles through md, not through el({html})', '',
   (APP_SRC.match(/html:/g) || []).join(''));

console.log(rows.join('\n'));
