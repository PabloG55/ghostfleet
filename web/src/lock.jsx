// web/src/lock.jsx — the phone's door: a passkey, on web/ui's gate card (the team app's sign-in is
// the same card). Everything below is the old lock screen's rules, kept because each one was paid
// for on a real phone:
//
//   NO ACTION UNTIL THE PROBE ANSWERS. "Register a passkey" means one thing against a server and
//   another against fixtures, and the fixture bypass must never be offered on a page that turns
//   out to be served BY the daemon — which is exactly the window a probe is open for.
//   THE UNLOCK TAP IS SYNCHRONOUS. passkey.js open() has to reach navigator.credentials.get()
//   inside the tap, so nothing awaits before it; the challenge it signs is fetched ahead (prepare).
//   ONE AUTOMATIC ATTEMPT per open or resume (passkey.js autoUnlock), silent when WebKit wants a
//   tap — the button is the answer to that.
//   WHAT WENT WRONG STAYS ON THE CARD until the next tap: a refusal said only in a toast looked
//   exactly like a dead button.
//   AGAINST A SERVER, REGISTERING IS ENROLLING: the server refuses a passkey no enrolment window
//   authorised, so the card has the field for the one-time code the Mac printed.
import { useState, useEffect } from 'preact/hooks';
import * as api from '../api.js';
import * as pk from '../passkey.js';
import { Gate, LangToggle } from '../ui/gate.jsx';
import { Btn } from '../ui/ui.jsx';
import { Connection } from '../ui/views.jsx';
import { devKind } from './adapter.js';
import { t } from '../ui/i18n.js';

export function Lock({ onIn, connection }) {
  const [, bump] = useState(0);
  const redraw = () => bump(n => n + 1);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const [window_, setWindow] = useState(null);     // the server's enrolment window, asked before Face ID
  const [where, setWhere] = useState(false);
  const r = api.resolution();
  const server = r.mode === 'server';
  const probing = r.mode === 'probing';

  useEffect(() => { api.ready().then(redraw); }, []);
  // The challenge the tap will sign, fetched NOW so the tap has nothing to wait for. Once per
  // failure: a failed fetch is shown and the next tap asks again.
  useEffect(() => {
    if (probing || !pk.available() || !pk.registered()) return;
    if (!pk.prepared() && !pk.preparing() && !pk.prepareError()) pk.prepare().then(redraw, (e) => setErr(pk.describe(e)));
  });
  // Asked before anything is typed: a closed window is knowable in advance, and finding out
  // afterwards means biometrics spent on a refusal.
  useEffect(() => {
    if (!server || !pk.available() || pk.registered()) return;
    pk.enrolmentState().then(setWindow, (e) => setWindow({ error: String((e && e.message) || e) }));
  }, [server]);

  const unlock = () => {
    if (pk.unlocking()) return;
    setErr('');
    const p = pk.open();
    redraw();
    p.then(() => onIn('passkey'), (e) => { setErr(pk.describe(e)); redraw(); });
  };
  const enrol = async () => {
    setErr('');
    try { await pk.register(server ? code : ''); onIn('enrol'); }
    catch (e) { setErr(String((e && e.message) || e)); }
  };
  const dev = pk.device(), kind = devKind();

  return (
    <Gate name="ghostfleet" sub={t('lock.tagline')} top={<LangToggle />}>
      <div class="gate-notes">
        <p class="muted small">{r.detail}</p>
        {!probing && !pk.available() ? <p class="warn">{t('lock.unavailable', { why: pk.unavailableReason() })}</p> : null}
        {r.mode === 'fixtures' ? <p class="warn small">{t('lock.fixturesGate')}</p> : null}
      </div>
      {probing ? null : (
        <div class="stack">
          {pk.available() && !pk.registered() && server ? <>
            <p class={window_?.open ? 'ok' : 'muted'}>
              {window_ == null ? t('lock.asking', { where: api.modeLabel() })
                : window_.error ? t('lock.askFailed', { why: window_.error })
                : window_.open ? t('lock.windowOpen', { client: window_.client }) : t('lock.windowClosed', { how: t(`dev.${kind}.enrol`) })}
            </p>
            <label class="field"><span>{t('lock.code')}</span>
              <input value={code} placeholder="GP7CX-ZRDR5" autocapitalize="characters" autocomplete="one-time-code"
                     onInput={(e) => setCode(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && code) enrol(); }} /></label>
            <Btn kind="primary" disabled={!code} onClick={enrol}>{t(`dev.${kind}.enrolBtn`)}</Btn>
          </> : null}
          {pk.available() && !pk.registered() && !server ? <Btn kind="primary" onClick={enrol}>{t('lock.register')}</Btn> : null}
          {pk.available() && pk.registered()
            ? <Btn kind="primary" disabled={pk.unlocking()} onClick={unlock}>{pk.unlocking() ? t('lock.unlocking') : t('lock.unlock', { sensor: dev.sensor })}</Btn>
            : null}
          {pk.bypassAllowed() ? <Btn kind="ghost" onClick={() => { pk.bypass(); onIn('bypass'); }}>{t('lock.bypass')}</Btn> : null}
          {r.mode === 'fixtures' && r.source === 'probe'
            ? <Btn kind="ghost" onClick={async () => { await api.reprobe(); redraw(); }}>{t('lock.lookAgain')}</Btn> : null}
        </div>
      )}
      {err ? <p class="err" role="alert">{err}</p> : null}
      <button type="button" class="link-btn" aria-expanded={where} onClick={() => setWhere(!where)}>{t('lock.where')}</button>
      {where ? <Connection part={connection} onChange={redraw} /> : null}
    </Gate>
  );
}
