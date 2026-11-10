// PostToolUse observer. Silent even on failure: tool output is never echoed to a log.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pendingLogin } from './login-shape.js';

export function captureLogin(input, env = process.env) {
  const dir = env.CLAUDE_FLEET_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'fleet');
  const sid = input.session_id;
  if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sid)) return null;
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8')); } catch { return null; }
  if (rec.nested_under) return null;
  const login = pendingLogin(input, { session_id: sid, session: rec.slot, sock: rec.sock, project: rec.project || rec.cwd || input.cwd });
  if (!login) return null;
  const store = path.join(dir, 'logins');
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  login.id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(store, `${login.id}.json`), JSON.stringify(login), { mode: 0o600, flag: 'wx' });
  // The existing Telegram outbox is a notice channel, never an OAuth transport.
  const tg = env.GHOSTFLEET_TELEGRAM_DIR || path.join(env.HOME || os.homedir(), '.config', 'ghostfleet', 'telegram');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(tg, 'config.json'), 'utf8'));
    if (config.link) {
      const outbox = path.join(tg, 'outbox'); fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outbox, `login-${login.id}.json`), JSON.stringify({ event: 'asks',
        sock: login.sock, session: login.session, at: Math.floor(login.created / 1000),
        text: `${login.server} needs authorization. Open the fleet app.` }), { mode: 0o600, flag: 'wx' });
    }
  } catch {}
  return login;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; if (raw.length > 1024 * 1024) process.exit(0); });
  process.stdin.on('end', () => { try { captureLogin(JSON.parse(raw)); } catch {} });
}
