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
  ['localStorage', { getItem: () => null, setItem: noop, removeItem: noop }],
  ['addEventListener', noop],
  ['history', { length: 1, pushState: noop, replaceState: noop, back: noop, go: noop }],
  ['window', { isSecureContext: false }],
  ['navigator', {}],
  ['setInterval', () => 0],           // left real, this process would never exit
  ['location', { href: 'file:///', origin: 'null', protocol: 'file:', host: '', hostname: '' }],
]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// No fixture is read here; the probe must simply not reach the network.
globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

const { speakable } = await import(new URL('../../web/app.js', import.meta.url).href);
is('web/app.js exports speakable()', 'function', typeof speakable);

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
  ['a rooted path',   'The grid is at /Users/pgarces/gf-demo/acme-api now.',               '/Users/pgarces',                           'acme-api'],
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
is('a fenced block is named, not read', true, /code block/.test(speakable('before\n```\nrm -rf /\n```\nafter')));
is('...and its contents are gone', false, /rm -rf/.test(speakable('before\n```\nrm -rf /\n```\nafter')));
is('inline code keeps its text', 'run the suite first', speakable('run the `suite` first'));
is('a markdown link becomes its label', 'the design link says so', speakable('the [design](https://x.test/a/b.md) says so'));
is('a bare URL becomes "link"', true, / link /.test(speakable('see https://x.test/a/b.md for it')));
is('...and the URL is not read as a path', false, /b\.md/.test(speakable('see https://x.test/a/b.md for it')));
is('heading marks go', 'What changed', speakable('## What changed'));
is('bullet marks go', 'one two', speakable('- one\n- two'));
is('emphasis marks go', 'really not optional', speakable('**really** _not_ optional'));
const long = speakable('word '.repeat(600));
is('a long turn is capped', true, long.length <= 1250);
is('...and says that it goes on', true, long.endsWith('… and it goes on.'));
is('empty in, empty out', '', speakable(''));
is('null in, empty out', '', speakable(null));

console.log(rows.join('\n'));
