// Automations: a trigger and steps, built with blocks you drag (or tap, on a phone), or by
// asking the AI tab beside the editor, which writes the draft into the same blocks. Either way
// the person sees what will run and saves it; the server runs it (server/automations.mjs).
import { useState, useRef, useEffect } from 'preact/hooks';
import { api } from './api.js';
import { Btn, Confirm, usePoll, clock, toast } from '../../../../web/ui/ui.jsx';
import { ACTIONS, EVENTS, STATES, DAY_NAMES, SCOPES, TEMPLATES, blankTrigger, blankStep, describeTrigger, describeStep, everyWords } from '../../shared/automations.js';
// `t` is a trigger or a template all through this file, so the words come in as `tr`.
import { t as tr, locale } from './i18n.js';
import { Icon } from '../../../../web/ui/icon.jsx';
import { useKeys } from '../../../../web/ui/keyboard.jsx';

const EVERY = [15, 30, 60, 120, 180, 360, 720, 1440];
const blank = () => ({ id: null, name: '', enabled: true, scope: 'personal', trigger: blankTrigger('schedule'), steps: [] });
const TAB_KEY = 'gfw.autosTab';
const SEEN_KEY = 'gfw.noticesSeen';
export const noticesSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
export const markNoticesSeen = (at) => { try { localStorage.setItem(SEEN_KEY, String(at)); } catch {} };
const short = (ts) => new Date(ts * 1000).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// ── the list ─────────────────────────────────────────────────────────────────────────
export function Automations({ ctx, projects, id }) {
  const { data, error, reload } = usePoll(() => api.automations(), 10000, []);
  const [tab, setTabState] = useState(() => { try { return localStorage.getItem(TAB_KEY) || 'mine'; } catch { return 'mine'; } });
  const setTab = (t) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch {} };
  // The editor offers only the projects this person can read (the server says which).
  const mineOnly = data?.me ? (projects || []).filter(p => data.me.projects.includes(p.name)) : projects;
  // The phone client's Automations keys (web/ui/keyboard.jsx): n a new one, q / ` back to
  // home from the list, and from one automation back to the list.
  useKeys((key) => {
    if (key.ctrl || key.alt) return false;
    if (key.k === 'q' || key.k === '`') { ctx.go(id ? '/automations' : '/'); return true; }
    if (key.k === 'n' && !id) { ctx.go('/automations/new'); return true; }
    return false;
  });
  if (id) return <Editor ctx={ctx} projects={mineOnly} data={data} id={id} onSaved={reload} />;
  const admin = !!data?.me?.admin;
  const all = data?.automations || [];
  const tabs = [['mine', tr('project.mine'), all.filter(a => a.scope === 'personal' && a.mine)],
                ['company', tr('autos.company'), all.filter(a => a.scope === 'company')],
                ...(admin ? [['others', tr('autos.others'), all.filter(a => a.scope === 'personal' && !a.mine)]] : [])];
  const cur = tabs.find(t => t[0] === tab) || tabs[0];
  const list = cur[2];
  const templates = Object.entries(TEMPLATES).filter(([, t]) => t.scope === 'personal' || admin);
  const seenAt = noticesSeen();
  const fresh = (data?.notices || []).filter(n => n.at > seenAt);
  return (
    <div class="page autos">
      <header class="page-head">
        <div><h1>{tr('nav.automations')}</h1><p class="muted">{tr('autos.sub')}</p></div>
        <Btn kind="primary" icon="plus" onClick={() => ctx.go('/automations/new')}>{tr('project.new')}</Btn>
      </header>
      {error ? <p class="err">{error.message}</p> : null}
      {fresh.length ? (
        <section class="notices">
          {fresh.map(n => <div key={n.id} class={`notice k-${n.kind}`}><span class="when">{clock(n.at)}</span> {n.text}</div>)}
          <Btn kind="ghost sm" onClick={() => { markNoticesSeen(fresh[0].at); reload(); }}>{tr('autos.seen')}</Btn>
        </section>
      ) : null}
      <section class="templates" aria-label={tr('autos.templates')}>
        {templates.map(([k, t]) => (
          <button key={k} class="tpl" onClick={() => ctx.go(`/automations/template-${k}`)}>
            <b>{t.name}</b> <span class={`tag${t.scope === 'company' ? ' team' : ''}`}>{SCOPES[t.scope]}</span>
            <span class="muted small">{t.hint}</span>
          </button>
        ))}
      </section>
      <div class="seg autos-tabs" role="tablist">
        {tabs.map(([k, label, items]) => (
          <button key={k} role="tab" aria-selected={cur[0] === k} class={cur[0] === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label} <span class="muted">{items.length}</span>
          </button>
        ))}
      </div>
      {data && !list.length ? (
        <div class="empty">
          {cur[0] === 'company' ? <>
            <b>{admin ? tr('autos.noCompany') : tr('autos.noCompanyMine')}</b>
            <span class="muted">{admin ? tr('autos.companyWhoAdmin') : tr('autos.companyWho')}</span>
          </> : cur[0] === 'others' ? <b>{tr('autos.noOthers')}</b> : <>
            <b>{tr('autos.none')}</b>
            <span class="muted">{tr('autos.example')}</span>
            <Btn kind="primary" onClick={() => ctx.go('/automations/new')}>{tr('autos.createFirst')}</Btn>
          </>}
        </div>
      ) : null}
      <div class="auto-list">
        {list.map(a => <AutoCard key={a.id} a={a} ctx={ctx} onChange={reload} />)}
      </div>
      {(data?.runs || []).length ? (
        <section class="runs">
          <h2>{tr('autos.runs')}</h2>
          {data.runs.map((r, i) => (
            <details key={i} class="run">
              <summary>
                <span class={`run-st s-${r.status}`}>{r.status === 'ok' ? '✓' : r.status === 'skipped' ? '↷' : '✕'}</span>
                <span class="when">{clock(r.at)}</span>
                <b class="ellipsis">{r.name}</b>
                <span class="muted ellipsis grow">{r.status === 'skipped' ? tr('autos.skipped', { why: r.text }) : r.trigger}</span>
              </summary>
              {(r.steps || []).map((s, j) => <div key={j} class={`run-step${s.ok ? '' : ' bad'}`}>{s.halt ? <Icon name="stop" /> : s.ok ? '✓' : '✕'} {s.what}{s.text ? <small> — {s.text}</small> : null}</div>)}
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function AutoCard({ a, ctx, onChange }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    try { await api.saveAutomation({ ...a, enabled: !a.enabled }); onChange(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  const runNow = async () => {
    setBusy(true);
    try { const r = await api.runAutomation(a.id); toast(r.ok ? tr('autos.ran', { name: a.name }) : r.text, r.ok ? 'good' : 'bad'); onChange(); }
    catch (e) { toast(e.message, 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <article class={`auto-card${a.enabled ? '' : ' off'}`}>
      <div class="auto-top">
        <label class="switch" title={a.enabled ? tr('autos.on') : tr('autos.off')}>
          <input type="checkbox" checked={a.enabled} onChange={toggle} disabled={!a.editable && !(a.enabled && a.scope === 'personal')} aria-label={tr(a.enabled ? 'autos.turnOff' : 'autos.turnOn', { name: a.name })} /><i />
        </label>
        <a class="auto-name" href={`#/automations/${a.id}`}>{a.name}</a>
        <span class={`tag${a.scope === 'company' ? ' team' : ''}`}>{SCOPES[a.scope]}</span>
        {!a.mine ? <span class="muted small">{tr('autos.ownedBy', { name: a.ownerName })}</span> : null}
      </div>
      {a.paused && !a.enabled ? <div class="notice k-warn">{tr('autos.paused', { why: a.paused.why })}</div> : null}
      <div class="auto-flow">
        <span class="chip-trigger"><Icon name={a.trigger.type === 'event' ? 'bolt' : 'clock'} /> {describeTrigger(a.trigger)}</span>
        {a.steps.map((s, i) => <span key={i} class="chip-step"><i>→</i> <Icon name={ACTIONS[s.action]?.icon} /> {describeStep(s)}</span>)}
      </div>
      <div class="auto-foot">
        <span class="muted small">
          {a.running ? tr('autos.running') : a.nextRun ? tr('autos.next', { when: short(a.nextRun) }) : a.trigger.type === 'event' && a.enabled ? tr('autos.waitingEvent') : a.enabled ? '' : tr('autos.off')}
          {a.lastRun ? ` · ${tr('autos.last', { when: short(a.lastRun.at) })} ${a.lastRun.ok ? '✓' : '✕'}` : ''}
        </span>
        <span class="grow" />
        {a.editable ? <>
          <Btn kind="ghost sm" disabled={busy} onClick={runNow}>{busy ? tr('autos.runningBtn') : <><Icon name="play" /> {tr('autos.tryNow')}</>}</Btn>
          <Btn kind="ghost sm" onClick={() => ctx.go(`/automations/${a.id}`)}>{tr('autos.edit')}</Btn>
        </> : <Btn kind="ghost sm" onClick={() => ctx.go(`/automations/${a.id}`)}>{tr('autos.view')}</Btn>}
        {a.editable || a.scope === 'personal' ? <Btn kind="ghost sm" onClick={() => setAsk(true)} aria-label={tr('vp.delete', { name: a.name })}><Icon name="close" /></Btn> : null}
      </div>
      {ask ? <Confirm title={tr('autos.delTitle')} danger action={tr('common.delete')}
                      body={<p>{tr('autos.delBody.a')}<b>{a.name}</b>{tr('autos.delBody.b')}</p>}
                      onYes={async () => { await api.deleteAutomation(a.id); onChange(); }} onClose={() => setAsk(false)} /> : null}
    </article>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────────────
function Editor({ ctx, projects, data, id, onSaved }) {
  const tpl = id.startsWith('template-') ? TEMPLATES[id.slice('template-'.length)] : null;
  const fresh = id === 'new' || !!tpl;
  const existing = !fresh ? data?.automations?.find(a => a.id === id) : null;
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('edit');             // phones: editor or AI, one at a time
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!draft && (fresh || existing)) setDraft(existing ? structuredClone(existing) : tpl ? tpl.build() : blank()); }, [existing, id]);
  const admin = !!data?.me?.admin;
  const readOnly = existing && !existing.editable;
  if (!draft) return <div class="page"><p class="muted">{data ? tr('autos.notFound') : tr('common.loading')}</p></div>;
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setTrigger = (patch) => setDraft(d => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const setStep = (i, patch) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const insert = (action, at) => setDraft(d => { const steps = [...d.steps]; steps.splice(at ?? steps.length, 0, blankStep(action)); return { ...d, steps }; });
  const move = (from, to) => setDraft(d => {
    const steps = [...d.steps]; const [s] = steps.splice(from, 1); steps.splice(to > from ? to - 1 : to, 0, s); return { ...d, steps };
  });
  const remove = (i) => setDraft(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveAutomation(draft);
      toast(tr(r.automation.enabled ? 'autos.saved' : 'autos.savedOff', { name: r.automation.name }), 'good');
      onSaved(); ctx.go('/automations');
    } catch (e) { toast(e.message, 'bad'); }
    finally { setSaving(false); }
  };
  const isEvent = draft.trigger.type === 'event';
  return (
    <div class="page autos-edit">
      <header class="page-head">
        <div class="grow">
          <a class="muted small" href="#/automations">← {tr('nav.automations')}</a>
          <input class="auto-title" placeholder={tr('autos.namePh')} value={draft.name}
                 onInput={(e) => set({ name: e.currentTarget.value })} aria-label={tr('auth.name')} />
        </div>
        <div class="row wrap">
          {/* A member makes personal ones only, so there is nothing to choose: no company option at all. */}
          {admin && !readOnly ? (
            <select class="scope-pick" value={draft.scope} onChange={(e) => set({ scope: e.currentTarget.value })} aria-label={tr('autos.scope')}>
              <option value="personal">{tr('autos.scopePersonal')}</option>
              <option value="company">{tr('autos.scopeCompany')}</option>
            </select>
          ) : <span class={`tag${draft.scope === 'company' ? ' team' : ''}`} aria-label={tr('autos.scope')}>{SCOPES[draft.scope]}</span>}
          <label class="switch-l"><span class="switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} /><i /></span> {tr('autos.on')}</label>
          <Btn kind="primary" disabled={saving || readOnly} onClick={save}>{saving ? tr('common.saving') : tr('common.save')}</Btn>
        </div>
      </header>
      {readOnly ? <p class="notice k-warn">{existing.scope === 'company' ? tr('autos.roCompany') : tr('autos.roPersonal', { name: existing.ownerName })}</p> : null}
      {existing?.paused && !existing.enabled ? <p class="notice k-warn">{tr('autos.paused', { why: existing.paused.why })}</p> : null}
      <div class="tabs-m" role="tablist">
        <button class={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>{tr('autos.editor')}</button>
        <button class={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>✦ {tr('autos.askAI')}</button>
      </div>
      <div class={`builder show-${tab}`}>
        <Palette onAdd={(a) => insert(a)} onTrigger={(t) => setTrigger(blankTrigger(t))} />
        <div class="flow" aria-label={tr('autos.flow')}>
          <TriggerBlock t={draft.trigger} projects={projects} onChange={setTrigger} onType={(t) => set({ trigger: blankTrigger(t) })} />
          {draft.steps.map((s, i) => (
            <div key={i} class="flow-item">
              <Drop at={i} onAdd={insert} onMove={move} />
              <StepBlock s={s} i={i} n={draft.steps.length} isEvent={isEvent} projects={projects}
                         onChange={(p) => setStep(i, p)} onRemove={() => remove(i)} onMove={move} />
            </div>
          ))}
          <Drop at={draft.steps.length} onAdd={insert} onMove={move} last empty={!draft.steps.length} />
        </div>
        <AIPanel draft={draft} onDraft={(a) => setDraft(d => ({ ...d, ...a, id: d.id, scope: d.scope, enabled: d.enabled }))} />
      </div>
    </div>
  );
}

function Palette({ onAdd, onTrigger }) {
  const drag = (e, kind, v) => { e.dataTransfer.setData('text/plain', `${kind}:${v}`); e.dataTransfer.effectAllowed = 'copy'; };
  return (
    <aside class="palette" aria-label={tr('autos.blocks')}>
      <h3>{tr('autos.triggers')}</h3>
      <button class="blk trig" draggable onDragStart={(e) => drag(e, 'trigger', 'schedule')} onClick={() => onTrigger('schedule')}><Icon name="clock" /> {tr('autos.schedule')}</button>
      <button class="blk trig" draggable onDragStart={(e) => drag(e, 'trigger', 'event')} onClick={() => onTrigger('event')}><Icon name="bolt" /> {tr('autos.sessionEvent')}</button>
      <h3>{tr('autos.actions')}</h3>
      {Object.entries(ACTIONS).map(([k, d]) => (
        <button key={k} class={`blk${d.danger ? ' danger' : ''}`} draggable onDragStart={(e) => drag(e, 'action', k)} onClick={() => onAdd(k)}
                title={tr('autos.dragHint')}>
          <span class="blk-ico"><Icon name={d.icon} /></span> {d.label}
        </button>
      ))}
      <p class="muted small">{tr('autos.dragHelp')}</p>
    </aside>
  );
}

function Drop({ at, onAdd, onMove, last, empty }) {
  const [over, setOver] = useState(false);
  const onDrop = (e) => {
    e.preventDefault(); setOver(false);
    const [kind, v] = e.dataTransfer.getData('text/plain').split(':');
    if (kind === 'action' && ACTIONS[v]) onAdd(v, at);
    if (kind === 'move') onMove(Number(v), at);
  };
  return (
    <div class={`drop${over ? ' over' : ''}${last ? ' last' : ''}${empty ? ' empty' : ''}`}
         onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      {empty ? tr('autos.dropEmpty') : last ? `＋ ${tr('autos.dropLast')}` : null}
    </div>
  );
}

function TriggerBlock({ t, projects, onChange, onType }) {
  const [over, setOver] = useState(false);
  const sessions = (projects || []).find(p => p.name === t.project)?.sessions || [];
  return (
    <section class={`node trigger${over ? ' over' : ''}`}
             onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
             onDrop={(e) => { e.preventDefault(); setOver(false); const [k, v] = e.dataTransfer.getData('text/plain').split(':'); if (k === 'trigger') onType(v); }}>
      <header><span class="node-k">{tr('autos.when')}</span>
        <div class="seg">
          <button class={t.type === 'schedule' ? 'on' : ''} onClick={() => t.type !== 'schedule' && onType('schedule')}><Icon name="clock" /> {tr('autos.schedule')}</button>
          <button class={t.type === 'event' ? 'on' : ''} onClick={() => t.type !== 'event' && onType('event')}><Icon name="bolt" /> {tr('autos.event')}</button>
        </div>
      </header>
      {t.type === 'schedule' ? (
        <div class="node-body">
          <div class="seg sm">
            <button class={t.mode === 'days' ? 'on' : ''} onClick={() => onChange({ mode: 'days' })}>{tr('autos.someDays')}</button>
            <button class={t.mode === 'once' ? 'on' : ''} onClick={() => onChange({ mode: 'once' })}>{tr('autos.once')}</button>
            <button class={t.mode === 'every' ? 'on' : ''} onClick={() => onChange({ mode: 'every' })}>{tr('autos.everySoOften')}</button>
          </div>
          {t.mode === 'days' ? (
            <div class="days" role="group" aria-label={tr('autos.days')}>
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <button key={d} class={t.days.includes(d) ? 'on' : ''} aria-pressed={t.days.includes(d)}
                        onClick={() => onChange({ days: t.days.includes(d) ? t.days.filter(x => x !== d) : [...t.days, d] })}>{DAY_NAMES[d]}</button>
              ))}
            </div>
          ) : null}
          {t.mode === 'once' ? <label class="field"><span>{tr('autos.date')}</span><input type="date" value={t.date} onInput={(e) => onChange({ date: e.currentTarget.value })} /></label> : null}
          {t.mode !== 'every' ? <label class="field"><span>{tr('autos.time')}</span><input type="time" value={t.at} onInput={(e) => onChange({ at: e.currentTarget.value })} /></label> : (
            <label class="field"><span>{tr('autos.every')}</span>
              <select value={t.minutes} onChange={(e) => onChange({ minutes: Number(e.currentTarget.value) })}>
                {EVERY.map(m => <option key={m} value={m}>{everyWords(m)}</option>)}
              </select>
            </label>
          )}
        </div>
      ) : (
        <div class="node-body">
          <label class="field"><span>{tr('autos.whenSession')}</span>
            <select value={t.event} onChange={(e) => onChange({ event: e.currentTarget.value })}>
              {Object.entries(EVENTS).map(([k, d]) => <option key={k} value={k}>{d.label} ({d.hint})</option>)}
            </select>
          </label>
          <div class="row wrap">
            <label class="field grow"><span>{tr('autos.whichProject')}</span>
              <select value={t.project} onChange={(e) => onChange({ project: e.currentTarget.value, session: '*' })}>
                <option value="*">{tr('autos.anyProject')}</option>
                {(projects || []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </label>
            <label class="field grow"><span>{tr('autos.whichSession')}</span>
              <select value={t.session} onChange={(e) => onChange({ session: e.currentTarget.value })} disabled={t.project === '*'}>
                <option value="*">{tr('autos.any')}</option>
                {sessions.map(s => <option key={s.name} value={s.name}>{s.lead ? `${s.name} (${tr('common.lead')})` : s.name}</option>)}
              </select>
            </label>
          </div>
          <label class="field"><span>{tr('autos.cooldown')}</span>
            <input type="number" min="1" max="1440" value={t.cooldown} onInput={(e) => onChange({ cooldown: Number(e.currentTarget.value) })} />
          </label>
        </div>
      )}
      <p class="node-say">{describeTrigger(t)}</p>
    </section>
  );
}

function StepBlock({ s, i, n, isEvent, projects, onChange, onRemove, onMove }) {
  const d = ACTIONS[s.action];
  const [grab, setGrab] = useState(false);
  const fromEvent = s.project === '{proyecto}';
  const sessions = (projects || []).find(p => p.name === s.project)?.sessions || [];
  const has = (f) => d.needs.includes(f) || d.optional?.includes(f);
  return (
    <section class={`node step${d.danger ? ' danger' : ''}${grab ? ' grab' : ''}`} draggable={grab}
             onDragStart={(e) => { e.dataTransfer.setData('text/plain', `move:${i}`); e.dataTransfer.effectAllowed = 'move'; }}
             onDragEnd={() => setGrab(false)}>
      <header>
        <span class="handle" title={tr('autos.dragMove')} onMouseDown={() => setGrab(true)} onMouseUp={() => setGrab(false)}>⋮⋮</span>
        <span class="node-k">{i + 1}. <Icon name={d.icon} /> {d.label}</span>
        <span class="grow" />
        <button class="icon-btn" disabled={i === 0} onClick={() => onMove(i, i - 1)} aria-label={tr('autos.up')}>↑</button>
        <button class="icon-btn" disabled={i === n - 1} onClick={() => onMove(i, i + 2)} aria-label={tr('autos.down')}>↓</button>
        <button class="icon-btn" onClick={onRemove} aria-label={tr('autos.removeStep')}>✕</button>
      </header>
      <div class="node-body">
        {has('project') ? (
          <div class="row wrap">
            <label class="field grow"><span>{tr('autos.project')}</span>
              <select value={s.project} onChange={(e) => {
                const v = e.currentTarget.value;
                // A session of the same name there (a template's 'master') stays chosen.
                const keep = (projects || []).find(p => p.name === v)?.sessions.some(x => x.name === s.session);
                onChange(v === '{proyecto}' ? { project: v, session: '{sesion}' } : { project: v, session: keep ? s.session : '' });
              }}>
                <option value="">{tr('autos.choose')}</option>
                {isEvent ? <option value="{proyecto}">{tr('autos.eventProject')}</option> : null}
                {(projects || []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </label>
            {has('session') ? (
              <label class="field grow"><span>{tr('autos.session')}</span>
                <select value={s.session} onChange={(e) => onChange({ session: e.currentTarget.value })} disabled={!s.project}>
                  <option value="">{tr('autos.choose')}</option>
                  {isEvent ? <option value="{sesion}">{tr('auto.step.eventSession')}</option> : null}
                  {!fromEvent ? sessions.map(x => <option key={x.name} value={x.name}>{x.lead ? `${x.name} (${tr('common.lead')})` : x.name}</option>) : null}
                </select>
              </label>
            ) : null}
            {has('name') ? (
              <label class="field grow"><span>{tr('autos.newName')}</span>
                <input value={s.name} placeholder="revision-{fecha}" onInput={(e) => onChange({ name: e.currentTarget.value })} />
              </label>
            ) : null}
          </div>
        ) : null}
        {has('prompt') ? (
          <label class="field"><span>{s.action === 'send' ? tr('sched.message') : s.action === 'spawn' ? tr('autos.firstTask') : tr('autos.resumeMsg')}</span>
            <textarea rows={3} value={s.prompt} placeholder={tr('autos.vars')}
                      onInput={(e) => onChange({ prompt: e.currentTarget.value })} />
          </label>
        ) : null}
        {has('branch') ? <label class="field"><span>{tr('autos.branchOpt')}</span><input value={s.branch} onInput={(e) => onChange({ branch: e.currentTarget.value })} /></label> : null}
        {s.action === 'notify' ? <label class="field"><span>{tr('autos.noticeText')}</span><input value={s.text} placeholder={tr('autos.noticePh')} onInput={(e) => onChange({ text: e.currentTarget.value })} /></label> : null}
        {s.action === 'check' ? (
          <div class="field"><span>{tr('autos.ifNow')}</span>
            <div class="days states" role="group" aria-label={tr('autos.states')}>
              {Object.entries(STATES).map(([k, label]) => (
                <button key={k} class={s.status.includes(k) ? 'on' : ''} aria-pressed={s.status.includes(k)}
                        onClick={() => onChange({ status: s.status.includes(k) ? s.status.filter(x => x !== k) : [...s.status, k] })}>{label}</button>
              ))}
            </div>
            <small class="muted">{tr('autos.checkHint')}</small>
          </div>
        ) : null}
        {s.action === 'summary' ? <p class="muted small">{tr('autos.summaryHint')}</p> : null}
        {s.action === 'wait' ? <label class="field"><span>{tr('autos.minutes')}</span><input type="number" min="1" max="60" value={s.minutes} onInput={(e) => onChange({ minutes: Number(e.currentTarget.value) })} /></label> : null}
        {d.danger ? (
          <label class="check danger"><input type="checkbox" checked={s.confirmed} onChange={(e) => onChange({ confirmed: e.currentTarget.checked })} />
            {tr('autos.confirmStop')}</label>
        ) : null}
      </div>
    </section>
  );
}

// ── the AI tab: say it, it fills the blocks ───────────────────────────────────────────
function AIPanel({ draft, onDraft }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState(null);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);
  const ask = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next = [...msgs, { role: 'user', text: t }];
    setMsgs(next); setText(''); setBusy(true);
    try {
      const has = draft.steps.length || draft.name;
      const r = await api.automationAI(next, has ? { name: draft.name, trigger: draft.trigger, steps: draft.steps } : null);
      setMsgs(m => [...m, { role: 'ai', text: r.reply, applied: !!r.automation }]);
      if (r.automation) { setUndo(structuredClone(draft)); onDraft(r.automation); }
    } catch (e) { setMsgs(m => [...m, { role: 'ai', text: tr('autos.aiFailed', { why: e.message }), error: true }]); }
    finally { setBusy(false); }
  };
  return (
    <aside class="ai-panel" aria-label={tr('autos.askAI')}>
      <h3><Icon name="spark" /> {tr('autos.askAI')}</h3>
      <div class="ai-msgs">
        {!msgs.length ? <p class="muted small">{tr('autos.aiHint')}</p> : null}
        {msgs.map((m, i) => (
          <div key={i} class={`ai-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.text}
            {m.applied ? <small class="ai-applied">✓ {tr('autos.aiApplied')}{undo && i === msgs.length - 1 ? <> · <a href="#" onClick={(e) => { e.preventDefault(); onDraft(undo); setUndo(null); }}>{tr('autos.undo')}</a></> : null}</small> : null}
          </div>
        ))}
        {busy ? <div class="ai-msg ai muted">{tr('autos.aiBusy')}</div> : null}
        <div ref={end} />
      </div>
      <div class="ai-input">
        <textarea rows={2} value={text} placeholder={tr('autos.aiPh')} onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        <Btn kind="primary" disabled={busy || !text.trim()} onClick={ask}>{tr('common.send')}</Btn>
      </div>
    </aside>
  );
}
