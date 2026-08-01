#!/usr/bin/env node
// npx entry point: `npx ghostfleet` runs THIS (the npm package's "ghostfleet" bin),
// not bin/ghostfleet (the actual control plane — that one assumes the runtime is
// already staged, which is exactly what hasn't happened yet on a first install).
//
// install.sh stays the single source of truth for the install logic (staging,
// symlinks, hook/MCP wiring) — this is a thin shim so `npx ghostfleet` reaches it
// without requiring a manual git clone first. After install.sh finishes, the real
// `ghostfleet` command is on $PATH (~/.local/bin), independent of npm/npx.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const installSh = path.join(repoRoot, 'install.sh');

const res = spawnSync('bash', [installSh, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: repoRoot,
});

if (res.error) {
  console.error(`ghostfleet: failed to run install.sh — ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
