// Personal and company automations (docs/TEAM-ARCHITECTURE.md §5): who creates one, who sees
// it, whose permissions it runs with, and what happens when its owner loses a project. The real
// engine (server/automations.mjs) over a fake fleet and a fake disk: what is checked is who
// perform() is called as, and what each user gets back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../server/automations.mjs';
import { can } from '../server/access.mjs';
import { TEMPLATES, normalize } from '../shared/automations.js';
import { render } from '../shared/i18n/index.js';

const FLEET = [
  { name: 'acme-api', sessions: [{ name: 'master', lead: true, status: 'ready' }, { name: 'pagos', status: 'need-you' }] },
  { name: 'billing-svc', sessions: [{ name: 'master', lead: true, status: 'working' }] },
];

function setup({ automations = [], users } = {}) {
  const disk = { 'automations.json': { automations }, 'notices.json': { notices: [] } };
  const lines = { 'automation-runs.jsonl': [], 'activity.jsonl': [] };
  const people = users || [
    { id: 'ana', name: 'Ana', role: 'admin' },
    { id: 'beto', name: 'Beto', role: 'member', projects: { 'acme-api': 'member', 'billing-svc': 'member' } },
    { id: 'caro', name: 'Caro', role: 'member', projects: { 'billing-svc': 'member' } },
  ];
  const performed = [], sent = [];
  const engine = createEngine({
    fleet: { projects: async () => FLEET, ensureLead: async () => ({ ok: true }) },
    readJson: (n, d) => structuredClone(disk[n] ?? d),
    writeJson: (n, v) => { disk[n] = structuredClone(v); },
    appendLine: (n, row) => { (lines[n] ||= []).push(row); },
    readLines: (n, limit) => (lines[n] || []).slice(-limit).reverse(),
    perform: async (userId, tool, args) => { performed.push({ userId, tool, args }); return { ok: true, text: 'ok' }; },
    users: () => people,
    can,
    telegram: (text) => { sent.push(text); return { ok: true }; },
  });
  const u = (id) => people.find(x => x.id === id);
  return { engine, disk, lines, performed, sent, people, u };
}
const send = (project, prompt = 'revisa los pendientes') => ({ action: 'send', project, session: 'master', prompt });
const daily = { type: 'schedule', mode: 'days', at: '18:00', days: [1, 2, 3, 4, 5] };
const auto = (scope, steps, extra = {}) => ({ name: `${scope} ${steps[0]?.project || ''}`, scope, enabled: true, trigger: daily, steps, ...extra });

for (const field of ['runs', 'notices']) test(`wildcard company automation ${field} respect each event's project grant`, async t => {
  const people = [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'member', projects: { 'acme-web': 'member' } }];
  const disk = {}, lines = {}, clocks = [];
  const statuses = { 'acme-web': 'ready', 'billing-svc': 'ready' };
  t.mock.method(globalThis, 'setInterval', fn => { clocks.push(fn); return { unref() {} }; });
  const engine = createEngine({
    fleet: { projects: async () => Object.entries(statuses).map(([name, status]) => ({ name, sessions: [{ name: 'master', status }] })) },
    readJson: (n, d) => structuredClone(disk[n] ?? d), writeJson: (n, v) => { disk[n] = structuredClone(v); },
    appendLine: (n, row) => { (lines[n] ||= []).push(row); }, readLines: n => (lines[n] || []).slice().reverse(),
    perform: async () => ({ ok: true }), users: () => people, can,
  });
  engine.upsert(people[0], { name: 'Session started', scope: 'company', enabled: true,
    trigger: { type: 'event', event: 'started', project: '*', session: '*', cooldown: 1 },
    steps: [{ action: 'notify', text: '{proyecto}/{sesion} started' }] });
  engine.start(); await new Promise(setImmediate);
  for (const name of Object.keys(statuses)) { statuses[name] = 'working'; clocks[1](); await new Promise(setImmediate); }
  const member = (await engine.view(people[1]))[field];
  assert.equal(member.length, 1, `${field}: only acme-web`);
  assert.doesNotMatch(JSON.stringify(member), /billing-svc/);
  assert.match(JSON.stringify(member), /acme-web/);
  assert.equal((await engine.view(people[0]))[field].length, 2);
});

test('existing ones become company automations, created by the first admin, exactly once', () => {
  const legacy = [{ id: 'a1', name: 'vieja', owner: 'beto', visibility: 'personal', enabled: true, trigger: daily, steps: [send('acme-api')] },
                  { id: 'a2', name: 'de equipo', owner: 'caro', visibility: 'team', enabled: true, trigger: daily, steps: [send('billing-svc')] }];
  const { disk, people } = setup({ automations: legacy });
  const saved = disk['automations.json'].automations;
  for (const a of saved) {
    assert.equal(a.scope, 'company');
    assert.equal(a.createdBy, 'ana');
    assert.equal('owner' in a, false);
    assert.equal('visibility' in a, false);
  }
  // A second boot over what the first wrote changes nothing.
  const again = setup({ automations: saved, users: people });
  assert.deepEqual(again.disk['automations.json'].automations, saved);
});

test('a member creates a personal one; a company one is refused', async () => {
  const { engine, u } = setup();
  const a = engine.upsert(u('beto'), auto('personal', [send('acme-api')]));
  assert.equal(a.scope, 'personal');
  assert.equal(a.createdBy, 'beto');
  assert.throws(() => engine.upsert(u('beto'), auto('company', [send('acme-api')])), e => e.status === 403);
  assert.equal((await engine.view(u('beto'))).me.admin, false);
});

test('an admin creates a company one, and it runs with THEIR permissions', async () => {
  const { engine, performed, u } = setup();
  const a = engine.upsert(u('ana'), auto('company', [send('acme-api')]));
  assert.equal(a.scope, 'company');
  assert.equal(a.savedBy, 'ana');
  const r = await engine.runNow(u('ana'), a.id);
  assert.equal(r.ok, true);
  assert.deepEqual(performed.map(p => p.userId), ['ana']);
});

test('a member does not see someone else\'s personal one; the admin does; a company one is seen by whoever has its project', async () => {
  const { engine, u } = setup();
  const mine = engine.upsert(u('beto'), auto('personal', [send('billing-svc')]));
  const company = engine.upsert(u('ana'), auto('company', [send('acme-api')]));
  const ids = async (who) => (await engine.view(u(who))).automations.map(a => a.id).sort();
  assert.deepEqual(await ids('caro'), [], 'caro: neither beto\'s personal one nor the acme-api one, which is not theirs');
  assert.deepEqual(await ids('beto'), [mine.id, company.id].sort());
  assert.deepEqual(await ids('ana'), [mine.id, company.id].sort());
  assert.deepEqual((await engine.view(u('caro'))).me.projects, ['billing-svc'], 'caro\'s editor offers only their own projects');
  assert.throws(() => engine.remove(u('caro'), mine.id), e => e.status === 404);
  assert.throws(() => engine.upsert(u('caro'), { ...mine, name: 'mía ahora' }), e => e.status === 404);
  // beto sees the company one but cannot edit it.
  assert.throws(() => engine.upsert(u('beto'), { ...company, name: 'otra' }), e => e.status === 403);
});

test('a personal one cannot name a project its owner cannot see (404, as if it did not exist)', () => {
  const { engine, u } = setup();
  assert.throws(() => engine.upsert(u('caro'), auto('personal', [send('acme-api')])), e => e.status === 404 && /project 'acme-api' does not exist/.test(e.message));
});

test('running a personal one on a project without access is refused and pauses it with a notice', async () => {
  const { engine, performed, people, u } = setup();
  const a = engine.upsert(u('beto'), auto('personal', [send('acme-api')]));
  delete people.find(x => x.id === 'beto').projects['acme-api'];        // loses the project
  const r = await engine.runNow(u('beto'), a.id);
  assert.equal(r.ok, false);
  assert.match(r.text, /refused: .*acme-api/);
  assert.equal(performed.length, 0, 'it never reached perform()');
  // They still see it, switched off and with the reason: it is theirs, and they need to know what happened.
  const v = await engine.view(u('beto'));
  const after = v.automations.find(x => x.id === a.id);
  assert.equal(after.enabled, false);
  assert.match(after.paused.why, /acme-api/);
  assert.ok(v.notices.some(n => /I paused/.test(n.text)));
  // And it cannot be switched back on until they get the project back.
  assert.throws(() => engine.upsert(u('beto'), { ...after, enabled: true }), e => e.status === 404);
});

test('even when switched off, a step into a project without access is refused at the step', async () => {
  const { engine, performed, people, u } = setup();
  const a = engine.upsert(u('beto'), auto('personal', [send('billing-svc')], { enabled: false }));
  people.find(x => x.id === 'beto').projects['billing-svc'] = 'viewer';   // can no longer send prompts
  const r = await engine.runNow(u('beto'), a.id);
  assert.equal(r.ok, false);
  assert.match(r.steps[0].text, /refused/);
  assert.equal(performed.length, 0);
});

test('a company one pauses if whoever saved it stops being an admin', async () => {
  const { engine, performed, people, u } = setup();
  const a = engine.upsert(u('ana'), auto('company', [send('acme-api')]));
  people.find(x => x.id === 'ana').role = 'member';
  people.find(x => x.id === 'ana').projects = { 'acme-api': 'member' };
  engine.reconcile();                    // what the clock does on every tick
  const stored = engine.get(a.id);
  assert.equal(stored.enabled, false);
  assert.match(render(stored.paused.why), /no longer an admin/);
  assert.equal(performed.length, 0);
  assert.throws(() => engine.upsert(u('ana'), { ...stored, enabled: true }), e => e.status === 403);
});

test('the admin can switch off someone else\'s personal one, but not change it', () => {
  const { engine, u } = setup();
  const a = engine.upsert(u('beto'), auto('personal', [send('acme-api')]));
  const off = engine.upsert(u('ana'), { ...a, enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.savedBy, 'beto');
  assert.throws(() => engine.upsert(u('ana'), { ...a, prompt: undefined, steps: [send('acme-api', 'otra cosa')] }), e => e.status === 403);
});

test('«Resumen de mi día» (my day summary): only their projects, a notice for them, Telegram only for the machine\'s owner', async () => {
  const { engine, lines, sent, u } = setup();
  const t = Math.floor(Date.now() / 1000);
  lines['activity.jsonl'].push({ ts: t, user: 'beto', verb: 'fleet_send', project: 'billing-svc', result: 'ran' },
                               { ts: t, user: 'ana', verb: 'fleet_spawn', project: 'acme-api', result: 'ran' });
  const tpl = TEMPLATES['resumen-dia'];
  assert.equal(tpl.scope, 'personal');
  const draft = normalize(tpl.build());
  const mine = engine.upsert(u('caro'), draft);
  const r = await engine.runNow(u('caro'), mine.id);
  assert.equal(r.ok, true);
  const caroNotices = (await engine.view(u('caro'))).notices;
  assert.equal(caroNotices.length, 1);
  assert.match(caroNotices[0].text, /billing-svc: 1 prompts/);
  assert.doesNotMatch(caroNotices[0].text, /acme-api/);
  assert.equal((await engine.view(u('beto'))).notices.length, 0, 'caro\'s summary does not reach beto');
  assert.equal((await engine.view(u('ana'))).notices.length, 0, 'nor the admin: it is for caro, even though the admin can see the automation');
  assert.equal(sent.length, 0, 'caro does not own the machine\'s Telegram');

  const anas = engine.upsert(u('ana'), normalize(tpl.build()));
  await engine.runNow(u('ana'), anas.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /acme-api: 1 new sessions/);
  assert.match(sent[0], /need you: pagos/);
});

test('«Actualizar datos de una página» (update a page\'s data) is a company one and writes to the master', async () => {
  const { engine, performed, u } = setup();
  const tpl = TEMPLATES['actualizar-pagina'];
  assert.equal(tpl.scope, 'company');
  const d = tpl.build();
  assert.deepEqual(d.trigger.days, [1]);
  assert.throws(() => normalize(d), /project is missing/, 'the project is chosen by whoever saves it');
  const a = engine.upsert(u('ana'), { ...d, steps: [{ ...d.steps[0], project: 'acme-api' }] });
  await engine.runNow(u('ana'), a.id);
  assert.equal(performed[0].tool, 'fleet_send');
  assert.equal(performed[0].args.session, 'master');
  assert.throws(() => engine.upsert(u('beto'), { ...d, steps: [{ ...d.steps[0], project: 'acme-api' }] }), e => e.status === 403);
});
