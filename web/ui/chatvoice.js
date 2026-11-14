// A chat that talks: the ▶ on a message, and speak mode in the composer. Both ride web/ui/voice.js
// (the Mac's voice when the server offers it, the browser's otherwise) and speakable.js — this file
// is the control around them, not a second way to speak.
//
// ONE MESSAGE PLAYS AT A TIME, for the whole app: the player in voice.js is one, so a second ▶
// replaces the first, and `cur` names which bubble is lit. An id is `<project>/<session>:<key>`, so
// a session leaving the screen stops its own voice and never one that belongs to another view.
import { useState, useEffect, useRef } from 'preact/hooks';
import { speak, stopSpeaking, listenLocal, listenBrowser, browserCanHear, voiceStatus, PAUSES } from './voice.js';
import { S } from './agent.js';
import { toast } from './ui.jsx';
import { t } from './i18n.js';

let cur = '';
const subs = new Set();
const note = (id) => { cur = id; for (const f of subs) f(); };
export function useReading() {
  const [, n] = useState(0);
  useEffect(() => { const f = () => n(x => x + 1); subs.add(f); return () => subs.delete(f); }, []);
  return cur;
}

// Speak mode hands over the moment the person presses a ▶ themselves: its loop would otherwise wait
// for a reply that was cut off, and an `onEnd` that a replaced voice never calls.
let takeover = null;   // a function carrying the `owner` that set it

// iOS lets speech start only from a gesture; a silent word said inside the tap unlocks the voice
// for the timers and network callbacks that speak later.
export function unlockSpeech() {
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis?.speak(u); } catch {}
}

export function toggleRead(id, md) {
  if (cur === id) { stopSpeaking(); note(''); return; }
  takeover?.();
  unlockSpeech();
  note(id);
  speak(md, () => { if (cur === id) note(''); }, S.voice);
}
export function stopRead(scope) {
  if (cur && cur.startsWith(scope)) { stopSpeaking(); note(''); }
}

// The last thing the agent said, as a stable key: a timestamp is the device's clock against the
// Mac's, so "new" is "different from what was there when the words were sent".
const lastSaid = (page) => {
  const m = [...(page?.messages || [])].reverse().find(x => x.role !== 'user' && x.role !== 'tools' && x.text);
  return m ? { key: `${m.ts}|${String(m.text).slice(0, 200)}`, text: m.text } : null;
};

// phase: off | listening | hearing | sending | waiting | speaking. listen → send → (turn ends) →
// read the reply → listen. `gen` is bumped by every way out, so a transcript still coming back from
// the transcriber, or a voice still finishing, cannot act after the person turned it off.
export function useSpeakMode({ scope, send, page, status }) {
  const [phase, setPhase] = useState('off');
  const R = useRef({ gen: 0, mic: null, seen: '', phase: 'off', page: null, off: null });
  R.current.page = page;
  const go = (p) => { R.current.phase = p; setPhase(p); };
  const live = (g) => R.current.gen === g;
  const off = (why) => {
    const r = R.current;
    r.gen++;
    if (r.mic) { const m = r.mic; r.mic = null; try { m.cancel(); } catch {} }
    if (r.phase === 'speaking') { stopSpeaking(); if (cur.startsWith(scope)) note(''); }
    if (takeover?.owner === R) takeover = null;
    go('off');
    if (why) toast(why, 'bad');
  };
  R.current.off = off;
  const listen = async (g) => {
    go('listening');
    const vs = await voiceStatus();
    if (!live(g)) return;
    const local = !!vs.hear?.ready;
    if (!local && !browserCanHear) { off(t('chat.speakNoMic')); return; }
    stopSpeaking();
    const common = {
      pauseMs: PAUSES[S.pause]?.ms ?? PAUSES.normal.ms,
      onState: (s) => { if (live(g)) go(s); },
      onError: (m) => { if (live(g)) off(m); },
      onText: (text) => {
        if (!live(g)) return;
        R.current.mic = null;
        // Nothing heard is not a message: it ends the mode, with the words saying so.
        if (!text.trim()) { off(t('agent.heardNothing')); return; }
        sendIt(g, text.trim());
      },
    };
    R.current.mic = local ? listenLocal(common) : listenBrowser(common);
  };
  const sendIt = async (g, text) => {
    go('sending');
    R.current.seen = lastSaid(R.current.page)?.key || '';
    const ok = await send(`(spoken) ${text}`);
    if (!live(g)) return;
    if (!ok) { off(); return; }
    go('waiting');
  };
  // The turn is over when the session is no longer working and there is something newer than what
  // was said before the send.
  useEffect(() => {
    if (phase !== 'waiting') return;
    if (status === 'working' || status === 'starting') return;
    const a = lastSaid(page);
    if (!a || a.key === R.current.seen) return;
    const g = R.current.gen;
    go('speaking');
    const id = `${scope}:speak`;
    note(id);
    speak(a.text, () => { if (cur === id) note(''); if (live(g)) listen(g); }, S.voice);
  }, [phase, page, status]);
  // A reply that never comes ends the mode rather than listening to nothing for good.
  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const g = R.current.gen;
    const timer = setTimeout(() => { if (live(g)) off(); }, 10 * 60e3);
    return () => clearTimeout(timer);
  }, [phase]);
  useEffect(() => () => off(), []);

  const toggle = () => {
    if (R.current.phase !== 'off') { off(); return; }
    // Inside the tap: it unlocks the voice for the replies read later.
    unlockSpeech();
    stopSpeaking(); note('');
    takeover = Object.assign(() => R.current.off(), { owner: R });
    const g = ++R.current.gen;
    listen(g);
  };
  return { phase, on: phase !== 'off', toggle };
}
