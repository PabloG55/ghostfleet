import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { STATUS, StatusMark, statusOf, Btn } from './ui.jsx';
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
        <Btn kind="primary" type="submit" disabled={!typed.trim()}>{t('common.send')}</Btn>
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
  useEffect(() => { const n = ref.current; if (n) n.scrollTop = n.scrollHeight; }, [S.feed.length, S.interim]);
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
      {choosing && voices ? <div class="as-voices"><VoicePicker /></div> : <><Sea /><Feed empty={<Hint />} /></>}
      <div class="as-controls"><Console projects={projects} /></div>
    </aside>
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
export function Launcher({ onOpen }) {
  const S = useAgent();
  const state = shipStateOf(S);
  const live = LIVE.includes(S.phase) || S.conversing;
  const doing = working(state);
  const word = doing ? stateWord(S, state)
    : S.conversing ? `${t('as.name')} · ${t('as.conversing')}` : t('as.name');
  return (
    <div class={`as-dock st-${state}`}>
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
