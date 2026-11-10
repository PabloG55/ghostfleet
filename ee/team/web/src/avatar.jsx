// A person, as a square of their initials in their colour (server/users.mjs COLORS). Team-only:
// the shared screens in web/ui never know who anyone is, and draw an avatar only through a slot.
import { t } from './i18n.js';

export function Avatar({ user, size = 26, title }) {
  if (!user) return <span class="avatar none" style={{ width: size, height: size }} title={title || t('ui.noOwner')}>?</span>;
  const initials = user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return <span class={`avatar c-${user.color}`} style={{ width: size, height: size, fontSize: size * 0.42 }} title={title || user.name}>{initials}</span>;
}
