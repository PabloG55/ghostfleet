// server/tasks.mjs — the list of what a person has asked for by voice, so that nothing said gets
// lost between one project and the next. It lives here, not in the page: it has to survive a
// reload, and replies have to be caught for every project at once, not just the one on screen.
//   A task is one thing asked, with one destination. It is created when the dispatcher decides
// (server/router.mjs), sent by the page, and followed from then on: this watches the session it
// went to and keeps what comes back. It leaves the list only when the person ticks it off.
//   `hidden` is a comment ("perfect, let me know") that had nowhere to attach to: not worth a row,
// but what comes back still has to be read out, with its project.
import crypto from 'node:crypto';
import { t as tr } from '../shared/i18n/index.js';

const EVERY_MS = 5000;
const FOLLOW_S = 3 * 86400;
const STUCK_S = 180;
const REPLIES = 6;
const now = () => Math.floor(Date.now() / 1000);
const place = (t) => `${t.project}\x1f${t.session}`;

export function createTasks({ fleet, readJson, writeJson, canRead = () => true }) {
  let all = readJson('tasks.json', []);
  const seen = new Map();   // place -> the session's ts last read, so a quiet session costs nothing
  const save = () => {
    const done = all.filter(t => t.done);
    all = [...all.filter(t => !t.done), ...done.slice(-100)];
    writeJson('tasks.json', all);
  };
  const open = (user) => all.filter(t => t.user === user && !t.done);
  const mine = (user, id) => open(user).find(t => t.id === id);

  function add(user, d) {
    const session = d.session || '';
    if (d.listed === false && d.project) {
      const t = open(user).filter(x => x.project === d.project && x.session === session && !x.hidden).pop();
      if (t) return { ...t, text: d.text, context: d.context, why: d.why, voice: !!d.voice };
    }
    if (d.project) for (const t of open(user)) if (t.hidden && t.project === d.project && t.session === session) t.done = true;
    const t = { id: crypto.randomBytes(6).toString('hex'), user, at: now(), from: now(), title: d.title, text: d.text, voice: !!d.voice,
                project: d.project || '', session, context: d.context || '', question: d.question || '', options: d.options || [],
                why: d.why || '', status: d.project ? 'sending' : 'ask', hidden: d.listed === false && !!d.project, replies: [], live: '' };
    all.push(t);
    save();
    return t;
  }
  // The task the person was asked about, now with a place to go.
  function settle(user, id, { project, session = '', context = '', why = '' }) {
    const t = mine(user, id);
    if (!t) return null;
    Object.assign(t, { project, session, context: context || t.context, why, status: 'sending', question: '', options: [], error: '', from: now() });
    save();
    return t;
  }
  function sent(user, id, { project, session, error }) {
    const t = mine(user, id);
    if (!t) return null;
    if (error) Object.assign(t, { status: 'failed', error: String(error).slice(0, 300), question: tr('task.missed', { project }), options: [project] });
    else Object.assign(t, { status: t.status === 'sending' ? 'sent' : t.status, lead: session });
    save();
    return t;
  }
  function done(user, id) {
    for (const t of open(user)) if (id ? t.id === id : t.status === 'replied') t.done = true;
    save();
  }

  async function watch() {
    // The page that was sending it went away halfway: say so, and let the person decide.
    for (const t of all) if (!t.done && t.status === 'sending' && now() - t.from > STUCK_S) {
      Object.assign(t, { status: 'failed', error: tr('task.unsure'), question: '', options: [t.project] });
      save();
    }
    // Someone who lost the project stops hearing from it.
    const followed = all.filter(t => !t.done && t.project && canRead(t.user, t.project) && ['sending', 'sent', 'working', 'need-you', 'replied'].includes(t.status) && now() - t.from < FOLLOW_S);
    if (!followed.length) return;
    const projects = await fleet.projects();
    const groups = new Map();
    for (const t of followed) groups.set(place(t), [...(groups.get(place(t)) || []), t]);
    let changed = false;
    for (const [key, list] of groups) {
      const { project, session } = list[0];
      const name = session || list.find(t => t.lead)?.lead || 'master';
      const p = projects.find(x => x.name === project);
      const live = session ? p?.sessions.find(s => s.name === session) : p?.sessions.find(s => s.lead);
      if (live && live.ts !== seen.get(key)) {
        let messages = [];
        try { messages = (await fleet.session(project, name)).messages || []; } catch { continue; }
        seen.set(key, live.ts);
        for (const m of messages) {
          if (m.role !== 'assistant' || !m.text) continue;
          // What comes back belongs to the last thing asked before it was written.
          const t = [...list].sort((a, b) => a.from - b.from).filter(x => x.from <= m.ts).pop();
          if (!t || t.replies.some(r => r.ts >= m.ts)) continue;
          t.replies = [...t.replies, { ts: m.ts, text: String(m.text).slice(0, 4000) }].slice(-REPLIES);
          changed = true;
        }
      }
      const newest = list.reduce((a, b) => (b.from >= a.from ? b : a));
      for (const t of list) {
        if (t.status === 'sending') continue;
        const busy = t === newest && ['working', 'need-you'].includes(live?.status);
        const status = busy ? live.status : t.replies.length ? 'replied' : 'sent';
        if (status !== t.status || t.live !== (live?.status || '')) { t.status = status; t.live = live?.status || ''; changed = true; }
      }
    }
    if (changed) save();
  }
  function start() {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try { await watch(); } catch (e) { console.log('tasks:', e.message); }
      running = false;
    }, EVERY_MS);
  }
  return { add, settle, sent, done, start, open: (user) => open(user), get: mine };
}
