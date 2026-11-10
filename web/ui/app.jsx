// web/ui/app.jsx — THE app. The team app (ee/team/web/src/main.jsx) and the phone
// (web/src/phone.jsx) both render <FleetApp>, so there is one route table, one sidebar, one
// assistant and one set of screens, and the two cannot drift apart: a page added here is in both.
//
// What an app brings is only what is its own:
//   the adapter     <FleetProvider adapter> above this, the server behind every screen
//   name, sub       the wordmark and the line under it
//   projects        the app polls them (each server has its own route) and passes them down
//   me              who is talking to the assistant, where an app knows (the team's account)
//   hosts           the machines the projects come from, when there are several (the phone's pairs)
//   extra           the app's OWN pages: { parse(parts) -> route | null, screens: { view: (route) => vnode },
//                   nav(route, close) }. The team's are sign-in and administration; the phone has none.
//                   test/one-base.test.mjs holds both apps to that list.
//   frame           below, foot, topEnd, banner, class: the frame's slots (shell.jsx)
//   badges          { view: n } beside a nav link (automation notices, waiting sign-ins)
//   canonical       rewrites an old link in place (useHashRoute)
// Every view in VIEWS has its screen in SCREENS. There is no per-app copy and no placeholder,
// so a page cannot be in one app and missing from the other.
import { useState, useEffect } from 'preact/hooks';
import './viewport.js'; // the on-screen keyboard: the app follows the visible area while it is up
import { Frame, NavLink, sharedRoute, useHashRoute } from './shell.jsx';
import { useFleet } from './adapter.jsx';
import { Home } from './home.jsx';
import { ProjectView } from './project.jsx';
import { FleetMap } from './map.jsx';
import { Activity, Settings } from './views.jsx';
import { Automations } from './automations.jsx';
import { Reviews, Review } from './reviews.jsx';
import { StackPicker, StackView } from './stacks.jsx';
import { Queue } from './queue.jsx';
import { Held } from './held.jsx';
import { SignIns } from './sign-ins.jsx';
import { Search } from './search.jsx';
import { Assistant, HomeAgent, Launcher } from './assistant.jsx';
import { AccountsLine } from './accounts.jsx';
import { TaskRail, TaskChip } from './tasks.jsx';
import { bind, unbind, useAgent } from './agent.js';
import { go } from './history.js';
import { Icon } from './icon.jsx';
import { t } from './i18n.js';

// Every page both apps have, in the order the sidebar lists them. `nav` is the link's icon and
// word, and the word is the page's place name (phone-places.js), so the link and the back link that
// returns to it say the same thing. `offer` is the adapter member that says the server has it (a
// server without it hides the link; the route still answers, with the page saying so). `under`
// names the link that stays lit while a page with no link of its own is open: a stack is opened
// from the picker, a held item from the queue.
export const VIEWS = [
  { view: 'home' }, { view: 'map' }, { view: 'project' },
  { view: 'automations', nav: ['bolt', 'phone.nav.automations'] },
  { view: 'reviews', nav: ['check', 'phone.reviews'] },
  { view: 'stack-picker', nav: ['branch', 'phone.stackPlace'] },
  { view: 'stack', under: 'stack-picker' },
  { view: 'queue', nav: ['hourglass', 'phone.queue'] },
  { view: 'held', under: 'queue' },
  { view: 'sign-ins', nav: ['key', 'phone.signIns'] },
  { view: 'search', nav: ['search', 'phone.search'] },
  { view: 'activity', nav: ['list', 'nav.activity'] },
  { view: 'settings' },
];
export const SHARED = VIEWS.map(v => v.view);

const decode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
// The hash, read once for both apps. Home, the map and a project or session are shell.jsx's
// (the screens link to them). The rest are `#/<view>` with the path after it in `rest` (a review is
// three segments, a held item two), and a query in `q`: search keeps what was typed in its
// address, `#/search?q=…`, so a reload or a link opens the same search.
export function parseRoute(hash, extra) {
  const shared = sharedRoute(hash);
  if (shared && shared.view !== 'home') return shared;
  const [path, query = ''] = String(hash).split('?');
  const parts = path.replace(/^#\/?/, '').split('/').map(decode);
  const v = VIEWS.find(x => x.view === parts[0] && !['home', 'map', 'project'].includes(x.view));
  if (v) {
    let q = '';
    try { q = new URLSearchParams(query).get('q') || ''; } catch {}
    return { view: v.view, id: parts[1] || null, rest: parts.slice(1).filter(Boolean), q };
  }
  return (parts[0] && extra?.parse?.(parts)) || { view: 'home' };
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

// A stack's members ride in its address as JSON (stacks.jsx), so the address is untrusted input:
// anything that is not a list of { project, session } strings is an empty stack, never a throw.
export function stackMembers(id) {
  let v;
  try { v = JSON.parse(id || '[]'); } catch { return []; }
  return Array.isArray(v) ? v.filter(m => m && typeof m.project === 'string' && typeof m.session === 'string')
    .map(m => ({ project: m.project, session: m.session })) : [];
}

// The screens the route table draws, one for every view above but home (drawn below, with the
// assistant's card in it). test/one-base.test.mjs fails when a view has no screen here.
export const SCREENS = {
  map: (r, p) => <FleetMap projects={p.projects} />,
  project: (r) => <ProjectView key={r.project} project={r.project} session={r.session} tool={r.tool} />,
  automations: (r, p) => <Automations key={r.id || 'list'} projects={p.projects} id={r.id} />,
  // #/reviews/<host>/<profile>/<run>: `-` is "this machine" (reviews.jsx reviewRoute).
  reviews: (r) => (r.rest.length >= 3
    ? <Review key={r.rest.join('/')} host={r.rest[0] === '-' ? '' : r.rest[0]} profile={r.rest[1]} run={r.rest[2]} />
    : <Reviews />),
  'stack-picker': () => <StackPicker />,
  stack: (r) => <StackView key={r.id} members={stackMembers(r.id)} />,
  queue: () => <Queue />,
  held: (r) => <Held project={r.rest[0] || null} id={r.rest[1] || null} />,
  'sign-ins': () => <SignIns />,
  search: (r) => <Search query={r.q} />,
  activity: () => <Activity />,
  settings: () => <Settings />,
};

const kept = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const keep = (k, on) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch {} };

export function FleetApp({ name, sub, projects, hosts, me, extra, frame = {}, badges = {}, canonical }) {
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
  else if (home) main = <Home projects={projects}><AccountsLine /><HomeAgent projects={projects} /></Home>;
  else if (SHARED.includes(route.view) && !offers(route.view)) main = <NotHere view={route.view} />;
  else main = SCREENS[route.view](route, { projects });

  return (
    <Frame name={name} sub={sub} route={route} projects={projects} hosts={hosts} settings="/settings"
           class={`${frame.class || ''}${panel ? ' with-as' : ''}${rail ? ' with-rail' : ''}`}
           nav={(close) => <>
             {VIEWS.filter(v => v.nav && offers(v.view)).map(v => (
               <NavLink key={v.view} to={`/${v.view}`} active={route.view === v.view || VIEWS.find(x => x.view === route.view)?.under === v.view} onClick={close}>
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
