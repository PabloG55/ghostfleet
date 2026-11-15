import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'preact/hooks';
import { STATUS, StatusMark, statusOf, Btn, SendBtn, usePoll, toast, Modal, useRequest } from './ui.jsx';
import { useRoom } from './skeleton.jsx';
import { Select, Popover } from './select.jsx';
import { plainText, browserCanHear, PAUSES } from './voice.js';
import { useAgent, talk, stop, submit, setPin, setOption, canHear, busy, unframe } from './agent.js';
import { VoicePicker } from './voices.jsx';
import { useFleet } from './adapter.jsx';
import { go } from './history.js';
import { t } from './i18n.js';
import { words } from './i18n.js';
import { Icon } from './icon.jsx';
// The assistant's face: ghostfleet's own SHIP sprite, the one the app icon is drawn from.
import { GhostShip as Ship } from './fleet.jsx';

const STATE_WORDS = words(['listening', 'hearing', 'routing', 'sending', 'starting', 'thinking', 'acting', 'speaking', 'idle', 'off'], 'ship');
const LIVE = ['listening', 'hearing', 'routing', 'sending', 'starting', 'speaking'];
const stateWord = (S, state) => `${STATE_WORDS[state]}${state === 'acting' && S.focus ? ` ${t('as.in', { where: S.focus })}` : ''}`;
const working = (state) => !['idle', 'off'].includes(state);

export function shipStateOf(S) {
  if (LIVE.includes(S.phase)) return S.phase;
  const master = S.cards.find(c => c.lead);
  if (!master) return 'off';
  const st = statusOf(master);
  if (st === 'working') return S.focus !== master.name ? 'acting' : 'thinking';
  return st === 'need-you' ? 'thinking' : 'idle';
}

// Projects in the order a person is likeliest to want them: what is moving, then the rest.
export function rankedProjects(projects) {
  const last = (p) => Math.max(0, ...p.sessions.map(s => s.ts || 0));
  return [...(projects || [])].sort((a, b) => (b.counts.need_you - a.counts.need_you) || (last(b) - last(a)) || a.name.localeCompare(b.name));
}

// Who the person is talking to: auto, or a project's lead (agent.js setPin). One control for the
// panel and the home card, which are the same assistant.
export function TalkTo({ projects, compact }) {
  const S = useAgent();
  const list = useMemo(() => rankedProjects(projects), [projects]);
  const has = (name) => list.some(p => p.name === name);
  const options = [{ value: '', label: t('as.auto') },
    ...(projects == null && S.pin ? [{ value: S.pin, label: t('as.leadOf', { project: S.pin }) }] : []),
    // A lead that is not open yet is still a choice: the first request starts it.
    ...list.map(p => ({ value: p.name, label: t(p.sessions.some(s => s.lead) ? 'as.leadOf' : 'as.leadLater', { project: p.name }) }))];
  return <Select field={compact ? 'talk-to small' : 'field as-target'} label={t('as.talkingTo')}
                 value={projects == null || has(S.pin) ? S.pin : ''} onChange={setPin} options={options} />;
}

export function Console({ projects, big, foot }) {
  const S = useAgent();
  const [typed, setTyped] = useState('');
  const listening = S.phase === 'listening' || S.phase === 'hearing';
  // Stop while anything is under way, routing too: on the home page the card is the only place
  // left to stop it from, now that the bar that also had a Stop is gone (Launcher).
  const active = busy() || listening || LIVE.includes(S.phase);
  const local = !!S.vs?.hear?.ready;
  return (
    <div class={`console${big ? ' big' : ''}`}>
      <div class="console-row">
        <button class={`mic${listening ? ' on' : ''}`} disabled={!canHear() || S.phase === 'hearing'} onClick={talk}
                aria-label={listening ? t('as.doneTalking') : t('as.talk')}>
          <span class="mic-ico">{S.phase === 'hearing' ? '…' : <Icon name={listening ? 'check' : 'mic'} />}</span>
          <span>{S.phase === 'hearing' ? t('ship.hearing') : listening ? (S.pause === 'manual' ? t('as.listenManual') : t('as.listenAuto')) : t('as.talk')}</span>
          {S.phase === 'listening' && local ? <span class="meter"><i style={{ width: `${Math.round(S.level * 100)}%` }} /></span> : null}
        </button>
        {active ? <button class="stop-all" onClick={stop} aria-label={t('as.stopAll')}><Icon name="stop" /> {t('sess.stop')}</button> : null}
      </div>
      <form class="row" onSubmit={(e) => { e.preventDefault(); const said = typed; setTyped(''); submit(said, false); }}>
        <input class="grow" value={typed} onInput={(e) => setTyped(e.currentTarget.value)}
               placeholder={big ? t('as.typeBig') : t('as.type')} />
        <SendBtn disabled={!typed.trim()} />
      </form>
      {foot ? <div class="console-foot">{foot}{voiceOpts(S, local)}</div> : voiceOpts(S, local)}
    </div>
  );
}

// Voice options, the popover from the More menu's surface, in the panel and on the card alike.
function voiceOpts(S, local) {
  return (
      <Popover class="voice-opts-btn" boxClass="voice-opts" icon="gear" label={t('as.voiceOpts')} title={t('as.voiceOpts')}>
      <p class="voice-src muted small">
        {S.vs == null ? t('as.vsChecking')
          : local ? <><Icon name="lock" /> {t('as.vsLocal')}</>
          : browserCanHear ? t('as.vsBrowser')
          : t('as.vsNone')}
      </p>
      {S.phase === 'listening' ? <p class="listen-hint small">{S.pause === 'manual'
        ? t('as.hintManual')
        : t('as.hintAuto', { s: S.pause === 'larga' ? t('as.sLong') : t('as.sShort') })}</p> : null}
      <Select field="pause-pick small" label={t('as.whenPause')} value={S.pause}
              options={Object.entries(PAUSES).map(([k, p]) => ({ value: k, label: p.label }))}
              onChange={(v) => setOption('pause', v)} />
      <div class="toggles">
        <label><input type="checkbox" checked={S.voiceOut} onChange={(e) => setOption('voiceOut', e.currentTarget.checked)} /> {t('as.voiceOut')}</label>
        <label><input type="checkbox" checked={S.handsFree} onChange={(e) => setOption('handsFree', e.currentTarget.checked)} /> {t('as.handsFree')}</label>
        <label><input type="checkbox" checked={S.follow} onChange={(e) => setOption('follow', e.currentTarget.checked)} /> {t('as.follow')}</label>
      </div>
      </Popover>
  );
}

export function Feed({ limit, empty }) {
  const S = useAgent();
  const ref = useRef(null);
  const rows = limit ? S.feed.slice(-limit) : S.feed;
  // To the end on every new row: what was just said and its answer. Keyed on the newest row, not
  // the count: the feed keeps its last 61 (agent.js push), so from the 61st on its length stopped
  // changing, and a message sent in a long conversation went in below the fold with the feed held
  // where the reader had left it.
  const newest = rows.length ? rows[rows.length - 1].id : 0;
  useEffect(() => { const n = ref.current; if (n) n.scrollTop = n.scrollHeight; }, [newest, S.interim]);
  return (
    <div class="as-feed" ref={ref}>
      {!rows.length && !S.interim ? empty : null}
      {rows.map(e => (
        <div key={e.id} class={`as-row ${e.kind}${e.bad ? ' bad' : ''}${e.ask ? ' ask-row' : ''}${e.session && e.project ? ' go' : ''}`}
             onClick={e.session && e.project ? () => go(`/p/${encodeURIComponent(e.project)}/s/${encodeURIComponent(e.session)}`) : undefined}>
          {e.kind === 'me' ? <><span class="tag-me">{e.voice ? <><Icon name="mic" /> {t('settings.you')}</> : t('settings.you')}</span> {unframe(e.text)}</>
            : e.kind === 'ai' ? <><span class="tag-ai">{e.project || t('common.lead')}</span>{e.title ? <em class="tag-about"> {e.title}</em> : null} {plainText(e.text)}</>
            : <><span class="tag-ev">{e.ask ? t('as.question') : t('as.live')}</span> {e.text}</>}
        </div>
      ))}
      {S.interim ? <div class="as-row me live"><span class="tag-me"><Icon name="mic" /></span> {S.interim}…</div> : null}
    </div>
  );
}

function Sea({}) {
  const S = useAgent();
  const state = shipStateOf(S);
  const lane = [...S.cards].sort((a, b) => Number(b.lead) - Number(a.lead));
  const at = Math.max(0, lane.findIndex(c => c.name === S.focus));
  return (
    <div class={`sea st-${state}`}>
      <div class="ship-track" style={{ '--i': at, '--n': Math.max(lane.length, 1) }}>
        <Ship size={64} state={state} />
        <span class="ship-say">{stateWord(S, state)}</span>
      </div>
      <div class="lane" style={{ '--n': Math.max(lane.length, 1) }}>
        {!lane.length ? <span class="muted small lane-empty">{t('as.laneEmpty')}</span> : null}
        {lane.map(c => {
          const s = statusOf(c);
          return (
            <button key={c.name} class={`buoy c-${(STATUS[s] || STATUS.unknown).color}${c.name === S.focus ? ' on' : ''}`}
                    title={`${c.label || c.name} · ${(STATUS[s] || STATUS.unknown).label}`}
                    onClick={() => go(`/p/${encodeURIComponent(S.target)}/s/${encodeURIComponent(c.name)}`)}>
              <b><StatusMark status={s} /></b><span>{c.lead ? t('common.lead') : c.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const Hint = () => (
  <div class="as-hint">
    <p><b>{t('as.hint.title')}</b></p>
    <p class="muted">{t('as.hint.examples')}</p>
    <p class="muted">{t('as.hint.how')}</p>
  </div>
);

export function Assistant({ projects, onClose, chip }) {
  const [choosing, setChoosing] = useState(false);
  // A server that keeps no list of voices (fleet-serve picks its own) has nothing to choose from.
  const voices = !!useFleet().voices;
  return (
    <aside class="assistant" aria-label={t('as.name')}>
      <header class="as-head">
        <div><b>{t('as.name')}</b><small>{t('as.sub')}</small></div>
        <span class="as-head-end">{chip}{voices ? <Btn kind="sm" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>{choosing ? t('common.back') : t('as.pickVoice')}</Btn> : null}<button class="x" aria-label={t('as.close')} onClick={onClose}>✕</button></span>
      </header>
      <TalkTo projects={projects} />
      <Proposals />
      {choosing && voices ? <div class="as-voices"><VoicePicker /></div> : <><Sea /><Feed empty={<Hint />} /></>}
      <div class="as-controls"><Console projects={projects} /></div>
    </aside>
  );
}

// WHAT JARVIS WANTS TO DO AND IS WAITING ON A YES FOR (docs/jarvis.md): each is a call it tried that
// the tool refused until the owner says yes — spoken, typed at the desk, or here. It was the old
// phone's Jarvis screen; with one assistant it is drawn wherever the assistant is, the home card
// and the panel. A server with no Jarvis gives the adapter no `proposals`, and nothing is drawn.
export function Proposals() {
  const fleet = useFleet();
  const has = typeof fleet.proposals === 'function';
  const { data, reload } = usePoll(() => (has ? fleet.proposals() : Promise.resolve([])), has ? 15000 : 0, [has], { key: 'proposals' });
  const [busyId, setBusyId] = useState('');
  const list = Array.isArray(data) ? data : [];
  const request = useRequest('proposals', data == null ? undefined : list.map(p => `${p.id}:${!!p.granted}`).join('|') || null);
  // The way back to a request is a button ABOVE the box a person types in, and it is only there
  // when something waits: while the first read is out the slot keeps the height it had last time
  // on this device (skeleton.jsx useRoom), so the box under it is not pushed down when it lands.
  const room = useRoom('proposals', has && data == null, !list.length);
  if (!has) return null;
  const answer = async (p, yes) => {
    setBusyId(p.id);
    try {
      await fleet.answerProposal(p, yes);
      request.close();
      toast(t(yes ? 'as.proposalYesDone' : 'as.proposalNoDone', { summary: p.summary }), 'good');
    } catch (e) { toast(String((e && e.message) || e), 'bad'); }
    finally { setBusyId(''); reload(); }
  };
  return (
    <div class="proposal-slot" ref={room.ref} style={room.style}>
    {list.length ? <Btn kind="sm proposal-return" onClick={request.show}>{t('sess.answerRequest')}</Btn> : null}
    {request.open ? <Modal sheet title={t('as.proposals')} onClose={request.close}>
    <ul class="as-asks modal-body" aria-label={t('as.proposals')}>
      {list.map(p => (
        <li key={p.id} class="as-ask">
          <span class="grow">{t(p.granted ? 'as.proposalGranted' : 'as.proposal', { summary: p.summary })} <small class="muted">{p.id}</small></span>
          {p.granted ? null : <span class="as-ask-btns">
            <Btn kind="primary sm" disabled={busyId === p.id} onClick={() => answer(p, true)}>{t('as.proposalYes')}</Btn>
            <Btn kind="sm" disabled={busyId === p.id} onClick={() => answer(p, false)}>{t('as.proposalNo')}</Btn>
          </span>}
        </li>))}
    </ul></Modal> : null}
    </div>
  );
}

// The first thing on the home page: talk or type, right away. On the home page this card is the
// assistant, with the panel's controls (who it talks to, Voice options), and the floating button
// is not there: the two read as two assistants (main.jsx).
export function HomeAgent({ projects }) {
  const S = useAgent();
  const state = shipStateOf(S);
  return (
    <section class="home-agent">
      <div class="home-agent-head">
        <Ship size={64} state={state} />
        <div>
          <h2>{t('as.today')}</h2>
          {/* what the floating button says everywhere else, said here: the bar that said it went */}
          <p class="home-say" aria-live="polite">{working(state) ? stateWord(S, state) : ''}</p>
        </div>
      </div>
      <Proposals />
      <Console projects={projects} big foot={<TalkTo projects={projects} compact />} />
      {S.feed.length || S.interim ? <Feed limit={8} /> : null}
    </section>
  );
}

// Away from the home page the assistant is one floating button, and it says what the assistant is
// doing ("Working out where it goes…", "Speaking", the ship moving with it), so a request is seen
// to go on without opening the panel. A conversation in progress can be finished and stopped from
// beside it wherever the person is: one started on the home page used to go on listening after
// the page moved to a project, with no Stop on screen. That used to be a bar of its own in the
// middle of the page, with its own Open; with the button beside it, it read as a second assistant.
// THE BUTTON FLOATS ABOVE A COMPOSER, NEVER ON IT. Its height over a composer was a number in
// ui.css, a guess at the composer's height: the taller box a touch screen gets (16px, so iOS does
// not zoom on the focus) put the button over the box's top-right corner, on the words being typed,
// and at a desk over a stack column's mic; a keyboard moved the composer up and left the button
// where it was. So the button measures. Its bottom edge goes GAP px above the top of the highest
// composer under it, whatever that composer's height, keyboard up or down. `bottom` counts from
// the foot of the box a fixed element is placed in, and that foot is read back from where the dock
// IS rather than taken to be the window's: while the keyboard is up #app is pinned to the visible
// area (viewport.js) and the window is not. --launch-b moves the toasts and the task chip with
// the button; --launch-h is the room the chat leaves under its newest message (ui.css).
const GAP = 8;
function useAboveComposers(ref) {
  useLayoutEffect(() => {
    const dock = ref.current, app = dock?.closest('.app');
    if (!dock || !app || typeof ResizeObserver === 'undefined') return undefined;
    const watched = new WeakSet(), last = {};
    const put = (k, v) => {
      if (last[k] === v) return;
      last[k] = v;
      if (v == null) app.style.removeProperty(k); else app.style.setProperty(k, v);
    };
    let frame = 0;
    const place = () => {
      frame = 0;
      const d = dock.getBoundingClientRect();
      if (!d.height) return;
      put('--launch-h', `${Math.round(d.height)}px`);
      const under = [];
      for (const c of app.querySelectorAll('.composer')) {
        if (!watched.has(c)) { watched.add(c); ro.observe(c); }
        const r = c.getBoundingClientRect();
        if (r.height > 0 && r.left < d.right && r.right > d.left) under.push(r.top);
      }
      if (!under.length) { put('--launch-b', null); return; }
      const now = parseFloat(getComputedStyle(dock).bottom) || 0;
      put('--launch-b', `${Math.round(now + d.bottom - (Math.min(...under) - GAP))}px`);
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(place); };
    const ro = new ResizeObserver(soon);
    ro.observe(dock); ro.observe(app);
    // A composer comes and goes with the route and the tab, and a stack's columns scroll sideways
    // under the button; a keyboard resizes the app (viewport.js), which the observer above sees.
    const mo = new MutationObserver(soon);
    mo.observe(app, { childList: true, subtree: true });
    const vv = globalThis.visualViewport;
    addEventListener('resize', soon);
    addEventListener('scroll', soon, true);
    vv?.addEventListener?.('resize', soon);
    place();
    return () => {
      cancelAnimationFrame(frame); ro.disconnect(); mo.disconnect();
      removeEventListener('resize', soon); removeEventListener('scroll', soon, true);
      vv?.removeEventListener?.('resize', soon);
      app.style.removeProperty('--launch-b'); app.style.removeProperty('--launch-h');
    };
  }, []);
}

export function Launcher({ onOpen }) {
  const S = useAgent();
  const dock = useRef(null);
  useAboveComposers(dock);
  const state = shipStateOf(S);
  const live = LIVE.includes(S.phase) || S.conversing;
  const doing = working(state);
  const word = doing ? stateWord(S, state)
    : S.conversing ? `${t('as.name')} · ${t('as.conversing')}` : t('as.name');
  return (
    <div class={`as-dock st-${state}`} ref={dock}>
      {S.phase === 'listening' && S.vs?.hear?.ready ? <span class="vb-meter"><i style={{ width: `${Math.round(S.level * 100)}%` }} /></span> : null}
      {S.phase === 'listening' ? <button class="vb-btn" onClick={talk}><Icon name="check" /> {t('as.done')}</button> : null}
      {live ? <button class="vb-stop" onClick={stop}><Icon name="stop" /> {t('sess.stop')}</button> : null}
      <button class={`as-launch${doing || live ? ' busy' : ''}`} onClick={onOpen} title={t('as.open')}
              aria-label={doing || S.conversing ? `${t('as.open')} · ${word}` : t('as.open')}>
        <Ship size={32} state={doing ? state : 'idle'} /> <span class="as-say" aria-live="polite">{word}</span>
      </button>
    </div>
  );
}
