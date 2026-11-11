// Administration → License: the subscription key of this install. Paste one, see what it
// covers and how many accounts count against it, replace or remove it, and decide whether the
// server asks the license service for renewals. Everything here is server/license.mjs's view;
// the key goes in and never comes back.
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { Btn, Confirm, toast } from '../../../../../web/ui/ui.jsx';
import { t, locale } from '../i18n.js';

const STATUS_COLOR = { valid: 'c-green', expired: 'c-yellow', invalid: 'c-red', none: 'c-grey' };
const when = (at) => new Date(at * 1000).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (s) => String(s || '').slice(0, 10);
// The pages above this one (the admin banner) learn that the license changed.
export const LICENSE_EVENT = 'gfw-license';
const changed = () => { try { window.dispatchEvent(new Event(LICENSE_EVENT)); } catch {} };

// Why additions are refused right now, in the words the banner uses too. null: nothing to say.
export function licenseNotice(v) {
  if (!v || v.demo) return null;
  if (v.status === 'expired') return t('lic.note.expired', { date: day(v.expires), seats: v.capacity });
  if (v.status === 'invalid') return t('lic.note.invalid', { seats: v.capacity });
  if (v.over) return t('lic.note.over', { n: v.counted, seats: v.capacity });
  return null;
}

export function License() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  useEffect(() => { api.admin.license().then(setV).catch(e => setErr(e.message)); }, []);
  const act = async (b, ok) => {
    setBusy(true);
    try {
      const r = await api.admin.licenseAct(b);
      setV(r); changed();
      if (r.demo && r.text) toast(r.text);
      else if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'good');
      return r;
    } catch (e) { toast(e.message, 'bad'); return null; }
    finally { setBusy(false); }
  };
  if (err) return <p class="err pad">{err}</p>;
  if (!v) return <p class="muted pad">{t('common.loading')}</p>;
  const note = licenseNotice(v);
  const has = v.status !== 'none';
  const last = v.renewal.last;

  return (
    <>
      <section class="panel" aria-label={t('admin.license')}>
        <div class="row wrap">
          <h2 class="grow">{t('lic.title')}</h2>
          <span class={`pill sm ${STATUS_COLOR[v.status]}`}>{t(`lic.status.${v.status}`)}</span>
        </div>
        {v.demo ? <p class="muted small">{t('lic.demo')}</p> : null}
        <div class="rows">
          <div class="row-item static"><span class="grow muted">{t('lic.org')}</span><b>{v.org || t('lic.dash')}</b></div>
          <div class="row-item static"><span class="grow muted">{t('lic.seats')}</span><b>{v.seats ?? t('lic.dash')}</b></div>
          <div class="row-item static"><span class="grow muted">{t('lic.expires')}</span><b>{v.expires ? day(v.expires) : t('lic.dash')}</b></div>
          <div class="row-item static"><span class="grow muted">{t('lic.counted')}</span><b>{t('lic.countedOf', { n: v.counted, seats: v.capacity })}</b></div>
        </div>
        <p class="muted small">{t('lic.countedHow')}</p>
        {v.status === 'none' ? <p class="muted small">{t('lic.free', { n: v.free })}</p> : null}
        {v.status === 'invalid' && v.reason ? <p class="err small">{t(`err.license.${v.reason}`)}</p> : null}
        {note ? <p class="license-note" role="status">{note}</p> : null}
      </section>

      <section class="panel">
        <h2>{has ? t('lic.replace') : t('lic.paste')}</h2>
        {!v.verifiable ? <p class="muted small">{t('lic.noVerify')}</p> : null}
        <form class="stack" onSubmit={async (e) => {
          e.preventDefault();
          if (await act({ action: 'set', key }, t('lic.saved'))) setKey('');
        }}>
          <textarea rows="3" class="mono" autocomplete="off" spellcheck={false} placeholder="gft1.…" value={key}
                    onInput={(e) => setKey(e.currentTarget.value)} aria-label={t('lic.key')} />
          <div class="row wrap">
            <Btn kind="primary" type="submit" disabled={!key.trim() || busy}>{has ? t('lic.replaceBtn') : t('common.save')}</Btn>
            {has ? <Btn kind="danger" disabled={busy} onClick={() => setDel(true)}>{t('lic.remove')}</Btn> : null}
          </div>
        </form>
        <p class="muted small">{t('lic.stored')}</p>
        {del ? <Confirm title={t('lic.removeAsk')} danger action={t('lic.remove')} body={<p>{t('lic.removeBody', { n: v.free })}</p>}
                        onYes={() => act({ action: 'remove' }, t('lic.removed'))} onClose={() => setDel(false)} /> : null}
      </section>

      <section class="panel">
        <h2>{t('lic.renew')}</h2>
        {!v.renewal.available ? <p class="muted">{t('lic.renewNA')}</p> : (
          <>
            <label class="row"><input type="checkbox" checked={v.renewal.auto} disabled={busy}
                                      onChange={(e) => act({ action: 'auto', on: e.currentTarget.checked }, e.currentTarget.checked ? t('lic.autoOn') : t('lic.autoOff'))} />
              <span>{t('lic.auto')}</span></label>
            <p class="muted small">{t('lic.sends')}</p>
            <div class="row wrap">
              <Btn disabled={busy || !v.renewal.auto || !has} onClick={() => act({ action: 'check' }, (r) => r.checked?.ok ? t('lic.check.ok') : t(`lic.check.${r.checked?.reason || 'transient'}`))}>{busy ? t('common.wait') : t('lic.checkNow')}</Btn>
              <span class="muted small">{last
                ? t('lic.last', { when: when(last.at), result: last.ok ? t('lic.check.ok') : t(`lic.check.${last.reason}`) })
                : t('lic.never')}</span>
            </div>
          </>
        )}
      </section>
    </>
  );
}
