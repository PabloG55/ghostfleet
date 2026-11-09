// Usage ledger: one row per turn, to the right person, never twice — and the cap that stops them.
// Transcripts here are built the way Claude Code writes them: one assistant line per content
// block, each repeating the whole message's usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTurns, attribute, createLedger, capTokens, parseCap, dollars } from '../server/usage-ledger.mjs';

const T0 = Math.floor(new Date(2026, 10, 4, 10, 0, 0) / 1000);   // a Wednesday, 10:00 local
const iso = (s) => new Date(s * 1000).toISOString();
const prompt = (uuid, ts, text) => ({ type: 'user', uuid, timestamp: iso(ts), message: { role: 'user', content: text } });
const toolResult = (ts) => ({ type: 'user', uuid: `tr${ts}`, timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
// One API call that Claude Code split into `blocks` lines, all carrying the same usage.
const call = (id, ts, u, blocks = 3, model = 'claude-opus-5-5') =>
  Array.from({ length: blocks }, (_, k) => ({ type: 'assistant', uuid: `${id}-${k}`, timestamp: iso(ts), requestId: `req_${id}`,
                                              message: { id, model, role: 'assistant', usage: u } }));
const jsonl = (lines) => lines.flat().map(l => JSON.stringify(l)).join('\n') + '\n';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gfw-usage-')); }
function ledgerFor(dir, transcript, { activity = [], owners = {}, users = [], now = T0 + 3600 } = {}) {
  let clock = now;
  const l = createLedger({ dir, users: () => users, activity: () => activity, owners: () => owners,
                           sources: () => [{ project: 'acme-api', session: 'billing-svc', transcript }], now: () => clock });
  l.tick = (s) => { clock += s; };
  return l;
}
const quietFile = (f, ts) => fs.utimesSync(f, ts, ts);
const readLedger = (dir) => fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('a call written as several lines counts once, and a turn sums its calls', () => {
  const text = jsonl([prompt('p1', T0, 'arregla el webhook'), call('m1', T0 + 5, usage(2, 100, 5000, 300)), toolResult(T0 + 6),
                      call('m2', T0 + 9, usage(3, 50, 6000, 10), 2), prompt('p2', T0 + 60, 'sigue')]);
  const { turns } = readTurns(text);
  assert.equal(turns.length, 1, 'the second turn is still open');
  assert.deepEqual({ ...turns[0], prompt: undefined }, { id: 'p1', ts: T0, prompt: undefined, model: 'claude-opus-5-5', input: 5, output: 150, cacheRead: 11000, cacheWrite: 310 });
});

test('a tool result is not a new turn', () => {
  const text = jsonl([prompt('p1', T0, 'a'), call('m1', T0 + 1, usage(1, 1, 1, 1)), toolResult(T0 + 2), call('m2', T0 + 3, usage(1, 1, 1, 1))]);
  const { turns } = readTurns(text, { quiet: true });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].output, 2);
});

test('the turn still running is not written, and is written exactly once when it closes', () => {
  const dir = tmp(), f = path.join(dir, 'aaaa.jsonl');
  fs.writeFileSync(f, jsonl([prompt('p1', T0, 'uno'), call('m1', T0 + 1, usage(1, 10, 0, 0))]));
  const l = ledgerFor(dir, f, { now: T0 + 30 });
  quietFile(f, T0 + 20);
  assert.equal(l.scan(), 0, 'open turn, file not quiet');
  fs.appendFileSync(f, jsonl([call('m2', T0 + 25, usage(1, 20, 0, 0)), prompt('p2', T0 + 40, 'dos'), call('m3', T0 + 41, usage(1, 5, 0, 0))]));
  quietFile(f, T0 + 41);
  assert.equal(l.scan(), 1, 'the first turn closed when the second prompt arrived');
  assert.equal(l.scan(), 0, 'scanning again adds nothing');
  l.tick(3600);                                           // the file goes quiet: the last turn is over
  assert.equal(l.scan(), 1);
  assert.equal(l.scan(), 0);
  assert.deepEqual(readLedger(dir).map(r => r.output), [30, 5]);
});

test('losing the cursor (a crash after the append) does not count anything twice', () => {
  const dir = tmp(), f = path.join(dir, 'bbbb.jsonl');
  fs.writeFileSync(f, jsonl([prompt('p1', T0, 'uno'), call('m1', T0 + 1, usage(1, 10, 0, 0)), prompt('p2', T0 + 9, 'dos'), call('m2', T0 + 10, usage(1, 7, 0, 0))]));
  quietFile(f, T0 + 10);
  assert.equal(ledgerFor(dir, f).scan(), 2);
  fs.unlinkSync(path.join(dir, 'usage-cursor.json'));
  assert.equal(ledgerFor(dir, f).scan(), 0, 'a fresh ledger rereads from 0 and recognises every turn');
  fs.writeFileSync(f, jsonl([prompt('p1', T0, 'uno'), call('m1', T0 + 1, usage(1, 10, 0, 0))]));   // truncated
  assert.equal(ledgerFor(dir, f).scan(), 0);
  assert.equal(readLedger(dir).length, 2);
});

test('a turn that goes on after it looked finished is counted, once, for the same prompt', () => {
  const dir = tmp(), f = path.join(dir, 'cccc.jsonl');
  fs.writeFileSync(f, jsonl([prompt('p1', T0, 'corre la suite'), call('m1', T0 + 1, usage(1, 10, 0, 0))]));
  quietFile(f, T0 + 1);
  const l = ledgerFor(dir, f, { activity: [{ ts: T0 - 1, user: 'beto', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: 'corre la suite' } }] });
  assert.equal(l.scan(), 1);
  fs.appendFileSync(f, jsonl([call('m2', T0 + 900, usage(1, 40, 0, 0))]));        // the suite took 15 minutes
  quietFile(f, T0 + 900);
  l.tick(3600);
  assert.equal(l.scan(), 1);
  assert.equal(l.scan(), 0);
  const rows = readLedger(dir);
  assert.deepEqual(rows.map(r => [r.user, r.output]), [['beto', 10], ['beto', 40]]);
  assert.notEqual(rows[0].id, rows[1].id);
});

test('the turn goes to whoever sent its prompt, the latest send of that text, else the owner', () => {
  const act = [
    { ts: T0 - 86400, user: 'ana', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: 'continúa' } },
    { ts: T0 - 10, user: 'beto', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: 'continúa' } },
    { ts: T0 + 500, user: 'carla', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: 'continúa' } },
    { ts: T0 - 5, user: 'carla', verb: 'fleet_send', project: 'acme-web', subject: 'billing-svc', result: 'ran', args: { prompt: 'revisa los tests' } },
    { ts: T0 - 5, user: 'diego', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'refused', args: { prompt: 'revisa los tests' } },
    { ts: T0 - 3, user: 'ana', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', via: 'resumen diario', args: { prompt: 'resume lo de hoy' } },
  ];
  const ctx = { project: 'acme-api', session: 'billing-svc', activity: act, owners: { 'acme-api/billing-svc': 'diego' } };
  assert.equal(attribute({ ts: T0, prompt: 'continúa' }, ctx).user, 'beto', 'not the old send, not the one after the turn');
  assert.equal(attribute({ ts: T0, prompt: 'revisa los tests' }, ctx).user, 'diego',
               'another project\'s send and a refused send do not count; the session owner gets it');
  assert.deepEqual(attribute({ ts: T0, prompt: 'resume lo de hoy' }, ctx), { user: 'ana', via: 'resumen diario' }, 'an automation goes to its owner');
  assert.equal(attribute({ ts: T0, prompt: 'typed in the terminal' }, { ...ctx, owners: {} }).user, null);
  // A long prompt is logged cut at 500 characters; the head still matches.
  const long = 'x'.repeat(900);
  assert.equal(attribute({ ts: T0, prompt: long }, { ...ctx, activity: [{ ts: T0, user: 'ana', verb: 'fleet_spawn', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: long.slice(0, 500) } }] }).user, 'ana');
});

test('the cap stops prompts and spawns of that user only, and reading goes on', () => {
  const dir = tmp(), f = path.join(dir, 'dddd.jsonl');
  fs.writeFileSync(f, jsonl([prompt('p1', T0, 'trabajo pesado'), call('m1', T0 + 1, usage(1000, 200000, 9e6, 800000))]));
  quietFile(f, T0 + 1);
  const users = [{ id: 'ana', tokenCap: null }, { id: 'beto', tokenCap: { daily: 1_000_000, monthly: 40_000_000 } },
                 { id: 'carla', tokenCap: { daily: 5_000_000, monthly: 40_000_000 } }];
  const act = [{ ts: T0 - 1, user: 'beto', verb: 'fleet_send', project: 'acme-api', subject: 'billing-svc', result: 'ran', args: { prompt: 'trabajo pesado' } }];
  const refused = [];
  const l = createLedger({ dir, users: () => users, activity: () => act, sources: () => [{ project: 'acme-api', session: 'billing-svc', transcript: f }],
                           onRefuse: (r) => refused.push(r), now: () => T0 + 3600 });
  l.scan();
  assert.equal(l.spent('beto').day, 1_001_000, 'cache reads are not counted toward the cap');
  for (const tool of ['fleet_send', 'fleet_spawn', 'fleet_resume', 'gfw_schedule'])
    assert.throws(() => l.gate('beto', tool, { project: 'acme-api' }), (e) => e.status === 429 && /daily token cap/.test(e.message), tool);
  for (const tool of ['fleet_interrupt', 'fleet_stop', 'fleet_answer', 'gfw_label']) assert.doesNotThrow(() => l.gate('beto', tool), tool);
  assert.doesNotThrow(() => l.gate('carla', 'fleet_send'), 'under her cap');
  assert.doesNotThrow(() => l.gate('ana', 'fleet_send'), 'no cap');
  assert.equal(refused.length, 4);
  assert.equal(refused[0].user, 'beto');
  // The next day the daily cap is fresh, but a monthly cap counts the whole month.
  users[1].tokenCap = { daily: 1_000_000, monthly: 1_000_000 };
  const tomorrow = createLedger({ dir, users: () => users, now: () => T0 + 86400 });
  assert.throws(() => tomorrow.gate('beto', 'fleet_send'), /monthly token cap/);
  users[1].tokenCap = { daily: 1_000_000, monthly: null };
  assert.doesNotThrow(() => tomorrow.gate('beto', 'fleet_send'));
});

test('the report: periods, projects, dollars only when asked', () => {
  const dir = tmp();
  const rows = [
    { ts: T0, user: 'ana', project: 'acme-api', session: 's', model: 'claude-opus-5-5', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },
    { ts: T0 - 2 * 86400, user: 'ana', project: 'acme-web', session: 's', model: 'claude-sonnet-5-5', input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 },
    { ts: T0 - 40 * 86400, user: 'ana', project: 'acme-web', session: 's', model: 'claude-opus-5-5', input: 5e6, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const l = createLedger({ dir, users: () => [{ id: 'ana', name: 'Ana' }], extraRows: () => rows, now: () => T0 + 60 });
  const r = l.report({ withDollars: true }).users[0];
  assert.equal(r.today.tokens, 1e6);
  assert.equal(r.week.tokens, 2e6, 'Monday to now');
  assert.equal(r.month.tokens, 2e6, 'last month is not this month');
  assert.deepEqual(r.projects.map(p => p.project), ['acme-api', 'acme-web']);
  assert.equal(r.today.usd, 4);
  assert.equal(Math.round(r.week.usd * 100), 1400);
  assert.equal(l.report().users[0].today.usd, undefined);
  assert.equal(dollars({ model: 'claude-opus-5-5-20990101', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), 4, 'a dated id prices as its model');
  assert.equal(capTokens({ input: 1, output: 2, cacheRead: 100, cacheWrite: 3 }), 6);
});

test('a cap as typed in the panel', () => {
  assert.equal(parseCap({ daily: '', monthly: '' }), null);
  assert.deepEqual(parseCap({ daily: '2000000', monthly: '' }), { daily: 2000000, monthly: null });
  assert.throws(() => parseCap({ daily: '-3' }), (e) => e.status === 400);
  assert.throws(() => parseCap({ daily: 'mucho' }), (e) => e.status === 400);
});
