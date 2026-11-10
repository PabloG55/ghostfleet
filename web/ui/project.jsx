import { useState, useMemo } from 'preact/hooks';
import { STATUS, StatusMark, statusOf, StatusPill, Btn, usePoll, ago, toast, Modal, Confirm } from './ui.jsx';
import { SessionView } from './session.jsx';
import { t, locale, worded } from './i18n.js';
import { Icon } from './icon.jsx';
import { useFleet, useSlot } from './adapter.jsx';
import { useKeys, moveFocus, dirOf, typeIntoComposer, focusComposer, projectTo } from './keyboard.jsx';
import { cycleName } from './keys.js';
import { ProjectTabs, ToolPanel } from './terminal.jsx';

// Grouped by what each one asks of a person, in the order it should be looked at.
const GROUPS = Object.values(worded({
  need: { id: 'need', has: (s) => s === 'need-you' },
  work: { id: 'work', has: (s) => s === 'working' || s === 'starting' },
  ready: { id: 'ready', has: (s) => s === 'ready' || s === 'interrupted' || s === 'limit' },
  rest: { id: 'rest', has: () => true },
}, 'group', ['title', 'hint']));

// `cardFoot(card)` is an app's slot (adapter.jsx): what a card says at its foot — in the team
// app, whose it is and who else has it open. A card with no foot has no foot row.
export function Card({ c, active, compact, onOpen }) {
  const st = statusOf(c);
  const foot = useSlot('cardFoot')(c);
  return (
    <article class={`card s-${(STATUS[st] || STATUS.unknown).color}${active ? ' active' : ''}${compact ? ' compact' : ''}`}
             tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div class="card-top">
        <StatusPill status={st} small />
        <span class="age">{c.age != null ? ago(c.age) : ''}</span>
      </div>
      <h3>{c.name}{c.lead ? <span class="tag">{t('common.lead')}</span> : null}</h3>
      {c.label ? <span class="card-label"><Icon name="tag" /> {c.label}</span> : null}
      <div class="card-meta">
        <span class="branch" title={t('project.branch')}><Icon name="branch" /> {c.branch || '—'}</span>
        {c.pr ? <span class="tag pr">PR {c.pr}</span> : null}
        {c.queued ? <span class="tag">{t('project.queued', { n: c.queued })}</span> : null}
        {c.sched ? <span class="tag sched" title={c.sched.msg || ''}><Icon name="clock" /> {new Date(c.sched.at * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span> : null}
      </div>
      {!compact && c.msg ? <p class="card-msg">{c.msg}</p> : null}
      {foot ? <div class="card-foot">{foot}</div> : null}
    </article>
  );
}

// Slots (adapter.jsx): `filterChips({ cards, filter, setFilter })` draws a row of filters over
// the groups and `filterCards(cards, filter)` applies the one picked — the team app's "mine",
// "of a teammate", "nobody's". The filter is a plain value this view keeps ('all' to start),
// so an app with no filters shows every card.
const allCards = (cards) => cards;
export function ProjectView({ project, session, tool = null }) {
  const fleet = useFleet();
  const filterCards = useSlot('filterCards', allCards), filterChips = useSlot('filterChips');
  const { data: g, error, reload } = usePoll(() => fleet.grid(project), 3000, [project]);
  const [filter, setFilter] = useState('all');
  const [spawn, setSpawn] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const cards = useMemo(() => filterCards(g?.cards || [], filter), [g, filter]);
  const open = (name) => fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`);
  const current = session && g ? g.cards.find(c => c.name === session) : null;

  const removeWorktree = (w) => setConfirm({
    title: t('project.rmTitle'), action: t('project.rmAction'), danger: true,
    body: <p>{t('project.rmBody.a')}<code>{w.path}</code>{t('project.rmBody.b')}<code>{w.branch}</code>{t('project.rmBody.c')}</p>,
    onYes: async () => {
      try { const r = await fleet.act('fleet_worktree_remove', { project, path: w.path }, { confirm: true }); toast(r.text || t('project.rmDone'), 'good'); }
      catch (e) { toast(e.message, 'bad'); }
      reload();
    },
  });

  const lead = (g?.cards || []).find(c => c.lead);
  const leadUp = lead && !lead.lost && !lead.asleep && statusOf(lead) !== 'parked';

  // The desk's keys, the grid's or an attached session's (keyboard.jsx; README "The keys").
  // Digits count the cards in the fleet's own order, the desk's numbering, not the groups'.
  const hasSelection = () => { try { return String(getSelection() || '') !== ''; } catch { return false; } };
  // ` from a session is tmux's detach: a worker goes back to its grid, the master to Projects.
  const sessionBack = () => fleet.go(current?.lead ? '/' : projectTo(project));
  const cycle = (d) => {
    const cs = g?.cards || [];
    const names = [...cs.filter(c => c.lead), ...cs.filter(c => !c.lead)].map(c => c.name);
    const next = cycleName(names, session, d);
    if (next && next !== session) open(next);
  };
  useKeys((key, e, layer) => {
    const { k, lk, ctrl } = key;
    const cs = g?.cards || [];
    if (session) {
      // Ctrl-a, then: g / d back · s the grid · p Projects · f the jump chord · ← / → cycle.
      if (layer.prefix) {
        layer.prefix = false;
        if (ctrl) return lk === 'a';           // Ctrl-a Ctrl-a: a literal Ctrl-a, and no terminal to send it to
        if (lk === 'g' || lk === 'd') sessionBack();
        else if (lk === 's') fleet.go(projectTo(project));
        else if (lk === 'p') fleet.go('/');
        else if (lk === 'f') layer.startJump();
        else if (k === 'ArrowRight') cycle(1);
        else if (k === 'ArrowLeft') cycle(-1);
        return true;
      }
      if (ctrl) {
        if (lk === 'a') { layer.prefix = true; return true; }
        if (lk === 's') { fleet.go(projectTo(project)); return true; }
        return false;                          // Ctrl-f and Ctrl-p are every screen's
      }
      if (k === '`') { sessionBack(); return true; }
      if (key.shift && (k === 'ArrowRight' || k === 'ArrowLeft')) { cycle(k === 'ArrowRight' ? 1 : -1); return true; }
      // Everything else at the desk goes to the agent: here, typed into the composer.
      if (k.length === 1 && !key.alt) return typeIntoComposer(k);
      if (k === 'Enter') return focusComposer();
      return false;
    }
    if (ctrl) return lk === 'c' && !hasSelection() ? layer.toLead(project, cs) : false;
    const d = dirOf(key);
    if (d) { moveFocus('.main .cards .card', d); return true; }
    if (key.alt) return false;
    if (k === 'n' || k === 'N') { setSpawn({}); return true; }
    if (k === 'q' || k === '`') return layer.toLead(project, cs);
    if (/^[1-9]$/.test(k)) { const c = cs[Number(k) - 1]; if (c) open(c.name); return true; }
    return false;
  });
  const [waking, setWaking] = useState(false);
  const wake = async () => {
    setWaking(true);
    try { const r = await fleet.lead(project); toast(r.started ? t('project.leadReady') : t('project.leadWasOpen'), 'good'); reload(); }
    catch (e) { toast(t('project.leadFailed', { why: e.message }), 'bad'); }
    finally { setWaking(false); }
  };
  const header = (
    <header class="page-head">
      <div>
        <h1 class="name">{project}</h1>
        <p class="muted">{g ? `${t('project.sessions', { n: g.cards.length })} · ${t('project.freeWts', { n: g.free_worktrees?.length || 0 })}` : t('common.loading')}</p>
      </div>
      <div class="row wrap">
        {g && !leadUp ? (
          <Btn kind="ghost" disabled={waking} onClick={wake} title={t('project.leadIs')}>
            {waking ? t('status.starting') + '…' : !lead ? <><Icon name="play" /> {t('project.leadStart')}</> : lead.lost ? <><Icon name="refresh" /> {t('project.leadReopen')}</> : lead.asleep ? <><Icon name="sun" /> {t('project.leadWake')}</> : <><Icon name="play" /> {t('project.leadResume')}</>}
          </Btn>
        ) : null}
        <Btn kind="primary" icon="plus" onClick={() => setSpawn({})}>{t('project.newSession')}</Btn>
      </div>
    </header>
  );
  const filters = filterChips({ cards: g?.cards || [], filter, setFilter });
  const modals = (
    <>
      {spawn ? <NewSession project={project} free={g?.free_worktrees || []} preset={spawn}
                           onClose={() => setSpawn(null)} onDone={(name) => { setSpawn(null); reload(); open(name); }} /> : null}
      {confirm ? <Confirm {...confirm} onClose={() => setConfirm(null)} /> : null}
    </>
  );

  if (error && !g) return <div class="page">{header}<p class="err">{t('project.readFailed', { project, why: error.message })}</p></div>;

  if (session) {
    return (
      <div class="split">
        <aside class="split-list">
          <div class="split-head">
            <button class="link" onClick={() => fleet.go(`/p/${encodeURIComponent(project)}`)}>← {project}</button>
            <Btn kind="ghost sm" icon="plus" onClick={() => setSpawn({})}>{t('project.new')}</Btn>
          </div>
          {(g?.cards || []).map(c => <Card key={c.name} c={c} compact active={c.name === session} onOpen={() => open(c.name)} />)}
        </aside>
        <SessionView key={`${project}/${session}`} project={project} name={session} card={current} tool={tool}
                     onChanged={reload} onGone={() => fleet.go(`/p/${encodeURIComponent(project)}`)} />
        {modals}
      </div>
    );
  }

  // A project's Terminal or Editor tab (terminal.jsx), in place of its sessions.
  if (tool) return <div class="page page-tool">{header}<ProjectTabs project={project} tool={tool} /><ToolPanel key={tool} project={project} kind={tool} />{modals}</div>;

  return (
    <div class="page">
      {header}
      <ProjectTabs project={project} tool={null} />
      {filters}
      {g && !g.cards.length ? (
        <div class="empty">
          <p><b>{t('project.empty')}</b></p>
          <p class="muted">{t('project.emptyWhy')}</p>
          <Btn kind="primary" icon="plus" onClick={() => setSpawn({})}>{t('project.openFirst')}</Btn>
        </div>
      ) : null}
      {GROUPS.map((gr, i) => {
        const taken = new Set(GROUPS.slice(0, i).flatMap(x => cards.filter(c => x.has(statusOf(c))).map(c => c.name)));
        const list = cards.filter(c => !taken.has(c.name) && gr.has(statusOf(c)));
        if (!list.length) return null;
        return (
          <section key={gr.id} class={`group g-${gr.id}`}>
            <h2>{gr.title} <span class="count">{list.length}</span><small>{gr.hint}</small></h2>
            <div class="cards">{list.map(c => <Card key={c.name} c={c} onOpen={() => open(c.name)} />)}</div>
          </section>
        );
      })}
      {g && (g.cards.length || g.free_worktrees?.length) ? (
        <section class="group">
          <h2>{t('project.tree')} <small>{t('project.treeHint')}</small></h2>
          <Tree g={g} open={open} onReuse={(w) => setSpawn({ reuse: w.path })} onRemove={removeWorktree} />
        </section>
      ) : null}
      {modals}
    </div>
  );
}

// Who hangs from whom: the lead, the workers it (or a person) opened, the sub-workers a
// worker opened in turn (card.parent), and the folders nobody is using. `treeOwner(card)` is an
// app's slot for the end of each row: whose session it is.
function Tree({ g, open, onReuse, onRemove }) {
  const treeOwner = useSlot('treeOwner');
  const cards = g.cards || [];
  const lead = cards.find(c => c.lead);
  const kids = (name) => cards.filter(c => !c.lead && (c.parent || null) === name);
  const top = cards.filter(c => !c.lead && (!c.parent || !cards.some(x => x.name === c.parent)));
  const Row = ({ c, depth }) => {
    const st = statusOf(c), meta = STATUS[st] || STATUS.unknown;
    return (
      <>
        <button class={`tree-row c-${meta.color}`} style={{ '--d': depth }} onClick={() => open(c.name)}>
          <span class="tree-branch">{depth ? '└─' : ''}</span>
          <b class="tree-glyph"><StatusMark status={st} /></b>
          <span class="tree-name">{c.lead ? t('common.lead') : c.name}{c.label ? <em> · {c.label}</em> : null}</span>
          <span class="tree-meta"><Icon name="folder" /> {c.folder || '—'} · <Icon name="branch" /> {c.branch || '—'}</span>
          <span class="tree-st">{meta.label}</span>
          {treeOwner(c)}
        </button>
        {kids(c.name).map(k => <Row key={k.name} c={k} depth={depth + 1} />)}
      </>
    );
  };
  return (
    <div class="tree">
      {lead ? <Row c={lead} depth={0} /> : <div class="tree-row static"><span class="muted">{t('project.noLead')}</span></div>}
      {top.map(c => <Row key={c.name} c={c} depth={1} />)}
      {(g.free_worktrees || []).map(w => (
        <div class="tree-row free-row" key={w.path} style={{ '--d': 1 }}>
          <span class="tree-branch">└─</span>
          <b class="tree-glyph">○</b>
          <span class="tree-name">{w.path.split('/').pop()} <em class="muted">{t('project.free')}</em></span>
          <span class="tree-meta"><Icon name="branch" /> {w.branch} · {w.path}</span>
          <span class="row">
            <Btn kind="ghost sm" onClick={() => onReuse(w)}>{t('project.openHere')}</Btn>
            <Btn kind="ghost sm danger" onClick={() => onRemove(w)}>{t('common.delete')}</Btn>
          </span>
        </div>
      ))}
    </div>
  );
}

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// `spawnOwner({ value, onChange })` is an app's slot: who the new session belongs to. `value`
// starts undefined, which an adapter's act() reads as "the person asking", as the team server does.
function NewSession({ project, free, preset, onClose, onDone }) {
  const fleet = useFleet();
  const spawnOwner = useSlot('spawnOwner');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [owner, setOwner] = useState(undefined);
  const [where, setWhere] = useState(preset.reuse || 'new');
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = slugify(name);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    const args = { project, name: n, prompt: prompt.trim() || undefined, model: model || undefined,
                   branch: branch.trim() || undefined, from: from.trim() || undefined };
    if (where === 'new') { if (free.length) args.force_new = true; } else args.reuse = where;
    try { const r = await fleet.act('fleet_spawn', args, { owner }); toast(r.text?.split('\n')[0] || t('project.created'), 'good'); onDone(n); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('project.newSession')} onClose={onClose} wide>
      <form onSubmit={submit} class="stack modal-body">
        <p class="muted">{t('project.newWhy')}</p>
        <label class="field"><span>{t('auth.name')}</span>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('project.namePh')} autoFocus />
          {name && n !== name ? <small class="muted">{t('project.willBe')} <code>{n}</code></small> : null}</label>
        <label class="field"><span>{t('project.what')}</span>
          <textarea rows={5} value={prompt} onInput={(e) => setPrompt(e.currentTarget.value)}
                    placeholder={t('project.whatPh')} /></label>
        <div class="grid2">
          {spawnOwner({ value: owner, onChange: setOwner })}
          <label class="field"><span>{t('project.where')}</span>
            <select value={where} onChange={(e) => setWhere(e.currentTarget.value)}>
              <option value="new">{t('project.newWt')}</option>
              {free.map(w => <option key={w.path} value={w.path}>{t('project.reuse', { name: w.path.split('/').pop(), branch: w.branch })}</option>)}
            </select></label>
        </div>
        <details class="advanced">
          <summary>{t('project.advanced')}</summary>
          <div class="grid3">
            <label class="field"><span>{t('project.branch')}</span><input value={branch} onInput={(e) => setBranch(e.currentTarget.value)} placeholder={n || t('project.sameAsName')} /></label>
            <label class="field"><span>{t('project.from')}</span><input value={from} onInput={(e) => setFrom(e.currentTarget.value)} placeholder={t('project.fromPh')} /></label>
            <label class="field"><span>{t('project.model')}</span>
              <select value={model} onChange={(e) => setModel(e.currentTarget.value)}>
                <option value="">{t('project.accountModel')}</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
              </select></label>
          </div>
        </details>
        {err ? <p class="err">{err}</p> : null}
        <footer>
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn kind="primary" type="submit" disabled={!n || busy}>{busy ? t('common.creating') : t('project.create')}</Btn>
        </footer>
      </form>
    </Modal>
  );
}
