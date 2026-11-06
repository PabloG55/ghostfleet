// web/src/reviews.jsx — the Reviews screens: what `fleet-shots` recorded, reviewed on the phone.
//
// Built into web/screens.js with the other card screens (screens.jsx imports these). The
// seam is the one that file documents, and nothing here moves it:
//
//   THE LIST is a CardScreen like the queue. Its cards are app.js's cardEl() — one per
//   branch, its newest run's state on the rail — and the "N earlier" rows under each are
//   app.js DOM too, so the list is drawn by exactly the code that draws every other list.
//
//   THE RUN is a screen of its own, because nothing else in this app has a video, a chapter
//   strip or a verdict. Every word on it arrives in `t` (app.js REVIEW_WORDS) and every
//   value in props; S in app.js is still the one place a verdict lives.
//
// ONE PIECE OF STATE IS THIS FILE'S, ON PURPOSE: which chapter the video is in. It is the
// <video> element's own playback position, read off its `timeupdate`, and it changes four
// times a second. Routing it through S would re-render the whole app — the poll's render
// included — at the video's frame clock, for a highlight. It is never persisted, and
// nothing outside this screen can ask for it, so it cannot become a second source of truth.

import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Header, CardScreen } from './screens.jsx';

// The requests the PAGE asked for, as fleet-shots partitions them (bin/fleet-shots.mjs
// MEANT): the document and its XHR/fetch. Everything else is an asset and folds away, so a
// failed call is never lost in a scroll of fonts — the old page's reason, kept.
const MEANT = /^(Document|XHR|Fetch)$/i;
const reqCls = (r) => r.failed || r.status >= 400 ? 'bad' : r.status >= 300 ? 'warn' : 'ok';
const clock = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function ReviewsScreen(p) {
  return <CardScreen {...p} band={null} />;
}

function Req({ r }) {
  return (
    <div class={'rv-req ' + reqCls(r)}>
      <span class="m">{r.method}</span>
      <span class="s">{r.failed ? r.failed : (r.status ?? '—')}</span>
      <span class="u">{r.url}</span>
    </div>
  );
}

function Requests({ list, t }) {
  const calls = list.filter(r => MEANT.test(r.type || ''));
  const assets = list.filter(r => !MEANT.test(r.type || ''));
  const bad = calls.filter(r => r.failed || r.status >= 400).length;
  const assetBad = assets.filter(r => r.failed || r.status >= 400).length;
  return (
    <div class="rv-reqs">
      <div class="rv-cap">
        <span>{t.calls(calls.length)}</span>
        {bad ? <span class="bad">{t.failed(bad)}</span> : <span>{t.noneFailed}</span>}
      </div>
      {calls.length ? calls.map((r, i) => <Req key={i} r={r} />) : <div class="rv-none">{t.noCalls}</div>}
      {assets.length
        ? <details class="rv-assets" open={assetBad > 0}>
            <summary>{t.assets(assets.length, assetBad)}</summary>
            {assets.map((r, i) => <Req key={i} r={r} />)}
          </details>
        : null}
    </div>
  );
}

// A field that saves as it is typed in (app.js debounces). 16px, as every field in this app,
// so focusing it does not zoom an iPhone.
function Note({ value, placeholder, onInput, label }) {
  return <textarea class="rv-note" rows={2} value={value} placeholder={placeholder} aria-label={label}
                   onInput={(e) => onInput(e.currentTarget.value)} />;
}

function Step({ s, run, t, v, cur, onSeek, onStep, onStepNote, onChapterNote }) {
  const recorded = run.kind === 'recorded';
  const flagged = !!(s.notes && s.notes.length);
  const mark = recorded ? null : (v[String(s.n)] || {});
  const note = recorded ? ((v.chapters || {})[String(s.n)] || '') : (mark.note || '');
  return (
    <section class={'rv-step' + (flagged ? ' flag' : '') + (cur ? ' cur' : '')} data-n={s.n}>
      <div class="rv-sh">
        <span class="rv-n">{String(s.n).padStart(2, '0')}</span>
        <span class="rv-sn">{s.name}</span>
        {recorded && s.start != null
          ? <button type="button" class="rv-t" onClick={() => onSeek(s)} aria-label={t.playFrom(s.name, clock(s.start))}>{'▶ ' + clock(s.start)}</button>
          : null}
      </div>
      <div class="rv-url">{s.url || t.noPage}</div>
      {s.title ? <div class="rv-ttl">{s.title}</div> : null}
      {/* A missed expect is already one of the run's notes ("expected text not on the
          page: …"), so only the found one gets a line of its own. */}
      {s.expect && (s.expect.found || !(s.notes || []).length)
        ? <div class={'rv-line ' + (s.expect.found ? 'ok' : 'bad')}>{t.expect(s.expect)}</div>
        : null}
      {(s.notes || []).map((n, i) => <div key={i} class="rv-line warn">{n}</div>)}
      {s.src ? <img class="rv-shot" src={s.src} alt={s.name} loading="lazy" /> : null}
      <Requests list={s.requests || []} t={t} />
      {recorded
        ? <Note value={note} label={t.chapterNoteLabel(s.n)}
                placeholder={flagged ? t.reasonPlaceholder : t.chapterPlaceholder}
                onInput={(x) => onChapterNote(s.n, x)} />
        : <Fragment>
            <div class="seg rv-mark" role="group" aria-label={t.markLabel(s.n)}>
              {t.marks.map(m => (
                <button key={m.v} type="button" class={(mark.v === m.v ? 'on ' : '') + m.v}
                        aria-pressed={mark.v === m.v ? 'true' : 'false'}
                        onClick={() => onStep(s.n, mark.v === m.v ? '' : m.v)}>{m.label}</button>
              ))}
            </div>
            <Note value={note} label={t.stepNoteLabel(s.n)}
                  placeholder={flagged ? t.reasonPlaceholder : t.notePlaceholder}
                  onInput={(x) => onStepNote(s.n, x)} />
          </Fragment>}
    </section>
  );
}

// The video and its chapters. The strip is the run at a glance — one segment per step, as
// wide as the step was long, the flagged ones in the warning hue — and a tap on one plays
// from there. The steps below carry the same jump, by name.
function Player({ run, t, video, cur, setCur, onSeek }) {
  const steps = run.steps.filter(s => s.start != null);
  const total = run.duration || (steps.length ? steps[steps.length - 1].end : 0) || 1;
  useEffect(() => {
    const el = video.current;
    if (!el) return undefined;
    const tick = () => {
      const tm = el.currentTime;
      let k = 0;
      steps.forEach((s, i) => { if (tm + 0.05 >= s.start) k = i; });
      setCur(steps[k] ? steps[k].n : 0);
    };
    el.addEventListener('timeupdate', tick);
    el.addEventListener('seeked', tick);
    return () => { el.removeEventListener('timeupdate', tick); el.removeEventListener('seeked', tick); };
  }, [run.id]);
  const now = steps.find(s => s.n === cur) || steps[0];
  return (
    <div class="rv-player">
      {/* playsinline: without it an iPhone takes the video full screen on play, and the
          chapters, the steps and the verdict all go with the page behind it. */}
      <video ref={video} class="rv-video" src={run.videoSrc} controls playsInline preload="metadata" />
      <div class="rv-strip" role="group" aria-label={t.chapters}>
        {steps.map(s => (
          <button key={s.n} type="button" style={`flex-grow:${Math.max(0.2, ((s.end ?? total) - s.start) / total)}`}
                  class={'rv-ch' + (s.notes && s.notes.length ? ' flag' : '') + (s.n === cur ? ' on' : '')}
                  aria-label={t.playFrom(s.name, clock(s.start))} title={s.name} onClick={() => onSeek(s)}>
            {String(s.n)}
          </button>
        ))}
      </div>
      {now ? <div class="rv-now"><b>{String(now.n).padStart(2, '0')}</b> {now.name} <span>{clock(now.start)}</span></div> : null}
    </div>
  );
}

function Provenance({ run, t }) {
  const p = run.provenance || {};
  const rows = [
    [t.prov.commit, p.commit ? `${p.commit}${p.dirty ? ' ' + t.dirty : ''}` : '—'],
    [t.prov.base, p.base || '—'],
    [t.prov.viewport, p.viewport ? `${p.viewport.width}×${p.viewport.height}` : '—'],
    [t.prov.at, t.when(run.at)],
    [t.prov.session, p.session || '—'],
    [t.prov.run, run.id],
  ];
  return (
    <dl class="rv-prov">
      {rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
    </dl>
  );
}

// THE VERDICT IS PINNED, like the composer: it is the one thing this screen is for, and a
// control you scroll past five steps of requests to reach is one that does not get used.
// The gate line is `fleet-shots --check`'s own answer for this run, in its hue.
function Bar({ run, t, v, gate, save, onFlow, onRestOk, onRetry }) {
  const fv = (v.flow || {}).v || '';
  const unmarked = run.kind === 'recorded' ? 0 : run.steps.filter(s => !(v[String(s.n)] || {}).v).length;
  return (
    <div class="rv-bar">
      <div class={'rv-gate ' + (gate.cls || 'warn')}>
        <span class="rv-dot" aria-hidden="true" />
        <span class="rv-gt">{gate.text}</span>
        {save === 'failed'
          ? <button type="button" class="rv-retry" onClick={onRetry}>{t.retry}</button>
          : <span class="rv-saved">{save ? t.save[save] : ''}</span>}
      </div>
      {run.kind === 'recorded'
        ? <div class="rv-acts">
            <button type="button" class={'danger' + (fv === 'reject' ? ' on' : '')} aria-pressed={fv === 'reject' ? 'true' : 'false'}
                    title={t.keys.reject} onClick={() => onFlow(fv === 'reject' ? '' : 'reject')}>{t.reject}</button>
            <button type="button" class={'go' + (fv === 'approve' ? ' on' : '')} aria-pressed={fv === 'approve' ? 'true' : 'false'}
                    title={t.keys.approve} onClick={() => onFlow(fv === 'approve' ? '' : 'approve')}>{fv === 'approve' ? t.approved : t.approve}</button>
          </div>
        : unmarked
          ? <div class="rv-acts"><button type="button" class="go" onClick={onRestOk}>{t.restOk(unmarked)}</button></div>
          : null}
    </div>
  );
}

export function ReviewScreen(p) {
  const { run, t } = p;
  const video = useRef(null);
  const [cur, setCur] = useState(0);
  const body = useRef(null);
  // ← → and space at a desk reach the video through here: app.js owns the keys, this owns
  // the element. Registered per mount, dropped on the way out.
  useEffect(() => {
    if (!p.onPlayer) return undefined;
    p.onPlayer({
      toggle: () => { const el = video.current; if (el) (el.paused ? el.play().catch(() => {}) : el.pause()); },
      step: (d) => {
        const st = run ? run.steps.filter(s => s.start != null) : [];
        const i = Math.max(0, st.findIndex(s => s.n === cur));
        const s = st[Math.min(st.length - 1, Math.max(0, i + d))];
        if (s) seek(s);
      },
    });
    return () => p.onPlayer(null);
  });
  const seek = (s) => {
    const el = video.current;
    if (!el || s.start == null) return;
    el.currentTime = s.start + 0.01;
    setCur(s.n);
    el.play().catch(() => {});
    // From a step far down the list, the picture is what was asked for — bring it back.
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
  };
  if (!run) {
    return (
      <Fragment>
        <Header scope={p.scope} mode={p.mode} stale={p.stale} onBack={p.onBack} />
        <div class="rv-body"><div class="rv-wait">{p.err || t.loading}</div></div>
      </Fragment>
    );
  }
  const v = p.verdict || {};
  return (
    <Fragment>
      <Header scope={p.scope} mode={p.mode} stale={p.stale} onBack={p.onBack} />
      <div class="rv-body" ref={body}>
        <div class="rv-col">
          <div class="rv-head">
            <div class="rv-br">{run.branch || t.noBranch}</div>
            <div class="rv-meta">{p.where}</div>
          </div>
          {run.kind === 'recorded'
            ? <Fragment>
                <Player run={run} t={t} video={video} cur={cur} setCur={setCur} onSeek={seek} />
                <Note value={(v.flow || {}).note || ''} label={t.flowNoteLabel} placeholder={t.flowPlaceholder}
                      onInput={p.onFlowNote} />
              </Fragment>
            : null}
          <h2 class="rv-h">{t.steps(run.steps.length)}</h2>
          {run.steps.map(s => (
            <Step key={s.n} s={s} run={run} t={t} v={v} cur={run.kind === 'recorded' && s.n === cur}
                  onSeek={seek} onStep={p.onStep} onStepNote={p.onStepNote} onChapterNote={p.onChapterNote} />
          ))}
          <h2 class="rv-h">{t.provenance}</h2>
          <Provenance run={run} t={t} />
        </div>
      </div>
      {p.toast ? <div class={('toast ' + (p.toast.kind || '')).trim()}>{p.toast.text}</div> : null}
      <Bar run={run} t={t} v={v} gate={p.gate} save={p.save} onFlow={p.onFlow} onRestOk={p.onRestOk} onRetry={p.onRetry} />
    </Fragment>
  );
}
