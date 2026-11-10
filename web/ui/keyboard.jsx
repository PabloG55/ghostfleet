// web/ui/keyboard.jsx — the desk's keys for the Preact screens: keys.js's rules, one window
// listener, and the screens' own tables.
//
// <DeskKeys> is mounted once, by <Frame>. It owns what lasts longer than one key: the Ctrl-f
// chord (and its prompt) and Ctrl-a's prefix. Each screen hands it the keys that mean
// something there with useKeys(handler); the screen mounted last is the one on top, and gets
// the key first. A handler is (key, event, layer) → true when it took the key:
//   key     keys.js's deskKey(): { k, lk, ctrl, shift, alt }
//   layer   { prefix, startJump(), go(to), toLead(project, cards?), focusSearch(), held() }
// What no screen takes falls to the keys every screen shares: Ctrl-f, Ctrl-p and Q, and `,`
// and `/` where the screen says so.
import { useEffect, useRef, useState } from 'preact/hooks';
import { typingIn, noteKeyboard, deskKey, deskKeyInComposer, jumpStep, stepIndex, DIRS } from './keys.js';
import { useFleet } from './adapter.jsx';
import { t } from './i18n.js';

const screens = [];
export function useKeys(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h = (key, e, layer) => ref.current(key, e, layer);
    screens.push(h);
    return () => { const i = screens.lastIndexOf(h); if (i >= 0) screens.splice(i, 1); };
  }, []);
}

export const sessionTo = (project, name) => `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`;
export const projectTo = (project) => `/p/${encodeURIComponent(project)}`;
const leadIn = (list) => (list || []).find(s => s.lead)?.name || null;

// The cursor here is the focus: the browser draws it (the focus ring), Tab agrees with it, and
// ⏎ on it is the element's own. `selector` picks the items, in reading order.
export function moveFocus(selector, dir) {
  const els = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
  const from = els.indexOf(document.activeElement);
  const to = stepIndex(els.map(el => el.getBoundingClientRect()), from, dir);
  if (to < 0) return false;
  els[to].focus();
  els[to].scrollIntoView?.({ block: 'nearest' });
  return true;
}
export const dirOf = (key) => !key.ctrl && !key.alt && !(key.shift && key.k.startsWith('Arrow')) ? DIRS[key.k] : undefined;

// ⏎ and Space on a link, a button, a tab or a card are that element's: the browser turns them
// into its click. Taken here they would mean the screen's ⏎ instead of the thing in focus.
const OWN = 'a[href], button, summary, select, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
const ownActivation = (e) => (e.key === 'Enter' || e.key === ' ') && !!e.target?.closest?.(OWN) && e.target !== document.body;
const dialogOpen = () => !!document.querySelector('[aria-modal="true"]');
const inComposer = (t) => !!t?.closest?.('.composer');

function jumpText(j) {
  if (j.stage === 'grid') return t('keys.jump.grid');
  if (j.stage === 'proj') return t('keys.jump.proj', { n: j.proj });
  return t('keys.jump.first');
}

// `route` is the shell's ({ view, project, session }), `settings` the route `,` opens (none:
// the key does nothing), `openMenu` shows the phone's drawer so `/` has a search to focus.
export function DeskKeys({ route, projects, settings, openMenu }) {
  const fleet = useFleet();
  const [jump, setJump] = useState(null);
  const live = useRef({});
  live.current = { route, projects, settings, openMenu, fleet, jump };
  const prefix = useRef(false);

  useEffect(() => {
    const now = () => live.current;
    const go = (to, opts) => now().fleet.go(to, opts);
    const nth = (n) => (now().projects || [])[n - 1] || null;
    const layer = {
      get prefix() { return prefix.current; },
      set prefix(v) { prefix.current = !!v; },
      held: () => !!now().jump || prefix.current,
      startJump: () => setJump({ stage: 'first' }),
      go,
      // A project's front door is its master, as at the desk. A project with no lead card has
      // no door to open: the key is taken and nothing moves.
      toLead(project, cards) {
        const p = (now().projects || []).find(x => x.name === project);
        const name = leadIn(cards) || leadIn(p?.sessions);
        if (name) go(sessionTo(project, name));
        return true;
      },
      focusSearch() {
        let tries = 0;
        const focus = () => {
          const box = document.querySelector('.side .search');
          if (box && box.getClientRects().length) { box.focus(); box.select?.(); return; }
          if (tries++ < 10) requestAnimationFrame(focus);
        };
        if (matchMedia('(max-width: 900px)').matches) now().openMenu?.();
        focus();
        return true;
      },
    };
    const follow = async (g) => {
      if (g.to === 'projects') return go('/');
      const p = nth(g.project);
      if (!p) return;                                   // no project there: the desk does nothing either
      if (g.to === 'master') return layer.toLead(p.name);
      go(projectTo(p.name));
      if (g.to !== 'card') return;
      try {
        const grid = await now().fleet.grid(p.name);
        const c = (grid?.cards || [])[g.card - 1];
        // the project page was a step on the way, not a screen chosen: the card takes its entry,
        // so back from the card is the screen the chord was typed on (history.js)
        if (c) go(sessionTo(p.name, c.name), { replace: true });
      } catch { /* the grid it landed on says what went wrong */ }
    };
    // The keys every screen shares, when the screen on top did not take the key.
    const shared = (key) => {
      const { k, lk, ctrl } = key;
      const view = now().route?.view;
      if (ctrl && lk === 'f') { layer.startJump(); return true; }
      if (ctrl && lk === 'p') { if (view === 'home') return false; go('/'); return true; }   // on home it is the browser's
      if (ctrl || key.alt) return false;
      if (k === 'Q' && view !== 'home') { go('/'); return true; }
      if (k === ',' && now().settings && (view === 'home' || (view === 'project' && !now().route.session))) { go(now().settings); return true; }
      if (k === '/' && view === 'home') return layer.focusSearch();
      return false;
    };
    const onKey = (e) => {
      if (dialogOpen()) return;                         // a dialog owns the keyboard; Esc is its own
      const session = now().route?.view === 'project' && !!now().route.session;
      if (typingIn(e.target) && !(session && inComposer(e.target) && deskKeyInComposer(e, { held: layer.held() }))) return;
      if (!layer.held() && ownActivation(e)) return;
      const key = deskKey(e);
      if (!key) return;
      if (now().jump) {
        e.preventDefault();
        const r = jumpStep(now().jump, key);
        setJump(r.j);
        if (r.go) follow(r.go);
        return;
      }
      const top = screens[screens.length - 1];
      if ((top && top(key, e, layer)) || shared(key)) e.preventDefault();
    };
    addEventListener('keydown', noteKeyboard, true);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', noteKeyboard, true); removeEventListener('keydown', onKey); };
  }, []);

  if (!jump) return null;
  // One hint per segment, each kept whole: a phone-width prompt that wraps inside a hint reads
  // "s + digit" on one line and "= that project's sessions" on the next.
  const hints = jumpText(jump).split(/\s+·\s+/);
  return <p class="keyprompt" role="status">{hints.map((h, i) => <>{i ? ' · ' : ''}<span>{h}</span></>)}</p>;
}

// Types into the session's composer, at its caret, and leaves the focus there so the rest of
// the sentence follows: at the desk every key a session does not bind goes to the agent.
export function typeIntoComposer(text) {
  const box = document.querySelector('.composer textarea');
  if (!box) return false;
  box.focus();
  const a = Number.isInteger(box.selectionStart) ? box.selectionStart : box.value.length;
  const b = Number.isInteger(box.selectionEnd) ? box.selectionEnd : a;
  box.setRangeText(text, a, b, 'end');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
export function focusComposer() {
  const box = document.querySelector('.composer textarea');
  if (!box) return false;
  box.focus();
  return true;
}
