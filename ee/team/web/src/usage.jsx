// How much of each Claude account is left — the 5-hour window and the week — always on
// screen: in the sidebar on a desk, as one line in the top bar on a phone. Read from what
// Claude Code reports to the status line (server/fleet.mjs usage()).
import { t, locale } from './i18n.js';
import { words } from '../../shared/i18n/index.js';
import { Icon } from '../../../../web/ui/icon.jsx';

const NAMES = words(['work', 'personal'], 'usage.profile');
const nameOf = (p) => NAMES[p] || p;
// Who is shown the quotas. The server answers /api/usage with 404 unless the person is an admin
// or may prompt in some project (server/index.mjs, access.mjs `can`): a viewer sees how full the
// accounts are for nothing they can spend. The same question, asked here, so the page neither
// polls a route that refuses it nor leaves an empty slot where the meter would be.
export const seesUsage = (me) => me.role === 'admin'
  || Object.values(me.projects || {}).some((r) => r === 'member' || r === 'admin');

export const toneOf = (pct) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green');
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// When it fills back up: "in 1 h 20" for the 5-hour window, "Thu 10:00" for the week.
function refill(resets, week, now) {
  if (!resets) return '';
  const s = resets - now;
  if (s <= 0) return t('usage.renewed');
  if (!week || s < 20 * 3600) {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return t('usage.in', { time: `${h ? `${h} h ` : ''}${h ? String(m).padStart(2, '0') : `${m} min`}` });
  }
  const d = new Date(resets * 1000);
  return `${d.toLocaleDateString(locale(), { weekday: 'short' })} ${hhmm(d)}`;
}
const ago = (at, now) => { const m = Math.round((now - at) / 60); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };

function Bar({ label, w, week, now }) {
  if (!w) return <div class="ubar off"><span class="ubar-k">{label}</span><span class="ubar-track" /><span class="ubar-v">—</span></div>;
  const left = Math.max(0, 100 - w.pct);
  return (
    <div class={`ubar c-${toneOf(w.pct)}`}
         title={t('usage.barTitle', { label, used: w.pct, left, when: new Date(w.resets * 1000).toLocaleString(locale()) })}>
      <span class="ubar-k">{label}</span>
      <span class="ubar-track"><i style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
      <span class="ubar-v">{w.pct}%</span>
      <span class="ubar-r"><Icon name="refresh" /> {refill(w.resets, week, now)}</span>
    </div>
  );
}

export function UsageMeter({ data }) {
  const list = data?.profiles || [];
  if (!list.length) return data ? <div class="usage muted small">{t('usage.none')}</div> : null;
  const now = Math.floor(Date.now() / 1000);
  return (
    <div class="usage" aria-label={t('usage.title')}>
      {list.map(p => (
        <div key={p.profile} class="usage-acc">
          <div class="usage-head">
            <b>{list.length > 1 ? nameOf(p.profile) : t('usage.title')}</b>
            {now - p.at > 20 * 60 ? <small title={t('usage.updates')}>{t('usage.ago', { time: ago(p.at, now) })}</small> : null}
          </div>
          <Bar label="5 h" w={p.five_hour} now={now} />
          <Bar label={t('usage.week')} w={p.seven_day} week now={now} />
        </div>
      ))}
    </div>
  );
}

// The phone's version: one chip per account, the tighter of its two limits.
export function UsageChips({ data, onClick }) {
  const list = data?.profiles || [];
  if (!list.length) return null;
  return (
    <button class="uchips" onClick={onClick} aria-label={t('usage.see')}>
      {list.map(p => {
        const w = [p.five_hour, p.seven_day].filter(Boolean).sort((a, b) => b.pct - a.pct)[0];
        return w ? <span key={p.profile} class={`uchip c-${toneOf(w.pct)}`}>{list.length > 1 ? nameOf(p.profile)[0] : ''}{w === p.five_hour ? ' 5h ' : ` ${t('usage.wk')} `}{w.pct}%</span> : null;
      })}
    </button>
  );
}
