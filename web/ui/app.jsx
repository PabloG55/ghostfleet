// web/ui/app.jsx — THE app. The team app (ee/team/web/src/main.jsx) and the phone
// (web/src/phone.jsx) both render <FleetApp>, so there is one route table, one sidebar, one
// assistant and one set of screens, and the two cannot drift apart: a page added here is in both.
//
// What an app brings is only what is its own:
//   the adapter     <FleetProvider adapter> above this, the server behind every screen
//   name, sub       the wordmark and the line under it
//   projects        the app polls them (each server has its own route) and passes them down
//   me              who is talking to the assistant, where an app knows (the team's account)
//   extra           the app's OWN pages: { parse(parts) -> route | null, screens: { view: (route) => vnode },
//                   nav(route, close) }. The team's are sign-in and administration; the phone has none.
//                   test/one-base.test.mjs holds both apps to that list.
//   frame           below, foot, topEnd, banner, class: the frame's slots (shell.jsx)
//   badges          { view: n } beside a nav link (automation notices, waiting sign-ins)
//   canonical       rewrites an old link in place (useHashRoute)
// The pages that come from screens still being built elsewhere draw <Pending> until they land.
import { useState, useEffect } from 'preact/hooks';
import { Frame, NavLink, sharedRoute, useHashRoute } from './shell.jsx';
import { useFleet } from './adapter.jsx';
import { Home } from './home.jsx';
import { ProjectView } from './project.jsx';
import { FleetMap } from './map.jsx';
import { Activity, Settings } from './views.jsx';
import { Assistant, HomeAgent, Launcher } from './assistant.jsx';
import { TaskRail, TaskChip } from './tasks.jsx';
import { bind, unbind, useAgent } from './agent.js';
import { go } from './history.js';
import { Icon } from './icon.jsx';
import { t } from './i18n.js';

// Every page both apps have, in the order the sidebar lists them. `nav` is the link's icon and
// word; `offer` is the adapter member that says the server has it (a server without it hides the
// link — the route still answers, with the page saying so).
export const VIEWS = [
  { view: 'home' }, { view: 'map' }, { view: 'project' },
  { view: 'automations', nav: ['bolt', 'nav.automations'], id: true },
  { view: 'reviews', nav: ['check', 'nav.reviews'], id: true },
  { view: 'stacks', nav: ['branch', 'nav.stacks'], id: true },
  { view: 'queue', nav: ['hourglass', 'nav.queue'] },
  { view: 'held', nav: ['hand', 'nav.held'] },
  { view: 'sign-ins', nav: ['key', 'nav.signIns'] },
  { view: 'search', nav: ['search', 'nav.searchAll'], id: true },
  { view: 'activity', nav: ['list', 'nav.activity'] },
  { view: 'settings' },
];
export const SHARED = VIEWS.map(v => v.view);

// The hash, read once for both apps. Home, the map and a project or session are shell.jsx's
// (the screens link to them); the rest are `#/<view>` with an optional id after it.
export function parseRoute(hash, extra) {
  const shared = sharedRoute(hash);
  if (shared && shared.view !== 'home') return shared;
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const v = VIEWS.find(x => x.view === parts[0] && !['home', 'map', 'project'].includes(x.view));
  if (v) return v.id ? { view: v.view, id: parts[1] || null } : { view: v.view };
  return (parts[0] && extra?.parse?.(parts)) || { view: 'home' };
}

// A page whose screen is still on its way into web/ui: it says what it will be, in the page's
// own layout, rather than an empty column that looks broken.
export function Pending({ view }) {
  return (
    <div class="page narrow">
      <header class="page-head"><div><h1>{t(VIEWS.find(v => v.view === view)?.nav?.[1] || 'nav.home')}</h1></div></header>
      <p class="muted">{t('app.pending')}</p>
    </div>
  );
}
// A page the server behind this app does not have.
export function NotHere({ view }) {
  return (
    <div class="page narrow">
      <header class="page-head"><div><h1>{t(VIEWS.find(v => v.view === view)?.nav?.[1] || 'nav.home')}</h1></div></header>
      <p class="muted">{t('app.notHere')}</p>
    </div>
  );
}

// The screens the route table draws. Filled in as each one lands in web/ui; until then a view is
// drawn by `interim` (the app's copy, on its way here) or <Pending>.
const SCREENS = {
  activity: () => <Activity />,
  settings: () => <Settings />,
  map: (r, p) => <FleetMap projects={p.projects} />,
  project: (r) => <ProjectView key={r.project} project={r.project} session={r.session} tool={r.tool} />,
};

const kept = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const keep = (k, on) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch {} };

export function FleetApp({ name, sub, projects, me, extra, frame = {}, badges = {}, canonical, interim = {} }) {
  const fleet = useFleet();
  const route = useHashRoute((h) => parseRoute(h, extra), canonical);
  const [asOpen, setAsOpen] = useState(() => kept('gfw.asOpen', false));
  const [railOpen, setRailOpen] = useState(() => kept('gfw.rail', typeof innerWidth === 'number' && innerWidth > 900));
  useEffect(() => keep('gfw.rail', railOpen), [railOpen]);
  useEffect(() => keep('gfw.asOpen', asOpen), [asOpen]);
  const S = useAgent();
  const asked = S.tasks.some(x => !x.hidden) || S.deciding.length > 0;
  const rail = asked && railOpen;
  // On the home page the card is the assistant, so neither the panel nor its button is there:
  // a card that talks and a button that opens a second place to talk read as two assistants.
  // Going home closes the panel, and the card goes on with the same conversation (agent.js).
  // The panel is not a page: opening and closing it never adds a history entry.
  const home = route.view === 'home';
  const panel = asOpen && !home;
  useEffect(() => { if (home) setAsOpen(false); }, [home]);
  // The assistant lives above the pages; it needs to know where the person is.
  bind({ go, me, projects: projects || [], route, fleet, app: name });
  useEffect(() => () => unbind(), []);

  const offers = (view) => (fleet.offers ? fleet.offers(view) : true);
  const own = extra?.screens?.[route.view];
  let main;
  if (own) main = own(route);
  else if (home) main = <Home projects={projects}><HomeAgent projects={projects} /></Home>;
  else if (SHARED.includes(route.view) && !offers(route.view)) main = <NotHere view={route.view} />;
  else if (SCREENS[route.view]) main = SCREENS[route.view](route, { projects });
  else if (interim[route.view]) main = interim[route.view](route);
  else main = <Pending view={route.view} />;

  return (
    <Frame name={name} sub={sub} route={route} projects={projects} settings="/settings"
           class={`${frame.class || ''}${panel ? ' with-as' : ''}${rail ? ' with-rail' : ''}`}
           nav={(close) => <>
             {VIEWS.filter(v => v.nav && offers(v.view)).map(v => (
               <NavLink key={v.view} to={`/${v.view}`} active={route.view === v.view} onClick={close}>
                 <Icon name={v.nav[0]} /> {t(v.nav[1])} {badges[v.view] ? <span class="badge warn">{badges[v.view]}</span> : null}
               </NavLink>
             ))}
             {extra?.nav ? extra.nav(route, close) : null}
           </>}
           below={frame.below}
           foot={frame.foot || ((close) => (
             <div class="side-foot">
               <span class="grow" />
               <a href="#/settings" class="icon-btn" title={t('nav.settings')} aria-label={t('nav.settings')} onClick={close}><Icon name="gear" /></a>
             </div>
           ))}
           topEnd={frame.topEnd}
           banner={frame.banner}
           after={<>
             {rail ? <TaskRail projects={projects} onClose={() => setRailOpen(false)} /> : null}
             {panel
               ? <Assistant route={route} projects={projects} onClose={() => setAsOpen(false)} chip={asked && !rail ? <TaskChip onClick={() => setRailOpen(true)} /> : null} />
               : <>{asked && !rail ? <TaskChip floating onClick={() => setRailOpen(true)} /> : null}
                   {home ? null : <Launcher onOpen={() => setAsOpen(true)} />}</>}
           </>}>
      {main}
    </Frame>
  );
}
