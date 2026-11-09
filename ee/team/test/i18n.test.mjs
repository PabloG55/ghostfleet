// The two catalogs say the same things: a key in one and not the other is a screen that falls
// back to English mid-sentence, or shows the bare key. And every key the code asks for exists,
// and the server answers in the language the request asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS, LANGS, translate, pickLang, msg, render } from '../shared/i18n/index.js';
import { inRequest, asUser } from '../server/i18n.mjs';
import { t } from '../shared/i18n/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every key is in both catalogs', () => {
  for (const a of LANGS) for (const b of LANGS) {
    if (a === b) continue;
    const missing = Object.keys(CATALOGS[a]).filter(k => !(k in CATALOGS[b]));
    assert.deepEqual(missing, [], `in ${a} but not in ${b}`);
  }
});

test('placeholders match between languages', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const off = Object.keys(CATALOGS.en).filter(k => k in CATALOGS.es && vars(CATALOGS.en[k]) !== vars(CATALOGS.es[k]));
  assert.deepEqual(off, []);
});

test('every literal key the code asks for exists', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = ['web/src', 'shared', 'server'].flatMap(d => walk(path.join(root, d)))
    .filter(f => /\.(m?js|jsx)$/.test(f) && !f.includes(`${path.sep}i18n${path.sep}`));
  const missing = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(?:t|tr|msg)\(\s*'([\w.-]+)'/g)) {
      if (!(m[1] in CATALOGS.en)) missing.push(`${path.relative(root, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('browser language picks the default', () => {
  assert.equal(pickLang('es-MX'), 'es');
  assert.equal(pickLang('es'), 'es');
  assert.equal(pickLang('en-US'), 'en');
  assert.equal(pickLang('fr'), 'en');
  assert.equal(pickLang(''), 'en');
});

test('plurals, placeholders and deferred messages', () => {
  assert.equal(translate('en', 'ucap.turns', { n: 1 }), '1 turn');
  assert.equal(translate('en', 'ucap.turns', { n: 3 }), '3 turns');
  assert.equal(translate('es', 'ucap.turns', { n: 3 }), '3 turnos');
  const m = msg('err.noProject');
  assert.notEqual(render(m, 'en'), render(m, 'es'));
});

test('the server speaks the header first, then the person, then Accept-Language', () => {
  const req = (h) => ({ headers: h });
  const say = (h, u) => inRequest(req(h), () => { if (u) asUser(u); return t('err.noProject'); });
  const en = CATALOGS.en['err.noProject'], es = CATALOGS.es['err.noProject'];
  assert.equal(say({ 'x-gfw-lang': 'es' }, { lang: 'en' }), es);
  assert.equal(say({ 'x-gfw-lang': 'en' }, { lang: 'es' }), en);
  assert.equal(say({}, { lang: 'es' }), es);
  assert.equal(say({ 'accept-language': 'es-AR,es;q=0.9' }), es);
  assert.equal(say({}), en);
});
