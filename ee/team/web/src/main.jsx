import { render } from 'preact';
import { t, lang, setLang, useLang } from './i18n.js';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { api } from './api.js';
import { Setup, Login, ChangePassword } from './auth.jsx';
import { Admin } from './admin/index.jsx';
import { licenseNotice, LICENSE_EVENT } from './admin/license.jsx';
import { Avatar } from './avatar.jsx';
import { UsageMeter, UsageChips, seesUsage } from './usage.jsx';
import { unbind } from '../../../../web/ui/agent.js';
import { noticesSeen } from '../../../../web/ui/automations.jsx';
import { teamAdapter } from './adapter.js';
// The one app, from the MIT core (web/ui/app.jsx): every page, the sidebar and the assistant.
// What is here is only what the team app has and ghostfleet itself does not — signing in, the
// people, administration and the account's usage (test/one-base.test.mjs holds it to that).
import { FleetProvider } from '../../../../web/ui/adapter.jsx';
import { FleetApp } from '../../../../web/ui/app.jsx';
import { NavLink } from '../../../../web/ui/shell.jsx';
import { go } from '../../../../web/ui/history.js';
import { Logo, Toasts, usePoll, toast } from '../../../../web/ui/ui.jsx';
import { Icon } from '../../../../web/ui/icon.jsx';
// Shared rules first at each layer, the app's own after them: see web/ui/ui.css.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/silkscreen/400.css';
import '../../../../brand/tokens.css';
import '../../../../web/ui/modality.js'; // the focus ring follows the keyboard, not a click
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

// The team app's own pages: administration, and nothing else. Every other page is web/ui's.
export const TEAM_VIEWS = ['admin'];

function Shell({ me, mode, onLogout, onAccount }) {
  const admin = me.role === 'admin';
  const [users, setUsers] = useState([me]);
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
  // Why the next account would be refused (an expired or invalid key, more accounts than
  // seats). Admins only: nobody else can act on it, and the server answers them 404 anyway.
  const [licTick, setLicTick] = useState(0);
  useEffect(() => {
    const bump = () => setLicTick(n => n + 1);
    window.addEventListener(LICENSE_EVENT, bump);
    return () => window.removeEventListener(LICENSE_EVENT, bump);
  }, []);
  const { data: lic } = usePoll(() => (admin ? api.admin.license() : Promise.resolve(null)), 300000, [admin, licTick]);
  const licNote = admin ? licenseNotice(lic) : null;
  const usersById = useMemo(() => Object.fromEntries(users.map(u => [u.id, u])), [users]);
  const ctx = {
    me, mode, users, usersById, admin,
    go,                                    // one history for every back (web/ui/history.js)
    logout: async () => { unbind(); try { await api.logout(); } catch {} onLogout(); },
    // The sign-in ended under the page, or the account still has a temporary password: the
    // same two screens App shows at load, reached from wherever the person is.
    signIn: () => { unbind(); onLogout(); },
    changePassword: () => onAccount({ ...me, mustChange: true }),
  };
  const fleet = useMemo(() => teamAdapter(ctx), [users]);
  const projects = pj?.projects ?? null;

  return (
    <FleetProvider adapter={fleet}>
      <FleetApp name={NAME} sub={mode === 'demo' ? t('nav.demo') : t('nav.fleet')} projects={projects} me={me} canonical={canonical}
                badges={{ automations: fresh.length }}
                extra={{
                  parse: (parts) => (parts[0] === 'admin' ? { view: 'admin', section: parts[1] || null } : null),
                  screens: { admin: (r) => <Admin ctx={ctx} section={r.section} /> },
                  nav: (route, close) => (admin ? <NavLink to="/admin" active={route.view === 'admin'} onClick={close}><Icon name="lock" /> {t('nav.admin')}</NavLink> : null),
                }}
                frame={{
                  class: mode === 'demo' ? ' is-demo' : '',
                  below: quotas ? <UsageMeter data={usage} /> : null,
                  foot: (close) => (
                    <div class="side-foot">
                      <Avatar user={me} size={28} />
                      <span class="grow ellipsis">{me.name}</span>
                      <a href="#/settings" class="icon-btn" title={t('nav.settings')} aria-label={t('nav.settings')} onClick={close}><Icon name="gear" /></a>
                      <button class="icon-btn" title={t('nav.logout')} aria-label={t('nav.logout')} onClick={ctx.logout}><Icon name="logout" /></button>
                    </div>
                  ),
                  topEnd: quotas ? (open) => <UsageChips data={usage} onClick={open} /> : undefined,
                  banner: mode === 'demo' ? <div class="demo-bar">{t('nav.demoBar')}</div>
                    : licNote ? <a class="license-bar" href="#/admin/license" role="status">{licNote}</a> : null,
                }} />
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
