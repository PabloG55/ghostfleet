// web/ui/terminal.jsx — a project's Terminal and Editor tabs, the interactive ones: the screen's
// half of the server's terminal contract (ee/team/server/TERMINAL.md).
//
// ONE ENGINE. The terminal itself is web/term.js, the phone client's, over the same vendored
// xterm.js: the same bytes for every key. This file lays it out and gets it a ticket. It is
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
import { useEffect, useRef, useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { sessionTo, projectTo } from './keyboard.jsx';
import { Btn, toast } from './ui.jsx';
import { t } from './i18n.js';

export const TOOL_KINDS = ['term', 'edit'];
const baseTo = (project, session) => (session ? sessionTo(project, session) : projectTo(project));
export const toolTo = (project, session, kind) => `${baseTo(project, session)}/${kind}`;

const offers = (fleet, project) => typeof fleet.canTerm === 'function' && typeof fleet.termOpen === 'function'
  && typeof fleet.termSocket === 'function' && !!fleet.canTerm(project);

// The two tabs, for a tab bar that already exists (the session's). Nothing for a person who
// may not type into the project: a viewer never sees them.
export function ToolTabs({ project, session, tool }) {
  const fleet = useFleet();
  if (!offers(fleet, project)) return null;
  return TOOL_KINDS.map(k => (
    <a key={k} role="tab" class={`tool-tab${tool === k ? ' on' : ''}`} aria-selected={tool === k}
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

// A key or a tap that must not move the focus: the terminal keeps it, and on a phone the
// on-screen keyboard stays up. The press acts on its click.
const keepFocus = (e) => e.preventDefault();

// Away from a tab that is not this person's, to the page it hangs from. REPLACING the entry,
// not adding one: a pushed redirect would put the refused address back under the back button,
// and back would land on it and be sent forward again, every time.
const away = (to) => location.replace(`#${to}`);
function Away({ to }) {
  useEffect(() => { away(to); }, [to]);
  return null;
}

// The open tab: a bar (what it is, and how to leave) and the terminal. Mounted with a key per
// project and kind, so switching tabs is a new terminal and a new ticket. An address typed or
// pasted by someone who may not open it (a viewer) goes to its page instead.
export function ToolPanel(props) {
  const fleet = useFleet();
  if (!offers(fleet, props.project)) return <Away to={baseTo(props.project, props.session)} />;
  return <Panel {...props} />;
}
function Panel({ project, session, kind }) {
  const fleet = useFleet();
  const panel = useRef(null), host = useRef(null);
  const h = useRef(null);
  // What the callbacks term.js holds need to read now, not at the render they were made in.
  const live = useRef({ alive: true });
  const [phase, setPhase] = useState('loading');           // loading → opening → open | closed
  const [focused, setFocused] = useState(false);
  const [tab, setTab] = useState(`_${kind}-${project}`);

  // A ticket asked for and handed to the socket.
  const open = async () => {
    const L = live.current;
    if (!h.current || !L.alive) return;
    setPhase('opening');
    let r;
    try { r = await fleet.termOpen(project, kind, h.current.size()); }
    catch { if (L.alive) setPhase('closed'); return; }
    if (!L.alive || !h.current) return;
    if (r.session) setTab(r.session);
    h.current.connect(r.ticket);
  };
  const onState = ({ state }) => {
    if (!live.current.alive) return;
    setPhase(state === 'open' ? 'open' : state === 'opening' ? 'opening' : 'closed');
  };
  const leave = () => { if (h.current) h.current.blur(); if (panel.current) panel.current.focus({ preventScroll: true }); };
  const enter = () => { if (h.current) h.current.focus(); };

  useEffect(() => {
    const L = live.current;
    L.alive = true;
    (async () => {
      let T;
      try { T = await import('../term.js'); }
      catch { setPhase('closed'); return; }
      if (!L.alive || !host.current) return;
      h.current = T.mount(host.current, {
        socket: fleet.termSocket,
        onState,
        onMessage: (o) => { if (o.t === 'hello' && o.session) setTab(o.session); },
        onLeave: leave,
        onFocus: (up) => { if (L.alive) setFocused(up); },
        onCopy: () => toast(t('term.copied'), 'good'),
        fontSize: 13,
      });
      // The terminal takes the keyboard at once, as the phone client's does.
      h.current.focus();
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
  const ready = phase === 'open';
  return (
    <section class={`tool k-${kind}`} ref={panel} tabIndex={-1} onKeyDown={onKeyDown}
             aria-label={t(`term.tab.${kind}`)}>
      <div class="tool-bar">
        <p class="tool-cap">{t(`term.cap.${kind}`, { project })} <code>{tab}</code>
          {phase === 'opening' || phase === 'loading' ? <span class="tool-st"> · {t('term.opening')}</span> : null}</p>
        <div class="tool-acts">
          <Btn kind="ghost sm tool-leave" disabled={!ready} onPointerDown={keepFocus} onMouseDown={keepFocus}
               onClick={() => (focused ? leave() : enter())}>
            {t(`term.${focused ? 'leave' : 'enter'}.${kind}`)}
            <kbd>{focused ? '⇧Esc' : '⏎'}</kbd>
          </Btn>
        </div>
      </div>
      <div class={`tool-host${ready ? '' : ' off'}`} ref={host} />
    </section>
  );
}
