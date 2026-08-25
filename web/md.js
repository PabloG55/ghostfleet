// web/md.js — the markdown an assistant turn actually uses, as DOM.
//
// "the messages are not in nice .md format, they have the ****". turn() built its bubble
// with `text:`, which is textContent, so every turn on the phone was raw markup: literal
// asterisks around the emphasis, literal backticks around the code, `#` at the head of
// every section and `-` at the head of every bullet. The desk has never shown it that way
// — the pane is a rendered TUI — so the phone was the only surface reading the source.
//
// ── why this is hand-rolled, and small ────────────────────────────────────
// No library, and not because of taste: web/ is served under `default-src 'self'` with no
// build step and no npm dependency, so a markdown package is a CDN link the CSP refuses or
// a bundler this repo does not have. A parser is the smaller thing to own.
//
// ── nodes, not innerHTML, and this is where it parts from ansi.js ─────────
// ansi.js is the neighbouring problem — arbitrary bytes from a worker, turned into markup
// — and it builds a STRING and hands it to innerHTML, escaping on the one path text takes
// into the output. That is right for a pane: 269x65 cells repainted every two seconds is
// one assignment against tens of thousands of nodes, and it is measured.
//   A bubble is not that. It is a few hundred characters, repainted on the 5s poll, and
// the difference in cost is nothing — so this builds nodes, where the question of escaping
// does not arise at all. Text reaches the document only as createTextNode, and the one
// attribute this file ever sets is an href it has already checked. A transcript is
// untrusted input by definition: it contains whatever a worker printed, which is why the
// pane's version of this rule is written in capitals above its own escape table.
//
// PARSE IS PURE AND SEPARATE FROM THE DOM, which is what makes it testable in node with no
// browser at all — the same split grid.js has. parse() returns blocks; toDom() spends
// forty lines turning them into elements.
//
// ── the subset, and what it deliberately leaves out ───────────────────────
// Everything supported is something that has to stay right, so: fenced code, inline code,
// bold, italic, links, bullets, numbered lists, headings. That is already a lot for a chat
// bubble.
//
// NOT supported, on purpose: tables (no room at 390pt), images (a transcript's images are
// paths on another machine), blockquotes, nested lists, strikethrough, task lists, and any
// HTML in the source, which is text like everything else here.
//
// AND `_` IS NOT EMPHASIS. `*bold*` is, `_this_` is not, and that is a decision about THIS
// app's messages rather than about markdown: they are full of snake_case. `DATABASE_URL`,
// `sk_live_`, `fleet_send`, `next_before` — every one of those would turn into an italic
// run with its underscores eaten, and a mangled identifier is worse than a missed italic.

// ── inline ────────────────────────────────────────────────────────────────
// One scan, alternation ordered by precedence: code first, because nothing inside a code
// span is markup; then links, so a `*` inside a URL is not emphasis; then bold before
// italic, or `**a**` matches the italic rule twice and comes out as `*a*`.
//
// No lookbehind anywhere. It only reached Safari in 16.4, and an unsupported regex literal
// is a PARSE error — the whole client blank rather than one feature degraded — so the
// "not in the middle of a word" tests are done with a captured prefix character instead.
const INLINE = /(`+)([\s\S]*?)\1|\[([^\]]*)\]\(([^)\s]+)\)|\*\*(\S(?:[\s\S]*?\S)?)\*\*|\*([^\s*](?:[\s\S]*?\S)?)\*/g;
// ...and emphasis does not START IN THE MIDDLE OF A WORD. `2*3*4` is arithmetic and
// `a*b*c` is a glob, and reading either as emphasis deletes the asterisks — which is worse
// than a missed italic, because it changes what the message says. Checked on the character
// BEFORE the match rather than with a lookbehind, for the Safari reason above.

// A link is the one place this file writes an attribute, so it is the one place a
// transcript could reach something other than text. Only http and https: `javascript:`
// and `data:` are how a rendered message becomes a script, and a relative href would
// navigate the app away from itself.
export function safeHref(url) {
  const u = String(url || '').trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null;
}

export function inline(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  let at = 0;
  // THE WHOLE SCAN FIRST, then the recursion. INLINE is one shared object with /g on it,
  // so it carries a lastIndex — and this function recurses into itself for the contents of
  // bold, italic and a link's label. Recursing mid-scan resets that cursor under the loop
  // that is using it, and the outer scan then re-reads text it had already passed: not a
  // wrong answer, an infinite one. It ran the heap out in four seconds.
  const found = [];
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(src); m; m = INLINE.exec(src)) found.push(m);
  for (const m of found) {
    if (m.index > at) out.push({ t: 'text', text: src.slice(at, m.index) });
    if (m[1] != null) out.push({ t: 'code', text: m[2] });          // `code`, never recursed into
    else if (m[3] != null) {
      const href = safeHref(m[4]);
      // A link whose target this file will not follow is still a thing somebody wrote, so
      // it stays as its own words rather than disappearing.
      out.push(href ? { t: 'link', href, kids: inline(m[3]) } : { t: 'text', text: m[0] });
    } else if (/[A-Za-z0-9]/.test(src[m.index - 1] || '')) {
      out.push({ t: 'text', text: m[0] });        // intraword: the characters are the point
    } else if (m[5] != null) out.push({ t: 'bold', kids: inline(m[5]) });
    else out.push({ t: 'em', kids: inline(m[6]) });
    at = m.index + m[0].length;
  }
  if (at < src.length) out.push({ t: 'text', text: src.slice(at) });
  return out;
}

// ── blocks ────────────────────────────────────────────────────────────────
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

export function parse(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      // Everything up to the closing fence is CONTENT, including any markdown in it — a
      // block that showed its own examples rendered would be a block lying about the code.
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !(FENCE.test(lines[j]) && lines[j].trim()[0] === fence[1][0]); j++) body.push(lines[j]);
      blocks.push({ t: 'code', lang: fence[2] || '', text: body.join('\n') });
      i = j + 1;                                  // an unterminated fence ends at the end
      continue;
    }
    const head = HEADING.exec(line);
    if (head) { blocks.push({ t: 'heading', level: head[1].length, kids: inline(head[2]) }); i++; continue; }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = !BULLET.test(line);
      const items = [];
      for (; i < lines.length; i++) {
        const b = BULLET.exec(lines[i]), n = NUMBER.exec(lines[i]);
        if (ordered ? !n : !b) break;
        items.push(inline(ordered ? n[2] : b[1]));
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // A paragraph runs to the next blank line or the next block that starts one. Soft
    // line breaks are KEPT — an agent's turn is written in lines, and the bubble has
    // always been pre-wrap, so joining them would reflow work that was laid out.
    const para = [];
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || NUMBER.test(l)) break;
      para.push(l);
    }
    blocks.push({ t: 'para', kids: inline(para.join('\n')) });
  }
  return blocks;
}

// ── the DOM ───────────────────────────────────────────────────────────────
// Deliberately dull, and the only part of this file that needs a document. Text reaches
// the page through createTextNode and nowhere else.
const TAG = { bold: 'strong', em: 'em', code: 'code' };

export function toDom(blocks, doc) {
  const frag = doc.createDocumentFragment();
  const put = (parent, kids) => {
    for (const k of kids) {
      if (k.t === 'text') { parent.appendChild(doc.createTextNode(k.text)); continue; }
      if (k.t === 'link') {
        const a = doc.createElement('a');
        a.setAttribute('href', k.href);
        a.setAttribute('target', '_blank');
        // noopener because the opened page gets window.opener otherwise, and noreferrer
        // because a fleet's URLs are nobody else's business.
        a.setAttribute('rel', 'noopener noreferrer');
        put(a, k.kids);
        parent.appendChild(a);
        continue;
      }
      const n = doc.createElement(TAG[k.t] || 'span');
      if (k.t === 'code') n.appendChild(doc.createTextNode(k.text));
      else put(n, k.kids);
      parent.appendChild(n);
    }
  };
  for (const b of blocks) {
    if (b.t === 'code') {
      // WIDE CONTENT SCROLLS INSIDE ITS OWN BOX, and the page never scrolls sideways —
      // the rule the shell was built on (#48), and the one a code block is most likely to
      // break: a 90-column command in a 390pt bubble would otherwise push the whole chat
      // off the screen, header and composer with it. app.css gives .md-code overflow-x.
      const pre = doc.createElement('pre');
      pre.className = 'md-code';
      const code = doc.createElement('code');
      code.appendChild(doc.createTextNode(b.text));
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }
    if (b.t === 'heading') {
      // Not an <h1>. A heading inside a chat bubble is a LINE that is heavier than the
      // ones around it, not a document title — browser heading sizes would be bigger than
      // the message.
      const h = doc.createElement('div');
      h.className = 'md-h';
      put(h, b.kids);
      frag.appendChild(h);
      continue;
    }
    if (b.t === 'list') {
      const list = doc.createElement(b.ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      for (const item of b.items) {
        const li = doc.createElement('li');
        put(li, item);
        list.appendChild(li);
      }
      frag.appendChild(list);
      continue;
    }
    const p = doc.createElement('div');
    p.className = 'md-p';
    put(p, b.kids);
    frag.appendChild(p);
  }
  return frag;
}

export function render(text, doc) { return toDom(parse(text), doc); }

// The words, with every mark removed — what the reader ends up seeing, as a string.
// Used by the tests to assert the half that a "no asterisks" check cannot: that the TEXT
// is still there. Not used by speakable(), which does its own stripping from the source
// for the ear, and must go on doing so: one reading the other's output would mean fixing
// a rendering bug could silently change what the phone says out loud.
export function plain(blocks) {
  const words = (kids) => kids.map(k => (
    k.t === 'text' ? k.text : k.t === 'code' ? k.text : words(k.kids || [])
  )).join('');
  return blocks.map(b => (
    b.t === 'code' ? b.text
    : b.t === 'list' ? b.items.map(words).join('\n')
    : words(b.kids || [])
  )).join('\n');
}
