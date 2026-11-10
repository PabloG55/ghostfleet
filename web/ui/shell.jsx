// web/ui/shell.jsx — the frame every page sits in: the top bar a phone sees, the sidebar a desk
// sees (a drawer on a phone), the fleet's projects in it, and the tab title.
//
// What is the app's own comes in through props, so the frame never learns who is signed in:
//   name, sub     the wordmark and the line under it in the sidebar
//   title         the browser tab's name; "(3) <title>" while three sessions need someone
//   nav(close)    links after Home and Map, drawn with <NavLink>
//   below, foot(close)  under the project list, and the sidebar's last row
//   topEnd(open)  the right end of the phone's top bar, before the needs-you badge
//   banner        above the page, inside .main
//   after         after .main: panels and launchers that float over the page
//   class         extra classes on .app
//   settings      the route `,` opens, the desk's settings key (keyboard.jsx); none, no key
// `close` shuts the phone's drawer (a link inside it has been followed); `open` opens it.
// The frame also mounts the keyboard (keyboard.jsx), so every page has the desk's keys.
import { useState, useEffect } from 'preact/hooks';
import { Logo, Toasts } from './ui.jsx';
import { Led } from './fleet.jsx';
import { topLight } from './lights.js';
import { Icon } from './icon.jsx';
import { t } from './i18n.js';
import { DeskKeys } from './keyboard.jsx';

// The routes the shared screens link to. An app adds its own views beside them. `tool` is a
// project's Terminal or Editor tab (terminal.jsx), after the project's or a session's address.
export function sharedRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) {
    const session = parts[2] === 's' ? parts[3] : null, tool = parts[session ? 4 : 2];
    return { view: 'project', project: parts[1], session, tool: tool === 'term' || tool === 'edit' ? tool : null };
  }
  if (parts[0] === 'map') return { view: 'map' };
  if (!parts[0]) return { view: 'home' };
  return null;
}

// The route as a value that follows the hash. `canonical` may rewrite an old link in place.
export function useHashRoute(parse, canonical = (h) => h) {
  const read = () => {
    const h = canonical(location.hash || '#/');
    if (location.hash && h !== location.hash) history.replaceState(null, '', h);
    return parse(h);
  };
  const [r, setR] = useState(read);
  useEffect(() => { const f = () => setR(read()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

export const needOf = (projects) => (projects || []).reduce((n, p) => n + p.counts.need_you, 0);

export function NavLink({ to, active, onClick, children }) {
  return <a href={`#${to}`} class={`nav${active ? ' on' : ''}`} onClick={onClick}>{children}</a>;
}

// The project search answers the desk's `/` keys too: ⏎ opens the first project it shows and
// Esc clears it and gives the keyboard back to the page.
export function Sidebar({ name, sub, route, projects, open, onClose, nav, below, foot }) {
  const [q, setQ] = useState('');
  const list = (projects || [])
    .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.counts.need_you - a.counts.need_you) || (b.counts.total - a.counts.total) || a.name.localeCompare(b.name));
  const need = needOf(projects);
  return (
    <nav class={`side${open ? ' open' : ''}`} aria-label={t('nav.label')}>
      <div class="brand"><Logo /><div><b>{name}</b><small>{sub}</small></div></div>
      <NavLink to="/" active={route.view === 'home'} onClick={onClose}><Icon name="home" /> {t('nav.home')} {need ? <span class="badge need">{need}</span> : null}</NavLink>
      <NavLink to="/map" active={route.view === 'map'} onClick={onClose}><Icon name="map" /> {t('nav.map')}</NavLink>
      {nav ? nav(onClose) : null}
      <div class="side-sec">
        <span>{t('nav.projects')}</span>
        <input class="search" placeholder={t('nav.search')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('nav.searchProject')}
               onKeyDown={(e) => {
                 if (e.isComposing || e.keyCode === 229) return;
                 if (e.key === 'Escape') { e.preventDefault(); setQ(''); e.currentTarget.blur(); if (open) onClose(); }
                 else if (e.key === 'Enter' && list[0]) { e.preventDefault(); location.hash = `#/p/${encodeURIComponent(list[0].name)}`; e.currentTarget.blur(); if (open) onClose(); }
               }} />
      </div>
      <div class="side-list">
        {projects == null ? <p class="muted pad">{t('common.loading')}</p> : null}
        {list.map(p => (
          <NavLink key={p.name} to={`/p/${encodeURIComponent(p.name)}`} active={route.view === 'project' && route.project === p.name} onClick={onClose}>
            <Led state={topLight(p.sessions.map(x => x.status))} size={8} />
            <span class="grow ellipsis">{p.name}</span>
            {p.counts.need_you ? <span class="badge need">{p.counts.need_you}</span> : p.counts.total ? <span class="n">{p.counts.total}</span> : null}
          </NavLink>
        ))}
      </div>
      {below}
      {foot ? foot(onClose) : null}
    </nav>
  );
}

export function Frame({ name, sub, title = name, route, projects, nav, below, foot, topEnd, banner, after, settings, class: extra = '', children }) {
  const [menu, setMenu] = useState(false);
  const need = needOf(projects);
  useEffect(() => { document.title = need ? `(${need}) ${title}` : title; }, [need, title]);
  const close = () => setMenu(false), open = () => setMenu(true);
  return (
    <div class={`app${extra}`}>
      <div class="topbar">
        <button class="icon-btn" aria-label={t('nav.menu')} onClick={open}><Icon name="menu" /></button>
        <div class="brand"><Logo size={22} /><b>{name}</b></div>
        <span class="topbar-end">{topEnd ? topEnd(open) : null}{need ? <a class="badge need" href="#/">{need}</a> : null}</span>
      </div>
      {menu ? <div class="side-scrim" onClick={close} /> : null}
      <Sidebar name={name} sub={sub} route={route} projects={projects} open={menu} onClose={close} nav={nav} below={below} foot={foot} />
      <main class="main">
        {banner}
        {children}
      </main>
      {after}
      <DeskKeys route={route} projects={projects} settings={settings} openMenu={open} />
      <Toasts />
    </div>
  );
}
