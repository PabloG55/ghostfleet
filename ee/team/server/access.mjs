// server/access.mjs — who may do what, in one place. Every route, perform(), the voice
// dispatcher, the assistant and the automations ask here; nothing else decides permissions.
//
// A project a person has no role in does not exist for them: callers answer 404, not 403, so
// that asking about a project cannot confirm it is there. `can()` is the whole rule; the rest
// of this file only maps the things the server does onto its six actions.

import { t } from '../shared/i18n/index.js';

export const ACTIONS = ['read', 'prompt', 'spawn', 'stop', 'assign', 'manage'];
export const PROJECT_ROLES = ['viewer', 'member', 'admin'];
export const GLOBAL_ROLES = ['admin', 'member'];

const RANK = { viewer: 1, member: 2, admin: 3 };
const NEED = { read: 1, prompt: 2, spawn: 2, stop: 2, assign: 3, manage: 3 };

const nameOf = (p) => (p && typeof p === 'object' ? p.name : p);

export function can(user, project, action) {
  if (!user || user.disabled || !Object.hasOwn(NEED, action)) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'member') return false;
  const name = nameOf(project);
  // hasOwn: a project called "constructor" or "__proto__" must not find Object's own keys.
  const role = typeof name === 'string' && user.projects && Object.hasOwn(user.projects, name) ? user.projects[name] : null;
  return !!RANK[role] && RANK[role] >= NEED[action];
}

// `all` is fleet.projects() (objects with .name) or a list of names; it comes back filtered.
export const visibleProjects = (user, all) => (all || []).filter(p => can(user, nameOf(p), 'read'));

export const isAdmin = (user) => !!user && !user.disabled && user.role === 'admin';

// Each fleet verb is one of the actions above. A verb that is not listed is refused, so a new
// tool added to index.mjs's allowlist stays closed until someone says what it needs.
export const TOOL_ACTION = {
  fleet_send: 'prompt', fleet_answer: 'prompt', fleet_resume: 'prompt', fleet_unqueue: 'prompt',
  fleet_interrupt: 'prompt', fleet_pause: 'prompt', fleet_wake: 'prompt', fleet_reopen: 'prompt',
  fleet_rename: 'prompt', gfw_label: 'prompt', gfw_schedule: 'prompt', gfw_unschedule: 'prompt',
  fleet_spawn: 'spawn',
  fleet_stop: 'stop', fleet_worktree_remove: 'stop',
};

// The answer a route gives when the check fails: 404 when the project does not exist for this
// person, 403 when they can see it but not do this to it. Returns null when allowed.
export function denial(user, project, action) {
  if (can(user, project, action)) return null;
  if (!can(user, project, 'read')) return { status: 404, text: t('err.noProject', { project: String(nameOf(project) || '').slice(0, 80) }) };
  return { status: 403, text: t('err.roleDenies', { project: nameOf(project) }) };
}

// Installations from before roles (§2): the first account becomes admin and everyone else a
// member of every project that exists right now, so nobody loses what they see today. It runs
// only while some account has no role, which after the first write is never.
export function migrate(users, projectNames) {
  if (!users.some(u => !u.role)) return false;
  users.forEach((u, i) => {
    if (u.role) return;
    u.role = i === 0 ? 'admin' : 'member';
    u.projects = i === 0 ? {} : Object.fromEntries(projectNames.map(n => [n, 'member']));
    if (!('tokenCap' in u)) u.tokenCap = null;
    if (!('disabled' in u)) u.disabled = false;
  });
  return true;
}

// The projects an automation names in its trigger and steps; `*` and `{proyecto}` (the event's)
// are not names. Showing one that names a project you cannot see would be listing that project.
export const automationProjects = (a) => [a?.trigger?.project, ...(a?.steps || []).map(s => s?.project)]
  .filter(n => typeof n === 'string' && n && n !== '*' && n !== '{proyecto}');
export const canSeeAutomation = (user, a) => automationProjects(a).every(n => can(user, n, 'read'));
