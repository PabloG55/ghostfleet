import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { accountLoginNeeds } from './account-logins.mjs';

// Derive scope from the registered socket AND profile directory, as other fleet reads do.
// The record's project label is descriptive; it is never authority to expose a project.
export function loginRecords(projects) {
  const out = [];
  for (const t of projects) {
    const dir = path.join(t.cfg, 'fleet', 'logins');
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      try {
        const file = path.join(dir, name), r = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (r.sock === t.sock && name === `${r.id}.json`) out.push({ ...r, project: t.name, file });
      } catch {}
    }
  }
  return out;
}

export function loginList(projects, now = Date.now()) {
  const records = loginRecords(projects);
  const items = records.map(({ file, state, port, path: callbackPath, pane, server_pid, ...r }) => ({ ...r,
    status: r.used ? (r.result || 'used') : r.expires <= now ? 'expired' : 'pending',
    // Prior authorizations, including consumed ones, remember a site across devices.
    first_site: r.kind !== 'account' && !records.some(x => x.provider === r.provider && x.created < r.created),
  }));
  const needs = accountLoginNeeds(projects).filter(n => !items.some(r => r.kind === 'account' && r.expires > now
    && r.sock === n.sock && r.session === n.session && (!r.used || (n.attempt && n.attempt === r.attempt))));
  return [...items, ...needs];
}

export function callbackProblem(r, value, now = Date.now()) {
  if (!r) return 'login not found';
  if (r.used) return 'login already used';
  if (r.expires <= now) return 'login expired';
  if (r.kind !== 'loopback') return 'use claude.ai connector settings';
  let u;
  try { u = new URL(value); } catch { return 'invalid callback URL'; }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password || u.hash) return 'callback must be localhost';
  if (Number(u.port) !== r.port) return 'callback port mismatch';
  if (u.pathname !== r.path) return 'callback path mismatch';
  if (u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== r.state) return 'callback state mismatch';
  return null;
}

export async function finishLogin(projects, args) {
  const r = loginRecords(projects).find(r => r.id === args.id && r.project === args.project);
  const problem = callbackProblem(r, args.callback);
  if (problem) return { status: 400, json: { ok: false, text: problem } };
  // Consume BEFORE the network request. Neither a timeout nor a concurrent tap can replay.
  // O_EXCL also protects against two daemon processes sharing the same state directory.
  let fd;
  try { fd = fs.openSync(`${r.file}.used`, 'wx', 0o600); fs.closeSync(fd); }
  catch { return { status: 400, json: { ok: false, text: 'login already used' } }; }
  const { authorize, state, file, ...clean } = r;
  const save = result => fs.writeFileSync(file, JSON.stringify({ ...clean, used: true, result }), { mode: 0o600 });
  save('used');
  const u = new URL(args.callback);
  const status = await new Promise(resolve => {
    let timer;
    const done = status => { clearTimeout(timer); resolve(status); };
    // A numeric loopback address, the recorded port/path, no redirect handler, no body
    // retained and no raw network exception returned. Providers may echo codes in either.
    const req = http.get({ host: '127.0.0.1', port: r.port, path: r.path + u.search, timeout: 3000 }, res => {
      res.destroy(); done(res.statusCode);
    });
    timer = setTimeout(() => { req.destroy(); done(0); }, 3000);
    req.on('timeout', () => { req.destroy(); done(0); });
    req.on('error', () => done(0));
  });
  save(status >= 200 && status < 300 ? 'done' : status ? `HTTP ${status}` : 'listener gone');
  return { status: 200, json: { ok: status >= 200 && status < 300, status,
    text: status >= 200 && status < 300 ? `done · HTTP ${status}` : status ? `listener answered HTTP ${status}` : 'listener gone or timed out' } };
}
