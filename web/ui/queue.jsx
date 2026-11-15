// Mounted at #/queue (app.jsx's route table), in both apps.
//   WHAT WAITS ON THE PERSON, and only that: each master's ledger items that are theirs to answer
// (mods/ghostfleet/hooks/ledger.js forYou) — the questions it asked them, one item per numbered
// question, and the requests it holds until they decide. What a session owes is its own work and
// is not listed here.
//   EXPLÍCAME: every such item asks the session that raised it to explain it in plain words (a
// prompt that waits for a running turn to end, never an interrupt). The answer opens in a sheet
// on a phone and a dialog at a desk, never inline, with the item's options beside it: choosing
// one answers the item.
import { useState, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { usePoll, Btn, Modal, Markdown, splitAddr, ago, toast } from './ui.jsx';
import { PendingSignIns } from './sign-ins.jsx';
import { HeldCard } from './held.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta } from './phone-screen.jsx';
export const replyText = (row, text) => `Re your ledger item ${row.id}: "${row.text}"\n\n${String(text || '').trim()}`;
const yours = (r) => r.state === 'question' || r.state === 'waiting';
const optionLine = (o) => `${o.key}) ${o.text}`;
const PENDING_POLL_MS = 2000;
export function Queue() {
  const fleet = useFleet();
  const { data, error, loading, reload } = usePoll(() => fleet.waiting(), 5000, [], { key: 'waiting' });
  // A DRAFT PER ITEM, in memory only. One shared box was emptied each time a reply opened, so
  // words typed and closed with a tap beside the dialog were gone when it was reopened — and
  // kept instead, they would have been sent as the answer to whichever item opened next.
  const [row, setRow] = useState(null), [drafts, setDrafts] = useState({}), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const [explaining, setExplaining] = useState(null), [asked, setAsked] = useState({});
  const keyOf = (r) => `${r.project}/${r.id}`;
  const text = row ? drafts[keyOf(row)] || '' : '';
  const setText = (v) => { const k = keyOf(row); setDrafts(d => ({ ...d, [k]: v })); };
  const clearDraft = (r) => setDrafts(d => { const n = { ...d }; delete n[keyOf(r)]; return n; });
  // ANSWERING IS A MESSAGE FIRST: the session is told, then the ledger marks the item answered
  // (fleet_ledger answer). The other way round, a send that failed would leave an item off the
  // list that its session never heard about.
  const answer = async (r, said, option) => {
    const session = r.session || 'master';
    await fleet.act('fleet_send', { project: r.project, session, prompt: replyText(r, said) });
    if (!yours(r)) return;
    try { await fleet.act('fleet_ledger', { project: r.project, session, verb: 'answer', id: String(r.id), ...(option ? { option: option.key } : {}), text: said }); }
    catch (e) { toast(t('phone.answerNotMarked', { why: e.message }), 'bad'); }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setFailure('');
    try { await answer(row, text); clearDraft(row); setRow(null); reload(); }
    catch (e) { setFailure(e.message); } finally { setBusy(false); }
  };
  const explain = async (r) => {
    setExplaining(r);
    const live = r.explain || {};
    if (live.text || (live.askedAt && !live.failed)) return;
    try {
      const out = await fleet.act('fleet_ledger', { project: r.project, session: r.session || 'master', verb: 'explain', id: String(r.id) });
      setAsked(a => ({ ...a, [keyOf(r)]: { at: Date.now(), queued: !!(out && out.queued) } }));
      reload();
    } catch (e) { setAsked(a => ({ ...a, [keyOf(r)]: { at: Date.now(), failed: e.message } })); }
  };
  const items = data?.items || [];
  return <PhoneScreen title={t('phone.queue')} error={error} loading={loading}><PendingSignIns /><div class="extra-grid">{items.map(r => r.state === 'held' ? <HeldCard key={keyOf(r)} row={r} /> : <ForYouCard key={keyOf(r)} r={r} onReply={() => { setRow(r); setFailure(''); }} onExplain={() => explain(r)} />)}</div>
    {data && !items.length ? <p class="empty">{t('phone.nothingWaiting')}</p> : null}
    {row ? <Modal title={joinMeta(t('phone.reply'), row.project, row.id == null ? null : `#${row.id}`)} onClose={() => !busy && setRow(null)}><p>{row.text}</p><p class="muted">{t(yours(row) ? 'phone.replyHintYours' : 'phone.replyHint')}</p><label class="field"><span>{t('phone.reply')}</span><textarea rows={4} value={text} onInput={e => setText(e.currentTarget.value)} /></label>{failure ? <p class="err" role="alert">{failure}</p> : null}<Btn kind="primary" disabled={busy || !text.trim()} onClick={send}>{t('common.send')}</Btn></Modal> : null}
    {explaining ? <ExplainSheet row={items.find(x => keyOf(x) === keyOf(explaining)) || null} was={explaining} asked={asked[keyOf(explaining)]} reload={reload}
      draft={drafts[keyOf(explaining)] || ''} setDraft={(v) => setDrafts(d => ({ ...d, [keyOf(explaining)]: v }))}
      onAnswer={async (said, option) => { await answer(explaining, said, option); clearDraft(explaining); setExplaining(null); reload(); toast(t('phone.answered')); }}
      onAgain={() => { setAsked(a => ({ ...a, [keyOf(explaining)]: null })); explain({ ...explaining, explain: null }); }}
      onClose={() => setExplaining(null)} /> : null}
  </PhoneScreen>;
}

function ForYouCard({ r, onReply, onExplain }) {
  const label = r.state === 'question' ? t('phone.queueState.question') : ['waiting', 'replied'].includes(r.state) ? t(`phone.queueState.${r.state}`) : r.state;
  const reason = typeof r.reason === 'string' ? r.reason : r.reason?.text;
  return <article class="card extra-card s-yellow foryou-card"><span class="pill c-yellow">{label}</span>
    <h3>{joinMeta(splitAddr(r.project)[0], r.id == null ? null : `#${r.id}`, r.n ? t('phone.questionN', { num: r.n }) : null)}</h3>
    <p>{r.text}</p>
    {r.options?.length ? <ul class="foryou-options">{r.options.map(o => <li key={o.key}>{optionLine(o)}</li>)}</ul> : null}
    <p class="muted">{joinMeta(r.host, reason, r.since ? ago(Date.now() / 1000 - r.since) : '', r.explain?.text ? t('phone.explained') : null)}</p>
    <div class="foryou-actions">{yours(r) ? <Btn kind="primary" icon="question" onClick={onExplain}>{t('phone.explain')}</Btn> : null}<Btn onClick={onReply}>{t('phone.reply')}</Btn></div>
  </article>;
}

// The sheet reads the LIVE row (the list polls), so the explanation appears in it when the
// session's turn ends, without the person doing anything. `was` is the row as tapped, for when
// the item has left the list meanwhile (answered from the desk, dropped by its master).
function ExplainSheet({ row, was, asked, reload, draft, setDraft, onAnswer, onAgain, onClose }) {
  const r = row || was, ex = (row && row.explain) || null;
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const session = r.session || 'master';
  const failed = (asked && asked.failed) || (ex && ex.failed) || '';
  const pending = !failed && !(ex && ex.text) && !!row;
  useEffect(() => {
    if (!pending) return undefined;
    const iv = setInterval(() => { if (!document.hidden) reload(); }, PENDING_POLL_MS);
    return () => clearInterval(iv);
  }, [pending, reload]);
  const go = async (said, option) => {
    if (busy || !String(said || '').trim()) return;
    setBusy(true); setFailure('');
    try { await onAnswer(String(said).trim(), option); } catch (e) { setFailure(e.message); } finally { setBusy(false); }
  };
  const status = !row ? <p class="muted">{t('phone.explainGone')}</p>
    : ex && ex.text ? <div class="explain-text"><Markdown text={ex.text} /><p class="muted">{joinMeta(t('phone.explainedBy', { session }), ex.at ? ago((Date.now() - ex.at) / 1000) : '')}</p></div>
    : failed ? <div class="explain-wait"><p class="err" role="alert">{t('phone.explainFailed', { why: failed })}</p><Btn onClick={onAgain}>{t('phone.explainRetry')}</Btn></div>
    : <div class="explain-wait" role="status"><span class="explain-dots" aria-hidden="true" /><p>{asked && asked.queued ? t('phone.explainQueued', { session }) : t('phone.explainAsking', { session })}</p></div>;
  return <Modal sheet title={joinMeta(t('phone.explain'), splitAddr(r.project)[0], r.id == null ? null : `#${r.id}`)} onClose={() => !busy && onClose()}>
    <div class="modal-body explain-sheet">
      <blockquote class="explain-ask">{r.text}</blockquote>
      {status}
      {row && ex && ex.text ? <button type="button" class="link-btn" onClick={onAgain}>{t('phone.explainAgain')}</button> : null}
      {row ? <section class="explain-answer" aria-label={t('phone.answerIt')}>
        <h4>{t('phone.answerIt')}</h4>
        {r.options?.length ? <div class="explain-options">{r.options.map(o => <Btn key={o.key} disabled={busy} onClick={() => go(optionLine(o), o)}>{optionLine(o)}</Btn>)}</div> : null}
        <label class="field"><span>{r.options?.length ? t('phone.answerOwnWords') : t('phone.answerWords')}</span><textarea rows={3} value={draft} onInput={e => setDraft(e.currentTarget.value)} /></label>
        {failure ? <p class="err" role="alert">{failure}</p> : null}
        <Btn kind="primary" disabled={busy || !draft.trim()} onClick={() => go(draft)}>{t('common.send')}</Btn>
      </section> : null}
    </div>
  </Modal>;
}
