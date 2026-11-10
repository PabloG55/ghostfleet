import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'preact/hooks';
// The phone client's own web/md.js, not a copy: one renderer for a message wherever it is read.
import { render as renderMd } from '../md.js';
import { colorOf } from './lights.js';
import { PIXELS } from './sprite.js';
import { Led } from './fleet.jsx';
import { Icon } from './icon.jsx';
import { t, locale, worded } from './i18n.js';
import { typingIn } from './keys.js';

// The nine statuses, with the TUI's own glyphs (bin/fleet-grid.mjs's STATUS table) and words a
// person reads without a legend. Plus the two the cards carry as flags. The colour is the
// status light's (lights.js), so a pill, a LED and a boat never disagree. Where the TUI's glyph
// is one a phone draws as an emoji, the status names a pixel icon instead.
export const STATUS = {
  'need-you':  { glyph: '●' },
  working:     { glyph: '◆' },
  ready:       { glyph: '✓' },
  parked:      { icon: 'pause' },
  idle:        { glyph: '·' },
  starting:    { glyph: '…' },
  limit:       { icon: 'hourglass' },
  interrupted: { icon: 'warning' },
  unknown:     { glyph: '?' },
  asleep:      { icon: 'moon' },
  lost:        { glyph: '✕' },
};
worded(STATUS, 'status', ['label', 'hint']);
for (const [k, v] of Object.entries(STATUS)) v.color = colorOf(k);
export const statusOf = (c) => (c.lost ? 'lost' : c.asleep ? 'asleep' : c.status) || 'unknown';

// A status's mark, where a legend or a list shows the shape beside the colour.
export function StatusMark({ status }) {
  const s = STATUS[status] || STATUS.unknown;
  return s.icon ? <Icon name={s.icon} /> : s.glyph;
}

export function StatusPill({ status, small }) {
  const s = STATUS[status] || STATUS.unknown;
  return <span class={`pill c-${s.color}${small ? ' sm' : ''}`} title={s.hint}><Led state={status} size={small ? 7 : 8} hidden /> {s.label}</span>;
}

export function Btn({ kind = '', icon, children, ...rest }) {
  return <button type="button" class={`btn ${kind}`} {...rest}>{icon ? <Icon name={icon} /> : null}{children}</button>;
}

// The app icon, drawn from its own pixels so it stays crisp at any size: the ghost ship on
// its dark tile, with a faint glow because it is a ghost.
export function Logo({ size = 28 }) {
  return (
    <span class="logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="-4 -10 40 36" width={size} height={size} shape-rendering="crispEdges">
        {PIXELS.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />)}
      </svg>
    </span>
  );
}

export function ago(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return t('ago.now');
  const m = Math.round(s / 60);
  if (m < 60) return t('ago.min', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('ago.h', { n: h });
  return t('ago.d', { n: Math.round(h / 24) });
}
export const sinceTs = (ts) => (ts ? ago(Date.now() / 1000 - ts) : '');
export const clock = (ts) => new Date(ts * 1000).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// Re-run `fn` every `ms` while mounted, and right away when `deps` change. Errors are kept,
// not thrown, so a flaky poll shows a line instead of blanking the screen.
//   A TICK THAT FINDS ITS LAST READ STILL OUT SKIPS. An interval does not wait for an answer, so a
// server slower than the period had a second read started behind the first, then a third — the
// backlog that came back as a burst of 429s, measured at 399 reads in under three minutes from one
// phone. An explicit reload() still asks.
export function usePoll(fn, ms, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const live = useRef(0);
  const out = useRef(0);
  const run = useCallback(async () => {
    const id = live.current;
    out.current++;
    try { const d = await fn(); if (id === live.current) { setData(d); setError(null); } }
    catch (e) { if (id === live.current) setError(e); }
    finally { out.current--; if (id === live.current) setLoading(false); }
  }, deps);
  useEffect(() => {
    live.current++; setLoading(true); setData(null);
    run();
    if (!ms) return undefined;
    const iv = setInterval(() => { if (!document.hidden && !out.current) run(); }, ms);
    return () => clearInterval(iv);
  }, [run]);
  return { data, error, loading, reload: run };
}

// Drawn before the paint, not after it: a bubble that is empty for a frame and then fills is a
// list that grows above the reader after anything that measured it — the chat holding their place
// while a page of older messages goes in above them measured empty bubbles, and the reader was then
// pushed down by the height of everything that filled in.
export function Markdown({ text }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n) return;
    n.replaceChildren();
    try { n.append(renderMd(String(text || ''), document)); } catch { n.textContent = text; }
  }, [text]);
  return <div class="md" ref={ref} />;
}

// ── modal, confirm, toast: one of each at a time, driven from anywhere ─────────────────
let pushToast = () => {};
export const toast = (text, kind = '', icon = null) => pushToast({ text, kind, icon, id: Math.random() });
export function Toasts() {
  const [list, setList] = useState([]);
  pushToast = (m) => { setList(l => [...l, m]); setTimeout(() => setList(l => l.filter(x => x.id !== m.id)), m.kind === 'bad' ? 7000 : 3500); };
  return <div class="toasts">{list.map(m => <div key={m.id} class={`toast ${m.kind}`}>{m.icon ? <Icon name={m.icon} /> : null}{m.text}</div>)}</div>;
}

// ANOTHER MACHINE'S PROJECT is addressed `<name>@<key>` (fleet-serve mergeProjects), the key a slug
// of that machine's own label (lib/peers.mjs keyFor). The address is the app's: a reader is shown
// the name and the machine, because this machine has projects of the same names and `acme-api@vm`
// reads as a typo. One function, so no screen spells it its own way.
export const splitAddr = (n) => { const m = /^(.+)@([^@]+)$/.exec(String(n || '')); return m ? [m[1], m[2]] : [String(n || ''), '']; };
export function ProjectName({ name }) {
  const [bare, host] = splitAddr(name);
  return host ? <>{bare}<small class="at"> · {host}</small></> : bare;
}

// Remember a dismissal while navigating away and back. Undefined means the poll has not
// answered yet; only a confirmed absence ends the request's lifetime.
const requestsSeen = new Map();
export function useRequest(scope, key, active = true) {
  const [opened, setOpened] = useState(null);
  useEffect(() => {
    if (key === undefined || !active) return;
    if (key === null) { requestsSeen.delete(scope); setOpened(null); return; }
    if (requestsSeen.get(scope) !== key) {
      requestsSeen.set(scope, key);
      setOpened(key);
    }
  }, [scope, key, active]);
  return { open: !!key && opened === key && active, close: () => setOpened(null), show: () => setOpened(key) };
}

export function Modal({ title, onClose, children, wide, sheet = false }) {
  const box = useRef(null);
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement;
    const dialog = box.current;
    const owner = dialog?.closest('.session, .proposal-slot');
    (dialog?.querySelector('input:not(:disabled), textarea:not(:disabled)') || dialog?.querySelector('.x'))?.focus({ preventScroll: true });
    const trap = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(n => n.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener('keydown', trap);
    return () => {
      dialog?.removeEventListener('keydown', trap);
      const back = owner?.querySelector('.request-return, .proposal-return') || previous;
      if (back?.isConnected && back.getClientRects().length && getComputedStyle(back).visibility !== 'hidden') back.focus({ preventScroll: true });
    };
  }, [sheet]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class={`scrim${sheet ? ' sheet' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button class="x" aria-label={t('common.close')} onClick={onClose}><Icon name="close" /></button></header>
        {children}
      </div>
    </div>
  );
}

// A destructive step names what it destroys and needs a second, deliberate click. When
// `typed` is set the person types it, for the ones that delete uncommitted work.
//   `y` is yes, as in the desk's question bar, unless the step wants its name typed: there the
// typing is the deliberate act, as the desk's refused worktree removal takes `f` and never a
// second `y`. Esc is no (Modal). Every other key stays the dialog's, so Tab still walks it.
export function Confirm({ title, body, action, danger, typed, onYes, onClose }) {
  const [busy, setBusy] = useState(false);
  const [txt, setTxt] = useState('');
  const ok = !typed || txt.trim() === typed;
  const yes = async () => { setBusy(true); try { await onYes(); onClose(); } finally { setBusy(false); } };
  const live = useRef(); live.current = { yes, busy };
  useEffect(() => {
    if (typed) return;
    const k = (e) => {
      if ((e.key !== 'y' && e.key !== 'Y') || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typingIn(e.target)) return;
      e.preventDefault();
      if (!live.current.busy) live.current.yes();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [typed]);
  return (
    <Modal title={title} onClose={onClose}>
      <div class="modal-body">{body}</div>
      {typed ? (
        <label class="field">
          <span>{t('ui.typeTo.a')}<code>{typed}</code>{t('ui.typeTo.b')}</span>
          <input value={txt} onInput={(e) => setTxt(e.currentTarget.value)} autoFocus />
        </label>
      ) : null}
      <footer>
        <Btn onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn kind={danger ? 'danger' : 'primary'} disabled={!ok || busy}
             onClick={yes}>
          {busy ? t('common.wait') : action}
        </Btn>
      </footer>
    </Modal>
  );
}
