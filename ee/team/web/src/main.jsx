import { render } from 'preact';
import { t, lang, setLang, useLang } from './i18n.js';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { api } from './api.js';
import { Setup, Login, ChangePassword } from './auth.jsx';
import { Admin } from './admin/index.jsx';
import { ProjectView } from './project.jsx';
import { Home, Activity, Settings } from './views.jsx';
import { Avatar, Logo, Toasts, usePoll, toast } from './ui.jsx';
import { UsageMeter, UsageChips } from './usage.jsx';
import { Assistant, Ship, VoiceBar } from './assistant.jsx';
import { bind, unbind, useAgent } from './agent.js';
import { TaskRail, TaskChip } from './tasks.jsx';
import { FleetMap } from './map.jsx';
import { Led } from './fleet.jsx';
import { topLight } from './lights.js';
import { Automations, noticesSeen } from './automations.jsx';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/silkscreen/400.css';
import '../../brand/tokens.css';
import './styles.css';
import './skin.css';
import { Icon } from './icon.jsx';

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
function parse(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { view: 'project', project: parts[1], session: parts[2] === 's' ? parts[3] : null };
  if (parts[0] === 'activity') return { view: 'activity' };
  if (parts[0] === 'map') return { view: 'map' };
  if (parts[0] === 'automations') return { view: 'autos', id: parts[1] || null };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'admin') return { view: 'admin', section: parts[1] || null };
  return { view: 'home' };
}
function current() {
  const h = canonical(location.hash || '#/');
  if (location.hash && h !== location.hash) history.replaceState(null, '', h);
  return parse(h);
}
function useRoute() {
  const [r, setR] = useState(current);
  useEffect(() => { const f = () => setR(current()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

function Sidebar({ ctx, route, projects, open, onClose, usage, notices }) {
  const [q, setQ] = useState('');
  const list = (projects || [])
    .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.counts.need_you - a.counts.need_you) || (b.counts.total - a.counts.total) || a.name.localeCompare(b.name));
  const need = (projects || []).reduce((n, p) => n + p.counts.need_you, 0);
  const link = (to, active, children) => <a href={`#${to}`} class={`nav${active ? ' on' : ''}`} onClick={onClose}>{children}</a>;
  return (
    <nav class={`side${open ? ' open' : ''}`} aria-label={t('nav.label')}>
      <div class="brand"><Logo /><div><b>ghostfleet team</b><small>{ctx.mode === 'demo' ? t('nav.demo') : t('nav.fleet')}</small></div></div>
      {link('/', route.view === 'home', <><Icon name="home" /> {t('nav.home')} {need ? <span class="badge need">{need}</span> : null}</>)}
      {link('/map', route.view === 'map', <><Icon name="map" /> {t('nav.map')}</>)}
      {link('/automations', route.view === 'autos', <><Icon name="bolt" /> {t('nav.automations')} {notices ? <span class="badge warn" title={t('nav.unseen')}>{notices}</span> : null}</>)}
      {link('/activity', route.view === 'activity', <><Icon name="list" /> {t('nav.activity')}</>)}
      {ctx.me.role === 'admin' ? link('/admin', route.view === 'admin', <><Icon name="key" /> {t('nav.admin')}</>) : null}
      <div class="side-sec">
        <span>{t('nav.projects')}</span>
        <input class="search" placeholder={t('nav.search')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('nav.searchProject')} />
      </div>
      <div class="side-list">
        {projects == null ? <p class="muted pad">{t('common.loading')}</p> : null}
        {list.map(p => link(`/p/${encodeURIComponent(p.name)}`, route.view === 'project' && route.project === p.name, (
          <>
            <Led state={topLight(p.sessions.map(x => x.status))} size={8} />
            <span class="grow ellipsis">{p.name}</span>
            {p.counts.need_you ? <span class="badge need">{p.counts.need_you}</span> : p.counts.total ? <span class="n">{p.counts.total}</span> : null}
          </>
        )))}
      </div>
      <UsageMeter data={usage} />
      <div class="side-foot">
        <Avatar user={ctx.me} size={28} />
        <span class="grow ellipsis">{ctx.me.name}</span>
        <a href="#/settings" class="icon-btn" title={t('nav.settings')} aria-label={t('nav.settings')} onClick={onClose}><Icon name="gear" /></a>
        <button class="icon-btn" title={t('nav.logout')} aria-label={t('nav.logout')} onClick={ctx.logout}><Icon name="logout" /></button>
      </div>
    </nav>
  );
}

function Shell({ me, mode, onLogout }) {
  const admin = me.role === 'admin';
  const route = useRoute();
  const [users, setUsers] = useState([me]);
  const [menu, setMenu] = useState(false);
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
  const { data: usage } = usePoll(() => api.usage(), 15000, []);
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
  };
  // The assistant lives above the pages; it needs to know where the person is.
  bind({ go: ctx.go, me, projects: pj?.projects || [], route });
  const need = (pj?.projects || []).reduce((n, p) => n + p.counts.need_you, 0);
  useEffect(() => { document.title = need ? `(${need}) ghostfleet` : 'ghostfleet'; }, [need]);

  let main;
  if (route.view === 'project') main = <ProjectView key={route.project} ctx={ctx} project={route.project} session={route.session} />;
  else if (route.view === 'activity') main = <Activity ctx={ctx} />;
  else if (route.view === 'autos') main = <Automations key={route.id || 'list'} ctx={ctx} projects={pj?.projects ?? null} id={route.id} />;
  else if (route.view === 'map') main = <FleetMap ctx={ctx} projects={pj?.projects ?? null} />;
  else if (route.view === 'settings') main = <Settings ctx={ctx} />;
  else if (route.view === 'admin') main = <Admin ctx={ctx} section={route.section} />;
  else main = <Home ctx={ctx} projects={pj?.projects ?? null} />;

  return (
    <div class={`app${mode === 'demo' ? ' is-demo' : ''}${asOpen ? ' with-as' : ''}${rail ? ' with-rail' : ''}`}>
      <div class="topbar">
        <button class="icon-btn" aria-label={t('nav.menu')} onClick={() => setMenu(true)}><Icon name="menu" /></button>
        <div class="brand"><Logo size={22} /><b>ghostfleet team</b></div>
        <span class="topbar-end"><UsageChips data={usage} onClick={() => setMenu(true)} />{need ? <a class="badge need" href="#/">{need}</a> : null}</span>
      </div>
      {menu ? <div class="side-scrim" onClick={() => setMenu(false)} /> : null}
      <Sidebar ctx={ctx} route={route} usage={usage} notices={fresh.length} projects={pj?.projects ?? null} open={menu} onClose={() => setMenu(false)} />
      <main class="main">
        {mode === 'demo' ? <div class="demo-bar">{t('nav.demoBar')}</div> : null}
        {main}
      </main>
      {rail ? <TaskRail ctx={ctx} projects={pj?.projects ?? null} onClose={() => setRailOpen(false)} /> : null}
      {asOpen
        ? <Assistant ctx={ctx} route={route} projects={pj?.projects ?? null} onClose={() => setAsOpen(false)} chip={asked && !rail ? <TaskChip onClick={() => setRailOpen(true)} /> : null} />
        : <>{asked && !rail ? <TaskChip floating onClick={() => setRailOpen(true)} /> : null}<VoiceBar onOpen={() => setAsOpen(true)} />
            <button class="as-launch" onClick={() => setAsOpen(true)} aria-label={t('as.open')}><Ship size={32} /> <span>{t('as.name')}</span></button></>}
      <Toasts />
    </div>
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
  return <Shell key={l} me={h.user} mode={h.mode} onLogout={() => setH({ ...h, user: null })} />;
}
// The language saved on the account follows the person to any device; an account that has none
// yet keeps the one this page is showing.
function adopt(user) {
  if (!user) return;
  if (user.lang) setLang(user.lang);
  else api.setLang(lang()).catch(() => {});
}

render(<App />, document.getElementById('app'));
