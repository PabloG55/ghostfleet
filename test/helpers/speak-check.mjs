#!/usr/bin/env node
// test/helpers/speak-check.mjs — what the 🔊 button actually says.
//
//     node test/helpers/speak-check.mjs      # one "name <US> want <US> got" row per check
//
// web/app.js's speakable() is pure and exported, and until this file it had no coverage at
// all — which is how it shipped reading a 40-character sha out one character at a time.
// From the phone: "it has a bunch of numbers and stuff that is not relevant."
//
// BOTH DIRECTIONS, AND THE SECOND ONE IS THE POINT. Every case here is a pair: the address
// is gone, AND the word that replaced it is there. A file that only asserted removal would
// be passed in full by `return ''` — a normaliser that deletes every digit is worse than
// the one we had, because "1885 passed, 0 failed" is the entire content of that sentence.
// So the facts get their own section and are asserted as SURVIVING: counts, #1171, version
// numbers, percentages, durations. CLAUDE.md's rule, in the place it is easiest to break:
// a test that can only pass proves nothing.
//
// The third section is the one nobody would think to write. The sha rule is a guess about
// what a 7-40 character run of [0-9a-f] means, and the word "defaced" and the number
// "1234567" are both inside that guess — so they are checked as staying put. That is the
// assertion that fails if someone later "simplifies" the rule to /[0-9a-f]{7,}/.
//
// WHY ITS OWN DOM AND NOT pwa-render.mjs'S. That helper needs a live fleet-serve on
// loopback — it exists to prove the client boots against a real daemon — and these are
// table rows for a pure string function that must run on every suite, daemon or not. What
// is duplicated is twenty lines of stub, and only because importing app.js runs its boot
// block; nothing here touches a screen.

import fs from 'node:fs';
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// ── the least DOM that lets app.js's last block run ───────────────────────
const noop = () => {};
class Node_ {
  constructor(tag) {
    this.tag = tag; this.kids = []; this.attrs = {}; this.className = ''; this._text = null;
    this.value = ''; this.style = { cssText: '', setProperty: noop }; this.dataset = {};
    this.classList = { contains: () => false, add: noop, remove: noop, toggle: noop };
  }
  set textContent(v) { this.kids.length = 0; this._text = String(v); }
  get textContent() { return (this._text || '') + this.kids.map(k => k.textContent).join(' '); }
  set innerHTML(v) { this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  append(...ks) { for (const k of ks) if (k != null) this.kids.push(k); }
  appendChild(k) { this.kids.push(k); return k; }
  remove() {} focus() {} blur() {}
  get firstChild() { return this.kids[0] || null; }
  getBoundingClientRect() { return { width: 800, height: 20 }; }   // fitCards() measures this
  querySelector() { return null; }
}
const appHost = new Node_('div'), sheetHost = new Node_('div');
const documentStub = {
  hidden: false, documentElement: new Node_('html'), body: new Node_('body'),
  createElement: t => new Node_(t),
  createTextNode: t => { const n = new Node_('#text'); n.textContent = t; return n; },
  getElementById: id => (id === 'app' ? appHost : id === 'sheet' ? sheetHost : null),
  querySelectorAll: () => [], addEventListener: noop,
};
for (const [name, value] of [
  ['document', documentStub],
  // A REAL map, not a null getter: the voice preference is the thing under test and a
  // store that forgets every write would make every "saved voice" assertion vacuous.
  ['localStorage', (() => { const m = new Map(); return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; })()],
  ['addEventListener', noop],
  ['history', { length: 1, pushState: noop, replaceState: noop, back: noop, go: noop }],
  ['window', { isSecureContext: false }],
  ['navigator', {}],
  ['setInterval', () => 0],           // left real, this process would never exit
  ['location', { href: 'file:///', origin: 'null', protocol: 'file:', host: '', hostname: '' }],
]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// No fixture is read here; the probe must simply not reach the network.
globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

// ── the speech stub, driveable ────────────────────────────────────────────
// getVoices() answers [] until `voices` is filled, exactly as Safari does, and every
// cancel/speak is recorded so "a second play stops the first" is an observation rather
// than a claim about intent.
const V = (uri, name, lang) => ({ voiceURI: uri, name, lang, default: false });
const synth = {
  voices: [], calls: [], listeners: {},
  getVoices() { return this.voices; },
  cancel() { this.calls.push('cancel'); },
  // The volume-0 utterance is unlockAudio()'s primer — iOS speaks only after a gesture has
  // spoken once — and is recorded as what it is, so it is not counted as a second voice.
  speak(u) { this.calls.push(u.volume === 0 ? 'prime' : 'speak:' + (u.voice ? u.voice.name : 'default') + '@' + u.rate); },
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  fire(ev) { for (const fn of (this.listeners[ev] || [])) fn(); },
};
Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, writable: true, value: synth });
Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, writable: true,
  value: class { constructor(t) { this.text = t; this.rate = 1; this.voice = null; this.lang = ''; } } });
Object.defineProperty(globalThis, 'getSelection', { configurable: true, writable: true, value: () => '' });

const APP = await import(new URL('../../web/app.js', import.meta.url).href);
const { speakable, allVoices, pickVoice, savedRate, toggleSpeak, gridColsFrom, talkRefusal, jarvisSurfaces } = APP;
// A client without these still runs every row below, and every row about them goes red on
// its own, rather than one TypeError taking the whole file's rows with it.
const speechChunks = APP.speechChunks || (() => ['(no speechChunks)']);
const CHUNK_MAX = APP.CHUNK_MAX || 0;
const absent = { end: '(no turnClock)', left: NaN, frac: NaN, pausing: null };
const turnClock = APP.turnClock || (() => ({ start() {}, voice() {}, tap() {}, spoke: NaN, at: () => absent }));
const savedQuiet = APP.savedQuiet || (() => NaN);
const QUIET = APP.QUIET || {};
const bargeDetector = APP.bargeDetector || (() => ({ frame: () => '(no bargeDetector)' }));
is('web/app.js exports speakable()', 'function', typeof speakable);
is('web/app.js exports speechChunks()', 'function', typeof APP.speechChunks);
is('web/app.js exports turnClock()', 'function', typeof APP.turnClock);

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

// ── 5d. conversation mode: when a turn ends, on a fake clock ──────────────
// "I have to have time to think and I can't stop talking": the turn ended one second after
// the last loud frame. Now it waits savedQuiet() seconds, counted from the LAST SPEECH, and
// talking again resets it.
const q = turnClock(3500);
q.start(0); q.voice(1000);
is('a 2 s pause does not end the turn', '', q.at(3000).end);
is('...and the countdown shows what is left', 1500, q.at(3000).left);
is('...as a fraction for the bar', '0.43', Number(q.at(3000).frac).toFixed(2));
is('...and it is a pause, not speech', true, q.at(3000).pausing);
is('3.5 s of quiet ends it', 'quiet', q.at(4500).end);
const r = turnClock(3500);
r.start(0); r.voice(1000);
is('3 s in, still waiting', '', r.at(4000).end);
r.voice(4000);
is('speech resets the countdown', 3500, r.at(4000).left);
is('...so the old deadline passes without a send', '', r.at(4600).end);
is('...and the new one sends', 'quiet', r.at(7500).end);
const tp = turnClock(3500);
tp.start(0); tp.voice(500);
tp.tap();
is('a tap ends it now', 'tap', tp.at(600).end);
const lg = turnClock(3500, 90000);
lg.start(0);
for (let t = 0; t <= 90000; t += 1000) lg.voice(t);
is('a turn that never pauses still ends at the cap', 'long', lg.at(90000).end);
is('...and not before it', '', lg.at(89000).end);
is('how long speech lasted is measured to the last voice', 90000, lg.spoke);
localStorage.removeItem('gf.talkquiet');
is('the quiet setting defaults to 3.5 s', 3.5, savedQuiet());
localStorage.setItem('gf.talkquiet', '5');
is('...and is the saved value', 5, savedQuiet());
localStorage.setItem('gf.talkquiet', '30');
is('...unless it is out of range', QUIET.DEFAULT, savedQuiet());
localStorage.setItem('gf.talkquiet', '1');
is('...either way', QUIET.DEFAULT, savedQuiet());
localStorage.removeItem('gf.talkquiet');

// ── 5e. barge-in: the owner talking over the answer, never the answer itself ──
// The REAL frames first: a long Kokoro reply played through a laptop's speaker into its own
// mic, with echo cancellation on and off (test/fixtures/barge-echo.json). The app's own
// voice alone must never barge in — not one frame, the whole reply, either way.
is('web/app.js exports bargeDetector()', 'function', typeof APP.bargeDetector);
// ONE SOUND IN THAT RECORDING WAS NOT THE SPEAKER: 280 ms at ~90 s where the mic read up to
// 0.19 while the reply sat between two sentences at 0.0008 — five to ten times louder than
// anything playing, with echo cancelling on, when with it off the echo never passed 0.41×.
// That is the room, and the fixture marks it (`room`). It is replayed in BOTH directions:
// everything else never barges in, and that sound DOES, because a voice in the room loud
// and long enough is exactly what the gate is for — it cannot tell who is speaking.
const ECHO_FX = JSON.parse(fs.readFileSync(new URL('../fixtures/barge-echo.json', import.meta.url), 'utf8'));
const echo = ECHO_FX.frames;
const inRoom = (k, t) => (ECHO_FX.room[k] || []).some(([a, z]) => t >= a - 300 && t <= z + 300);
for (const k of ['aec', 'raw']) {
  const det = bargeDetector();
  const playing = echo[k].filter(f => f[1] && !inRoom(k, f[0]));
  const fired = playing.filter(([t, , out, mic]) => det.frame(t, mic, out, 0.012) === true).length;
  is(`own playback alone never barges in (${k === 'aec' ? 'echo cancelled' : 'no echo cancelling'}, ${playing.length} real frames)`, 0, fired);
  // The same frames from a speaker three times as loud: the mic scaled, the output not —
  // the margin the gate has before a louder phone would cut itself off.
  const det3 = bargeDetector();
  is(`...nor with that speaker three times as loud (${k})`, 0,
     playing.filter(([t, , out, mic]) => det3.frame(t, mic * 3, out, 0.012) === true).length);
}
is('...and the replay is the long one, not a sample', true, echo.aec.filter(f => f[1]).length >= 1000 && echo.raw.filter(f => f[1]).length >= 400);
{ const det = bargeDetector(); let at = -1;
  for (const [t, p, out, mic] of echo.aec) if (p && at < 0 && det.frame(t, mic, out, 0.012) === true) at = t;
  is('...while the real sound in that room does barge in, at ~90 s', true, at >= 89800 && at <= 90200); }
// The owner, on a fake clock and a fake mic: frames every 85 ms, as the ScriptProcessor
// delivers them, over an answer playing at a level the measurement saw often (0.1 RMS).
const run = (frames) => { const d = bargeDetector(); let at = -1;
  frames.forEach(([t, mic, out]) => { if (at < 0 && d.frame(t, mic, out, 0.012) === true) at = t; }); return at; };
const over = (fromMs, toMs, mic, out = 0.1) => Array.from({ length: Math.ceil((toMs - fromMs) / 85) }, (_, i) => [fromMs + i * 85, mic, out]);
const talkOver = [...over(0, 2000, 0.03), ...over(2000, 3000, 0.2)];
is('the owner talking over the answer barges in', true, run(talkOver) > 0);
is('...after 250 ms of it, not on the first frame', true, run(talkOver) >= 2250 && run(talkOver) < 2400);
is('one loud frame over the answer is not the owner', -1, run([...over(0, 1000, 0.03), [1000, 0.3, 0.1], ...over(1085, 3000, 0.03)]));
is('speech that is only as loud as the echo could be does not', -1, run(over(0, 3000, 0.055)));
// The echo DECAYS after the voice does, so the tail of a loud word cannot barge in either;
// but once the reply has been quiet a while, ordinary speech can.
is('a loud word ending does not open a gap for its own tail', -1,
   run([...over(0, 500, 0.02, 0.25), ...over(500, 900, 0.09, 0)]));
is('...and a voice after the reply has gone quiet barges in', true,
   run([...over(0, 500, 0.02, 0.1), ...over(500, 3000, 0.002, 0), ...over(3000, 3600, 0.05, 0)]) > 3000);
// The device's voice plays outside Web Audio, so there is no level to compare: the gate
// assumes the loud end of what was measured.
is('with no output level, a normal voice still barges in', true, run(over(0, 600, 0.15, null)) > 0);
is('...and a quiet echo does not', -1, run(over(0, 3000, 0.05, null)));
is('nothing below the room\'s own floor ever does', -1, (() => { const d = bargeDetector(); let at = -1;
  over(0, 2000, 0.03, 0).forEach(([t, m]) => { if (at < 0 && d.frame(t, m, 0, 0.04) === true) at = t; }); return at; })());

// ── 6. the voice picker, and the three ways it breaks ─────────────────────
// EMPTY ON THE FIRST CALL is not an edge case, it is Safari's documented behaviour: the
// list is populated asynchronously and announced with `voiceschanged`. A picker built once
// at boot therefore ships empty on the device this whole client exists for.
is('getVoices() is empty at first', 0, allVoices().length);
// SUBSCRIBING IS THE POINT, and asserting "the list is populated later" does NOT test it:
// allVoices() re-asks getVoices() every call, so that assertion passes with no listener at
// all. Measured — removing the subscription left it green. What the listener is actually
// for is re-rendering an ALREADY-OPEN picker, so the two things worth asserting are that
// it is registered, and that the cache does not flicker back to empty once filled.
is('...and it subscribed to voiceschanged', true, (synth.listeners.voiceschanged || []).length > 0);
synth.voices = [V('urn:a', 'Ada', 'en-GB'), V('urn:b', 'Blaise', 'en-US')];
synth.fire('voiceschanged');
is('...and the list arrives with the event', 2, allVoices().length);
// Safari has been observed handing back [] again on a later call; a picker that emptied
// itself mid-scroll is the same bug as one that ships empty.
synth.voices = [];
is('...and a later empty answer does not undo it', 2, allVoices().length);
synth.voices = [V('urn:a', 'Ada', 'en-GB'), V('urn:b', 'Blaise', 'en-US')];
is('...and the picker would draw both', true, /const vs = allVoices\(\)/.test(
  fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')));

// A SAVED VOICE THAT IS NOT ON THIS DEVICE MUST STILL SPEAK. A phone and a tablet do not
// have the same list, so this is the ordinary case on the second device, not a corner.
localStorage.setItem('gf.voice', JSON.stringify({ uri: 'urn:a', name: 'Ada' }));
is('a saved voice resolves by URI', 'Ada', (pickVoice() || {}).name);
localStorage.setItem('gf.voice', JSON.stringify({ uri: 'urn:gone', name: 'Blaise' }));
is('...or by name when the URI moved', 'Blaise', (pickVoice() || {}).name);
localStorage.setItem('gf.voice', JSON.stringify({ uri: 'urn:gone', name: 'Nobody' }));
is('an absent voice resolves to null', null, pickVoice());
synth.calls.length = 0;
toggleSpeak('the deploy finished cleanly');
is('...and it still speaks, with the default', 1, synth.calls.filter(c => c.startsWith('speak:')).length);
is('...specifically the browser default', true, synth.calls.some(c => c.startsWith('speak:default@')));

// THE RATE IS A SETTING NOW, and its default is the 1.05 that used to be hardcoded.
localStorage.removeItem('gf.rate');
is('rate defaults to the old constant', 1.05, savedRate());
localStorage.setItem('gf.rate', '9');
is('...and a junk rate falls back, not throws', 1.05, savedRate());
localStorage.setItem('gf.rate', '0.8');
is('...and a real one is used', 0.8, savedRate());

// TWO VOICES AT ONCE MUST STAY IMPOSSIBLE. This is the assertion that per-message
// playback could break: with one button there was only ever one thing to stop.
localStorage.setItem('gf.voice', JSON.stringify({ uri: 'urn:a', name: 'Ada' }));
synth.calls.length = 0;
toggleSpeak('message M');
toggleSpeak('message N');
is('playing N cancelled first', true, synth.calls.indexOf('cancel') < synth.calls.indexOf('speak:Ada@0.8'));
// one cancel per speak: an orphan utterance is exactly the overlap this must prevent
is('...one cancel for every speak', true,
   synth.calls.filter(c => c === 'cancel').length === synth.calls.filter(c => c.startsWith('speak:')).length);
is('...every speak is preceded by a cancel', true,
   synth.calls.filter((c, i) => c.startsWith('speak:') && synth.calls[i - 1] !== 'cancel').length === 0);
// and the toggle: tapping the one that is talking stops it and starts nothing
synth.calls.length = 0;
toggleSpeak('message N');
is('tapping the talking one only cancels', 0, synth.calls.filter(c => c.startsWith('speak:')).length);
is('...and it did cancel', 1, synth.calls.filter(c => c === 'cancel').length);

// ── 6b. why `talk` will not start, per target ─────────────────────────────
// Conversation mode is one implementation with a target (Jarvis, or <project>/<session>),
// and the refusal has to be about the thing tapped: a session must never be told "there is
// no Jarvis", and Jarvis must never be told about a grid card it does not have. Each row
// has its passing neighbour, so a refusal that always fired would fail the '' rows.
const sess = { jarvis: false, project: 'acme-api', session: 'acme-api-2', label: 'acme-api-2' };
const jar = { jarvis: true, project: 'jarvis', session: 'master', label: 'Jarvis' };
const hears = { present: false, voice: { ready: true } };
const caps = { mic: true, audio: true };
const live = { name: 'acme-api-2', status: 'ready' };
is('a session can be talked to with no Jarvis set up', '', talkRefusal(sess, hears, live, caps));
is('...but Jarvis cannot', 'there is no Jarvis to talk to yet', talkRefusal(jar, hears, null, caps));
is('...and can once it is there', '', talkRefusal(jar, { ...hears, present: true }, null, caps));
is('a session gone from the grid says so by name', "'acme-api-2' is not on this fleet's grid any more", talkRefusal(sess, hears, null, caps));
is('a parked session says to resume it', true, /acme-api-2 is parked — resume it/.test(talkRefusal(sess, hears, { ...live, status: 'parked' }, caps)));
is('no answer from the Mac yet is not "voice is off"', true, /still asking the Mac/.test(talkRefusal(sess, null, live, caps)));
is('a Mac with no transcriber says why, for a session too', 'voice is off — no whisper', talkRefusal(sess, { voice: { ready: false, why: 'no whisper' } }, live, caps));
is('no microphone in this browser', 'this browser gives web apps no microphone', talkRefusal(sess, hears, live, { ...caps, mic: false }));
is('no Web Audio in this browser', 'this browser has no Web Audio to listen with', talkRefusal(sess, hears, live, { ...caps, audio: false }));
// JARVIS IS EXPERIMENTAL, and switched off it is GONE — not a band that says "off", not a
// talk button that refuses. Both directions, and the old-daemon case that sends no switch.
const jp = { present: true, project: 'jarvis' };
is('Jarvis off: no band', false, jarvisSurfaces(false, jp).bar);
is('...no Jarvis screen', false, jarvisSurfaces(false, jp).screen);
is('...and no talk button anywhere', false, jarvisSurfaces(false, jp).talk);
is('Jarvis on: the band is there', true, jarvisSurfaces(true, jp).bar);
is('...and talk', true, jarvisSurfaces(true, jp).talk);
is('...but no band before /api/jarvis answers', false, jarvisSurfaces(true, null).bar);
is('a daemon with no switch keeps the old behaviour', true, jarvisSurfaces(null, jp).bar && jarvisSurfaces(null, jp).talk);
is('a working session can be talked to (the prompt queues)', '', talkRefusal(sess, hears, { ...live, status: 'working' }, caps));

// ── 7. the column count, which is what makes rotation safe ────────────────
// gridColsFrom reads the USED value of grid-template-columns, so the keys agree with what
// the engine actually laid out rather than with a breakpoint copied into JS.
is('no grid -> one column', 1, gridColsFrom('none'));
is('empty -> one column', 1, gridColsFrom(''));
is('one track -> one column', 1, gridColsFrom('390px'));
is('two tracks -> two columns', 2, gridColsFrom('384px 384px'));
is('four tracks -> four columns', 4, gridColsFrom('298.5px 298.5px 298.5px 298.5px'));
is('extra whitespace is not a column', 2, gridColsFrom('  384px   384px  '));

console.log(rows.join('\n'));
