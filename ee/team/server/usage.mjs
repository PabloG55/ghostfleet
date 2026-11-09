// server/usage.mjs — the ledger wired to this server: where transcripts come from, who is an
// admin, the demo's pretend history, and the two admin routes. index.mjs makes one of these,
// calls gate() from perform() and hands it every /api/admin/usage request.
import { createLedger, parseCap } from './usage-ledger.mjs';
import { demoRows, demoCap } from './usage-demo.mjs';
import { isAdmin } from './access.mjs';
import { t } from '../shared/i18n/index.js';

// Until the roles work lands, a user without `role` is read the way the contract's migration
// will write it (§2): the first user is the admin, everyone else a member.

export function createUsage({ dir, mode, fleet, activity, owners, users, saveUsers, settings, audit }) {
  const demo = mode === 'demo';
  let demoProjects = [], demoCache = { key: '', rows: [] };
  if (demo) fleet.projects().then(p => { demoProjects = p; }).catch(() => {});
  const extraRows = () => {
    if (!demo) return [];
    const key = users().map(u => u.id).join(',') + '|' + demoProjects.length + '|' + new Date().toDateString();
    if (demoCache.key !== key) demoCache = { key, rows: demoRows(users(), demoProjects, Math.floor(Date.now() / 1000)) };
    return demoCache.rows;
  };
  // A cap that was never set is `undefined`; the contract's "no cap" is null, and it wins.
  const capOf = (u) => (u && u.tokenCap !== undefined ? u.tokenCap : demo ? demoCap(users(), u) : null);
  const ledger = createLedger({
    dir, users, capOf, extraRows, owners,
    activity: () => activity(5000),
    sources: () => (typeof fleet.transcripts === 'function' ? fleet.transcripts() : []),
    onRefuse: ({ user, verb, project, why, via }) => audit({ user, verb, project, subject: '-', ...(via ? { via } : {}), result: 'refused', output: `${t('act.cap')}: ${why}`.slice(0, 500) }),
  });
  const scan = () => { try { ledger.scan(); } catch (e) { console.error('usage scan:', e.message); } };
  scan();
  setInterval(scan, 30000).unref();

  // The money view only makes sense when the company pays per token (§3). The demo shows it, so
  // the screen can be seen; a real install shows it once the admin picks api-key.
  const aiMode = () => settings()?.ai?.mode || (demo ? 'api-key' : null);

  async function route(req, p, me, body) {
    if (!isAdmin(me)) throw Object.assign(new Error(t('err.noPath', { path: p })), { status: 404 });
    if (p === '/api/admin/usage' && req.method === 'GET') {
      scan();
      return { ok: true, mode: aiMode(), ...ledger.report({ withDollars: aiMode() === 'api-key' }) };
    }
    if (p === '/api/admin/usage/cap' && req.method === 'POST') {
      const b = await body(req);
      const u = users().find(x => x.id === String(b.user || ''));
      if (!u) throw Object.assign(new Error(t('err.noPersonNamed', { who: String(b.user || '').slice(0, 40) })), { status: 400 });
      u.tokenCap = parseCap(b);
      saveUsers();
      audit({ user: me.id, verb: 'token_cap', subject: u.name, args: { daily: u.tokenCap?.daily ?? null, monthly: u.tokenCap?.monthly ?? null }, result: 'ran' });
      return { ok: true, cap: u.tokenCap };
    }
    throw Object.assign(new Error(t('err.noPath', { path: p })), { status: 404 });
  }

  return { gate: ledger.gate, route, ledger };
}
