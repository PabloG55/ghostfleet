// The team app's own pieces inside the shared screens (web/ui/adapter.jsx, "slots"): who owns a
// session, who else has it open, who wrote a prompt, and the filters and pickers that follow from
// there being more than one person. Each is a plain function of the screen's data — no hooks —
// closed over the signed-in context, so the shared screens draw them without knowing what a user is.
import { api } from './api.js';
import { toast } from '../../../../web/ui/ui.jsx';
import { Avatar } from './avatar.jsx';
import { t } from './i18n.js';

export function teamSlots(ctx) {
  const user = (id) => (id ? ctx.usersById[id] : null);
  const others = (here) => (here || []).filter(h => h.user !== ctx.me.id);
  return {
    ownerName: (s) => user(s.owner)?.name || null,
    ownerBadge: (s, size) => { const u = user(s.owner); return u ? <Avatar user={u} size={size} /> : null; },

    cardFoot: (c) => {
      const owner = user(c.owner), o = others(c.here);
      return (
        <>
          <span class="owner"><Avatar user={owner} size={22} /> {owner ? owner.name : t('ui.noOwner')}</span>
          {o.length ? (
            <span class="here" title={t('project.alsoHere')}>
              {o.map(h => <Avatar key={h.user} user={ctx.usersById[h.user]} size={18} />)}
              {o.some(h => h.typing) ? ` ${t('project.typing')}` : ` ${t('project.watching')}`}
            </span>
          ) : null}
        </>
      );
    },
    treeOwner: (c) => <Avatar user={user(c.owner)} size={18} />,

    filterCards: (cards, f) => cards.filter(c => (f === 'all' ? true : f === 'none' ? !c.owner : c.owner === f)),
    filterChips: ({ cards, filter, setFilter }) => {
      const counts = { all: cards.length, none: 0 };
      for (const c of cards) { if (!c.owner) counts.none++; else counts[c.owner] = (counts[c.owner] || 0) + 1; }
      return (
        <div class="chips" role="tablist" aria-label={t('project.filter')}>
          <button class={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('project.all')} <b>{counts.all}</b></button>
          <button class={filter === ctx.me.id ? 'on' : ''} onClick={() => setFilter(ctx.me.id)}>{t('project.mine')} <b>{counts[ctx.me.id] || 0}</b></button>
          {ctx.users.filter(u => u.id !== ctx.me.id).map(u => (
            <button key={u.id} class={filter === u.id ? 'on' : ''} onClick={() => setFilter(u.id)}>{t('project.of', { name: u.name })} <b>{counts[u.id] || 0}</b></button>
          ))}
          <button class={filter === 'none' ? 'on' : ''} onClick={() => setFilter('none')}>{t('ui.noOwner')} <b>{counts.none}</b></button>
        </div>
      );
    },
    // A new session is the asker's unless they pick someone else; undefined means the asker.
    spawnOwner: ({ value, onChange }) => (
      <label class="field"><span>{t('project.owner')}</span>
        <select value={value ?? ctx.me.id} onChange={(e) => onChange(e.currentTarget.value)}>
          {ctx.users.map(u => <option key={u.id} value={u.id}>{u.id === ctx.me.id ? `${u.name} (${t('project.me')})` : u.name}</option>)}
        </select></label>
    ),

    ownerPicker: ({ project, name, owner, onChanged }) => (
      <label class="owner-pick" title={t('sess.ownerOf')}>
        <Avatar user={user(owner)} size={24} />
        <select value={owner || ''} onChange={async (e) => {
          try { await api.assign(project, name, e.currentTarget.value || null); onChanged(); }
          catch (x) { toast(x.message, 'bad'); }
        }}>
          <option value="">{t('ui.noOwner')}</option>
          {ctx.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
    ),
    presence: (here) => {
      const o = others(here);
      if (!o.length) return null;
      return (
        <p class="presence">
          {o.map(h => <Avatar key={h.user} user={ctx.usersById[h.user]} size={18} />)}
          {' '}{o.map(h => ctx.usersById[h.user]?.name || h.user).join(t('common.and'))}
          {o.some(h => h.typing) ? ` ${t('sess.othersTyping', { n: o.length })}` : ` ${t('sess.othersHere', { n: o.length })}`}
        </p>
      );
    },
    author: (m) => { const by = user(m.by); return by ? <><Avatar user={by} size={18} /> {by.name}</> : null; },
  };
}
