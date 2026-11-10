// An explicit changed-reader selection; this never runs the unfiltered suite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const groups = JSON.parse(fs.readFileSync(new URL('./account-login-groups.json', import.meta.url), 'utf8'));
if (!Array.isArray(groups) || !groups.length) throw new Error('missing account regression selection');
// The mod group restores SUITE_HOME for its optional engine validator. Give the
// suite an outer fake home too, so even that escape hatch cannot reach an account.
const tmp = fs.mkdtempSync('/tmp/gfa-reg.');
try {
  const home = path.join(tmp, 'home'), cfg = path.join(tmp, 'config'), guard = path.join(tmp, 'bin');
  for (const dir of [home, cfg, guard]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(guard, 'security'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, PATH: `${guard}:${process.env.PATH}` };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
  const selected = process.argv.slice(2).length ? process.argv.slice(2) : groups;
  const r = spawnSync(path.join(root, 'test/run.sh'), selected, { stdio: 'inherit', env });
  process.exitCode = r.status ?? 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
