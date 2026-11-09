// What a status LOOKS like: one light per session, the same everywhere it is drawn — the LED
// beside a name, the pill in a header, the boat on the board and on the map. Kept apart from
// the JSX so the mapping can be tested without a bundler.
//
// The colours are the grid's (xterm 114/221/203/80/245) but the meaning is the one a status
// light has on a machine: green is working, amber is waiting on a person, red is broken, and
// dark is asleep. That puts need-you on amber, where the TUI draws it red: a session waiting
// for an answer is not an error, and with red kept for errors the two never share a colour.
import { worded } from '../../shared/i18n/index.js';

export const LIGHTS = worded({
  work:  { color: 'green',  motion: 'sail' },   // breathing light, boat under way
  start: { color: 'green',  motion: 'sail' },   // quick blink, boat leaving port
  wait:  { color: 'yellow', motion: 'signal' }, // blinking amber, boat stopped and signalling
  error: { color: 'red',    motion: 'list' },   // red strobe, boat listing
  done:  { color: 'cyan',   motion: 'moored' }, // steady, boat at anchor
  idle:  { color: 'grey',   motion: 'moored' }, // dim steady
  off:   { color: 'grey',   motion: 'ghost' },  // dark, boat a faint ghost
}, 'light');

export const STATUS_LIGHT = {
  working: 'work', starting: 'start',
  'need-you': 'wait',
  limit: 'error', interrupted: 'error', unknown: 'error', lost: 'error',
  ready: 'done',
  idle: 'idle',
  parked: 'off', asleep: 'off',
};

// A status the table does not know is drawn as an error: a light that cannot say what it
// means must not look calm.
export const lightOf = (status) => STATUS_LIGHT[status] || 'error';
export const colorOf = (status) => LIGHTS[lightOf(status)].color;

// A group of sessions (a project, a fleet) shows its most urgent light.
const URGENCY = ['wait', 'error', 'work', 'start', 'done', 'idle', 'off'];
export function topLight(statuses) {
  let best = null;
  for (const s of statuses) {
    const l = lightOf(s);
    if (best == null || URGENCY.indexOf(l) < URGENCY.indexOf(best)) best = l;
  }
  return best || 'off';
}
