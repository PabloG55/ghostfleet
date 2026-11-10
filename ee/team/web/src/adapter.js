// The team app's side of web/ui/adapter.jsx: the shared screens' fleet, over this app's server.
// Every call is the server's own, scoped to the signed-in person; the slots are teamSlots(ctx).
import { api, ATTACH_PER_MESSAGE } from './api.js';
import { teamSlots } from './slots.jsx';

// Who may type into a project's terminal: the server's can(user, project, 'prompt')
// (server/access.mjs), read from the account the client already has. An admin, or a member
// whose grant on the project is member or admin. The server decides again on every ticket.
const RANK = { viewer: 1, member: 2, admin: 3 };
export function canTerm(me, project) {
  if (!me || me.disabled) return false;
  if (me.role === 'admin') return true;
  if (me.role !== 'member') return false;
  const g = me.projects && Object.hasOwn(me.projects, project) ? me.projects[project] : null;
  return (RANK[g] || 0) >= RANK.member;
}

export function teamAdapter(ctx) {
  return {
    grid: api.grid,
    session: api.session,
    pane: api.pane,
    act: api.act,
    attach: api.attach,
    attachPerMessage: ATTACH_PER_MESSAGE,
    lead: api.lead,
    presence: api.presence,
    canTerm: (project) => canTerm(ctx.me, project),
    termOpen: api.termOpen,
    termSocket: api.termSocket,
    go: ctx.go,
    slots: teamSlots(ctx),
  };
}
