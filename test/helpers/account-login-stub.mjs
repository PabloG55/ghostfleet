// Scratch-only terminal. It keeps input in memory and exposes only equality/counts.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
const [controlFile, expectedHash] = process.argv.slice(2);
if (!controlFile || !expectedHash || !process.env.TMUX_TMPDIR) process.exit(2);
let mode = 'expired', input = '', count = 0, exact = true;
const authorize = 'https://claude.com/cai/oauth/authorize?code=true&state=placeholder-state&code_challenge=placeholder-challenge';
function draw() {
  process.stdout.write('\x1b[2J\x1b[H' + (mode === 'expired' ? 'Not logged in · Please run /login\n❯ '
    : mode === 'busy' ? '✻ Working… (12s · ↓ 2k tokens)\n'
    : mode === 'prompt' ? `Browser didn't open? Use the url below to sign in\n${authorize}\n\n Paste code here if prompted > ` : '❯ '));
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/mode') { mode = u.searchParams.get('value'); input = ''; draw(); }
  res.end(JSON.stringify({ mode, count, exact }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
fs.writeFileSync(controlFile, String(server.address().port));
process.stdin.setRawMode(true); process.stdin.resume(); draw();
process.stdin.on('data', chunk => {
  for (const char of chunk.toString()) {
    if (char === '\r') {
      if (input === '/login') { mode = 'prompt'; input = ''; draw(); continue; }
      count++;
      exact &&= crypto.createHash('sha256').update(input + '\r').digest('hex') === expectedHash;
      // Deliberately echo, including into history. The production finish must erase it.
      process.stdout.write(input + '\n'.repeat(60) + '\x1b[2J\x1b[HLogin successful\n❯ ');
      input = ''; mode = 'done';
    } else input += char;
  }
});
