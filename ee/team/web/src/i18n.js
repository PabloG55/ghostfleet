// The team app's words: its catalogs are registered with the shared machinery by importing
// shared/i18n/index.js, and the page's language itself is web/ui/lang.js's, the same for every app.
export { t, lang, locale, render, LANGS, LANG_NAMES } from '../../shared/i18n/index.js';
export { setLang, useLang } from '../../../../web/ui/lang.js';
