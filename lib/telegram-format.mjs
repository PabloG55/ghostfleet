// lib/telegram-format.mjs — an agent's markdown, as messages Telegram will show.
//
// A turn's final message is GitHub-flavoured markdown, and Telegram renders none of it as
// such: sent raw, a reply arrives as asterisks, pound signs and backticks. Telegram's own
// "MarkdownV2" is worse than nothing for text nobody wrote for it — eighteen characters must
// be escaped everywhere, and one unescaped `.` or `-` makes the API refuse the WHOLE message,
// which on this path is an answer the owner never gets. So the markdown is converted to the
// small HTML subset Telegram does render (b, i, s, code, pre, a, blockquote), where only
// `<`, `>` and `&` need escaping and a mistake degrades instead of failing.
//
// AND SPLIT, because a message is at most 4096 characters and a long answer is not. Split
// BEFORE converting, on the markdown's own boundaries — a blank line, then a line, then a
// space — so a chunk never ends inside a tag it opened, and never inside a code block: a
// fence that has to be split is closed at the end of one chunk and reopened in the next.
// A chunk that still converts to more than the limit (escaping grows `&` five-fold) is
// split again, smaller, rather than cut.
//
// Node builtins only, and no I/O: bin/fleet-telegram.mjs sends, test/run.sh asserts.

export const TELEGRAM_LIMIT = 4096;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// Inline markup within one line of prose. Code spans are cut out first so nothing inside
// them is read as emphasis, then put back escaped.
function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  const links = [];
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => { links.push([t, u]); return `\u0001${links.length - 1}\u0001`; });
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
       .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
       .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
       .replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1<i>$2</i>')
       .replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, '$1<i>$2</i>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<a href="${escAttr(links[i][1])}">${esc(links[i][0])}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

// One chunk of markdown to Telegram HTML.
export function toTelegramHtml(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null, buf = [], quote = [];
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = []; } };
  for (const line of lines) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(fence ? `<pre><code class="language-${escAttr(fence)}">${esc(buf.join('\n'))}</code></pre>`
                       : `<pre>${esc(buf.join('\n'))}</pre>`);
        fence = null; buf = [];
      } else buf.push(line);
      continue;
    }
    const f = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (f) { flushQuote(); fence = f[1] || ''; continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { quote.push(inline(q[1])); continue; }
    flushQuote();
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push(`<b>${inline(h[1])}</b>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('──────'); continue; }
    // A table has no rendering here; its rows are kept as monospace text, which lines up.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      out.push(`<code>${esc(line.trim())}</code>`); continue;
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) { out.push(`${' '.repeat(Math.min(li[1].length, 6))}• ${inline(li[2])}`); continue; }
    out.push(inline(line));
  }
  flushQuote();
  // An unclosed fence (the chunker closes its own; this is the model's) is still code.
  if (fence !== null) out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The same text with no markup at all: what is sent when Telegram refuses the HTML.
export function toPlain(md) {
  return String(md ?? '').replace(/\r\n?/g, '\n').replace(/^\s*```[^\n]*$/gm, '').trim();
}

// Split markdown into pieces of at most `max` characters, on the best boundary available,
// never leaving a code fence open across a cut.
export function splitMarkdown(md, max = 3500) {
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  if (text.length <= max) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let cur = [], len = 0, fence = null;          // fence: the opening line of an open block
  const push = () => {
    if (!cur.length) return;
    if (fence !== null) cur.push('```');
    chunks.push(cur.join('\n'));
    cur = fence !== null ? [fence] : []; len = cur.length ? fence.length + 1 : 0;
  };
  for (let line of lines) {
    // A single line longer than a chunk: cut it at a space where there is one.
    while (line.length > max - 8) {
      let at = line.lastIndexOf(' ', max - 8);
      if (at < max / 2) at = max - 8;
      const head = line.slice(0, at);
      if (len + head.length + 1 > max - 4) push();
      cur.push(head); len += head.length + 1; push();
      line = line.slice(at).replace(/^ /, '');
    }
    // Prefer to cut at a blank line once the chunk is mostly full.
    if (len + line.length + 1 > max - 4 || (line.trim() === '' && fence === null && len > max * 0.85)) push();
    const isFence = /^\s*```/.test(line);
    cur.push(line); len += line.length + 1;
    if (isFence) fence = fence === null ? line.trim() : null;
  }
  if (cur.length && cur.some((l) => l.trim() !== '' && l !== fence)) {
    if (fence !== null && !/^\s*```\s*$/.test(cur[cur.length - 1])) cur.push('```');
    chunks.push(cur.join('\n'));
  }
  return chunks.filter((c) => c.trim() !== '');
}

// Markdown to the messages that carry it: [{ html, plain }], each html within the limit.
export function telegramChunks(md, limit = TELEGRAM_LIMIT) {
  const out = [];
  const take = (piece, max) => {
    const html = toTelegramHtml(piece);
    if (html.length <= limit || max < 200) {
      out.push({ html: html.slice(0, limit), plain: toPlain(piece).slice(0, limit) });
      return;
    }
    for (const p of splitMarkdown(piece, Math.floor(max / 2))) take(p, Math.floor(max / 2));
  };
  for (const piece of splitMarkdown(md, Math.min(3500, limit - 96))) take(piece, Math.min(3500, limit - 96));
  return out.length ? out : [{ html: '', plain: '' }];
}
