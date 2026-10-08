// The handoff spool's vocabulary, as plain functions: no `$`, no I/O. The DELIVERY section
// of register.js uses them; bin/fleet-send and lib/mod-target.mjs write and read the same
// names, and test/run.sh imports this file with node to hold the three to each other.
//
// <fleet dir>/<session_id>.handoff/
//   <id>.json     a prompt fleet-send left for this session: { id, text, reply? }
//   <id>.taken    claimed by the mod, being submitted
//   <id>.done     the receipt: { id, turnId } once its turn started, or { dropped | error }
//   <id>.revoked  fleet-send took it back unclaimed and pasted it instead
//   .ready        the pid of the mod process that delivers from here
// <id> starts with the epoch milliseconds it was written at, so names sort in send order.

export const spoolOf = (dir, sessionId) => `${dir}/${sessionId}.handoff`

const ID = /^[0-9]+[0-9A-Za-z._-]*$/
export const entryId = (name, ext) =>
  typeof name === 'string' && name.endsWith(ext) && ID.test(name.slice(0, -ext.length))
    ? name.slice(0, -ext.length) : null

// The prompts waiting, oldest first.
export const waiting = entries => entries
  .filter(e => e && e.kind === 'file').map(e => entryId(e.name, '.json')).filter(Boolean).sort()

// A receipt is kept for an hour, then cleared by the next claim.
export const KEEP_DONE_MS = 3_600_000
export const staleReceipts = (entries, nowMs) => entries
  .filter(e => e && e.kind === 'file' && entryId(e.name, '.done'))
  .filter(e => nowMs - Number(e.name.match(/^[0-9]+/)[0]) > KEEP_DONE_MS)
  .map(e => e.name)

// The reply address an entry carries, or null. fleet-send validated it; it arrives here
// through a file, so it is validated again with fleet-send's own charset.
const NAME = /^[A-Za-z0-9._~-]+$/
export function replyOf(entry) {
  const r = entry && entry.reply
  if (!r || !NAME.test(String(r.sock || '')) || !NAME.test(String(r.sess || ''))) return null
  if (typeof r.dir !== 'string' || !r.dir.startsWith('/') || /[\n\x1f]/.test(r.dir)) return null
  return { sock: r.sock, sess: r.sess, dir: r.dir }
}

// hooks/fleet-event.sh's reply-to marker and its arming, as that hook reads them: the
// address as three \x1f-separated fields, and the arming as the transcript line the turn
// starts at, with `turn <id>` on a second line, which tells the hook this arming is
// exact and not to be redone by a prompt typed into the same turn.
export const replyMarker = r => `${r.sock}\x1f${r.sess}\x1f${r.dir}\n`
export const armedMarker = (lines, turnId) => `${lines}\nturn ${turnId}\n`

// Whether a turn.start is the turn a submitted prompt began: the engine hands the hook the
// user's text as the turn proceeds with it.
export const isTurnOf = (pending, text) =>
  Boolean(pending && typeof text === 'string' && text.trim() === String(pending.text).trim())
