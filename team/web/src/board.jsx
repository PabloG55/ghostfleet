// The home page as a picture of the fleet: every fleet with something open is a tile, every
// session a boat in the colour of what it is doing. Words only where a click is needed — a
// name on hover, and on the boats that are waiting for an answer.
import { useState } from 'preact/hooks';
import { Ship, Led } from './fleet.jsx';
import { Avatar } from './ui.jsx';
import { t } from './i18n.js';
import { worded } from '../../shared/i18n/index.js';

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

const sessionHref = (p, s) => `#/p/${encodeURIComponent(p)}/s/${encodeURIComponent(s)}`;
const projectHref = (p) => `#/p/${encodeURIComponent(p)}`;

export function Board({ ctx, projects }) {
  const [showQuiet, setShowQuiet] = useState(false);
  const now = Date.now() / 1000;
  const fleets = (projects || []).map(p => {
    const boats = p.sessions.map(s => ({ ...s, look: lookOf(s, now) }))
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

  if (projects == null) return <p class="muted">{t('map.reading')}</p>;
  return (
    <section class="board">
      <div class="legend" role="list">
        {ORDER.filter(k => total[k]).map(k => (
          <span key={k} role="listitem" class={`lg c-${LOOKS[k].color} lk-${k}`}><Led state={LOOKS[k].light} hidden />{total[k]} <small>{LOOKS[k].label}</small></span>
        ))}
      </div>
      {live.length ? (
        <div class="fleets">
          {live.map(f => (
            <article key={f.name} class={`fleet c-${LOOKS[f.top].color} lk-${f.top}`}>
              <a class="fleet-name" href={projectHref(f.name)} title={t('board.open', { name: f.name })}>{f.name}</a>
              <div class="fleet-sea">
                {f.boats.map(b => {
                  const owner = b.owner ? ctx.usersById?.[b.owner] : null;
                  return (
                    <a key={b.name} class={`fboat c-${LOOKS[b.look].color} lk-${b.look}`} href={sessionHref(f.name, b.name)}
                       title={`${b.lead ? t('common.lead') : b.name} · ${LOOKS[b.look].label}${owner ? ` · ${owner.name}` : ''}`}>
                      <Ship size={b.lead ? 64 : 32} state={LOOKS[b.look].light} />
                      {b.look === 'need' ? <span class="fboat-name">{b.lead ? t('common.lead') : b.name}</span> : null}
                      {owner ? <span class="fboat-owner"><Avatar user={owner} size={15} /></span> : null}
                    </a>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : <p class="muted pad">{t('board.none')}</p>}
      {quiet.length ? (
        <div class={`quiet${showQuiet ? ' open' : ''}`}>
          <button class="quiet-toggle" onClick={() => setShowQuiet(v => !v)} aria-expanded={showQuiet}>
            <i class="qdot" /> {t('board.quiet', { n: quiet.length })} {showQuiet ? '▴' : '▾'}
          </button>
          {showQuiet ? quiet.map(f => <a key={f.name} class="qchip" href={projectHref(f.name)}>{f.name}</a>) : null}
        </div>
      ) : null}
    </section>
  );
}
