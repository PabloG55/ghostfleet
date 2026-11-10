import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { accountLoginReason } from './account-login-shape.mjs';

const tmux = (sock, ...args) => execFileSync('tmux', ['-u', '-L', sock, ...args],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
export const accountPrivacyFile = (dir, sock, session) => path.join(dir, `${sock}.${session}.account-private`);
export const accountPanePrivate = (dir, sock, session) => fs.existsSync(accountPrivacyFile(dir, sock, session));
export function accountPane(sock, session, dir) {
  if (accountPanePrivate(dir, sock, session)) throw new Error('sign-in is being submitted');
  return tmux(sock, 'capture-pane', '-p', '-J', '-t', `=${session}`);
}
const noticed = new Set();
export function accountLoginNotice(row, env = process.env) {
  const key = `${row.sock}/${row.session}`;
  if (noticed.has(key)) return;
  const dir = env.GHOSTFLEET_TELEGRAM_DIR || path.join(env.HOME || os.homedir(), '.config/ghostfleet/telegram');
  try {
    if (!JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).link) return;
    fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true, mode: 0o700 });
    // No pane, URL, config path, or caller-supplied string becomes notice text.
    fs.writeFileSync(path.join(dir, 'outbox', `account-${row.sock}-${row.session}.json`), JSON.stringify({
      event: 'asks', sock: row.sock, session: row.session, at: Math.floor(Date.now() / 1000),
      text: `${row.session} · ${row.profile}: Claude account sign-in needs you. Open the fleet app.`,
    }), { mode: 0o600 });
    noticed.add(key);
  } catch {}
}

export function accountLoginNeeds(projects) {
  const out = [];
  for (const t of projects) {
    const dir = path.join(t.cfg, 'fleet');
    let sessions;
    try { sessions = tmux(t.sock, 'list-sessions', '-F', '#{session_name}').trim().split('\n'); } catch { continue; }
    for (const session of sessions) {
      if (!/^[A-Za-z0-9_-]+$/.test(session)) continue;
      try {
        let agent = 'claude';
        try { agent = fs.readFileSync(path.join(dir, `${t.sock}.${session}.agent`), 'utf8').trim(); } catch {}
        if (agent !== 'claude') continue;
        if (!accountLoginReason(accountPane(t.sock, session, dir))) { noticed.delete(`${t.sock}/${session}`); continue; }
        const row = { id: `account-${t.sock}-${session}`, kind: 'account', status: 'needs-login',
          provider: 'Claude account sign-in', server: 'Claude account', profile: t.profile || path.basename(t.cfg),
          project: t.name, sock: t.sock, session, expires: 0, first_site: false };
        out.push(row); accountLoginNotice(row);
      } catch {}
    }
  }
  return out;
}
