// The only file that talks to the network.
import { t, lang } from './i18n.js';

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-GFW': '1', 'X-GFW-Lang': lang(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok || (j && j.ok === false)) {
    const e = new Error((j && j.text) || `error ${res.status}`);
    e.status = res.status; e.body = j;
    throw e;
  }
  return j;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

export const api = {
  health: () => call('GET', '/api/health'),
  login: (name, password, lang) => call('POST', '/api/login', { name, password, lang }),
  setLang: (lang) => call('POST', '/api/lang', { lang }),
  logout: () => call('POST', '/api/logout'),
  users: () => call('GET', '/api/users'),
  password: (old, nw) => call('POST', '/api/password', { old, new: nw }),
  projects: () => call('GET', '/api/projects'),
  grid: (project) => call('GET', `/api/grid?${qs({ project })}`),
  session: (project, session, before) => call('GET', `/api/session?${qs({ project, session, before })}`),
  pane: (project, session) => call('GET', `/api/pane?${qs({ project, session })}`),
  presence: (project, session, typing) => call('POST', '/api/presence', { project, session, typing }),
  assign: (project, session, owner) => call('POST', '/api/assign', { project, session, owner }),
  activity: () => call('GET', '/api/activity'),
  act: (tool, args, { confirm = false, owner } = {}) => call('POST', '/api/act', { tool, args, confirm, owner }),
  resetDemo: () => call('POST', '/api/demo/reset'),
  voice: () => call('GET', '/api/voice'),
  usage: () => call('GET', '/api/usage'),
  adminUsage: () => call('GET', '/api/admin/usage'),
  setTokenCap: (user, daily, monthly) => call('POST', '/api/admin/usage/cap', { user, daily, monthly }),
  lead: (project) => call('POST', '/api/lead', { project }),
  // A project's terminal or editor (server/TERMINAL.md): a 30-second ticket, then the socket.
  termOpen: (project, kind, size) => call('POST', '/api/term/open', { project, kind, ...(size || {}) }),
  termSocket: (ticket) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/ws?${qs({ ticket })}`);
    ws.binaryType = 'arraybuffer';
    return ws;
  },
  speak: (text, voice) => call('POST', '/api/speak', { text, voice }),
  // A 16 kHz WAV of what was said; the text whisper heard in it.
  hear: async (wav) => {
    const res = await fetch('/api/hear', { method: 'POST', headers: { 'X-GFW': '1', 'X-GFW-Lang': lang(), 'Content-Type': 'audio/wav' }, body: wav, credentials: 'same-origin' });
    let j = null; try { j = await res.json(); } catch {}
    if (!res.ok || !j?.ok) throw new Error(j?.text || `error ${res.status}`);
    return j;
  },
  route: (b) => call('POST', '/api/route', b),
  tasks: () => call('GET', '/api/tasks'),
  taskSent: (b) => call('POST', '/api/tasks/sent', b),
  taskPlace: (id, project) => call('POST', '/api/tasks/place', { id, project }),
  taskDone: (id) => call('POST', '/api/tasks/done', { id }),
  voices: () => call('GET', '/api/voices'),
  installVoice: (key) => call('POST', '/api/voices/install', { key }),
  deleteVoice: (key) => call('POST', '/api/voices/delete', { key }),
  // Administration; the server answers all of it with 404 to anyone who is not an admin.
  admin: {
    users: () => call('GET', '/api/admin/users'),
    addUser: (b) => call('POST', '/api/admin/users', b),
    updateUser: (b) => call('POST', '/api/admin/users/update', b),
    resetPassword: (id) => call('POST', '/api/admin/users/reset', { id }),
  },
  automations: () => call('GET', '/api/automations'),
  saveAutomation: (automation) => call('POST', '/api/automations', { automation }),
  deleteAutomation: (id) => call('POST', '/api/automations/delete', { id }),
  runAutomation: (id) => call('POST', '/api/automations/run', { id }),
  automationAI: (messages, draft) => call('POST', '/api/automations/ai', { messages, draft }),
  aiAccount: () => call('GET', '/api/admin/ai'),
  aiAct: (b) => call('POST', '/api/admin/ai', b),
  // The file's own bytes as the body (no base64), where it goes in the query.
  attach: async (project, session, file) => {
    if (file.size > ATTACH_MAX_BYTES) throw new Error(t('attach.tooBig', { name: file.name, mb: ATTACH_MAX_BYTES / 1048576 }));
    const res = await fetch(`/api/attach?${qs({ project, session, name: file.name })}`, {
      method: 'POST', headers: { 'X-GFW': '1', 'X-GFW-Lang': lang(), 'Content-Type': file.type || 'application/octet-stream' },
      body: file, credentials: 'same-origin',
    });
    let j = null; try { j = await res.json(); } catch {}
    if (!res.ok || !j?.ok) throw new Error(j?.text || `error ${res.status}`);
    return j;
  },
};
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;     // server/attach.mjs holds the same
export const ATTACH_PER_MESSAGE = 10;
