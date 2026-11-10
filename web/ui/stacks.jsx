// Suggested hash routes: #/stack-picker and #/stack/:members (URI-encoded JSON array).
import { useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { useKept } from './back.jsx';
import { usePoll, Btn, StatusPill } from './ui.jsx';
import { SessionView } from './session.jsx';
import { useKeys } from './keyboard.jsx';
import { t } from './i18n.js';
import { PhoneScreen, sessionRoute } from './phone-screen.jsx';
const keyOf = m => JSON.stringify([m.project, m.session]);
export function StackPicker({ members = [], onOpen }) {
  const fleet = useFleet();
  const [selected, setSelected] = useKept('stack.members', members), [query, setQuery] = useKept('stack.query', '');
  const { data, error, loading } = usePoll(async () => { const p = await fleet.screenProjects(); return Promise.all((p.projects || []).filter(p => !p.sessions || p.sessions.total !== 0).map(async p => { try { return { ...p,...await fleet.grid(p.name) }; } catch(error) { return { ...p,cards:[],error }; } })); }, 5000, []);
  const toggle = m => setSelected(items => items.some(x => keyOf(x) === keyOf(m)) ? items.filter(x => keyOf(x) !== keyOf(m)) : [...items, m]);
  const open = () => selected.length && (onOpen ? onOpen(selected) : fleet.go(`/stack/${encodeURIComponent(JSON.stringify(selected))}`));
  useKeys(key => { if (!key.ctrl && !key.alt && key.k === 'Enter') { open(); return true; } return false; });
  return <PhoneScreen title={t('phone.stacks')} error={error || data?.find(p => p.error)?.error} loading={loading} actions={<Btn kind="primary" disabled={!selected.length} onClick={open}>{t('phone.openStack', { n: selected.length })}</Btn>}><label class="field"><span>{t('phone.search')}</span><input type="search" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
    {(data || []).map(p => { const cards = (p.cards || []).filter(c => !c.lost && `${p.name} ${c.name} ${c.branch || ''} ${c.msg || ''}`.toLowerCase().includes(query.toLowerCase())); return cards.length ? <section key={p.name}><h2>{p.name} {p.host ? `· ${p.host}` : ''}</h2><div class="extra-grid">{cards.map(c => { const m = { project: p.name, session: c.name }; return <label class="card extra-card stack-choice" key={c.name}><input type="checkbox" checked={selected.some(x => keyOf(x) === keyOf(m))} onChange={() => toggle(m)} /><h3>{c.name}</h3><StatusPill status={c.status} small /><p class="muted">{c.branch}</p><p>{c.msg}</p></label>; })}</div></section> : null; })}
    {data && !data.some(p => p.cards?.some(c => !c.lost)) ? <p class="empty">{t('phone.noSessions')}</p> : null}</PhoneScreen>;
}
export function StackView({ members = [] }) {
  const fleet = useFleet(), [active, setActive] = useState(0);
  return <PhoneScreen title={t('phone.stacks')} parent="/stack-picker" actions={<Btn onClick={() => fleet.go('/stack-picker')}>{t('phone.editStack')}</Btn>}>
    {!members.length ? <p class="empty">{t('phone.emptyStack')}</p> : <><div class="seg" role="tablist">{members.map((m, i) => <button role="tab" aria-selected={active === i} class={active === i ? 'on' : ''} onClick={() => setActive(i)}>{m.project} · {m.session}</button>)}</div><div class="stack-columns">{members.map((m, i) => <section class={`stack-column${i === active ? ' stack-active' : ''}`} key={keyOf(m)} onFocusIn={() => setActive(i)}><header class="row wrap"><h2>{m.project} · {m.session}</h2><Btn onClick={() => fleet.go(sessionRoute(m.project, m.session))}>{t('phone.openSession')}</Btn></header><SessionView project={m.project} name={m.session} onChanged={() => {}} onGone={() => fleet.go('/stack-picker')} /></section>)}</div></>}
  </PhoneScreen>;
}
