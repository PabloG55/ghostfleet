// web/ui/history.js — one history for every way back: the app's back button, the browser's, a
// phone's back swipe and the desk's back keys. Framework-free, as keys.js is, so the phone
// client can take it too.
//
// Back used to go to a fixed parent. A session's ← went to its project page whatever screen had
// opened it, so a session opened from the live map came back to a project page the person had
// never been on, while the browser's back went to the map: two backs, two answers.
//
// Every entry the app makes or meets is stamped in history.state.gfEntry with `{ id, from }`.
// `from` is the route of the entry before it, the screen the person came from; it is null when
// there is none in this app (a link opened in a new tab, a pasted address). The phone client
// counts its depth in history.state.gf, a key of its own, so neither reads the other's. Then:
//   back(parent)  steps back one entry, which is exactly the browser's back, when there is a
//                 screen to go back to; otherwise it REPLACES this entry with `parent`, the
//                 screen's logical parent. Replaced and not pushed, so the browser's back from
//                 there leaves the app instead of landing on the deep link again.
//   go(to)        pushes an entry, and does nothing when `to` is where the person already is,
//                 so back never takes two presses. `{ replace: true }` is for a screen that is
//                 gone or was only a step on the way (a renamed session, the project page the
//                 jump chord passes through): it keeps the entry's `from`.
// history.state survives a reload, so a reloaded screen still knows where it came from and its
// back still agrees with the browser's.
//
// A screen comes back as it was. What it was is kept per entry, in memory and mirrored to
// sessionStorage for a reload: the scroll of `.main` and of every element marked
// data-keep-scroll="<name>", and whatever a screen keeps with kept()/setKept() (useKept in
// back.jsx). A new entry starts at the top.

const KEY = 'gf.history';
const MAX = 80;                 // entries remembered; the oldest go first
const SETTLE = 400;             // ms a restored scroll is held while late content lands
const GIVE_UP = 2000;           // ms to wait for content tall enough to scroll back into

let started = false;
let cur = null;                 // this entry's stamp, { id, from }
let here = '#/';                // its route
let pending = null;             // the id go() just stamped, so arrive() knows it is new
let store = new Map();          // id → { scroll: { name: { top, end } }, state: { key: value } }
let restoring = null;
let saveTimer = 0;
const subs = new Set();

const route = (to) => '/' + String(to ?? '').replace(/^#?\/?/, '');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const stampOf = () => { try { const s = history.state?.gfEntry; return s?.id ? s : null; } catch { return null; } };
function stamp(st) {
  try { history.replaceState({ ...(history.state || {}), gfEntry: st }, ''); } catch { /* rate-limited: the entry keeps no stamp */ }
}
function rec(id) {
  let r = store.get(id);
  if (!r) {
    r = { scroll: {}, state: {} };
    store.set(id, r);
    while (store.size > MAX) store.delete(store.keys().next().value);
  }
  return r;
}
function flush() {
  clearTimeout(saveTimer); saveTimer = 0;
  try { sessionStorage.setItem(KEY, JSON.stringify([...store])); } catch { /* private mode: memory only */ }
}
const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(flush, 300); };

const nameOf = (el) => (el?.classList?.contains('main') ? 'main' : el?.dataset?.keepScroll || null);
// `end` only on a box that can scroll. A screen still loading is too short to, and the page
// before it clamping to it fires a scroll there: counted as "at its end", a project page left at
// its top came back at its bottom, 296 down an 816 page, whenever the server was slow.
function where(el) {
  const max = el.scrollHeight - el.clientHeight;
  return { top: Math.round(el.scrollTop), end: max > 2 && max - el.scrollTop < 2 };
}
function onScroll(e) {
  const el = e.target;
  const name = nameOf(el);
  if (!name || !cur) return;
  rec(cur.id).scroll[name] = where(el);
  saveSoon();
}
// The person's own hand ends a restore: a wheel, a touch, a press or a key is theirs to keep.
const stopRestore = () => { restoring = null; };

// Scroll each kept element back to where it was once its content is tall enough to hold that
// place, and hold it there for a moment, because a chat that sticks to its end, or rows that
// load late, scroll it again. `want` is copied when the entry is entered, before the new
// screen's first layout clamps the scroll and records the clamp over it. When it is done, where
// it settled is recorded: setting a scroll to the value it already has fires no event, so the
// clamp's record would otherwise stand and be what the next return restores.
function restore(want) {
  const token = {};
  restoring = token;
  const t0 = performance.now();
  const met = {};
  const targets = { main: { top: 0 }, ...want };
  const step = () => {
    if (restoring !== token) return;
    const now = performance.now();
    const els = { main: document.querySelector('.main') };
    for (const el of document.querySelectorAll('[data-keep-scroll]')) els[el.dataset.keepScroll] = el;
    let waiting = false;
    for (const [name, w] of Object.entries(targets)) {
      const el = els[name];
      if (!el) { waiting = true; continue; }
      const max = el.scrollHeight - el.clientHeight;
      const top = w.end ? max : w.top;                // it was at its end: the end, however far that is now
      if (max >= w.top - 1) {
        if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
        met[name] ??= now;
        if (now - met[name] < SETTLE) waiting = true;
      } else if (now - t0 >= GIVE_UP) {
        el.scrollTop = max;
      } else waiting = true;
    }
    if (waiting && now - t0 < GIVE_UP) { requestAnimationFrame(step); return; }
    restoring = null;
    if (!cur) return;
    for (const name of Object.keys(targets)) if (els[name]) rec(cur.id).scroll[name] = where(els[name]);
    saveSoon();
  };
  requestAnimationFrame(step);
}

export function startHistory() {
  if (started || typeof window === 'undefined') return;
  started = true;
  try { history.scrollRestoration = 'manual'; } catch { /* old engines */ }
  try { store = new Map(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { store = new Map(); }
  cur = stampOf();
  if (!cur) { cur = { id: newId(), from: null }; stamp(cur); }
  here = location.hash || '#/';
  addEventListener('scroll', onScroll, true);
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) addEventListener(ev, stopRestore, true);
  addEventListener('pagehide', flush);
  restore({ ...(store.get(cur.id)?.scroll || {}) });
}

// The hash changed: a link, the browser's back or forward, or go(). Called by the router
// (shell.jsx useHashRoute) before the new route renders, so the screen that mounts reads its
// own entry's kept state.
export function arrive() {
  if (!started) return startHistory();
  if ((location.hash || '#/') === here) return;
  const st = stampOf();
  if (st) cur = st;                                                       // gone back or forward to it, or go() made it
  else { cur = { id: newId(), from: here }; stamp(cur); }                 // a plain link: a new entry
  const fresh = cur.id === pending;
  pending = null;
  here = location.hash || '#/';
  for (const f of subs) f();
  restore(fresh ? {} : { ...(store.get(cur.id)?.scroll || {}) });
}

export function go(to, { replace = false } = {}) {
  startHistory();
  const h = '#' + route(to);
  if (h === (location.hash || '#/')) return;
  const now = stampOf() || cur;
  const st = { id: newId(), from: replace ? now?.from ?? null : (location.hash || '#/') };
  if (replace) location.replace(h); else location.hash = h;
  stamp(st);
  pending = st.id;
}

// Where back goes from here, as a route: the screen before this one, or `parent`.
export function backTo(parent) {
  const from = (stampOf() || cur)?.from;
  return route(from != null ? from : parent);
}

export function back(parent) {
  startHistory();
  const from = (stampOf() || cur)?.from;
  if (from != null) history.back();
  else go(parent, { replace: true });
}

// A screen's own state for this entry: `initial` on a new one, what it was on one gone back to.
export function kept(key, initial) {
  const v = cur ? store.get(cur.id)?.state?.[key] : undefined;
  return v === undefined ? initial : v;
}
export function setKept(key, value) {
  if (!cur) return;
  rec(cur.id).state[key] = value;
  saveSoon();
}
// Told when the entry changes, after `kept` answers for the new one.
export function onEntry(f) { subs.add(f); return () => subs.delete(f); }
