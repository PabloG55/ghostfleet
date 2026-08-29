#!/usr/bin/env node
// test/helpers/name-sweep.mjs — no real project, client or employer name in the tree.
//
//     node test/helpers/name-sweep.mjs              # "name <US> want <US> got" rows
//     node test/helpers/name-sweep.mjs --digest foo # the line to paste to add a name
//
// WHY THIS EXISTS AND WHY IT IS NOT A ONE-TIME SWEEP. Roughly twenty comments named the
// projects that produced the fixes they document, and the repo has been public since
// August. Cleaning them once fixes today; the next comment somebody writes is the one that
// puts a name back, because naming the project is the natural way to write "this is where
// I saw it". A row that goes red is the only version of this rule that survives contact.
//
// WHY THE LIST IS DIGESTS AND NOT NAMES. A file containing the names would publish exactly
// what the sweep exists to remove, and worse than a comment does: a tidy, machine-readable
// roster of them in one place. test/helpers/doc-fixtures.mjs already wrote this down —
// "listing the retired names here would put them straight back into the public repo #59
// removed them from" — and chose membership over a blacklist for that reason.
//   Membership is the better shape and it is used where it fits: doc-fixtures asks whether
// an example name is IN web/fixtures/, which catches the NEXT name and not just the last
// one. It cannot work here. A comment legitimately contains most of English, so there is no
// vocabulary to be a member of, and a denylist is the only thing left.
//   So the names are stored one-way. BE CLEAR ABOUT WHAT THAT BUYS: these are short,
// guessable words, so anybody who already knows a name can confirm it by hashing it. This
// is not secrecy. It stops the repo from *publishing* the list — to a reader, to a search
// engine, to the npm tarball — which is the whole of what was asked for. Adding a name
// needs no name in the diff either: `--digest` prints the line to paste.
//
// WHAT IT SCANS. Every file git tracks, so nothing depends on a working copy's litter, and
// binary files are skipped by content rather than by extension.
//
// HOW IT MATCHES, and why it is structural rather than a substring search. The shortest
// entry on the list is three letters and must not fire inside an ordinary English word that
// contains it; a different name cannot be listed at all — measured, it is the ordinary
// English word in 41 of the 44 places it appears. So a line is split into
// alphanumeric runs, each run into its camelCase and letter/digit parts, and candidates are
// those parts plus adjacent runs re-joined with a hyphen. That catches `cf-name`, `name-1`,
// `NameHQ`, `name-06` and `someone@name.com` while `coincidence` yields only itself.
//   DEDUPED BEFORE HASHING. The tree holds a few hundred thousand tokens and only tens of
// thousands of distinct ones; hashing the distinct set keeps this at a few tens of
// milliseconds instead of seconds, which is the difference between a suite people run and
// one they skip.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

// The salt is public and only defeats a precomputed table — see the header on what this
// does and does not buy. Bump it and every digest below has to be regenerated.
const SALT = 'ghostfleet-name-sweep-v1:';
export const digest = (s) => crypto.createHash('sha256')
  .update(SALT + String(s).toLowerCase()).digest('hex').slice(0, 16);

if (process.argv[2] === '--digest') {
  const n = process.argv[3] || '';
  if (!n) { console.error('usage: name-sweep.mjs --digest <name>'); process.exit(2); }
  console.log(`  '${digest(n)}',   // ${n.length} chars`);
  process.exit(0);
}

// ── the list ──────────────────────────────────────────────────────────────
// Generated with --digest, so no name passed through a file to get here. The comment on
// each is its LENGTH and nothing else: enough to tell two entries apart in a diff, not
// enough to be a hint. The last one is a canary and is not a real name — section 3 plants
// it to prove the sweep can fail at all.
//   AND THE LIST IS ONLY EVER WHAT SOMEBODY THOUGHT OF. Three of these were found by
// reading a comment that was being edited for another reason, months after the sweep went
// in: the original list came from project names, and a branch name, a worktree name and a
// domain term are none of those. That is the standing weakness of a denylist and the reason
// doc-fixtures' membership test is the better shape wherever it fits. Add to this when you
// find one; `--digest` means doing so costs no name in the diff.
const DENY = new Set([
  'd376caa575c4bc6a',   // 7 chars
  'a273e332152a4cae',   // 8 chars
  '5e1e022d237aa135',   // 10 chars
  '65e8ae48ce5d577a',   // 5 chars
  '046662e80bba2b8c',   // 3 chars
  '82caa52ef67c665f',   // 15 chars
  '2d7f901e0f873bf2',   // 10 chars
  '75d33096e7f5f674',   // 3 chars
  '915ad1aa3a999f07',   // 7 chars
  '777db33fc5ef8fd9',   // 15 chars
  '05baf528e6b32f7b',   // 7 chars
  '569848378b3e0185',   // 8 chars
  'f4474b0cdf6815cf',   // 10 chars
  '108694849bc59a75',   // 8 chars
  'e3f9bc81c1589ace',   // 11 chars
  '78b387a29408bf7b',   // 7 chars
  'b195d79961285f67',   // 13 chars
  'b52ffb62b11c17d6',   // 7 chars
'b7b1d45c9dd780be',   // 5 chars
  '8cd4594d611fa412',   // 27 chars
  'f56266800c580984',   // 18 chars
  'CANARY',             // replaced in section 3
]);

// ── candidates from a line ────────────────────────────────────────────────
// Exported so section 3 can drive it directly: the tokenizer is where a sweep quietly goes
// blind, and "no names found" is what a broken tokenizer says just as fluently.
// The separator is written as an ESCAPE and not as a raw byte, and that is not cosmetic: a
// literal NUL in the source made git call this file binary and refuse to diff it, and made
// the sweep below skip its own source as binary. Found while adding a name to the list.
const CAMEL = /([a-z0-9])([A-Z])|([A-Z]+)([A-Z][a-z])|([A-Za-z])([0-9])|([0-9])([A-Za-z])/g;
const splitRun = (run) => run.replace(CAMEL, '$1$3$5$7\u0000$2$4$6$8').split('\u0000').filter(Boolean);
export function candidates(line) {
  const out = new Set();
  // Runs, with the gap to the next one, so `a@b.c` and `a-b` re-join and `a, b` does not.
  const runs = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(line))) runs.push({ text: m[0], at: m.index, end: m.index + m[0].length });
  for (let i = 0; i < runs.length; i++) {
    out.add(runs[i].text.toLowerCase());
    for (const part of splitRun(runs[i].text)) out.add(part.toLowerCase());
    // Adjacent runs separated by ONE character re-join: that one character is the `-`, `_`,
    // `.`, `@` or `/` that a name is spelled with. Up to four runs, because
    // `one-two-three-four` is a shape a project directory really has.
    let joined = runs[i].text;
    for (let j = i + 1; j < runs.length && j <= i + 3; j++) {
      if (runs[j].at - runs[j - 1].end !== 1) break;
      joined += '-' + runs[j].text;
      out.add(joined.toLowerCase());
    }
  }
  return out;
}

// ── 1. the tree ───────────────────────────────────────────────────────────
// EXEMPT, EXPLICITLY AND BY PATH — never by directory.
//   TWO CAPTURED PANES USED TO BE HERE, and their removal is this list working rather than
// this list shrinking. They were excluded "pending that decision"; the decision was taken
// and they were sanitised to the placeholder vocabulary the other nine captures already
// used. Section 2's still-contaminated assertion is what noticed: it went red on both the
// moment they were clean, which is the check asking for its own exemption to be deleted.
//   A path here is not a blanket pass. Section 2 asserts each one is STILL contaminated, so
// an exemption that has been dealt with turns red and asks to be deleted instead of
// quietly covering a file nobody has looked at in a year.
//   The third is not a comment either: it is the address CONTRIBUTING.md tells people to
// send a vulnerability report to. Where security mail goes is a decision about how this
// project is contacted, not a comment citing a case, so it is not something to rewrite in a
// cleanup pass — flagged, exempt, and left to the person whose inbox it is.
// EMPTY, AND THAT IS THE POINT. Every path that was here has been dealt with rather than
// permanently excused: two captured panes were sanitised, and CONTRIBUTING.md's security
// contact was replaced by GitHub's private vulnerability reporting, so there is no address
// in the tree to exempt. Section 2 asserted each entry was STILL contaminated, which is what
// turned each one red the moment it was fixed and asked for its own deletion.
const EXEMPT = [];

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
is('git lists the tracked files', true, tracked.length > 50);

// candidate -> "file:line", first sighting only. Deduped here, which is what keeps the
// hashing below to the distinct set rather than to every token in the repo.
const seen = new Map();
let scanned = 0;
const skipped = [];
for (const rel of tracked) {
  if (EXEMPT.includes(rel)) continue;
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }        // a symlink or a gone file
  if (buf.includes(0)) { skipped.push(rel); continue; }          // by CONTENT, not extension
  scanned++;
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const c of candidates(lines[i])) {
      if (!seen.has(c)) seen.set(c, `${rel}:${i + 1}`);
    }
  }
}
is('...and the sweep read them', true, scanned > 50);
// NAMED, NOT COUNTED. A NUL anywhere in a file makes this skip the whole file, and a bare
// count cannot tell "the four captured panes with escape sequences in them" from "a source
// file nobody is scanning any more" — which is exactly what happened to THIS file while the
// count read as healthy. Listing them means a new one has to be looked at.
const BINARY_EXPECTED = [
  'docs/img/pane-fit.png', 'docs/img/pane-permission-dialog.png',
  'docs/mobile/confirm.png', 'docs/mobile/grid.gif', 'docs/mobile/pane.gif',
  'docs/mobile/phone-demo.gif', 'docs/mobile/projects.png', 'docs/mobile/session.gif',
  'docs/mobile/statuses.png', 'docs/stack-demo.gif', 'docs/stack-demo.mp4',
  'docs/worktree-demo.gif', 'docs/worktree-demo.mp4',
  'web/icons/apple-touch-icon.png', 'web/icons/icon-192.png', 'web/icons/icon-512.png',
].sort().join(' ');
is('...skipping binaries by content, and naming them', BINARY_EXPECTED, skipped.sort().join(' '));
// ...and none of them is source. A .mjs or a .sh in that list is a file nobody is sweeping.
is('...none of which is source', '',
   skipped.filter(f => /\.(mjs|js|sh|json|md|ya?ml)$/.test(f) || /^bin\//.test(f)).join(' '));

const hits = [];
for (const [cand, where] of seen) if (DENY.has(digest(cand))) hits.push(where);
hits.sort();
// The ROW CARRIES THE LOCATION AND NOT THE NAME, so a failure is actionable without the
// failure itself reprinting what it is complaining about — in CI logs, which are public too.
is('no real project name in the tree', '', hits.join(' '));

// ── 2. the exemptions are live, not stale ────────────────────────────────
for (const rel of EXEMPT) {
  const abs = path.join(ROOT, rel);
  const there = fs.existsSync(abs);
  is(`exempt: ${rel} still exists`, true, there);
  if (!there) continue;
  let found = false;
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    for (const c of candidates(line)) if (DENY.has(digest(c))) { found = true; break; }
    if (found) break;
  }
  // Red when the file has been CLEANED: the exemption has done its job and is now cover.
  is(`...and still needs the exemption`, true, found);
}

// ── 3. the sweep can fail, and the tokenizer is not blind ────────────────
// THE CANARY IS NOT A REAL NAME. It is a listed token that exists only so the machinery can
// be driven in the direction that fails — a sweep whose only evidence is a clean tree looks
// exactly like a sweep with an empty list, or a broken tokenizer, or a typo in the salt.
//   Assembled from two pieces so the literal never appears as one token in this file, which
// would make section 1 flag the sweep itself.
const CANARY = ['notareal', 'projectname'].join('');
DENY.delete('CANARY');
DENY.add(digest(CANARY));

const caught = (line) => [...candidates(line)].some(c => DENY.has(digest(c)));
is('a planted name is caught', true, caught(`# seen once on ${CANARY} last week`));
is('...and an ordinary comment is not', false, caught('# the pane is the truth for "is it working"'));

// EVERY SPELLING A NAME ACTUALLY ARRIVES IN. Each of these is a shape that was really in
// the tree an hour ago — a socket, a numbered sibling clone, a directory-derived peer name,
// an address — so a tokenizer that handles the bare word and none of the rest would leave
// most of the leak in place while reporting a clean tree.
for (const [what, line] of [
  ['a bare word', `${CANARY}`],
  ['a socket', `cf-${CANARY}`],
  ['a numbered sibling', `${CANARY}-1`],
  ['a lettered sibling', `${CANARY}-xd`],
  ['a derived peer name', `${CANARY}-06`],
  ['an address', `${CANARY}/master`],
  ['a home path', `~/${CANARY}/.worktrees/foo`],
  ['an email', `someone@${CANARY}.com`],
  ['a camelCase suffix', `${CANARY}HQ`],
  ['a url', `https://github.com/${CANARY}/repo/pull/1`],
  ['inside prose', `it went unnoticed twice (${CANARY}, other).`],
]) is(`...caught as ${what}`, true, caught(line));

// ...and the other direction on the part that could over-fire. The shortest real entry is
// three letters, and a three-letter entry must not match inside a longer ordinary word —
// which is the whole reason this splits structurally instead of running a substring search.
//   DRIVEN WITH A SECOND CANARY, not with the real entry. Writing the real one here would
// put it back in the file the sweep is meant to keep clean — and it did: once the raw NUL
// was gone and this file could finally scan itself, its own header and this line were the
// first two hits it reported. `cid` is not a name, and it sits inside three real words.
const SHORT = ['c', 'i', 'd'].join('');
DENY.add(digest(SHORT));
for (const word of ['coincidence', 'incident', 'acidic', 'lucid']) {
  is(`...and "${word}" is not a hit`, false, [...candidates(word)].some(c => DENY.has(digest(c))));
}
is('...but a hyphenated one is', true, [...candidates(`${SHORT}-policy`)].includes(SHORT));
is('...and the canary is really on the list', true, DENY.has(digest(SHORT)));

console.log(rows.join('\n'));
