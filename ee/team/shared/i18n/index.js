// shared/i18n/index.js — the team app's words in two languages, for the page and the server alike.
//
// The machinery and the shared screens' own words are the MIT core's (web/ui/i18n.js); this adds
// the team app's catalogs (en.js, es.js) to it, so one t() answers for every key wherever it runs.
// Who is speaking is not decided here: the page plugs in the language it shows (web/src/i18n.js),
// the server the language of the request it is answering (server/i18n.mjs). Shared code
// (shared/automations.js) just calls t() and gets whichever applies where it runs.
import en from './en.js';
import es from './es.js';
import { addWords } from '../../../../web/ui/i18n.js';

addWords({ en, es });

export {
  CATALOGS, LANGS, LANG_NAMES, pickLang, normLang, setLangSource, lang, locale,
  msg, isMsg, render, translate, t, worded, words,
} from '../../../../web/ui/i18n.js';
