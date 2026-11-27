// The home page as a picture of the fleet: every fleet with something open is a tile, every
// session a boat in the colour of what it is doing. Words only where a click is needed — who a
// boat is, on hover (shiptip.jsx), and the names of the boats that are waiting for an answer.
import { useKept } from './back.jsx';
import { Ship, Led } from './fleet.jsx';
import { t, worded } from './i18n.js';
import { useSlot, useFleet } from './adapter.jsx';
import { useShipTips } from './shiptip.jsx';
import { ProjectName } from './ui.jsx';
import { Skeleton, SkelLine, useRoom } from './skeleton.jsx';
import { useWake } from './wake.jsx';

const FRESH_S = 15 * 60;        // "just finished": ready, and its turn ended this recently

// What a person needs to tell apart at a glance, in order of urgency. Each look is drawn with
// a status light (lights.js), so the board speaks the same colours as every LED in the app.
export const LOOKS = worded({
  need:  { color: 'yellow', light: 'wait' },
  work:  { color: 'green',  light: 'work' },
  fresh: { color: 'cyan',   light: 'done' },
  warn:  { color: 'red',    light: 'error' },
  open:  { color: 'white',  light: 'idle' },
  off:   { color: 'grey',   light: 'off' },
}, 'look');
const ORDER = Object.keys(LOOKS);

export function lookOf(s, now = Date.now() / 1000) {
  switch (s.status) {
    case 'need-you': return 'need';
    case 'working': case 'starting': return 'work';
    case 'ready': return s.ts && now - s.ts < FRESH_S ? 'fresh' : 'open';
    case 'limit': case 'interrupted': case 'unknown': return 'warn';
    case 'idle': return 'open';
    default: return 'off';                     // lost, asleep, parked
  }
}

const sessionPath = (p, s) => `/p/${encodeURIComponent(p)}/s/${encodeURIComponent(s)}`;
const sessionHref = (p, s) => `#${sessionPath(p, s)}`;
const projectHref = (p) => `#/p/${encodeURIComponent(p)}`;

// `ownerBadge(session, size)` is an app's slot (adapter.jsx): who a boat belongs to, as a badge
// on it; its card names them (ownerName). The single-user client has neither.
//   AN ASLEEP BOAT WAKES BEFORE IT OPENS (wake.jsx), as a card does: its link would open the page
// of a session that is not there. While the wake is out it is drawn as starting.
export function Board({ projects }) {
  const ownerBadge = useSlot('ownerBadge');
  const fleet = useFleet();
  const wk = useWake();
  const tips = useShipTips();
  const room = useRoom('legend', projects == null);
  const [showQuiet, setShowQuiet] = useKept('board.quiet', false);
  const now = Date.now() / 1000;
  const fleets = (projects || []).map(p => {
    const boats = p.sessions.map(s => ({ ...s, look: lookOf(wk.waking(p.name, s.name) ? { ...s, status: 'starting' } : s, now) }))
      .sort((a, b) => ORDER.indexOf(a.look) - ORDER.indexOf(b.look) || Number(b.lead) - Number(a.lead));
    const n = Object.fromEntries(ORDER.map(k => [k, boats.filter(b => b.look === k).length]));
    const top = ORDER.find(k => n[k]) || 'off';
    const last = Math.max(0, ...p.sessions.map(s => s.ts || 0));
    return { name: p.name, boats, n, top, last };
  });
  const live = fleets.filter(f => f.top !== 'off')
    .sort((a, b) => ORDER.indexOf(a.top) - ORDER.indexOf(b.top) || b.n.need - a.n.need || b.n.work - a.n.work || b.last - a.last);
  const quiet = fleets.filter(f => f.top === 'off').sort((a, b) => b.boats.length - a.boats.length || a.name.localeCompare(b.name));
  const total = Object.fromEntries(ORDER.map(k => [k, fleets.reduce((x, f) => x + f.n[k], 0)]));

  // Its own frame while the fleet is read: the legend, at the height it had last time (its chips
  // wrap on a phone), and the grid the projects go in.
  if (projects == null) return <section class="board"><div class="legend" ref={room.ref} style={room.style}><span class="lg"><SkelLine w="9em" /></span></div><Skeleton shape="fleets" box="fleets" n={3} /></section>;
  return (
    <section class="board">
      <div class="legend" role="list" ref={room.ref}>
        {ORDER.filter(k => total[k]).map(k => (
          <span key={k} role="listitem" class={`lg c-${LOOKS[k].color} lk-${k}`}><Led state={LOOKS[k].light} hidden />{total[k]} <small>{LOOKS[k].label}</small></span>
        ))}
      </div>
      {live.length ? (
        <div class="fleets">
          {live.map(f => (
            <article key={f.name} class={`fleet c-${LOOKS[f.top].color} lk-${f.top}`} onPointerEnter={() => tips.warm(f.name)}>
              <a class="fleet-name" href={projectHref(f.name)} title={t('board.open', { name: f.name })}><ProjectName name={f.name} /></a>
              <div class="fleet-sea">
                {f.boats.map(b => {
                  const badge = ownerBadge(b, 15);
                  return (
                    <a key={b.name} class={`fboat c-${LOOKS[b.look].color} lk-${b.look}`} href={sessionHref(f.name, b.name)}
                       {...tips.bind({ project: f.name, name: b.name, lead: b.lead, ts: b.ts, session: b, word: LOOKS[b.look].label, light: LOOKS[b.look].light },
                                     b.status === 'asleep' ? (e) => { e.preventDefault(); wk.wake(f.name, b.name, () => fleet.go(sessionPath(f.name, b.name))); } : null)}>
                      <Ship size={b.lead ? 64 : 32} state={LOOKS[b.look].light} />
                      {b.look === 'need' ? <span class="fboat-name">{b.lead ? t('common.lead') : b.name}</span> : null}
                      {badge ? <span class="fboat-owner">{badge}</span> : null}
                    </a>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : <p class="muted pad">{t('board.none')}</p>}
      {tips.card}
      {wk.sheet}
      {quiet.length ? (
        <div class={`quiet${showQuiet ? ' open' : ''}`}>
          <button class="quiet-toggle" onClick={() => setShowQuiet(v => !v)} aria-expanded={showQuiet}>
            <i class="qdot" /> {t('board.quiet', { n: quiet.length })} {showQuiet ? '▴' : '▾'}
          </button>
          {showQuiet ? quiet.map(f => <a key={f.name} class="qchip" href={projectHref(f.name)}><ProjectName name={f.name} /></a>) : null}
        </div>
      ) : null}
    </section>
  );
}
