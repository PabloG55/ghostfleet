// web/src/projects.jsx — the Projects screen, as Preact components.
//
// Built by vite.config.mjs into web/projects.js, which is what app.js imports and what
// the phone fetches. This file is the source; the built file is committed beside it, for
// the reasons in that config and in bin/cf-sync.
//
// ══ THE SEAM ══════════════════════════════════════════════════════════════════════════
// This is the first screen ported, and everything else in web/app.js is untouched. So
// there is a line running through the middle of this screen, and the next person to port
// a screen needs to know exactly where it is and why it is there rather than discovering
// it from a diff.
//
//   THE RULE: data crosses the seam; the four gestures do not.
//
// What that means concretely:
//
//   PREACT OWNS      the header, the stale banner, the profile tabs, the confirm bar, the
//                    .cards container, the verb footer, the hint and the toast — every box
//                    on this screen, its classes and its layout.
//
//   app.js OWNS      what goes INSIDE .cards. Each card is still built by app.js's
//                    cardEl(), which calls wire(): one pointer handler telling a tap from a
//                    600ms long-press from a 60px swipe from a drag that starts on the
//                    title line. That code is the most device-specific in the client and
//                    the most expensively debugged — the grip is a single line so a
//                    vertical drag elsewhere still scrolls the page, and a re-render
//                    mid-gesture replaces the node under the finger and kills the gesture
//                    half-finished, which is why markSel() moves the selection WITHOUT
//                    rendering. Re-expressing that as hooks on a first pass would spend
//                    the debugging and then rediscover it on a phone, which is the worst
//                    place to debug. It is also shared with the grid screen, and two
//                    copies of a gesture machine is two answers to "did that count as a
//                    tap".
//
//                    So the cards arrive here as real DOM nodes and are placed into the
//                    container with replaceChildren(). CardList is the whole of the seam,
//                    in one component, and it is ten lines.
//
//   NEITHER OWNS     the strings. Every label, question and key hint on this screen is
//                    built by app.js's projectsProps() and handed over as data. The TUI's
//                    own wording is what test/helpers/pwa-check.mjs greps web/app.js for
//                    (§7: "the guardrails ARE the TUI's own prompts"), and a string
//                    retyped here would be a string that check can no longer see.
//
//   NOT YET MOVED    the state. S in app.js is still the single source of truth, and this
//                    screen is a pure function of the props built from it. A useState for
//                    the profile tab would be a SECOND place that knows which tab is open,
//                    and the first one is persisted to localStorage and read by
//                    visibleProjects(); the bug that produces is a tab that survives a
//                    reload in one place and not the other. Moving state into components
//                    is worth doing and is a separate change, after more than one screen
//                    is here to share it.
//
// WHEN THE GRID SCREEN IS PORTED: Header, ConfirmBar and Btn below become shared
// components, app.js's header()/bar()/btn() are deleted, and CardList is the thing to look
// at hardest — that is the point at which porting the gestures is worth it, because then
// there is one caller left rather than two.
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
// WRITTEN TWICE — once for the ported screen and once for the two that are not. A
// duplicated rule is a rule that drifts, so pwa-check asserts the two spellings agree
// rather than trusting that anybody noticed; porting the grid screen deletes the other
// copy. The bound is on the KEY, not the label: `⏎ open` splits and `remove anyway` must
// not.
const VERB = /^(\S+) (.+)$/;
function Btn({ label, onClick, cls = '' }) {
  const m = VERB.exec(label);
  if (m && [...m[1]].length <= 2) {
    return <button class={(cls + ' k').trim()} onClick={onClick}><b>{m[1]}</b>{' ' + m[2]}</button>;
  }
  return <button class={cls || null} onClick={onClick}>{label}</button>;
}

// ── the one-line header, plus the offline line under it ───────────────────────────────
// The banner does not fit a phone, so this is exactly what a narrow terminal gets. `stale`
// is an epoch rather than a rendered sentence: clockLabel is grid.js's, and the phone and
// the TUI print a time the same way or they are two clocks.
function Header({ scope, mode, stale }) {
  return (
    <Fragment>
      <div class="hdr">
        <span class="name">ghostfleet</span>
        <span class="scope">{scope}</span>
        <span class={'mode ' + mode.kind} title={mode.detail || null}>{mode.text}</span>
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
//   The reader's scroll position lives on this node. Preact keeps it across a re-render
//   instead of building a new one, and a fresh element starts at scrollTop 0 — the reported
//   "it suddenly goes to the top" every five seconds. app.js's scroll memory still runs
//   (see listRef below) because it is what restores a position after LEAVING the screen and
//   coming back; what it no longer has to do is rescue one from a rebuild that no longer
//   happens. That is the first thing the component model actually buys here.
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

function ProjectsScreen(p) {
  return (
    <Fragment>
      <Header scope={p.scope} mode={p.mode} stale={p.stale} />
      <ProfileTabs tabs={p.tabs} onTab={p.onTab} />
      <ConfirmBar confirm={p.confirm} />
      <CardList nodes={p.cards} listRef={p.listRef} />
      {/* ABOVE THE FOOTER, IN FLOW. The toast is a band of the shell column now rather than
          a fixed overlay, so its position in this fragment is its position on screen — and
          the one place it must never be is over a control. On the session screen the
          equivalent slot is directly above the composer; here it is above the verbs. */}
      {p.toast ? <div class={('toast ' + (p.toast.kind || '')).trim()}>{p.toast.text}</div> : null}
      <div class="verbs">
        {p.verbs.map((v, i) => <Btn key={i} label={v.label} cls={v.cls} onClick={v.onClick} />)}
      </div>
      <div class="hint">{p.hint}</div>
    </Fragment>
  );
}

// ── what app.js calls ─────────────────────────────────────────────────────────────────
// Two functions and no other exports. mount() is idempotent: Preact diffs against whatever
// it put in this container last time, which is the entire reason the scroll position and
// the .cards node survive a poll.
//
// unmount() is NOT optional and NOT the same as app.js's `app.textContent = ''`. Clearing
// the container behind Preact's back leaves it believing its vnode tree is still on screen,
// and the next mount diffs against nodes that are gone. Rendering null is what tears the
// tree down and lets the container be emptied by anyone again.
export function mount(container, props) {
  preactRender(<ProjectsScreen {...props} />, container);
}
export function unmount(container) {
  preactRender(null, container);
}
