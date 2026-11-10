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
import teamEn from '../shared/i18n/en.js';
import teamEs from '../shared/i18n/es.js';
import coreEn from '../../../web/ui/words/en.js';
import coreEs from '../../../web/ui/words/es.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The shared screens (the MIT core's web/ui), whose words are in web/ui/words.
const coreDir = path.join(root, '../../web/ui');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const code = (f) => /\.(m?js|jsx)$/.test(f) && !f.includes(`${path.sep}i18n${path.sep}`) && !f.includes(`${path.sep}words${path.sep}`);
const literalKeys = (f) => [...fs.readFileSync(f, 'utf8').matchAll(/\b(?:t|tr|msg)\(\s*'([\w.-]+)'/g)].map(m => m[1]);

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
  const files = [...['web/src', 'shared', 'server'].map(d => path.join(root, d)), coreDir].flatMap(walk).filter(code);
  assert.ok(files.some(f => f.startsWith(coreDir)), 'read none of web/ui');
  const missing = [];
  for (const f of files) for (const k of literalKeys(f)) if (!(k in CATALOGS.en)) missing.push(`${path.relative(root, f)}: ${k}`);
  assert.deepEqual(missing, []);
});

// The shared screens are the MIT core's, and the phone client will draw them with no team
// catalog loaded: a word they print that lives only in this app's catalog is a bare key there.
test('the shared screens find every word in their own catalog', () => {
  const files = walk(coreDir).filter(code);
  assert.ok(files.length >= 10, `read ${files.length} files in web/ui`);
  const missing = [];
  for (const f of files) for (const k of literalKeys(f)) if (!(k in coreEn)) missing.push(`${path.relative(coreDir, f)}: ${k}`);
  assert.deepEqual(missing, [], 'a word web/ui prints is not in web/ui/words/en.js');
  for (const [a, b, name] of [[coreEn, coreEs, 'web/ui/words'], [teamEn, teamEs, 'shared/i18n']]) {
    assert.deepEqual(Object.keys(a).filter(k => !(k in b)), [], `${name}: in en.js but not in es.js`);
    assert.deepEqual(Object.keys(b).filter(k => !(k in a)), [], `${name}: in es.js but not in en.js`);
  }
});

// The team catalogs are merged over the core's, so a key in both would show whichever was
// added last, and the two copies would drift with nobody seeing which one was on screen.
test('a key lives in one catalog, never in both', () => {
  for (const [core, team, l] of [[coreEn, teamEn, 'en'], [coreEs, teamEs, 'es']]) {
    const both = Object.keys(core).filter(k => k in team);
    assert.deepEqual(both, [], `${l}: in web/ui/words and in shared/i18n`);
  }
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
