#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { addDevice, revokeDevice, devices } from '../lib/voice.mjs';

try {
  const [cmd, verb, name, ...extra] = process.argv.slice(2);
  if (cmd !== 'token' || extra.length || !['add', 'revoke', 'list'].includes(verb) || (verb === 'list' ? name !== undefined : !name)) {
    throw new Error('usage: fleet-voice token add <device> | token revoke <device> | token list');
  }
  if (verb === 'list') {
    for (const d of devices()) console.log(`${d.name}\t${d.revoked ? 'revoked' : 'active'}\tlast use: ${d.last_use || 'never'}`);
  } else if (verb === 'revoke') {
    revokeDevice(name); console.log('Device token revoked.');
  } else {
    // Refuse a session/transcript or redirected output. The owner runs this command
    // at a terminal; only pbcopy's stdin (or the controlling tty) sees the value.
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CLAUDE_FLEET_SLOT || process.env.CLAUDECODE || process.env.CODEX_THREAD_ID) {
      throw new Error('run token add yourself in a terminal outside an agent session');
    }
    const token = addDevice(name);
    const copied = process.platform === 'darwin' && spawnSync('pbcopy', [], { input: token, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
    if (copied) console.log('Token copied to the clipboard. Paste it into the Shortcut import question. It will not be shown again.');
    else { const tty = fs.openSync('/dev/tty', 'w'); try { fs.writeSync(tty, token + '\n'); } finally { fs.closeSync(tty); } }
  }
} catch (e) { console.error(`fleet-voice: ${e.message}`); process.exitCode = 1; }
