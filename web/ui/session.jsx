import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { Ship } from './fleet.jsx';
import { STATUS, statusOf, StatusPill, Btn, SendBtn, usePoll, toast, Markdown, Confirm, Modal, useRequest, sinceTs, ago } from './ui.jsx';
import { Skeleton } from './skeleton.jsx';
import { render as renderAnsi } from '../ansi.js';   // the phone client's own, not a copy
import { useFleet, useSlot } from './adapter.jsx';
import { t, locale } from './i18n.js';
import { Icon } from './icon.jsx';
import { sendsOnEnter, finePointer } from './keys.js';
import { ToolTabs, ToolPanel } from './terminal.jsx';
import { useLayer } from './select.jsx';
import { BackLink } from './back.jsx';
import { useTranscript } from './transcript.js';
import { useReading, toggleRead, stopRead, useSpeakMode } from './chatvoice.js';
import { draftKey, draftText, draftFiles, lostFiles, keepDraft, seenLost, sentDraft } from './drafts.js';
import { useWake, ASLEEP_FAILED } from './wake.jsx';

// Claude's dialog speaks English; the buttons say what pressing them does.
function optionText(label) {
  const l = String(label || '');
  if (/^yes,? and don.?t ask again/i.test(l)) return { text: t('sess.opt.yesAlways'), sub: l, kind: 'yes' };
  if (/^yes,? allow all edits/i.test(l)) return { text: t('sess.opt.yesEdits'), sub: l, kind: 'yes' };
  if (/^yes/i.test(l)) return { text: t('sess.opt.yes'), sub: l, kind: 'yes' };
  if (/^no/i.test(l)) return { text: t('sess.opt.no'), sub: l, kind: 'no' };
  return { text: l, sub: '', kind: '' };
}

function PromptCard({ prompt, onAnswer, busy, typed, setTyped }) {
  if (prompt.kind === 'permission') {
    return (
      <div class="ask permission">
        <div class="ask-head"><b>{prompt.tool || t('sess.aTool')}</b></div>
        {prompt.command ? <pre class="ask-cmd">{prompt.command.replace(/╌+/g, '').trim()}</pre> : null}
        <div class="ask-opts">
          {(prompt.options || []).map(o => {
            const op = optionText(o.label);
            return (
              <button key={o.n} disabled={busy} class={`opt ${op.kind}`} onClick={() => onAnswer(String(o.n), false)}>
                <span class="n">{o.n}</span><span><b>{op.text}</b>{op.sub ? <small>{op.sub}</small> : null}</span>
              </button>
            );
          })}
        </div>
        <p class="muted small">{t('sess.checkCmd')}</p>
      </div>
    );
  }
  const tabs = (prompt.tabs || []).filter(x => !x.submit);
  return (
    <div class="ask question">
      <div class="ask-head">
        {tabs.length > 1 ? <span>{t('sess.qOf', { i: prompt.tab != null ? prompt.tab + 1 : '?', n: tabs.length })}</span> : null}
        {prompt.submit ? <span>{t('sess.review')}</span> : null}</div>
      <p class="ask-q">{prompt.question}</p>
      {prompt.typing ? (
        <form class="row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onAnswer(typed.trim(), false); }}>
          <input class="grow" disabled={busy} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} placeholder={t('sess.yourAnswer')} autoFocus />
          <SendBtn disabled={busy || !typed.trim()} />
        </form>
      ) : (
        <div class="ask-opts">
          {(prompt.options || []).map(o => (
            <button key={o.n} disabled={busy} class={`opt${o.chosen ? ' chosen' : ''}`} onClick={() => onAnswer(String(o.n), true)}>
              <span class="n">{o.n}</span><span><b>{o.label}</b>{o.description ? <small>{o.description}</small> : null}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The play button on a message. Its slot is the same size playing or not (it swaps play for stop), so a bubble never
// moves when one is pressed.
function ReadBtn({ on, onClick }) {
  return (
    <button type="button" class={`read-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? t('chat.stopRead') : t('chat.read')}
            title={on ? t('chat.stopRead') : t('chat.read')} onClick={onClick}><Icon name={on ? 'stop' : 'play'} /></button>
  );
}

function Terminal({ pane }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const html = pane ? renderAnsi(pane).html : '';
  useEffect(() => { const n = ref.current; if (n && stick.current) n.scrollTop = n.scrollHeight; }, [html]);
  return (
    <div class="term" ref={ref} onScroll={(e) => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 40; }}>
      {pane == null ? <Skeleton shape="lines" n={8} /> : <pre class="pane" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

// A message's key: when it was said, by whom, and which of that pair it is. Not its index — a page
// prepended above shifts every index, and a key that moves rebuilds the bubble, which throws a table
// scrolled sideways back to its first column and drops a selection in it.
function keyed(msgs) {
  const seen = new Map();
  return msgs.map((m) => { const k = `${m.ts}:${m.role}`; const n = seen.get(k) || 0; seen.set(k, n + 1); return [`${k}:${n}`, m]; });
}

// Waiting is drawn as the shape of a conversation, without words — the phone's rule. A read that
// FAILED says so in one line, why and that it is being asked again, because a skeleton that never
// resolves is exactly the "it does not load until I send" this was reported as.
function ChatLoading({ load }) {
  return (
    <div class="chat sk-late" aria-busy="true">
      {load.tries ? <p class="loading err center" role="status">{t('chat.loadFailed', { why: load.why })}</p> : null}
      {[0, 1, 2].map(i => <div key={i} class={`msg ${i === 1 ? 'me' : 'ai'} skel`} aria-hidden="true"><div class="bubble skel" /></div>)}
    </div>
  );
}

// OLDER MESSAGES LOAD BY SCROLLING UP: within OLDER_NEAR_PX of the top is the press. The message the
// reader is on stays exactly where it was: measured when the page above is ASKED for, and held there
// on every paint until it lands — through the "loading" line going in above it as well as the page,
// either of which alone would push it down. A scroll while it is out moves the hold with the reader,
// so it never fights a thumb. A list that does not fill its box asks by itself: it has no top to
// scroll to.
const OLDER_NEAR_PX = 240;
// THE SWIPE to the next or previous session, on the chat and not the screen: the Screen tab is a
// terminal that scrolls sideways on purpose. A finger only (a mouse drag there is selecting text),
// never from the left edge (iOS's own back gesture starts there), and more across than down.
const SWIPE_NEXT = 60, EDGE = 24;

// `author(message)` is an app's slot: who wrote a prompt. Without it, every prompt is an instruction.
function Chat({ scope, page, queued, older, onOlder, onRetryOlder, onStep, sent = 0 }) {
  const author = useSlot('author');
  const reading = useReading();
  const ref = useRef(null);
  const stick = useRef(true);
  const ours = useRef(-1);            // the scrollTop this chat last set itself (below)
  const anchor = useRef(null);
  const reader = useRef(null);
  const swipe = useRef(null);
  const msgs = page.messages || [];
  const rows = keyed(msgs);
  const last = rows.length ? rows[rows.length - 1][0] : '';
  const toEnd = (n) => { n.scrollTop = n.scrollHeight; ours.current = n.scrollTop; reader.current = null; };
  const rememberReader = (box) => {
    const top = box.getBoundingClientRect().top;
    const n = !stick.current && [...box.children].find(c => c.dataset.k && c.getBoundingClientRect().bottom > top);
    reader.current = n ? { node: n, top: n.getBoundingClientRect().top, scroll: box.scrollTop } : null;
  };
  useEffect(() => { const n = ref.current; if (n && stick.current) toEnd(n); }, [last, queued.length]);
  // A SEND TAKES THE CHAT TO ITS END, wherever the reader had scrolled to. The end used to follow
  // only a reader already at it (`stick`), so a message sent while reading older turns went in
  // below the fold and the chat stayed where it was, with nothing on screen to say it had gone.
  // The send puts the reader back at the end, and the jump above and the size watch below then
  // keep them there when the message lands, a moment later, from the transcript's next read or
  // as a queued bubble. The chat's own box scrolls; the window never does (viewport.js).
  useEffect(() => { const n = ref.current; if (!sent || !n) return; stick.current = true; toEnd(n); }, [sent]);
  // A CHAT AT ITS END STAYS AT ITS END. It jumped there when a message arrived, and its end moves
  // without one: the box shrinks when a permission card or a keyboard comes up, and a message grows
  // when its font lands. Under a permission card at 390x844 it sat 29 px short as opened, and the
  // newest message's last line lay under the Assistant button, the room left for that button being
  // at the very end. So the box and every row in it are watched, and while the reader is at the end
  // (`stick`) a change of size takes it back there. Not a tools row, which grows because the reader
  // opened it, and not while older messages land above (`anchor`).
  //   `stick` is the READER's: the browser sends the scroll event for a jump the chat made itself a
  // frame later, measured against whatever the box is by then, and a card drawn in that frame read
  // as the reader leaving the end, 415 px up, after which nothing took the chat back. A scroll that
  // lands where the chat put it (`ours`) leaves `stick` as it was.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const seen = new WeakSet();
    const ro = new ResizeObserver(() => {
      if (anchor.current) return;
      if (stick.current) { toEnd(box); return; }
      // Late header metadata or a row's font can move the message the reader
      // scrolled to without firing a scroll event. Keep that message on screen.
      const a = reader.current;
      if (a && box.contains(a.node)) {
        const d = a.node.getBoundingClientRect().top - a.top;
        if (Math.abs(d) > 0.5) { box.scrollTop += d; ours.current = box.scrollTop; a.scroll = box.scrollTop; }
      }
    });
    const watch = () => { for (const c of [box, ...box.children]) if (!seen.has(c) && c.tagName !== 'DETAILS') { seen.add(c); ro.observe(c); } };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(box, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);
  const measure = () => {
    const box = ref.current; if (!box) return;
    const top = box.getBoundingClientRect().top;
    const n = [...box.children].find(c => c.dataset.k && c.getBoundingClientRect().bottom > top);
    anchor.current = n ? { k: n.dataset.k, top: n.getBoundingClientRect().top } : null;
  };
  const held = () => { const box = ref.current, a = anchor.current; return a && box ? [...box.children].find(c => c.dataset.k === a.k) : null; };
  useLayoutEffect(() => {
    const box = ref.current, a = anchor.current;
    if (a && box) {
      const n = held();
      const d = n ? n.getBoundingClientRect().top - a.top : 0;
      if (d) box.scrollTop += d;
      if (!older.busy) anchor.current = null;
    }
    if (box && page.next_before && !older.busy && !older.err && box.scrollHeight <= box.clientHeight + 1) onOlder();
  });
  const nearTop = (box) => {
    const n = held(); if (n) anchor.current.top = n.getBoundingClientRect().top;
    if (!page.next_before || older.busy || older.err) return;
    if (box.scrollHeight <= box.clientHeight || box.scrollTop > OLDER_NEAR_PX) return;
    measure(); onOlder();
  };
  const down = (e) => { swipe.current = e.pointerType !== 'mouse' && e.clientX > EDGE ? { x: e.clientX, y: e.clientY } : null; };
  const up = (e) => {
    const s0 = swipe.current; swipe.current = null;
    if (!s0 || !onStep) return;
    const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
    if (Math.abs(dx) < SWIPE_NEXT || Math.abs(dx) <= Math.abs(dy) * 2) return;
    onStep(dx < 0 ? 1 : -1);
  };
  return (
    <div class="chat" ref={ref} data-keep-scroll="chat" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { swipe.current = null; }}
         onScroll={(e) => {
           const n = e.currentTarget;
           if (Math.abs(n.scrollTop - ours.current) > 1) {
             ours.current = -1; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60;
             // A queued scroll event can arrive after layout moved the box.
             // If the offset did not change, it is still the same reading spot.
             if (stick.current || !reader.current || Math.abs(n.scrollTop - reader.current.scroll) > 1) rememberReader(n);
           }
           nearTop(n);
         }}>
      {page.next_before
        ? (older.busy ? <p class="older muted center" role="status">{t('chat.olderLoading')}</p>
          : older.err ? <div class="older center"><span class="muted">{t('chat.olderFailed', { why: older.err })}</span>
                          <button class="link" onClick={() => { measure(); onRetryOlder(); }}>{t('sess.older')}</button></div>
          : null)
        : msgs.length ? <p class="start muted center">{t('chat.start')}</p> : null}
      {!msgs.length ? <p class="muted center">{t('sess.noMsgs')}</p> : null}
      {rows.map(([k, m]) => {
        if (m.role === 'tools') {
          const tools = m.tools || [];
          const names = [...new Set(tools.map(x => x.name))];
          return (
            <details key={k} data-k={k} class="tools">
              <summary><Icon name="gear" /> {t('sess.actions', { n: tools.length })} · {names.slice(0, 4).join(', ')}{names.length > 4 ? '…' : ''}<span class="when">{sinceTs(m.ts)}</span></summary>
              <ul>{tools.map((x, j) => <li key={j}><b>{x.name}</b> <span>{x.detail}</span></li>)}</ul>
            </details>
          );
        }
        return (
          <div key={k} data-k={k} class={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
            <div class="who">
              {m.role === 'user'
                ? <>{author(m) || t('sess.instruction')}</>
                : 'Claude'}
              <span class="when">{sinceTs(m.ts)}</span>
              <ReadBtn on={reading === `${scope}:${k}`} onClick={() => toggleRead(`${scope}:${k}`, m.text)} />
            </div>
            <div class="bubble">{m.role === 'user' ? <p class="plain">{m.text}</p> : <Markdown text={m.text} />}</div>
          </div>
        );
      })}
      {queued.map((q, i) => (
        <div key={`q${i}`} class="msg me pending">
          <div class="who">{t('sess.queuedMsg')}</div>
          <div class="bubble"><p class="plain">{q.text}</p></div>
        </div>
      ))}
    </div>
  );
}

const STATE_KEY = { listening: 'chat.speakListening', hearing: 'chat.speakHearing', sending: 'chat.speakSending', waiting: 'chat.speakWaiting', speaking: 'chat.speakReading' };
const hhmm = (at) => new Date(at * 1000).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// ── DETAILS: what this session left listening, running or booted ─────────────
// lib/ports.mjs's last scan, narrowed to this one session by the daemon (/api/ports). READ ONCE
// WHEN THE SHEET OPENS, NEVER POLLED: the scan is a dozen processes and the governor already redoes
// it every five minutes. Every row says HOW it was tied to the session, because that is what makes
// it believable: a port is this session's only if a parent process, a working directory, a compose
// label, a mount or a process naming the device says so.
//   THE PHONE GETS NO CONTROL HERE. `can_refresh` and `can_stop` are the daemon saying this is the
// owner's own browser on this machine, the one place a scan may be started or a thing stopped
// from (and never a stop in a work-profile project). A stop is ONE row, through a modal that names
// it; "Force stop" exists only after a TERM left that process running, behind a second modal of
// its own. Nothing on a card says any of this: the line at the top is the flag, and it is shown
// only here and in fleet-ports.
//   THE FLAG SPEAKS IN THE CHIP'S WORD. The scan's own state word ("done") sat under a header
// whose chip said "Ready" for the same session — two names for one moment, side by side. So the
// scan says WHETHER to flag (the session is not running a turn), and the header's status says
// what to call it. A chip that says the session is busy again means the scan is older than that,
// and a leftover flag on a working session would be the stale half talking.
export const IDLE_STATES = ['done', 'asleep', 'parked', 'lost', 'exited', 'stopped'];
const BUSY_CHIP = new Set(['working', 'need-you', 'starting']);
export function detailsFlag(state, items, status) {
  if (!IDLE_STATES.includes(state) || !items?.length || BUSY_CHIP.has(status)) return '';
  const ports = [...new Set(items.flatMap(i => i.kind === 'listen' ? [i.port] : i.kind === 'container' ? (i.ports || []).map(p => p.host) : []))].sort((a, b) => a - b);
  const nc = items.filter(i => i.kind === 'container').length, ns = items.filter(i => i.kind === 'simulator').length;
  const bits = [];
  if (ports.length) bits.push(t('details.flagListen', { ports: ports.map(p => ':' + p).join(', ') }));
  if (nc) bits.push(t(nc === 1 ? 'details.flagContainer' : 'details.flagContainers', { n: nc }));
  if (ns) bits.push(t(ns === 1 ? 'details.flagSimulator' : 'details.flagSimulators', { n: ns }));
  return `${STATUS[status]?.label || t(`details.state.${state}`)} — ${bits.join(', ')}`;
}
// What Details sends back to stop a row: the identity it SHOWED, so the daemon stops the
// process that was confirmed or refuses — never whatever holds that port now.
const wantOf = (it) => it.kind === 'listen' ? { kind: 'listen', port: it.port, pid: it.pid, start: it.start, cmd: it.cmd }
  : it.kind === 'container' ? { kind: 'container', id: it.id } : { kind: 'simulator', udid: it.udid };
const rowKey = (it) => `${it.kind}:${it.port || it.id || it.udid}:${it.pid || ''}`;
const rowName = (it) => it.kind === 'listen' ? `:${it.port} ${it.name || ''} (pid ${it.pid})`.replace('  ', ' ') : it.name || it.id;
function howWords(tie) {
  const at = tie.path ? tie.path.replace(/^\/(?:Users|home)\/[^/]+/, '~') : '';
  if (tie.how === 'parent') return t('details.how.parent', { chain: (tie.chain || []).join(' ← ') });
  if (tie.how === 'cwd') return t('details.how.cwd', { path: at });
  if (tie.how === 'label') return t('details.how.label', { path: at });
  if (tie.how === 'mount') return t('details.how.mount', { path: at });
  if (tie.how === 'argv') return t('details.how.argv', { pid: tie.pid });
  return '';
}
function DetailsModal({ project, name, status, onClose }) {
  const fleet = useFleet();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);       // { it, kill } — the row a modal is asking about
  const [left, setLeft] = useState({});       // rowKey -> the text of a TERM that left it running
  const load = async () => {
    try { setData(await fleet.ports(project, name)); setErr(''); }
    catch (e) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { load(); }, [project, name]);
  const refresh = async () => {
    setBusy(true);
    try { await fleet.portsRefresh(project); await load(); }
    catch (e) { toast(String(e?.message || e), 'bad'); }
    finally { setBusy(false); }
  };
  const stopOne = async ({ it, kill }) => {
    try {
      const r = await fleet.portsStop(project, name, wantOf(it), kill);
      if (r.result === 'still-running' && !kill) setLeft(l => ({ ...l, [rowKey(it)]: r.text }));
      else setLeft(l => { const n = { ...l }; delete n[rowKey(it)]; return n; });
      toast(r.text, r.result === 'stopped' ? 'ok' : 'bad');
    } catch (e) { toast(String(e?.message || e), 'bad'); }
    await load();
  };
  const items = data?.items || [];
  const canStop = data?.can_stop === true && !!fleet.portsStop;
  const flag = data ? detailsFlag(data.state, items, status) : '';
  const groups = [['listen', 'details.listening'], ['container', 'details.containers'], ['simulator', 'details.simulators']]
    .map(([kind, head]) => [head, items.filter(i => i.kind === kind)]).filter(([, list]) => list.length);
  const age = data?.at ? Date.now() / 1000 - data.at : null;
  // The confirm is the sheet's SIBLING, not its child, so the sheet's Tab trap does not walk into
  // it; and while it is open the sheet ignores its own Esc, which would otherwise close both.
  const keep = () => {};
  return (<>
    <Modal sheet wide title={t('details.title', { name })} onClose={ask ? keep : onClose}>
      <div class="modal-body stack details">
        {flag ? <p class="details-flag" role="status"><Icon name="warning" /> {flag}</p> : null}
        {err ? <p class="bad small">{err}</p>
          : !data ? <p class="muted">{t('common.loading')}</p>
          : !data.at ? <p class="muted">{t('details.never')}</p>
          : !items.length ? <p class="muted">{t('details.empty')}</p>
          : groups.map(([head, list]) => (
            <section key={head} class="details-group">
              <h3>{t(head)}</h3>
              <ul>
                {list.map(it => (
                  <li key={`${it.kind}:${it.port || it.id || it.udid}:${it.pid || ''}`}>
                    <div class="details-what">
                      {it.kind === 'listen' ? <><b>:{it.port}</b> <span>{it.name || '?'}</span> <span class="muted small">pid {it.pid}</span></>
                        : it.kind === 'container' ? <><b>{it.name || it.id}</b> <span class="muted small">{it.image}</span>{(it.ports || []).map(p => <span key={`${p.host}${p.to}`} class="muted small"> :{p.host}→{p.to}</span>)}</>
                        : <><b>{it.name}</b> <span class="muted small">{it.runtime}</span></>}
                    </div>
                    <div class="details-how muted small">{howWords(it.tie)}</div>
                    {it.kind === 'listen' && it.cmd ? <code class="details-cmd small">{it.cmd}</code> : null}
                    {canStop && left[rowKey(it)] ? <p class="details-left small" role="status">{t('details.stillRunning')}</p> : null}
                    {canStop ? <div class="details-stop">
                      {left[rowKey(it)] && it.kind === 'listen'
                        ? <Btn kind="danger sm" onClick={() => setAsk({ it, kill: true })}>{t('details.force')}</Btn>
                        : <Btn kind="ghost sm" icon="stop" onClick={() => setAsk({ it, kill: false })}>{t('details.stop')}</Btn>}
                    </div> : null}
                  </li>))}
              </ul>
            </section>))}
        <footer>
          <span class="muted small">{data?.at ? (age < 60 ? t('details.scannedNow') : t('details.scanned', { ago: ago(age) })) : ''}</span>
          {data?.can_refresh && fleet.portsRefresh
            ? <Btn kind="ghost sm" disabled={busy} onClick={refresh} icon="refresh">{t('details.refresh')}</Btn> : null}
        </footer>
      </div>
    </Modal>
    {ask ? <Confirm danger
        title={t(ask.kill ? 'details.forceTitle' : 'details.stopTitle', { what: rowName(ask.it) })}
        body={ask.kill ? t('details.forceBody', { pid: ask.it.pid })
          : t(ask.it.kind === 'listen' ? 'details.stopBodyListen' : ask.it.kind === 'container' ? 'details.stopBodyContainer' : 'details.stopBodySimulator',
              { pid: ask.it.pid, id: ask.it.id, udid: ask.it.udid, name })}
        action={t(ask.kill ? 'details.forceGo' : 'details.stopGo')}
        onYes={() => stopOne(ask)} onClose={() => setAsk(null)} /> : null}
  </>);
}

function ScheduleModal({ name, onClose, onSave }) {
  const [msg, setMsg] = useState(() => t('sched.default'));
  const [when, setWhen] = useState(() => localInput(new Date(Date.now() + 3600e3)));
  const [busy, setBusy] = useState(false);
  const quick = [
    [t('sched.in30'), () => Date.now() + 30 * 60e3],
    [t('sched.in1h'), () => Date.now() + 3600e3],
    [t('sched.in3h'), () => Date.now() + 3 * 3600e3],
    [t('sched.tomorrow'), () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }],
  ];
  const save = async (ms) => { setBusy(true); try { await onSave(Math.floor(ms / 1000), msg.trim() || t('sched.default')); onClose(); } finally { setBusy(false); } };
  return (
    <Modal title={t('sched.title', { name })} onClose={onClose}>
      <div class="stack modal-body">
        <p class="muted">{t('sched.why')}</p>
        <label class="field"><span>{t('sched.message')}</span><textarea rows={3} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} /></label>
        <div class="quick">{quick.map(([l, f]) => <Btn key={l} kind="ghost" disabled={busy} onClick={() => save(f())}>{l}</Btn>)}</div>
        <label class="field"><span>{t('sched.exact')}</span><input type="datetime-local" value={when} onInput={(e) => setWhen(e.currentTarget.value)} /></label>
        <footer><Btn onClick={onClose}>{t('common.cancel')}</Btn><Btn kind="primary" disabled={busy || !when} onClick={() => save(new Date(when).getTime())}>{t('sched.go')}</Btn></footer>
      </div>
    </Modal>
  );
}

// One of the state's controls in the header (Interrupt, Pause, Wake, Reopen, Resume, Start). Its
// word is a span of its own, so a phone can draw the button as its icon alone (ui.css) while the
// word stays its name: what a screen reader says and what a test or a search of the page finds.
function Act({ kind = '', icon, word, title, ...rest }) {
  return <Btn kind={`ghost sm act ${kind}`} icon={icon} title={title || word} {...rest}><span class="act-word">{word}</span></Btn>;
}

// Slots (adapter.jsx): `ownerPicker({ project, name, owner, onChanged })` beside the session's
// tools, and `presence(here)` under the header, where `here` is the pane's list of who else has
// it open. The adapter's optional `presence(project, session, typing)` is told every 5 s.
//
// `embedded`: the session is a column inside another page (a stack, stacks.jsx), under a header
// that already names it and links to it. Its own back link and title would say both again, so they
// are left out; its state, branch and tools stay.
//
// `quiet`: a column that does not have the focus. A STACK IS SEVERAL OF THESE READING AT ONCE, and
// the daemon allows one device 240 reads a minute. A focused session reads its transcript every
// 2 s while an answer is owed and its pane every 2.5 s, up to 54 a minute; four of those is most of
// the budget, and the old phone client was told by a burst of 429s what that costs: replies that
// did not land until the chat was reopened. So a quiet column reads its transcript at the idle
// pace and its pane every 15 s, 16 a minute, and the focused one reads as a session does. A stack
// of twelve fits. The pane read keeps its last answer between reads, so nothing flickers.
export const QUIET_PANE_MS = 15000;
// `waiting` is the parent saying its read of the cards has not answered yet, which is not the
// same as a session with no card: the first is drawn as the header's shape (below), the second
// as "No data", which is a finding and was being shown for the length of every load.
export function SessionView({ project, name, card, waiting = false, onChanged, onGone, onStep = null, tool: routeTool = null, embedded = false, quiet = false, startLead = null }) {
  const fleet = useFleet();
  const ownerPicker = useSlot('ownerPicker'), presence = useSlot('presence');
  const [tab, setTab] = useState('chat');
  const [localTool, setLocalTool] = useState(null);
  const tool = embedded ? localTool : routeTool;
  // From a Terminal or Editor tab (a route of its own) the session's two tabs go back to its page.
  const pick = (x) => { setTab(x); if (embedded) setLocalTool(null); else if (tool) fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`); };
  // The box is this session's draft (drafts.js): its words and files are back when the session is
  // opened again, after a reload and after a relaunch, until a send of them succeeds. The view is
  // mounted per session (keyed by its parent), so the draft is read once, here.
  const dkey = draftKey(project, name);
  const [draft, setDraftState] = useState(() => draftText(dkey));
  const setDraft = (v) => { setDraftState(v); keepDraft(dkey, v); };
  const [lost, setLost] = useState(() => lostFiles(dkey));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [rename, setRename] = useState(null);
  const [menu, setMenu] = useState(false);
  // What this server does at all (adapter.jsx `can`): a verb it refuses by name is not offered,
  // rather than offered and refused on every tap.
  const can = (verb) => (typeof fleet.can === 'function' ? fleet.can(verb) : true);
  // Stop, rename and pause wait for the CARD, not just for "not the lead": a deep link draws this
  // screen before the grid answers, and `!card?.lead` read the lead as a worker for that second —
  // measured, the lead's menu offered "Stop session…" until its card arrived.
  // More is a layer like every picker and popover: Esc closes it and puts the focus back on its
  // button, a press outside closes it. It used to close only when the mouse left it, so on a
  // touch screen it stayed open until one of its actions was chosen, and Esc did nothing.
  const menuWrap = useRef(null);
  useLayer(menu, (n) => menuWrap.current?.contains(n), (focus) => {
    setMenu(false);
    if (focus) menuWrap.current?.querySelector('.btn')?.focus({ preventScroll: true });
  });
  const [labelEdit, setLabelEdit] = useState(null);
  const [schedOpen, setSchedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [files, setFilesState] = useState(() => draftFiles(dkey));   // {id, name, size, state: 'up'|'ok'|'err', path, preview, why}
  // An upload answers seconds after it was picked, perhaps once the person has moved on: it lands in
  // THIS session's draft, and on the screen only while the screen is still this session's.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const setFiles = (fn) => {
    const next = fn(draftFiles(dkey));
    keepDraft(dkey, draftText(dkey), next);
    if (mounted.current) setFilesState(next);
  };
  const [drag, setDrag] = useState(false);
  const picker = useRef(null);
  const typing = useRef(!!draft);
  const composer = useRef(null);
  // ON A PHONE THE BOX IS AS TALL AS WHAT IS TYPED IN IT: one line at rest, the buttons' height
  // (ui.css), and a line more for each line typed, up to its cap, after which it scrolls. Sized from
  // the draft and nothing else, so a message that arrives or a card that lands never moves it, and
  // a send that empties it puts it back on one line. Before paint (a layout effect), so a draft
  // brought back from an earlier visit opens at its height instead of growing into it. The desk
  // keeps its two rows and does not grow.
  useLayoutEffect(() => {
    const n = composer.current;
    const fit = () => {
      if (!n) return;
      n.style.height = '';
      if (!matchMedia('(max-width: 900px)').matches) return;
      const cs = getComputedStyle(n);
      const need = n.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      if (need > n.offsetHeight + 0.5) n.style.height = `${need}px`;
    };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [draft, tool]);   // a tool tab unmounts the composer; back on the chat, the draft is fitted again
  const lastComposerKey = useRef(-Infinity);
  const typingPause = useRef(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerRecent, setComposerRecent] = useState(false);
  const composerKey = () => {
    lastComposerKey.current = performance.now();
    setComposerRecent(true);
    clearTimeout(typingPause.current);
    typingPause.current = setTimeout(() => setComposerRecent(false), 2000);
  };
  useEffect(() => () => clearTimeout(typingPause.current), []);

  // The transcript on its own poll (transcript.js), LIVE while an answer is owed: the session
  // working, or a message sent in the last two minutes.
  const sentAt = useRef(0);
  // How many messages this screen has sent: each one takes the chat to its end (Chat's `sent`).
  const [sends, setSends] = useState(0);
  const statusNow = useRef('unknown');
  const quietRef = useRef(quiet); quietRef.current = quiet;
  const tr = useTranscript(fleet, project, name, () => !quietRef.current &&
    (statusNow.current === 'working' || statusNow.current === 'starting' || Date.now() - sentAt.current < 120000));
  const lastPane = useRef({ at: 0, data: null });
  const pane = usePoll(async () => {
    const was = lastPane.current;
    if (quietRef.current && was.data && Date.now() - was.at < QUIET_PANE_MS) return was.data;
    const data = await fleet.pane(project, name);
    lastPane.current = { at: Date.now(), data };
    return data;
  }, 2500, [project, name]);
  useEffect(() => {
    if (!fleet.presence) return undefined;
    const iv = setInterval(() => { if (!document.hidden) fleet.presence(project, name, typing.current).catch(() => {}); }, 5000);
    return () => clearInterval(iv);
  }, [project, name]);

  const st = card ? statusOf(card) : (tr.page?.status || 'unknown');
  statusNow.current = st;
  // THE HEADER IS A SHAPE UNTIL THE CARD LANDS, its controls included. With no card the state
  // above is the conversation's own read, which can land first: a working session then drew
  // Interrupt beside the controls' shape, and when the card came the shape went and Interrupt
  // slid 82 px back along the row (two loads in six, at either width).
  const shaped = waiting && !card;
  const owner = card?.owner || tr.page?.owner || null;
  const prompt = pane.data?.prompt || null;
  const available = !quiet && !confirm && rename == null && labelEdit == null && !schedOpen && !detailsOpen;
  // A request waits for a pause in an active sentence. The draft stays in its original box
  // until then; Enter explicitly opens the request rather than sending that sentence.
  const held = !!prompt && composerFocused && composerRecent;
  const request = useRequest(`session:${project}/${name}`, pane.data ? (prompt?.fingerprint || null) : undefined, available && !held);
  const showRequest = () => { clearTimeout(typingPause.current); setComposerRecent(false); request.show(); };
  const quota = useRequest(`quota:${project}/${name}`, card ? (st === 'limit' ? String(card.limit_at || 'limit') : null) : undefined, available && !prompt);
  const canAnswer = !fleet.canAnswer || fleet.canAnswer(project);
  const [typedAnswer, setTypedAnswer] = useState('');
  useEffect(() => { setTypedAnswer(''); }, [prompt?.fingerprint]);
  const answering = useRef(false);

  // A wake that failed, whether it was Wake or a send that had to wake it first (fleet-send wakes
  // an asleep session before it types, and refuses when the wake does), says why in the wake's
  // own sheet (wake.jsx); everything else that is refused keeps its line.
  const wk = useWake();
  const refresh = () => { onChanged(); tr.reload(); pane.reload(); };
  const act = async (tool, args = {}, opts = {}) => {
    setBusy(true);
    try {
      const r = await fleet.act(tool, { project, session: name, ...args }, opts);
      if (r.queued === 'question') toast(t('sess.queuedQ'), '');
      else if (r.queued) toast(t('sess.queuedTurn'), '');
      else if (r.into) toast(t('sess.intoTurn'), '');
      refresh();
      return r;
    } catch (e) {
      if (e.body?.changed) { toast(t('sess.changed'), 'bad'); pane.reload(); }
      else if (tool === 'fleet_wake' || ASLEEP_FAILED.test(e.message)) wk.fail(project, name, e.message, refresh);
      else toast(e.message, 'bad');
      return null;
    } finally { setBusy(false); }
  };
  const answer = async (text, noEnter) => {
    if (!canAnswer || answering.current || !prompt) return;
    answering.current = true;
    try {
      const r = await act('fleet_answer', { text, no_enter: noEnter, expect: prompt.fingerprint });
      if (r) request.close();
    } finally { answering.current = false; }
  };
  // The dialog owns these keys; the app's normal desk shortcuts deliberately stop at a modal.
  const requestOpenedAt = useRef(Infinity);
  useLayoutEffect(() => {
    requestOpenedAt.current = request.open ? performance.now() : Infinity;
  }, [request.open, prompt?.fingerprint]);
  useLayoutEffect(() => {
    if (!request.open || !canAnswer || prompt?.typing) return;
    const key = (e) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.keyCode === 229 || /^(INPUT|TEXTAREA)$/.test(e.target?.tagName) || e.target?.isContentEditable) return;
      // Focus may have just left a sentence containing a number. Neither typed-through keys
      // nor a held key may authorize a tool; deliberate clicks remain immediate.
      const now = performance.now();
      if (now - requestOpenedAt.current < 600 || now - lastComposerKey.current <= 1500) return;
      const o = prompt.options?.find(o => String(o.n) === e.key);
      if (o) { e.preventDefault(); answer(String(o.n), prompt.kind !== 'permission'); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [request.open, prompt, canAnswer]);
  // Speak mode and the play button on messages (chatvoice.js). Leaving the session stops whichever of them is
  // this session's, and only this session's: an embedded stack holds several of these at once.
  const scope = `${project}/${name}`;
  const speakMode = useSpeakMode({
    scope, page: tr.page, status: st,
    send: async (text) => { const r = await act('fleet_send', { prompt: text }); if (r) { sentAt.current = Date.now(); setSends(n => n + 1); } return !!r; },
  });
  useEffect(() => () => stopRead(scope), [scope]);
  // Each file goes up as soon as it is picked, so "Send" only sends the words that name them.
  const addFiles = (list) => {
    const picked = [...(list || [])].slice(0, Math.max(0, fleet.attachPerMessage - files.length));
    if (list?.length > picked.length) toast(t('sess.maxFiles', { n: fleet.attachPerMessage }), '');
    for (const f of picked) {
      const id = Math.random().toString(36).slice(2);
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      setFiles(x => [...x, { id, name: f.name || t('sess.pasted'), size: f.size, state: 'up', preview }]);
      fleet.attach(project, name, f)
        .then(r => setFiles(x => x.map(y => y.id === id ? { ...y, state: 'ok', path: r.path } : y)))
        .catch(e => setFiles(x => x.map(y => y.id === id ? { ...y, state: 'err', why: e.message } : y)));
    }
  };
  const dropFile = (id) => setFiles(x => { const f = x.find(y => y.id === id); if (f?.preview) URL.revokeObjectURL(f.preview); return x.filter(y => y.id !== id); });
  const uploading = files.some(f => f.state === 'up');
  const ready = files.filter(f => f.state === 'ok');
  const sendOff = (!!prompt && !held) || st === 'limit' || busy || uploading || (!draft.trim() && !ready.length);
  const [sendMenu, setSendMenu] = useState(false);
  const hold = useRef({ timer: 0, fired: false, at: 0 });
  const openSendMenu = () => { hold.current.at = Date.now(); setSendMenu(true); };
  // the same press, arriving late on a browser that does not honour the cancelled touchend
  const sendMenuFresh = () => Date.now() - hold.current.at < 400;
  useEffect(() => () => clearTimeout(hold.current.timer), []);
  // after: the composer's "send after this turn" (the Send button held, or right-clicked). A plain
  // send to a working session goes INTO its turn (bin/fleet-send), so holding it is the choice.
  const sendDraft = async (after = false) => {
    if (prompt) { showRequest(); return; }
    if (st === 'limit') return;
    const text = draft.trim();
    if ((!text && !ready.length) || uploading) return;
    // Words first: a message that opens with a path (`/home/…`) reads as a slash command.
    const list = ready.map(f => `- ${f.path}`).join('\n');
    const message = !ready.length ? text
      : `${text || t('sess.attaching', { n: ready.length })}\n\n${t('sess.attached', { n: ready.length })}:\n${list}`;
    const r = await act('fleet_send', after ? { prompt: message, after_turn: true } : { prompt: message });
    if (r) {
      sentAt.current = Date.now(); typing.current = false; setSends(n => n + 1);
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      sentDraft(dkey); setDraftState(''); setLost(0);
      if (mounted.current) setFilesState([]);
    }
  };

  const stop = (reclaim) => setConfirm({
    title: reclaim ? t('sess.stopRmTitle') : t('sess.stopTitle'),
    action: reclaim ? t('sess.stopRm') : t('sess.stop'), danger: true,
    typed: reclaim ? name : null,
    body: reclaim
      ? <p>{t('sess.stopRmBody.a')}<b>{name}</b>{t('sess.stopRmBody.b')}</p>
      : <p>{t('sess.stopRmBody.a')}<b>{name}</b>{t('sess.stopBody.b')}</p>,
    onYes: async () => { const r = await act('fleet_stop', reclaim ? { reclaim: true } : {}, { confirm: true }); if (r) { toast(r.text?.split('\n')[0] || t('sess.stopped'), 'good'); onGone(); } },
  });

  const parked = st === 'parked';
  return (
    <section class="session">
      <header class={`sess-head${embedded ? ' embedded' : ''}`}>
        {/* where the person came from, by name; opened by a link, the session's project */}
        {embedded ? null : <BackLink parent={`/p/${encodeURIComponent(project)}`} />}
        <div class="sess-title">
          {/* THE HEADER AT ITS FINAL SIZE BEFORE ITS CARD HAS LANDED. Its state, branch, PR and
              controls all come with the card, so the header used to be a name and "More", and
              grew a row when the card answered: 28 px at 390 wide, under which the tabs and the
              whole conversation went down. The same elements are drawn as shapes (ui.css
              .sk-ghost) where the real ones will stand. */}
          {embedded ? null : <span class="sess-name"><Ship state={shaped ? 'idle' : st} size={32} /><h1>{name}</h1></span>}
          {/* ...BUT HOW MANY LINES THEY TOOK, AND HOW WIDE, WAS THE CARD'S TO SAY. The shapes were
              one guess, a branch and a PR after the name, and at 390 wide that wrapped to two
              lines; a lead on `main` with no PR fits on one, so its header lost a row when the
              card landed and the tabs and the conversation went UP 28 px (measured per state:
              master, list-pages and csv-export 28, a label and a schedule 5). So the name is one
              line, and everything the card says about the session is one more (ui.css
              .sess-meta), on a phone under the name and on a desk after it, and neither wraps.
                The state is the first thing on that line and not the last thing beside the name,
              because its width is the card's too: "Ready" is 65 px, "Interrupted" half as wide
              again, the shape 62. Anything drawn after it before the card came would stand
              wherever the word ended, and the branch's line did, 10 to 39 px along on a desk.
                ON A PHONE THE WHOLE HEADER IS ONE ROW, 44 px: back, ship, these two lines, the
              controls as icons and More (ui.css). It was three rows, 145 px, and with the
              on-screen keyboard up on a 390 x 844 phone that left the conversation 21 px between
              it and the composer, none of it a line of text. So this line holds the state and the
              branch there, and the PR, the label and the schedule are at the top of More. */}
          <span class="sess-meta">
            {shaped ? <span class="sk sk-ghost-row" role="status" aria-label={t('common.loading')}>
              <span class="pill sk-ghost" aria-hidden="true">Working</span>
              <span class="branch sk-ghost" aria-hidden="true"><Icon name="branch" /> feat/a-branch-name</span>
              <span class="tag pr sk-ghost" aria-hidden="true">PR 0000</span>
            </span> : <StatusPill status={st} />}
            {card?.branch ? <span class="branch" title={card.branch}><Icon name="branch" /> {card.branch}</span> : null}
            {card?.pr ? <span class="tag pr">PR {card.pr}</span> : null}
            {card?.label ? (can('gfw_label')
              ? <button class="chip-label" title={t('sess.changeLabel')} onClick={() => setLabelEdit(card.label)}><Icon name="tag" /> {card.label}</button>
              : <span class="chip-label"><Icon name="tag" /> {card.label}</span>) : null}
            {card?.sched ? (
              <span class="chip-sched" title={t('sess.schedMsg', { msg: card.sched.msg || '' })}><Icon name="clock" /> {hhmm(card.sched.at)} · “{String(card.sched.msg || '').slice(0, 30)}”
                {can('gfw_unschedule') ? <button aria-label={t('sess.unsched')} onClick={() => act('gfw_unschedule')}><Icon name="close" /></button> : null}</span>
            ) : null}
          </span>
        </div>
        {/* MORE HAS A PLACE OF ITS OWN, at the row's end, and the state's controls fill the room
            before it (ui.css .sess-acts). They are a different set in every state (Interrupt and
            Pause while working, Wake asleep, Reopen lost, Resume parked, none for an idle lead),
            so More, drawn after them, was wherever they ended: one shape and More while the card
            was out, then Interrupt and Pause landed and pushed it 97 px along, and it moved again
            each time the session started or stopped working. On a phone each control is its icon
            alone, 38 px wide, with its word kept as its name (Act). */}
        <div class="sess-tools">
          <div class="sess-acts">
          {ownerPicker({ project, name, owner, onChanged: () => { onChanged(); tr.reload(); } })}
          {shaped ? <span class="sk" aria-hidden="true"><Act kind="sk-ghost" disabled tabIndex={-1} icon="pause" word={t('sess.pause')} /></span> : null}
          {st === 'working' && !shaped ? <Act disabled={busy} onClick={() => act('fleet_interrupt')} title={t('sess.interruptHint')} icon="hand" word={t('sess.interrupt')} /> : null}
          {st === 'asleep' && !shaped ? <Act disabled={busy} onClick={() => act('fleet_wake')} icon="sun" word={t('sess.wake')} /> : null}
          {st === 'lost' && !shaped ? <Act disabled={busy} onClick={() => act('fleet_reopen')} icon="refresh" word={t('sess.reopen')} /> : null}
          {card && !card.lead && !['asleep', 'lost'].includes(st)
            ? <Act disabled={busy} onClick={() => act(parked ? 'fleet_resume' : 'fleet_pause')} icon={parked ? 'play' : 'pause'} word={parked ? t('sess.resume') : t('sess.pause')} /> : null}
          {/* A LEAD IS NEVER PAUSED HERE, but a parked one has to come back from here: the pair
              above is a worker's, so a lead parked by an older build or by hand had no way up
              from its own screen. Only Resume, never Pause (fleet_pause refuses a lead). */}
          {card?.lead && parked ? <Act disabled={busy} onClick={() => act('fleet_resume')} icon="play" word={t('sess.resume')} /> : null}
          {/* ...and a project with NO lead, opened at its lead's name: the project page's own
              start (startLead, fleet.lead), so both places start one the same way. */}
          {!card && startLead ? <Act disabled={busy} onClick={startLead} icon="play" word={t('project.leadStart')} /> : null}
          </div>
          <div class="menu-wrap" ref={menuWrap}>
            <Btn kind="ghost sm more-btn" onClick={() => setMenu(m => !m)} aria-haspopup="true" aria-expanded={menu} title={t('sess.more')}>
              <Icon name="more" class="more-ico" /><span class="act-word">{t('sess.more')}</span><span class="more-caret" aria-hidden="true"> ▾</span></Btn>
            {menu ? (
              <div class="menu">
                {/* On a phone the line under the name holds the state and the branch, cut short;
                    the rest of what the card says is here, whole (ui.css). A desk's header has
                    room for all of it, and this is not drawn there. */}
                {card && (card.branch || card.pr || card.label || card.sched) ? (
                  <div class="menu-info">
                    {card.branch ? <span class="branch"><Icon name="branch" /> {card.branch}</span> : null}
                    {card.pr ? <span class="tag pr">PR {card.pr}</span> : null}
                    {card.label ? <span class="chip-label"><Icon name="tag" /> {card.label}</span> : null}
                    {card.sched ? <span class="chip-sched"><Icon name="clock" /> {hhmm(card.sched.at)} · “{String(card.sched.msg || '').slice(0, 60)}”</span> : null}
                  </div>) : null}
                {/* ...and the rest of what this session is about, beside it: what it left listening,
                    running or booted (DetailsModal), on a desk and a phone alike. */}
                {card && fleet.ports ? <button onClick={() => { setMenu(false); setDetailsOpen(true); }}><Icon name="list" /> {t('sess.details')}</button> : null}
                {can('gfw_label') ? <button onClick={() => { setMenu(false); setLabelEdit(card?.label || ''); }}><Icon name="tag" /> {t('sess.setLabel')}</button> : null}
                {can('gfw_schedule') ? <button onClick={() => { setMenu(false); setSchedOpen(true); }}><Icon name="clock" /> {t('sess.schedule')}</button> : null}
                {/* The schedule's × rides in its chip, which a phone does not draw (above), so its
                    cancel is here as well. */}
                {card?.sched && can('gfw_unschedule') ? <button onClick={() => { setMenu(false); act('gfw_unschedule'); }}><Icon name="close" /> {t('sess.unsched')}</button> : null}
                {card && !card.lead ? <button onClick={() => { setMenu(false); setRename(name); }}>{t('sess.renameMenu')}</button> : null}
                {card && !card.lead ? <button onClick={() => { setMenu(false); stop(false); }}>{t('sess.stopMenu')}</button> : null}
                {card && !card.lead ? <button class="danger" onClick={() => { setMenu(false); stop(true); }}>{t('sess.stopRmMenu')}</button> : null}
              </div>
            ) : null}
          </div>
        </div>
        {presence(pane.data?.here || [])}
      </header>

      {quota.open ? <Modal sheet title={t('status.limit.hint')} onClose={quota.close}>
        <div class="ask limit">
          <div class="ask-head"><b><Icon name="hourglass" /> {t('status.limit.hint')}</b>{card?.limit_at ? <span>{t('sess.quotaBack', { when: hhmm(card.limit_at) })}</span> : null}</div>
          <p class="muted small">{t('sess.limitWhy')}</p>
          {card?.sched
            ? <p>{t('sess.alreadySched', { when: hhmm(card.sched.at) })}</p>
            : !can('gfw_schedule') ? null
            : <div class="row wrap">
                <Btn kind="primary" disabled={busy} onClick={async () => { const r = await act('gfw_schedule', { at: (card?.limit_at || Math.floor(Date.now() / 1000) + 5 * 3600) + 90, msg: t('sess.continueMsg') }); if (r) quota.close(); }}>
                  <Icon name="clock" /> {t('sess.resumeOnQuota')}</Btn>
                <Btn kind="ghost" onClick={() => { quota.close(); setSchedOpen(true); }}>{t('sess.otherTime')}</Btn>
              </div>}
        </div>
      </Modal> : null}

      {request.open ? <Modal sheet title={t(prompt.kind === 'permission' ? 'sess.asksPermission' : 'sess.asks')} onClose={request.close}>
        <PromptCard key={prompt.fingerprint} prompt={prompt} onAnswer={answer} busy={busy || !canAnswer} typed={typedAnswer} setTyped={setTypedAnswer} />
        {!canAnswer ? <p class="modal-body muted small">{t('sess.requestReadonly')}</p> : null}
      </Modal> : null}

      <div class="tabs" role="tablist">
        <button role="tab" class={!tool && tab === 'chat' ? 'on' : ''} onClick={() => pick('chat')}>{t('sess.chat')}</button>
        <button role="tab" class={!tool && tab === 'term' ? 'on' : ''} title={t('sess.screenHint')} onClick={() => pick('term')}>{t('sess.screen')}</button>
        <ToolTabs project={project} session={name} tool={tool} onPick={embedded ? setLocalTool : null} />
      </div>
      {tool ? <ToolPanel key={tool} project={project} session={name} kind={tool} quiet={quiet} onUnavailable={embedded ? () => setLocalTool(null) : null} /> : tab === 'chat'
        ? (!tr.page ? <ChatLoading load={tr.load} />
            : <Chat scope={scope} page={tr.page} queued={tr.page.queued || []} older={tr.older} onOlder={tr.loadOlder}
                    onRetryOlder={tr.retryOlder} onStep={onStep} sent={sends} />)
        : <Terminal pane={pane.data?.pane ?? null} />}

      {/* The composer is the agent's; a Terminal or Editor tab has the keyboard to itself. */}
      {!tool && <form class={`composer${drag ? ' drag' : ''}`} onSubmit={(e) => { e.preventDefault(); sendDraft(); }}
            onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); } }}>
        {lost ? (
          <p class="att-lost" role="status">{t('sess.filesLost', { n: lost })}{' '}
            <button type="button" class="link-btn" onClick={() => { seenLost(dkey); setLost(0); }}>{t('common.ok')}</button></p>
        ) : null}
        {files.length ? (
          <div class="att-list">
            {files.map(f => (
              <span key={f.id} class={`att att-${f.state}`} title={f.why || f.path || f.name}>
                {f.preview ? <img src={f.preview} alt="" /> : <i class="att-ico"><Icon name="file" size={24} /></i>}
                <span class="att-name">{f.name}</span>
                <small>{f.state === 'up' ? t('sess.uploading') : f.state === 'err' ? t('sess.notUploaded') : `${Math.max(1, Math.round(f.size / 1024))} KB`}</small>
                <button type="button" class="att-x" aria-label={t('sess.remove', { name: f.name })} onClick={() => dropFile(f.id)}><Icon name="close" /></button>
              </span>
            ))}
          </div>
        ) : null}
        <div class="composer-row">
          <button type="button" class="cbtn attach-btn" onClick={() => picker.current?.click()} title={t('sess.attach')} aria-label={t('sess.attach')}><Icon name="clip" size={24} /></button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
          <div class={`composer-input${(prompt && !held) || st === 'limit' ? ' has-request' : ''}`}>
          {/* The hint names dragging a file and ⏎ only where a mouse is, which is where ⏎ sends
              (keys.js): on a phone it wrapped to three lines in the two-line box, the last one cut. */}
          <textarea ref={composer} rows={embedded ? 1 : 2} value={draft} placeholder={drag ? t('sess.drop') : embedded || !finePointer() ? t('sess.writeToShort', { name }) : t('sess.writeTo', { name })}
                    onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)}
                    onInput={(e) => { setDraft(e.currentTarget.value); typing.current = !!e.currentTarget.value;
                      if (document.activeElement === composer.current) composerKey(); }}
                    onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } }}
                    onKeyDown={(e) => {
                      composerKey();
                      // Esc leaves the box. ⏎ sends with a keyboard and is a new line on a phone's
                      // on-screen one, never mid-composition (keys.js sendsOnEnter).
                      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
                      else if (held && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); showRequest(); }
                      else if (sendsOnEnter(e)) { e.preventDefault(); sendDraft(); }
                    }} />
          {(prompt && !held) || st === 'limit' ? <button type="button" class="btn request-return" onClick={prompt ? showRequest : quota.show}>
            <Icon name={prompt ? 'question' : 'hourglass'} size={18} />
            {t(prompt ? (canAnswer ? 'sess.answerRequest' : 'sess.viewRequest') : 'sess.viewLimit')}
          </button> : null}
          </div>
          <button type="button" class={`cbtn speak-btn${speakMode.on ? ' on' : ''}`} aria-pressed={speakMode.on}
                  aria-label={speakMode.on ? t('chat.speakOff') : t('chat.speak')} title={speakMode.on ? t('chat.speakOff') : t('chat.speak')}
                  onClick={speakMode.toggle}><Icon name="mic" size={24} /></button>
          {/* HELD, OR RIGHT-CLICKED, IT ASKS WHEN. A tap sends at once, into the running turn
              when there is one; the choice of waiting for that turn to end opens as a sheet over
              the screen (a modal on a desk), never as something inline that would move the
              composer under the thumb. A long press that opened it must not also send, and must
              not choose for the owner either: the sheet opens UNDER the finger, and the release's
              compatibility mousedown and click landed on its first option, "Send now" (measured
              at 390, touch: pointerup, touchend, then mousedown/mouseup/click on the option, all
              at the same millisecond). A cancelled touchend sends no compatibility events. */}
          <SendBtn busy={uploading} disabled={sendOff} title={t('sess.sendHold')} aria-haspopup="dialog"
                   onPointerDown={(e) => { clearTimeout(hold.current.timer); hold.current.fired = false; if (e.button > 0 || sendOff) return;
                     hold.current.timer = setTimeout(() => { hold.current.fired = true; openSendMenu(); }, 500); }}
                   onPointerUp={() => clearTimeout(hold.current.timer)} onPointerLeave={() => clearTimeout(hold.current.timer)}
                   onPointerCancel={() => clearTimeout(hold.current.timer)}
                   onTouchEnd={(e) => { if (hold.current.fired) e.preventDefault(); }}
                   onContextMenu={(e) => { e.preventDefault(); clearTimeout(hold.current.timer); if (!sendOff) { hold.current.fired = true; openSendMenu(); } }}
                   onClick={(e) => { if (hold.current.fired) { e.preventDefault(); hold.current.fired = false; } }} />
        </div>
        <p class="speak-state muted small" role="status" aria-live="polite">{speakMode.on ? t(STATE_KEY[speakMode.phase] || 'chat.speakListening') : ''}</p>
      </form>}

      {confirm ? <Confirm {...confirm} onClose={() => setConfirm(null)} /> : null}
      {sendMenu ? <Modal sheet title={t('sess.sendMenu', { name })} onClose={() => setSendMenu(false)}>
        <div class="modal-body ask-opts send-opts">
          <button type="button" class="opt" onClick={() => { if (sendMenuFresh()) return; setSendMenu(false); sendDraft(false); }}>
            <span><b>{t('sess.sendNow')}</b><small>{t('sess.sendNowHint')}</small></span></button>
          <button type="button" class="opt" onClick={() => { if (sendMenuFresh()) return; setSendMenu(false); sendDraft(true); }}>
            <span><b>{t('sess.sendAfter')}</b><small>{t('sess.sendAfterHint')}</small></span></button>
        </div>
      </Modal> : null}
      {detailsOpen ? <DetailsModal project={project} name={name} status={st} onClose={() => setDetailsOpen(false)} /> : null}
      {wk.sheet}
      {schedOpen ? <ScheduleModal name={name} onClose={() => setSchedOpen(false)}
                                  onSave={async (at, msg) => { const r = await act('gfw_schedule', { at, msg }); if (r) toast(r.text, 'good'); }} /> : null}
      {labelEdit != null ? (
        <Modal title={t('sess.labelTitle')} onClose={() => setLabelEdit(null)}>
          <form class="stack modal-body" onSubmit={async (e) => { e.preventDefault(); const r = await act('gfw_label', { text: labelEdit }); if (r) setLabelEdit(null); }}>
            <p class="muted">{t('sess.labelWhy')}</p>
            <label class="field"><span>{t('sess.labelField')}</span><input maxLength={40} value={labelEdit} onInput={(e) => setLabelEdit(e.currentTarget.value)} autoFocus /></label>
            <footer><Btn onClick={() => setLabelEdit(null)}>{t('common.cancel')}</Btn><Btn kind="primary" type="submit">{t('common.save')}</Btn></footer>
          </form>
        </Modal>
      ) : null}
      {rename != null ? (
        <Modal title={t('sess.renameTitle')} onClose={() => setRename(null)}>
          <form class="stack modal-body" onSubmit={async (e) => {
            e.preventDefault();
            const r = await act('fleet_rename', { new_name: rename.trim() }, { confirm: true });
            if (r) { setRename(null); fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(rename.trim())}`, { replace: true }); }
          }}>
            <label class="field"><span>{t('sess.newName')}</span><input value={rename} onInput={(e) => setRename(e.currentTarget.value)} autoFocus /></label>
            <footer><Btn onClick={() => setRename(null)}>{t('common.cancel')}</Btn><Btn kind="primary" type="submit" disabled={!rename.trim() || rename.trim() === name}>{t('sess.rename')}</Btn></footer>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
