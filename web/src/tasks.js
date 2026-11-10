// web/src/tasks.js — the assistant's dispatcher and its list of what was asked, for an app whose
// server has neither: fleet-serve has no router and no task store, so this device keeps both.
//
// The team server decides where a request goes with a model (server/router.mjs) and keeps the
// list on disk (server/tasks.mjs). Here the deciding is the plain rule a person would use:
//   - on a project or a session's page, it goes there (the page is the context);
//   - otherwise, to Jarvis's lead when this machine runs Jarvis (it is the one that dispatches);
//   - otherwise, to the only project there is;
//   - otherwise it is a task with no place yet, and the list asks which project, with the names.
// web/ui/resolve.js has already taken the things that are not requests ("open acme-api", "stop
// talking") before this is asked; agent.js runs that first in both apps.
//
// THE LIST IS THIS DEVICE'S, in localStorage. A reply is caught the way server/tasks.mjs catches
// one: what the destination session wrote after the task was sent belongs to the last task sent
// there before it was written. Followed for three days, as there.
const KEY = 'gf.tasks';
const FOLLOW_S = 3 * 86400;
const STUCK_S = 180;
const REPLIES = 6;
const now = () => Math.floor(Date.now() / 1000);
const id = () => Math.random().toString(16).slice(2, 14);

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function save(all) {
  const done = all.filter(t => t.done);
  const keep = [...all.filter(t => !t.done), ...done.slice(-50)];
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch {}
}

const title = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

// `fleet` is what the adapter reads with: { projects() → names, jarvis() → project | null,
// session(project, name) → { messages }, grid(project) → { cards } }. `tr` is the words.
export function createTasks(fleet, tr) {
  const open = () => load().filter(t => !t.done);

  function add(d) {
    const all = load();
    const t = { id: id(), at: now(), from: now(), title: title(d.text), text: d.text, voice: !!d.voice,
                project: d.project || '', session: d.session || '', context: '', why: d.why || '',
                question: d.question || '', options: d.options || [], status: d.project ? 'sending' : 'ask',
                hidden: false, replies: [], live: '' };
    all.push(t);
    save(all);
    return t;
  }

  async function route({ text, page, voice }) {
    const names = await fleet.projects();
    if (page?.project && names.includes(page.project))
      return { action: 'tasks', tasks: [add({ text, voice, project: page.project, session: page.session || '', why: tr('task.why.page') })] };
    const jarvis = await fleet.jarvis().catch(() => null);
    if (jarvis && names.includes(jarvis))
      return { action: 'tasks', tasks: [add({ text, voice, project: jarvis, why: tr('task.why.jarvis') })] };
    if (names.length === 1)
      return { action: 'tasks', tasks: [add({ text, voice, project: names[0], why: tr('task.why.only') })] };
    if (!names.length) return { action: 'ask', tasks: [], question: tr('task.noProjects') };
    return { action: 'tasks', tasks: [add({ text, voice, question: tr('task.which'), options: names })] };
  }

  function edit(tid, fn) {
    const all = load();
    const t = all.find(x => x.id === tid && !x.done);
    if (!t) return null;
    fn(t);
    save(all);
    return t;
  }
  const place = async (tid, project) => {
    const t = edit(tid, (x) => Object.assign(x, { project, session: '', status: 'sending', question: '', options: [], error: '', from: now() }));
    if (!t) throw new Error(tr('task.gone'));
    return t;
  };
  const sent = async ({ id: tid, project, session, error }) => {
    edit(tid, (x) => (error
      ? Object.assign(x, { status: 'failed', error: String(error).slice(0, 300), question: tr('task.missed', { project }), options: [project] })
      : Object.assign(x, { status: x.status === 'sending' ? 'sent' : x.status, lead: session })));
    return { ok: true };
  };
  const done = async (tid) => {
    const all = load();
    for (const t of all) if (!t.done && (tid ? t.id === tid : t.status === 'replied')) t.done = true;
    save(all);
    return { ok: true };
  };

  // Each place read at most every ten seconds: agent.js asks for the list every three.
  const lastRead = new Map();
  async function watch() {
    const all = load();
    let changed = false;
    for (const t of all) if (!t.done && t.status === 'sending' && now() - t.from > STUCK_S) {
      Object.assign(t, { status: 'failed', error: tr('task.unsure'), question: '', options: [t.project] });
      changed = true;
    }
    const followed = all.filter(t => !t.done && t.project && ['sent', 'working', 'need-you', 'replied'].includes(t.status) && now() - t.from < FOLLOW_S);
    const groups = new Map();
    for (const t of followed) {
      const key = `${t.project}\x1f${t.session || t.lead || 'master'}`;
      groups.set(key, [...(groups.get(key) || []), t]);
    }
    for (const [key, list] of groups) {
      if (Date.now() - (lastRead.get(key) || 0) < 10000) continue;
      lastRead.set(key, Date.now());
      const [project, name] = key.split('\x1f');
      let messages = [], live = '';
      try { messages = (await fleet.session(project, name)).messages || []; } catch { continue; }
      try { live = ((await fleet.grid(project)).cards || []).find(c => c.name === name)?.status || ''; } catch {}
      for (const m of messages) {
        if (m.role !== 'assistant' || !m.text) continue;
        const t = [...list].sort((a, b) => a.from - b.from).filter(x => x.from <= m.ts).pop();
        if (!t || t.replies.some(r => r.ts >= m.ts)) continue;
        t.replies = [...t.replies, { ts: m.ts, text: String(m.text).slice(0, 4000) }].slice(-REPLIES);
        changed = true;
      }
      const newest = list.reduce((a, b) => (b.from >= a.from ? b : a));
      for (const t of list) {
        const busy = t === newest && ['working', 'need-you'].includes(live);
        const status = busy ? live : t.replies.length ? 'replied' : 'sent';
        if (status !== t.status || t.live !== live) { t.status = status; t.live = live; changed = true; }
      }
    }
    if (changed) save(all);
  }
  let watching = null;
  const tasks = async () => {
    if (!watching) watching = watch().catch(() => {}).finally(() => { watching = null; });
    await watching;
    return { tasks: open() };
  };

  return { route, tasks, taskSent: sent, taskPlace: place, taskDone: done };
}
