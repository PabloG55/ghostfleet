import { useState, useMemo } from 'preact/hooks';
import { api } from './api.js';
import { STATUS, StatusMark, statusOf, StatusPill, Avatar, Btn, usePoll, ago, toast, Modal, Confirm } from './ui.jsx';
import { SessionView } from './session.jsx';
import { t, locale } from './i18n.js';
import { worded } from '../../shared/i18n/index.js';
import { Icon } from './icon.jsx';

// Grouped by what each one asks of a person, in the order it should be looked at.
const GROUPS = Object.values(worded({
  need: { id: 'need', has: (s) => s === 'need-you' },
  work: { id: 'work', has: (s) => s === 'working' || s === 'starting' },
  ready: { id: 'ready', has: (s) => s === 'ready' || s === 'interrupted' || s === 'limit' },
  rest: { id: 'rest', has: () => true },
}, 'group', ['title', 'hint']));

export function Card({ c, ctx, active, compact, onOpen }) {
  const st = statusOf(c);
  const owner = c.owner ? ctx.usersById[c.owner] : null;
  const others = (c.here || []).filter(h => h.user !== ctx.me.id);
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
      <div class="card-foot">
        <span class="owner"><Avatar user={owner} size={22} /> {owner ? owner.name : t('ui.noOwner')}</span>
        {others.length ? (
          <span class="here" title={t('project.alsoHere')}>
            {others.map(h => <Avatar key={h.user} user={ctx.usersById[h.user]} size={18} />)}
            {others.some(h => h.typing) ? ` ${t('project.typing')}` : ` ${t('project.watching')}`}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export function ProjectView({ ctx, project, session }) {
  const { data: g, error, reload } = usePoll(() => api.grid(project), 3000, [project]);
  const [filter, setFilter] = useState('all');
  const [spawn, setSpawn] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const cards = useMemo(() => (g?.cards || []).filter(c =>
    filter === 'all' ? true : filter === 'none' ? !c.owner : c.owner === filter), [g, filter]);
  const counts = useMemo(() => {
    const o = { all: g?.cards?.length || 0, none: 0 };
    for (const c of g?.cards || []) { if (!c.owner) o.none++; else o[c.owner] = (o[c.owner] || 0) + 1; }
    return o;
  }, [g]);
  const open = (name) => ctx.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`);
  const current = session && g ? g.cards.find(c => c.name === session) : null;

  const removeWorktree = (w) => setConfirm({
    title: t('project.rmTitle'), action: t('project.rmAction'), danger: true,
    body: <p>{t('project.rmBody.a')}<code>{w.path}</code>{t('project.rmBody.b')}<code>{w.branch}</code>{t('project.rmBody.c')}</p>,
    onYes: async () => {
      try { const r = await api.act('fleet_worktree_remove', { project, path: w.path }, { confirm: true }); toast(r.text || t('project.rmDone'), 'good'); }
      catch (e) { toast(e.message, 'bad'); }
      reload();
    },
  });

  const lead = (g?.cards || []).find(c => c.lead);
  const leadUp = lead && !lead.lost && !lead.asleep && statusOf(lead) !== 'parked';
  const [waking, setWaking] = useState(false);
  const wake = async () => {
    setWaking(true);
    try { const r = await api.lead(project); toast(r.started ? t('project.leadReady') : t('project.leadWasOpen'), 'good'); reload(); }
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
  const filters = (
    <div class="chips" role="tablist" aria-label={t('project.filter')}>
      <button class={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('project.all')} <b>{counts.all}</b></button>
      <button class={filter === ctx.me.id ? 'on' : ''} onClick={() => setFilter(ctx.me.id)}>{t('project.mine')} <b>{counts[ctx.me.id] || 0}</b></button>
      {ctx.users.filter(u => u.id !== ctx.me.id).map(u => (
        <button key={u.id} class={filter === u.id ? 'on' : ''} onClick={() => setFilter(u.id)}>{t('project.of', { name: u.name })} <b>{counts[u.id] || 0}</b></button>
      ))}
      <button class={filter === 'none' ? 'on' : ''} onClick={() => setFilter('none')}>{t('ui.noOwner')} <b>{counts.none}</b></button>
    </div>
  );
  const modals = (
    <>
      {spawn ? <NewSession ctx={ctx} project={project} free={g?.free_worktrees || []} preset={spawn}
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
            <button class="link" onClick={() => ctx.go(`/p/${encodeURIComponent(project)}`)}>← {project}</button>
            <Btn kind="ghost sm" icon="plus" onClick={() => setSpawn({})}>{t('project.new')}</Btn>
          </div>
          {(g?.cards || []).map(c => <Card key={c.name} c={c} ctx={ctx} compact active={c.name === session} onOpen={() => open(c.name)} />)}
        </aside>
        <SessionView key={`${project}/${session}`} ctx={ctx} project={project} name={session} card={current}
                     onChanged={reload} onGone={() => ctx.go(`/p/${encodeURIComponent(project)}`)} />
        {modals}
      </div>
    );
  }

  return (
    <div class="page">
      {header}
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
            <div class="cards">{list.map(c => <Card key={c.name} c={c} ctx={ctx} onOpen={() => open(c.name)} />)}</div>
          </section>
        );
      })}
      {g && (g.cards.length || g.free_worktrees?.length) ? (
        <section class="group">
          <h2>{t('project.tree')} <small>{t('project.treeHint')}</small></h2>
          <Tree ctx={ctx} g={g} open={open} onReuse={(w) => setSpawn({ reuse: w.path })} onRemove={removeWorktree} />
        </section>
      ) : null}
      {modals}
    </div>
  );
}

// Who hangs from whom: the lead, the workers it (or a person) opened, the sub-workers a
// worker opened in turn (card.parent), and the folders nobody is using.
function Tree({ ctx, g, open, onReuse, onRemove }) {
  const cards = g.cards || [];
  const lead = cards.find(c => c.lead);
  const kids = (name) => cards.filter(c => !c.lead && (c.parent || null) === name);
  const top = cards.filter(c => !c.lead && (!c.parent || !cards.some(x => x.name === c.parent)));
  const Row = ({ c, depth }) => {
    const st = statusOf(c), meta = STATUS[st] || STATUS.unknown;
    const owner = c.owner ? ctx.usersById[c.owner] : null;
    return (
      <>
        <button class={`tree-row c-${meta.color}`} style={{ '--d': depth }} onClick={() => open(c.name)}>
          <span class="tree-branch">{depth ? '└─' : ''}</span>
          <b class="tree-glyph"><StatusMark status={st} /></b>
          <span class="tree-name">{c.lead ? t('common.lead') : c.name}{c.label ? <em> · {c.label}</em> : null}</span>
          <span class="tree-meta"><Icon name="folder" /> {c.folder || '—'} · <Icon name="branch" /> {c.branch || '—'}</span>
          <span class="tree-st">{meta.label}</span>
          <Avatar user={owner} size={18} />
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

function NewSession({ ctx, project, free, preset, onClose, onDone }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [owner, setOwner] = useState(ctx.me.id);
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
    try { const r = await api.act('fleet_spawn', args, { owner }); toast(r.text?.split('\n')[0] || t('project.created'), 'good'); onDone(n); }
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
          <label class="field"><span>{t('project.owner')}</span>
            <select value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
              {ctx.users.map(u => <option key={u.id} value={u.id}>{u.id === ctx.me.id ? `${u.name} (${t('project.me')})` : u.name}</option>)}
            </select></label>
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
