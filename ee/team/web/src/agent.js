// The assistant, once for the whole app. The home page and the side panel are two views of
// this one object, so a conversation started on one is the same conversation on the other.
//
// A CONVERSATION HAS ONE OFF SWITCH. Hands-free used to re-arm the microphone from three
// places (after a reply was read, after a send, after silence), and "stop" only stopped the
// one in progress — so it went on listening, or started talking again. Now every re-arm
// asks `S.conversing` first, and stop() clears it, cancels every timer and silences
// everything at once.
import { useState, useEffect } from 'preact/hooks';
import { api } from './api.js';
import { STATUS, statusOf } from '../../../../web/ui/ui.jsx';
import { voiceStatus, listenLocal, listenBrowser, browserCanHear, speak, stopSpeaking, warmVad, PAUSES } from './voice.js';
import { command } from './resolve.js';
// `t` is a task or a transcript all through this file, so the words come in as `tr`.
import { t as tr } from './i18n.js';

const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`gfw.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`gfw.${k}`, JSON.stringify(v)); } catch {} },
};

export const S = {
  pin: store.get('pin', ''),            // who the person chose to talk to: a project's lead, or '' for auto
  target: store.get('pin', '') || store.get('target', ''),   // the project whose lead is being talked to
  targetAt: 0,                          // when it was last chosen, explicitly
  feed: [],
  phase: 'idle',                        // listening | hearing | routing | sending | starting | speaking | idle
  level: 0, interim: '',
  cards: [], focus: 'master',
  tasks: [],                            // what has been asked and not ticked off (server/tasks.mjs)
  deciding: [],                         // said, and on its way through the dispatcher
  conversing: false,
  voiceOut: store.get('voiceOut', true),
  voice: store.get('voice', ''),        // who answers: 'kokoro:<name>' or 'piper:<key>', '' = the default
  handsFree: store.get('handsFree', false),
  follow: store.get('follow', true),
  pause: PAUSES[store.get('pause', 'normal')] ? store.get('pause', 'normal') : 'normal',   // key of PAUSES
  vs: null,
};
const subs = new Set();
function set(patch) { Object.assign(S, patch); for (const f of subs) f(); }
export function useAgent() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(x => x + 1); subs.add(f); return () => subs.delete(f); }, []);
  return S;
}

let ctx = null;              // { go, me, projects, route }
let mic = null;
// Bumped by stop(). Anything started before it — a transcript still on its way back from
// whisper, a sentence Kokoro is still making, a re-arm on a timer — checks it and drops itself,
// so nothing said before "Stop" can act after it.
let gen = 0;
const timers = new Set();
const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
const push = (e) => set({ feed: [...S.feed.slice(-60), { id: Math.random(), at: Date.now(), ...e }] });
const projects = () => ctx?.projects || [];
const go = (to) => ctx?.go(to);

// What the lead is told along with the words, so it answers in a way that reads aloud well, in
// the person's language, and treats a big ask as work to hand out rather than to do in its own turn.
// The frame opens with a bracketed tag so unframe() can find it again. It used to open with an
// emoji, which a transcript written then still carries, so those are matched too (escaped: the
// source itself stays free of them, test/no-emoji.test.mjs).
const frame = (text, voice) =>
  `${voice ? '[voice]' : '[typed]'} ${tr(voice ? 'agent.frame.voice' : 'agent.frame.typed', { name: ctx.me.name })} ${tr('agent.frame.ask')}\n\n${text}`;
const FRAME_RE = /^(?:\[(?:voice|typed)\]|\u{1F399}\uFE0F?|\u{1F4AC})[^\n]*\n\n/u;
export const unframe = (t) => String(t || '').replace(FRAME_RE, '');

// ── settings ────────────────────────────────────────────────────────────────────────────
export function setOption(k, v) {
  store.set(k, v);
  set({ [k]: v });
  if (k === 'handsFree' && !v) set({ conversing: false });
  if (k === 'voiceOut' && !v) { stopSpeaking(); if (S.phase === 'speaking') set({ phase: 'idle' }); }
}
// Auto ('') lets the router place each request from what was said, as it always has. A project
// is that project's lead: the choice holds until it is changed, and a request made with no project
// page open is placed as if that page were (decide()). It used to be a pick the router never saw:
// the panel said "You're talking to the lead of acme-web" while the router placed each request
// from the words alone.
export function setPin(project) {
  store.set('pin', project || '');
  set({ pin: project || '' });
  if (project) setTarget(project);
}
export function setTarget(project, explicit = true) {
  if (!project) return;
  if (project !== S.target) { store.set('target', project); set({ target: project, cards: [], focus: 'master' }); resetWatch(); }
  if (explicit) set({ targetAt: Date.now() });
}

// ── voice in ────────────────────────────────────────────────────────────────────────────
export const canHear = () => !!S.vs?.hear?.ready || browserCanHear;
export function talk() {                      // the big button: start, or finish what is being said
  if (mic) { mic.stop(); return; }
  set({ conversing: S.handsFree });
  listen();
}
function listen() {
  if (mic) return;
  stopSpeaking();
  set({ interim: '', level: 0, phase: 'listening' });
  const my = gen;
  const common = {
    pauseMs: PAUSES[S.pause].ms,
    onState: (s) => { if (my === gen) set({ phase: s }); },
    onError: (m) => { if (my !== gen) return; push({ kind: 'event', text: m, bad: true }); set({ conversing: false }); },
    onText: (t) => {
      if (my !== gen) return;
      mic = null;
      set({ level: 0, interim: '', phase: 'idle' });
      if (t) heard(t, true);
      else if (S.conversing) { set({ conversing: false }); push({ kind: 'event', text: tr('agent.heardNothing') }); }
    },
  };
  mic = S.vs?.hear?.ready
    ? listenLocal({ ...common, onLevel: (l) => { if (my === gen) set({ level: l }); } })
    : listenBrowser({ ...common, onInterim: (t) => { if (my === gen) set({ interim: t }); } });
}
const again = () => { const my = gen; if (S.conversing && S.handsFree) later(450, () => { if (my === gen && S.conversing) listen(); }); };

// Stop everything: the microphone, the voice, the hands-free loop, anything scheduled.
export function stop() {
  gen++;
  set({ conversing: false });
  for (const t of timers) clearTimeout(t);
  timers.clear();
  if (mic) { const m = mic; mic = null; m.cancel(); }
  stopSpeaking();
  set({ phase: 'idle', interim: '', level: 0 });
}
export const busy = () => !!mic || S.phase === 'speaking' || S.conversing;

// ── voice out ───────────────────────────────────────────────────────────────────────────
function say(text, then) {
  if (!S.voiceOut) { then?.(); return; }
  const my = gen;
  set({ phase: 'speaking' });
  speak(text, () => { if (my !== gen) return; if (S.phase === 'speaking') set({ phase: 'idle' }); then?.(); }, S.voice);
}

// ── understanding ───────────────────────────────────────────────────────────────────────
// The project in front of the person, the lead they chose, or the one last talked to in the
// last quarter hour.
const context = () => ctx?.route?.project || S.pin || (S.target && Date.now() - S.targetAt < 15 * 60e3 ? S.target : null);

export function submit(text, voice = false) {
  const t = String(text || '').trim();
  if (t) heard(t, voice);
}
// A task that was waiting for a place, and the place tapped for it.
export async function place(task, project) {
  try {
    const t = await api.taskPlace(task.id, project);
    setTarget(project);
    const who = await deliver(t);
    say(who ? tr('agent.passed', { who }) : tr('task.missed', { project }), again);
  } catch (e) { push({ kind: 'event', text: tr('agent.missed', { why: e.message }), bad: true }); }
  pollTasks();
}
export function tickOff(id) { set({ tasks: S.tasks.filter(t => (id ? t.id !== id : t.status !== 'replied')) }); api.taskDone(id).catch(() => {}); }

// One decision at a time, in the order things were said: each one has to see where the last went.
let line = Promise.resolve();
let lastSaid = { text: '', at: 0 };

function heard(text, voice) {
  push({ kind: 'me', text, voice });
  const c = command(text, projects(), context());
  if (c) {
    if (c.go) go(c.go);
    if (c.project) setTarget(c.project, false);
    if (c.session) set({ focus: c.session });
    push({ kind: 'event', text: c.say });
    say(c.say, again);
    return;
  }
  if (text === lastSaid.text && Date.now() - lastSaid.at < 20000) {
    push({ kind: 'event', text: tr('agent.dupe') });
    return;
  }
  lastSaid = { text, at: Date.now() };
  const row = { id: Math.random(), text };
  set({ deciding: [...S.deciding, row] });
  line = line.then(() => decide(text, voice)).catch(() => {}).then(() => set({ deciding: S.deciding.filter(d => d !== row) }));
}

const spokenName = (p) => String(p).replace(/[-_]+/g, ' ');
const inWords = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')}${tr('common.and')}${l[l.length - 1]}`);

async function decide(text, voice) {
  const my = gen;
  set({ phase: 'routing' });
  const page = ctx?.route?.project ? { project: ctx.route.project, session: ctx.route.session || '' } : { project: S.pin, session: '' };
  const feed = S.feed.slice(0, -1).map(({ kind, text: t }) => ({ kind, text: unframe(t) }));
  let r;
  try { r = await api.route({ text, feed, page, voice }); }
  catch (e) {
    set({ phase: 'idle' });
    push({ kind: 'event', text: tr('agent.routeFailed', { text, why: e.message }), bad: true });
    say(tr('agent.routeFailedSay'), again);
    return;
  }
  if (my !== gen) { pollTasks(); return; }
  set({ phase: 'idle' });
  if (r.action === 'ask') {
    push({ kind: 'event', text: r.question, ask: true });
    say(r.question, again);
    return;
  }
  if (r.action === 'go') {
    setTarget(r.project);
    go(`/p/${encodeURIComponent(r.project)}${r.session ? `/s/${encodeURIComponent(r.session)}` : ''}`);
    const here = tr('agent.here', { project: r.project });
    push({ kind: 'event', text: here });
    say(here, again);
    return;
  }
  const going = r.tasks.filter(t => t.project), unsure = r.tasks.filter(t => !t.project);
  await pollTasks();
  const reached = [], missed = [];
  for (const t of going) {
    if (going.length === 1) setTarget(t.project);
    const who = await deliver(t, going.length > 1);
    if (who) reached.push(going.length === 1 ? who : spokenName(t.project)); else missed.push(spokenName(t.project));
  }
  for (const t of unsure) push({ kind: 'event', text: `“${t.title}”: ${t.question}`, ask: true });
  pollTasks();
  const words = [
    missed.length ? tr('task.missed', { project: inWords(missed) }) : '',
    !voice || !reached.length ? '' : reached.length === 1 ? tr('agent.passed', { who: reached[0] }) : tr('agent.noted', { n: reached.length, list: inWords(reached) }),
    unsure.length === 1 ? unsure[0].question : unsure.length ? tr('agent.unsure', { n: unsure.length }) : '',
  ].filter(Boolean).join(' ');
  if (words) say(words, again); else again();
}

// Sends one task. Answers who got it, or nothing if it did not get there: it stays on the list
// either way, with what went wrong.
async function deliver(t, quiet = false) {
  const { project, session, text, voice, context: earlier, why } = t;
  const who = session ? tr('agent.toSession', { session, project }) : tr('agent.toLead', { project });
  if (!quiet && (!ctx?.route?.session || ctx.route.project !== project)) go(`/p/${encodeURIComponent(project)}`);
  push({ kind: 'event', text: why ? tr('agent.goingWhy', { who, why }) : tr('agent.going', { who }) });
  set({ phase: 'starting', focus: session || 'master' });
  const failed = (message) => {
    set({ phase: 'idle' });
    push({ kind: 'event', text: message, bad: true });
    api.taskSent({ id: t.id, project, error: message }).catch(() => {});
    return '';
  };
  let lead = session || 'master';
  if (!session) {
    try {
      const l = await api.lead(project);
      if (l.started) push({ kind: 'event', text: l.started === 'start' ? tr('agent.leadStarted', { project }) : tr('agent.leadWoke', { project }) });
      lead = l.lead || 'master';
    } catch (e) { return failed(tr('agent.leadFailed', { project, why: e.message })); }
  }
  set({ phase: 'sending' });
  try {
    sentAt = Math.floor(Date.now() / 1000);
    const words = earlier ? `${tr('agent.earlier', { earlier })}\n\n${text}` : text;
    const r = await api.act('fleet_send', { project, session: lead, prompt: frame(words, voice) });
    if (r.queued) push({ kind: 'event', text: r.queued === 'question' ? tr('agent.queuedQ') : tr('agent.queuedTurn') });
    set({ phase: 'idle' });
    await api.taskSent({ id: t.id, project, session: lead });
    return who;
  } catch (e) { return failed(tr('agent.missedAt', { project, why: e.message })); }
}

// ── the list, and what comes back from it ───────────────────────────────────────────────
// Replies are read one after another, each saying where it comes from. A second reply used to
// cut the first one off, and one from a project no longer on screen was never read at all.
let heardUpTo = null;     // task id -> ts of the last reply taken in; null until the first load
let toRead = [];
const lastTs = (t) => t.replies.reduce((n, r) => Math.max(n, r.ts), 0);

export async function pollTasks() {
  let tasks;
  try { ({ tasks } = await api.tasks()); } catch { return; }
  set({ tasks });
  if (!heardUpTo) { heardUpTo = new Map(tasks.map(t => [t.id, lastTs(t)])); return; }
  for (const t of tasks) {
    const news = t.replies.filter(r => r.ts > (heardUpTo.get(t.id) || 0));
    if (!news.length) continue;
    heardUpTo.set(t.id, lastTs(t));
    // With two things open at the same place there is no telling which one this answers: the
    // project is certain, the task is not, so only the project is claimed.
    const sure = !t.hidden && tasks.filter(x => !x.hidden && x.project === t.project && x.session === t.session).length === 1;
    for (const r of news) push({ kind: 'ai', text: r.text, project: t.project, session: t.session, title: sure ? t.title : '' });
    const from = sure ? tr('agent.fromAbout', { project: spokenName(t.project), title: t.title }) : tr('agent.from', { project: spokenName(t.project) });
    toRead = [...toRead.filter(x => x.id !== t.id), { id: t.id, text: `${from} ${news[news.length - 1].text}` }];
  }
  readNext();
}
function readNext() {
  if (!toRead.length || mic || S.phase !== 'idle' || document.hidden) return;
  const [next, ...rest] = toRead;
  toRead = rest;
  say(next.text, () => { again(); readNext(); });
}

// ── watching: the target's fleet, and the lead's replies ────────────────────────────────
let prev = null, sentAt = 0, lastGo = 0, loop = null, taskLoop = null;
function resetWatch() { prev = null; }

async function tick() {
  if (!S.target || document.hidden) return;
  const project = S.target;
  let g;
  try { g = await api.grid(project); } catch { return; }
  if (project !== S.target) return;
  const list = g.cards || [];
  set({ cards: list });
  const before = prev;
  prev = Object.fromEntries(list.map(c => [c.name, statusOf(c)]));
  if (before) {
    for (const c of list) {
      const now = statusOf(c), was = before[c.name];
      if (was === now) continue;
      const word = (STATUS[now] || STATUS.unknown).label.toLowerCase();
      push({ kind: 'event', text: was == null ? tr('agent.opened', { name: c.name }) : c.lead ? tr('agent.leadIs', { word }) : `${c.name}: ${word}`, session: c.name, project });
      set({ focus: c.name });
      // A session the lead opened because of what this person asked is that person's.
      if (was == null && !c.lead && !c.owner && sentAt && Date.now() / 1000 - sentAt < 900) api.assign(project, c.name, ctx.me.id).catch(() => {});
      const worth = was == null || now === 'need-you' || (now === 'working' && !c.lead);
      if (S.follow && worth && !c.lead && Date.now() - lastGo > 3000) { lastGo = Date.now(); go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(c.name)}`); }
    }
  }
}

export function bind(next) {
  ctx = next;
  if (!loop) {
    loop = setInterval(tick, 2500);
    taskLoop = setInterval(pollTasks, 3000);
    pollTasks();
    resetWatch();
    voiceStatus(true).then(vs => { set({ vs }); if (vs.hear?.ready) warmVad(); });
  }
}
export function unbind() { stop(); clearInterval(loop); clearInterval(taskLoop); loop = null; heardUpTo = null; toRead = []; ctx = null; }
