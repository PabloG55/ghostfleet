import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREEN_PLACES, screenPlace } from '../../../web/ui/phone-places.js';
import { setLangSource, t } from '../../../web/ui/i18n.js';
import en from '../../../web/ui/words/en.js';
import es from '../../../web/ui/words/es.js';

test('every shared extra route has a translated place, including nested routes and queries', t => {
  t.after(() => setLangSource(() => 'en'));
  const routes = {
    '/automations': ['Automations', 'Automatizaciones'],
    '/reviews': ['Reviews', 'Revisiones'],
    '/stack-picker': ['Stacks', 'Grupos de sesiones'],
    '/stack': ['Stacks', 'Grupos de sesiones'],
    '/queue': ['Queue', 'Cola'],
    '/held': ['Held items', 'Pendientes retenidos'],
    '/search': ['Search', 'Buscar'],
    '/sign-ins': ['Pending sign-ins', 'Inicios de sesión pendientes'],
  };
  for (const [i, language] of ['en', 'es'].entries()) {
    setLangSource(() => language);
    assert.deepEqual(Object.keys(SCREEN_PLACES).sort(), Object.keys(routes).sort());
    for (const [route, words] of Object.entries(routes)) {
      assert.equal(SCREEN_PLACES[route], words[i]);
      assert.equal(screenPlace(`#${route}/detail?query=1`), words[i]);
    }
    assert.equal(screenPlace('/reviews-old'), null);
    assert.equal(screenPlace('/constructor'), null);
  }
});

test('every added count string handles zero, one and two in both languages', context => {
  context.after(() => setLangSource(() => 'en'));
  const cases = {
    'phone.steps': [['0 steps', '1 step', '2 steps'], ['0 pasos', '1 paso', '2 pasos']],
    'phone.earlier': [['0 earlier runs', '1 earlier run', '2 earlier runs'], ['0 ejecuciones anteriores', '1 ejecución anterior', '2 ejecuciones anteriores']],
    'phone.requests': [['Requests · 0', 'Request · 1', 'Requests · 2'], ['Solicitudes · 0', 'Solicitud · 1', 'Solicitudes · 2']],
    'phone.openStack': [['Open stack · 0', 'Open stack · 1', 'Open stack · 2'], ['Abrir grupo · 0', 'Abrir grupo · 1', 'Abrir grupo · 2']],
    'phone.stackCount': [['0 sessions · 0 selected', '1 session · 1 selected', '2 sessions · 2 selected'], ['0 sesiones · selección: 0', '1 sesión · selección: 1', '2 sesiones · selección: 2']],
    'phone.auto.every.days': [['0 days', '1 day', '2 days'], ['0 días', '1 día', '2 días']],
    'phone.auto.err.maxSteps': [['0 steps at most', '1 step at most', '2 steps at most'], ['como mucho 0 pasos', 'como mucho 1 paso', 'como mucho 2 pasos']],
  };
  const countKeys = Object.keys(en).filter(key => key.startsWith('phone.') && !key.endsWith('.one') && en[key].includes('{n}'));
  assert.deepEqual(countKeys.sort(), [...Object.keys(cases), 'phone.auto.notice.loop'].sort(), 'review every newly added count string');
  for (const [i, language] of ['en', 'es'].entries()) {
    setLangSource(() => language);
    for (const [key, expected] of Object.entries(cases)) for (const n of [0, 1, 2]) assert.equal(t(key, { n, selected: n }), expected[i][n]);
    for (const n of [0, 1, 2]) {
      const message = t('phone.auto.notice.loop', { n, name: 'Daily check' });
      assert.ok(message.includes(language === 'en' ? `${n} ${n === 1 ? 'time' : 'times'} in an hour` : `${n} ${n === 1 ? 'vez' : 'veces'} en una hora`));
    }
  }
  assert.deepEqual(Object.keys(en).filter(k => k.startsWith('phone.')).sort(), Object.keys(es).filter(k => k.startsWith('phone.')).sort());
});
