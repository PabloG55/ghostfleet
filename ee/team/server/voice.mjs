// server/voice.mjs — hearing and speaking on THIS machine, through ghostfleet's own code:
// lib/jarvis.mjs runs whisper.cpp, lib/speech.mjs runs Kokoro, server/piper.mjs adds the voices
// that can be downloaded. The first two are optional and found
// rather than configured; when either is missing the browser falls back to its own voice.
// Nothing spoken is kept: whisper's input lives in a temp dir that is removed before the
// transcript returns, and the log line carries sizes and times, never words.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GF_HOME } from './paths.mjs';
import * as piper from './piper.mjs';
import { t } from '../shared/i18n/index.js';

const load = async (rel) => {
  const p = path.join(GF_HOME, rel);
  if (!fs.existsSync(p)) return null;
  try { return await import(pathToFileURL(p).href); } catch { return null; }
};
const jarvis = await load('lib/jarvis.mjs');
const speech = await load('lib/speech.mjs');

export function status() {
  const hear = jarvis ? jarvis.voiceStatus() : { ready: false, why: t('voice.noGf', { home: GF_HOME }) };
  const speak = speech ? speech.status() : { ready: false, why: t('voice.noGf', { home: GF_HOME }) };
  return { hear: { ready: !!hear.ready, why: hear.ready ? null : hear.why },
           speak: { ready: !!speak.ready, why: speak.ready ? null : speak.why } };
}

// One transcription at a time: whisper takes every core it is given.
let chain = Promise.resolve();
export function hear(wav, words = []) {
  if (!jarvis) return Promise.resolve({ error: t('voice.noGfShort') });
  if (!jarvis.isWav(wav)) return Promise.resolve({ error: t('voice.notWav') });
  // The names on screen are the words whisper is likeliest to mishear, so they go in the prompt.
  const prompt = `Proyectos y sesiones: ${words.slice(0, 40).join(', ')}.`;
  const run = () => jarvis.transcribeAsync(wav, { prompt, lang: process.env.GFW_VOICE_LANG || 'es', timeout: 90000 });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// The voices that answer in Spanish: Kokoro's own three, and whatever was downloaded from Piper.
// A voice is 'kokoro:<name>' or 'piper:<key>'. Only Spanish sentences change voice: an English
// one read by a Spanish voice sounds wrong, so those stay with Kokoro's English voice.
const KOKORO_ES = [{ id: 'ef_dora', name: 'Dora', who: 'mujer' }, { id: 'em_alex', name: 'Alex', who: 'hombre' }, { id: 'em_santa', name: 'Santa', who: 'hombre' }];
export function voices() {
  const def = speech?.VOICES.es.voice;
  return { kokoro: KOKORO_ES.map(v => ({ ...v, id: `kokoro:${v.id}`, default: v.id === def })), ...piper.list() };
}
function revoice(it, choice) {
  if (it.lang !== 'es' || !choice) return it;
  const [engine, name] = String(choice).split(':');
  if (engine === 'kokoro' && KOKORO_ES.some(v => v.id === name)) {
    const v = { voice: name, lang: it.code };
    return { ...it, id: speech.idFor(it.text, v), voice: name };
  }
  if (engine === 'piper' && piper.installed(name)) return { ...it, id: piper.idFor(name, it.text), voice: name, piper: name };
  return it;
}

const speakLog = (m) => console.log(new Date().toISOString().slice(11, 19), 'speak:', m);
export function plan(text, more = false, choice = '') {
  if (!speech) return { error: t('voice.noGfShort') };
  const items = speech.plan(String(text || '').slice(0, 8000)).map(it => revoice(it, choice));
  if (!items.length) return { error: t('voice.nothing') };
  speech.prefetch(items.filter(it => !it.piper), speakLog, { append: more });
  piper.prefetch(items.filter(it => it.piper).map(it => ({ id: it.id, text: it.text, key: it.piper })), { append: more });
  return { sentences: items.map(({ id, lang, voice, text: t }) => ({ id, lang, voice, text: t })) };
}
export async function audio(id) {
  if (!speech || !speech.validId(id)) return { status: 400, error: t('voice.badId') };
  const pending = piper.owns(id) ? piper.audio(id).then(p => ({ path: p })) : speech.audio(id, speakLog);
  if (!pending) return { status: 404, error: t('voice.unknown') };
  let r;
  try { r = await pending; } catch (e) { return { status: 503, error: String(e?.message || e) }; }
  try { return { wav: fs.readFileSync(r.path) }; } catch { return { status: 410, error: t('voice.gone') }; }
}
