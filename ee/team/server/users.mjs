// server/users.mjs — the accounts in GFW_DATA/users.json, shared by the server and by
// admin-cli.mjs. The CLI writes the same file while the server may be running, so the server
// re-reads it whenever its mtime is not the one it last wrote or read: an admin created from
// the console can log in without a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GLOBAL_ROLES, PROJECT_ROLES } from './access.mjs';
import { t } from '../shared/i18n/index.js';

export const COLORS = ['cyan', 'yellow', 'green', 'magenta', 'blue', 'red'];
export const dataDir = (mode) => path.join(process.env.GFW_DATA || path.join(os.homedir(), '.config', 'ghostfleet-web'), mode);

export const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') });
export const pwOk = (u, pw) => {
  const h = Buffer.from(crypto.scryptSync(String(pw), u.salt, 64).toString('hex'));
  const ref = Buffer.from(u.hash);
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
};
// Read aloud or typed from a printout: no 0/O, 1/l/I.
export function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), b => abc[b % abc.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}
export const publicUser = (u) => u && ({ id: u.id, name: u.name, color: u.color });
// What a person may know about their own account, and what the admin panel lists.
export const selfUser = (u) => u && ({ ...publicUser(u), role: u.role, projects: u.projects || {}, mustChange: !!u.mustChange, lang: u.lang || null });
export const adminUser = (u) => u && ({ ...selfUser(u), disabled: !!u.disabled, tokenCap: u.tokenCap ?? null, created: u.created || null });

const err = (status, text) => Object.assign(new Error(text), { status });

export function cleanProjects(raw, known) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err(400, t('err.projectsShape'));
  const out = {};
  for (const [name, role] of Object.entries(raw)) {
    if (!role) continue;
    if (!PROJECT_ROLES.includes(role)) throw err(400, t('err.badProjectRole', { role: String(role).slice(0, 20) }));
    if (known && !known.includes(name)) throw err(400, t('err.noProject', { project: name.slice(0, 80) }));
    out[name] = role;
  }
  return out;
}

export function createUsers(dir) {
  const f = path.join(dir, 'users.json');
  let users = [], mtime = 0;
  const load = () => {
    try { users = JSON.parse(fs.readFileSync(f, 'utf8')).users || []; mtime = fs.statSync(f).mtimeMs; }
    catch { users = []; mtime = 0; }
  };
  const fresh = () => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch {} if (m !== mtime) load(); };
  const save = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    mtime = fs.statSync(f).mtimeMs;
  };
  load();

  function add(name, password, { role = 'member', projects = {} } = {}) {
    fresh();
    const id = slug(name);
    if (!id) throw err(400, t('err.emptyName'));
    if (String(password || '').length < 12) throw err(400, t('err.shortPw'));
    if (!GLOBAL_ROLES.includes(role)) throw err(400, t('err.badRole', { role: String(role).slice(0, 20) }));
    if (users.some(u => u.id === id)) throw err(409, t('err.userExists', { name }));
    const u = { id, name: String(name).trim(), color: COLORS[users.length % COLORS.length], ...hashPw(password),
                role, projects: role === 'admin' ? {} : projects, tokenCap: null, disabled: false, created: Math.floor(Date.now() / 1000) };
    users.push(u); save();
    return u;
  }

  return {
    get list() { fresh(); return users; },
    find: (id) => { fresh(); return users.find(u => u.id === id) || null; },
    add, save, fresh,
  };
}
