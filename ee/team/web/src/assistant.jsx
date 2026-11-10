import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { STATUS, StatusMark, statusOf, Btn } from '../../../../web/ui/ui.jsx';
import { Select, Popover } from '../../../../web/ui/select.jsx';
import { plainText, browserCanHear, PAUSES } from './voice.js';
import { useAgent, talk, stop, submit, setTarget, setOption, canHear, busy, unframe } from './agent.js';
import { VoicePicker } from './voices.jsx';
import { t } from './i18n.js';
import { words } from '../../shared/i18n/index.js';
import { Icon } from '../../../../web/ui/icon.jsx';
// The assistant's face: ghostfleet's own SHIP sprite, the one the app icon is drawn from.
import { GhostShip as Ship } from '../../../../web/ui/fleet.jsx';

const STATE_WORDS = words(['listening', 'hearing', 'routing', 'sending', 'starting', 'thinking', 'acting', 'speaking', 'idle', 'off'], 'ship');

export function shipStateOf(S) {
  if (['listening', 'hearing', 'routing', 'sending', 'starting', 'speaking'].includes(S.phase)) return S.phase;
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

export function Console({ projects, big }) {
  const S = useAgent();
  const [typed, setTyped] = useState('');
  const listening = S.phase === 'listening' || S.phase === 'hearing';
  const active = busy() || listening;
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
    </div>
  );
}

export function Feed({ ctx, limit, empty }) {
  const S = useAgent();
  const ref = useRef(null);
  const rows = limit ? S.feed.slice(-limit) : S.feed;
  useEffect(() => { const n = ref.current; if (n) n.scrollTop = n.scrollHeight; }, [S.feed.length, S.interim]);
  return (
    <div class="as-feed" ref={ref}>
      {!rows.length && !S.interim ? empty : null}
      {rows.map(e => (
        <div key={e.id} class={`as-row ${e.kind}${e.bad ? ' bad' : ''}${e.ask ? ' ask-row' : ''}`}
             onClick={e.session && e.project ? () => ctx.go(`/p/${encodeURIComponent(e.project)}/s/${encodeURIComponent(e.session)}`) : undefined}>
          {e.kind === 'me' ? <><span class="tag-me">{e.voice ? <><Icon name="mic" /> {t('settings.you')}</> : t('settings.you')}</span> {unframe(e.text)}</>
            : e.kind === 'ai' ? <><span class="tag-ai">{e.project || t('common.lead')}</span>{e.title ? <em class="tag-about"> {e.title}</em> : null} {plainText(e.text)}</>
            : <><span class="tag-ev">{e.ask ? t('as.question') : t('as.live')}</span> {e.text}</>}
        </div>
      ))}
      {S.interim ? <div class="as-row me live"><span class="tag-me"><Icon name="mic" /></span> {S.interim}…</div> : null}
    </div>
  );
}

function Sea({ ctx }) {
  const S = useAgent();
  const state = shipStateOf(S);
  const lane = [...S.cards].sort((a, b) => Number(b.lead) - Number(a.lead));
  const at = Math.max(0, lane.findIndex(c => c.name === S.focus));
  return (
    <div class={`sea st-${state}`}>
      <div class="ship-track" style={{ '--i': at, '--n': Math.max(lane.length, 1) }}>
        <Ship size={64} state={state} />
        <span class="ship-say">{STATE_WORDS[state]}{state === 'acting' && S.focus ? ` ${t('as.in', { where: S.focus })}` : ''}</span>
      </div>
      <div class="lane" style={{ '--n': Math.max(lane.length, 1) }}>
        {!lane.length ? <span class="muted small lane-empty">{t('as.laneEmpty')}</span> : null}
        {lane.map(c => {
          const s = statusOf(c);
          return (
            <button key={c.name} class={`buoy c-${(STATUS[s] || STATUS.unknown).color}${c.name === S.focus ? ' on' : ''}`}
                    title={`${c.label || c.name} · ${(STATUS[s] || STATUS.unknown).label}`}
                    onClick={() => ctx.go(`/p/${encodeURIComponent(S.target)}/s/${encodeURIComponent(c.name)}`)}>
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

export function Assistant({ ctx, projects, onClose, chip }) {
  const S = useAgent();
  const list = useMemo(() => rankedProjects(projects), [projects]);
  const [choosing, setChoosing] = useState(false);
  return (
    <aside class="assistant" aria-label={t('as.name')}>
      <header class="as-head">
        <div><b>{t('as.name')}</b><small>{t('as.sub')}</small></div>
        <span class="as-head-end">{chip}<Btn kind="sm" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>{choosing ? t('common.back') : t('as.pickVoice')}</Btn><button class="x" aria-label={t('as.close')} onClick={onClose}>✕</button></span>
      </header>
      <Select field="field as-target" label={t('as.talkingTo')} value={S.target} onChange={setTarget}
              options={[...(!S.target ? [{ value: '', label: t('as.pickProject') }] : []),
                ...list.map(p => ({ value: p.name, label: p.sessions.some(s => s.lead) ? p.name : `${p.name} (${t('ship.off').toLowerCase()})` }))]} />
      {choosing ? <div class="as-voices"><VoicePicker admin={ctx.admin} /></div> : <><Sea ctx={ctx} /><Feed ctx={ctx} empty={<Hint />} /></>}
      <div class="as-controls"><Console projects={projects} /></div>
    </aside>
  );
}

// The first thing on the home page: talk or type, right away.
export function HomeAgent({ ctx, projects }) {
  const S = useAgent();
  return (
    <section class="home-agent">
      <div class="home-agent-head">
        <Ship size={64} state={shipStateOf(S)} />
        <div>
          <h2>{t('as.today')}</h2>
        </div>
      </div>
      <Console projects={projects} big />
      {S.feed.length || S.interim ? <Feed ctx={ctx} limit={8} /> : null}
    </section>
  );
}

// Wherever the person is, a conversation in progress can be seen and stopped. Without this,
// one started on the home page went on listening after the page moved to a project, with
// no Stop on screen.
export function VoiceBar({ onOpen }) {
  const S = useAgent();
  const state = shipStateOf(S);
  const live = ['listening', 'hearing', 'routing', 'sending', 'starting', 'speaking'].includes(S.phase) || S.conversing;
  if (!live) return null;
  return (
    <div class={`voicebar st-${state}`} role="status">
      <Ship size={32} state={state} />
      <span class="vb-text">
        {STATE_WORDS[state] || t('ship.idle')}{S.conversing && state === 'idle' ? ` · ${t('as.conversing')}` : ''}
        {S.interim ? <em> “{S.interim}”</em> : null}
      </span>
      {S.phase === 'listening' && S.vs?.hear?.ready ? <span class="vb-meter"><i style={{ width: `${Math.round(S.level * 100)}%` }} /></span> : null}
      {S.phase === 'listening' ? <button class="vb-btn" onClick={talk}><Icon name="check" /> {t('as.done')}</button> : null}
      <button class="vb-btn" onClick={onOpen}>{t('as.openBtn')}</button>
      <button class="vb-stop" onClick={stop}><Icon name="stop" /> {t('sess.stop')}</button>
    </div>
  );
}
