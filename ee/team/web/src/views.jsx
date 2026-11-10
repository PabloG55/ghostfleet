import { useState } from 'preact/hooks';
import { api } from './api.js';
import { Btn, usePoll, clock, toast } from '../../../../web/ui/ui.jsx';
import { Avatar } from './avatar.jsx';
import { t, lang, setLang, LANGS, LANG_NAMES } from './i18n.js';
import { words } from '../../shared/i18n/index.js';
import { Icon } from '../../../../web/ui/icon.jsx';

// "Ana <verb> acme-api": the verb reads right before the subject in either language.
const VERBS = words(['fleet_send', 'attach', 'fleet_answer', 'fleet_interrupt', 'fleet_pause', 'fleet_resume', 'fleet_wake', 'fleet_reopen',
  'fleet_spawn', 'fleet_stop', 'fleet_rename', 'fleet_worktree_remove', 'fleet_unqueue', 'assign', 'login', 'setup', 'add_user', 'password',
  'auto_save', 'auto_delete', 'route', 'voice_install', 'voice_delete'], 'verb');
const RESULT = { ran: 'good', refused: 'bad', changed: 'warn' };

export function Activity({ ctx }) {
  const { data, error } = usePoll(() => api.activity(), 5000, []);
  const [who, setWho] = useState('all');
  const rows = (data?.rows || []).filter(r => who === 'all' || r.user === who);
  return (
    <div class="page">
      <header class="page-head"><div><h1>{t('activity.title')}</h1><p class="muted">{t('activity.sub')}</p></div></header>
      <div class="chips">
        <button class={who === 'all' ? 'on' : ''} onClick={() => setWho('all')}>{t('activity.all')}</button>
        {ctx.users.map(u => <button key={u.id} class={who === u.id ? 'on' : ''} onClick={() => setWho(u.id)}>{u.name}</button>)}
      </div>
      {error ? <p class="err">{error.message}</p> : null}
      <div class="log">
        {rows.map((r, i) => {
          const u = ctx.usersById[r.user];
          const [rl, rk] = RESULT[r.result] ? [t(`result.${r.result}`), RESULT[r.result]] : [r.result, ''];
          const target = r.subject && r.subject !== '-' ? r.subject : '';
          const detail = r.args?.prompt || r.args?.text || r.args?.new_name || (r.args?.owner !== undefined ? (ctx.usersById[r.args.owner]?.name || t('activity.nobody')) : '');
          return (
            <details class="log-row" key={i}>
              <summary>
                <span class="when">{clock(r.ts)}</span>
                <Avatar user={u} size={20} />
                <span class="grow"><b>{u?.name || r.user}</b> {VERBS[r.verb] || r.verb} {target ? <b>{target}</b> : null}
                  {r.project ? <span class="muted"> · {r.project}</span> : null}
                  {r.via ? <span class="tag"><Icon name="bolt" /> {r.via}</span> : null}</span>
                <span class={`badge ${rk}`}>{rl}</span>
              </summary>
              {detail ? <p class="log-detail">“{String(detail)}”</p> : null}
              {r.output ? <pre class="log-out">{r.output}</pre> : null}
            </details>
          );
        })}
        {data && !rows.length ? <p class="muted pad">{t('activity.empty')}</p> : null}
      </div>
    </div>
  );
}

export function Settings({ ctx }) {
  const [old, setOld] = useState(''); const [nw, setNw] = useState('');
  return (
    <div class="page narrow">
      <header class="page-head"><div><h1>{t('settings.title')}</h1></div></header>
      <section class="panel">
        <h2>{t('settings.language')}</h2>
        <label class="field"><span class="muted">{t('settings.languageHint')}</span>
          <select value={lang()} onChange={(e) => {
            const l = e.currentTarget.value;
            setLang(l);
            api.setLang(l).catch(x => toast(x.message, 'bad'));
          }}>
            {LANGS.map(l => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
          </select>
        </label>
      </section>
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
          <input type="password" placeholder={t('settings.pwNew')} value={nw} onInput={(e) => setNw(e.currentTarget.value)} />
          <Btn kind="ghost" type="submit" disabled={!old || nw.length < 6}>{t('settings.change')}</Btn>
        </form>
      </section>
      <section class="panel">
        <h2>{t('settings.connection')}</h2>
        <p>{ctx.mode === 'demo'
          ? t('settings.demo')
          : t('settings.real')}</p>
        {ctx.mode === 'demo' && ctx.me.role === 'admin' ? <Btn kind="ghost" onClick={async () => { await api.resetDemo(); toast(t('settings.demoReset'), 'good'); }}>{t('settings.resetDemo')}</Btn> : null}
      </section>
    </div>
  );
}
