// lib/automations.mjs — automations: a trigger and steps the daemon runs on its own. A clock
// for the scheduled ones, a watcher of session statuses for the event ones, and a log of every
// run. EXPERIMENTAL and off by default (lib/experimental.mjs); docs/automations.md is the
// user's side of it.
//
// IT DECIDES WHEN, AND NOTHING ELSE. Every step that touches a session goes through `perform`,
// which bin/fleet-serve.mjs hands in: its own verb path, with the allowlist, the argument
// checks, the one-at-a-time chain and the audit row a tap from the phone gets. The audit names
// the automation as the client, so a row it caused is never mistaken for the owner's tap.
//
// A PASSKEY VERB IS APPROVED WHEN THE AUTOMATION IS SAVED. spawn and stop ask for a fresh
// passkey at the moment of action, and an automation that runs at 03:00 has nobody to ask. So
// the moment of action moves to the save: saving (or switching on) an automation that holds
// one of those steps needs X-Fleet-Assertion like the tap itself would, and the audit row of
// every run says which save approved it. Any later edit is a new save and asks again.
//
// A SCHEDULE THAT CAME DUE WHILE THE DAEMON WAS DOWN IS NOT RUN LATE: it is logged as skipped
// and a notice says so. Work that lands hours after it was meant to is the surprise this
// avoids. Switched off, nothing runs and nothing is watched; switched back on, every schedule
// counts from that moment rather than catching up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as X from './experimental.mjs';
import { ACTIONS, EVENTS, EVENT_PROJECT, EVENT_SESSION, normalize, nextAfter, describeTrigger, describeStep, fill, needsPasskey } from './automations-model.mjs';

export const FEATURE = 'automations';
export const enabled = () => X.enabled(FEATURE);
export const DISABLED_WHY = X.disabledWhy(FEATURE);
export const dir = () => process.env.CLAUDE_FLEET_AUTOMATIONS_DIR || path.join(os.homedir(), '.config', 'ghostfleet', 'automations');

const nowS = () => Math.floor(Date.now() / 1000);
const GRACE = 120;               // a due run later than this was missed, not late
const MAX_PER_HOUR = 30;         // a loop (an event its own steps cause) switches itself off here
const MAX_CHAIN = 10;            // ...and so does a slow one the hourly count never sees
const TICK_MS = 15000;
const WATCH_MS = 8000;
const MAX_AUTOMATIONS = 100;     // what can come due in the same minute has a ceiling
const MAX_NOTICES = 200;
const WAIT_SLICE_MS = 5000;      // how long a wait can outlive the thing that should have ended it
const FLEET_TTL_MS = 5000;       // a read of every project's grid is shared for this long
// A step that starts a turn on a session, which is how a run can cause the next event.
const STARTS_A_TURN = new Set(['send', 'resume', 'wake', 'reopen', 'spawn']);
const RUNS_MAX_BYTES = 256 * 1024;

// A mode given to mkdir or to a file's first write only applies when that call creates the thing:
// a directory or a file already there keeps whatever it had. Prompts live in these files, so the
// mode is asserted on every write rather than hoped for at the first one.
function privateDir() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir(), 0o700); } catch {}
}
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')); } catch { return fallback; } }
function writeText(f, text) {
  privateDir();
  const p = path.join(dir(), f), tmp = `${p}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const writeJson = (f, v) => writeText(f, JSON.stringify(v, null, 1) + '\n');
function appendLine(f, v) {
  privateDir();
  const p = path.join(dir(), f);
  fs.appendFileSync(p, JSON.stringify(v) + '\n', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}
// The log is append-only and a schedule runs for years, so it is cut back to its newest half when
// it outgrows the cap, whole lines only and through the same atomic write.
function trimRuns() {
  const p = path.join(dir(), 'runs.jsonl');
  let size = 0;
  try { size = fs.statSync(p).size; } catch { return; }
  if (size <= RUNS_MAX_BYTES) return;
  const tail = fs.readFileSync(p, 'utf8').slice(-Math.floor(RUNS_MAX_BYTES / 2));
  writeText('runs.jsonl', tail.slice(tail.indexOf('\n') + 1));
}
function readLines(f, n) {
  try { return fs.readFileSync(path.join(dir(), f), 'utf8').split('\n').filter(Boolean).slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });
const http = (status, text, extra = {}) => ({ status, json: { ok: status < 400, text, ...extra } });

// perform(tool, args, { id, name, approved }) → { ok, text }   bin/fleet-serve.mjs's verb path
// fleet() → [{ name, sessions: [{ name, status, lead }] }]     what the grid says, every project
// audit(row)                                                  the daemon's hash-chained log
export function createAutomations({ perform, fleet, audit = () => {}, log = () => {}, sleep = realSleep }) {
  const storedNotices = readJson('notices.json', null)?.notices;
  let notices = Array.isArray(storedNotices) ? storedNotices.filter(n => n && typeof n === 'object') : [];
  let list = [];
  const save = () => writeJson('automations.json', { automations: list });
  const saveNotices = () => writeJson('notices.json', { notices });
  const running = new Map();     // runKey -> id
  const lastFire = new Map();    // `${id}|${project}/${session}` -> epoch, for the cooldown
  const recent = new Map();      // id -> [epoch…] in the last hour
  const touched = new Map();     // `${project}/${session}` -> how deep the chain that started its turn is
  let wasOn = null;              // null: the daemon just started

  function notice(a, text, kind = 'info') {
    notices.push({ id: crypto.randomBytes(6).toString('hex'), at: nowS(), auto: a?.id || null, name: a?.name || '', text, kind, seen: false });
    notices = notices.slice(-MAX_NOTICES);
    saveNotices();
  }
  const logRun = (row) => { appendLine('runs.jsonl', { at: nowS(), ...row }); trimRuns(); };

  // ── what is on disk is checked before anything runs it ─────────────────────────────────
  // This file is read once at the daemon's start, and the clock and the watcher then walk it from
  // timers with nothing above them, so one row with no trigger took the whole daemon down, and
  // the phone with it. A file that cannot be used is copied aside, because the next save would
  // otherwise replace it with what survived: an error nobody saw, and every automation gone.
  function setAside(why) {
    const from = path.join(dir(), 'automations.json'), to = `${from}.bad-${nowS()}`;
    try {
      fs.copyFileSync(from, to); fs.chmodSync(to, 0o600);
      notice(null, `automations.json ${why}. A copy of it is kept as ${path.basename(to)}.`, 'bad');
    } catch (e) { log(`automations: ${why}, and it could not be kept: ${e.message}`); }
  }
  function load() {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(dir(), 'automations.json'), 'utf8'))?.automations; }
    catch (e) { if (e.code !== 'ENOENT') setAside('could not be read'); return []; }
    if (!Array.isArray(rows)) { setAside('did not hold a list'); return []; }
    const good = rows.flatMap((r) => {
      try {
        const clean = normalize(r, { strict: false });
        return clean.id ? [{ ...r, ...clean, nextRun: typeof r.nextRun === 'number' ? r.nextRun : null }] : [];
      } catch { return []; }
    });
    if (good.length !== rows.length) setAside(`held ${rows.length - good.length} automation(s) that could not be read, now left out`);
    return good;
  }
  list = load();

  // ── the clock ──────────────────────────────────────────────────────────────────────
  const arm = (a, from = nowS()) => {
    a.nextRun = a.enabled && a.trigger.type === 'schedule' ? nextAfter(a.trigger, from, a.anchor || from) : null;
  };
  function tick() {
    const on = enabled();
    if (!on) { wasOn = false; seen = null; return; }
    const t = nowS();
    // SWITCHED BACK ON: count from now. What came due while it was off was not missed — it was
    // switched off, which is the one thing that switch means.
    if (wasOn === false) { for (const a of list) { a.anchor = t; arm(a, t); } save(); }
    wasOn = true;
    let dirty = false;
    for (const a of list) {
      if (!a.enabled || a.trigger.type !== 'schedule') continue;
      if (a.nextRun == null) {
        arm(a, t); dirty = true;
        // NOTHING AHEAD OF IT: a one-off whose time went by while the switch was off. Left as it
        // was, it reads "on" with nothing scheduled and this line rewrites the file every tick.
        if (a.nextRun == null) {
          a.enabled = false;
          notice(a, `Switched "${a.name}" off: ${describeTrigger(a.trigger)} has passed and it did not run. It was not run late.`, 'warn');
        }
        continue;
      }
      if (a.nextRun > t) continue;
      const due = a.nextRun;
      if (t - due > GRACE) {
        logRun({ auto: a.id, name: a.name, status: 'skipped', trigger: describeTrigger(a.trigger), due, text: 'fleet-serve was not running, or this machine was asleep' });
        notice(a, `"${a.name}" did not run at ${new Date(due * 1000).toLocaleString()}: fleet-serve was not running then, or this machine was asleep. It was not run late.`, 'warn');
      } else {
        begin(a, { why: describeTrigger(a.trigger), at: due, depth: 0 });
      }
      if (a.trigger.mode === 'once') { a.enabled = false; a.nextRun = null; } else arm(a, t);
      dirty = true;
    }
    if (dirty) save();
  }

  // ── what the grid says ─────────────────────────────────────────────────────────────────
  // One grid per project per read, in a process each. The phone's poll of this screen asked for
  // all of them every time, on top of the watcher, so these share one read for a few seconds.
  // `fresh` is for a step whose whole point is the status at this moment.
  let fleetRead = null;
  function readFleet({ fresh = false } = {}) {
    if (!fresh && fleetRead && Date.now() - fleetRead.at < FLEET_TTL_MS) return fleetRead.promise;
    const read = { at: Date.now(), promise: Promise.resolve().then(() => fleet()) };
    fleetRead = read;
    read.promise.catch(() => { if (fleetRead === read) fleetRead = null; });
    return read.promise;
  }

  // ── the watcher: a status that CHANGED is an event; the first look only learns the fleet ──
  let seen = null, watching = false;
  async function watch() {
    if (watching) return;        // a slow grid outlasts the interval, and reads would pile up
    watching = true;
    try { await watchOnce(); } finally { watching = false; }
  }
  async function watchOnce() {
    if (!enabled()) { seen = null; return; }
    const listeners = list.filter(a => a.enabled && a.trigger.type === 'event');
    if (!listeners.length) { seen = null; return; }
    let projects;
    try { projects = await readFleet(); } catch { return; }
    if (!enabled()) { seen = null; return; }
    const cur = new Map();
    for (const p of projects) for (const s of p.sessions || []) cur.set(`${p.name}/${s.name}`, { project: p.name, session: s.name, status: s.status });
    if (seen) {
      for (const [k, c] of cur) {
        const before = seen.get(k)?.status;
        if (before === undefined || before === c.status) continue;
        // HOW DEEP THIS IS: was this turn started by a step, and how deep was the run behind that
        // step? "When a worker finishes, send it the next thing", with turns longer than the
        // cooldown, fires a few times an hour for ever: it never reaches the hourly count, and
        // nothing is wrong with any one run. Two automations feeding each other, and one whose
        // spawned session sets off the next spawn, are the same chain. A chain ends the moment
        // an event arrives that no step caused. Read before the runs below start, because their
        // first step marks the session in the same breath.
        const depth = touched.has(k) ? touched.get(k) + 1 : 0;
        if (before === 'working' && c.status !== 'working') touched.delete(k);
        for (const a of listeners) {
          if (!list.includes(a)) continue;
          const tr = a.trigger;
          if (!EVENTS[tr.event]?.is(before, c.status)) continue;
          if (tr.project !== '*' && tr.project !== c.project) continue;
          if (tr.session !== '*' && tr.session !== c.session) continue;
          const ck = `${a.id}|${k}`;
          if (nowS() - (lastFire.get(ck) || 0) < tr.cooldown * 60) continue;
          if (depth >= MAX_CHAIN) {
            switchOff(a, `Switched "${a.name}" off: automations have set each other off ${MAX_CHAIN} times in a row on ${k}, which looks like a loop. Check it and switch it back on.`);
            continue;
          }
          // A fire that did not start has not used its cooldown: the second of two sessions that
          // changed in one look lost its "tell me" to the first's run, and to its own cooldown.
          if (begin(a, { why: `${c.project}/${c.session} ${EVENTS[tr.event].label}`, at: nowS(), project: c.project, session: c.session, depth })) lastFire.set(ck, nowS());
        }
      }
    }
    seen = cur;
    if (touched.size > 1000) touched.clear();     // sessions long gone: only a bound, never a reset in practice
  }

  // ── a run: the steps in order; the first that fails stops the rest ─────────────────────
  // An automation's own switching-off replaces the object, like an edit, so a run in flight sees
  // it and stops.
  function switchOff(a, text) {
    const off = { ...a, enabled: false, nextRun: null };
    list = list.map(x => (x === a ? off : x));
    save();
    notice(off, text, 'bad');
    return { ok: false, text };
  }
  // One at a time per automation, except that an event runs once per SESSION: two workers
  // finishing in the same look are two things that happened. Synchronous, so that whoever asked
  // knows the answer before anything awaits.
  const runKey = (a, ctx) => (ctx.session ? `${a.id}|${ctx.project}/${ctx.session}` : a.id);
  const isRunning = (id) => [...running.values()].includes(id);
  function admit(a, ctx) {
    if (running.has(runKey(a, ctx))) {
      logRun({ auto: a.id, name: a.name, status: 'skipped', trigger: ctx.why, text: 'the previous run had not finished' });
      return { ok: false, text: 'it is already running' };
    }
    const hour = (recent.get(a.id) || []).filter(x => nowS() - x < 3600);
    if (hour.length >= MAX_PER_HOUR) return switchOff(a, `Switched "${a.name}" off: it fired ${MAX_PER_HOUR} times in an hour, which looks like a loop. Check it and switch it back on.`);
    recent.set(a.id, [...hour, nowS()]);
    return null;
  }
  // Nothing waits on a run the clock or the watcher started, so a write that fails inside it (a
  // full disk, say) would be an unhandled rejection, and that ends the daemon. True if it started.
  function begin(a, ctx) {
    try { if (admit(a, ctx)) return false; }
    catch (e) { log(`automations: "${a.name}" could not start: ${e.message}`); return false; }
    launch(a, ctx).catch(e => log(`automations: a run of "${a.name}" failed: ${e.message}`));
    return true;
  }
  async function launch(a, ctx) {
    const key = runKey(a, ctx);
    running.set(key, a.id);
    // WHAT WAS SAVED RUNS ONLY WHILE IT STILL STANDS. A run can take twenty steps of an hour each,
    // and without this it went on sending prompts after the switch was turned off, after it was
    // deleted, and from the old steps after an edit, whose last write then landed on an object no
    // longer in the list. Asked before every step, and through every wait. An edit replaces the
    // object, so "still this revision" is the same question as "still here".
    const stopped = () => (!enabled() ? 'automations were switched off while it ran'
      : !list.some(x => x.id === a.id) ? 'it was deleted while it ran'
      : !list.includes(a) ? 'it was changed while it ran' : '');
    const steps = [];
    let status = 'ok', text = '';
    try {
      for (const s of a.steps) {
        text = stopped();
        if (text) { status = 'stopped'; break; }
        const r = await step(a, s, { ...ctx, stopped }).catch(e => ({ ok: false, text: e.message }));
        const v = { at: ctx.at, project: ctx.project, session: ctx.session };
        const shown = { ...s, project: fill(s.project === EVENT_PROJECT ? ctx.project : s.project, v),
                        session: fill(s.session === EVENT_SESSION ? ctx.session : s.session, v),
                        prompt: fill(s.prompt, v), name: fill(s.name, v), text: fill(s.text, v) };
        steps.push({ action: s.action, what: describeStep(shown), ok: r.ok, text: String(r.text || '').slice(0, 300), ...(r.halt ? { halt: true } : {}) });
        if (!r.ok) { status = 'error'; text = String(r.text || ''); break; }
        if (r.halt) break;
      }
    } finally { running.delete(key); }
    const ok = status === 'ok';
    const cur = list.find(x => x.id === a.id);
    if (cur && status !== 'stopped') { cur.lastRun = { at: nowS(), ok }; save(); }
    logRun({ auto: a.id, name: a.name, status, trigger: ctx.why, steps, ...(text ? { text: text.slice(0, 300) } : {}) });
    if (status === 'error') notice(a, `"${a.name}" failed at "${steps.at(-1)?.what}": ${steps.at(-1)?.text || 'no detail'}`, 'bad');
    return { ok, steps, text };
  }

  async function step(a, s, ctx) {
    const v = { at: ctx.at, project: ctx.project, session: ctx.session };
    if (s.action === 'wait') {
      // In slices, so what ended the run also ends the wait, and the slot a later run needs is
      // not held for the rest of an hour by a run that is already over.
      for (let left = s.minutes * 60000; left > 0 && !ctx.stopped(); left -= WAIT_SLICE_MS) await sleep(Math.min(left, WAIT_SLICE_MS));
      return { ok: true, text: `waited ${s.minutes} min` };
    }
    if (s.action === 'notify') { notice(a, fill(s.text, v), 'info'); return { ok: true, text: 'notice added' }; }
    const project = s.project === EVENT_PROJECT ? ctx.project : s.project;
    const session = s.session === EVENT_SESSION ? ctx.session : s.session;
    if (!project) return { ok: false, text: "no project: the step uses the event's, and this run did not come from an event" };
    if (s.action === 'check') {
      const st = (await readFleet({ fresh: true })).find(p => p.name === project)?.sessions?.find(x => x.name === session)?.status || 'gone';
      return s.status.includes(st) ? { ok: true, text: `it is ${st}: continuing` } : { ok: true, halt: true, text: `it is ${st}: stopping here` };
    }
    const def = ACTIONS[s.action];
    if (def.passkey && !a.approved) return { ok: false, text: `${s.action} needs the automation to be saved with a passkey` };
    const args = { project };
    if (s.action === 'spawn') {
      args.name = fill(s.name, v).replace(/[^A-Za-z0-9 ._~-]/g, '-').slice(0, 48);
      if (s.prompt) args.prompt = fill(s.prompt, v);
      if (s.branch) args.branch = fill(s.branch, v);
    } else {
      if (!session) return { ok: false, text: "no session: the step uses the event's, and this run did not come from an event" };
      args.session = session;
      if (s.prompt) args.prompt = fill(s.prompt, v);
    }
    // Marked before the step, not after it: fleet-send can take long enough for a short turn to
    // be over by the time it returns, and that turn's end would then read as nobody's doing.
    if (STARTS_A_TURN.has(s.action)) touched.set(`${project}/${args.session || args.name}`, ctx.depth || 0);
    return perform(def.tool, args, { id: a.id, name: a.name, approved: a.approved });
  }

  // ── what the phone asks ────────────────────────────────────────────────────────────────
  async function view() {
    let projects = [];
    try { projects = await readFleet(); } catch {}
    return { ok: true, automations: list.map(a => ({ ...a, running: isRunning(a.id) })),
             runs: readLines('runs.jsonl', 60), notices: notices.slice(-40).reverse(),
             fleet: projects.map(p => ({ name: p.name, sessions: (p.sessions || []).map(s => ({ name: s.name, lead: !!s.lead })) })) };
  }
  function upsert(raw, getAssertion, client) {
    const clean = normalize(raw, { strict: raw?.enabled !== false });
    const old = clean.id && list.find(a => a.id === clean.id);
    if (clean.id && !old) return http(404, 'there is no such automation');
    if (!old && list.length >= MAX_AUTOMATIONS) return http(409, `at most ${MAX_AUTOMATIONS} automations: delete one first`);
    // THE SAVE IS THE MOMENT OF ACTION for a passkey step (see the top of this file). Saving one
    // switched off needs none: nothing can run until it is switched on, which is a save.
    let approved = null;
    if (needsPasskey(clean) && clean.enabled) {
      const assertion = getAssertion();
      if (!assertion) return http(428, 'this automation can start or stop sessions on its own, so saving it needs a fresh passkey (X-Fleet-Assertion)', { needs: 'passkey' });
      if (assertion.error) return http(428, assertion.error, { needs: 'passkey' });
      approved = { at: nowS(), by: client?.id || '?', purpose: assertion.purpose || 'unnamed' };
    }
    const a = { ...(old || { created: nowS() }), ...clean, id: old?.id || crypto.randomBytes(5).toString('hex'), updated: nowS(), approved };
    if (JSON.stringify(old?.trigger) !== JSON.stringify(a.trigger) || !old?.enabled) a.anchor = nowS();
    arm(a, nowS());
    // Written first and only then taken: a save that failed told the phone so, and was still in
    // the list that runs, so a retry of a new one left two.
    const next = old ? list.map(x => (x === old ? a : x)) : [...list, a];
    writeJson('automations.json', { automations: next });
    list = next;
    audit({ client: client?.id || '?', verb: 'automation_save', subject: a.name, result: 'ran',
            confirmed: approved ? `passkey:${approved.purpose}` : null,
            output: `${describeTrigger(a.trigger)} · ${a.steps.length} step(s)${a.enabled ? '' : ' · off'}` });
    return http(200, 'saved', { automation: a });
  }
  function remove(id, client) {
    const a = list.find(x => x.id === id);
    if (!a) return http(404, 'there is no such automation');
    list = list.filter(x => x !== a); save();
    audit({ client: client?.id || '?', verb: 'automation_delete', subject: a.name, result: 'ran', output: '' });
    return http(200, 'deleted');
  }
  async function runNow(id) {
    const a = list.find(x => x.id === id);
    if (!a) return http(404, 'there is no such automation');
    if (a.trigger.type === 'event' && a.steps.some(s => s.project === EVENT_PROJECT || s.session === EVENT_SESSION))
      return http(409, "it uses the event's session, so it can only run when the event happens");
    const ctx = { why: 'run now, from the phone', at: nowS(), depth: 0 };
    const r = admit(a, ctx) || await launch(a, ctx);
    return { status: 200, json: { ok: r.ok, text: r.text || (r.ok ? 'done' : 'it failed'), steps: r.steps || [] } };
  }

  // A throw in a timer's callback has nothing above it and ends the process, and this is the
  // process the phone talks to. An automation is never worth that.
  const guarded = (what, fn) => async () => { try { await fn(); } catch (e) { log(`automations: ${what} failed: ${e.message}`); } };
  const timers = [];
  return {
    start() {
      const t = guarded('the clock', tick), w = guarded('the watcher', watch);
      t();
      timers.push(setInterval(t, TICK_MS), setInterval(w, WATCH_MS));
      for (const x of timers) x.unref();
    },
    stop() { for (const x of timers.splice(0)) clearInterval(x); },
    tick, watch,
    // Every /api/automations* route, or null when the path is not one. Switched off, every one
    // is a 404 that says so — never a 200 describing an absent feature, which a client would draw.
    async route({ method, p, body, assertion, client }) {
      if (p !== '/api/automations' && !p.startsWith('/api/automations/')) return null;
      if (!enabled()) return { status: 404, json: { ok: false, disabled: true, experimental: true, text: DISABLED_WHY } };
      try {
        if (p === '/api/automations' && method === 'GET') return { status: 200, json: await view() };
        if (method !== 'POST') return http(405, 'POST only');
        if (p === '/api/automations') return upsert(body.automation, assertion, client);
        if (p === '/api/automations/delete') return remove(String(body.id || ''), client);
        if (p === '/api/automations/run') return await runNow(String(body.id || ''));
        if (p === '/api/automations/seen') {
          for (const n of notices) n.seen = true;
          saveNotices();
          return http(200, 'seen');
        }
        if (p === '/api/automations/draft') return await draft(body, readFleet);
        return http(404, `no such endpoint: ${p}`);
      } catch (e) {
        return http(e.status || 500, e.message || 'internal error');
      }
    },
    // For /api/projects: how many notices the owner has not looked at, or null when switched off.
    unseen: () => (enabled() ? notices.filter(n => !n.seen).length : null),
    get: (id) => list.find(a => a.id === id),
  };
}

// ── the draft: a one-shot model that turns a sentence into an automation ─────────────────
// No tools, no MCP, no settings (so no fleet hook mistakes it for a session), nothing kept. It
// only WRITES A DRAFT: the owner still sees it in the editor and saves it, and the save is
// where a passkey step is approved. One at a time — it is a whole agent process.
let drafting = false;
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'what you tell the person, short' },
    automation: { type: ['object', 'null'], properties: { name: { type: 'string' }, trigger: { type: 'object' }, steps: { type: 'array', items: { type: 'object' } } } },
  },
  required: ['reply', 'automation'],
};

async function draft(body, fleet) {
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && m.text)
    .map(m => ({ role: m.role === 'ai' ? 'ai' : 'user', text: String(m.text).slice(0, 2000) })).slice(-12);
  if (!messages.length) return http(400, 'say what you want automated');
  if (drafting) return http(429, 'a draft is already being written — wait for it');
  let projects = [];
  try { projects = await fleet(); } catch {}
  const fleetText = projects.map(p => `- ${p.name}: ${(p.sessions || []).map(s => `${s.name}${s.lead ? ' (lead)' : ''} [${s.status}]`).join(', ') || 'no sessions'}`).join('\n');
  const system = `You write AUTOMATIONS for ghostfleet, which runs fleets of coding-agent sessions organised by project. Each project has a lead session, usually called "master", and workers with names.

An automation is one trigger and a list of steps run in order. Always return the requested JSON: "reply" (short: what you built, or what you still need to know) and "automation" (the complete draft, or null if you are only talking or are missing something essential).

"automation":
{ "name": "short name",
  "trigger": ONE of:
    { "type":"schedule", "mode":"days", "at":"HH:MM", "days":[0..6] }   (0=Sunday … 6=Saturday; weekdays = [1,2,3,4,5])
    { "type":"schedule", "mode":"once", "date":"YYYY-MM-DD", "at":"HH:MM" }
    { "type":"schedule", "mode":"every", "minutes": N }   (N ≥ 15)
    { "type":"event", "event": "finished"|"need-you"|"started"|"limit"|"interrupted", "project": "name or *", "session": "name or *", "cooldown": minutes }
  "steps": a list of:
    { "action":"send", "project", "session", "prompt" }
    { "action":"spawn", "project", "name", "prompt"?, "branch"? }     start a new session (a worktree) with a task
    { "action":"pause"|"wake"|"interrupt"|"reopen"|"stop", "project", "session" }
    { "action":"resume", "project", "session", "prompt"? }
    { "action":"notify", "text" }                                    a notice for the owner on the phone
    { "action":"wait", "minutes": 1..60 }
    { "action":"check", "project", "session", "status": [statuses] } continue with the steps below ONLY if the session is in one of these; otherwise the run ends there, without an error. Statuses: need-you, working, ready, parked, idle, starting, unknown, limit, interrupted.
}
With an event trigger, "project":"{project}" and "session":"{session}" in a step mean the session the event happened to. Prompts, names and notices may use {date} {time} {project} {session}.
Use ONLY projects and sessions that exist (below), except in "spawn", which creates one. "The lead" is the session marked lead. When the person changes an existing draft, return the whole draft with the change. If something cannot be inferred, ask in "reply" and leave "automation" null or partial.

It is now ${new Date().toString()}.
The fleet right now:
${fleetText || '(could not be read)'}`;
  const prompt = `${body.draft ? `Current draft in the editor:\n${JSON.stringify(body.draft).slice(0, 8000)}\n\n` : ''}Conversation:\n${messages.map(m => `${m.role === 'user' ? 'PERSON' : 'YOU'}: ${m.text}`).join('\n\n')}\n\nAnswer the PERSON's last message.`;
  drafting = true;
  let r;
  try { r = await oneShot({ system, prompt, schema: DRAFT_SCHEMA }); } finally { drafting = false; }
  if (!r.ok) return http(502, r.text);
  let automation = null, problem = '';
  if (r.data.automation) {
    try { automation = normalize(r.data.automation, { strict: false }); delete automation.id; }
    catch (e) { problem = e.message; }
  }
  return http(200, 'drafted', { reply: problem ? `${r.data.reply}\n\n(The draft came back with a problem: ${problem})` : r.data.reply, automation });
}

// `claude -p`, one question, one JSON answer. CLAUDE_FLEET_AUTOMATIONS_AGENT replaces the
// binary (the suite points it at a stub).
function oneShot({ system, prompt, schema, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const bin = process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT || 'claude';
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_FLEET_') && k !== 'TMUX' && k !== 'TMUX_PANE'));
    const child = spawn(bin, ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--output-format', 'json', '--model', 'sonnet', '--system-prompt', system, '--json-schema', JSON.stringify(schema), prompt],
      { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '', err = '';
    const kill = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(kill); resolve({ ok: false, text: `could not start ${bin}: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(kill);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return resolve({ ok: false, text: String(j.result || 'the model returned an error').slice(0, 300) });
        resolve({ ok: true, data: j.structured_output || JSON.parse(j.result) });
      } catch {
        resolve({ ok: false, text: (err || out || 'the model did not answer').trim().split('\n').slice(-1)[0].slice(0, 300) });
      }
    });
  });
}
