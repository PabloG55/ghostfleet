// Shared frame and navigation for the additional fleet screens.
import { useKeys } from './keyboard.jsx';
import { BackLink } from './back.jsx';
import { back } from './history.js';
import { t } from './i18n.js';
import './phone-screens.css';
export const sessionRoute = (project, session) => `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(session || 'master')}`;
export function PhoneScreen({ title, parent = '/', error, loading, children, actions }) {
  useKeys(key => {
    if (!key.ctrl && !key.alt && ['q', '`'].includes(key.k)) { back(parent); return true; }
    return false;
  });
  return <div class="page fleet-extra"><BackLink parent={parent} /><header class="page-head"><h1>{title}</h1><div class="row wrap">{actions}</div></header>
    {error ? <p class="err" role="alert">{error.message}</p> : null}
    {loading ? <p class="muted" role="status">{t('common.loading')}</p> : null}{children}</div>;
}
