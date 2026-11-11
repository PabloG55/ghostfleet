import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { Ship } from './fleet.jsx';
import { statusOf, StatusPill, Btn, usePoll, toast, Markdown, Confirm, Modal, sinceTs } from './ui.jsx';
import { render as renderAnsi } from '../ansi.js';   // the phone client's own, not a copy
import { useFleet, useSlot } from './adapter.jsx';
import { t, locale } from './i18n.js';
import { Icon } from './icon.jsx';
import { sendsOnEnter } from './keys.js';
import { ToolTabs, ToolPanel } from './terminal.jsx';
import { useLayer } from './select.jsx';
import { BackLink } from './back.jsx';
import { useTranscript } from './transcript.js';
import { draftKey, draftText, draftFiles, lostFiles, keepDraft, seenLost, sentDraft } from './drafts.js';

// Claude's dialog speaks English; the buttons say what pressing them does.
function optionText(label) {
  const l = String(label || '');
  if (/^yes,? and don.?t ask again/i.test(l)) return { text: t('sess.opt.yesAlways'), sub: l, kind: 'yes' };
  if (/^yes,? allow all edits/i.test(l)) return { text: t('sess.opt.yesEdits'), sub: l, kind: 'yes' };
  if (/^yes/i.test(l)) return { text: t('sess.opt.yes'), sub: l, kind: 'yes' };
  if (/^no/i.test(l)) return { text: t('sess.opt.no'), sub: l, kind: 'no' };
  return { text: l, sub: '', kind: '' };
}

function PromptCard({ prompt, onAnswer, busy }) {
  const [typed, setTyped] = useState('');
  if (prompt.kind === 'permission') {
    return (
      <div class="ask permission">
        <div class="ask-head"><b>● {t('sess.asksPermission')}</b><span>{prompt.tool || t('sess.aTool')}</span></div>
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
      <div class="ask-head"><b>● {t('sess.asks')}</b>
        {tabs.length > 1 ? <span>{t('sess.qOf', { i: prompt.tab != null ? prompt.tab + 1 : '?', n: tabs.length })}</span> : null}
        {prompt.submit ? <span>{t('sess.review')}</span> : null}</div>
      <p class="ask-q">{prompt.question}</p>
      {prompt.typing ? (
        <form class="row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onAnswer(typed.trim(), false); }}>
          <input class="grow" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} placeholder={t('sess.yourAnswer')} autoFocus />
          <Btn kind="primary" type="submit" disabled={busy || !typed.trim()}>{t('common.send')}</Btn>
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

function Terminal({ pane }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const html = pane ? renderAnsi(pane).html : '';
  useEffect(() => { const n = ref.current; if (n && stick.current) n.scrollTop = n.scrollHeight; }, [html]);
  return (
    <div class="term" ref={ref} onScroll={(e) => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 40; }}>
      {pane == null ? <p class="muted">{t('sess.readingTerm')}</p> : <pre class="pane" dangerouslySetInnerHTML={{ __html: html }} />}
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
    <div class="chat" aria-busy="true">
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
function Chat({ page, queued, older, onOlder, onRetryOlder, onStep }) {
  const author = useSlot('author');
  const ref = useRef(null);
  const stick = useRef(true);
  const ours = useRef(-1);            // the scrollTop this chat last set itself (below)
  const anchor = useRef(null);
  const swipe = useRef(null);
  const msgs = page.messages || [];
  const rows = keyed(msgs);
  const last = rows.length ? rows[rows.length - 1][0] : '';
  const toEnd = (n) => { n.scrollTop = n.scrollHeight; ours.current = n.scrollTop; };
  useEffect(() => { const n = ref.current; if (n && stick.current) toEnd(n); }, [last, queued.length]);
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
    const ro = new ResizeObserver(() => { if (stick.current && !anchor.current) toEnd(box); });
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
           if (Math.abs(n.scrollTop - ours.current) > 1) { ours.current = -1; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; }
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

const hhmm = (at) => new Date(at * 1000).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

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
export function SessionView({ project, name, card, onChanged, onGone, onStep = null, tool: routeTool = null, embedded = false, quiet = false }) {
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

  // The transcript on its own poll (transcript.js), LIVE while an answer is owed: the session
  // working, or a message sent in the last two minutes.
  const sentAt = useRef(0);
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
  const owner = card?.owner || tr.page?.owner || null;
  const prompt = pane.data?.prompt || null;

  const act = async (tool, args = {}, opts = {}) => {
    setBusy(true);
    try {
      const r = await fleet.act(tool, { project, session: name, ...args }, opts);
      if (r.queued === 'question') toast(t('sess.queuedQ'), '');
      else if (r.queued) toast(t('sess.queuedTurn'), '');
      onChanged(); tr.reload(); pane.reload();
      return r;
    } catch (e) {
      if (e.body?.changed) { toast(t('sess.changed'), 'bad'); pane.reload(); }
      else toast(e.message, 'bad');
      return null;
    } finally { setBusy(false); }
  };
  const answer = (text, noEnter) => act('fleet_answer', { text, no_enter: noEnter, expect: prompt?.fingerprint });
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
  const sendDraft = async () => {
    const text = draft.trim();
    if ((!text && !ready.length) || uploading) return;
    // Words first: a message that opens with a path (`/home/…`) reads as a slash command.
    const list = ready.map(f => `- ${f.path}`).join('\n');
    const prompt = !ready.length ? text
      : `${text || t('sess.attaching', { n: ready.length })}\n\n${t('sess.attached', { n: ready.length })}:\n${list}`;
    const r = await act('fleet_send', { prompt });
    if (r) {
      sentAt.current = Date.now(); typing.current = false;
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
          {embedded ? null : <><Ship state={st} size={32} /><h1>{name}</h1></>}
          <StatusPill status={st} />
          {card?.branch ? <span class="branch"><Icon name="branch" /> {card.branch}</span> : null}
          {card?.pr ? <span class="tag pr">PR {card.pr}</span> : null}
          {card?.label ? (can('gfw_label')
            ? <button class="chip-label" title={t('sess.changeLabel')} onClick={() => setLabelEdit(card.label)}><Icon name="tag" /> {card.label}</button>
            : <span class="chip-label"><Icon name="tag" /> {card.label}</span>) : null}
          {card?.sched ? (
            <span class="chip-sched" title={t('sess.schedMsg', { msg: card.sched.msg || '' })}><Icon name="clock" /> {hhmm(card.sched.at)} · “{String(card.sched.msg || '').slice(0, 30)}”
              {can('gfw_unschedule') ? <button aria-label={t('sess.unsched')} onClick={() => act('gfw_unschedule')}><Icon name="close" /></button> : null}</span>
          ) : null}
        </div>
        <div class="sess-tools">
          {ownerPicker({ project, name, owner, onChanged: () => { onChanged(); tr.reload(); } })}
          {st === 'working' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_interrupt')} title={t('sess.interruptHint')} icon="hand">{t('sess.interrupt')}</Btn> : null}
          {st === 'asleep' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_wake')} icon="sun">{t('sess.wake')}</Btn> : null}
          {st === 'lost' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_reopen')} icon="refresh">{t('sess.reopen')}</Btn> : null}
          {card && !card.lead && !['asleep', 'lost'].includes(st)
            ? <Btn kind="ghost sm" disabled={busy} onClick={() => act(parked ? 'fleet_resume' : 'fleet_pause')} icon={parked ? 'play' : 'pause'}>{parked ? t('sess.resume') : t('sess.pause')}</Btn> : null}
          <div class="menu-wrap" ref={menuWrap}>
            <Btn kind="ghost sm" onClick={() => setMenu(m => !m)} aria-haspopup="true" aria-expanded={menu}>{t('sess.more')} ▾</Btn>
            {menu ? (
              <div class="menu">
                {can('gfw_label') ? <button onClick={() => { setMenu(false); setLabelEdit(card?.label || ''); }}><Icon name="tag" /> {t('sess.setLabel')}</button> : null}
                {can('gfw_schedule') ? <button onClick={() => { setMenu(false); setSchedOpen(true); }}><Icon name="clock" /> {t('sess.schedule')}</button> : null}
                {card && !card.lead ? <button onClick={() => { setMenu(false); setRename(name); }}>{t('sess.renameMenu')}</button> : null}
                {card && !card.lead ? <button onClick={() => { setMenu(false); stop(false); }}>{t('sess.stopMenu')}</button> : null}
                {card && !card.lead ? <button class="danger" onClick={() => { setMenu(false); stop(true); }}>{t('sess.stopRmMenu')}</button> : null}
              </div>
            ) : null}
          </div>
        </div>
        {presence(pane.data?.here || [])}
      </header>

      {st === 'limit' ? (
        <div class="ask limit">
          <div class="ask-head"><b><Icon name="hourglass" /> {t('status.limit.hint')}</b>{card?.limit_at ? <span>{t('sess.quotaBack', { when: hhmm(card.limit_at) })}</span> : null}</div>
          <p class="muted small">{t('sess.limitWhy')}</p>
          {card?.sched
            ? <p>{t('sess.alreadySched', { when: hhmm(card.sched.at) })}</p>
            : !can('gfw_schedule') ? null
            : <div class="row wrap">
                <Btn kind="primary" disabled={busy} onClick={() => act('gfw_schedule', { at: (card?.limit_at || Math.floor(Date.now() / 1000) + 5 * 3600) + 90, msg: t('sess.continueMsg') })}>
                  <Icon name="clock" /> {t('sess.resumeOnQuota')}</Btn>
                <Btn kind="ghost" onClick={() => setSchedOpen(true)}>{t('sess.otherTime')}</Btn>
              </div>}
        </div>
      ) : null}

      {prompt ? <PromptCard key={prompt.fingerprint} prompt={prompt} onAnswer={answer} busy={busy} /> : null}

      <div class="tabs" role="tablist">
        <button role="tab" class={!tool && tab === 'chat' ? 'on' : ''} onClick={() => pick('chat')}>{t('sess.chat')}</button>
        <button role="tab" class={!tool && tab === 'term' ? 'on' : ''} title={t('sess.screenHint')} onClick={() => pick('term')}>{t('sess.screen')}</button>
        <ToolTabs project={project} session={name} tool={tool} onPick={embedded ? setLocalTool : null} />
      </div>
      {tool ? <ToolPanel key={tool} project={project} session={name} kind={tool} quiet={quiet} onUnavailable={embedded ? () => setLocalTool(null) : null} /> : tab === 'chat'
        ? (!tr.page ? <ChatLoading load={tr.load} />
            : <Chat page={tr.page} queued={tr.page.queued || []} older={tr.older} onOlder={tr.loadOlder}
                    onRetryOlder={tr.retryOlder} onStep={onStep} />)
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
          <button type="button" class="attach-btn" onClick={() => picker.current?.click()} title={t('sess.attach')} aria-label={t('sess.attach')}><Icon name="clip" size={24} /></button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
          <textarea rows={2} value={draft} placeholder={drag ? t('sess.drop') : prompt ? t('sess.pendingAbove') : t('sess.writeTo', { name })}
                    onInput={(e) => { setDraft(e.currentTarget.value); typing.current = !!e.currentTarget.value; }}
                    onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } }}
                    onKeyDown={(e) => {
                      // Esc leaves the box. ⏎ sends with a keyboard and is a new line on a phone's
                      // on-screen one, never mid-composition (keys.js sendsOnEnter).
                      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
                      else if (sendsOnEnter(e)) { e.preventDefault(); sendDraft(); }
                    }} />
          <Btn kind="primary" type="submit" disabled={busy || uploading || (!draft.trim() && !ready.length)}>{uploading ? t('sess.uploadingBtn') : t('common.send')}</Btn>
        </div>
      </form>}

      {confirm ? <Confirm {...confirm} onClose={() => setConfirm(null)} /> : null}
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
