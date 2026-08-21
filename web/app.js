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

// ── state ─────────────────────────────────────────────────────────────────
const S = {
  screen: 'projects',   // projects | grid | session
  project: null,        // the fleet being looked at
  session: null,        // the card opened on the session screen
  projects: null,       // last /api/projects payload
  grid: null,           // last §4 payload
  sess: null,           // last /api/session payload  { messages, next_before, … }
  sel: 0,               // the TUI's `sel` — which card the verbs act on
  locked: true,
  confirm: null,        // { kind, … } — the TUI's confirm bar, reproduced
  sheet: null,          // { kind, … } — one of the TUI's full-screen forms
  toast: null,
  stale: 0,             // epoch of the payload on screen, when it came from the cache
  hiddenAt: 0,
};
const LS_LAST = 'gf.last';   // last fetched state, for a cold offline open

// ── persistence: something to show before the network answers ─────────────
// "Usable offline enough to show the last fetched state rather than a blank page."
// The service worker caches the files; this caches the ANSWER, so a cold open on a
// train paints the fleet as it was and says when that was.
function save() {
  try {
    localStorage.setItem(LS_LAST, JSON.stringify({
      at: Math.floor(Date.now() / 1000), screen: S.screen, project: S.project,
      projects: S.projects, grid: S.grid,
    }));
  } catch {}
}
function restore() {
  let j; try { j = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); } catch { return; }
  if (!j) return;
  S.projects = j.projects || null; S.grid = j.grid || null;
  S.project = j.project || null; S.screen = j.screen || 'projects';
  S.stale = j.at || 0;
}

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
      // Re-read the tail while it is STILL the first page, so a worker that says
      // something new while you are looking at it shows up. Once "load more" has been
      // pressed, leave the loaded pages alone — refetching would throw away the older
      // messages you deliberately went and got.
      if (!S.sess || S.sess.pages === 1) {
        const fresh = await api.getSession(S.project, S.session);
        S.sess = { ...fresh, pages: 1 };
      }
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
function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  if (S.locked) { app.append(lockScreen()); renderSheet(); return; }
  if (S.screen === 'projects') app.append(...projectsScreen());
  else if (S.screen === 'grid') app.append(...gridScreen());
  else app.append(...sessionScreen());
  if (S.toast) app.append(el('div', { class: 'toast ' + S.toast.kind, text: S.toast.text }));
  renderSheet();
}

// The banner does not fit a phone — bannerFits() wants 76 columns and 26 rows — so the
// phone gets exactly what a narrow terminal gets: the one-line header. Split over two
// rows only because 60 columns of it will not fit in 32, which is the same split the
// TUI itself makes when it draws the ship beside the counts.
function header(counts) {
  const scope = S.screen === 'projects'
    ? el('span', { class: 'scope', text: '— projects' })
    : el('span', { class: 'scope', text: `[${(S.grid && S.grid.profile) || ''}:${S.project || ''}]` });
  const kids = [el('span', { class: 'name', text: 'ghostfleet' }), scope];
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
  out.push(confirmBar(), list);
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
function openProject(name) {
  if (!name) return;
  S.project = name; S.screen = 'grid'; S.sel = 0; S.grid = null;
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
        swipeLeft: () => doVerb('fleet_pause', { project: S.project, session: c.name }),
        swipeRight: () => doVerb('fleet_resume', { project: S.project, session: c.name }),
        reorder: d => reorder(c.name, d),
      }, idx));
    }
  });
  out.push(list);
  const it = its[S.sel] || {};
  out.push(el('div', { class: 'verbs' }, [
    btn('⏎ enter', () => { if (it.card) openSession(it.card.name); else if (it.freeWt) sheetName({ cwd: it.freeWt.path, name: G.basename(it.freeWt.path), reuse: it.freeWt.path }); else sheetPicker(); }),
    btn('n new', () => sheetPicker()),
    btn('w worktree', () => sheetWorktree()),
    btn('s sched', () => { if (it.card) sheetSchedule(it.card.name); }),
    btn('p pause', () => { if (it.card) doVerb('fleet_pause', { project: S.project, session: it.card.name }); }),
    btn('P resume', () => { if (it.card) doVerb('fleet_resume', { project: S.project, session: it.card.name }); }),
    // The footer says which `x` means right now, exactly as the TUI's does, because
    // finding out by pressing it costs a worktree.
    btn(it.freeWt ? 'x remove wt' : 'x kill', () => { if (it.card) askKill(it.card.name); else if (it.freeWt) askRemoveWorktree(it.freeWt); }, 'danger'),
    btn(', settings', () => sheetSettings()),
    btn('Q projects', () => { S.screen = 'projects'; S.sel = 0; render(); refresh(); }),
  ]));
  out.push(el('div', { class: 'hint', text: 'tap a card · swipe ← pause · swipe → resume · long-press = x · drag a card\'s title to reorder' }));
  return out.filter(Boolean);
}

// ⇧hjkl → drag. reorderSession(name, delta) is the TUI's own move, and at nc = 1 all
// four of its keys collapse to ±1 — H/L move one card, K/J move one row, and one row
// IS one card here.
async function reorder(name, delta) {
  const names = ((S.grid && S.grid.cards) || []).map(c => c.name);
  const i = names.indexOf(name);
  if (i < 0 || !delta) return;
  const ni = Math.max(0, Math.min(names.length - 1, i + delta));
  if (ni === i) return;
  names.splice(ni, 0, ...names.splice(i, 1));
  S.sel = ni;
  await doVerb('fleet_order', { project: S.project, order: names }, { quiet: true });
}

// ── the session screen ────────────────────────────────────────────────────
function openSession(name) {
  if (!name) return;
  S.session = name; S.screen = 'session'; S.sess = null;
  render(); refresh();
}
function cardOf(name) { return ((S.grid && S.grid.cards) || []).find(c => c.name === name); }

function sessionScreen() {
  const c = cardOf(S.session);
  const out = header(null);
  out.push(confirmBar());
  if (c) {
    const list = el('div', { class: 'cards' });
    // The same card, not a summary of it: this screen is reached BY the card, and
    // redrawing it differently here would be the second layout §10 refuses.
    list.append(cardEl(G.cardLines(c, false, ((S.grid.cards || []).indexOf(c))), {}, -1));
    out.push(list);
  } else {
    out.push(el('div', { class: 'hint', text: `'${S.session}' is not on this fleet's grid any more.` }));
  }
  const parked = c && c.status === 'parked';
  out.push(el('div', { class: 'verbs' }, [
    btn('send a prompt', () => sheetSend(S.session), 'go'),
    // The motivating case (§1): a worker blocked on "Allow pnpm test?" since 9pm. That
    // is fleet_answer, keystrokes into a dialog — not a prompt, which would queue
    // behind the block instead of clearing it.
    btn('answer keys', () => sheetAnswer(S.session)),
    btn(parked ? 'P resume' : 'p pause', () => doVerb(parked ? 'fleet_resume' : 'fleet_pause', { project: S.project, session: S.session })),
    btn('s sched', () => sheetSchedule(S.session)),
    btn('r rename', () => sheetRename(S.session), 'danger'),
    btn('l label', () => sheetLabel(S.session)),
    btn('x kill', () => askKill(S.session), 'danger'),
    // §7 puts stop --reclaim on the phone on purpose, and §12 is why it takes two
    // confirmations: fleet-clean's gates decide whether removal is SAFE, never whether
    // it was intended.
    btn('stop + reclaim worktree', () => askReclaim(S.session), 'danger'),
    btn('q back', () => back()),
  ]));
  out.push(messages());
  return out.filter(Boolean);
}

// Newest first. The TUI has no equivalent screen to mirror — a session's conversation
// is Remote Control's job (§9) and this is not a chat client — so the choice is made
// for the question the phone is opened to answer: what did this worker just say. The
// page is 20 with an explicit "load more" (§11.3): a bound on bytes over a tunnel, not
// a redaction. What is shown is unredacted.
function messages() {
  const wrap = el('div', { class: 'msgs' });
  const s = S.sess;
  if (!s) { wrap.append(el('div', { class: 'hint', text: 'reading the transcript…' })); return wrap; }
  if (s.note) { wrap.append(el('div', { class: 'hint', text: s.note })); return wrap; }
  const msgs = (s.messages || []).slice().reverse();
  wrap.append(el('div', { class: 'hint', text: `${msgs.length} of ${s.total} messages · newest first · served whole` }));
  for (const m of msgs) {
    wrap.append(el('div', { class: 'msg' }, [
      el('div', { class: 'when', text: `${G.clockLabel(m.ts)} · ${m.role}` }),
      el('div', { class: 'text', text: m.text }),
    ]));
  }
  if (s.next_before) {
    wrap.append(el('div', { class: 'more' }, [
      btn(`load more (${api.PAGE} older)`, async () => {
        try {
          const older = await api.getSession(S.project, S.session, s.next_before);
          S.sess = { ...older, messages: [...(older.messages || []), ...(s.messages || [])],
                     next_before: older.next_before, pages: (s.pages || 1) + 1 };
        } catch (e) { toast(String(e.message || e), 'bad'); }
        render();
      }),
    ]));
  } else if (s.total) {
    wrap.append(el('div', { class: 'hint', text: '— the whole transcript —' }));
  }
  return wrap;
}

function back() {
  if (S.screen === 'session') { S.screen = 'grid'; S.session = null; S.sess = null; }
  else if (S.screen === 'grid') { S.screen = 'projects'; S.sel = 0; }
  render(); refresh();
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
      span.append(tok.cell ? el('i', { class: 'c', text: tok.text }) : document.createTextNode(tok.text));
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

function askKill(name) { if (name) { S.confirm = { kind: 'kill', name }; render(); } }
async function confirmedKill(name) {
  S.confirm = null;
  await doVerb('fleet_stop', { project: S.project, session: name });
  if (S.screen === 'session' && S.session === name) back(); else render();
}
// stop --reclaim removes the worktree too, so it takes BOTH of the TUI's prompts: the
// kill, then the removal. Two deliberate steps for the one verb that can delete work.
function askReclaim(name) { if (name) { S.confirm = { kind: 'reclaim-kill', name }; render(); } }
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
  const server = api.mode() === 'server';
  box.append(el('p', { text: server ? `${api.baseUrl()} — over the tailnet` : 'fixtures — no server configured' }));
  if (!pk.available()) {
    box.append(el('p', { class: 'warn', text: `passkey unavailable: ${pk.unavailableReason()}` }));
  }
  if (!server) {
    // Say plainly what the gate is worth here. §5's rule is that the assertion has to
    // mint a token the SERVER checks; with no server there is nothing to check it, and
    // claiming otherwise would be the "lock screen as decoration" the doc warns about.
    box.append(el('p', { text: 'in fixture mode the passkey gate is local only — the server is what enforces it (§5).' }));
  }
  const row = el('div', { class: 'row' });
  if (pk.available() && !pk.registered()) {
    row.append(btn('register a passkey', async () => {
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
    for (const c of (S.grid && S.grid.cards) || []) {
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
  const base = input(api.baseUrl(), { placeholder: 'http://mac.tailnet.ts.net:8787  (blank = fixtures)' });
  kids.push(el('h2', { text: 'connection' }));
  kids.push(field('fleet-serve URL', base));
  kids.push(el('p', { text: 'blank runs the client against the bundled fixtures. Over the tailnet only — never a public hostname (§5).' }));
  const fx = el('select', {}, api.FIXTURES.map(f => el('option', { value: f.file, text: f.title, selected: f.file === api.fixtureName() })));
  kids.push(field('fixture', fx));
  kids.push(el('div', { class: 'row' }, [
    btn('save', () => {
      api.setBaseUrl(base.value.trim());
      api.setFixtureName(fx.value);
      api.resetOverlay();
      closeSheet();
      lock();     // a different backend is a different session: assert again
    }, 'go'),
  ]));

  kids.push(el('h2', { text: 'passkey' }));
  kids.push(el('p', { text: pk.available() ? (pk.registered() ? 'registered on this device.' : 'not registered yet.') : `unavailable: ${pk.unavailableReason()}` }));
  kids.push(el('div', { class: 'row' }, [
    pk.available() && !pk.registered() ? btn('register', async () => { try { await pk.register(); toast('passkey registered', 'good'); } catch (e) { toast(String(e.message || e), 'bad'); } closeSheet(); }) : null,
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
      case 'Q': S.screen = 'projects'; S.sel = 0; render(); refresh(); break;
      case 'p': doVerb('fleet_pause', { project: S.project, session: S.session }); break;
      case 'P': doVerb('fleet_resume', { project: S.project, session: S.session }); break;
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
    case 'p': if (it.card) doVerb('fleet_pause', { project: S.project, session: it.card.name }); break;
    case 'P': if (it.card) doVerb('fleet_resume', { project: S.project, session: it.card.name }); break;
    case 'x': case 'X':
      if (S.screen === 'projects') { if (it.project) { S.confirm = { kind: 'project', name: it.project.name }; render(); } }
      else if (it.card) askKill(it.card.name);
      else if (it.freeWt) askRemoveWorktree(it.freeWt);
      break;
    case ',': sheetSettings(); break;
    case 'q': case '`': back(); break;
    case 'Q': S.screen = 'projects'; S.sel = 0; render(); refresh(); break;
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
      } else if (e.ctrlKey && (k === 'p' || k === 'P')) { S.screen = 'projects'; S.sel = 0; render(); refresh(); }
      // Ctrl-f is a chord in the terminal because there is no other way to point at a
      // project from inside a session. Here the two screens ARE the chord: projects,
      // then a card.
      else if (e.ctrlKey && (k === 'f' || k === 'F')) { S.screen = 'projects'; S.sel = 0; render(); refresh(); }
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
addEventListener('resize', fitCards);
addEventListener('keydown', onKey);
// §5: a passkey at every open, and again after the app has been backgrounded for a few
// minutes. The token expiring is the same event as far as this is concerned.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { S.hiddenAt = Date.now(); return; }
  if (S.hiddenAt && Date.now() - S.hiddenAt > pk.RELOCK_AFTER_HIDDEN) lock();
  else if (!api.haveToken() && !pk.bypassAllowed()) lock();
  else refresh();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
render();

// Polling, not a socket: `fleet-grid.mjs --plain` answers the busiest fleet in 0.39s
// (§2), so a 5s poll is well inside what the daemon can serve and needs no new
// machinery. Paused while a form or a confirmation is open — a redraw under a
// half-typed prompt is how you lose it.
setInterval(() => {
  if (document.hidden || S.locked || S.sheet || S.confirm) return;
  refresh();
}, 5000);


