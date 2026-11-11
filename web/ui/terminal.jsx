// web/ui/terminal.jsx — a project's Terminal and Editor tabs, the interactive ones: the screen's
// half of the server's terminal contract (ee/team/server/TERMINAL.md).
//
// ONE ENGINE. The terminal itself is web/term.js, the phone client's, over the same vendored
// xterm.js: the same bytes for a key, the same key row, the same pinch and the same opening
// font. This file lays it out, gets it a ticket and says what each way of closing means. It is
// imported on demand, so xterm.js is a chunk of its own and nobody who never opens a shell
// downloads it.
//
// PROJECT-LEVEL. The server keeps one shell tab and one editor tab per PROJECT
// (`_term-<project>`, `_edit-<project>`), not one per session, so the Terminal opened from a
// session's page and the one opened from the project's page are the same tab, in the project's
// folder. The caption says so: someone who expects a shell in the session's worktree would
// otherwise type into another folder without being told.
//
// A ROUTE, NOT A STATE. `…/term` and `…/edit` after a project's or a session's address; the
// tabs are links, so back returns to the page before and a link pasted to a teammate opens the
// same tab.
//
// THE KEYBOARD. While the terminal has the focus every key is the terminal's: its input is a
// textarea, and a text box owns the keyboard (keys.js), so Esc, q, ` and the desk's chords reach
// the shell and nvim, not the app. ⇧Esc leaves (term.js isLeaveKey: a terminal cannot tell it
// from Esc, so taking it costs the shell nothing), and so does the button beside the caption;
// either puts the focus on the panel, where ⏎ goes back in.
//
// WHAT AN ADAPTER GIVES IT, every one optional — an app without them shows no tab at all:
//   canTerm(project)                → true when this person may type into the project
//   termOpen(project, kind, size)   → { ticket, session }; throws an Error carrying .status
//   termSocket(ticket)              → the WebSocket for one ticket, binaryType 'arraybuffer'
//   termAccount()                   → who is signed in now ({ mustChange }), null for nobody
//   signIn()                        → the app's sign-in screen
//   changePassword()                → the app's password-change flow
import { useEffect, useRef, useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { sessionTo, projectTo } from './keyboard.jsx';
import { Btn, toast } from './ui.jsx';
import { Icon } from './icon.jsx';
import { t } from './i18n.js';

export const TOOL_KINDS = ['term', 'edit'];
const baseTo = (project, session) => (session ? sessionTo(project, session) : projectTo(project));
export const toolTo = (project, session, kind) => `${baseTo(project, session)}/${kind}`;

// Projects the server answered 404 for, until the page is loaded again: the role the client
// read at sign-in can be older than the grant (an admin took it away since), and the server is
// the one that knows. A tab it refused is hidden rather than offered again.
const refused = new Set();
export const offers = (fleet, project) => typeof fleet.canTerm === 'function' && typeof fleet.termOpen === 'function'
  && typeof fleet.termSocket === 'function' && !refused.has(project) && !!fleet.canTerm(project);

// The two tabs, for a tab bar that already exists (the session's). Nothing for a person who
// may not type into the project: a viewer never sees them.
export function ToolTabs({ project, session, tool }) {
  const fleet = useFleet();
  const on = useRef(null);
  // A phone's bar is narrower than four tabs and scrolls inside itself (terminal.css): the open
  // one is brought into it, or the Editor tab reads as cut in half while it is the one showing.
  useEffect(() => {
    const a = on.current, bar = a && a.parentElement;
    if (!bar) return;
    const x = a.getBoundingClientRect(), y = bar.getBoundingClientRect();
    if (x.right > y.right) bar.scrollLeft += x.right - y.right + 16;
    else if (x.left < y.left) bar.scrollLeft -= y.left - x.left + 16;
  }, [tool]);
  if (!offers(fleet, project)) return null;
  return TOOL_KINDS.map(k => (
    <a key={k} ref={tool === k ? on : null} role="tab" class={`tool-tab${tool === k ? ' on' : ''}`} aria-selected={tool === k}
       href={`#${toolTo(project, session, k)}`}>{t(`term.tab.${k}`)}</a>
  ));
}

// The project page's own bar: its sessions, then the two tabs. None at all for a viewer, whose
// page stays exactly what it was.
export function ProjectTabs({ project, tool }) {
  const fleet = useFleet();
  if (!offers(fleet, project)) return null;
  return (
    <div class="tabs page-tabs" role="tablist">
      <a role="tab" class={tool ? '' : 'on'} aria-selected={!tool} href={`#${projectTo(project)}`}>{t('term.tab.sessions')}</a>
      <ToolTabs project={project} session={null} tool={tool} />
    </div>
  );
}

const FONT_KEY = 'gfw.termFont';
function startFont(T) {
  if (!T.isTouch()) return 13;
  let v = 0;
  try { v = Number(localStorage.getItem(FONT_KEY)) || 0; } catch {}
  return v >= T.FONT_MIN && v <= T.FONT_MAX ? v : T.defaultFont();
}
// A key or a tap that must not move the focus: the terminal keeps it, and on a phone the
// on-screen keyboard stays up. The press acts on its click.
const keepFocus = (e) => e.preventDefault();

// What a closed tab says, and the one thing it offers, in the reader's language. The server's
// own sentence (`n.why`, in English) is shown only where it is the information: which editor to
// install, and what refused the connection. Anywhere else it was term.js's fallback ("the
// connection dropped"), which read as English, lower-case, under a Spanish title.
function Notice({ n, kind, onAgain, fleet }) {
  const title = {
    idle: t('term.idle', { min: n.min }), takeover: t(`term.takeover.${kind}`), failed: t('term.failed'),
    dropped: t('term.dropped'), ended: t(`term.ended.${kind}`), noEditor: t('term.noEditor'),
    password: t('term.password'), signedOut: t('term.signedOut'), refused: t('term.refused'), off: t('term.off'),
  }[n.kind] || t('term.failed');
  const why = { idle: t('term.idleWhy'), takeover: t('term.takeoverWhy'), password: t('term.passwordWhy'),
                signedOut: t('term.signedOutWhy'), failed: t('term.failedWhy'), dropped: t('term.droppedWhy'),
                ended: t('term.endedWhy'), off: t('term.offWhy') }[n.kind] || n.why || '';
  let act = <Btn kind="primary sm" onClick={onAgain}>{t(n.kind === 'idle' || n.kind === 'takeover' ? 'term.reconnect' : 'term.openAgain')}</Btn>;
  if (n.kind === 'password') act = fleet.changePassword ? <Btn kind="primary sm" onClick={() => fleet.changePassword()}>{t('term.changePassword')}</Btn> : null;
  if (n.kind === 'signedOut') act = fleet.signIn ? <Btn kind="primary sm" onClick={() => fleet.signIn()}>{t('term.signIn')}</Btn> : null;
  if (n.kind === 'off') act = <Btn kind="primary sm" onClick={() => fleet.go('/settings')}>{t('term.openSettings')}</Btn>;
  return (
    <div class={`tool-note n-${n.kind}`} role="status">
      <div class="tool-note-text"><b>{title}</b>{why ? <span>{why}</span> : null}</div>
      {act}
    </div>
  );
}

// Away from a tab that is not this person's, to the page it hangs from. REPLACING the entry,
// not adding one: a pushed redirect would put the refused address back under the back button,
// and back would land on it and be sent forward again, every time.
const away = (to) => location.replace(`#${to}`);
function Away({ to }) {
  useEffect(() => { away(to); }, [to]);
  return null;
}

// The open tab: a bar (what it is, how to leave, and on touch the A− A+ and keyboard of the phone
// client), a notice when it is not connected, the terminal, and on touch the key row. Mounted
// with a key per project and kind, so switching tabs is a new terminal and a new ticket. An
// address typed or pasted by someone who may not open it (a viewer) goes to its page instead.
export function ToolPanel(props) {
  const fleet = useFleet();
  if (!offers(fleet, props.project)) return <Away to={baseTo(props.project, props.session)} />;
  return <Panel {...props} />;
}
function Panel({ project, session, kind }) {
  const fleet = useFleet();
  const panel = useRef(null), host = useRef(null), row = useRef(null);
  const h = useRef(null);
  // What the callbacks term.js holds need to read now, not at the render they were made in.
  const live = useRef({ alive: true, hello: false, retried: false, idle: 1800, touch: false });
  const [phase, setPhase] = useState('loading');           // loading → opening → open | closed
  const [notice, setNotice] = useState(null);
  const [focused, setFocused] = useState(false);
  const [touch, setTouch] = useState(false);
  const [tab, setTab] = useState(`_${kind}-${project}`);
  const back = baseTo(project, session);

  const say = (k, why = '') => {
    if (!live.current.alive) return;
    setPhase('closed');
    setNotice({ kind: k, why: String(why || ''), min: Math.round(live.current.idle / 60) });
  };
  // A ticket asked for and handed to the socket. `silent` is the one reopen nobody asked for
  // (below), which must not reset the budget that stops it from becoming a loop.
  const open = async (silent = false) => {
    const L = live.current;
    if (!h.current || !L.alive) return;
    if (!silent) L.retried = false;
    L.hello = false;
    setNotice(null); setPhase('opening');
    let r;
    try { r = await fleet.termOpen(project, kind, h.current.size()); }
    catch (e) { if (L.alive) await denied(e); return; }
    if (!L.alive || !h.current) return;
    if (r.session) setTab(r.session);
    h.current.connect(r.ticket);
  };
  // The POST's refusals (TERMINAL.md "HTTP status"). A 404 is not a notice: the tab goes, and
  // the page it hung from comes back.
  const denied = async (e) => {
    const s = e && e.status;
    if (s === 404) { refused.add(project); away(back); return; }
    if (s === 401) return say('signedOut');
    if (s === 403) {
      // The temporary-password gate answers before the terminal is reached; anything else
      // forbidden here is an origin or a header, which the person cannot fix from this page.
      let who;
      try { who = fleet.termAccount ? await fleet.termAccount() : undefined; } catch {}
      if (who === null) return say('signedOut');
      return say(who && who.mustChange ? 'password' : 'refused', e.message);
    }
    if (s === 502 && kind === 'edit' && /no editor/i.test(e.message || '')) return say('noEditor', e.message);
    return say('failed', (e && e.message) || '');
  };
  const onState = ({ state, why, code }) => {
    const L = live.current;
    if (!L.alive) return;
    if (state === 'opening') return setPhase('opening');
    if (state === 'open') { L.retried = false; setNotice(null); setPhase('open'); return; }
    // Refused BEFORE hello. A browser is not shown why an upgrade failed, and the likeliest
    // cause is a ticket that expired between the POST and the socket (30 s): ONE silent reopen,
    // with a new ticket, and then the failure says so. Never a loop.
    if (!L.hello) {
      if (!L.retried) { L.retried = true; open(true); return; }
      return say('failed', why);
    }
    if (code === 4000) return say('idle');
    if (code === 4001) return say('takeover');
    // The sign-in, the password rule or the grant changed under an open tab: asking again
    // lands on whichever of those it was (a 401, a 403 or a 404 above), or opens it again.
    if (code === 4003 && !L.retried) { L.retried = true; open(true); return; }
    if (code === 1000) return say('ended', why);
    return say('dropped', why);
  };
  const leave = () => { if (h.current) h.current.blur(); if (panel.current) panel.current.focus({ preventScroll: true }); };
  const enter = () => { if (h.current) h.current.focus(); };

  useEffect(() => {
    const L = live.current;
    L.alive = true;
    (async () => {
      let T;
      try { T = await import('../term.js'); }
      catch (e) { say('failed', e && e.message); return; }
      if (!L.alive || !host.current) return;
      L.touch = T.isTouch();
      setTouch(L.touch);
      h.current = T.mount(host.current, {
        socket: fleet.termSocket,
        onState,
        onMessage: (o) => { if (o.t === 'hello') { L.hello = true; if (o.idle > 0) L.idle = o.idle; if (o.session) setTab(o.session); } },
        onLeave: leave,
        onFocus: (up) => { if (L.alive) setFocused(up); },
        onCopy: () => toast(t('term.copied'), 'good'),
        fontSize: startFont(T),
        onFont: (px) => { if (L.touch) try { localStorage.setItem(FONT_KEY, String(px)); } catch {} },
      });
      if (L.touch && row.current && !row.current.firstChild) T.keyRow(row.current, () => h.current);
      // At a desk the terminal takes the keyboard at once, as the phone client's does. On a
      // phone the keyboard waits for its button: raised by itself it would cover half the screen.
      if (!L.touch) h.current.focus();
      open();
    })();
    return () => { L.alive = false; const x = h.current; h.current = null; if (x) try { x.dispose(); } catch {} };
  }, []);

  // On the panel itself (after leaving), ⏎ goes back in. Keys inside the terminal are not
  // this element's: they are the terminal's.
  const onKeyDown = (e) => {
    if (e.target !== panel.current) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
      e.preventDefault(); e.stopPropagation(); enter();
    }
  };
  const tool = (label, aria, act, cls = '') => (
    <button type="button" class={`btn ghost tt${cls}`} aria-label={aria} title={aria}
            onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => h.current && act(h.current)}>{label}</button>
  );
  const ready = phase === 'open';
  return (
    <section class={`tool k-${kind}${touch ? ' touch' : ''}`} ref={panel} tabIndex={-1} onKeyDown={onKeyDown}
             aria-label={t(`term.tab.${kind}`)}>
      <div class="tool-bar">
        <p class="tool-cap">{t(`term.cap.${kind}`, { project })} <code>{tab}</code>
          {phase === 'opening' || phase === 'loading' ? <span class="tool-st"> · {t('term.opening')}</span> : null}</p>
        <div class="tool-acts">
          {touch ? (
            <span class="tool-tools">
              {tool('A−', t('term.smaller'), (x) => x.zoom(-1))}
              {tool('A+', t('term.larger'), (x) => x.zoom(1))}
              {tool(<Icon name="keyboard" size={24} />, t('term.keyboard'), (x) => x.keyboard(), ` kbd${focused ? ' on' : ''}`)}
            </span>
          ) : null}
          <Btn kind="ghost sm tool-leave" disabled={!ready} onPointerDown={keepFocus} onMouseDown={keepFocus}
               onClick={() => (focused ? leave() : enter())}>
            {t(`term.${focused ? 'leave' : 'enter'}.${kind}`)}
            {touch ? null : <kbd>{focused ? '⇧Esc' : '⏎'}</kbd>}
          </Btn>
        </div>
      </div>
      {notice ? <Notice n={notice} kind={kind} fleet={fleet} onAgain={() => { open(); if (!live.current.touch) enter(); }} /> : null}
      <div class={`tool-host${ready ? '' : ' off'}`} ref={host} />
      <div class="tool-keys" ref={row} hidden={!touch} />
    </section>
  );
}
