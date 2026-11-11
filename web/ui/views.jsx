// Activity and Settings: the two pages every app built on web/ui has beside the fleet itself.
//
// Both are drawn from the adapter (web/ui/adapter.jsx) and nothing else. Activity reads
// `activity()`; Settings draws one section per thing the adapter offers — a section whose member
// is missing draws nothing, so an app without push notifications has no push section rather than
// a disabled one. The people in either page (who did it, the team, a password) are the app's
// slots: the phone has no people, so its slots draw nothing.
import { useState, useEffect } from 'preact/hooks';
import { useKept } from './back.jsx';
import { Btn, usePoll, clock, toast, ProjectName } from './ui.jsx';
import { Select } from './select.jsx';
import { useFleet, useSlot } from './adapter.jsx';
import { t, lang, LANGS, LANG_NAMES, words } from './i18n.js';
import { setLang } from './lang.js';
import { Icon } from './icon.jsx';
import { Led } from './fleet.jsx';

// "Ana <verb> acme-api": the verb reads right before the subject in either language.
const VERBS = words(['fleet_send', 'attach', 'fleet_answer', 'fleet_interrupt', 'fleet_pause', 'fleet_resume', 'fleet_wake', 'fleet_reopen',
  'fleet_spawn', 'fleet_stop', 'fleet_rename', 'fleet_worktree_remove', 'fleet_unqueue', 'assign', 'login', 'setup', 'add_user', 'password',
  'auto_save', 'auto_delete', 'route', 'voice_install', 'voice_delete', 'license_set', 'license_remove', 'license_renew', 'license_auto'], 'verb');
const RESULT = { ran: 'good', refused: 'bad', changed: 'warn' };

export function Activity() {
  const fleet = useFleet();
  const { data, error } = usePoll(() => fleet.activity(), 5000, []);
  const [who, setWho] = useKept('activity.who', 'all');   // a person picked stays picked when gone back to
  const rows = (data?.rows || []).filter(r => who === 'all' || r.user === who);
  const people = useSlot('activityPeople');
  const face = useSlot('activityFace');
  const person = useSlot('activityWho', (r) => (r.by ? <b>{r.by}</b> : null));
  return (
    <div class="page">
      <header class="page-head"><div><h1>{t('activity.title')}</h1><p class="muted">{t('activity.sub')}</p></div></header>
      {people({ who, setWho })}
      {error ? <p class="err">{error.message}</p> : null}
      <div class="log">
        {rows.map((r, i) => {
          const [rl, rk] = RESULT[r.result] ? [t(`result.${r.result}`), RESULT[r.result]] : [r.result, ''];
          const target = r.subject && r.subject !== '-' ? r.subject : '';
          const detail = r.args?.prompt || r.args?.text || r.args?.new_name || r.detail || '';
          return (
            <details class="log-row" key={i}>
              <summary>
                <span class="when">{clock(r.ts)}</span>
                {face(r)}
                <span class="grow">{person(r)} {VERBS[r.verb] || r.verb} {target ? <b>{target}</b> : null}
                  {r.project ? <span class="muted"> · <ProjectName name={r.project} /></span> : null}
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

// A switch row: what it is, what it does now, and the one control. A native checkbox under the
// skin's switch, so a screen reader and the keyboard get a real checkbox.
function Toggle({ label, hint, on, busy, onChange }) {
  return (
    <label class="set-row">
      <span class="grow"><b>{label}</b>{hint ? <small class="muted">{hint}</small> : null}</span>
      <span class="switch"><input type="checkbox" checked={!!on} disabled={busy} onChange={(e) => onChange(e.currentTarget.checked)} /><i /></span>
    </label>
  );
}

// One adapter section that has a state to read and a switch to flip: push notifications, the
// terminal. `state()` answers { on, ready, why }; `set(on)` flips it and may ask for a passkey.
function SwitchSection({ title, part, label, icon }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => part.state().then(setSt, (e) => setSt({ ready: false, why: e.message }));
  useEffect(() => { load(); }, []);
  const flip = async (on) => {
    setBusy(true);
    try { await part.set(on); } catch (e) { toast(e.message, 'bad'); }
    setBusy(false); load();
  };
  return (
    <section class="panel">
      <h2><Icon name={icon} /> {title}</h2>
      {st == null ? <p class="muted">{t('settings.reading')}</p>
        : st.ready === false ? <p class="muted">{st.why}</p>
        : <Toggle label={label} hint={st.why} on={st.on} busy={busy} onChange={flip} />}
    </section>
  );
}

// Paired machines (the phone's /api/pairs): each one's name, whether it answers, and the two
// things to do to it. Unpairing is the only way back from a pairing, so it asks first.
function Hosts({ part }) {
  const { data, error, reload } = usePoll(() => part.list(), 15000, []);
  const [asking, setAsking] = useState('');
  const hosts = data || [];
  return (
    <section class="panel">
      <h2><Icon name="map" /> {t('settings.hosts')}</h2>
      {error ? <p class="err">{error.message}</p> : null}
      {data && !hosts.length ? <p class="muted">{t('settings.hostsNone')}</p> : null}
      <div class="rows">
        {hosts.map(h => (
          <div class="row-item static" key={h.key}>
            <Led state={h.self || h.online !== false ? 'idle' : 'off'} size={8} />
            <span class="grow"><b>{h.label || h.key}</b> <small class="muted">{h.self ? t('settings.hostThis') : h.online === false ? t('settings.hostOffline') : t('settings.hostOnline')}</small></span>
            {h.self ? null : asking === h.key
              ? <><Btn kind="danger" onClick={async () => { try { await part.unpair(h.key); toast(t('settings.unpaired', { name: h.label || h.key }), 'good'); } catch (e) { toast(e.message, 'bad'); } setAsking(''); reload(); }}>{t('settings.unpair')}</Btn>
                  <Btn kind="ghost" onClick={() => setAsking('')}>{t('common.cancel')}</Btn></>
              : <Btn kind="ghost" onClick={() => setAsking(h.key)}>{t('settings.unpairQ')}</Btn>}
          </div>
        ))}
      </div>
    </section>
  );
}

// Which server this page talks to, and the choices for it: the team app says whether it is the
// demo; the phone can be pointed at its fixtures, its own origin or another URL.
export function Connection({ part, onChange }) {
  const [st, setSt] = useState(() => part.state());
  const [url, setUrl] = useState(() => st.detail || '');
  // "Another server" needs its address before it means anything: picking it shows the field,
  // and the address is what applies it (Enter, or the button beside it).
  const [choice, setChoice] = useState(st.choice);
  const apply = async (v, u = url) => {
    try { await part.choose(v, u); const n = part.state(); setSt(n); setChoice(n.choice); onChange?.(n); } catch (e) { toast(e.message, 'bad'); }
  };
  const pick = (v) => { setChoice(v); if (v !== 'server') apply(v); };
  return (
    <section class="panel">
      <h2><Icon name="link" /> {t('settings.connection')}</h2>
      <p>{st.text}</p>
      {st.detail ? <p class="muted small">{st.detail}</p> : null}
      {part.choices ? (
        <div class="row wrap">
          <Select label={t('settings.backend')} labelClass="muted" value={choice} options={part.choices()} onChange={pick} />
          {choice === 'server' ? <>
            <input type="url" inputMode="url" placeholder="https://" aria-label={t('settings.serverUrl')} value={url}
                   onInput={(e) => setUrl(e.currentTarget.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') apply('server'); }} />
            <Btn kind="ghost" disabled={!/^https?:\/\/./.test(url)} onClick={() => apply('server')}>{t('settings.useServer')}</Btn>
          </> : null}
        </div>
      ) : null}
      {part.reset ? <Btn kind="ghost" onClick={async () => { try { await part.reset(); toast(t('settings.demoReset'), 'good'); } catch (e) { toast(e.message, 'bad'); } }}>{t('settings.resetDemo')}</Btn> : null}
    </section>
  );
}

// This device's own key (the phone's passkey): what it is, and the ways out of it.
function Device({ part }) {
  const st = part.state();
  return (
    <section class="panel">
      <h2><Icon name="key" /> {t('settings.device')}</h2>
      <p>{st.text}</p>
      {st.detail ? <p class="muted small">{st.detail}</p> : null}
      <div class="row wrap">
        {(part.actions?.() || []).map(a => <Btn key={a.id} kind={a.kind || 'ghost'} onClick={async () => { try { await a.run(); } catch (e) { toast(e.message, 'bad'); } }}>{a.label}</Btn>)}
      </div>
    </section>
  );
}

export function Settings() {
  const fleet = useFleet();
  const s = fleet.settings || {};
  const people = useSlot('settingsPeople');
  return (
    <div class="page narrow">
      <header class="page-head"><div><h1>{t('settings.title')}</h1></div></header>
      <section class="panel">
        <h2>{t('settings.language')}</h2>
        <Select label={t('settings.languageHint')} labelClass="muted" value={lang()}
                options={LANGS.map(l => ({ value: l, label: LANG_NAMES[l] }))}
                onChange={(l) => { setLang(l); fleet.saveLang?.(l)?.catch?.(x => toast(x.message, 'bad')); }} />
      </section>
      {people()}
      {s.push ? <SwitchSection title={t('settings.push')} label={t('settings.pushLabel')} icon="bell" part={s.push} /> : null}
      {s.hosts ? <Hosts part={s.hosts} /> : null}
      {s.device ? <Device part={s.device} /> : null}
      {s.connection ? <Connection part={s.connection} /> : null}
      {s.about ? <section class="panel"><h2>{t('settings.about')}</h2><p class="muted small">{s.about()}</p></section> : null}
    </div>
  );
}
