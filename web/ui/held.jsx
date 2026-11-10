// Suggested hash route: #/held (or #/held/:project/:id for one item).
import { useFleet } from './adapter.jsx';
import { usePoll, Btn, ago } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen, sessionRoute } from './phone-screen.jsx';
export function HeldCard({ row }) {
  const fleet = useFleet();
  return <article class="card extra-card s-yellow"><span class="pill c-yellow">{t('phone.held')}</span><h3>{row.project} · {row.session || 'master'}</h3><p>{row.text}</p><p class="muted">{[row.host, typeof row.reason === 'string' ? row.reason : row.reason?.text, row.since ? ago(Date.now() / 1000 - row.since) : ''].filter(Boolean).join(' · ')}</p><Btn onClick={() => fleet.go(sessionRoute(row.project, row.session))}>{t('phone.openHeld')}</Btn></article>;
}
export function Held({ row, project, id }) {
  const fleet = useFleet();
  const { data, error, loading } = usePoll(() => row ? Promise.resolve({ items: [row] }) : fleet.waiting(), 5000, [row, project, id]);
  const rows = (data?.items || []).filter(r => r.state === 'held' && (!project || r.project === project) && (!id || String(r.id) === String(id)));
  return <PhoneScreen title={t('phone.held')} parent="/queue" error={error} loading={loading}><p class="muted">{t('phone.heldHint')}</p><div class="extra-grid">{rows.map(r => <HeldCard key={`${r.project}/${r.id}`} row={r} />)}</div>{data && !rows.length ? <p class="empty">{t('phone.nothingWaiting')}</p> : null}</PhoneScreen>;
}
