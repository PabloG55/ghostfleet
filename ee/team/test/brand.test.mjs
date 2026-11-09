// The brand keeps three copies of one thing: the grid's ship, the generated SVGs and the
// manual (which cannot load anything beside it, because it is published as a single page).
// These tests fail when one copy drifts from the others, which is how a logo rots without
// anyone noticing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shipRows, pixels, shipPath, variants, injectTokens } from '../brand/make-logo.mjs';

const BRAND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'brand');
const read = (f) => fs.readFileSync(path.join(BRAND, f), 'utf8');
const manual = read('manual.html');

// the rows the manual draws with its own JS
const manualShip = () => {
  const m = /const SHIP = \[\n([\s\S]*?)\n\];/.exec(manual);
  assert.ok(m, 'manual.html has no const SHIP');
  return m[1].split('\n').map(l => /'([^']*)'/.exec(l)[1]);
};

test('the manual\'s ship is the grid\'s, row by row', () => {
  assert.deepEqual(manualShip(), shipRows());
});

test('the manual carries tokens.css verbatim (make-logo.mjs injects it)', () => {
  assert.equal(injectTokens(manual, read('tokens.css')), manual,
    'manual.html and tokens.css drifted apart: run node ee/team/brand/make-logo.mjs');
});

test('the committed SVGs are the ones the current sprite generates', () => {
  const want = variants(shipRows());
  const have = fs.readdirSync(path.join(BRAND, 'logo')).filter(f => f.endsWith('.svg')).sort();
  assert.deepEqual(have, Object.keys(want).sort());
  for (const [f, body] of Object.entries(want)) assert.equal(read(`logo/${f}`), body, `logo/${f} is out of date`);
});

test('the ship\'s path paints exactly the sprite\'s pixels', () => {
  const px = pixels(shipRows());
  const cells = new Set();
  for (const [, x, y, w] of shipPath(px).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g))
    for (let i = 0; i < +w; i++) cells.add(`${+x + i},${y}`);
  assert.deepEqual([...cells].sort(), px.map(([x, y]) => `${x},${y}`).sort());
});

test('every variant is an SVG with a viewBox and a title', () => {
  for (const [f, body] of Object.entries(variants(shipRows()))) {
    assert.match(body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+"/, f);
    assert.match(body, /<title>ghostfleet( team)?<\/title>/, f);
    assert.match(body, /<\/svg>\n$/, f);
  }
});

test('the manual fetches nothing from the network but Google Fonts', () => {
  const urls = [...manual.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]);
  assert.ok(urls.length > 0);
  for (const u of urls) assert.match(u, /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/, u);
  assert.doesNotMatch(manual, /<script[^>]+src=/);
  assert.doesNotMatch(manual, /url\(\s*['"]?https?:/);
});

// The manual is bilingual from one dictionary: the markup carries keys, and each language is
// a flat key -> HTML map. A sentence added to one language and not the other would show its
// bare key on the page in the other, and nothing else would notice.
const dictionary = () => {
  const m = /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(manual);
  assert.ok(m, 'manual.html has no i18n dictionary');
  return JSON.parse(m[1]);
};

test('the manual\'s English and Spanish carry the same set of keys', () => {
  const d = dictionary();
  assert.deepEqual(Object.keys(d).sort(), ['en', 'es']);
  const en = Object.keys(d.en).sort(), es = Object.keys(d.es).sort();
  assert.deepEqual(en.filter(k => !d.es[k]), [], 'in English, missing from Spanish');
  assert.deepEqual(es.filter(k => !d.en[k]), [], 'in Spanish, missing from English');
  for (const lang of ['en', 'es']) for (const k of en) assert.ok(String(d[lang][k]).trim(), `${lang}.${k} is empty`);
});

test('every key the manual\'s markup names exists in the dictionary', () => {
  const d = dictionary();
  const used = [...manual.matchAll(/data-t(?:-[a-z]+)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(used.length > 100, `only ${used.length} keyed elements: the regex lost them`);
  assert.deepEqual([...new Set(used)].filter(k => !(k in d.en)), []);
});

test('each translation keeps the same inline markup as its other language', () => {
  // a <code> or a <br> dropped in one language is a different-looking sentence, not a translation
  const d = dictionary();
  const tags = (h) => [...String(h).matchAll(/<\/?([a-z0-9]+)/g)].map(m => m[0]).sort().join(' ');
  for (const k of Object.keys(d.en)) assert.equal(tags(d.es[k]), tags(d.en[k]), k);
});
