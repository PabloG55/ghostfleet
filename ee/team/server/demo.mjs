// server/demo.mjs — a pretend fleet, in memory, so the app can be shown and clicked through
// without touching a real session. Same interface as fleet.mjs; nothing here runs a process.
import path from 'node:path';
import * as attachments from './attach.mjs';
import { dataDir } from './users.mjs';
import { t as tr } from '../shared/i18n/index.js';
import { literalProject } from './terminal-tab.mjs';

const now = () => Math.floor(Date.now() / 1000);
const ago = (min) => now() - min * 60;

const ESC = '\u001b[';
const c = (n, s) => `${ESC}38;5;${n}m${s}${ESC}39m`;
const permissionPane = (cmd) => [
  '',
  `${c(231, '●')} Voy a correr la suite de pagos antes de tocar el webhook.`,
  '',
  `${c(246, '●')} ${ESC}1mBash${ESC}0m(${cmd})`,
  '',
  c(153, '────────────────────────────────────────────────────────────────────────'),
  ` ${ESC}1mBash command${ESC}0m`,
  '',
  `   ${cmd}`,
  `   ${c(246, 'Run the billing test suite')}`,
  '',
  ' Do you want to proceed?',
  ` ${c(153, '❯')} 1. Yes`,
  '   2. Yes, and don’t ask again for this command in this project',
  '   3. No, and tell Claude what to do differently (esc)',
  '',
].join('\n');

const plainPane = (lines) => ['', ...lines.map(l => `${c(231, '●')} ${l}`), '', `${c(239, '❯')} `].join('\n');

function seed() {
  const P = {};
  const add = (project, path, cards, free = []) => { P[project] = { path, cards, free }; };
  const card = (name, status, branch, msgs, extra = {}) => ({
    name, status, branch, folder: name === 'master' ? extra.folder : name, agent: 'claude', label: null, pr: null,
    msg: msgs.filter(m => m.role === 'assistant').at(-1)?.text || '', age: 0, exited: false, asleep: false, lost: false,
    queued: 0, attached: false, sched: null, limit_at: null, lead: name === 'master', parent: null, workers: null,
    sub_head: false, ts: extra.ts || now(), messages: msgs, prompt: extra.prompt || null, pane: extra.pane || null, ...extra.more,
  });
  const m = (role, text, min) => ({ role, text, ts: ago(min) });

  add('acme-web', '/home/equipo/Proyectos/acme-web', [
    card('master', 'ready', 'saas', [
      m('user', 'Revisa el PLAN.md y reparte la fase 2 en worktrees.', 95),
      m('assistant', 'Leí PLAN.md. La fase 2 tiene tres frentes independientes: onboarding de organizaciones, cobros con Stripe y el dashboard de ingresos. Abrí un worktree para cada uno.', 90),
    ], { folder: 'acme-web', ts: ago(90) }),
    card('onboarding', 'working', 'f2-onboarding', [
      m('user', 'Arma el flujo de alta de una organización nueva: datos, moneda y primer usuario.', 80),
      { role: 'tools', ts: ago(4), tools: [{ name: 'Write', detail: 'supabase/migrations/0007_organizations.sql' }, { name: 'Bash', detail: 'pnpm supabase db reset' }, { name: 'Bash', detail: 'pnpm vitest run src/domain/org' }] },
      m('assistant', 'Creé la migración de organizations y memberships con RLS. Ahora estoy armando el formulario de alta en tres pasos.', 3),
    ], { ts: ago(3) }),
    card('stripe-billing', 'need-you', 'f2-billing', [
      m('user', 'Integra Stripe detrás de src/server/billing con planes mensuales.', 70),
      m('assistant', 'La interfaz de billing está lista y los webhooks validan la firma. Antes de seguir quiero correr la suite de pagos.', 1),
    ], { ts: ago(1), prompt: {
      kind: 'permission', agent: 'claude', tool: 'Bash', command: 'pnpm test src/server/billing',
      question: 'Do you want to proceed?', fingerprint: 'demo-billing-1',
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and don’t ask again for this command in this project' },
                { n: 3, label: 'No, and tell Claude what to do differently (esc)' }] },
      pane: permissionPane('pnpm test src/server/billing') }),
    card('revenue-dashboard', 'ready', 'f2-dashboard', [
      m('user', 'Haz el dashboard de ingresos por plan con el diseño del manual de marca.', 60),
      m('assistant', 'Listo: el dashboard muestra ingresos por plan y por mes, funciona en 390px y 1440px, en claro y oscuro. Abrí el PR #14 contra saas.', 12),
    ], { ts: ago(12), more: { pr: '#14' } }),
  ], [{ path: '/home/equipo/Proyectos/acme-web-1', branch: 'f1-auth', task: '', removing: false }]);

  add('toolbox', '/home/equipo/Proyectos/toolbox', [
    card('master', 'idle', 'main', [
      m('assistant', 'toolbox está al día con el remoto.', 240),
    ], { folder: 'toolbox', ts: ago(240) }),
    card('kpi-report', 'working', 'kpi-report', [
      m('user', 'Compara el KPI de conversión de la región norte contra el dashboard de ventas del 06/10.', 30),
      m('assistant', 'Bajé las oportunidades del embudo principal de ese día. Me falta cruzar los ganados con el CSV del dashboard.', 2),
    ], { ts: ago(2) }),
  ]);

  add('billing-svc', '/home/equipo/Proyectos/billing-svc', [
    card('precios-2027', 'limit', 'precios-2027', [
      m('user', 'Actualiza la tabla de precios 2027 y recalcula los márgenes.', 50),
      m('assistant', 'Llegué al límite de uso de la cuenta a mitad de la tarea. Retomo cuando vuelva el cupo.', 6),
    ], { ts: ago(6), more: { limit_at: now() + 2 * 3600, label: 'urgente cliente' } }),
    card('master', 'parked', 'main', [
      m('assistant', 'Quedó en pausa hasta que el cliente confirme los precios nuevos.', 1440),
    ], { folder: 'billing-svc', ts: ago(1440) }),
  ]);
  add('scratch', '/home/equipo/Proyectos/scratch', [], [
    { path: '/home/equipo/Proyectos/scratch-ocr', branch: 'ocr-tuning', task: '', removing: false }]);
  for (const p of Object.values(P)) for (const k of p.cards) if (!k.pane) k.pane = plainPane([k.msg]);
  return P;
}

let P = seed();
const later = (ms, fn) => setTimeout(fn, ms).unref?.();

function find(project, name) {
  const p = P[project];
  if (!p) throw Object.assign(new Error(tr('err.noProject', { project })), { status: 404 });
  const k = name == null ? null : p.cards.find(x => x.name === name);
  if (name != null && !k) throw Object.assign(new Error(tr('err.noSessionIn', { session: name, project })), { status: 404 });
  return { p, k };
}

const COUNT_KEYS = ['need_you', 'working', 'ready', 'parked', 'limit', 'interrupted'];
function counts(cards) {
  const o = Object.fromEntries(COUNT_KEYS.map(x => [x, 0]));
  for (const k of cards) { const key = k.status === 'need-you' ? 'need_you' : k.status; if (key in o) o[key]++; }
  return o;
}
const publicCard = (k) => {
  const { messages, prompt, pane, ts, ...rest } = k;
  return { ...rest, age: Math.max(0, now() - ts), queued: 0 };
};

export async function projects() {
  return Object.entries(P).map(([name, p]) => {
    const cnt = counts(p.cards);
    return { name, path: p.path, profile: 'work',
             counts: { need_you: cnt.need_you, working: cnt.working, ready: cnt.ready, parked: cnt.parked, lost: 0, total: p.cards.length },
             sessions: p.cards.map(k => ({ name: k.name, status: k.status, ts: k.ts, lead: k.lead })) };
  });
}

export async function grid(project) {
  const { p } = find(project);
  return { project, profile: 'work', sub: null, counts: counts(p.cards), cards: p.cards.map(publicCard), free_worktrees: p.free };
}

export async function session(project, name) {
  const { k } = find(project, name);
  return { project, session: name, agent: 'claude', status: k.status, total: k.messages.length,
           messages: k.messages.slice(-30), next_before: null };
}
export async function queue() { return []; }
export async function openTerminal(project, kind) {
  if (!literalProject(project)) throw Object.assign(new Error('No such project.'), { status: 404 });
  find(project);
  return { session: `_${kind}-${project}` };
}
export async function checkTerminal(ticket) {
  const tab = await openTerminal(ticket.project, ticket.kind);
  if (tab.session !== ticket.session) throw Object.assign(new Error('No such terminal tab.'), { status: 404 });
}
export async function pane(project, name) { const { k } = find(project, name); return { pane: k.pane, prompt: k.prompt }; }

function say(k, text) {
  k.messages.push({ role: 'assistant', text, ts: now() });
  k.msg = text; k.ts = now(); k.pane = plainPane([text]);
}

export async function act(tool, a) {
  const { p, k } = find(a.project, a.session ?? null);
  switch (tool) {
    case 'fleet_send': {
      k.messages.push({ role: 'user', text: a.prompt, ts: now() });
      if (k.lead) return leadAct(p, k, a.prompt);
      k.status = 'working'; k.ts = now();
      later(4000, () => { k.status = 'ready'; say(k, `(demo) Recibido. En la flota real aquí verías la respuesta de Claude a: «${String(a.prompt).slice(0, 80)}»`); });
      return { ok: true, text: `→ ${k.name}` };
    }
    case 'fleet_answer': {
      if (!k.prompt) return { ok: false, changed: true, text: tr('demo.promptGone') };
      if (a.expect && a.expect !== k.prompt.fingerprint) return { ok: false, changed: true, text: tr('demo.promptChanged') };
      const declined = /^3$/.test(String(a.text).trim());
      k.prompt = null; k.status = declined ? 'ready' : 'working'; k.ts = now();
      if (declined) say(k, '(demo) Entendido, no corro ese comando. ¿Qué prefieres que haga?');
      else later(3500, () => { k.status = 'ready'; say(k, '(demo) La suite de pagos pasó: 42 tests en verde. Sigo con el webhook de suscripciones.'); });
      return { ok: true, text: tr('demo.answered', { text: a.text }) };
    }
    case 'fleet_interrupt': k.status = 'ready'; k.ts = now(); return { ok: true, text: tr('demo.interrupted') };
    case 'fleet_pause': k.status = 'parked'; return { ok: true, text: tr('demo.paused') };
    case 'fleet_resume': case 'fleet_wake': case 'fleet_reopen':
      k.status = a.prompt ? 'working' : 'idle'; k.ts = now();
      if (a.prompt) k.messages.push({ role: 'user', text: a.prompt, ts: now() });
      return { ok: true, text: tr('demo.resumed') };
    case 'fleet_rename': k.name = a.new_name; return { ok: true, text: tr('demo.renamed', { name: a.new_name }) };
    case 'fleet_stop':
      if (k.lead) return { ok: false, text: tr('demo.leadStop') };
      p.cards = p.cards.filter(x => x !== k);
      if (!a.reclaim) p.free.push({ path: `${p.path}-${k.name}`, branch: k.branch, task: '', removing: false });
      return { ok: true, text: a.reclaim ? tr('demo.stoppedReclaim') : tr('demo.stopped') };
    case 'fleet_worktree_remove':
      p.free = p.free.filter(w => w.path !== a.path);
      return { ok: true, text: tr('demo.wtRemoved', { path: a.path }) };
    case 'fleet_spawn': {
      if (p.cards.some(x => x.name === a.name)) return { ok: false, text: tr('demo.exists', { name: a.name }) };
      if (a.reuse) p.free = p.free.filter(w => w.path !== a.reuse && !w.path.endsWith(`/${a.reuse}`));
      const n = { name: a.name, status: 'starting', branch: a.branch || a.name, folder: a.name, agent: 'claude', label: null,
                  pr: null, msg: '', age: 0, exited: false, asleep: false, lost: false, queued: 0, attached: false, sched: null,
                  limit_at: null, lead: false, parent: null, workers: null, sub_head: false, ts: now(),
                  messages: a.prompt ? [{ role: 'user', text: a.prompt, ts: now() }] : [], prompt: null, pane: plainPane(['arrancando…']) };
      p.cards.push(n);
      later(2500, () => { n.status = a.prompt ? 'working' : 'idle'; n.ts = now(); });
      if (a.prompt) later(7000, () => { n.status = 'ready'; say(n, '(demo) Terminé un primer pase de la tarea. En la flota real aquí verías el resumen de Claude.'); });
      return { ok: true, text: tr('demo.spawned', { name: a.name }) };
    }
    default: return { ok: false, text: tr('demo.unavailable', { tool }) };
  }
}

// The lead, pretended: it answers, opens a session named after the ask and hands it the work,
// so the assistant's live view has something real-looking to sail to.
function leadAct(p, k, prompt) {
  const ask = String(prompt).replace(/^(?:\[(?:voice|typed)\]|\u{1F399}\uFE0F?|\u{1F4AC})[^\n]*\n\n/u, '').trim();
  const words = ask.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{4,}/g) || ['tarea'];
  let name = words.slice(0, 2).join('-');
  while (p.cards.some(x => x.name === name)) name += '-2';
  k.status = 'working'; k.ts = now();
  later(2500, () => say(k, `Entendido. Abro la sesión ${name} para eso y le paso la tarea.`));
  later(4500, () => {
    const n = { name, status: 'starting', branch: name, folder: name, agent: 'claude', label: null, pr: null, msg: '', age: 0,
                exited: false, asleep: false, lost: false, queued: 0, attached: false, sched: null, limit_at: null, lead: false,
                parent: null, workers: null, sub_head: false, ts: now(), messages: [{ role: 'user', text: ask, ts: now() }],
                prompt: null, pane: plainPane(['arrancando…']) };
    p.cards.push(n);
    later(2000, () => { n.status = 'working'; n.ts = now(); });
    later(9000, () => { n.status = 'ready'; say(n, `(demo) Primer pase listo de: «${ask.slice(0, 70)}».`); k.status = 'ready';
                        say(k, `Listo: ${name} terminó su primer pase. Revísalo cuando puedas.`); });
  });
  return { ok: true, text: `→ ${k.name}` };
}

export async function ensureLead(project) {
  const { p } = find(project);
  let m = p.cards.find(k => k.lead);
  if (m && m.status !== 'parked') return { ok: true, started: null, lead: m.name };
  if (!m) {
    m = { name: 'master', status: 'starting', branch: 'main', folder: project, agent: 'claude', label: null, pr: null, msg: '', age: 0,
          exited: false, asleep: false, lost: false, queued: 0, attached: false, sched: null, limit_at: null, lead: true, parent: null,
          workers: null, sub_head: false, ts: now(), messages: [], prompt: null, pane: plainPane(['arrancando…']) };
    p.cards.unshift(m);
    await new Promise(r => setTimeout(r, 1800));
  }
  m.status = 'idle'; m.ts = now();
  return { ok: true, started: 'start', lead: m.name };
}

const timers = new Map();
export function setLabel(project, session, text) {
  const { k } = find(project, session);
  k.label = String(text || '').trim().slice(0, 40) || null;
  return { ok: true, text: k.label ? tr('fleet.label', { label: k.label }) : tr('fleet.labelOff') };
}
export function cancelSchedule(project, session) {
  const { k } = find(project, session);
  clearTimeout(timers.get(`${project}/${session}`));
  const had = !!k.sched; k.sched = null;
  return { ok: true, text: had ? tr('fleet.unsched') : tr('fleet.noSched') };
}
export function schedule(project, session, at, msg) {
  const { p, k } = find(project, session);
  cancelSchedule(project, session);
  k.sched = { at, msg };
  const wait = Math.min(Math.max(0, at * 1000 - Date.now()), 2 ** 31 - 1);
  timers.set(`${project}/${session}`, setTimeout(() => { k.sched = null; act('fleet_send', { project, session, prompt: msg }); }, wait));
  return { ok: true, text: tr('fleet.sched', { when: { at } }) };
}

// Real files, in a throwaway folder: the demo's sessions are pretend, the upload is not.
export function attach(project, session, name, buf) {
  find(project, session);
  return attachments.save(path.join(dataDir('demo'), 'attach', `${project}.${session}`), name, buf);
}

export function usage() {
  const t = now(), h = (x) => t - (t % 3600) + x * 3600;
  return { ok: true, at: t, profiles: [
    { profile: 'work', at: t, five_hour: { pct: 62, resets: h(2) }, seven_day: { pct: 48, resets: h(70) } },
    { profile: 'personal', at: t - 1800, five_hour: { pct: 91, resets: h(1) }, seven_day: { pct: 23, resets: h(120) } },
  ] };
}

export const reset = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); P = seed(); };
export const mode = 'demo';
