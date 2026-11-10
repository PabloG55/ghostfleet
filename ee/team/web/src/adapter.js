// The team app's side of web/ui/adapter.jsx: the shared screens' fleet, over this app's server.
// Every call is the server's own, scoped to the signed-in person; the slots are teamSlots(ctx).
import { teamScreenExtras } from './adapter-extras.js';
import { api, ATTACH_PER_MESSAGE } from './api.js';
import { teamSlots } from './slots.jsx';
import { t } from './i18n.js';

// What this app's own routes are called on a back button (web/ui/back.jsx names the shared ones).
const PLACES = { activity: 'nav.activity', automations: 'nav.automations', settings: 'nav.settings', admin: 'nav.admin' };
export const place = (to) => { const k = PLACES[String(to).replace(/^#?\/?/, '').split('/')[0]]; return k ? t(k) : null; };

// Who may type into a project's terminal: the server's can(user, project, 'prompt')
// (server/access.mjs), read from the account the client already has. An admin, or a member
// whose grant on the project is member or admin. The server decides again on every ticket, and
// a 404 from it hides the tab (web/ui/terminal.jsx), so a grant taken away since sign-in costs
// one refused open, not a tab that keeps failing.
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
    ...teamScreenExtras(ctx),
    automations: async () => ({ ...await api.automations(), capabilities:{actions:['send','spawn','pause','resume','wake','interrupt','reopen','stop','check','notify','wait','summary'],events:['finished','need-you','started','limit','lost'],states:['need-you','working','ready','idle','parked','limit','interrupted','asleep','lost']} }),
    saveAutomation: api.saveAutomation,
    deleteAutomation: api.deleteAutomation,
    runAutomation: api.runAutomation,
    automationAI: api.automationAI,
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
    termAccount: () => api.health().then(r => r.user || null),
    signIn: ctx.signIn,
    changePassword: ctx.changePassword,
    go: ctx.go,
    place,
    slots: teamSlots(ctx),
  };
}
