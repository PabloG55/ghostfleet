#!/usr/bin/env node
// test/helpers/speak-check.mjs — what the assistant actually says when it reads a reply out.
//
//     node test/helpers/speak-check.mjs      # one "name <US> want <US> got" row per check
//
// web/ui/speakable.js's speakable() and speechChunks() are pure, and they are what both apps'
// voice is handed (web/ui/voice.js speak()). The phone's 🔊 shipped once reading a 40-character
// sha out one character at a time — "it has a bunch of numbers and stuff that is not relevant" —
// and these tables came with the fix. The phone's own talk screen went when it moved onto web/ui
// (one assistant, in both apps), and the fix moved with it: without it the shared assistant read
// a lead's reply as written, cut at 1500 characters.
//
// BOTH DIRECTIONS, AND THE SECOND ONE IS THE POINT. Every case here is a pair: the address is
// gone, AND the word that replaced it is there. A file that only asserted removal would be passed
// in full by `return ''` — a normaliser that deletes every digit is worse than none, because
// "1885 passed, 0 failed" is the entire content of that sentence. So the facts get their own
// section and are asserted as SURVIVING: counts, #1171, version numbers, percentages, durations.
//
// The third section is the one nobody would think to write. The sha rule is a guess about what a
// 7-40 character run of [0-9a-f] means, and the word "defaced" and the number "1234567" are both
// inside that guess — so they are checked as staying put. That is the assertion that fails if
// someone later "simplifies" the rule to /[0-9a-f]{7,}/.
//
// RETIRED WITH THE OLD CLIENT: its conversation-mode clock, barge-in detector, voice picker, the
// reasons `talk` would not start, and the grid column count. They were app.js's own, and web/ui's
// assistant has its own pauses, listening and voice settings (web/ui/voice.js, agent.js), which
// phone-check.mjs and the team app's tests reach.
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const S = await import(new URL('../../web/ui/speakable.js', import.meta.url).href);
const { speakable, speechChunks, CHUNK_MAX } = S;
is('speakable.js exports speakable()', 'function', typeof speakable);
is('...and speechChunks()', 'function', typeof speechChunks);
is('...and a chunk cap', true, CHUNK_MAX > 0);
// And it is what the voice is handed: a reply cut to a fixed length before the voice sees it is
// the bug the long-reply rows below exist for, so the speak path is read for it too.
{
  const fs = await import('node:fs');
  const V = fs.readFileSync(new URL('../../web/ui/voice.js', import.meta.url), 'utf8');
  const sp = (/export async function speak\([\s\S]*?\n\}/.exec(V) || [''])[0];
  is('the voice is handed speakable() text, in chunks', true, /speechChunks\(speakable\(md, sayWords\(\)\)\)/.test(sp));
  is('...and nothing cuts it to a length first', false, /\.slice\(0, \d+\)/.test(sp) || /\.slice\(0, \d+\)/.test((/function utter\([\s\S]*?\n\}/.exec(V) || [''])[0]));
  is('...in the language the app speaks', true, /t\(`say\.\$\{k\}`\)/.test(V));
}

// ── 1. the four messages this was measured on, whole ──────────────────────
// Real assistant turns from this repo. Asserted as EXACT output rather than as a bag of
// substrings, because the sentence still has to be a sentence afterwards — a normaliser
// that produced the right words in an unreadable order would pass every check below.
for (const [label, input, want] of [
  ['a rebase',
   'Rebased onto ee451b7224f7b03d1c5f80ee02ba4c3dce9b9622 and pushed. 1885 passed / 0 failed.',
   'Rebased onto a commit and pushed. 1885 passed, 0 failed.'],
  ['a dead session',
   'Session 28782a23-ad3e-452e-bb2e-40ecd98466ce died at 2026-08-24T11:05:15-0400.',
   'Session an id died at a timestamp.'],
  ['a fix at a line',
   'Fixed bin/fleet-grid.mjs:86 — tmux <= 3.5 escapes \\x1f into \\037, so the split fails.',
   'Fixed fleet-grid.mjs line 86 — tmux <= 3.5 escapes an escape code into an escape code, so the split fails.'],
  ['an install command',
   'Run npm i -g @anthropic-ai/claude-code with --dangerously-skip-permissions off.',
   'Run npm i -g @anthropic-ai/claude-code with --dangerously-skip-permissions off.'],
]) is(`speaks ${label}`, want, speakable(input));

// ── 2. an address is named, never spelled ─────────────────────────────────
// Two rows each, and the second is what stops `return ''` from passing this section: the
// address has to be GONE and the word that stands in for it has to be THERE.
for (const [what, input, address, name] of [
  ['a 40-char sha',   'Rebased onto ee451b7224f7b03d1c5f80ee02ba4c3dce9b9622 and pushed.', 'ee451b7224f7b03d1c5f80ee02ba4c3dce9b9622', 'a commit'],
  ['a short sha',     'Reverted ee451b7 this morning.',                                    'ee451b7',                                  'a commit'],
  ['a UUID',          'Session 28782a23-ad3e-452e-bb2e-40ecd98466ce died.',                '28782a23-ad3e-452e-bb2e-40ecd98466ce',     'an id'],
  ['an ISO stamp',    'It died at 2026-08-24T11:05:15-0400.',                              '2026-08-24T11:05:15',                      'a timestamp'],
  ['a UTC stamp',     'Logged 2026-08-24T11:05:15Z by the governor.',                      '2026-08-24T11:05:15Z',                     'a timestamp'],
  ['a hex id',        'The marker holds 0x1f4ade00 as its pid word.',                      '0x1f4ade00',                               'a hex id'],
  ['an \\x escape',   'tmux escapes \\x1f, so the split fails.',                           '\\x1f',                                    'an escape code'],
  ['an octal escape', 'It comes back as \\037 instead.',                                   '\\037',                                    'an escape code'],
  ['a rooted path',   'The grid is at /Users/you/gf-demo/acme-api now.',               '/Users/you',                           'acme-api'],
  ['a home path',     'Markers live in ~/.claude/fleet on this machine.',                  '~/.claude',                                'fleet'],
  ['a relative path', 'See docs/mobile.md for the payload.',                               'docs/',                                    'mobile.md'],
  ['a path + line',   'Fixed bin/fleet-grid.mjs:86 this morning.',                         'bin/fleet-grid.mjs:86',                    'fleet-grid.mjs line 86'],
  ['a bare file:line','The probe is decided at api.js:128.',                               'api.js:128',                               'api.js line 128'],
]) {
  const out = speakable(input);
  is(`${what} is not spelled out`, '', out.includes(address) ? address : '');
  is(`...it is called "${name}"`, true, out.includes(name));
}

// ── 3. a fact survives, because it is the sentence ────────────────────────
// These are the numbers a listener ACTS on, and the reason this cannot be "strip the
// digits". Every one is measured off a real turn or a real card.
for (const [what, input, fact] of [
  ['a test count',      'Suite green: 1885 passed / 0 failed.',            '1885 passed'],
  ['...and its zero',   'Suite green: 1885 passed / 0 failed.',            '0 failed'],
  ['a PR number',       'Draft PR #1171 is up with both screenshots.',     '#1171'],
  ['an issue number',   'That is #59, and #60 re-shot the images.',        '#59'],
  ['a version',         'Claude Code 2.1.241 is what the pane says.',      '2.1.241'],
  ['a v-version',       'codex v0.147.0 on this machine.',                 'v0.147.0'],
  ['a percentage',      'Context is at 40% with two hours left.',          '40%'],
  ['a duration',        'Worked for 6s and then asked a question.',        '6s'],
  ['a longer duration', 'It has been sitting there 22 minutes.',           '22 minutes'],
  ['a size',            'A 269x65 pane captures to 5.9 KB with escapes.',  '5.9 KB'],
  ['a bare count',      'Confirmed across 4213 paths: 11 pairs.',          '4213 paths'],
  ['a plain year',      'Shipped in 2026 and never touched since.',        '2026'],
]) is(`keeps ${what} ("${fact}")`, true, speakable(input).includes(fact));

// ── 4. the words the sha rule is allowed to be wrong about ────────────────
// A run of [0-9a-f] is a GUESS, and these live inside it. "defaced" and "acceded" are
// seven HEX LETTERS and nothing else; "1234567" is seven hex digits; a branch and an npm
// scope both carry a slash without being addresses. The rule needs a digit AND a letter
// below twelve characters, and a dotted last segment before it will call something a path
// — which is exactly what these rows hold it to.
//   The first draft of this section used "cabbage", which has a 'g' in it and was never
// inside the guess at all: with the sha guard deliberately deleted the row stayed green.
// That is the whole reason for breaking each one on purpose before trusting it.
for (const [what, input, kept] of [
  ['an all-hex word',    'The commit defaced the changelog, apparently.', 'defaced'],
  ['a longer hex word',  'Everyone acceded to the rename.',              'acceded'],
  ['a 7-digit number',   'It walked 1234567 rows before giving up.',     '1234567'],
  ['a branch name',      'Pushed feat/retry-backoff for review.',        'feat/retry-backoff'],
  ['a scoped package',   'Run npm i -g @anthropic-ai/claude-code now.',  '@anthropic-ai/claude-code'],
  ['a long flag',        'It runs with --dangerously-skip-permissions.', '--dangerously-skip-permissions'],
  ['a slashed idiom',    'Take it and/or leave it, 24/7.',               'and/or'],
  ['a bare filename',    'sw.js is precached and app.js is too.',        'sw.js'],
]) is(`leaves ${what} alone ("${kept}")`, true, speakable(input).includes(kept));

// ── 5. the markdown behaviour it already had ──────────────────────────────
// Regression rows, not new claims: identifiers were added UNDER these, and the cheapest way
// to break them is to reorder the passes — run the path rule before the link rule and every
// URL becomes a basename.
is('a fenced block is named, not read', true, /Code omitted/.test(speakable('before\n```\nrm -rf /\n```\nafter')));
is('...and its contents are gone', false, /rm -rf/.test(speakable('before\n```\nrm -rf /\n```\nafter')));
is('inline code keeps its text', 'run the suite first', speakable('run the `suite` first'));
is('a markdown link becomes its label', 'the design link says so', speakable('the [design](https://x.test/a/b.md) says so'));
is('a bare URL becomes "the link"', 'see the link for it', speakable('see https://x.test/a/b.md for it'));
is('...and the URL is not read as a path', false, /b\.md/.test(speakable('see https://x.test/a/b.md for it')));
is('heading marks go', 'What changed', speakable('## What changed'));
is('bullet marks go, and each item is its own sentence', 'one. two', speakable('- one\n- two'));
// ── 5b. what the Mac's voice must not read ────────────────────────────────
// Sentence ends survive as full stops because lib/speech.mjs chooses the language and the
// voice PER SENTENCE: two list items run together are one clause and one language.
is('a line that already ends a sentence is not doubled', 'Done. Next.', speakable('Done.\nNext.'));
is('a table is read as its cells', 'Name, State. acme-api, green', speakable('| Name | State |\n|---|:---:|\n| acme-api | green |'));
is('...and no pipe survives', false, /\|/.test(speakable('| a | b |\n|---|---|\n| 1 | 2 |')));
is('...and the rule row is not read as dashes', false, /-{2,}/.test(speakable('| a | b |\n|---|---|\n| 1 | 2 |')));
is('emoji are not read', 'Shipped. Tests green', speakable('Shipped 🚀.\nTests green ✅'));
is('...a joined emoji leaves no glue behind', 'family', speakable('👨‍👩‍👧 family'));
is('...and the words beside them stay', true, speakable('✅ merged #42').includes('merged #42'));
is('a fenced block ends its own sentence', 'before. Code omitted. after', speakable('before\n```\nrm -rf /\n```\nafter'));
is('emphasis marks go', 'really not optional', speakable('**really** _not_ optional'));
// THE CAP WAS THE BUG. A long reply was cut at 1200 characters with "… and it goes on.",
// before Kokoro ever saw the rest — measured on a 2059-character reply, whose closing
// question was never read. A real long reply is read to its last sentence now; only a
// runaway turn, twenty minutes of listening, is still capped.
const longReply = Array.from({ length: 30 }, (_, i) =>
  `Step ${i + 1} of the acme-api rollout went through, and the billing-svc checks stayed green.`).join(' ') +
  ' Should I merge it now or wait for the toolbox build?';
const readWhole = speakable(longReply);
is('a 2700-character reply is not capped', false, /and it goes on\.$/.test(readWhole));
is('...and reaches its last sentence', true, readWhole.endsWith('Should I merge it now or wait for the toolbox build?'));
const long = speakable('word '.repeat(5000));
is('a runaway turn is still capped', true, long.length <= 20050);
is('...and says that it goes on', true, long.endsWith('… and it goes on.'));
is('empty in, empty out', '', speakable(''));
is('null in, empty out', '', speakable(null));

// ── 5b. markdown is read as speech, not as its marks ─────────────────────
for (const [what, input, want] of [
  ['a blockquote mark',      '> the PR says it is ready',                     'the PR says it is ready'],
  ['a starred rule',         'above\n\n***\n\nbelow',                        'above. below'],
  ['struck-out text',        'the ~~old~~ new plan',                          'the new plan'],
  ['an autolink',            'see <https://example.com/acme-web/42> now',     'see the link now'],
  ['an html line break',     'one<br>two',                                    'one two'],
  ['underscore bold',        'this is __important__ here',                    'this is important here'],
  ['a task list',            '- [ ] write the test\n- [x] fix the bug',      'write the test. fix the bug'],
  ['a reference link',       'read [the guide][1] first\n\n[1]: https://example.com/guide', 'read the guide first.'],
]) is(`markdown: ${what}`, want, speakable(input));
is('...and a generic type is text, not a tag', 'Array<string> stays', speakable('Array<string> stays'));
is('...and so is a comparison', 'tmux <= 3.5 escapes it', speakable('tmux <= 3.5 escapes it'));

// ── 5c. a long reply, in chunks ───────────────────────────────────────────
// Ordered, each under the cap, and the words round-trip EXACTLY: a chunker that dropped a
// sentence, reordered two, or cut inside a word (which joining with a space would expose as
// "fleet- grid") fails the last row even if every chunk is the right size.
const chunks = speechChunks(readWhole);
is('a long reply becomes several chunks', true, chunks.length >= 4);
is('...each under the cap', true, chunks.every(c => c.length <= CHUNK_MAX));
is('...in order, losing and adding nothing', readWhole, chunks.join(' '));
is('...cut only after a sentence end', true, chunks.slice(0, -1).every(c => /[.!?…]$/.test(c)));
const dotted = 'Fixed fleet-grid.mjs line 86 in 2.1.241 for acme-web. '.repeat(40).trim();
const dc = speechChunks(dotted, 200);
is('a dotted name is never a boundary', true, dc.every(c => !/^(mjs|1\.241|241)\b/.test(c)) && dc.join(' ') === dotted);
is('short sentences fold into one chunk', ['Yes. No. Done. OK, merged.'], speechChunks('Yes. No. Done. OK, merged.'));
const runOn = 'the acme-api deploy finished, ' .repeat(40) + 'and that is all.';
const rc = speechChunks(runOn, 300);
is('a sentence over the cap is cut at a clause', true, rc.length > 1 && rc.every(c => c.length <= 300) && rc.slice(0, -1).every(c => c.endsWith(',')));
is('...and still round-trips', runOn.replace(/\s+/g, ' ').trim(), rc.join(' '));
const noComma = ('acme ').repeat(200).trim();
const nc = speechChunks(noComma, 300);
is('...or at a space, never inside a word', true, nc.every(c => c.length <= 300 && /^acme( acme)*$/.test(c)));
const token = 'x'.repeat(700);
is('one token longer than the cap stays whole', [`see ${token}`], speechChunks(`see ${token}`, 300));
// A chunk 290 long, then a sentence with "e.g." in it: were "e.g." a sentence end, the
// first nine characters would still fit and the chunk would end on it.
const ab1 = 'a '.repeat(143) + 'end.';
is('an abbreviation is not a sentence end', [ab1, 'Use e.g. dry-run first.'], speechChunks(`${ab1} Use e.g. dry-run first.`, 300));
is('nothing to say is no chunks', [], speechChunks(' … '));

console.log(rows.join('\n'));
