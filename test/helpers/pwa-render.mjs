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
class Node_ {
  constructor(tag) {
    this.tag = tag; this.kids = []; this.attrs = {}; this.listeners = {};
    this.className = ''; this._text = null; this.value = ''; this.checked = false;
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
  append(...ks) { for (const k of ks) if (k != null) this.kids.push(k); }
  appendChild(k) { this.kids.push(k); return k; }
  remove() {}
  focus() { this.focused = true; }
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
  createTextNode: (t) => { const n = new Node_('#text'); n.textContent = t; return n; },
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
const stored = new Map();
for (const [name, value] of [
  ['localStorage', {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  }],
  ['document', documentStub],
  // available() wants these two; the ceremony behind the buttons is pwa-enrol.mjs's job,
  // and this file stops at the sheet rather than touching navigator.credentials.
  ['window', { isSecureContext: true, PublicKeyCredential: function PublicKeyCredential() {} }],
  ['navigator', {}],
  ['addEventListener', () => {}],
  // app.js polls every 5s; left real, the process would never exit.
  ['setInterval', () => 0],
]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// FIXTURE MODE HAS TO BE ABLE TO READ ITS FIXTURES. api.js fetches them as
// `./fixtures/<file>` — a relative URL, which in a browser resolves against the page and
// here resolves against nothing ("Failed to parse URL"). So the shipped files are served
// off disk, and only those: anything else falls through to the real fetch, which is what
// the origin probe and every server-mode request still use.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const m = /^\.\/fixtures\/([A-Za-z0-9._-]+)$/.exec(String(url));
  if (!m) return realFetch(url, opts);
  const file = new URL(`../../web/fixtures/${m[1]}`, import.meta.url);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); }
  catch { return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); }
  return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(body) });
};

const U = BASE ? new URL(BASE) : null;
globalThis.location = U ? { origin: U.origin, protocol: U.protocol, host: U.host, hostname: U.hostname }
                       : { origin: 'null', protocol: 'file:', host: '', hostname: '' };

const api = await import(new URL('../../web/api.js', import.meta.url).href);
is('a live fleet-serve base was given', true, !!BASE);

// ── it boots at all ───────────────────────────────────────────────────────
// The import IS the test: app.js's last block runs restore(), fitCards(), render() and
// the probe. A ReferenceError anywhere in it lands here instead of on a phone.
let bootError = '';
try { await import(new URL('../../web/app.js', import.meta.url).href); }
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
// Null-safe on purpose: a button that is not there has to come out as a red ROW from the
// assertion above it, not as a dead helper that emits nothing at all.
const click = (n) => (n && (n.listeners.click || []).map(f => f())[0]);

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
globalThis.location = { origin: 'http://127.0.0.1:1', protocol: 'http:', host: '127.0.0.1:1', hostname: '127.0.0.1' };
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
is('the projects list arrives', true, await until(() => /superkey/.test(app.textContent)));
// btn() splits "<key> <label>" into a <b> and a text node, and this DOM joins children
// with a space — so a footer button reads "⏎  open", with two. Every match below is
// whitespace-loose for that reason; a single-space regex silently matches nothing, and
// click(null) is a no-op that looks like a screen that did not change.
click(btnWith(/⏎\s+open/));                            // the first project — superkey
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
const cardTitled = (re) => app.find(n => n.className.split(/\s+/).includes('card') && re.test(n.textContent));
const tap = (n) => (n && (n.listeners.pointerdown || []).length
  ? ((n.listeners.pointerdown || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 })),
     (n.listeners.pointerup || []).forEach(f => f({ clientX: 0, clientY: 0, target: n, pointerId: 1 })))
  : null);
tap(cardTitled(/master/));
await until(() => /the fleet's lead/.test(app.textContent), 4000);
is('tapping it opens its session screen', true, !!btnWith(/send a prompt/));
is('...and it says it is the lead', true, /the fleet's lead/.test(app.textContent));
// THE PANE IS WHAT A TAP LANDS ON (§7a), and until this fixture existed nobody had ever
// rendered a LEAD's. It is a real 269x65 capture — the widest pane on the fleet going to
// the narrowest screen, which is the exact case "never wrapped, never reflowed" exists
// for. (One edit to the capture: the lead names its own checkout in its header, and this
// one came off the ghostfleet fleet, so the path says superkey. Byte-length preserved.)
// Matched on text that lives INSIDE one span: ansi.js opens a new span per attribute run,
// so "Claude Code v2.1.235" is two spans and a regex spanning them silently never fires.
is('...the lead pane renders', true, await until(() => /Claude Code/.test(app.textContent), 4000));
// ...and it is THIS lead's pane: the header names the checkout, which is the one thing in
// the capture that identifies whose screen it is.
is('...naming its own checkout', true, /Documents\/superkey/.test(app.textContent));
is('...and not as an error or a placeholder', false,
   /no pane captured|capturing the pane…/.test(app.textContent));
// Both views work for a lead, which needed a transcript fixture too — without one the
// messages tap 404s into "reading the transcript…" and the lead is half-openable.
click(btnWith(/^messages$/));
is('...its transcript opens too', true, await until(() => /anything blocked on me/.test(app.textContent), 4000));
click(btnWith(/^pane$/));
// The geometry label LAGS by one paint on purpose — it is a node the poll updates without
// redrawing the screen under a reader — so it is asserted after coming back to the pane
// rather than on the first render, where it is legitimately empty.
is('...and the pane reports its real size', true, await until(() => /269×65/.test(app.textContent), 4000));
// The verbs that mean something for a lead are all still there.
is('...keeps send a prompt', true, !!btnWith(/send a prompt/));
is('...keeps answer keys', true, !!btnWith(/answer keys/));
// ...and NOT pause. Parking the lead turns off the session that dispatches work and
// drains fleet-inbox; the governor already excludes master from what it parks, plan()
// refuses it, and on the grid it was one careless swipe on the FIRST card. Resume stays
// reachable everywhere — the recovery direction is never guarded — it is simply not drawn
// here while the lead is running.
is('...has no pause button', false, !!btnWith(/\bp\s+pause/));
// ...and the three the server refuses are NOT.
is('...has no kill button', false, !!btnWith(/x\s+kill/));
is('...no stop \u002b reclaim', false, !!btnWith(/reclaim worktree/));
is('...and no rename', false, !!btnWith(/r\s+rename/));
// THE OTHER DIRECTION, or a screen that drew no buttons at all would pass all three.
click(btnWith(/q\s+back/));
await until(() => !!btnWith(/n\s+new/), 4000);
tap(cardTitled(/coi-beside/));
await until(() => !!btnWith(/x\s+kill/), 4000);
is('a worker keeps its pause button', true, !!btnWith(/\bp\s+pause/));
is('a worker keeps its kill button', true, !!btnWith(/x\s+kill/));
is('...and its stop + reclaim', true, !!btnWith(/reclaim worktree/));
is('...and its rename', true, !!btnWith(/r\s+rename/));
is('...and says nothing about a lead', false, /the fleet's lead/.test(app.textContent));

console.log(rows.join('\n'));
