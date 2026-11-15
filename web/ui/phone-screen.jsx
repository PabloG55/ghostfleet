// Shared frame and navigation for the additional fleet screens.
import { useKeys } from './keyboard.jsx';
import { BackLink } from './back.jsx';
import { back } from './history.js';
import { t } from './i18n.js';
import { STATUS, StatusPill } from './ui.jsx';
import { Led } from './fleet.jsx';
import { Skeleton } from './skeleton.jsx';
import './phone-screens.css';
export const joinMeta = (...parts) => parts.map(p => p == null ? '' : String(p).trim()).filter(Boolean).join(' · ');
export function CardStatePill({ status, label }) {
  if (!label) return <StatusPill status={status} small />;
  return <span class={`pill c-${STATUS[status].color} sm`}><Led state={status} size={7} hidden /> {label}</span>;
}
export const sessionRoute = (project, session) => `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(session || 'master')}`;
// WAITING IS DRAWN UNDER WHAT THE SCREEN ALWAYS HAS, NOT ABOVE IT. The line of words this used to
// put first sat above a search's field and a queue's sign-ins, so each was drawn one line low and
// came back up when the read answered. The skeleton stands where the cards will (`skeleton`: its
// shape, a drawing of the screen's own, or false for none).
export function PhoneScreen({ title, parent = '/', error, loading, children, actions, skeleton = 'cards', class: extra = '' }) {
  useKeys(key => {
    if (!key.ctrl && !key.alt && ['q', '`'].includes(key.k)) { back(parent); return true; }
    return false;
  });
  return <div class={`page fleet-extra ${extra}`}><BackLink parent={parent} /><header class="page-head"><h1>{title}</h1><div class="row wrap">{actions}</div></header>
    {error ? <p class="err" role="alert">{error.message}</p> : null}
    {children}{!loading || error || !skeleton ? null : typeof skeleton === 'string' ? <Skeleton shape={skeleton} box={skeleton === 'cards' ? 'extra-grid' : ''} n={3} /> : skeleton}</div>;
}
