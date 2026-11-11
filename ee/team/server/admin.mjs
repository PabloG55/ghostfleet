// server/admin.mjs — the routes behind Administration → Users and → License. Only a global
// admin gets an answer; anyone else gets the same 404 as a path that does not exist, so the
// panel cannot be found by probing. Each change lands in the activity log with the admin's name.
//   The two places an account is ADDED ask license.mjs first: creating one, and re-enabling a
// disabled one. Nothing else here does, so an install over its seats can still edit, disable
// and reset the accounts it has.
import { isAdmin, GLOBAL_ROLES } from './access.mjs';
import { adminUser, hashPw, tempPassword, cleanProjects } from './users.mjs';
import { t } from '../shared/i18n/index.js';

export function createAdmin({ store, fleet, audit, dropLogins, httpErr, license }) {
  const projectNames = async () => { try { return (await fleet.projects()).map(p => p.name); } catch { return []; } };
  const activeAdmins = () => store.list.filter(u => u.role === 'admin' && !u.disabled);
  const target = (id) => {
    const u = store.find(String(id || ''));
    if (!u) throw httpErr(404, t('err.noPerson'));
    return u;
  };

  // Returns true when it answered.
  return async function route(me, req, res, url, { body, send }) {
    const p = url.pathname;
    if (!p.startsWith('/api/admin/')) return false;
    if (!isAdmin(me)) throw httpErr(404, t('err.noPath', { path: p }));

    if (p === '/api/admin/users' && req.method === 'GET') {
      send(res, 200, { users: store.list.map(adminUser), projects: await projectNames() });
      return true;
    }
    if (p === '/api/admin/users' && req.method === 'POST') {
      const b = await body(req);
      const role = b.role || 'member';
      const projects = cleanProjects(b.projects || {}, await projectNames());
      license.assertCanAdd();
      const pw = tempPassword();
      const u = store.add(b.name, pw, { role, projects });
      u.mustChange = true; store.save();
      audit({ user: me.id, verb: 'add_user', subject: u.name, args: { role, projects }, result: 'ran' });
      send(res, 200, { ok: true, user: adminUser(u), password: pw });
      return true;
    }
    if (p === '/api/admin/users/update' && req.method === 'POST') {
      const b = await body(req);
      const u = target(b.id);
      const change = {};
      if (b.role !== undefined) {
        if (!GLOBAL_ROLES.includes(b.role)) throw httpErr(400, t('err.badRole', { role: String(b.role).slice(0, 20) }));
        change.role = b.role;
      }
      if (b.disabled !== undefined) change.disabled = b.disabled === true;
      if (b.projects !== undefined) change.projects = cleanProjects(b.projects, await projectNames());
      // The instance must always keep someone who can open this panel.
      const losesAdmin = u.role === 'admin' && !u.disabled && (change.role === 'member' || change.disabled === true);
      if (losesAdmin && activeAdmins().length <= 1) throw httpErr(409, t('err.lastAdmin'));
      if (u.id === me.id && change.disabled) throw httpErr(409, t('err.disableSelf'));
      // Re-enabling puts an account back among the counted ones, so it is an addition.
      if (u.disabled && change.disabled === false) license.assertCanAdd();
      Object.assign(u, change);
      store.save();
      if (change.disabled) dropLogins(u.id);
      audit({ user: me.id, verb: 'edit_user', subject: u.name, args: change, result: 'ran' });
      send(res, 200, { ok: true, user: adminUser(u) });
      return true;
    }
    if (p === '/api/admin/users/reset' && req.method === 'POST') {
      const b = await body(req);
      const u = target(b.id);
      const pw = tempPassword();
      Object.assign(u, hashPw(pw), { mustChange: true });
      store.save();
      dropLogins(u.id);
      audit({ user: me.id, verb: 'reset_password', subject: u.name, result: 'ran' });
      send(res, 200, { ok: true, password: pw });
      return true;
    }
    if (p === '/api/admin/license' && req.method === 'GET') { send(res, 200, license.view()); return true; }
    if (p === '/api/admin/license' && req.method === 'POST') { send(res, 200, await license.act(me, await body(req))); return true; }
    // Usage and the AI account answer their own /api/admin/ paths further down the router.
    return false;
  };
}
