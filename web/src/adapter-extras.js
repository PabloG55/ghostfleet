// The phone's additional shared-screen members. Spread into its main adapter.
// Existing api.js owns tokens, paired-host routing and request auditing; sign-in calls
// deliberately use its dedicated, unrecorded path instead of verb().
import * as api from '../api.js';
import * as passkey from '../passkey.js';
import { ACTIONS, EVENTS, STATES, needsPasskey } from '../../lib/automations-model.mjs';
async function assertion(purpose) {
  if (api.localTrusted()) return null;
  if (!passkey.available() || !passkey.registered()) {
    if (passkey.bypassAllowed()) return null;
    throw new Error('Register a passkey before continuing');
  }
  return passkey.fresh(purpose);
}
const toPhone = value => JSON.parse(JSON.stringify(value).replace(/\{proyecto\}/g, '{project}').replace(/\{sesion\}/g, '{session}').replace(/\{fecha\}/g, '{date}').replace(/\{hora\}/g, '{time}'));
const toShared = value => JSON.parse(JSON.stringify(value).replace(/\{project\}/g, '{proyecto}').replace(/\{session\}/g, '{sesion}').replace(/\{date\}/g, '{fecha}').replace(/\{time\}/g, '{hora}'));
let automations = [];
export const adapterExtras = {
  hasPeople: false,
  screenProjects: api.getProjects,
  waiting: api.getWaiting,
  reviews: api.getShots,
  review: api.getShotsRun,
  saveReview: api.postShotsVerdict,
  pendingSignIns: api.getLogins,
  startAccountLogin: api.startAccountLogin,
  async finishLogin(project, id, callback) {
    try { const r = await api.finishLogin(project, id, callback, await assertion('finish login')); return { ok:r.ok === true }; }
    finally { callback = ''; }
  },
  async finishAccountLogin(project, id, code) {
    try { const r = await api.finishAccountLogin(project, id, code, await assertion('finish login')); return { ok:r.ok === true }; }
    finally { code = ''; }
  },
  async automations() {
    const j = await api.getAutomations();
    automations = j.automations || [];
    return { ...j, automations: automations.map(a => ({ ...toShared(a), scope:'personal', mine:true, editable:true })), capabilities:{ scopes:['personal'], actions:Object.keys(ACTIONS), events:Object.keys(EVENTS), states:STATES } };
  },
  async saveAutomation(value) {
    const a = toPhone(value);
    return api.saveAutomation(a, needsPasskey(a) ? await assertion('save automation') : null);
  },
  deleteAutomation: api.deleteAutomation,
  async runAutomation(id) {
    const a = automations.find(a => a.id === id);
    return api.runAutomation(id, a && needsPasskey(a) ? await assertion('run automation') : null);
  },
  async automationAI(messages, draft) {
    const r = await api.automationDraft(messages, draft ? toPhone(draft) : null);
    return { ...r, automation:r.automation ? toShared(r.automation) : null };
  },
  automationsSeen: api.automationsSeen,
};
