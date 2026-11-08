// pnpm dev — the API server and vite together, one Ctrl-C stops both.
import { spawn } from 'node:child_process';
const demo = process.argv.includes('--demo');
const kids = [
  spawn(process.execPath, ['server/index.mjs', ...(demo ? ['--demo'] : [])], { stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit' }),
];
const stop = () => { for (const k of kids) k.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const k of kids) k.on('exit', stop);
