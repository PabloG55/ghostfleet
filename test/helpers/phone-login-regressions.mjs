// The readers of the changed files, their fixture providers, and the required tree sweeps.
// An explicit selection: this never falls back to the full suite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const groups = JSON.parse(fs.readFileSync(new URL('./phone-login-groups.json', import.meta.url), 'utf8'));
if (!Array.isArray(groups) || !groups.length) throw new Error('missing selected regression groups');
const r = spawnSync(path.join(root, 'test/run.sh'), groups, { stdio: 'inherit' });
process.exit(r.status ?? 1);
