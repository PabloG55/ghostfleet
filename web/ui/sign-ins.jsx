// Suggested hash route: #/sign-ins. PendingSignIns also mounts above Queue's ledger items.
import { useState, useRef, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { usePoll, Btn } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen } from './phone-screen.jsx';
export function SignInCard({ row, onChanged = () => {} }) {
  const fleet = useFleet(), input = useRef();
  const [busy, setBusy] = useState(false), [result, setResult] = useState(''), [done, setDone] = useState(false), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(timer); if (input.current) input.current.value = ''; }; }, []);
  const left = Math.max(0, Math.ceil((row.expires - now) / 1000));
  const pending = row.status === 'pending' && left > 0 && !done;
  const account = row.kind === 'account';
  const start = async () => {
    setBusy(true);
    try { const r = await fleet.startAccountLogin(row.project, row.session, row.sock); setResult(r.ok ? t('phone.loginStarted') : t('phone.loginStartFailed')); if (r.ok) onChanged(); }
    catch { setResult(t('phone.loginStartFailed')); } finally { setBusy(false); }
  };
  const finish = async () => {
    // The DOM alone owns a pasted secret. Clear it BEFORE the first await. No hook,
    // history entry, error message, toast or generic action path may ever receive it.
    let secret = input.current?.value || '';
    if (input.current) input.current.value = '';
    setBusy(true);
    try {
      const r = account ? await fleet.finishAccountLogin(row.project, row.id, secret) : await fleet.finishLogin(row.project, row.id, secret);
      secret = '';
      setResult(t(r.ok ? 'phone.loginDone' : 'phone.loginFailed'));
      if (r.ok) { setDone(true); onChanged(); }
    } catch { setResult(t('phone.loginFailed')); }
    finally { secret = ''; if (input.current) input.current.value = ''; setBusy(false); }
  };
  return <article class="card extra-card s-red login-card" data-login={row.id}>
    <span class="pill c-red">{t('phone.signIns')}</span><h3>{row.provider}</h3><p>{row.server} · {row.session} · {row.host || t('phone.thisHost')} · {row.project}</p>
    {account ? <p>{row.profile}</p> : null}{row.first_site ? <p class="err">{t('phone.firstSite')}</p> : null}
    {row.kind === 'connector' ? <p>claude.ai · {row.connector}</p> : null}
    {account && row.status === 'needs-login' ? <Btn disabled={busy} onClick={start}>{t('phone.signIn')}</Btn> : null}
    {(pending || row.kind === 'connector') && /^https?:\/\//.test(row.authorize || '') ? <a class="btn" href={row.authorize} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t(row.kind === 'connector' ? 'phone.openConnector' : 'phone.open')}</a> : null}
    {pending && (account || row.kind === 'loopback') ? <><label class="field"><span>{t(account ? 'phone.code' : 'phone.callback')}</span><input ref={input} type={account ? 'password' : 'text'} autoComplete="off" autoCapitalize="off" spellcheck={false} /></label><Btn disabled={busy || !left} onClick={finish}>{t('phone.finishLogin')}</Btn><small class="muted">{t('phone.expires', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</small></> : null}
    {!pending && row.kind !== 'connector' && row.status === 'pending' && !done ? <p>{t('phone.expired')}</p> : null}<p role="status">{result || (done ? t('phone.loginDone') : '')}</p>
  </article>;
}
export function PendingSignIns() {
  const fleet = useFleet();
  const { data, error, reload } = usePoll(() => fleet.pendingSignIns(), 5000, []);
  return <>{error ? <p class="err" role="alert">{t('phone.loginReadFailed')}</p> : null}<div class="extra-grid">{(data?.items || []).map(r => <SignInCard key={r.id} row={r} onChanged={reload} />)}</div></>;
}
export function SignIns() { return <PhoneScreen title={t('phone.signIns')}><PendingSignIns /></PhoneScreen>; }
