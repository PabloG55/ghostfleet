// Administration → Users: create an account, give it projects with a role in each, change
// its global role, disable it, reset its password. A new account and a reset both get a
// temporary password, shown once here and asked to be changed on first login.
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { Avatar, Btn, Modal, Confirm, toast } from '../ui.jsx';
import { t } from '../i18n.js';
import { words } from '../../../shared/i18n/index.js';

const ROLE = words(['admin', 'member'], 'role');
// '' is "no access"; its key is spelled `none`.
const pr = (k) => k || 'none';
const PROJECT_ROLE = {};
for (const k of ['', 'viewer', 'member', 'admin']) Object.defineProperty(PROJECT_ROLE, k, { get: () => t(`prole.${pr(k)}`), enumerable: true });
const HINT = {};
for (const k of ['', 'viewer', 'member', 'admin']) Object.defineProperty(HINT, k, { get: () => t(`prole.${pr(k)}.hint`), enumerable: true });

function Seg({ value, options, onPick, label }) {
  return (
    <div class="seg sm" role="radiogroup" aria-label={label}>
      {Object.entries(options).map(([k, v]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} class={value === k ? 'on' : ''} title={HINT[k]} onClick={() => onPick(k)}>{v}</button>
      ))}
    </div>
  );
}

// The projects of one account, with a role per project. An admin sees everything already.
function ProjectRoles({ role, projects, all, onChange }) {
  if (role === 'admin') return <p class="muted">{t('users.adminAll')}</p>;
  if (!all.length) return <p class="muted">{t('users.noProjects')}</p>;
  return (
    <div class="rows">
      {all.map(n => (
        <div class="row-item static admin-proj" key={n}>
          <b class="grow ellipsis">{n}</b>
          <Seg label={t('users.roleIn', { project: n })} value={projects[n] || ''} options={PROJECT_ROLE}
               onPick={(r) => { const next = { ...projects }; if (r) next[n] = r; else delete next[n]; onChange(next); }} />
        </div>
      ))}
    </div>
  );
}

function Password({ who, password, onClose }) {
  return (
    <Modal title={t('users.tempTitle', { who })} onClose={onClose}>
      <div class="modal-body stack">
        <p>{t('users.tempWhy')}</p>
        <code class="temp-pw" aria-label={t('auth.pw.temp')}>{password}</code>
      </div>
      <footer>
        <Btn onClick={async () => { try { await navigator.clipboard.writeText(password); toast(t('users.copied'), 'good'); } catch { toast(t('users.copyFailed'), 'bad'); } }}>{t('users.copy')}</Btn>
        <Btn kind="primary" onClick={onClose}>{t('common.done')}</Btn>
      </footer>
    </Modal>
  );
}

function NewUser({ all, onDone, onClose }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [projects, setProjects] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { onDone(await api.admin.addUser({ name, role, projects })); }
    catch (x) { toast(x.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('users.new')} onClose={onClose} wide>
      <form class="modal-body stack" onSubmit={submit}>
        <label class="field"><span>{t('auth.name')}</span><input value={name} onInput={(e) => setName(e.currentTarget.value)} autoFocus placeholder={t('users.namePh')} /></label>
        <div class="field"><span>{t('users.globalRole')}</span><Seg label={t('users.globalRole')} value={role} options={ROLE} onPick={setRole} /></div>
        <div class="field"><span>{t('nav.projects')}</span><ProjectRoles role={role} projects={projects} all={all} onChange={setProjects} /></div>
        <footer>
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn kind="primary" type="submit" disabled={busy || !name.trim()}>{busy ? t('common.creating') : t('users.create')}</Btn>
        </footer>
      </form>
    </Modal>
  );
}

function Editor({ ctx, u, all, onSaved }) {
  const [projects, setProjects] = useState(u.projects);
  const [confirm, setConfirm] = useState(null);
  useEffect(() => setProjects(u.projects), [u.id, JSON.stringify(u.projects)]);
  const dirty = JSON.stringify(projects) !== JSON.stringify(u.projects);
  const save = async (change, ok) => {
    try { await api.admin.updateUser({ id: u.id, ...change }); toast(ok, 'good'); onSaved(); }
    catch (x) { toast(x.message, 'bad'); }
  };
  const self = u.id === ctx.me.id;
  return (
    <section class="panel admin-editor" aria-label={t('users.account', { name: u.name })}>
      <div class="row wrap">
        <Avatar user={u} size={34} />
        <div class="grow"><h2>{u.name}{self ? <span class="muted"> · {t('settings.you')}</span> : null}</h2><small class="muted">{t('users.signsInAs')} <code>{u.id}</code>{u.disabled ? ` · ${t('users.disabled')}` : ''}</small></div>
      </div>
      <div class="field"><span>{t('users.globalRole')}</span>
        <Seg label={t('users.globalRole')} value={u.role} options={ROLE} onPick={(r) => r !== u.role && save({ role: r }, t('users.nowIs', { name: u.name, role: ROLE[r].toLowerCase() }))} /></div>
      <div class="field"><span>{t('nav.projects')}</span><ProjectRoles role={u.role} projects={projects} all={all} onChange={setProjects} /></div>
      {u.role !== 'admin' ? (
        <div class="row"><span class="grow" />
          <Btn disabled={!dirty} onClick={() => setProjects(u.projects)}>{t('autos.undo')}</Btn>
          <Btn kind="primary" disabled={!dirty} onClick={() => save({ projects }, t('users.projectsSaved'))}>{t('users.saveProjects')}</Btn></div>
      ) : null}
      <div class="row wrap admin-danger">
        <Btn onClick={() => setConfirm('reset')}>{t('users.reset')}</Btn>
        {u.disabled
          ? <Btn onClick={() => save({ disabled: false }, t('users.reenabled', { name: u.name }))}>{t('users.reenable')}</Btn>
          : <Btn kind="danger" disabled={self} title={self ? t('err.disableSelf') : ''} onClick={() => setConfirm('disable')}>{t('users.disable')}</Btn>}
      </div>
      {confirm === 'disable' ? <Confirm title={t('users.disableTitle', { name: u.name })} danger action={t('users.disable')}
        body={<p>{t('users.disableBody')}</p>}
        onYes={() => save({ disabled: true }, t('users.disabledToast', { name: u.name }))} onClose={() => setConfirm(null)} /> : null}
      {confirm === 'reset' ? <Confirm title={t('users.resetTitle', { name: u.name })} action={t('users.resetBtn')}
        body={<p>{t('users.resetBody')}</p>}
        onYes={async () => { const r = await api.admin.resetPassword(u.id); onSaved({ who: u.name, password: r.password }); }}
        onClose={() => setConfirm(null)} /> : null}
    </section>
  );
}

export function Users({ ctx }) {
  const [data, setData] = useState(null);
  const [pick, setPick] = useState(null);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState(null);
  const load = () => api.admin.users().then(setData).catch(x => toast(x.message, 'bad'));
  useEffect(() => { load(); }, []);
  if (!data) return <p class="muted pad">{t('common.loading')}</p>;
  const sel = data.users.find(u => u.id === pick) || null;
  const summary = (u) => u.role === 'admin' ? t('users.allProjects')
    : Object.keys(u.projects).length ? Object.entries(u.projects).map(([p, r]) => `${p} (${PROJECT_ROLE[r].toLowerCase()})`).join(', ') : t('users.noProject');
  return (
    <div class="admin-users">
      <div class="row"><h2 class="grow">{t('users.people')} <span class="muted">{data.users.length}</span></h2>
        <Btn kind="primary" icon="plus" onClick={() => setAdding(true)}>{t('users.new')}</Btn></div>
      <div class="admin-split">
        <div class="rows" role="list">
          {data.users.map(u => (
            <button key={u.id} role="listitem" class={`row-item${u.id === pick ? ' on' : ''}${u.disabled ? ' off' : ''}`} onClick={() => setPick(u.id)}>
              <Avatar user={u} />
              <span class="grow"><b>{u.name}</b><small class="muted ellipsis admin-sum">{summary(u)}</small></span>
              {u.disabled ? <span class="pill sm c-grey">{t('users.disabled')}</span> : <span class={`pill sm ${u.role === 'admin' ? 'c-cyan' : 'c-grey'}`}>{ROLE[u.role]}</span>}
            </button>
          ))}
        </div>
        {sel ? <Editor ctx={ctx} u={sel} all={data.projects} onSaved={(pw) => { if (pw) setShown(pw); load(); }} />
             : <p class="muted admin-empty">{t('users.pick')}</p>}
      </div>
      {adding ? <NewUser all={data.projects} onClose={() => setAdding(false)}
                         onDone={(r) => { setAdding(false); setPick(r.user.id); setShown({ who: r.user.name, password: r.password }); load(); }} /> : null}
      {shown ? <Password who={shown.who} password={shown.password} onClose={() => setShown(null)} /> : null}
    </div>
  );
}
