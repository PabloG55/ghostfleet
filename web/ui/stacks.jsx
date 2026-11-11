// Mounted at #/stack-picker and #/stack/:members, a URI-encoded JSON array (app.jsx's route table), in both apps.
import { useState, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { useKept } from './back.jsx';
import { usePoll, Btn, StatusPill, splitAddr } from './ui.jsx';
import { SessionView } from './session.jsx';
import { useKeys } from './keyboard.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta, sessionRoute } from './phone-screen.jsx';
// A paired machine's project is `<name>@<key>` and also carries `host`: drawn as both it read
// `acme-api@vm · vm`. The heading takes the bare name beside the host; a member's label keeps
// the machine, because a stack can hold this machine's acme-api and the other one's.
const memberName = (m) => joinMeta(...splitAddr(m.project), m.session);
const keyOf = m => JSON.stringify([m.project, m.session]);
export function StackPicker({ members = [], onOpen }) {
  const fleet = useFleet();
  const [selected, setSelected] = useKept('stack.members', members), [query, setQuery] = useKept('stack.query', '');
  const { data, error, loading } = usePoll(async () => { const p = await fleet.screenProjects(); return Promise.all((p.projects || []).filter(p => !p.sessions || p.sessions.total !== 0).map(async p => { try { return { ...p,...await fleet.grid(p.name) }; } catch(error) { return { ...p,cards:[],error }; } })); }, 5000, []);
  const toggle = m => setSelected(items => items.some(x => keyOf(x) === keyOf(m)) ? items.filter(x => keyOf(x) !== keyOf(m)) : [...items, m]);
  const open = () => selected.length && (onOpen ? onOpen(selected) : fleet.go(`/stack/${encodeURIComponent(JSON.stringify(selected))}`));
  useKeys(key => { if (!key.ctrl && !key.alt && key.k === 'Enter') { open(); return true; } return false; });
  const [expanded, setExpanded] = useKept('stack.expanded', {});
  const search = query.trim().toLowerCase();
  return <PhoneScreen class="stack-picker" title={t('phone.stacks')} error={error || data?.find(p => p.error)?.error} loading={loading} actions={<Btn kind="primary" disabled={!selected.length} onClick={open}>{t('phone.openStack', { n: selected.length })}</Btn>}>
    <label class="field stack-search"><span>{t('phone.search')}</span><input type="search" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
    <div class="stack-list" data-keep-scroll="stack-list">
      {(data || []).map(p => {
        const sessions = (p.cards || []).filter(c => !c.lost);
        const cards = sessions.filter(c => `${p.name} ${p.host || ''} ${c.name} ${c.branch || ''}`.toLowerCase().includes(search));
        const count = selected.filter(m => m.project === p.name).length;
        const isOpen = search ? true : (expanded[p.name] ?? !!count);
        return cards.length ? <details class="stack-group" key={p.name} open={isOpen}
          onToggle={e => { const open = e.currentTarget.open; if (!search && open !== isOpen) setExpanded(v => ({ ...v, [p.name]: open })); }}>
          <summary><h2>{joinMeta(splitAddr(p.name)[0], p.host)}</h2><span class="muted">{t('phone.stackCount', { n: sessions.length, selected: count })}</span></summary>
          <div>{cards.map(c => { const m = { project: p.name, session: c.name }; return <label class="stack-choice" key={c.name}>
            <input type="checkbox" checked={selected.some(x => keyOf(x) === keyOf(m))} onChange={() => toggle(m)} />
            <span class="stack-name">{c.name}</span><StatusPill status={c.status} small /><span class="muted stack-branch">{c.branch}</span>
          </label>; })}</div>
        </details> : null;
      })}
      {data && !data.some(p => p.cards?.some(c => !c.lost)) ? <p class="empty">{t('phone.noSessions')}</p> : null}
    </div>
  </PhoneScreen>;
}
// ONE COLUMN AT A TIME BELOW 760 PX, and only that one is mounted: a hidden column that stays
// mounted goes on reading its transcript and its pane, so a stack of four on a phone read four
// sessions to show one. The others are mounted beside it at a desk, quiet (SessionView `quiet`)
// until one takes the focus. Their drafts are drafts.js's, so a column swapped out keeps its words.
const NARROW = '(max-width: 759px)';
function useNarrow() {
  const q = () => { try { return matchMedia(NARROW).matches; } catch { return false; } };
  const [narrow, setNarrow] = useState(q);
  useEffect(() => {
    let m; try { m = matchMedia(NARROW); } catch { return undefined; }
    const f = () => setNarrow(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return narrow;
}
export function StackView({ members = [] }) {
  const fleet = useFleet(), [active, setActive] = useState(0), narrow = useNarrow();
  const projects = [...new Set(members.map(m => m.project))];
  // One grid per project, shared by its columns. Reserve at most eight reads per minute
  // for cards, on top of SessionView's focused/quiet budget (twelve columns: 238 total).
  const cards = usePoll(async () => Object.fromEntries(await Promise.all(projects.map(async project =>
    [project, (await fleet.grid(project)).cards || []]))), Math.max(5000, projects.length * 7500), [JSON.stringify(projects)]);
  return <PhoneScreen class="stack-view" error={cards.error} title={t('phone.stacks')} parent="/stack-picker" actions={<Btn onClick={() => fleet.go('/stack-picker')}>{t('phone.editStack')}</Btn>}>
    {!members.length ? <p class="empty">{t('phone.emptyStack')}</p> : <>{narrow ? <div class="seg stack-switcher" role="tablist">{members.map((m, i) => <button role="tab" aria-selected={active === i} class={active === i ? 'on' : ''} onClick={() => setActive(i)}>{memberName(m)}</button>)}</div> : null}<div class="stack-columns">{members.map((m, i) => <section class={`stack-column${i === active ? ' stack-active' : ''}`} key={keyOf(m)} onPointerDown={() => setActive(i)} onFocusIn={() => setActive(i)}><header class="row wrap"><h2>{memberName(m)}</h2><Btn onClick={() => fleet.go(sessionRoute(m.project, m.session))}>{t('phone.openSession')}</Btn></header>{narrow && i !== active ? null : <SessionView card={cards.data?.[m.project]?.find(c => c.name === m.session)} embedded quiet={i !== active} project={m.project} name={m.session} onChanged={cards.reload} onGone={() => fleet.go('/stack-picker')} />}</section>)}</div></>}
  </PhoneScreen>;
}
