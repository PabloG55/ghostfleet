// Suggested hash route: #/search. SearchInput can also be mounted in either sidebar.
import { useRef, useEffect, useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { useKept } from './back.jsx';
import { useKeys } from './keyboard.jsx';
import { usePoll, Btn, StatusPill } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta, sessionRoute } from './phone-screen.jsx';
export function SearchInput({ value, onChange, onOpen, inputRef }) {
  const fleet = useFleet();
  return <form class="extra-search" role="search" onSubmit={e => { e.preventDefault(); onOpen ? onOpen() : fleet.go(`/search?q=${encodeURIComponent(value || '')}`); }}>
    <input ref={inputRef} type="search" aria-label={t('phone.search')} placeholder={t('phone.searchHint')} value={value || ''} onInput={e => onChange(e.currentTarget.value)} />
    <Btn onClick={() => onOpen ? onOpen() : fleet.go(`/search?q=${encodeURIComponent(value || '')}`)}>{t('phone.search')}</Btn></form>;
}
export function Search({ query = '' }) {
  const fleet = useFleet(), field = useRef();
  const [openError, setOpenError] = useState(null);
  const [q, setQ] = useKept('search.query', query);
  const { data, error, loading } = usePoll(() => fleet.screenProjects(), 5000, []);
  const { data: grids, error: gridError, loading: gridLoading } = usePoll(async () => !q.trim() ? [] : Promise.all((data?.projects || []).filter(p => !p.sessions || p.sessions.total !== 0).map(async p => { try { return { project:p,...await fleet.grid(p.name) }; } catch(error) { return { project:p,cards:[],error }; } })), 5000, [data, !!q.trim()]);
  const needle = q.trim().toLocaleLowerCase();
  const projects = (data?.projects || []).filter(p => !needle || `${p.name} ${p.path || ''}`.toLocaleLowerCase().includes(needle));
  const sessions = (grids || []).flatMap(g => (g.cards || []).filter(c => !c.lost && `${c.name} ${c.branch || ''} ${c.path || ''} ${c.pr || ''} ${c.msg || ''} ${c.label || ''}`.toLocaleLowerCase().includes(needle)).map(c => ({ project: g.project, card: c })));
  const openProject = async p => {
    setOpenError(null);
    try {
      if (p.canPrompt === false) { const g = await fleet.grid(p.name); fleet.go(sessionRoute(p.name, g.cards?.find(c => c.lead)?.name)); return; }
      const r = await fleet.lead(p.name); fleet.go(sessionRoute(p.name, r.session || r.lead || 'master'));
    } catch (e) { setOpenError(e); }
  };
  const first = () => projects.length ? openProject(projects[0]) : sessions.length ? fleet.go(sessionRoute(sessions[0].project.name, sessions[0].card.name)) : null;
  useEffect(() => { field.current?.focus(); }, []);
  useKeys(key => { if (!key.ctrl && !key.alt && key.k === '/') { field.current?.focus(); return true; } return false; });
  return <PhoneScreen title={t('phone.search')} error={openError || error || gridError || grids?.find(g => g.error)?.error} loading={loading}>
    <SearchInput value={q} onChange={setQ} onOpen={first} inputRef={field} />
    {projects.length ? <section><h2>{t('phone.projects')}</h2><div class="extra-grid">{projects.map(p => <button class="card extra-card" key={p.name} onClick={() => openProject(p)}><h3>{p.name}</h3><p class="muted">{p.host || p.path}</p></button>)}</div></section> : null}
    {needle && sessions.length ? <section><h2>{t('phone.sessions')}</h2><div class="extra-grid">{sessions.map(({ project: p, card: c }) => <button class="card extra-card" key={`${p.name}/${c.name}`} onClick={() => fleet.go(sessionRoute(p.name, c.name))}><StatusPill status={c.status} small /><h3>{c.name}</h3><p>{joinMeta(p.name, p.host)}</p><p class="muted">{c.branch} {c.pr} {c.label}</p><p>{c.msg}</p></button>)}</div></section> : null}
    {!loading && (!needle || !gridLoading) && !sessions.length && !projects.length ? <p class="empty">{t('phone.noMatches')}</p> : null}
  </PhoneScreen>;
}
