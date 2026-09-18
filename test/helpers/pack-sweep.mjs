#!/usr/bin/env node
// pack-sweep — no withheld name in what npm will actually SHIP.
//
// WHY THIS IS NOT THE SWEEP WE ALREADY HAVE. `name-sweep.mjs` reads `git ls-files`, and
// `npm pack` reads the WORKING DIRECTORY. Those are different sets, and the difference is
// not theoretical — measured, an untracked file dropped inside any directory named in
// package.json's `files` ships to the registry while the sweep that is supposed to guard
// the release can never see it. `prepublishOnly` runs the suite, so the release looked
// checked; it was checking a set that does not include what leaves.
//
// THAT IS THE SHAPE THIS REPO KEEPS REPEATING, and it is worth naming rather than fixing
// once more. #59 scrubbed the fixtures and #63 found the document those fixtures are an
// implementation OF — "the leak stayed open in the file that gets read the most, two PRs
// after it was declared closed". The tracked-file sweep was then silent about 37 branches
// live on the public remote. Every one of those guards checked a PROXY for the thing that
// ships. So this one asks npm what it will ship, and reads that.
//
// Run as a script it prints `name <US> want <US> got` rows like the other helpers; it exits
// non-zero only when it could not ask npm at all, because "nothing found" and "nothing
// looked at" must not share an exit status.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const US = '\x1f';
const rows = [];
const is = (n, w, g) => rows.push(`${n}${US}${w}${US}${g}`);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const { digest, candidates, DENY } = await import(
  pathToFileURL(path.join(ROOT, 'test/helpers/name-sweep.mjs')).href);
const hits = (s) => {
  const out = new Set();
  for (const line of String(s).split('\n'))
    for (const c of candidates(line)) if (DENY.has(digest(c))) out.add(c);
  return out;
};

// ASK NPM, do not reimplement its file selection. `files`, .npmignore, .gitignore and the
// always-included set interact in ways a reimplementation gets subtly wrong, and a subtly
// wrong list is exactly how this repo has leaked before: the checker and the artifact
// disagreeing while both look right.
let listed;
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  listed = JSON.parse(out)[0].files.map(f => f.path);
} catch (e) {
  // NOT A PASS. A release that could not be inspected is not a release that is clean.
  process.stdout.write(`could not ask npm what it ships${US}a file list${US}${String(e && e.message || e).slice(0, 120)}\n`);
  process.exit(1);
}

is('npm named the files it ships', 'true', String(listed.length > 0));

const dirtyContent = [], dirtyPath = [], untracked = [];
let tracked = new Set();
try {
  tracked = new Set(execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean));
} catch {}

for (const rel of listed) {
  if (hits(rel).size) dirtyPath.push(rel);
  if (!tracked.has(rel)) untracked.push(rel);
  let buf; try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch { continue; }
  if (buf.includes(0)) continue;                       // binary, by content not extension
  if (hits(buf.toString('utf8')).size) dirtyContent.push(rel);
}

is('no withheld name in a shipped FILE',  '', dirtyContent.join(' '));
is('no withheld name in a shipped PATH',  '', dirtyPath.join(' '));
// THE GAP ITSELF, named rather than merely closed. An untracked file in the tarball is not
// automatically wrong — but it is invisible to every other check in this repo, so it has to
// be looked at deliberately rather than shipped because nobody was watching that set.
is('nothing ships that git does not track', '', untracked.join(' '));

process.stdout.write(rows.join('\n') + '\n');
