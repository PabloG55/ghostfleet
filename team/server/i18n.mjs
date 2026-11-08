// server/i18n.mjs — which language the server is speaking right now.
//
// Every request runs inside its own store: the X-GFW-Lang header the page sends, then the
// person's saved `lang`, then the browser's Accept-Language. Work that runs on its own (an
// automation on its clock) is put in its owner's language with orLang(). Messages are written
// with shared/i18n's t(), which asks here, so no function has to be handed a language.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setLangSource, normLang, pickLang } from '../shared/i18n/index.js';

const als = new AsyncLocalStorage();
setLangSource(() => als.getStore()?.lang() || 'en');

export function inRequest(req, fn) {
  const s = { user: null };
  s.lang = () => normLang(req.headers['x-gfw-lang']) || normLang(s.user?.lang) || pickLang(req.headers['accept-language']);
  return als.run(s, fn);
}
// Once the request knows who is asking.
export function asUser(u) { const s = als.getStore(); if (s) s.user = u; }
// Runs fn in `lang` unless a request already set one (a person pressing "run now" is answered
// in their own language, not in the owner's).
export function orLang(l, fn) {
  if (als.getStore()) return fn();
  return als.run({ lang: () => normLang(l) || 'en' }, fn);
}
export const withLang = (l, fn) => als.run({ lang: () => normLang(l) || 'en' }, fn);
