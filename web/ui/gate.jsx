// web/ui/gate.jsx — the card in front of the app: the team app's sign-in, the phone's passkey lock.
// One card, so the two doors look like one product: the harbour as its picture, the wordmark, the
// language in its corner, and whatever the app asks for below (a name and a password; a passkey).
import { Logo } from './ui.jsx';
import { Harbor } from './fleet.jsx';
import { t, lang, LANGS } from './i18n.js';
import { setLang } from './lang.js';

// Above the harbour, top right: the one control a person who cannot read the page still finds.
// `onPick` is told when the person chose (the team app makes that choice their account's).
export function LangToggle({ onPick }) {
  const cur = lang();
  return (
    <div class="lang-toggle" role="group" aria-label={t('settings.language')}>
      {LANGS.map(l => (
        <button type="button" key={l} class={l === cur ? 'on' : ''} aria-pressed={l === cur}
                onClick={() => { setLang(l); onPick?.(l); }}>{l.toUpperCase()}</button>
      ))}
    </div>
  );
}

export function Gate({ name, sub, top, children }) {
  return (
    <div class="auth">
      <div class="auth-card">
        {top}
        <Harbor />
        <div class="brand big"><Logo size={44} /><div><b>{name}</b>{sub ? <small>{sub}</small> : null}</div></div>
        {children}
      </div>
    </div>
  );
}
