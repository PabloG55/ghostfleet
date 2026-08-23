#!/usr/bin/env node
// A stand-in for tmux <= 3.5, so its output escaping can be tested on a machine running
// 3.7b. Runs the REAL tmux and then vis-escapes stdout the way tmux <= 3.5 did.
//
//     node tmux-vis35.mjs <real-tmux> <args…>
//
// WHY THIS EXISTS. tmux <= 3.5 pushed every byte of command output through vis(3) —
// utf8_strvis() with VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH, called from
// server_client_print() via cmdq_print_data(item, 0, …). tmux 3.6 stopped, by passing
// parse=1 unconditionally in cmd-queue.c. So a `\x1f` separator inside a `-F` format
// comes back as the four literal characters `\037` on 3.4/3.5 and as the raw byte on
// 3.6+, and Ubuntu 24.04's apt tmux is 3.4 while Homebrew's is 3.7b.
//
// Without this, the fix for that is UNTESTABLE where it is developed: on tmux 3.7b a
// tab and a \x1f separator behave identically, so the assertion would pass either way —
// which is the same as having no assertion. The suite proves the shim really mangles
// before it trusts what the shim proves.
//
// WHAT IT MODELS, from tmux 3.4's compat/vis.c + utf8.c:
//   * valid UTF-8 sequences pass through untouched (utf8_strvis walks codepoints)
//   * `$` before an alpha, `_` or `{` gains a backslash  (utf8_strvis, verbatim)
//   * isgraph ASCII, space, tab and newline pass through — isvisible() says so, because
//     VIS_SP / VIS_TAB / VIS_NL are NOT in the flag set. THIS is why a tab survives.
//   * \a \b \v \f \r \0 become their C escapes                (VIS_CSTYLE)
//   * every other byte becomes \NNN octal                     (VIS_OCTAL)
//   * a backslash is NOT doubled                              (VIS_NOSLASH)
// The last one is why "just un-escape it again" is not a fix: with no doubling, a
// literal `\037` in the data is indistinguishable from an escaped 0x1f.
//
// stderr and the exit status are passed through untouched — the grid decides "is there a
// server" from tmux's exit status, and a shim that swallowed it would change behaviour
// it is not supposed to be testing.
import { spawnSync } from 'node:child_process';

const [real, ...args] = process.argv.slice(2);
if (!real) { process.stderr.write('tmux-vis35: need the real tmux path\n'); process.exit(2); }

const CSTYLE = { 0x07: '\\a', 0x08: '\\b', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x00: '\\0' };
const isGraph = b => b >= 0x21 && b <= 0x7e;
const isAlphaUnderBrace = b =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f /* _ */ || b === 0x7b /* { */;
// How many bytes the UTF-8 sequence starting at i occupies, or 0 if it is not one.
function utf8Len(buf, i) {
  const b = buf[i];
  const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 0;
  if (!n || i + n > buf.length) return 0;
  for (let k = 1; k < n; k++) if ((buf[i + k] & 0xc0) !== 0x80) return 0;
  return n;
}
function vis35(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const n = utf8Len(buf, i);
    if (n) { out += buf.toString('utf8', i, i + n); i += n - 1; continue; }
    const b = buf[i];
    if (b === 0x24 /* $ */ && i + 1 < buf.length && isAlphaUnderBrace(buf[i + 1])) { out += '\\$'; continue; }
    // isvisible(): graph, space, tab and newline are all left alone by this flag set
    if (isGraph(b) || b === 0x20 || b === 0x09 || b === 0x0a) { out += String.fromCharCode(b); continue; }
    if (b in CSTYLE) { out += CSTYLE[b]; continue; }
    out += '\\' + b.toString(8).padStart(3, '0');
  }
  return out;
}

const r = spawnSync(real, args, { encoding: 'buffer', stdio: ['inherit', 'pipe', 'pipe'] });
if (r.error) { process.stderr.write(`tmux-vis35: ${r.error.message}\n`); process.exit(2); }
if (r.stdout?.length) process.stdout.write(vis35(r.stdout));
if (r.stderr?.length) process.stderr.write(r.stderr);
process.exit(r.status === null ? 2 : r.status);
