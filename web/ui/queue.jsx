// Suggested hash route: #/queue.
import { useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { usePoll, Btn, Modal } from './ui.jsx';
import { PendingSignIns } from './sign-ins.jsx';
import { HeldCard } from './held.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta } from './phone-screen.jsx';
export const replyText = (row, text) => `Re your ledger item ${row.id}: "${row.text}"\n\n${String(text || '').trim()}`;
export function Queue() {
  const fleet = useFleet();
  const { data, error, loading, reload } = usePoll(() => fleet.waiting(), 5000, []);
  const [row, setRow] = useState(null), [text, setText] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setFailure('');
    try { await fleet.act('fleet_send', { project: row.project, session: 'master', prompt: replyText(row, text) }); setRow(null); setText(''); reload(); }
    catch (e) { setFailure(e.message); } finally { setBusy(false); }
  };
  return <PhoneScreen title={t('phone.queue')} error={error} loading={loading}><PendingSignIns /><div class="extra-grid">{(data?.items || []).map(r => r.state === 'held' ? <HeldCard key={`${r.project}/${r.id}`} row={r} /> : <article class="card extra-card s-yellow" key={`${r.project}/${r.id}`}><span class="pill c-yellow">{['waiting','replied'].includes(r.state) ? t(`phone.queueState.${r.state}`) : r.state}</span><h3>{joinMeta(r.project, r.id == null ? null : `#${r.id}`)}</h3><p>{r.text}</p><p class="muted">{joinMeta(r.host, typeof r.reason === 'string' ? r.reason : r.reason?.text)}</p><Btn onClick={() => { setRow(r); setText(''); }}>{t('phone.reply')}</Btn></article>)}</div>
    {data && !data.items?.length ? <p class="empty">{t('phone.nothingWaiting')}</p> : null}
    {row ? <Modal title={joinMeta(t('phone.reply'), row.project, row.id == null ? null : `#${row.id}`)} onClose={() => !busy && setRow(null)}><p>{row.text}</p><p class="muted">{t('phone.replyHint')}</p><label class="field"><span>{t('phone.reply')}</span><textarea rows={4} value={text} onInput={e => setText(e.currentTarget.value)} /></label>{failure ? <p class="err" role="alert">{failure}</p> : null}<Btn kind="primary" disabled={busy || !text.trim()} onClick={send}>{t('common.send')}</Btn></Modal> : null}
  </PhoneScreen>;
}
