// shared/i18n/index.js — the app's words in two languages, for the page and the server alike.
//
// One catalog per language (en.js, es.js), flat keys, `{name}` placeholders. Who is speaking is
// not decided here: the page plugs in the language it shows (web/src/i18n.js), the server the
// language of the request it is answering (server/i18n.mjs). Shared code (shared/automations.js)
// just calls t() and gets whichever applies where it runs.
import en from './en.js';
import es from './es.js';

export const CATALOGS = { en, es };
export const LANGS = ['en', 'es'];
export const LANG_NAMES = { en: 'English', es: 'Español' };

// 'es', 'es-MX', 'es_AR' → es; anything else, including nothing, → en.
export const pickLang = (s) => (/^es(\b|[-_])/i.test(String(s || '').trim()) ? 'es' : 'en');
// A value that names one of ours exactly, or null.
export const normLang = (s) => (LANGS.includes(s) ? s : null);

let source = () => 'en';
export function setLangSource(fn) { source = fn; }
export const lang = () => normLang(source()) || 'en';
// For toLocaleString and friends.
export const locale = () => lang();

// A message to be put into words later, by whoever reads it: a notice stored once and shown to
// several people is rendered in each one's language, not in the language of the moment it was made.
export const msg = (k, v) => ({ k, ...(v ? { v } : {}) });
export const isMsg = (x) => !!x && typeof x === 'object' && typeof x.k === 'string';
export const render = (x, l) => (isMsg(x) ? translate(l || lang(), x.k, x.v) : x);

export function translate(l, key, vars) {
  const cat = CATALOGS[l] || en;
  // `n` picks the singular when the catalog has one: 'x.one' beside 'x'.
  const k = vars && vars.n === 1 && (key + '.one') in cat ? key + '.one' : key;
  let s = cat[k] ?? en[k] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(word(vars[name], l) ?? '') : m));
  return s;
}
// A placeholder's value: a message is translated, `{ at }` (epoch seconds) is a date in that
// language, anything else is itself.
const word = (v, l) => (isMsg(v) ? translate(l, v.k, v.v)
  : v && typeof v === 'object' && typeof v.at === 'number'
    ? new Date(v.at * 1000).toLocaleString(l, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : v);
export const t = (key, vars) => translate(lang(), key, vars);

// A table whose words are looked up when read: `label` (and any other field named) become getters,
// so a table built once at load time still speaks the language of the moment it is read in.
// Keys are `${prefix}.${k}` for the label and `${prefix}.${k}.${field}` for the rest.
export function worded(table, prefix, fields = ['label']) {
  for (const [k, v] of Object.entries(table)) {
    for (const f of fields) {
      const key = f === 'label' ? `${prefix}.${k}` : `${prefix}.${k}.${f}`;
      Object.defineProperty(v, f, { get: () => t(key), enumerable: true, configurable: true });
    }
  }
  return table;
}
// The same for a plain {key: word} map.
export function words(keys, prefix) {
  const o = {};
  for (const k of keys) Object.defineProperty(o, k, { get: () => t(`${prefix}.${k}`), enumerable: true });
  return o;
}
