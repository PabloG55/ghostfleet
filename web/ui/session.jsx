import { useState, useEffect, useRef } from 'preact/hooks';
import { Ship } from './fleet.jsx';
import { statusOf, StatusPill, Btn, usePoll, toast, Markdown, Confirm, Modal, sinceTs } from './ui.jsx';
import { render as renderAnsi } from '../ansi.js';   // the phone client's own, not a copy
import { useFleet, useSlot } from './adapter.jsx';
import { t, locale } from './i18n.js';
import { Icon } from './icon.jsx';
import { sendsOnEnter } from './keys.js';
import { ToolTabs, ToolPanel } from './terminal.jsx';

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

// `author(message)` is an app's slot: who wrote a prompt. Without it, every prompt is an instruction.
function Chat({ msgs, queued, older, onOlder }) {
  const author = useSlot('author');
  const ref = useRef(null);
  const stick = useRef(true);
  const last = msgs.length ? `${msgs.length}:${msgs[msgs.length - 1].ts}` : '';
  useEffect(() => { const n = ref.current; if (n && stick.current) n.scrollTop = n.scrollHeight; }, [last, queued.length]);
  return (
    <div class="chat" ref={ref} onScroll={(e) => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; }}>
      {older ? <button class="link center" onClick={onOlder}>{t('sess.older')}</button> : null}
      {!msgs.length ? <p class="muted center">{t('sess.noMsgs')}</p> : null}
      {msgs.map((m, i) => {
        if (m.role === 'tools') {
          const tools = m.tools || [];
          const names = [...new Set(tools.map(x => x.name))];
          return (
            <details key={`${m.ts}-${i}`} class="tools">
              <summary><Icon name="gear" /> {t('sess.actions', { n: tools.length })} · {names.slice(0, 4).join(', ')}{names.length > 4 ? '…' : ''}<span class="when">{sinceTs(m.ts)}</span></summary>
              <ul>{tools.map((x, j) => <li key={j}><b>{x.name}</b> <span>{x.detail}</span></li>)}</ul>
            </details>
          );
        }
        return (
          <div key={`${m.ts}-${i}`} class={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
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
export function SessionView({ project, name, card, onChanged, onGone, tool = null }) {
  const fleet = useFleet();
  const ownerPicker = useSlot('ownerPicker'), presence = useSlot('presence');
  const [tab, setTab] = useState('chat');
  // From a Terminal or Editor tab (a route of its own) the session's two tabs go back to its page.
  const pick = (x) => { setTab(x); if (tool) fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`); };
  const [extra, setExtra] = useState([]);      // older pages, loaded on demand
  const [before, setBefore] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [rename, setRename] = useState(null);
  const [menu, setMenu] = useState(false);
  const [labelEdit, setLabelEdit] = useState(null);
  const [schedOpen, setSchedOpen] = useState(false);
  const [files, setFiles] = useState([]);       // {id, name, size, state: 'up'|'ok'|'err', path, preview, why}
  const [drag, setDrag] = useState(false);
  const picker = useRef(null);
  const typing = useRef(false);
  useEffect(() => { setFiles([]); }, [project, name]);

  const sess = usePoll(() => fleet.session(project, name), 3000, [project, name]);
  const pane = usePoll(() => fleet.pane(project, name), 2500, [project, name]);
  useEffect(() => { setBefore(sess.data?.next_before ?? null); }, [sess.data?.next_before]);
  useEffect(() => {
    if (!fleet.presence) return undefined;
    const iv = setInterval(() => { if (!document.hidden) fleet.presence(project, name, typing.current).catch(() => {}); }, 5000);
    return () => clearInterval(iv);
  }, [project, name]);

  const st = card ? statusOf(card) : (sess.data?.status || 'unknown');
  const owner = card?.owner || sess.data?.owner || null;
  const prompt = pane.data?.prompt || null;

  const act = async (tool, args = {}, opts = {}) => {
    setBusy(true);
    try {
      const r = await fleet.act(tool, { project, session: name, ...args }, opts);
      if (r.queued === 'question') toast(t('sess.queuedQ'), '');
      else if (r.queued) toast(t('sess.queuedTurn'), '');
      onChanged(); sess.reload(); pane.reload();
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
    if (r) { setDraft(''); typing.current = false; for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview); setFiles([]); }
  };
  const loadOlder = async () => {
    try {
      const r = await fleet.session(project, name, before);
      setExtra(x => [...(r.messages || []), ...x]); setBefore(r.next_before ?? null);
    } catch (e) { toast(e.message, 'bad'); }
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

  const msgs = [...extra, ...(sess.data?.messages || [])];
  const parked = st === 'parked';
  return (
    <section class="session">
      <header class="sess-head">
        <div class="sess-title">
          <button class="link back" onClick={onGone} aria-label={t('common.back')}>←</button>
          <Ship state={st} size={32} />
          <h1>{name}</h1>
          <StatusPill status={st} />
          {card?.branch ? <span class="branch"><Icon name="branch" /> {card.branch}</span> : null}
          {card?.pr ? <span class="tag pr">PR {card.pr}</span> : null}
          {card?.label ? <button class="chip-label" title={t('sess.changeLabel')} onClick={() => setLabelEdit(card.label)}><Icon name="tag" /> {card.label}</button> : null}
          {card?.sched ? (
            <span class="chip-sched" title={t('sess.schedMsg', { msg: card.sched.msg || '' })}><Icon name="clock" /> {hhmm(card.sched.at)} · “{String(card.sched.msg || '').slice(0, 30)}”
              <button aria-label={t('sess.unsched')} onClick={() => act('gfw_unschedule')}><Icon name="close" /></button></span>
          ) : null}
        </div>
        <div class="sess-tools">
          {ownerPicker({ project, name, owner, onChanged: () => { onChanged(); sess.reload(); } })}
          {st === 'working' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_interrupt')} title={t('sess.interruptHint')} icon="hand">{t('sess.interrupt')}</Btn> : null}
          {st === 'asleep' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_wake')} icon="sun">{t('sess.wake')}</Btn> : null}
          {st === 'lost' ? <Btn kind="ghost sm" disabled={busy} onClick={() => act('fleet_reopen')} icon="refresh">{t('sess.reopen')}</Btn> : null}
          {!card?.lead && !['asleep', 'lost'].includes(st)
            ? <Btn kind="ghost sm" disabled={busy} onClick={() => act(parked ? 'fleet_resume' : 'fleet_pause')} icon={parked ? 'play' : 'pause'}>{parked ? t('sess.resume') : t('sess.pause')}</Btn> : null}
          <div class="menu-wrap">
            <Btn kind="ghost sm" onClick={() => setMenu(m => !m)} aria-expanded={menu}>{t('sess.more')} ▾</Btn>
            {menu ? (
              <div class="menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); setLabelEdit(card?.label || ''); }}><Icon name="tag" /> {t('sess.setLabel')}</button>
                <button onClick={() => { setMenu(false); setSchedOpen(true); }}><Icon name="clock" /> {t('sess.schedule')}</button>
                <button onClick={() => { setMenu(false); setRename(name); }}>{t('sess.renameMenu')}</button>
                {!card?.lead ? <button onClick={() => { setMenu(false); stop(false); }}>{t('sess.stopMenu')}</button> : null}
                {!card?.lead ? <button class="danger" onClick={() => { setMenu(false); stop(true); }}>{t('sess.stopRmMenu')}</button> : null}
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
        <ToolTabs project={project} session={name} tool={tool} />
      </div>
      {tool ? <ToolPanel key={tool} project={project} session={name} kind={tool} /> : tab === 'chat'
        ? (sess.error && !sess.data
            ? <p class="err pad">{t('sess.readFailed', { why: sess.error.message })}</p>
            : <Chat msgs={msgs} queued={sess.data?.queued || []} older={before != null} onOlder={loadOlder} />)
        : <Terminal pane={pane.data?.pane ?? null} />}

      {/* The composer is the agent's; a Terminal or Editor tab has the keyboard to itself. */}
      {!tool && <form class={`composer${drag ? ' drag' : ''}`} onSubmit={(e) => { e.preventDefault(); sendDraft(); }}
            onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); } }}>
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
            if (r) { setRename(null); fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(rename.trim())}`); }
          }}>
            <label class="field"><span>{t('sess.newName')}</span><input value={rename} onInput={(e) => setRename(e.currentTarget.value)} autoFocus /></label>
            <footer><Btn onClick={() => setRename(null)}>{t('common.cancel')}</Btn><Btn kind="primary" type="submit" disabled={!rename.trim() || rename.trim() === name}>{t('sess.rename')}</Btn></footer>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
