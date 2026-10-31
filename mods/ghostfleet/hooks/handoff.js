// The handoff spool's vocabulary, as plain functions: no `$`, no I/O. The DELIVERY section
// of register.js uses them; bin/fleet-send and lib/mod-target.mjs write and read the same
// names, and test/run.sh imports this file with node to hold the three to each other.
//
// <fleet dir>/<session_id>.handoff/
//   <id>.json     a prompt fleet-send left for this session: { id, text, reply? }
//   <id>.taken    claimed by the mod, being submitted
//   <id>.done     the receipt: { id, turnId } once its turn started, { id, ran } for a slash
//                 command that ran without starting one, or { dropped | error }
//   <id>.failed   a { dropped | error } receipt nobody read within the hour, kept for
//                 fleet-inbox to report (lib/handoff-sweep.mjs) rather than cleared
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

// A SLASH COMMAND IS RUN, NEVER SUBMITTED. The host refuses `$.prompt.submit` for any text
// whose first non-space character is `/` ("a text beginning with / would run a command as
// the user"), and the refusal used to land in a receipt nobody read: a brief that opened
// with a skill left the worker idle. Measured on the host: `//x`, ` /x` and a framed `/x`
// are all refused alike, so there is no literal-slash escape to offer. Such a text runs as
// typed, `/name args`, through `$.command.run`; a `//` or a bare `/` cannot name a command
// and is refused here with words a lead can act on.
//   null: not a command, submit it. { command, args }: run it. { refused }: neither.
export function commandOf(text) {
  const t = String(text ?? '').trimStart()
  if (!t.startsWith('/')) return null
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(t)
  if (!m) {
    const word = t.split(/\s/)[0]
    return { refused: `a prompt that starts with / runs as a slash command, and ${word === '/' ? 'a bare /' : `"${word.slice(0, 40)}"`} names none; the host refuses it as text, so reword it to start with something else` }
  }
  return { command: m[1], args: (m[2] || '').trimEnd() }
}

// Whether a turn.start is the turn a submitted prompt began: the engine hands the hook the
// user's text as the turn proceeds with it. A command's turn does not carry the typed line:
// measured, a skill run as `/probe-skill alpha beta` starts a turn whose text is
// `<command-message>probe-skill</command-message>\n<command-name>/probe-skill</command-name>
// \n<command-args>alpha beta</command-args>`, its args trimmed. So a command is matched by
// those tags, the args only when the turn carries them.
const tag = (text, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m ? m[1] : null
}
export function isTurnOf(pending, text) {
  if (!pending || typeof text !== 'string') return false
  const c = pending.command
  if (!c) return text.trim() === String(pending.text).trim()
  if (tag(text, 'command-name') !== `/${c.command}`) return false
  const args = tag(text, 'command-args')
  return args === null || args.trim() === String(c.args).trim()
}

// A receipt that says the prompt went nowhere: its words, or null for one that delivered.
export function failureOf(r) {
  if (!r || typeof r !== 'object') return null
  if (typeof r.error === 'string' && r.error) return r.error
  if (r.dropped !== undefined) return `dropped by a hook: ${String(r.dropped) || 'no reason given'}`
  return null
}

// The opening words of a prompt, for a failure receipt: by the time anyone reads that
// receipt the entry is gone, and "a prompt was not delivered" does not say which.
export const headOf = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)

// How long a failed receipt is the sender's to read. fleet-send waits CLAUDE_FLEET_MOD_CLAIM
// (3s) for the claim and CLAUDE_FLEET_MOD_START (20s) for the receipt; one still there well
// past that was read by nobody, and fleet-inbox reports it (lib/handoff-sweep.mjs).
export const UNREAD_MS = 30_000
