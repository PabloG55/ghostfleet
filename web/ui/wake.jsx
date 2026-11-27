import { useState, useRef } from 'preact/hooks';
import { Modal, Btn } from './ui.jsx';
import { useFleet } from './adapter.jsx';
import { t } from './i18n.js';

// AN ASLEEP SESSION WAKES BEFORE IT OPENS, as its pill promises ("one click wakes it") and as the
// desk's grid does it (bin/ghostfleet: ⏎ on an asleep card is fleet-hibernate --wake, then the
// attach). The old phone client did the same, and the shared screens that replaced it opened the
// asleep session's page and stopped there: a tap that changed nothing, on a session that stayed
// asleep, with the one wake left an unnamed sun in the header. So every place a person taps a
// session to go to it — a card, a row of the tree, a boat on the board — goes through here when
// that session is asleep, and the page opens only once the wake has answered yes.
//
// A WAKE THAT FAILS SAYS WHY, in a sheet: a bottom sheet on a phone and a dialog at a desk (Modal
// `sheet`), never a toast that is gone in seven seconds and never a card in the page. What it says
// is what fleet-hibernate printed (fleet-serve strips its "FAILED —" prefix): which way the agent
// died and its last lines, and that it is still asleep, so trying again is safe.
//   The same sheet takes a send that could not wake its session (fleet-send: "asleep and did not
// wake"), because that is the same failure reached by another verb, and the person needs the same
// answer: it is asleep, here is why, try the wake again.
export const ASLEEP_FAILED = /asleep and did not wake/;

// `wake(project, name, then)` → true once it is up (and `then` has run), false when it is not; a
// second tap while one is out is ignored, since fleet-hibernate would only wait on the first.
// `fail(project, name, why, then)` opens the sheet for a failure some other verb met.
//   fleet.act is called with nothing awaited before it: on a phone the passkey ceremony behind a
// write keeps the tap's activation only if the call is made in the tap's own turn (adapter.js).
export function useWake() {
  const fleet = useFleet();
  const [waking, setWaking] = useState(null);
  const [failed, setFailed] = useState(null);
  const out = useRef(null);
  const wake = async (project, name, then) => {
    if (out.current) return false;
    const key = `${project}\0${name}`;
    out.current = key; setWaking(key);
    try {
      await fleet.act('fleet_wake', { project, session: name });
      out.current = null; setWaking(null);
      then?.();
      return true;
    } catch (e) {
      out.current = null; setWaking(null);
      setFailed({ project, name, why: e.message, then });
      return false;
    }
  };
  const fail = (project, name, why, then) => setFailed({ project, name, why, then });
  const sheet = failed ? (
    <WakeFailed name={failed.name} why={failed.why} onClose={() => setFailed(null)}
                onRetry={() => { const f = failed; setFailed(null); wake(f.project, f.name, f.then); }} />
  ) : null;
  return { wake, fail, sheet, waking: (project, name) => waking === `${project}\0${name}` };
}

export function WakeFailed({ name, why, onClose, onRetry }) {
  return (
    <Modal sheet title={t('wake.failedTitle', { name })} onClose={onClose}>
      <div class="modal-body wake-failed">
        <p>{t('wake.failedBody')}</p>
        <pre class="wake-why">{why || t('wake.noWhy')}</pre>
      </div>
      <footer>
        <Btn onClick={onClose}>{t('common.close')}</Btn>
        <Btn kind="primary" icon="sun" onClick={onRetry}>{t('wake.again')}</Btn>
      </footer>
    </Modal>
  );
}
