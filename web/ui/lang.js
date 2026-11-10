// web/ui/lang.js — which language the page shows, for every app built on web/ui.
//
// The person's saved choice (localStorage), and before that the browser's. Everything on screen
// reads it through t(), so switching re-renders the app: each app keys its tree on useLang().
// An app that also keeps the choice somewhere else (the team app saves it on the account) does
// that through its adapter's `saveLang`; this file only owns the page's copy.
import { useState, useEffect } from 'preact/hooks';
import { setLangSource, pickLang, normLang } from './i18n.js';

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
  if (typeof document !== 'undefined') document.documentElement.lang = v;
  for (const f of subs) f(v);
}
export function useLang() {
  const [l, setL] = useState(cur);
  useEffect(() => { subs.add(setL); return () => subs.delete(setL); }, []);
  return l;
}
