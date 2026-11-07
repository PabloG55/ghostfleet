// lib/attach.mjs — a photo handed to a session, as a file on this machine.
//
// ONE STORE, TWO DOORS. The phone's /api/attach (bin/fleet-serve.mjs) was the only way a
// picture reached a session, and then a Telegram channel needed exactly the same thing: the
// bytes of a photo sent from somewhere else, kept where the session can open them, under the
// same per-session quota, with the same refusals. A second copy of these rules would be the
// copy that drifts — a photo the phone refuses as markup arriving through the other door, or
// a quota one of them stopped enforcing — so both call storePhoto() and neither writes a file
// of its own.
//
// docs/attachments.md measured the hard part: fleet-send pastes TEXT, so a photo has to
// become a file here and the prompt has to name its path — and given a path, claude and
// codex both read the pixels.
//
// THE ORIGINAL BYTES COME IN AND THE CONVERSION HAPPENS HERE. iOS hands out HEIC, and no
// agent reads HEIC; macOS has had /usr/bin/sips forever and it speaks HEIC. Linux has no
// sips, so the converter is probed for (CLAUDE.md: every macOS-only call needs a guard).
//
// Node builtins only: ghostfleet is a zero-dependency package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ATTACH_MAX_BYTES = 6 * 1024 * 1024;  // the decoded length a photo may have
// SEVERAL PHOTOS GO IN ONE MESSAGE, and the phone uploads them one request at a time before
// the message is sent. The quota drops the OLDEST files first, so at 24 MB a message of ten
// full-size photos on a machine with no converter (nothing shrinks them) deleted its own
// first six while the last four were still arriving — and the agent was handed six paths to
// files that no longer existed. Sized so one whole message always fits: what gets dropped is
// then only ever an earlier message's.
export const ATTACH_PER_MESSAGE = 10;      // web/api.js holds the phone to the same number
export const ATTACH_QUOTA = Math.max(24 * 1024 * 1024, ATTACH_PER_MESSAGE * ATTACH_MAX_BYTES);  // per session, oldest deleted first
const ATTACH_MAX_PX = 1600;                // what a converter downscales to, when there is one
const ATTACH_RESIZE_OVER = 512 * 1024;     // below this an already-readable image is kept as it is

// SNIFFED, NEVER DECLARED. The sender's content-type is a hint; the magic bytes are what the
// file is. SVG is refused loudly and specifically: it is an image that is also a script
// container.
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // HEIC/HEIF is ISO-BMFF: a size, then 'ftyp', then a brand.
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if (buf.slice(0, 5).toString('latin1').trim().startsWith('<')) return 'markup';
  return null;
}

// Probed in order and remembered, because three spawns per photo to re-learn the same
// answer is three spawns per photo.
let converterCache;
export function imageConverter() {
  if (converterCache !== undefined) return converterCache;
  const has = (bin) => { try { return execFileSync('command', ['-v', bin], { shell: '/bin/sh', encoding: 'utf8' }).trim(); } catch { return ''; } };
  for (const [bin, kind] of [['sips', 'sips'], ['heif-convert', 'heif'], ['magick', 'magick']]) {
    const at = has(bin);
    if (at) { converterCache = { bin: at, kind }; return converterCache; }
  }
  converterCache = null;
  return converterCache;
}

// Returns '' on success, or a sentence saying what could not be done. Never throws into
// the caller: a silently dropped attachment is the worst outcome this feature has.
export function convertImage(kind, src, dst) {
  const c = imageConverter();
  if (!c) return 'no image converter on this machine (looked for sips, heif-convert, magick)';
  try {
    if (c.kind === 'sips') {
      execFileSync(c.bin, ['-s', 'format', 'jpeg', '-Z', String(ATTACH_MAX_PX), src, '--out', dst],
                   { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    } else if (c.kind === 'heif') {
      // heif-convert only reads HEIF; a JPEG or PNG that reaches it would fail, so those
      // are copied instead (below) and this only ever sees HEIC.
      execFileSync(c.bin, [src, dst], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    } else {
      execFileSync(c.bin, [src, '-auto-orient', '-resize', `${ATTACH_MAX_PX}x${ATTACH_MAX_PX}>`, dst],
                   { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    }
  } catch (e) {
    return `${c.kind} could not convert it: ${String((e.stderr || e.message || '')).split('\n')[0].slice(0, 160)}`;
  }
  try { if (!fs.statSync(dst).size) return `${c.kind} produced an empty file`; } catch { return `${c.kind} produced no file`; }
  return '';
}

// <fleet dir>/attach/<sock>.<session>/<random>.jpg — the same <sock>.<session> key every
// other piece of per-session state under that directory already uses, so a directory whose
// session is gone is an orphan of a class fleet-clean already understands, and fleet-rename
// moves it with the session.
export const defaultFleetDir = () =>
  process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude', 'fleet');
export function attachDir(sock, session, fleetDir = defaultFleetDir()) {
  return path.join(fleetDir, 'attach', `${sock}.${session}`);
}

// OLDEST FIRST, to a fixed ceiling. fleet-clean can only help once a session is dead; a
// session that lives for weeks and gets a photo a day needs the bound enforced here.
export function enforceQuota(dir, quota = ATTACH_QUOTA) {
  let files = [];
  try {
    files = fs.readdirSync(dir).map(f => {
      const full = path.join(dir, f);
      try { const st = fs.statSync(full); return { full, size: st.size, at: st.mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.at - b.at);
  } catch { return 0; }
  let total = files.reduce((n, f) => n + f.size, 0), dropped = 0;
  while (total > quota && files.length > 1) {
    const oldest = files.shift();
    try { fs.unlinkSync(oldest.full); total -= oldest.size; dropped++; } catch { break; }
  }
  return dropped;
}

// THE SESSION NAME IS A PATH COMPONENT AND COMES FROM OUTSIDE. Validated by shape rather
// than sanitised: sanitising is a list of things somebody remembered, and this string is
// about to name a directory AND end up inside a prompt that gets pasted into a terminal.
export const sessionNameOk = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) && !s.includes('..');

// Store one photo for <sock>.<session>. Returns { ok: true, path, bytes, from, converted,
// dropped } or { ok: false, status, text } — the status is the HTTP one the phone's door
// answers with, and the text is a sentence a person can act on.
export function storePhoto({ buf, sock, session, fleetDir = defaultFleetDir() }) {
  if (!sessionNameOk(String(session || '')))
    return { ok: false, status: 400, text: `'${String(session || '').slice(0, 40)}' is not a usable session name here — letters, digits, dot, dash and underscore only` };
  if (!buf || !buf.length) return { ok: false, status: 400, text: "'data' is empty" };
  // Checked on the decoded bytes: a transport's cap alone does not bound them.
  if (buf.length > ATTACH_MAX_BYTES)
    return { ok: false, status: 413, text: `that photo is ${Math.round(buf.length / 1048576 * 10) / 10} MB and the limit is ${Math.round(ATTACH_MAX_BYTES / 1048576)} MB` };
  const kind = sniffImage(buf);
  if (kind === 'markup')
    return { ok: false, status: 415, text: 'that looks like markup, not a photo. SVG is refused here on purpose: it is an image that is also a script container' };
  if (!kind)
    return { ok: false, status: 415, text: 'that is not a JPEG, a PNG or a HEIC — the type is read from the file itself, not from what the sender called it' };
  // HEIC is the iPhone's default and cannot be handed to an agent as-is.
  if (kind === 'heic' && !imageConverter())
    return { ok: false, status: 501, text: 'that is a HEIC and this machine has no converter for it — looked for sips (macOS), heif-convert and magick. Send a JPEG, or install one of those' };

  const dir = attachDir(sock, session, fleetDir);
  let out = '';
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(8).toString('hex');
    const raw = path.join(dir, `.in-${id}`);
    // O_EXCL on a name nothing has seen: never write through a path that existed before
    // this call, and never follow a symlink into one.
    fs.writeFileSync(raw, buf, { flag: 'wx', mode: 0o600 });
    const conv = imageConverter();
    // HEIC ALWAYS, because no agent reads it. Anything already readable is only put
    // through a converter when it is big enough for that to be worth doing: measured,
    // sips turns a 70-byte PNG into a 41 KB JPEG, so re-encoding by reflex can make a
    // small picture bigger AND lossier for nothing.
    const worthResizing = buf.length > ATTACH_RESIZE_OVER;
    if (kind === 'heic' || (conv && conv.kind !== 'heif' && worthResizing)) {
      out = path.join(dir, `${id}.jpg`);
      const bad = convertImage(kind, raw, out);
      if (bad) { try { fs.unlinkSync(raw); } catch {} try { fs.unlinkSync(out); } catch {}
        return { ok: false, status: 500, text: bad }; }
      fs.unlinkSync(raw);
    } else {
      // No converter, and it is already something an agent can read: keep the original
      // rather than refuse. This is the Linux-without-sips path.
      out = path.join(dir, `${id}.${kind}`);
      fs.renameSync(raw, out);
    }
    fs.chmodSync(out, 0o600);
  } catch (e) {
    return { ok: false, status: 500, text: `could not store it: ${e.message}` };
  }
  const dropped = enforceQuota(dir);
  const bytes = (() => { try { return fs.statSync(out).size; } catch { return 0; } })();
  // THE PATH IS ABOUT TO BE PUT IN A PROMPT AND PASTED INTO A TERMINAL. Every component of
  // it is either from the projects file or generated here, so this can only fail if one of
  // those assumptions breaks — which is exactly when it should.
  if (!/^[A-Za-z0-9._\/-]+$/.test(out)) {
    try { fs.unlinkSync(out); } catch {}
    return { ok: false, status: 500, text: 'refusing to hand back a path with characters a shell would read' };
  }
  return { ok: true, path: out, bytes, from: kind,
           converted: path.extname(out) === '.jpg' && kind !== 'jpg', dropped };
}

// A VOICE NOTE, which no converter is asked about: an agent cannot listen to it, so it is
// stored only so a transcriber — or the owner, at the desk — can. Same directory, same
// quota, same O_EXCL write as a photo; the type is sniffed from the bytes like a photo's.
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  const head = buf.slice(0, 4).toString('latin1');
  if (head === 'OggS') return 'oga';
  if (head === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  return null;
}
export function storeAudio({ buf, sock, session, fleetDir = defaultFleetDir() }) {
  if (!sessionNameOk(String(session || '')))
    return { ok: false, status: 400, text: `'${String(session || '').slice(0, 40)}' is not a usable session name here` };
  if (!buf || !buf.length) return { ok: false, status: 400, text: 'the voice note is empty' };
  if (buf.length > ATTACH_MAX_BYTES)
    return { ok: false, status: 413, text: `that voice note is ${Math.round(buf.length / 1048576 * 10) / 10} MB and the limit is ${Math.round(ATTACH_MAX_BYTES / 1048576)} MB` };
  const kind = sniffAudio(buf);
  if (!kind) return { ok: false, status: 415, text: 'that is not an Ogg, MP3, M4A or WAV recording — the type is read from the file itself' };
  const dir = attachDir(sock, session, fleetDir);
  let out = '';
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    out = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.${kind}`);
    fs.writeFileSync(out, buf, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    return { ok: false, status: 500, text: `could not store it: ${e.message}` };
  }
  const dropped = enforceQuota(dir);
  if (!/^[A-Za-z0-9._\/-]+$/.test(out)) {
    try { fs.unlinkSync(out); } catch {}
    return { ok: false, status: 500, text: 'refusing to hand back a path with characters a shell would read' };
  }
  return { ok: true, path: out, bytes: buf.length, from: kind, dropped };
}
