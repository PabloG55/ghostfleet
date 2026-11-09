// The page's language: the person's saved choice once they are in, before that the one picked on
// the login screen (kept in localStorage), and before that the browser's. Everything on screen
// reads it through t(), so switching re-renders the app (main.jsx keys the tree on it).
import { useState, useEffect } from 'preact/hooks';
import { setLangSource, pickLang, normLang, t, lang, locale, render, LANGS, LANG_NAMES } from '../../shared/i18n/index.js';

const KEY = 'gfw.lang';
const saved = () => { try { return normLang(localStorage.getItem(KEY)); } catch { return null; } };
let cur = saved() || pickLang(typeof navigator !== 'undefined' ? navigator.language : '');
setLangSource(() => cur);
if (typeof document !== 'undefined') document.documentElement.lang = cur;

const subs = new Set();
export function setLang(l) {
  const v = normLang(l);
  if (!v) return;
  try { localStorage.setItem(KEY, v); } catch {}
  if (v === cur) return;
  cur = v;
  document.documentElement.lang = v;
  for (const f of subs) f(v);
}
export function useLang() {
  const [l, setL] = useState(cur);
  useEffect(() => { subs.add(setL); return () => subs.delete(setL); }, []);
  return l;
}

export { t, lang, locale, render, LANGS, LANG_NAMES };
