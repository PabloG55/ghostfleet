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
import { Header } from './screens.jsx';
import { ACTIONS, EVENTS, STATES, DAY_NAMES, EVENT_PROJECT, EVENT_SESSION, blankTrigger, blankStep, blankAutomation,
         describeTrigger, describeStep, everyWords, needsPasskey, normalize } from '../../lib/automations-model.mjs';

const EVERY = [15, 30, 60, 120, 180, 360, 720, 1440];
// A WEEKDAY NAMES THE NEAREST ONE, so "next Fri" on something twelve days away is the wrong Friday.
const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, Math.abs(ts - Date.now() / 1000) > 6 * 86400
  ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clone = (v) => JSON.parse(JSON.stringify(v));
const eventOnly = (a) => a.trigger.type === 'event' && a.steps.some(s => s.project === EVENT_PROJECT || s.session === EVENT_SESSION);

export function AutomationsScreen(p) {
  return (
    <Fragment>
      <Header scope={p.editing ? (p.editing === 'new' ? '— new automation' : '— edit automation') : '— automations'}
              mode={p.mode} stale={p.stale} onBack={p.onBack} />
      {p.data == null ? (p.error ? <Failed error={p.error} onRetry={p.onRetry} /> : <Loading />)
        : p.editing ? <Editor key={p.editing} {...p} />
        : <List {...p} />}
      {p.toast ? <div class={('toast ' + (p.toast.kind || '')).trim()}>{p.toast.text}</div> : null}
    </Fragment>
  );
}

// THE BAR IS OUTSIDE THE SCROLL, like the review screen's verdict. A save at the end of a form that
// grows with every step is a control you scroll to, and one that moves each time a step is added.
const Bar = ({ children }) => <div class="autos-bar">{children}</div>;

// ── the three states that are not the list ────────────────────────────────────────────
function Loading() {
  return (
    <Fragment>
      <div class="cards autos" aria-busy="true" aria-label="reading the automations">
        {[0, 1, 2].map(i => <div key={i} class="card skel"><div class="skel-bar w1" /><div class="skel-bar w2" /><div class="skel-bar w3" /></div>)}
      </div>
      <Bar><div class="autos-acts"><button type="button" class="go" disabled>new automation</button></div></Bar>
    </Fragment>
  );
}

function Failed({ error, onRetry }) {
  return (
    <div class="cards autos">
      <div class="autos-empty" role="alert">
        <h3>could not read the automations</h3>
        <p>{error}</p>
        <button type="button" class="go" onClick={onRetry}>try again</button>
      </div>
    </div>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────────────
function List({ data, onEdit, onSave, onSeen, onSay }) {
  const list = data.automations || [];
  const unseen = (data.notices || []).filter(n => !n.seen);
  const runs = data.runs || [];
  return (
    <Fragment>
      <div class="cards autos">
        {unseen.length ? <Notices list={unseen} onSeen={onSeen} /> : null}
        {!list.length ? (
          <div class="autos-empty">
            <h3>no automations yet</h3>
            <p>One is a trigger and some steps. For example: "weekdays at 09:00, send the lead of acme-api: review what
              is open", or "when any session in acme-web needs you, tell me".</p>
          </div>
        ) : null}
        {list.map(a => <Item key={a.id} a={a} onEdit={onEdit} onSave={onSave} onSay={onSay} />)}
        {runs.length ? (
          <section class="autos-block autos-wide">
            <h3>last runs</h3>
            <Capped items={runs} n={10} render={(r, i) => <Run key={i} r={r} />} />
          </section>
        ) : null}
      </div>
      <Bar><div class="autos-acts"><button type="button" class="go" onClick={() => onEdit('new')}>new automation</button></div></Bar>
    </Fragment>
  );
}

// A long history must not stand between the owner and the list, or the end of it.
function Capped({ items, n, render }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, n);
  return (
    <Fragment>
      {shown.map(render)}
      {items.length > shown.length ? <button type="button" onClick={() => setAll(true)}>show {items.length - shown.length} more</button> : null}
    </Fragment>
  );
}

function Notices({ list, onSeen }) {
  return (
    <section class="autos-block autos-wide" aria-label="needs a look">
      <div class="autos-head">
        <h3>needs a look</h3>
        <button type="button" onClick={onSeen}>mark as seen</button>
      </div>
      <Capped items={list} n={3} render={(n) => <div key={n.id} class={`autos-notice k-${n.kind}`}><span class="autos-when">{when(n.at)}</span> {n.text}</div>} />
    </section>
  );
}

// IN WORDS AS WELL AS GLYPHS: a colour and a tick are not what a screen reader says, and a stopped
// run is neither a success nor a failure.
const RUN_WORD = { ok: '✓ ran', error: '✕ failed', skipped: '– skipped', stopped: '■ stopped' };
function Run({ r }) {
  const steps = r.steps || [];
  const head = (
    <Fragment>
      <span class={`autos-st s-${r.status}`}>{RUN_WORD[r.status] || r.status}</span>
      <b class="autos-run-name">{r.name}</b>
      <span class="autos-when">{when(r.at)}</span>
      <span class="autos-run-why">{r.status === 'skipped' || r.status === 'stopped' ? r.text : r.trigger}</span>
    </Fragment>
  );
  if (!steps.length) return <div class="autos-run"><div class="autos-run-head">{head}</div></div>;
  return (
    <details class="autos-run">
      <summary class="autos-run-head">{head}</summary>
      {steps.map((s, j) => <div key={j} class={`autos-step-run${s.ok ? '' : ' bad'}`}>{s.halt ? '■' : s.ok ? '✓' : '✕'} {s.what}{s.text ? <small> — {s.text}</small> : null}</div>)}
    </details>
  );
}

// `aria-checked` says the state, so the name stays the automation's. A name that flipped between
// "switch off X" and "switch on X" announced the action as if it were the state.
function Switch({ on, label, busy, onClick }) {
  return (
    <button type="button" class={`autos-sw${on ? ' on' : ''}`} role="switch" aria-checked={on ? 'true' : 'false'}
            aria-label={label} aria-busy={busy ? 'true' : null} onClick={onClick}>
      <span class="autos-knob" aria-hidden="true" />
    </button>
  );
}

// ONE CONTROL ON A ROW, THE SWITCH, and the rest of the card opens it. Three buttons on every row
// made a list of four automations a wall of twelve targets, and one of them deleted. The name is a
// real button stretched over the card, so a keyboard and a screen reader get it too.
function Item({ a, onEdit, onSave, onSay }) {
  const [want, setWant] = useState(null);
  const on = want == null ? a.enabled : want;
  const toggle = async () => {
    if (want != null) return;
    setWant(!a.enabled);
    const r = await onSave({ ...a, enabled: !a.enabled }, !a.enabled && needsPasskey(a));
    setWant(null);
    if (r && r.error) onSay(r.error);
  };
  const failed = a.lastRun && !a.lastRun.ok;
  const hue = a.running ? 'var(--cyan)' : !on ? 'var(--dim)' : failed ? 'var(--red)' : 'var(--green)';
  const status = a.running ? 'running now'
    : !on ? 'off'
    : a.nextRun ? `next ${when(a.nextRun)}`
    : a.trigger.type === 'event' ? 'waiting for the event' : '';
  const more = a.steps.length - 3;
  return (
    <article class={`card autos-card${on ? '' : ' off'}`} style={`--c: ${hue}`}>
      <div class="c-top">
        <button type="button" class="c-name autos-open" onClick={() => onEdit(a.id)}>{a.name}</button>
        <Switch on={on} label={a.name} busy={want != null} onClick={toggle} />
      </div>
      <p class="autos-say">{describeTrigger(a.trigger)}</p>
      <ol class="autos-steps">
        {a.steps.slice(0, 3).map((s, i) => <li key={i}>{describeStep(s)}</li>)}
        {more > 0 ? <li class="autos-dim">and {more} more</li> : null}
      </ol>
      <div class="autos-status">
        {status ? <span>{status}</span> : null}
        {a.lastRun ? <span class={failed ? 'bad' : ''}>{failed ? 'failed' : 'last ran'} {when(a.lastRun.at)}</span> : null}
      </div>
    </article>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────────────
function Editor({ data, editing, onSave, onDelete, onRun, onDraft, onCancel }) {
  const existing = editing !== 'new' ? (data.automations || []).find(a => a.id === editing) : null;
  const [draft, setDraft] = useState(() => (existing ? clone(existing) : blankAutomation()));
  const [opened] = useState(() => JSON.stringify(draft));
  const [tab, setTab] = useState('steps');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // The conversation outlives the tab: going back to refine a draft must not start it over.
  const [chat, setChat] = useState({ msgs: [], text: '' });
  const [menu, setMenu] = useState(null);       // which step's actions are open: it follows the step
  // A step that moved takes its place in the list with it, so the press after this one has to land
  // on the same step. Removing one leaves focus nowhere at all without this.
  const refocus = useRef(null);
  useEffect(() => {
    const tries = refocus.current;
    if (!tries) return;
    refocus.current = null;
    for (const q of tries) { const el = document.querySelector(q); if (el && !el.disabled) { el.focus(); return; } }
  });
  if (editing !== 'new' && !existing) {
    return (
      <Fragment>
        <div class="cards autos"><div class="autos-empty"><h3>that automation is not there any more</h3></div></div>
        <Bar><div class="autos-acts"><button type="button" onClick={onCancel}>back to the list</button></div></Bar>
      </Fragment>
    );
  }
  const fleet = data.fleet || [];
  const edit = (fn) => { setErr(''); setDraft(fn); };
  const set = (patch) => edit(d => ({ ...d, ...patch }));
  const setTrigger = (patch) => edit(d => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const setStep = (i, patch) => edit(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i, to) => {
    const dir = to < i ? 'up' : 'down';
    refocus.current = [`[data-move="${to}:${dir}"]`, `[data-move="${to}:${dir === 'up' ? 'down' : 'up'}"]`];
    setMenu(to);
    edit(d => { const steps = [...d.steps]; const [s] = steps.splice(i, 1); steps.splice(to, 0, s); return { ...d, steps }; });
  };
  const remove = (i) => { setMenu(null); refocus.current = ['.autos-add select']; edit(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) })); };
  const key = needsPasskey(draft) && draft.enabled;
  const save = async () => {
    if (busy) return;
    // ASKED HERE FIRST when a passkey is next: a draft the daemon will refuse should not cost a
    // fingerprint on the way to being told so. The daemon still asks, and it has the last word.
    if (key) { try { normalize(draft); } catch (e) { setErr(e.message); return; } }
    setBusy(true); setErr('');
    const r = await onSave(draft, key);
    setBusy(false);
    if (r && r.error) setErr(r.error);
  };
  return (
    <Fragment>
      <div class="cards autos autos-form">
        <div class="autos-col">
          <label class="autos-field"><span>name</span>
            <input type="text" value={draft.name} placeholder="morning review" autocomplete="off" onInput={(e) => set({ name: e.currentTarget.value })} />
          </label>
          <Seg label="how to build it" cls="tabs" value={tab} options={[['steps', 'steps'], ['ask', 'ask for it']]} onChange={setTab} />
          {tab === 'ask'
            ? <Ask draft={draft} chat={chat} setChat={setChat} onDraft={onDraft} onApply={(a) => { edit(d => ({ ...d, ...a, id: d.id, enabled: d.enabled })); setTab('steps'); }} />
            : (
              <Fragment>
                <Trigger t={draft.trigger} fleet={fleet} onChange={setTrigger} onType={(type) => set({ trigger: blankTrigger(type) })} />
                {draft.steps.map((s, i) => (
                  <Step key={i} s={s} i={i} n={draft.steps.length} isEvent={draft.trigger.type === 'event'} fleet={fleet}
                        open={menu === i} onMenu={() => setMenu(menu === i ? null : i)}
                        onChange={(patch) => setStep(i, patch)} onMove={(to) => move(i, to)} onRemove={() => remove(i)} />
                ))}
                <label class="autos-field autos-add"><span>add a step</span>
                  <select value="" onChange={(e) => { const v = e.currentTarget.value; if (v) edit(d => ({ ...d, steps: [...d.steps, blankStep(v)] })); e.currentTarget.value = ''; }}>
                    <option value="">choose…</option>
                    {Object.entries(ACTIONS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
                  </select>
                </label>
                <div class="autos-block">
                  <div class="autos-line">
                    <div><b>{draft.enabled ? 'switched on' : 'switched off'}</b>{draft.enabled ? null : <small>Saved, and it does nothing until it is switched on.</small>}</div>
                    <Switch on={draft.enabled} label="switched on" onClick={() => set({ enabled: !draft.enabled })} />
                  </div>
                  {key ? <p class="autos-note">It can start or stop sessions on its own, so saving it asks for your passkey, the same one a tap on start or stop would.</p> : null}
                </div>
                {existing ? <Manage a={existing} dirty={JSON.stringify(draft) !== opened} onRun={onRun} onDelete={onDelete} /> : null}
              </Fragment>
            )}
        </div>
      </div>
      <Bar>
        {err ? <p class="autos-err" role="alert">{err}</p> : null}
        <div class="autos-acts">
          <button type="button" onClick={onCancel}>cancel</button>
          {/* Not the primary while asking: there the primary is the proposal's own button, and a save
              on this tab keeps the steps it had, which is not what a person reading a proposal means. */}
          <button type="button" class={tab === 'ask' ? null : 'go'} disabled={busy} onClick={save}>{busy ? 'saving…' : 'save'}</button>
        </div>
      </Bar>
    </Fragment>
  );
}

// What can be done to the saved automation, away from the list's rows and from the fields above. A
// run is of what is SAVED: run now over unsaved edits would run something other than what is on
// screen, so it says that and waits.
function Manage({ a, dirty, onRun, onDelete }) {
  const [sure, setSure] = useState(false);
  const [running, setRunning] = useState(false);
  const refused = a.running ? 'It is running now.'
    : eventOnly(a) ? "It uses the event's session, so it can only run when the event happens."
    : dirty ? 'This runs what is saved. Save your changes first.' : '';
  const run = async () => { setRunning(true); try { await onRun(a.id, needsPasskey(a), a.name); } finally { setRunning(false); } };
  return (
    <section class="autos-block">
      <div class="autos-line">
        <div><b>run it once</b>{refused ? <small>{refused}</small> : needsPasskey(a) ? <small>Asks for your passkey.</small> : null}</div>
        <button type="button" disabled={!!refused || running} onClick={run}>{running ? 'starting…' : 'run now'}</button>
      </div>
      <div class="autos-line">
        <div><b>delete this automation</b>{sure ? <small>This cannot be undone.</small> : null}</div>
        {sure ? <button type="button" onClick={() => setSure(false)}>keep it</button> : null}
        {sure ? <button type="button" class="danger" onClick={() => onDelete(a.id)}>delete it</button>
              : <button type="button" onClick={() => setSure(true)}>delete</button>}
      </div>
    </section>
  );
}

function Seg({ label, value, options, onChange, cls = '' }) {
  return (
    <div class={`seg autos-seg ${cls}`.trim()} role="group" aria-label={label}>
      {options.map(([v, text]) => <Tog key={v} on={value === v} label={text} onClick={() => value !== v && onChange(v)} />)}
    </div>
  );
}
const Tog = ({ on, label, onClick }) => (
  <button type="button" class={on ? 'on' : null} aria-pressed={on ? 'true' : 'false'} onClick={onClick}>{label}</button>
);

// A <select> WHOSE VALUE HAS NO OPTION SHOWS NOTHING, and the value is still what gets saved. A model
// can propose a project that is not on the list, and a session can be gone since the save, so the
// form would read as blank over a real target. It says what is there instead.
function Gone({ value, known }) {
  if (!value || known.includes(value)) return null;
  const words = value === EVENT_PROJECT ? "the event's project (needs a trigger on a session)"
    : value === EVENT_SESSION ? "the event's session (needs a trigger on a session)"
    : `${value} (not in the fleet now)`;
  return <option value={value}>{words}</option>;
}

function Trigger({ t, fleet, onChange, onType }) {
  const sessions = fleet.find(p => p.name === t.project)?.sessions || [];
  return (
    <section class="autos-block">
      <h3>when</h3>
      <Seg label="what starts it" value={t.type} options={[['schedule', 'scheduled'], ['event', 'when a session changes']]} onChange={onType} />
      {t.type === 'schedule' ? (
        <Fragment>
          <Seg label="how often" value={t.mode} options={[['days', 'weekly'], ['once', 'once'], ['every', 'every…']]} onChange={(mode) => onChange({ mode })} />
          {t.mode === 'days' ? (
            <div class="seg autos-seg autos-days" role="group" aria-label="days">
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <Tog key={d} label={DAY_NAMES[d]} on={t.days.includes(d)}
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
              <Gone value={t.project} known={['*', ...fleet.map(p => p.name)]} />
              {fleet.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label class="autos-field"><span>session</span>
            <select value={t.session} disabled={t.project === '*'} onChange={(e) => onChange({ session: e.currentTarget.value })}>
              <option value="*">any session</option>
              <Gone value={t.session} known={['*', ...sessions.map(s => s.name)]} />
              {sessions.map(s => <option key={s.name} value={s.name}>{s.lead ? `${s.name} (lead)` : s.name}</option>)}
            </select>
          </label>
          <label class="autos-field"><span>not again for the same session within (min)</span>
            <input type="number" inputmode="numeric" min="1" max="1440" value={t.cooldown}
                   onInput={(e) => { const v = e.currentTarget.value; onChange({ cooldown: v === '' ? '' : Number(v) }); }} />
          </label>
        </Fragment>
      )}
      <p class="autos-say">{describeTrigger(t)}</p>
    </section>
  );
}

function Step({ s, i, n, isEvent, fleet, open, onMenu, onChange, onMove, onRemove }) {
  const d = ACTIONS[s.action];
  const has = (f) => d.needs.includes(f) || (d.optional || []).includes(f);
  const fromEvent = s.project === EVENT_PROJECT;
  const sessions = fleet.find(p => p.name === s.project)?.sessions || [];
  const shown = fromEvent ? [] : sessions;
  return (
    <section class={`autos-block${d.passkey ? ' key' : ''}`}>
      <div class="autos-head">
        <h3>{i + 1}. {d.label}</h3>
        <button type="button" class="autos-icon" aria-label={`actions for step ${i + 1}`} aria-expanded={open ? 'true' : 'false'} onClick={onMenu}>⋯</button>
      </div>
      {/* One control on a step until it is asked for: three on each of twenty steps is a form of arrows. */}
      {open ? (
        <div class="autos-step-acts">
          <button type="button" data-move={`${i}:up`} disabled={!i} onClick={() => onMove(i - 1)}>move up</button>
          <button type="button" data-move={`${i}:down`} disabled={i >= n - 1} onClick={() => onMove(i + 1)}>move down</button>
          <button type="button" onClick={onRemove}>remove</button>
        </div>
      ) : null}
      {has('project') ? (
        <label class="autos-field"><span>project</span>
          <select value={s.project} onChange={(e) => { const v = e.currentTarget.value; onChange(v === EVENT_PROJECT ? { project: v, session: EVENT_SESSION } : { project: v, session: '' }); }}>
            <option value="">choose…</option>
            {isEvent ? <option value={EVENT_PROJECT}>the event's project</option> : null}
            <Gone value={s.project} known={[...(isEvent ? [EVENT_PROJECT] : []), ...fleet.map(p => p.name)]} />
            {fleet.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
      ) : null}
      {has('session') ? (
        <label class="autos-field"><span>session</span>
          <select value={s.session} disabled={!s.project} onChange={(e) => onChange({ session: e.currentTarget.value })}>
            <option value="">choose…</option>
            {isEvent ? <option value={EVENT_SESSION}>the event's session</option> : null}
            <Gone value={s.session} known={[...(isEvent ? [EVENT_SESSION] : []), ...shown.map(x => x.name)]} />
            {shown.map(x => <option key={x.name} value={x.name}>{x.lead ? `${x.name} (lead)` : x.name}</option>)}
          </select>
        </label>
      ) : null}
      {has('name') ? <label class="autos-field"><span>new session's name</span><input type="text" value={s.name} placeholder="review-{date}" autocomplete="off" onInput={(e) => onChange({ name: e.currentTarget.value })} /></label> : null}
      {has('prompt') ? (
        <label class="autos-field"><span>{s.action === 'send' ? 'message' : s.action === 'spawn' ? 'first task (optional)' : 'message on resume (optional)'}</span>
          <textarea rows={3} value={s.prompt} placeholder="{date} {time} {project} {session} are filled in" onInput={(e) => onChange({ prompt: e.currentTarget.value })} />
        </label>
      ) : null}
      {has('branch') ? <label class="autos-field"><span>branch (optional)</span><input type="text" value={s.branch} autocomplete="off" onInput={(e) => onChange({ branch: e.currentTarget.value })} /></label> : null}
      {s.action === 'notify' ? <label class="autos-field"><span>text</span><input type="text" value={s.text} placeholder="{session} finished in {project}" onInput={(e) => onChange({ text: e.currentTarget.value })} /></label> : null}
      {s.action === 'check' ? (
        <div class="autos-field"><span>…if it is now</span>
          <div class="seg autos-seg" role="group" aria-label="statuses">
            {STATES.map(k => <Tog key={k} label={k} on={s.status.includes(k)}
                                  onClick={() => onChange({ status: s.status.includes(k) ? s.status.filter(x => x !== k) : [...s.status, k] })} />)}
          </div>
          <small class="autos-dim">If it is not, the run ends here. That is not an error.</small>
        </div>
      ) : null}
      {s.action === 'wait' ? (
        <label class="autos-field"><span>minutes (1–60)</span>
          <input type="number" inputmode="numeric" min="1" max="60" value={s.minutes}
                 onInput={(e) => { const v = e.currentTarget.value; onChange({ minutes: v === '' ? '' : Number(v) }); }} />
        </label>
      ) : null}
    </section>
  );
}

// ── ask for it: a sentence in, the same steps out ──────────────────────────────────────
// What comes back is a DRAFT put into the editor; nothing is saved until the owner saves it,
// and a draft holding start or stop still asks for the passkey there. The bubble spells out what
// the proposal does, so what is being accepted is on screen before it replaces anything.
function Ask({ draft, chat, setChat, onDraft, onApply }) {
  const { msgs, text } = chat;
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const setMsgs = (fn) => setChat(c => ({ ...c, msgs: fn(c.msgs) }));
  useEffect(() => { if (msgs.length) { try { end.current?.scrollIntoView({ block: 'end' }); } catch {} } }, [msgs.length, busy]);
  const ask = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next = [...msgs, { role: 'user', text: t }];
    setChat({ msgs: next, text: '' }); setBusy(true);
    try {
      const has = draft.steps.length || draft.name;
      const r = await onDraft(next, has ? { name: draft.name, trigger: draft.trigger, steps: draft.steps } : null);
      setMsgs(m => [...m, { role: 'ai', text: r.reply, automation: r.automation || null }]);
    } catch (e) {
      // The sentence goes back in the box and out of the conversation, so asking again does not
      // send it twice and nothing has to be typed over.
      setChat(c => ({ msgs: [...msgs, { role: 'ai', text: e.message, error: true }], text: c.text || t }));
    } finally { setBusy(false); }
  };
  return (
    <section class="autos-block autos-ask">
      {!msgs.length ? <p class="autos-dim">Say it in a sentence: "every weekday at 09:00, wake the workers in acme-api and tell the lead to share out what is open". It fills in the steps. You check them and save.</p> : null}
      {msgs.map((m, i) => (
        <div key={i} class={`autos-msg ${m.role}${m.error ? ' bad' : ''}`} role={m.error ? 'alert' : null}>
          {m.text}
          {m.automation ? <Proposal a={m.automation} replaces={draft.steps.length > 0} onApply={() => onApply(m.automation)} /> : null}
        </div>
      ))}
      {busy ? <div class="autos-msg ai autos-dim">writing it…</div> : null}
      <div ref={end} />
      <div class="autos-compose">
        <textarea rows={2} value={text} placeholder="what should happen, and when?" aria-label="what should happen, and when?"
                  onInput={(e) => { const v = e.currentTarget.value; setChat(c => ({ ...c, text: v })); }} />
        <button type="button" disabled={busy || !text.trim()} onClick={ask}>ask</button>
      </div>
    </section>
  );
}

function Proposal({ a, replaces, onApply }) {
  return (
    <div class="autos-proposal">
      <b>{a.name}</b>
      <p class="autos-say">{describeTrigger(a.trigger)}</p>
      <ol class="autos-steps full">{(a.steps || []).map((s, i) => <li key={i}>{describeStep(s)}</li>)}</ol>
      {needsPasskey(a) ? <p class="autos-note">It can start or stop sessions on its own, so saving it asks for your passkey.</p> : null}
      <button type="button" class="go" onClick={onApply}>{replaces ? 'replace the steps with this' : 'put it in the editor'}</button>
    </div>
  );
}
