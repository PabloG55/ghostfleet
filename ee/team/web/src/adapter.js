// The team app's side of web/ui/adapter.jsx: the shared screens' fleet, over this app's server.
// Every call is the server's own, scoped to the signed-in person; the slots are teamSlots(ctx).
import { api, ATTACH_PER_MESSAGE } from './api.js';
import { teamSlots } from './slots.jsx';
import { t } from './i18n.js';

// The shared pages this server has (web/ui/app.jsx VIEWS). The rest — code reviews, dev stacks,
// the queue, held items, sign-ins, search — are fleet-serve's, and a team server has no route
// for them yet: their links are hidden and their addresses say so.
const OFFERS = new Set(['home', 'map', 'project', 'automations', 'activity', 'settings']);

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
    offers: (view) => OFFERS.has(view),
    // An assignment's row names the new owner, which only this app can put a name to.
    activity: () => api.activity().then(r => ({ ...r, rows: (r.rows || []).map(x => (x.args?.owner !== undefined
      ? { ...x, detail: ctx.usersById[x.args.owner]?.name || t('activity.nobody') } : x)) })),
    saveLang: api.setLang,
    // The assistant (web/ui/agent.js): the dispatcher and the list of what was asked are this
    // server's (server/router.mjs, server/tasks.mjs), and so is the voice.
    route: api.route,
    tasks: api.tasks,
    taskSent: api.taskSent,
    taskPlace: api.taskPlace,
    taskDone: api.taskDone,
    assign: api.assign,
    voice: api.voice,
    hear: api.hear,
    speak: api.speak,
    speakAudio: (id) => `/api/speak/${encodeURIComponent(id)}`,
    voices: api.voices,
    // Only an admin installs or deletes a voice; the server answers anyone else with 404.
    ...(ctx.admin ? { installVoice: api.installVoice, deleteVoice: api.deleteVoice } : {}),
    // The speech detector ships with this app (scripts/copy-vad.mjs puts its files beside it).
    vad: () => import('@ricky0123/vad-web'),
    settings: {
      connection: {
        state: () => ({ text: ctx.mode === 'demo' ? t('settings.demo') : t('settings.real') }),
        ...(ctx.mode === 'demo' && ctx.admin ? { reset: api.resetDemo } : {}),
      },
    },
    slots: teamSlots(ctx),
  };
}
