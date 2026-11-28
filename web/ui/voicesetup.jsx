// "Voice isn't set up on <machine>": the sheet that says the computer serving this app cannot
// hear (and whether it can speak), why, and the one command that fixes it.
//
// IT REPLACES A SILENCE. With no whisper.cpp on the serving machine the app used to fall back to
// the browser's own dictation without a word — a different engine, its audio sent to whoever
// makes the browser — or, with none of that either, turn speak mode off with a toast. Either
// way the person learnt nothing about the machine, which is the one place it can be fixed. The
// status already carried the reason and the command; nothing showed them.
//
// A SHEET, NOT A CARD: it is raised while the person is on a screen, so it opens over that
// screen — a bottom sheet on a phone, a dialog at a desk (ui.css .modal.sheet) — and moves
// nothing. Raised by explainVoice(), from speak mode and the assistant when the status says the
// machine cannot hear, and by voice.js itself when a transcription comes back `needs: 'voice'`.
// The device's dictation is offered as a choice, never taken for the person.
import { useState, useEffect } from 'preact/hooks';
import { Modal, Btn } from './ui.jsx';
import { t } from './i18n.js';
import { whenVoiceMissing, browserCanHear } from './voice.js';

let cur = null;
const subs = new Set();
const show = (v) => { cur = v; for (const f of subs) f(); };
// vs: what voiceStatus() said ({hear, speak, machine}). onDictate: run instead when the person
// picks the device's dictation; onClose: when they close it without.
export function explainVoice(vs, { onDictate = null, onClose = null } = {}) { show({ vs: vs || {}, onDictate, onClose }); }
export const voiceSheetOpen = () => !!cur;
whenVoiceMissing((vs, opts) => explainVoice(vs, opts));

// The server's reason without its own "— run: <command>", which the sheet shows as a line of its own.
const reason = (why) => String(why || '').replace(/\s+—\s+run:.*$/s, '').trim();

function Command({ text }) {
  const [copied, setCopied] = useState(false);
  const can = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {} };
  return (
    <div class="vs-cmd">
      {/* Breaks only between words: wrapping at a hyphen split a flag into "--" and "install". */}
      <code>{text.split(' ').map((w, i) => <>{i ? ' ' : ''}<span class="vs-word">{w}</span></>)}</code>
      {can ? <Btn kind="ghost sm" onClick={copy}>{copied ? t('vs.copied') : t('vs.copy')}</Btn> : null}
    </div>
  );
}

export function VoiceSetup() {
  const [, n] = useState(0);
  useEffect(() => { const f = () => n(x => x + 1); subs.add(f); return () => subs.delete(f); }, []);
  if (!cur) return null;
  const { vs, onDictate, onClose } = cur;
  const machine = vs.machine || t('vs.thisMachine');
  const hear = vs.hear || {}, speak = vs.speak || null;
  const close = () => { const f = cur?.onClose; show(null); f?.(); };
  const dictate = () => { const f = cur?.onDictate; show(null); f?.(); };
  const canDictate = !!onDictate && browserCanHear;
  return (
    <Modal sheet title={t('vs.title', { machine })} onClose={close}>
      <div class="modal-body voice-setup">
        <p>{t('vs.lead', { machine })}</p>
        <section class="vs-half">
          <h3>{t('vs.hearing')}</h3>
          {reason(hear.why) ? <p class="muted small vs-why">{reason(hear.why)}</p> : null}
          {hear.fix ? <><p class="small">{t('vs.runOn', { machine })}</p><Command text={hear.fix} /></> : null}
        </section>
        {speak && !speak.ready ? (
          <section class="vs-half">
            <h3>{t('vs.speaking')}</h3>
            <p class="muted small">{t('vs.speakFallback')}</p>
            {speak.fix ? <Command text={speak.fix} /> : null}
          </section>
        ) : null}
        <p class="muted small">{canDictate ? t('vs.dictateNote') : browserCanHear ? '' : t('vs.noDictation')}</p>
        <footer>
          <Btn kind="ghost" onClick={close}>{t('common.close')}</Btn>
          {canDictate ? <Btn kind="primary" onClick={dictate}>{t('vs.dictate')}</Btn> : null}
        </footer>
      </div>
    </Modal>
  );
}
