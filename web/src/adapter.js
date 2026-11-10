// web/src/adapter.js — the phone's side of web/ui/adapter.jsx: the shared screens' fleet, over
// fleet-serve (bin/fleet-serve.mjs), through the client that has always talked to it (web/api.js).
//
// The team app's adapter (ee/team/web/src/adapter.js) speaks to a multi-user server that already
// answers in the shapes the screens draw. fleet-serve answers in its own, older ones, so this file
// is mostly translation, and every translation is here rather than in a screen:
//   - a project: /api/projects's row and rollup, plus its sessions — from /api/digest for this
//     machine's fleets (one read for all of them) and from the grid for a paired host's;
//   - a session: `queue` is what the screens call `queued`;
//   - Activity: the hash-chained audit log, newest first, with the device that did it as `by`;
//   - the assistant: fleet-serve has no router and no task list, so web/src/tasks.js is both;
//   - voice: /api/voice, /api/voice/hear and /api/speak, the sentence audio fetched with the
//     session's bearer token and handed back as a blob URL (an <audio> cannot send a header).
//
// THE PASSKEY IS ASKED FOR HERE, at the moment of a change, for exactly the verbs fleet-serve
// gates on one (TOOLS_ALLOWED `passkey: true`). It is not the enforcement — the server is — it is
// what makes a phone in someone else's hand different from a phone plus its owner.
import * as api from '../api.js';
import * as pk from '../passkey.js';
import * as push from './push.js';
import { createTasks } from './tasks.js';
import { t } from '../ui/i18n.js';

// fleet-serve's TOOLS_ALLOWED entries marked `passkey: true`.
export const PASSKEY = new Set(['fleet_spawn', 'fleet_stop', 'fleet_rename', 'fleet_worktree_remove', 'fleet_project_add']);
// The team server's own verbs for a card's label and its scheduled continue. fleet-serve refuses
// both by name (its NOT_YET table: the grid owns those marker files, and a second writer of them
// would drift), so the session screen does not offer them here (`can`) instead of offering them
// and failing on every tap.
export const NOT_SERVED = new Set(['gfw_label', 'gfw_schedule', 'gfw_unschedule']);

// Which of the two devices passkey.js knows this is, so the words can be whole sentences in
// each language rather than its English noun ("this Mac") spliced into a Spanish one.
export const devKind = () => (/Mac/.test(pk.device().noun) ? 'mac' : 'phone');

// Another machine's project is addressed `<name>@<host key>` (fleet-serve mergeProjects).
export const remote = (project) => /@[^@]+$/.test(String(project || ''));

// A destructive verb's assertion. One prepared ahead of the tap is used when there is one
// (passkey.js freshNow: WebKit keeps the tap's activation only if nothing is awaited first);
// otherwise the ceremony fetches its own challenge. Fixtures with no passkey need none.
function assertFor(purpose) {
  if (!pk.available() || !pk.registered()) {
    if (pk.bypassAllowed()) return Promise.resolve(null);
    return Promise.reject(new Error(t('lock.noPasskey', { why: pk.unavailableReason() || t('lock.enrolHint') })));
  }
  return pk.freshReady() ? pk.freshNow(purpose) : pk.fresh(purpose);
}

// Sessions as the shared Board and map draw them: name, status, the time of its last activity,
// and whether it is the lead.
const fromCards = (cards) => {
  const at = Math.floor(Date.now() / 1000);
  return (cards || []).map(c => ({ name: c.name, status: c.status, ts: at - (Number(c.age) || 0), lead: !!c.lead }));
};
function counted(sessions) {
  const counts = { need_you: 0, working: 0, ready: 0, parked: 0, lost: 0, total: 0 };
  for (const s of sessions) {
    counts.total++;
    if (s.status === 'need-you') counts.need_you++;
    else if (s.status in counts) counts[s.status]++;
  }
  return counts;
}

export function phoneAdapter({ lock, go, place }) {
  // Every read and write goes through here, so a session the server let lapse locks the app
  // wherever it was noticed, instead of each screen showing "the server rejected the token".
  const guard = (p) => p.catch((e) => { if (e instanceof api.AuthError) lock(); throw e; });

  // A paired host's grid is read only for its boats, and it is the most expensive read there is
  // (one fleet-grid run on the other machine, through this one): kept for 15 s.
  const peerGrids = new Map();
  async function peerSessions(name) {
    const hit = peerGrids.get(name);
    if (hit && Date.now() - hit.at < 15000) return hit.sessions;
    let sessions = hit ? hit.sessions : [];
    try { sessions = fromCards((await api.getGrid(name)).cards); } catch {}
    peerGrids.set(name, { at: Date.now(), sessions });
    return sessions;
  }

  // Projects, in the shape every shared screen reads, with the machine each one is on.
  async function projects() {
    const j = await guard(api.getProjects());
    const digest = await api.getDigest().catch(() => null);
    const local = new Map((digest?.projects || []).map(p => [p.name, p]));
    const rows = await Promise.all((j.projects || []).map(async (p) => {
      const d = !p.host_key && local.get(p.name);
      const sessions = d ? (d.sessions || []).map(s => ({ name: s.name, status: s.status, ts: s.ts, lead: !!s.lead }))
        : p.host_key ? await peerSessions(p.name)
        : fromCards((await api.getGrid(p.name).catch(() => ({ cards: [] }))).cards);
      return { name: p.name, path: p.path, profile: p.profile, agent: p.agent || null, model: p.model || null,
               host: p.host || '', host_key: p.host_key || '', sched: p.sched || null, counts: counted(sessions), sessions };
    }));
    return { projects: rows, hosts: j.hosts || [] };
  }

  // Jarvis's project on this machine, if it runs one: where a request with no page goes.
  let jarvisAt = 0, jarvis = null;
  async function jarvisProject() {
    if (Date.now() - jarvisAt < 60000) return jarvis;
    jarvisAt = Date.now();
    try { const j = await api.getJarvis(); jarvis = j && j.present !== false && j.project ? j.project : null; }
    catch { jarvis = null; }
    return jarvis;
  }

  async function act(tool, args = {}, opts = {}) {
    void opts;
    if (NOT_SERVED.has(tool)) throw new Error(t('phone.notServed'));
    const assertion = PASSKEY.has(tool) ? await assertFor(`${tool} ${args.session || args.name || args.path || ''}`.trim()) : null;
    return guard(api.verb(tool, args, assertion));
  }

  // The lead, started if it is not running: the team server's /api/lead, done from here.
  async function lead(project) {
    const find = async () => ((await guard(api.getGrid(project))).cards || []).find(c => c.lead);
    const m = await find();
    let did = null;
    if (!m) {
      const p = ((await api.getProjects()).projects || []).find(x => x.name === project);
      if (!p || remote(project)) throw new Error(t('phone.noLead', { project }));
      did = 'start';
      await act('fleet_project_add', { path: p.path, name: p.name, profile: p.profile, start: true });
    } else if (m.lost || m.exited) { did = 'reopen'; await act('fleet_reopen', { project, session: m.name }); }
    else if (m.asleep) { did = 'wake'; await act('fleet_wake', { project, session: m.name }); }
    else if (m.status === 'parked') { did = 'resume'; await act('fleet_resume', { project, session: m.name }); }
    if (!did) return { ok: true, started: null, lead: m.name };
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const n = await find().catch(() => null);
      if (n && !n.lost && !n.asleep && !['starting', 'unknown'].includes(n.status)) return { ok: true, started: did, lead: n.name };
    }
    return { ok: true, started: did, lead: m ? m.name : 'master' };
  }

  const tasks = createTasks({
    projects: async () => ((await api.getProjects()).projects || []).map(p => p.name),
    jarvis: jarvisProject,
    session: (project, name) => api.getSession(project, name),
    grid: (project) => api.getGrid(project),
  }, t);

  // The sentence audio, as URLs an <audio> can play. The last few are kept and the older ones
  // let go, so a long reply does not pin every sentence it ever spoke in memory.
  const urls = [];
  async function speakAudio(id) {
    const buf = await guard(api.speakAudio(id));
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    urls.push(url);
    while (urls.length > 8) { try { URL.revokeObjectURL(urls.shift()); } catch {} }
    return url;
  }

  const server = () => api.mode() === 'server';

  return {
    projects,
    grid: (project) => guard(api.getGrid(project)),
    session: async (project, name, before) => {
      const r = await guard(api.getSession(project, name, before));
      return { ...r, queued: r.queue || r.queued || [] };
    },
    pane: (project, name) => guard(api.getPane(project, name)),
    act,
    attach: (project, session, file) => guard(api.attach(project, session, file)),
    attachPerMessage: api.ATTACH_PER_MESSAGE,
    lead,
    // The terminal and the editor: this machine's projects only (a paired host's shell is not
    // reachable from here, by decision), and only against a server — fixtures have no tmux.
    canTerm: (project) => server() && !remote(project),
    // Each open takes a fresh assertion, made inside the tap when one is prepared (passkey.js
    // freshNow). The first open after a tab is drawn may come too late for WebKit to count the
    // tap; the screen then offers "open again", and that tap reaches the sensor itself.
    termOpen: (project, kind, size) => {
      const asking = pk.available() && pk.registered()
        ? pk.freshNow(`${kind === 'edit' ? 'editor' : 'terminal'} ${project}`) : Promise.resolve(null);
      return guard(asking.then((a) => api.termOpen(project, size, a, kind)));
    },
    termSocket: api.termSocket,
    go,
    place,
    // Every shared page: fleet-serve has them all.
    offers: () => true,
    can: (verb) => !NOT_SERVED.has(verb),
    activity: async () => {
      const j = await guard(api.getAudit(100));
      return { rows: (j.rows || []).filter(r => !r.unparseable).reverse()
        .map(r => ({ ...r, by: r.client || '', result: r.result === 'ran' ? 'ran' : r.result === 'refused' ? 'refused' : r.result })) };
    },
    // The assistant (web/ui/agent.js).
    ...tasks,
    voice: async () => {
      const j = await api.getVoice();
      return { hear: { ready: server() && !!j.voice?.ready, why: j.voice?.why || null },
               speak: { ready: server() && !!j.speak?.ready, why: j.speak?.why || null } };
    },
    hear: (wav) => guard(api.hear(wav)),
    speak: async (text) => ({ sentences: await guard(api.speakPlan(text)) }),
    speakAudio,
    settings: {
      push: {
        state: () => push.state(t),
        set: (on) => (on ? push.enable(t) : push.disable()),
      },
      terminal: {
        state: async () => {
          if (!server()) return { ready: false, why: t('phone.termFixtures') };
          try { const j = await guard(api.getTerm()); return { ready: true, on: !!j.enabled, why: j.enabled ? t('phone.termOn') : '' }; }
          catch (e) { return { ready: false, why: e.status === 404 ? t('phone.termOld') : e.message }; }
        },
        // ON is a grant and takes a fresh passkey (fleet-serve /api/term/enable); OFF takes one away.
        set: async (on) => { const a = on && pk.registered() ? await pk.fresh('terminal on') : null; await guard(api.termEnable(on, a)); },
      },
      hosts: {
        list: async () => ((await guard(api.getProjects())).hosts || []),
        unpair: (key) => guard(api.unpairHost(key)),
      },
      device: {
        state: () => {
          const k = devKind();
          if (!pk.available()) return { text: t('phone.noSensor'), detail: pk.unavailableReason() };
          return pk.registered() ? { text: t(`dev.${k}.has`) } : { text: t(`dev.${k}.none`), detail: t(`dev.${k}.enrol`) };
        },
        actions: () => [
          { id: 'lock', label: t('phone.lockNow'), run: () => lock() },
          ...(pk.registered() ? [{ id: 'forget', label: t('phone.forget'), kind: 'danger', run: () => { pk.forget(); lock(); } }] : []),
        ],
      },
      connection: {
        state: () => {
          const r = api.resolution(), pref = api.pref();
          return { text: r.detail || api.modeLabel(), choice: pref.kind, detail: pref.base || '' };
        },
        choices: () => [
          { value: 'auto', label: t('phone.conn.auto') },
          { value: 'fixtures', label: t('phone.conn.fixtures') },
          { value: 'server', label: t('phone.conn.server') },
        ],
        // Pointing the app somewhere else is a new session: the lock comes down, as a cold open's would.
        choose: async (v, url) => {
          if (v === 'auto') api.useAutoDetect();
          else if (v === 'fixtures') api.useFixtures();
          else { if (!/^https?:\/\//.test(String(url || ''))) return; api.setBaseUrl(url); }
          await api.reprobe();
          lock();
        },
      },
      about: () => t('phone.about', { shell: push.shellVersion() || '?', mode: api.modeLabel() }),
    },
    slots: {},
  };
}
