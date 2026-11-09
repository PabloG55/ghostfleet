// shared/automations.js — what an automation IS, for the server that runs it and the page that
// edits it: the shapes, the one function that cleans what a person (or the AI) wrote into a
// shape the runner can trust, when it fires next, and how it reads out loud in a sentence.
//
// An automation is a trigger and a list of steps, run top to bottom:
//   { id, name, scope: 'personal'|'company', createdBy, savedBy, enabled,
//     trigger: { type: 'schedule', mode: 'once'|'days'|'every', date, at, days, minutes }
//            | { type: 'event', event, project, session, cooldown },
//     steps: [{ action, project, session, prompt, name, branch, minutes, text, confirmed }] }
// A step's project/session can be the literal '{proyecto}' / '{sesion}': the session the
// event happened to. Prompts, names and notices can use {fecha} {hora} {proyecto} {sesion}.
//
// The scope (docs/TEAM-ARCHITECTURE.md §5) says who sees it and whose permissions it runs with:
// a personal one is its creator's, and runs as them; a company one is made by an admin, seen by
// whoever can read its projects, and runs as the admin who saved it last (`savedBy`).

import { t, worded, words } from './i18n/index.js';

// Each table's words are read when they are shown (shared/i18n's worded()), in the language of
// whoever is looking: `label` from 'event.<k>', the rest from 'event.<k>.<field>'.
export const EVENTS = worded({
  finished: {}, 'need-you': {}, started: {}, limit: {}, lost: {},
}, 'event', ['label', 'hint', 'verb']);

// Each action: the words, the MCP tool it becomes, and which fields it needs. `icon` names a
// sprite in web/src/icon.jsx, never a character: an emoji is drawn by the platform's font.
export const ACTIONS = worded({
  send:      { icon: 'mail',      tool: 'fleet_send',      needs: ['project', 'session', 'prompt'] },
  spawn:     { icon: 'plus',      tool: 'fleet_spawn',     needs: ['project', 'name'], optional: ['prompt', 'branch'] },
  pause:     { icon: 'pause',     tool: 'fleet_pause',     needs: ['project', 'session'] },
  resume:    { icon: 'play',      tool: 'fleet_resume',    needs: ['project', 'session'], optional: ['prompt'] },
  wake:      { icon: 'sun',       tool: 'fleet_wake',      needs: ['project', 'session'] },
  interrupt: { icon: 'hand',      tool: 'fleet_interrupt', needs: ['project', 'session'] },
  reopen:    { icon: 'refresh',   tool: 'fleet_reopen',    needs: ['project', 'session'] },
  stop:      { icon: 'stop',      tool: 'fleet_stop',      needs: ['project', 'session'], danger: true },
  check:     { icon: 'question',  tool: null,              needs: ['project', 'session', 'status'] },
  notify:    { icon: 'bell',      tool: null,              needs: ['text'] },
  wait:      { icon: 'hourglass', tool: null,              needs: ['minutes'] },
  summary:   { icon: 'clipboard', tool: null,              needs: [] },
}, 'action');

// What each action asks of access.mjs's can(), for the person it runs as. pause/interrupt are
// the session's work stopping, like stop; wake/resume/reopen bring a session back to take
// prompts; a condition and a summary only read.
export const NEEDS = {
  send: 'prompt', spawn: 'spawn', pause: 'stop', resume: 'prompt', wake: 'prompt', interrupt: 'stop',
  reopen: 'spawn', stop: 'stop', check: 'read', notify: null, wait: null, summary: 'read',
};

export const SCOPES = words(['personal', 'company'], 'scope');

// The projects an automation names outright: its steps' and an event trigger's. '{proyecto}'
// and '*' are decided when it fires, and are checked then.
export function projectsOf(a) {
  const out = new Set();
  if (a?.trigger?.type === 'event' && a.trigger.project && a.trigger.project !== '*') out.add(a.trigger.project);
  for (const s of a?.steps || []) if (s.project && s.project !== '{proyecto}') out.add(s.project);
  return [...out];
}

// What a "Continue only if…" step can ask a session to be (the digest's statuses).
export const STATES = words(['need-you', 'working', 'ready', 'idle', 'parked', 'limit', 'interrupted', 'asleep', 'lost'], 'state');

export const LIMITS = { steps: 20, prompt: 4000, name: 80, text: 300, waitMin: 60, cooldownMin: 1440 };
export const DAY_NAMES = words(['0', '1', '2', '3', '4', '5', '6'], 'day');            // 0 = Sunday
const SESSION_OK = /^[A-Za-z0-9][A-Za-z0-9 ._~-]{0,47}$/;
const TEMPLATE_OK = /^[A-Za-z0-9{}][A-Za-z0-9 ._~{}-]{0,79}$/;     // a name that may hold {fecha}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const bad = (text) => Object.assign(new Error(text), { status: 400 });

export const blankTrigger = (type = 'schedule') => (type === 'event'
  ? { type: 'event', event: 'finished', project: '*', session: '*', cooldown: 10 }
  : { type: 'schedule', mode: 'days', at: '10:00', days: [1, 2, 3, 4, 5], date: '', minutes: 60 });
export const blankStep = (action) => ({ action, project: '', session: '', prompt: '', name: '', branch: '',
  minutes: action === 'wait' ? 5 : 0, text: '', status: action === 'check' ? ['need-you'] : [], confirmed: false });

// Clean an automation as written into one the runner can trust; throws a 400 with the words
// a person can act on. `strict` (saving an enabled one) also requires every field filled.
export function normalize(raw, { strict = true } = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const name = str(a.name, LIMITS.name) || t('auto.unnamed');
  const tr = a.trigger && typeof a.trigger === 'object' ? a.trigger : {};
  let trigger;
  if (tr.type === 'event') {
    if (!EVENTS[tr.event]) throw bad(t('auto.err.event', { event: String(tr.event) }));
    const project = str(tr.project, 80) || '*', session = str(tr.session, 48) || '*';
    if (session !== '*' && !SESSION_OK.test(session)) throw bad(t('auto.err.triggerSession', { session }));
    const cooldown = Math.max(1, Math.min(LIMITS.cooldownMin, Math.round(Number(tr.cooldown) || 10)));
    trigger = { type: 'event', event: tr.event, project, session, cooldown };
  } else {
    const mode = ['once', 'days', 'every'].includes(tr.mode) ? tr.mode : 'days';
    const at = HHMM.test(tr.at) ? tr.at : '10:00';
    const days = [...new Set((Array.isArray(tr.days) ? tr.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
    const date = DATE.test(tr.date) ? tr.date : '';
    const minutes = Math.max(15, Math.min(7 * 1440, Math.round(Number(tr.minutes) || 60)));
    if (strict && mode === 'once' && !date) throw bad(t('auto.err.onceDate'));
    if (strict && mode === 'days' && !days.length) throw bad(t('auto.err.days'));
    trigger = { type: 'schedule', mode, at, days, date, minutes };
  }
  const list = Array.isArray(a.steps) ? a.steps : [];
  if (list.length > LIMITS.steps) throw bad(t('auto.err.maxSteps', { n: LIMITS.steps }));
  const steps = list.map((s, i) => {
    const action = s?.action;
    const def = ACTIONS[action];
    if (!def) throw bad(t('auto.err.action', { i: i + 1, action: String(action) }));
    const o = { action };
    if (def.needs.includes('project')) o.project = str(s.project, 80);
    if (def.needs.includes('session')) {
      o.session = str(s.session, 48);
      if (o.session && o.session !== '{sesion}' && !SESSION_OK.test(o.session)) throw bad(t('auto.err.stepSession', { i: i + 1, session: o.session }));
    }
    if (def.needs.includes('prompt') || def.optional?.includes('prompt')) o.prompt = str(s.prompt, LIMITS.prompt);
    if (def.needs.includes('name')) {
      o.name = str(s.name, 80);
      if (o.name && !TEMPLATE_OK.test(o.name)) throw bad(t('auto.err.stepName', { i: i + 1 }));
    }
    if (def.optional?.includes('branch')) o.branch = str(s.branch, 80);
    if (action === 'wait') o.minutes = Math.max(1, Math.min(LIMITS.waitMin, Math.round(Number(s.minutes) || 1)));
    if (action === 'notify') o.text = str(s.text, LIMITS.text);
    if (action === 'check') o.status = [...new Set((Array.isArray(s.status) ? s.status : []).filter(x => STATES[x]))];
    if (def.danger) o.confirmed = s.confirmed === true;
    if (strict) {
      for (const f of def.needs) if (o[f] === '' || o[f] == null || (Array.isArray(o[f]) && !o[f].length)) throw bad(t('auto.err.missing', { i: i + 1, action: def.label, field: FIELD.includes(f) ? t(`auto.field.${f}`) : f }));
      if (def.danger && !o.confirmed) throw bad(t('auto.err.confirm', { i: i + 1, action: def.label }));
      if ((o.project === '{proyecto}' || o.session === '{sesion}') && trigger.type !== 'event')
        throw bad(t('auto.err.eventOnly', { i: i + 1 }));
    }
    return o;
  });
  if (strict && !steps.length) throw bad(t('auto.err.noSteps'));
  return {
    id: str(a.id, 40) || null, name, enabled: a.enabled !== false,
    scope: a.scope === 'company' ? 'company' : 'personal', trigger, steps,
  };
}
const FIELD = ['status', 'project', 'session', 'prompt', 'name', 'text', 'minutes'];

// ── when ─────────────────────────────────────────────────────────────────────────────
const localAt = (y, m, d, hhmm) => { const [h, mi] = hhmm.split(':').map(Number); return Math.floor(new Date(y, m, d, h, mi, 0).getTime() / 1000); };

// The first time the trigger fires strictly after `t` (epoch seconds), or null if never.
// `anchor` is when an "every N minutes" one started counting.
export function nextAfter(trigger, t, anchor = t) {
  if (!trigger || trigger.type !== 'schedule') return null;
  if (trigger.mode === 'once') {
    if (!trigger.date) return null;
    const [y, m, d] = trigger.date.split('-').map(Number);
    const at = localAt(y, m - 1, d, trigger.at);
    return at > t ? at : null;
  }
  if (trigger.mode === 'every') {
    const step = trigger.minutes * 60;
    const k = Math.floor((t - anchor) / step) + 1;
    return anchor + Math.max(1, k) * step;
  }
  const base = new Date(t * 1000);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    if (!trigger.days.includes(d.getDay())) continue;
    const at = localAt(d.getFullYear(), d.getMonth(), d.getDate(), trigger.at);
    if (at > t) return at;
  }
  return null;
}

// ── words ────────────────────────────────────────────────────────────────────────────
const anyOr = (v, word) => (!v || v === '*' ? word : v);
function daysWords(days) {
  const s = [...days].sort().join(',');
  if (s === '0,1,2,3,4,5,6') return t('auto.days.all');
  if (s === '1,2,3,4,5') return t('auto.days.weekdays');
  if (s === '0,6') return t('auto.days.weekends');
  return t('auto.days.list', { days: days.map(d => DAY_NAMES[d]).join(', ') });
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function describeTrigger(tr) {
  if (!tr) return '';
  if (tr.type === 'event') {
    const who = tr.session && tr.session !== '*' ? t('auto.trig.session', { session: tr.session }) : t('auto.trig.anySession');
    return t('auto.trig.event', { who, project: anyOr(tr.project, t('auto.trig.anyProject')), what: EVENTS[tr.event]?.verb || tr.event });
  }
  if (tr.mode === 'once') return t('auto.trig.once', { date: tr.date ? tr.date.split('-').reverse().join('/') : '?', at: tr.at });
  if (tr.mode === 'every') return t('auto.trig.every', { every: everyWords(tr.minutes) });
  return t('auto.trig.days', { days: cap(daysWords(tr.days)), at: tr.at });
}
// 90 → "90 min", 120 → "2 h", 2880 → "2 days".
export const everyWords = (m) => (m % 1440 === 0 ? t('auto.every.days', { n: m / 1440 }) : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const where = (s) => `${s.session === '{sesion}' ? t('auto.step.eventSession') : s.session || '?'}${s.project && s.project !== '{proyecto}' ? ` (${s.project})` : ''}`;
const clip = (x) => `${String(x || '').slice(0, 60)}${String(x || '').length > 60 ? '…' : ''}`;
export function describeStep(s) {
  const d = ACTIONS[s.action];
  if (!d) return s.action;
  switch (s.action) {
    case 'send': return t('auto.step.send', { where: where(s), prompt: clip(s.prompt) });
    case 'spawn': return t(s.prompt ? 'auto.step.spawnTask' : 'auto.step.spawn', { name: s.name || '?', project: s.project || '?' });
    case 'notify': return t('auto.step.notify', { text: String(s.text || '').slice(0, 60) });
    case 'wait': return t('auto.step.wait', { minutes: s.minutes });
    case 'summary': return t('auto.step.summary');
    case 'check': return t('auto.step.check', { where: where(s), states: (s.status || []).map(x => STATES[x] || x).join(t('auto.or')) || '?' });
    default: return `${d.label} ${where(s)}`;
  }
}

// {fecha} {hora} {proyecto} {sesion} in a prompt, a name or a notice.
export function fill(text, ctx) {
  const d = new Date((ctx.at || Date.now() / 1000) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const vars = { fecha: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, hora: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
                 proyecto: ctx.project || '', sesion: ctx.session || '' };
  return String(text || '').replace(/\{(fecha|hora|proyecto|sesion)\}/g, (_, k) => vars[k]);
}

// ── templates: two ready to pick, one per scope ──────────────────────────────────────────
// `build()` returns a draft the editor opens; nothing is saved until the person saves it. The
// draft is written in the language of whoever opens it. The keys are ids, kept as they were.
export const TEMPLATES = worded({
  'resumen-dia': {
    scope: 'personal',
    build: () => ({ name: t('tpl.resumen-dia.name'), scope: 'personal', enabled: true,
                    trigger: { ...blankTrigger('schedule'), days: [0, 1, 2, 3, 4, 5, 6], at: '18:00' },
                    steps: [blankStep('summary')] }),
  },
  'actualizar-pagina': {
    scope: 'company',
    build: () => ({ name: t('tpl.actualizar-pagina.name'), scope: 'company', enabled: true,
                    trigger: { ...blankTrigger('schedule'), days: [1], at: '09:00' },
                    steps: [{ ...blankStep('send'), session: 'master', prompt: t('tpl.actualizar-pagina.prompt') }] }),
  },
}, 'tpl', ['name', 'hint']);
