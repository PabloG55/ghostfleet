// web/ui/shiptip.jsx — a ship says who it is: on hover, on keyboard focus, on a long press.
//
// Every ship that stands for a session (the home board's, the live map's) used to say so in a
// native title: drawn by the OS about a second late, unstyled, never on a touch screen, never in
// a screenshot, and it did not say which agent the ship was. Now one card, in the menu surface
// the pickers use (select.jsx), says it: the session (lead, for a project's master) and its
// project; its state, with the LED the ship is drawn in; the agent, and the model when the grid
// carries one; the owner by name, beside the badge the ship wears; its label; when it last moved;
// the last thing it said. Only what is there is shown: a row with nothing in it is left out.
//
// When: 150 ms into a hover, or at once when the keyboard brings the focus to it (:focus-visible,
// as modality.js decides it); moving on to another ship while one is open, or just closed, swaps
// at once. It closes on leave, blur and Esc, and after Esc it stays closed until the pointer
// moves. It sits above the ship, below when there is no room above, never
// over it and never outside the viewport, so a press on the ship is always the ship's. The
// pointer can cross onto the card and read it, which is why the card takes whichever side covers
// less of the OTHER ships: over a neighbour it stands between the pointer and that ship, and on
// the map a card above a ship in the lower island covered the upper island's ships and held the
// pointer on its way to them. A phone has no hover: a tap opens the session as it always did, and
// a press held for half a second shows the card instead and opens nothing.
//
// The projects list says only a session's name, state, time and owner. The agent, the label and
// the last message are in the project's grid, fetched when the pointer reaches the project or the
// focus reaches a ship, so it has usually landed by the time the card opens, and kept for a few
// seconds for the next ship of the same project.
import { Fragment } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Portal, useLayer, placeBy } from './select.jsx';
import { Led } from './fleet.jsx';
import { useFleet, useSlot } from './adapter.jsx';
import { sinceTs } from './ui.jsx';
import { t } from './i18n.js';

const HOVER_MS = 150;
const PRESS_MS = 500;
const SWAP_MS = 300;    // a card closed this recently opens on the next ship without the wait
const CROSS_MS = 150;   // to cross the gap from the ship onto its card
const SLOP = 10;        // px a finger may drift and still be a press
const KEEP_MS = 10000;  // a project's grid is reused this long

const grids = new Map();   // project → { at, data, wait }
function gridOf(fleet, project) {
  const g = grids.get(project);
  if (g && (g.wait || Date.now() - g.at < KEEP_MS)) return g;
  const n = { at: 0, data: g?.data || null, wait: null };
  n.wait = Promise.resolve().then(() => fleet.grid(project))
    .then((d) => { n.data = d; }, () => {})
    .then(() => { n.at = Date.now(); n.wait = null; });
  grids.set(project, n);
  return n;
}
const cardOf = (project, name) => grids.get(project)?.data?.cards?.find(c => c.name === name) || null;
const agentOf = (c) => (c?.agent ? (c.model ? `${c.agent} · ${c.model}` : c.agent) : null);
const keyboard = (el) => !document.documentElement.classList.contains('by-pointer') && el.matches(':focus-visible');

// One per screen. `bind(info, onClick)` goes on each ship's link or button; `card` is rendered
// once anywhere in the screen. info: { project, name, lead, ts, session, word, light }, where
// `session` is what the screen has for it (the owner slots read it), `word` the state as the
// screen says it and `light` the LED it is drawn with. `warm(project)` fetches a project's grid
// ahead, for a pointer that has reached the project and not yet a ship.
export function useShipTips() {
  const fleet = useFleet();
  const ownerName = useSlot('ownerName'), ownerBadge = useSlot('ownerBadge');
  const [tip, setTip] = useState(null);            // { key, how: 'hover' | 'focus' | 'press' }
  const [, landed] = useState(0);
  const id = useId();
  const box = useRef(null);
  const m = useRef(null);
  if (!m.current) m.current = { infos: new Map(), els: new Map(), timer: 0, cross: 0, shut: 0, press: null, ate: false, xy: null, still: null };
  const s = m.current;
  s.tip = tip;

  const warm = (project) => { const g = gridOf(fleet, project); if (g.wait) g.wait.then(() => landed(n => n + 1)); };
  const open = (key, how) => {
    clearTimeout(s.timer); clearTimeout(s.cross);
    setTip({ key, how });
  };
  const close = (esc) => {
    clearTimeout(s.timer); clearTimeout(s.cross);
    if (!s.tip) return;
    s.shut = Date.now();
    // After Esc the card stays closed while the pointer stays where it was. A card closed over
    // another ship uncovers it, and Chrome enters that ship without the pointer moving: that
    // enter opened the other ship's card, which read as Esc not working.
    if (esc) s.still = s.xy;
    s.tip = null;
    setTip(null);
  };
  const leave = () => { clearTimeout(s.cross); s.cross = setTimeout(() => close(false), CROSS_MS); };

  // Esc closes it (the top layer, as a list's Esc does), and a press outside the card and its
  // ship closes it: on a phone, that is how a long-pressed card goes away.
  useLayer(!!tip, (n) => !!(box.current?.contains(n) || (s.tip && s.els.get(s.tip.key)?.contains(n))), (esc) => close(esc));

  const place = () => {
    const el = s.tip && s.els.get(s.tip.key), b = box.current;
    if (!el || !el.isConnected) { close(false); return; }
    if (!b) return;
    const others = [...s.els.values()].filter(x => x !== el && x.isConnected).map(x => x.getBoundingClientRect());
    const cover = () => {
      const r = b.getBoundingClientRect();
      return others.reduce((n, o) => n + Math.max(0, Math.min(r.right, o.right) - Math.max(r.left, o.left)) * Math.max(0, Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)), 0);
    };
    const at = (prefer) => placeBy(el, b, { prefer, align: 'center', maxW: 300, maxH: 360 });
    at('up');
    const up = cover();
    if (!up) return;
    at('down');
    if (cover() >= up) at('up');
  };
  useLayoutEffect(() => { if (tip) place(); });
  useEffect(() => {
    if (!tip) return undefined;
    const on = (e) => { if (!(e.type === 'scroll' && box.current?.contains(e.target))) place(); };
    const xy = (e) => { s.xy = { x: e.clientX, y: e.clientY }; };
    addEventListener('scroll', on, true);
    addEventListener('resize', on);
    addEventListener('pointermove', xy, { passive: true });
    return () => { removeEventListener('scroll', on, true); removeEventListener('resize', on); removeEventListener('pointermove', xy); };
  }, [tip?.key]);
  useEffect(() => () => clearTimeout(s.timer), []);

  const facts = (info) => {
    const owner = ownerName(info.session), ago = sinceTs(info.ts), agent = agentOf(cardOf(info.project, info.name));
    return [`${info.lead ? t('common.lead') : info.name}, ${info.project}`, info.word, agent,
      owner ? `${t('tip.owner')}: ${owner}` : null, ago ? `${t('tip.moved')} ${ago}` : null].filter(Boolean).join(' · ');
  };

  const bind = (info, onClick) => {
    const key = `${info.project}/${info.name}`;
    s.infos.set(key, info);
    return {
      ref: (el) => { if (el) s.els.set(key, el); else if (!s.els.get(key)?.isConnected) s.els.delete(key); },
      'aria-label': facts(info),
      'aria-describedby': tip?.key === key ? id : undefined,
      onPointerEnter: (e) => {
        if (e.pointerType === 'touch') return;
        warm(info.project);
        if (s.still && e.clientX === s.still.x && e.clientY === s.still.y) return;
        s.still = null;
        clearTimeout(s.timer); clearTimeout(s.cross);
        if (s.tip?.key === key) return;
        if (s.tip || Date.now() - s.shut < SWAP_MS) open(key, 'hover');
        else s.timer = setTimeout(() => open(key, 'hover'), HOVER_MS);
      },
      onPointerLeave: (e) => {
        if (e.pointerType === 'touch') return;
        clearTimeout(s.timer);
        if (s.tip?.key === key && s.tip.how === 'hover') leave();
      },
      onFocus: (e) => { if (keyboard(e.currentTarget)) { warm(info.project); open(key, 'focus'); } },
      onBlur: () => { if (s.tip?.key === key && s.tip.how === 'focus') close(false); },
      // A finger: a press held still for PRESS_MS shows the card, and the click that ends it is
      // eaten, so the session does not open. `ate` is reset by the next press, because a long
      // press is not always followed by a click.
      onPointerDown: (e) => {
        s.ate = false;
        if (e.pointerType !== 'touch') return;
        warm(info.project);
        s.press = { x: e.clientX, y: e.clientY };
        clearTimeout(s.timer);
        s.timer = setTimeout(() => { s.press = null; s.ate = true; open(key, 'press'); }, PRESS_MS);
      },
      onPointerMove: (e) => {
        if (s.press && Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) > SLOP) { clearTimeout(s.timer); s.press = null; }
      },
      onPointerUp: () => { if (s.press) { clearTimeout(s.timer); s.press = null; } },
      onPointerCancel: () => { if (s.press) { clearTimeout(s.timer); s.press = null; } },
      onContextMenu: (e) => { if (s.ate || s.press) e.preventDefault(); },
      onClick: (e) => {
        if (s.ate) { s.ate = false; e.preventDefault(); return; }
        onClick?.(e);
      },
    };
  };

  const info = tip && s.infos.get(tip.key);
  const card = info ? (
    <Portal>
      <ShipCard id={id} box={box} info={info} card={cardOf(info.project, info.name)}
                owner={ownerName(info.session)} badge={ownerBadge(info.session, 18)}
                onEnter={() => clearTimeout(s.cross)} onLeave={() => { if (s.tip?.how === 'hover') leave(); }} />
    </Portal>
  ) : null;
  return { bind, card, warm };
}

// The card itself. Rendered through the Portal, outside the screen's tree, so it is given what
// it shows rather than reading the fleet's context.
function ShipCard({ id, box, info, card, owner, badge, onEnter, onLeave }) {
  const ago = sinceTs(info.ts), agent = agentOf(card);
  const rows = [
    agent ? ['agent', t('tip.agent'), agent] : null,
    owner ? ['owner', t('tip.owner'), <>{badge}<span>{owner}</span></>] : null,
    card?.label ? ['label', t('tip.label'), card.label] : null,
    ago ? ['moved', t('tip.moved'), ago] : null,
    card?.msg ? ['said', t('tip.said'), <span class="tip-said">{card.msg}</span>] : null,
  ].filter(Boolean);
  return (
    <div id={id} role="tooltip" ref={box} class="menu popover ship-tip" onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <p class="tip-who"><b>{info.lead ? t('common.lead') : info.name}</b> <span>{info.project}</span></p>
      <p class="tip-state"><Led state={info.light} hidden /> {info.word}</p>
      {rows.length ? (
        <dl class="tip-rows">
          {rows.map(([k, dt, dd]) => <Fragment key={k}><dt>{dt}</dt><dd class={`tip-${k}`}>{dd}</dd></Fragment>)}
        </dl>
      ) : null}
    </div>
  );
}
