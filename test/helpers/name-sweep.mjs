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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
export const DENY = new Set([
  '91bd7c698252b8db',   // the identity a merge composed into two commits
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
  // ADDED 2026-09-18, and every one of these was found the same way: not by the sweep, but
  // by reading 28 pull request BODIES that were describing the earlier leaks and therefore
  // enumerated the names they had removed. The list only ever holds what somebody thought
  // of, and what somebody thought of was the tree — so a name that never appeared in a
  // tracked file was never added, and the prose about removing it stayed public for weeks.
  '191c13ecda83379e',   // 16 chars
  '1ebf617faac5cebd',   // 13 chars
  'f0e6c15464f8fc90',   // 13 chars
  'b810e389ad1cd42d',   // 12 chars
  'e0013b5c1d3e98a1',   // 12 chars
  '5785bdae238a877d',   // 12 chars
  '001ef18b21f55e4e',   // 12 chars
  '626df54a92b7c6a8',   // 4 chars
  'a40206b2f501cb94',   // 4 chars
  // ADDED 2026-09-26, from a sweep of the owner's machine rather than of anything written
  // down: every fleet, session, worktree, branch and folder name on it, minus ordinary
  // English and generic dev words, minus anything the tree already uses. Two leaks had
  // survived two history rewrites for the same reason as the batch above — an integration
  // name in a commit message, and demo data shaped on real work (an endpoint, branch names,
  // a record shape) — none of which was ever a PROJECT name, so nobody thought to list it.
  //   A NAME LONGER THAN FOUR PARTS is listed by its first four. `candidates()` re-joins at
  // most four runs, so the digest of a whole seven-part branch name could never match
  // anything; its first four parts are what the tokenizer actually produces, and are no
  // less distinctive. Sorted by digest, not by name, so the order carries no hint either.
  '0118cc505d0e9817',   // 20 chars
  '012c7ff7ab1faa57',   // 27 chars
  '016402fbf643ea1f',   // 29 chars
  '01d26d84d213fd45',   // 22 chars
  '02890f70c93f8600',   // 14 chars
  '032f68eca86b3015',   // 30 chars
  '037e55c059311cb7',   // 17 chars
  '04007f80d8d894a1',   // 27 chars
  '047b246c76c82c12',   // 26 chars
  '051e53e6467622b0',   // 24 chars
  '074af30dd84cadaa',   // 17 chars
  '076e9dd414c45571',   // 22 chars
  '079e35cd02b5441d',   // 21 chars
  '07c7417cd7b95dd2',   // 12 chars
  '09b408a379641e1b',   // 15 chars
  '09f31d1bc79a3fc4',   // 26 chars
  '0b35d0fb8a982737',   // 15 chars
  '0bbc3d44e6cc4177',   // 12 chars
  '0bcb5cf8eee547ad',   // 25 chars
  '0bdf73e4604bd605',   // 28 chars
  '0db20905a2f7d0c2',   // 37 chars
  '1040879d3c7de783',   // 23 chars
  '10804eef70bf85e2',   // 18 chars
  '11cf18b54c9ec79c',   // 32 chars
  '12174fbf8fc03e3f',   // 10 chars
  '12360b98ba2bbf8c',   // 21 chars
  '128385d333f928f8',   // 26 chars
  '12e9b94bcf6aea43',   // 23 chars
  '14c98eba3fded64b',   // 24 chars
  '14d1cb6bd7bc1784',   // 23 chars
  '14e6a167e8384cb3',   // 15 chars
  '14eb736c134318f3',   // 12 chars
  '14fca5b0602a275c',   // 24 chars
  '150822cc10026f35',   // 25 chars
  '154ebae20e986ca3',   // 20 chars
  '1592bbb9f532b4a5',   // 15 chars
  '18f1357baf763725',   // 23 chars
  '191b58af6a882266',   // 31 chars
  '1947275b7cca4531',   // 9 chars
  '19a7ee6f2883ea3e',   // 20 chars
  '1a33e1819dd93310',   // 28 chars
  '1a9eb64164b2a795',   // 25 chars
  '1b02b58702457c4d',   // 28 chars
  '1b65f81896791b82',   // 27 chars
  '1cf5746ae9aa01e7',   // 13 chars
  '1dd79a1a3466dcdb',   // 24 chars
  '1e127ddad7c64c57',   // 12 chars
  '1f053e05a9b1b9d9',   // 29 chars
  '1fc9215889a20bbb',   // 18 chars
  '20152c5b90627bdd',   // 16 chars
  '205e596e7c84f1c6',   // 15 chars
  '210bdb443dc1e197',   // 16 chars
  '216fea64d652be27',   // 25 chars
  '224ac2c942deab0a',   // 26 chars
  '2277f5f7e63a27eb',   // 35 chars
  '22d38137fd7ae487',   // 28 chars
  '238412a1fdc9f49a',   // 26 chars
  '253ccaad1d9e3c25',   // 31 chars
  '25d03ebfd12504fc',   // 22 chars
  '2858378642982e8b',   // 17 chars
  '295ec99f04733add',   // 23 chars
  '2daac53a8c516347',   // 27 chars
  '2db0cb1aa597da98',   // 32 chars
  '2dd670fae463a2c2',   // 27 chars
  '2e0ea52595370f40',   // 22 chars
  '3021fefa96fc2da7',   // 18 chars
  '305efed1e6c0c2fd',   // 12 chars
  '3069b31fd8d317a1',   // 25 chars
  '31b365d6f1d34bfc',   // 21 chars
  '31e34fce10ec571f',   // 22 chars
  '33822b5c68b29be0',   // 28 chars
  '34221fcaa349360f',   // 24 chars
  '3433333e17270482',   // 21 chars
  '34884d3fe491809f',   // 26 chars
  '35a2d44a26c537e6',   // 24 chars
  '36f83c1ac72a95ba',   // 27 chars
  '375ad28b0fb7d08b',   // 18 chars
  '375f25f2f897e38e',   // 7 chars
  '3861e8a27352552b',   // 15 chars
  '3a449882ed9d39fd',   // 21 chars
  '3ac073617faa2e5e',   // 30 chars
  '3ad488f78c7b57cb',   // 32 chars
  '3cb9790d27f502de',   // 24 chars
  '3e581b21db1f2bd5',   // 20 chars
  '3f793f5dfd429596',   // 31 chars
  '3fd1fe5fc4670a39',   // 12 chars
  '4027dbd626021271',   // 31 chars
  '40a6cd7664885683',   // 35 chars
  '41d82b8074a9f7e3',   // 20 chars
  '435a91b70cddcb4f',   // 26 chars
  '449829944da6009f',   // 11 chars
  '45f74ef6a5f1606b',   // 20 chars
  '461073ed5566427e',   // 15 chars
  '46376c8842427dad',   // 12 chars
  '46dfd0a7a95c00cc',   // 20 chars
  '4808e74a623ce248',   // 32 chars
  '497a8eb3711cf960',   // 11 chars
  '4b2ce3fc3ade0694',   // 24 chars
  '4d04421e26311c0f',   // 20 chars
  '4d1c493d2d0554fe',   // 28 chars
  '4d9d6a6b87ed8cff',   // 12 chars
  '4e5db1a207982ae1',   // 25 chars
  '4ec87e4f16b2ddd0',   // 20 chars
  '4edab9c6bb0aa1e4',   // 20 chars
  '4f6e932340dc22bd',   // 26 chars
  '50335864bfe963c9',   // 21 chars
  '50f2d3166e99be1b',   // 11 chars
  '52d869679381e736',   // 8 chars
  '536cb671546969af',   // 22 chars
  '54a5ed46eb747db4',   // 26 chars
  '54c00abaad82d87b',   // 20 chars
  '57640bb78f5bf239',   // 23 chars
  '58a07e52284dc15d',   // 27 chars
  '59c0bfb12320f0fc',   // 6 chars
  '59ee5cc2b3217f27',   // 28 chars
  '5a3e30856831998f',   // 9 chars
  '5b2be7c2d0b129a8',   // 24 chars
  '5d35bc368ae0afa5',   // 21 chars
  '5de69cc821887e3c',   // 11 chars
  '5e925761d7add677',   // 24 chars
  '5eae91677777e04b',   // 27 chars
  '5f2d8a194f7abf5b',   // 14 chars
  '5fdbe6c60d64ace2',   // 29 chars
  '603fbabed4f41e99',   // 19 chars
  '61c34c4c87cb4907',   // 34 chars
  '62b391b06c203b74',   // 16 chars
  '62fcd2ac8f826def',   // 26 chars
  '637a96567afbaf4d',   // 21 chars
  '6392d8799d49584c',   // 22 chars
  '642aa0a15e623ef4',   // 22 chars
  '6544fec04fcee166',   // 20 chars
  '65cb00de68b8fa35',   // 12 chars
  '66a4853776aa103c',   // 26 chars
  '6842dd1418c842fc',   // 9 chars
  '6865152404b66699',   // 17 chars
  '68f86367f629c9fc',   // 13 chars
  '6c224bf8db2a0a72',   // 21 chars
  '6e9590e0975b2a6d',   // 18 chars
  '6ea070fb77335428',   // 8 chars
  '6ef3f649c783dfe6',   // 30 chars
  '6f304098cbc8d329',   // 30 chars
  '704fae7fb60bd789',   // 26 chars
  '705adb00c01cc42d',   // 18 chars
  '70bc2e51aa3871d4',   // 22 chars
  '719b00cd891d9871',   // 26 chars
  '720944d3e1ae72c0',   // 26 chars
  '7251860761deafe6',   // 28 chars
  '729bd8dce36a655a',   // 35 chars
  '73adaf9815a9969a',   // 13 chars
  '74a06965dd554bca',   // 29 chars
  '74cd5ee5e1b89fbf',   // 30 chars
  '75811dda2fb488fd',   // 24 chars
  '75a195756c6e74f9',   // 17 chars
  '75ee5163ca4387b5',   // 14 chars
  '76651b3ac5169f81',   // 24 chars
  '779e45e5ffae20ea',   // 32 chars
  '782f457e9666289a',   // 12 chars
  '794f49c00e5106cd',   // 22 chars
  '7a10bf3cefb83eb3',   // 12 chars
  '7adad77de7c51804',   // 18 chars
  '7b7c2cda38f67857',   // 27 chars
  '7bbfb1c7fa62bb7d',   // 25 chars
  '7c30880410d80849',   // 23 chars
  '7c655b41c98149ee',   // 30 chars
  '7d07b1c7e2b651aa',   // 35 chars
  '7da14f176979e9b2',   // 20 chars
  '801b598e5694cd7f',   // 27 chars
  '8074ba2c86cdbbdd',   // 10 chars
  '80e21aa52261ab24',   // 24 chars
  '816e9d533f3ef981',   // 15 chars
  '833531f7e886e47c',   // 21 chars
  '835bdfcf44a54376',   // 17 chars
  '84410a830b56c920',   // 24 chars
  '849874e3de3438d1',   // 12 chars
  '85073b67172c2e1b',   // 14 chars
  '859aa3d61f5ff6bd',   // 24 chars
  '85f7fa1e8320f05a',   // 15 chars
  '86005fde4f51f27a',   // 26 chars
  '862577edebf3622b',   // 26 chars
  '8651da0d2a3e4ff7',   // 24 chars
  '881e03673b88bb3c',   // 22 chars
  '895deb6d2ca7bd42',   // 26 chars
  '89c827df40596a92',   // 22 chars
  '8a1e492a75cd809f',   // 25 chars
  '8a5f34aafd3aedbc',   // 27 chars
  '8b5a898142ce1510',   // 21 chars
  '8bd46ae5c551c32d',   // 27 chars
  '8c252cd3a8bc94c1',   // 20 chars
  '8d946089bcc162be',   // 22 chars
  '8db11643294a8b2b',   // 6 chars
  '8dbe737c9ee38ea0',   // 16 chars
  '8df7638fd5136c6f',   // 32 chars
  '8dfe2d25d771ce54',   // 23 chars
  '90964a3f16942234',   // 21 chars
  '9172c2490d1e2d86',   // 8 chars
  '92b0065ad5ffa460',   // 26 chars
  '942107ee1ae80c7a',   // 22 chars
  '945b7dc558985a53',   // 14 chars
  '9543d47ab28f6a04',   // 15 chars
  '9728074e0841c489',   // 23 chars
  '994f928b3810766f',   // 30 chars
  '995580a141bc743b',   // 19 chars
  '9aac3aa67b7da676',   // 27 chars
  '9ab45d22b824dc9d',   // 21 chars
  '9b1ab80f9cc3ebfc',   // 12 chars
  '9b2b51ac2f31c866',   // 17 chars
  '9cbdd20f278222f8',   // 26 chars
  '9d43e79e8319ce04',   // 28 chars
  '9fb59a5dced8401d',   // 23 chars
  '9fe64eee476cfe66',   // 15 chars
  'a2b9db596c1491de',   // 6 chars
  'a36d6bf3a705e0eb',   // 17 chars
  'a414c9034bfa836c',   // 10 chars
  'a484232aec286407',   // 19 chars
  'a49c5420624ce437',   // 19 chars
  'a58509c66163384e',   // 32 chars
  'a5b74d940b598fde',   // 22 chars
  'a6053247aa5377d5',   // 28 chars
  'a7204535bc76abad',   // 19 chars
  'a868ba0de7cb0f3d',   // 19 chars
  'a93642f63ae0785b',   // 19 chars
  'a9472b44e99205fb',   // 28 chars
  'a991c943fac39388',   // 27 chars
  'ad6dcd715fb3adcc',   // 22 chars
  'b00f06520b48f81c',   // 22 chars
  'b1852144dea69127',   // 22 chars
  'b186211b118ac716',   // 17 chars
  'b199fcbcc918c9af',   // 32 chars
  'b20294c962b30d8c',   // 26 chars
  'b2a3e9bf5c2a6e6f',   // 23 chars
  'b4c78e08adda908b',   // 25 chars
  'b4dbe57cb3ba5cd0',   // 23 chars
  'b5710f94d96cb4e4',   // 30 chars
  'b5c4014883e0e72f',   // 28 chars
  'b6827c7728c2851a',   // 27 chars
  'b77f348b7320a4c6',   // 17 chars
  'b7c5343afa840ef1',   // 22 chars
  'b8ac782ee201cef6',   // 29 chars
  'b9086d1774a01add',   // 25 chars
  'ba0d8eac517a6831',   // 23 chars
  'ba7163b0bd5aa874',   // 6 chars
  'bb5b9bc7a1ac4aee',   // 19 chars
  'bcf224ea61ebc0e4',   // 11 chars
  'bd40412a5c312fb3',   // 24 chars
  'bf1ba87fc5d9b58b',   // 23 chars
  'c00fef405a82d3f2',   // 23 chars
  'c18e7e171178f78a',   // 20 chars
  'c2a953828c6e3f57',   // 24 chars
  'c2ffef258f19c565',   // 32 chars
  'c43670e8b5a3f010',   // 18 chars
  'c53189b41ce57457',   // 28 chars
  'c90fea8d9a2e0021',   // 25 chars
  'c969cdd7bae2dd4e',   // 24 chars
  'c9fd0aeb5ed57c5c',   // 29 chars
  'ca7be16cda6ea060',   // 23 chars
  'ca91a9a34c29d66f',   // 18 chars
  'cb11f39031984066',   // 13 chars
  'cc44a892e8467799',   // 29 chars
  'cc8b876ca0e98e64',   // 23 chars
  'cccf98d99bae8b3b',   // 32 chars
  'cd8439616eb2e055',   // 21 chars
  'cdb352f5f998edb5',   // 26 chars
  'cde2097de0fdd0fb',   // 25 chars
  'cf41beabe0df394c',   // 26 chars
  'cf53e8f15d49d5f8',   // 4 chars
  'cfb8bcb4e0ea86dd',   // 25 chars
  'd0b8474578aa6681',   // 21 chars
  'd19153ab588ad2f0',   // 27 chars
  'd21058984a1ae92c',   // 28 chars
  'd40d11da495dcdf8',   // 16 chars
  'd4d23bc807dbae34',   // 4 chars
  'd65be86500bb636b',   // 8 chars
  'd7a84c9702314a51',   // 25 chars
  'd8b6901bc96b7284',   // 22 chars
  'd9e247e8a9b8add1',   // 14 chars
  'da84dce0817c9ab2',   // 22 chars
  'da973f5b1037e566',   // 31 chars
  'dbcd64c026cd83b6',   // 11 chars
  'dc16bbd9b4e354ed',   // 27 chars
  'dc7bfa10e1b8dea5',   // 26 chars
  'dd9675cc5f3d5f87',   // 22 chars
  'ddc0af384ac4e908',   // 20 chars
  'dde7a397a4b06e13',   // 15 chars
  'ddef632bf158277c',   // 19 chars
  'df7dca94bf058852',   // 11 chars
  'dfc72b38f38e9350',   // 16 chars
  'dfe862319d0541c8',   // 15 chars
  'e0a25ffff9e8bc07',   // 27 chars
  'e1404e9cf7cb0b3d',   // 12 chars
  'e16b6f7a82becb4b',   // 13 chars
  'e4f2438b198f2a3b',   // 12 chars
  'e5e5df38031c3c33',   // 28 chars
  'e649e611f24f88a0',   // 18 chars
  'e6c65351a4f8b00a',   // 12 chars
  'e7bc165485944ff6',   // 8 chars
  'e8a6f74a07b10eb2',   // 23 chars
  'e995966441563d68',   // 25 chars
  'eab0294e59c0a92e',   // 23 chars
  'eb08888fde030bf0',   // 15 chars
  'ec7d989eeae6e99f',   // 25 chars
  'ed37a90b8bcada1a',   // 20 chars
  'ed8d96046297aa10',   // 19 chars
  'edeb4e16a57dfb41',   // 23 chars
  'ee311bfe4ad8a63c',   // 35 chars
  'ef51652677a634c1',   // 19 chars
  'ef62406696c77af1',   // 22 chars
  'f0db0471b1d29bff',   // 26 chars
  'f1db78a0add81e6f',   // 25 chars
  'f2f2781ea5d84a73',   // 16 chars
  'f2fd6412be5ae437',   // 27 chars
  'f48425672f54cdb1',   // 20 chars
  'f6aad950f07457fd',   // 26 chars
  'f6d9dfe48e0711f5',   // 30 chars
  'f70821977cb8892d',   // 24 chars
  'f74000342c82b956',   // 27 chars
  'f801ed3b4f0e5d77',   // 22 chars
  'f9608e6148222b0a',   // 35 chars
  'f985a646f8778ca1',   // 19 chars
  'f98deca1d6f327f5',   // 24 chars
  'f9ba44c0ee970d22',   // 24 chars
  'f9c65ed96c89f0fc',   // 13 chars
  'f9fb333e042d6e67',   // 32 chars
  'fa2c22539bb70de8',   // 24 chars
  'fa54ee6a574ca450',   // 13 chars
  'fae29791d50230c7',   // 29 chars
  'fb2402fe03be9286',   // 17 chars
  'fda8bee8209aa515',   // 20 chars
  'feb3f7f64c4a3d6f',   // 13 chars
  'ff9272f522917d27',   // 12 chars
  'ffa73646e6556a10',   // 29 chars
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

// ── tailnet addresses ─────────────────────────────────────────────────────
// A NAME IS NOT THE ONLY THING THAT IDENTIFIES A MACHINE. A test fixture once carried the
// real tailnet address of the Mac it was written on, and it sat on the public tree for
// sixty-odd PRs and survived two history rewrites, because every guard here asked "is this
// a listed name" and an address is not a name. Nothing needed to be on a list to catch it:
// the whole of 100.64.0.0/10 is Tailscale's, so ANY address in it is either a documented
// example or somebody's real node. The same holds for a MagicDNS host — `<node>.<tailnet>.ts.net`
// names the tailnet — and for the IPv6 half, fd7a:115c:a1e0::/48.
//   So this is membership, the shape doc-fixtures prefers, turned around: the question is
// not whether an address is on a deny list but whether it is on THIS allowlist. That catches
// the next real address and not just the last one.
//   ADDING AN EXAMPLE HERE IS A DECISION, NOT A CHORE. A new doc or test that needs a tailnet
// address should reuse one of these. If it genuinely needs another, add it here, on purpose,
// in a diff somebody reads — and first confirm it is not the address of any machine you own,
// because the one this list exists to stop looked exactly like an example to everyone who
// read past it.
export const TAILNET_EXAMPLES = new Set([
  '100.64.0.0',         // the network address, as written in "100.64.0.0/10"
  '100.64.0.1',         // the low end of the range, in the bind-policy test
  '100.64.0.9',         // the serve config fixture's bind address
  '100.64.99.99',       // an in-range address no interface has, for check-bind
  '100.100.100.100',    // Tailscale's own MagicDNS resolver — public and documented
  '100.127.255.254',    // the high end of the range
  'fd7a:115c:a1e0::1',  // the IPv6 half, in the same bind-policy test
]);
// MagicDNS hosts. A label `example` anywhere passes on its own — box.example.ts.net is the
// style to copy, and no real tailnet is called that. The rest are the realistic-looking
// hosts already on the tree, each checked against the tailnet of the machine it was written
// on before it was listed; they are here because a width test needs a realistic length.
export const TS_NET_EXAMPLES = new Set([
  'mac.ts.net',
  'mac.tailnet.ts.net',
  'mac-studio.tail9f2c3b.ts.net',
  'mac-studio-2.tailfe8c.ts.net',
]);
const V4 = /(?<![\d.])100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;
const TSNET = /(?<![A-Za-z0-9-])((?:[A-Za-z0-9-]+\.)+ts\.net)(?![A-Za-z0-9-])/gi;
const V6 = /(?<![0-9a-f:])fd7a:115c:a1e0:[0-9a-f:]*[0-9a-f]/gi;
// The offending strings in `text`, so the hook can show you what you nearly pushed. The
// suite prints only the location, as it does for names — CI logs are public too.
export function tailnetHits(text) {
  const out = new Set();
  const s = String(text);
  if (s.includes('100.')) for (const m of s.matchAll(V4)) {
    const [a, b, c] = [+m[1], +m[2], +m[3]];
    if (a >= 64 && a <= 127 && b <= 255 && c <= 255 && !TAILNET_EXAMPLES.has(m[0])) out.add(m[0]);
  }
  if (/ts\.net/i.test(s)) for (const m of s.matchAll(TSNET)) {
    const h = m[1].toLowerCase();
    if (!h.split('.').includes('example') && !TS_NET_EXAMPLES.has(h)) out.add(h);
  }
  // The /48 prefix itself is public and never matches; anything past it is a node.
  if (/fd7a:115c:a1e0:/i.test(s)) for (const m of s.matchAll(V6)) {
    if (!TAILNET_EXAMPLES.has(m[0].toLowerCase())) out.add(m[0]);
  }
  return out;
}

// ── running as a script, or imported? ─────────────────────────────────────
// EVERYTHING BELOW IS THE SUITE'S CHECK, and it has two side effects that make a plain
// import unusable: it prints its rows to stdout, and section 3 ADDS a canary digest to
// DENY to prove the sweep can fail at all. `.githooks/pre-push` needs the tokenizer and
// the list and nothing else — so it imports this file, and importing must not run a test
// or grow the list it is about to check against. Guarding here keeps ONE tokenizer and
// ONE list in the repo: a hook that carried its own copy would be the "renderer nobody
// ships" shape, passing against a matcher that is not the one the suite proves.
const IS_MAIN = !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (IS_MAIN) {

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
//   THE LIST IS EMPTY, AND THAT IS THE POINT. The last entry was CONTRIBUTING.md, held back
// on the argument that where security mail goes is a decision about how the project is
// contacted rather than a comment to rewrite in a cleanup pass. The argument was sound and
// the conclusion was wrong: the decision did not need an address at all. GitHub's private
// vulnerability reporting opens the same private thread with no address to publish, so the
// exemption had nothing left to protect and its "still contaminated" assertion is what
// forced the question. An exemption is a debt, not a category.
const EXEMPT = [];

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
is('git lists the tracked files', true, tracked.length > 50);

// candidate -> "file:line", first sighting only. Deduped here, which is what keeps the
// hashing below to the distinct set rather than to every token in the repo.
const seen = new Map();
let scanned = 0;
const skipped = [];
// Tailnet addresses by "file:line", and the paths themselves — a file NAME is published
// exactly as its contents are, and until now only the pre-push hook ever read one.
const tailnet = [];
const badPaths = [];
for (const rel of tracked) {
  if (EXEMPT.includes(rel)) continue;
  if (tailnetHits(rel).size || [...candidates(rel)].some(c => DENY.has(digest(c)))) badPaths.push(rel);
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
    if (tailnetHits(lines[i]).size) tailnet.push(`${rel}:${i + 1}`);
  }
}
is('...and the sweep read them', true, scanned > 50);
// NAMED, NOT COUNTED. A NUL anywhere in a file makes this skip the whole file, and a bare
// count cannot tell "the four captured panes with escape sequences in them" from "a source
// file nobody is scanning any more" — which is exactly what happened to THIS file while the
// count read as healthy. Listing them means a new one has to be looked at.
// ── 4. a binary nobody read is not a binary nobody has to read ───────────
// NAMING THE SKIPPED FILES WAS NOT ENOUGH. The list below said "a new one has to be
// looked at", and for weeks nobody did: docs/img/pane-permission-dialog.png sat in the
// docs showing a real fleet header and a real session name, through six leak hunts, three
// history rewrites and two repo deletions. Every text guard was green the whole time,
// because every text guard skips it — and so does git-filter-repo's --replace-text, which
// is why two rewrites left it untouched. It was found by a human asking "did we get the
// gifs?" and by then opening the file.
//   SO THE LIST IS A REVIEW RECORD, not an inventory. Each entry is the digest of a file
// somebody has actually LOOKED AT and confirmed carries no withheld name. Change a binary
// or add one and this goes red with the digest to paste — which is the moment to open it
// and look, because nothing else in this repo can.
//   A DIGEST IS NOT A READING. This cannot tell whether an image is clean; it can only
// tell whether it is the same bytes as the one somebody vouched for. That is the whole of
// what is being claimed, and it is worth exactly as much as the look that preceded it.
const BINARY_REVIEWED = new Set([
  '2c785a8e51bcab64',   // docs/img/pane-fit.png
  '265c13b1e022d32c',   // docs/img/pane-permission-dialog.png
  '242a6f9c498399a1',   // docs/mobile/confirm.png
  '8b962f74b4b387eb',   // docs/mobile/grid.gif
  '391976337517eac8',   // docs/mobile/pane.gif
  '57f0372775587188',   // docs/mobile/phone-demo.gif
  'd6ea272da209deef',   // docs/mobile/projects.png
  'a8580058a434195a',   // docs/mobile/session.gif
  '4f2218f03a99a458',   // docs/mobile/statuses.png
  '07b65ab7235ca1d3',   // docs/stack-demo.gif
  'ef987172757ffd8c',   // docs/stack-demo.mp4
  '23ec45657a6e9e92',   // docs/worktree-demo.gif
  '6e433873d5794276',   // docs/worktree-demo.mp4
  '37954347dcba219e',   // web/icons/apple-touch-icon.png
  '3c5c79f7450c7e04',   // web/icons/icon-192.png
  '162cb00d56e8857e',   // web/icons/icon-512.png
]);
{
  const unreviewed = skipped.filter(f => {
    const b = fs.readFileSync(path.join(ROOT, f));
    return !BINARY_REVIEWED.has(crypto.createHash('sha256').update(b).digest('hex').slice(0, 16));
  });
  is('every skipped binary has been looked at', '', unreviewed.join(' '));
}

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
// Location only, as above. An address that belongs here is added to TAILNET_EXAMPLES on
// purpose — see the comment there — never by widening the pattern.
is('no tailnet address or MagicDNS host outside the examples', '', tailnet.join(' '));
is('...and none in a tracked file NAME, nor a withheld name', '', badPaths.join(' '));

// ── 1b. the commits, not just the tree ───────────────────────────────────
// A TREE CAN BE CLEAN WHILE ITS HISTORY IS NOT, and the history is what a clone publishes.
// Two things reach a public branch that no file in the tree records: the author/committer
// of every commit, and whatever a server-side merge composes into the message — GitHub's
// squash writes its own Co-authored-by trailers from the account's linked addresses, and
// that commit never passes through a local pre-push hook. Measured: two work addresses as
// author fields and two more as squash trailers, all behind a sweep that reported clean.
//   Runs on whatever history this clone has. CI's checkout is shallow, so on a push to
// staging it reads the one commit that push produced — which is exactly the merge commit
// GitHub composed, the one nothing else ever inspects. Locally it reads everything.
function commitHits(logText) {
  const out = new Set();
  for (const line of logText.split('\n')) for (const c of candidates(line)) if (DENY.has(digest(c))) out.add(c);
  return out;
}
let log = '';
try {
  log = execFileSync('git', ['-C', ROOT, 'log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', '-n', '2000', 'HEAD'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch {}
is('the history this clone has is readable', true, log.length > 0);
const badCommits = [];
for (const rec of log.split('\x1e')) {
  const f = rec.trim().split('\x1f');
  if (f.length < 6) continue;
  const body = f.slice(1).join('\n');
  if (commitHits(body).size || tailnetHits(body).size) badCommits.push(f[0].slice(0, 12));
}
// Location only, never the name — CI logs are public too.
is('no real name or tailnet address in any commit author, committer or message', '', badCommits.join(' '));

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
// ...and in the fields section 1b reads, which a tree sweep never saw. Both shapes a work
// identity actually took: an author address, and a trailer a squash merge composed.
is('a planted name in an AUTHOR address is caught', true,
   commitHits(`Jordan Doe\njdoe@${CANARY}.example\nGitHub\nnoreply@github.com`).size > 0);
is('a planted name in a squash Co-authored-by trailer is caught', true,
   commitHits(`Fix a thing (#12)\n\nCo-authored-by: someone <x@${CANARY}.example>`).size > 0);
is('...and a clean record is not', 0,
   commitHits('Fix a thing (#12)\n\nPabloG55\n1+PabloG55@users.noreply.github.com').size);
is('...and an ordinary comment is not', false, caught('# the pane is the truth for "is it working"'));

// THE TAILNET RULE, BOTH WAYS. The planted address and host are assembled from pieces for
// the canary's reason: as literals they would be the first thing section 1 reported.
const REAL_V4 = ['100', '101', '7', '42'].join('.');
const REAL_HOST = ['laptop', 'tail4c1e7a', 'ts', 'net'].join('.');
const REAL_V6 = ['fd7a:115c:a1e0', 'ab12', '4843', 'cd96', '6271'].join(':');
is('a real-looking tailnet address is caught', true, tailnetHits(`bind: ${REAL_V4}:8787`).has(REAL_V4));
is('...at the edge of a line, in a url', true, tailnetHits(`http://${REAL_V4}/`).size > 0);
is('...and a real-looking MagicDNS host', true, tailnetHits(`open https://${REAL_HOST}:8787`).has(REAL_HOST));
is('...and a node in the IPv6 half', true, tailnetHits(`addr ${REAL_V6}`).size > 0);
is('...and in a commit message', true, tailnetHits(`Fix the bind\n\nseen on ${REAL_V4} only`).size > 0);
is('...and in a file name', true, tailnetHits(`test/fixtures/serve-${REAL_V4}.json`).size > 0);
for (const ok of [...TAILNET_EXAMPLES, 'box.example.ts.net', ...TS_NET_EXAMPLES])
  is(`...but the example ${ok} passes`, 0, tailnetHits(`see ${ok} here`).size);
// The edges of 100.64/10, from the outside, and prose that only looks like an address.
for (const ok of ['100.63.255.255', '100.128.0.1', '10.100.64.1', 'version 1100.64.0.2',
                  'fd7a:115c:a1e0::/48', '*.ts.net', 'v100.64.0.1.2'])
  is(`...and "${ok}" is not a tailnet address`, 0, tailnetHits(ok).size);

// THE ORDINARY WORDS THE LIST WAS BUILT AROUND. The machine sweep that fed the last batch
// held these too — as folder and branch names — and they were left out as ordinary English
// or generic dev words. One of them reaching the list would turn the suite red on half the
// tree, so pin that they did not, rather than finding out from a sea of false positives.
//   ONLY WORDS THE TREE ALREADY USED ELSEWHERE. The excluded set came off a private machine
// too, and its rarer members say something about that machine even when they are English.
for (const word of ['master', 'main', 'docs', 'stack', 'proposal', 'research', 'spec',
                    'feat', 'chore', 'integration', 'library', 'desktop', 'downloads'])
  is(`...and the ordinary word "${word}" is not listed`, false, caught(`the ${word} here`));

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

}   // end IS_MAIN
