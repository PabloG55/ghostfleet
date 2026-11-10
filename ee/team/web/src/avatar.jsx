// A person, as a square of their initials in their colour (server/users.mjs COLORS). Team-only:
// the shared screens in web/ui never know who anyone is, and draw an avatar only through a slot.
import { t } from './i18n.js';

// `title={null}` draws it with no native tooltip, for a place that names the person itself.
export function Avatar({ user, size = 26, title }) {
  const tip = (name) => (title === null ? undefined : title || name);
  if (!user) return <span class="avatar none" style={{ width: size, height: size }} title={tip(t('ui.noOwner'))}>?</span>;
  const initials = user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return <span class={`avatar c-${user.color}`} style={{ width: size, height: size, fontSize: size * 0.42 }} title={tip(user.name)}>{initials}</span>;
}
