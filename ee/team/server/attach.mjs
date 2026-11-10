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
const QUOTA = 200 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// The person's own file name, kept readable (Claude is told it) but unable to leave the folder.
export function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC')
    .replace(/[^\p{L}\p{N}._()-]+/gu, '_').replace(/^[.\s]+/, '').trim().slice(-90);
  return base || 'archivo';
}

function folderBytes(dir) {
  return fs.readdirSync(dir).reduce((total, name) => {
    const full = path.join(dir, name), st = fs.lstatSync(full);
    return total + (st.isDirectory() ? folderBytes(full) : st.size);
  }, 0);
}

export function save(dir, name, buf) {
  if (!buf?.length) throw Object.assign(new Error(tr('err.emptyFile')), { status: 400 });
  if (buf.length > ATTACH_MAX_BYTES) throw Object.assign(new Error(tr('err.fileLimit')), { status: 413 });
  const clean = safeName(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Check before writing, synchronously with the write: concurrent HTTP uploads cannot
  // both reserve the same remaining space, and a refusal never erases earlier attachments.
  if (folderBytes(dir) + buf.length > QUOTA) throw Object.assign(new Error(tr('err.attachmentQuota')), { status: 413 });
  const file = path.join(dir, `${crypto.randomBytes(3).toString('hex')}-${clean}`);
  fs.writeFileSync(file, buf, { mode: 0o600, flag: 'wx' });   // a fresh name, never through an existing file
  return { ok: true, path: file, name: clean, size: buf.length, image: IMAGE.test(clean) };
}
