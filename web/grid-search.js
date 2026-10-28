// ── finding an agent by typing part of its name ─────────────────────────────
// Pure, and in lib/ rather than inside bin/fleet-grid.mjs, so every screen that lists
// sessions answers "which cards does `bil` mean" the same way the desk does. Two screens
// with two matchers is two answers to one question, and the second one is always found by
// somebody typing a name into it.
//   THE BROWSER'S GRID USES THIS FILE TOO, AS web/grid-search.js — a byte-for-byte copy,
// because a browser can only fetch what is under web/. The copy goes that way round and
// not the other: making this file re-export from web/ was tried, and the desk's grid then
// failed to start anywhere bin/ and lib/ are copied without web/ (the suite builds several
// such runtimes). test/run.sh holds the two files identical, so the copy cannot drift.
//
// A card matches on what it SHOWS and on what you TYPE elsewhere: its label (the title a
// human gave it, when it has one) and its session name (what fleet-send and fleet-read
// take). Searching only the label would lose every labelled card to anyone who knows it
// by name, and searching only the name would lose them to anyone reading the screen.
// Case-insensitive substring, nothing cleverer: the query is typed one key at a time and
// re-run on every key, and a fuzzy rank that reorders as you type moves the cursor under
// you.

const norm = (s) => String(s ?? '').toLowerCase();

// Does this card ({ label, name }) answer to `query`? An empty query matches nothing:
// "/" with nothing typed yet is a prompt, not a search for everything.
export function agentMatches(card, query) {
  const q = norm(query);
  if (!q || !card) return false;
  return [card.label, card.name].some(s => s && norm(s).includes(q));
}

// Indices of the entries in `list` that match, in list order — which is grid order, so
// "the first match" is the first one the eye reaches. `pick` turns an entry into its
// card, or into nothing for an entry that is not a session (a free worktree, `+ new`):
// those are never matches, because there is no agent there to find.
export function matchIndices(list, query, pick = (x) => x) {
  const out = [];
  (list || []).forEach((x, i) => { if (agentMatches(pick(x), query)) out.push(i); });
  return out;
}

// The next (dir > 0) or previous match from position `from`, wrapping at either end.
// `from` need not be a match itself — the cursor can have been moved off one by hand,
// and n from there means "the next one after where I am", not "the one after the last n".
// -1 when there is nothing to move to.
export function stepMatch(matches, from, dir) {
  if (!matches || !matches.length) return -1;
  if (dir > 0) return matches.find(i => i > from) ?? matches[0];
  for (let k = matches.length - 1; k >= 0; k--) if (matches[k] < from) return matches[k];
  return matches[matches.length - 1];
}

// Where `query` first lands in `text`, as [start, end) string offsets for drawing it, or
// null. Offsets are into `text` as given, so a caller can slice the very string it drew.
// A character whose lower case is a different LENGTH (a handful in Unicode, `İ` the
// usual one) would shift every offset after it; for those this declines to point rather
// than mark the wrong letters. The card still matches — only the mark is skipped.
export function matchSpan(text, query) {
  const t = String(text ?? ''), q = norm(query);
  if (!q) return null;
  const lt = norm(t);
  if (lt.length !== t.length) return null;
  const at = lt.indexOf(q);
  return at < 0 ? null : [at, at + q.length];
}
