// The team app's side of web/ui/adapter.jsx: the shared screens' fleet, over this app's server.
// Every call is the server's own, scoped to the signed-in person; the slots are teamSlots(ctx).
import { teamScreenExtras } from './adapter-extras.js';
import { screenPlace } from '../../../../web/ui/phone-places.js';
import { api, ATTACH_PER_MESSAGE } from './api.js';
import { teamSlots } from './slots.jsx';
import { t } from './i18n.js';

// What this app's own route is called on a back button. The shared pages are named by web/ui:
// back.jsx names home, the map, a project or session, Activity and Settings, and phone-places.js
// names the others. That is composed in front of this, as the phone's adapter composes it.
const PLACES = { admin: 'nav.admin' };
const appPlace = (to) => { const k = PLACES[String(to).replace(/^#?\/?/, '').split('/')[0]]; return k ? t(k) : null; };
export const place = (to) => screenPlace(to) || appPlace(to);

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
    hasPeople: true,
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
    canAnswer: (project) => canTerm(ctx.me, project),
    termOpen: api.termOpen,
    termSocket: api.termSocket,
    termAccount: () => api.health().then(r => r.user || null),
    signIn: ctx.signIn,
    changePassword: ctx.changePassword,
    go: ctx.go,
    place,
    // Every shared page: the team server serves the queue, held items, screen reviews and sign-ins
    // too (server/screen-routes.mjs), so nothing is hidden and `offers` is left out.
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
