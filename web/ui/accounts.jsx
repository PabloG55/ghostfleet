// web/ui/accounts.jsx — WHICH CLAUDE LOGIN EACH PROFILE IS SPENDING, at the top of the first page.
//
// One line per profile: its active account and that account's 5h and 7d figures, from the
// adapter's optional `usage()` (fleet-serve /api/usage, which is `fleet-accounts list`'s own data,
// lib/accounts.mjs describe()). So every word that names a STATE is the desk's word, carried in the
// payload, not one made up here; only the sentences around them are this app's, in both languages.
// A tap opens every account of every profile, laid out as `list` lays them out. Read only:
// switching stays at the desk. An app whose adapter has no `usage` draws nothing.
//
//   THE HUE IS THE FIXED PALETTE: green while the active account runs on figures read in the last
// six hours, yellow when they are older than that (stale) or the login in use is not a saved one,
// red when it cannot run — out, over the line, needs a login, blocked, or every account exhausted —
// and grey for the experiment switched off, which is said and nothing else.
//   READ GENTLY, on its own clock: the page's other polls run every few seconds and these figures
// only move when a turn lands, so it reads every POLL_MS and once more on a resume — never sooner
// than FLOOR_MS after the read before, so a window clicked in and out of is not a burst.
import { useState, useEffect } from 'preact/hooks';
import { useFleet } from './adapter.jsx';
import { Modal } from './ui.jsx';
import { t } from './i18n.js';
import './accounts.css';

const POLL_MS = 45000, FLOOR_MS = 10000, TICK_MS = 5000;
const RED = new Set(['out', 'exhausted', 'needs-login', 'blocked']);

// What all-exhausted did to the workers, by the word /api/usage carries (lib/accounts.mjs WORKERS).
const workers = (x) => t(`acct.workers.${['paused', 'running', 'mixed'].includes(x && x.workers) ? x.workers : 'paused'}`);
const until = (at) => (at ? t('acct.until', { at }) : '');
export const hue = (a) => (RED.has(a.kind) ? 'red' : a.kind === 'stale' ? 'yellow' : a.active ? (a.stale ? 'yellow' : 'green') : 'grey');
export function win(w, label, short = false) {
  if (!w) return `${label} —`;
  return short ? `${label} ${w.pct}% (${label === '5h' ? w.left : w.day})` : t('acct.resets', { label, pct: w.pct, at: w.resets_at, read: w.read });
}

// The line, as data: [{ profile, text, color }], the profile named only when there are two.
export function usageLines(u) {
  if (!u) return [];
  if (!u.enabled) return [{ profile: '', text: u.off || t('acct.off'), color: 'grey' }];
  const ps = u.profiles || [];
  if (!ps.length) return [{ profile: '', text: t('acct.none'), color: 'grey' }];
  return ps.map((p) => {
    const profile = ps.length > 1 ? p.profile : '';
    if (p.exhausted) return { profile, text: t('acct.exhausted', { until: until(p.exhausted.until_at), workers: workers(p.exhausted) }), color: 'red' };
    if (p.unsaved) return { profile, text: t('acct.unsaved'), color: 'yellow' };
    const a = (p.accounts || []).find((x) => x.active);
    if (!a) return { profile, text: t('acct.noActive'), color: 'grey' };
    if (a.kind !== 'active') return { profile, text: `${a.name} · ${a.state}`, color: hue(a) };
    const read = a.stale ? ` · ${t('acct.read', { when: (a.seven_day || a.five_hour || {}).read || t('acct.never') })}` : '';
    return { profile, text: `${a.name} · ${win(a.five_hour, '5h', true)} · ${win(a.seven_day, '7d', true)}${read}`, color: hue(a) };
  });
}

function useUsage(fleet) {
  const [u, setU] = useState(null);
  useEffect(() => {
    if (!fleet.usage) return undefined;
    let live = true, busy = false, wanted = false, at = 0;
    // Stamped either way, so a daemon that refuses it is asked again in 45s and not in 5.
    const read = () => {
      busy = true; wanted = false;
      Promise.resolve().then(() => fleet.usage()).then((j) => { if (live) setU(j); }, () => {})
        .finally(() => { busy = false; at = Date.now(); });
    };
    const tick = () => {
      if (busy || document.hidden) return;
      const since = Date.now() - at;
      if (since >= POLL_MS || (wanted && since >= FLOOR_MS)) read();
    };
    // A FLAG, not an earlier stamp: moving the stamp back on each focus let the second of five
    // focuses in a row read the stamp the first had moved, and the line was read 5s after the last.
    const soon = () => { wanted = true; };
    const shown = () => { if (!document.hidden) soon(); };
    read();
    const iv = setInterval(tick, TICK_MS);
    addEventListener('focus', soon);
    document.addEventListener('visibilitychange', shown);
    return () => { live = false; clearInterval(iv); removeEventListener('focus', soon); document.removeEventListener('visibilitychange', shown); };
  }, [fleet]);
  return u;
}

export function AccountsLine() {
  const fleet = useFleet();
  const u = useUsage(fleet);
  const [open, setOpen] = useState(false);
  const lines = usageLines(u);
  if (!lines.length) return null;
  const kids = lines.map((l, i) => (
    <div key={i} class={`u-line u-${l.color}`}>
      {l.profile ? <span class="u-prof">{l.profile}</span> : null}<span class="u-text">{l.text}</span>
    </div>
  ));
  // Off is a sentence with nothing behind it, so it is not a control.
  if (!u.enabled) return <div class="usage">{kids}</div>;
  return (
    <>
      <button type="button" class="usage" aria-haspopup="dialog" title={t('acct.open')} onClick={() => setOpen(true)}>{kids}</button>
      {open ? <AccountsDialog u={u} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AccountsDialog({ u, onClose }) {
  const ps = u.profiles || [];
  return (
    <Modal title={t('acct.title')} onClose={onClose}>
      <div class="modal-body usage-list">
        <p>{t('acct.threshold', { pct: u.threshold })}</p>
        {!ps.length ? <p>{t('acct.noProfile')}</p> : null}
        {ps.map((p) => (
          <section key={p.profile}>
            <h3 class="u-prof">{p.profile}{p.unsaved ? t('acct.profUnsaved')
              : p.exhausted ? t('acct.profExhausted', { until: until(p.exhausted.until_at), workers: workers(p.exhausted) }) : ''}</h3>
            {!(p.accounts || []).length ? <p>{t('acct.noAccounts')}</p> : <>
              {p.accounts.length < 2 ? <p>{t('acct.one')}</p> : null}
              {p.pin ? <p class="u-pin">{t('acct.pin', { account: p.pin.account, at: p.pin.until_at })}</p> : null}
              {p.accounts.map((a) => (
                <div key={a.name} class={`u-acct u-${hue(a)}`}>
                  <div class="u-head"><span class="u-name">{a.active ? '* ' : ''}{a.name}</span>
                    <span class="u-state">{a.state}{a.active && a.state !== 'active' ? t('acct.activeTag') : ''}</span></div>
                  <div class="u-win">{win(a.five_hour, '5h')}</div>
                  <div class="u-win">{win(a.seven_day, '7d')}</div>
                  {a.fix ? <p class="u-fix">{a.fix}</p> : null}
                </div>
              ))}
            </>}
          </section>
        ))}
        <p class="muted">{t('acct.readOnly')}</p>
      </div>
    </Modal>
  );
}
