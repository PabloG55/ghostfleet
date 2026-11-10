import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { STATUS, StatusMark, sinceTs } from './ui.jsx';
import { GhostShip as Ship, Ship as Boat } from './fleet.jsx';
import { t } from './i18n.js';
import { useFleet, useSlot } from './adapter.jsx';

// The whole fleet at once: every project an island, every session a boat in its status
// colour, and the ghost ship flying to wherever something just happened — in any project.
const shipState = (s) => (s === 'working' ? 'acting' : s === 'need-you' ? 'thinking' : s === 'starting' ? 'sending' : 'idle');
const WORD = (s) => (STATUS[s] || STATUS.unknown).label.toLowerCase();

// `ownerName` and `ownerBadge` are the same slots the board takes (adapter.jsx).
export function FleetMap({ projects }) {
  const { go } = useFleet();
  const ownerName = useSlot('ownerName'), ownerBadge = useSlot('ownerBadge');
  const [events, setEvents] = useState([]);
  const [focus, setFocus] = useState(null);            // {project, session}
  const [pos, setPos] = useState(null);
  const [showIdle, setShowIdle] = useState(false);
  const prev = useRef(null);
  const sea = useRef(null);

  useEffect(() => {
    if (!projects) return;
    const now = {};
    for (const p of projects) for (const s of p.sessions) now[`${p.name}/${s.name}`] = { p: p.name, s: s.name, st: s.status, lead: s.lead };
    const before = prev.current;
    prev.current = now;
    if (!before) {
      const latest = projects.flatMap(p => p.sessions.map(s => ({ p: p.name, s }))).sort((a, b) => (b.s.ts || 0) - (a.s.ts || 0))[0];
      if (latest) setFocus({ project: latest.p, session: latest.s.name });
      return;
    }
    const fresh = [];
    for (const [k, v] of Object.entries(now)) {
      const was = before[k];
      if (was && was.st === v.st) continue;
      fresh.push({ id: Math.random(), at: Date.now(), project: v.p, session: v.s, status: v.st,
                   text: !was ? t('map.opened', { project: v.p, session: v.s }) : `${v.p} · ${v.lead ? t('common.lead') : v.s}: ${WORD(v.st)}` });
    }
    for (const k of Object.keys(before)) if (!now[k]) fresh.push({ id: Math.random(), at: Date.now(), project: before[k].p, session: null, text: t('map.closed', { project: before[k].p, session: before[k].s }) });
    if (fresh.length) {
      setEvents(e => [...fresh, ...e].slice(0, 40));
      const f = fresh.find(x => x.session) || fresh[0];
      setFocus({ project: f.project, session: f.session });
    }
  }, [projects]);

  // The ghost ship is placed over the boat it is visiting, measured, so it sails there.
  useLayoutEffect(() => {
    const root = sea.current;
    if (!root || !focus) return;
    const sel = focus.session ? `[data-boat="${CSS.escape(`${focus.project}/${focus.session}`)}"]` : `[data-island="${CSS.escape(focus.project)}"]`;
    const el = root.querySelector(sel) || root.querySelector(`[data-island="${CSS.escape(focus.project)}"]`);
    if (!el) return;
    const isl = root.querySelector(`[data-island="${CSS.escape(focus.project)}"]`) || el;
    const a = root.getBoundingClientRect(), b = el.getBoundingClientRect(), i = isl.getBoundingClientRect();
    setPos({ x: b.left - a.left + b.width / 2 + root.scrollLeft, y: i.top - a.top + root.scrollTop });
  }, [focus, projects, showIdle]);

  const active = (projects || []).filter(p => p.sessions.length);
  const idle = (projects || []).filter(p => !p.sessions.length);
  const shown = showIdle ? [...active, ...idle] : active;
  const fs = focus && (projects || []).find(p => p.name === focus.project)?.sessions.find(s => s.name === focus.session);

  return (
    <div class="page map-page">
      <header class="page-head">
        <div><h1>{t('nav.map')}</h1><p class="muted">{t('map.sub')}</p></div>
        <label class="toggle-inline"><input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.currentTarget.checked)} /> {t('map.showIdle', { n: idle.length })}</label>
      </header>
      <div class="map-wrap">
        <div class="ocean" ref={sea}>
          {projects == null ? <p class="muted pad">{t('map.reading')}</p> : null}
          {projects && !shown.length ? <p class="muted pad">{t('map.none')}</p> : null}
          {shown.map(p => (
            <section key={p.name} class={`island${p.counts.need_you ? ' hot' : ''}${focus?.project === p.name ? ' focus' : ''}`} data-island={p.name}>
              <button class="island-name" onClick={() => go(`/p/${encodeURIComponent(p.name)}`)}>
                {p.name}{p.counts.need_you ? <span class="badge need">{p.counts.need_you}</span> : null}
              </button>
              <div class="boats">
                {p.sessions.map(s => {
                  const st = STATUS[s.status] || STATUS.unknown;
                  const owner = ownerName(s), badge = ownerBadge(s, 15);
                  return (
                    <button key={s.name} class={`boat c-${st.color} st-${s.status}`} data-boat={`${p.name}/${s.name}`}
                            title={`${s.name} · ${st.label}${owner ? ` · ${owner}` : ''}`}
                            onClick={() => go(`/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.name)}`)}>
                      <Boat size={34} state={s.status} />
                      <span class="boat-name">{s.lead ? t('common.lead') : s.name}</span>
                      {badge ? <span class="boat-owner">{badge}</span> : null}
                    </button>
                  );
                })}
                {!p.sessions.length ? <span class="muted small">{t('map.noSessions')}</span> : null}
              </div>
            </section>
          ))}
          {pos ? (
            <div class="ghostship" style={{ transform: `translate(calc(${pos.x}px - 50%), ${pos.y - 64}px)` }}>
              {focus ? <span class="ghost-tag">{focus.session ? `${focus.project} · ${focus.session}` : focus.project}</span> : null}
              <Ship size={64} state={fs ? shipState(fs.status) : 'idle'} />
              <span class="ghost-beam" />
            </div>
          ) : null}
        </div>
        <aside class="ticker">
          <h2>{t('map.live')}</h2>
          {!events.length ? <p class="muted small">{t('map.waiting')}</p> : null}
          {events.map(e => (
            <button key={e.id} class={`tick c-${(STATUS[e.status] || STATUS.unknown).color}`}
                    onClick={() => { setFocus({ project: e.project, session: e.session }); if (e.session) go(`/p/${encodeURIComponent(e.project)}/s/${encodeURIComponent(e.session)}`); }}>
              <b><StatusMark status={e.status} /></b> <span>{e.text}</span> <small>{sinceTs(Math.floor(e.at / 1000))}</small>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
