#!/usr/bin/env node
// place-check — where the app was, written into the URL and read back out of it.
//
//     node test/helpers/place-check.mjs [web-dir]     # "name <US> want <US> got" rows
//
// web/place.js is the whole codec and the clamps a restore goes through, with no DOM, so
// this imports it and nothing else. `web-dir` defaults to this checkout's web/; pointed at a
// `git archive` of staging, which has no place.js, the import fails and every row is red —
// which is how it was watched before it was trusted.
//
// WHAT IS CLAIMED, in the order the brief put it:
//   - a place survives the round trip through a query string, every screen that has one;
//   - the query carries only the place: nothing a reader of the address bar should not see;
//   - a URL naming a missing subject lands where the STORED state with the same hole lands,
//     because both go through the same clamp — asserted by running both, not by reading;
//   - a URL that carries a place wins over the stored one, and none leaves the stored one
//     exactly as it was.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = () => { console.log(rows.join('\n')); process.exit(0); };

let P;
try { P = await import(pathToFileURL(path.join(WEB, 'place.js')).href); }
catch (e) { is('web/place.js imports', 'yes', String((e && e.message) || e).split('\n')[0].slice(0, 120)); done(); }
is('web/place.js imports', 'yes', 'yes');

const SEP = ' · ';
// The fields a place has, and nothing else — what the round trip compares.
const keep = (p) => p && ({ screen: p.screen, project: p.project, session: p.session, sub: p.sub, view: p.view,
  profile: p.profile, entry: p.entry, jarvisMode: p.jarvisMode, rv: p.rv });

// ── the round trip ──────────────────────────────────────────────────────────────────────
const PLACES = {
  'Projects, every tab':           { screen: 'projects', profile: 'all' },
  'Projects, one profile':         { screen: 'projects', profile: 'work' },
  'Projects, a paired tab':        { screen: 'projects', profile: `vm${SEP}work` },
  'a grid':                        { screen: 'grid', project: 'acme-api', profile: 'all' },
  'a sub-grid':                    { screen: 'grid', project: 'acme-api', sub: 'api-fix', profile: 'all' },
  'a session':                     { screen: 'session', project: 'acme-api', session: 'master', profile: 'work' },
  'a session in its pane':         { screen: 'session', project: 'acme-api', session: 'api-fix', view: 'pane', profile: 'all' },
  'a master entered from Projects':{ screen: 'session', project: 'acme-api', session: 'master', entry: 'projects', profile: 'all' },
  "a paired machine's session":    { screen: 'session', project: 'billing-svc@vm', session: 'master', profile: `vm${SEP}work` },
  'Jarvis':                        { screen: 'session', session: 'master', jarvisMode: true, profile: 'all' },
  'the queue':                     { screen: 'queue', profile: 'all' },
  'Reviews':                       { screen: 'reviews', profile: 'all' },
  'Automations':                   { screen: 'automations', profile: 'all' },
  'a run':                         { screen: 'review', profile: 'all', rv: { host: '', profile: 'work', run: '2026-03-05_14-02-11' } },
  "a paired machine's run":        { screen: 'review', profile: 'all', rv: { host: 'vm', profile: 'work', run: '2026-03-05_13-20-00' } },
  'the stack':                     { screen: 'stack', profile: 'all' },
  'the stack picker':              { screen: 'stackpick', profile: 'all' },
  // names a reader can type, and names nobody should have to
  'a name with spaces and &#?':    { screen: 'session', project: 'scratch', session: 'a b&c#d?e', profile: 'all' },
};
for (const [what, p] of Object.entries(PLACES)) {
  const q = P.toQuery(p);
  const back = P.fromQuery(q);
  is(`round trip: ${what}`, keep(P.normalize(p)), keep(back));
}

// ── what it reads like ──────────────────────────────────────────────────────────────────
is('a session reads as words',
  '?screen=session&tab=work&p=acme-api&s=master', P.toQuery(PLACES['a session']));
is("a paired tab and project keep their @ (the project's own address form)",
  '?screen=session&tab=work@vm&p=billing-svc@vm&s=master', P.toQuery(PLACES["a paired machine's session"]));
is('a run names its host, profile and run',
  '?screen=review&host=vm&profile=work&run=2026-03-05_13-20-00', P.toQuery(PLACES["a paired machine's run"]));
is('defaults are left out (all, chat, this machine)', '?screen=grid&p=acme-api', P.toQuery(PLACES['a grid']));
is('Jarvis is a screen of its own, not a session of a project', '?screen=jarvis', P.toQuery(PLACES['Jarvis']));
is('a reserved character is encoded, not passed through', true,
  /s=a%20b%26c%23d%3Fe$/.test(P.toQuery(PLACES['a name with spaces and &#?'])));

// ── only the place ──────────────────────────────────────────────────────────────────────
// Whatever else rides on the object handed in — a draft, a token, a payload — never reaches
// the address bar. The keys are a closed list.
const leaky = { ...PLACES['a session'], draft: 'the message being typed', token: 'tok-123', sess: { messages: ['hi'] },
  projects: [{ name: 'acme-api' }], srch: { q: 'bil' } };
const keys = [...new URLSearchParams(P.toQuery(leaky)).keys()];
is('the query carries place keys only', [], keys.filter(k => !P.PLACE_KEYS.includes(k)));
is('...and no value from anything else on the object', false,
  /message|tok-123|bil|hi/.test(decodeURIComponent(P.toQuery(leaky))));

// ── parsing what a person might type ────────────────────────────────────────────────────
is('no query is no place', null, P.fromQuery(''));
is('a query with none of ours is no place', null, P.fromQuery('?utm_source=x&ticket=abc'));
is('#reviews is not read as a place (app.js keeps its own alias)', null, P.fromQuery('', '#reviews'));
is('a screen implied by its subject: s means a session', 'session', (P.fromQuery('?p=acme-api&s=master') || {}).screen);
is('...p alone means its grid', 'grid', (P.fromQuery('?p=acme-api') || {}).screen);
is('...a run means the run', 'review', (P.fromQuery('?run=2026-03-05_14-02-11&profile=work') || {}).screen);
is('an unknown screen is not trusted', 'projects', (P.fromQuery('?screen=term&tab=work') || {}).screen);
is('a tab with a host comes back as the label the strip draws', `vm${SEP}work`, (P.fromQuery('?tab=work@vm') || {}).profile);

// ── the clamps: a URL lands where the stored state with the same hole lands ─────────────
// clamp() is what restore() runs. Each case is the SAME half-written place given both ways:
// stored, as save() writes it, and as a URL over a stored state that says something else.
const ctx = { tabs: ['work', 'personal'], stackLen: 0 };
const OTHER = { at: 1, screen: 'grid', project: 'toolbox', session: null, profile: 'personal', view: 'pane', entry: '', jarvisMode: false, sub: 'x' };
const HOLES = {
  'a session with no session name':   ['?screen=session&p=acme-api', { screen: 'session', project: 'acme-api', session: null }],
  'a session with no project either': ['?screen=session',            { screen: 'session', project: null, session: null }],
  'a grid with no project':           ['?screen=grid',               { screen: 'grid', project: null }],
  'a run with no run':                ['?screen=review&profile=work', { screen: 'review', rv: { profile: 'work', run: '' } }],
  'a tab that is not there any more': ['?screen=projects&tab=gone',  { screen: 'projects', profile: 'gone' }],
  'the stack with nothing in it':     ['?screen=stack',              { screen: 'stack' }],
  'a session that is not on the grid':['?screen=session&p=acme-api&s=long-gone', { screen: 'session', project: 'acme-api', session: 'long-gone' }],
};
for (const [what, [q, stored]] of Object.entries(HOLES)) {
  const viaUrl = P.clamp(P.overlay(OTHER, P.fromQuery(q)), ctx);
  const viaStore = P.clamp(stored, ctx);
  is(`same clamp: ${what}`, viaStore, viaUrl);
}
// ...and the clamps themselves, so "the same" is not two copies of the same mistake.
is('clamp: a session with no name falls to its grid', ['grid', 2], (c => [c.screen, c.depth + 1])(P.clamp(HOLES['a session with no session name'][1], ctx)));
is('clamp: with no project either, to Projects', 'projects', P.clamp(HOLES['a session with no project either'][1], ctx).screen);
is('clamp: a run with no run, to Reviews', 'reviews', P.clamp(HOLES['a run with no run'][1], ctx).screen);
is('clamp: an unknown tab, to all', 'all', P.clamp(HOLES['a tab that is not there any more'][1], ctx).profile);
is('clamp: an empty stack, to its picker', 'stackpick', P.clamp(HOLES['the stack with nothing in it'][1], ctx).screen);
// the trail back: restoredDepth, as restore() measured it before this file existed
const depth = (q) => P.clamp(P.overlay({}, P.fromQuery(q)), ctx).depth;
is('trail: a session is two above Projects', 2, depth('?screen=session&p=acme-api&s=api-fix'));
is('trail: a master entered from Projects is one', 1, depth('?screen=session&p=acme-api&s=master&from=projects'));
is('trail: Jarvis is one', 1, depth('?screen=jarvis'));
is('trail: a grid, the queue, Reviews are one', [1, 1, 1], [depth('?screen=grid&p=acme-api'), depth('?screen=queue'), depth('?screen=reviews')]);
is('trail: a run is two', 2, depth('?screen=review&profile=work&run=r1'));
is('trail: Projects is the root', 0, depth('?screen=projects'));

// ── the URL wins; no URL is the stored state, untouched ─────────────────────────────────
const STORED = { at: 7, screen: 'session', project: 'acme-api', session: 'docs-pass', view: 'pane', profile: 'work',
  entry: '', jarvisMode: false, sub: '', grid: { cards: ['acme-api grid'] }, projects: [{ name: 'acme-api' }], hosts: null };
const won = P.overlay(STORED, P.fromQuery('?screen=reviews'));
is('URL wins: the screen', 'reviews', P.clamp(won, ctx).screen);
is('...and nothing of the stored place leaks into it', [null, null, 'chat', 'all'], [won.project, won.session, won.view, won.profile]);
is('...while the payload cache is still there to paint with', [{ name: 'acme-api' }], won.projects);
const other = P.overlay(STORED, P.fromQuery('?screen=grid&p=billing-svc'));
is("another project's cached grid is not painted under this one", null, other.grid);
const same = P.overlay(STORED, P.fromQuery('?screen=session&p=acme-api&s=master'));
is("the same project's cached grid is kept", STORED.grid, same.grid);
is('no URL: the stored state exactly', STORED, P.overlay(STORED, null));
is('no URL: the same clamp result as before', P.clamp(STORED, ctx), P.clamp(P.overlay(STORED, P.fromQuery('')), ctx));
done();
