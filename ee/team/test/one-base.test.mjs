// One base: the team app and the phone are one app (web/ui/app.jsx), and this holds them to it.
//
// The two used to be separate clients for one product. Every feature was built twice or reached
// only one of them, and the copies drifted in look and behaviour without any test noticing, because
// each copy was tested on its own terms. What would let that happen again is structural: a page
// routed in one app and not the other, a screen kept in an app's folder beside the shared one, a
// link to an address no route answers, or a page whose sidebar word and back-link word differ. Each
// of those is a test below.
//
// Read from the source, as the other structural tests here are: the route table is a literal in
// app.jsx, and the question is what the file says, not what one render of it happened to draw.
// The render is checked by phone-check.mjs (both widths, every route) and look.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../..', import.meta.url).pathname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UI = 'web/ui';
const APP = read(`${UI}/app.jsx`);
// Comments out, so a route named in a comment ("Suggested hash route: …") cannot satisfy a check.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

// ── the route table, as app.jsx writes it ────────────────────────────────────────────────────
const block = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `app.jsx has no ${head}`);
  let depth = 0, i = src.indexOf(head.endsWith('[') ? '[' : '{', at);
  const open = src[i], close = open === '[' ? ']' : '}';
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`${head} never closes`);
};
const VIEWS_SRC = block(APP, 'export const VIEWS = [');
const SCREENS_SRC = block(APP, 'export const SCREENS = {');
const VIEWS = [...VIEWS_SRC.matchAll(/\{\s*view:\s*'([\w-]+)'([^}]*)\}/g)].map(m => ({
  view: m[1],
  nav: (/nav:\s*\['[\w-]+',\s*'([\w.-]+)'\]/.exec(m[2]) || [])[1] || null,
  under: (/under:\s*'([\w-]+)'/.exec(m[2]) || [])[1] || null,
}));
// A key at the top level of SCREENS: `name: (` or `'name': (` at the start of its line.
const SCREENS = [...code(SCREENS_SRC).matchAll(/^\s*'?([\w-]+)'?:\s*\(/gm)].map(m => m[1]);

test('every page in the route table has its screen, and every screen is a page', () => {
  assert.ok(VIEWS.length >= 10, `read ${VIEWS.length} views from app.jsx`);
  const views = VIEWS.map(v => v.view).filter(v => v !== 'home').sort();
  assert.deepEqual([...SCREENS].sort(), views, 'VIEWS and SCREENS name different pages');
  // Home is drawn by FleetApp itself, with the assistant's card in it; it must not grow a screen
  // entry that would bypass that.
  assert.ok(!SCREENS.includes('home'), 'home is FleetApp\'s own');
});

test('every screen the table draws comes from web/ui, never from an app', () => {
  const imports = new Map();
  for (const m of APP.matchAll(/^import\s*\{([^}]+)\}\s*from\s*'([^']+)'/gm))
    for (const name of m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imports.set(name, m[2]);
  const drawn = [...new Set([...SCREENS_SRC.matchAll(/<([A-Z]\w*)/g)].map(m => m[1]))];
  assert.ok(drawn.length >= 12, `read ${drawn.length} components from SCREENS`);
  const outside = drawn.filter(n => !/^\.\/[\w-]+\.jsx$/.test(imports.get(n) || '')).map(n => `${n} from ${imports.get(n) || 'nowhere'}`);
  assert.deepEqual(outside, [], 'a page drawn by something that is not a web/ui screen');
});

test('neither app keeps a placeholder or a copy of a shared page', () => {
  assert.doesNotMatch(code(APP), /\binterim\b|<Pending\b/, 'app.jsx still has a per-app or placeholder page');
  const team = code(read('ee/team/web/src/main.jsx'));
  const phone = code(read('web/src/phone.jsx'));
  for (const [name, src] of [['the team app', team], ['the phone', phone]])
    assert.doesNotMatch(src, /\binterim\s*=/, `${name} passes a page of its own for a shared view`);
  // The team's own pages are administration and nothing else, and they are named in one list.
  const own = /export const TEAM_VIEWS = \[([^\]]*)\]/.exec(team);
  assert.ok(own, 'main.jsx exports TEAM_VIEWS');
  assert.deepEqual(own[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean), ['admin']);
  const screens = /screens:\s*\{([^}]*)\}/.exec(team);
  assert.deepEqual(screens ? [...screens[1].matchAll(/^\s*'?([\w-]+)'?:/gm)].map(m => m[1]) : [], ['admin'],
                   'the team app draws a page that is not in TEAM_VIEWS');
  const shared = new Set(VIEWS.map(v => v.view));
  assert.ok(!shared.has('admin'), 'admin is the team\'s, not a shared page');
  // The phone has no pages of its own.
  assert.doesNotMatch(phone, /\bextra\s*=/, 'the phone passes pages of its own');
});

// What an app folder may hold: what that app has and ghostfleet itself does not. A new file here
// is a decision, so it fails until it is named, with its reason, in this list.
const APP_FILES = {
  'ee/team/web/src': {
    'main.jsx': 'the entry: sign-in states, then <FleetApp>',
    'auth.jsx': 'sign-in, first-run setup and the password change, on the shared gate',
    'slots.jsx': 'the people slots: who owns a session, who else has it open',
    'avatar.jsx': 'a person\'s picture, for the people slots and the sidebar foot',
    'usage.jsx': 'the account\'s Claude usage, a team server\'s data',
    'admin': 'administration: users, the AI account, usage limits',
    'adapter.js': 'the team adapter',
    'adapter-extras.js': 'the team adapter\'s members for the queue, reviews and sign-ins',
    'api.js': 'the team server\'s client',
    'i18n.js': 'the team\'s catalogs, added to web/ui\'s',
    'styles.css': 'the team\'s layout rules, after web/ui/ui.css',
    'skin.css': 'the team\'s skin rules, after web/ui/skin.css',
  },
  'web/src': {
    'phone.jsx': 'the entry: the passkey lock, then <FleetApp>',
    'lock.jsx': 'the passkey lock, on the shared gate',
    'adapter.js': 'the phone adapter, over fleet-serve',
    'adapter-extras.js': 'the phone adapter\'s members for the queue, reviews, sign-ins and automations',
    'push.js': 'web push, which only an installed phone app has',
    'tasks.js': 'the assistant\'s task list, which fleet-serve does not keep',
    'lead.js': 'a project\'s lead started if it is not running: the team server\'s /api/lead, which fleet-serve does not have',
  },
};
test('an app folder holds only what that app has and web/ui does not', () => {
  for (const [dir, allowed] of Object.entries(APP_FILES)) {
    const have = fs.readdirSync(path.join(ROOT, dir)).filter(f => !f.startsWith('.')).sort();
    assert.deepEqual(have.filter(f => !Object.hasOwn(allowed, f)), [], `${dir} has a file this test does not know`);
  }
});

test('no app defines a screen web/ui already has', () => {
  // Every component web/ui/app.jsx draws as a page, and the session view the project page opens.
  const names = [...new Set([...SCREENS_SRC.matchAll(/<([A-Z]\w*)/g)].map(m => m[1])), 'Home', 'SessionView', 'Frame'];
  const files = Object.keys(APP_FILES).flatMap(dir => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter(f => /\.jsx?$/.test(f)).map(f => path.join(dir, f)));
  const found = [];
  for (const f of files) for (const n of names)
    if (new RegExp(`(function|const|class)\\s+${n}\\b`).test(code(read(f)))) found.push(`${n} in ${f}`);
  assert.deepEqual(found, [], 'a second copy of a shared screen');
});

// ── links: every address a shared screen sends the person to is one the table answers ────────
test('every address web/ui links to is a route both apps answer', () => {
  const answered = new Set([...VIEWS.map(v => v.view), 'p', 'map']);
  const files = fs.readdirSync(path.join(ROOT, UI)).filter(f => /\.jsx?$/.test(f));
  const seen = new Map();
  for (const f of files) {
    const src = code(read(`${UI}/${f}`));
    // go('/x…'), back('/x…'), href="#/x…", parent="/x…", and template literals that start one.
    for (const m of src.matchAll(/(?:\bgo\(|\bback\(|href=\{?|parent=\{?)\s*[`'"]#?\/([a-z][\w-]*)/g)) {
      if (!seen.has(m[1])) seen.set(m[1], new Set());
      seen.get(m[1]).add(f);
    }
  }
  assert.ok(seen.size >= 8, `read ${seen.size} distinct link targets from web/ui`);
  const dead = [...seen].filter(([seg]) => !answered.has(seg)).map(([seg, fs_]) => `/${seg} (${[...fs_].join(', ')})`);
  assert.deepEqual(dead, [], 'a link to an address no route answers');
});

// ── names: the sidebar's word for a page is the back link's word for it ───────────────────────
test('a page\'s sidebar word is the word its back link uses, in both languages', async () => {
  const i18n = await import(path.join(ROOT, UI, 'i18n.js'));
  const { screenPlace } = await import(path.join(ROOT, UI, 'phone-places.js'));
  const linked = VIEWS.filter(v => v.nav);
  assert.ok(linked.length >= 7, `read ${linked.length} sidebar links`);
  for (const lang of ['en', 'es']) {
    i18n.setLangSource(() => lang);
    for (const v of linked) {
      const word = i18n.t(v.nav);
      assert.notEqual(word, v.nav, `${lang}: ${v.nav} is not in the catalog`);
      const place = screenPlace(`/${v.view}`);
      // Activity is named by back.jsx itself (SHARED_PLACES), not by phone-places.js.
      if (place == null) { assert.match(read(`${UI}/back.jsx`), new RegExp(`${v.view}:\\s*'${v.nav.replace('.', '\\.')}'`), `${v.view} is named nowhere`); continue; }
      assert.equal(place, word, `${lang}: the sidebar says "${word}" for /${v.view} and its back link says "${place}"`);
    }
  }
});

// ── the adapters: one naming, and the people only where there are people ──────────────────────
test('both adapters name web/ui\'s pages first, and only the team has people', () => {
  const team = code(read('ee/team/web/src/adapter.js'));
  const phone = code(read('web/src/adapter.js'));
  for (const [name, src] of [['team', team], ['phone', phone]]) {
    assert.match(src, /import \{ screenPlace \} from '[./]+(web\/)?ui\/phone-places\.js'/, `${name}: does not import screenPlace`);
    assert.match(src, /screenPlace\(to\)\s*\|\|/, `${name}: place() does not ask screenPlace first`);
  }
  assert.match(team, /hasPeople:\s*true/, 'the team adapter has people');
  assert.match(code(read('web/src/adapter-extras.js')), /hasPeople:\s*false/, 'the phone has none');
  assert.match(phone, /\.\.\.Object\.fromEntries\(Object\.entries\(adapterExtras\)/, 'the phone adapter spreads its extras (through its guard)');
});
