// Siri ingress shares Telegram's turn queue and outbox. Only the turn host holds
// device hashes; the paired host carries the bearer inside the signed body in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const telegramDir = () => process.env.GHOSTFLEET_TELEGRAM_DIR || path.join(os.homedir(), '.config', 'ghostfleet', 'telegram');
export const read = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
export function write(f, value) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}
export const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const redact = (s) => String(s ?? '').replace(/gfvoice_[A-Za-z0-9_-]{43}/g, '<redacted>');
const devicesDir = () => path.join(telegramDir(), 'voice-devices');
const deviceFile = (name) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || redact(name) !== name) throw new Error('device names use 1–64 letters, digits, underscores or dashes, never a bearer');
  return path.join(devicesDir(), `${name}.json`);
};
export function devices() {
  try { return fs.readdirSync(devicesDir()).filter(n => n.endsWith('.json')).map(n => {
    const f = path.join(devicesDir(), n), d = read(f);
    if (!d) return null;
    const used = read(f + '.used');
    return { name: d.name, revoked: read(f + '.revoked') === d.sha256,
      last_use: used?.sha256 === d.sha256 ? used.at : null };
  }).filter(Boolean); } catch { return []; }
}
export function addDevice(name) {
  const f = deviceFile(name), old = read(f);
  if (old && read(f + '.revoked') !== old.sha256) throw new Error('that device already has a token; revoke it first');
  const token = `gfvoice_${crypto.randomBytes(32).toString('base64url')}`;
  write(f, { name, sha256: digest(token), created: new Date().toISOString() });
  return token;
}
export function revokeDevice(name) {
  const f = deviceFile(name), d = read(f);
  if (!d) throw new Error('no such device');
  // A separate marker: recording last use must never overwrite a concurrent revoke.
  write(f + '.revoked', d.sha256);
}
export function checkToken(token) {
  if (!/^gfvoice_[A-Za-z0-9_-]{43}$/.test(token || '')) return false;
  const hash = digest(token);
  let names; try { names = fs.readdirSync(devicesDir()); } catch { return false; }
  for (const n of names.filter(n => n.endsWith('.json'))) {
    const f = path.join(devicesDir(), n), d = read(f);
    if (d?.sha256 !== hash || read(f + '.revoked') === hash) continue;
    write(f + '.used', { sha256: hash, at: new Date().toISOString() });
    return read(f + '.revoked') !== hash;
  }
  return false;
}
export const settings = () => read(path.join(telegramDir(), 'config.json'), {});
export const deadlineMs = () => {
  const n = settings().voice_deadline_ms;
  return Number.isInteger(n) && n >= 100 && n <= 45000 ? n : 15000;
};
export const voiceTag = () => settings().voice_tag || '[voice] Answer in a few short spoken sentences, in the language of the question, with no markdown and no links.';
export const answerFormat = 'Return only JSON with text (the spoken answer) and lang (es or en, matching the question). The JSON wrapper will be removed before speech.';
// Used only before there is an answer (the deadline). Ambiguous short questions
// can supply lang explicitly; the session chooses the final answer's language.
export function guessLang(text) {
  return /[¿¡ñáéíóúü]|\b(hola|oye|qué|que|cómo|como|cuál|cual|cuándo|cuando|dónde|donde|por|para|puedes|quiero|necesito|estado|sesión|sesion|gracias|está|esta|hay|dime|haz|revisa|mi|mis|el|la|los|las|un|una)\b/i.test(text) ? 'es' : 'en';
}
export function spokenAnswer(text, lang = 'en') {
  try {
    const a = JSON.parse(text);
    if (typeof a.text === 'string' && a.text.trim() && ['es', 'en'].includes(a.lang)) return { text: a.text, lang: a.lang };
  } catch {}
  return { text, lang: guessLang(text) === 'es' ? 'es' : lang };
}
export const requestsDir = () => path.join(telegramDir(), 'voice-requests');
export const requestDir = (id) => {
  if (!/^s[0-9a-f]{32}$/.test(id)) throw new Error('invalid voice request id');
  return path.join(requestsDir(), id);
};
export const fallback = (lang) => lang === 'es' ? 'La respuesta te llegará por Telegram.' : 'The answer is coming on Telegram.';
export function enqueue(text, lang, deadline) {
  const id = 's' + crypto.randomBytes(16).toString('hex');
  write(path.join(requestDir(id), 'request.json'), { id, text, lang, deadline, created: Date.now() });
  return id;
}
// Both the HTTP deadline and the outbox may win. Publishing a complete file with
// link(2) gives them one durable decision, including across a daemon restart.
export function decide(id, value) {
  const dir = requestDir(id), tmp = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  try { fs.linkSync(tmp, path.join(dir, 'decision.json')); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
  return read(path.join(dir, 'decision.json'));
}
export const decision = (id) => read(path.join(requestDir(id), 'decision.json'));
export const defer = (id, lang) => decide(id, { via: 'telegram', text: fallback(lang), lang });
export const isVoice = (id) => /^s[0-9a-f]{32}$/.test(String(id || ''));
