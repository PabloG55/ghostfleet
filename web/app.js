// web/app.js — the screens, the gestures and the verbs.
//
// Three screens, mirroring the desktop: Projects → grid → session (docs/mobile.md §6).
// The grid is renderGrid() at `nc = 1`: a one-column list of the same cards, under the
// same one-line header, over the same footer of verbs. The keys become touches by the
// mapping in §7 — 1-9/⏎ → tap, ⇧hjkl → drag, p/P → swipe, x → long-press — and the
// keyboard bindings are wired too, because a keyboard is how this gets driven for a
// screenshot and how it behaves on a desktop browser.
//
// Two things are deliberately missing and are not to be substituted (§7): the STACK
// (it exists to put sessions side by side, and a phone has no side — at nc = 1 it is
// this list) and the Ctrl-t / Ctrl-n terminal and editor tabs (they open a shell and
// neovim in the session's folder, and there is no local shell on a phone; streaming a
// remote one is a larger surface than the whole rest of the design). The settings sheet
// says so out loud rather than leaving a hole where a key used to be.

import * as G from './grid.js';
import * as api from './api.js';
import * as pk from './passkey.js';
import * as ansi from './ansi.js';
import * as md from './md.js';
// THE ONE BUILT FILE IN web/. Everything above is served exactly as written; this one is
// vite's output from web/src/screens.jsx, committed beside its source. It holds BOTH card
// screens — Projects and the grid — which is why it is no longer called projects.js. The
// seam between what it draws and what this file still draws is documented at the top of
// that source; read it before porting a third.
import * as screensUI from './screens.js';

// ── state ─────────────────────────────────────────────────────────────────
const S = {
  screen: 'projects',   // projects | grid | session
  project: null,        // the fleet being looked at
  session: null,        // the card opened on the session screen
  projects: null,       // last /api/projects payload
  profile: 'all',       // the projects screen's tab: 'all' | a profile name (see PROFILES)
  grid: null,           // last §4 payload
  sess: null,           // last /api/session payload  { messages, next_before, … }
  view: 'chat',         // the session screen: 'chat' (the conversation) | 'pane' (the terminal)
  pane: null,           // last /api/pane payload   { pane, at, … }
  paneGeom: null,       // { rows, cols } — measured from that payload, not claimed by it
  paneErr: '',          // the last pane read's failure, shown once rather than per poll
  speakSel: '',         // key of the bubble that was TAPPED — the only one showing a play
                        // control. See turn(): this is what keeps per-message playback
                        // from becoming a speaker on every bubble.
  pscroll: 0,           // scrollback rows asked for; 0 = exactly what an attach shows
  pfs: 0,               // the pane's font size in px, 0 until restore() or PFS_DEFAULT
  sel: 0,               // the TUI's `sel` — which card the verbs act on
  locked: true,
  confirm: null,        // { kind, … } — the TUI's confirm bar, reproduced
  sheet: null,          // { kind, … } — one of the TUI's full-screen forms
  toast: null,
  stale: 0,             // epoch of the payload on screen, when it came from the cache
  hiddenAt: 0,
  draft: '',            // the composer's text, kept across repaints (a poll must not eat it)
  attaching: false,     // a photo is on its way up; the camera button says so and refuses a second
  pending: null,        // { text, at } — sent, not yet back in the transcript
  speaking: '',         // the text currently being read aloud, '' when silent
};
// WHICH VIEW A TAP ON A CARD LANDS ON, and it moved. #45 made it the pane, because a
// message list could not show a command and the first person to use the app said so. It is
// the chat now, because the second thing they said after living with it was "convert it to
// a normal chat like the Claude app... the chat is very small" — and the pane's reason
// survives inside the new default rather than being argued away: a blocked session draws a
// red banner in the chat with one button to the pane, which is the only place an answer can
// be typed. Both views are one tap apart, and the pane is still a verbatim capture.
const DEFAULT_VIEW = 'chat';
const LS_LAST = 'gf.last';   // last fetched state, for a cold offline open
const LS_PFS = 'gf.pfs';    // the pane's font size, which is a per-eyesight preference
const LS_VOICE = 'gf.voice'; // { uri, name } of the chosen voice — see pickVoice()
const LS_RATE = 'gf.rate';   // speaking rate, the other half of "make it listenable"

// ── persistence: something to show before the network answers ─────────────
// "Usable offline enough to show the last fetched state rather than a blank page."
// The service worker caches the files; this caches the ANSWER, so a cold open on a
// train paints the fleet as it was and says when that was.
function save() {
  try {
    localStorage.setItem(LS_LAST, JSON.stringify({
      at: Math.floor(Date.now() / 1000), screen: S.screen, project: S.project,
      // THE SESSION NAME TOO. `screen` was saved and this was not, so quitting from a
      // session and reopening restored the session SCREEN with nothing on it: "'null' is
      // not on this fleet's grid any more". It was always broken and was easy to miss
      // while that screen was a card and a row of buttons; it is the whole viewport now.
      session: S.session, view: S.view, profile: S.profile,
      projects: S.projects, grid: S.grid,
    }));
  } catch {}
}
function restore() {
  let j; try { j = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); } catch { return; }
  if (!j) return;
  S.projects = j.projects || null; S.grid = j.grid || null;
  S.project = j.project || null; S.screen = j.screen || 'projects';
  S.session = j.session || null;
  // 'msgs' was the old list view's name and is not a view any more; anything unrecognised
  // falls to the default rather than rendering neither.
  S.view = j.view === 'pane' ? 'pane' : DEFAULT_VIEW;
  // THE SAME CLAMP, FOR THE SAME REASON. A profile is free text and a projects file is
  // edited between opens, so the stored tab can name something that no longer exists —
  // and a tab matching nothing would draw an empty screen over a fleet that has projects
  // in it. Unknown falls to `all`, which is also the default: hiding projects on a first
  // run would be a surprise, and "is anything blocked on me" must not need two looks.
  const tabs = profileTabs(S.projects || []);
  S.profile = (j.profile && (j.profile === PROFILE_ALL || tabs.includes(j.profile))) ? j.profile : PROFILE_ALL;
  // A CLAMP, not a trust. Half-written state is how the screen above happened, and the
  // rule is simple enough to state: you cannot be on a screen whose subject is missing.
  if (S.screen === 'session' && !S.session) S.screen = S.project ? 'grid' : 'projects';
  if (S.screen === 'grid' && !S.project) S.screen = 'projects';
  S.stale = j.at || 0;
  // ...and give the back gesture the trail it would have had if you had walked here. A
  // cold open is at the root of its own history, so without this the first swipe out of a
  // restored session screen leaves the app — the exact complaint, one reopen later.
  seedNav(S.screen === 'session' ? 2 : S.screen === 'grid' ? 1 : 0);
}
function seedNav(depth) { for (let i = 0; i < depth; i++) pushNav(); }

// The card is 32 columns (CW + 2) and it should span the phone. Measured rather than
// assumed: monospace faces differ in advance width, and a guess that is 4% out either
// clips the right border off every card or leaves a gutter.
function fitCards() {
  // Measured with the SAME characters a card is made of, not with 'M' × 32: the box
  // rules and the corners are the glyphs most likely to come from a fallback face, and a
  // fallback advance is what the measurement exists to catch (see the font-weight note
  // in app.css). One weight only, because a card is drawn at one weight — ever.
  const probe = document.createElement('pre');
  probe.style.cssText = 'position:absolute;visibility:hidden;margin:0;font-size:100px;white-space:pre';
  probe.textContent = '╭' + '─'.repeat(G.CARD_COLS - 2) + '╮';
  document.body.appendChild(probe);
  const per = probe.getBoundingClientRect().width / 100;   // em per card, at 100px
  probe.remove();
  const avail = Math.min(document.documentElement.clientWidth - 16, 640);
  const fs = Math.min(Math.max(avail / per, 9), 19);
  document.documentElement.style.setProperty('--fs', fs.toFixed(2) + 'px');
}

// ── loading ───────────────────────────────────────────────────────────────
async function refresh() {
  // Once per unlock, and only ever a no-op after that: a rotated push endpoint is
  // invisible from the phone (push simply stops), so the check rides along with the poll
  // that is already running rather than waiting for someone to open the settings sheet.
  maybeSyncPush();
  try {
    if (S.screen === 'projects') {
      // The payload carries the agent CATALOGUE beside the projects, and both are needed:
      // the list draws the cards, the catalogue fills the picker. Keeping only `.projects`
      // (which is what this line did) left the picker with nothing to offer and no way to
      // tell that apart from a machine with one agent installed.
      const j = await api.getProjects();
      S.projects = j.projects; S.agents = j.agents || [];
    }
    else if (S.screen === 'grid') S.grid = await api.getGrid(S.project);
    else if (S.screen === 'session') {
      S.grid = await api.getGrid(S.project);
      // The pane has its OWN faster timer (panePoll below), so this loop only has to
      // fetch it once, to fill the box on the way in rather than up to a poll later.
      if (S.view === 'pane' && !S.pane) await readPane();
      // Re-read the tail while it is STILL the first page, so a worker that says
      // something new while you are looking at it shows up. Once "load more" has been
      // pressed, leave the loaded pages alone — refetching would throw away the older
      // messages you deliberately went and got.
      //
      // Only while the list is what is on screen. A transcript read is the most
      // expensive call this client makes — /api/session buffers 32 MB because one page
      // is 20 whole assistant turns — and paying for it every five seconds to render
      // nothing is the kind of waste that is invisible until it is a phone bill.
      if (S.view !== 'pane' && (!S.sess || S.sess.pages === 1)) {
        const fresh = await api.getSession(S.project, S.session);
        S.sess = { ...fresh, pages: 1 };
      }
      // Whatever the transcript now says decides whether the optimistic bubble is still
      // telling the truth.
      reconcilePending();
    }
    S.stale = 0;
    save();
  } catch (e) {
    if (e instanceof api.AuthError) return lock('refresh');
    // Offline: keep the cards that are on screen and say how old they are. A blank
    // screen with an error on it is strictly less useful than a stale fleet with a
    // date on it — the question this app answers is "is anything blocked on me", and
    // the answer from ten minutes ago is still worth something.
    if (!S.stale) S.stale = lastFetchedAt();
    toast(e instanceof api.OfflineError ? 'offline — showing the last state fetched' : String(e.message || e), 'bad');
  }
  // NOT render(). The poll checks pollPaused() before it calls this, and then this awaits
  // the network — so the guard was read at the START of a request and acted on at the END
  // of one. Tap into the composer during that window and the keyboard opens, the reply
  // lands, and this line rebuilds #app under it. Over a tailnet from a phone that window is
  // a whole round trip wide, and it is the "the keyboard closes by itself after a while,
  // and I had not typed anything" report: nothing the reader did closed it, a request they
  // never saw came back. Deferred, not dropped — renderWasDeferred() spends it on the next
  // poll after the box loses focus, so the fleet on screen is never more than one interval
  // stale.
  renderUnlessTyping();
}
function lastFetchedAt() {
  try { return (JSON.parse(localStorage.getItem(LS_LAST) || '{}').at) || Math.floor(Date.now() / 1000); }
  catch { return Math.floor(Date.now() / 1000); }
}

// Installed, by either signal. iOS has honoured navigator.standalone since before the
// media query existed and the two have not always agreed, so anything that depends on
// being installed asks both — and the probe reports them SEPARATELY, so one launch says
// which is true here instead of leaving an OR nobody can attribute.
const mmStandalone = () => { try { return !!matchMedia('(display-mode: standalone)').matches; } catch { return false; } };
const navStandalone = () => { try { return !!navigator.standalone; } catch { return false; } };
function markStandalone() {
  try { document.documentElement.classList.toggle('standalone', mmStandalone() || navStandalone()); } catch {}
}

// ── what the screen ACTUALLY measures, from the device ────────────────────
// "still it doesnt use the full screen", in the installed app. The suspicion is that the
// shell's `height: 100dvh` resolves SHORTER than the physical screen in iOS standalone
// with a black-translucent status bar — but that is a suspicion, and the only engine that
// can settle it is the one on the phone. No desktop viewport reproduces it (dvh there is
// the window), and the home-screen app cannot be driven from here.
//
// So the device reports its own geometry, once, after the first layout has settled.
// Everything is an integer in the PATH, because fleet-serve drops query strings.
//
//   ih  innerHeight            sh  screen.height        (CSS px)
//   sl  the shell's bottom edge                          <- 100dvh, resolved
//   cb  the composer's bottom edge, when one is drawn
//   gap innerHeight - the lowest painted edge            <- the band, measured
//   sat/sab  the safe-area insets this page actually resolves
//
// If `sl` comes back short of `sh` by about a status bar, the suspicion is the cause and
// the shape has to stop being sized by dvh. If they match, it is something else and this
// says so before anything is changed.
//   IT WAITS FOR THE SHELL. `#app` only carries `.shell` — and therefore `height: 100dvh`
// — once a real screen is drawn; on the lock screen it is content-height, so a report sent
// at load measures the lock screen and says nothing about the thing under suspicion.
// Measured locally: it came back sl524 against ih844, which is the ship and two buttons,
// not a viewport. So it retries until the shell exists and gives up rather than lying.
//   ONCE PER SCREEN, NOT ONCE PER LAUNCH. The first version reported whichever shell
// appeared first, which is the grid — and the grid has no composer, so it came back cb0
// gap0 and said nothing about the thing the band is under. The composer only exists on the
// chat screen, so the measurement has to be taken there too. Keyed by screen so a launch
// that visits both sends both, and neither repeats on the 5s poll.
const geoSent = new Set();
let geoTries = 0;
function reportGeometry() {
  const el = document.getElementById('app');
  const where = S.screen;
  if (!el || !el.classList.contains('shell')) {
    if (++geoTries < 40) setTimeout(reportGeometry, 1500);
    return;
  }
  if (geoSent.has(where)) return;
  geoSent.add(where);
  try {
    const shell = el;
    const comp = document.querySelector('.composer');
    // env() cannot be read directly; a throwaway element resolves it for us.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;'
      + 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);';
    document.body.appendChild(probe);
    const ps = getComputedStyle(probe);
    const sat = Math.round(parseFloat(ps.paddingTop) || 0);
    const sab = Math.round(parseFloat(ps.paddingBottom) || 0);
    probe.remove();
    const r = shell.getBoundingClientRect();
    const c = comp ? comp.getBoundingClientRect() : null;
    const low = c ? c.bottom : (r ? r.bottom : 0);
    const sa = (mmStandalone() || navStandalone()) ? 1 : 0;
    api.diag('geo', where, 'sa' + sa, 'mm' + (mmStandalone() ? 1 : 0), 'ns' + (navStandalone() ? 1 : 0), 'ih' + Math.round(innerHeight), 'sh' + Math.round(screen.height),
             'sl' + Math.round(r ? r.bottom : 0), 'cb' + Math.round(c ? c.bottom : 0),
             'gap' + Math.round(innerHeight - low), 'sat' + sat, 'sab' + sab);
  } catch {}
}

function lock(why = 'x') {
  api.diag('lock', why, 'tok' + (api.haveToken() ? 1 : 0), 'pend' + (swReloadPending ? 1 : 0));
  S.locked = true; api.clearToken(); render();
  // The session just ended, so a swap that was waiting for it is free now — and this is
  // the moment the poll cannot cover, because the poll does not run while locked. Without
  // this, deferring under a live session would defer until the next cold open.
  takeNewClientIfIdle();
}

// ── tiny DOM ──────────────────────────────────────────────────────────────
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid != null) n.append(kid);
  return n;
}
function btn(label, onclick, cls = '') {
  // The key letter stays in the label. The TUI's footer is muscle memory, and a button
  // that says "p pause" transfers where one that says "Pause" starts again.
  const b = el('button', { class: cls, onclick });
  const m = /^(\S+) (.+)$/.exec(label);
  if (m && m[1].length <= 2) { b.append(el('b', { text: m[1] }), document.createTextNode(' ' + m[2])); b.classList.add('k'); }
  else b.textContent = label;
  return b;
}
function toast(text, kind = '') {
  S.toast = { text, kind };
  clearTimeout(toast._t);
  // ...AND ITS EXPIRY IS A RENDER ON A TIMER, which is the other way the keyboard closed
  // with nobody touching anything. attachPhoto() ends in a toast, and the flow it exists
  // for is: attach a photo, tap the box to say what to do with it, and 4.2 seconds later
  // the toast quietly rebuilt the screen and took the keyboard with it. A toast that
  // outstays its welcome by a few seconds is a toast; one that closes the keyboard is a
  // bug, so this one waits its turn.
  toast._t = setTimeout(() => { S.toast = null; renderUnlessTyping(); }, 4200);
}

// ── render ────────────────────────────────────────────────────────────────
// Which screens own the viewport rather than growing a page under it. The session screen
// has a composer pinned to the bottom and a conversation that scrolls between two fixed
// bars, and the grid has a card list under a header — both are columns of a known height,
// which is what stops the layout moving on a poll.
const SHELL_SCREENS = new Set(['session', 'grid', 'projects']);
// The screens are a STACK, and the depth is what makes a transition directional: the only
// thing motion can say here that a static swap cannot is which way you went.
const SCREEN_DEPTH = { projects: 0, grid: 1, session: 2 };
// ONLY ON A REAL SCREEN CHANGE. render() runs on the 5s poll and after every verb, so
// animating on render would re-run the slide every five seconds on a screen nobody moved
// away from — the Preact path deliberately does not even empty #app, for the same reason.
let navFrom = null, navTimer = null;
function markNav(app, screen) {
  if (navFrom === screen) return;
  const from = navFrom; navFrom = screen;
  if (from === null) return;                       // the first paint is an arrival, not a move
  const d = (SCREEN_DEPTH[screen] ?? 0) - (SCREEN_DEPTH[from] ?? 0);
  if (!d) return;
  try {
    app.classList.remove('nav-fwd', 'nav-back');
    // Reading offsetWidth restarts a CSS animation that is already on the element —
    // without it, walking two screens in under 160ms plays the second one not at all.
    void app.offsetWidth;
    app.classList.add(d > 0 ? 'nav-fwd' : 'nav-back');
    clearTimeout(navTimer);
    navTimer = setTimeout(() => { try { app.classList.remove('nav-fwd', 'nav-back'); } catch {} }, 260);
  } catch {}
}
// THE TWO SCREENS PREACT DRAWS. The session screen is still this file's, built with el().
const PREACT_SCREENS = new Set(['projects', 'grid']);
// Whether Preact currently owns #app. Not derivable from S.screen: the screen can change
// in the same breath as the lock, and what has to be known here is who put the nodes on
// screen, not who would put them there now.
let preactUp = false;
function render() {
  const app = document.getElementById('app');
  // Toggled on <html> as well: the page must not scroll behind a screen that owns the
  // viewport, or a drag near the edge slides the whole app and the scroller under the
  // finger never moves. Guarded — the fake DOM the suite renders into has no classList on
  // documentElement until it needs one.
  const shell = !S.locked && SHELL_SCREENS.has(S.screen);
  try {
    app.classList.toggle('shell', shell);
    document.documentElement.classList.toggle('shell', shell);
  } catch {}
  if (shell) {
    markNav(app, S.screen);
    // A screen this launch has not measured yet gets measured, once it has settled.
    if (!geoSent.has(S.screen)) { geoTries = 0; setTimeout(reportGeometry, 900); }
  } else navFrom = null;
  // ── the Preact screens ─────────────────────────────────────────────────────────────
  // They DIFF, so this path must not empty #app first: the whole gain is that the .cards
  // node survives the 5s poll and keeps the reader's scroll position instead of being
  // rebuilt at scrollTop 0. Emptying happens exactly once, on the way IN from a screen this
  // file draws, and then never again while a card screen is up — INCLUDING across the walk
  // from Projects into a project, which is a screen change Preact handles by keying the two
  // apart (see screens.jsx) rather than by wiping the container out from under it.
  //   Preact renders a fragment straight into #app rather than into a host div, and that is
  // not a style choice: app.css reaches the bands with CHILD selectors
  // (`#app.shell > .cards`, `> .hdr`, `> .verbs`), so one div of nesting would stop the
  // card list being the screen's scrolling region and let the whole page scroll.
  if (!S.locked && PREACT_SCREENS.has(S.screen)) {
    if (!preactUp) {
      app.textContent = '';
      paneBoxNode = paneNode = paneGeomNode = null;
      composerNode = null;
      preactUp = true;
    }
    screensUI.mount(app, S.screen, S.screen === 'grid' ? gridProps() : projectsProps());
    renderSheet();
    syncPanePoll();
    return;
  }
  // LEAVING IT IS AN UNMOUNT, NOT A `textContent = ''`. Clearing the container behind
  // Preact's back leaves it holding a vnode tree whose DOM is gone, and the next time this
  // screen opens it diffs against nodes that no longer exist. Rendering null is what tears
  // the tree down — and it has to happen BEFORE the wipe below, while the nodes are still
  // there to be removed.
  if (preactUp) { screensUI.unmount(app); preactUp = false; }
  app.textContent = '';
  // The pane's nodes are about to be thrown away; drop the references with them, so a
  // poll that lands mid-render patches nothing rather than a detached <pre>.
  paneBoxNode = paneNode = paneGeomNode = null;
  composerNode = null;                      // re-set by composer() if this render draws one
  if (S.locked) { app.append(lockScreen()); renderSheet(); syncPanePoll(); return; }
  // Only the session screen reaches here now: `projects` and `grid` returned above, and
  // the lock screen returned above that. Left as a bare call rather than a ternary with one
  // live arm, which would read as a choice that no longer exists.
  const screen = sessionScreen();
  // THE TOAST GOES ABOVE THE COMPOSER, IN FLOW — it is a band of the shell column now, not
  // a fixed overlay, so where it sits in this array is where it sits on screen. Appending
  // it last put it BELOW the input on the session screen, which with the old
  // `position: fixed` meant it landed on top of the input and the newest message:
  // "dont blok the chat with toasts". Splicing it in front of the composer is what makes
  // overlap impossible rather than merely unlikely — the scroller above simply gets shorter
  // by the toast's height for as long as it is up.
  if (S.toast) {
    const t = el('div', { class: ('toast ' + (S.toast.kind || '')).trim(), text: S.toast.text });
    const ci = screen.findIndex(n => n && n.classList && n.classList.contains('composer'));
    if (ci >= 0) screen.splice(ci, 0, t); else screen.push(t);
  }
  app.append(...screen);
  renderSheet();
  // Every state change that matters to the pane's timer — the screen, the view, a sheet,
  // a confirmation, the lock — has already been applied by the time we get here, which is
  // why this is the single place that starts and stops it.
  syncPanePoll();
}

// header() USED TO LIVE HERE AND IS GONE. It drew the one-line header for the two screens
// that were not ported; gridScreen() was its last caller, and porting the grid took that
// caller with it. The header is now drawn once, by screens.jsx's Header, from the same data
// — which is the point of the port and not a side effect of it: two renderers each holding
// their own copy of `[profile:project] ⚠ offline …` is how a header comes to say different
// things on two screens without anybody being able to see it happen.
// WHICH FLEET AM I LOOKING AT — on every screen, without opening settings. The lock
// screen has always said it, and the lock screen is the one thing you dismiss: the phone
// that was shown four fictional projects had gone past it, and the only clue left was
// recognising the project names. So the answer lives in the header, which every screen
// draws, and it names the ORIGIN rather than saying "server" — two fleets are two
// origins, and "server" would not tell them apart.
// SPLIT INTO THE ANSWER AND THE DRAWING OF IT, because two screens now draw it with two
// renderers. The ported Projects screen builds this span in Preact and the grid and session
// screens build it with el(); if each decided for itself what "server" is called, the
// header would name the fleet differently depending on which screen you were looking at.
// The words are decided once, here.
function modeSpec() {
  const r = api.resolution();
  return {
    kind: r.mode,
    detail: r.detail,
    text: r.mode === 'server' ? '\u25cf ' + api.modeLabel()
        : r.mode === 'probing' ? '\u2026 looking for a fleet'
        : '\u26a0 fixtures',
  };
}
function modeChip() {
  const m = modeSpec();
  return el('span', { class: 'mode ' + m.kind, text: m.text, title: m.detail });
}

// ── the projects screen, and its tabs ─────────────────────────────────────
// "add like tabs on the projects page to differentiate between work and personal."
//
// THE NUMBER ON A PROJECT CARD IS AN ADDRESS, NOT A POSITION IN WHAT YOU CAN SEE, and
// that is the whole reason this is not a one-line filter. `Ctrl-f <p>` at the desk
// resolves through bin/ghostfleet's proj_nth(), which counts EVERY non-comment line of
// ~/.config/ghostfleet/projects — no profile filter anywhere on that path, and
// fleet-grid's own pBuild() and fleet-serve's /api/projects are equally unfiltered. So
// the digit is global, across profiles, and the phone's merged list has always agreed
// with it. Number a filtered array and card "2" in the personal tab is a project that
// `Ctrl-f 2` does not open — a digit that sends you to the wrong project is worse than
// no digit. The tab decides what is DRAWN and never what a card is CALLED.
//   (docs/OPERATIONS.md said the project digit was "its position in its profile's list".
// It was not, and that sentence is corrected in this change: it is exactly the belief
// that would turn this into a per-tab index.)
const PROFILE_ALL = 'all';
// `profile || 'work'` is readProjects()'s own default (bin/fleet-grid.mjs), so a project
// whose column is blank lands in the same tab the desk puts it in. The field is free
// text — `ghostfleet <profile>` takes any name — so the tabs are DERIVED and a profile
// nobody anticipated gets its own tab rather than disappearing.
const profileOf = (p) => (p && p.profile) || 'work';

// ── the demo fleet, and when it is in the way ─────────────────────────────
// "hide the demo account from the real phone."
//
// THIS IS THE ONLY MERGED SCREEN, which is why the demo shows up here and on no other
// screen. Every screen a person browses is scoped to ONE profile — bin/ghostfleet sets
// PROJECTS_CFG per profile, fleet-grid's pBuild() reads that one file, and the stack
// screen reads it too — so a `demo` profile is invisible at the desk unless you type
// `ghostfleet demo`. /api/projects merges every projects.* file (mcp/fleet-dispatch.mjs),
// and this list is what that returns. So this is not a phone-specific carve-out: it is
// the one SCREEN the merge reaches.
//   OTHER MERGED READERS EXIST AND MUST STAY COMPLETE. `fleet-project list`, `rm` and
// `agent` walk every profile on purpose, bin/ghostfleet walks them to explain an unknown
// profile, and the MCP's projects() does too. Those are explicit enumerations — you asked
// for every project — and a demo row hidden from them is one you can no longer see or
// remove. Hiding belongs in the surface somebody BROWSES, never in the data underneath.
//
// THE RULE IS DERIVED, NOT CONFIGURED: the demo is hidden once there is real work to hide
// it from, and shown IN FULL when it is all there is. A setting would be a second thing to
// keep in step with a file anyone can edit by hand, and this cannot go stale — it is the
// same shape as the tab strip below, which does not draw itself when there is only one
// profile to choose.
//   THE CASE THIS IS OPTIMISED FOR IS THE NEW USER. Somebody who followed the README ran
// `ghostfleet demo` and has nothing else; hiding it from THEM would open the app on an
// empty screen and undo the first-run flow that put them there. A rule that makes the demo
// invisible to the person it was built for is worse than the bug it fixes, so the "all
// there is" branch is the one that comes first here.
//
// It costs a false positive: somebody whose OWN profile is called `demo` sees it hidden on
// the phone once they have other projects. `demo` is the name bin/fleet-demo writes and
// bin/ghostfleet documents as the profile that builds itself, so it is ours by convention
// — and the recovery is to call the profile something else. Recorded because it is a real
// case, not because it is a likely one.
const DEMO_PROFILE = 'demo';
const isDemo = (p) => profileOf(p) === DEMO_PROFILE;
export function demoHidden(projects) {
  const all = projects || [];
  return all.some(isDemo) && all.some(p => !isDemo(p));
}
// Every row keeps the index it has in the WHOLE list. Hiding is a DRAWING decision, the
// same as a tab — see the address note above: the digit on a card is what `Ctrl-f <p>`
// counts at the desk and what the number key opens here, and `list` in the key handler is
// deliberately the unfiltered one. Filter the array the index counts and every card after
// the demo block is renamed, which is the one thing this screen must never do.
// The need count behind a tab's ● badge. Over the SHOWN rows, for the same reason the
// tabs are built from them: an `all` badge that includes a hidden demo advertises a
// blocked project with no card anywhere to open — the "a tab can hide the answer" failure
// this count exists to prevent, arriving from the other side.
export function tabNeed(projects, name) {
  return shownProjects(projects)
    .filter(({ p }) => name === PROFILE_ALL || profileOf(p) === name)
    .reduce((n, { p }) => n + (((p.sessions || {}).need) || 0), 0);
}
export function shownProjects(projects) {
  const rows = (projects || []).map((p, i) => ({ p, i }));
  return demoHidden(projects) ? rows.filter(({ p }) => !isDemo(p)) : rows;
}
export function profileTabs(projects) {
  const seen = [];
  // Built from what is DRAWN, so a hidden demo takes its tab with it. Leaving the tab
  // would answer "hide the demo" with the word `demo` still on screen, one tap from the
  // thing that was meant to be gone.
  for (const { p } of shownProjects(projects)) { const k = profileOf(p); if (!seen.includes(k)) seen.push(k); }
  return seen;                     // in the projects file's own order, which is the address order
}
// Every entry carries the index it has in the WHOLE list, because that index is the name.
// Falls back to showing everything when the stored tab matches nothing: a clamp runs on
// restore (below), and this is the second line of defence, because the one thing this
// must never do is draw an empty screen over a fleet that has projects in it.
function visibleProjects() {
  const rows = shownProjects(S.projects || []);
  if (S.profile === PROFILE_ALL) return rows;
  const mine = rows.filter(({ p }) => profileOf(p) === S.profile);
  // The fallback is why this cannot leak the demo back: a stored `demo` tab survives in
  // S.profile until the next load clamps it (see restore), and while it does, `mine` is
  // empty — so this returns the SHOWN rows rather than the raw list. Returning `all` here
  // would put the demo back on screen at the one moment the user is on its tab.
  return mine.length ? mine : rows;
}
function setProfile(name) {
  S.profile = name;
  // The cursor is a GLOBAL index too, so switching tabs has to move it to something that
  // is on screen — otherwise `⏎ open` and `x remove` act on a card nobody can see.
  const vis = visibleProjects();
  S.sel = vis.length ? vis[0].i : 0;
  save();
  render();
}
// THIS SCREEN IS DRAWN BY PREACT, and this function is everything the components need to
// know. It builds no boxes: web/src/screens.jsx owns the header, the tab strip, the
// .cards container, the verbs and the hint, and the seam between the two is written out at
// the top of that file. What stays here is the part that is SHARED with the grid screen —
// the card and its four gestures — plus every string, because §7's guardrails are the
// TUI's own words and pwa-check reads them out of this file.
function projectsProps() {
  const projects = S.projects || [];
  const names = profileTabs(projects);
  // THE CURSOR CANNOT SIT ON A CARD NOBODY DRAWS. S.sel is a global index and starts at 0,
  // which is normally the first work project — but the merged order is the work file and
  // then projects.* alphabetically, so an empty work file puts a `demo` row at index 0
  // while personal projects exist further down. The cursor would then be on a hidden card:
  // no ring anywhere, and `⏎ open` acting on a project that is not on screen. Same clamp
  // the file already applies on the grid screen, for the same reason.
  const shown = shownProjects(projects);
  if (shown.length && !shown.some(v => v.i === S.sel) && S.sel !== projects.length) S.sel = shown[0].i;
  return {
    scope: '— projects',
    mode: modeSpec(),
    stale: S.stale,
    // NO STRIP WHEN THERE IS NO CHOICE. One profile is the common case — everything is
    // 'work' — and a control whose only option is the one you are already on is furniture.
    // The component redraws nothing when this is null.
    tabs: names.length > 1 ? [PROFILE_ALL, ...names].map(name => ({
      name,
      on: S.profile === name,
      // THE NEED-YOU COUNT RIDES ON THE TAB, and only when it is not zero. §1 says this
      // app exists to answer "is anything blocked on me", and a tab is the one control
      // here that can HIDE the answer — a blocked project in the other profile would be
      // off screen with nothing anywhere to say so, which is the same failure as the
      // summary reading "0 need you" over a blocked lead. Silent when there is nothing
      // to report, so the strip stays a chooser rather than a dashboard.
      need: tabNeed(projects, name),
    })) : null,
    onTab: setProfile,
    confirm: confirmSpec(),
    // ── the seam ────────────────────────────────────────────────────────────────────
    // Real DOM, built by cardEl(), which wires the four gestures. Preact places these into
    // the list and is told nothing else about them; see web/src/screens.jsx.
    // NULL, NOT EMPTY, is the difference between "still asking" and "you have no projects".
    // An empty list is a real answer and gets the first-run path; a null one has not been
    // answered yet and gets the wait.
    cards: S.projects == null ? skeletonCards(4) : [
      ...visibleProjects().map(({ p, i }) =>
        // i is the GLOBAL index, on purpose
        cardEl(G.projectModel(p, i, i === S.sel), {
          tap: () => openProject(p.name),
          longPress: () => { S.confirm = { kind: 'project', name: p.name }; render(); },
          reorder: d => reorderProject(p.name, d),
        }, i)),
      cardEl(G.addProjectModel(S.sel === projects.length), {
        tap: () => sheetAddProject(),
      }, projects.length),
    ],
    // THE SCROLL MEMORY STAYS HERE, and it is still the same one call that does both
    // halves. It fires once, when Preact creates the list, rather than on every render —
    // because the list is no longer rebuilt on every render, which is the thing this whole
    // port is meant to demonstrate. What it still has to do is restore a position after
    // the screen has been LEFT and come back to.
    listRef: (list) => { if (list) watchScroll('projects', list); },
    // BEHIND THE `⋯`, NOT A FOOTER. Same verbs, same words — this is still screen verbs
    // only, and `remove` is still here rather than in a per-card sheet because a project
    // has no such sheet, and it is still gated by the confirm bar carrying the TUI's own
    // question. What changed is where you reach them from.
    onMore: () => sheetMore('actions', '— projects', [
      { label: 'open', cls: 'go', onClick: () => openProject((projects[S.sel] || {}).name) },
      // the projects screen schedules a message to THAT project's master
      { label: 'schedule', onClick: () => { const p = projects[S.sel]; if (p) sheetSchedule('master', p.name); } },
      { label: 'settings', onClick: () => sheetSettings() },
      { label: 'remove', cls: 'danger', onClick: () => { const p = projects[S.sel]; if (p) { S.confirm = { kind: 'project', name: p.name }; render(); } } },
    ], PROJECTS_HINT),
    toast: S.toast,
  };
}
const PROJECTS_HINT = 'tap a project · long-press to remove it from the list · drag its title to reorder';
// `Q` / Ctrl-p jumps straight to Projects from anywhere, which is neither forward nor
// back. Unwinding our own entries keeps the stack honest: pushing here would leave the
// gesture retracing grid → session screens you have already left, and leaving the stack
// alone would make the first back-gesture from Projects exit the app.
function toProjects() {
  const n = navDepth;
  S.screen = 'projects'; S.sel = 0; S.session = null; S.sess = null; S.pane = null;
  S.pending = null; S.speakSel = ''; stopSpeaking();
  navDepth = 0;
  if (n > 0 && typeof history !== 'undefined' && typeof history.go === 'function') {
    try { history.go(-n); } catch {}    // popstate fires; popTo() sees screen==='projects'
  }
  render(); refresh();
}

function openProject(name) {
  if (!name) return;
  S.project = name; S.screen = 'grid'; S.sel = 0; S.grid = null;
  // Another project's card list is a different list; row 12 of it means nothing here.
  scrollMem.delete('grid');
  pushNav();                          // so the back gesture returns to Projects, not out
  render(); refresh();
}

// The projects list reorders the same way the grid does, and for the same reason: the
// digit on a project card is what `Ctrl-f <p>` counts, so the order has to persist.
async function reorderProject(name, delta) {
  const names = (S.projects || []).map(p => p.name);
  const i = names.indexOf(name);
  if (i < 0 || !delta) return;
  // ONE PRESS IS ONE VISIBLE STEP, which means moving PAST the hidden ones. This writes
  // the shared order file that the desk then counts, and inside a tab the neighbour above
  // may be in another profile: a single-step swap would either look like nothing happened
  // (it traded places with a card you cannot see) or like a jump of two. The gesture has
  // to mean what it looks like, so the target is the next VISIBLE neighbour and the
  // project lands directly beside it in the real order.
  //   In the `all` tab every neighbour is visible, so this is exactly the single step it
  // has always been — one path, not a special case.
  const vis = visibleProjects().map(v => v.i);
  const at = vis.indexOf(i);
  const to = at + (delta > 0 ? 1 : -1);
  if (at < 0 || to < 0 || to >= vis.length) return;
  const ni = vis[to];
  names.splice(ni, 0, ...names.splice(i, 1));
  S.sel = ni;
  await doVerb('fleet_project_order', { order: names }, { quiet: true });
}

// ── the grid ──────────────────────────────────────────────────────────────
// buildItems(): the cards, then the free worktrees, then `+ new session`. The order is
// load-bearing — it is what the digit on each card counts.
function items() {
  const g = S.grid || { cards: [], free_worktrees: [] };
  return [
    ...(g.cards || []).map(c => ({ card: c })),
    ...(g.free_worktrees || []).map(w => ({ freeWt: w })),
    { newCard: true },
  ];
}
// The four counts that fit a phone row, each a tile. ONLY A NON-ZERO COUNT IS COLOURED:
// a strip where every tile is lit says nothing, and the question this app exists to answer
// is which one is not zero. The hue is the status's own — the same one the card's rail and
// chip use — so the strip and the cards teach one colour vocabulary.
const STRIP = [
  ['need you', 'need_you', 'red'],
  ['working', 'working', 'cyan'],
  ['ready', 'ready', 'green'],
  ['parked', 'parked', 'grey'],
];
// THE FOUR WORDS STAY IN THIS FILE, and the tiles cross the seam as data. §7 is that the
// guardrails ARE the TUI's own prompts, and what enforces it is pwa-check grepping
// web/app.js for that wording — so a label moved into screens.jsx is a label that check can
// no longer see. screens.jsx's CountStrip draws boxes and is handed the words, the numbers
// and the resolved hue; it writes none of the three.
function stripTiles(counts) {
  const c = counts || {};
  return STRIP.map(([label, key, color]) => ({ label, n: c[key] || 0, color: G.COLORS[color] }));
}

// ── the grid screen, as props ─────────────────────────────────────────────
// PROPS, NOT NODES, AND THAT IS THE WHOLE FIX. This used to be gridScreen(), which built a
// fresh div.cards on every call — and render() is called by the 5s poll. A fresh element
// starts at scrollTop 0, so the scroll memory had to RESCUE the reader's position after
// every poll, racing layout to do it before the eye caught up. Reported from a real iPhone:
// "i scroll the sessions and after some seconds it goes all the way up again". Now the
// container is Preact's and outlives the render, so there is no position to rescue.
function gridProps() {
  const g = S.grid || { cards: [], free_worktrees: [] };
  const its = items();
  // buildItems() clamps `sel` after every rebuild, and so does this: a session that was
  // stopped while you were on another screen leaves the selection past the end, and every
  // verb in the footer then acts on `undefined` — silently, since each one guards.
  S.sel = Math.max(0, Math.min(S.sel, its.length - 1));
  // From the CARDS, as renderGrid does, so the summary cannot disagree with what is
  // under it. §4 ships `counts` as well; if the two ever differ, the cards win —
  // they are what you can see.
  // THE SUMMARY AS NUMBERS, NOT AS A SENTENCE. `0 need you · 2 working · 5 ready` is a
  // clause you have to read to the end before you know whether it concerns you; four tiles
  // are a thing you glance at, and the one that matters is the one that is not zero.
  //   The WORDS and the ARITHMETIC are unchanged — countsFrom() over the cards, and the
  // TUI's own vocabulary — so the strip and the desk's header cannot disagree. The header
  // still gets the same counts and still draws them, because on a narrow screen the strip
  // is the glance and the header line is the detail (interrupted, at limit, parked, which
  // are appended only when non-zero and would make four tiles into eight).
  const counts = G.countsFrom(g.cards || []);
  const sel = its[S.sel] || {};
  return {
    scope: `[${(S.grid && S.grid.profile) || ''}:${S.project || ''}]`,
    mode: modeSpec(),
    stale: S.stale,
    // WORDED AND COLOURED HERE, drawn there. countsSegments() is grid.js's, so the phone's
    // header and the desk's are the same sentence; the palette lookup happens on this side
    // of the seam so that screens.jsx contains no hex at all.
    counts: G.countsSegments(counts).map(seg => ({ text: seg.text, color: seg.color ? G.COLORS[seg.color] : null })),
    strip: stripTiles(counts),
    confirm: confirmSpec(),
    // ── the seam ────────────────────────────────────────────────────────────────────
    // Real DOM, built by cardEl(), which wires the four gestures. Preact places these into
    // the list and is told nothing else about them; see web/src/screens.jsx.
    // Same rule as the projects screen: a null grid has not been answered yet, an empty one
    // has. `its` always carries the `+ new session` card, so length alone cannot tell them
    // apart — ask S.grid itself.
    cards: S.grid == null ? skeletonCards(6) : its.map((it, idx) => {
      const isSel = idx === S.sel;
      if (it.newCard) return cardEl(G.newModel(isSel), { tap: () => sheetPicker() }, idx);
      if (it.freeWt) {
        return cardEl(G.freeModel(it.freeWt, isSel, idx), {
          tap: () => sheetName({ cwd: it.freeWt.path, name: G.basename(it.freeWt.path), reuse: it.freeWt.path }),
          longPress: () => askRemoveWorktree(it.freeWt),
        }, idx);
      }
      const c = it.card;
      return cardEl(G.cardModel(c, isSel, idx), {
        tap: () => (c.asleep ? wakeSession(c.name) : openSession(c.name)),
        longPress: () => askKill(c.name),
        swipeLeft: () => pauseSession(c.name),
        swipeRight: () => resumeSession(c.name),
        reorder: d => reorder(c.name, d),
      }, idx);
    }),
    // ONCE, WHEN PREACT BUILDS THE LIST — not on every render, which is what the old
    // `out.push(watchScroll('grid', list))` amounted to. What it still has to do is restore
    // a position after the screen has been LEFT and come back to; what it no longer has to
    // do is rescue one from a rebuild that no longer happens.
    listRef: (list) => { if (list) watchScroll('grid', list); },
    // ── the footer: touch targets, and only the SCREEN's verbs ────────────────
    // Nine key-letter buttons wrapped to three rows, ate ~190px and overlaid the last card.
    // The letters were muscle memory borrowed from the TUI, and there is no keyboard on a
    // phone for them to transfer to.
    //   WHAT SPLIT THEM: a verb that acts on the SCREEN stays in the footer; a verb that
    // acts on the SELECTED CARD moves into that card's actions sheet, behind `more`. That is
    // not just tidying — a footer button that acts on whatever happens to be selected is the
    // control most likely to be pressed against the wrong thing, and the sheet names the
    // session in its title before it offers anything destructive.
    //   The gestures that already existed cover the common two without either: swipe ←
    // pause, swipe → resume, long-press = x. The sheet's last line says so.
    //   AND THE FOOTER ITSELF IS GONE. Two rows of 44px plus a three-line hint was 179 of
    // 844 points, 21% of the screen, and the card list got 536 — three of nine sessions.
    // The verbs are the same verbs with the same words, reached from the `⋯` in the header,
    // which is the control the session screen has had since #7.
    onMore: () => sheetMore('actions', `[${(S.grid && S.grid.profile) || ''}:${S.project || ''}]`, [
      { label: 'open', cls: 'go',
        onClick: () => { if (sel.card) openSession(sel.card.name); else if (sel.freeWt) sheetName({ cwd: sel.freeWt.path, name: G.basename(sel.freeWt.path), reuse: sel.freeWt.path }); else sheetPicker(); } },
      { label: 'new', onClick: () => sheetPicker() },
      { label: 'worktrees', onClick: () => sheetWorktree() },
      // Only when there is something for it to act on — see sheetMore on why a disabled
      // row earns a line in a footer and not in a sheet.
      sel.card ? { label: 'more', onClick: () => sheetActions(sel.card.name) }
               : { label: 'more', cls: 'off', onClick: () => {} },
      { label: 'settings', onClick: () => sheetSettings() },
      { label: 'projects', onClick: () => toProjects() },
    ], GRID_HINT),
    toast: S.toast,
  };
}
// THE GRID'S HINT, STILL THIS FILE'S STRING. It is the TUI's own wording (§7) and pwa-check
// greps web/app.js for it; it moved out of a permanent band and into the sheet, not out of
// this file.
const GRID_HINT = 'tap a card · swipe ← pause · swipe → resume · long-press = x · drag a card\'s title to reorder';

// ⇧hjkl → drag. reorderSession(name, delta) is the TUI's own move, and at nc = 1 all
// four of its keys collapse to ±1 — H/L move one card, K/J move one row, and one row
// IS one card here.
async function reorder(name, delta) {
  const cards = (S.grid && S.grid.cards) || [];
  const i = cards.findIndex(c => c.name === name);
  if (i < 0 || !delta) return;
  // THE LEAD DOES NOT MOVE AND IS NOT IN THE ORDER. <sock>.order is written from the
  // TUI's own cards, which never include master, and the emitter puts the lead first
  // regardless of what that file says — so dragging it would be a card that springs back
  // on the next poll, and sending its name would put a line in the order file that
  // nothing will ever match.
  if (cards[i].lead) return;
  const ni = Math.max(0, Math.min(cards.length - 1, i + delta));
  if (ni === i || cards[ni]?.lead) return;
  const moved = cards.slice();
  moved.splice(ni, 0, ...moved.splice(i, 1));
  S.sel = ni;
  await doVerb('fleet_order', { project: S.project, order: moved.filter(c => !c.lead).map(c => c.name) }, { quiet: true });
}

// ── reading a message aloud ─────────────────────────────────────────────────
// "add smth to reproduce the last message like an audio". SpeechSynthesis, which is in
// the browser already — no network call, no key, nothing for the CSP to refuse and no
// second service to keep alive. It is also the only way this app produces output you can
// take in without looking at it, which on a phone is the point.
//
// WHAT IS SPOKEN IS NOT WHAT IS WRITTEN. An assistant turn is markdown with code in it,
// and a synthesiser reads `**` and backticks and a 40-line diff out loud, one character at
// a time. So fenced blocks become the words "code block" (you cannot follow code by ear,
// and pretending otherwise wastes a minute of listening), inline code keeps its text
// without its backticks, links become "link", and the emphasis marks go. Capped, because
// a whole turn can be thousands of characters and there is no way to skim a voice.
//
// AND IDENTIFIERS ARE NAMED, NOT SPELLED. "it has a bunch of numbers and stuff that is not
// relevant" — a 40-character sha is read one character at a time, which is most of a minute
// for a string nobody could write down from a speaker anyway. Neither could they write down
// a UUID, an ISO timestamp, `\x1f`, or four directories on the way to a filename.
//
// THE LINE IS NOT "NUMBERS ARE NOISE", and a normaliser that dropped every digit would be
// worse than doing nothing. It is ADDRESS versus FACT. An address is a thing you would have
// to READ to act on, so speech can only name it: say that a commit was involved, not which.
// A fact is a thing you act on BY EAR and it has to survive intact — "1885 passed, 0 failed"
// is the whole content of that sentence, and so are #1171, 2.1.241, 40% and 6s. Those are
// asserted, in test/helpers/speak-check.mjs, in both directions on purpose: a test that only
// checks that noise is gone is passed by returning the empty string.
const SPEAK_MAX = 1200;
// A left edge that cannot itself be part of an identifier, as a capturing group rather than
// a lookbehind: lookbehind only reached Safari in 16.4, this app supports the phones that
// installed it (§9's 16.4+ is about Web Push, not about parsing), and an unsupported regex
// literal is a PARSE error — the whole client, blank, not one feature degraded.
const IDENT_EDGE = '(^|[^\\w./~@+-])';
const pathSpoken = (p, line) => {
  // The basename is a NAME — it is usually what the sentence is about ("fixed fleet-grid")
  // — and everything left of it is the address. The line number stays: it is one short
  // word by ear, and it is the difference between "there is a bug in that file" and "there
  // is a bug at that spot", which is the only part of a path a listener can act on.
  const base = p.replace(/\/+$/, '').split('/').pop() || p;
  return line ? `${base} line ${line.slice(1)}` : base;
};
function sayIdentifiers(t) {
  // Most specific first, because the general patterns would eat the parts of these: the
  // sha rule matches the first block of a UUID, and the octal rule the tail of an escape.
  t = t.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, 'a timestamp');
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'an id');
  t = t.replace(/\b0x[0-9a-f]+\b/gi, 'a hex id');
  t = t.replace(/\\(?:x[0-9a-f]{2}|u\{?[0-9a-f]{4,6}\}?|[0-7]{2,3})/gi, 'an escape code');
  // A path, rooted (/a/b, ./a, ../a, ~/a) or relative with a dotted last segment (bin/x.mjs).
  // The dot is what keeps `@anthropic-ai/claude-code` and `feat/retry-backoff` whole: a
  // package and a branch are names you act on, and they read perfectly well aloud.
  t = t.replace(new RegExp(IDENT_EDGE + '((?:~|\\.{1,2})?\\/[\\w.@+~-]+(?:\\/[\\w.@+~-]+)*)(:\\d+)?(?::\\d+)?', 'g'),
                (m, pre, p, line) => pre + pathSpoken(p, line));
  t = t.replace(new RegExp(IDENT_EDGE + '([\\w.@+~-]+(?:\\/[\\w.@+~-]+)*\\/[\\w.@+~-]*\\.\\w+)(:\\d+)?(?::\\d+)?', 'g'),
                (m, pre, p, line) => pre + pathSpoken(p, line));
  t = t.replace(new RegExp(IDENT_EDGE + '([\\w.@+~-]*\\.\\w+):(\\d+)(?::\\d+)?', 'g'),
                (m, pre, f, n) => `${pre}${f} line ${n}`);
  // A git sha. The guard is what separates it from a count and from a word: below 12
  // characters it has to look like hex ON PURPOSE — at least one digit AND at least one
  // a-f — so "1234567" stays a number and "cabbage" stays a word. At 12 and up, nothing
  // that long is anything but an address. Called "a commit" because in this app's
  // transcripts that is what it always is; a hash that is not one still comes out as
  // "an address was elided here", which is the part that matters.
  t = t.replace(new RegExp('(^|[^\\w.-])([0-9a-f]{7,40})(?![\\w.-])', 'g'),
                (m, pre, h) => (h.length >= 12 || (/\d/.test(h) && /[a-f]/.test(h))) ? pre + 'a commit' : m);
  // "1885 passed / 0 failed" is spoken "slash", which is a word that is not in the sentence.
  t = t.replace(/ \/ /g, ', ');
  return t;
}
export function speakable(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' … code block … ');   // fenced code: named, not read
  t = t.replace(/`([^`]*)`/g, '$1');                      // inline code: the text, not the ticks
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1 link'); // [label](url) -> "label link"
  t = t.replace(/https?:\/\/\S+/g, ' link ');            // and a bare one
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');               // heading marks
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');                // bullet marks
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\W)[*_]([^*_]+)[*_](\W|$)/g, '$1$2$3');
  // AFTER the markdown pass, so a path inside backticks is a path by the time it gets here
  // and a URL is already the word "link"; BEFORE the cap, so the 1200 characters are spent
  // on words instead of on an address that will not be read out.
  t = sayIdentifiers(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > SPEAK_MAX ? t.slice(0, SPEAK_MAX).replace(/\s\S*$/, '') + '… and it goes on.' : t;
}
const canSpeak = () => {
  try { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function'; }
  catch { return false; }
};

// ── which voice, and the three ways asking that question goes wrong ──────────
//
// THE LIST IS EMPTY THE FIRST TIME YOU ASK. getVoices() returns [] on the first call in
// Safari and fills in later, announcing it with `voiceschanged`. A picker built once, at
// boot, therefore ships empty on the device this app is for. So: subscribe once, and
// re-render the sheet if it is open when the list arrives.
let voicesCache = [];
let voicesHooked = false;
export function allVoices() {
  if (!canSpeak()) return [];
  try {
    const v = speechSynthesis.getVoices();
    if (v && v.length) voicesCache = v;
  } catch {}
  if (!voicesHooked) {
    voicesHooked = true;
    try {
      speechSynthesis.addEventListener('voiceschanged', () => {
        try { voicesCache = speechSynthesis.getVoices() || voicesCache; } catch {}
        // Only if the settings sheet is the thing on screen: a list arriving while you are
        // reading a transcript must not redraw the transcript under your thumb.
        if (S.sheet === 'settings') render();
      });
    } catch {}
  }
  return voicesCache;
}
// THE LIST DIFFERS PER DEVICE, so what is stored is an IDENTITY and not an index: a phone
// and a tablet do not have the same voices, and position 7 is a different person on each.
// Both fields are kept because voiceURI is the exact match and name is what survives an OS
// upgrade that renumbers the URIs.
function savedVoice() {
  try { const j = JSON.parse(localStorage.getItem(LS_VOICE) || 'null');
        return (j && typeof j === 'object' && (j.uri || j.name)) ? j : null; } catch { return null; }
}
function setSavedVoice(v) {
  try { v ? localStorage.setItem(LS_VOICE, JSON.stringify({ uri: v.voiceURI, name: v.name }))
          : localStorage.removeItem(LS_VOICE); } catch {}
}
// A SAVED VOICE THAT IS NOT HERE MUST STILL SPEAK. Returning null means "whatever the
// browser defaults to", which is what an unset preference means too — so the phone that
// has the voice and the tablet that does not both read the message out, and neither shows
// an error about a preference. Falling back loudly would be a setting that breaks the app
// on the second device.
export function pickVoice() {
  const want = savedVoice();
  if (!want) return null;
  const vs = allVoices();
  return vs.find(v => v.voiceURI === want.uri) || vs.find(v => v.name === want.name) || null;
}
export function savedRate() {
  let r = NaN;
  try { r = Number(localStorage.getItem(LS_RATE)); } catch {}
  return Number.isFinite(r) && r >= 0.5 && r <= 2 ? r : 1.05;
}
function stopSpeaking() {
  if (!canSpeak()) { S.speaking = ''; return; }
  try { speechSynthesis.cancel(); } catch {}
  S.speaking = '';
}
// A TOGGLE, and it is the same button both ways: tapping the one that is speaking stops
// it. Two voices at once is the failure mode of a play button that is really two buttons.
export function toggleSpeak(text) {
  if (!canSpeak()) { toast('this browser has no speech synthesis', 'bad'); return; }
  const say = speakable(text);
  if (!say) { toast('nothing to read out in that message', 'bad'); return; }
  const wasSpeaking = S.speaking;
  stopSpeaking();
  if (wasSpeaking === say) { render(); return; }        // tapped the one that was talking
  S.speaking = say;
  try {
    const u = new SpeechSynthesisUtterance(say);
    // The rate that was hardcoded here is now the default of a setting; the voice is null
    // when nothing is saved or the saved one is absent, and null is exactly what the
    // browser treats as "your default". speakable() is untouched by either — what gets
    // normalised and what reads it out are different questions.
    u.rate = savedRate();
    const voice = pickVoice();
    if (voice) { u.voice = voice; if (voice.lang) u.lang = voice.lang; }
    // Cleared when it finishes on its own, or the button stays lit for a voice that
    // stopped talking a minute ago. `onerror` too: iOS refuses to speak at all until a
    // gesture has unlocked audio, and a stuck highlight is how that looks from outside.
    u.onend = () => { if (S.speaking === say) { S.speaking = ''; render(); } };
    u.onerror = () => { if (S.speaking === say) { S.speaking = ''; render(); } };
    speechSynthesis.speak(u);
  } catch { S.speaking = ''; toast('speech synthesis refused to start', 'bad'); }
  render();
}

// ── the session screen ────────────────────────────────────────────────────
// WHAT A TAP ON A CARD LANDS ON IS THE PANE, and that is the whole of this change.
//
// It used to land on a message list, and the first person to use the app said why that
// was wrong: "it doesn't look like a normal chat and i can't see the commands that is
// running." Both halves, one cause. /api/session goes through `fleet-read --json`, whose
// payload is {ts, role, text} — assistant and user prose — so a tool call, the command
// inside it and its result are not in the data at all. The list was not under-rendering
// them; it never had them. Pressing ⏎ on a card at the desk ATTACHES to the tmux pane,
// and what you get is the Claude Code TUI: ⏺ bullets, ⎿ tool results, the spinner, the
// permission dialog. "Exactly as the computer version" is that pane, and CLAUDE.md
// already says how to get it — THE PANE IS THE TRUTH, which is why every status detector
// in this repo reads it instead of reconstructing it.
//
// The list stays, one tap away, and is not a consolation prize: it pages back over the
// WHOLE transcript, which the pane cannot do (a pane is what fits on a screen plus
// whatever scrollback tmux kept), and prose reads better in it. Two views of two
// different things, not two attempts at one.
function openSession(name) {
  if (!name) return;
  S.session = name; S.screen = 'session'; S.sess = null;
  // Reset to the pane on every open rather than remembering the last choice. The card is
  // tapped to answer "what is this worker doing right now", and the pane is the answer to
  // that question; a sticky preference would sometimes answer a different one.
  S.view = DEFAULT_VIEW; S.pane = null; S.paneGeom = null; S.paneErr = ''; S.pscroll = 0;
  S.draft = ''; S.pending = null; stopSpeaking();
  // Another session's offset means nothing in this one's pane or transcript.
  scrollMem.delete('pane'); scrollMem.delete('chat');
  pushNav();
  render(); refresh();
}
function cardOf(name) { return ((S.grid && S.grid.cards) || []).find(c => c.name === name); }

function sessionScreen() {
  const c = cardOf(S.session);
  const lead = !!(c && c.lead);
  const parked = c && c.status === 'parked';
  const meta = (c && G.STATUS[c.status]) || null;

  // ── the top bar ─────────────────────────────────────────────────────────
  // What replaced ten footer buttons. It carries only what you need in order to READ the
  // screen — where you are, what this session is doing, which view you are in — and one
  // `⋯` for everything you might DO. The verbs did not go away; they moved somewhere that
  // is not competing with the conversation for a phone's worth of pixels.
  //
  // The mode chip stays. It is on every screen for a reason with a scar on it: a phone was
  // once shown four projects that did not exist and the only clue was recognising the
  // names, so "which fleet is this" is never more than a glance away.
  const out = [el('div', { class: 'sbar' }, [
    btn('‹', () => back()),
    el('div', { class: 'who' }, [
      el('span', { class: 'nm', text: (c && c.label) || S.session }),
      el('span', { class: 'st' }, [
        meta ? el('span', { style: `color:${G.COLORS[meta.color]}`, text: meta.label }) : null,
        // The folder earns its place only when it says something the two names either side
        // of it do not. A lead sits in the main checkout, which is usually named after the
        // project — printing both gave "acme-api · acme-api".
        el('span', { class: 'scope', text: ` ${S.project || ''}${c && c.folder && c.folder !== S.session && c.folder !== S.project ? ' · ' + c.folder : ''}` }),
        // WHICH FLEET, ON THE DETAIL LINE RATHER THAN AS ITS OWN CONTROL. It was a
        // top-row flex item and the row could not hold five of them: measured at 390px,
        // back 27 + name 150 + chip 72 + toggle 101 + ⋯ 27 plus four gaps is 409px in a
        // 374px box, so it wrapped to THREE rows and 80px — the ⋯ alone on the last one.
        //   Here it costs the bar no width at all. It sits inside `.st`, which already
        // ellipsises, so a long tailnet hostname can no longer push the view toggle off
        // the end; it shortens the line it is on instead. Its own 7em clamp stays, because
        // the chip must not eat the status and the project either.
        modeChip(),
      ]),
    ]),
    el('div', { class: 'seg' }, [
      btn('chat', () => setView('chat'), S.view === 'chat' ? 'on' : ''),
      btn('pane', () => setView('pane'), S.view === 'pane' ? 'on' : ''),
    ]),
    btn('⋯', () => sheetActions()),
  ])];
  out.push(confirmBar());
  if (!c) out.push(el('div', { class: 'hint', text: `'${S.session}' is not on this fleet's grid any more.` }));
  // The lead still says what it is, in one line rather than by three missing buttons.
  if (lead) out.push(el('div', { class: 'hint lead1', text: "the fleet's lead — no stop, reclaim, rename or pause" }));
  out.push(S.view === 'pane' ? paneView() : chatView(c));
  out.push(composer(c));
  return out.filter(Boolean);
}

function setView(v) {
  if (S.view === v) return;
  S.view = v;
  render();
  refresh();                // fills whichever payload this view needs and has not got
}

// ── the chat ────────────────────────────────────────────────────────────────
// "can we literally convert it to a normal chat like the Claude app... it has a bunch of
// buttons and the chat is very small."
//
// It was a table: newest-first, every row stamped `HH:MM · role`, under a card and ten
// buttons. Oldest-first with the newest at the bottom is not decoration — it is the only
// order in which the thing you just said and the answer to it are next to each other, and
// it is what every chat on the phone has trained the reader to expect.
//
// AND THE COST OF MAKING THIS THE DEFAULT IS PAID EXPLICITLY. #45 moved the default to the
// pane because a message list could not show a command: /api/session serves {ts, role,
// text}, so a tool call, the command inside it and a permission dialog are not in this
// payload at all. That is still true. So a session that is BLOCKED says so here, in red,
// with the one button that goes where the answer has to be typed — the pane. The chat is
// the better place to read a conversation; the pane is the only place to unblock one, and
// this is the seam between them rather than a thing to discover.
// ── swipe the transcript to the previous / next session ───────────────────
// "like the pc app, if u scroll that gets u to the next one" — the phone's j/k.
//
// WHY IT IS BOUND TO THE CHAT AND NOT THE SCREEN. The PANE scrolls sideways ON PURPOSE: it
// is real terminal output, often much wider than a phone, and a horizontal drag there is
// the reader moving along a line. Binding this to the whole session screen would make one
// gesture mean two things depending on a view toggle, which is the exact trap the grid's
// cards already avoid (← / → are pause/resume there, so this could not live on a card
// either).
//
// AND IT IGNORES THE LEFT EDGE. iOS's own back gesture starts there; a swipe that begins
// within EDGE px is the system's, not ours, and stealing it would break the way out of the
// screen. Vertical intent wins outright — the transcript scrolls, and a drag that is more
// down than across is never a session change.
const SWIPE_NEXT = 60, EDGE = 24;
function wireSessionSwipe(node) {
  let x0 = 0, y0 = 0, live = false;
  node.addEventListener('pointerdown', ev => {
    live = ev.clientX > EDGE;             // the left edge belongs to the system
    x0 = ev.clientX; y0 = ev.clientY;
  });
  node.addEventListener('pointerup', ev => {
    if (!live) return;
    live = false;
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    // Mostly horizontal, and far enough to be deliberate — the same two tests wire() makes
    // for a card swipe, with the same constants, so the two gestures feel like one gesture.
    if (Math.abs(dx) < SWIPE_NEXT || Math.abs(dx) <= Math.abs(dy) * 2) return;
    stepSession(dx < 0 ? 1 : -1);
  });
  return node;
}
// STOPS AT THE ENDS RATHER THAN WRAPPING. A wrap on a list with no visible edge means a
// flick at the last session silently shows the first, and the reader has no way to tell
// that from "it did not move". It also walks the SAME order the grid draws, so the phone's
// next-session and the desk's j are the same next.
function stepSession(delta) {
  const names = items().filter(i => i.card).map(i => i.card.name);
  const at = names.indexOf(S.session);
  if (at < 0) return;
  const to = at + delta;
  if (to < 0 || to >= names.length) return;
  openSession(names[to]);
}

function chatView(card) {
  const wrap = wireSessionSwipe(el('div', { class: 'chat' }));
  const s = S.sess;
  if (card && card.status === 'need-you') {
    wrap.append(el('div', { class: 'blocked' }, [
      el('div', { class: 't', text: 'this session is waiting on you — a permission prompt or a question is drawn in its pane, and a transcript cannot show one' }),
      btn('open the pane', () => setView('pane')),
    ]));
  }
  if (!s) { wrap.append(el('div', { class: 'hint', text: 'reading the transcript…' })); return wrap; }
  // A session that has not taken a turn comes back with total 0 and a `note` — fleet-read's
  // own words for a terminal: "…is live but has no transcript yet — Send it work: fleet-send
  // -s … <prompt>". The API keeps the note, because "no messages" and "no transcript yet" are
  // different facts and a JSON caller may care; the SCREEN does not print it, because it told
  // a phone user to run a shell command. The composer is right below; say that instead.
  if (s.note || !(s.messages && s.messages.length)) {
    wrap.append(el('div', { class: 'hint empty', text: 'No messages yet — send one below' }));
    return wrap;
  }
  // Older messages load at the TOP, where they belong in this order — the button is the
  // ceiling of the conversation, not a footer.
  if (s.next_before) {
    wrap.append(el('div', { class: 'row l' }, [
      btn(`load ${api.PAGE} older`, async () => {
        // Hold the reader's place: a page prepended above them would otherwise throw them
        // to the top of a conversation they were reading the middle of.
        //   MEASURED BEFORE THE AWAIT, armed after it. A 5s poll landing mid-fetch rebuilds
        // this list and leaves `wrap` detached, and a detached node measures a scrollHeight
        // of 0 — which would record a distance-from-the-end of 0, and 0 from the end IS the
        // end, the one place this must never send anybody.
        const held = measureFromEnd('chat', wrap);
        try {
          const older = await api.getSession(S.project, S.session, s.next_before);
          S.sess = { ...older, messages: [...(older.messages || []), ...(s.messages || [])],
                     next_before: older.next_before, pages: (s.pages || 1) + 1 };
        } catch (e) { toast(String(e.message || e), 'bad'); }
        holdScrollFromEnd('chat', held);
        render();
      }),
    ]));
  } else if (s.total) {
    wrap.append(el('div', { class: 'meta l', text: '— the beginning of the transcript —' }));
  }
  for (const m of (s.messages || [])) wrap.append(turn(m.role === 'user', m.text, G.clockLabel(m.ts), false, msgKey(m)));
  // Sent, not yet echoed by the transcript. Dimmed rather than absent: a chat where your
  // own message disappears for five seconds reads as a send that failed, and this app's
  // whole job is telling you what is actually happening.
  if (S.pending) wrap.append(turn(true, S.pending.text, 'sending…', true));
  // ── "it is working on it" ──────────────────────────────────────────────
  // Between the transcript echoing your prompt and the answer landing, this screen said
  // nothing at all, and a chat that goes quiet reads as a send that went nowhere. The
  // pending bubble covers the first few seconds; this covers the rest of the wait.
  //
  // FROM THE STATUS THAT IS ALREADY HERE. `card` is the grid card the poll already
  // fetched, and `working` is the same verdict the grid card shows — no second signal, no
  // second endpoint, and nothing for the two to disagree about.
  if (card && card.status === 'working') wrap.append(thinking());
  watchScroll('chat', wrap);
  return wrap;
}
// NOT A MESSAGE, AND DELIBERATELY NOT BUILT BY turn(). It looks like an agent bubble
// because that is where the answer is going to appear, but every path that treats the tail
// of this list as content has to miss it: read-aloud keys off msgKey() and only turn()
// mints one, so there is no play control here and speakable() is never handed it; it is
// not in S.sess.messages, so reconcilePending and the card's own preview line cannot see
// it either. Sharing turn() would have given it all three for free, which is the reason
// this is fifteen lines instead of one argument.
//   THE POLL IS 5s AND THIS DOES NOT PRETEND OTHERWISE. A turn that starts and finishes
// inside one poll is never seen as working, and a status that flaps will flicker. Both are
// accepted rather than smoothed with a minimum visible duration, because a floor is a
// timer that keeps saying "working" after the answer is already on screen above it — this
// client's one job is being accurate about what is happening, and an indicator that
// outlives the truth is worse than one that was too quick to catch. It is a mirror of the
// status, and it is exactly as fine-grained as the status is.
//   The dots are real characters, so the state survives with no CSS and with animation
// turned off (app.css honours prefers-reduced-motion with a static ellipsis).
function thinking() {
  return el('div', { class: 'turn them thinking' }, [
    el('div', { class: 'dots', 'aria-label': 'working', role: 'status' },
       ['.', '.', '.'].map(d => el('span', { class: 'dot', text: d }))),
  ]);
}
// PER-MESSAGE PLAYBACK WITHOUT A SPEAKER ON EVERY BUBBLE.
//
// The composer used to carry the only 🔊, and the comment there said why: a speaker on
// every bubble is the button wall this client keeps having to fight. That objection was
// right and it still is — so this does not put N buttons on screen. It puts ONE, on the
// bubble you tapped, and moves it when you tap another. The count of visible speakers is
// the same as it was; what changed is that you choose which message it is attached to,
// instead of it always being the newest.
//   A TAP, not a long-press: long-press is already `x kill` on a card and already the
// text-selection gesture inside a bubble, and a third meaning for it would be the worst
// kind of hidden. A tap has no meaning on a bubble today, so it is free.
//   Nothing is spoken by the tap itself. Tap reveals, the control plays — because a tap
// that started talking would make scrolling a transcript hazardous, and because the
// control is what carries the stop state.
// ── the read-aloud icon, and why both states are the same drawing ───────────
//
// THIS CONTROL HAS ALREADY BEEN GOT WRONG ONCE, in the direction an icon makes easy. It
// was 🔊 idle and ■ playing: a colour emoji against U+25A0, two typefaces at two weights
// and about a third of the size. Tapping it changed the button's colour, its weight and
// its apparent size all at once, which reads as a DIFFERENT control appearing rather than
// as this one being pressed. The 🔊/🔇 pair fixed that by being one face at one weight —
// at the cost of a colour emoji in an app whose entire visual language is monospace
// terminal chrome, where it looks pasted on.
//   An SVG pair is the third answer and it is only an improvement if it does not walk back
// into the first problem. So these are NOT two icons. They are one horn plus one swapped
// decoration, from the same viewBox, at the same stroke width, two strokes of ink each —
// and every one of those is a single constant below rather than a copy in each branch,
// because a viewBox that can only be written once cannot drift, and drift is the whole
// failure mode. If you add a third state, add a decoration; do not add a viewBox.
//   Stroked in `currentColor` and sized in `em`, so it is the button's colour and the
// button's size in both states — including `.speak.on`, which inverts to background-on-
// yellow and would strand any hard-coded stroke.
//   24 UNITS AT A STROKE OF 2 IS MEASURED, not convention worship. The first draft was 16
// at 1.6, which puts a 2.4-unit-wide horn against a 1.6-unit stroke — 0.8 units of interior
// left unpainted — and it rendered as a solid blob that outweighed its own decoration, the
// same imbalance in miniature that this control is here to stop having.
//   AND THE WEIGHTS WERE COUNTED, in Chrome, each state alone at 240px: the pressed one
// carries 88% of the idle one's ink and both occupy an identical 160px-tall box. The cross
// reaches y 8.6..15.4 rather than the 9.5..14.5 it started at for exactly that reason — the
// short version measured 83%, and the arcs are long. If you redraw either decoration,
// re-count; "looks about the same" is what produced the emoji-against-a-square pair.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_BOX = '0 0 24 24';
const ICON_STROKE = '2';
const ICON_HORN = 'M11 5 6 9H2v6h4l5 4z';   // shared: most of the ink
const ICON_WAVE = 'M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14';   // idle: will speak
const ICON_STOP = 'M17.2 8.6l5.6 6.8M22.8 8.6l-5.6 6.8';             // on: tap to stop
// ONE PLACE THE GEOMETRY IS WRITTEN, for every icon in the app. #82 made that a rule and
// pwa-check counts it — and the count is what caught the camera below being added as a
// second copy of this block rather than a second caller of it. Two icons drawn from two
// copies of "the box is 24 and the stroke is 2" is how the app ends up with two icon
// languages, which is the emoji-against-a-square problem one layer up.
//   aria-hidden because the BUTTON carries the name — see the labels at the call sites. An
// icon that also announced itself would be read twice.
function iconSvg(...ds) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: ICON_BOX, fill: 'none', stroke: 'currentColor', 'stroke-width': ICON_STROKE,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    focusable: 'false',
  })) svg.setAttribute(k, v);
  for (const d of ds) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
function speakIcon(on) { return iconSvg(ICON_HORN, on ? ICON_STOP : ICON_WAVE); }
// A DRAWN CAMERA, for the reason #82 drew the speaker: an emoji next to an SVG is two
// different weights, two colour models and two metrics in one row, and that read as a
// different control appearing rather than as this one being pressed.
// ── the footer's icons ARE NOT HERE ANY MORE ──────────────────────────────
// Eight stroked paths (enter, plus, worktree, more, gear, folder) and vbtn() used to sit
// here to draw the grid's footer. Porting the grid screen took their only caller, so they
// are gone and web/src/screens.jsx's ICONS table is now the ONE place a verb's picture is
// written — which the comment beside that table already claimed while there were plainly
// two copies of every path in the client. One caller, one table, and `settings` can no
// longer be two different pictures on two screens.
//   A CLOCK WAS ALREADY DEAD BEFORE THIS PASS: ICON_CLOCK_C/ICON_CLOCK were declared here
// and referenced nowhere, left behind when the schedule verb moved to the ported screen.
// Nothing said so — an unused const is not a warning in a file nobody bundles — which is
// the small argument for a build step reading this directory one day.
//   What stays: iconSvg() itself, and the speaker and camera paths below, because turn()
// and the composer still draw those with el() on screens that are not ported.

const ICON_CAM_BODY = 'M3 8h3.2l1.6-2h8.4l1.6 2H21v11H3z';
const ICON_CAM_LENS = 'M12 13.4m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0';
function cameraIcon() { return iconSvg(ICON_CAM_BODY, ICON_CAM_LENS); }

// ── a photo becomes a path in the box you are about to send ───────────────
// "can I send a picture?", twice. The mechanism docs/attachments.md measured is that an
// agent given a PATH reads the pixels — so this uploads the file and then puts the path it
// gets back into the composer, WHERE YOU CAN SEE IT. What is sent is an ordinary prompt
// that happens to name a file, through the same fleet_send every other message uses:
// nothing here touches the send path, which is the most scarred code in the repo and the
// one place a stranded prompt costs the most (#77).
//
// NO THUMBNAIL, DELIBERATELY. The CSP is `default-src 'self'`, so a blob: in an <img> is
// refused and the only route is decoding to a canvas — and the format an iPhone actually
// hands over is HEIC, which the browser may not decode at all (unmeasured, and the whole
// reason the bytes are converted on the Mac instead). A preview that worked for a JPEG
// from a laptop and silently showed nothing on the phone this feature exists for would be
// worse than none. The path in the box is the confirmation, and it is the same string the
// agent will be given.
async function attachPhoto(file, card) {
  if (!file) return;
  if (S.attaching) return;
  // WHOSE DRAFT THIS IS, decided before the upload rather than after it. An upload from a
  // phone takes seconds and the screen is live throughout — so `S.session` at the moment
  // the bytes land is not necessarily the session that asked for them, and appending a
  // path to whatever draft happens to be on screen puts one worker's photo in another
  // worker's message box. The same discipline readPane() already keeps for a capture that
  // arrives after the screen moved.
  const want = { project: S.project, session: S.session };
  S.attaching = true; render();
  let note = '', bad = false;
  try {
    const r = await api.attach(want.project, want.session, file);
    const kb = Math.max(1, Math.round(r.bytes / 1024));
    if (S.project !== want.project || S.session !== want.session) {
      // Not silently dropped and not pasted somewhere it does not belong: the file is
      // stored and its path is the only thing that makes it usable, so the path is what
      // the message says.
      note = `photo stored for ${want.session} — you have moved on, so it is at ${r.path}`;
    } else {
      const sep = S.draft && !/\s$/.test(S.draft) ? ' ' : '';
      S.draft = (S.draft || '') + sep + r.path + ' ';
      note = r.converted ? `photo converted and stored, ${kb} KB` : `photo stored, ${kb} KB`;
      // ...and the one honesty requirement the research left standing: two of the three
      // agents read images and the third depends on a model ghostfleet cannot see. ONE
      // toast, not two: S.toast is a single slot, so a second call did not add a warning,
      // it replaced the confirmation — and the size, which is the half that says the
      // upload worked at all, was the half nobody on an opencode worker ever saw.
      if (card && card.agent === 'opencode')
        note += ' — this worker runs opencode, so whether it can read an image depends on its model';
    }
  } catch (e) {
    note = String((e && e.message) || e); bad = true;
  }
  S.attaching = false;
  // THE PATH GOES INTO THE BOX YOU ARE LOOKING AT, WITHOUT REBUILDING IT. render() would
  // show the new draft and close the keyboard doing it — the composer is where you were
  // about to type the sentence that goes with the photo. So the live box is patched in
  // place, the way paintPane() patches the pane, and the rest of the screen (the camera's
  // busy state) repaints on the next poll that is allowed to run.
  if (isLive(composerNode)) { composerNode.value = S.draft || ''; growComposer(composerNode); }
  toast(note, bad ? 'bad' : '');
  renderUnlessTyping();
}

function msgKey(m) { return String(m.role || '') + '|' + String(m.ts || ''); }
function turn(mine, text, when, pending = false, key = '') {
  const bub = el('div', { class: 'bub ' + (mine ? 'user' : 'agent') + (pending ? ' pending' : '') });
  // AN ASSISTANT'S TURN IS MARKDOWN AND WAS BEING SHOWN AS ITS OWN SOURCE — "the messages
  // are not in nice .md format, they have the ****" — because this was one `text:`, which
  // is textContent. web/md.js turns it into nodes; nothing here ever touches innerHTML.
  //   YOUR OWN TURN IS NOT RENDERED, and that is the one asymmetry. A user bubble is the
  // prompt that was SENT, and this is a tool where the exact bytes of a prompt matter — a
  // literal `**` you typed showing as emphasis would leave you unable to tell whether the
  // asterisks reached the agent. What you typed is what you see.
  if (mine) bub.textContent = String(text || '');
  else bub.appendChild(md.render(String(text || ''), document));
  const meta = el('div', { class: 'meta', text: when });
  const speakableHere = !pending && key && canSpeak() && speakable(text);
  if (speakableHere) {
    bub.classList.add('tappable');
    bub.addEventListener('click', (e) => {
      // A link is a link, and a selection is a selection. Tapping either must not also
      // toggle a control — copying a sha out of a bubble is a thing people do here.
      if (e.target && e.target.closest && e.target.closest('a')) return;
      try { if (String(getSelection && getSelection() || '').length) return; } catch {}
      S.speakSel = (S.speakSel === key) ? '' : key;
      render();
    });
  }
  if (speakableHere && S.speakSel === key) {
    const on = S.speaking === speakable(text);
    // NOT btn(): that helper assigns textContent, which would print the markup. The icon is
    // a real child element — see speakIcon() for why both states are the same drawing.
    //   THE LABEL IS THE BUTTON'S ONLY NAME. An icon contributes no text, so without this
    // VoiceOver announces "button" and nothing else — strictly worse than the emoji it
    // replaces, which at least said "speaker". aria-pressed carries the on/off half, so the
    // state is not conveyed by the drawing alone.
    meta.append(el('button', {
      class: 'speak tiny' + (on ? ' on' : ''),
      'aria-label': on ? 'stop reading this message aloud' : 'read this message aloud',
      'aria-pressed': on ? 'true' : 'false',
      title: on ? 'stop reading' : 'read aloud',
      onclick: (e) => { e.stopPropagation(); toggleSpeak(text); },
    }, [speakIcon(on)]));
  }
  return el('div', { class: 'turn ' + (mine ? 'me' : 'them') }, [bub, meta]);
}

// ── the composer ────────────────────────────────────────────────────────────
// A text box and a send button, where a chat puts them. It replaces `send a prompt`, which
// opened a full-screen form to type one line — three taps and a screen change for the verb
// this app exists to use most.
//
// It is drawn in the PANE view too, on purpose: watching a worker work and then telling it
// something is one motion, and making you switch views to find the box would be the same
// mistake the sheet was.
// ── the keyboard, which is the one viewport nothing else reports ──────────
// THE SOFTWARE KEYBOARD IS NOT PART OF THE DYNAMIC VIEWPORT. On iOS `100dvh` does not
// shrink when the keyboard opens, so the shell column stayed full height, the keyboard
// covered its bottom, and Safari's only remaining move was to SCROLL THE PAGE to bring the
// focused composer into view. Reported in those words: "the scroll happens when I click on
// the text box to type". And a page that scrolls at all is a page that will also scroll
// SIDEWAYS the moment anything is marginally too wide, which is why this and the clipping
// were one report.
//   visualViewport is the only thing that knows. Its `height` is what is actually visible
// with the keyboard in place, and `offsetTop` is how far Safari has already panned; both
// are written into CSS custom properties and the layout follows them, rather than the
// layout being fixed and the browser panning around it.
//   The bottom safe-area inset goes to 0 while the keyboard is up. It is there for the home
// indicator, the keyboard covers the home indicator, and stacking one on the other is the
// "too much space between the text box and the bottom" half of the same report.
function syncViewport() {
  try {
    const vv = typeof visualViewport !== 'undefined' ? visualViewport : null;
    if (!vv) return;
    const h = Number(vv.height) || 0;
    const full = Number(innerHeight) || h;
    // A threshold, not equality: the URL bar moves this by a few pixels all the time and a
    // keyboard takes a third of the screen. 120px is well above the former, well below the
    // latter.
    const keyboard = full - h > 120;
    // THE ONLY THING THIS WRITES IS A PADDING. It used to drive the shell's HEIGHT from
    // vv.height and scrollTo(0,0) away Safari's pan; on a real iPhone that put the composer
    // at the top of the screen over the status bar with the transcript black below it. The
    // layout is dvh now and Safari is allowed to pan. An inset that is briefly wrong is a
    // cosmetic 34px; a height driven by a number that does not reliably revert is a dead
    // screen.
    // REMOVED, NOT SET TO EMPTY, and that distinction was costing the home indicator.
    // `padding-bottom: calc(var(--kb-inset, env(safe-area-inset-bottom)) + 8px)` only
    // reaches its fallback when --kb-inset is ABSENT. setProperty(name, '') does not
    // reliably remove a custom property in WebKit — it leaves one whose value substitutes
    // as nothing or as zero — so the fallback never applied and the composer's padding
    // resolved to 0 + 8.
    //   MEASURED on the device: gap8 against sab29. Harmless only while the shell stopped
    // 53pt short of the bottom; the moment it reaches the real bottom, 8px of padding puts
    // the composer ON the home indicator. The two findings arrived in one log line and had
    // to be fixed in one change.
    if (keyboard) document.documentElement.style.setProperty('--kb-inset', '0px');
    else          document.documentElement.style.removeProperty('--kb-inset');
  } catch {}
}

// IS THIS NODE STILL PART OF THE APP. The one question both the input guard above and
// pollPaused() below are really asking, and the reason neither of them asks it of a stored
// reference any more: a reference says which node was drawn LAST, which is a different
// question from whether the node in your hand is attached to the document. They agree
// until something writes the reference out of order, and then they disagree silently.
//   `isConnected` is the DOM's own answer and it is exact. The `!== false` shape is for the
// suite's DOM, where an unimplemented property is undefined rather than false — a stub that
// cannot answer must not be read as "detached", or every keystroke in the harness is
// ignored and the test that proves typing works passes for the wrong reason.
const isLive = (n) => !!n && n.isConnected !== false;

// Up to the CSS max (`max-height`), then it scrolls inside itself — a composer that grows
// without a ceiling eats the conversation it is a reply to. The height is cleared first so
// scrollHeight measures the CONTENT rather than the box we last set.
function growComposer(box) {
  try {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, COMPOSER_MAX_PX) + 'px';
  } catch {}
}
// The ceiling, and app.css's `.composer textarea { max-height }` is the same number on
// purpose: this caps the height growComposer WRITES, that caps what the browser HONOURS,
// and the smaller of the two wins. They disagreed (160 here, 120 there), so this constant
// had no effect above 120px and the box stopped growing for a reason not written anywhere.
const COMPOSER_MAX_PX = 120;
function composer(card) {
  const box = el('textarea', { rows: '1', placeholder: 'message this session…',
                               autocapitalize: 'sentences', spellcheck: 'false' });
  box.value = S.draft || '';
  composerNode = box;      // pollPaused() compares document.activeElement against this
  // The draft lives in state, not in the DOM: render() rebuilds this element every poll,
  // and a half-typed message must survive that. That saves the TEXT and not the caret:
  // the element the keyboard is attached to is gone, and a mobile browser lowers the
  // keyboard when its focused node is destroyed — so the box that survives is one you
  // have to tap again, every five seconds, which is not a box you can type in. The poll
  // has to actually stop; see pollPaused().
  // A DETACHED BOX MUST NOT WRITE STATE, and that is not hypothetical tidiness — it is the
  // message that arrived carrying the PREVIOUS message's text. Reported with a photograph
  // of two bubbles: a sent one holding a photo path and a sentence, and under it a second
  // one holding that same path, that same sentence, AND the new photo's path.
  //   The sequence is: tap send, sendDraft() empties S.draft and render() throws this
  // element away — and only THEN does iOS commit the keyboard's marked/predictive text,
  // which fires one last `input` on the node that is already gone. The listener obligingly
  // wrote its stale value back into S.draft, and every later append built on top of it.
  // A blur commit is the trigger; the defect is that a node the app has discarded could
  // still reach the app's state at all, so the guard is on the property and not on the
  // trigger — which is also the only half of this a desktop engine can be made to prove.
  box.addEventListener('input', () => {
    if (!isLive(box)) return;
    S.draft = box.value; growComposer(box);
  });
  // ...AND ON EVERY RENDER, not only on a keystroke. render() rebuilds this element from
  // scratch on the 5s poll, on a toast, on a view switch — with rows="1" and the draft
  // poured back in — so a two-line message came back as one line and a clipped sliver of
  // the second, which is what "you cannot see what you are typing" looked like from a
  // phone. The listener had never run against THIS element. Next frame, because a node
  // that is not in the document yet reports a scrollHeight of 0.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => growComposer(box));
  else growComposer(box);
  // NO SPEAKER HERE ANY MORE. It lived in the composer because lastAgentText() was the
  // only thing that could be spoken, which made "the newest message" the whole feature.
  // Now any bubble can be played (see turn()), so the composer is a text box and a send
  // button again — which is what it is for.
  // The picker is a hidden <input type=file>; the visible control is a button, so it can
  // be styled and sized like the one beside it. accept="image/*" is what makes iOS offer
  // the camera and the library rather than a file browser.
  const pick = el('input', { type: 'file', accept: 'image/*', class: 'pick' });
  pick.addEventListener('change', () => {
    const f = pick.files && pick.files[0];
    pick.value = '';                       // so picking the SAME photo twice still fires
    attachPhoto(f, card);
  });
  const cam = btn('', () => pick.click(), 'cam' + (S.attaching ? ' busy' : ''));
  cam.textContent = '';
  cam.appendChild(cameraIcon());
  cam.setAttribute('aria-label', S.attaching ? 'sending a photo' : 'attach a photo');
  cam.setAttribute('title', 'attach a photo');
  if (S.attaching) cam.setAttribute('disabled', 'disabled');
  const kids = [pick, cam, box, btn('send', () => sendDraft(), 'go')];
  return el('div', { class: 'composer' }, kids);
}
async function sendDraft() {
  const text = String(S.draft || '').trim();
  if (!text) return;
  // Optimistic, and reconciled against the transcript rather than trusted: reconcilePending
  // clears this when the real message comes back, and gives up on it after a while so a
  // failed send cannot sit there looking sent forever.
  // ...AND HOW MANY TIMES THE TRANSCRIPT ALREADY SAID IT. The only id a sent prompt has is
  // its own text (see reconcilePending), and matching on text alone means the SECOND time
  // you send the same thing — "run the suite", "check again", the two words this app is
  // used for most — the FIRST one already sitting in the transcript answers for it. The
  // bubble stops saying `sending…` before the message has gone anywhere, which is the same
  // lie as one that says it forever, told the other way round.
  //   A count, not a timestamp. The obvious fix is "only match a message newer than this
  // one", but `at` is the PHONE's clock and `m.ts` is the Mac's, and the two are as close
  // as whatever synced them last. Counting occurrences needs no clock at all.
  S.pending = { text, at: Math.floor(Date.now() / 1000), seen: countSaid(text) };
  S.draft = '';
  scrollMem.delete('chat');          // a message you just sent belongs on screen
  render();
  const r = await doVerb('fleet_send', { project: S.project, session: S.session, prompt: text }, { quiet: true });
  if (!r) { S.pending = null; render(); }        // doVerb already said why
}
// The pending bubble goes when the transcript has it — matched on the text, because the
// only id a sent prompt has is what it said. PENDING_TTL is the give-up: a send that
// errored has already cleared this, but one that vanished for any other reason must not
// leave a permanent "sending…" on a screen whose whole purpose is being accurate.
const PENDING_TTL = 180;
// How many of the transcript's user turns say exactly this. The pending bubble is cleared
// by the count GOING UP, not by the text being present — see sendDraft for why.
function countSaid(text) {
  const want = String(text || '').trim();
  const ms = (S.sess && S.sess.messages) || [];
  return ms.filter(m => m.role === 'user' && String(m.text || '').trim() === want).length;
}
function reconcilePending() {
  if (!S.pending) return;
  const said = countSaid(S.pending.text);
  // The baseline FOLLOWS THE TRANSCRIPT DOWN. /api/session serves a page, and a long
  // conversation rolls — so an identical turn that was in the transcript when the count was
  // taken can be gone from it by the time the new one lands, and an arrival would then read
  // as no change at all and sit on `sending…` until the 180s give-up. Counting relative to
  // what is on screen now is what makes "one more of these appeared" the question, whichever
  // direction the window moved.
  if (said < (S.pending.seen || 0)) S.pending.seen = said;
  if (said > (S.pending.seen || 0)) { S.pending = null; return; }
  if (Math.floor(Date.now() / 1000) - S.pending.at > PENDING_TTL) S.pending = null;
}

// ── everything you can DO to a session, in one sheet ────────────────────────
// The ten buttons that used to sit between the card and the conversation. Nothing here is
// new and nothing was dropped — the lead's three refusals are still absent for the reasons
// leadGuard documents, and `stop + reclaim` still takes both of the TUI's confirmations.
// TAKES THE SESSION IT ACTS ON, rather than reading S.session. The grid's `more` button
// opens this for the SELECTED card while S.session is still null (nothing is open yet), and
// a sheet that silently acted on whatever was last opened is the shape that kills the wrong
// worker. Defaults to S.session so the session screen's own ⋯ is unchanged.
// ── THE SCREEN'S OWN ACTIONS, WHICH USED TO BE A FOOTER ───────────────────
// Six buttons in two rows of 44px plus a three-line hint cost 179 of 844 points on the grid
// — 21% of the screen — and the card list got 536, which fits THREE of nine sessions. They
// are in here now, behind the `⋯` in the header, and the list is the same list: this takes
// the `verbs` array the screen was already being handed, so not one label is retyped and
// every string §7 cares about is still in this file where pwa-check greps for it.
//   A DISABLED ROW IS NOT WORTH A LINE IN A SHEET. `more` is drawn inert in a footer on
// purpose — a control that appears and disappears as the selection moves is one you cannot
// learn the position of — but a sheet is a list you read top to bottom, and an entry that
// does nothing is just a thing to skip. The footer's reason does not transfer, so the
// disabled verb is filtered out rather than carried across.
//   THE GESTURES COME WITH IT. They were a permanent three-line band saying what a swipe
// and a long-press do; here they are one line at the bottom of the sheet you open when you
// want to know what you can do, which is the moment they are worth reading.
function sheetMore(title, sub, verbs, hint) {
  const go = (fn) => () => { closeSheet(); fn(); };
  const rows = (verbs || [])
    .filter(v => v.cls !== 'off')
    .map(v => btn(v.label, go(v.onClick), v.cls || ''));
  openSheet(sheet(title, sub, [
    el('div', { class: 'rows' }, rows.map(b => el('div', { class: 'srow' }, [b]))),
    hint ? el('p', { class: 'gest', text: hint }) : null,
    el('div', { class: 'row' }, [btn('esc back', closeSheet)]),
  ].filter(Boolean)), false);
}

function sheetActions(name = S.session) {
  const c = cardOf(name);
  const lead = !!(c && c.lead);
  const parked = c && c.status === 'parked';
  const go = (fn) => () => { closeSheet(); fn(); };
  const rows = [
    // The motivating case (§1): a worker blocked on "Allow pnpm test?" since 9pm. That is
    // fleet_answer — keystrokes into a dialog — not a prompt, which would queue behind the
    // block instead of clearing it. It is the first row for that reason.
    btn('answer keys', go(() => sheetAnswer(name))),
    lead && !parked ? null
      : btn(parked ? 'P resume' : 'p pause', go(() => (parked ? resumeSession(name) : pauseSession(name)))),
    btn('s sched', go(() => sheetSchedule(name))),
    btn('l label', go(() => sheetLabel(name))),
    lead ? null : btn('r rename', go(() => sheetRename(name)), 'danger'),
    lead ? null : btn('x kill', go(() => askKill(name)), 'danger'),
    // §7 puts stop --reclaim on the phone on purpose, and §12 is why it takes two
    // confirmations: fleet-clean's gates decide whether removal is SAFE, never whether
    // it was intended.
    lead ? null : btn('stop + reclaim worktree', go(() => askReclaim(name)), 'danger'),
  ].filter(Boolean);
  openSheet(sheet('actions', name, [
    el('div', { class: 'rows' }, rows.map(b => el('div', { class: 'srow' }, [b]))),
    lead ? el('p', { text: "the lead cannot be stopped, reclaimed, renamed or paused — every project needs one, and its checkout is the repo itself" }) : null,
    el('div', { class: 'row' }, [btn('esc back', closeSheet)]),
  ].filter(Boolean)), false);
}

// ── WHAT COMING BACK MEANS, AS A VALUE RATHER THAN AS THREE BRANCHES ──────
// NAMED AND EXPORTED BECAUSE THE LISTENER BELOW WAS UNREACHABLE FROM THE SUITE. The fake
// DOM's `document.addEventListener` was a no-op, so this — the one handler in the client
// that can throw a live session away — had never been executed by a single test, in a repo
// whose rule is that an assertion is only trusted after it has been watched going red.
// That is the durable half of this fix: the decision is now a function the suite can ask.
//
// 'wait' IS THE CASE THAT WAS MISSING, and it is what the bug was. Face ID is a system
// sheet: the page goes hidden when it opens and visible again the moment the face matches,
// which is BEFORE the assertion has crossed the network — so this ran mid-unlock, with no
// token, and locked the app the user was in the middle of unlocking. lock() also clears the
// token, so the assertion that landed a second later was minting a session into a client
// that had just thrown one away. On a fast link it is a flash; over a tailnet the lock
// screen is up long enough to tap, and tapping it starts the same race again — "i put my
// face and then it asked me again". A three-state answer is the point: "no token" and "no
// token YET" are different facts and a two-way test cannot hold both.
export function onVisibleAction(now = Date.now()) {
  if (pk.busy()) return 'wait';          // an unlock is in progress; it IS the answer
  if (S.hiddenAt && now - S.hiddenAt > pk.RELOCK_AFTER_HIDDEN) return 'lock';
  if (!api.haveToken() && !pk.bypassAllowed()) return 'lock';
  return 'refresh';
}
// ── the pane ──────────────────────────────────────────────────────────────
// NEVER WRAPPED, NEVER REFLOWED. The pane was captured at the width the desktop layout
// gave it — 269 columns on this machine's fleets, measured, against a phone's ~40 — and
// it is a character grid, so wrapping it does not make it narrower, it makes it a
// different picture. So it scrolls sideways inside .pane-box and the page body never
// does (app.css).
//
// That leaves a real problem rather than solving it, and the zoom row is the honest
// answer to it: no toggle makes 269 columns readable on a phone, so both readings are
// offered. `fit` scales the whole pane in to see its SHAPE — is there a dialog, is a diff
// on screen, where is the spinner — and ± takes it back to a size you can read and pan
// across. Font-size, not a transform, so every step re-lays the glyphs out crisply.
const PFS_DEFAULT = 11;         // px: small, and still readable on a phone held normally
const PFS_MIN = 6, PFS_MAX = 28;
const PANE_HISTORY = 200;       // rows of scrollback the `history` toggle asks for

let paneBoxNode = null, paneNode = null, paneGeomNode = null;

// ── where the reader had scrolled to ────────────────────────────────────────
// KEPT OUTSIDE THE NODES, BECAUSE THE NODES DO NOT SURVIVE. refresh()'s 5s poll ends in
// render(), render() does `app.textContent = ''` and rebuilds the screen, and a freshly
// built element starts at scrollTop 0. That is one bug with three faces, and it was fixed
// three times: the pane got `paneScroll`, the chat got `chatScroll`, and the two CARD
// LISTS got nothing at all — so they were still doing it. Reported as two different
// complaints because the fallbacks differ: "when scrolling up on a chat it suddenly goes
// to the end" (the chat sticks to the bottom when it has no position) and "it also happens
// on the projects and session list, it suddenly goes to the top" (a new element is at 0).
// Measured on the grid at 390x844, 8 cards: parked at 290, and five seconds later 0, with
// the node identity changed under it.
//
// SO THERE IS ONE OF THESE NOW, KEYED BY LIST, and that is not tidiness. The third copy of
// an idea is where its bugs live: `chatScroll` was assigned a hand-built `{ keepFromEnd:
// true }` with no `fromEnd` in it, and the restore then computed `scrollHeight - undefined`
// = NaN, which the DOM lands on 0 — the button whose entire job is "do not throw the reader
// to the top" threw them to the top. A caller cannot build a half-shaped position here:
// the only ways in are rememberScroll() and holdScrollFromEnd(), and both measure first.
const scrollMem = new Map();   // key -> { top, left, atEnd, fromEnd, keepFromEnd?, wrote? }
// Per list, because they do not all want the same thing when nobody has scrolled yet.
// `end: true` = a box that has never been touched opens at the BOTTOM, and a reader who is
// at the bottom is kept there as it grows. True of a terminal, where the newest output is
// at the end, and of a chat, where the newest message is. NOT true of a list of cards: the
// end of a card list is not where the news is, and a fresh one belongs at the top, which is
// where the browser already puts it. `slack` is how close to the bottom still counts as
// being at it — a pane is measured in exact rows, a chat in fat bubbles.
const SCROLLERS = {
  pane:     { end: true,  slack: 6 },
  chat:     { end: true,  slack: 24 },
  projects: { end: false, slack: 24 },
  grid:     { end: false, slack: 24 },
};
const numOf = v => Number(v) || 0;

function rememberScroll(key, box) {
  const s = SCROLLERS[key]; if (!s || !box) return;
  const h = numOf(box.scrollHeight), top = numOf(box.scrollTop), ch = numOf(box.clientHeight);
  // A NODE THAT IS NOT IN THE DOCUMENT MEASURES ZERO, AND ZERO READS AS "AT THE END".
  // Measured in Chrome 151: tear a box that was scrolled to 400 out of the page and it
  // reports { scrollTop: 0, scrollHeight: 0, clientHeight: 0 } — and 0 - 0 - 0 is inside
  // every slack there is. Record that and the list is pinned to the bottom for the rest of
  // the session, which is the reported "it suddenly goes to the end". There is nothing to
  // learn from a detached box, so learn nothing.
  if (!h) return;
  const prev = scrollMem.get(key);
  // A POSITION THIS CODE WROTE IS NOT THE READER CHOOSING IT. Measured in Chrome: assigning
  // scrollTop fires no 'scroll' event synchronously, and the event has arrived by the next
  // animation frame — so it reaches this listener looking exactly like a finger. That is
  // harmless when the write landed where it aimed, and not harmless when it had to CLAMP:
  // ask for 700 in a list whose maximum is now 300 and the DOM gives you 300 immediately
  // and reports 300 to the listener, which is within `slack` of the end, so `atEnd` goes
  // true and the list is glued to the bottom from then on — the reported symptom, arriving
  // from a list that merely got shorter. One-shot: the next real scroll is the reader's.
  if (prev && prev.wrote === top) { delete prev.wrote; return; }
  scrollMem.set(key, { top, left: numOf(box.scrollLeft), atEnd: h - top - ch < s.slack, fromEnd: h - top });
}

// "A page of older messages is about to be prepended ABOVE the reader." The distance to the
// BOTTOM is the one number a prepend does not move, so that is what is held.
//   MEASURING AND ARMING ARE TWO CALLS, and the gap between them is a network fetch. They
// were one, and a 5s poll landing mid-fetch re-rendered the chat, spent the marker on the
// list as it was BEFORE the page arrived, and left the real render to fall back to the
// absolute offset. Seen in Chrome, intermittently, which is the worst way to see anything:
// distance from the end 1367 before the press and 1715 after, where the whole point is that
// it is the same number. Nothing can spend a marker that has not been armed yet.
function measureFromEnd(key, box) {
  rememberScroll(key, box);
  const m = scrollMem.get(key);
  return m ? m.fromEnd : null;
}
function holdScrollFromEnd(key, fromEnd) {
  // The measurement is the ARGUMENT, so a marker cannot exist without one. It used to be
  // hand-built at the call site as a bare keepFromEnd flag with no distance in it at all,
  // and `scrollHeight - undefined` is NaN, which the DOM lands on 0: the button whose only
  // job is "do not throw the reader to the top" threw them to the top.
  if (fromEnd == null) return;
  const m = scrollMem.get(key) || { top: 0, left: 0 };
  // atEnd is tested before keepFromEnd in restoreScroll and would win, and it is true
  // whenever the whole transcript already fits on one screen — which is exactly when this
  // button is still on screen to be pressed. The press says "hold my place"; say only that.
  scrollMem.set(key, { ...m, atEnd: false, fromEnd, keepFromEnd: true });
}

function writeScroll(key, box, top, left) {
  try {
    const want = numOf(top);
    box.scrollTop = want;
    if (left != null) box.scrollLeft = numOf(left);
    // WRITE IT BACK INTO THE MEMORY HERE, rather than waiting for the scroll event to say
    // where we ended up. Measured in Chrome 151: assigning scrollTop fires no event during
    // the assignment and the event has arrived by the next animation frame — so a second
    // render in between would restore the value from BEFORE this one, and the position
    // would spring back. Re-read rather than trust what was asked for, because the DOM
    // clamps to the current maximum synchronously and the clamp is where it really is.
    //   `atEnd` is deliberately NOT recomputed. It is the reader's intent — "I am reading
    // the newest" — and a clamp is not an intent; recomputing it from a list that merely
    // got shorter is how a reader who was in the middle ends up glued to the bottom.
    //   BUT A CLAMP AGAINST A BOX THAT IS STILL TOO SHORT IS NOT A POSITION. The re-read
    // above is right once layout has settled and wrong while it is still happening: on a
    // rebuild the list is re-appended and can briefly measure shorter than the position
    // being restored, so the DOM clamps the request to 0 — and writing that back makes the
    // reader's place UNRECOVERABLE, because the only record of it has just been replaced by
    // the clamp. One frame of short content and the position is gone for good, which is why
    // this reads as "intermittently forgets" rather than as a consistent bug.
    //   So the two cases are separated by asking whether the box COULD have held it. If the
    // maximum is below what was asked for, the shortfall is the content not being laid out
    // yet: keep the request as the intent and re-apply when the box can hold it. If the box
    // could hold it and the DOM still moved us, that IS where the reader is — keep it.
    const got = numOf(box.scrollTop);
    const max = numOf(box.scrollHeight) - numOf(box.clientHeight);
    const transient = got < want && max < want;
    const m = scrollMem.get(key);
    if (m) { m.top = transient ? want : got; m.left = numOf(box.scrollLeft); m.wrote = m.top; }
    // BOUNDED, because a box that never grows must not spin forever — and re-applying is
    // only ever worth it while the box is still growing toward the request.
    if (transient) reapplyScroll(key, box, want, left, 0);
  } catch {}
}

// Re-apply a position the box was too short to take, once per frame while it is still
// growing. It stops the moment the box can hold the request (the write in writeScroll then
// records the real value) or after enough frames that the content is clearly not coming.
function reapplyScroll(key, box, want, left, n) {
  if (n >= 12) return;
  const again = () => {
    try {
      if (!box.isConnected) return;
      const m = scrollMem.get(key);
      // Someone scrolled, or a later restore took over: their intent wins over this retry.
      if (!m || m.wrote !== m.top || numOf(m.top) !== numOf(want)) return;
      if (numOf(box.scrollHeight) - numOf(box.clientHeight) >= want) writeScroll(key, box, want, left);
      else reapplyScroll(key, box, want, left, n + 1);
    } catch {}
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(again);
  else if (typeof queueMicrotask === 'function') queueMicrotask(again);
}

function restoreScroll(key, box, prepare) {
  const s = SCROLLERS[key]; if (!s || !box) return;
  const go = () => {
    try {
      if (prepare) prepare(box);
      const m = scrollMem.get(key);
      if (!m) { if (s.end) writeScroll(key, box, box.scrollHeight); return; }
      if (m.atEnd && s.end) writeScroll(key, box, box.scrollHeight);
      else if (m.keepFromEnd) { writeScroll(key, box, numOf(box.scrollHeight) - numOf(m.fromEnd)); delete m.keepFromEnd; }
      else writeScroll(key, box, m.top, m.left);
    } catch {}
  };
  // NEXT FRAME, NOT THIS ONE. The element is not in the document until render() appends
  // it, and a detached node reports a scrollHeight of 0 — so an inline pass is an
  // assignment that clamps to 0 and looks like it worked. Where there is no rAF a
  // microtask is the nearest thing to "after this is built"; inline is the one moment
  // guaranteed to be too early.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
  else if (typeof queueMicrotask === 'function') queueMicrotask(go);
  else go();
}

// One call, because attaching the listener and restoring the position are two halves of the
// same thing and a list that got only the first half is a list that forgets.
function watchScroll(key, box, prepare) {
  if (!box) return box;
  try { box.addEventListener('scroll', () => rememberScroll(key, box)); } catch {}
  restoreScroll(key, box, prepare);
  return box;
}

function paneView() {
  const wrap = el('div', { class: 'paneview' });
  if (!S.pfs) S.pfs = restoredPfs();

  const g = S.paneGeom;
  // The pane's real geometry, measured from the capture on screen rather than asked of
  // tmux separately — see the comment on /api/pane in bin/fleet-serve.mjs for why a
  // second `-t <session>` resolution is a thing to avoid rather than a convenience.
  // Kept as a node so the poll can update it without redrawing the screen under a reader.
  paneGeomNode = el('span', { class: 'geom', text: g ? `${g.cols}×${g.rows}` : '' });
  wrap.append(el('div', { class: 'pane-bar' }, [
    btn('−', () => zoomPane(1 / 1.25)),
    btn('+', () => zoomPane(1.25)),
    btn('fit', () => fitPane()),
    btn(S.pscroll ? `history ${S.pscroll}` : 'history', () => {
      S.pscroll = S.pscroll ? 0 : PANE_HISTORY;
      S.pane = null;                       // the old payload is the wrong length now
      render(); refresh();
    }, S.pscroll ? 'on' : ''),
    paneGeomNode,
  ]));

  const box = el('div', { class: 'pane-box' });
  const pre = el('pre', { class: 'pane' });
  pre.style.setProperty('--pfs', S.pfs.toFixed(2) + 'px');
  if (S.paneErr) {
    // A dead pane read says so IN the box, where the pane would be. A toast every two
    // seconds would bury the app in its own error messages.
    box.append(el('div', { class: 'hint', text: S.paneErr }));
  } else if (!S.pane) {
    box.append(el('div', { class: 'hint', text: 'capturing the pane…' }));
  } else if (S.pane.note) {
    box.append(el('div', { class: 'hint', text: S.pane.note }));
  } else {
    const r = ansi.render(S.pane.pane || '');
    S.paneGeom = { rows: r.rows, cols: r.cols };
    pre.innerHTML = r.html;
    box.append(pre);
  }
  paneBoxNode = box; paneNode = pre;
  // Recorded as the reader scrolls, so the next render can put them back. Cheap, and the
  // only place `atEnd` is decided from a real layout rather than inferred.
  watchScroll('pane', box, sizePaneBox);
  wrap.append(box);
  return wrap;
}

// The box takes exactly the screen that is left below it — MEASURED, not a vh fraction.
// app.css carries `max-height: 68vh` as the pre-JS fallback and 68vh is wrong on every
// phone, because what sits above the box is not a fixed height: the verb bar wraps to
// however many rows the buttons need, which differs with the width and with whether the
// session is parked. Measured at 390x844 the constant put the box's last 30px past the
// fold, which is precisely where a pane keeps the things worth seeing — the ❯ prompt, the
// spinner, and the bottom edge of a permission dialog.
function sizePaneBox(box) {
  if (!box || typeof box.getBoundingClientRect !== 'function' || typeof getComputedStyle !== 'function') return;
  const top = box.getBoundingClientRect().top;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  // #app's bottom padding is the home-indicator safe area; the viewport includes it, so
  // without it the box would end underneath the indicator on a notched phone.
  const app = document.getElementById('app');
  const pad = app ? (parseFloat(getComputedStyle(app).paddingBottom) || 0) : 0;
  // UNDER THE SHELL THIS IS FLEX'S JOB. The measurement existed because what sat above
  // the box was a button bar that rewrapped, so no constant was right on every phone — and
  // the box moving whenever the buttons did was itself part of "the screen moves around".
  // A flex child is given its height; measuring one and then setting a max-height fights
  // the layout that already knows the answer.
  try { if (document.getElementById('app').classList.contains('shell')) return; } catch {}
  const h = vh - top - pad - 6;
  if (Number.isFinite(h) && h > 140) box.style.maxHeight = Math.round(h) + 'px';
}

// The resolved column count of the card grid. getComputedStyle returns the USED value of
// grid-template-columns — a space-separated list of pixel widths, one per track — so its
// length is the number of columns the engine settled on. No parsing of ch units, no
// duplicate of the CSS breakpoint in JS, and nothing to keep in sync when the CSS changes.
export function gridColsFrom(tracks) {
  const t = String(tracks || '').trim();
  if (!t || t === 'none') return 1;
  return Math.max(1, t.split(/\s+/).filter(Boolean).length);
}
function gridCols() {
  try {
    const list = document.querySelector('#app .cards');
    if (!list) return 1;
    return gridColsFrom(getComputedStyle(list).gridTemplateColumns);
  } catch { return 1; }
}

function restoredPfs() {
  // Guarded like every other storage read here: a browser with site data blocked throws
  // on the getter, and a pane that will not draw because of a font-size preference would
  // be an absurd way to lose the screen.
  let v = NaN;
  try { v = Number(localStorage.getItem(LS_PFS)); } catch {}
  return Number.isFinite(v) && v >= 1 && v <= PFS_MAX ? v : PFS_DEFAULT;
}
// No render() here, deliberately: the size is one CSS variable on the <pre>, and
// rebuilding the screen to change it would reset the horizontal scroll to column 0 on
// every tap of `+`. Zooming a terminal you are panning across must not move you.
function setPfs(px) {
  S.pfs = px;
  try { localStorage.setItem(LS_PFS, String(px)); } catch {}
  if (paneNode) paneNode.style.setProperty('--pfs', px.toFixed(2) + 'px');
}
function zoomPane(mul) {
  setPfs(Math.max(PFS_MIN, Math.min(PFS_MAX, (S.pfs || PFS_DEFAULT) * mul)));
}
// The whole pane, in the viewport. Measured, not computed from an assumed advance width:
// monospace faces differ, and fitCards() already learned that a guess 4% out is a clipped
// border. Same probe, one glyph, at a known size.
function fitPane() {
  const cols = (S.paneGeom && S.paneGeom.cols) || 80;
  const box = paneBoxNode;
  const avail = (box && box.clientWidth ? box.clientWidth : document.documentElement.clientWidth) - 14;
  const probe = document.createElement('pre');
  probe.style.cssText = 'position:absolute;visibility:hidden;margin:0;font-size:100px;white-space:pre';
  probe.textContent = '0'.repeat(10);
  document.body.appendChild(probe);
  const per100 = probe.getBoundingClientRect().width / 10;       // px per column at 100px
  probe.remove();
  if (!per100 || !avail || avail < 0) return;
  // No PFS_MIN floor here, on purpose: `fit` is the one control whose job is to show the
  // SHAPE of a 269-column pane, and clamping it to a readable size would silently refuse
  // to do the thing it was tapped for.
  setPfs(Math.max(1, Math.min(PFS_MAX, avail * 100 / (cols * per100))));
}

// ── the pane's own poll ───────────────────────────────────────────────────
// A terminal has to look live or it is a screenshot, so the pane is read faster than the
// rest of the app and on its own timer.
//
// AND IT STOPS WHEN THE PAGE IS HIDDEN — cleared, not merely skipped. A phone polling a
// terminal every two seconds from inside a pocket is a battery cost and a rate-limit cost
// for a picture nobody is looking at, and `if (document.hidden) return` inside the
// callback still wakes the radio and the JS thread on schedule to decide that. So
// visibilitychange tears the timer down and rebuilds it, and syncPanePoll() is the one
// place that decides whether it should exist at all.
//
// THE CADENCE, and the arithmetic behind it: serve.json's read limit is 240/min, counted
// per client id AND per ip. On the session screen the app makes two kinds of read — this
// pane poll and refresh()'s grid poll at 5s (12/min) — so 2s here totals 42/min, about a
// sixth of the ceiling. `history` on multiplies the payload by four (200 rows of
// scrollback against a 65-row pane), so it slows to 4s: the request is cheap for the
// daemon either way, but the bytes cross a WireGuard tunnel on someone's cellular plan,
// and that is the cost worth being careful with. Measured: a 269x65 pane captures to
// 5.9 KB with its escapes, so 2s is ~3 KB/s and history at 4s is about the same.
// Whether the 5s poll may run. Declared here, with the other declarations, because
// pwa-check enforces that every top-level declaration precedes the first top-level
// statement — that is what makes a temporal-dead-zone reference structurally impossible,
// and putting this beside the setInterval that uses it broke the rule.
// The version of the SHELL that is actually serving this page — asked of the worker,
// because it is the only thing that knows which bytes you got. Shown in settings so the
// question "is the fix on my phone yet" is answerable ON the phone, instead of by reading
// fleet-serve's request log and inferring.
let swVersion = '';
export function shellVersion() { return swVersion; }
export async function askShellVersion() {
  try {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) { swVersion = 'no worker'; return swVersion; }   // served straight from the network
    const ch = new MessageChannel();
    swVersion = await new Promise((res) => {
      const t = setTimeout(() => res('unknown'), 600);       // an old worker will not answer
      ch.port1.onmessage = (e) => { clearTimeout(t); res((e.data && e.data.version) || 'unknown'); };
      c.postMessage({ type: 'version' }, [ch.port2]);
    });
  } catch { swVersion = 'unknown'; }
  return swVersion;
}

// ── push (docs/mobile.md §9) ────────────────────────────────────────────────
// HOME SCREEN ONLY, and that is not a preference we can nudge. On iOS a Safari TAB
// cannot subscribe at all — `PushManager` is absent, and `Notification.requestPermission`
// either is missing or resolves to a prompt that never appears. So the UI has to SAY
// which state it is in: a permission dialog that silently never opens is indistinguishable
// from a broken button, and this app has already spent twenty minutes of someone's
// evening on exactly that shape of bug (see api.js's authFetch).
let pushSynced = false;
export function pushStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {}
  return navigator.standalone === true;                      // iOS's own, older spelling
}
export function pushSupported() {
  return !!(navigator.serviceWorker && typeof window !== 'undefined' && 'PushManager' in window
            && typeof Notification !== 'undefined');
}
export function pushPermission() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  catch { return 'unsupported'; }
}
// Why it CANNOT be turned on, in the words that say what to do about it. Returns '' when
// it can.
export function pushBlockedReason() {
  // 'probing' is a real third mode (api.js says so), and the settings sheet is reachable
  // from the lock screen while it is still running. Answering "fixtures have nothing to
  // send one" there would be confidently wrong about a question not yet decided.
  if (api.mode() === 'probing') return 'still working out which fleet this is — try again in a moment';
  if (api.mode() !== 'server') return 'push needs a real fleet-serve — fixtures have nothing to send one';
  // THE HOME-SCREEN RULE IS iOS's, so it is only said on iOS. A desktop browser in a tab
  // subscribes perfectly well, and telling it that only a home-screen app can is the
  // mistake #73 recorded in the voice picker: a cause pinned on every device when it
  // belongs to one. The capability check goes first for the same reason — it is the
  // measured half, and on an iOS tab it is the thing that is actually true.
  if (!pushSupported()) return iosLike() && !pushStandalone()
    ? 'no Push API in a tab — on iOS only a home-screen app has one: Share → Add to Home Screen, then open it from the icon'
    : 'this browser has no Push API';
  if (iosLike() && !pushStandalone())
    return 'iOS only allows notifications for a home-screen app: Share → Add to Home Screen, then open it from the icon';
  if (pushPermission() === 'denied') return 'notifications are blocked for this app — iOS Settings → Notifications → ghostfleet';
  return '';
}
// iPadOS reports itself as a Mac, which is why the touch-point half is here: without it an
// iPad in a tab is told a desktop's story.
function iosLike() {
  const ua = (navigator.userAgent || '');
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
}
const b64uToBytes = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
};
async function pushRegistration() {
  if (!navigator.serviceWorker) return null;
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}
export async function pushCurrent() {
  const reg = await pushRegistration();
  if (!reg || !reg.pushManager) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}
export async function pushEnable() {
  const why = pushBlockedReason();
  if (why) throw new Error(why);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('notifications were not allowed');
  const k = await api.pushKey();
  if (!k || !k.key) throw new Error('the fleet has no VAPID key to subscribe with');
  const reg = await pushRegistration();
  if (!reg || !reg.pushManager) throw new Error('no service worker to subscribe with');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(k.key) });
  // Stash the key where sw.js can find it: on a rotated subscription the worker has to
  // re-subscribe with the SAME application key and cannot ask the server for it (no
  // token). See sw.js's pushsubscriptionchange.
  try { const c = await caches.open(await shellVersionOrGuess()); await c.put('./__push-key', new Response(k.key)); } catch {}
  const j = sub.toJSON ? sub.toJSON() : sub;
  await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
  try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
  return j.endpoint;
}
export async function pushDisable() {
  const sub = await pushCurrent();
  const ep = sub ? (sub.endpoint || '') : '';
  // Server FIRST. Unsubscribing in the browser before the daemon has been told leaves the
  // daemon posting to an endpoint that will 410 — recoverable, but it means the row lives
  // until the next send, and "off" should be off the moment it says so.
  try { if (ep) await api.pushUnsubscribe(ep); } catch {}
  try { if (sub) await sub.unsubscribe(); } catch {}
  try { localStorage.removeItem('gf.push.endpoint'); } catch {}
}
// A subscription's endpoint can be REPLACED by the browser without asking (an OS update,
// a reinstall), and the daemon then posts into a 410 forever. sw.js catches the event it
// can and leaves the new subscription in the cache, but the event is not reliable on
// every platform — so the durable check is this one, run once per unlock: whatever the
// browser says our subscription is now, tell the server if it is not what we last sent.
async function maybeSyncPush() {
  if (pushSynced || !api.haveToken() || api.mode() !== 'server') return;
  pushSynced = true;
  try {
    const cacheName = await shellVersionOrGuess();
    try {
      const c = await caches.open(cacheName);
      const pending = await c.match('./__push-pending');
      if (pending) {
        const j = await pending.json();
        if (j && j.endpoint && j.keys) {
          await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
          try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
        }
        await c.delete('./__push-pending');
      }
    } catch {}
    const sub = await pushCurrent();
    if (!sub) return;
    const j = sub.toJSON ? sub.toJSON() : sub;
    let last = '';
    try { last = localStorage.getItem('gf.push.endpoint') || ''; } catch {}
    if (j.endpoint && j.endpoint !== last) {
      await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
      try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
    }
  } catch {}
}
// The cache the worker is actually using. Falls back to a name that is wrong-but-harmless
// rather than throwing: a stash we cannot reach costs a re-subscribe on the next open,
// which maybeSyncPush does anyway.
async function shellVersionOrGuess() {
  const v = shellVersion();
  if (v && /^ghostfleet-v/.test(v)) return v;
  try { const keys = await caches.keys(); const hit = keys.find(k => /^ghostfleet-v/.test(k)); if (hit) return hit; } catch {}
  return 'ghostfleet-push';
}

// Set when a newer service worker has taken control and this page is now the stale one.
let swReloadPending = false;
// WHEN IT IS FREE TO SWAP CLIENTS, as a value rather than as a condition inside the
// caller — the same reason onVisibleAction above is named and exported: the listener that
// arms this is `controllerchange`, which the suite's DOM does not have, so the decision
// had never been executed by a single assertion.
export function reloadAction(pending, typing, authed) {
  if (!pending) return 'none';
  if (typing) return 'wait';               // never mid-sentence: a reload eats S.draft
  // NEVER UNDER A LIVE SESSION, and this is the whole fix. The token is in memory by
  // design, so a reload ENDS the session — do it while somebody is holding one and they
  // land on the lock screen they just cleared, and the passkey they just spent bought
  // them one second of app.
  //   It used to be guarded on pollPaused(), which counts S.locked as paused. That
  // deferred the swap while locked and spent it the instant the app unlocked — waiting
  // for precisely the transition that costs a Face ID. Locked is the FREE moment: there is
  // no session to lose and the reader is about to authenticate anyway, so the new client
  // is what they authenticate into.
  if (authed) return 'wait';
  return 'reload';
}
export function takeNewClientIfIdle() {
  const typing = typingNow(), authed = api.haveToken();
  const act = reloadAction(swReloadPending, typing, authed);
  if (swReloadPending) api.diag('swap', act, 'typ' + (typing ? 1 : 0), 'auth' + (authed ? 1 : 0));
  if (act !== 'reload') return false;
  try { location.reload(); } catch { return false; }
  return true;
}

// A render that defers rather than destroying what you are typing into. render() empties
// #app, so any caller that fires while the composer has focus closes the keyboard — the
// 5s poll was the loud case and pollPaused() stops that one, but readPane()'s error
// transitions call render() too, on a 2s timer, and would reopen the same wound the first
// time a pane read failed mid-sentence. Deferred, not dropped: the flag is spent by the
// next poll, so the error still reaches the screen a moment later.
let renderDeferred = false;
export function renderUnlessTyping() {
  if (pollPaused()) { renderDeferred = true; return false; }
  render();
  return true;
}
export function renderWasDeferred() { return renderDeferred; }

export function pollPaused() {
  if (document.hidden || S.locked || S.sheet || S.confirm) return true;
  return typingNow();
}
// THE TYPING HALF ON ITS OWN. pollPaused() answers "should the 5s poll hold off", and
// S.locked is a perfectly good reason for that — but it is the WRONG question for the
// client swap below, which is free precisely when the app is locked. Sharing one
// implementation of the sentence test keeps the two from drifting; the difference between
// them is which other states they add to it, and that difference is the bug this split
// exists to fix.
export function typingNow() {
  // Typing counts. refresh() ends in a render, render() empties #app and rebuilds it, so
  // a poll that lands while the composer has focus destroys the element the keyboard is
  // attached to. Reported as "it hides the keyboard every time, I cannot type for more
  // than five seconds" — five being this interval, exactly.
  //   ASKED OF THE ACTIVE ELEMENT, NOT OF A STORED NODE. This used to compare
  // `document.activeElement === composerNode`, a module global that render() nulls and
  // composer() re-sets — so the answer depended on the two of them being written in the
  // right order by every path that draws a screen, which is a promise the file cannot
  // keep on its own. The question is a property of the element that has focus: is it a
  // textarea, is it still attached, and is it inside a composer. Three things the node
  // knows about itself, none of which can go stale.
  try {
    const a = document.activeElement;
    if (a && String(a.tagName || '').toLowerCase() === 'textarea' && isLive(a) && insideComposer(a)) return true;
  } catch {}
  return false;
}

// The composer row an element sits in, by walking its own ancestry. Not `closest()`: the
// suite's DOM has parents and no selector engine, and this is one loop.
function insideComposer(n) {
  for (let e = n; e; e = e.parentElement || e.parentNode) {
    try { if (e.classList && e.classList.contains && e.classList.contains('composer')) return true; } catch {}
  }
  return false;
}

// The live composer <textarea>. Still kept, because attachPhoto() has to put a path into
// the box you are looking at without rebuilding it — but nothing DECIDES anything from it
// any more; the two guards above ask the element instead.
let composerNode = null;

const PANE_POLL_MS = 2000, PANE_POLL_HISTORY_MS = 4000;
let paneTimer = null, paneTimerMs = 0, paneBusy = false;

const panePeriod = () => (S.pscroll ? PANE_POLL_HISTORY_MS : PANE_POLL_MS);
// Paused for a sheet or a confirmation for the same reason refresh() is: those are forms
// with half-typed text in them, and a repaint under one is how you lose it.
const panePollWanted = () =>
  !document.hidden && !S.locked && !S.sheet && !S.confirm &&
  S.screen === 'session' && S.view === 'pane';

function stopPanePoll() {
  if (paneTimer) { clearInterval(paneTimer); paneTimer = null; paneTimerMs = 0; }
}
// Idempotent, and called from render() — so entering the screen, switching view, opening a
// sheet and locking all reach it without any of them having to know about the timer.
function syncPanePoll() {
  if (!panePollWanted()) return stopPanePoll();
  if (paneTimer && paneTimerMs === panePeriod()) return;
  stopPanePoll();
  paneTimerMs = panePeriod();
  paneTimer = setInterval(() => {
    if (!panePollWanted()) return stopPanePoll();
    readPane().then(paintPane);
  }, paneTimerMs);
}

async function readPane() {
  // One request in flight at a time. A capture that takes longer than the period would
  // otherwise stack up requests behind it, which is how a slow link turns into a burst
  // that trips the rate limit — the opposite of what a poll interval is for.
  if (paneBusy) return;
  paneBusy = true;
  const want = { project: S.project, session: S.session, scroll: S.pscroll };
  try {
    const j = await api.getPane(want.project, want.session, want.scroll);
    // Discarded if the screen moved while this was in flight: painting it would put one
    // session's pane under another session's card.
    if (S.screen !== 'session' || S.session !== want.session || S.pscroll !== want.scroll) return;
    S.pane = j;
    if (S.paneErr) { S.paneErr = ''; renderUnlessTyping(); }
  } catch (e) {
    if (e instanceof api.AuthError) return lock('poll');
    const msg = e instanceof api.OfflineError
      ? 'offline — this is the last pane captured' : String(e.message || e);
    // Rendered only when it CHANGES. The poll is every two seconds; re-rendering the
    // screen on each failure would make an unreachable daemon look like a flickering app.
    if (S.paneErr !== msg) { S.paneErr = msg; renderUnlessTyping(); }
  } finally { paneBusy = false; }
}

// The repaint, in place: one innerHTML assignment on the <pre>, never a render() of the
// whole screen. render() would rebuild the box and throw away where the reader had
// scrolled to — twice a second, mid-sentence, which is unusable.
function paintPane() {
  if (S.screen !== 'session' || S.view !== 'pane' || !S.pane || S.paneErr) return;
  const box = paneBoxNode, pre = paneNode;
  if (!box || !pre) { render(); return; }
  const r = ansi.render(S.pane.pane || '');
  S.paneGeom = { rows: r.rows, cols: r.cols };
  // A terminal's tail behaviour: follow the end only for a reader who was already at it.
  // Someone who has scrolled up to read a command stays where they put themselves.
  rememberScroll('pane', box);
  pre.innerHTML = r.html;
  if ((scrollMem.get('pane') || {}).atEnd) writeScroll('pane', box, box.scrollHeight);
  if (paneGeomNode) paneGeomNode.textContent = `${r.cols}×${r.rows}`;
}

// ── back, and why there are no URLs ─────────────────────────────────────────
// "if I go back it takes me to the last page I was, not back." An installed PWA gets the
// system back gesture, and this app had nothing on the history stack — so back left the
// app entirely (or returned to whatever page the tab held before it), skipping every
// screen you had actually walked through.
//
// The fix is history ENTRIES WITHOUT A URL. pushState is called with the CURRENT href, so
// the stack gains a step the gesture can pop while the address never changes: no routes to
// invent, nothing to parse on a cold open, no way for a stale link to name a session that
// is gone. In standalone mode there is no address bar to show a URL anyway; what the user
// asked for and what the platform wants are the same thing here.
//
// ONE DIRECTION OF TRUTH: going deeper pushes, and every backward move goes through
// popstate. The app's own `‹`/`q` calls history.back() rather than changing the screen
// itself, so the gesture and the button cannot disagree about where "back" is.
let navDepth = 0;
function pushNav() {
  navDepth++;
  try { history.pushState({ gf: navDepth }, '', location.href); } catch {}
}
// The actual screen change. Called ONLY by popstate (and by the pop-less fallbacks below,
// for a browser that gave us no history object at all).
function popTo() {
  if (S.sheet) { closeSheet(); return; }
  if (S.confirm) { cancel(); return; }
  if (S.screen === 'session') { S.screen = 'grid'; S.session = null; S.sess = null; S.pane = null; S.paneErr = ''; S.pending = null; S.speakSel = ''; stopSpeaking(); }
  else if (S.screen === 'grid') { S.screen = 'projects'; S.sel = 0; }
  else return;                                  // at the root: let the platform have it
  navDepth = Math.max(0, navDepth - 1);
  render(); refresh();
}
function back() {
  // Ask the platform to pop, so a tap and a swipe take the identical path. With no entry
  // of ours on the stack (or no history at all) there is nothing to pop, so move directly
  // rather than doing nothing — a back button that silently fails is worse than no gesture.
  if (navDepth > 0 && typeof history !== 'undefined' && typeof history.back === 'function') history.back();
  else popTo();
}

// ── cards, and the four gestures ──────────────────────────────────────────
// A SURFACE CARD, NOT BOX ART — and rewritten IN PLACE rather than ported into Preact,
// which is the seam web/src/screens.jsx documents: Preact owns every box on the screen,
// this owns what goes inside .cards, and wire() below stays the one gesture machine for
// both card lists. A redesign lands squarely on that seam, and the cheap half is this one.
//
// WHAT WENT AND WHY. The card was a faithful transcription of the TUI: five lines of
// ╭─╮ in monospace, at a font size fitCards() measured so the art would line up. It cost
// ~210px to state three short facts, triple-encoded status as border-colour AND glyph AND
// word, and clipped the agent's last line mid-word at 28 columns — the one line you opened
// the app to read. The box is gone, the status is one chip, and the message gets two real
// lines (-webkit-line-clamp: 2 in app.css).
//
// WHAT STAYED. Every string still comes from web/grid.js's models, so the phone and the
// desk cannot disagree about what a card SAYS — only about how it looks, which is the
// intended difference and what test/helpers/grid-parity.mjs now asserts. The status word
// is the TUI's own (§7), the 1-9 digit is still the card's address, and `--c` still carries
// the status hue so one declaration colours the rail, the chip and the selection.
// ── a card-shaped wait ────────────────────────────────────────────────────
// Three bars in a card, so the placeholder occupies the layout the real card will. The
// point is that nothing MOVES when the data lands — the cards swap into boxes the eye is
// already resting on, instead of appearing under a spinner that was in the middle of an
// empty screen and pushing everything down.
//   Built here rather than in the ported screen, and that is a constraint rather than a
// preference: web/screens.js is vite output and this checkout has no node_modules, so the
// JSX cannot be rebuilt. The card screens take REAL DOM for their cards (see the seam in
// projectsProps), which is the one door open from this file.
function skeletonCards(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(el('div', { class: 'card skel', 'aria-hidden': 'true' }, [
      el('div', { class: 'skel-bar w1' }), el('div', { class: 'skel-bar w2' }), el('div', { class: 'skel-bar w3' }),
    ]));
  }
  return out;
}

function cardEl(m, h, idx) {
  const d = el('div', {
    // `exited` is a CLASS, not a status: the nine statuses say what a running agent is
    // doing and this one is not running, so it rides beside the status rather than
    // replacing the vocabulary. app.css dims the card and recolours the chip from it.
    class: 'card' + (m.selected ? ' sel' : '') + (m.dim ? ' dim' : '') + ` k-${m.kind}`
           + (m.status ? ` s-${m.status}` : '') + (m.exited ? ' exited' : ''),
    role: 'button', tabindex: '0',
  });
  d.style.setProperty('--c', G.COLORS[m.color] || G.COLORS.grey);
  // ── the title row: number, name, lead, and when ────────────────────────
  const top = el('div', { class: 'c-top' });
  if (m.num != null) top.append(el('span', { class: 'c-num', text: String(m.num) }));
  top.append(el('span', { class: 'c-name', text: m.title }));
  if (m.lead) top.append(el('span', { class: 'chip lead', text: 'lead' }));
  if (m.when) top.append(el('span', { class: 'c-when', text: m.when }));
  d.append(top);
  // ── the meta row: the status chip, then where it is, then agent and PR ──
  const meta = el('div', { class: 'c-meta' });
  // AN EXITED SESSION'S OLD STATUS IS THE MOST MISLEADING THING THE CARD COULD SAY —
  // it is whatever the agent was doing at the moment it stopped. The chip is where the
  // eye already goes for "what is this doing", so it is where "it is not" belongs, and
  // the status it replaces is gone rather than shown beside it.
  //   `⏎ resumes` on the desk and `open it and press enter` here are the same route: the
  // pane is held by bin/agent-here and is already asking for Enter, so the way back in is
  // the way in. No new verb, no new gesture.
  // ASLEEP OUTRANKS THE STATUS for the same reason `exited` does: both mean no agent is
  // running, so the status underneath is the last thing it was doing rather than what it is
  // doing, and showing it beside "asleep" would read as a live session.
  //   No new chip colour — the palette is fixed, and a state that needs its own colour to be
  // understood is a state whose WORDS are wrong. The plain chip plus the line below carries it.
  if (m.asleep) meta.append(el('span', { class: 'chip st', text: 'asleep' }));
  else if (m.exited) meta.append(el('span', { class: 'chip st exited', text: 'exited' }));
  else if (m.statusLabel) meta.append(el('span', { class: 'chip st', text: m.statusLabel }));
  if (m.where) meta.append(el('span', { class: 'c-where', text: m.where }));
  if (m.path) meta.append(el('span', { class: 'c-where', text: m.path }));
  if (m.agent) meta.append(el('span', { class: 'chip tag', text: m.agent }));
  if (m.pr) meta.append(el('span', { class: 'chip tag', text: m.pr }));
  if (m.queued) meta.append(el('span', { class: 'chip tag', text: `queued: ${m.queued}` }));
  if (meta.childNodes.length) d.append(meta);
  // ── the agent's last line, two real lines of it ─────────────────────────
  // THE POINT OF THE REDESIGN. Rendered as text, never as markup: this is whatever the
  // agent last said, and app.css clamps it rather than the client truncating it — so the
  // browser decides where two lines end, at whatever size the reader has chosen.
  if (m.asleep) {
    // The card says what to DO, not what happened to it. An exited card waits for a person
    // to press enter because a person ended it; this one was ended by the fleet to give the
    // memory back, so the way home is a tap and the card is the thing that knows it.
    d.append(el('div', { class: 'c-msg none', text: 'asleep — tap to wake' }));
  } else if (m.exited) {
    d.append(el('div', { class: 'c-msg none', text: 'the agent exited — open it and press enter to resume this conversation' }));
  } else if (m.msg || m.placeholder) {
    d.append(el('div', { class: 'c-msg' + (m.msg ? '' : ' none'), text: m.msg || m.placeholder }));
  }
  // THE GRIP IS STILL EXACTLY ONE LINE, and it is now the title row rather than the top
  // border. `.c-top` carries `touch-action: none` in app.css so a drag that starts there
  // reorders, and a vertical drag anywhere else on the card still scrolls the list. That
  // one-line grip is the reason reorder does not fight the page scroll, so it did not get
  // wider just because the card got a nicer surface.
  top.classList.add('t');
  if (idx >= 0) d.dataset.idx = String(idx);
  wire(d, h, idx);
  return d;
}

// One pointer handler for all four gestures, because they have to be told apart from
// each other AND from a scroll:
//   tap        — down/up under 10px and under the long-press timer     (⏎ / 1-9)
//   long-press — 600ms without moving                                  (x)
//   swipe      — mostly horizontal, over 60px                          (p / P)
//   drag       — starts on the TITLE line, which is the grip           (⇧hjkl)
// The grip is why reorder does not fight the page scroll: only that one line sets
// touch-action:none, so a vertical drag anywhere else on the card still scrolls.
const LONG_PRESS = 600, MOVE_SLOP = 10, SWIPE = 60;
function wire(node, h, idx) {
  // `travelled` is NOT derivable from the pointerup position, and that is the whole reason
  // this variable exists: a finger that went down, moved 40px and came back to where it
  // started reports dx = dy = 0 at the end, exactly like one that never moved. They are
  // different gestures — the second is a tap, the first is a drag the reader thought
  // better of — and only a flag set DURING the move can tell them apart.
  let x0 = 0, y0 = 0, t0 = 0, held = false, dragging = false, timer = 0, rowH = 0, travelled = false;
  const clear = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener('pointerdown', ev => {
    if (idx >= 0) { S.sel = idx; markSel(); }
    x0 = ev.clientX; y0 = ev.clientY; t0 = Date.now(); held = false; travelled = false;
    dragging = !!h.reorder && ev.target.classList.contains('t');
    if (dragging) {
      rowH = node.getBoundingClientRect().height;
      node.setPointerCapture(ev.pointerId);
      node.classList.add('lift');
    } else if (h.longPress) {
      timer = setTimeout(() => { held = true; clear(); h.longPress(); }, LONG_PRESS);
    }
  });
  node.addEventListener('pointermove', ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (Math.hypot(dx, dy) > MOVE_SLOP) { clear(); travelled = true; }
    if (!dragging) return;
    ev.preventDefault();
    const steps = rowH ? Math.round(dy / rowH) : 0;
    node.classList.toggle('drop-above', steps < 0);
    node.classList.toggle('drop-below', steps > 0);
  });
  node.addEventListener('pointerup', ev => {
    clear();
    node.classList.remove('lift', 'drop-above', 'drop-below');
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (dragging) {
      dragging = false;
      const steps = rowH ? Math.round(dy / rowH) : 0;
      if (steps) { h.reorder(steps); return; }
      // A PRESS ON THE GRIP THAT NEVER MOVED IS A TAP, NOT A CANCELLED DRAG. This branch
      // used to `return` on any press of the title line, so the title was a DEAD ZONE: tap
      // anywhere else on the card and it opens, tap the name and nothing happens at all.
      // It hid for as long as the card was four identical monospace lines and nobody aimed
      // at one of them; the redesign made the name the biggest, boldest thing on the card,
      // which turned the one dead target into the one a thumb goes for.
      //   TWO CONDITIONS, and the second is the one a naive `steps === 0` check gets wrong.
      // `steps` is zero both for a finger that never left the grip AND for one that moved
      // half a row and came back, because both end where they started. Only `travelled`
      // separates them, and a drag the reader abandoned must do nothing rather than open
      // the thing they were dragging.
      //   NO TIME BOUND HERE, unlike the tap below. The grip arms no long-press timer (see
      // pointerdown), so there is no second meaning for a slow press to collide with — and
      // a bound would leave a deliberate, slow press on the title still dead, which is the
      // complaint rather than half of it.
      if (!travelled && h.tap) { h.tap(); return; }
      return;
    }
    if (held) return;                                        // long-press already fired
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 2) {
      if (dx < 0 && h.swipeLeft) h.swipeLeft(); else if (dx > 0 && h.swipeRight) h.swipeRight();
      return;
    }
    if (Math.hypot(dx, dy) <= MOVE_SLOP && Date.now() - t0 < LONG_PRESS && h.tap) { h.tap(); return; }
    // A touch that only moved the selection (a short scroll, a cancelled gesture) still
    // has to redraw the footer: `x` means "kill" over a session and "remove wt" over a
    // free worktree, and the TUI names which one it means RIGHT NOW rather than making
    // you find out by pressing it.
    if (idx >= 0) render();
  });
  node.addEventListener('pointercancel', () => { clear(); dragging = false; node.classList.remove('lift', 'drop-above', 'drop-below'); });
}
// Moving the selection must not re-render: a re-render during a pointer sequence
// replaces the node under the finger and the gesture dies half-finished.
function markSel() {
  for (const n of document.querySelectorAll('#app .card')) {
    n.classList.toggle('sel', n.dataset.idx === String(S.sel));
  }
}

// ── the confirm bar: the TUI's own strings ────────────────────────────────
// Reproduced, not reinvented (§7). "A phone confirmation is a second deliberate tap,
// and --force needs its own" — so the force step is a DIFFERENT button with a
// different letter, never a second press of the one that just refused.
// THE QUESTION IS DATA, AND THE DRAWING OF IT IS NOT — same split as modeSpec() above, for
// a sharper reason. §7 says the guardrails ARE the TUI's own prompts, so these strings are
// the thing pwa-check greps this file for; the Projects screen draws its confirmation in
// Preact now, and a second copy of `remove 'x' from projects?` over there would be a string
// that check can no longer see. One spelling, two renderers.
function confirmSpec() {
  const c = S.confirm;
  if (!c) return null;
  const yn = 'y = yes · any other key = cancel';
  const cancelBtn = { label: 'cancel', onClick: cancel };
  if (c.kind === 'kill' || c.kind === 'reclaim-kill') {
    return { cls: 'red', q: `kill session '${c.name}'?`, keys: yn, buttons: [
      { label: 'y = yes', cls: 'danger', onClick: () => c.kind === 'kill' ? confirmedKill(c.name) : askReclaimWorktree(c.name) },
      cancelBtn,
    ] };
  }
  if (c.kind === 'wt') {
    if (c.busy) return { cls: 'busy', q: `removing worktree '${G.basename(c.path)}'…`, keys: 'deleting the checkout — this can take a minute on a big one', buttons: [] };
    if (c.force) return { cls: 'red', q: c.msg, keys: 'f = remove anyway · any key = cancel', buttons: [
      { label: 'f = remove anyway', cls: 'danger', onClick: () => removeWorktree(c, true) },
      cancelBtn,
    ] };
    return { cls: 'red', q: `remove worktree '${G.basename(c.path)}' (${c.branch})?`, keys: yn, buttons: [
      { label: 'y = yes', cls: 'danger', onClick: () => removeWorktree(c, false) },
      cancelBtn,
    ] };
  }
  if (c.kind === 'reclaim-wt') {
    return { cls: 'red', q: `remove worktree '${c.folder}' (${c.branch})?`, keys: yn, buttons: [
      { label: 'y = yes', cls: 'danger', onClick: () => confirmedReclaim(c.name) },
      cancelBtn,
    ] };
  }
  if (c.kind === 'project') {
    return { cls: 'red', q: `remove '${c.name}' from projects?`, keys: yn, buttons: [
      { label: 'y = yes', cls: 'danger', onClick: () => doVerb('fleet_project_remove', { name: c.name }).then(cancel) },
      cancelBtn,
    ] };
  }
  return null;
}
function confirmBar() {
  const s = confirmSpec();
  return s ? bar(s) : null;
}
function bar(s) {
  return el('div', { class: 'confirm ' + s.cls }, [
    el('span', { class: 'q', text: ' ' + s.q }),
    el('span', { class: 'keys', text: '  ' + s.keys }),
    s.buttons.length ? el('div', { class: 'row' }, s.buttons.map(b => btn(b.label, b.onClick, b.cls || ''))) : null,
  ]);
}
function cancel() { S.confirm = null; render(); }

// THE LEAD IS NOT A WORKER, and the card no longer looks any different from one — which
// is the whole hazard of putting master on the grid at all. So every path into the two
// verbs that would end it goes through here first.
//
// It reads `card.lead` (§4), NEVER the name: the producer decided which session is the
// lead exactly once, and a client that re-derived it by comparing "master" here, on the
// session screen, and beside each button would be three comparisons to keep in step.
//
// This is the affordance half only. mcp/fleet-dispatch.mjs refuses the call whatever the
// client draws (§7: `curl` does not run this file), and the toast says the same thing the
// server would — so the two cannot end up disagreeing about whether it was allowed.
function isLeadCard(name) { const c = cardOf(name); return !!(c && c.lead); }
function leadGuard(name, what) {
  if (!isLeadCard(name)) return false;
  toast(`'${name}' is this fleet's lead — it cannot be ${what}. Every project needs one, and its checkout is the repo itself.`, 'bad');
  // toast() only sets the state; doVerb's callers repaint on their way to refresh() and
  // this path has nothing else to do — so without this the tap produced no toast, no
  // prompt and no error, which is a button that looks broken rather than one that refused.
  render();
  return true;
}

// Pause is a WORKER verb, and the fleet already keeps that rule where it matters:
// bin/fleet-governor excludes master from the sessions it parks ("master is never
// parked"), and plan() refuses it. A lead that is off dispatches nothing and drains no
// inbox — and on the grid it is one careless swipe on the FIRST card, which the lead now
// is. RESUME is deliberately NOT guarded: the recovery direction has to stay open.
function pauseSession(name) {
  if (name && !leadGuard(name, 'paused')) doVerb('fleet_pause', { project: S.project, session: name });
}
function resumeSession(name) {
  if (name) doVerb('fleet_resume', { project: S.project, session: name });
}
// ── waking is NOT resuming, and the two are one letter apart in the UI ────────
// fleet_resume un-parks a session that is still running. fleet_wake starts a process that
// is gone and replays its conversation into it, which takes seconds rather than
// milliseconds and can fail in ways un-parking cannot — a folder that was never trusted, a
// transcript too large to replay inside the timeout. So the tap goes through the verb and
// waits for its answer instead of opening optimistically: opening first would show an empty
// pane for a session that never came back, which is the failure looking exactly like
// success that this repo keeps paying for.
async function wakeSession(name) {
  if (!name) return;
  const r = await doVerb('fleet_wake', { project: S.project, session: name });
  if (r && r.ok === false) return;          // doVerb has already surfaced the reason
  openSession(name);
}

function askKill(name) { if (name && !leadGuard(name, 'stopped')) { S.confirm = { kind: 'kill', name }; render(); } }
async function confirmedKill(name) {
  S.confirm = null;
  await doVerb('fleet_stop', { project: S.project, session: name });
  if (S.screen === 'session' && S.session === name) back(); else render();
}
// stop --reclaim removes the worktree too, so it takes BOTH of the TUI's prompts: the
// kill, then the removal. Two deliberate steps for the one verb that can delete work.
function askReclaim(name) { if (name && !leadGuard(name, 'stopped or reclaimed')) { S.confirm = { kind: 'reclaim-kill', name }; render(); } }
function askReclaimWorktree(name) {
  const c = cardOf(name) || {};
  S.confirm = { kind: 'reclaim-wt', name, folder: c.folder || name, branch: c.branch || '' };
  render();
}
async function confirmedReclaim(name) {
  S.confirm = null;
  const r = await doVerb('fleet_stop', { project: S.project, session: name, reclaim: true });
  // fleet_stop always stops; whether it also removed the checkout is fleet-clean's
  // call, and its reason is the interesting half of the answer.
  if (r && r.text) toast(r.text, 'good');
  if (S.screen === 'session' && S.session === name) back(); else render();
}
function askRemoveWorktree(w) { S.confirm = { kind: 'wt', path: w.path, branch: w.branch, msg: '', force: false }; render(); }
async function removeWorktree(c, force) {
  S.confirm = { ...c, busy: true }; render();
  try {
    const assertion = await assertFor(`remove worktree ${G.basename(c.path)}`);
    const r = await api.verb('fleet_worktree_remove', { project: S.project, path: c.path, branch: c.branch, force }, assertion);
    S.confirm = null; toast(r.text || 'removed', 'good');
    await refresh();
  } catch (e) {
    // Refused (unpushed commits, a dirty tree, another session on it) — say what it
    // said and offer the force step as its own key, the way the TUI does.
    S.confirm = { ...c, busy: false, msg: String(e.message || e), force: true };
    render();
  }
}

// ── verbs ─────────────────────────────────────────────────────────────────
// The passkey prompt happens HERE, at the moment of action, for exactly the verbs §7
// names. It is not the enforcement — the server is (§5) — it is what makes a phone in
// someone else's hand different from a phone plus its owner.
async function assertFor(purpose) {
  if (!pk.available() || !pk.registered()) {
    if (pk.bypassAllowed()) return null;         // fixtures: nothing to protect
    throw new Error(`this device has no passkey — ${pk.unavailableReason() || 'register one in settings'}`);
  }
  return pk.fresh(purpose);
}
async function doVerb(tool, args, opts = {}) {
  try {
    const assertion = api.DESTRUCTIVE.has(tool) ? await assertFor(`${tool} ${args.session || args.name || ''}`.trim()) : null;
    const r = await api.verb(tool, args, assertion);
    if (!opts.quiet) toast(r.text || `${tool} ok`, 'good');
    await refresh();
    return r;
  } catch (e) {
    if (e instanceof api.AuthError) { lock('pane'); return null; }
    toast(String(e.message || e), 'bad');
    render();
    return null;
  }
}

// ── the lock screen ───────────────────────────────────────────────────────
// The ship, small, because this is the one screen with room for it.
const SHIP = [
  '   ▄▄▄▄▄▄█        ',
  '   ▀▀▀▀▀ █        ',
  '    ▄▄███████▄▄▄  ',
  ' ▄██████ ███ ████▄',
  '▄████████████████ ',
  '▀▀█████████████▀▀ ',
].join('\n');
function lockScreen() {
  const box = el('div', { class: 'lock' });
  box.append(el('pre', { class: 'ship', text: SHIP }));
  box.append(el('h1', { text: 'ghostfleet' }));
  // Which backend, and WHY that one — api.js writes the sentence, because api.js is the
  // half that knows whether it asked and what answered. "fixtures — no server
  // configured" is the line that made this diagnosable from a photo of a phone, so the
  // shape is kept and the server case is now equally specific: it names the origin it is
  // talking to, so "which fleet is this" is answerable here too.
  const r = api.resolution();
  const server = r.mode === 'server';
  box.append(el('p', { class: server ? null : 'warn', text: r.detail }));
  if (r.mode !== 'probing' && !pk.available()) {
    box.append(el('p', { class: 'warn', text: `passkey unavailable: ${pk.unavailableReason()}` }));
  }
  if (r.mode === 'fixtures') {
    // Say plainly what the gate is worth here. §5's rule is that the assertion has to
    // mint a token the SERVER checks; with no server there is nothing to check it, and
    // claiming otherwise would be the "lock screen as decoration" the doc warns about.
    box.append(el('p', { text: 'in fixture mode the passkey gate is local only — the server is what enforces it (§5).' }));
  }
  const row = el('div', { class: 'row' });
  // NO ACTION BUTTONS UNTIL THE PROBE ANSWERS. "register a passkey" means one thing
  // against a server and another against fixtures, and the fixture bypass must never be
  // offered on a page that turns out to be served BY the daemon — which is precisely the
  // window a probe is open for.
  if (r.mode !== 'probing') {
    if (pk.available() && !pk.registered()) {
      // Against a server, registering is ENROLLING, and the server refuses a passkey that
      // no window and no one-time code authorised. That refusal is not a bug to route
      // around — the endpoint is remote code execution — so the phone gets a field to
      // type the code into, which is the half that was missing.
      if (server) row.append(btn('enrol this phone', () => sheetEnrol(), 'go'));
      else row.append(btn('register a passkey', async () => {
        try { await pk.register(); S.locked = false; render(); refresh(); }
        catch (e) { toast(String(e.message || e), 'bad'); }
      }, 'go'));
    } else if (pk.available()) {
      row.append(btn('unlock with Face ID', async () => {
        try { api.diag('auth', 'start'); await pk.open(); api.diag('auth', 'ok');
              S.locked = false; render(); refresh(); }
        catch (e) { toast(String(e.message || e), 'bad'); }
      }, 'go'));
    }
    if (pk.bypassAllowed()) {
      row.append(btn('continue without a passkey (fixtures)', () => { pk.bypass(); S.locked = false; render(); refresh(); }));
    }
    // Only when the probe is the reason. A daemon started after this page was opened is
    // the ordinary way to be here, and it is one request to find out — not a reload,
    // which on a home-screen app is a cold start.
    if (r.mode === 'fixtures' && r.source === 'probe') {
      row.append(btn('look again', async () => {
        const next = await api.reprobe();
        toast(next.detail, next.mode === 'server' ? 'good' : '');
        render();
      }));
    }
  }
  row.append(btn('settings', () => sheetSettings()));
  box.append(row);
  if (S.toast) box.append(el('div', { class: 'toast ' + S.toast.kind, text: S.toast.text }));
  return box;
}

// ── sheets (the TUI's forms) ──────────────────────────────────────────────
function renderSheet() {
  const host = document.getElementById('sheet');
  // Already mounted: leave it ALONE. Re-appending a live node moves it, and moving it
  // blurs whatever is focused inside — a toast arriving while you type a prompt would
  // otherwise throw the caret back to the first field mid-sentence.
  if (S.sheet && host.firstChild === S.sheet.node) return;
  host.textContent = '';
  if (!S.sheet) return;
  host.append(S.sheet.node);
  const first = host.querySelector('input, textarea, select');
  if (first && S.sheet.focus !== false) first.focus();
}
function openSheet(node, focus = true) { S.sheet = { node, focus }; renderSheet(); }
function closeSheet() { S.sheet = null; renderSheet(); render(); }
function sheet(title, sub, kids) {
  const s = el('div', { class: 'sheet' });
  s.append(el('h2', {}, [document.createTextNode(title), sub ? el('span', { class: 'sub', text: ' — ' + sub }) : null]));
  for (const k of kids) if (k) s.append(k);
  return s;
}
function field(label, input) { return el('div', {}, [el('label', { class: 'field', text: label }), input]); }
function input(value = '', attrs = {}) { return el('input', { type: 'text', value, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs }); }

// `n` — a session in a checkout that already exists. The TUI's picker; the list has to
// come from the daemon, since the phone has no filesystem to discover.
async function sheetPicker() {
  let data;
  try { data = await api.getCheckouts(S.project); }
  catch (e) { toast(String(e.message || e), 'bad'); return; }
  const list = el('div', { class: 'rows' });
  for (const c of data.checkouts || []) {
    list.append(el('div', { class: 'srow' }, [
      el('div', { class: 'nm', text: G.homeTilde(c) }),
      btn('⏎ name it', () => sheetName({ cwd: c, name: G.basename(c), reuse: c })),
    ]));
  }
  if (!(data.checkouts || []).length) {
    list.append(el('p', { class: 'warn', text: 'no git checkouts found. looked in: ' + (data.roots || []).map(G.homeTilde).join(', ') }));
    list.append(el('p', { text: 'fix: put one path per line in ~/.config/ghostfleet/checkouts' }));
  }
  openSheet(sheet('new session', `pick a checkout under ~/${S.project || ''}`, [list, el('div', { class: 'row' }, [btn('esc back', closeSheet)])]), false);
}

// the naming screen: a live session with the same name gets -2/-3 appended automatically
function sheetName({ cwd, name, reuse }) {
  const nm = input(name);
  const go = async () => {
    const n = (nm.value || '').trim() || G.basename(cwd);
    closeSheet();
    await doVerb('fleet_spawn', { project: S.project, name: n, reuse });
  };
  openSheet(sheet('session name', G.homeTilde(cwd), [
    field('name', nm),
    el('p', { text: 'a live session with the same name gets -2/-3 appended automatically' }),
    el('p', { class: 'warn', text: 'spawn asks for the passkey — it creates a checkout and runs shell commands (§7).' }),
    el('div', { class: 'row' }, [btn('⏎ create', go, 'go'), btn('esc back', closeSheet)]),
  ]));
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// `w` — a brand-new worktree. The TUI's four fields, same defaults, same hints.
function sheetWorktree() {
  const name = input(''), branch = input(''), from = input('');
  const agent = el('select', {}, ['claude', 'codex', 'opencode'].map(a => el('option', { value: a, text: a })));
  const go = async () => {
    const n = (name.value || '').trim();
    if (!n) { toast('a name is required', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_spawn', { project: S.project, name: n, branch: (branch.value || '').trim() || n,
                                  from: (from.value || '').trim(), agent: agent.value });
  };
  openSheet(sheet('new worktree', `a sibling checkout of ${S.project || ''}, on its own branch`, [
    field('name', name), field('branch  (blank = same as the name)', branch),
    field('from  (base ref for a new branch)', from), field('agent', agent),
    el('p', { class: 'warn', text: 'creating the worktree runs git and boots a session — the passkey prompt comes first.' }),
    el('div', { class: 'row' }, [btn('⏎ create + open', go, 'go'), btn('esc cancel', closeSheet)]),
  ]));
}

// `s` — schedule a message. The TUI's form: "<time> | <message>", a live preview, the
// same examples, and empty + ⏎ clears a pending one.
function sheetSchedule(name, project = S.project) {
  const c = project === S.project ? cardOf(name) : null;
  const existing = c && c.sched;
  const box = input('');
  const preview = el('p', { text: '→ enter a time' });
  const msgLine = el('p', { text: 'message: continue' });
  const update = () => {
    const parts = (box.value || '').split('|');
    const at = G.parseWhen((parts[0] || '').trim());
    const msg = (parts[1] || 'continue').trim() || 'continue';
    preview.className = at ? 'ok' : '';
    preview.textContent = at ? `→ ${G.clockLabel(at)}  (${new Date(at * 1000).toLocaleString()})` : '→ enter a time';
    msgLine.textContent = 'message: ' + msg;
  };
  box.addEventListener('input', update);
  const go = async () => {
    const parts = (box.value || '').split('|');
    const at = G.parseWhen((parts[0] || '').trim());
    const msg = (parts[1] || 'continue').trim() || 'continue';
    if (box.value.trim() && !at) { toast('unparseable time', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_schedule', { project, session: name, at, prompt: msg });
  };
  box.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  openSheet(sheet('schedule a message', `→ ${name}`, [
    existing ? el('p', { class: 'warn', text: `currently: @${G.clockLabel(existing.at)} "${existing.msg || ''}" — a new time replaces it; empty clears it` }) : null,
    field('send at', box), preview, msgLine,
    el('p', { text: 'examples: 3:50am · 15:30 · +2h   ·   customize text with  <time> | <message>' }),
    el('div', { class: 'row' }, [btn('⏎ schedule', go, 'go'), btn('esc back', closeSheet)]),
  ]));
  update();
}

function sheetSend(name) {
  const t = el('textarea', { placeholder: 'a self-contained prompt — the sibling does not share your context' });
  const go = async () => {
    const p = (t.value || '').trim();
    if (!p) { toast('nothing to send', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_send', { project: S.project, session: name, prompt: p });
  };
  openSheet(sheet('send a prompt', `→ ${name}`, [
    field('prompt', t),
    // The trap from CLAUDE.md, where it can actually be read by the person about to
    // step in it.
    el('p', { text: 'a prompt sent to a BUSY session queues behind the turn already running.' }),
    el('div', { class: 'row' }, [btn('send', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

function sheetAnswer(name) {
  const t = input('', { placeholder: 'e.g. 2   or   yes' });
  const noEnter = el('input', { type: 'checkbox' });
  const go = async () => {
    const text = t.value;
    if (!text) { toast('fleet_answer refuses an empty text', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_answer', { project: S.project, session: name, text, no_enter: noEnter.checked });
  };
  t.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  openSheet(sheet('answer keys', `→ ${name}`, [
    el('p', { text: 'literal keystrokes for a worker blocked on a dialog — a permission prompt, "reached usage limit — retry?", a trust prompt.' }),
    field('keys', t),
    el('label', { class: 'field' }, [noEnter, document.createTextNode(' send without pressing Enter')]),
    el('div', { class: 'row' }, [btn('answer', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

function sheetRename(name) {
  // The button is already gone on the lead's screen; the KEY is a second door into the
  // same sheet, and a form that can only end in a refusal is worse than no form.
  if (leadGuard(name, 'renamed')) return;
  const nm = input(name);
  const go = async () => {
    const n = (nm.value || '').trim();
    if (!n || n === name) { closeSheet(); return; }
    closeSheet();
    await doVerb('fleet_rename', { project: S.project, session: name, new_name: n });
    if (S.session === name) { S.session = n; S.sess = null; refresh(); }
  };
  openSheet(sheet('rename', name, [
    field('new name', nm),
    el('p', { text: 'renames the tmux session AND moves its worktree folder (git worktree move)' }),
    el('p', { class: 'warn', text: 'a destructive verb (§7) — the passkey prompt comes first.' }),
    el('div', { class: 'row' }, [btn('⏎ rename', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

function sheetLabel(name) {
  const c = cardOf(name) || {};
  const nm = input(c.label || '');
  const go = async () => { const v = (nm.value || '').trim(); closeSheet(); await doVerb('fleet_label', { project: S.project, session: name, label: v }); };
  openSheet(sheet('label', `what the card calls ${name}`, [
    field('label', nm),
    el('p', { text: `Display only. The session is still '${name}' — that is what fleet-send addresses, and the card keeps showing it. Empty clears the label.` }),
    el('div', { class: 'row' }, [btn('⏎ save', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

// ── which CLI a project's master runs ────────────────────────────────────────
// "the master cant be selected as open code or codex add that pls". The 4th column of
// the projects file has been the project's default agent for a while, bin/ghostfleet
// reads it into CLAUDE_FLEET_AGENT and hands it to the master at creation, and
// `fleet-project add --agent` could write it — but nothing on any SCREEN could, so the
// only way to change it was editing a text file.
//
// THE OPTIONS COME FROM THE MACHINE. /api/projects carries `agents`, built by the daemon
// from `fleet-agent list` filtered by `fleet-agent installed`, so a fourth agent appears
// here without this file changing, and an agent that is not installed is never offered —
// picking one that cannot run would leave the next master dead at `exec agent-here` with
// nothing on screen to say why.
//
// AND EACH OPTION CARRIES WHAT IT COSTS. `fleet-agent caveat` composes that from the
// registry's own capability fields, measured rather than assumed (2026-08-26): opencode
// is fully visible to the fleet but has no fleet_* tools registered, and codex has
// neither those nor an event bridge, so its card status is pane guesswork and a question
// it asks may never reach the inbox. Shipping the option without saying so would be a
// silent footgun — the fleet would look broken rather than degraded.
const agentCatalogue = () => (S.agents || []);
// The empty option is FIRST and is not the word "claude": an absent 4th column is what
// every existing project has, and it is what the card's "profile · agent" line keys off.
// Writing 'claude' would make every default project start printing "· claude".
function agentPicker(current, onPick) {
  const cat = agentCatalogue();
  const note = el('p', { class: 'hint' });
  const paint = (v) => {
    const hit = cat.find(a => a.name === v);
    note.className = hit && hit.caveat ? 'warn' : 'hint';
    note.textContent = !v ? 'claude — the default; nothing is given up.'
      : hit && hit.caveat ? `${v} — ${hit.caveat}`
      : `${v} — the full fleet: events, tools and resume.`;
  };
  const row = el('div', { class: 'seg wrap' });
  const draw = () => {
    row.textContent = '';          // clears children in a browser and in the test DOM
    const opts = [{ name: '', label: 'claude (default)' }, ...cat.filter(a => a.name !== 'claude').map(a => ({ name: a.name, label: a.name }))];
    for (const o of opts) {
      row.append(btn(o.label, () => { current = o.name; onPick(o.name); paint(o.name); draw(); },
                     current === o.name ? 'on' : ''));
    }
  };
  draw(); paint(current);
  // A CATALOGUE THAT NEVER ARRIVED MUST SAY SO. On a daemon too old to send `agents`, or
  // a hand-written fixture, this list is empty — and a picker offering one option reads
  // as "there is only claude" rather than as "the machine was never asked".
  if (!cat.length) note.textContent = 'this fleet did not report which agents are installed — only the default is offered.';
  return { row, note };
}
// THE RUNNING MASTER DOES NOT CHANGE, said at the point of change. CLAUDE_FLEET_AGENT is
// read once, by agent-here, when the tmux session is created; the session has already
// exec'd its CLI and nothing re-reads the projects file. Without this line the setting
// looks broken — you pick codex, the master keeps answering as claude, and nothing
// anywhere explains it. Same family as every long-lived-process trap in CLAUDE.md.
const NEXT_MASTER = 'takes effect on the NEXT master — a running one keeps the CLI it started with (stop it, or open the project again, to switch).';

// The edit path for a project that already exists — reached from the projects screen's
// settings sheet, where the other two per-project settings live. A sheet of its own
// rather than a cycling button in that row, because the option that matters most about
// this setting is the sentence under it: what the choice costs, and that it applies to
// the next master rather than the one that is running.
function sheetProjectAgent(p) {
  let agent = p.agent && p.agent !== 'claude' ? p.agent : '';
  const pick = agentPicker(agent, v => { agent = v; });
  const go = async () => {
    closeSheet();
    await doVerb('fleet_project_agent', { name: p.name, agent });
    refresh();                       // the card's "profile · agent" line is now stale
  };
  openSheet(sheet(`agent · ${p.name}`, NEXT_MASTER, [
    pick.row, pick.note,
    el('div', { class: 'row' }, [btn('save', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

function sheetAddProject() {
  const p = input('', { placeholder: '/Users/you/some-repo' });
  const nm = input('');
  const start = el('input', { type: 'checkbox' });
  let agent = '';
  const pick = agentPicker('', v => { agent = v; });
  const go = async () => {
    const path = (p.value || '').trim();
    if (!path) { toast('a path is required', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_project_add', { path, name: (nm.value || '').trim(), agent, start: start.checked });
  };
  openSheet(sheet('add project', 'the repo, or a folder holding its checkouts', [
    field('path', p), field('name  (default: the folder name)', nm),
    el('div', { class: 'field' }, [el('label', { text: "master's agent" }), pick.row, pick.note]),
    el('label', { class: 'field' }, [start, document.createTextNode(' also start its master session')]),
    el('div', { class: 'row' }, [btn('add', go, 'go'), btn('esc back', closeSheet)]),
  ]));
}

// The enrolment code. `fleet-serve enroll <client-id>` prints one and says "Open <origin>
// on the phone and enter it" — and there was nowhere to enter it, so every registration
// was a 403 and the lock screen's button did nothing at all.
//
// Errors land INSIDE the sheet rather than in a toast: #sheet is a fixed overlay above
// #app, so a toast under it cannot be read, and the two sentences worth reading here are
// long. They are the server's own, verbatim (api.js), because "no enrolment is open — run
// fleet-serve enroll <id>" and "wrong or missing enrolment code" are the difference
// between knowing what to do next and staring at a screen.
function sheetEnrol() {
  const code = input('', { placeholder: 'GP7CX-ZRDR5', autocapitalize: 'characters' });
  const note = el('p', { text: `asking ${api.modeLabel()} whether an enrolment window is open…` });
  const err = el('p', { class: 'err' });
  const go = async () => {
    err.textContent = '';
    try {
      await pk.register(code.value);
      S.locked = false;
      toast('enrolled — the server minted this session', 'good');
      closeSheet();
      refresh();
    } catch (e) { err.textContent = String((e && e.message) || e); }
  };
  openSheet(sheet('enrol this phone', api.modeLabel(), [
    el('p', { text: 'On the Mac: fleet-serve enroll <client-id> — it prints a one-time code, good for 15 minutes and one use. Case and the hyphen do not matter.' }),
    note, field('enrolment code', code), err,
    el('div', { class: 'row' }, [btn('enrol', go, 'go'), btn('esc back', closeSheet)]),
  ]));
  // Asked before anything is typed, and before Face ID: a closed window is knowable in
  // advance, and finding out afterwards means biometrics spent on a refusal.
  pk.enrolmentState().then(st => {
    note.className = st.open ? 'ok' : 'warn';
    note.textContent = st.open
      ? `a window is open for '${st.client}' — enter the code it printed.`
      : 'no enrolment is open. On the Mac: fleet-serve enroll <client-id>, then come back.';
  }).catch(e => {
    note.className = 'warn';
    note.textContent = `could not ask the server: ${String((e && e.message) || e)}`;
  });
}

// `,` — settings. The TUI has two of these pages and this sheet is both, plus the block
// a phone needs and a terminal does not (where the fleet is, and the passkey).
async function sheetSettings() {
  const kids = [];
  if (S.screen === 'grid' || S.screen === 'session') {
    let cfg = { global_nudge: false, sessions: {} };
    try { cfg = await api.getSettings(S.project); } catch {}
    kids.push(el('p', { text: 'worker → master auto-nudge, per session. A session\'s own setting wins over the project\'s.' }));
    const rows = el('div', { class: 'rows' });
    kids.push(el('p', { text: `nudge global default: ${cfg.global_nudge ? 'on' : 'off'}` }));
    // THE LEAD IS SKIPPED. These rows are the "worker → master auto-nudge" override, and
    // the lead has no lead to nudge — a toggle for master pinging itself is nonsense the
    // moment master became a card. The `r` shortcut in each row would only reach a refusal
    // too. Filtered on the WIRE's flag, like every other lead test in this file.
    for (const c of ((S.grid && S.grid.cards) || []).filter(c => !c.lead)) {
      const state = cfg.sessions[c.name] || 'inherit';
      const badge = el('span', { class: 'badge ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : 'inherit'),
                                 text: state === 'on' ? '● on' : state === 'off' ? '○ off' : '· inherit' });
      rows.append(el('div', { class: 'srow' }, [
        badge, el('div', { class: 'nm', text: c.name }),
        btn('cycle', async () => {
          const next = state === 'inherit' ? 'on' : state === 'on' ? 'off' : 'inherit';
          await doVerb('fleet_nudge', { project: S.project, session: c.name, state: next });
          closeSheet();
        }),
        btn('r', () => { closeSheet(); sheetRename(c.name); }),
        btn('l', () => { closeSheet(); sheetLabel(c.name); }),
      ]));
    }
    kids.push(rows);
  } else {
    kids.push(el('p', { text: 'auto-nudge: a worker that finishes or needs help pings its master to drain fleet-inbox' }));
    kids.push(el('p', { text: 'budget limit: enforced = the governor parks all workers near the 5h usage ceiling · ignored = keep running' }));
    // THE AGENT SITS WITH THE OTHER TWO PER-PROJECT SETTINGS, and that placement is the
    // point rather than convenience: the TUI's `,` page is a table of projects with a
    // column per setting, and this is the same table. A project created before today —
    // which is all of them — had no edit path at all on the phone, so a picker that only
    // worked at creation time would not have answered the request.
    kids.push(el('p', { text: "agent: which coding CLI this project's master runs. It " + NEXT_MASTER }));
    const rows = el('div', { class: 'rows' });
    for (const p of S.projects || []) {
      rows.append(el('div', { class: 'srow' }, [
        el('div', { class: 'nm', text: p.name }),
        // Labelled with what it IS, not with a verb: the row is a state readout first.
        // 'claude' rather than blank, because a blank cell reads as "not loaded" — the
        // empty COLUMN is a storage detail and this is the only place it should not leak.
        btn(p.agent && p.agent !== 'claude' ? p.agent : 'claude',
            () => { closeSheet(); sheetProjectAgent(p); },
            p.agent && p.agent !== 'claude' ? 'on' : ''),
        btn(p.nudge ? '● on' : '○ off', async () => { await doVerb('fleet_nudge', { project: p.name, state: p.nudge ? 'off' : 'on' }); closeSheet(); }, p.nudge ? 'on' : 'off'),
        btn(p.budget === 'ignored' ? '● ignored' : '○ enforced', async () => { await doVerb('fleet_budget', { project: p.name, state: p.budget === 'ignored' ? 'enforced' : 'ignored' }); closeSheet(); }),
      ]));
    }
    kids.push(rows);
  }

  // where the fleet is
  //
  // THREE choices, not a URL box whose emptiness means two different things. It used to
  // be one field where blank meant fixtures, so "I have not said" and "I want fixtures"
  // were the same value — and since nothing ever filled it in, the client fleet-serve
  // was serving chose fixtures and showed a fleet that does not exist. Both overrides
  // have to survive that fix: forcing fixtures while the daemon serves the page (a demo)
  // and forcing an origin while something else serves it.
  const p = api.pref();
  const how = el('select', {}, [
    el('option', { value: 'auto', text: 'auto — this page\'s own origin, if a fleet answers there', selected: p.kind === 'auto' }),
    el('option', { value: 'fixtures', text: 'fixtures — the bundled sample fleet, never a server', selected: p.kind === 'fixtures' }),
    el('option', { value: 'url', text: 'a URL I type below', selected: p.kind === 'server' }),
  ]);
  const base = input(p.kind === 'server' ? p.base : '', { placeholder: 'http://mac.tailnet.ts.net:8787' });
  kids.push(el('h2', { text: 'connection' }));
  kids.push(el('p', { text: `right now: ${api.resolution().detail}` }));
  kids.push(field('where the fleet is', how));
  kids.push(field('fleet-serve URL', base));
  kids.push(el('p', { text: `auto asks ${api.PROBE_PATH} on the origin that served this page — a 401 there is proof of a fleet, since it means the endpoint exists and is enforcing the passkey. Over the tailnet only — never a public hostname (§5).` }));
  const fx = el('select', {}, api.FIXTURES.map(f => el('option', { value: f.file, text: f.title, selected: f.file === api.fixtureName() })));
  kids.push(field('fixture', fx));
  kids.push(el('div', { class: 'row' }, [
    btn('save', async () => {
      if (how.value === 'fixtures') api.useFixtures();
      else if (how.value === 'url') api.setBaseUrl(base.value.trim());
      else api.useAutoDetect();
      api.setFixtureName(fx.value);
      api.resetOverlay();
      closeSheet();
      lock();               // a different backend is a different session: assert again
      await api.ready();    // and 'auto' has to ask before the lock screen can say what it is
      render();
    }, 'go'),
  ]));

  // A passkey is registered FOR A BACKEND, so this says which one — that is the whole
  // reason the phone was stuck: a credential registered against fixtures counted as one
  // for the server, so the app offered to unlock with a passkey the server had never
  // seen.
  kids.push(el('h2', { text: 'passkey' }));
  kids.push(el('p', { text: pk.available()
    ? (pk.registered() ? `registered on this device for ${api.modeLabel()}.` : `not registered for ${api.modeLabel()} yet.`)
    : `unavailable: ${pk.unavailableReason()}` }));
  kids.push(el('div', { class: 'row' }, [
    pk.available() && !pk.registered() && api.mode() === 'server'
      ? btn('enrol this phone', () => { closeSheet(); sheetEnrol(); }) : null,
    pk.available() && !pk.registered() && api.mode() === 'fixtures'
      ? btn('register', async () => { try { await pk.register(); toast('passkey registered', 'good'); } catch (e) { toast(String(e.message || e), 'bad'); } closeSheet(); }) : null,
    pk.registered() ? btn('forget this device\'s passkey', () => { pk.forget(); toast('forgotten — a lost phone is revoked server-side too', 'good'); closeSheet(); }, 'danger') : null,
  ].filter(Boolean)));

  // ── notifications ───────────────────────────────────────────────────────
  // SAY WHICH STATE IT IS IN. Every branch here is a state someone can be standing in
  // with a phone, and the one that has to be named out loud is the tab: on iOS a Safari
  // tab cannot subscribe at all, so a button would open no prompt and change nothing —
  // which reads exactly like a bug. It says "add it to your home screen" instead.
  kids.push(el('h2', { text: 'notifications' }));
  kids.push(el('p', { text: 'a buzz when a session has an answer for you or is blocked on you — those two, and nothing else. Never any transcript text: the payload carries a state and a name.' }));
  const pwhy = pushBlockedReason();
  if (pwhy) {
    kids.push(el('p', { class: 'dim', text: pwhy }));
  } else {
    const sub = await pushCurrent();
    let meta = null;
    try { meta = await api.pushKey(); } catch {}
    const on = !!sub;
    kids.push(el('p', { text: on
      ? `on for this device${meta && meta.subscribed ? '' : ' (the fleet has not been told yet — it will be on the next unlock)'}`
      : 'off for this device' }));
    // WHOSE NAMES REACH THE LOCK SCREEN — the one thing that is Pablo's call and not
    // this file's. Set on the Mac (`fleet-serve push --detail anonymous`) because the
    // payload is built there; shown here because the phone is where the consequence is.
    if (meta) kids.push(el('p', { class: 'dim small', text: meta.detail === 'anonymous'
      ? 'detail: anonymous — a count only, no project or session names (fleet-serve push --detail named to change it)'
      : 'detail: named — project/session on the lock screen (fleet-serve push --detail anonymous to stop that)' }));
    kids.push(el('div', { class: 'row' }, [
      on ? btn('turn off', async () => {
            try { await pushDisable(); toast('notifications off', 'good'); } catch (e) { toast(String(e.message || e), 'bad'); }
            closeSheet();
          }, 'danger')
         : btn('turn on', async () => {
            try { await pushEnable(); toast('notifications on', 'good'); } catch (e) { toast(String(e.message || e), 'bad'); }
            closeSheet();
          }, 'go'),
    ]));
  }

  // the audit trail — a log that appears in the app is a control; one nobody reads is
  // a compliance gesture (§7)
  const log = api.auditLog();
  kids.push(el('h2', { text: `mobile actions this session (${log.length})` }));
  const ul = el('ul', { class: 'audit' });
  for (const r of log.slice(0, 25)) ul.append(el('li', { text: `${G.clockLabel(r.at)}  ${r.tool} ${JSON.stringify(r.args)} → ${r.result}` }));
  if (!log.length) ul.append(el('li', { text: 'nothing yet. Every mutating call lands here, and on a server it also lands in fleet-inbox.' }));
  kids.push(ul);

  kids.push(el('div', { class: 'absent' }, [el('div', { text: 'not here, on purpose (§7):' }),
    el('div', { text: '· the stack — it exists to put sessions side by side, and a phone has no side. At nc = 1 that is the card list.' }),
    el('div', { text: '· Ctrl-t terminal / Ctrl-n editor tabs — they open a shell and neovim in the session\'s folder, and there is no local shell here.' })]));
  // ── the voice, next to the diagnostic line it sits above ──────────────────
  // A <select> and not a list of buttons: the list is however many voices the OS ships
  // (dozens on iOS) and that is the one place a native control beats anything drawn here.
  if (canSpeak()) {
    const vs = allVoices();
    const cur = savedVoice();
    const sel = el('select', { class: 'vpick' });
    // "default" is a real choice and the first one, because it is what an unset preference
    // means AND what a saved-but-absent voice falls back to — the same state, named once.
    sel.append(el('option', { value: '', text: 'default (whatever this device picks)' }));
    // GROUPED BY LANGUAGE. A populated iOS list is dozens of entries and `Karen` on its own
    // tells you nothing about which of them will read English back to you; `lang` is the one
    // field every implementation fills in, so it is the one thing worth grouping on. It also
    // makes the count below legible: eight voices in one language and eight in eight are
    // very different answers to "why does this sound wrong".
    const byLang = new Map();
    for (const v of vs) {
      const k = String(v.lang || 'unknown');
      if (!byLang.has(k)) byLang.set(k, []);
      byLang.get(k).push(v);
    }
    const chosen = (v) => !!cur && (cur.uri === v.voiceURI ||
      (!vs.some(x => x.voiceURI === cur.uri) && cur.name === v.name));
    for (const k of [...byLang.keys()].sort()) {
      const g = el('optgroup', { label: k });
      for (const v of byLang.get(k)) {
        const o = el('option', { value: v.voiceURI, text: v.name });
        if (chosen(v)) o.selected = true;
        g.append(o);
      }
      sel.append(g);
    }
    sel.addEventListener('change', () => {
      setSavedVoice(vs.find(v => v.voiceURI === sel.value) || null);
      stopSpeaking();                       // whatever is talking is talking in the old voice
      render();
    });
    kids.push(el('h2', { text: 'read-aloud voice' }));
    kids.push(sel);
    // THE COUNT, BECAUSE ONE OPTION AND NO LIST LOOK IDENTICAL FROM THE OUTSIDE. "I only
    // see the default voice" has at least two causes — the device really reports one, or the
    // list never populated (see allVoices: getVoices() answers [] on the first call in
    // Safari) — and from a phone with no console attached neither is distinguishable from
    // the other. A number is. It is also the only thing on this screen anybody can quote
    // back, so it says `reported by this device` rather than naming a total it is not.
    kids.push(el('div', { class: 'dim small',
      text: `${vs.length} ${vs.length === 1 ? 'voice' : 'voices'} reported by this device` +
            (byLang.size > 1 ? `, in ${byLang.size} languages` : '') }));
    // A SUGGESTION, NOT A DIAGNOSIS, and phrased as one on purpose. No iPhone was in this
    // loop: the count above is measured on whatever device is reading it, this line is not.
    // iOS is documented to expose a reduced voice list to Web Speech until the enhanced
    // voices are downloaded in Settings, which WOULD explain a count of one — but nobody
    // here has watched that number change after downloading one, so it must not read as a
    // promise that it will. The count is the thing to trust; if the count stays put, this
    // text is wrong and should go.
    if (vs.length <= 1) kids.push(el('div', { class: 'dim small' }, [
      el('div', { text: vs.length
        ? 'one voice is fewer than a phone normally reports.'
        : 'nothing reported yet — this list can fill in a moment after the first open, so reopen this sheet before reading anything into it.' }),
      el('div', { text: 'on iOS it may be worth looking at Settings → Accessibility → Spoken Content → Voices and downloading a voice there. That is a guess, not a fix: if it is the right one, the count above goes up.' }),
    ]));
    if (cur && !pickVoice()) kids.push(el('div', { class: 'dim small',
      text: `“${cur.name}” is not installed on this device — using the default until it is` }));
    const rate = savedRate();
    kids.push(el('div', { class: 'row' }, [
      el('div', { class: 'dim small', text: `rate ${rate.toFixed(2)}×` }),
      btn('− slower', () => { try { localStorage.setItem(LS_RATE, String(Math.max(0.5, rate - 0.15))); } catch {} stopSpeaking(); render(); }),
      btn('+ faster', () => { try { localStorage.setItem(LS_RATE, String(Math.min(2, rate + 0.15))); } catch {} stopSpeaking(); render(); }),
    ]));
  }
  kids.push(el('div', { class: 'row' }, [btn('esc back', closeSheet)]));
  // Last row, and deliberately plain: it is diagnostic, not a setting. `no worker` means
  // you are on the network rather than a cached shell; `unknown` means the worker serving
  // you is too old to answer, which is itself the thing you wanted to know.
  kids.push(el('div', { class: 'dim small', text: `client ${swVersion || 'unknown'}` }));
  openSheet(sheet('settings', S.screen === 'projects' ? 'per project' : 'per session', kids), false);
}

// ── keyboard: the same keys, for a desktop browser and a BT keyboard ──────
function onKey(e) {
  if (S.sheet) {                       // a form owns the keyboard while it is open
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
    return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''))) return;
  const k = e.key;
  if (S.locked) return;
  if (S.confirm) {
    e.preventDefault();
    const c = S.confirm;
    if (c.busy) return;
    // Forcing takes a DIFFERENT key. A second y on a prompt that just refused is a
    // reflex, and this particular one throws away real work.
    if (c.force) { if (k === 'f' || k === 'F') removeWorktree(c, true); else cancel(); return; }
    if (k === 'y' || k === 'Y') {
      if (c.kind === 'kill') confirmedKill(c.name);
      else if (c.kind === 'reclaim-kill') askReclaimWorktree(c.name);
      else if (c.kind === 'reclaim-wt') confirmedReclaim(c.name);
      else if (c.kind === 'wt') removeWorktree(c, false);
      else if (c.kind === 'project') doVerb('fleet_project_remove', { name: c.name }).then(cancel);
    } else cancel();
    return;
  }
  // The session screen has one subject — the session you opened — and the grid's `sel`
  // is not it. Wired to `items()` as well, `p` on this screen paused whichever card the
  // grid cursor happened to be on: the right verb, the wrong worker, no error.
  if (S.screen === 'session') {
    switch (k) {
      case 'q': case '`': back(); break;
      case 'Q': toProjects(); break;
      case 'p': pauseSession(S.session); break;
      case 'P': resumeSession(S.session); break;
      case 's': sheetSchedule(S.session); break;
      case 'r': sheetRename(S.session); break;
      case 'l': sheetLabel(S.session); break;
      case 'x': case 'X': askKill(S.session); break;
      case ',': sheetSettings(); break;
      default: return;
    }
    e.preventDefault();
    return;
  }
  const list = S.screen === 'projects'
    ? [...(S.projects || []).map(p => ({ project: p })), { add: true }]
    : items();
  const it = list[S.sel] || {};
  // ARROWS WALK WHAT IS DRAWN; DIGITS STAY GLOBAL. `list` is deliberately the unfiltered
  // one, so `5` opens project 5 the way `Ctrl-f 5` does at the desk and the way the card
  // says — the digit is an address and an address does not change with the tab. Stepping
  // is the other thing: j/k through cards that are not on screen is a cursor that
  // disappears, so on the projects screen a step goes to the next VISIBLE index (plus the
  // `+ new project` card, which is always drawn).
  const move = d => {
    let n = S.sel + d;
    // WAS `S.profile !== PROFILE_ALL`, and a hidden demo is exactly the case that breaks:
    // on the `all` tab the visible set is now smaller than the list, so the old condition
    // walked j/k straight onto demo cards that are not drawn — a cursor that disappears,
    // which is the failure this branch already existed to prevent. Ask whether anything is
    // hidden, not which tab is on.
    if (S.screen === 'projects' && visibleProjects().length !== (S.projects || []).length) {
      const stops = [...visibleProjects().map(v => v.i), (S.projects || []).length];
      const at = stops.indexOf(S.sel);
      n = at >= 0 ? stops[at + (d > 0 ? 1 : -1)] : stops[0];
      if (n == null) return;
    }
    if (n >= 0 && n < list.length) { S.sel = n; render(); }
  };
  // HOW MANY COLUMNS ARE ACTUALLY ON SCREEN, asked of the browser rather than computed
  // from an assumed character width. The CSS picks the count with auto-fill (see
  // app.css), so the only place the truth lives is the resolved grid — and reading it back
  // means the keys agree with what the eye sees at any viewport, including the one the
  // rotation unlock just made possible. Falls back to 1, which is every phone.
  const nc = gridCols();
  switch (k) {
    // Up and down cross a ROW, which is nc cards — the TUI's ⇧K/⇧J arithmetic, and at
    // nc = 1 it is the one-card step it has always been.
    case 'ArrowUp': case 'k': move(-nc); break;
    case 'ArrowDown': case 'j': move(nc); break;
    // Left and right are always one card. At nc = 1 that makes them the same step as up
    // and down, which is what they used to be unconditionally.
    case 'ArrowLeft': case 'h': move(-1); break;
    case 'ArrowRight': case 'l': move(1); break;
    case 'H': case 'K': if (it.card) reorder(it.card.name, -1); break;
    case 'L': case 'J': if (it.card) reorder(it.card.name, 1); break;
    case 'Enter':
      if (S.screen === 'projects') { it.add ? sheetAddProject() : openProject(it.project.name); }
      else if (it.card) openSession(it.card.name);
      else if (it.freeWt) sheetName({ cwd: it.freeWt.path, name: G.basename(it.freeWt.path), reuse: it.freeWt.path });
      else sheetPicker();
      break;
    case 'n': case 'N': if (S.screen !== 'projects') sheetPicker(); break;
    case 'w': case 'W': if (S.screen !== 'projects') sheetWorktree(); break;
    case 's':
      if (S.screen === 'projects') { if (it.project) sheetSchedule('master', it.project.name); }
      else if (it.card) sheetSchedule(it.card.name);
      break;
    case 'p': if (it.card) pauseSession(it.card.name); break;
    case 'P': if (it.card) resumeSession(it.card.name); break;
    case 'x': case 'X':
      if (S.screen === 'projects') { if (it.project) { S.confirm = { kind: 'project', name: it.project.name }; render(); } }
      else if (it.card) askKill(it.card.name);
      else if (it.freeWt) askRemoveWorktree(it.freeWt);
      break;
    case ',': sheetSettings(); break;
    case 'q': case '`': back(); break;
    case 'Q': toProjects(); break;
    default:
      if (k >= '1' && k <= '9') {
        const i = Number(k) - 1;
        const t = list[i];
        if (!t) break;
        S.sel = i;
        if (S.screen === 'projects') { t.project ? openProject(t.project.name) : sheetAddProject(); }
        else if (t.card) openSession(t.card.name);
        else if (t.freeWt) sheetName({ cwd: t.freeWt.path, name: G.basename(t.freeWt.path), reuse: t.freeWt.path });
        else sheetPicker();
      } else if (e.ctrlKey && (k === 'p' || k === 'P')) { toProjects(); }
      // Ctrl-f is a chord in the terminal because there is no other way to point at a
      // project from inside a session. Here the two screens ARE the chord: projects,
      // then a card.
      else if (e.ctrlKey && (k === 'f' || k === 'F')) { toProjects(); }
      return;
  }
  e.preventDefault();
}

// ── boot ──────────────────────────────────────────────────────────────────
// LAST IN THE FILE, and that is load-bearing. This block ran at the top once, above the
// `const SHIP` the lock screen draws, and every screen was blank: `Cannot access 'SHIP'
// before initialization` — a ReferenceError from the temporal dead zone, which
// `node --check` cannot see because the file is perfectly valid syntax. It is the same
// failure mode CLAUDE.md warns about for the grid, in the one place a static check
// still cannot reach, so the rule is structural instead: nothing executes until every
// declaration exists. test/helpers/pwa-check.mjs asserts the ordering.
restore();
fitCards();
addEventListener('resize', () => {
  fitCards();
  syncViewport();
  // An orientation change moves the fold, and the pane box was sized against the old one.
  if (paneBoxNode) sizePaneBox(paneBoxNode);
});
// visualViewport fires its OWN resize when the keyboard opens — window's does not, on iOS
// — so this is a second registration rather than a tidier one. There is deliberately NO
// `scroll` listener: that fires while Safari pans around a focused field, and the handler
// that used it called scrollTo(0,0), which is a scroll handler fighting the user for the
// scrollbar. Safari's pan is now left alone.
syncViewport();
try {
  if (typeof visualViewport !== 'undefined' && visualViewport) {
    visualViewport.addEventListener('resize', syncViewport);
  }
} catch {}
addEventListener('keydown', onKey);
// The system back gesture. Every backward move in the app comes through here, so a swipe
// and a tap on `‹` cannot mean two different things (back() asks the platform to pop, and
// this is what answers). No URL is ever read: the entries carry a depth, not a route.
addEventListener('popstate', () => popTo());
// §5: a passkey at every open, and again after the app has been backgrounded for a few
// minutes. The token expiring is the same event as far as this is concerned.
document.addEventListener('visibilitychange', () => {
  // Hidden: the pane's timer is TORN DOWN, not left to skip its turns. That is the
  // difference between an app that stops polling in a pocket and one that keeps waking
  // the radio every two seconds to decide it should not have.
  if (document.hidden) { S.hiddenAt = Date.now(); stopPanePoll(); return; }
  const act = onVisibleAction();
  if (act === 'lock') lock('visible');
  else if (act === 'refresh') refresh();
  syncPanePoll();
});
// THE SHELL IS CACHE-FIRST, so a deploy does not reach a phone that already has the app
// until something re-navigates — and the first re-navigation runs the OLD app.js while the
// new one installs behind it, so it takes TWO cold opens to pick up a fix. Measured: a
// phone ran a client 42 minutes older than the deploy while making /api/ calls the whole
// time, and the bug it was reporting had already been fixed. So when a new worker takes
// control, reload — that is what turns one relaunch into the update.
//   `controllerchange` fires when the new worker claims this page (sw.js calls
// clients.claim()). Guarded on there having BEEN a controller: on a first install the
// event also fires, and reloading then would be a pointless flash on the very first open.
//   Never mid-sentence. A reload throws away S.draft, which lives in memory — so if you
// are typing, it waits, and the poll spends it when you are not.
if ('serviceWorker' in navigator) {
  // WHAT THE PAGE WOKE UP AS. `hadController` is the guard that decides whether a
  // controllerchange is a first install (ignore) or a swap (reload), and it is read once,
  // here, at module evaluation. If it reads wrong, every conclusion after it is wrong —
  // and the log cannot show it, because a controlled page still hits the network for the
  // whole shell (sw.js revalidates behind the paint). So the page says it out loud.
  let hadController = !!navigator.serviceWorker.controller;
  api.diag('load', 'ctl' + (hadController ? 1 : 0),
       'sa' + ((() => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 1 : 0; } catch { return 0; } })()),
       'lock' + (S.locked ? 1 : 0));
  navigator.serviceWorker.register('./sw.js').then(reg => {
    // WHICH STATES EXIST AT REGISTRATION. A worker that installs on every launch is the
    // whole puzzle: this says whether one was already active, whether a new one is
    // installing, and whether one is stuck waiting.
    if (!reg) return;
    const st = r => (r ? r.state : 'none');
    api.diag('reg', 'i-' + st(reg.installing), 'w-' + st(reg.waiting), 'a-' + st(reg.active));
    reg.addEventListener('updatefound', () => api.diag('updatefound', 'a-' + st(reg.active)));
  }).catch(() => api.diag('reg', 'failed'));
  askShellVersion();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    api.diag('cc', 'had' + (hadController ? 1 : 0), 'tok' + (api.haveToken() ? 1 : 0),
         'lock' + (S.locked ? 1 : 0));
    if (!hadController) { hadController = true; return; }
    swReloadPending = true;
    takeNewClientIfIdle();
  });
}
// ── the navigation nothing of ours admits to ──────────────────────────────
// A launch logged `load`, then a second `load` seven seconds later with no cc, no swap and
// no lock line before it — so something navigated that none of our reload paths issued,
// and it landed while the first Face ID sheet was open. Guessing at it is what the last two
// rounds cost, so the page reports its own lifecycle instead:
//
//   pagehide p1  the page went into the back/forward cache (a restore is coming)
//   pagehide p0  the page is being torn down — a REAL navigation
//   pageshow p1  restored from bfcache, which fetches no shell and would explain a
//                `load` with no requests behind it
//   pageshow p0  a fresh document
//   unload       the last thing a document ever does
//
// Paired with auth/start above, the order settles it: a pagehide between `auth/start` and
// the assert means the WebAuthn sheet is what tore the document down.
addEventListener('pageshow', e => api.diag('pageshow', 'p' + (e && e.persisted ? 1 : 0)));
addEventListener('pagehide', e => api.diag('pagehide', 'p' + (e && e.persisted ? 1 : 0)));
addEventListener('unload', () => api.diag('unload'));

markStandalone();
addEventListener('orientationchange', markStandalone);
addEventListener('resize', markStandalone);
render();
// One measurement, after layout has settled — early enough to be in the same log burst as
// the launch, late enough that the shell has been sized.
setTimeout(reportGeometry, 1200);
// Paint first, ask second. The lock screen above is drawn against the 'probing' mode —
// the ship, and one line saying which origin is being asked — so this only ever fills in
// the answer. Waiting for the probe before the first paint would put a blank page in
// front of a cold open, which is the thing the service worker exists to prevent.
api.ready().then(() => render());

// Polling, not a socket: `fleet-grid.mjs --plain` answers the busiest fleet in 0.39s
// (§2), so a 5s poll is well inside what the daemon can serve and needs no new
// machinery. Paused while a form or a confirmation is open — a redraw under a
// half-typed prompt is how you lose it.
setInterval(() => {
  if (pollPaused()) return;
  if (takeNewClientIfIdle()) return;       // a newer client was waiting for you to stop typing
  if (renderDeferred) { renderDeferred = false; render(); }
  refresh();
}, 5000);


