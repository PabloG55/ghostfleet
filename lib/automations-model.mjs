// lib/automations-model.mjs — what an automation IS, for the daemon that runs it
// (lib/automations.mjs) and the screen that edits it (web/ui/automations.jsx): the
// shapes, the one function that turns what a person (or the draft-writing model) wrote into
// a shape the runner can trust, when a schedule fires next, and how each piece reads as a
// sentence.
//
// ONE FILE FOR BOTH SIDES, so the editor cannot offer a step the runner refuses, or the other
// way round. vite bundles it into web/phone.js and the team app's bundle; the daemon imports it
// as it is. No imports, no Node builtins: it has to run in a browser too.
//
// An automation is a trigger and a list of steps, run top to bottom:
//   { id, name, enabled,
//     trigger: { type: 'schedule', mode: 'once'|'days'|'every', date, at, days, minutes }
//            | { type: 'event', event, project, session, cooldown },
//     steps: [{ action, project, session, prompt, name, branch, minutes, text, status }] }
// A step's project/session can be the literal '{project}' / '{session}': the session the
// event happened to. Prompts, names and notices can use {date} {time} {project} {session}.

// A STATUS THAT CHANGED is an event, read off the same nine values the grid draws
// (web/grid.js STATUSES) — never a second idea of what "finished" means. `from`/`to` decide
// whether a change between two observed statuses is this event.
export const EVENTS = {
  finished:    { label: 'finishes a turn',     hint: 'working → ready or idle',
                 is: (a, b) => a === 'working' && (b === 'ready' || b === 'idle') },
  'need-you':  { label: 'needs you',           hint: 'waiting on an answer or a permission',
                 is: (a, b) => b === 'need-you' && a !== 'need-you' },
  started:     { label: 'starts working',      hint: 'a turn begins',
                 is: (a, b) => b === 'working' && a !== 'working' },
  limit:       { label: 'hits a usage limit',  hint: 'the account ran out',
                 is: (a, b) => b === 'limit' && a !== 'limit' },
  interrupted: { label: 'is interrupted',      hint: 'the turn was cut off',
                 is: (a, b) => b === 'interrupted' && a !== 'interrupted' },
};

// Each action: its words, the fleet-serve verb it becomes, and which fields it needs. A step
// with a `tool` runs through the daemon's own verb path (allowlist, argument checks, audit) —
// an automation is not a back door. `passkey` mirrors TOOLS_ALLOWED in bin/fleet-serve.mjs:
// saving an automation that holds one of these asks for a fresh passkey (see lib/automations.mjs).
export const ACTIONS = {
  send:      { label: 'send a prompt',      tool: 'fleet_send',      needs: ['project', 'session', 'prompt'] },
  spawn:     { label: 'start a session',    tool: 'fleet_spawn',     needs: ['project', 'name'], optional: ['prompt', 'branch'], passkey: true },
  pause:     { label: 'pause',              tool: 'fleet_pause',     needs: ['project', 'session'] },
  resume:    { label: 'resume',             tool: 'fleet_resume',    needs: ['project', 'session'], optional: ['prompt'] },
  wake:      { label: 'wake',               tool: 'fleet_wake',      needs: ['project', 'session'] },
  interrupt: { label: 'interrupt',          tool: 'fleet_interrupt', needs: ['project', 'session'] },
  reopen:    { label: 'reopen',             tool: 'fleet_reopen',    needs: ['project', 'session'] },
  stop:      { label: 'stop',               tool: 'fleet_stop',      needs: ['project', 'session'], passkey: true },
  check:     { label: 'continue only if…',  tool: null,              needs: ['project', 'session', 'status'] },
  notify:    { label: 'tell me',            tool: null,              needs: ['text'] },
  wait:      { label: 'wait',               tool: null,              needs: ['minutes'] },
};

// What a "continue only if…" step can ask a session to be: the grid's nine, in its order.
export const STATES = ['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted'];

export const LIMITS = { steps: 20, prompt: 4000, name: 80, text: 300, waitMin: 60, cooldownMin: 1440, everyMin: 15 };
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const EVENT_PROJECT = '{project}';
export const EVENT_SESSION = '{session}';
const SESSION_OK = /^[A-Za-z0-9][A-Za-z0-9 ._~-]{0,47}$/;
const TEMPLATE_OK = /^[A-Za-z0-9{}][A-Za-z0-9 ._~{}-]{0,79}$/;     // a name that may hold {date}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const bad = (text) => Object.assign(new Error(text), { status: 400 });
// A KEY THAT WAS WRITTEN, NOT ONE EVERY OBJECT HAS. EVENTS['constructor'] is truthy, so an event
// of "constructor" passed the check and was saved; the watcher then asked EVENTS['__proto__'].is
// on every status change and threw for every automation. A draft comes from a model, so what
// reaches these lookups is not ours. The string test is the same hole from the other side:
// ['send'] coerces to a real key and stays an array in what gets saved.
const own = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
// new Date() rolls 2026-13-45 over to a real day in 2027 and says nothing, so the shape of a date
// says nothing about which day runs; only reading it back does.
const realDate = (v) => {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number), x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d;
};
// Number(null) and Number('') are 0, which is Sunday, and 1.5 is between the bounds: each would
// save a day nobody picked, or one that never comes.
const dayOf = (d) => (typeof d === 'number' || (typeof d === 'string' && d.trim() !== '') ? Number(d) : NaN);

export const blankTrigger = (type = 'schedule') => (type === 'event'
  ? { type: 'event', event: 'finished', project: '*', session: '*', cooldown: 10 }
  : { type: 'schedule', mode: 'days', at: '10:00', days: [1, 2, 3, 4, 5], date: '', minutes: 60 });
export const blankStep = (action) => ({ action, project: '', session: '', prompt: '', name: '', branch: '',
  minutes: action === 'wait' ? 5 : 0, text: '', status: action === 'check' ? ['need-you'] : [] });
export const blankAutomation = () => ({ id: null, name: '', enabled: true, trigger: blankTrigger('schedule'), steps: [] });

// Does this automation hold a step whose verb needs a passkey at the moment of action?
export const needsPasskey = (a) => (a?.steps || []).some(s => own(ACTIONS, s.action) && ACTIONS[s.action].passkey);

// Clean an automation as written into one the runner can trust; throws a 400 carrying words a
// person can act on. `strict` (saving an enabled one) also requires every field filled.
export function normalize(raw, { strict = true } = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const name = str(a.name, LIMITS.name) || 'untitled automation';
  const t = a.trigger && typeof a.trigger === 'object' ? a.trigger : {};
  let trigger;
  if (t.type === 'event') {
    if (!own(EVENTS, t.event)) throw bad(`unknown event: ${t.event}`);
    const project = str(t.project, 80) || '*', session = str(t.session, 48) || '*';
    if (session !== '*' && !SESSION_OK.test(session)) throw bad(`the trigger names an invalid session: '${session}'`);
    const cooldown = Math.max(1, Math.min(LIMITS.cooldownMin, Math.round(Number(t.cooldown) || 10)));
    trigger = { type: 'event', event: t.event, project, session, cooldown };
  } else {
    const mode = ['once', 'days', 'every'].includes(t.mode) ? t.mode : 'days';
    // typeof first: a regex .test() coerces, so ['09:00'] passes and is saved as an array, which
    // the clock then calls .split on, in a timer, with nothing above it to catch the throw.
    const at = typeof t.at === 'string' && HHMM.test(t.at) ? t.at : '10:00';
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(dayOf).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const date = realDate(t.date) ? t.date : '';
    const minutes = Math.max(LIMITS.everyMin, Math.min(7 * 1440, Math.round(Number(t.minutes) || 60)));
    if (strict && mode === 'once' && !date) throw bad('a one-off run needs a real date');
    if (strict && mode === 'days' && !days.length) throw bad('pick at least one day of the week');
    trigger = { type: 'schedule', mode, at, days, date, minutes };
    // A date already behind us saves as "on" with nothing ahead of it: it reads as armed and never
    // runs. Said here, at the save, where the person can pick another.
    if (strict && mode === 'once' && nextAfter(trigger, Math.floor(Date.now() / 1000)) == null)
      throw bad(`${date} at ${at} has already passed: pick a later time`);
  }
  const list = Array.isArray(a.steps) ? a.steps : [];
  if (list.length > LIMITS.steps) throw bad(`at most ${LIMITS.steps} steps`);
  const steps = list.map((s, i) => {
    const action = s?.action;
    if (!own(ACTIONS, action)) throw bad(`step ${i + 1}: unknown action '${action}'`);
    const def = ACTIONS[action];
    const o = { action };
    if (def.needs.includes('project')) o.project = str(s.project, 80);
    if (def.needs.includes('session')) {
      o.session = str(s.session, 48);
      if (o.session && o.session !== EVENT_SESSION && !SESSION_OK.test(o.session)) throw bad(`step ${i + 1}: invalid session name '${o.session}'`);
    }
    if (def.needs.includes('prompt') || def.optional?.includes('prompt')) o.prompt = str(s.prompt, LIMITS.prompt);
    if (def.needs.includes('name')) {
      o.name = str(s.name, 80);
      if (o.name && !TEMPLATE_OK.test(o.name)) throw bad(`step ${i + 1}: a session name takes letters, digits, spaces and . _ ~ -`);
    }
    if (def.optional?.includes('branch')) o.branch = str(s.branch, 80);
    if (action === 'wait') o.minutes = Math.max(1, Math.min(LIMITS.waitMin, Math.round(Number(s.minutes) || 1)));
    if (action === 'notify') o.text = str(s.text, LIMITS.text);
    if (action === 'check') o.status = [...new Set((Array.isArray(s.status) ? s.status : []).filter(x => STATES.includes(x)))];
    if (strict) {
      for (const f of def.needs) if (o[f] === '' || o[f] == null || (Array.isArray(o[f]) && !o[f].length)) throw bad(`step ${i + 1} (${def.label}): ${FIELD[f] || f} is missing`);
      if ((o.project === EVENT_PROJECT || o.session === EVENT_SESSION) && trigger.type !== 'event')
        throw bad(`step ${i + 1}: "the event's session" only exists when the trigger is an event`);
    }
    return o;
  });
  if (strict && !steps.length) throw bad('add at least one step');
  return { id: str(a.id, 40) || null, name, enabled: a.enabled !== false, trigger, steps };
}
const FIELD = { status: 'at least one status', project: 'the project', session: 'the session', prompt: 'the message', name: 'the name', text: 'the text', minutes: 'the minutes' };

// ── when ─────────────────────────────────────────────────────────────────────────────
// In the daemon's local time: "weekdays at 10:00" means 10:00 on the machine that runs it.
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
export const everyWords = (m) => (m % 1440 === 0 ? `${m / 1440} day${m > 1440 ? 's' : ''}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
function daysWords(days) {
  const s = [...days].sort().join(',');
  if (s === '0,1,2,3,4,5,6') return 'every day';
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  return days.map(d => DAY_NAMES[d]).join(', ');
}
// A date in the words a person would say it in. The stored one is ISO, which is what it should be
// for a file and not for a sentence. A year only when it is not this one.
function dateWords(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return date || '?';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
export function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'event') {
    const who = t.session && t.session !== '*' ? t.session : 'any session';
    const where = !t.project || t.project === '*' ? 'in any project' : `in ${t.project}`;
    return `when ${who} ${where} ${own(EVENTS, t.event) ? EVENTS[t.event].label : t.event}`;
  }
  if (t.mode === 'once') return `once, ${dateWords(t.date)} at ${t.at}`;
  if (t.mode === 'every') return `every ${everyWords(t.minutes)}`;
  return `${daysWords(t.days)} at ${t.at}`;
}
const where = (s) => `${s.session === EVENT_SESSION ? "the event's session" : s.session || '?'}${s.project && s.project !== EVENT_PROJECT ? ` (${s.project})` : ''}`;
const clip = (v, n) => { const x = String(v || ''); return x.length > n ? `${x.slice(0, n)}…` : x; };
export function describeStep(s) {
  if (!own(ACTIONS, s?.action)) return String(s?.action ?? '');
  const d = ACTIONS[s.action];
  switch (s.action) {
    case 'send': return `send ${where(s)}: "${clip(s.prompt, 60)}"`;
    case 'spawn': return `start session ${s.name || '?'} in ${s.project || '?'}${s.prompt ? ' with a task' : ''}`;
    case 'notify': return `tell me: "${clip(s.text, 60)}"`;
    case 'wait': return `wait ${s.minutes} min`;
    case 'check': return `continue only if ${where(s)} is ${(s.status || []).join(' or ') || '?'}`;
    default: return `${d.label} ${where(s)}`;
  }
}

// {date} {time} {project} {session} in a prompt, a name or a notice.
export function fill(text, ctx) {
  const d = new Date((ctx.at || Date.now() / 1000) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const vars = { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
                 project: ctx.project || '', session: ctx.session || '' };
  return String(text || '').replace(/\{(date|time|project|session)\}/g, (_, k) => vars[k]);
}
