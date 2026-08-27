#!/usr/bin/env node
// test/helpers/pwa-render.mjs — the client actually RUNS, and paints what it decided.
//
//     node test/helpers/pwa-render.mjs <live-fleet-serve-base>
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// WHY A FAKE DOM AND NOT MORE REGEXES. CLAUDE.md: "`node --check` proves syntax, not that
// it runs. A missing `let` is a ReferenceError that only fires on the keystroke that
// reaches it — and it kills the whole grid pane." web/app.js has met that exact failure
// once already (its boot block sat above the `const SHIP` the lock screen draws, and every
// screen was blank), and pwa-check's answer to it is a STRUCTURAL rule — declarations
// before statements — which makes the bug impossible rather than detected. This file is
// the other half: import app.js, let its boot block run, and read what it painted.
//
// It is about 60 lines of DOM because that is all app.js uses: createElement, append,
// textContent, one getBoundingClientRect for the font measurement, and two ids. Anything
// it does not implement, app.js is not allowed to reach for — which is itself a check.
//
// The two things it proves that no regex can:
//   - the lock screen says which backend it resolved to, on a real probe of a real daemon
//   - server mode routes to ENROLMENT and hides the fixture bypass, which is the pair of
//     buttons the stuck phone was on the wrong side of
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const BASE = (process.argv[2] || '').replace(/\/+$/, '');

// ── a DOM, as small as app.js allows ──────────────────────────────────────
const TEXTUAL = new Set(['input', 'textarea', 'select']);
// ── enough of a scroller to say where the reader is ───────────────────────
// MODELLED, not stubbed, because the geometry IS the bug. A rebuilt element starts at
// scrollTop 0, which is what threw the card lists to the top; and the browser CLAMPS a
// write to the current maximum and then reports the CLAMPED value to the scroll listener,
// which is how a list that merely got shorter can be recorded as "the reader is at the
// end" and glued there. Both are expressible here, and neither is if scrollTop is a plain
// property.
//   The event is dispatched ASYNCHRONOUSLY on purpose. Measured in Chrome 151 against a
// real element: assigning scrollTop fires no 'scroll' event during the assignment, and the
// event has arrived by the next animation frame. A model that called the listener inline
// would prove the opposite of what the code has to survive.
const ROW_H = 100;   // one card is five lines; one bubble is about the same
class Node_ {
  constructor(tag) {
    this.tag = tag; this.kids = []; this.attrs = {}; this.listeners = {};
    this.className = ''; this._text = null; this.value = ''; this.checked = false;
    this._top = 0; this.scrollLeft = 0; this.clientHeight = ROW_H * 4;
    this.style = { cssText: '', setProperty() {} };
    this.dataset = {};
    const has = (c) => this.className.split(/\s+/).includes(c);
    this.classList = {
      contains: has,
      add: (...cs) => { for (const c of cs) if (!has(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (...cs) => { this.className = this.className.split(/\s+/).filter(x => x && !cs.includes(x)).join(' '); },
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
    };
  }
  // Height comes from the children, so "the list got shorter" is a thing a test can do.
  get scrollHeight() { return Math.max(this.clientHeight, this.kids.length * ROW_H); }
  get scrollTop() { return this._top; }
  set scrollTop(v) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    const next = Math.min(max, Math.max(0, Number(v) || 0));   // NaN lands on 0, as it does
    if (next === this._top) return;                            // a no-op write fires nothing
    this._top = next;
    queueMicrotask(() => { for (const f of this.listeners.scroll || []) f({ type: 'scroll' }); });
  }
  set textContent(v) { this.kids.length = 0; this._text = String(v); }
  // The whole subtree's text, which is what "the lock screen says X" means.
  get textContent() {
    if (this._text != null && !this.kids.length) return this._text;
    return (this._text || '') + this.kids.map(k => k.textContent).join(' ');
  }
  set innerHTML(v) { this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  append(...ks) { for (const k of ks) if (k != null) this.appendChild(k); }
  // A fragment SPLICES, it does not nest — web/md.js builds a bubble's blocks into one and
  // appends it, and a model that kept the fragment as a child would put every rendered
  // message one level deeper than the browser does, which is the level the assertions
  // below count at.
  appendChild(k) {
    if (k && k.tag === '#fragment') { for (const c of k.kids) this.kids.push(c); k.kids.length = 0; return k; }
    this.kids.push(k); return k;
  }
  remove() {}
  setPointerCapture() {} releasePointerCapture() {}   // the drag calls these; nothing to capture here
  // Records the focused node on the document too, not just a flag on itself: the poll
  // guard asks `document.activeElement === composerNode`, which is the only way to
  // tell "you are typing" that cannot go stale when a render drops the element.
  focus() { this.focused = true; try { documentStub.activeElement = this; } catch {} }
  blur()  { this.focused = false; try { if (documentStub.activeElement === this) documentStub.activeElement = null; } catch {} }
  get firstChild() { return this.kids[0] || null; }
  getBoundingClientRect() { return { width: 800, height: 20 }; }   // 8px per column, at 100px
  // A comma-separated tag list is the only selector app.js uses (renderSheet's first field).
  querySelector(sel) {
    const want = sel.split(',').map(s => s.trim());
    const hit = (n) => {
      for (const k of n.kids) {
        if (want.includes(k.tag)) return k;
        const deep = hit(k); if (deep) return deep;
      }
      return null;
    };
    return hit(this);
  }
  // for the assertions, not for app.js
  find(pred) {
    for (const k of this.kids) { if (pred(k)) return k; const d = k.find(pred); if (d) return d; }
    return null;
  }
  all(pred, out = []) { for (const k of this.kids) { if (pred(k)) out.push(k); k.all(pred, out); } return out; }
}
const app = new Node_('div'), sheetHost = new Node_('div');
const documentStub = {
  hidden: false,
  documentElement: new Node_('html'),
  body: new Node_('body'),
  createElement: (t) => new Node_(t),
  // The read-aloud icon is an inline SVG, and SVG only exists in its own namespace — an
  // <svg> made with createElement is an unknown HTML element that draws nothing. The ns is
  // RECORDED rather than discarded so the assertion can say the icon is really an SVG and
  // not a same-named div, which is exactly the mistake this stub would otherwise hide.
  createElementNS: (ns, t) => { const n = new Node_(t); n.ns = ns; return n; },
  createTextNode: (t) => { const n = new Node_('#text'); n.textContent = t; return n; },
  createDocumentFragment: () => new Node_('#fragment'),
  getElementById: (id) => (id === 'app' ? app : id === 'sheet' ? sheetHost : null),
  // markSel() reaches for this on every pointerdown — it moves the selection without a
  // re-render, because re-rendering mid-gesture replaces the node under the finger. It is
  // implemented rather than stubbed to [] so a TAP goes all the way through: the lead's
  // card is the one thing on the grid that cannot be reached any other way here (no
  // keyboard — addEventListener is a no-op above).
  querySelectorAll: (sel) => (sel === '#app .card'
    ? app.all(n => n.className.split(/\s+/).includes('card'))
    : []),
  addEventListener() {},
};
const winListeners = {};
const fireWindow = (ev) => { for (const f of winListeners[ev] || []) f({ type: ev }); };
// THE GESTURE, both halves. A swipe pops the entry and then fires popstate; firing alone
// would model half of it and leave the depth assertions passing for the wrong reason.
const swipeBack = () => { if (histDepth > 0) histDepth--; fireWindow('popstate'); };
let histDepth = 0;
const histPushedUrls = [];
const stored = new Map();
for (const [name, value] of [
  ['localStorage', {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  }],
  ['document', documentStub],
  // A REAL REGISTRY, not a no-op. app.js's back gesture is wired to `popstate`, and a
  // swallowed listener would make the whole feature untestable outside a browser — which
  // is the same "it parses but does it run" gap this helper exists to close.
  ['addEventListener', (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); }],
  // ...and the platform half of it. The app never reads a URL — pushState is called with
  // the current href and the entries carry a depth — so a counter IS the model: push
  // deepens, back()/go() pop and fire popstate, and popping at the root does nothing,
  // which is where the system gesture would leave the app.
  ['history', {
    get length() { return histDepth + 1; },
    pushState: (_st, _t, url) => { histPushedUrls.push(String(url ?? '')); histDepth++; },
    replaceState: () => {},
    back: () => { if (histDepth > 0) { histDepth--; fireWindow('popstate'); } },
    go: (n) => {
      const steps = Math.min(histDepth, Math.max(0, -Number(n) || 0));
      if (!steps) return;
      histDepth -= steps; fireWindow('popstate');
    },
  }],
  // available() wants these two; the ceremony behind the buttons is pwa-enrol.mjs's job,
  // and this file stops at the sheet rather than touching navigator.credentials.
  ['window', { isSecureContext: true, PublicKeyCredential: function PublicKeyCredential() {} }],
  ['navigator', {}],
  // app.js polls every 5s; left real, the process would never exit. The callback is KEPT
  // rather than dropped, so a test can fire exactly one poll and know it has: the whole
  // point of the thinking indicator is that it is a mirror of a status the poll delivers,
  // and "it went away" is only worth asserting if the thing that clears it is the real
  // poll body rather than a re-render the test arranged.
  ['setInterval', (fn, ms) => { if (ms === 5000) pollTick = fn; return 0; }],
]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// FIXTURE MODE HAS TO BE ABLE TO READ ITS FIXTURES. api.js fetches them as
// `./fixtures/<file>` — a relative URL, which in a browser resolves against the page and
// here resolves against nothing ("Failed to parse URL"). So the shipped files are served
// off disk, and only those: anything else falls through to the real fetch, which is what
// the origin probe and every server-mode request still use.
let pollTick = null;                 // app.js's own 5s poll body, fired by hand below
const realFetch = globalThis.fetch;
// A HAND-WRITTEN FLEET, for the cases the shipped fixture cannot be: one profile only,
// a profile nobody anticipated, and a hidden project BETWEEN two visible ones. Changing
// projects.json itself would move the CLIENT-HASH and stale the seven images that were
// shot against it, for cases that are about the client's arithmetic rather than about
// the demo data.
let fixtureOverride = null;    // { 'projects.json': <object> } | null
// GF_SLOW_MS=<n> ADDS n MILLISECONDS TO EVERY FETCH, and it is the only reason the bug
// this file spent two CI runs on was findable. The symptom was macos-latest failing seven
// rows that ubuntu passed on the identical commit — unreproducible on the machine this is
// developed on, which is simply faster. At GF_SLOW_MS=30 it reproduces in twenty seconds,
// and the same knob is what proves a fix holds: 0, 30, 60, 120 and 250 all green is a
// different claim from "it passed once".
//   Inert when unset, so a normal run is untouched.
const SLOW_MS = Number(process.env.GF_SLOW_MS || 0);
const slow = (p) => SLOW_MS ? p.then(v => new Promise(r => setTimeout(() => r(v), SLOW_MS))) : p;
globalThis.fetch = (url, opts) => slow((() => {
  const m = /^\.\/fixtures\/([A-Za-z0-9._-]+)$/.exec(String(url));
  if (m && fixtureOverride && fixtureOverride[m[1]]) {
    const body = fixtureOverride[m[1]];
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
  }
  if (!m) return realFetch(url, opts);
  const file = new URL(`../../web/fixtures/${m[1]}`, import.meta.url);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); }
  catch { return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); }
  return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(body) });
})());

const U = BASE ? new URL(BASE) : null;
globalThis.location = U ? { href: U.href, origin: U.origin, protocol: U.protocol, host: U.host, hostname: U.hostname }
                       : { href: 'file:///', origin: 'null', protocol: 'file:', host: '', hostname: '' };

const api = await import(new URL('../../web/api.js', import.meta.url).href);
is('a live fleet-serve base was given', true, !!BASE);

// ── it boots at all ───────────────────────────────────────────────────────
// The import IS the test: app.js's last block runs restore(), fitCards(), render() and
// the probe. A ReferenceError anywhere in it lands here instead of on a phone.
let bootError = '', appmod = {};
try { appmod = await import(new URL('../../web/app.js', import.meta.url).href); }
catch (e) { bootError = String((e && e.message) || e); }
is('web/app.js boots without throwing', '', bootError);
is('...and painted something', true, app.kids.length > 0);
// The probe was still in flight during that first paint, and it must not have guessed.
is('the first paint is not a guess', true, /looking for a fleet/.test(app.textContent));

const tick = (ms) => new Promise(r => setTimeout(r, ms));
// Polled, not slept: BASE is `http://localhost:<port>` and the daemon binds 127.0.0.1
// only, so undici tries ::1 first and the first request pays a Happy-Eyeballs round trip
// — measured at over 300ms here. A fixed sleep tuned to that is a test that passes on
// this machine.
async function until(pred, ms = 4000) {
  for (let i = 0; i < ms / 25 && !pred(); i++) await tick(25);
  return pred();
}
const btnWith = (re) => app.find(n => n.tag === 'button' && re.test(n.textContent));
// The sheet's own "esc back", so a test closes it the way a finger does.
const closeSheetFromTest = () => {
  const host = sheetHost.firstChild;
  const b = host && host.find(n => n.tag === 'button' && /esc\s+back/.test(n.textContent));
  if (b) (b.listeners.click || []).forEach(f => f());
};
// Null-safe on purpose: a button that is not there has to come out as a red ROW from the
// assertion above it, not as a dead helper that emits nothing at all.
//   IT PASSES AN EVENT. It used to call the handler with nothing, which is a click no
// browser ever delivers — and the first handler to read the event (the speaker's
// stopPropagation, which is what keeps a tap on the control off the bubble underneath it)
// died on `undefined` inside the helper, taking every remaining row with it.
const clickEv = (n) => ({ stopPropagation() {}, preventDefault() {}, target: n });
const click = (n) => (n && (n.listeners.click || []).map(f => f(clickEv(n)))[0]);

// ── served by the daemon: it says so, and offers ENROLMENT ────────────────
await api.ready();
// app.js re-renders itself when the probe answers; give the microtask that queues it a
// turn, since `.then(() => render())` is one tick behind our own await.
await tick(50);
if (BASE) {
  is('the lock screen names the origin it resolved to', true, app.textContent.includes(BASE));
  is('...and says a 401 is what proved it', true, /asked for a passkey \(401\)/.test(app.textContent));
  is('...and does not claim fixtures', false, /fixtures — /.test(app.textContent));
  // The pair of buttons the stuck phone was on the wrong side of.
  is('it offers to enrol this phone', true, !!btnWith(/enrol this phone/));
  is('...and NOT the fixture bypass', false, !!btnWith(/continue without a passkey/));
  is('...and not a bare "register a passkey"', false, !!btnWith(/register a passkey/));
  is('...and not "look again", which is for fixtures', false, !!btnWith(/look again/));

  // The enrolment sheet: a field to type the code into — the thing that did not exist.
  click(btnWith(/enrol this phone/));
  const sheet = sheetHost.firstChild;
  is('tapping it opens a sheet', true, !!sheet);
  is('...with a code field', true, !!(sheet && sheet.find(n => n.tag === 'input')));
  is('...labelled as the enrolment code', true, !!sheet && /enrolment code/.test(sheet.textContent));
  is('...telling you where the code comes from', true, !!sheet && /fleet-serve enroll/.test(sheet.textContent));
  is('...and that case and the hyphen do not matter', true, !!sheet && /hyphen do not matter/.test(sheet.textContent));
  is('...and the field is focused', true, !!(sheet && sheet.find(n => n.tag === 'input' && n.focused)));
  // …and it asks the server whether a window is open before Face ID is spent on it. Which
  // answer depends on whether the suite has an enrolment open at this point; that it
  // ANSWERED, in words that say what to do next, is the check.
  // Null-guarded, like click(): if the button above was missing, the rows already say so
  // and the helper has to survive to PRINT them — it emits everything at the end, so
  // dying here would turn a dozen red rows into no rows at all.
  const answered = await until(() => !!sheet && /(a window is open for|no enrolment is open)/.test(sheet.textContent));
  is('the sheet reports the window state', true, answered);
  is('...and stops saying it is asking', false, !!sheet && /whether an enrolment window is open/.test(sheet.textContent));
}

// ── re-pointed at an origin with no fleet: fixtures, said out loud ────────
// Through the SETTINGS SHEET, because that is the path a person takes and because its
// save button is the one thing that has to re-resolve and re-lock. Port 1 has nothing on
// it, so 'auto' can only land in fixtures.
stored.clear();
globalThis.location = { href: 'http://127.0.0.1:1/', origin: 'http://127.0.0.1:1', protocol: 'http:', host: '127.0.0.1:1', hostname: '127.0.0.1' };
click(btnWith(/settings/));
await tick(50);
const set = sheetHost.firstChild;
is('settings opens over the lock screen', true, !!set);
is('...naming what it resolved to right now', true, !!set && /right now: /.test(set.textContent));
is('...and offering all three choices', true,
   !!set && /where the fleet is/.test(set.textContent)
        && set.all(n => n.tag === 'option').filter(o => ['auto', 'fixtures', 'url'].includes(o.attrs.value)).length === 3);
is('...and saying what auto asks for', true, !!set && new RegExp(api.PROBE_PATH).test(set.textContent));
const save = set && set.find(n => n.tag === 'button' && /save/.test(n.textContent));
is('...with a save button', true, !!save);
click(save);                           // the select's value is '' here, which is auto
await until(() => api.mode() === 'fixtures');
is('an origin with no fleet resolves to fixtures', 'fixtures', api.mode());
await until(() => /fixtures — nothing answered/.test(app.textContent));
is('the lock screen now says fixtures', true, /fixtures — nothing answered/.test(app.textContent));
is('...and re-locked, because the backend changed', true, !btnWith(/⏎ open/));
is('...and offers the way past the gate', true, !!btnWith(/continue without a passkey/));
is('...and offers to look again', true, !!btnWith(/look again/));
is('...and does not offer to enrol', false, !!btnWith(/enrol this phone/));
click(btnWith(/continue without a passkey/));
is('past the lock, the header names the backend', true, /⚠ fixtures/.test(app.textContent));
is('...on the projects screen', true, /ghostfleet/.test(app.textContent) && /projects/.test(app.textContent));

// ── the profile tabs, and the number that must not move ───────────────────
// "add like tabs on the projects page to differentiate between work and personal."
//
// BOTH DIRECTIONS ON EVERY TAB. "hides the other profile" is passed by a screen that
// shows nothing at all, so each tab is asserted to hide what belongs to the others AND to
// still draw its own. And the number is asserted separately, because the tempting
// implementation — filter the array, index the filtered one — passes every visibility
// check while quietly renaming the cards.
const tabStrip = () => app.find(n => n.className.split(/\s+/).join(' ').includes('seg tabs'));
const tabBtn = (label) => { const t = tabStrip(); return t && t.all(n => n.tag === 'button')
  .find(b => b.textContent.replace(/\s+/g, ' ').trim().startsWith(label)); };
const projectCards = () => app.all(n => n.className.split(/\s+/).includes('card'))
  .map(n => n.textContent.replace(/\s+/g, ' '));
// "╭ ─ 5 scratch ─ …" — one span per cell, so whitespace-collapsed. The DIGIT is the point.
const numberOf = (name) => {
  const c = projectCards().find(t => new RegExp('\\u2500 (?:\\d+ )?' + name + ' ').test(t));
  const m = c && /─ (\d+) /.exec(c);
  return m ? Number(m[1]) : null;
};
const shows = (name) => projectCards().some(t => new RegExp('\\u2500 (?:\\d+ )?' + name + ' ').test(t));

await until(() => !!tabStrip(), 4000);
is('two profiles in the fleet draw a tab strip', true, !!tabStrip());
is('...offering all, then each profile', 'all,work,personal',
   (tabStrip() ? tabStrip().all(n => n.tag === 'button')
      .map(b => b.textContent.replace(/\s+/g, ' ').trim().replace(/ ●\d+$/, '')).join(',') : ''));
is('...with all selected on a first run', true, !!(tabBtn('all') || {}).className && /\bon\b/.test(tabBtn('all').className));

// The numbers every card has while nothing is filtered — the addresses `Ctrl-f` uses.
const GLOBAL = { 'acme-api': numberOf('acme-api'), 'acme-web': numberOf('acme-web'),
                 'toolbox': numberOf('toolbox'), 'billing-svc': numberOf('billing-svc'),
                 'scratch': numberOf('scratch') };
is('all shows every project', true, Object.values(GLOBAL).every(n => n != null));
is('...numbered 1..5 in the file\'s order', '1,2,3,4,5', Object.values(GLOBAL).join(','));

click(tabBtn('work'));
await tick(5);
is('the work tab keeps its own projects', true, shows('acme-api') && shows('billing-svc'));
is('...and hides the other profile\'s', false, shows('scratch'));
is('...without renaming anything it draws', '1,4',
   [numberOf('acme-api'), numberOf('billing-svc')].join(','));

click(tabBtn('personal'));
await tick(5);
is('the personal tab keeps its own project', true, shows('scratch'));
is('...and hides work\'s', false, shows('acme-api') || shows('billing-svc'));
// THE ROW THIS WHOLE SECTION EXISTS FOR. `scratch` is the fifth line of the projects
// file, so it is `Ctrl-f 5` at the desk whatever tab the phone is on. Filtering the array
// and numbering the result would print 1 here, and 1 opens acme-api.
is('...and scratch is still project 5, not 1', GLOBAL['scratch'], numberOf('scratch'));

click(tabBtn('all'));
await tick(5);
is('all comes back', true, shows('acme-api') && shows('scratch'));
is('...with the numbers it started with', '1,2,3,4,5', Object.values(GLOBAL).join(',') === '1,2,3,4,5'
   ? [numberOf('acme-api'), numberOf('acme-web'), numberOf('toolbox'), numberOf('billing-svc'), numberOf('scratch')].join(',') : 'baseline moved');

// A BLOCKED PROJECT IN A TAB YOU ARE NOT LOOKING AT is the one thing a filter must not
// swallow — §1's whole question, and the same failure as a summary reading "0 need you"
// over a blocked lead. The degraded fixture puts need-you into every project's rollup.
//   Driven by leaving the screen and coming back, because that is what re-reads
// /api/projects: the count is computed from the rollup, and a re-render alone would only
// redraw the numbers the screen already had.
const tapHere = (name) => {
  const c = app.all(n => n.className.split(/\s+/).includes('card'))
    .find(t => new RegExp('\u2500 (?:\\d+ )?' + name + ' ').test(t.textContent.replace(/\s+/g, ' ')));
  if (!c) return false;
  (c.listeners.pointerdown || []).forEach(f => f({ clientX: 0, clientY: 0, target: c, pointerId: 1 }));
  (c.listeners.pointerup || []).forEach(f => f({ clientX: 0, clientY: 0, target: c, pointerId: 1 }));
  return true;
};
is('the tab strip is quiet when nothing needs you', false, /●\d/.test(tabStrip().textContent));
api.setFixtureName('grid-degraded.json');
is('...opened a project to re-read the rollup', true, tapHere('acme-api'));
await until(() => !btnWith(/add project/), 4000);
swipeBack();
await until(() => !!tabStrip(), 4000);
is('a tab says how many need you', true, await until(() => /●\d/.test((tabStrip() || { textContent: '' }).textContent), 5000));
api.setFixtureName('grid-acme-api.json');

// ── the fleets the shipped fixture is not ─────────────────────────────────
const fleetOf = (...rows) => ({ home: '/Users/pgarces', projects: rows.map(([name, profile]) => ({
  name, profile, path: `/Users/pgarces/gf-demo/${name}`, agent: null, socket: `cf-${name}`,
  sessions: { need: 0, working: 0, parked: 0, total: 0 }, sched: null, nudge: true, budget: 'enforced' })) });
// Leaving and returning is what re-reads /api/projects, which is where the tabs and the
// cards come from. Whatever card is FIRST, by name — the fleet changes under this helper,
// and a hard-coded project is one that has already gone by the time it is tapped.
//
// TWO THINGS IT USED TO GET WRONG, both silent and both only under latency:
//   · it did not check that it LEFT. When the tap had not opened a project yet, the wait
//     timed out, swipeBack() popped nothing (popTo returns at the root), the refresh never
//     ran, and the caller asserted against the fleet that was already on screen.
//   · the screen comes back BEFORE the refresh it triggered lands, so `ready` — what the
//     caller is actually waiting for — has to be waited on here, not guessed at with a
//     tick outside.
// Bounded retries, and it RETURNS whether it got there: no caller is waited into passing,
// and one that never renders the new fleet still fails its own assertion.
const reopenProjects = async (ready) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = app.all(n => n.className.split(/\s+/).includes('card'))
      .find(n => !/add project/.test(n.textContent));
    if (first) {
      (first.listeners.pointerdown || []).forEach(f => f({ clientX: 0, clientY: 0, target: first, pointerId: 1 }));
      (first.listeners.pointerup || []).forEach(f => f({ clientX: 0, clientY: 0, target: first, pointerId: 1 }));
    }
    if (await until(() => !btnWith(/add project/), 4000)) {
      swipeBack();
      await until(() => !!btnWith(/add project/), 4000);
    }
    if (!ready) return true;
    if (await until(ready, 4000)) return true;
  }
  return false;
};

// ONE PROFILE IS THE COMMON CASE — everything is 'work' — and a control whose only option
// is the one you are already on is furniture, not a choice.
fixtureOverride = { 'projects.json': fleetOf(['one', 'work'], ['two', 'work']) };
await reopenProjects();
is('one profile draws no tab strip at all', false, !!tabStrip());
is('...and still draws its projects', true, shows('one') && shows('two'));

// A PROFILE NOBODY ANTICIPATED. `ghostfleet <profile>` takes any name, and readProjects()
// defaults a blank column to 'work' — so a free-text profile must get its own tab rather
// than vanish, and a blank one must land where the desk puts it.
fixtureOverride = { 'projects.json': fleetOf(['alpha', 'work'], ['beta', 'demo'], ['gamma', '']) };
await reopenProjects();
is('an unanticipated profile gets its own tab', 'all,work,demo',
   (tabStrip() ? tabStrip().all(n => n.tag === 'button')
      .map(b => b.textContent.replace(/\s+/g, ' ').trim().replace(/ ●\d+$/, '')).join(',') : ''));
is('...and nothing has vanished from all', true, shows('alpha') && shows('beta') && shows('gamma'));
click(tabBtn('demo'));
await tick(5);
is('the demo tab shows its own project', true, shows('beta'));
is('...and hides the others', false, shows('alpha') || shows('gamma'));
is('...keeping beta\'s number', 2, numberOf('beta'));
click(tabBtn('work'));
await tick(5);
is('a blank profile lands in work, where the desk puts it', true, shows('gamma'));
is('...numbered where it really is', 3, numberOf('gamma'));

// REORDER INSIDE A TAB MOVES PAST THE HIDDEN ONE. This writes the shared order file the
// desk counts, so a single-step swap inside a filter would trade places with a card you
// cannot see: from the reader's side, nothing happened. The discriminator is the CURSOR —
// moving `gamma` up lands it beside `alpha` at index 0 and selects a card that is on
// screen, where a single step would select the hidden `beta` and leave nothing selected.
const selectedCard = () => app.all(n => n.className.split(/\s+/).includes('sel'))
  .map(n => n.textContent.replace(/\s+/g, ' '))[0] || '';
{
  const card = app.all(n => n.className.split(/\s+/).includes('card'))
    .find(t => /─ (?:\d+ )?gamma /.test(t.textContent.replace(/\s+/g, ' ')));
  const grip = card && card.find(n => n.className.split(/\s+/).includes('t'));
  is('the hidden-neighbour case is set up', true, !!grip);
  if (grip) {
    // THE REAL GESTURE: a drag by the title line, one row up. `reorder` is wired to the
    // pointer handlers and to nothing else — the phone has no ⇧hjkl — so firing anything
    // else here would be a test of a code path that does not exist.
    const ev = (y) => ({ clientX: 0, clientY: y, target: grip, pointerId: 1, preventDefault() {} });
    (card.listeners.pointerdown || []).forEach(f => f(ev(0)));
    (card.listeners.pointerup || []).forEach(f => f(ev(-card.getBoundingClientRect().height)));
    await tick(30);
  }
  is('...and the cursor lands on a card that is on screen', true, /alpha|gamma/.test(selectedCard()));
}
// A TAB THAT NO LONGER MATCHES ANYTHING. The projects file is edited between opens and a
// profile is free text, so the stored tab can name something that is simply not there any
// more — and the one thing this must never do is draw an empty screen over a fleet that
// has projects in it. Asserted as the OUTCOME rather than as the clamp, because the clamp
// on restore and the fallback in the filter are two defences for one promise.
click(tabBtn('demo'));
await tick(5);
is('parked on a tab that is about to disappear', true, shows('beta'));
fixtureOverride = { 'projects.json': fleetOf(['alpha', 'work'], ['gamma', 'work']) };
await reopenProjects(() => shows('alpha') && shows('gamma'));
is('a tab that matches nothing shows everything', true, shows('alpha') && shows('gamma'));
is('...rather than an empty screen', true, projectCards().length > 1);

// ...and hand the rest of this file back the fleet it was written against.
fixtureOverride = null;
await reopenProjects();
is('the shipped fleet is back', true, await until(() => shows('acme-api') && shows('scratch'), 4000));

// ── which CLI a project's master runs ────────────────────────────────────
// "the master cant be selected as open code or codex add that pls". The column has been
// readable for a while and nothing on a SCREEN could write it.
// cardTitled() is defined further down, for the GRID's cards; these are the projects
// screen's, whose text projectCards() already returns.
const projText = (name) => projectCards().find(t => t.includes(name)) || '';
const LONG_PRESS_MS = 600;     // cardEl's, in web/app.js — kept in step by the check below
// '+ add project' is a CARD, not a button — the same affordance a finger uses, and
// btnWith() cannot see it. tap() and cardTitled() are defined further down for the grid,
// so this is their projects-screen twin.
const projCardNode = (re) => app.all(n => n.className.split(/\s+/).includes('card'))
  .find(n => re.test(n.textContent.replace(/\s+/g, ' ')));
const tapCard = (n) => { if (!n) return false;
  (n.listeners.pointerdown || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 }));
  (n.listeners.pointerup || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 }));
  return true; };
const sheetNow = () => sheetHost.firstChild;
const sheetHas = (re) => { const s = sheetNow(); return !!s && re.test(s.textContent); };
// SCOPED TO THE SHEET. btnWith() searches #app and a sheet renders into #sheet, so it
// cannot see any of these — and every one of them would come back "button not found",
// which reads as the control being absent rather than as the finder looking in the wrong
// tree. The picker lives entirely inside a sheet, so nothing here can use btnWith.
const sBtn = (re) => { const s = sheetNow(); return s && s.find(n => n.tag === 'button' && re.test(n.textContent)); };
const sClick = (re) => { const b = sBtn(re); if (b) (b.listeners.click || []).forEach(f => f()); return !!b; };

// 1. AT CREATION TIME. The options come off the wire (`agents` on /api/projects, built
// from `fleet-agent list` filtered by `fleet-agent installed`), never from a list in the
// client — so a fourth agent appears here without app.js changing.
is('the add-project card is on screen', true, tapCard(projCardNode(/add project/)));
await tick(20);
is('the add sheet offers an agent', true, sheetHas(/master's agent/));
is('...with the default first, spelled out', true, !!sBtn(/claude \(default\)/));
is('...and the other installed agents', true, !!sBtn(/^opencode$/) && !!sBtn(/^codex$/));
// The default gives nothing up, so it must NOT carry a warning — a picker that warns
// about every option is one nobody reads.
is('...saying the default costs nothing', true, sheetHas(/nothing is given up/));
is('...and warning about neither yet', false, sheetHas(/no fleet events|no fleet_\* tools/));
// EACH OPTION CARRIES WHAT IT COSTS, and the two differ: opencode is visible to the
// fleet and cannot drive it; codex is neither. Shipping the option without saying so
// would be a silent footgun — the fleet reads as broken rather than as degraded.
sClick(/^codex$/);
await tick(5);
is('choosing codex says it is blind to events', true, sheetHas(/no fleet events/));
is('...and cannot call the fleet', true, sheetHas(/no fleet_\* tools/));
sClick(/^opencode$/);
await tick(5);
is('opencode says it cannot call the fleet', true, sheetHas(/no fleet_\* tools/));
is('...but is NOT called blind to events', false, sheetHas(/no fleet events/));
closeSheetFromTest();

// 2. AND AFTER, WHICH IS THE HALF THAT ANSWERS THE REQUEST. Every project Pablo has
// already exists, so a picker that only worked at creation time would not have helped.
// It lives with the other two per-project settings, which is where the TUI's `,` page
// keeps them.
const openProjSettings = () => click(btnWith(/,\s+settings/));
openProjSettings();
await tick(20);
is('project settings lists the agent', true, sheetHas(/which coding CLI/));
// THE RUNNING MASTER DOES NOT CHANGE, said at the point of change. CLAUDE_FLEET_AGENT is
// read once, when the tmux session is created; without this the setting reads as broken.
is('...and says it is the NEXT master', true, sheetHas(/NEXT master/));
// toolbox is `codex` in the fixture and acme-api has none — both directions on one screen.
is('...showing a project that has one', true, !!sBtn(/^codex$/));
is('...and claude for one that has not', true, !!sBtn(/^claude$/));
sClick(/^claude$/);            // acme-api's row: opens its own sheet
await tick(20);
is('a project opens its own agent sheet', true, sheetHas(/agent · /));
is('...repeating the next-master rule', true, sheetHas(/NEXT master/));
sClick(/^opencode$/);
await tick(5);
is('...and warns before you save', true, sheetHas(/no fleet_\* tools/));
// GATED ON BEING IN THE RIGHT SHEET. The projects settings sheet has a `save` of its own
// — the connection one, which re-points the whole client at a different backend — so an
// unguarded /^save$/ press after a control went missing did not fail, it changed the
// BACKEND, navigated off the projects screen, and surfaced three sections later as
// `box.scrollTop` on an undefined grid box.
const saveAgent = () => sheetHas(/agent · /) && sClick(/^save$/);
is('the save belongs to the agent sheet', true, saveAgent());
is('saving reports the change', true, await until(() => /will start its master as opencode/.test(app.textContent), 4000));
// ASSERTED ON THE CARD, not on client state: the card is what the request was about, and
// it is the only end of this that proves the write went all the way round — verb, refresh,
// payload, render. THE CARD SHOWS IT ONLY WHEN IT DIFFERS: the daemon normalises an empty
// 4th column to the word 'claude' before it goes on the wire, so a bare truthiness test
// printed "work · claude" on every card of a real fleet, hiding the one that differs.
is('...and the card names it beside the profile', true,
   await until(() => /work · opencode/.test(projText('acme-api')), 4000));
// ...and NOT when it is the default. THE DAEMON NORMALISES an empty 4th column to the
// literal word 'claude' before it goes on the wire (bin/fleet-serve.mjs), which the
// shipped fixture does not — it sends null — so a bare truthiness test in grid.js passed
// here for years while printing "work · claude" on every card of a REAL fleet, hiding the
// one project that differs. Reproduced with the wire's own shape rather than the
// fixture's, or this assertion proves nothing.
{
  const wire = fleetOf(['plain', 'work'], ['odd', 'work']);
  wire.projects[0].agent = 'claude';        // what the daemon sends for "no agent set"
  wire.projects[1].agent = 'codex';
  wire.agents = [{ name: 'claude', caveat: '' }, { name: 'codex', caveat: 'no fleet events' }];
  fixtureOverride = { 'projects.json': wire };
  await reopenProjects(() => projText('plain') && projText('odd'));
  is("the wire's 'claude' is not printed as a choice", false, /· claude/.test(projText('plain')));
  is('...while a real one still is', true, /work · codex/.test(projText('odd')));
  fixtureOverride = null;
  await reopenProjects();
  is('the shipped fleet is back for the rest', true, await until(() => shows('acme-api'), 4000));
}
// ...and CLEARING returns it to the default, which is the direction a picker that only
// ever sets would fail silently.
openProjSettings();
await tick(20);
sClick(/^opencode$/);          // acme-api's row now reads opencode
await tick(20);
sClick(/claude \(default\)/);
await tick(5);
is('the clear is saved from the agent sheet', true, saveAgent());
is('clearing reports the default', true, await until(() => /back to the default agent/.test(app.textContent), 4000));
await until(() => !/· opencode/.test(projText('acme-api')), 4000);
is('...and the card stops naming one', false, /· opencode/.test(projText('acme-api')));
is('...without falling back to the word claude', false, /· claude/.test(projText('acme-api')));
// LEAVE THE SCREEN AS THIS SECTION FOUND IT, whatever it found. If a control here goes
// missing, sClick() is a no-op and every step after it operates on a sheet that never
// opened — which ended, three sections later, as `box.scrollTop` on an undefined grid
// box: a crash that emits no rows at all, in place of the two or three reds that
// actually noticed. A red line has to point at its own subject.
let _g = 0; while (sheetNow() && _g++ < 5) closeSheetFromTest();
// PUT THE SELECTION BACK, because this section moved it. Tapping the '+ add project'
// card selects it (pointerdown → S.sel = its index), and the footer's `⏎ open` opens
// `projects[S.sel]` — which for the add card is undefined.
//
// A BARE POINTERDOWN IS NOT A SELECTION, IT IS A LONG-PRESS IN THE MAKING. That is what
// this used to be, and it armed cardEl's 600ms timer with no pointerup to clear it — so
// `S.confirm = {kind:'project'}` appeared half a second later, in the background, on a
// screen the test had already left. It then did two things, both silent and both far from
// here: pollPaused() returns true while a confirmation is up, so the indicator section's
// pollTick() became a no-op and its fixture switch never landed; and popTo() dismisses a
// confirmation INSTEAD of navigating, so the next back press was eaten and the voice
// section ran on the session screen. Seven assertions reporting "this device has no
// voices", from a finger that never lifted.
//
// The gesture that selects and does nothing else is down, a small move, up: the move is
// past MOVE_SLOP so cardEl clears the long-press timer, and under SWIPE so the pointerup
// is neither a tap nor a swipe. It is what a finger resting on a card and shifting does.
{
  const first = projCardNode(/acme-api/);
  if (first) {
    const ev = (x) => ({ clientX: x, clientY: 0, target: first, pointerId: 1 });
    (first.listeners.pointerdown || []).forEach(f => f(ev(0)));
    (first.listeners.pointermove || []).forEach(f => f(ev(20)));   // > MOVE_SLOP: disarms it
    (first.listeners.pointerup   || []).forEach(f => f(ev(20)));   // < SWIPE: acts on nothing
  }
}
// PROVEN, NOT ASSUMED, because the whole failure was that nothing here noticed. A
// confirmation armed by this block is invisible on the screen it fires on and only shows
// up as somebody else's red, three sections away.
//   PAST THE TIMER, DELIBERATELY. cardEl's long-press is 600ms, so an assertion made
// immediately outruns the very thing it is looking for — checked, and it did: with the
// bad gesture restored this line stayed green at full speed and only went red once the
// run was slow enough to still be here when the timer fired. A guard that depends on
// being slow is not a guard.
await tick(LONG_PRESS_MS + 100);
is('the long-press window this waited out is the app\'s', true,
   new RegExp('LONG_PRESS\\s*=\\s*' + LONG_PRESS_MS + '\\b').test(fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')));
is('...and armed no confirmation on the way out', false,
   !!app.find(n => n.className.split(/\s+/).includes('confirm')));
// The save above fires a refresh() this test does not await; let it land before the next
// section navigates, or its render arrives on top of a screen that has already moved on.
await until(() => !!btnWith(/⏎\s+open/), 4000);
await tick(50);

// ── the LEAD's card, and the three buttons that must not be on it ─────────
// docs/mobile.md §4: `master` is a card here because a phone is the only way to reach it,
// and the bug it fixes was reported as "it's not opening the main agent, just the
// sessions". Its card is the same five lines a worker's is — same box, same status line —
// so the only thing standing between the lead and `stop --reclaim` on this screen is that
// the button is not drawn.
//
// Driven, not asserted from the source: pwa-check reads the guard OUT of app.js, and a
// guard that is present in the file can still be bypassed by a second path into the same
// screen. This clicks through the real one.
// The projects list is fetched, so it is not on screen the instant the lock lifts —
// clicking `⏎ open` before it arrives opens nothing at all, silently.
is('the projects list arrives', true, await until(() => /acme-api/.test(app.textContent)));
// btn() splits "<key> <label>" into a <b> and a text node, and this DOM joins children
// with a space — so a footer button reads "⏎  open", with two. Every match below is
// whitespace-loose for that reason; a single-space regex silently matches nothing, and
// click(null) is a no-op that looks like a screen that did not change.
click(btnWith(/⏎\s+open/));                            // the first project — acme-api
await until(() => /master/.test(app.textContent), 4000);
is('the grid draws the lead as a card', true, /master/.test(app.textContent));
// The lead is card 1, so it is what the footer is aimed at on arrival — and that footer
// names which `x` means right now, exactly as the TUI's does, because finding out by
// pressing it costs a worktree. Over the lead it means nothing, and says so.
is('...selected first, with x disclaimed', true, !!btnWith(/not the lead/));
// Press it anyway: the confirmation must not open, and the refusal has to be VISIBLE.
// A guard that silently does nothing is a button that looks broken.
click(btnWith(/^x/));
is('...pressing x opens no kill prompt', false, /kill session 'master'/.test(app.textContent));
is('...and says why instead', true, /this fleet's lead/.test(app.textContent));
// ...and the summary above it counts the lead, which on the degraded fixture is the whole
// point: `counts` is a fold over the cards, and the lead is one of them.
// Open the lead by tapping its card. The card is a <div>, not a button, so this goes
// through the same tap handler a finger does.
// TITLED, which means the title LINE and not "the word appears somewhere in the card".
// A card's last message is part of its text, and master's is "Dispatched the retry work to
// api-fix" — so `cardTitled(/api-fix/)` matched MASTER, and every assertion below that
// believed it had opened the worker was quietly reading the lead's screen. It passed,
// because master has a transcript and a pane too. Anchored on the box-drawing title now,
// which is the only place a card's own name appears.
const cardTitled = (re) => app.find(n => {
  if (!n.className.split(/\s+/).includes('card')) return false;
  // Whitespace-collapsed, because a card is drawn one span per cell (ansi.js's rule, and
  // grid.js's `cells()`) and this DOM joins children with a space — so the title line
  // arrives here as "\u256d \u2500 2 api-fix \u2500 \u2500 \u2500".
  const t = n.textContent.replace(/\s+/g, ' ');
  return new RegExp('\u256d ?\u2500 (?:\\d+ )?' + re.source + ' ').test(t);
});

// ── where the reader was, across the 5s poll ──────────────────────────────
// "it also happens on the projects and session list, it suddenly goes to the top."
// refresh() ends in render(), render() empties #app and rebuilds it, and a fresh .cards
// element starts at scrollTop 0 — the chat and the pane each had their own memory and the
// card lists had none. Driven through renderUnlessTyping(), which is the poll's own render
// path, so this is the reported sequence and not an imitation of it.
//   BOTH DIRECTIONS, because "always restore something" and "never restore anything" are
// each passed by half of this: a list the reader moved must hold its place, and a list the
// reader never touched must stay where a fresh one naturally sits.
const scroller = () => app.kids.find(n => n.className.split(/\s+/).includes('cards'));
{
  const before = scroller();
  is('the grid card list is a scroller', true, !!before && before.scrollHeight > before.clientHeight);
  is('...and an untouched one sits at the top', 0, before ? before.scrollTop : -1);
  // A poll over a list nobody has scrolled must not invent a position either.
  appmod.renderUnlessTyping();
  await tick(5);
  is('...and a poll leaves it there', 0, (scroller() || {}).scrollTop);
  // Now the reader scrolls, and the poll rebuilds the node under them.
  const box = scroller();
  box.scrollTop = 200;
  await tick(5);
  is('the reader scrolls the card list', 200, box.scrollTop);
  appmod.renderUnlessTyping();
  await tick(5);
  const after = scroller();
  is('...the poll really did rebuild it', false, after === box);
  is('...and the reader is still at 200', 200, after ? after.scrollTop : -1);
  // A card vanishing under them must not throw them somewhere arbitrary. The cards are a
  // uniform five lines each, so a pixel offset IS a position in the list; when the list
  // gets SHORTER than the offset the browser clamps, and the reader lands at the end of
  // the list rather than at a number that no longer means anything.
  const tall = after.scrollHeight;
  after.scrollTop = tall;                       // park at the very bottom
  await tick(5);
  const parked = after.scrollTop;
  is('...parked at the bottom of the list', true, parked > 0);
  appmod.renderUnlessTyping();
  await tick(5);
  is('...and a poll keeps them there', parked, (scroller() || {}).scrollTop);

}

const tap = (n) => (n && (n.listeners.pointerdown || []).length
  ? ((n.listeners.pointerdown || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 })),
     (n.listeners.pointerup || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 })))
  : null);
tap(cardTitled(/master/));
await until(() => /the fleet's lead/.test(app.textContent), 4000);
is('tapping it opens its session screen', true, !!app.find(n => n.tag === 'textarea'));
is('...and it says it is the lead', true, /the fleet's lead/.test(app.textContent));

// ── the chat is what a tap lands on now ──────────────────────────────────
// The default moved from the pane (#45) to the chat, at the request of the person using
// it, and the pane's reason survives as the blocked banner rather than as the default.
is('...opening on the chat', true, await until(() => /anything blocked on me/.test(app.textContent), 4000));
is('...oldest first, newest last', true, (() => {
  const bubs = app.all(n => n.className.split(/\s+/).includes('bub')).map(n => n.textContent);
  return bubs.length >= 4 && /which workers are free/.test(bubs[0]) && /Dispatched the retry work/.test(bubs[bubs.length - 1]);
})());
// Two roles, drawn as two sides. A chat where both speakers look the same is the table
// this replaced.
is('...the user\'s turns are their own side', true,
   app.all(n => n.className.split(/\s+/).includes('user')).length >= 2);
is('...and the agent\'s are the other', true,
   app.all(n => n.className.split(/\s+/).includes('agent')).length >= 2);
// A composer, not a full-screen form: `send a prompt` used to be three taps and a screen
// change for the verb this app exists to use most.
// The absence half, on a session that is genuinely `ready` in the shipped fixture rather
// than one this file arranged — the paired presence check is further down, on api-fix.
is('...and a ready session shows no thinking indicator', false,
   !!app.find(n => n.className.split(/\s+/).includes('thinking')));
is('...with a composer in place of the prompt sheet', true, !!app.find(n => n.tag === 'textarea'));
is('...and a send button', true, !!btnWith(/^send$/));
is('...and the prompt sheet is gone', false, !!btnWith(/send a prompt/));

// THE POLL HAS TO STOP WHILE YOU ARE TYPING, and both directions matter: a guard that
// never pauses lowers the keyboard every five seconds, and one that never resumes leaves
// the grid frozen behind a box you touched once an hour ago. Reported live as "it hides
// the keyboard every time, I cannot type for more than five seconds" — refresh() ends in
// render(), render() empties #app, and the element the keyboard is attached to goes with it.
const boxNode = app.find(n => n.tag === 'textarea');
is('the poll runs when nothing is focused', false, appmod.pollPaused());
boxNode.focus();
is('...and pauses while the composer has focus', true, appmod.pollPaused());
boxNode.blur();
is('...and resumes when it loses focus', false, appmod.pollPaused());

// The 5s poll is not the only caller that rebuilds the screen: readPane()'s error
// transitions call render() on a 2s timer, so an unreachable daemon would close the
// keyboard mid-sentence even with the poll paused. Deferred, not dropped — the error still
// has to arrive, a moment later, or an offline pane would look like a working one.
boxNode.focus();
is('a render defers while you type', false, appmod.renderUnlessTyping());
is('...and is remembered, not dropped', true, appmod.renderWasDeferred());
boxNode.blur();
is('...and goes through once you stop', true, appmod.renderUnlessTyping());
// ONE region scrolls. The page itself must not, or a repaint every five seconds drops the
// reader wherever the browser lands — which is what "the screen moves around" was.
is('...inside the shell, not the page', true,
   (documentStub.documentElement.className || '').split(/\s+/).includes('shell'));
is('...and the chat is the scroller', true,
   !!app.find(n => n.className.split(/\s+/).includes('chat') && (n.listeners.scroll || []).length > 0));

// ── the pane, still one tap away, and now with a fixture for a LEAD ──────
// A real 269x65 capture — the widest pane on the fleet meeting the narrowest screen, which
// is the exact case "never wrapped, never reflowed" exists for and the one case that had no
// fixture. (One edit to it: the lead names its own checkout in its header and this capture
// came off the ghostfleet fleet, so the path says acme-api; byte length preserved.)
click(btnWith(/^pane$/));
// Matched on text inside ONE span: ansi.js opens a span per attribute run, so
// "Claude Code v2.1.235" is two of them and a regex spanning them never fires.
is('the pane view still opens', true, await until(() => /Claude Code/.test(app.textContent), 4000));
is('...naming its own checkout', true, /gf-demo\/acme-api/.test(app.textContent));
is('...and not an error or a placeholder', false,
   /no pane captured|capturing the pane…/.test(app.textContent));
click(btnWith(/^chat$/));
is('...and the chat comes back', true, await until(() => /anything blocked on me/.test(app.textContent), 4000));

// ── the composer actually sends, and the optimistic bubble is reconciled ──
// A chat where your own message vanishes for five seconds reads as a send that failed, so
// it is drawn immediately and dimmed. It is not TRUSTED, though: it is matched against
// what the transcript comes back with, or a send that silently went nowhere would sit
// there looking delivered forever.
const ta = app.find(n => n.tag === 'textarea');
ta.value = 'run the suite and report back';
(ta.listeners.input || []).forEach(f => f());
click(btnWith(/^send$/));
is('a sent message shows at once', true, await until(() =>
  !!app.find(n => n.className.split(/\s+/).includes('pending')), 4000));
is('...and the box is cleared', '', app.find(n => n.tag === 'textarea').value);
is('...then the transcript claims it', true, await until(() =>
  !app.find(n => n.className.split(/\s+/).includes('pending')), 8000));
is('...and it is still on screen, as a real turn', true,
   app.all(n => n.className.split(/\s+/).includes('bub')).some(n => /run the suite and report back/.test(n.textContent)));

// ── reading a message aloud, and the icon that does it ──────────────────
// MATCHED ON THE CLASS, NOT ON A GLYPH. This check used to be `btnWith(/🔊/)` and it went
// vacuous the moment the emoji became an SVG: an icon-only button has no text, so that
// regex could no longer match whether synthesis existed or not, and a check that can only
// pass proves nothing (CLAUDE.md). The class is what the control actually is.
const speakBtn = () => app.find(n => n.tag === 'button' && n.className.split(/\s+/).includes('speak'));
const tapBub = () => {
  const bubs = app.all(n => n.className.split(/\s+/).includes('bub'));
  const b = bubs[bubs.length - 1];
  if (b) (b.listeners.click || []).forEach(f => f({ target: b }));
  return !!b;
};
// A phone with no speech synthesis at all: the control must be ABSENT, not dead. This is
// the first half of the pair — until the stub below lands, canSpeak() is false.
//   IT TAPS A BUBBLE FIRST, and that is not ceremony. The speaker only exists on a bubble
// you tapped, so "no button on screen" is ALSO true of a synthesis-capable phone nobody
// has tapped yet — measured: with canSpeak() forced true, the untapped assertion stayed
// green. Tapping is what makes the row able to fail.
is('no bubble offers to be tapped without synthesis', false,
   !!app.find(n => n.className.split(/\s+/).includes('tappable')));
is('...and tapping one anyway reveals no speaker', false, (tapBub(), !!speakBtn()));

// ── and now WITH synthesis, which is the half that had no DOM test ───────
// Installed here rather than at the top so the absence above is a real measurement and not
// an ordering accident. Two voices in two languages, because the picker groups on `lang`.
const spoken = [];
const voiceList = [
  { name: 'Alex', lang: 'en-US', voiceURI: 'urn:alex', default: true },
  { name: 'Daniel', lang: 'en-GB', voiceURI: 'urn:daniel' },
  { name: 'Mónica', lang: 'es-ES', voiceURI: 'urn:monica' },
];
Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, writable: true, value: {
  getVoices: () => voiceList,
  speak: (u) => spoken.push(u.text),
  cancel: () => {},
  addEventListener: () => {},
} });
Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, writable: true,
  value: function SpeechSynthesisUtterance(t) { this.text = t; } });
const allVoicesReported = () => { try { return speechSynthesis.getVoices().length; } catch { return 0; } };
appmod.renderUnlessTyping();
// NOTHING IS SPOKEN BY THE TAP ITSELF, and nothing is offered before it: the control is
// revealed by tapping a bubble and belongs to that bubble only (see turn()).
is('with synthesis, a bubble offers to be tapped', true,
   !!app.find(n => n.className.split(/\s+/).includes('tappable')));
is('...but no speaker is on screen until one is tapped', false, !!speakBtn());
is('...tapped a bubble', true, tapBub());
is('...which reveals exactly one speaker', 1,
   app.all(n => n.tag === 'button' && n.className.split(/\s+/).includes('speak')).length);
is('...and speaks nothing by itself', 0, spoken.length);

// THE ICON, AND THE ONE PROPERTY THIS CONTROL KEEPS LOSING. It was 🔊 idle / ■ playing —
// two typefaces, two weights, three times the size — so a tap read as a different button
// appearing. Both states are asserted to be the SAME drawing with one path swapped, which
// is the shape that cannot regress into that.
const idle = speakBtn();
const svgOf = (b) => (b && b.kids.find(k => k.tag === 'svg')) || null;
const pathsOf = (b) => { const s2 = svgOf(b); return s2 ? s2.kids.filter(k => k.tag === 'path').map(k => k.attrs.d) : []; };
is('the speaker is an inline svg', 'svg', (svgOf(idle) || {}).tag);
is('...in the svg namespace, not a div called svg', 'http://www.w3.org/2000/svg', (svgOf(idle) || {}).ns);
is('...stroked in currentColor, so it is the button\'s colour', 'currentColor', (svgOf(idle) || { attrs: {} }).attrs.stroke);
is('...and filled with nothing, so weight is the stroke only', 'none', (svgOf(idle) || { attrs: {} }).attrs.fill);
// An icon contributes no text. That is the whole reason the label below is mandatory.
is('...and contributes no text of its own', '', (idle ? idle.textContent : 'x').trim());
is('...so the aria-label is its only name', true, /read this message aloud/.test((idle || { attrs: {} }).attrs['aria-label'] || ''));
is('...and the state is in aria-pressed, not only in the drawing', 'false',
   (idle || { attrs: {} }).attrs['aria-pressed']);
const idleBox = (svgOf(idle) || { attrs: {} }).attrs.viewBox;
const idleWidth = (svgOf(idle) || { attrs: {} }).attrs['stroke-width'];
const idlePaths = pathsOf(idle);
is('...drawn from a viewBox', true, !!idleBox);
is('...as two strokes: the horn and one decoration', 2, idlePaths.length);

// Press it. Same button, pressed — not a different button.
click(idle);
const on = speakBtn();
is('pressing it speaks', 1, spoken.length);
is('...and lights the same control', true, !!on && on.className.split(/\s+/).includes('on'));
is('...whose label now says how to stop it', true, /stop reading this message aloud/.test((on || { attrs: {} }).attrs['aria-label'] || ''));
is('...and whose aria-pressed flipped', 'true', (on || { attrs: {} }).attrs['aria-pressed']);
// THE FOUR ROWS THIS SECTION EXISTS FOR.
is('the pressed state uses the SAME viewBox', idleBox, (svgOf(on) || { attrs: {} }).attrs.viewBox);
is('...the SAME stroke width', idleWidth, (svgOf(on) || { attrs: {} }).attrs['stroke-width']);
is('...the same amount of ink: two strokes again', 2, pathsOf(on).length);
is('...the identical horn, so only the decoration changed', idlePaths[0], pathsOf(on)[0]);
is('...and the decoration DID change', true, !!pathsOf(on)[1] && pathsOf(on)[1] !== idlePaths[1]);
// Pressing it again is a stop, on the control that was lit — not a second utterance.
click(on);
is('pressing the lit one stops it', false,
   !!(speakBtn() || { className: '' }).className.split(/\s+/).includes('on'));
is('...without speaking again', 1, spoken.length);

// ── the ten buttons are one sheet now ───────────────────────────────────
is('the verb wall is gone', false, !!btnWith(/answer keys/));
click(btnWith(/⋯/));
const acts = sheetHost.firstChild;
is('⋯ opens the actions sheet', true, !!acts);
is('...with answer keys, the unblock verb', true, !!acts && /answer keys/.test(acts.textContent));
is('...and sched and label', true, !!acts && /sched/.test(acts.textContent) && /label/.test(acts.textContent));
// The lead's three refusals are absent HERE too — the sheet is not a way around them.
is('...and no kill for the lead', false, !!acts && /x  kill/.test(acts.textContent));
is('...no reclaim either', false, !!acts && /reclaim worktree/.test(acts.textContent));
is('...nor rename', false, !!acts && /r\s+rename/.test(acts.textContent));
is('...nor pause', false, !!acts && /p  pause/.test(acts.textContent));
is('...and it says why', true, !!acts && /cannot be stopped, reclaimed, renamed or paused/.test(acts.textContent));
closeSheetFromTest();

// ── the back gesture, which had nothing to pop before ───────────────────
// Two forward moves were made to get here (project, then session), so there are two of our
// entries on the stack and the system gesture has somewhere to go. No URL was ever set:
// every push reuses the current href.
is('navigating pushed history entries', 2, histDepth);
is('...and none of them set a url', true, histPushedUrls.every(u => u === location.href));
// The gesture itself. popstate is the ONLY path backwards, so this is exactly what a swipe
// does — not a second code path that happens to agree.
swipeBack();
is('the gesture goes back to the grid', true, await until(() => !!btnWith(/n\s+new/), 4000));
is('...and not out of the app', true, /master/.test(app.textContent));
swipeBack();
is('...then to projects', true, await until(() => /— projects/.test(app.textContent), 4000));
// At the root there is nothing of ours left, so the platform gets it — which is what
// closing the app should do, and what the old code did on the FIRST back from anywhere.
is('...and the stack is unwound', 0, histDepth);

// ── THE OTHER DIRECTION: a worker keeps all of it ───────────────────────
click(btnWith(/⏎\s+open/));
is('a project opens again', true, await until(() => !!cardTitled(/api-fix/), 4000));
tap(cardTitled(/api-fix/));
await until(() => !!app.find(n => n.tag === 'textarea'), 4000);
is('a worker says nothing about a lead', false, /the fleet's lead/.test(app.textContent));
click(btnWith(/⋯/));
const wacts = sheetHost.firstChild;
is('a worker keeps kill', true, !!wacts && /kill/.test(wacts.textContent));
is('...and stop + reclaim', true, !!wacts && /reclaim worktree/.test(wacts.textContent));
is('...and rename', true, !!wacts && /rename/.test(wacts.textContent));
is('...and pause', true, !!wacts && /pause/.test(wacts.textContent));
closeSheetFromTest();

// ── the banner that pays for the new default ────────────────────────────
// A ready session must NOT be shouted at, and a blocked one must be — the pair is the
// test, because a banner that is always there says nothing and one that never fires is
// indistinguishable from a missing feature. The degraded fixture is the fleet whose LEAD is
// need-you, which is the case a phone exists to catch.
is('a ready session has no banner', false, !!app.find(n => n.className.split(/\s+/).includes('blocked')));
// The overlay records what THIS run did to the fleet, and this run sent master a message
// a moment ago — which set it working. Reset it, or the status being asserted below is the
// test's own footprint rather than the fixture's.
api.resetOverlay();
api.setFixtureName('grid-degraded.json');
click(btnWith(/‹/));
is('back to the grid', true, await until(() => !!btnWith(/n\s+new/), 4000));
await until(() => {
  const c = cardTitled(/master/);
  return c && /NEEDS YOU/.test(c.textContent);
}, 5000);
tap(cardTitled(/master/));
is('a blocked session says so', true, await until(() =>
  !!app.find(n => n.className.split(/\s+/).includes('blocked')), 4000));
is('...naming what a transcript cannot show', true, /a transcript cannot show one/.test(app.textContent));
// ...and the button goes where the answer has to be typed. This is the whole seam between
// the two views: the chat is the better place to read, the pane the only place to unblock.
click(btnWith(/open the pane/));
is('...and it opens the pane', true, await until(() => /Claude Code/.test(app.textContent), 4000));

// ── "load 20 older" must not throw the reader anywhere ────────────────────
// The button exists for exactly one reason, in its own words: "a page prepended above them
// would otherwise throw them to the top of a conversation they were reading the middle of."
// It did precisely that. `chatScroll` was replaced with a hand-built `{ keepFromEnd: true }`
// carrying no `fromEnd`, so the restore computed `scrollHeight - undefined` = NaN, and the
// DOM lands NaN on 0. Confirmed in Chrome before the fix: press it and scrollTop is 0.
//   THE INVARIANT IS THE DISTANCE FROM THE END, not the offset: everything below the reader
// is unchanged by a prepend, everything above it moves. Asserted as that distance, so it
// cannot be satisfied by 0 (the top, the old bug) or by the bottom (the other direction,
// which is what defaulting fromEnd to 0 would silently do).

const chatBox = () => app.kids.find(n => n.className.split(/\s+/).includes('chat'));

// api-fix, not the lead: master's transcript is five messages and fits on one screen, so
// there is no page above it and nothing for this to press.
click(btnWith(/‹/));
is('back on the grid for the scroll checks', true, await until(() => !!btnWith(/n\s+new/), 4000));
tap(cardTitled(/api-fix/));
is('...and api-fix opens', true, await until(() => !!chatBox(), 4000));
await until(() => { const b = chatBox(); return !!b && b.scrollHeight > b.clientHeight; }, 4000);
{
  const box = chatBox();
  is('the chat is a scroller', true, !!box && box.scrollHeight > box.clientHeight);
  is('...and a chat opens at the newest message', true, !!box && box.scrollTop === box.scrollHeight - box.clientHeight);
  // The reader goes up to the middle and presses the button at the ceiling.
  box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 3);
  await tick(5);
  const fromEndBefore = box.scrollHeight - box.scrollTop;
  is('the reader scrolls up', true, box.scrollTop > 0);
  const older = btnWith(/load \d+ older/);
  is('...and there is a page above them to load', true, !!older);
  click(older);
  is('...the page arrives', true, await until(() => { const b = chatBox(); return !!b && b.scrollHeight > box.scrollHeight; }, 4000));
  await tick(5);
  const now = chatBox();
  is('...and the reader is held where they were', fromEndBefore, now.scrollHeight - now.scrollTop);
  is('...not thrown to the top', true, now.scrollTop > 0);
  is('...and not to the bottom', false, now.scrollTop === now.scrollHeight - now.clientHeight);
  // ...and the other direction, which is the behaviour that must NOT be lost: a reader who
  // is at the newest message stays at the newest message when a new one arrives.
  now.scrollTop = now.scrollHeight;
  await tick(5);
  appmod.renderUnlessTyping();
  await tick(5);
  const after = chatBox();
  is('a reader at the end stays at the end', true, after.scrollTop === after.scrollHeight - after.clientHeight);
}

// ── "it is working on it" ────────────────────────────────────────────────
// A sent prompt used to go quiet: the pending bubble clears the moment the transcript
// echoes it, and from there to the answer landing the screen said nothing at all. The
// indicator mirrors the card status the poll already delivers, so the two directions here
// are the feature rather than decoration — one that always rendered would look identical
// to this one on the very screen that motivated it.
//
// THE FIXTURE HAS TO BE PUT BACK FIRST. The section above left the DEGRADED fleet
// selected, where api-fix is need-you, and the overlay still carries what this run did to
// the fleet — so without both of these the status under test would be the test's own
// footprint and the indicator would be absent for a reason that has nothing to do with it.
api.resetOverlay();
api.setFixtureName('grid-acme-api.json');
await pollTick();
is('the busy fleet is back, with api-fix working', true,
   await until(() => !app.find(n => n.className.split(/\s+/).includes('blocked')), 4000));

// The same fixture with ONE field changed, so working and ready differ in nothing else: a
// second hand-written grid would let some other difference do the work.
const readyGrid = JSON.parse(fs.readFileSync(new URL('../../web/fixtures/grid-acme-api.json', import.meta.url), 'utf8'));
for (const c of readyGrid.cards) if (c.name === 'api-fix') c.status = 'ready';

const thinkingNode = () => app.find(n => n.className.split(/\s+/).includes('thinking'));
// EVERY READ OF IT GOES THROUGH THESE. A client that stopped drawing the indicator at all
// makes thinkingNode() null, and a bare `.className` on that throws — which ends the whole
// helper, emits zero rows, and reports as "pwa-render ran: 1" rather than as the two
// assertions that actually noticed. A red line has to point at its own subject.
const tHas = (c) => (thinkingNode() || { className: '' }).className.split(/\s+/).includes(c);
// THE WHOLE SUBTREE, not the wrapper. "Style it as an agent turn" is one `turn()` call
// away from nesting a real .bub inside this, which would leave the wrapper's own class
// list looking innocent while the bubble it contains collects a play control and becomes
// the last message in the list.
const tSub = (c) => { const t = thinkingNode(); if (!t) return false;
  return t.className.split(/\s+/).includes(c) || !!t.find(n => n.className.split(/\s+/).includes(c)); };
const tText = () => (thinkingNode() || { textContent: '' }).textContent.replace(/\s+/g, '');
const tButtons = () => (thinkingNode() || { all: () => [] }).all(n => n.tag === 'button').length;
const chatKids = () => (chatBox() || { kids: [] }).kids;
const bubs = () => app.all(n => n.className.split(/\s+/).includes('bub'));

is('a working session draws a thinking indicator', true, !!thinkingNode());
is('...at the end of the transcript', true, (() => {
  const k = chatKids(); return k.length > 0 && k[k.length - 1].className.split(/\s+/).includes('thinking');
})());
is('...on the agent side, where the answer will appear', true, tHas('them'));
// Real characters, which is also what makes the reduced-motion form legible: app.css only
// stops the dots moving, and text that was never there could not go static.
is('...with dots that are real text', '...', tText());
is('...and exactly one of it, not one per render', 1,
   chatKids().filter(n => n.className.split(/\s+/).includes('thinking')).length);

// IT IS NOT A MESSAGE. Everything that reads the tail of this list as content has to miss
// it — the card's preview line, reconcilePending, read-aloud. It carries no `bub`, so even
// a query written later cannot mistake it for one.
is('...it is not a bubble, at any depth', false, tSub('bub'));
is('...so the last bubble is still the last real message', true,
   /Running the full suite before I touch the migration/.test(bubs()[bubs().length - 1].textContent));

// NOT SPEAKABLE, ASSERTED WITH SYNTHESIS PRESENT — which it already is. This block used to
// install its own stub here, with the note that "until here the harness has none". That is
// no longer where the line falls: the read-aloud section above runs its no-synthesis pair
// and then installs a stub, so the premise this needs — that the indicator is measured on a
// client which CAN speak, or "the indicator has no play control" passes for the wrong reason
// — is satisfied before this point. A second install would have replaced that stub with an
// empty-voiced one and taken the voice-count rows at the end of this file down with it
// (measured: four of them red, for a reason that has nothing to do with the indicator).
// One stub, installed once, is the whole fix.
is('the indicator is measured on a client that can speak', true,
   typeof speechSynthesis !== 'undefined' && allVoicesReported() > 0);
appmod.renderUnlessTyping();
await tick(5);
const lastAgentBub = () => bubs().filter(n => n.className.split(/\s+/).includes('agent')).pop();
is('with synthesis, a real agent turn is tappable', true,
   lastAgentBub().className.split(/\s+/).includes('tappable'));
is('...and nothing in the indicator is', false, tSub('tappable'));
// A bubble's handler reads e.target (a tap on a link inside it must not toggle the
// control), so it needs a real event — `click()` above fires with none, which is fine for
// a button and is not for this.
const tapBubble = (n) => (n.listeners.click || []).forEach(f => f({ target: n }));
tapBubble(lastAgentBub());
await tick(5);
// MATCHED ON THE CLASS. These two read `btnWith(/🔊/)` and a count of buttons whose text is
// /🔊|🔇/, which the SVG control cannot satisfy in either direction — an icon-only button
// has no text at all. Both went red on the rebase rather than quietly vacuous, which is the
// good version of this, but the claim they make is about the control existing and being
// unique, not about which glyph it wears.
is('...tapping a real turn reveals a play control', true, !!speakBtn());
is('...exactly one, on the turn that was tapped', 1,
   app.all(n => n.tag === 'button' && n.className.split(/\s+/).includes('speak')).length);
is('...and never on the indicator', 0, tButtons());
// WHERE IT LANDS, with the indicator on screen. The control belongs to the meta row of the
// turn you tapped; the indicator is a sibling at the end of the same list, so "it is in the
// list somewhere" is not the same claim as "it is in that turn". Both are asserted, because
// a control that drifted to the end would look correct in a screenshot of one message.
const turnsWithSpeaker = () => app.all(n => n.className.split(/\s+/).includes('turn'))
  .filter(t => !!t.find(n => n.tag === 'button' && n.className.split(/\s+/).includes('speak')));
is('...inside one turn, next to that turn\'s own bubble', true,
   turnsWithSpeaker().length === 1 && !!turnsWithSpeaker()[0].find(n => n.className.split(/\s+/).includes('bub')));
is('...and the indicator is still the last thing in the list', true, (() => {
  const k = chatKids(); return k.length > 0 && k[k.length - 1].className.split(/\s+/).includes('thinking');
})());

// ── and it must not yank the reader, appearing OR vanishing ──────────────
// #72 gave this list scroll memory precisely so a poll that rebuilds it moves nobody. A
// node arriving and leaving at the END is the height change that fights it, so both edges
// are measured — and the HEIGHT is asserted at each, because a transition that did not
// actually change the box would make the position assertion say nothing at all.
{
  const box = chatBox();
  box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 3);
  await tick(5);
  const parkedAt = box.scrollTop, tallWith = box.scrollHeight;
  is('the reader parks mid-conversation', true, parkedAt > 0);

  // The session stops working under them. Delivered by app.js's OWN 5s poll body rather
  // than a re-render this test arranged, so what clears the indicator is the real path.
  fixtureOverride = { 'grid-acme-api.json': readyGrid };
  await pollTick();
  is('the indicator goes when the session stops working', true,
     await until(() => !thinkingNode(), 4000));
  await tick(5);
  // The revealed control is drawn from S.speakSel on every render, and the renders that
  // add and remove the indicator are renders like any other — so the tapped turn must
  // still have its speaker, and still only one, on both edges.
  is('...and the tapped turn keeps its speaker', 1, turnsWithSpeaker().length);
  const gone = chatBox();
  is('...and the list really did get shorter', true, gone.scrollHeight < tallWith);
  is('...and the reader has not moved', parkedAt, gone.scrollTop);

  // ...and back, which is the edge a reader actually hits: an answer lands, the next
  // prompt goes, and the indicator returns underneath them.
  fixtureOverride = null;
  await pollTick();
  is('the indicator comes back when work resumes', true, await until(() => !!thinkingNode(), 4000));
  await tick(5);
  is('...and the speaker is still on that turn, not on the indicator', '1,0',
     [turnsWithSpeaker().length, tButtons()].join(','));
  const back = chatBox();
  is('...and the list is taller again', tallWith, back.scrollHeight);
  is('...and the reader STILL has not moved', parkedAt, back.scrollTop);

  // The other direction of the scroll rule, which has to survive both edges too: a reader
  // who is following along at the newest message keeps following.
  back.scrollTop = back.scrollHeight;
  await tick(5);
  fixtureOverride = { 'grid-acme-api.json': readyGrid };
  await pollTick();
  await until(() => !thinkingNode(), 4000);
  await tick(5);
  const end = chatBox();
  is('a reader at the end is still at the end', true,
     end.scrollTop === end.scrollHeight - end.clientHeight);
  fixtureOverride = null;
}
// ── the voice picker REPORTS what the device gave it ─────────────────────
// AT THE END, AND ON THE GRID, because `, settings` is a verb of the grid and the projects
// screen — the session screen has no settings button, so the sheet cannot be opened from
// the chat this section used to sit in.
// ASSERTED, because everything below depends on it and nothing here said so. The `,
// settings` button is a verb of the GRID; if this navigation has not landed, click(null)
// is a no-op, sheetHost stays empty, and all seven voice assertions report an empty list
// — which reads as "this device has no voices". Seen exactly that way on a macos-latest
// runner while ubuntu passed the same commit. The `got` names the screen it is really on,
// so the next failure does not need a second CI run to explain itself.
click(btnWith(/‹/));
is('back on the grid for the voice checks', 'grid', await until(() => !!btnWith(/n\s+new/), 8000)
   ? 'grid' : String(app.textContent).replace(/\s+/g, ' ').slice(0, 60));
// "I only see the default voice" and "the list never populated" are the same screen from
// the outside and have different causes, so the count is on it. Asserted through the real
// sheet because the count is the only diagnostic a phone with no console can quote back.
//   IT READS THE SAME STUB the read-aloud section installed, which is why nothing between
// here and there may install a second one — see the indicator section.
// ONE WAY TO OPEN THIS SHEET, and it waits. On the GRID screen sheetSettings() awaits
// api.getSettings() before it renders anything, so a fixed tick is a race against an HTTP
// round-trip to the daemon — and when it lost, every assertion below reported an empty
// voice list, which reads as "this device has no voices" rather than as "the sheet had not
// been drawn yet". #88 fixed the first of the two copies of that fixed tick and left the
// second, which is why `one voice is counted as one` outlived the fix. One helper now.
//   IT STILL RETURNS THE SHEET WHEN THE PICKER NEVER COMES. The wait is for a picker that
// is on its way, not a precondition — a version that skipped the assertions when it timed
// out would turn "this build has no voice picker" into a green run.
const openVoiceSheet = async () => {
  click(btnWith(/settings/));
  await until(() => { const v = sheetHost.firstChild;
                      return !!v && v.find(n => n.tag === 'select' && /vpick/.test(n.className)); }, 8000);
  return sheetHost.firstChild;
};
const vset = await openVoiceSheet();
is('settings offers a voice picker', true, !!vset && !!vset.find(n => n.tag === 'select' && /vpick/.test(n.className)));
is('...and says how many voices this device reported', true, !!vset && /3 voices reported by this device/.test(vset.textContent));
is('...and in how many languages', true, !!vset && /in 3 languages/.test(vset.textContent));
is('...grouped by lang, so a populated list is legible', 'en-GB,en-US,es-ES',
   !vset ? '' : vset.all(n => n.tag === 'optgroup').map(g => g.attrs.label).join(','));
is('...with the voice names inside the groups', true, !!vset &&
   vset.all(n => n.tag === 'optgroup').some(g => g.kids.some(o => o.textContent === 'Mónica')));
// THREE voices is a normal list, so the unverified iOS hint must NOT be on screen. This is
// the direction that catches a hint pinned on unconditionally — which would be a guess
// presented as a diagnosis on every device.
is('...and no iOS suggestion when the list is populated', false, !!vset && /Spoken Content/.test(vset.textContent));
closeSheetFromTest();

// The other direction: one voice, which is what the phone reports. The count says one and
// the suggestion appears — worded as a guess, because nobody here has measured it.
voiceList.length = 1;
const vone = await openVoiceSheet();
is('one voice is counted as one', true, !!vone && /1 voice reported by this device/.test(vone.textContent));
is('...not pluralised, and no language count for one group', false, !!vone && /1 voices|in 1 languages/.test(vone.textContent));
is('...and the iOS path is offered', true, !!vone && /Settings → Accessibility → Spoken Content → Voices/.test(vone.textContent));
is('...as a guess and not a promise', true, !!vone && /That is a guess, not a fix/.test(vone.textContent));
closeSheetFromTest();

console.log(rows.join('\n'));
