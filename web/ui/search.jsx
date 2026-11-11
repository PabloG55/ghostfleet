// Mounted at #/search?q=… (app.jsx's route table), in both apps. SearchInput is its field.
import { useRef, useEffect, useState } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { useKept } from './back.jsx';
import { useKeys } from './keyboard.jsx';
import { usePoll, Btn, StatusPill, splitAddr } from './ui.jsx';
import { t } from './i18n.js';
import { PhoneScreen, joinMeta, sessionRoute } from './phone-screen.jsx';
import { Skeleton, SkelLine } from './skeleton.jsx';
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
  const { data, error, loading } = usePoll(() => fleet.screenProjects(), 15000, [], { key: 'screenProjects' });
  // ONE GRID PER PROJECT IS THE DEAREST READ THERE IS (a fleet-grid run each, on the daemon), and
  // this asked for all of them every 5 s — and again whenever the project list was re-read, because
  // the list's OBJECT was a dependency and every poll makes a new one: each of those emptied the
  // results and filled them back in. Measured on a daemon with three projects, a search left open
  // read 90 times a minute, of the 240 a device gets. The grids now depend on WHICH projects there
  // are, not on the list having been read again, and both reads go round every 15 s: a search is
  // looked at for seconds, and coming back to the page re-reads at once (usePoll).
  const wanted = (data?.projects || []).filter(p => !p.sessions || p.sessions.total !== 0);
  const names = wanted.map(p => p.name).join('\n');
  const { data: grids, error: gridError, loading: gridLoading } = usePoll(async () => !q.trim() ? [] : Promise.all(wanted.map(async p => { try { return { project:p,...await fleet.grid(p.name) }; } catch(error) { return { project:p,cards:[],error }; } })), 15000, [names, !!q.trim()]);
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
  return <PhoneScreen title={t('phone.search')} error={openError || error || gridError || grids?.find(g => g.error)?.error} loading={loading || (!!needle && gridLoading)}
    skeleton={<section><h2><SkelLine w="6em" /></h2><Skeleton shape="cards" box="extra-grid" n={3} /></section>}>
    <SearchInput value={q} onChange={setQ} onOpen={first} inputRef={field} />
    {projects.length ? <section><h2>{t('phone.projects')}</h2><div class="extra-grid">{projects.map(p => <button class="card extra-card" key={p.name} onClick={() => openProject(p)}><h3>{splitAddr(p.name)[0]}</h3><p class="muted">{p.host || p.path}</p></button>)}</div></section> : null}
    {needle && sessions.length ? <section><h2>{t('phone.sessions')}</h2><div class="extra-grid">{sessions.map(({ project: p, card: c }) => <button class="card extra-card" key={`${p.name}/${c.name}`} onClick={() => fleet.go(sessionRoute(p.name, c.name))}><StatusPill status={c.status} small /><h3>{c.name}</h3><p>{joinMeta(p.name, p.host)}</p><p class="muted">{c.branch} {c.pr} {c.label}</p><p>{c.msg}</p></button>)}</div></section> : null}
    {!loading && (!needle || !gridLoading) && !sessions.length && !projects.length ? <p class="empty">{t('phone.noMatches')}</p> : null}
  </PhoneScreen>;
}
