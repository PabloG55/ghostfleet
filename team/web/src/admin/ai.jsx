// Administration → AI account (contract §3). Which account Claude Code works on, the
// company's API key (it goes in and never comes back: the server answers sk-…last4), and
// Codex/Gemini as tools inside Claude. Everything here is server/ai-account.mjs's view.
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { Btn, Avatar, toast } from '../ui.jsx';
import { t, locale } from '../i18n.js';
import { worded } from '../../../shared/i18n/index.js';
import './ai.css';
import { Icon } from '../icon.jsx';

const MODES = worded({ 'shared-subscription': {}, 'api-key': {}, 'per-user': {} }, 'aimode', ['name', 'pays', 'usage']);
const when = (at) => new Date(at * 1000).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function AiAccount({ ctx }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState(false);
  const [agree, setAgree] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.aiAccount().then(setV).catch(e => setErr(e.message)); }, []);
  const act = async (b, ok) => {
    setBusy(true);
    try { setV(await api.aiAct(b)); if (ok) toast(ok, 'good'); return true; }
    catch (e) { toast(e.message, 'bad'); return false; }
    finally { setBusy(false); }
  };
  if (err) return <p class="err pad">{err}</p>;
  if (!v) return <p class="muted pad">{t('common.loading')}</p>;
  const who = (id) => ctx.usersById[id]?.name || id;
  const pick = (m) => {
    if (m === v.mode) return;
    if (m === 'shared-subscription') { setAgree(false); setWarn(true); return; }
    act({ action: 'mode', mode: m }, t('ai.modeSet', { mode: MODES[m].name }));
  };
  const profiles = v.profiles.map(p => p.profile);

  return (
    <>
      <section class="panel">
        <h2>{t('ai.which')}</h2>
        <p class="muted">{t('ai.whichSub')}</p>
        <div class="ai-modes" role="radiogroup" aria-label={t('ai.modeLabel')}>
          {v.modes.map(m => (
            <button key={m} type="button" role="radio" aria-checked={v.mode === m} disabled={busy || (m === 'api-key' && !v.key.set)}
                    class={`ai-mode${v.mode === m ? ' on' : ''}`} onClick={() => pick(m)}>
              <b>{MODES[m].name}</b>
              <span><small>{t('ai.pays')}</small> {MODES[m].pays}</span>
              <span><small>{t('ai.usagePer')}</small> {MODES[m].usage}</span>
              {m === 'api-key' && !v.key.set ? <em class="muted small">{t('ai.saveKeyFirst')}</em> : null}
              {v.mode === m ? <em class="ai-on">● {t('ai.inUse')}</em> : null}
            </button>
          ))}
        </div>
        {!v.mode ? <p class="muted small">{t('ai.noMode')}</p> : null}
        {warn ? (
          <div class="ai-warn" role="alertdialog" aria-labelledby="ai-warn-t">
            <b id="ai-warn-t"><Icon name="warning" /> {t('ai.warnTitle')}</b>
            <p>{t('ai.warn1')}</p>
            <p>{t('ai.warn2')}</p>
            <label class="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.currentTarget.checked)} />
              <span>{t('ai.accept')}</span></label>
            <div class="row">
              <Btn kind="primary" disabled={!agree || busy} onClick={async () => {
                if (await act({ action: 'mode', mode: 'shared-subscription', accept: true }, t('ai.modeSet', { mode: MODES['shared-subscription'].name }))) setWarn(false);
              }}>{t('ai.acceptBtn')}</Btn>
              <Btn kind="ghost" onClick={() => setWarn(false)}>{t('common.cancel')}</Btn>
            </div>
          </div>
        ) : null}
        {v.shared ? <p class="muted small">{t('ai.acceptedBy', { who: who(v.shared.by), when: when(v.shared.at) })}</p> : null}
      </section>

      <section class="panel">
        <h2>{t('ai.login')}</h2>
        <p class="muted small">{t('ai.loginSub')}</p>
        <div class="rows">
          {v.profiles.map(p => (
            <div class="row-item static" key={p.profile}>
              <span class={`dot${p.login.loggedIn ? ' ok' : ' bad'}`} />
              <b class="mono">{p.profile}</b>
              <span class="grow">{p.login.loggedIn
                ? <>{p.login.email || t('ai.connected')}{p.login.plan ? <> · {t('ai.plan')} <b>{p.login.plan}</b></> : null}{p.login.org ? <span class="muted"> · {p.login.org}</span> : null}</>
                : <span class="err">{t('ai.noLogin')} <code>CLAUDE_CONFIG_DIR=… claude</code> {t('ai.then')} <code>/login</code></span>}</span>
              {p.login.simulated ? <span class="muted small">demo</span> : null}
            </div>
          ))}
          {!v.profiles.length ? <p class="muted small">{t('ai.noProfiles')}</p> : null}
        </div>
      </section>

      <section class="panel">
        <h2>{t('ai.keyTitle')}</h2>
        {v.key.set
          ? <p>{t('ai.keySaved')} <code>{v.key.hint}</code> <span class="muted small">· {t('ai.byOn', { who: who(v.key.by), when: when(v.key.at) })}</span></p>
          : <p class="muted">{t('ai.noKey')}</p>}
        <form class="row wrap" onSubmit={async (e) => {
          e.preventDefault();
          if (await act({ action: 'key', key }, t('ai.keyStored'))) setKey('');
        }}>
          <input type="password" autocomplete="off" spellcheck={false} placeholder={v.key.set ? t('ai.keyReplace') : 'sk-ant-…'}
                 value={key} onInput={(e) => setKey(e.currentTarget.value)} aria-label={t('aimode.api-key.name')} />
          <Btn kind="ghost" type="submit" disabled={!key || busy}>{t('common.save')}</Btn>
          {v.key.set ? <Btn kind="danger" disabled={busy} onClick={() => confirm(t('ai.keyDelAsk')) && act({ action: 'clear-key' }, t('ai.keyDeleted'))}>{t('common.delete')}</Btn> : null}
        </form>
        <p class="muted small">{t('ai.keyHow1')} <code>apiKeyHelper</code>{t('ai.keyHow2')}</p>
      </section>

      <section class="panel">
        <h2>{t('aimode.per-user.name')}</h2>
        <p class="muted small">{t('ai.perUserSub1')} <code>CLAUDE_CONFIG_DIR</code> {t('ai.perUserSub2')}</p>
        <div class="rows">
          {ctx.users.map(u => (
            <div class="row-item static" key={u.id}>
              <Avatar user={u} /> <b class="grow">{u.name}</b>
              <select aria-label={t('ai.profileOf', { name: u.name })} value={v.perUser[u.id] || ''} disabled={busy}
                      onChange={(e) => act({ action: 'per-user', user: u.id, profile: e.currentTarget.value }, t('ai.profileSaved'))}>
                <option value="">— {t('ai.noProfile')} —</option>
                {[...new Set([...profiles, ...(v.perUser[u.id] ? [v.perUser[u.id]] : [])])].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p class="ai-note small"><b>{t('ai.notYet')}</b> {t('ai.notYetWhy')} <code>team/docs/CUENTA-IA-POR-PERSONA.md</code>.</p>
      </section>

      <section class="panel">
        <h2>{t('ai.others')}</h2>
        <p class="muted small">{t('ai.othersSub')}</p>
        <div class="rows">
          {['codex', 'gemini'].map(n => {
            const m = v.mcp[n];
            return (
              <div class="row-item static ai-mcp" key={n}>
                <label class="switch" title={m.available ? (m.on ? t('ai.on') : t('ai.off')) : t('ai.unavailable')}>
                  <input type="checkbox" checked={m.on} disabled={!m.available || busy} aria-label={t(m.on ? 'ai.turnOff' : 'ai.turnOn', { name: m.label })}
                         onChange={(e) => act({ action: 'mcp', name: n, on: e.currentTarget.checked }, `${m.label}: ${(e.currentTarget.checked ? t('ai.on') : t('ai.off')).toLowerCase()}`)} /><i />
                </label>
                <div class="grow">
                  <b>{m.label}</b> {m.command ? <code class="small">{m.command}</code> : null}
                  {!m.available && m.why ? <p class="muted small">{m.why}</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {v.applied ? (
        <section class="panel">
          <h2>{t('ai.applied')} {v.demo ? <span class="muted small">({t('ai.simulated')})</span> : null}</h2>
          <div class="rows">
            {v.applied.steps.map(s => (
              <div class="row-item static" key={s.profile}><span class={`dot${s.ok ? ' ok' : ' bad'}`} /><b class="mono">{s.profile}</b><span class="grow small">{s.text}</span></div>
            ))}
          </div>
          <p class="muted small">{when(v.applied.at)}. {t('ai.appliedWhen')}</p>
        </section>
      ) : null}
    </>
  );
}
