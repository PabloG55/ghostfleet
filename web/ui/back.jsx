// web/ui/back.jsx — the back button, and a screen's state kept per history entry, for the Preact
// screens. The history itself, and why back works the way it does, is history.js.
//
//   <BackLink parent="/p/acme-web" />   "← Live map": names where it goes, goes there with back()
//   useKept(key, initial)               useState, but each history entry keeps its own value, so
//                                       a screen gone back to shows the box ticked, the chip picked
//   useEntry()                          re-render when the entry changes
//   placeName(route, own?)              what a route is called on a back button
import { useState, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { t } from './i18n.js';
import { back, backTo, kept, setKept, onEntry } from './history.js';

export function useEntry() {
  const [, tick] = useState(0);
  useEffect(() => onEntry(() => tick(n => n + 1)), []);
}

// A screen that stays mounted from one entry to the next (a project's page and its sessions are
// one view) takes the new entry's value when the entry changes.
export function useKept(key, initial) {
  const [v, setV] = useState(() => kept(key, initial));
  useEffect(() => onEntry(() => setV(kept(key, initial))), [key]);
  const set = (x) => setV(prev => { const n = typeof x === 'function' ? x(prev) : x; setKept(key, n); return n; });
  return [v, set];
}

// Home, the map, a project, a session, Activity and Settings are named here. The other shared
// pages are named by phone-places.js, which each adapter composes into its `place(route)` ahead of
// its own names (`route => screenPlace(route) || appPlace(route)`).
const SHARED_PLACES = { activity: 'nav.activity', settings: 'nav.settings' };
export function placeName(to, own) {
  let parts;
  try { parts = String(to).replace(/^#?\/?/, '').split('/').map(decodeURIComponent); } catch { parts = []; }
  if (parts[0] === 'p' && parts[1]) return parts[2] === 's' && parts[3] ? parts[3] : parts[1];
  if (parts[0] === 'map') return t('nav.map');
  if (!parts[0]) return t('nav.home');
  if (SHARED_PLACES[parts[0]]) return t(SHARED_PLACES[parts[0]]);
  return own?.(to) || t('common.back');
}

// A link, so a middle click or ⌘-click still opens the destination in a new tab; a plain click is
// back(), the same step the browser's back takes.
export function BackLink({ parent, class: extra = '' }) {
  useEntry();
  const fleet = useFleet();
  const to = backTo(parent);
  const place = placeName(to, fleet?.place);
  return (
    <a class={`back-link${extra ? ` ${extra}` : ''}`} href={`#${to}`} aria-label={t('common.backTo', { place })}
       onClick={(e) => {
         if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
         e.preventDefault();
         back(parent);
       }}>
      <span aria-hidden="true">←</span> {place}
    </a>
  );
}
