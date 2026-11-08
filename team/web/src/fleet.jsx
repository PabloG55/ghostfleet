// The fleet's two pieces of personality, used anywhere a session is drawn: the LED that says
// what it is doing, and the boat that does it. Pure SVG + CSS (styles.css, "lights & boats"),
// and every motion is switched off under prefers-reduced-motion — the light keeps its colour
// and glow, so nothing is lost but the movement.
import { PIXELS, MAST } from './sprite.js';
import { LIGHTS, lightOf } from './lights.js';

const asLight = (state) => (LIGHTS[state] ? state : lightOf(state));

// state: a light (work|start|wait|error|done|idle|off) or a session status ('need-you'…).
// `hidden` when the words are already beside it (a pill), so a reader does not hear them twice.
export function Led({ state, size = 9, label, hidden, class: cls = '' }) {
  const l = asLight(state);
  const name = label || LIGHTS[l].label;
  const a11y = hidden ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': name, title: name };
  return <span class={`led l-${l} c-${LIGHTS[l].color} ${cls}`} style={{ '--led': `${size}px` }} {...a11y} />;
}

// A boat of the fleet. Working: under way, with a wake and the sea moving under it. Waiting on
// a person: stopped, rocking, signalling with its mast lamp. Error: listing, lamp strobing.
// Done or idle: at anchor. Asleep: a faint ghost. The lamp is the same LED, on the mast.
export function Ship({ state, size = 46, title }) {
  const l = asLight(state);
  const { color, motion } = LIGHTS[l];
  const h = Math.round(size * 19 / 32);
  return (
    <span class={`fship l-${l} m-${motion} c-${color}`} style={{ '--w': `${size}px`, '--h': `${h}px` }} title={title}>
      <span class="fship-sea" aria-hidden="true" />
      {motion === 'sail' ? <span class="fship-wake" aria-hidden="true" /> : null}
      <svg class="fship-hull" viewBox="0 -3 32 19" width={size} height={h} shape-rendering="crispEdges" aria-hidden="true">
        <g class="fship-body">{PIXELS.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />)}</g>
        <rect class="fship-lamp" x={MAST[0] - 1} y={MAST[1] - 3} width="3" height="3" />
      </svg>
      {l === 'off' ? <span class="fship-z" aria-hidden="true">z</span> : null}
    </span>
  );
}

// The entry screen's horizon: the ghost ship crossing, and three boats showing the lights a
// person will meet inside. Decoration only, so it is hidden from assistive tech.
export function Harbor() {
  return (
    <div class="harbor" aria-hidden="true">
      <div class="harbor-sky">
        <span class="harbor-ghost"><Ship state="done" size={96} /></span>
      </div>
      <div class="harbor-fleet">
        <Ship state="work" size={32} />
        <Ship state="wait" size={32} />
        <Ship state="off" size={32} />
      </div>
      <div class="harbor-waves" />
    </div>
  );
}
