// web/src/automations.jsx — the automations screen: the list (with what ran and what needs a
// look), and the editor that builds one by taps or by asking for it in a sentence. EXPERIMENTAL
// (lib/automations.mjs); app.js mounts it only while /api/projects says the switch is on.
//
// THE SAME SEAM AS screens.jsx, with one deliberate difference. The data, the navigation and
// every request are app.js's (automationsProps): what was read, which automation is open, the
// save that may need a passkey first. What lives HERE is the editor's draft — a form being
// filled in, which has no first place in app.js's S to be a second copy of. It dies with the
// editor, which is what an unsaved draft should do.
//
// The words are this screen's own: there is no TUI screen for automations, so there is no
// TUI wording for pwa-check to hold them to.
import { Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { Header, Btn } from './screens.jsx';
import { ACTIONS, EVENTS, STATES, DAY_NAMES, EVENT_PROJECT, EVENT_SESSION, blankTrigger, blankStep, blankAutomation,
         describeTrigger, describeStep, everyWords, needsPasskey } from '../../lib/automations-model.mjs';

const EVERY = [15, 30, 60, 120, 180, 360, 720, 1440];
const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clone = (v) => JSON.parse(JSON.stringify(v));

export function AutomationsScreen(p) {
  return (
    <Fragment>
      <Header scope={p.editing ? (p.editing === 'new' ? '— new automation' : '— edit automation') : '— automations'}
              mode={p.mode} stale={p.stale} onBack={p.onBack} />
      {/* .cards IS THE SCROLLING REGION (app.css: #app.shell > .cards), as on every screen. */}
      <div class="cards autos">
        {p.data == null ? <p class="autos-dim">reading…</p>
          : p.editing ? <Editor key={p.editing} {...p} />
          : <List {...p} />}
      </div>
      {p.toast ? <div class={('toast ' + (p.toast.kind || '')).trim()}>{p.toast.text}</div> : null}
    </Fragment>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────────────
function List({ data, onEdit, onSave, onDelete, onRun, onSeen }) {
  const list = data.automations || [];
  const unseen = (data.notices || []).filter(n => !n.seen);
  return (
    <Fragment>
      {unseen.length ? (
        <section class="autos-notices">
          {unseen.map(n => <div key={n.id} class={`autos-notice k-${n.kind}`}><span class="autos-when">{when(n.at)}</span> {n.text}</div>)}
          <Btn label="seen" onClick={onSeen} />
        </section>
      ) : null}
      <div class="autos-top"><Btn label="new automation" cls="go" onClick={() => onEdit('new')} /></div>
      {!list.length ? (
        <p class="autos-dim">
          None yet. One is a trigger and some steps — for example "weekdays at 09:00, send the lead of acme-api:
          review what is open", or "when any session in acme-web needs you, tell me".
        </p>
      ) : null}
      {list.map(a => <Item key={a.id} a={a} onEdit={onEdit} onSave={onSave} onDelete={onDelete} onRun={onRun} />)}
      {(data.runs || []).length ? (
        <section class="autos-runs">
          <h3>last runs</h3>
          {data.runs.map((r, i) => (
            <details key={i} class="autos-run">
              <summary>
                <span class={`autos-st s-${r.status}`}>{r.status === 'ok' ? '✓' : r.status === 'skipped' ? '↷' : '✕'}</span>
                <span class="autos-when">{when(r.at)}</span>
                <b>{r.name}</b>
                <span class="autos-dim">{r.status === 'skipped' ? `skipped: ${r.text}` : r.trigger}</span>
              </summary>
              {(r.steps || []).map((s, j) => <div key={j} class={`autos-step-run${s.ok ? '' : ' bad'}`}>{s.halt ? '⏹' : s.ok ? '✓' : '✕'} {s.what}{s.text ? <small> — {s.text}</small> : null}</div>)}
            </details>
          ))}
        </section>
      ) : null}
    </Fragment>
  );
}

function Item({ a, onEdit, onSave, onDelete, onRun }) {
  const [sure, setSure] = useState(false);
  const status = a.running ? 'running now…'
    : a.nextRun ? `next ${when(a.nextRun)}`
    : a.enabled && a.trigger.type === 'event' ? 'waiting for the event' : a.enabled ? '' : 'off';
  return (
    <article class={`autos-item${a.enabled ? '' : ' off'}`}>
      <div class="autos-head">
        <button class={`autos-sw${a.enabled ? ' on' : ''}`} role="switch" aria-checked={a.enabled}
                aria-label={`${a.enabled ? 'switch off' : 'switch on'} ${a.name}`}
                onClick={() => onSave({ ...a, enabled: !a.enabled }, !a.enabled && needsPasskey(a))}>{a.enabled ? '● on' : '○ off'}</button>
        <b class="autos-name">{a.name}</b>
      </div>
      <div class="autos-flow">
        <span class="autos-trigger">{describeTrigger(a.trigger)}</span>
        {a.steps.map((s, i) => <span key={i} class="autos-chip">→ {describeStep(s)}</span>)}
      </div>
      <div class="autos-foot">
        <span class="autos-dim">{status}{a.lastRun ? ` · last ${when(a.lastRun.at)} ${a.lastRun.ok ? '✓' : '✕'}` : ''}</span>
        <span class="autos-grow" />
        <Btn label="run now" onClick={() => onRun(a.id)} />
        <Btn label="edit" onClick={() => onEdit(a.id)} />
        {sure ? <Btn label="delete it" cls="danger" onClick={() => onDelete(a.id)} />
              : <Btn label="delete" onClick={() => setSure(true)} />}
      </div>
    </article>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────────────
function Editor({ data, editing, onSave, onDraft, onCancel }) {
  const existing = editing !== 'new' ? (data.automations || []).find(a => a.id === editing) : null;
  const [draft, setDraft] = useState(() => (existing ? clone(existing) : blankAutomation()));
  const [tab, setTab] = useState('steps');
  const [busy, setBusy] = useState(false);
  if (editing !== 'new' && !existing) return <p class="autos-dim">that automation is not there any more.</p>;
  const fleet = data.fleet || [];
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setTrigger = (patch) => setDraft(d => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const setStep = (i, patch) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i, to) => setDraft(d => { const steps = [...d.steps]; const [s] = steps.splice(i, 1); steps.splice(to, 0, s); return { ...d, steps }; });
  const key = needsPasskey(draft) && draft.enabled;
  const save = async () => { setBusy(true); try { await onSave(draft, key); } finally { setBusy(false); } };
  return (
    <Fragment>
      <label class="autos-field"><span>name</span>
        <input type="text" value={draft.name} placeholder="morning review" onInput={(e) => set({ name: e.currentTarget.value })} />
      </label>
      <div class="seg autos-tabs">
        <Btn label="steps" cls={tab === 'steps' ? 'on' : ''} onClick={() => setTab('steps')} />
        <Btn label="ask for it" cls={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')} />
      </div>
      {tab === 'ask'
        ? <Ask draft={draft} onDraft={onDraft} onApply={(a) => { setDraft(d => ({ ...d, ...a, id: d.id, enabled: d.enabled })); setTab('steps'); }} />
        : (
          <Fragment>
            <Trigger t={draft.trigger} fleet={fleet} onChange={setTrigger} onType={(type) => set({ trigger: blankTrigger(type) })} />
            {draft.steps.map((s, i) => (
              <Step key={i} s={s} i={i} n={draft.steps.length} isEvent={draft.trigger.type === 'event'} fleet={fleet}
                    onChange={(patch) => setStep(i, patch)} onMove={(to) => move(i, to)}
                    onRemove={() => setDraft(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))} />
            ))}
            <label class="autos-field"><span>add a step</span>
              <select value="" onChange={(e) => { const v = e.currentTarget.value; if (v) setDraft(d => ({ ...d, steps: [...d.steps, blankStep(v)] })); e.currentTarget.value = ''; }}>
                <option value="">choose…</option>
                {Object.entries(ACTIONS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
              </select>
            </label>
          </Fragment>
        )}
      <label class="autos-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} /> switched on</label>
      {key ? <p class="autos-note">It can start or stop sessions on its own, so saving it asks for your passkey — the same one a tap on start or stop would.</p> : null}
      <div class="row autos-save">
        <Btn label="cancel" onClick={onCancel} />
        <Btn label={busy ? 'saving…' : 'save'} cls="go" onClick={busy ? undefined : save} />
      </div>
    </Fragment>
  );
}

function Seg({ value, options, onChange }) {
  return (
    <div class="seg">
      {options.map(([v, label]) => <Btn key={v} label={label} cls={value === v ? 'on' : ''} onClick={() => value !== v && onChange(v)} />)}
    </div>
  );
}

function Trigger({ t, fleet, onChange, onType }) {
  const sessions = fleet.find(p => p.name === t.project)?.sessions || [];
  return (
    <section class="autos-block">
      <h3>when</h3>
      <Seg value={t.type} options={[['schedule', 'scheduled'], ['event', 'when a session changes']]} onChange={onType} />
      {t.type === 'schedule' ? (
        <Fragment>
          <Seg value={t.mode} options={[['days', 'weekly'], ['once', 'once'], ['every', 'every…']]} onChange={(mode) => onChange({ mode })} />
          {t.mode === 'days' ? (
            <div class="seg autos-days" role="group" aria-label="days">
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <Btn key={d} label={DAY_NAMES[d]} cls={t.days.includes(d) ? 'on' : ''}
                     onClick={() => onChange({ days: t.days.includes(d) ? t.days.filter(x => x !== d) : [...t.days, d] })} />
              ))}
            </div>
          ) : null}
          {t.mode === 'once' ? <label class="autos-field"><span>date</span><input type="date" value={t.date} onInput={(e) => onChange({ date: e.currentTarget.value })} /></label> : null}
          {t.mode !== 'every'
            ? <label class="autos-field"><span>time</span><input type="time" value={t.at} onInput={(e) => onChange({ at: e.currentTarget.value })} /></label>
            : <label class="autos-field"><span>every</span>
                <select value={t.minutes} onChange={(e) => onChange({ minutes: Number(e.currentTarget.value) })}>
                  {EVERY.map(m => <option key={m} value={m}>{everyWords(m)}</option>)}
                </select>
              </label>}
        </Fragment>
      ) : (
        <Fragment>
          <label class="autos-field"><span>when a session…</span>
            <select value={t.event} onChange={(e) => onChange({ event: e.currentTarget.value })}>
              {Object.entries(EVENTS).map(([k, d]) => <option key={k} value={k}>{d.label} ({d.hint})</option>)}
            </select>
          </label>
          <label class="autos-field"><span>in project</span>
            <select value={t.project} onChange={(e) => onChange({ project: e.currentTarget.value, session: '*' })}>
              <option value="*">any project</option>
              {fleet.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label class="autos-field"><span>session</span>
            <select value={t.session} disabled={t.project === '*'} onChange={(e) => onChange({ session: e.currentTarget.value })}>
              <option value="*">any session</option>
              {sessions.map(s => <option key={s.name} value={s.name}>{s.lead ? `${s.name} (lead)` : s.name}</option>)}
            </select>
          </label>
          <label class="autos-field"><span>not again for the same session within (min)</span>
            <input type="number" min="1" max="1440" value={t.cooldown} onInput={(e) => onChange({ cooldown: Number(e.currentTarget.value) })} />
          </label>
        </Fragment>
      )}
      <p class="autos-say">{describeTrigger(t)}</p>
    </section>
  );
}

function Step({ s, i, n, isEvent, fleet, onChange, onMove, onRemove }) {
  const d = ACTIONS[s.action];
  const has = (f) => d.needs.includes(f) || (d.optional || []).includes(f);
  const fromEvent = s.project === EVENT_PROJECT;
  const sessions = fleet.find(p => p.name === s.project)?.sessions || [];
  return (
    <section class={`autos-block${d.passkey ? ' key' : ''}`}>
      <div class="autos-head">
        <h3>{i + 1}. {d.label}</h3>
        <span class="autos-grow" />
        <Btn label="↑" onClick={i ? () => onMove(i - 1) : undefined} cls={i ? '' : 'off'} />
        <Btn label="↓" onClick={i < n - 1 ? () => onMove(i + 1) : undefined} cls={i < n - 1 ? '' : 'off'} />
        <Btn label="✕" onClick={onRemove} />
      </div>
      {has('project') ? (
        <label class="autos-field"><span>project</span>
          <select value={s.project} onChange={(e) => { const v = e.currentTarget.value; onChange(v === EVENT_PROJECT ? { project: v, session: EVENT_SESSION } : { project: v, session: '' }); }}>
            <option value="">choose…</option>
            {isEvent ? <option value={EVENT_PROJECT}>the event's project</option> : null}
            {fleet.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
      ) : null}
      {has('session') ? (
        <label class="autos-field"><span>session</span>
          <select value={s.session} disabled={!s.project} onChange={(e) => onChange({ session: e.currentTarget.value })}>
            <option value="">choose…</option>
            {isEvent ? <option value={EVENT_SESSION}>the event's session</option> : null}
            {!fromEvent ? sessions.map(x => <option key={x.name} value={x.name}>{x.lead ? `${x.name} (lead)` : x.name}</option>) : null}
          </select>
        </label>
      ) : null}
      {has('name') ? <label class="autos-field"><span>new session's name</span><input type="text" value={s.name} placeholder="review-{date}" onInput={(e) => onChange({ name: e.currentTarget.value })} /></label> : null}
      {has('prompt') ? (
        <label class="autos-field"><span>{s.action === 'send' ? 'message' : s.action === 'spawn' ? 'first task (optional)' : 'message on resume (optional)'}</span>
          <textarea rows={3} value={s.prompt} placeholder="{date} {time} {project} {session} are filled in" onInput={(e) => onChange({ prompt: e.currentTarget.value })} />
        </label>
      ) : null}
      {has('branch') ? <label class="autos-field"><span>branch (optional)</span><input type="text" value={s.branch} onInput={(e) => onChange({ branch: e.currentTarget.value })} /></label> : null}
      {s.action === 'notify' ? <label class="autos-field"><span>text</span><input type="text" value={s.text} placeholder="{session} finished in {project}" onInput={(e) => onChange({ text: e.currentTarget.value })} /></label> : null}
      {s.action === 'check' ? (
        <div class="autos-field"><span>…if it is now</span>
          <div class="seg autos-days" role="group" aria-label="statuses">
            {STATES.map(k => <Btn key={k} label={k} cls={s.status.includes(k) ? 'on' : ''}
                                  onClick={() => onChange({ status: s.status.includes(k) ? s.status.filter(x => x !== k) : [...s.status, k] })} />)}
          </div>
          <small class="autos-dim">If it is not, the run ends here — not an error.</small>
        </div>
      ) : null}
      {s.action === 'wait' ? <label class="autos-field"><span>minutes (1–60)</span><input type="number" min="1" max="60" value={s.minutes} onInput={(e) => onChange({ minutes: Number(e.currentTarget.value) })} /></label> : null}
    </section>
  );
}

// ── ask for it: a sentence in, the same steps out ──────────────────────────────────────
// What comes back is a DRAFT put into the editor; nothing is saved until the owner saves it,
// and a draft holding start or stop still asks for the passkey there.
function Ask({ draft, onDraft, onApply }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { try { end.current?.scrollIntoView({ block: 'end' }); } catch {} }, [msgs, busy]);
  const ask = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next = [...msgs, { role: 'user', text: t }];
    setMsgs(next); setText(''); setBusy(true);
    try {
      const has = draft.steps.length || draft.name;
      const r = await onDraft(next, has ? { name: draft.name, trigger: draft.trigger, steps: draft.steps } : null);
      setMsgs(m => [...m, { role: 'ai', text: r.reply, automation: r.automation || null }]);
    } catch (e) { setMsgs(m => [...m, { role: 'ai', text: `could not: ${e.message}`, error: true }]); }
    finally { setBusy(false); }
  };
  return (
    <section class="autos-ask">
      {!msgs.length ? <p class="autos-dim">Say it in a sentence — "every weekday at 09:00, wake the workers in acme-api and tell the lead to share out what is open". It fills in the steps; you check them and save.</p> : null}
      {msgs.map((m, i) => (
        <div key={i} class={`autos-msg ${m.role}${m.error ? ' bad' : ''}`}>
          {m.text}
          {m.automation ? <div><Btn label="put it in the editor" cls="go" onClick={() => onApply(m.automation)} /></div> : null}
        </div>
      ))}
      {busy ? <div class="autos-msg ai autos-dim">writing it…</div> : null}
      <div ref={end} />
      <textarea rows={2} value={text} placeholder="what should happen, and when?" onInput={(e) => setText(e.currentTarget.value)} />
      <div class="row"><Btn label="ask" cls="go" onClick={busy || !text.trim() ? undefined : ask} /></div>
    </section>
  );
}
