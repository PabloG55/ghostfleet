import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] || new URL('../..', import.meta.url).pathname);
const { accountLoginReason } = await import(pathToFileURL(path.join(root, 'lib/account-login-shape.mjs')));
let n = 0;
for (const file of fs.readdirSync(path.join(root, 'test/fixtures')).filter(f => f.endsWith('.txt'))) {
  const want = file.startsWith('claude-account-login-') || file === 'claude-account-expired-synthetic.txt';
  const got = !!accountLoginReason(fs.readFileSync(path.join(root, 'test/fixtures', file), 'utf8'));
  if (want !== got) { console.error(`${file}: expected ${want}, got ${got}`); process.exitCode = 1; }
  n++;
}
// Existing test/run.sh's auth-error pane is synthetic. There is no captured expired
// pane in the starting tree; keep that provenance explicit instead of inventing one.
for (const width of [56, 80, 120, 200]) {
  const pane = '  ⎿  API Error: 401 · OAuth token revoked · Please run /login';
  const wrapped = pane.match(new RegExp(`.{1,${width}}`, 'g')).join('\n');
  if (!accountLoginReason(wrapped)) { console.error(`${width}: expired pane missed`); process.exitCode = 1; }
  n++;
}
console.log(`${n} detector assertions (${process.env.LC_ALL || 'default locale'})`);
