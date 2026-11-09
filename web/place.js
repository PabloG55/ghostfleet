// web/place.js — where the app is, as a URL, and the clamps a restored place goes through.
//
// WHY THE ADDRESS CARRIES IT NOW. The app used to restore from ONE stored state, and
// localStorage is the origin's, not the tab's: two desk tabs overwrote each other's place on
// every poll, a reload put back whatever tab had written last, and no screen could be linked
// to. The URL is the one piece of state a browser keeps per tab and across a reload, so the
// place goes there and the stored state becomes the fallback for an open that names none —
// which is every open of the installed home-screen app, because it launches start_url and
// never the address it was on.
//
// WHAT A PLACE IS: the screen, its subject (project, sub-grid, session, the run on the
// review screen), the session's view, the Projects tab, and the two facts the back trail is
// measured from (a master entered from Projects, Jarvis). Never a draft, a search, a token
// or a payload: the keys are the closed list below, and toQuery reads nothing else off the
// object it is handed, so a caller passing the whole app state cannot leak the rest of it.
//
// ONE CLAMP FOR BOTH. clamp() is what restore() ran inline before this file: "you cannot be
// on a screen whose subject is missing". A URL is handwritten as easily as a stored state is
// half-written, and it has to land where the stored state with the same hole would — so it
// is the same function, not a second copy that would drift.
//
// No DOM and no imports, so test/helpers/place-check.mjs runs it as it is.

export const PROFILE_ALL = 'all';
// Between a machine and a profile in a tab's label: no-break spaces, see tabOf in app.js.
export const TAB_SEP = ' · ';
// Screens a URL may name. The terminal is not one: it takes a passkey at every open, so a
// reload of it lands where it was opened from (app.js placeOf). `jarvis` is written for the
// session screen in Jarvis mode, because its project is whatever /api/jarvis says it is.
const SCREENS = ['projects', 'queue', 'reviews', 'review', 'automations', 'grid', 'session', 'stack', 'stackpick'];
export const PLACE_KEYS = ['screen', 'tab', 'p', 'sub', 's', 'view', 'from', 'host', 'profile', 'run'];

// Every field of a place, defaulted. The shape save() writes and restore() reads.
export function normalize(p) {
  const x = p || {};
  const rv = x.rv && typeof x.rv === 'object'
    ? { host: String(x.rv.host || ''), profile: String(x.rv.profile || ''), run: String(x.rv.run || '') } : null;
  return {
    screen: SCREENS.includes(x.screen) ? x.screen : 'projects',
    project: x.project || null, session: x.session || null,
    sub: typeof x.sub === 'string' ? x.sub : '',
    view: x.view === 'pane' ? 'pane' : 'chat',
    profile: x.profile || PROFILE_ALL,
    entry: x.entry === 'projects' ? 'projects' : '',
    jarvisMode: !!x.jarvisMode,
    rv,
  };
}

// A tab in the address is `work`, or `work@vm` for a paired machine's — the `name@host` form
// a project on that machine already has — instead of the label's `vm · work`, which encodes
// to six escapes and a dot nobody can type.
function tabToQuery(label) {
  const s = String(label || '');
  const i = s.indexOf(TAB_SEP);
  return i < 0 ? s : `${s.slice(i + TAB_SEP.length)}@${s.slice(0, i)}`;
}
function tabFromQuery(v) {
  const s = String(v || ''), i = s.lastIndexOf('@');
  return i > 0 ? `${s.slice(i + 1)}${TAB_SEP}${s.slice(0, i)}` : s;
}
// encodeURIComponent, with `@` left as itself: it is legal in a query (RFC 3986 pchar) and it
// is the separator of every paired address, which should read as one.
const enc = (v) => encodeURIComponent(String(v)).replace(/%40/g, '@');

// The query for a place, '?…' — always naming the screen, so an address is never ambiguous
// about what it is; defaults (all, chat, this machine) left out so the common one stays short.
export function toQuery(p) {
  const x = normalize(p);
  const kv = [];
  const put = (k, v) => { if (v) kv.push(`${k}=${enc(v)}`); };
  const jarvis = x.jarvisMode && x.screen === 'session';
  put('screen', jarvis ? 'jarvis' : x.screen);
  if (x.profile !== PROFILE_ALL) put('tab', tabToQuery(x.profile));
  if (!jarvis && (x.screen === 'grid' || x.screen === 'session')) {
    put('p', x.project);
    put('sub', x.sub);
  }
  if (!jarvis && x.screen === 'session') {
    put('s', x.session);
    if (x.view === 'pane') put('view', 'pane');
    if (x.entry === 'projects') put('from', 'projects');
  }
  if (x.screen === 'review' && x.rv) { put('host', x.rv.host); put('profile', x.rv.profile); put('run', x.rv.run); }
  return '?' + kv.join('&');
}

// The place a query names, or null when it names none — and a query of somebody else's keys
// (a ticket, a tracking tag) names none. The hash is not read: `#reviews`, `#jarvis` and
// `#waiting` are app.js's own one-shot aliases and keep working exactly as they did.
export function fromQuery(search) {
  let q;
  try { q = new URLSearchParams(String(search || '')); } catch { return null; }
  if (!PLACE_KEYS.some(k => q.has(k))) return null;
  const g = (k) => q.get(k) || '';
  let screen = g('screen');
  const jarvisMode = screen === 'jarvis';
  if (jarvisMode) screen = 'session';
  // A screen nobody wrote, or one this list does not trust: implied by its subject, the way
  // a person shortening a link would expect — a session name means the session.
  else if (!SCREENS.includes(screen)) screen = g('run') ? 'review' : g('s') ? 'session' : g('p') ? 'grid' : 'projects';
  return normalize({
    screen, jarvisMode,
    project: jarvisMode ? null : g('p'), session: jarvisMode ? 'master' : g('s'),
    sub: g('sub'), view: g('view'), entry: g('from'),
    profile: g('tab') ? tabFromQuery(g('tab')) : PROFILE_ALL,
    rv: screen === 'review' ? { host: g('host'), profile: g('profile'), run: g('run') } : null,
  });
}

// A URL's place laid over the stored state: the place is the URL's ENTIRELY — a field it
// leaves out is that field's default, never what another tab stored — and the rest (the
// payloads painted before the network answers) is kept. Except the grid: a cached grid is
// one project's cards, and painting another tab's under this tab's header is the bug this
// file exists to fix, arriving one frame at a time.
export function overlay(stored, place) {
  if (!place) return stored;
  const j = { ...(stored || {}) };
  const same = (stored && stored.project) === place.project;
  for (const k of ['screen', 'project', 'session', 'sub', 'view', 'profile', 'entry', 'jarvisMode', 'rv']) j[k] = place[k];
  if (!same) j.grid = null;
  return j;
}

// restore()'s clamps, in restore()'s order, over a stored (or overlaid) state. `tabs` is
// the tab strip the cached projects draw; `stackLen` how many sessions the stack holds.
// Returns the place to be on and `depth`: the trail of entries a walk here would have left,
// which app.js pushes once the screen is painted (resumedSession, loggedIn).
export function clamp(j, { tabs = [], stackLen = 0 } = {}) {
  j = j || {};
  let project = j.project || null, screen = j.screen || 'projects';
  let session = j.session || null;
  // the sub-grid you were in; the next grid read falls back to the top if it has gone
  const sub = (project && typeof j.sub === 'string') ? j.sub : '';
  const jarvisMode = !!j.jarvisMode && screen === 'session';
  const entry = j.entry === 'projects' && screen === 'session' ? 'projects' : '';
  // 'msgs' was the old list view's name and is not a view any more; anything unrecognised
  // falls to the default rather than rendering neither.
  const view = j.view === 'pane' ? 'pane' : 'chat';
  // THE SAME CLAMP, FOR THE SAME REASON. A profile is free text and a projects file is
  // edited between opens, so the stored tab can name something that no longer exists —
  // and a tab matching nothing would draw an empty screen over a fleet that has projects
  // in it. Unknown falls to `all`, which is also the default: hiding projects on a first
  // run would be a surprise, and "is anything blocked on me" must not need two looks.
  const profile = (j.profile && (j.profile === PROFILE_ALL || (tabs || []).includes(j.profile))) ? j.profile : PROFILE_ALL;
  // A CLAMP, not a trust. Half-written state is how a session screen with nothing on it
  // happened, and the rule is simple enough to state: you cannot be on a screen whose
  // subject is missing.
  if (screen === 'session' && !session) screen = project ? 'grid' : 'projects';
  // The stack reopens as it was left — the picker, or the columns if there is a stack to show.
  if (screen === 'stack' && !stackLen) screen = 'stackpick';
  if (screen === 'stack' || screen === 'stackpick') { project = null; session = null; }
  if (screen === 'grid' && !project) screen = 'projects';
  // A run is reopened by its address and read again; a list is read again. Neither payload
  // is kept: a verdict changes from another device, and a stale one would be shown as now.
  const rv = screen === 'review' && j.rv && j.rv.profile && j.rv.run
    ? { host: String(j.rv.host || ''), profile: String(j.rv.profile), run: String(j.rv.run) } : null;
  if (screen === 'review' && !rv) screen = 'reviews';
  const depth = screen === 'session' ? (jarvisMode || entry ? 1 : 2)
    : (screen === 'grid' || screen === 'queue' || screen === 'reviews' || screen === 'automations' || screen === 'stack' || screen === 'stackpick') ? 1
    : screen === 'review' ? 2 : 0;
  return { screen, project, session, sub, view, profile, entry, jarvisMode, rv, depth };
}
