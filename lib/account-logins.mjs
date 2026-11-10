import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { accountLoginReason, accountLoginPrompt, accountLoginURL } from './account-login-shape.mjs';

const tmux = (sock, ...args) => execFileSync('tmux', ['-u', '-L', sock, ...args],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
export const accountPrivacyFile = (dir, sock, session) => path.join(dir, `${sock}.${session}.account-private`);
export const accountPanePrivate = (dir, sock, session) => fs.existsSync(accountPrivacyFile(dir, sock, session));
export function accountPane(sock, session, dir) {
  if (accountPanePrivate(dir, sock, session)) throw new Error('sign-in is being submitted');
  return tmux(sock, 'capture-pane', '-p', '-J', '-t', `=${session}:`);
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

const reply = (text, status = 400) => ({ status, json: { ok: status === 200, text } });
export function accountBusy(pane) {
  const source = execFileSync(fileURLToPath(new URL('../bin/fleet-agent', import.meta.url)), ['field', 'claude', 'busy_re_js'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!source.trim()) throw new Error('busy detector unavailable');
  const re = new RegExp(source, 'i');
  return pane.split('\n').some(line => re.test(line));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startAccountLogin(projects, args) {
  const t = projects.find(t => t.name === args.project);
  if (!t || !/^[A-Za-z0-9_-]+$/.test(args.session || '')) return reply('session not found in shared project');
  const dir = path.join(t.cfg, 'fleet');
  try {
    let agent = 'claude';
    try { agent = fs.readFileSync(path.join(dir, `${t.sock}.${args.session}.agent`), 'utf8').trim(); } catch {}
    if (agent !== 'claude') return reply('this session is not Claude Code');
    let pane = accountPane(t.sock, args.session, dir);
    if (accountBusy(pane)) return reply('session is busy; wait for its turn to end, then Sign in again');
    if (!accountLoginReason(pane)) return reply('session is not asking for an account sign-in');
    const target = tmux(t.sock, 'display-message', '-p', '-t', `=${args.session}:`, '#{pane_id}').trim();
    // A session already showing the paste prompt must keep its existing PKCE attempt.
    if (!accountLoginPrompt(pane)) {
      tmux(t.sock, 'send-keys', '-t', target, '-l', '/login');
      tmux(t.sock, 'send-keys', '-t', target, 'Enter');
    }
    let selected = false;
    for (let i = 0; i < 60; i++) {
      pane = accountPane(t.sock, args.session, dir);
      const authorize = accountLoginURL(pane);
      if (authorize) {
        const created = Date.now(), id = crypto.randomBytes(16).toString('hex');
        const row = { id, kind: 'account', session: args.session, sock: t.sock, pane: target,
          server_pid: tmux(t.sock, 'display-message', '-p', '#{pid}').trim(),
          profile: t.profile || path.basename(t.cfg), provider: 'Claude account sign-in', server: 'Claude account',
          project: t.name, authorize, created, expires: created + 600000, used: false };
        fs.mkdirSync(path.join(dir, 'logins'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'logins', `${id}.json`), JSON.stringify(row), { mode: 0o600, flag: 'wx' });
        return { status: 200, json: { ok: true, text: 'sign-in ready', id } };
      }
      // Measured /login opens the account-method chooser before it issues its URL.
      if (!selected && /Select login method:/.test(pane) && /Claude account with subscription/.test(pane)) {
        tmux(t.sock, 'send-keys', '-t', target, 'Enter'); selected = true;
      }
      await pause(100);
    }
    return reply('no account sign-in URL appeared; check the session');
  } catch { return reply('could not start account sign-in; check the session'); }
}
