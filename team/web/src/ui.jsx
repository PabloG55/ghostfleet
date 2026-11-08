import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { render as renderMd } from './vendor/md.js';
import { colorOf } from './lights.js';
import { PIXELS } from './sprite.js';
import { Led } from './fleet.jsx';
import { Icon } from './icon.jsx';
import { t, locale } from './i18n.js';
import { worded } from '../../shared/i18n/index.js';

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

export function Avatar({ user, size = 26, title }) {
  if (!user) return <span class="avatar none" style={{ width: size, height: size }} title={title || t('ui.noOwner')}>?</span>;
  const initials = user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return <span class={`avatar c-${user.color}`} style={{ width: size, height: size, fontSize: size * 0.42 }} title={title || user.name}>{initials}</span>;
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
export function usePoll(fn, ms, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const live = useRef(0);
  const run = useCallback(async () => {
    const id = live.current;
    try { const d = await fn(); if (id === live.current) { setData(d); setError(null); } }
    catch (e) { if (id === live.current) setError(e); }
    finally { if (id === live.current) setLoading(false); }
  }, deps);
  useEffect(() => {
    live.current++; setLoading(true); setData(null);
    run();
    if (!ms) return undefined;
    const iv = setInterval(() => { if (!document.hidden) run(); }, ms);
    return () => clearInterval(iv);
  }, [run]);
  return { data, error, loading, reload: run };
}

export function Markdown({ text }) {
  const ref = useRef(null);
  useEffect(() => {
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

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button class="x" aria-label={t('common.close')} onClick={onClose}><Icon name="close" /></button></header>
        {children}
      </div>
    </div>
  );
}

// A destructive step names what it destroys and needs a second, deliberate click. When
// `typed` is set the person types it, for the ones that delete uncommitted work.
export function Confirm({ title, body, action, danger, typed, onYes, onClose }) {
  const [busy, setBusy] = useState(false);
  const [txt, setTxt] = useState('');
  const ok = !typed || txt.trim() === typed;
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
             onClick={async () => { setBusy(true); try { await onYes(); onClose(); } finally { setBusy(false); } }}>
          {busy ? t('common.wait') : action}
        </Btn>
      </footer>
    </Modal>
  );
}
