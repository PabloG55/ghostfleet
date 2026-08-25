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

// ── state ─────────────────────────────────────────────────────────────────
const S = {
  screen: 'projects',   // projects | grid | session
  project: null,        // the fleet being looked at
  session: null,        // the card opened on the session screen
  projects: null,       // last /api/projects payload
  grid: null,           // last §4 payload
  sess: null,           // last /api/session payload  { messages, next_before, … }
  view: 'chat',         // the session screen: 'chat' (the conversation) | 'pane' (the terminal)
  pane: null,           // last /api/pane payload   { pane, at, … }
  paneGeom: null,       // { rows, cols } — measured from that payload, not claimed by it
  paneErr: '',          // the last pane read's failure, shown once rather than per poll
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
      session: S.session, view: S.view,
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
  try {
    if (S.screen === 'projects') S.projects = (await api.getProjects()).projects;
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
    if (e instanceof api.AuthError) return lock();
    // Offline: keep the cards that are on screen and say how old they are. A blank
    // screen with an error on it is strictly less useful than a stale fleet with a
    // date on it — the question this app answers is "is anything blocked on me", and
    // the answer from ten minutes ago is still worth something.
    if (!S.stale) S.stale = lastFetchedAt();
    toast(e instanceof api.OfflineError ? 'offline — showing the last state fetched' : String(e.message || e), 'bad');
  }
  render();
}
function lastFetchedAt() {
  try { return (JSON.parse(localStorage.getItem(LS_LAST) || '{}').at) || Math.floor(Date.now() / 1000); }
  catch { return Math.floor(Date.now() / 1000); }
}

function lock() { S.locked = true; api.clearToken(); render(); }

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
  toast._t = setTimeout(() => { S.toast = null; render(); }, 4200);
}

// ── render ────────────────────────────────────────────────────────────────
// Which screens own the viewport rather than growing a page under it. The session screen
// has a composer pinned to the bottom and a conversation that scrolls between two fixed
// bars, and the grid has a card list under a header — both are columns of a known height,
// which is what stops the layout moving on a poll.
const SHELL_SCREENS = new Set(['session', 'grid', 'projects']);
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
  app.textContent = '';
  // The pane's nodes are about to be thrown away; drop the references with them, so a
  // poll that lands mid-render patches nothing rather than a detached <pre>.
  paneBoxNode = paneNode = paneGeomNode = null;
  composerNode = null;                      // re-set by composer() if this render draws one
  if (S.locked) { app.append(lockScreen()); renderSheet(); syncPanePoll(); return; }
  if (S.screen === 'projects') app.append(...projectsScreen());
  else if (S.screen === 'grid') app.append(...gridScreen());
  else app.append(...sessionScreen());
  if (S.toast) app.append(el('div', { class: 'toast ' + S.toast.kind, text: S.toast.text }));
  renderSheet();
  // Every state change that matters to the pane's timer — the screen, the view, a sheet,
  // a confirmation, the lock — has already been applied by the time we get here, which is
  // why this is the single place that starts and stops it.
  syncPanePoll();
}

// The banner does not fit a phone — bannerFits() wants 76 columns and 26 rows — so the
// phone gets exactly what a narrow terminal gets: the one-line header. Split over two
// rows only because 60 columns of it will not fit in 32, which is the same split the
// TUI itself makes when it draws the ship beside the counts.
function header(counts) {
  const scope = S.screen === 'projects'
    ? el('span', { class: 'scope', text: '— projects' })
    : el('span', { class: 'scope', text: `[${(S.grid && S.grid.profile) || ''}:${S.project || ''}]` });
  const kids = [el('span', { class: 'name', text: 'ghostfleet' }), scope, modeChip()];
  if (counts) {
    const c = el('span', { class: 'counts' });
    for (const seg of G.countsSegments(counts)) {
      c.append(el('span', { style: seg.color ? `color:${G.COLORS[seg.color]}` : null, text: seg.text }));
    }
    kids.push(c);
  }
  const rows = [el('div', { class: 'hdr' }, kids)];
  if (S.stale) rows.push(el('div', { class: 'stale', text: `⚠ offline — last fetched ${G.clockLabel(S.stale)}` }));
  return rows;
}

// WHICH FLEET AM I LOOKING AT — on every screen, without opening settings. The lock
// screen has always said it, and the lock screen is the one thing you dismiss: the phone
// that was shown four fictional projects had gone past it, and the only clue left was
// recognising the project names. So the answer lives in the header, which every screen
// draws, and it names the ORIGIN rather than saying "server" — two fleets are two
// origins, and "server" would not tell them apart.
function modeChip() {
  const r = api.resolution();
  const text = r.mode === 'server' ? '\u25cf ' + api.modeLabel()
             : r.mode === 'probing' ? '\u2026 looking for a fleet'
             : '\u26a0 fixtures';
  return el('span', { class: 'mode ' + r.mode, text, title: r.detail });
}

// ── the projects screen ───────────────────────────────────────────────────
function projectsScreen() {
  const out = header(null);
  const list = el('div', { class: 'cards' });
  const projects = S.projects || [];
  projects.forEach((p, i) => {
    const block = G.projectCard(p, i, i === S.sel);
    list.append(cardEl(block, {
      tap: () => openProject(p.name),
      longPress: () => { S.confirm = { kind: 'project', name: p.name }; render(); },
      reorder: d => reorderProject(p.name, d),
    }, i));
  });
  list.append(cardEl(G.addProjectCard(S.sel === projects.length), {
    tap: () => sheetAddProject(),
  }, projects.length));
  out.push(confirmBar(), watchScroll('projects', list));
  out.push(el('div', { class: 'verbs' }, [
    btn('⏎ open', () => openProject((projects[S.sel] || {}).name)),
    // the projects screen schedules a message to THAT project's master
    btn('s schedule', () => { const p = projects[S.sel]; if (p) sheetSchedule('master', p.name); }),
    btn(', settings', () => sheetSettings()),
    btn('x remove', () => { const p = projects[S.sel]; if (p) { S.confirm = { kind: 'project', name: p.name }; render(); } }, 'danger'),
  ]));
  out.push(el('div', { class: 'hint', text: 'tap a project · long-press to remove it from the list · drag its title to reorder' }));
  return out.filter(Boolean);
}
// `Q` / Ctrl-p jumps straight to Projects from anywhere, which is neither forward nor
// back. Unwinding our own entries keeps the stack honest: pushing here would leave the
// gesture retracing grid → session screens you have already left, and leaving the stack
// alone would make the first back-gesture from Projects exit the app.
function toProjects() {
  const n = navDepth;
  S.screen = 'projects'; S.sel = 0; S.session = null; S.sess = null; S.pane = null;
  S.pending = null; stopSpeaking();
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
  const ni = Math.max(0, Math.min(names.length - 1, i + delta));
  if (ni === i) return;
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
function gridScreen() {
  const g = S.grid || { cards: [], free_worktrees: [] };
  // buildItems() clamps `sel` after every rebuild, and so does this: a session that was
  // stopped while you were on another screen leaves the selection past the end, and every
  // verb in the footer then acts on `undefined` — silently, since each one guards.
  S.sel = Math.max(0, Math.min(S.sel, items().length - 1));
  // From the CARDS, as renderGrid does, so the summary cannot disagree with what is
  // under it. §4 ships `counts` as well; if the two ever differ, the cards win —
  // they are what you can see.
  const out = header(G.countsFrom(g.cards || []));
  out.push(confirmBar());
  const list = el('div', { class: 'cards' });
  const its = items();
  its.forEach((it, idx) => {
    const sel = idx === S.sel;
    if (it.newCard) {
      list.append(cardEl(G.newCardLines(sel), { tap: () => sheetPicker() }, idx));
    } else if (it.freeWt) {
      list.append(cardEl(G.freeCardLines(it.freeWt, sel, idx), {
        tap: () => sheetName({ cwd: it.freeWt.path, name: G.basename(it.freeWt.path), reuse: it.freeWt.path }),
        longPress: () => askRemoveWorktree(it.freeWt),
      }, idx));
    } else {
      const c = it.card;
      list.append(cardEl(G.cardLines(c, sel, idx), {
        tap: () => openSession(c.name),
        longPress: () => askKill(c.name),
        swipeLeft: () => pauseSession(c.name),
        swipeRight: () => resumeSession(c.name),
        reorder: d => reorder(c.name, d),
      }, idx));
    }
  });
  out.push(watchScroll('grid', list));
  const it = its[S.sel] || {};
  out.push(el('div', { class: 'verbs' }, [
    btn('⏎ enter', () => { if (it.card) openSession(it.card.name); else if (it.freeWt) sheetName({ cwd: it.freeWt.path, name: G.basename(it.freeWt.path), reuse: it.freeWt.path }); else sheetPicker(); }),
    btn('n new', () => sheetPicker()),
    btn('w worktree', () => sheetWorktree()),
    btn('s sched', () => { if (it.card) sheetSchedule(it.card.name); }),
    btn('p pause', () => { if (it.card) pauseSession(it.card.name); }),
    btn('P resume', () => { if (it.card) resumeSession(it.card.name); }),
    // The footer says which `x` means right now, exactly as the TUI's does, because
    // finding out by pressing it costs a worktree — and on the lead it means nothing at
    // all, which is worth saying before the tap rather than in the toast after it.
    btn(it.freeWt ? 'x remove wt' : it.card?.lead ? 'x — not the lead' : 'x kill',
        () => { if (it.card) askKill(it.card.name); else if (it.freeWt) askRemoveWorktree(it.freeWt); }, 'danger'),
    btn(', settings', () => sheetSettings()),
    btn('Q projects', () => toProjects()),
  ]));
  out.push(el('div', { class: 'hint', text: 'tap a card · swipe ← pause · swipe → resume · long-press = x · drag a card\'s title to reorder' }));
  return out.filter(Boolean);
}

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
function stopSpeaking() {
  if (!canSpeak()) { S.speaking = ''; return; }
  try { speechSynthesis.cancel(); } catch {}
  S.speaking = '';
}
// A TOGGLE, and it is the same button both ways: tapping the one that is speaking stops
// it. Two voices at once is the failure mode of a play button that is really two buttons.
function toggleSpeak(text) {
  if (!canSpeak()) { toast('this browser has no speech synthesis', 'bad'); return; }
  const say = speakable(text);
  if (!say) { toast('nothing to read out in that message', 'bad'); return; }
  const wasSpeaking = S.speaking;
  stopSpeaking();
  if (wasSpeaking === say) { render(); return; }        // tapped the one that was talking
  S.speaking = say;
  try {
    const u = new SpeechSynthesisUtterance(say);
    u.rate = 1.05;
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
      ]),
    ]),
    modeChip(),
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
function chatView(card) {
  const wrap = el('div', { class: 'chat' });
  const s = S.sess;
  if (card && card.status === 'need-you') {
    wrap.append(el('div', { class: 'blocked' }, [
      el('div', { class: 't', text: 'this session is waiting on you — a permission prompt or a question is drawn in its pane, and a transcript cannot show one' }),
      btn('open the pane', () => setView('pane')),
    ]));
  }
  if (!s) { wrap.append(el('div', { class: 'hint', text: 'reading the transcript…' })); return wrap; }
  if (s.note) { wrap.append(el('div', { class: 'hint', text: s.note })); return wrap; }
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
  for (const m of (s.messages || [])) wrap.append(turn(m.role === 'user', m.text, G.clockLabel(m.ts)));
  // Sent, not yet echoed by the transcript. Dimmed rather than absent: a chat where your
  // own message disappears for five seconds reads as a send that failed, and this app's
  // whole job is telling you what is actually happening.
  if (S.pending) wrap.append(turn(true, S.pending.text, 'sending…', true));
  watchScroll('chat', wrap);
  return wrap;
}
function turn(mine, text, when, pending = false) {
  return el('div', { class: 'turn ' + (mine ? 'me' : 'them') }, [
    el('div', { class: 'bub ' + (mine ? 'user' : 'agent') + (pending ? ' pending' : ''), text: String(text || '') }),
    el('div', { class: 'meta', text: when }),
  ]);
}

// ── the composer ────────────────────────────────────────────────────────────
// A text box and a send button, where a chat puts them. It replaces `send a prompt`, which
// opened a full-screen form to type one line — three taps and a screen change for the verb
// this app exists to use most.
//
// It is drawn in the PANE view too, on purpose: watching a worker work and then telling it
// something is one motion, and making you switch views to find the box would be the same
// mistake the sheet was.
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
  box.addEventListener('input', () => {
    S.draft = box.value;
    // Grow with the text, up to the CSS max — a one-line box for a paragraph is the
    // "chat is very small" complaint in miniature.
    try { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 160) + 'px'; } catch {}
  });
  const kids = [box];
  // Read the newest thing the agent said. ONE button, deliberately: a speaker on every
  // bubble is the button wall again, and the newest message is the one you want read out —
  // it is also the one nearest the thumb, at the bottom of the column.
  const last = lastAgentText();
  if (canSpeak() && last) {
    const on = S.speaking === speakable(last);
    kids.push(btn(on ? '■' : '🔊', () => toggleSpeak(last), 'speak' + (on ? ' on' : '')));
  }
  kids.push(btn('send', () => sendDraft(), 'go'));
  return el('div', { class: 'composer' }, kids);
}
function lastAgentText() {
  const ms = (S.sess && S.sess.messages) || [];
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role !== 'user' && String(ms[i].text || '').trim()) return ms[i].text;
  return '';
}
async function sendDraft() {
  const text = String(S.draft || '').trim();
  if (!text) return;
  // Optimistic, and reconciled against the transcript rather than trusted: reconcilePending
  // clears this when the real message comes back, and gives up on it after a while so a
  // failed send cannot sit there looking sent forever.
  S.pending = { text, at: Math.floor(Date.now() / 1000) };
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
function reconcilePending() {
  if (!S.pending) return;
  const want = S.pending.text.trim();
  const ms = (S.sess && S.sess.messages) || [];
  if (ms.some(m => m.role === 'user' && String(m.text || '').trim() === want)) { S.pending = null; return; }
  if (Math.floor(Date.now() / 1000) - S.pending.at > PENDING_TTL) S.pending = null;
}

// ── everything you can DO to a session, in one sheet ────────────────────────
// The ten buttons that used to sit between the card and the conversation. Nothing here is
// new and nothing was dropped — the lead's three refusals are still absent for the reasons
// leadGuard documents, and `stop + reclaim` still takes both of the TUI's confirmations.
function sheetActions() {
  const c = cardOf(S.session);
  const lead = !!(c && c.lead);
  const parked = c && c.status === 'parked';
  const go = (fn) => () => { closeSheet(); fn(); };
  const rows = [
    // The motivating case (§1): a worker blocked on "Allow pnpm test?" since 9pm. That is
    // fleet_answer — keystrokes into a dialog — not a prompt, which would queue behind the
    // block instead of clearing it. It is the first row for that reason.
    btn('answer keys', go(() => sheetAnswer(S.session))),
    lead && !parked ? null
      : btn(parked ? 'P resume' : 'p pause', go(() => (parked ? resumeSession(S.session) : pauseSession(S.session)))),
    btn('s sched', go(() => sheetSchedule(S.session))),
    btn('l label', go(() => sheetLabel(S.session))),
    lead ? null : btn('r rename', go(() => sheetRename(S.session)), 'danger'),
    lead ? null : btn('x kill', go(() => askKill(S.session)), 'danger'),
    // §7 puts stop --reclaim on the phone on purpose, and §12 is why it takes two
    // confirmations: fleet-clean's gates decide whether removal is SAFE, never whether
    // it was intended.
    lead ? null : btn('stop + reclaim worktree', go(() => askReclaim(S.session)), 'danger'),
  ].filter(Boolean);
  openSheet(sheet('actions', S.session, [
    el('div', { class: 'rows' }, rows.map(b => el('div', { class: 'srow' }, [b]))),
    lead ? el('p', { text: "the lead cannot be stopped, reclaimed, renamed or paused — every project needs one, and its checkout is the repo itself" }) : null,
    el('div', { class: 'row' }, [btn('esc back', closeSheet)]),
  ].filter(Boolean)), false);
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
    box.scrollTop = numOf(top);
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
    const m = scrollMem.get(key);
    if (m) { m.top = numOf(box.scrollTop); m.left = numOf(box.scrollLeft); m.wrote = m.top; }
  } catch {}
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

// Set when a newer service worker has taken control and this page is now the stale one.
let swReloadPending = false;
export function takeNewClientIfIdle() {
  if (!swReloadPending) return false;
  if (pollPaused()) return false;          // not while you are typing into it
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
  // Typing counts. refresh() ends in render(), render() empties #app and rebuilds it, so
  // a poll that lands while the composer has focus destroys the element the keyboard is
  // attached to. Reported as "it hides the keyboard every time, I cannot type for more
  // than five seconds" — five being this interval, exactly.
  try { if (composerNode && document.activeElement === composerNode) return true; } catch {}
  return false;
}

// The live composer <textarea>, so the poll can tell whether you are typing in it.
// A node, not a boolean: a flag set by focus/blur goes stale the moment a render
// throws the element away without firing blur, and then the poll never resumes.
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
    if (e instanceof api.AuthError) return lock();
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
  if (S.screen === 'session') { S.screen = 'grid'; S.session = null; S.sess = null; S.pane = null; S.paneErr = ''; S.pending = null; stopSpeaking(); }
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
function cardEl(block, h, idx) {
  const d = el('div', { class: 'card' + (block.selected ? ' sel' : '') + (block.dim ? ' dim' : ''), role: 'button', tabindex: '0' });
  d.style.setProperty('--c', G.COLORS[block.color] || G.COLORS.grey);
  // One block span per line and NO newline between them. The spans are display:block, so
  // they already stack; a literal "\n" inside a <pre> then adds a line box of its own and
  // the card renders double-spaced — the │ and ╰ stop touching and the box comes apart
  // into a column of dashes. It looked like a line-height problem and was not.
  //
  // Inside a line, every non-ASCII code point goes in its own 1ch box (see cells() in
  // grid.js): ⧗ measures 1.27 cells and ⏸ 1.05 in every monospace font on this machine,
  // which is enough to walk a card's right border off the end of its own box.
  const pre = el('pre');
  block.lines.forEach((line, i) => {
    const span = el('span', { class: 'l' + (i === 0 ? ' t' : '') });
    for (const tok of G.cells(line)) {
      // `wide` came in with the pane view: cells() now says when tmux gave a character
      // TWO columns, and the card honours it for the same reason the pane does — one
      // answer to "how many cells is this", not two that can disagree. No card glyph is
      // wide today, so this changes nothing on screen and everything about which of the
      // two files has to be right.
      span.append(tok.cell ? el('i', { class: tok.wide ? 'c w' : 'c', text: tok.text }) : document.createTextNode(tok.text));
    }
    pre.append(span);
  });
  d.append(pre);
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
  let x0 = 0, y0 = 0, t0 = 0, held = false, dragging = false, timer = 0, rowH = 0;
  const clear = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener('pointerdown', ev => {
    if (idx >= 0) { S.sel = idx; markSel(); }
    x0 = ev.clientX; y0 = ev.clientY; t0 = Date.now(); held = false;
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
    if (Math.hypot(dx, dy) > MOVE_SLOP) clear();
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
      if (steps) h.reorder(steps);
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
function confirmBar() {
  const c = S.confirm;
  if (!c) return null;
  if (c.kind === 'kill' || c.kind === 'reclaim-kill') {
    return bar('red', `kill session '${c.name}'?`, 'y = yes · any other key = cancel', [
      btn('y = yes', () => c.kind === 'kill' ? confirmedKill(c.name) : askReclaimWorktree(c.name), 'danger'),
      btn('cancel', cancel),
    ]);
  }
  if (c.kind === 'wt') {
    if (c.busy) return bar('busy', `removing worktree '${G.basename(c.path)}'…`, 'deleting the checkout — this can take a minute on a big one', []);
    if (c.force) return bar('red', c.msg, 'f = remove anyway · any key = cancel', [
      btn('f = remove anyway', () => removeWorktree(c, true), 'danger'),
      btn('cancel', cancel),
    ]);
    return bar('red', `remove worktree '${G.basename(c.path)}' (${c.branch})?`, 'y = yes · any other key = cancel', [
      btn('y = yes', () => removeWorktree(c, false), 'danger'),
      btn('cancel', cancel),
    ]);
  }
  if (c.kind === 'reclaim-wt') {
    return bar('red', `remove worktree '${c.folder}' (${c.branch})?`, 'y = yes · any other key = cancel', [
      btn('y = yes', () => confirmedReclaim(c.name), 'danger'),
      btn('cancel', cancel),
    ]);
  }
  if (c.kind === 'project') {
    return bar('red', `remove '${c.name}' from projects?`, 'y = yes · any other key = cancel', [
      btn('y = yes', () => doVerb('fleet_project_remove', { name: c.name }).then(cancel), 'danger'),
      btn('cancel', cancel),
    ]);
  }
  return null;
}
function bar(cls, q, keys, buttons) {
  return el('div', { class: 'confirm ' + cls }, [
    el('span', { class: 'q', text: ' ' + q }),
    el('span', { class: 'keys', text: '  ' + keys }),
    buttons.length ? el('div', { class: 'row' }, buttons) : null,
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
    if (e instanceof api.AuthError) { lock(); return null; }
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
        try { await pk.open(); S.locked = false; render(); refresh(); }
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

function sheetAddProject() {
  const p = input('', { placeholder: '/Users/you/some-repo' });
  const nm = input('');
  const start = el('input', { type: 'checkbox' });
  const go = async () => {
    const path = (p.value || '').trim();
    if (!path) { toast('a path is required', 'bad'); return; }
    closeSheet();
    await doVerb('fleet_project_add', { path, name: (nm.value || '').trim(), start: start.checked });
  };
  openSheet(sheet('add project', 'the repo, or a folder holding its checkouts', [
    field('path', p), field('name  (default: the folder name)', nm),
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
    const rows = el('div', { class: 'rows' });
    for (const p of S.projects || []) {
      rows.append(el('div', { class: 'srow' }, [
        el('div', { class: 'nm', text: p.name }),
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
  const move = d => { const n = S.sel + d; if (n >= 0 && n < list.length) { S.sel = n; render(); } };
  switch (k) {
    case 'ArrowUp': case 'k': move(-1); break;
    case 'ArrowDown': case 'j': move(1); break;
    // At nc = 1 left/right are the same one-card step up and down the column.
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
  // An orientation change moves the fold, and the pane box was sized against the old one.
  if (paneBoxNode) sizePaneBox(paneBoxNode);
});
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
  if (S.hiddenAt && Date.now() - S.hiddenAt > pk.RELOCK_AFTER_HIDDEN) lock();
  else if (!api.haveToken() && !pk.bypassAllowed()) lock();
  else refresh();
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
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  askShellVersion();
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    swReloadPending = true;
    takeNewClientIfIdle();
  });
}
render();
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


