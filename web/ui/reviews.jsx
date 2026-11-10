// Mounted at #/reviews and #/reviews/:host/:profile/:run, each segment encoded (app.jsx's route table), in both apps.
import { useState, useRef, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { useKept } from './back.jsx';
import { useKeys } from './keyboard.jsx';
import { usePoll, Btn, ago } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta } from './phone-screen.jsx';
const commitOf = run => run.commit ? `${run.commit}${run.dirty ? '*' : ''}` : null;
export const reviewRoute = (host, profile, run) => `/reviews/${[host || '-', profile, run].map(encodeURIComponent).join('/')}`;
export function Reviews() {
  const fleet = useFleet();
  const { data, error, loading } = usePoll(() => fleet.reviews(), 5000, []);
  const [expanded, setExpanded] = useKept('reviews.expanded', []);
  const open = (g, r) => fleet.go(reviewRoute(g.host_key, g.profile, r.id));
  return <PhoneScreen title={t('phone.reviews')} error={error} loading={loading}>
    {data === null && !loading && !error ? <p class="empty">{t('phone.reviewsOff')}</p> : null}
    <div class="extra-grid">{(data?.groups || []).map(g => <section key={g.key}>
      <button class={`card extra-card s-${g.latest.state?.cls === 'ok' ? 'green' : g.latest.state?.cls === 'bad' ? 'red' : 'yellow'}`} onClick={() => open(g, g.latest)}><span class={`pill c-${g.latest.state?.cls === 'ok' ? 'green' : g.latest.state?.cls === 'bad' ? 'red' : 'yellow'}`}>{g.latest.state?.label}</span><h3>{g.branch || t('phone.noBranch')}</h3><p>{joinMeta(g.project, g.host, data.multi ? g.profile : '')}</p><p class="muted">{joinMeta(t(g.latest.kind === 'recorded' ? 'phone.video' : 'phone.stills'), g.latest.steps == null ? null : t('phone.steps', { n: g.latest.steps }), commitOf(g.latest), g.latest.at ? ago((Date.now() - Date.parse(g.latest.at)) / 1000) : null)}</p></button>
      {g.earlier?.length ? <><Btn kind="ghost sm" aria-expanded={expanded.includes(g.key)} onClick={() => setExpanded(xs => xs.includes(g.key) ? xs.filter(x => x !== g.key) : [...xs, g.key])}>{t('phone.earlier', { n: g.earlier.length })}</Btn>{expanded.includes(g.key) ? g.earlier.map(r => <Btn key={r.id} kind="ghost" onClick={() => open(g, r)}>{joinMeta(r.state?.label, commitOf(r), r.id)}</Btn>) : null}</> : null}
    </section>)}</div>
    {data && !data.groups?.length ? <p class="empty">{t('phone.noReviews')}</p> : null}
    {(data?.missing || []).map(m => <p class="muted" key={m.host_key}>{t('phone.hostMissing', { host: m.host })}</p>)}
  </PhoneScreen>;
}
export function Review({ host = '', profile, run: id }) {
  const fleet = useFleet(), video = useRef(), writer = useRef({ busy:false, dirty:false, timer:0, run:null, verdict:{} });
  const [run, setRun] = useState(null), [error, setError] = useState(null), [save, setSave] = useState(''), [verdict, setVerdict] = useState({});
  const [chapter, setChapter] = useState(0);
  // Writes are serialized. A late answer cannot overwrite a newer choice; unmount flushes
  // a pending note using the original run identity, even if another run is now mounted.
  useEffect(() => {
    let live = true;
    const w = { busy:false, dirty:false, timer:0, run:null, verdict:{}, live:true };
    writer.current = w; setRun(null); setError(null); setSave(''); setChapter(0);
    w.flush = async () => {
      clearTimeout(w.timer); w.timer = 0;
      if (w.busy || !w.dirty || !w.run) return;
      w.busy = true; w.dirty = false;
      const v = w.verdict;
      const body = { host, profile, run:id, ...(w.run.kind === 'recorded' ? { flow:v.flow?.v ? v.flow : { v:'' }, chapters:v.chapters || {} } : { state:Object.fromEntries(Object.entries(v).filter(([,x]) => x?.v)) }) };
      try { await fleet.saveReview(body); if (w.live) { setSave(t('phone.saved')); setError(null); } }
      catch (e) { w.dirty = true; if (w.live) { setSave(t('phone.saveFailed')); setError(e); } w.busy = false; return; }
      w.busy = false; if (w.dirty) return w.flush();
    };
    fleet.review(profile, id, host).then(j => { if (!live) return; w.run = j.run; w.verdict = j.run.verdict || {}; setRun(j.run); setVerdict(w.verdict); }, e => { if(live) setError(e); });
    return () => { live = false; w.live = false; clearTimeout(w.timer); w.flush(); };
  }, [profile, id, host]);
  const edit = (fn, delay = 0) => { const w = writer.current; w.verdict = fn(w.verdict); w.dirty = true; setVerdict(w.verdict); setSave(t('phone.saving')); clearTimeout(w.timer); if(delay) w.timer = setTimeout(w.flush, delay); else w.flush(); };
  const seek = n => { const next = Math.max(0, Math.min((run?.steps?.length || 1) - 1, n)); setChapter(next); const step = run?.steps?.[next]; if(video.current && step) video.current.currentTime = step.at ?? step.start ?? step.t ?? 0; };
  const flow = v => edit(x => ({ ...x, flow:{ ...x.flow, v:x.flow?.v === v ? '' : v } }));
  useKeys(key => {
    if(key.ctrl || key.alt || !run) return false;
    if(key.k === ' ' && video.current) { video.current.paused ? video.current.play().catch(() => {}) : video.current.pause(); return true; }
    if(key.k === 'ArrowLeft' || key.k === 'ArrowRight') { seek(chapter + (key.k === 'ArrowLeft' ? -1 : 1)); return true; }
    if(run.kind === 'recorded' && ['a','r'].includes(key.k)) { flow(key.k === 'a' ? 'approve' : 'reject'); return true; } return false;
  });
  const note = (label, value, change) => <label class="field"><span>{label}</span><textarea rows={2} value={value || ''} onInput={e => change(e.currentTarget.value)} onBlur={() => writer.current.flush()} /></label>;
  const stepEdit = (n, patch, delay = 0) => edit(x => ({ ...x, [n]:{ ...x[n], ...patch } }), delay);
  const steps = run?.steps || [];
  const problem = steps.filter(s => verdict[s.n]?.v === 'problem').length;
  const unmarked = steps.filter(s => !verdict[s.n]?.v).length;
  const flagged = steps.filter(s => s.notes?.length && !(['ok','skip'].includes(verdict[s.n]?.v) && verdict[s.n]?.note?.trim())).length;
  const gate = run?.kind === 'recorded'
    ? verdict.flow?.v === 'approve' ? 'approved' : verdict.flow?.v === 'reject' ? 'rejected' : 'unreviewed'
    : problem ? 'changesNeeded' : unmarked ? 'unreviewed' : flagged ? 'reasonNeeded' : 'approved';

  return <PhoneScreen title={run?.branch || t('phone.review')} parent="/reviews" error={error} loading={!run && !error}>
    {run ? <><span class={`pill says c-${gate === 'approved' ? 'green' : ['rejected','changesNeeded'].includes(gate) ? 'red' : 'yellow'}`}>{t(`phone.${gate}`)}</span><p class="muted">{joinMeta(run.project, run.host, profile, run.provenance?.commit)}</p><p role="status">{save}</p>{save === t('phone.saveFailed') ? <Btn onClick={() => writer.current.flush()}>{t('phone.retry')}</Btn> : null}
      {run.kind === 'recorded' ? <div class="stack review-verdict"><video ref={video} class="review-media" src={run.videoSrc} controls playsInline /><div class="row wrap">{['approve','reject'].map(v => <Btn kind={verdict.flow?.v === v ? 'primary' : ''} aria-pressed={verdict.flow?.v === v} onClick={() => flow(v)}>{t(`phone.${v}`)}</Btn>)}</div>{note(t('phone.reviewNote'), verdict.flow?.note, text => edit(x => ({...x, flow:{...x.flow, note:text}}), 700))}</div> : <Btn onClick={() => edit(x => ({...x, ...Object.fromEntries(run.steps.filter(s => !x[s.n]?.v).map(s => [s.n,{v:'ok',note:x[s.n]?.note || ''}]))}))}>{t('phone.restOk')}</Btn>}
      {(run.steps || []).map((s,i) => <section class="review-step stack" key={s.n}><h2>{s.n}. {s.name}</h2>{run.kind === 'recorded' ? <Btn onClick={() => seek(i)}>{t('phone.chapter')}</Btn> : <img class="review-media" src={s.src} alt={s.name} />}<p class="muted">{s.url}</p>{(s.notes || []).map((n,j) => <p class="err" key={j}>{typeof n === 'string' ? n : JSON.stringify(n)}</p>)}
        {run.kind !== 'recorded' ? <div class="row wrap">{['ok','problem','skip'].map(v => <Btn aria-pressed={verdict[s.n]?.v === v} kind={verdict[s.n]?.v === v ? 'primary' : ''} onClick={() => stepEdit(s.n,{v:verdict[s.n]?.v === v ? '' : v})}>{t(`phone.${v}`)}</Btn>)}</div> : null}
        {note(t('phone.reviewNote'), run.kind === 'recorded' ? verdict.chapters?.[s.n] : verdict[s.n]?.note, text => run.kind === 'recorded' ? edit(x => ({...x, chapters:{...x.chapters,[s.n]:text}}),700) : stepEdit(s.n,{note:text},700))}
        {s.requests?.length ? <details><summary>{t('phone.requests', {n:s.requests.length})}</summary>{s.requests.map((r,j) => <p key={j}>{r.method} {r.status} {r.url}</p>)}</details> : null}
      </section>)}
    </> : null}
  </PhoneScreen>;
}
