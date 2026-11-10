import { render } from 'preact';
import { t, lang, setLang, useLang } from './i18n.js';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { api } from './api.js';
import { Setup, Login, ChangePassword } from './auth.jsx';
import { Admin } from './admin/index.jsx';
import { Activity, Settings } from './views.jsx';
import { Avatar } from './avatar.jsx';
import { UsageMeter, UsageChips, seesUsage } from './usage.jsx';
import { Assistant, HomeAgent, VoiceBar } from './assistant.jsx';
import { bind, unbind, useAgent } from './agent.js';
import { TaskRail, TaskChip } from './tasks.jsx';
import { Automations, noticesSeen } from './automations.jsx';
import { teamAdapter } from './adapter.js';
// The shared screens, from the MIT core (web/ui/README.md); everything else here is the team app's.
import { FleetProvider } from '../../../../web/ui/adapter.jsx';
import { Frame, NavLink, sharedRoute, useHashRoute } from '../../../../web/ui/shell.jsx';
import { Home } from '../../../../web/ui/home.jsx';
import { ProjectView } from '../../../../web/ui/project.jsx';
import { FleetMap } from '../../../../web/ui/map.jsx';
import { GhostShip } from '../../../../web/ui/fleet.jsx';
import { Logo, Toasts, usePoll, toast } from '../../../../web/ui/ui.jsx';
import { Icon } from '../../../../web/ui/icon.jsx';
// Shared rules first at each layer, the app's own after them: see web/ui/ui.css.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/silkscreen/400.css';
import '../../../../brand/tokens.css';
import '../../../../web/ui/ui.css';
import './styles.css';
import '../../../../web/ui/skin.css';
import './skin.css';
// A project's Terminal and Editor tabs (web/ui/terminal.jsx): xterm's own rules, then the panel's.
import '../../../../web/xterm.css';
import '../../../../web/ui/terminal.css';

// The tab's name, and the wordmark's.
const NAME = 'ghostfleet team';

// Hash routes, so the back button works and a link pasted to a teammate opens the same view.
// The routes used to be in Spanish; a link saved from then is rewritten to its English name.
const OLD = { actividad: 'activity', mapa: 'map', automatizaciones: 'automations', ajustes: 'settings' };
const OLD_ADMIN = { usuarios: 'users', ia: 'ai', uso: 'usage' };
export function canonical(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (OLD[parts[0]]) parts[0] = OLD[parts[0]];
  if (parts[0] === 'admin' && OLD_ADMIN[parts[1]]) parts[1] = OLD_ADMIN[parts[1]];
  if (parts[0] === 'automations' && parts[1]) parts[1] = parts[1].replace(/^nueva$/, 'new').replace(/^plantilla-/, 'template-');
  return '#/' + parts.join('/');
}
// Home, the map and a project or session are the shared screens' routes (web/ui/shell.jsx).
function parse(hash) {
  const shared = sharedRoute(hash);
  if (shared) return shared;
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'activity') return { view: 'activity' };
  if (parts[0] === 'automations') return { view: 'autos', id: parts[1] || null };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'admin') return { view: 'admin', section: parts[1] || null };
  return { view: 'home' };
}

function Shell({ me, mode, onLogout, onAccount }) {
  const admin = me.role === 'admin';
  const route = useHashRoute(parse, canonical);
  const [users, setUsers] = useState([me]);
  const [asOpen, setAsOpen] = useState(() => { try { return localStorage.getItem('gfw.asOpen') === '1'; } catch { return false; } });
  const [railOpen, setRailOpen] = useState(() => { try { return (localStorage.getItem('gfw.rail') ?? (innerWidth > 900 ? '1' : '0')) === '1'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('gfw.rail', railOpen ? '1' : '0'); } catch {} }, [railOpen]);
  const S = useAgent();
  const asked = S.tasks.some(t => !t.hidden) || S.deciding.length > 0;
  const rail = asked && railOpen;
  useEffect(() => { try { localStorage.setItem('gfw.asOpen', asOpen ? '1' : '0'); } catch {} }, [asOpen]);
  const loadUsers = useCallback(() => api.users().then(r => setUsers(r.users)).catch(() => {}), []);
  useEffect(() => { loadUsers(); }, []);
  const { data: pj } = usePoll(() => api.projects(), 4000, []);
  const quotas = seesUsage(me);
  const { data: usage } = usePoll(() => (quotas ? api.usage() : Promise.resolve(null)), 15000, [quotas]);
  // Automation notices (a run that failed or was skipped) reach whoever is on any page.
  const { data: autos } = usePoll(() => api.automations(), 20000, []);
  const fresh = (autos?.notices || []).filter(n => n.at > noticesSeen());
  const told = useRef(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const news = fresh.filter(n => n.at > told.current);
    if (!news.length) return;
    told.current = Math.max(...news.map(n => n.at));
    for (const n of news.slice(0, 3)) toast(n.text, n.kind === 'bad' ? 'bad' : '', 'bolt');
  }, [autos]);
  const usersById = useMemo(() => Object.fromEntries(users.map(u => [u.id, u])), [users]);
  const ctx = {
    me, mode, users, usersById, admin,
    go: (to) => { location.hash = to; },
    logout: async () => { unbind(); try { await api.logout(); } catch {} onLogout(); },
    // The sign-in ended under the page, or the account still has a temporary password: the
    // same two screens App shows at load, reached from wherever the person is.
    signIn: () => { unbind(); onLogout(); },
    changePassword: () => onAccount({ ...me, mustChange: true }),
  };
  // The assistant lives above the pages; it needs to know where the person is.
  bind({ go: ctx.go, me, projects: pj?.projects || [], route });
  const fleet = useMemo(() => teamAdapter(ctx), [users]);
  const projects = pj?.projects ?? null;
  const notices = fresh.length;

  let main;
  if (route.view === 'project') main = <ProjectView key={route.project} project={route.project} session={route.session} tool={route.tool} />;
  else if (route.view === 'activity') main = <Activity ctx={ctx} />;
  else if (route.view === 'autos') main = <Automations key={route.id || 'list'} ctx={ctx} projects={projects} id={route.id} />;
  else if (route.view === 'map') main = <FleetMap projects={projects} />;
  else if (route.view === 'settings') main = <Settings ctx={ctx} />;
  else if (route.view === 'admin') main = <Admin ctx={ctx} section={route.section} />;
  else main = <Home projects={projects}><HomeAgent ctx={ctx} projects={projects} /></Home>;

  return (
    <FleetProvider adapter={fleet}>
      <Frame name={NAME} sub={mode === 'demo' ? t('nav.demo') : t('nav.fleet')} route={route} projects={projects} settings="/settings"
             class={`${mode === 'demo' ? ' is-demo' : ''}${asOpen ? ' with-as' : ''}${rail ? ' with-rail' : ''}`}
             nav={(close) => <>
               <NavLink to="/automations" active={route.view === 'autos'} onClick={close}><Icon name="bolt" /> {t('nav.automations')} {notices ? <span class="badge warn" title={t('nav.unseen')}>{notices}</span> : null}</NavLink>
               <NavLink to="/activity" active={route.view === 'activity'} onClick={close}><Icon name="list" /> {t('nav.activity')}</NavLink>
               {admin ? <NavLink to="/admin" active={route.view === 'admin'} onClick={close}><Icon name="key" /> {t('nav.admin')}</NavLink> : null}
             </>}
             below={quotas ? <UsageMeter data={usage} /> : null}
             foot={(close) => (
               <div class="side-foot">
                 <Avatar user={me} size={28} />
                 <span class="grow ellipsis">{me.name}</span>
                 <a href="#/settings" class="icon-btn" title={t('nav.settings')} aria-label={t('nav.settings')} onClick={close}><Icon name="gear" /></a>
                 <button class="icon-btn" title={t('nav.logout')} aria-label={t('nav.logout')} onClick={ctx.logout}><Icon name="logout" /></button>
               </div>
             )}
             topEnd={quotas ? (open) => <UsageChips data={usage} onClick={open} /> : undefined}
             banner={mode === 'demo' ? <div class="demo-bar">{t('nav.demoBar')}</div> : null}
             after={<>
               {rail ? <TaskRail ctx={ctx} projects={projects} onClose={() => setRailOpen(false)} /> : null}
               {asOpen
                 ? <Assistant ctx={ctx} route={route} projects={projects} onClose={() => setAsOpen(false)} chip={asked && !rail ? <TaskChip onClick={() => setRailOpen(true)} /> : null} />
                 : <>{asked && !rail ? <TaskChip floating onClick={() => setRailOpen(true)} /> : null}<VoiceBar onOpen={() => setAsOpen(true)} />
                     <button class="as-launch" onClick={() => setAsOpen(true)} aria-label={t('as.open')}><GhostShip size={32} /> <span>{t('as.name')}</span></button></>}
             </>}>
        {main}
      </Frame>
    </FleetProvider>
  );
}

function App() {
  const [h, setH] = useState(null);
  const [err, setErr] = useState('');
  const l = useLang();
  const check = () => api.health().then(r => { adopt(r.user); setH(r); }).catch(e => setErr(e.message));
  useEffect(() => { check(); }, []);
  if (err) return <div class="auth"><div class="auth-card"><h1>{t('app.noServer')}</h1><p class="err">{err}</p><p class="muted">{t('app.isRunning')} <code>pnpm start</code>?</p></div></div>;
  if (!h) return <div class="boot"><Logo size={48} /></div>;
  const in_ = (user) => { adopt(user); setH({ ...h, setup: false, user }); toast(t('app.hello', { name: user.name }), 'good'); };
  if (h.setup) return <><Setup mode={h.mode} onRetry={check} /><Toasts /></>;
  if (!h.user) return <><Login mode={h.mode} onDone={in_} /><Toasts /></>;
  // A temporary password (admin-cli, a new account, a reset) is changed before anything else.
  if (h.user.mustChange) return <><ChangePassword mode={h.mode} user={h.user} onDone={(user) => setH({ ...h, user })} /><Toasts /></>;
  // Keyed on the language: switching it redraws every screen in the new one.
  return <Shell key={l} me={h.user} mode={h.mode} onLogout={() => setH({ ...h, user: null })} onAccount={(user) => setH({ ...h, user })} />;
}
// The language saved on the account follows the person to any device; an account that has none
// yet keeps the one this page is showing.
function adopt(user) {
  if (!user) return;
  if (user.lang) setLang(user.lang);
  else api.setLang(lang()).catch(() => {});
}

render(<App />, document.getElementById('app'));
