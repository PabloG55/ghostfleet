// Mounted at #/held, and #/held/:project/:id for one item (app.jsx's route table), in both apps.
import { useFleet } from './adapter.jsx';
import { usePoll, Btn, ago, splitAddr } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen, CardStatePill, joinMeta, sessionRoute } from './phone-screen.jsx';
export function HeldCard({ row }) {
  const fleet = useFleet();
  return <article class="card extra-card s-yellow"><CardStatePill status="need-you" label={t('phone.cardHeld')} /><h3>{joinMeta(splitAddr(row.project)[0], row.session || 'master')}</h3><p>{row.text}</p><p class="muted">{joinMeta(row.host, typeof row.reason === 'string' ? row.reason : row.reason?.text, row.since ? ago(Date.now() / 1000 - row.since) : '')}</p><Btn onClick={() => fleet.go(sessionRoute(row.project, row.session))}>{t('phone.openHeld')}</Btn></article>;
}
// The hint explains a held item, so it is drawn only above one: with none it described nothing.
export function Held({ row, project, id }) {
  const fleet = useFleet();
  const { data, error, loading } = usePoll(() => row ? Promise.resolve({ items: [row] }) : fleet.waiting(), 5000, [row, project, id]);
  const rows = (data?.items || []).filter(r => r.state === 'held' && (!project || r.project === project) && (!id || String(r.id) === String(id)));
  return <PhoneScreen title={t('phone.held')} parent="/queue" error={error} loading={loading}>{rows.length ? <p class="muted">{t('phone.heldHint')}</p> : null}<div class="extra-grid">{rows.map(r => <HeldCard key={`${r.project}/${r.id}`} row={r} />)}</div>{data && !rows.length ? <p class="empty">{t('phone.nothingWaiting')}</p> : null}</PhoneScreen>;
}
