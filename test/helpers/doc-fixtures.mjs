#!/usr/bin/env node
// test/helpers/doc-fixtures.mjs — the docs' example data names sessions that exist.
//
//     node test/helpers/doc-fixtures.mjs     # one "name <US> want <US> got" row per name
//
// #59 replaced the phone client's demo fixtures — they had been the repo owner's real
// project and session names, shipped in a public package — and #60 re-shot the seven
// images that render them. What neither touched was docs/mobile.md, the document those
// fixtures are an implementation OF: its §4 payload, its `--plain` sample, its cards and
// its confirmations all still spelled the old names. So the leak stayed open in the one
// file that is read the most, and the spec and the fixtures now disagreed about what the
// app renders — with nothing anywhere to say so.
//
// Both halves of that are the same failure: a doc's example data has no compiler. It
// cannot 404, it cannot fail to parse, and a name that no longer exists reads exactly
// like one that does. The only thing that catches it is asking the fixtures.
//
// So: every name these documents put in a NAMING POSITION — a `"project"`/`"name"`/
// `"folder"` value in a payload sample, a `╭─ 2 api-fix ─╮` card title, `kill session
// 'x'?`, a row of the `--plain` table, a `cf-<project>` socket, a `~/gf-demo/<x>` path —
// must be a project, session, worktree or branch that web/fixtures/ actually contains.
//
// Two scoping decisions, both deliberate:
//
//   - **Only docs/mobile.md and web/README.md.** bin/, hooks/, mcp/ and test/run.sh keep
//     real project names on purpose: they are war stories about fleets that existed, and
//     a tmux socket name in a comment is evidence, not a demo. Renaming those would be
//     deleting the reason a rule is there. These two files are different — they describe
//     what the client SHOWS, so their examples are the fixtures or they are wrong.
//   - **Membership, never a blacklist.** Listing the retired names here would put them
//     straight back into the public repo #59 removed them from — and would only ever
//     catch the leak that already happened. Asking "is this in web/fixtures/" catches the
//     next one too.
//
// In prose a name is only recognisable by its shape, so a backticked token is checked
// when it is kebab-cased (`rate-limit`) and left alone otherwise: a one-word check would
// have to allowlist most of English before it could flag `koji`. Inside the example data
// — where every name that has ever drifted has lived — position does the work and the
// shape rule is not used at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The two files whose examples ARE the fixtures.
const DOCS = ['docs/mobile.md', 'web/README.md'];

// ── 1. what web/fixtures/ actually contains ───────────────────────────────
// Read out of the fixtures rather than restated here, because a second list of the
// names is a second thing to keep in step — the exact failure this file exists for.
const FIXDIR = path.join(ROOT, 'web', 'fixtures');
const FIXTURE = new Set();       // every name a doc may use
const PROJECTS = new Set();      // for the `cf-<project>` socket check
const add = v => { if (typeof v === 'string' && v) FIXTURE.add(v); };

for (const f of fs.readdirSync(FIXDIR).filter(f => f.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(FIXDIR, f), 'utf8'));
  if (j.project) { add(j.project); PROJECTS.add(j.project); }
  if (j.session) add(j.session);
  if (j.profile) add(j.profile);
  for (const c of j.cards || []) {
    add(c.name); add(c.folder); add(c.branch); add(c.label);
  }
  for (const w of j.free_worktrees || []) { add(path.basename(w.path)); add(w.branch); }
  for (const p of j.projects || []) {
    add(p.name); add(p.profile); add(p.socket); add(path.basename(p.path));
    PROJECTS.add(p.name);
  }
  for (const c of j.checkouts || []) add(path.basename(c));
  for (const r of j.roots || []) add(path.basename(r));
  for (const s of Object.keys(j.sessions || {})) add(s);
}
// A project's sibling checkouts are named for it — `acme-api-3` is the third worktree of
// `acme-api` — and the fixtures only carry the ones that happen to be live. The pattern
// is the fixture, so the doc may use it.
const sibling = t => { const m = /^(.+)-\d+$/.exec(t); return !!m && PROJECTS.has(m[1]); };

// ── 2. what is not a fleet name at all ────────────────────────────────────
// Derived from the tree wherever it can be — a helper, a bin command and a status are
// all things that already exist somewhere checkable, and a hand-written list of them
// would go stale the first time one is renamed. The literals below are the remainder:
// vocabulary from tmux and CSS that happens to be kebab-cased.
const VOCAB = new Set(['capture-pane', 'font-weight', 'apple-touch-icon',
  // ...and the web platform's own kebab-cased vocabulary, which reads exactly like a
  // session name to a rule that can only judge by shape.
  'aria-label', 'aria-pressed', 'prefers-reduced-motion', 'safe-area-inset', 'overflow-wrap']);
for (const d of ['bin', 'hooks', 'mcp', 'test/helpers', 'web', 'docs', 'tmux', 'layouts', 'scripts']) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(ROOT, d)); } catch { continue; }
  for (const e of entries) VOCAB.add(e.replace(/\.[^.]+$/, ''));
}
// The nine statuses are kebab-cased (`need-you`) and are named all over both documents.
const grid = await import(new URL('../../web/grid.js', import.meta.url).href);
for (const s of grid.STATUSES) VOCAB.add(s);
// The markers the grid writes, which §4 and the verb table both name.
for (const m of ['notify-lead', 'fleet-client', 'fleet-server']) VOCAB.add(m);

// ── 3. pull the names out of a document ───────────────────────────────────
// Positional first: inside a payload sample, a card or a confirmation there is no doubt
// what a token is, so nothing is filtered by shape and a bare `oldname` is caught as
// readily as `old-name`.
function namesIn(src) {
  const hits = [];
  const hit = (tok, where, vocabOk = false) => {
    tok = String(tok || '').trim();
    if (!tok || tok.includes('…') || tok.includes('<')) return;   // a placeholder, not a name
    hits.push({ tok, where, vocabOk });
  };

  // a §4 payload sample: the keys that carry a name
  for (const m of src.matchAll(/"(project|name|folder|session|profile|branch)"\s*:\s*"([^"]*)"/g)) hit(m[2], `"${m[1]}"`);
  for (const m of src.matchAll(/"path"\s*:\s*"([^"]*)"/g)) hit(path.basename(m[1]), '"path"');
  // a card, as cardLines() draws it: the title line, then the worktree on line 2
  for (const m of src.matchAll(/^╭─ (?:\d+ )?(.+?) ─*╮/gm)) {
    if (m[1].startsWith('+')) continue;                            // the `+ new session` card
    hit(m[1], 'a card title');
  }
  for (const m of src.matchAll(/^│ ([a-z0-9][a-z0-9-]*) · /gm)) hit(m[1], "a card's worktree line");
  // the TUI's confirmations, reproduced (§7)
  for (const m of src.matchAll(/\b(session|worktree) '([^']+)'/g)) hit(m[2], `${m[1]} '…'`);
  // a fleet socket names its project
  for (const m of src.matchAll(/\bcf-[a-z0-9][a-z0-9-]*/g)) hit(m[0], 'a fleet socket', true);
  // a path into the demo checkouts
  for (const m of src.matchAll(/gf-demo\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) hit(m[1], 'a checkout path');
  // `~/<x>` — a home directory that is a project is a project being named
  for (const m of src.matchAll(/~\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) hit(m[1], 'a home path', true);
  // the --plain table: TAB and CHECKOUT, for as long as the rows run
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^TAB\s+CHECKOUT\s+BRANCH\b/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const f = lines[j].trim().split(/\s{2,}/);
      if (!lines[j].trim() || lines[j].startsWith('```') || f.length < 3) break;
      hit(f[0], '--plain TAB'); hit(f[1], '--plain CHECKOUT');
    }
  }
  // prose: only what is shaped like a fleet name (see the header)
  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(t)) hit(t, 'named in prose', true);
  }
  return hits;
}

// ── 4. one row per name, so the vetting is visible and countable ──────────
for (const doc of DOCS) {
  const hits = namesIn(read(doc));
  const seen = new Map();
  for (const h of hits) if (!seen.has(h.tok)) seen.set(h.tok, h);
  for (const [tok, h] of [...seen.entries()].sort()) {
    const ok = FIXTURE.has(tok) || sibling(tok) || (h.vocabOk && VOCAB.has(tok));
    is(`${doc} names '${tok}' (${h.where})`, 'in web/fixtures/', ok ? 'in web/fixtures/' : 'nowhere in web/fixtures/');
  }
  // A scanner that matches nothing is indistinguishable from a document with nothing
  // wrong in it, and both print the same "no mismatches". The floor is what tells them
  // apart — the same reason test/run.sh puts one under every helper's row count.
  is(`${doc}: the scan found names to check`, 'yes', seen.size >= 5 ? 'yes' : `no: ${seen.size}`);
}
// And the fixtures have to have been read at all: an empty FIXTURE set would call every
// name unknown, which fails loudly — but a set built from a MOVED directory would be
// empty too, and `readdirSync` on a missing path throws before it can lie.
is('the fixture names were read', 'yes', FIXTURE.size >= 20 ? 'yes' : `no: ${FIXTURE.size}`);

console.log(rows.join('\n'));
