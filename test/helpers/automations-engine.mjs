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

const { createAutomations } = await import(`${LIB}/automations.mjs`);
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

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
