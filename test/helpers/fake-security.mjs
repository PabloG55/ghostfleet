#!/usr/bin/env node
// test/helpers/fake-security.mjs — a stand-in for macOS `security`, for the accounts rows.
//
// lib/accounts.mjs calls `$CLAUDE_FLEET_SECURITY` with the same arguments it gives the real
// one, so this is what proves the argv and the stdin it builds — and no run of the suite
// can reach a real Keychain. It speaks only the four shapes Claude Code itself uses:
//
//   find-generic-password -a <acct> -w -s <svc>          print the value, or exit 44
//   add-generic-password -U -a <acct> -s <svc> -X <hex>   (argv)
//   -i   with `add-generic-password -U -a "<acct>" -s "<svc>" -X "<hex>"` lines on stdin
//   delete-generic-password -a <acct> -s <svc>
//
// Items are files under $FAKE_KEYCHAIN (required: it refuses to run without one), named by
// a hash of service+account. Every call is appended to $FAKE_KEYCHAIN/calls.log WITHOUT the
// value, so a row can assert that a secret never travelled in argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.env.FAKE_KEYCHAIN;
if (!dir) { process.stderr.write('fake-security: FAKE_KEYCHAIN is not set\n'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const file = (svc, acct) => path.join(dir, crypto.createHash('sha256').update(`${svc}\x1f${acct}`).digest('hex').slice(0, 24));
const logCall = (how, svc, acct) => fs.appendFileSync(path.join(dir, 'calls.log'), `${how}\t${svc}\t${acct}\n`);
function opt(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function add(args, how) {
  const svc = opt(args, '-s'), acct = opt(args, '-a'), hex = opt(args, '-X');
  if (!svc || !acct || hex === undefined) return 1;
  fs.writeFileSync(file(svc, acct), Buffer.from(hex, 'hex').toString('utf8'));
  logCall(how, svc, acct);
  return 0;
}
// `security -i` tokenises like a shell with double quotes; values here never contain one.
const words = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);

const [cmd, ...rest] = process.argv.slice(2);
let rc = 0;
if (cmd === 'find-generic-password') {
  const f = file(opt(rest, '-s'), opt(rest, '-a'));
  logCall('find', opt(rest, '-s'), opt(rest, '-a'));
  if (fs.existsSync(f)) process.stdout.write(fs.readFileSync(f, 'utf8') + '\n'); else rc = 44;
} else if (cmd === 'add-generic-password') {
  rc = add(rest, 'add-argv');
} else if (cmd === 'delete-generic-password') {
  const f = file(opt(rest, '-s'), opt(rest, '-a'));
  logCall('delete', opt(rest, '-s'), opt(rest, '-a'));
  if (fs.existsSync(f)) fs.unlinkSync(f); else rc = 44;
} else if (cmd === '-i') {
  for (const line of fs.readFileSync(0, 'utf8').split('\n')) {
    const w = words(line);
    if (w[0] === 'add-generic-password') rc = add(w.slice(1), 'add-stdin') || rc;
  }
} else rc = 2;
process.exit(rc);
