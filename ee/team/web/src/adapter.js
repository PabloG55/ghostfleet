// The team app's side of web/ui/adapter.jsx: the shared screens' fleet, over this app's server.
// Every call is the server's own, scoped to the signed-in person; the slots are teamSlots(ctx).
import { api, ATTACH_PER_MESSAGE } from './api.js';
import { teamSlots } from './slots.jsx';
import { t } from './i18n.js';

// What this app's own routes are called on a back button (web/ui/back.jsx names the shared ones).
const PLACES = { activity: 'nav.activity', automations: 'nav.automations', settings: 'nav.settings', admin: 'nav.admin' };
export const place = (to) => { const k = PLACES[String(to).replace(/^#?\/?/, '').split('/')[0]]; return k ? t(k) : null; };

export function teamAdapter(ctx) {
  return {
    grid: api.grid,
    session: api.session,
    pane: api.pane,
    act: api.act,
    attach: api.attach,
    attachPerMessage: ATTACH_PER_MESSAGE,
    lead: api.lead,
    presence: api.presence,
    go: ctx.go,
    place,
    slots: teamSlots(ctx),
  };
}
