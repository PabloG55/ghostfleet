// web/ui/skeleton.jsx — the one thing every screen draws while it waits for its data.
//
// A screen that waits used to say so in a line of words above where the data would go, or say
// nothing at all. Both move the page: the line is one row tall and what replaces it is not, and
// a blank page becomes a full one in a single frame. Measured with every read held back two
// seconds: a search's field and a queue's grid sat 35 px lower while the line was there and came
// back up when it left, and on the first page the assistant's card went down 142 px at 390 wide
// (82 px at 1280) as the lines above it arrived.
//
// So the wait is drawn as the SHAPE of what is coming, in the container the data will use, and
// the real thing replaces it in place:
//
//   <Skeleton shape="cards" box="extra-grid" n={3} />   cards in the grid the cards will be in
//   <Skeleton shape="rows" box="log" n={6} />           rows of a list
//   <Skeleton shape="fleets" box="fleets" n={3} />      the board's projects
//   <SkelLine w="14em" />                               one line of text, inside its own <p>
//
// IT TAKES ITS SPACE AT ONCE AND SHOWS ITSELF LATE (ui.css `.sk`): the box is laid out from the
// first frame, so nothing below it is placed twice, and it stays invisible for SKEL_AFTER_MS. A
// read that answers sooner than that never flashes a skeleton; one that does not gets the shape
// without anything having moved to make room for it. The delay is CSS, not a timer, so there is
// no state to tear down and no render between "waiting" and "shown".
//
// No words are drawn — the shape is the message — but the box is a live `status` named
// "Loading…", so a screen reader is told what a sighted reader sees. The pulse is under
// `prefers-reduced-motion: no-preference` only; without it the shapes simply stand still.
import { useRef, useLayoutEffect } from 'preact/hooks';
import { t } from './i18n.js';

export const SKEL_AFTER_MS = 180;

const PIECES = {
  // a session or queue card: a pill, a title, two lines
  cards: () => <div class="sk-b sk-card"><i class="sk-bar w3" /><i class="sk-bar w6 tall" /><i class="sk-bar w9" /><i class="sk-bar w7" /></div>,
  // one row of a list: when, what, a badge
  rows: () => <div class="sk-b sk-row"><i class="sk-bar w2" /><i class="sk-bar grow" /><i class="sk-bar w1" /></div>,
  // a project on the board: its name over its water
  fleets: () => <div class="sk-b sk-fleet"><i class="sk-bar w4" /><i class="sk-sea" /></div>,
  // lines of text: a pane of terminal output, a list of names
  lines: (i) => <i class={`sk-bar ${['w9', 'w7', 'w6', 'w9', 'w5', 'w7', 'w8', 'w6'][i % 8]}`} />,
  // a settings row: a label, its hint, the switch
  toggle: () => <div class="sk-b sk-toggle"><span><i class="sk-bar w5" /><i class="sk-bar w8" /></span><i class="sk-bar w1 tall" /></div>,
};

export function Skeleton({ shape = 'cards', box = '', n = 3 }) {
  const piece = PIECES[shape] || PIECES.cards;
  return (
    <div class={`sk sk-${shape}${box ? ' ' + box : ''}`} role="status" aria-busy="true" aria-label={t('common.loading')}>
      {Array.from({ length: n }, (_, i) => <div key={i} class="sk-item" aria-hidden="true">{piece(i)}</div>)}
    </div>
  );
}

// One line of text on its way, set INSIDE the element the text will be in, so the line keeps the
// height the words will give it: <p class="muted">{g ? words : <SkelLine />}</p>.
export function SkelLine({ w = '12em' }) {
  return <span class="sk sk-line" role="status" aria-label={t('common.loading')}><i class="sk-bar" style={{ width: w }} aria-hidden="true" />&nbsp;</span>;
}

// "as of 3 min ago": beside data painted from the last read while the next one is out
// (usePoll's `stale`). Nothing when the data on screen is the answer to the read just made.
export function AsOf({ at, stale }) {
  if (!stale || !at) return null;
  const s = Math.max(0, (Date.now() - at) / 1000);
  return <p class="muted small as-of" role="status">{s < 60 ? t('skel.asOfNow') : t('skel.asOf', { n: Math.round(s / 60) })}</p>;
}

// ROOM FOR A BLOCK WHOSE HEIGHT ONLY ITS DATA KNOWS — the accounts line (a row per profile, and
// they wrap on a phone), the assistant's pending approvals, the board's legend. Each is above
// something, so each one landing pushed everything under it down: measured on the first page
// with its reads held two seconds, the assistant's card went from 88 to 230 px at 390 wide.
// A skeleton cannot know how many rows are coming, but THIS DEVICE DREW THEM LAST TIME: the
// height the block had is remembered, per block and per window width, and held while the next
// answer is out. A number of pixels is all that is stored, never what was in them.
//   const room = useRoom('usage', waiting);  <div ref={room.ref} style={room.style}>…</div>
// The same node carries the ref waiting and loaded, and nothing but the block's own content is in it. A block that loads to nothing (`gone`)
// forgets its height, so a line switched off does not leave a hole on the next launch.
export function useRoom(name, waiting, gone = false) {
  const ref = useRef(null);
  const wrote = useRef(-1);
  const key = `gfw.room.${name}.${typeof innerWidth === 'number' ? innerWidth : 0}`;
  useLayoutEffect(() => {
    if (waiting) return;
    const h = gone || !ref.current ? 0 : Math.round(ref.current.getBoundingClientRect().height);
    if (h === wrote.current) return;
    wrote.current = h;
    try { if (h) localStorage.setItem(key, String(h)); else localStorage.removeItem(key); } catch {}
  });
  let h = 0;
  if (waiting) { try { h = Number(localStorage.getItem(key)) || 0; } catch {} }
  // The height itself, not a floor under it: what stands in the block while it waits is a
  // skeleton of a guessed number of rows, and where the guess is taller than what came last time
  // (one machine paired, where the skeleton draws a row and the answer is a line of words) a floor
  // would let the guess win and the block shrink when the answer lands.
  return { ref, style: h ? { height: `${h}px`, overflow: 'hidden' } : undefined, h };
}
