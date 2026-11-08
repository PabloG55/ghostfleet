// server/automations.mjs — the runner behind the Automatizaciones page: a clock for the
// scheduled ones, a watcher of the fleet's statuses for the event ones, and a log of every
// run. It decides WHEN; every step it takes goes through `perform` (index.mjs), the same
// allowlist, argument checks, owners and activity log as a click in the browser.
//
// A schedule that comes due while this server is not running is NOT run late: it is logged
// as skipped and its owner gets a notice. Work that lands hours after it was meant to is the
// surprise this avoids.
//
// Who sees one and whose permissions it runs with is its scope (docs/TEAM-ARCHITECTURE.md §5),
// and every "may they" is a call to access.mjs's can(), the one place that decides it. A run is
// a person acting: a personal one is its creator, a company one the admin who saved it. That
// person is who perform() logs and who the turn's tokens are charged to.
import crypto from 'node:crypto';
import { claudeJson } from './claude.mjs';
import { ACTIONS, EVENTS, STATES, NEEDS, normalize, nextAfter, describeTrigger, describeStep, fill, projectsOf } from '../shared/automations.js';
import { t, msg, render, isMsg } from '../shared/i18n/index.js';
import { orLang } from './i18n.mjs';

const now = () => Math.floor(Date.now() / 1000);
const GRACE = 120;                 // a due run later than this was missed, not late
const MAX_PER_HOUR = 30;           // a loop (an event its own steps cause) stops itself here

// `telegram(text)`, when given, sends to the machine owner's fleet-telegram chat: that chat is
// the first admin's, so only their own summaries go there (anyone else's would land on the
// owner's phone).
export function createEngine({ fleet, readJson, writeJson, appendLine, readLines, perform, users, can, telegram = null }) {
  let list = readJson('automations.json', { automations: [] }).automations;
  let notices = readJson('notices.json', { notices: [] }).notices;
  const save = () => writeJson('automations.json', { automations: list });
  const saveNotices = () => writeJson('notices.json', { notices: notices.slice(-200) });
  const running = new Set();
  const lastFire = new Map();      // `${id}|${project}/${session}` -> epoch, for the cooldown
  const recent = new Map();        // id -> [epoch…] in the last hour

  const userOf = (id) => users().find(u => u.id === id) || null;
  const firstAdmin = () => users().find(u => u.role === 'admin') || users()[0] || null;
  const isAdmin = (u) => u?.role === 'admin' && !u.disabled;
  const ownerName = (id) => userOf(id)?.name || id;
  const runAs = (a) => userOf(a.scope === 'company' ? a.savedBy || a.createdBy : a.createdBy);
  // Personal: its creator, and the admins. Company: whoever can read every project it names
  // (one it cannot read does not exist for them, and its name would say otherwise).
  const canSee = (a, u) => !!u && !u.disabled && (isAdmin(u) || (a.scope === 'personal'
    ? a.createdBy === u.id
    : projectsOf(a).every(p => can(u, p, 'read'))));
  const canEdit = (a, u) => (a.scope === 'company' ? isAdmin(u) : a.createdBy === u?.id && !u.disabled);
  const missing = (a, u) => projectsOf(a).filter(p => !can(u, p, 'read'));

  // Before scopes there were `owner` and `visibility: personal|team`. Every one of those becomes
  // the company's, created by the first admin (§5): it was all one team's fleet then. Once each
  // has a scope there is nothing left to migrate, so this runs on the first boot only.
  if (list.some(a => !a.scope)) {
    const admin = firstAdmin()?.id || null;
    list = list.map(a => {
      if (a.scope) return a;
      const { owner, visibility, ...rest } = a;
      return { ...rest, scope: 'company', createdBy: admin || owner || null, savedBy: admin || owner || null };
    });
    save();
  }

  // A notice goes to whoever can see its automation; `to` pins one to a single person.
  function notice(a, text, kind = 'info', to = null) {
    notices.push({ id: crypto.randomBytes(6).toString('hex'), at: now(), auto: a?.id || null, autoName: a?.name || '',
                   to, ...(isMsg(text) ? { msg: text } : { text }), kind });
    saveNotices();
  }

  // Someone lost access to a project it names (or their account was turned off): it stops,
  // and says why, instead of failing on every run. The person turns it back on once fixed.
  function pauseIfLost(a) {
    if (!a.enabled) return false;
    const u = runAs(a);
    const gone = u && !u.disabled ? missing(a, u) : projectsOf(a);
    const accountGone = !u || u.disabled || (a.scope === 'company' && !isAdmin(u));
    if (!gone.length && !accountGone) return false;
    a.enabled = false; a.nextRun = null;
    const why = accountGone
      ? (a.scope === 'company' ? msg('auto.why.notAdmin', { who: ownerName(a.savedBy) }) : msg('auto.why.disabled'))
      : msg('auto.why.noAccess', { who: ownerName(u.id), projects: gone.join(', ') });
    a.paused = { at: now(), why };
    notice(a, msg('auto.notice.paused', { name: a.name, why }), 'warn');
    return true;
  }
  function reconcile() {
    let dirty = false;
    for (const a of list) if (pauseIfLost(a)) dirty = true;
    if (dirty) save();
  }
  function logRun(row) { appendLine('automation-runs.jsonl', { at: now(), ...row }); }
  // What a run row or a notice holds, in words: a message, a trigger or a step to describe, or
  // the plain text older rows (and the fleet's own answers) carry.
  const said = (x) => (x?.trigger ? describeTrigger(x.trigger) : render(x));

  // ── the clock: compute the next run for every schedule; on boot, what came due while off ──
  function arm(a, from = now()) {
    a.nextRun = a.enabled && a.trigger.type === 'schedule' ? nextAfter(a.trigger, from, a.anchor || from) : null;
  }
  for (const a of list) if (a.enabled && a.trigger.type === 'schedule' && a.nextRun == null) arm(a);
  save();

  function tick() {
    reconcile();
    const t = now();
    let dirty = false;
    for (const a of list) {
      if (!a.enabled || a.trigger.type !== 'schedule' || !a.nextRun || a.nextRun > t) continue;
      const due = a.nextRun;
      if (t - due > GRACE) {
        logRun({ auto: a.id, name: a.name, owner: a.createdBy, status: 'skipped', trigger: { trigger: a.trigger }, due,
                 text: msg('auto.run.serverOff') });
        notice(a, msg('auto.notice.missed', { name: a.name, due: { at: due } }), 'warn');
      } else {
        run(a, { why: { trigger: a.trigger }, at: due });
      }
      if (a.trigger.mode === 'once') { a.enabled = false; a.nextRun = null; }
      else arm(a, t);
      dirty = true;
    }
    if (dirty) save();
  }

  // ── the watcher: a status that CHANGED is an event; the first look only learns the fleet ──
  let seen = null;
  const fromTo = {
    finished: (a, b) => a === 'working' && (b === 'ready' || b === 'idle'),
    'need-you': (a, b) => b === 'need-you' && a !== 'need-you',
    started: (a, b) => b === 'working' && a !== 'working',
    limit: (a, b) => b === 'limit' && a !== 'limit',
    lost: (a, b) => b === 'lost' && a !== 'lost',
  };
  async function watch() {
    const listeners = list.filter(a => a.enabled && a.trigger.type === 'event');
    if (!listeners.length) { seen = null; return; }
    let projects;
    try { projects = await fleet.projects(); } catch { return; }
    const cur = new Map();
    for (const p of projects) for (const s of p.sessions) cur.set(`${p.name}/${s.name}`, { project: p.name, session: s.name, status: s.status });
    if (seen) {
      for (const [k, c] of cur) {
        const before = seen.get(k)?.status;
        if (before === undefined || before === c.status) continue;
        for (const a of listeners) {
          const tr = a.trigger;
          if (!fromTo[tr.event]?.(before, c.status)) continue;
          if (tr.project !== '*' && tr.project !== c.project) continue;
          // "any project" means any THEY can read: another project's events are not theirs.
          if (!can(runAs(a), c.project, 'read')) continue;
          if (tr.session !== '*' && tr.session !== c.session) continue;
          const ck = `${a.id}|${k}`;
          if (now() - (lastFire.get(ck) || 0) < tr.cooldown * 60) continue;
          lastFire.set(ck, now());
          run(a, { why: msg('auto.why.event', { where: `${c.project}/${c.session}`, what: msg(`event.${tr.event}.verb`) }), project: c.project, session: c.session, at: now() });
        }
      }
    }
    seen = cur;
  }

  // ── a run: the steps in order; the first that fails stops the rest ─────────────────────
  // In its owner's language: what a run says is written once and read by them first.
  const run = (a, ctx) => orLang(runAs(a)?.lang, () => runIn(a, ctx));
  async function runIn(a, ctx) {
    if (pauseIfLost(a)) {
      save();
      const text = msg('auto.run.refused', { why: a.paused.why });
      logRun({ auto: a.id, name: a.name, owner: a.createdBy, status: 'refused', trigger: ctx.why, text });
      return { ok: false, text: render(text) };
    }
    if (running.has(a.id)) {
      logRun({ auto: a.id, name: a.name, owner: a.createdBy, status: 'skipped', trigger: ctx.why, text: msg('auto.run.stillRunning') });
      return { ok: false, text: t('auto.run.running') };
    }
    const hour = (recent.get(a.id) || []).filter(x => now() - x < 3600);
    if (hour.length >= MAX_PER_HOUR) {
      a.enabled = false; arm(a); save();
      notice(a, msg('auto.notice.loop', { name: a.name, n: MAX_PER_HOUR }), 'bad');
      return { ok: false, text: t('auto.run.tooMany') };
    }
    recent.set(a.id, [...hour, now()]);
    running.add(a.id);
    const steps = [];
    let ok = true;
    try {
      for (const s of a.steps) {
        const r = await step(a, s, ctx).catch(e => ({ ok: false, text: e.message }));
        const v = { at: ctx.at, project: ctx.project, session: ctx.session };
        const shown = { ...s, project: fill(s.project, v), session: fill(s.session, v), prompt: fill(s.prompt, v), name: fill(s.name, v), text: fill(s.text, v) };
        steps.push({ action: s.action, step: shown, what: describeStep(shown), ok: r.ok, text: isMsg(r.text) ? r.text : String(r.text || '').slice(0, 300) });
        if (!r.ok) { ok = false; break; }
        if (r.halt) { steps.at(-1).halt = true; break; }
      }
    } finally { running.delete(a.id); }
    a.lastRun = { at: now(), ok };
    save();
    logRun({ auto: a.id, name: a.name, owner: a.createdBy, status: ok ? 'ok' : 'error', trigger: ctx.why, steps });
    if (!ok) notice(a, msg('auto.notice.failed', { name: a.name, step: steps.at(-1)?.what, text: steps.at(-1)?.text || msg('auto.noDetail') }), 'bad');
    return { ok, steps: steps.map(x => ({ ...x, text: render(x.text) })) };
  }

  async function step(a, s, ctx) {
    const v = { at: ctx.at, project: ctx.project, session: ctx.session };
    if (s.action === 'wait') { await new Promise(r => setTimeout(r, s.minutes * 60000)); return { ok: true, text: msg('auto.step.waited', { minutes: s.minutes }) }; }
    if (s.action === 'notify') { notice(a, fill(s.text, v), 'info'); return { ok: true, text: msg('auto.step.notified') }; }
    const who = runAs(a);
    if (s.action === 'summary') return summary(a, who);
    const project = s.project === '{proyecto}' ? ctx.project : s.project;
    const session = s.session === '{sesion}' ? ctx.session : s.session;
    if (!project) return { ok: false, text: msg('auto.step.noProject') };
    // The same words as a project that is not there: one they cannot read does not exist (§2).
    if (!can(who, project, NEEDS[s.action])) return { ok: false, text: msg('auto.step.refused', { who: ownerName(who?.id), project }) };
    // A condition: the rest runs only if the session is in one of these states right now.
    if (s.action === 'check') {
      const st = (await fleet.projects()).find(p => p.name === project)?.sessions.find(x => x.name === session)?.status || 'lost';
      return s.status.includes(st)
        ? { ok: true, text: msg('auto.step.checkGo', { state: STATES[st] ? msg(`state.${st}`) : st }) }
        : { ok: true, halt: true, text: msg('auto.step.checkHalt', { state: STATES[st] ? msg(`state.${st}`) : st }) };
    }
    const args = { project };
    if (s.action === 'spawn') {
      args.name = fill(s.name, v).replace(/[^A-Za-z0-9 ._~-]/g, '-').slice(0, 48);
      if (s.prompt) args.prompt = fill(s.prompt, v);
      if (s.branch) args.branch = fill(s.branch, v);
    } else {
      if (!session) return { ok: false, text: msg('auto.step.noSession') };
      args.session = session;
      if (s.prompt) args.prompt = fill(s.prompt, v);
      // The lead has to be up before it can be written to (the assistant does the same).
      if (s.action === 'send') {
        const lead = (await fleet.projects()).find(p => p.name === project)?.sessions.find(x => x.lead)?.name;
        if (session === lead || session === 'master') {
          const r = await fleet.ensureLead(project);
          if (!r.ok) return { ok: false, text: r.text || t('auto.step.noLead') };
        }
      }
    }
    return perform(who.id, ACTIONS[s.action].tool, args, { confirm: s.confirmed === true, via: a.name });
  }

  // "What happened today in my projects": the activity log since midnight and the fleet as it
  // is now, both cut to the projects this person can read. A web notice for them, and their
  // Telegram if they are the one it belongs to.
  async function summary(a, who) {
    const since = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
    let projects = [];
    try { projects = (await fleet.projects()).filter(p => can(who, p.name, 'read')); } catch {}
    const names = new Set(projects.map(p => p.name));
    const rows = readLines('activity.jsonl', 5000).filter(r => r.ts >= since && r.project && can(who, r.project, 'read'));
    for (const r of rows) names.add(r.project);
    if (!names.size) {
      const text = msg('sum.empty');
      notice(a, text, 'info', who.id);
      return { ok: true, text };
    }
    const VERB = { fleet_send: t('sum.prompts'), fleet_spawn: t('sum.spawned'), fleet_stop: t('sum.stopped'), fleet_answer: t('sum.answers') };
    const lines = [...names].sort().map(name => {
      const mine = rows.filter(r => r.project === name && r.result !== 'refused');
      const counts = {};
      for (const r of mine) if (VERB[r.verb]) counts[VERB[r.verb]] = (counts[VERB[r.verb]] || 0) + 1;
      const people = [...new Set(mine.map(r => ownerName(r.user)))];
      const ss = projects.find(p => p.name === name)?.sessions || [];
      const need = ss.filter(x => x.status === 'need-you').map(x => x.name);
      const busy = ss.filter(x => x.status === 'working').length;
      const did = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || t('sum.quiet');
      return `• ${name}: ${did}${people.length ? ` (${people.join(', ')})` : ''}` +
             `${busy ? ` · ${t('sum.working', { n: busy })}` : ''}${need.length ? ` · ${t('sum.needYou', { who: need.join(', ') })}` : ''}`;
    });
    const text = `${t('sum.title')}\n${lines.join('\n')}`;
    notice(a, text, 'info', who.id);
    let tg = '';
    if (telegram && who.id === firstAdmin()?.id) {
      const r = await Promise.resolve(telegram(text)).catch(e => ({ ok: false, text: e.message }));
      tg = r?.ok ? t('sum.tgOk') : t('sum.tgNo', { why: String(r?.text || '').slice(0, 80) });
    }
    return { ok: true, text: t('sum.sent', { tg }) };
  }

  // ── what the page asks ─────────────────────────────────────────────────────────────────
  return {
    start() {
      tick();
      setInterval(tick, 15000).unref();
      setInterval(() => { watch().catch(() => {}); }, 8000).unref();
      watch().catch(() => {});
    },
    // `user` is the person (a users.json row), not an id: every answer depends on their role.
    async view(user) {
      let projects = [];
      try { projects = (await fleet.projects()).map(p => p.name).filter(p => can(user, p, 'read')); } catch {}
      const mine = list.filter(a => canSee(a, user));
      const ids = new Set(mine.map(a => a.id));
      const runs = readLines('automation-runs.jsonl', 400).filter(r => ids.has(r.auto)).slice(0, 60);
      const visibleNotices = notices.filter(n => (n.to ? n.to === user.id : !n.auto || ids.has(n.auto))).slice(-40).reverse();
      // Put into words now, for the person asking: one notice is read by everyone who can see it.
      return { me: { id: user.id, admin: isAdmin(user), projects },
               automations: mine.map(a => ({ ...a, ownerName: ownerName(a.createdBy), running: running.has(a.id),
                                             mine: a.createdBy === user.id, editable: canEdit(a, user),
                                             ...(a.paused ? { paused: { ...a.paused, why: said(a.paused.why) } } : {}) })),
               runs: runs.map(r => ({ ...r, trigger: said(r.trigger), text: said(r.text),
                                      steps: r.steps?.map(x => ({ ...x, what: x.step ? describeStep(x.step) : x.what, text: said(x.text) })) })),
               notices: visibleNotices.map(n => (n.msg ? { ...n, text: said(n.msg) } : n)) };
    },
    upsert(user, raw) {
      const clean = normalize(raw, { strict: raw?.enabled !== false });
      const old = clean.id && list.find(a => a.id === clean.id);
      if (old && !canSee(old, user)) throw Object.assign(new Error(t('auto.err.notFound')), { status: 404 });
      if (old && !canEdit(old, user)) {
        // An admin may switch off someone's personal one, and nothing else: editing it would be
        // putting words in its creator's mouth, since it runs as them.
        const offOnly = isAdmin(user) && old.scope === 'personal' && clean.enabled === false &&
          JSON.stringify({ ...old, enabled: false }) === JSON.stringify({ ...old, ...clean, id: old.id, scope: old.scope });
        if (!offOnly) throw Object.assign(new Error(old.scope === 'company'
          ? t('auto.err.companyEdit') : t('auto.err.othersPersonal')), { status: 403 });
        old.enabled = false; arm(old); save();
        return old;
      }
      if (clean.scope === 'company' && !isAdmin(user)) throw Object.assign(new Error(t('auto.err.companyCreate')), { status: 403 });
      // A personal one can only name projects its creator can act on; one they cannot read is
      // answered like one that does not exist.
      if (clean.scope === 'personal') {
        for (const s of clean.steps) {
          if (!s.project || s.project === '{proyecto}') continue;
          if (!can(user, s.project, 'read')) throw Object.assign(new Error(t('err.noProject', { project: s.project })), { status: 404 });
          if (NEEDS[s.action] && !can(user, s.project, NEEDS[s.action])) throw Object.assign(new Error(t('auto.err.cannot', { project: s.project, action: ACTIONS[s.action].label })), { status: 403 });
        }
        if (clean.trigger.type === 'event' && clean.trigger.project !== '*' && !can(user, clean.trigger.project, 'read'))
          throw Object.assign(new Error(t('err.noProject', { project: clean.trigger.project })), { status: 404 });
      }
      const a = { ...(old || { created: now(), createdBy: user.id }), ...clean, savedBy: user.id,
                  id: old?.id || crypto.randomBytes(5).toString('hex'), updated: now() };
      delete a.paused;
      const timing = JSON.stringify(old?.trigger) !== JSON.stringify(a.trigger) || !old?.enabled;
      if (timing) a.anchor = now();
      arm(a, now());
      if (old) list[list.indexOf(old)] = a; else list.push(a);
      save();
      return a;
    },
    remove(user, id) {
      const a = list.find(x => x.id === id);
      if (!a || !canSee(a, user)) throw Object.assign(new Error(t('auto.err.notFound')), { status: 404 });
      if (!canEdit(a, user) && !isAdmin(user)) throw Object.assign(new Error(t('auto.err.companyDelete')), { status: 403 });
      list = list.filter(x => x !== a); save();
      return a;
    },
    async runNow(user, id) {
      const a = list.find(x => x.id === id);
      if (!a || !canSee(a, user)) throw Object.assign(new Error(t('auto.err.notFound')), { status: 404 });
      if (!canEdit(a, user)) throw Object.assign(new Error(t('auto.err.runNow')), { status: 403 });
      if (a.trigger.type === 'event' && a.steps.some(s => s.project === '{proyecto}' || s.session === '{sesion}'))
        return { ok: false, text: t('auto.err.runEvent') };
      return run(a, { why: msg('auto.why.manual', { who: user.name || user.id }), at: now() });
    },
    reconcile,
    get(id) { return list.find(a => a.id === id); },
  };
}

// ── the AI tab: a one-shot Claude that turns a sentence into a draft ─────────────────────
// No tools, no MCP, no settings (so no ghostfleet hooks treat it as a fleet session), no
// transcript kept. It only WRITES A DRAFT: the person still sees it in the editor and saves.
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'lo que le dices a la persona, breve, en el idioma que pide el sistema' },
    automation: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string' },
        trigger: { type: 'object' },
        steps: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  required: ['reply', 'automation'],
};

export async function askAI({ messages, draft, projects, nowText }) {
  const fleetText = projects.map(p => `- ${p.name}: ${p.sessions.map(s => `${s.name}${s.lead ? ' (líder)' : ''} [${s.status}]`).join(', ') || 'sin sesiones'}`).join('\n');
  const system = `Eres el asistente que arma AUTOMATIZACIONES en ghostfleet team, una página para manejar una flota de sesiones de Claude Code (workers) organizadas por proyecto. Cada proyecto tiene un líder llamado normalmente "master" y workers con nombre.

Una automatización es un disparador y una lista de pasos en orden. Devuelves SIEMPRE el JSON pedido: "reply" (breve, en ${t('ai.language')}: qué armaste o qué te falta saber) y "automation" (el borrador completo, o null si solo conversas o te falta un dato imprescindible).

Formato de "automation":
{ "name": "nombre corto",
  "trigger": UNO de:
    { "type":"schedule", "mode":"days", "at":"HH:MM", "days":[0..6] }   (0=domingo … 6=sábado; lunes a viernes = [1,2,3,4,5])
    { "type":"schedule", "mode":"once", "date":"YYYY-MM-DD", "at":"HH:MM" }
    { "type":"schedule", "mode":"every", "minutes": N }   (N ≥ 15)
    { "type":"event", "event": "finished"|"need-you"|"started"|"limit"|"lost", "project": "nombre o *", "session": "nombre o *", "cooldown": minutos }
  "steps": lista de:
    { "action":"send", "project", "session", "prompt" }        mandar un prompt a una sesión
    { "action":"spawn", "project", "name", "prompt"?, "branch"? }  crear una sesión nueva (worktree) con una tarea
    { "action":"pause"|"wake"|"interrupt"|"reopen"|"stop", "project", "session" }
    { "action":"resume", "project", "session", "prompt"? }
    { "action":"notify", "text" }                              avisarle a la persona en la página
    { "action":"wait", "minutes": 1..60 }
    { "action":"summary" }                                    mandarle a la persona un resumen de lo que pasó hoy en sus proyectos
    { "action":"check", "project", "session", "status": [estados] }   seguir con los pasos de abajo SOLO si la sesión está en alguno de esos estados; si no, la ejecución termina ahí sin error. Estados: "need-you" (te necesita), "working", "ready", "idle", "parked", "limit", "interrupted", "asleep", "lost". Úsalo para "si sigue igual…", "si todavía…".
}
Con un disparador de evento, "project":"{proyecto}" y "session":"{sesion}" en un paso significan la sesión donde pasó el evento. En prompts, nombres y avisos puedes usar {fecha} {hora} {proyecto} {sesion}. Para "stop" no pongas "confirmed": la persona lo confirma en el editor.
Usa SOLO proyectos y sesiones que existen (abajo), salvo en "spawn", que crea una nueva. Si la persona dice "el líder" usa la sesión marcada como líder. Si modifica un borrador existente, devuelve el borrador completo con el cambio. Si falta algo que no puedes deducir, pregunta en "reply" y deja "automation" en null o con lo que sí sabes.
${t('ai.replyIn')}

Ahora es ${nowText}.
La flota ahora:
${fleetText || '(no se pudo leer)'}`;
  const convo = messages.slice(-12).map(m => `${m.role === 'user' ? 'PERSONA' : 'ASISTENTE'}: ${String(m.text).slice(0, 2000)}`).join('\n\n');
  const prompt = `${draft ? `Borrador actual en el editor:\n${JSON.stringify(draft)}\n\n` : ''}Conversación:\n${convo}\n\nResponde al último mensaje de la PERSONA.`;
  const r = await claudeJson({ system, prompt, schema: DRAFT_SCHEMA });
  if (!r.ok) return r;
  let automation = null, problem = '';
  if (r.data.automation) {
    try { automation = normalize(r.data.automation, { strict: false }); delete automation.id; }
    catch (e) { problem = e.message; }
  }
  return { ok: true, reply: problem ? `${r.data.reply}\n\n${t('ai.draftProblem', { problem })}` : r.data.reply, automation };
}
