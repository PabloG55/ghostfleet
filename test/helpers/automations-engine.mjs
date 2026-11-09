#!/usr/bin/env node
// automations-engine — the runner on its own: the clock, the watcher, the files, the draft.
//
//     node test/helpers/automations-engine.mjs      # "name <US> want <US> got" rows
//
// AUTOMATIONS_LIB points it at another copy of lib/ (the default is this checkout's), which is
// how each row was watched go red: the group's comment in test/run.sh says against what.
//
// WHY NOT THROUGH THE DAEMON. Most of what can go wrong here takes a clock: a week of downtime, an
// hour of runs, a sixty-minute wait. `Date.now` is replaced and `sleep` is handed in, so those take
// no time, and the fleet is a fake whose statuses a row sets. serve-probe covers the same code
// through the real routes and the real verb path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIB = process.env.AUTOMATIONS_LIB || new URL('../../lib', import.meta.url).pathname;
const US = '\x1f';
const row = (name, want, got) => process.stdout.write(`${name}${US}${want}${US}${String(got).replace(/\s+/g, ' ')}\n`);

const realNow = Date.now;
let clock = Math.floor(realNow() / 1000);
Date.now = () => clock * 1000;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-auto-engine-'));
process.env.CLAUDE_FLEET_EXPERIMENTAL_DIR = path.join(TMP, 'switch');
fs.mkdirSync(process.env.CLAUDE_FLEET_EXPERIMENTAL_DIR);
const SWITCH = path.join(process.env.CLAUDE_FLEET_EXPERIMENTAL_DIR, 'automations.enabled');
const setSwitch = (on) => fs.writeFileSync(SWITCH, on ? 'on\n' : 'off\n');
setSwitch(true);

const { createAutomations, oneShot } = await import(`${LIB}/automations.mjs`);
const model = await import(`${LIB}/automations-model.mjs`);
const { normalize } = model;

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

let serial = 0;
const dirFor = () => {
  const d = path.join(TMP, `auto-${++serial}`);
  process.env.CLAUDE_FLEET_AUTOMATIONS_DIR = d;
  return d;
};
// A fleet whose statuses a row sets, and a perform that records what reached it.
function rig({ seed, clientLive, perform, fleet } = {}) {
  const d = dirFor();
  if (seed !== undefined) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'automations.json'), seed); }
  const did = [], audits = [], logs = [];
  const state = { sessions: { 'acme-api/w1': 'ready', 'acme-api/w2': 'ready', 'acme-web/master': 'ready' }, reads: 0 };
  const readFleet = async () => {
    state.reads++;
    const byProject = new Map();
    for (const [k, status] of Object.entries(state.sessions)) {
      const [project, name] = k.split('/');
      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project).push({ name, status, lead: name === 'master' });
    }
    return [...byProject].map(([name, sessions]) => ({ name, sessions, share: name !== 'billing-svc' }));
  };
  const sleeps = { pending: [], total: 0 };
  const sleep = (ms) => new Promise((r) => { sleeps.total += ms; sleeps.pending.push({ ms, r }); });
  const engine = createAutomations({
    perform: perform || (async (tool, args, meta) => { did.push({ tool, args, meta }); return { ok: true, text: 'ok' }; }),
    fleet: fleet || readFleet,
    audit: r => audits.push(r), log: m => logs.push(String(m)),
    clientLive, sleep,
  });
  const call = (method, p, body = {}, assertion = () => null, client = { id: 'phone-1' }) =>
    engine.route({ method, p, body, client, assertion });
  // A save the suite means to succeed: it goes through the route, as the phone's does.
  const save = async (a, assertion) => {
    const r = await call('POST', '/api/automations', { automation: a }, assertion || (() => null));
    return r.json.automation;
  };
  return { d, did, audits, logs, state, sleeps, engine, call, save,
    file: f => path.join(d, f),
    list: async () => (await call('GET', '/api/automations')).json };
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
const threw = (fn) => { try { fn(); return 'no'; } catch (e) { return e.status === 400 ? '400' : `other: ${e.message}`; } };
const nowDate = (plusDays) => {
  const d = new Date((clock + plusDays * 86400) * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const modeOf = (f) => (fs.statSync(f).mode & 0o777).toString(8);
const SEND = { action: 'send', project: 'acme-api', session: 'w1', prompt: 'review what is open' };
const EVERY = { type: 'schedule', mode: 'every', minutes: 15 };
const DAILY = { type: 'schedule', mode: 'days', at: '09:00', days: [1, 2, 3, 4, 5] };

// ── what a person, or the model, can write ───────────────────────────────────────────────
{
  const draft = (trigger, steps = [SEND]) => ({ name: 'x', trigger, steps });
  row('an event named after a built-in is refused', '400', threw(() => normalize(draft({ type: 'event', event: 'constructor' }), { strict: false })));
  row('...and the one every object inherits', '400', threw(() => normalize(draft({ type: 'event', event: '__proto__' }), { strict: false })));
  row('...and a real name wrapped in a list', '400', threw(() => normalize(draft({ type: 'event', event: ['finished'] }), { strict: false })));
  row('an action named after a built-in is refused', '400', threw(() => normalize(draft(DAILY, [{ action: 'constructor' }]), { strict: false })));
  row('...and the one every object inherits, for an action', '400', threw(() => normalize(draft(DAILY, [{ action: '__proto__' }]), { strict: false })));
  row('...and a real action wrapped in a list', '400', threw(() => normalize(draft(DAILY, [{ action: ['send'] }]), { strict: false })));
  row('a real event and a real action still pass', 'no', threw(() => normalize(draft({ type: 'event', event: 'finished' }), { strict: false })));
  row('a time that is a list is not saved as a list', '10:00', normalize(draft({ ...DAILY, at: ['09:00'] })).trigger.at);
  row('a real time is kept', '09:00', normalize(draft(DAILY)).trigger.at);
  row("a null, an empty day and 1.5 are not Sunday, and '3' is Wednesday", '[2,3]',
    JSON.stringify(normalize(draft({ ...DAILY, days: [null, '', 1.5, 2, '3'] })).trigger.days));
  const once = (date, at = '23:59') => ({ type: 'schedule', mode: 'once', date, at });
  row('month 13 is not a date', '400', threw(() => normalize(draft(once('2099-13-45')))));
  row('...and neither is the 30th of February', '400', threw(() => normalize(draft(once('2099-02-30')))));
  row('...nor a date in a list', '400', threw(() => normalize(draft(once(['2099-01-01'])))));
  row('a one-off in the past is refused at the save', '400', threw(() => normalize(draft(once(nowDate(-3))))));
  try { normalize(draft(once(nowDate(-3)))); } catch (e) { row('...saying what to do about it', 'yes', /already passed/.test(e.message) ? 'yes' : e.message); }
  row('...and one ahead of us is taken', 'no', threw(() => normalize(draft(once(nowDate(3))))));
  row('...and switched off it may keep its old date', 'no', threw(() => normalize(draft(once(nowDate(-3))), { strict: false })));
}

// ── a file that cannot be used never takes the daemon down, and is never overwritten ─────
{
  const r = rig({ seed: '{ this is not json' });
  const copies = fs.readdirSync(r.d).filter(f => f.includes('.bad-'));
  row('a file that is not JSON: the engine still starts', '[]', JSON.stringify((await r.list()).automations));
  row('...a copy is kept beside it', '1', copies.length);
  row('...holding what was there', '{ this is not json', fs.readFileSync(r.file(copies[0]), 'utf8'));
  row('...that only the owner can read', '600', modeOf(r.file(copies[0])));
  row('...and the phone is told', 'yes', (await r.list()).notices.some(n => /could not be read/.test(n.text) && n.kind === 'bad') ? 'yes' : 'no');
  await r.save({ name: 'after', trigger: DAILY, steps: [SEND] });
  row('...and the next save leaves the copy alone', '{ this is not json', fs.readFileSync(r.file(copies[0]), 'utf8'));
}
for (const [what, seed] of [['null', 'null'], ['a string where the list goes', '{"automations":"nope"}'], ['an object where the list goes', '{"automations":{}}']]) {
  const r = rig({ seed });
  r.engine.tick(); await r.engine.watch();
  row(`a file holding ${what}: the engine runs with none`, '[]', JSON.stringify((await r.list()).automations));
}
{
  const good = { id: 'keep1', name: 'kept', enabled: true, trigger: EVERY, steps: [SEND], nextRun: clock + 900 };
  const seed = JSON.stringify({ automations: [
    { id: 'noTrigger', name: 'no trigger', enabled: true, steps: [{ action: 'constructor' }] },
    { id: 'proto', name: 'proto', enabled: true, trigger: { type: 'event', event: '__proto__' }, steps: [] },
    null, 7,
    good,
  ] });
  const r = rig({ seed });
  r.state.sessions['acme-api/w1'] = 'working';
  await r.engine.watch();
  r.state.sessions['acme-api/w1'] = 'ready';
  let threwAt = 'no';
  try { r.engine.tick(); await r.engine.watch(); } catch (e) { threwAt = e.message; }
  row('rows it cannot read do not throw from the clock or the watcher', 'no', threwAt);
  row('...the row it can read survives them', 'keep1', (await r.list()).automations.map(a => a.id).join());
  row('...and the whole file was copied aside first', '1', fs.readdirSync(r.d).filter(f => f.includes('.bad-')).length);
}
{
  const r = rig({});
  fs.mkdirSync(r.d, { recursive: true });
  fs.writeFileSync(r.file('notices.json'), '{"notices":"nope"}');
  const again = createAutomations({ perform: async () => ({ ok: true }), fleet: async () => [], sleep: async () => {} });
  row('a notices file that is not a list is treated as none', '0', again.unseen());
}

// ── the clock ────────────────────────────────────────────────────────────────────────────
{
  // A one-off whose time went by while the switch was off: nothing ahead of it.
  const seed = JSON.stringify({ automations: [{ id: 'past1', name: 'one-off', enabled: true, nextRun: null,
    trigger: { type: 'schedule', mode: 'once', date: nowDate(-1), at: '09:00' }, steps: [SEND] }] });
  const r = rig({ seed });
  r.engine.tick();
  const a = (await r.list()).automations[0];
  row('a one-off with nothing ahead of it is switched off', 'false', a.enabled);
  row('...it does not run', '0', r.did.length);
  row('...and the phone hears about it', '1', (await r.list()).notices.filter(n => /has passed/.test(n.text)).length);
  const old = new Date(realNow() - 3600 * 1000);
  fs.utimesSync(r.file('automations.json'), old, old);
  const before = fs.statSync(r.file('automations.json')).mtimeMs;
  r.engine.tick(); r.engine.tick();
  row('...and the clock stops rewriting the file for it', 'yes', fs.statSync(r.file('automations.json')).mtimeMs === before ? 'yes' : 'no');
  row('...and says so only once', '1', (await r.list()).notices.filter(n => /has passed/.test(n.text)).length);
}
{
  const r = rig({ seed: JSON.stringify({ automations: [{ id: 'wk', name: 'weekly', enabled: true, nextRun: clock - 7 * 86400,
    trigger: EVERY, steps: [SEND] }] }) });
  r.engine.tick();
  await settle();
  const runs = lines(r.file('runs.jsonl')).map(l => JSON.parse(l));
  row('a daemon down for a week runs nothing on its return', '0', r.did.length);
  row('...logs one skip, not a week of them', '1', runs.filter(x => x.status === 'skipped').length);
  const n = (await r.list()).notices;
  row('...with one notice', '1', n.length);
  row('...that allows for a machine that slept', 'yes', /asleep/.test(n[0].text) ? 'yes' : n[0].text);
  const a = (await r.list()).automations[0];
  row('...and it is armed from now, not from then', 'yes', a.nextRun > clock ? 'yes' : `${a.nextRun} <= ${clock}`);
}
{
  const r = rig({ seed: JSON.stringify({ automations: [{ id: 'due', name: 'due', enabled: true, nextRun: clock - 30, trigger: EVERY, steps: [SEND] }] }) });
  r.engine.tick();
  await settle();
  row('a run due within the grace does run', '1', r.did.length);
  r.engine.tick();
  await settle();
  row('...once', '1', r.did.length);
}
{
  const r = rig({});
  await r.save({ name: 'off and on', trigger: EVERY, steps: [SEND] });
  setSwitch(false);
  r.engine.tick();
  clock += 3 * 86400;
  r.engine.tick();
  row('switched off, nothing runs', '0', r.did.length);
  setSwitch(true);
  r.engine.tick();
  await settle();
  row('...switched back on, what came due meanwhile is not run', '0', r.did.length);
  row('...and is not reported as missed either', '0', (await r.list()).notices.length);
  row('...it counts from that moment', 'yes', (await r.list()).automations[0].nextRun > clock ? 'yes' : 'no');
}

// ── the files ────────────────────────────────────────────────────────────────────────────
{
  const r = rig({});
  fs.mkdirSync(r.d, { recursive: true, mode: 0o755 }); fs.chmodSync(r.d, 0o755);
  for (const f of ['automations.json', 'runs.jsonl', 'notices.json']) { fs.writeFileSync(r.file(f), f === 'runs.jsonl' ? '' : '{}'); fs.chmodSync(r.file(f), 0o644); }
  const a = await r.save({ name: 'modes', trigger: EVERY, steps: [{ action: 'notify', text: 'hello' }] });
  await r.call('POST', '/api/automations/run', { id: a.id });
  await settle();
  row('a directory that was already open is closed', '700', modeOf(r.d));
  row('...the list that was already open is closed', '600', modeOf(r.file('automations.json')));
  row('...and the log', '600', modeOf(r.file('runs.jsonl')));
  row('...and the notices', '600', modeOf(r.file('notices.json')));
  row('...and no temporary file is left behind', '0', fs.readdirSync(r.d).filter(f => f.endsWith('.tmp')).length);
}
{
  const r = rig({});
  fs.mkdirSync(r.d, { recursive: true });
  const filler = JSON.stringify({ at: 1, auto: 'old', name: 'old', status: 'ok', pad: 'x'.repeat(500) });
  fs.writeFileSync(r.file('runs.jsonl'), `${filler}\n`.repeat(1000));
  const huge = fs.statSync(r.file('runs.jsonl')).size;
  const a = await r.save({ name: 'newest row', trigger: EVERY, steps: [{ action: 'notify', text: 'hi' }] });
  await r.call('POST', '/api/automations/run', { id: a.id });
  await settle();
  const after = lines(r.file('runs.jsonl'));
  row('a log past its cap is cut back', 'yes', fs.statSync(r.file('runs.jsonl')).size < huge / 2 ? 'yes' : `${fs.statSync(r.file('runs.jsonl')).size} of ${huge}`);
  row('...keeping the newest run', 'newest row', JSON.parse(after.at(-1)).name);
  row('...and every line it kept is whole', 'yes', after.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }) ? 'yes' : 'no');
}
{
  const r = rig({});
  const a = await r.save({ name: 'chatty', trigger: EVERY, steps: [{ action: 'notify', text: 'hi' }] });
  for (let i = 0; i < 260; i++) { await r.call('POST', '/api/automations/run', { id: a.id }); clock += 121; await settle(); }
  row('notices are bounded in memory, not only on disk', 'yes', r.engine.unseen() <= 200 ? 'yes' : `${r.engine.unseen()} unseen`);
}
{
  const r = rig({});
  for (let i = 0; i < 100; i++) await r.save({ name: `n${i}`, trigger: EVERY, steps: [SEND] });
  const over = await r.call('POST', '/api/automations', { automation: { name: 'one more', trigger: EVERY, steps: [SEND] } });
  row('what can come due together has a ceiling', '409', over.status);
}

// ── a write that fails inside a run does not take the daemon down ────────────────────────
{
  const r = rig({ seed: JSON.stringify({ automations: [{ id: 'due2', name: 'due', enabled: true, nextRun: clock - 5, trigger: EVERY, steps: [SEND] }] }) });
  fs.mkdirSync(r.file('runs.jsonl'));          // an append to a directory is the failure a full disk would be
  r.engine.tick();
  await settle();
  await new Promise(res => setTimeout(res, 5));
  row('a log that cannot be written is not an unhandled rejection', '0', unhandled);
  row('...and it is logged', 'yes', r.logs.some(l => /failed/.test(l)) ? 'yes' : `no: ${r.logs.join('|')}`);
  // The rename onto a directory fails too, and a notice is written from inside the clock.
  const s = rig({ seed: JSON.stringify({ automations: [{ id: 'lost', name: 'missed', enabled: true, nextRun: clock - 7 * 86400, trigger: EVERY, steps: [SEND] }] }) });
  fs.mkdirSync(s.file('notices.json'));
  let threwAt = 'no';
  try { s.engine.start(); await settle(); } catch (e) { threwAt = e.message; }
  s.engine.stop();
  row('a notice that cannot be written does not throw out of the clock', 'no', threwAt);
  row('...and is logged', 'yes', s.logs.some(l => /clock failed/.test(l)) ? 'yes' : `no: ${s.logs.join('|')}`);
}
// ── a run in flight answers to the switch, a delete and an edit ──────────────────────────
// Lets every wait in flight finish its current slice, the way time would.
const slice = async (r) => { await settle(); for (const p of r.sleeps.pending.splice(0)) p.r(); await settle(); };
const WAITS = [{ action: 'wait', minutes: 5 }, SEND];
const dueRun = (id, steps = WAITS, extra = {}) => JSON.stringify({ automations: [{ id, name: id, enabled: true, nextRun: clock - 5, trigger: EVERY, steps, ...extra }] });
const stoppedRow = (r) => lines(r.file('runs.jsonl')).map(l => JSON.parse(l)).find(x => x.status === 'stopped');
{
  const r = rig({ seed: dueRun('sw') });
  r.engine.tick(); await settle();
  row('a wait is in flight', '1', r.sleeps.pending.length);
  setSwitch(false);
  await slice(r);
  row('switched off during a wait, the next step is not sent', '0', r.did.length);
  row('...the wait ends with the slice it was in', '0', r.sleeps.pending.length);
  setSwitch(true);
  row('...and the log says why it stopped', 'yes', /switched off/.test(stoppedRow(r)?.text || '') ? 'yes' : `no: ${JSON.stringify(stoppedRow(r))}`);
  row('...and it is not reported as a failure', '0', (await r.list()).notices.length);
}
{
  const r = rig({ seed: dueRun('del') });
  r.engine.tick(); await settle();
  await r.call('POST', '/api/automations/delete', { id: 'del' });
  await slice(r);
  row('deleted during a wait, the next step is not sent', '0', r.did.length);
  row('...and it says so', 'yes', /deleted/.test(stoppedRow(r)?.text || '') ? 'yes' : 'no');
  row('...and the file does not get it back', '0', JSON.parse(fs.readFileSync(r.file('automations.json'), 'utf8')).automations.length);
}
{
  const r = rig({ seed: dueRun('edit') });
  r.engine.tick(); await settle();
  await r.save({ id: 'edit', name: 'edit', trigger: DAILY, steps: [{ ...SEND, prompt: 'the new words' }] });
  await slice(r);
  row('edited during a wait, the old steps do not go on', '0', r.did.length);
  row('...and it says so', 'yes', /changed/.test(stoppedRow(r)?.text || '') ? 'yes' : 'no');
  const a = (await r.list()).automations[0];
  row('...and the new revision is the one that stands', 'the new words', a.steps[0].prompt);
  row('...not marked as having failed by the old run', 'undefined', String(a.lastRun));
}
{
  const r = rig({ seed: dueRun('slices', [{ action: 'wait', minutes: 2 }, SEND]) });
  r.engine.tick(); await settle();
  let turns = 0, longest = 0;
  while (r.sleeps.pending.length && turns < 100) { longest = Math.max(longest, r.sleeps.pending[0].ms); await slice(r); turns++; }
  row('a wait left alone lasts what it was asked to', '120000', r.sleeps.total);
  row('...in slices short enough to answer', 'yes', longest <= 5000 ? 'yes' : `${longest} ms`);
  row('...and the step after it runs', '1', r.did.length);
}
{
  // A one-off switches itself off the moment it fires, and that must not end the run it fired.
  const once = { type: 'schedule', mode: 'once', date: nowDate(1), at: '09:00' };
  const r = rig({ seed: dueRun('oneoff', WAITS, { trigger: once }) });
  r.engine.tick(); await settle();
  row('a one-off is switched off as it fires', 'false', (await r.list()).automations[0].enabled);
  await slice(r); while (r.sleeps.pending.length) await slice(r);
  row('...and its run still reaches its last step', '1', r.did.length);
}

// ── the watcher: two things that happen together are two things, and nothing feeds itself ──
const TELL = { action: 'notify', text: '{session} finished' };
const FINISHED = (extra = {}) => ({ type: 'event', event: 'finished', project: '*', session: '*', cooldown: 1, ...extra });
const go = async (r, statuses) => { Object.assign(r.state.sessions, statuses); await r.engine.watch(); await settle(); };
const finish = async (r, k) => {
  clock += 61;
  await go(r, { [k]: 'working' });
  clock += 61;
  await go(r, { [k]: 'ready' });
};
{
  const r = rig({});
  await r.save({ name: 'tell me', trigger: FINISHED(), steps: [TELL] });
  await r.engine.watch();
  r.state.sessions['acme-api/w1'] = 'working'; r.state.sessions['acme-api/w2'] = 'working';
  clock += 6; await r.engine.watch();
  clock += 6; await go(r, { 'acme-api/w1': 'ready', 'acme-api/w2': 'ready' });
  const texts = (await r.list()).notices.map(n => n.text).sort().join();
  row('two sessions finishing in one look are two notices', 'w1 finished,w2 finished', texts);
}
{
  // The same session again, while the run it started is still waiting: refused, and not charged.
  const r = rig({});
  await r.save({ name: 'slow', trigger: FINISHED(), steps: [{ action: 'wait', minutes: 1 }, TELL] });
  await r.engine.watch();
  await finish(r, 'acme-api/w1');
  row('a run is waiting', '1', r.sleeps.pending.length);
  await finish(r, 'acme-api/w1');
  const skipped = lines(r.file('runs.jsonl')).map(l => JSON.parse(l)).filter(x => x.status === 'skipped');
  row('the same session finishing again is refused while it runs', '1', skipped.length);
  while (r.sleeps.pending.length) await slice(r);
  clock += 6;
  await go(r, { 'acme-api/w1': 'working' });
  clock += 6;
  await go(r, { 'acme-api/w1': 'ready' });
  row('...and the refusal did not use up its cooldown', 'yes', r.sleeps.pending.length === 1 ? 'yes' : `${r.sleeps.pending.length} waiting`);
}
{
  // The slow loop: each turn outlasts the cooldown, so it fires only a few times an hour, and the
  // hourly count never sees it.
  const r = rig({});
  await r.save({ name: 'keep going', trigger: FINISHED({ session: 'w1', cooldown: 10 }), steps: [{ action: 'send', project: '{project}', session: '{session}', prompt: 'next' }] });
  await r.engine.watch();
  const turn = async () => { clock += 6; await go(r, { 'acme-api/w1': 'working' }); clock += 720; await go(r, { 'acme-api/w1': 'ready' }); };
  await turn();
  row('a step on the session it watches runs', '1', r.did.length);
  for (let i = 0; i < 30; i++) await turn();
  row('...and a chain of them stops by itself', '10', r.did.length);
  const a = (await r.list()).automations[0];
  row('...switched off', 'false', a.enabled);
  row('...with a notice that says why', '1', (await r.list()).notices.filter(n => /in a row/.test(n.text)).length);
  row('...though it never reached the hourly count', 'yes', 10 * 726 > 3600 ? 'yes' : 'no');
}
{
  // Two automations feeding each other: each is innocent on its own.
  const r = rig({});
  await r.save({ name: 'a to b', trigger: FINISHED({ session: 'w1', cooldown: 1 }), steps: [{ action: 'send', project: 'acme-api', session: 'w2', prompt: 'go' }] });
  await r.save({ name: 'b to a', trigger: FINISHED({ session: 'w2', cooldown: 1 }), steps: [{ action: 'send', project: 'acme-api', session: 'w1', prompt: 'go' }] });
  await r.engine.watch();
  // Only a session a step just sent to takes a turn: nothing else is working in this fleet.
  let k = 'acme-api/w1', n = 0;
  for (let i = 0; i < 40; i++) {
    await finish(r, k);
    if (r.did.length === n) break;
    n = r.did.length;
    k = `acme-api/${r.did.at(-1).args.session}`;
  }
  row('two automations feeding each other stop too', 'yes', r.did.length <= 11 && r.did.length >= 5 ? 'yes' : `${r.did.length} sends`);
  row('...with one of them switched off', '1', (await r.list()).automations.filter(a => !a.enabled).length);
}
{
  // A spawned session finishing sets off the next spawn: a new name each time, one chain.
  const r = rig({});
  const appr = () => ({ purpose: 'automation nightly' });
  await r.save({ name: 'spawner', trigger: FINISHED({ cooldown: 1 }), steps: [{ action: 'spawn', project: 'acme-api', name: 'n{time}', prompt: 'go' }] }, appr);
  await r.engine.watch();
  r.state.sessions['acme-api/w1'] = 'ready';
  let target = 'acme-api/w1', n = 0;
  for (let i = 0; i < 40; i++) {
    await finish(r, target);
    const last = r.did.at(-1);
    if (r.did.length === n) break;
    n = r.did.length;
    target = `acme-api/${last.args.name}`;
    r.state.sessions[target] = 'ready';
    await r.engine.watch();
  }
  row('a spawn that sets off the next spawn stops too', 'yes', r.did.length <= 11 && r.did.length >= 5 ? 'yes' : `${r.did.length} spawns`);
}
{
  // A turn nobody's step started ends the chain, and a person working in a session is not a loop.
  const r = rig({});
  await r.save({ name: 'summary', trigger: FINISHED({ session: 'w1', cooldown: 1 }), steps: [{ action: 'send', project: '{project}', session: '{session}', prompt: 'summarise' }] });
  await r.engine.watch();
  const owner = async () => {
    await finish(r, 'acme-api/w1');                    // the owner's task ends: it fires
    clock += 6; await go(r, { 'acme-api/w1': 'working' });
    clock += 6; await go(r, { 'acme-api/w1': 'ready' }); // the summary ends inside the cooldown: nothing fires
  };
  for (let i = 0; i < 25; i++) await owner();
  row('a person working in a session is not a chain', 'true', (await r.list()).automations[0].enabled);
  row('...it answered every turn of theirs', '25', r.did.length);
}
{
  const r = rig({});
  await r.save({ name: 'too fast', trigger: FINISHED({ session: 'w1', cooldown: 1 }), steps: [TELL] });
  await r.engine.watch();
  for (let i = 0; i < 31; i++) { clock += 6; await go(r, { 'acme-api/w1': 'working' }); clock += 61; await go(r, { 'acme-api/w1': 'ready' }); }
  row('the hourly count is a limit with no step on a session', 'false', (await r.list()).automations[0].enabled);
}
{
  // Being switched off by a limit ends a run in flight on another session, as a person doing it does.
  const r = rig({});
  await r.save({ name: 'limited', trigger: FINISHED({ cooldown: 1 }), steps: [{ action: 'wait', minutes: 1 }, TELL] });
  await r.engine.watch();
  const fin = async (k) => { clock += 6; await go(r, { [k]: 'working' }); clock += 61; await go(r, { [k]: 'ready' }); };
  for (let i = 0; i < 29; i++) { await fin('acme-api/w1'); while (r.sleeps.pending.length) await slice(r); }
  const told = (await r.list()).notices.length;
  await fin('acme-api/w2');
  row('the thirtieth run is waiting', '1', r.sleeps.pending.length);
  await fin('acme-api/w1');
  row('...the thirty-first switches it off', 'false', (await r.list()).automations[0].enabled);
  while (r.sleeps.pending.length) await slice(r);
  row('...and the run still waiting stops there', '1', (await r.list()).notices.filter(n => /30 times/.test(n.text)).length + (await r.list()).notices.length - told - 1);
}
{
  // One read of every project's grid, shared.
  const r = rig({});
  await r.list(); await r.list(); await r.list();
  row('the screen polling three times reads the fleet once', '1', r.state.reads);
  clock += 6; await r.list();
  row('...and a few seconds later reads it again', '2', r.state.reads);
  await r.save({ name: 'checks', trigger: DAILY, steps: [{ action: 'check', project: 'acme-api', session: 'w1', status: ['ready'] }, { action: 'check', project: 'acme-api', session: 'w1', status: ['ready'] }] });
  const id = (await r.list()).automations[0].id;
  const before = r.state.reads;
  await r.call('POST', '/api/automations/run', { id });
  row('...but a "continue only if" reads the session as it is now', '2', r.state.reads - before);

  let calls = 0, release;
  const slow = rig({ fleet: () => { calls++; return new Promise((res) => { release = () => res([]); }); } });
  await slow.save({ name: 'slow grid', trigger: FINISHED(), steps: [TELL] });
  const first = slow.engine.watch();
  clock += 6;
  await slow.engine.watch();
  row('a watcher still reading is not started again', '1', calls);
  release(); await first;
}

// ── run now is a tap: it asks what the tap asks, and it answers ──────────────────────────
const STOP = { action: 'stop', project: 'acme-api', session: 'w1' };
const yes = () => ({ purpose: 'run it' });
{
  const r = rig({});
  const a = await r.save({ name: 'stopper', trigger: DAILY, steps: [STOP] }, () => ({ purpose: 'saved it' }));
  const none = await r.call('POST', '/api/automations/run', { id: a.id });
  row('run now on a stop, with no passkey, is refused', '428', none.status);
  row('...saying it needs one', 'passkey', none.json.needs);
  row('...and nothing ran', '0', r.did.length);
  const forged = await r.call('POST', '/api/automations/run', { id: a.id }, () => ({ error: 'that assertion is no good' }));
  row('...and with a bad one', '428', forged.status);
  row('...and nothing ran for that either', '0', r.did.length);
  row('...and neither was recorded as a run', '0', r.audits.filter(x => x.verb === 'automation_run').length);
  const good = await r.call('POST', '/api/automations/run', { id: a.id }, yes);
  row('with a fresh one it runs', '200', good.status);
  row('...once', '1', r.did.length);
  row('...on the tap\'s approval, not the save\'s', 'run it', r.did[0].meta.approved.purpose);
  const row0 = r.audits.find(x => x.verb === 'automation_run');
  row('...and the audit names who tapped', 'phone-1', row0?.client);
  row('...and what confirmed it', 'passkey:run it', row0?.confirmed);
}
{
  const r = rig({});
  const a = await r.save({ name: 'plain', trigger: DAILY, steps: [SEND] });
  let asked = 0;
  const res = await r.call('POST', '/api/automations/run', { id: a.id }, () => { asked++; return null; });
  row('a step with no passkey needs none to run now', '200', res.status);
  row('...and its challenge is not spent asking', '0', asked);
  row('...it is audited too', '1', r.audits.filter(x => x.verb === 'automation_run').length);
}
{
  const r = rig({});
  const a = await r.save({ name: 'slept on', enabled: false, trigger: DAILY, steps: [STOP] });
  row('one saved off carries no approval', 'null', String(a.approved));
  const res = await r.call('POST', '/api/automations/run', { id: a.id }, yes);
  row('...and run now with a fresh passkey still runs it', 'true', res.json.ok);
}
{
  // The request does not wait for a sixty-minute step.
  const r = rig({});
  const a = await r.save({ name: 'long', trigger: DAILY, steps: [{ action: 'wait', minutes: 60 }, SEND] });
  const pending = r.call('POST', '/api/automations/run', { id: a.id });
  await settle();
  // The first sleep to finish is run-now's own timer, armed as the run's wait began.
  for (const p of r.sleeps.pending.filter(x => x.ms === 4000)) p.r();
  r.sleeps.pending = r.sleeps.pending.filter(x => x.ms !== 4000);
  const res = await pending;
  row('run now on a long run answers that it is running', 'true', res.json.running);
  row('...and that is a success', 'true', res.json.ok);
  row('...the list says so', 'true', (await r.list()).automations[0].running);
  const again = await r.call('POST', '/api/automations/run', { id: a.id });
  row('...and a second tap is refused, saying why', '409', again.status);
  row('...in words', 'it is already running', again.json.text);
  while (r.sleeps.pending.length) await slice(r);
  row('...and the run finishes on its own', '1', r.did.length);
}
{
  // ok:false is not "running it now".
  const r = rig({ perform: async () => ({ ok: false, text: 'the session is not there' }) });
  const a = await r.save({ name: 'fails', trigger: DAILY, steps: [SEND] });
  const res = await r.call('POST', '/api/automations/run', { id: a.id });
  row('a run that fails at once says so', 'false', res.json.ok);
  row('...with the reason', 'the session is not there', res.json.text);
}

// ── an approval dies with the device that gave it ────────────────────────────────────────
{
  let live = true;
  const r = rig({ clientLive: () => live });
  const a = await r.save({ name: 'nightly stop', trigger: EVERY, steps: [STOP] }, () => ({ purpose: 'saved it' }));
  row('the approval names the device', 'phone-1', a.approved.by);
  const saved = JSON.parse(fs.readFileSync(r.file('automations.json'), 'utf8'));
  clock = saved.automations[0].nextRun + 1;
  r.engine.tick(); await settle();
  row('while that device is trusted it runs', '1', r.did.length);
  live = false;
  clock = (await r.list()).automations[0].nextRun + 1;
  r.engine.tick(); await settle();
  row('revoked, it does not run again', '1', r.did.length);
  row('...it is switched off', 'false', (await r.list()).automations[0].enabled);
  row('...and the phone is told what to do', '1', (await r.list()).notices.filter(n => /revoked/.test(n.text) && /Save it again/.test(n.text)).length);
  const byHand = await r.call('POST', '/api/automations/run', { id: a.id }, yes);
  row('...while a fresh passkey from a trusted device can still run it', 'true', byHand.json.ok);
}

// ── the draft: what leaves, and what comes back ──────────────────────────────────────────
const AGENT = path.join(TMP, 'agent');
const SAID = path.join(TMP, 'said');
const REPLY = path.join(TMP, 'reply');
fs.writeFileSync(AGENT, `#!/bin/sh\npwd -P > "${SAID}.cwd"\nprintf '%s\\n' "$@" > "${SAID}"\ncat "${REPLY}"\n`, { mode: 0o755 });
process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT = AGENT;
const reply = (v) => fs.writeFileSync(REPLY, typeof v === 'string' ? v : JSON.stringify({ structured_output: v }));
const said = () => { try { return fs.readFileSync(SAID, 'utf8'); } catch { return ''; } };
const ask = async (r, draft = null) => { fs.rmSync(SAID, { force: true }); return r.call('POST', '/api/automations/draft', { messages: [{ role: 'user', text: 'every weekday at nine, say good morning' }], draft }); };
reply({ reply: 'built it', automation: { name: 'good morning', trigger: DAILY, steps: [{ action: 'notify', text: 'morning' }] } });
{
  const r = rig({});
  Object.assign(r.state.sessions, { 'billing-svc/master': 'ready', 'billing-svc/w9': 'working' });
  const ok = await ask(r);
  row('a draft comes back', 'good morning', ok.json.automation?.name);
  row('...the model is told about a project that may be shared', 'yes', /acme-api: /.test(said()) ? 'yes' : 'no');
  row('...and not about one kept private', 'no', /billing-svc/.test(said()) ? 'yes' : 'no');
  row('...nor its sessions', 'no', /w9/.test(said()) ? 'yes' : 'no');
  row('...while the phone itself still lists it', 'yes', (await r.list()).fleet.some(p => p.name === 'billing-svc') ? 'yes' : 'no');
  row('...and it does not run where the daemon runs', fs.realpathSync(os.tmpdir()), fs.readFileSync(`${SAID}.cwd`, 'utf8').trim());
  const held = await ask(r, { name: 'x', trigger: DAILY, steps: [{ action: 'send', project: 'billing-svc', session: 'master', prompt: 'p' }] });
  row('a draft that names a private project is not sent', '', said());
  row('...and says why', '409', held.status);
  row('...in words that say what to do', 'yes', /billing-svc/.test(held.json.text) && /by hand/.test(held.json.text) ? 'yes' : held.json.text);
  const heldT = await ask(r, { name: 'x', trigger: { type: 'event', event: 'finished', project: 'billing-svc', session: '*' }, steps: [] });
  row('...nor one whose trigger watches it', '409', heldT.status);
  const fine = await ask(r, { name: 'x', trigger: DAILY, steps: [{ action: 'send', project: 'acme-api', session: 'w1', prompt: 'the draft so far' }] });
  row('a draft on a shared project goes', '200', fine.status);
  row('...with the draft in it', 'yes', /the draft so far/.test(said()) ? 'yes' : 'no');
  const ev = await ask(r, { name: 'x', trigger: { type: 'event', event: 'finished', project: '*', session: '*' }, steps: [{ action: 'notify', text: 'x' }] });
  row('any project and the event\'s project are not names', '200', ev.status);
}
{
  const r = rig({ fleet: async () => { throw new Error('no grid'); } });
  const ok = await ask(r);
  row('a fleet that cannot be read shares nothing', 'yes', /could not be read/.test(said()) ? 'yes' : said().slice(0, 80));
  const held = await ask(r, { name: 'x', trigger: DAILY, steps: [{ action: 'send', project: 'acme-api', session: 'w1', prompt: 'p' }] });
  row('...and a draft naming a project is not sent either', '409', held.status);
  row('(the first still answered)', '200', ok.status);
}
{
  const r = rig({ fleet: async () => [{ name: 'acme-api', sessions: [{ name: 'w1', status: 'ready' }] }] });
  await ask(r);
  row('a project with no answer about sharing is not shared', 'no', /acme-api: /.test(said()) ? 'yes' : 'no');
}
{
  const r = rig({});
  for (const [what, v] of [['null', 'null'], ['nothing', '']]) {
    fs.writeFileSync(REPLY, v);
    const res = await ask(r);
    row(`a model that answers ${what} is a 502, not a crash`, '502', res.status);
  }
  fs.writeFileSync(REPLY, JSON.stringify({ result: 'null' }));
  row('...and a result of null', '502', (await ask(r)).status);
  reply({ reply: 42, automation: null });
  row('a reply that is not a string is made one', '42', (await ask(r)).json.reply);
  reply({ reply: 'x'.repeat(50000), automation: null });
  row('...and a very long one is cut', '2000', (await ask(r)).json.reply.length);
  reply({ reply: 'here', automation: { name: 'evil', trigger: DAILY, steps: [{ action: '__proto__' }] } });
  const bad = await ask(r);
  row('a draft holding an action that is not one comes back as words', 'null', String(bad.json.automation));
  row('...saying so', 'yes', /problem/.test(bad.json.reply) ? 'yes' : bad.json.reply);
  reply({ reply: 'here', automation: { id: 'someone-else', name: 'stolen id', trigger: DAILY, steps: [] } });
  row('a draft cannot name an existing automation to overwrite', 'undefined', String((await ask(r)).json.automation?.id));
  reply({ reply: 'here', automation: { name: 'nothing saved', trigger: DAILY, steps: [{ action: 'notify', text: 'x' }] } });
  await ask(r);
  row('...and asking saves nothing', '0', (await r.list()).automations.length);
}
{
  // The child that will not go. It ignores SIGTERM and never closes its pipes.
  const stuck = path.join(TMP, 'stuck');
  const pidFile = path.join(TMP, 'stuck.pid');
  fs.writeFileSync(stuck, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 0.05; done\n`, { mode: 0o755 });
  process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT = stuck;
  const t0 = realNow();
  const r = await oneShot({ system: 's', prompt: 'p', schema: {}, timeoutMs: 300, killAfterMs: 100 });
  row('a child that ignores SIGTERM still gets an answer on time', 'false', r.ok);
  row('...saying so', 'the model did not answer in time', r.text);
  row('...promptly', 'yes', realNow() - t0 < 2000 ? 'yes' : `${realNow() - t0} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await new Promise(res => setTimeout(res, 400));
  let alive = 'gone';
  try { process.kill(pid, 0); alive = 'alive'; } catch {}
  row('...and it does not outlive the kill', 'gone', alive);

  const noisy = path.join(TMP, 'noisy');
  fs.writeFileSync(noisy, '#!/bin/sh\nwhile :; do printf "%01000d" 0; done\n', { mode: 0o755 });
  process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT = noisy;
  const big = await oneShot({ system: 's', prompt: 'p', schema: {}, timeoutMs: 8000, killAfterMs: 50, maxBytes: 200000 });
  row('a child that never stops talking is cut off', 'the model answered with far too much', big.text);
  process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT = path.join(TMP, 'no-such-agent');
  const absent = await oneShot({ system: 's', prompt: 'p', schema: {} });
  row('a binary that is not there is an answer too', 'yes', /could not start/.test(absent.text) ? 'yes' : absent.text);
  process.env.CLAUDE_FLEET_AUTOMATIONS_AGENT = AGENT;
  // ...and after all of that, the next draft is not told one is still being written.
  reply({ reply: 'still here', automation: null });
  const s = rig({});
  row('...and the next draft is not refused', '200', (await ask(s)).status);
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
