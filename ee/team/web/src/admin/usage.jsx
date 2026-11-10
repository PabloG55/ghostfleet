// Administration → Usage: how many tokens each person's turns took today, this week and this
// month, where they went, and the cap that stops them. Read from server/usage-ledger.mjs, which
// counts the transcripts; a cap is counted without cache reads (see capTokens there), and the
// table says so, because otherwise the numbers look small next to Claude Code's own.
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Btn, Modal, toast, usePoll } from '../../../../../web/ui/ui.jsx';
import { Avatar } from '../avatar.jsx';
import { t, locale } from '../i18n.js';
import './usage.css';

export const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toLocaleString(locale(), { maximumFractionDigits: n >= 1e7 ? 0 : 1 })} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString(locale())} k`;
  return String(n);
};
const fmtUsd = (x) => `US$ ${x.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toneOf = (pct) => (pct >= 100 ? 'red' : pct >= 75 ? 'yellow' : 'green');

// The tighter of the two caps is the one that will stop them first.
function capUse(u) {
  const c = u.cap;
  if (!c) return null;
  const opts = [];
  if (c.daily) opts.push({ label: t('ucap.daily'), used: u.today.tokens, cap: c.daily });
  if (c.monthly) opts.push({ label: t('ucap.monthly'), used: u.month.tokens, cap: c.monthly });
  return opts.map(o => ({ ...o, pct: Math.round((o.used / o.cap) * 100) })).sort((a, b) => b.pct - a.pct)[0] || null;
}

function CapBar({ u }) {
  const c = capUse(u);
  if (!c) return <span class="muted small">{t('ucap.none')}</span>;
  return (
    <div class={`ucap c-${toneOf(c.pct)}`} title={t('ucap.title', { which: c.label, used: c.used.toLocaleString(locale()), cap: c.cap.toLocaleString(locale()) })}>
      <span class="ucap-track"><i style={{ width: `${Math.min(100, c.pct)}%` }} /></span>
      <span class="ucap-v">{c.pct}% <small>{t('ucap.of', { which: c.label })}</small></span>
    </div>
  );
}

function Period({ p, usd }) {
  return (
    <td class="num">
      <b>{fmtTokens(p.tokens)}</b>
      {usd ? <small class="usd">{fmtUsd(p.usd)}</small> : <small>{t('ucap.turns', { n: p.turns })}</small>}
    </td>
  );
}

function CapEditor({ u, onClose, onSaved }) {
  const m = (v) => (v ? String(v / 1e6) : '');
  const [daily, setDaily] = useState(m(u.cap?.daily));
  const [monthly, setMonthly] = useState(m(u.cap?.monthly));
  const [busy, setBusy] = useState(false);
  const toTok = (s) => (String(s).trim() === '' ? '' : Math.round(Number(String(s).replace(',', '.')) * 1e6));
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      await api.setTokenCap(u.id, toTok(daily), toTok(monthly));
      toast(t('ucap.saved', { name: u.name }), 'good'); onSaved(); onClose();
    } catch (x) { toast(x.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('ucap.modal', { name: u.name })} onClose={onClose}>
      <form class="ucap-form modal-body" onSubmit={save}>
        <p class="muted small">{t('ucap.how', { name: u.name })}</p>
        <label class="field"><span>{t('ucap.dailyH')}</span>
          <input inputMode="decimal" placeholder={t('ucap.none')} value={daily} onInput={(e) => setDaily(e.currentTarget.value)} aria-label={t('ucap.dailyAria')} />
        </label>
        <label class="field"><span>{t('ucap.monthlyH')}</span>
          <input inputMode="decimal" placeholder={t('ucap.none')} value={monthly} onInput={(e) => setMonthly(e.currentTarget.value)} aria-label={t('ucap.monthlyAria')} />
        </label>
        <p class="muted small">{t('ucap.sofar', { today: fmtTokens(u.today.tokens), month: fmtTokens(u.month.tokens) })}</p>
        <div class="row end">
          {u.cap ? <Btn kind="ghost" type="button" disabled={busy} onClick={() => { setDaily(''); setMonthly(''); }}>{t('ucap.remove')}</Btn> : null}
          <Btn kind="primary" type="submit" disabled={busy}>{t('common.save')}</Btn>
        </div>
      </form>
    </Modal>
  );
}

export function UsageAdmin({ ctx }) {
  const { data, error, reload } = usePoll(() => api.adminUsage(), 30000, []);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  if (error && !data) return <p class="err">{error.message || String(error)}</p>;
  if (!data) return <p class="muted pad">{t('common.loading')}</p>;
  const usd = data.dollars;
  const team = (k) => data.users.reduce((o, u) => ({ tokens: o.tokens + u[k].tokens, usd: o.usd + (u[k].usd || 0) }), { tokens: 0, usd: 0 });
  const users = [...data.users].sort((a, b) => b.month.tokens - a.month.tokens);
  const byId = Object.fromEntries(data.users.map(u => [u.id, u]));
  return (
    <div class="uadm">
      <div class="uadm-sum">
        {[['ucap.today', 'today'], ['ucap.thisWeek', 'week'], ['ucap.thisMonth', 'month']].map(([label, k]) => {
          const sum = team(k);
          return <div key={k} class="uadm-tile"><span>{t(label)}</span><b>{fmtTokens(sum.tokens)}</b>{usd ? <small class="usd">≈ {fmtUsd(sum.usd)}</small> : <small>{t('ucap.teamTokens')}</small>}</div>;
        })}
      </div>
      {usd ? <p class="muted small uadm-note">{t('ucap.estimate', { date: data.pricesAsOf })}</p> : null}
      <div class="uadm-tablewrap">
        <table class="uadm-table">
          <thead><tr><th>{t('ucap.person')}</th><th class="num">{t('ucap.today')}</th><th class="num">{t('ucap.week')}</th><th class="num">{t('ucap.month')}</th><th>{t('ucap.cap')}</th><th /></tr></thead>
          <tbody>
            {users.map(u => (
              <Fragment key={u.id}>
                <tr class={u.over ? 'is-over' : ''}>
                  <td>
                    <button class="uadm-who" onClick={() => setOpen(open === u.id ? null : u.id)} aria-expanded={open === u.id} aria-label={t('ucap.byProject', { name: u.name })}>
                      <span class="caret">{open === u.id ? '▾' : '▸'}</span><Avatar user={u} size={24} /><b>{u.name}</b>
                      {u.over ? <span class="badge bad">{t('ucap.reached')}</span> : null}
                    </button>
                    <div class="cap-mini"><CapBar u={u} /></div>
                  </td>
                  <Period p={u.today} usd={usd} /><Period p={u.week} usd={usd} /><Period p={u.month} usd={usd} />
                  <td class="capcell"><CapBar u={u} /></td>
                  <td class="num"><Btn kind="ghost sm" onClick={() => setEdit(u.id)}>{t('ucap.edit')}</Btn></td>
                </tr>
                {open === u.id ? (
                  <tr class="uadm-projects"><td colSpan={6}>
                    {u.projects.length ? u.projects.map(p => (
                      <div key={p.project} class="uproj">
                        <span class="ellipsis">{p.project}</span>
                        <span class="ucap-track"><i style={{ width: `${Math.round((p.tokens / Math.max(1, u.month.tokens)) * 100)}%` }} /></span>
                        <b>{fmtTokens(p.tokens)}</b>
                        <small class="muted">{usd ? fmtUsd(p.usd) : t('ucap.turns', { n: p.turns })}</small>
                      </div>
                    )) : <p class="muted small">{t('ucap.noUse')}</p>}
                    <div class="cap-mini"><Btn kind="ghost sm" onClick={() => setEdit(u.id)}>{t('ucap.edit')}</Btn></div>
                  </td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small uadm-note">{t('ucap.counts')}
        {data.unattributed ? <> {t('ucap.unattributed', { n: fmtTokens(data.unattributed) })}</> : null}</p>
      {edit && byId[edit] ? <CapEditor u={byId[edit]} onClose={() => setEdit(null)} onSaved={reload} /> : null}
    </div>
  );
}
