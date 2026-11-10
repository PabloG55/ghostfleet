// web/ui/speakable.js — what a reply SOUNDS like: the text a voice is handed, and the chunks it
// is handed in. Pure (no DOM, no catalog), so test/helpers/speak-check.mjs imports it as is.
//
// The assistant reads a lead's reply out loud (agent.js), and a reply is written for the eye:
// markdown, a sha, a path four directories deep, a table. Read as written, a 40-character sha is
// spelled one character at a time, most of a minute for a string nobody could write down from a
// speaker — reported from a phone as "it has a bunch of numbers and stuff that is not relevant".
//
// THE LINE IS NOT "NUMBERS ARE NOISE", and a normaliser that dropped every digit would be worse
// than doing nothing. It is ADDRESS versus FACT. An address is a thing you would have to READ to
// act on, so speech can only name it: say that a commit was involved, not which. A fact is a thing
// you act on BY EAR and it has to survive intact — "1885 passed, 0 failed" is the whole content of
// that sentence, and so are #1171, 2.1.241, 40% and 6s. speak-check.mjs asserts both directions.
//
// AND A LONG REPLY IS READ TO ITS END. A cap of a few hundred characters was the bug, twice: a
// 2059-character reply ended at "There… and it goes on." and its closing question, the thing the
// reply existed to ask, was never sent to the voice at all. Only a runaway turn (SPEAK_MAX, about
// twenty minutes of listening) is still cut, and the rest goes in chunks: one request each, so a
// reply of any length starts after one sentence's synthesis and stop means stop.
//
// The spoken words are a parameter. EN is the default, and voice.js passes the catalog's words
// for the language the app is speaking in.
export const EN = {
  code: 'Code omitted.', timestamp: 'a timestamp', id: 'an id', hex: 'a hex id', escape: 'an escape code',
  commit: 'a commit', link: '{label} link', theLink: 'the link', line: 'line', goesOn: '… and it goes on.',
};
const SPEAK_MAX = 20000;
// A left edge that cannot itself be part of an identifier, as a capturing group rather than a
// lookbehind: lookbehind only reached Safari in 16.4, and an unsupported regex literal is a PARSE
// error — the whole app blank, not one feature degraded.
const IDENT_EDGE = '(^|[^\\w./~@+-])';

function sayIdentifiers(t, w) {
  const pathSpoken = (p, line) => {
    // The basename is a NAME — usually what the sentence is about ("fixed fleet-grid") — and
    // everything left of it is the address. The line number stays: one short word by ear, and
    // the difference between "a bug in that file" and "a bug at that spot".
    const base = p.replace(/\/+$/, '').split('/').pop() || p;
    return line ? `${base} ${w.line} ${line.slice(1)}` : base;
  };
  // Most specific first, because the general patterns would eat the parts of these: the sha rule
  // matches the first block of a UUID, and the octal rule the tail of an escape.
  t = t.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, w.timestamp);
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, w.id);
  t = t.replace(/\b0x[0-9a-f]+\b/gi, w.hex);
  t = t.replace(/\\(?:x[0-9a-f]{2}|u\{?[0-9a-f]{4,6}\}?|[0-7]{2,3})/gi, w.escape);
  // A path, rooted (/a/b, ./a, ../a, ~/a) or relative with a dotted last segment (bin/x.mjs). The
  // dot is what keeps `@anthropic-ai/claude-code` and `feat/retry-backoff` whole: a package and a
  // branch are names you act on, and they read perfectly well aloud.
  t = t.replace(new RegExp(IDENT_EDGE + '((?:~|\\.{1,2})?\\/[\\w.@+~-]+(?:\\/[\\w.@+~-]+)*)(:\\d+)?(?::\\d+)?', 'g'),
                (m, pre, p, line) => pre + pathSpoken(p, line));
  t = t.replace(new RegExp(IDENT_EDGE + '([\\w.@+~-]+(?:\\/[\\w.@+~-]+)*\\/[\\w.@+~-]*\\.\\w+)(:\\d+)?(?::\\d+)?', 'g'),
                (m, pre, p, line) => pre + pathSpoken(p, line));
  t = t.replace(new RegExp(IDENT_EDGE + '([\\w.@+~-]*\\.\\w+):(\\d+)(?::\\d+)?', 'g'),
                (m, pre, f, n) => `${pre}${f} ${w.line} ${n}`);
  // A git sha. Below 12 characters it has to look like hex ON PURPOSE — at least one digit AND at
  // least one a-f — so "1234567" stays a number and "cabbage" stays a word. At 12 and up, nothing
  // that long is anything but an address.
  t = t.replace(new RegExp('(^|[^\\w.-])([0-9a-f]{7,40})(?![\\w.-])', 'g'),
                (m, pre, h) => (h.length >= 12 || (/\d/.test(h) && /[a-f]/.test(h))) ? pre + w.commit : m);
  // "1885 passed / 0 failed" is spoken "slash", which is a word that is not in the sentence.
  t = t.replace(/ \/ /g, ', ');
  return t;
}

export function speakable(text, w = EN) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, `\n${w.code}\n`);       // fenced code: named, not read
  t = t.replace(/`([^`]*)`/g, '$1');                        // inline code: the text, not the ticks
  t = t.replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+.*$/gm, ''); // [1]: url — a footnote's address
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, (m, label) => w.link.replace('{label}', label)); // [label](url)
  t = t.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1');       // [label][1] -> "label"
  t = t.replace(/<https?:\/\/[^>\s]*>/g, ` ${w.theLink} `);  // <url>, before the bare rule eats its >
  t = t.replace(/https?:\/\/\S+/g, ` ${w.theLink} `);       // and a bare one
  // HTML a reply carries for layout. Named tags only: `Array<string>` and `<= 3.5` are text.
  t = t.replace(/<\/?(?:br|p|div|span|b|i|em|strong|code|pre|kbd|sub|sup|details|summary|img|a|hr|ul|ol|li|table|tr|td|th)\b[^>]*>/gi, ' ');
  t = t.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');  // --- / *** / ___ rules
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '');               // blockquote marks
  t = t.replace(/~~[^~\n]+~~/g, '');                        // struck out is withdrawn: not said
  // A TABLE IS READ AS ITS CELLS: the rule row is pure punctuation, and a pipe read aloud is
  // "vertical bar" between every word. [ \t], never \s: under /m a \s* beside ^ or $ eats the line
  // break too, and the row runs into the next one with no stop between them.
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '');
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (m, cells) => cells.split('|').map(c => c.trim()).filter(Boolean).join(', '));
  // Emoji are decoration in writing and noise in speech. The joiner and the variation selector go
  // with them, or a family emoji leaves its glue behind.
  t = t.replace(/[ \t]*[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]+/gu, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');                // heading marks
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');                 // bullet marks
  t = t.replace(/^\[[ xX]\][ \t]+/gm, '');                 // a task list's box
  t = t.replace(/__([^_\n]+)__/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\W)[*_]([^*_]+)[*_](\W|$)/g, '$1$2$3');
  // AFTER the markdown pass, so a path inside backticks is a path by now and a URL is already "the
  // link"; BEFORE the cap, so the length is spent on words, not on an address nobody will hear.
  t = sayIdentifiers(t, w);
  // A LINE BREAK IS A SENTENCE END, and it survives the whitespace collapse as one: a list item has
  // no full stop, and the Mac's voice picks its language and its pause per sentence.
  t = t.replace(/([^\s.!?…:;,])[ \t]*\n\s*/g, '$1. ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > SPEAK_MAX ? t.slice(0, SPEAK_MAX).replace(/\s\S*$/, '') + w.goesOn : t;
}

// ── a long reply, in chunks ─────────────────────────────────────────────────────────────
// Cut at sentence ends only — a full stop FOLLOWED BY SPACE, so `fleet-grid.mjs` and `2.1.241` are
// never a boundary — then packed: short sentences fold together up to the cap, and a sentence
// longer than the cap is cut at a clause mark, then at a space, never inside a word. One unbroken
// token longer than the cap stays whole: it is one word. The device's own voice gets the same
// chunks, one utterance each, because one long utterance is what WebKit's speechSynthesis is known
// to drop partway.
export const CHUNK_MAX = 600;
const CHUNK_ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Sr|Sra|approx|p\.ej)\.$/i;
function sentencesOf(t) {
  const out = [], re = /[.!?…]+["')\]]*(\s+|$)/g;
  let from = 0, m;
  while ((m = re.exec(t))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const end = m.index + m[0].length;
    const piece = t.slice(from, m.index + m[0].length - m[1].length);
    if (CHUNK_ABBREV.test(piece) && end < t.length) continue;   // "e.g. this" is one sentence
    out.push(piece.trim()); from = end;
  }
  if (from < t.length) out.push(t.slice(from).trim());
  return out.filter(Boolean);
}
// A sentence over the cap, cut at the last clause mark that leaves a real piece, else at the last
// space; the remainder goes round again.
function cutLong(x, max) {
  const out = [];
  while (x.length > max) {
    let at = -1;
    for (const mark of [/[,;:—–]\s/g, /\s/g]) {
      let m, best = -1;
      mark.lastIndex = 0;
      while ((m = mark.exec(x)) && m.index < max) best = m.index + m[0].length - 1;
      if (best >= max / 4) { at = best; break; }
    }
    if (at < 0) { const sp = x.indexOf(' ', max); if (sp < 0) break; at = sp; }   // one long word: kept whole
    out.push(x.slice(0, at).trim()); x = x.slice(at).trim();
  }
  if (x) out.push(x);
  return out;
}
export function speechChunks(text, max = CHUNK_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let cur = '';
  for (const sen of sentencesOf(t)) {
    for (const piece of sen.length > max ? cutLong(sen, max) : [sen]) {
      if (cur && cur.length + 1 + piece.length > max) { out.push(cur); cur = ''; }
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  // A chunk with no letter or digit in it ("…") has nothing to say, and the Mac answers one with a
  // 400 that would read as its voice failing.
  return out.filter(x => /[\p{L}\p{N}]/u.test(x));
}
