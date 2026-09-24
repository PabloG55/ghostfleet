// web/src/screens.jsx — the ported screens, as Preact components.
//
// Built by vite.config.mjs into web/screens.js, which is what app.js imports and what the
// phone fetches. This file is the source; the built file is committed beside it, for the
// reasons in that config and in bin/cf-sync.
//
// TWO SCREENS LIVE HERE NOW — Projects and the grid — which is why this file is no longer
// called projects.jsx. The rename is not tidying: the grid screen was ported to fix a bug
// that only the component model can fix (see CardList), and a bundle named for one of the
// two screens inside it is a name that has to be read past rather than read.
//
// ══ THE SEAM ══════════════════════════════════════════════════════════════════════════
// The session screen, the lock screen, the pane and every sheet are still app.js's, built
// with el(). So there is still a line running through this client, and the next person to
// port a screen needs to know exactly where it is and why it is there rather than
// discovering it from a diff.
//
//   THE RULE: data crosses the seam; the four gestures do not.
//
// What that means concretely:
//
//   PREACT OWNS      every box on these two screens — the header, the stale banner, the
//                    profile tabs, the count strip, the confirm bar, the .cards container,
//                    the verb footer, the hint and the toast — their classes and their
//                    layout.
//
//   app.js OWNS      what goes INSIDE .cards. Each card is still built by app.js's
//                    cardEl(), which calls wire(): one pointer handler telling a tap from a
//                    600ms long-press from a 60px swipe from a drag that starts on the
//                    title line. That code is the most device-specific in the client and
//                    the most expensively debugged — the grip is a single line so a
//                    vertical drag elsewhere still scrolls the page, and a re-render
//                    mid-gesture replaces the node under the finger and kills the gesture
//                    half-finished, which is why markSel() moves the selection WITHOUT
//                    rendering. Re-expressing that as hooks would spend the debugging and
//                    then rediscover it on a phone, which is the worst place to debug.
//
//                    IT NOW HAS ONE CALLER SHAPE RATHER THAN TWO, which is what porting
//                    the grid bought: both screens hand their cards to the same CardList
//                    as real DOM nodes, placed with replaceChildren(). That is the
//                    precondition for porting the gestures — it is deliberately NOT done
//                    here, because this pass is a scroll fix and a gesture rewrite in the
//                    same diff is two things to bisect at once.
//
//   NEITHER OWNS     the strings. Every label, question, count and key hint on these
//                    screens is built by app.js's projectsProps()/gridProps() and handed
//                    over as data — including the count strip's four words and the colours
//                    they are drawn in. The TUI's own wording is what
//                    test/helpers/pwa-check.mjs greps web/app.js for (§7: "the guardrails
//                    ARE the TUI's own prompts"), and a string retyped here would be a
//                    string that check can no longer see.
//
//   NOT YET MOVED    the state. S in app.js is still the single source of truth, and both
//                    screens are pure functions of the props built from it. A useState for
//                    the profile tab would be a SECOND place that knows which tab is open,
//                    and the first one is persisted to localStorage and read by
//                    visibleProjects(); the bug that produces is a tab that survives a
//                    reload in one place and not the other. Moving state into components
//                    is worth doing and is a separate change.
//
// WHAT PORTING THE GRID DID **NOT** DELETE, because the previous version of this comment
// predicted otherwise and was wrong: app.js's btn() is still there and still needed. Its
// callers are the sheets (~40 of them), the lock screen, the pane's zoom row, the composer
// and the session screen's top bar — none of which is a card screen, and none of which is
// ported. app.js's bar()/confirmBar() survive for the same reason: the session screen
// still draws a confirm bar with them. Only header() actually died, because gridScreen()
// was its one caller. So Btn below is STILL a second spelling of app.js's rule, and
// pwa-check's cross-check that the two agree is still load-bearing rather than vestigial.
// ══════════════════════════════════════════════════════════════════════════════════════

import { render as preactRender, Fragment } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
// Resolved by the browser against web/, NOT bundled — see CLIENT_MODULES in
// vite.config.mjs. The specifier is '../' here because that is where the file is from this
// one, and rollup rewrites it to './' in the output, which is where it is from there.
import { clockLabel } from '../grid.js';

// ── a button whose key letter stays in the label ──────────────────────────────────────
// The TUI's footer is muscle memory, and a button that says "p pause" transfers where one
// that says "Pause" starts again. THIS IS THE SAME RULE AS app.js's btn() AND IT IS
// WRITTEN TWICE — once for the ported screens and once for everything else, which is the
// sheets, the lock screen, the pane and the session bar. A duplicated rule is a rule that
// drifts, so pwa-check asserts the two spellings agree rather than trusting that anybody
// noticed. The bound is on the KEY, not the label: `⏎ open` splits and `remove anyway`
// must not.
const VERB = /^(\S+) (.+)$/;
function Btn({ label, onClick, cls = '' }) {
  const m = VERB.exec(label);
  if (m && [...m[1]].length <= 2) {
    return <button class={(cls + ' k').trim()} onClick={onClick}><b>{m[1]}</b>{' ' + m[2]}</button>;
  }
  return <button class={cls || null} onClick={onClick}>{label}</button>;
}

// ── the one icon this client still draws in a component ───────────────────────────────
// VerbBtn AND FIVE ICON PATHS USED TO BE HERE. They drew the six-button footer, and moving
// the verbs into a sheet took their only caller — a sheet is a list of labelled actions, the
// same shape every other sheet in this app already has, and an icon beside each row would be
// a second vocabulary for the same six words.
//   `more` survives because the header's `⋯` is it. Kept as a path rather than the character
// "⋯" for the reason #82 gave for the speaker: an emoji or a glyph is a font-dependent
// picture that renders differently on every device and measures two cells in some of them.
// This is a stroked path in the button's own currentColor.
const ICONS = {
  more: ['M6 12h.01M12 12h.01M18 12h.01'],
};
function Icon({ name }) {
  const ds = ICONS[name];
  if (!ds) return null;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {ds.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// ── ⋯ LIVES HERE NOW, AND THE FOOTER IS GONE ──────────────────────────────────────────
// Six verb buttons wrapped to two rows of 44px and a three-line hint under them cost 179 of
// 844 points — 21% of the screen — to say things you stop reading after the first day.
// Measured at 390x844: chrome was 292pt (34.6%) and the card list got 536, which fits THREE
// of nine sessions. The owner, looking at a photograph of that footer: "i think we can
// simply this with a 3 dots on the header i beleive".
//   It is also the idiom this client already has. The session screen has carried exactly
// this since #7 — a bar whose last control is `⋯` opening the actions sheet — so the two
// screens now agree instead of one having a footer and the other a header button.
//   The verbs did not go away and neither did the gestures: both are in the sheet, which
// names what it is acting on before it offers anything destructive.
function Header({ scope, mode, stale, counts, onMore }) {
  return (
    <Fragment>
      <div class="hdr">
        <span class="name">ghostfleet</span>
        <span class="scope">{scope}</span>
        <span class={'mode ' + mode.kind} title={mode.detail || null}>{mode.text}</span>
        {counts && counts.length
          ? <span class="counts">
              {counts.map((s, i) => <span key={i} style={s.color ? `color:${s.color}` : null}>{s.text}</span>)}
            </span>
          : null}
        {onMore
          ? <button class="more" onClick={onMore} title="actions" aria-label="actions">
              <Icon name="more" />
            </button>
          : null}
      </div>
      {stale ? <div class="stale">{`⚠ offline — last fetched ${clockLabel(stale)}`}</div> : null}
    </Fragment>
  );
}

// ── the profile tabs ──────────────────────────────────────────────────────────────────
// Drawn only when there is a choice: one profile is the common case and a control with one
// option is furniture. The need-you count rides on the tab because a tab is the one control
// here that can HIDE the answer to the question this app exists to answer.
function ProfileTabs({ tabs, onTab }) {
  if (!tabs || tabs.length < 2) return null;
  return (
    <div class="seg tabs">
      {tabs.map(t => (
        <Btn key={t.name} label={t.need ? `${t.name} ●${t.need}` : t.name}
             cls={t.on ? 'on' : ''} onClick={() => onTab(t.name)} />
      ))}
    </div>
  );
}

// ── the count strip ───────────────────────────────────────────────────────────────────
// The four counts that fit a phone row, each a tile. ONLY A NON-ZERO COUNT IS COLOURED: a
// strip where every tile is lit says nothing, and the question this app exists to answer is
// which one is not zero. The words, the numbers and the hue all arrive as data — the hue is
// the status's own, the same one the card's rail and chip use, so the strip and the cards
// teach one colour vocabulary.
function CountStrip({ strip }) {
  if (!strip || !strip.length) return null;
  return (
    <div class="strip">
      {strip.map(t => (
        <div key={t.label} class={'stat' + (t.n ? ' on' : '')} style={`--c:${t.color}`}>
          <div class="n">{String(t.n)}</div>
          <div class="l">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── the confirm bar ───────────────────────────────────────────────────────────────────
// Reproduced from app.js's spec, never reworded here: §7 says the guardrails ARE the TUI's
// own prompts, so the question and the key hint are data that arrives, not text this file
// writes.
function ConfirmBar({ confirm }) {
  if (!confirm) return null;
  return (
    <div class={'confirm ' + confirm.cls}>
      <span class="q">{' ' + confirm.q}</span>
      <span class="keys">{'  ' + confirm.keys}</span>
      {confirm.buttons.length
        ? <div class="row">
            {confirm.buttons.map((b, i) => <Btn key={i} label={b.label} cls={b.cls} onClick={b.onClick} />)}
          </div>
        : null}
    </div>
  );
}

// ── the seam itself ───────────────────────────────────────────────────────────────────
// THE CONTAINER IS THE POINT, AND IT IS WHY THIS IS NOT A WRAPPER DIV. Two things depend
// on .cards being this exact element, in this exact position:
//
//   app.css has `#app.shell > .cards { flex: 1 1 auto; min-height: 0; overflow-y: auto }`.
//   That is a CHILD selector: one div of nesting and the card list stops being the screen's
//   scrolling region, the column grows past the viewport, and the whole page scrolls —
//   which is the bug test/helpers/viewport-check.mjs drives a real Chrome to catch.
//
//   The reader's scroll position lives on this node, AND THIS IS THE BUG THE GRID PORT
//   EXISTS TO FIX. Reported from a real iPhone: "i scroll the sessions and after some
//   seconds it goes all the way up again". "Some seconds" was the 5s poll. gridScreen()
//   built a fresh div.cards on every render, a fresh element starts at scrollTop 0, and
//   app.js's scroll memory therefore had to RESCUE the position after the fact, every
//   single poll — a rescue that has to win a race with layout to be invisible, and did not
//   always win it. Preact keeps this node across a render instead of building a new one, so
//   there is no position to rescue: the reader's scrollTop is simply never disturbed.
//   watchScroll still runs (see listRef), because restoring a position after LEAVING the
//   screen and coming back is a real job; what it no longer has to do is the impossible one.
//
// The children are still app.js's DOM, replaced wholesale on each render exactly as before.
// Preact is told nothing about them, so it never tries to diff them.
function CardList({ nodes, listRef }) {
  const box = useRef(null);
  // ONCE, NOT PER RENDER, and the empty dep array is load-bearing. watchScroll() attaches a
  // scroll listener and restores the saved offset; calling it on every render would stack a
  // listener per poll on a node that now outlives the render, and re-restore a position over
  // the reader's own scrolling.
  useLayoutEffect(() => {
    listRef(box.current);
    return () => listRef(null);
  }, []);
  // ...and this one has NO dep array on purpose: app.js builds fresh card nodes every
  // render, so there is new content to place every time.
  useLayoutEffect(() => { if (box.current) box.current.replaceChildren(...nodes); });
  return <div class="cards" ref={box} />;
}

// ── the shape both screens share ──────────────────────────────────────────────────────
// Header, one band, the confirm bar, the scrolling card list, the toast, the verbs, the
// hint. Written once rather than twice, because THE ORDER IS THE TOAST FIX: the toast is a
// band of this column now rather than a fixed overlay, so its position in this fragment is
// its position on screen, and the one place it must never be is over a control ("dont blok
// the chat with toasts"). Two copies of this order is one screen where that is true and one
// where it is true until somebody appends something.
function CardScreen({ scope, mode, stale, counts, onMore, band, confirm, cards, listRef, toast }) {
  return (
    <Fragment>
      <Header scope={scope} mode={mode} stale={stale} counts={counts} onMore={onMore} />
      {band}
      <ConfirmBar confirm={confirm} />
      <CardList nodes={cards} listRef={listRef} />
      {/* STILL THE LAST BAND, AND STILL IN FLOW. The toast is a band of this column rather
          than a fixed overlay, so its position here is its position on screen — and with the
          footer gone the one control it must never cover is the ⋯ at the top, which it
          cannot reach. */}
      {toast ? <div class={('toast ' + (toast.kind || '')).trim()}>{toast.text}</div> : null}
    </Fragment>
  );
}

function ProjectsScreen(p) {
  return <CardScreen {...p} band={<ProfileTabs tabs={p.tabs} onTab={p.onTab} />} />;
}
function GridScreen(p) {
  return <CardScreen {...p} band={<CountStrip strip={p.strip} />} />;
}

// ── what app.js calls ─────────────────────────────────────────────────────────────────
// mount() is idempotent: Preact diffs against whatever it put in this container last time,
// which is the entire reason the scroll position and the .cards node survive a poll.
//
// THE `key` IS NOT DECORATION, AND IT IS THE ONE THING TO GET RIGHT WHEN ADDING A THIRD
// SCREEN. Both screens put a <CardList> at the same depth in the same fragment, so without
// a key at the root Preact would happily reuse the SAME div.cards when you walk from
// Projects into a project — carrying the projects list's scroll offset into the grid, and
// worse, never re-firing CardList's mount effect, so the reused node would still be wired
// to the 'projects' scroll key and the grid's would never be attached at all. A key change
// tears the old tree down and builds the new one, which is exactly what crossing between
// two screens means. Preact would also tear down on the differing component type alone;
// the key is here so that stays true if these two ever become one component with a prop.
const SCREENS = { projects: ProjectsScreen, grid: GridScreen };
export function mount(container, screen, props) {
  const S = SCREENS[screen];
  // Not a silent no-op: a typo here would leave the container holding the PREVIOUS screen
  // while app.js believes it drew the new one, which is the kind of wrong that looks like
  // a routing bug for an afternoon.
  if (!S) throw new Error(`screens.mount: no such screen '${screen}'`);
  preactRender(<S key={screen} {...props} />, container);
}
// unmount() is NOT optional and NOT the same as app.js's `app.textContent = ''`. Clearing
// the container behind Preact's back leaves it believing its vnode tree is still on screen,
// and the next mount diffs against nodes that are gone. Rendering null is what tears the
// tree down and lets the container be emptied by anyone again.
export function unmount(container) {
  preactRender(null, container);
}
