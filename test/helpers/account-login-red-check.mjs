// Mutation proof is opt-in because each case starts the isolated two-host rig.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const cases = {
  'start-disabled': 'pending record is private',
  'finish-disabled': 'stub receives exactly the code plus Enter, once',
  'skip-clear': 'visible pane and history were cleared',
  'skip-input-clear': 'retained input is cleared after submission',
  busy: 'busy start refuses without queuing /login',
  'busy-types': 'busy start types nothing',
  expired: 'expired record refuses',
  prompt: 'changed prompt refuses',
  'local-passkey': 'local finish requires a fresh assertion',
  'home-passkey': 'home refuses missing assertion before crossing',
  signature: 'pair without signature refuses',
  replay: 'replayed pair signature refuses',
  scope: 'hidden peer project refuses finish',
  'secret-log': 'sentinel absent from everything both hosts wrote',
  'crossing-disabled': 'home starts the remote session through its pair',
  used: 'second use types nothing more',
  privacy: 'pane reads are blocked while the code is being submitted',
  'notice-reset': 'a later account expiry can ring again for the same session',
  'profile-label': 'another fake profile uses its own label and fleet socket',
  'profile-scope': 'ambiguous profile start refuses without choosing a fleet',
  'blank-pane': 'cleanup preserves the accepted prompt for the phone',
  'reader-drain': 'preexisting pane readers drain before typing',
};
// Short enough for Unix socket paths on macOS as well as Linux.
const tmp = fs.mkdtempSync('/tmp/gfar.');
try {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)) {
    if (!cases[name]) throw new Error('unknown mutation');
    const r = spawnSync(process.execPath, [path.join(root, 'test/helpers/mcp-login-check.mjs'), root, 'account', name],
      { cwd: root, env: { ...process.env, TMUX_TMPDIR: tmp }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    const failures = r.stdout.split('\n').map(line => line.split('\x1f')).filter(a => a.length === 3 && a[1] !== a[2]).map(a => a[0]);
    const hit = failures.includes(cases[name]);
    console.log(`${name}: ${hit ? 'RED observed' : 'FAILED mutation proof'} (${failures.length} red assertions)`);
    if (!hit) process.exitCode = 1;
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
