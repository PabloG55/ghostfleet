import { useState } from 'preact/hooks';
import { api } from './api.js';
import { Btn } from '../../../../web/ui/ui.jsx';
import { Gate, LangToggle } from '../../../../web/ui/gate.jsx';
import { PASSWORD_MIN } from '../../shared/password.js';
import { t, lang } from './i18n.js';

// Set when the person flips the language here, so signing in makes that choice their account's.
let picked = false;

// The shared card (web/ui/gate.jsx, the phone's lock is the same one), with the team's name.
function Shell({ mode, children }) {
  return (
    <Gate name="ghostfleet team" sub={t('auth.tagline')} top={<LangToggle onPick={() => { picked = true; }} />}>
      {mode === 'demo' ? <p class="demo-note">{t('auth.demoNote')}</p> : null}
      {children}
    </Gate>
  );
}

// No accounts yet. They are not created from here: whoever reaches this port could make
// themselves admin. The first admin comes from the server's console (contract §1).
export function Setup({ mode, onRetry }) {
  const cmd = `node server/admin-cli.mjs create-admin <${t('auth.nameArg')}>${mode === 'demo' ? ' --demo' : ''}`;
  return (
    <Shell mode={mode}>
      <h1>{t('auth.setup.title')}</h1>
      <p class="muted">{t('auth.setup.who')}</p>
      <pre class="cmd"><code>{cmd}</code></pre>
      <p class="muted">{t('auth.setup.then')}</p>
      <Btn kind="primary" onClick={onRetry}>{t('auth.setup.done')}</Btn>
    </Shell>
  );
}

export function ChangePassword({ mode, user, onDone }) {
  const [old, setOld] = useState('');
  const [nw, setNw] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (nw !== again) return setErr(t('auth.pw.mismatch'));
    setBusy(true);
    try { const r = await api.password(old, nw); onDone(r.user); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Shell mode={mode}>
      <h1>{t('auth.pw.title', { name: user.name })}</h1>
      <p class="muted">{t('auth.pw.why')}</p>
      <form onSubmit={submit} class="stack">
        <label class="field"><span>{t('auth.pw.temp')}</span><input type="password" value={old} onInput={(e) => setOld(e.currentTarget.value)} autoFocus autocomplete="current-password" /></label>
        <label class="field"><span>{t('auth.pw.new')}</span><input type="password" value={nw} onInput={(e) => setNw(e.currentTarget.value)} placeholder={t('auth.pw.min', { n: PASSWORD_MIN })} autocomplete="new-password" /></label>
        <label class="field"><span>{t('auth.pw.again')}</span><input type="password" value={again} onInput={(e) => setAgain(e.currentTarget.value)} autocomplete="new-password" /></label>
        {err ? <p class="err">{err}</p> : null}
        <Btn kind="primary" type="submit" disabled={busy || !old || nw.length < PASSWORD_MIN || !again}>{busy ? t('common.saving') : t('auth.pw.save')}</Btn>
      </form>
    </Shell>
  );
}

export function Login({ mode, onDone }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api.login(name, password, picked ? lang() : undefined); onDone(r.user); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Shell mode={mode}>
      <h1>{t('auth.login')}</h1>
      <form onSubmit={submit} class="stack">
        <label class="field"><span>{t('auth.name')}</span><input value={name} onInput={(e) => setName(e.currentTarget.value)} autoFocus autocomplete="username" /></label>
        <label class="field"><span>{t('auth.password')}</span><input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} autocomplete="current-password" /></label>
        {err ? <p class="err">{err}</p> : null}
        <Btn kind="primary" type="submit" disabled={busy || !name || !password}>{busy ? t('auth.loggingIn') : t('auth.login')}</Btn>
      </form>
    </Shell>
  );
}
