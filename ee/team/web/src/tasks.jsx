import { useState } from 'preact/hooks';
import { useAgent, place, tickOff } from './agent.js';
import { plainText } from './voice.js';
import { t, locale } from './i18n.js';
import { worded } from '../../shared/i18n/index.js';

// Everything asked of the assistant and where it stands. It is beside whatever page is open, so
// that hopping between projects while talking does not lose anything along the way.
const STATES = worded({
  ask: { color: 'yellow', rank: 0 },
  failed: { color: 'red', rank: 0 },
  'need-you': { color: 'red', rank: 1 },
  replied: { color: 'green', rank: 2 },
  working: { color: 'cyan', rank: 3 },
  sent: { color: 'grey', rank: 4 },
  sending: { color: 'grey', rank: 4 },
}, 'task.state');
const shown = (S) => S.tasks.filter(x => !x.hidden).sort((a, b) => STATES[a.status].rank - STATES[b.status].rank || a.at - b.at);
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function Places({ task, projects }) {
  const [all, setAll] = useState(false);
  const names = (projects || []).map(p => p.name).sort((a, b) => a.localeCompare(b));
  const list = all || !task.options.length ? names : task.options;
  return (
    <div class="tk-places">
      {list.map(n => <button key={n} class="pchip" onClick={() => place(task, n)}>{n}</button>)}
      {task.options.length && !all ? <button class="pchip more" onClick={() => setAll(true)}>{t('task.other')}</button> : null}
    </div>
  );
}

function Task({ ctx, task, projects }) {
  const [open, setOpen] = useState(false);
  const st = STATES[task.status];
  const last = task.replies[task.replies.length - 1];
  const where = task.session || t('common.lead');
  const waiting = task.status === 'ask' || task.status === 'failed';
  const goTo = () => ctx.go(`/p/${encodeURIComponent(task.project)}${task.session ? `/s/${encodeURIComponent(task.session)}` : ''}`);
  return (
    <li class={`tk c-${st.color}`}>
      <div class="tk-top">
        <span class="tk-state">{st.label}</span>
        <small class="tk-time">{hhmm(task.at)}</small>
        <button class="tk-ok" aria-label={t('task.tickAria', { title: task.title })} title={t('task.tick')} onClick={() => tickOff(task.id)}>✓</button>
      </div>
      <button class="tk-title" aria-expanded={open} onClick={() => setOpen(o => !o)}>{task.title}</button>
      {task.project ? <button class="tk-place" onClick={goTo}>{task.project} · {where}</button> : null}
      {waiting ? <><p class="tk-q">{task.error || task.question}</p><Places task={task} projects={projects} /></> : null}
      {last && !open ? <p class="tk-reply">{plainText(last.text).slice(0, 110)}</p> : null}
      {open ? (
        <div class="tk-more">
          <p class="tk-said">“{task.text}”</p>
          {task.replies.map(r => <p key={r.ts} class="tk-reply full">{plainText(r.text)}</p>)}
        </div>
      ) : null}
    </li>
  );
}

export function TaskRail({ ctx, projects, onClose }) {
  const S = useAgent();
  const list = shown(S);
  const replied = list.filter(x => x.status === 'replied').length;
  return (
    <aside class="rail" aria-label={t('task.title')}>
      <header class="rail-head">
        <b>{t('task.title')}</b><span class="n">{list.length}</span>
        <span class="grow" />
        {replied > 1 ? <button class="rail-clear" onClick={() => tickOff('')}>{t('task.clear')}</button> : null}
        <button class="x" aria-label={t('task.hide')} onClick={onClose}>✕</button>
      </header>
      <ul class="tk-list">
        {list.map(x => <Task key={x.id} ctx={ctx} task={x} projects={projects} />)}
        {S.deciding.map(d => <li key={d.id} class="tk c-grey deciding"><span class="tk-state">{t('task.deciding')}</span><p class="tk-said">“{d.text}”</p></li>)}
      </ul>
    </aside>
  );
}

export function TaskChip({ onClick, floating }) {
  const S = useAgent();
  const list = shown(S);
  const waiting = list.filter(x => STATES[x.status].rank < 2).length;
  return (
    <button class={`tk-chip${floating ? ' floating' : ''}`} onClick={onClick} aria-label={t('task.see', { n: list.length })}>
      {t('task.title')} {list.length + S.deciding.length}{waiting ? <span class="badge bad">{waiting}</span> : null}
    </button>
  );
}
