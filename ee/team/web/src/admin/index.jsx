// Administration: one page with a tab per section, only for global admins. A section is a file
// beside this one (admin/<section>.jsx) and one row in SECTIONS; the route is #/admin/<id>.
// The server answers /api/admin/* with 404 to anyone else, so hiding the link is courtesy,
// not the control.
import { Users } from './users.jsx';
import { AiAccount } from './ai.jsx';
import { UsageAdmin } from './usage.jsx';
import { t } from '../i18n.js';
import { worded } from '../../../shared/i18n/index.js';

export const SECTIONS = Object.values(worded({
  users: { id: 'users', View: Users },
  ai: { id: 'ai', View: AiAccount },
  usage: { id: 'usage', View: UsageAdmin },
}, 'admin'));

export function Admin({ ctx, section }) {
  if (ctx.me.role !== 'admin') return <div class="page narrow"><h1>{t('admin.noPage')}</h1></div>;
  const cur = SECTIONS.find(s => s.id === section) || SECTIONS[0];
  return (
    <div class="page admin">
      <header class="page-head"><div><h1>{t('nav.admin')}</h1><p class="muted">{t('admin.sub')}</p></div></header>
      <div class="tabs admin-tabs" role="tablist">
        {SECTIONS.map(s => <a key={s.id} role="tab" aria-selected={s === cur} class={s === cur ? 'on' : ''} href={`#/admin/${s.id}`}>{s.label}</a>)}
      </div>
      <cur.View ctx={ctx} />
    </div>
  );
}
