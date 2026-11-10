// The team app's own pieces inside the shared screens (web/ui/adapter.jsx, "slots"): who owns a
// session, who else has it open, who wrote a prompt, and the filters and pickers that follow from
// there being more than one person. Each is a plain function of the screen's data — no hooks —
// closed over the signed-in context, so the shared screens draw them without knowing what a user is.
import { api } from './api.js';
import { toast } from '../../../../web/ui/ui.jsx';
import { Select } from '../../../../web/ui/select.jsx';
import { Btn } from '../../../../web/ui/ui.jsx';
import { useState } from 'preact/hooks';
import { Avatar } from './avatar.jsx';
import { t } from './i18n.js';
import { PASSWORD_MIN } from '../../shared/password.js';

// Settings' people (web/ui/views.jsx `settingsPeople`): the team, and this account's password.
// A component of its own because the password form keeps what is typed.
function People({ ctx }) {
  const [old, setOld] = useState(''); const [nw, setNw] = useState('');
  return (
    <>
      <section class="panel">
        <h2>{t('settings.team')}</h2>
        <div class="rows">{ctx.users.map(u => <div class="row-item static" key={u.id}><Avatar user={u} /> <b class="grow">{u.name}</b>{u.id === ctx.me.id ? <span class="muted">{t('settings.you')}</span> : null}</div>)}</div>
        {ctx.me.role === 'admin'
          ? <p class="muted">{t('settings.adminWhere')} <a href="#/admin/users">{t('nav.admin')} → {t('admin.users')}</a>.</p>
          : <p class="muted">{t('settings.askAdmin')}</p>}
      </section>
      <section class="panel">
        <h2>{t('settings.password')}</h2>
        <form class="row wrap" onSubmit={async (e) => {
          e.preventDefault();
          try { await api.password(old, nw); setOld(''); setNw(''); toast(t('settings.pwChanged'), 'good'); } catch (x) { toast(x.message, 'bad'); }
        }}>
          <input type="password" placeholder={t('settings.pwOld')} value={old} onInput={(e) => setOld(e.currentTarget.value)} />
          <input type="password" placeholder={t('settings.pwNew', { n: PASSWORD_MIN })} value={nw} onInput={(e) => setNw(e.currentTarget.value)} />
          <Btn kind="ghost" type="submit" disabled={!old || nw.length < PASSWORD_MIN}>{t('settings.change')}</Btn>
        </form>
      </section>
    </>
  );
}

export function teamSlots(ctx) {
  const user = (id) => (id ? ctx.usersById[id] : null);
  const others = (here) => (here || []).filter(h => h.user !== ctx.me.id);
  return {
    ownerName: (s) => user(s.owner)?.name || null,
    // On a ship, and in the ship's card beside the name (web/ui/shiptip.jsx): the card says who it
    // is, so the badge draws no native tooltip of its own over it.
    ownerBadge: (s, size) => { const u = user(s.owner); return u ? <Avatar user={u} size={size} title={null} /> : null; },

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
      <Select label={t('project.owner')} value={value ?? ctx.me.id} onChange={onChange}
              options={ctx.users.map(u => ({ value: u.id, label: u.id === ctx.me.id ? `${u.name} (${t('project.me')})` : u.name }))} />
    ),

    ownerPicker: ({ project, name, owner, onChanged }) => (
      <Select class="owner-pick" aria-label={t('sess.ownerOf')} title={t('sess.ownerOf')} value={owner || ''}
              placeholder={t('ui.noOwner')}
              options={[{ value: '', label: t('ui.noOwner'), icon: <Avatar user={null} size={22} /> },
                ...ctx.users.map(u => ({ value: u.id, label: u.name, icon: <Avatar user={u} size={22} /> }))]}
              onChange={async (v) => {
                try { await api.assign(project, name, v || null); onChanged(); }
                catch (x) { toast(x.message, 'bad'); }
              }} />
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

    // Activity (web/ui/views.jsx): a chip per teammate to narrow the log, and who did each row.
    activityPeople: ({ who, setWho }) => (
      <div class="chips">
        <button class={who === 'all' ? 'on' : ''} onClick={() => setWho('all')}>{t('activity.all')}</button>
        {ctx.users.map(u => <button key={u.id} class={who === u.id ? 'on' : ''} onClick={() => setWho(u.id)}>{u.name}</button>)}
      </div>
    ),
    activityFace: (r) => <Avatar user={user(r.user)} size={20} />,
    activityWho: (r) => <b>{user(r.user)?.name || r.user}</b>,
    settingsPeople: () => <People ctx={ctx} />,
  };
}
