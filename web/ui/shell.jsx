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
import { Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Logo, Toasts } from './ui.jsx';
import { Led } from './fleet.jsx';
import { topLight } from './lights.js';
import { Icon } from './icon.jsx';
import { t } from './i18n.js';
import { DeskKeys } from './keyboard.jsx';
import { startHistory, arrive, go } from './history.js';

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

// The route as a value that follows the hash. `canonical` may rewrite an old link in place,
// keeping the entry's stamp (history.js): it is the same entry, under its new name.
// history.js hears of the change first, so the screen that mounts reads its own entry.
export function useHashRoute(parse, canonical = (h) => h) {
  const read = () => {
    const h = canonical(location.hash || '#/');
    if (location.hash && h !== location.hash) history.replaceState(history.state, '', h);
    startHistory();
    return parse(h);
  };
  const [r, setR] = useState(read);
  useEffect(() => { const f = () => { const v = read(); arrive(); setR(v); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

export const needOf = (projects) => (projects || []).reduce((n, p) => n + p.counts.need_you, 0);

export function NavLink({ to, active, onClick, children }) {
  return <a href={`#${to}`} class={`nav${active ? ' on' : ''}`} onClick={onClick}>{children}</a>;
}

// The project search answers the desk's `/` keys too: ⏎ opens the first project it shows and
// Esc clears it and gives the keyboard back to the page.
// `hosts` is the machines an app's projects come from, when there is more than one (the phone's
// paired machines: fleet-serve /api/projects `hosts`, each project carrying its `host_key`). The
// list is then one group per machine, this one first, and a machine that is not answering keeps
// its heading with no projects under it — "it is down" is something to see, not an absence.
export const hostGroups = (list, hosts) => (hosts && hosts.length > 1
  ? hosts.map(h => ({ h, items: list.filter(p => (p.host_key || '') === (h.self ? '' : h.key)) }))
  : [{ h: null, items: list }]);
const hostDown = (h) => !h.self && h.online === false;
// ...and within a machine, one group per PROFILE when the projects span more than one (the
// desk's Projects tabs: work, personal, a profile somebody added). In the order the projects file
// first names them, and a project with no profile is in `work`, where the desk puts it. One
// profile, which is every team, draws no headings at all.
const profOf = (p) => p.profile || 'work';
export const profileGroups = (items, order = []) => {
  const names = [...new Set([...order, ...items.map(profOf)])].filter(n => items.some(p => profOf(p) === n));
  return names.length > 1 ? names.map(n => ({ n, items: items.filter(p => profOf(p) === n) })) : [{ n: null, items }];
};

export function Sidebar({ name, sub, route, projects, hosts, open, onClose, nav, below, foot }) {
  const [q, setQ] = useState('');
  const list = (projects || [])
    .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.counts.need_you - a.counts.need_you) || (b.counts.total - a.counts.total) || a.name.localeCompare(b.name));
  const groups = hostGroups(list, hosts);
  const profOrder = (projects || []).map(profOf);
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
                 else if (e.key === 'Enter' && list[0]) { e.preventDefault(); go(`/p/${encodeURIComponent(list[0].name)}`); e.currentTarget.blur(); if (open) onClose(); }
               }} />
      </div>
      <div class="side-list">
        {projects == null ? <p class="muted pad">{t('common.loading')}</p> : null}
        {groups.map(({ h, items }) => (
          <Fragment key={h ? `h:${h.key}` : 'all'}>
            {h ? (
              <div class={`side-host${hostDown(h) ? ' down' : ''}`}>
                <Led state={hostDown(h) ? 'off' : 'idle'} size={8} />
                <span class="grow ellipsis">{h.label || h.key}</span>
                {hostDown(h) ? <small>{t('settings.hostOffline')}</small> : h.self ? <small>{t('settings.hostThis')}</small> : null}
              </div>
            ) : null}
            {profileGroups(items, profOrder).map(({ n, items: mine }) => (
              <Fragment key={n || 'one'}>
                {n ? (
                  <div class="side-prof">
                    <span class="grow ellipsis">{n}</span>
                    {needOf(mine) ? <span class="badge need">{needOf(mine)}</span> : null}
                  </div>
                ) : null}
                {mine.map(p => (
                  <NavLink key={p.name} to={`/p/${encodeURIComponent(p.name)}`} active={route.view === 'project' && route.project === p.name} onClick={onClose}>
                    <Led state={topLight(p.sessions.map(x => x.status))} size={8} />
                    <span class="grow ellipsis">{h ? p.name.replace(/@[^@]+$/, '') : p.name}</span>
                    {p.counts.need_you ? <span class="badge need">{p.counts.need_you}</span> : p.counts.total ? <span class="n">{p.counts.total}</span> : null}
                  </NavLink>
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </div>
      {below}
      {foot ? foot(onClose) : null}
    </nav>
  );
}

export function Frame({ name, sub, title = name, route, projects, hosts, nav, below, foot, topEnd, banner, after, settings, class: extra = '', children }) {
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
      <Sidebar name={name} sub={sub} route={route} projects={projects} hosts={hosts} open={menu} onClose={close} nav={nav} below={below} foot={foot} />
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
