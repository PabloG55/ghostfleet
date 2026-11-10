// node scripts/test-resolve.mjs — what the assistant understands on its own, and what the
// dispatcher's answer is held to. One project name (scratch) is also an everyday word on purpose.
import assert from 'node:assert/strict';
import { command } from '../../../web/ui/resolve.js';
import { check } from '../server/router.mjs';

const projects = [
  { name: 'toolbox', sessions: [{ name: 'master', lead: true }, { name: 'kpi-report' }] },
  { name: 'acme-web', sessions: [{ name: 'master', lead: true }, { name: 'stripe-billing' }] },
  { name: 'scratch', sessions: [] },
];

// Only what moves the page is decided here; anything else is the dispatcher's.
const go = (said, ctx) => command(said, projects, ctx)?.go;
assert.equal(go('muéstrame el mapa'), '/map');
assert.equal(go('show me the map'), '/map');
assert.equal(go('go home'), '/');
assert.equal(go('open the session stripe bilging'), '/p/acme-web/s/stripe-billing');
assert.equal(go('vamos al inicio'), '/');
assert.equal(go('abre la actividad'), '/activity');
assert.equal(go('open activity'), '/activity');
assert.equal(go('abre la sesión stripe bilging'), '/p/acme-web/s/stripe-billing');
for (const said of ['vamos a scratch', 'en acme arregla los tests', 'empieza desde scratch', 'arregla los tests que fallan'])
  assert.equal(command(said, projects, null), null, said);

const T = { pending_id: '', project: '', session: '', title: 'x', text: 'x', listed: true, context: '', confidence: 0.95, question: '', options: [], why: 'x' };
const one = (t) => check({ action: 'tasks', tasks: [{ ...T, ...t }] }, projects).tasks[0];
assert.equal(one({ project: 'acme-web' }).project, 'acme-web');
assert.equal(one({ project: 'acme-web', session: 'stripe-billing' }).session, 'stripe-billing');
assert.equal(one({ project: 'acme-web', session: 'master' }).session, '');           // the lead
// Everything that cannot be confirmed stays as a task with no place, so it is asked and not sent.
for (const t of [{ project: 'no-existe' }, { project: 'acme-web', session: 'no-existe' }, { project: 'acme-web', confidence: 0.79 }, { project: '' }]) {
  const r = one(t);
  assert.equal(r.project, '', JSON.stringify(t));
  assert.ok(r.question);
  assert.equal(r.listed, true);
}
assert.deepEqual(one({ options: ['scratch', 'inventado'] }).options, ['scratch']);
assert.equal(one({ project: 'scratch', listed: false }).listed, false);
// Several things said at once are several tasks, each with its own place.
const two = check({ action: 'tasks', tasks: [{ ...T, project: 'scratch' }, { ...T, project: 'acme-web', confidence: 0.2 }] }, projects).tasks;
assert.deepEqual(two.map(t => t.project), ['scratch', '']);
assert.equal(one({ project: 'scratch', pending_id: 'abc' }).pending, '');                     // not an id it was given
assert.equal(check({ action: 'tasks', tasks: [{ ...T, project: 'scratch', pending_id: 'abc' }] }, projects, '', [{ id: 'abc' }]).tasks[0].pending, 'abc');
assert.equal(check({ action: 'go', project: 'no-existe' }, projects).action, 'ask');
console.log('all good');
