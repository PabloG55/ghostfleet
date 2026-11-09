// The few things the assistant understands on its own, because they move the page and send
// nothing: the map, the home page, the activity, a session by name. Everything else goes to the
// dispatcher (server/router.mjs). Pure, so it is tested in node (scripts/test-resolve.mjs).
// It hears both languages whichever one the page shows: people mix them when they talk.
import { t as tr } from '../../shared/i18n/index.js';

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Speech written down by a recogniser that does not know these names: "toolbox" arrives as
// "tulbox" or "tool box", "acme" as "acmi" or "akme". Compare sounds.
export const phon = (s) => norm(s)
  .replace(/qu/g, 'k').replace(/q/g, 'k').replace(/c([aou])/g, 'k$1').replace(/c([ei])/g, 's$1').replace(/c\b/g, 'k').replace(/ck/g, 'k')
  .replace(/z/g, 's').replace(/v/g, 'b').replace(/w/g, 'u').replace(/ll/g, 'y').replace(/ph/g, 'f').replace(/x/g, 'ks')
  .replace(/h/g, '').replace(/([a-z])\1+/g, '$1').replace(/\s+/g, ' ').trim();

const grams = (s) => { const t = ` ${s} `; const g = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
export function dice(a, b) {
  const A = grams(a), B = grams(b); let both = 0, n = 0;
  for (const [k, v] of A) { n += v; both += Math.min(v, B.get(k) || 0); }
  for (const v of B.values()) n += v;
  return n ? (2 * both) / n : 0;
}
const sim = (a, b) => (phon(a) === phon(b) ? 1 : dice(phon(a), phon(b)));

function bestName(name, options) {
  const n = norm(name);
  if (!n) return null;
  let hit = null, score = 0;
  for (const o of options) {
    const k = norm(o);
    const s = k === n ? 2 : (k.startsWith(n) || n.startsWith(k)) && Math.min(k.length, n.length) >= 3 ? 1.5 : sim(k, n);
    if (s > score) { hit = o; score = s; }
  }
  return score >= 0.6 ? hit : null;
}

// → {go, say, project?, session?} when it is one of those, or null.
export function command(text, projects, context) {
  const t = norm(text);
  if (!t) return null;
  const short = t.split(' ').length <= 9;
  if (short && (/^(muestrame |abre |ve a |ir a |vamos a |llevame a )?(el )?mapa( en vivo)?$/.test(t)
             || /^(show me |open |go to |take me to )?(the )?(live )?map$/.test(t))) return { go: '/map', say: tr('cmd.map') };
  if (short && (/^(ve |vamos |llevame |volver |vuelve )?(al )?inicio$/.test(t)
             || /^(go |take me |back )?(to )?(the )?home( page)?$|^go home$/.test(t))) return { go: '/', say: tr('cmd.home') };
  if (short && (/^(muestrame |abre |ve a )?(la )?actividad$/.test(t)
             || /^(show me |open |go to )?(the )?activity$/.test(t))) return { go: '/activity', say: tr('cmd.activity') };

  const m = /^(?:abre|ve a|vamos a|llevame a|muestrame|ensename|cambia a|pasa a|anda a) (?:la )?sesion (.+)$/.exec(t)
         || /^(?:open|go to|take me to|show me|switch to) (?:the )?session (.+)$/.exec(t);
  if (m && short) {
    const all = (projects || []).flatMap(p => p.sessions.map(x => ({ p: p.name, s: x.name })));
    const inCtx = all.filter(x => x.p === context);
    const pick = (list) => { const k = bestName(m[1], list.map(x => x.s)); return k && list.find(x => x.s === k); };
    const hit = pick(inCtx) || pick(all);
    if (hit) return { go: `/p/${encodeURIComponent(hit.p)}/s/${encodeURIComponent(hit.s)}`, project: hit.p, session: hit.s,
                      say: hit.p !== context ? tr('cmd.openIn', { session: hit.s, project: hit.p }) : tr('cmd.open', { session: hit.s }) };
    return { go: null, say: tr('cmd.noSession', { name: m[1] }) };
  }

  return null;
}
