// web/ui/transcript.js — AN OPEN CHAT CONVERGES TO THE TRANSCRIPT WITHOUT BEING REOPENED.
//
// Reported from the phone as "the reply is not there until I leave the chat and open it again",
// and the daemon's log for the same evening said how: /api/session usually answered in well under
// a second but regularly took 8-26 s, slow answers clustered, and the phone then drew a burst of
// 429s from its own backlog of polls. A plain interval poll (usePoll) fails that four ways, each
// measured by test/helpers/chat-lands-check.mjs:
//   · OVERLAP. An interval starts the next read while the last is still out, and whichever answers
//     LAST is drawn — so a slow read asked before the reply was written puts the screen back to how
//     it was before the reply: there, then gone. And the backlog is the burst.
//   · A READ THAT NEVER ANSWERS (a socket an iOS resume killed) holds the chat for good.
//   · A RESUME waits out the period, when what is on screen is from before the app left.
//   · NOTHING ON SCREEN YET is an empty list, not a wait and not a failure.
// So: one read at a time, on a chain of timeouts timed from the end of the last read, so a read
// slower than the period never has another started behind it and a Retry-After moves the next read
// rather than being met by it. A read answering after a newer one was drawn is dropped by its
// sequence number. A resume, a pageshow or a focus asks again at once, and drops a read that is
// older than the hide or out longer than SUPERSEDE_MS. A read out longer than GIVEUP_MS is given up
// on and asked again. Conditional when the adapter can be (an ETag, answered 304 with no body), so
// an idle chat's poll costs a cellular tunnel almost nothing. Until the first page lands the retry
// backs off 1, 2, 4, 8, then every 15 s, and never stops while the chat is open.
//
// The adapter's `session(project, name, before, { etag, signal })` may ignore the options: an
// answer without `notModified` is simply a full page, and a read it cannot abort is dropped by the
// sequence check instead.
import { useState, useEffect, useRef } from 'preact/hooks';
import { toast } from './ui.jsx';
import { t } from './i18n.js';

export const LIVE_MS = 2000, IDLE_MS = 5000, SUPERSEDE_MS = 3000;
export const FIRST_GIVEUP_MS = 8000, GIVEUP_MS = 30000, RETRY_MAX_MS = 15000;

// THE NEWEST PAGE, ON TOP OF WHATEVER IS HELD ABOVE IT. Joined where the new page's first message
// sits in what is already held; everything before that is kept — the reader's paged-in history,
// and on the first page too the message a new one pushed out of the window: dropping it shrank the
// list above the reader by a message's height, and they were moved by that much. No overlap means
// more arrived than a page holds, and then the newest page alone is the truth — a gap drawn as if
// it were continuous would be worse.
const pageKey = (m) => `${m && m.role}|${m && m.ts}|${String((m && m.text) || '').slice(0, 200)}`;
export function mergeNewest(cur, fresh) {
  const ms = (fresh && fresh.messages) || [];
  if (!cur || !ms.length) return { ...fresh, pages: 1 };
  const old = cur.messages || [], k = pageKey(ms[0]);
  let at = -1;
  for (let i = old.length - 1; i >= 0; i--) if (pageKey(old[i]) === k) { at = i; break; }
  if (at < 0) return { ...fresh, pages: 1 };
  return { ...fresh, messages: [...old.slice(0, at), ...ms], next_before: cur.next_before, pages: cur.pages || 1 };
}

const why = (e) => (e && e.status === 429 ? t('chat.slowDown')
  : e && e.name === 'OfflineError' ? t('chat.offline') : String((e && e.message) || e));
const quiet = (e) => e && (e.status === 429 || e.name === 'OfflineError' || e.name === 'AuthError');

// `live()`: is an answer owed — the session working, or a message just sent. Read on each tick, so
// the cadence follows it without re-arming from the outside.
export function useTranscript(fleet, project, name, live) {
  const [page, setPage] = useState(null);
  const [load, setLoad] = useState({ tries: 0, why: '' });
  const [older, setOlder] = useState({ busy: false, err: '' });
  const r = useRef(null);
  const liveRef = useRef(live); liveRef.current = live;

  useEffect(() => {
    const st = { seq: 0, drawn: 0, read: null, timer: null, cur: null, tries: 0, hiddenAt: 0, gone: false, err: '', olderBusy: false };
    r.current = st;
    setPage(null); setLoad({ tries: 0, why: '' }); setOlder({ busy: false, err: '' });
    const held = () => (typeof fleet.heldFor === 'function' ? fleet.heldFor() : 0);
    const period = () => (!st.cur ? Math.min(1000 * 2 ** Math.max(0, st.tries - 1), RETRY_MAX_MS)
      : liveRef.current && liveRef.current() ? LIVE_MS : IDLE_MS);
    // Before the first page every failure is said IN the chat, where the conversation should be.
    const failed = (w) => { if (st.cur) return false; st.tries++; setLoad({ tries: st.tries, why: w }); return true; };
    const read = ({ fresh = false } = {}) => {
      if (st.read) {
        const age = Date.now() - st.read.at;
        const stale = st.read.at < st.hiddenAt || age > SUPERSEDE_MS;
        const dead = age > (st.cur ? GIVEUP_MS : FIRST_GIVEUP_MS);
        if (!dead && (!fresh || !stale)) return st.read.p;
        if (dead) failed(t('chat.noAnswer'));
        try { st.read.ctl && st.read.ctl.abort(); } catch {}
      }
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const me = { seq: ++st.seq, ctl, at: Date.now(), p: null };
      st.read = me;
      me.p = (async () => {
        try {
          const got = await fleet.session(project, name, null, { etag: (st.cur && st.cur.etag) || '', signal: ctl ? ctl.signal : undefined });
          if (st.gone || (ctl && ctl.signal.aborted)) return;
          if (st.cur && st.drawn > me.seq) return;           // a newer read has been drawn
          if (st.tries) { st.tries = 0; setLoad({ tries: 0, why: '' }); }
          st.err = '';
          if (got && got.notModified) { if (st.cur) st.drawn = me.seq; return; }
          st.cur = mergeNewest(st.cur, got); st.drawn = me.seq;
          setPage(st.cur);
        } catch (e) {
          if (st.gone || (ctl && ctl.signal.aborted)) return;   // we let it go
          const w = why(e);
          if (failed(w) || quiet(e)) return;                 // a hold or a dropped line is the banner's to say
          if (w !== st.err) { st.err = w; toast(w, 'bad'); }
        } finally { if (st.read === me) st.read = null; }
      })();
      return me.p;
    };
    // Re-armed when the timer fires, not when the read settles: a read that never answers would
    // otherwise be the last thing this timer ever did. A tick that finds a read out joins it.
    const arm = (ms = period()) => {
      clearTimeout(st.timer); st.timer = null;
      if (st.gone || document.hidden) return;
      st.timer = setTimeout(() => { st.timer = null; if (st.gone || document.hidden) return; read(); arm(); }, Math.max(ms, held()));
    };
    const resume = () => { if (st.gone || document.hidden) return; read({ fresh: true }).finally(() => arm()); };
    // Hidden, the timer is torn down rather than left to skip its turns: an app in a pocket does not
    // wake the radio every few seconds to decide it should not have.
    const vis = () => { if (document.hidden) { st.hiddenAt = Date.now(); clearTimeout(st.timer); st.timer = null; } else resume(); };
    const shown = (e) => { if (e && e.persisted) resume(); };
    st.read$ = read; st.arm = arm;
    read(); arm();
    document.addEventListener('visibilitychange', vis);
    addEventListener('pageshow', shown);
    addEventListener('focus', resume);
    return () => {
      st.gone = true; clearTimeout(st.timer);
      try { st.read && st.read.ctl && st.read.ctl.abort(); } catch {}
      document.removeEventListener('visibilitychange', vis);
      removeEventListener('pageshow', shown);
      removeEventListener('focus', resume);
    };
  }, [fleet, project, name]);

  // Asked now, on top of the poll: after a send, a verb, anything that changed the transcript.
  const reload = () => { const st = r.current; if (st && st.read$) st.read$({ fresh: true }).finally(() => st.arm()); };

  // THE PAGE ABOVE, prepended. One fetch at a time; after a failure none until asked again by hand,
  // because retrying on every scroll event would be a retry loop at the speed of a thumb. The poll
  // may land while this is out, so the older page goes under what was held when it was asked for
  // and whatever is held NOW goes back on top. `before()` runs just before the page is drawn, which
  // is when the chat measures what the reader is looking at.
  const loadOlder = async (before) => {
    const st = r.current, s = st && st.cur;
    if (!s || !s.next_before || st.olderBusy) return;
    st.olderBusy = true; setOlder({ busy: true, err: '' });
    try {
      const got = await fleet.session(project, name, s.next_before);
      if (st.gone) return;
      const cur = st.cur || s;
      const base = { ...cur, messages: [...(got.messages || []), ...(s.messages || [])],
                     next_before: got.next_before ?? null, pages: (s.pages || 1) + 1 };
      st.cur = mergeNewest(base, cur);
      if (before) before();
      setPage(st.cur); setOlder({ busy: false, err: '' });
    } catch (e) {
      if (!st.gone) setOlder({ busy: false, err: why(e) });
    } finally { st.olderBusy = false; }
  };
  const retryOlder = (before) => { setOlder({ busy: false, err: '' }); if (r.current) r.current.olderBusy = false; return loadOlder(before); };

  return { page, load, older, loadOlder, retryOlder, reload };
}
