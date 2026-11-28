import { useState, useEffect } from 'preact/hooks';
import { Modal, Btn, toast } from './ui.jsx';
import { Icon } from './icon.jsx';
import { useFleet } from './adapter.jsx';
import { t } from './i18n.js';

// MOVE A RUNNING SESSION TO ANOTHER AGENT, from its own page: the desk's `fleet-model <session>
// <agent>[:<model>]`, through the same fleet_model the MCP tool and the CLI use. Same session,
// same worktree and branch; only the agent process is replaced (lib/agent-switch.sh), and the
// conversation goes over with it (lib/handoff.mjs).
//
// A SHEET, NEVER INLINE: a bottom sheet on a phone and a dialog at a desk (Modal `sheet`), like
// Details and a failed wake. A picker that opened in the page would push the conversation down
// under the person's thumb, and this is a choice made once, not a control kept on screen.
//
// IT LISTS WHAT fleet-model WOULD TAKE, as `fleet-model --models` gives it: each agent's models,
// and a first row with no model, which is what a switch back usually wants (the agent comes back
// on the model it was left on; one never run here starts on its default). The row the session is
// on says so. What it says after is fleet-model's own sentence, so the sheet cannot promise a
// "now" that the CLI would have said was "when its current turn ends".
//
// The message rides with the switch and is sent exactly as typed, after the handoff: the box is
// never trimmed, as the composer's own text is not.
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const agentName = (a) => AGENT_NAMES[a] || a;
const words = (s) => String(s || '').replace(/^fleet-model:\s*/, '');

export function SwitchAgent({ project, name, onClose, onDone }) {
  const fleet = useFleet();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(null);          // { agent, model } — model null: no model named
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fleet.models(project, name).then((d) => { if (live) setData(d); }, (e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [project, name]);

  const cur = data ? { agent: data.agent || 'claude', model: data.model || null } : null;
  const groups = data ? Object.entries(data.models || {}).filter(([, list]) => Array.isArray(list) && list.length) : [];
  const isCur = (a, m) => !!cur && cur.agent === a && (m ? cur.model === m : !cur.model || !(data.models[a] || []).some(x => x.id === cur.model));
  const same = pick && isCur(pick.agent, pick.model);
  const go = async () => {
    if (!pick || same || busy) return;
    setBusy(true);
    try {
      const r = await fleet.act('fleet_model', { project, session: name, model: pick.model ? `${pick.agent}:${pick.model}` : pick.agent,
                                                ...(msg.trim() ? { message: msg } : {}) });
      toast(words(r?.text) || t('switch.asked'), 'good', 'swap');
      onDone?.();
      onClose();
    } catch (e) {
      toast(words(e?.message || e), 'bad');
    } finally { setBusy(false); }
  };

  return (
    <Modal sheet wide title={t('switch.title', { name })} onClose={onClose}>
      <div class="modal-body agent-switch">
        {err ? <p class="bad small">{err}</p> : !data ? <p class="muted">{t('common.loading')}</p> : <>
          <p class="switch-now">{cur.model ? t('switch.now', { agent: agentName(cur.agent), model: cur.model }) : t('switch.nowDefault', { agent: agentName(cur.agent) })}</p>
          {data.switching ? <p class="switch-pending" role="status"><Icon name="hourglass" /> {t('switch.pending', { to: agentName(data.switching.agent) + (data.switching.model ? ` (${data.switching.model})` : '') })}</p> : null}
          {data.failed ? <p class="switch-failed" role="status"><Icon name="warning" /> {t('switch.failed', { why: data.failed })}</p> : null}
          {!groups.length ? <p class="muted">{t('switch.none')}</p> : (
            <div class="switch-groups">
              {groups.map(([a, list]) => (
                <section key={a} class="switch-group">
                  <h3>{agentName(a)}</h3>
                  <ul role="radiogroup" aria-label={agentName(a)}>
                    {[{ id: '', name: t('switch.last') }, ...list].map((m) => {
                      const id = m.id || null;
                      const on = !!pick && pick.agent === a && pick.model === id;
                      return (
                        <li key={m.id || '-'}>
                          <button role="radio" aria-checked={on} class={`switch-row${on ? ' on' : ''}`} disabled={busy}
                                  onClick={() => setPick({ agent: a, model: id })}>
                            <span class="switch-name">{m.name}</span>
                            {isCur(a, id) ? <span class="tag">{t('switch.current')}</span> : null}
                            <span class="switch-tick" aria-hidden="true">{on ? <Icon name="check" /> : null}</span>
                          </button>
                        </li>);
                    })}
                  </ul>
                </section>))}
            </div>)}
          <label class="field switch-msg">
            <span>{t('switch.message')}</span>
            <textarea rows={2} value={msg} disabled={busy} onInput={(e) => setMsg(e.currentTarget.value)} />
          </label>
          <p class="muted small switch-keeps">{t('switch.keeps')} {t('switch.waits')}</p>
        </>}
      </div>
      <footer>
        <Btn onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn kind="primary" icon="swap" disabled={!pick || same || busy} onClick={go}>
          {pick ? t('switch.go', { agent: agentName(pick.agent) + (pick.model ? ` · ${(data?.models?.[pick.agent] || []).find(x => x.id === pick.model)?.name || pick.model}` : '') }) : t('switch.pick')}
        </Btn>
      </footer>
    </Modal>
  );
}
