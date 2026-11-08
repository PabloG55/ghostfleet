// server/attach.mjs — a file from the browser, as a file on this machine, for a session to read.
//
// fleet-send pastes TEXT, so an attachment has to become a file here and the message has to
// name its path; given a path, Claude reads it (an image's pixels, a PDF, a spreadsheet). The
// place is the one fleet-serve uses for the phone's photos, $CLAUDE_FLEET_DIR/attach/
// <sock>.<session>/, so a folder whose session is gone is an orphan fleet-clean already knows.
//
// Not just images: "upload a file from here" meant a document too. Nothing here is ever
// served back to a browser, so what a file contains cannot run anywhere — it is only read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { t as tr } from '../shared/i18n/index.js';

export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;     // per file; web/src/api.js says the same
export const ATTACH_PER_MESSAGE = 10;
const QUOTA = 250 * 1024 * 1024;                      // per session, oldest deleted first
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// The person's own file name, kept readable (Claude is told it) but unable to leave the folder.
export function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC')
    .replace(/[^\p{L}\p{N}._()-]+/gu, '_').replace(/^[.\s]+/, '').trim().slice(-90);
  return base || 'archivo';
}

// Oldest first, to a fixed ceiling, never the file just written.
function enforceQuota(dir, keep) {
  let files = [];
  try {
    files = fs.readdirSync(dir).map(f => {
      const full = path.join(dir, f);
      try { const st = fs.statSync(full); return st.isFile() ? { full, size: st.size, at: st.mtimeMs } : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.at - b.at);
  } catch { return; }
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= QUOTA) break;
    if (f.full === keep) continue;
    try { fs.unlinkSync(f.full); total -= f.size; } catch {}
  }
}

export function save(dir, name, buf) {
  if (!buf?.length) throw Object.assign(new Error(tr('err.emptyFile')), { status: 400 });
  const clean = safeName(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${crypto.randomBytes(3).toString('hex')}-${clean}`);
  fs.writeFileSync(file, buf, { mode: 0o600, flag: 'wx' });   // a fresh name, never through an existing file
  enforceQuota(dir, file);
  return { ok: true, path: file, name: clean, size: buf.length, image: IMAGE.test(clean) };
}
