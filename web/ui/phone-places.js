// Names for these shared routes. Both apps can compose screenPlace with their own place().
import { t } from './i18n.js';
const keys = {
  '/automations': 'phone.nav.automations',
  '/reviews': 'phone.reviews',
  '/stack-picker': 'phone.stackPlace',
  '/stack': 'phone.stackPlace',
  '/queue': 'phone.queue',
  '/held': 'phone.held',
  '/search': 'phone.search',
  '/sign-ins': 'phone.signIns',
};
// Getters keep an existing map in sync with language changes.
export const SCREEN_PLACES = Object.freeze(Object.defineProperties({}, Object.fromEntries(
  Object.entries(keys).map(([route, key]) => [route, { enumerable: true, get: () => t(key) }]),
)));
export function screenPlace(route) {
  const root = '/' + String(route || '').replace(/^#?\/?/, '').split(/[/?#]/)[0];
  return Object.hasOwn(SCREEN_PLACES, root) ? SCREEN_PLACES[root] : null;
}
