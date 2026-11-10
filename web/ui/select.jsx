// web/ui/select.jsx — the app's own select, with the stack of open layers it and every other
// overlay that floats over the page share.
//
// A native select element opens the engine's list: a grey wheel on a phone, an OS menu on a desktop,
// and neither is the app's. Restyling the closed box (skin.css did) changed nothing about the
// open one, and that is the half a person reads. So the list is ours, in the session page's
// "More" menu surface (ui.css shares those rules with .menu rather than copying them), and the
// keyboard is the one the WAI-ARIA select-only combobox describes, because that is what a
// person who knows a native select already presses:
//
//   closed  ↓ ↑ Enter Space open on the chosen option; Home End open on the first or last;
//           a letter opens on the next option that starts with it
//   open    ↓ ↑ Home End PageUp PageDown move; letters jump (typed quickly they spell a word,
//           one letter again cycles); Enter or Space chooses; Esc closes without choosing;
//           Tab closes without choosing and leaves, as a native list does — a value that
//           assigns a session's owner is not changed by walking past it
//
// The focus never leaves the button: the open option is aria-activedescendant, so Esc has
// nothing to give back and a screen reader hears the option it is on. A key the picker uses
// stops at it, because the desk's keys listen on window (keyboard.jsx) and `q` typed to jump
// to an option is not the desk's `q`.
//
// The list is rendered at the end of <body> and placed with position: fixed from the button's rect,
// because the pickers live in modals that scroll, a drawer that is transformed and windows
// that clip. It flips above the button when it fits better there, shrinks to the room it has,
// and never leaves the viewport.
import { render } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.jsx';

// Its children, rendered into a box at the end of <body>. Not preact/compat's createPortal:
// importing compat installs its React shims on every vnode in the app, one of which turns a
// text field's onChange into onInput. A child's layout effects run before its parent's, so
// what this renders exists (and its refs are set) by the time the parent places it.
export function Portal({ children }) {
  const host = useRef(null);
  if (!host.current) host.current = document.createElement('div');
  useLayoutEffect(() => {
    document.body.append(host.current);
    return () => { render(null, host.current); host.current.remove(); };
  }, []);
  useLayoutEffect(() => { render(children, host.current); });
  return null;
}

// ── layers ────────────────────────────────────────────────────────────────────────────────
// Every open list or popover, in the order it opened. Esc closes the top one only, in the
// capture phase on window, so a list open in a modal closes the list and not the modal under
// it (Modal listens on window too, after). A press outside closes every layer it is not
// inside, from the top down, and stops at the first one it is in: a choice made in a list
// that a popover opened is a press inside the list, and the popover stays.
const stack = [];
function onPress(e) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].contains(e.target)) break;
    stack[i].close(false);
  }
}
function onEsc(e) {
  if (e.key !== 'Escape' || e.isComposing || !stack.length) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].close(true);
}

// While `open`, this component is a layer: `contains(node)` says whether a press is inside
// it, `close(focusBack)` closes it, focusing what opened it when asked.
export function useLayer(open, contains, close) {
  const me = useRef({});
  me.current.contains = contains;
  me.current.close = close;
  useEffect(() => {
    if (!open) return undefined;
    const layer = { contains: (n) => !!me.current.contains(n), close: (f) => me.current.close(f) };
    stack.push(layer);
    if (stack.length === 1) {
      document.addEventListener('pointerdown', onPress, true);
      addEventListener('keydown', onEsc, true);
    }
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) {
        document.removeEventListener('pointerdown', onPress, true);
        removeEventListener('keydown', onEsc, true);
      }
    };
  }, [open]);
}

// Keep a fixed box beside its anchor while the page scrolls or resizes under it. A scroll
// inside the box itself is its own and moves nothing.
function useFollow(open, place, inside) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const on = (e) => { if (!(e.type === 'scroll' && inside(e.target))) place(); };
    addEventListener('scroll', on, true);
    addEventListener('resize', on);
    return () => { removeEventListener('scroll', on, true); removeEventListener('resize', on); };
  }, [open]);
}

const EDGE = 8;  // the least the box keeps from the viewport's edges
const GAP = 4;   // between the anchor and the box, as .menu sits 4px below its button

// Place `box` under `anchor`, or above it when there is more room there than below and the
// box does not fit below. Returns the side it took.
export function placeBy(anchor, box, { maxH = 320, align = 'start', minWidth = 0 } = {}) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const keep = box.scrollTop;
  box.style.maxWidth = `${vw - 2 * EDGE}px`;
  box.style.minWidth = `${Math.min(minWidth, vw - 2 * EDGE)}px`;
  box.style.maxHeight = 'none';
  const full = box.offsetHeight;
  const below = vh - r.bottom - GAP - EDGE, above = r.top - GAP - EDGE;
  const up = full > below && above > below;
  const h = Math.min(full, maxH, Math.max(0, up ? above : below));
  box.style.maxHeight = `${h}px`;
  box.style.top = `${up ? r.top - GAP - h : r.bottom + GAP}px`;
  const w = box.offsetWidth;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  box.style.left = `${left}px`;
  box.scrollTop = keep;
  return up ? 'up' : 'down';
}

// ── the select ────────────────────────────────────────────────────────────────────────────
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const same = (a, b) => String(a) === String(b);

// options: [{ value, label, icon? }]. `label` is the visible label, rendered in a <span> the
// button is labelled by, inside a <div class={field}> (a <label> would forward its clicks and
// lend the button its whole text as a name). Without one, pass aria-label. onChange gets the
// option's value as it was given, number or string, and only when it changed.
export function Select({
  value, onChange, options, label, labelClass, field = 'field', placeholder = '',
  class: cls = '', disabled, title, 'aria-label': ariaLabel,
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const btn = useRef(null), list = useRef(null), typed = useRef({ s: '', at: 0 });
  const chosen = options.findIndex(o => same(o.value, value));
  const cur = options[chosen];
  const last = options.length - 1;

  const show = (i) => { setActive(Math.max(0, Math.min(i, last))); setOpen(true); };
  // a word typed to one opening of the list is not the start of the next one's
  const close = (focus) => { setOpen(false); typed.current = { s: '', at: 0 }; if (focus) btn.current?.focus({ preventScroll: true }); };
  const pick = (i) => {
    const o = options[i];
    close(true);
    if (o && !same(o.value, value)) onChange(o.value);
  };
  useLayer(open, (n) => btn.current?.contains(n) || list.current?.contains(n), close);
  useFollow(open, () => {
    if (btn.current && list.current) {
      list.current.style.fontSize = getComputedStyle(btn.current).fontSize;
      placeBy(btn.current, list.current, { minWidth: btn.current.offsetWidth });
    }
  }, (n) => list.current?.contains(n));

  // the active option stays in view inside the list
  useLayoutEffect(() => {
    const l = list.current, o = l?.children[active];
    if (!o) return;
    if (o.offsetTop < l.scrollTop) l.scrollTop = o.offsetTop - 5;
    else if (o.offsetTop + o.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = o.offsetTop + o.offsetHeight - l.clientHeight + 5;
  }, [open, active]);

  // Type to jump: letters typed within 700ms are one word; the same letter again moves on to
  // the next option that starts with it, as a native list does.
  const search = (ch, from) => {
    const T = typed.current, now = Date.now();
    T.s = now - T.at < 700 ? T.s + ch : ch;
    T.at = now;
    const again = [...T.s].every(c => c === T.s[0]);
    const q = fold(again ? T.s[0] : T.s);
    const n = options.length, start = again ? from + 1 : from;
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n;
      if (fold(options[i].label).startsWith(q)) return i;
    }
    return -1;
  };
  const typing = () => Date.now() - typed.current.at < 700 && typed.current.s;

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.isComposing) return;
    const k = e.key;
    const letter = k.length === 1 && k !== ' ' && !e.altKey;
    let next = null;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') next = Math.max(chosen, 0);
      else if (k === 'Home') next = 0;
      else if (k === 'End') next = last;
      else if (letter) { const i = search(k, chosen); next = i < 0 ? Math.max(chosen, 0) : i; }
      else return;
      e.preventDefault(); e.stopPropagation();
      show(next);
      return;
    }
    if (k === 'Tab') { close(false); return; }
    if (e.altKey && k === 'ArrowUp') next = 'pick';
    else if (k === 'Enter' || (k === ' ' && !typing())) next = 'pick';
    else if (k === 'ArrowDown') next = Math.min(active + 1, last);
    else if (k === 'ArrowUp') next = Math.max(active - 1, 0);
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = last;
    else if (k === 'PageDown') next = Math.min(active + 10, last);
    else if (k === 'PageUp') next = Math.max(active - 10, 0);
    else if (letter || k === ' ') { const i = search(k, active); next = i < 0 ? active : i; }
    else return;
    e.preventDefault(); e.stopPropagation();
    if (next === 'pick') pick(active); else setActive(next);
  };

  const lid = `${id}-l`, listId = `${id}-x`, optId = (i) => `${id}-o${i}`;
  const named = label != null ? { 'aria-labelledby': lid } : { 'aria-label': ariaLabel };
  const button = (
    <button
      type="button" ref={btn} class={`select${cls ? ` ${cls}` : ''}`} role="combobox" aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
      {...named} disabled={disabled} title={title}
      onClick={() => (open ? close(false) : show(Math.max(chosen, 0)))} onKeyDown={onKey}
    >
      {cur?.icon ?? null}<span class="select-v">{cur ? cur.label : placeholder}</span>
    </button>
  );
  const box = open ? <Portal>
    <div class="menu select-list" id={listId} role="listbox" ref={list} {...named}>
      {options.map((o, i) => (
        <div
          key={String(o.value)} id={optId(i)} role="option" aria-selected={i === chosen}
          class={`select-opt${i === active ? ' on' : ''}`}
          onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== active) setActive(i); }}
          onClick={() => pick(i)}
        >
          {o.icon ?? null}<span class="select-v">{o.label}</span>{i === chosen ? <Icon name="check" /> : null}
        </div>
      ))}
    </div>
  </Portal> : null;

  if (label == null) return <>{button}{box}</>;
  return (
    <div class={field}>
      <span id={lid} class={labelClass} onClick={() => btn.current?.focus()}>{label}</span>
      {button}{box}
    </div>
  );
}
